"""API for import, migration, Git and Syncthing sync, static site publishing, PDF export."""

from __future__ import annotations

import base64
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from xml.etree import ElementTree

from PyQt6.QtCore import QEventLoop, QMarginsF, QTimer, QUrl
from PyQt6.QtGui import QPageLayout, QPageSize
from PyQt6.QtWebEngineCore import QWebEnginePage
from PyQt6.QtWidgets import QFileDialog

from ..app.bridge import ApiError

log = logging.getLogger(__name__)


def register(app) -> None:
    r = app.api.route

    def svc():
        if app.service is None:
            raise ApiError("no-vault")
        return app.service

    def parent():
        return app.windows[0] if app.windows else None

    # ------------------------------------------------------------- import
    @r("import.pick")
    def import_pick(p, ctx):
        if p.get("folder"):
            return QFileDialog.getExistingDirectory(parent(), p.get("title", "")) or None
        f, _ = QFileDialog.getOpenFileName(parent(), p.get("title", ""), str(Path.home()), p.get("filter", ""))
        return f or None

    @r("import.run", slow=True)
    def import_run(p, ctx):
        from . import importers
        if ctx.plugin:
            raise ApiError("permission-denied")
        fmt = p["format"]
        fn = importers.IMPORTERS.get(fmt)
        if fn is None:
            raise ApiError("bad-format", fmt)
        src = Path(p["source"]).expanduser()
        if not src.exists():
            raise ApiError("not-found", str(src))
        s = svc()
        target = (p.get("folder") or "").strip("/")
        root = s.vault.root.resolve()
        if src.resolve() == root or root in src.resolve().parents:
            raise ApiError("source-inside-vault")
        count, notes, errors = 0, 0, []
        try:
            for rel, data in fn(src):
                rel = rel.strip("/")
                stem, dot, ext = rel.rpartition(".")
                folder, _, base = (stem if dot else rel).rpartition("/")
                full_folder = "/".join(x for x in (target, folder) if x)
                path = s.vault.available_path(full_folder, base or "Untitled", ext if dot else "")
                try:
                    if path.endswith(".md"):
                        s.write(path, data.decode("utf-8", errors="replace"), reason="import")
                        notes += 1
                    else:
                        s.write_binary(path, data)
                    count += 1
                except Exception as exc:  # noqa: BLE001 - keep importing the rest
                    errors.append(f"{rel}: {exc}")
        except Exception as exc:  # noqa: BLE001
            log.exception("import failed")
            raise ApiError("import-failed", str(exc)) from exc
        return {"files": count, "notes": notes, "errors": errors[:20]}

    # ------------------------------------------------------------- migration
    @r("migration.scan")
    def migration_scan(p, ctx):
        from . import migrate
        res = migrate.scan(svc().vault.root)
        for item in res.get("items", []):
            if item["id"] in ("settings", "hotkeys", "bookmarks", "graph"):
                item["preview"] = item["data"] if item["id"] != "bookmarks" else None
        return res

    @r("migration.apply")
    def migration_apply(p, ctx):
        from . import migrate
        if ctx.plugin:
            raise ApiError("permission-denied")
        return migrate.apply(svc(), list(p.get("items") or []))

    # ------------------------------------------------------------- git
    def git(*args, timeout=120, check=False):
        try:
            res = subprocess.run(["git", *args], cwd=svc().vault.root, capture_output=True, text=True, timeout=timeout)  # noqa: S603,S607
        except FileNotFoundError as exc:
            raise ApiError("git-missing") from exc
        except subprocess.TimeoutExpired as exc:
            raise ApiError("timeout", "git " + " ".join(args)) from exc
        if check and res.returncode:
            raise ApiError("git-failed", (res.stderr or res.stdout).strip()[:500])
        return res

    @r("git.status", slow=True)
    def git_status(p, ctx):
        if shutil.which("git") is None:
            return {"available": False}
        inside = git("rev-parse", "--is-inside-work-tree").stdout.strip() == "true"
        if not inside:
            return {"available": True, "repo": False}
        st = git("status", "--porcelain=v1", "-b").stdout.splitlines()
        branch = st[0][3:] if st and st[0].startswith("## ") else ""
        remote = git("remote").stdout.split()
        last = git("log", "-1", "--format=%h %cr %s").stdout.strip()
        return {"available": True, "repo": True, "branch": branch, "changes": len(st) - 1, "remotes": remote, "last": last,
                "files": [line[3:] for line in st[1:]][:200]}

    @r("git.init", slow=True)
    def git_init(p, ctx):
        git("init", check=True)
        gi = svc().vault.root / ".gitignore"
        if not gi.exists():
            gi.write_text(".sk_notes/cache.db*\n.sk_notes/history.db*\n.sk_notes/embeddings.db*\n.trash/\n", encoding="utf-8")
        return git_status(p, ctx)

    @r("git.commit", slow=True)
    def git_commit(p, ctx):
        git("add", "-A", check=True)
        msg = (p.get("message") or "").strip() or "sk_notes: update"
        res = git("-c", "user.name=" + (git("config", "user.name").stdout.strip() or "sk_notes"),
                  "-c", "user.email=" + (git("config", "user.email").stdout.strip() or "sk_notes@localhost"), "commit", "-m", msg)
        if res.returncode and "nothing to commit" not in (res.stdout + res.stderr):
            raise ApiError("git-failed", (res.stderr or res.stdout).strip()[:500])
        return {"committed": res.returncode == 0, "output": res.stdout.strip()[-500:]}

    @r("git.pull", slow=True)
    def git_pull(p, ctx):
        res = git("pull", "--rebase", "--autostash", timeout=300)
        if res.returncode:
            raise ApiError("git-failed", (res.stderr or res.stdout).strip()[:500])
        svc().rescan()
        return {"output": res.stdout.strip()[-500:]}

    @r("git.push", slow=True)
    def git_push(p, ctx):
        res = git("push", timeout=300)
        if res.returncode:
            raise ApiError("git-failed", (res.stderr or res.stdout).strip()[:500])
        return {"output": (res.stdout + res.stderr).strip()[-500:]}

    @r("git.setRemote", slow=True)
    def git_set_remote(p, ctx):
        url = p.get("url", "").strip()
        if not url or re.search(r"\s", url):
            raise ApiError("bad-url")
        if "origin" in git("remote").stdout.split():
            git("remote", "set-url", "origin", url, check=True)
        else:
            git("remote", "add", "origin", url, check=True)
        return True

    # ------------------------------------------------------------- syncthing
    @r("syncthing.status", slow=True)
    def syncthing_status(p, ctx):
        import urllib.request
        cfg = None
        for c in (Path.home() / ".local/state/syncthing/config.xml", Path.home() / ".config/syncthing/config.xml"):
            if c.exists():
                cfg = c
                break
        installed = shutil.which("syncthing") is not None
        if cfg is None:
            return {"installed": installed, "configured": False}
        try:
            root = ElementTree.parse(cfg).getroot()
        except ElementTree.ParseError:
            return {"installed": installed, "configured": False}
        api_key = root.findtext("gui/apikey") or ""
        address = root.findtext("gui/address") or "127.0.0.1:8384"
        vault = str(svc().vault.root)
        folder = None
        for f in root.findall("folder"):
            path = os.path.expanduser(f.get("path", "")).rstrip("/")
            if path == vault:
                folder = {"id": f.get("id"), "label": f.get("label"), "devices": len(f.findall("device"))}
        out = {"installed": installed, "configured": True, "gui": f"http://{address}", "shared": folder is not None, "folder": folder}
        if folder and api_key:
            try:
                req = urllib.request.Request(f"http://{address}/rest/db/status?folder={folder['id']}", headers={"X-API-Key": api_key})
                with urllib.request.urlopen(req, timeout=3) as resp:  # noqa: S310 - local Syncthing
                    import json
                    st = json.load(resp)
                out["state"] = st.get("state")
                out["needFiles"] = st.get("needFiles")
                out["running"] = True
            except Exception:  # noqa: BLE001
                out["running"] = False
        return out

    # ------------------------------------------------------------- static site
    @r("publish.pickFolder")
    def publish_pick(p, ctx):
        return QFileDialog.getExistingDirectory(parent(), p.get("title", "")) or None

    @r("publish.write")
    def publish_write(p, ctx):
        if ctx.plugin:
            raise ApiError("permission-denied")
        out = Path(p["folder"]).expanduser().resolve()
        root = svc().vault.root.resolve()
        if out == root or root in out.parents:
            raise ApiError("output-inside-vault")
        out.mkdir(parents=True, exist_ok=True)
        for f in p.get("files", []):
            rel = Path(f["path"])
            if rel.is_absolute() or ".." in rel.parts:
                raise ApiError("bad-path", f["path"])
            target = out / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if "text" in f:
                target.write_text(f["text"], encoding="utf-8")
            elif "vault" in f:
                shutil.copy2(svc().vault.abs(f["vault"]), target)
            else:
                target.write_bytes(base64.b64decode(f.get("b64", "")))
        return {"folder": str(out), "files": len(p.get("files", []))}

    @r("publish.open")
    def publish_open(p, ctx):
        from PyQt6.QtGui import QDesktopServices
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(Path(p["folder"]) / "index.html")))
        return True

    # ------------------------------------------------------------- PDF
    @r("export.pdf")
    def export_pdf(p, ctx):
        name = re.sub(r'[\\/:*?"<>|]+', "-", p.get("name") or "note")
        default = str((Path.home() / "Documents" if (Path.home() / "Documents").is_dir() else Path.home()) / f"{name}.pdf")
        target, _ = QFileDialog.getSaveFileName(parent(), "PDF", default, "PDF (*.pdf)")
        if not target:
            return None
        html = ("<!doctype html><html><head><meta charset='utf-8'><style>" + p.get("css", "") +
                "\nbody{background:#fff;color:#111;margin:0;padding:0 8px;font-family:sans-serif}"
                ".copy-code-button{display:none}</style></head><body class='theme-light'>" + p.get("html", "") + "</body></html>")
        page = QWebEnginePage(app.profile)
        loop = QEventLoop()
        page.loadFinished.connect(lambda ok: loop.quit())
        page.setHtml(html, QUrl("skn://app/"))
        QTimer.singleShot(20000, loop.quit)
        loop.exec()
        done = {"ok": False}
        page.pdfPrintingFinished.connect(lambda path, ok: (done.update(ok=ok), loop.quit()))
        layout = QPageLayout(QPageSize(QPageSize.PageSizeId.A4), QPageLayout.Orientation.Portrait, QMarginsF(15, 15, 15, 15))
        QTimer.singleShot(500, lambda: page.printToPdf(target, layout))
        QTimer.singleShot(60000, loop.quit)
        loop.exec()
        page.deleteLater()
        if not done["ok"]:
            raise ApiError("pdf-failed")
        return target
