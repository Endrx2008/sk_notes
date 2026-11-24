"""Sync of the open vault with GitHub, GitLab or another Git server (desktop).

The user gives a site, a name and a password or access token and picks a repository; the
app commits, fetches, merges and pushes by itself (see gitsync.py for one round). Same API
as the Android app (sync.*), so the two behave alike. Kept apart, per vault:
  - what is not secret (site, name, address, options) in <data dir>/vaults/<id>/sync.json;
  - the password or token in the system keyring (core/secrets.py);
  - the Git data in the vault's own .git folder, as Git and other apps expect it.
Community plugins cannot call any of these. An encrypted vault is not synced (its notes
would be readable on the site).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from PyQt6.QtCore import QObject, Qt, pyqtSignal, pyqtSlot

from ..app import config
from ..app.bridge import ApiError
from ..core.secrets import delete_secret, get_secret, set_secret
from .gitsync import GitSync, SyncError

log = logging.getLogger(__name__)
PROVIDERS = {"github", "gitlab", "other"}
INTERVALS = {0, 5, 10, 15, 30, 60}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(:\d{1,5})?$")
LOCAL_HOST = re.compile(r"^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local|\[::1\])$", re.I)


def vault_id(root) -> str:
    return hashlib.sha1(str(root).encode("utf-8")).hexdigest()[:20]


def secret_name(root) -> str:
    return "sync-" + vault_id(root)


def _config_path(root) -> Path:
    d = config.data_dir() / "vaults" / vault_id(root)
    d.mkdir(parents=True, exist_ok=True)
    return d / "sync.json"


def read_config(root) -> dict:
    try:
        data = json.loads(_config_path(root).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_config(root, cfg: dict) -> None:
    p = _config_path(root)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    tmp.replace(p)


def repo_label(url: str) -> str:
    m = re.match(r"^https?://([^/]+)/(.*)$", url or "")
    if not m:
        return url
    host, path = m.group(1), m.group(2).strip("/")
    path = path[:-4] if path.endswith(".git") else path
    return path if host in ("github.com", "gitlab.com") else f"{host}/{path}"


def site_host(provider: str, host: str) -> str:
    if provider == "github":
        return "github.com"
    h = re.sub(r"/.*$", "", re.sub(r"^https?://", "", str(host or "").strip(), flags=re.I))
    if provider == "gitlab" and not h:
        return "gitlab.com"
    if not HOST_RE.match(h):
        raise ApiError("sync-bad-url", h)
    return h


def repo_url(provider: str, host: str, text: str) -> str:
    """What the user typed for the repository → its https address ("name/notes", a web address, "git@site:name/notes.git")."""
    s = str(text or "").strip()
    if not s:
        raise ApiError("sync-bad-url")
    m = re.match(r"^(?:ssh://)?git@([^:/]+)[:/](.+)$", s)
    if m:
        s = f"https://{m.group(1)}/{m.group(2)}"
    if not re.match(r"^https?://", s, re.I):
        if provider == "other":
            raise ApiError("sync-bad-url", s)
        s = f"https://{site_host(provider, host)}/{s.lstrip('/')}"
    m = re.match(r"^(https?)://(?:[^@/]*@)?([^/?#]+)([^?#]*)", s, re.I)
    if not m:
        raise ApiError("sync-bad-url", s)
    scheme, hostport, path = m.group(1).lower(), m.group(2), m.group(3).rstrip("/")
    if scheme != "https" and not LOCAL_HOST.match(hostport.split(":")[0]):
        raise ApiError("sync-not-https")
    if len([x for x in path.split("/") if x]) < (1 if provider == "other" else 2):
        raise ApiError("sync-bad-url", s)
    if provider != "other" and not path.endswith(".git"):
        path += ".git"
    return f"{scheme}://{hostport}{path}"


def author_of(provider: str, user: str, url: str) -> tuple[str, str]:
    host = (re.match(r"^https?://([^/:]+)", url or "") or [None, "localhost"])[1]
    name = user or "sk_notes"
    mail = re.sub(r"[^A-Za-z0-9._-]+", "-", name)
    if provider == "github":
        return name, f"{mail}@users.noreply.github.com"
    return name, f"{mail}@users.noreply.{host}" if provider == "gitlab" else f"{mail}@{host}"


def _site_api(provider: str, host: str, token: str, method: str, path: str, body: dict | None = None):
    github = provider == "github"
    url = ("https://api.github.com" if github else f"https://{site_host(provider, host)}/api/v4") + path
    headers = ({"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
               if github else {"PRIVATE-TOKEN": token})
    headers["User-Agent"] = "sk_notes"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:  # noqa: S310 - https only (site_host)
            status, raw = res.status, res.read(8 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read(1024 * 1024)
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError("network-error", str(getattr(exc, "reason", exc))) from exc
    try:
        return status, json.loads(raw.decode("utf-8"))
    except ValueError:
        return status, None


def _need_ok(status, data):
    if status in (401, 403):
        raise ApiError("sync-auth", str(status))
    if not 200 <= status < 300:
        msg = (data or {}).get("message") if isinstance(data, dict) else ""
        raise ApiError("sync-http", f"{status} {str(msg)[:200]}")
    return data


class _Hop(QObject):
    """Runs a function on the thread this object lives in (the UI thread): a queued call to
    a real slot. (A plain lambda connected to the signal would run in the emitting thread.)"""

    done = pyqtSignal(object)

    def __init__(self):
        super().__init__()
        self.done.connect(self._run, Qt.ConnectionType.QueuedConnection)

    @pyqtSlot(object)
    def _run(self, fn):
        fn()


def register(app) -> None:
    r = app.api.route
    running = threading.Lock()
    hop = _Hop()
    state = {"busy": False}

    def root() -> Path:
        if app.service is None:
            raise ApiError("no-vault")
        return Path(app.service.vault.root)

    def encrypted() -> bool:
        return getattr(app, "crypt_session", None) is not None and app.crypt_session.vault is not None

    def guard(name):
        def deco(fn):
            def run(p, ctx):
                if ctx.plugin:
                    raise ApiError("permission-denied")
                if encrypted() and name != "sync.status":
                    raise ApiError("sync-encrypted")
                return fn(p)
            r(name, slow=True)(run)
            return fn
        return deco

    def status() -> dict:
        if encrypted():
            return {"linked": False, "offered": True, "busy": False, "encrypted": True, "auto": False, "interval": 0, "lastSync": 0, "lastError": None}
        cfg = read_config(root())
        linked = bool(cfg.get("url"))
        return {"linked": linked, "offered": bool(cfg.get("offered")), "busy": state["busy"],
                "provider": cfg.get("provider", ""), "host": cfg.get("host", ""), "user": cfg.get("user", ""),
                "url": cfg.get("url", ""), "branch": cfg.get("branch", ""), "repo": repo_label(cfg.get("url", "")) if linked else "",
                "auto": cfg.get("auto", True) is not False, "interval": cfg.get("interval", 10) if cfg.get("interval", 10) in INTERVALS else 10,
                "lastSync": cfg.get("lastSync", 0), "lastError": cfg.get("lastError")}

    def engine(cfg: dict, token: str) -> GitSync:
        svc = app.service

        def before(path, data):
            if path.lower().endswith((".md", ".canvas", ".base", ".txt")):
                try:
                    svc.history.snapshot(path, data.decode("utf-8"), reason="external", force=True)
                except (UnicodeDecodeError, Exception):  # noqa: BLE001 - history is a nicety here
                    pass
        memory = svc.vault.protected  # SKAI_ Memory: not writable, so the repository is kept aside and files only go up
        return GitSync(root(), cfg["url"], cfg.get("branch") or "main", author_of(cfg.get("provider", ""), cfg.get("user", ""), cfg["url"]),
                       (cfg.get("user") or "git", token), before_overwrite=before,
                       git_dir=_config_path(root()).parent / "memory-git" if memory else None, upload_only=memory)

    def run_round() -> dict:
        if not running.acquire(blocking=False):
            raise ApiError("sync-busy")
        state["busy"] = True
        base = root()
        try:
            cfg = read_config(base)
            if not cfg.get("url"):
                raise ApiError("sync-not-linked")
            app.emit("sync", {"state": "running"})
            try:
                res = engine(cfg, get_secret(secret_name(base)) or "").sync()
            except SyncError as exc:
                err = {"code": exc.code, "detail": exc.detail[:300]}
                write_config(base, {**read_config(base), "lastError": err})
                app.emit("sync", {"state": "offline" if exc.code == "network-error" else "error", "error": err})
                raise ApiError(exc.code, exc.detail[:300]) from exc
            now = int(time.time() * 1000)
            write_config(base, {**read_config(base), "lastSync": now, "lastError": None})
            if res["pulled"] and app.service is not None:
                hop.done.emit(app.service.rescan)  # the watcher sees the files too; this makes it immediate
            app.emit("sync", {"state": "idle", "result": res, "lastSync": now})
            return res
        finally:
            state["busy"] = False
            running.release()

    @guard("sync.status")
    def _status(p):
        return status()

    @guard("sync.check")
    def check(p):
        provider, token, user = str(p.get("provider", "")), str(p.get("token", "")), str(p.get("user", "")).strip()
        if provider not in PROVIDERS:
            raise ApiError("sync-bad-url")
        if not token:
            raise ApiError("sync-auth")
        if provider == "other":
            return {"user": user, "canList": False, "repos": []}
        status_, me = _site_api(provider, p.get("host"), token, "GET", "/user")
        if provider == "gitlab" and status_ == 401:
            return {"user": user, "canList": False, "repos": []}  # an account password: Git accepts it, the lists do not
        who = _need_ok(status_, me)
        user = user or str((who or {}).get("login" if provider == "github" else "username") or "")
        path = "/user/repos?per_page=100&sort=pushed" if provider == "github" else "/projects?membership=true&min_access_level=30&simple=true&order_by=last_activity_at&per_page=100"
        lst = _need_ok(*_site_api(provider, p.get("host"), token, "GET", path))
        repos = []
        for x in lst if isinstance(lst, list) else []:
            if provider == "github":
                if (x.get("permissions") or {}).get("push") is False:
                    continue
                if x.get("full_name") and x.get("clone_url"):
                    repos.append({"name": x["full_name"], "url": x["clone_url"], "private": bool(x.get("private")), "branch": x.get("default_branch") or ""})
            elif x.get("path_with_namespace") and x.get("http_url_to_repo"):
                repos.append({"name": x["path_with_namespace"], "url": x["http_url_to_repo"], "private": x.get("visibility") != "public", "branch": x.get("default_branch") or ""})
        return {"user": user, "canList": True, "repos": repos}

    @guard("sync.createRepo")
    def create_repo(p):
        provider, name = str(p.get("provider", "")), str(p.get("name", "")).strip()
        if provider not in ("github", "gitlab"):
            raise ApiError("unsupported")
        if not NAME_RE.match(name):
            raise ApiError("invalid-name")
        body = {"name": name, "private": True, "description": "Notes (sk_notes)"} if provider == "github" else {"name": name, "path": name, "visibility": "private", "description": "Notes (sk_notes)"}
        status_, data = _site_api(provider, p.get("host"), str(p.get("token", "")), "POST", "/user/repos" if provider == "github" else "/projects", body)
        if status_ in (400, 422):
            raise ApiError("already-exists", name)
        data = _need_ok(status_, data)
        url = (data or {}).get("clone_url" if provider == "github" else "http_url_to_repo")
        if not url:
            raise ApiError("sync-http", "no address in the reply")
        return {"name": (data or {}).get("full_name" if provider == "github" else "path_with_namespace") or name, "url": url}

    @guard("sync.link")
    def link(p):
        provider = str(p.get("provider", ""))
        if provider not in PROVIDERS:
            raise ApiError("sync-bad-url")
        token, user = str(p.get("token", "")), str(p.get("user", "")).strip()
        if not token:
            raise ApiError("sync-auth")
        url = repo_url(provider, p.get("host"), p.get("url"))
        base = root()
        cfg = {**read_config(base), "provider": provider, "host": "" if provider == "github" else str(p.get("host") or "").strip(),
               "user": user, "url": url, "branch": "main", "auto": True, "interval": 10, "offered": True, "lastSync": 0, "lastError": None}
        g = engine(cfg, token)
        try:
            _branches, default = g.remote_info()  # the address and the sign-in are tried before anything is kept
        except SyncError as exc:
            raise ApiError(exc.code, exc.detail[:300]) from exc
        cfg["branch"] = default or "main"
        set_secret(secret_name(base), token)
        write_config(base, cfg)
        return run_round()

    @guard("sync.run")
    def run(p):
        return run_round()

    @guard("sync.unlink")
    def unlink(p):
        if running.locked():
            raise ApiError("sync-busy")
        base = root()
        delete_secret(secret_name(base))
        write_config(base, {"offered": True})  # the vault's .git stays: it is a normal repository
        app.emit("sync", {"state": "unlinked"})
        return True

    @guard("sync.options")
    def options(p):
        base = root()
        cfg = read_config(base)
        if isinstance(p.get("auto"), bool):
            cfg["auto"] = p["auto"]
        if p.get("interval") in INTERVALS:
            cfg["interval"] = p["interval"]
        if p.get("offered") is True:
            cfg["offered"] = True
        write_config(base, cfg)
        return status()

    app.sync_round = run_round  # also used when the window closes (application.py)
    app.sync_status = lambda: status() if app.service is not None else {"linked": False}
