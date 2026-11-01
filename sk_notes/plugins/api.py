"""Community plugins: install/enable/remove, and the Python side of the Node/Electron
shims (file system, child processes, network, hashes) behind permissions."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path

from ..app.bridge import ApiError, Ctx
from . import permissions

log = logging.getLogger(__name__)
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$", re.I)
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
MAX_DOWNLOAD = 40 * 1024 * 1024
LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")


def register(app) -> None:
    r = app.api.route

    def svc():
        if app.service is None:
            raise ApiError("no-vault")
        return app.service

    def plugins_dir() -> Path:
        d = svc().vault.config_dir / "plugins"
        try:
            d.mkdir(exist_ok=True)
        except OSError:
            pass  # read-only vault: listing finds nothing, installing reports the error
        return d

    def enabled() -> list[str]:
        return list(svc().config_read("community-plugins.json", []) or [])

    # ------------------------------------------------------------- management
    @r("plugins.list")
    def plugins_list(p, ctx):
        out = []
        pdir = plugins_dir()
        for d in sorted(pdir.iterdir()) if pdir.is_dir() else []:
            mf = d / "manifest.json"
            if not mf.is_file():
                continue
            try:
                m = json.loads(mf.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                out.append({"id": d.name, "broken": True, "dir": d.name})
                continue
            m["dir"] = d.name
            m["hasStyles"] = (d / "styles.css").is_file()
            m["hasMain"] = (d / "main.js").is_file()
            out.append(m)
        perms = svc().config_read("permissions.json", {}) or {}
        return {"plugins": out, "enabled": enabled(), "permissions": perms}

    @r("plugins.source")
    def plugins_source(p, ctx):
        d = plugins_dir() / _safe_id(p["id"])
        try:
            main = (d / "main.js").read_text(encoding="utf-8")
        except OSError as exc:
            raise ApiError("not-found", str(exc)) from exc
        css = (d / "styles.css").read_text(encoding="utf-8") if (d / "styles.css").is_file() else ""
        return {"main": main, "css": css}

    @r("plugins.setEnabled")
    def plugins_set_enabled(p, ctx):
        if ctx.plugin:
            raise ApiError("permission-denied")
        pid = _safe_id(p["id"])
        lst = [x for x in enabled() if x != pid]
        if p.get("enabled"):
            lst.append(pid)
        svc().config_write("community-plugins.json", lst)
        permissions.refresh_network(app)
        return lst

    @r("plugins.remove")
    def plugins_remove(p, ctx):
        if ctx.plugin:
            raise ApiError("permission-denied")
        pid = _safe_id(p["id"])
        d = plugins_dir() / pid
        if d.is_dir():
            shutil.rmtree(d)
        svc().config_write("community-plugins.json", [x for x in enabled() if x != pid])
        perms = svc().config_read("permissions.json", {}) or {}
        perms.pop(pid, None)
        svc().config_write("permissions.json", perms)
        return True

    @r("plugins.installFolder")
    def plugins_install_folder(p, ctx):
        if ctx.plugin:
            raise ApiError("permission-denied")
        src = Path(p["path"]).expanduser()
        mf = src / "manifest.json"
        if not mf.is_file() or not (src / "main.js").is_file():
            raise ApiError("not-a-plugin", str(src))
        m = json.loads(mf.read_text(encoding="utf-8"))
        pid = _safe_id(m.get("id", ""))
        dest = plugins_dir() / pid
        dest.mkdir(exist_ok=True)
        for name in ("manifest.json", "main.js", "styles.css"):
            if (src / name).is_file():
                shutil.copy2(src / name, dest / name)
        return m

    @r("plugins.installGithub", slow=True)
    def plugins_install_github(p, ctx):
        import urllib.error  # lazy: costs ~0.3 s at start-up
        import urllib.request
        if ctx.plugin:
            raise ApiError("permission-denied")
        repo = p.get("repo", "").strip().removeprefix("https://github.com/").strip("/")
        if not REPO_RE.match(repo):
            raise ApiError("bad-repo", repo)
        tag = p.get("version") or ""
        base = f"https://github.com/{repo}/releases/" + (f"download/{tag}/" if tag else "latest/download/")
        files = {}
        for name in ("manifest.json", "main.js", "styles.css"):
            try:
                files[name] = _download(base + name)
            except urllib.error.HTTPError as exc:
                if name == "styles.css" and exc.code == 404:
                    continue
                raise ApiError("download-failed", f"{name}: HTTP {exc.code}") from exc
            except (urllib.error.URLError, OSError) as exc:
                raise ApiError("download-failed", str(exc)) from exc
        try:
            m = json.loads(files["manifest.json"])
        except ValueError as exc:
            raise ApiError("not-a-plugin", "manifest") from exc
        pid = _safe_id(m.get("id", ""))
        dest = plugins_dir() / pid
        dest.mkdir(exist_ok=True)
        for name, data in files.items():
            (dest / name).write_bytes(data)
        m["repo"] = repo
        return m

    @r("plugins.permissions")
    def plugins_permissions(p, ctx):
        if ctx.plugin:
            raise ApiError("permission-denied")
        if "set" in p:
            for perm, value in p["set"].items():
                if perm in permissions.PERMISSIONS:
                    permissions.set_status(app, _safe_id(p["id"]), perm, value)
        return (svc().config_read("permissions.json", {}) or {}).get(p["id"], {})

    # ------------------------------------------------------------- Node shims
    def resolve_path(ctx: Ctx, raw: str, write: bool) -> Path:
        """Absolute path for a plugin fs call; outside the vault needs a permission."""
        root = svc().vault.root
        path = Path(raw)
        if not path.is_absolute():
            path = root / raw
        path = Path(os.path.normpath(path))
        inside = path == root or root in path.parents
        if inside:
            rel = path.relative_to(root).as_posix() if path != root else ""
            cfg = ".sk_notes"
            if rel == cfg or rel.startswith(cfg + "/"):
                own = f"{cfg}/plugins/{ctx.plugin}" if ctx.plugin else None
                if not own or not (rel == own or rel.startswith(own + "/")):
                    if write or not rel.startswith(f"{cfg}/plugins/"):
                        raise ApiError("permission-denied", rel)
            return path
        permissions.require(app, ctx, "fs-outside-vault", str(path))
        return path

    @r("shim.fs")
    def shim_fs(p, ctx):
        op = p["op"]
        write = op in ("writeFile", "appendFile", "mkdir", "rm", "rename", "copyFile", "unlink", "rmdir")
        path = resolve_path(ctx, p["path"], write)
        try:
            if op == "readFile":
                data = path.read_bytes()
                return {"b64": base64.b64encode(data).decode()}
            if op == "writeFile":
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(p.get("b64", "")))
                _notify(app, path)
                return True
            if op == "appendFile":
                with open(path, "ab") as fh:
                    fh.write(base64.b64decode(p.get("b64", "")))
                _notify(app, path)
                return True
            if op == "exists":
                return path.exists()
            if op == "stat":
                st = path.stat()
                return {"size": st.st_size, "mtimeMs": st.st_mtime * 1000, "ctimeMs": st.st_ctime * 1000,
                        "birthtimeMs": getattr(st, "st_birthtime", st.st_ctime) * 1000, "isFile": path.is_file(),
                        "isDirectory": path.is_dir(), "mode": st.st_mode}
            if op == "readdir":
                return sorted(os.listdir(path))
            if op == "mkdir":
                path.mkdir(parents=bool(p.get("recursive")), exist_ok=bool(p.get("recursive")))
                return True
            if op in ("rm", "unlink", "rmdir"):
                if path.is_dir() and not path.is_symlink():
                    if p.get("recursive") or op == "rmdir":
                        shutil.rmtree(path) if p.get("recursive") else path.rmdir()
                    else:
                        raise ApiError("is-a-folder", str(path))
                elif path.exists() or path.is_symlink():
                    path.unlink()
                elif not p.get("force"):
                    raise ApiError("not-found", str(path))
                _notify(app, path)
                return True
            if op == "rename":
                dest = resolve_path(ctx, p["dest"], True)
                os.replace(path, dest)
                _notify(app, path)
                _notify(app, dest)
                return True
            if op == "copyFile":
                dest = resolve_path(ctx, p["dest"], True)
                shutil.copy2(path, dest)
                _notify(app, dest)
                return True
        except FileNotFoundError as exc:
            raise ApiError("ENOENT", str(exc)) from exc
        except PermissionError as exc:
            raise ApiError("EACCES", str(exc)) from exc
        except IsADirectoryError as exc:
            raise ApiError("EISDIR", str(exc)) from exc
        except FileExistsError as exc:
            raise ApiError("EEXIST", str(exc)) from exc
        raise ApiError("bad-op", op)

    @r("shim.exec", slow=True)
    def shim_exec(p, ctx):
        cmd = p.get("cmd")
        args = p.get("args") or []
        shell = bool(p.get("shell"))
        shown = cmd if shell else " ".join([cmd, *args])
        permissions.require(app, ctx, "exec", shown)
        cwd = p.get("cwd") or str(svc().vault.root)
        try:
            proc = subprocess.run(cmd if shell else [cmd, *args], shell=shell, cwd=cwd,  # noqa: S602 - user approved
                                  input=base64.b64decode(p["input"]) if p.get("input") else None,
                                  capture_output=True, timeout=float(p.get("timeout") or 120))
        except FileNotFoundError as exc:
            return {"code": 127, "stdout": "", "stderr": base64.b64encode(str(exc).encode()).decode(), "error": "ENOENT"}
        except subprocess.TimeoutExpired:
            return {"code": 124, "stdout": "", "stderr": "", "error": "ETIMEDOUT"}
        return {"code": proc.returncode, "stdout": base64.b64encode(proc.stdout).decode(),
                "stderr": base64.b64encode(proc.stderr).decode()}

    @r("shim.request", slow=True)
    def shim_request(p, ctx):
        import urllib.error  # lazy: costs ~0.3 s at start-up
        import urllib.request
        url = p["url"]
        m = re.match(r"^(https?)://([^/:]+|\[[^\]]+\])", url)
        if not m:
            raise ApiError("bad-url", url)
        if m.group(2) not in LOCAL_HOSTS:
            permissions.require(app, ctx, "network", url)
        body = base64.b64decode(p["body"]) if p.get("body") else None
        headers = {k: v for k, v in (p.get("headers") or {}).items() if k.lower() not in ("host", "content-length")}
        if p.get("contentType"):
            headers["Content-Type"] = p["contentType"]
        req = urllib.request.Request(url, data=body, method=(p.get("method") or "GET").upper(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - permission checked
                data = resp.read(MAX_DOWNLOAD + 1)
                status, hdrs = resp.status, dict(resp.headers.items())
        except urllib.error.HTTPError as exc:
            data, status, hdrs = exc.read(MAX_DOWNLOAD + 1), exc.code, dict(exc.headers.items())
        except (urllib.error.URLError, OSError) as exc:
            raise ApiError("network-error", str(exc)) from exc
        if len(data) > MAX_DOWNLOAD:
            raise ApiError("too-large", url)
        return {"status": status, "headers": {k.lower(): v for k, v in hdrs.items()}, "b64": base64.b64encode(data).decode()}

    @r("shim.hash")
    def shim_hash(p, ctx):
        algo = p.get("algo", "sha256").lower().replace("-", "")
        if algo not in ("md5", "sha1", "sha256", "sha512", "sha384", "sha224"):
            raise ApiError("bad-algo", algo)
        h = hashlib.new(algo, base64.b64decode(p.get("b64", "")))
        return {"hex": h.hexdigest(), "b64": base64.b64encode(h.digest()).decode()}

    @r("shim.env")
    def shim_env(p, ctx):
        return {"home": str(Path.home()), "tmp": "/tmp", "user": os.environ.get("USER", ""), "hostname": os.uname().nodename,
                "vault": str(svc().vault.root)}


def _safe_id(pid: str) -> str:
    if not ID_RE.match(pid or ""):
        raise ApiError("bad-id", pid)
    return pid


def _download(url: str) -> bytes:
    import urllib.error  # lazy: costs ~0.3 s at start-up
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "sk_notes"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - fixed GitHub URL chosen by the user
        data = resp.read(MAX_DOWNLOAD + 1)
    if len(data) > MAX_DOWNLOAD:
        raise ApiError("too-large", url)
    return data


def _notify(app, path: Path) -> None:
    """A plugin wrote into the vault through fs: update the index."""
    try:
        root = app.service.vault.root
        if root in path.parents:
            app.service.external_change(path.relative_to(root).as_posix())
    except Exception:  # noqa: BLE001
        log.debug("notify failed for %s", path)
