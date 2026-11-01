"""Core API methods: app, vaults, vault files, config, search, history, system."""

from __future__ import annotations

import base64
import logging
import os
import re
from pathlib import Path

from PyQt6.QtCore import QTimer, QUrl
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import QApplication, QFileDialog

from ..core import i18n
from ..core.search import QueryError, search, snippets
from ..core.vault import CONFIG_DIR, normalize_path
from . import config
from .bridge import ApiError, Ctx

log = logging.getLogger(__name__)


def process_age() -> float | None:
    """Seconds since this process was created (Linux /proc), or None."""
    try:
        start_ticks = int(Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19])
        uptime = float(Path("/proc/uptime").read_text().split()[0])
        return uptime - start_ticks / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError):
        return None


CONFIG_NAME_RE = re.compile(r"^(?:[A-Za-z0-9_.-]+\.json|plugins/[A-Za-z0-9_.-]+/data\.json|"
                            r"snippets/[^/]+\.css|themes/[^/]+/theme\.css)$")


# Written only by Python (plugin install, enable, permission dialogs): page code, plugins
# included, can never change what plugins may do or replace a plugin's code.
_PROTECTED = re.compile(r"^(permissions\.json|community-plugins\.json|rename-journal\.json(\.tmp)?|plugins(/[^/]+(/(main\.js|manifest\.json|styles\.css))?)?)$")


def protected(config_name: str) -> bool:
    """config_name: path inside .sk_notes/ (e.g. 'plugins/x/main.js')."""
    # a plugin's folder is its identity: moving another folder there would hand it that
    # plugin's permissions
    return bool(_PROTECTED.match(config_name.strip("/"))) or config_name.strip("/") == ""


def _plugins_allowed(app) -> bool:
    from ..plugins.permissions import plugins_allowed
    return bool(app.service) and plugins_allowed(app)


def register(app) -> None:
    api = app.api
    r = api.route

    def svc():
        if app.service is None:
            raise ApiError("no-vault")
        return app.service

    def check_plugin_write(ctx: Ctx, path: str) -> None:
        """Community plugins may write inside the vault (default permission) but never
        into sk_notes' own configuration folder except their own data. Nobody writes the
        files that decide what plugins may do through these routes (see protected())."""
        from ..plugins.permissions import protected_real
        if protected_real(app, str(svc().vault.root / path), write=True):  # symlinks too (B3-2)
            raise ApiError("permission-denied", path)
        if path == ".git" or path.startswith(".git/"):
            # git runs what its config says (fsmonitor, hooks, filters): never written by page code (B2-4)
            raise ApiError("permission-denied", path)
        if path == CONFIG_DIR or path.startswith(CONFIG_DIR + "/"):
            if path == CONFIG_DIR or protected(path[len(CONFIG_DIR) + 1:]):
                raise ApiError("permission-denied", path)
            if ctx.plugin and not path.startswith(f"{CONFIG_DIR}/plugins/{ctx.plugin}/"):
                raise ApiError("permission-denied", path)

    # ------------------------------------------------------------- app
    @r("app.info")
    def app_info(p, ctx):
        s = app.service
        return {
            "version": config.VERSION,
            "language": app.language,
            "languages": i18n.available(),
            "strings": i18n.strings(app.language),
            "theme": app.theme,
            "vault": {"name": s.vault.name, "path": str(s.vault.root)} if s else None,
            "home": str(Path.home()),
            "zoom": app.settings.zoom,
            "safeMode": app.safe_mode,
            "pluginsAllowed": _plugins_allowed(app),
            "renameRecovered": getattr(s, "recovered_rename", None) if s else None,
        }

    @r("app.setLanguage")
    def set_language(p, ctx):
        lang = p.get("language", "")
        if lang and lang not in {x["code"] for x in i18n.available()}:
            raise ApiError("unknown-language", lang)
        app.settings.language = lang
        app.settings.save()
        app.language = lang or i18n.system_language()
        return {"language": app.language, "strings": i18n.strings(app.language)}

    @r("app.setZoom")
    def set_zoom(p, ctx):
        z = max(0.5, min(3.0, float(p.get("zoom", 1.0))))
        app.settings.zoom = z
        app.settings.save()
        for w in app.windows:
            w.view.setZoomFactor(z)
        return z

    @r("app.relaunch")
    def relaunch(p, ctx):
        args = ["--vault", str(app.vault_root())] if app.vault_root() else []
        app.spawn_process(args)
        QApplication.instance().quit()
        return True

    @r("app.ready")
    def ready(p, ctx):
        """The page finished starting: log the time since the process was created."""
        if hasattr(app, "set_page_ready"):
            QTimer.singleShot(0, app.set_page_ready)  # after this reply: links waiting at start-up
        secs = process_age()
        if secs is not None and not getattr(app, "_ready_logged", False):
            app._ready_logged = True
            log.info("window ready %.2fs after process start (page %.0f ms) %s", secs, float(p.get("pageMs", 0)), p.get("marks") or "")
        return True

    @r("app.quit")
    def quit_(p, ctx):
        for w in list(app.windows):
            w.close()
        return True

    @r("events.fetch")
    def events_fetch(p, ctx):
        import json
        data = app.big_events.pop(int(p.get("id", -1)), None)
        if data is None:
            raise ApiError("not-found")
        return json.loads(data)

    # ------------------------------------------------------------- vaults
    @r("vaults.list")
    def vaults_list(p, ctx):
        out = []
        for path, info in sorted(app.settings.vaults.items(), key=lambda kv: -kv[1].get("ts", 0)):
            out.append({"path": path, "name": Path(path).name, "ts": info.get("ts", 0),
                        "exists": Path(path).is_dir(), "current": str(app.vault_root() or "") == path})
        return out

    @r("vaults.open")
    def vaults_open(p, ctx):
        path = str(Path(p["path"]).expanduser())
        if not Path(path).is_dir():
            raise ApiError("not-a-folder", path)
        if app.service is None:
            res = app.open_vault(path)
            return {"opened": "here", **res}
        if str(app.vault_root()) == str(Path(path).resolve()):
            return {"opened": "already"}
        app.spawn_process(["--vault", path])
        return {"opened": "new-window"}

    @r("vaults.create")
    def vaults_create(p, ctx):
        parent = Path(p["parent"]).expanduser()
        name = p["name"].strip()
        if not name or "/" in name or name in (".", ".."):
            raise ApiError("invalid-name")
        target = parent / name
        if target.exists() and any(target.iterdir()):
            raise ApiError("already-exists", str(target))
        target.mkdir(parents=True, exist_ok=True)
        return vaults_open({"path": str(target)}, ctx)

    @r("vaults.forget")
    def vaults_forget(p, ctx):
        app.settings.vaults.pop(p["path"], None)
        app.settings.save()
        return True

    @r("vaults.pickFolder")
    def pick_folder(p, ctx):
        parent = app.windows[0] if app.windows else None
        d = QFileDialog.getExistingDirectory(parent, p.get("title", ""), p.get("start", str(Path.home())))
        return d or None

    # ------------------------------------------------------------- vault files
    r("vault.snapshot", slow=True)(lambda p, ctx: svc().index.snapshot())

    @r("vault.read")
    def vault_read(p, ctx):
        return svc().read(p["path"])

    @r("vault.readBinary")
    def vault_read_binary(p, ctx):
        return base64.b64encode(svc().vault.read_bytes(p["path"])).decode("ascii")

    @r("vault.write")
    def vault_write(p, ctx):
        path = normalize_path(p["path"])
        check_plugin_write(ctx, path)
        return svc().write(path, p.get("text", ""), expected_mtime=p.get("expectedMtime"),
                           reason=p.get("reason", "edit"), mtime=(p["mtime"] / 1000) if p.get("mtime") else None)

    @r("vault.writeBinary")
    def vault_write_binary(p, ctx):
        path = normalize_path(p["path"])
        check_plugin_write(ctx, path)
        return svc().write_binary(path, base64.b64decode(p.get("data", "")))

    @r("vault.create")
    def vault_create(p, ctx):
        path = normalize_path(p["path"])
        check_plugin_write(ctx, path)
        return svc().create(path, p.get("text", ""))

    @r("vault.createUnique")
    def vault_create_unique(p, ctx):
        # the name with the numeric suffix it will really get is what is checked (B2-7, B3-5)
        path = svc().vault.available_path(p.get("folder", ""), p.get("base", "Untitled"), p.get("ext", "md"))
        check_plugin_write(ctx, normalize_path(path))
        return svc().write(path, p.get("text", ""))

    @r("vault.availablePath")
    def vault_available(p, ctx):
        return svc().vault.available_path(p.get("folder", ""), p.get("base", "Untitled"), p.get("ext", "md"))

    @r("vault.mkdir")
    def vault_mkdir(p, ctx):
        path = normalize_path(p["path"])
        check_plugin_write(ctx, path)
        return svc().mkdir(path)

    @r("vault.rename")
    def vault_rename(p, ctx):
        check_plugin_write(ctx, normalize_path(p["path"]))
        check_plugin_write(ctx, normalize_path(p["newPath"]))
        return svc().rename(p["path"], p["newPath"], update_links=p.get("updateLinks"))

    @r("vault.copy")
    def vault_copy(p, ctx):
        check_plugin_write(ctx, normalize_path(p["newPath"]))
        return svc().copy(p["path"], p["newPath"])

    @r("vault.delete")
    def vault_delete(p, ctx):
        check_plugin_write(ctx, normalize_path(p["path"]))
        return svc().delete(p["path"], mode=p.get("mode"))

    @r("vault.exists")
    def vault_exists(p, ctx):
        return svc().vault.exists(p["path"]) if normalize_path(p["path"]) != "/" else True

    @r("vault.stat")
    def vault_stat(p, ctx):
        e = svc().vault.stat(p["path"])
        if e is None:
            return None
        return {"type": "folder" if e.is_dir else "file", "size": e.size, "mtime": int(e.mtime * 1000),
                "ctime": int(e.ctime * 1000)}

    @r("vault.list")
    def vault_list(p, ctx):
        files, folders = svc().vault.list_dir(p.get("path", "/"))
        return {"files": files, "folders": folders}

    @r("vault.rescan")
    def vault_rescan(p, ctx):
        svc().rescan()
        return True

    # ------------------------------------------------------------- vault config (.sk_notes/*)
    @r("config.read")
    def config_read(p, ctx):
        name = p["name"]
        if not CONFIG_NAME_RE.match(name) or ".." in name:
            raise ApiError("bad-name", name)
        if ctx.plugin and not name.startswith(f"plugins/{ctx.plugin}/"):
            raise ApiError("permission-denied", name)
        path = svc().vault.config_dir / name
        if name.endswith(".css"):
            return path.read_text(encoding="utf-8") if path.exists() else None
        return svc().config_read(name, None)

    @r("config.write")
    def config_write(p, ctx):
        name = p["name"]
        if not CONFIG_NAME_RE.match(name) or ".." in name or name.endswith(".css"):
            raise ApiError("bad-name", name)
        if protected(name):
            raise ApiError("permission-denied", name)
        if ctx.plugin and not name.startswith(f"plugins/{ctx.plugin}/"):
            raise ApiError("permission-denied", name)
        svc().config_write(name, p.get("data"))
        return True

    @r("config.list")
    def config_list(p, ctx):
        kind = p.get("kind")
        base = svc().vault.config_dir
        if kind == "snippets":
            return sorted(f.name for f in (base / "snippets").glob("*.css")) if (base / "snippets").is_dir() else []
        if kind == "themes":
            return sorted(d.name for d in (base / "themes").iterdir() if (d / "theme.css").exists()) \
                if (base / "themes").is_dir() else []
        raise ApiError("bad-kind")

    @r("config.openFolder")
    def config_open_folder(p, ctx):
        sub = p.get("sub", "")
        if sub not in ("", "snippets", "themes", "plugins"):
            raise ApiError("bad-name")
        d = svc().vault.config_dir / sub
        d.mkdir(exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(d)))
        return True

    # ------------------------------------------------------------- search & history
    @r("search.query", slow=True)
    def search_query(p, ctx):
        try:
            return search(svc().index, p.get("query", ""), case_sensitive=bool(p.get("caseSensitive")),
                          context=int(p.get("context", 1)), limit_files=int(p.get("limit", 2000)),
                          snippet_files=int(p["snippetFiles"]) if p.get("snippetFiles") is not None else None)
        except QueryError as exc:
            raise ApiError("bad-query", str(exc)) from exc

    @r("search.snippets", slow=True)
    def search_snippets(p, ctx):
        try:
            return snippets(svc().index, p.get("query", ""), list(p.get("paths") or []),
                            case_sensitive=bool(p.get("caseSensitive")), context=int(p.get("context", 1)))
        except QueryError as exc:
            raise ApiError("bad-query", str(exc)) from exc

    @r("index.tags")
    def index_tags(p, ctx):
        return svc().index.all_tags()

    @r("index.properties")
    def index_props(p, ctx):
        return svc().index.properties()

    @r("history.list")
    def history_list(p, ctx):
        return svc().history.list(normalize_path(p["path"]))

    @r("history.files")
    def history_files(p, ctx):
        s = svc()
        return [dict(f, exists=f["path"] in s.index.files) for f in s.history.files()]

    @r("history.read")
    def history_read(p, ctx):
        return svc().history.read(int(p["id"]))

    @r("history.restore")
    def history_restore(p, ctx):
        return svc().restore_snapshot(p["path"], int(p["id"]))

    # ------------------------------------------------------------- system
    @r("system.openExternal")
    def open_external(p, ctx):
        url = QUrl(p["url"])
        if url.scheme() not in ("http", "https", "mailto"):
            raise ApiError("bad-url")
        if ctx.plugin:
            from ..plugins.permissions import require
            require(app, ctx, "open-external", p["url"])
        QDesktopServices.openUrl(url)
        return True

    @r("system.openPath")
    def open_path(p, ctx):
        target = svc().vault.abs(p["path"])
        if target.is_file() and (os.access(target, os.X_OK) or target.suffix.lower() in (".desktop", ".sh", ".exe", ".bat", ".py", ".appimage")):
            # opening a program or launcher with the default app would run it
            from ..plugins.permissions import require
            if ctx.plugin:
                require(app, ctx, "exec", str(target))
            else:
                raise ApiError("permission-denied", str(target))
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(target)))
        return True

    @r("system.showInFolder")
    def show_in_folder(p, ctx):
        target = svc().vault.abs(p.get("path", "/"))
        folder = target if target.is_dir() else target.parent
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))
        return True

    @r("system.pickFiles")
    def pick_files(p, ctx):
        parent = app.windows[0] if app.windows else None
        files, _ = QFileDialog.getOpenFileNames(parent, p.get("title", ""), str(Path.home()), p.get("filter", ""))
        from ..plugins.permissions import remember_path
        for f in files:
            remember_path(app, f)
        return files

    @r("system.importFiles")
    def import_files(p, ctx):
        """Copy external files (drag & drop, picker) into the vault."""
        from ..plugins.permissions import chosen, require
        s = svc()
        folder = p.get("folder", "")
        out = []
        for src in p.get("files", []):
            src_p = Path(src)
            if not src_p.is_file():
                continue
            if not chosen(app, src):  # only files the user picked, unless a plugin may read outside
                require(app, ctx, "fs-outside-vault", src)
            stem, dot, ext = src_p.name.rpartition(".")
            dest = s.vault.available_path(folder, stem if dot else src_p.name, ext if dot else "")
            s.write_binary(dest, src_p.read_bytes())
            out.append(dest)
        return out

    @r("system.env")
    def system_env(p, ctx):
        return {"desktop": os.environ.get("XDG_CURRENT_DESKTOP", ""), "wayland": bool(os.environ.get("WAYLAND_DISPLAY")),
                "hyprland": bool(os.environ.get("HYPRLAND_INSTANCE_SIGNATURE")), "i3": bool(os.environ.get("I3SOCK"))}

    # ------------------------------------------------------------- windows
    @r("window.setTitle")
    def set_title(p, ctx):
        title = str(p.get("title", ""))[:200]
        for w in app.windows:
            w.setWindowTitle(title)
        return True

    @r("window.toggleDevtools")
    def toggle_devtools(p, ctx):
        if app.windows:
            app.windows[0].toggle_devtools()
        return True

    @r("window.fullscreen")
    def fullscreen(p, ctx):
        for w in app.windows:
            w.showNormal() if w.isFullScreen() else w.showFullScreen()
        return True

    @r("window.popout")
    def popout(p, ctx):
        from urllib.parse import quote
        w = app.new_window(popout=True)
        w.load("popout=" + quote(p.get("state", "")))
        w.show()
        return True
