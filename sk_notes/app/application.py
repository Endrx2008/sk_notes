"""sk_notes application: window, web engine profile, API wiring, watchers."""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from PyQt6.QtCore import QFileSystemWatcher, QObject, QTimer, QUrl, pyqtSignal
from PyQt6.QtGui import QDesktopServices, QIcon, QKeySequence, QShortcut
from PyQt6.QtNetwork import QLocalServer
from PyQt6.QtWidgets import QApplication, QFileDialog, QMainWindow, QMessageBox
from PyQt6.QtWebEngineCore import (QWebEnginePage, QWebEngineProfile, QWebEngineSettings,
                                   QWebEngineUrlRequestInterceptor)
from PyQt6.QtWebEngineWidgets import QWebEngineView

from ..core import i18n
from ..core.search import QueryError, search
from ..core.service import VaultService
from ..core.vault import VaultError, normalize_path
from . import config, uri as sknotes_uri
from .bridge import Api, ApiError, Ctx, SchemeHandler
from .watcher import VaultWatcher

log = logging.getLogger(__name__)
ICON = Path(__file__).resolve().parent.parent / "web" / "dist" / "logo.svg"
BIG_EVENT = 256 * 1024


class NetworkGuard(QWebEngineUrlRequestInterceptor):
    """Offline by default: the page may only reach skn://, data:, blob: and the local
    Ollama host. Remote hosts are allowed only after a plugin got the 'network'
    permission (raw fetch() cannot be attributed to a plugin; see docs)."""

    def __init__(self, app: "SkNotesApp"):
        super().__init__()
        self.app = app

    def interceptRequest(self, info):  # noqa: N802 - Qt API
        url = info.requestUrl()
        scheme = url.scheme()
        if scheme in ("skn", "data", "blob", "devtools", "chrome-devtools", "qrc", "about"):
            return
        if scheme in ("http", "https", "ws", "wss"):
            host = url.host()
            if host in ("localhost", "127.0.0.1", "::1"):
                return
            if self.app.remote_network_allowed():
                return
        info.block(True)


class Page(QWebEnginePage):
    def __init__(self, profile, app: "SkNotesApp", parent=None):
        super().__init__(profile, parent)
        self.app = app

    def acceptNavigationRequest(self, url, nav_type, is_main):  # noqa: N802 - Qt API
        if url.scheme() == "skn":
            return True
        if url.scheme() in ("http", "https", "mailto") and nav_type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked:
            QDesktopServices.openUrl(url)
            return False
        return url.scheme() in ("data", "blob", "about") or not is_main

    def createWindow(self, _type):  # noqa: N802 - window.open → pop-out window
        win = self.app.new_window(popout=True)
        return win.view.page()

    def javaScriptConsoleMessage(self, level, message, line, source):  # noqa: N802
        if level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            log.warning("JS %s:%s %s", source.rsplit("/", 1)[-1], line, message)


class MainWindow(QMainWindow):
    def __init__(self, app: "SkNotesApp", popout: bool = False):
        super().__init__()
        self.app = app
        self.popout = popout
        self.view = QWebEngineView(self)
        self.view.setPage(Page(app.profile, app, self.view))
        self.view.page().setBackgroundColor(Qt_color(app.theme))
        self.setCentralWidget(self.view)
        self.setWindowTitle("sk_notes")
        if ICON.exists():
            self.setWindowIcon(QIcon(str(ICON)))
        self._closing_ok = False
        self.devtools = None
        sc = QShortcut(QKeySequence("Ctrl+Shift+I"), self)
        sc.activated.connect(self.toggle_devtools)
        geo = app.settings.window
        if geo.get("w") and not popout:
            self.resize(geo["w"], geo["h"])
            if geo.get("max"):
                self.showMaximized()
        else:
            self.resize(1200, 800)

    def load(self, hash_part: str = "") -> None:
        self.view.setUrl(QUrl("skn://app/index.html" + (("#" + hash_part) if hash_part else "")))

    def toggle_devtools(self) -> None:
        if self.devtools is None:
            self.devtools = QWebEngineView()
            self.devtools.setWindowTitle("sk_notes – developer tools")
            self.view.page().setDevToolsPage(self.devtools.page())
            self.devtools.resize(900, 600)
        self.devtools.setVisible(not self.devtools.isVisible())

    def closeEvent(self, event):  # noqa: N802 - Qt API
        if self._closing_ok:
            if not self.popout:
                self.app.settings.window = {"w": self.width(), "h": self.height(), "max": self.isMaximized()}
                self.app.settings.save()
            event.accept()
            return
        event.ignore()

        def done(_result=None):
            if not self._closing_ok:
                self._closing_ok = True
                self.close()

        # let the UI save open editors first (max 3 s)
        self.view.page().runJavaScript("window.__skn && window.__skn.flush ? window.__skn.flush() : true", done)
        QTimer.singleShot(3000, done)


def Qt_color(theme: str):  # noqa: N802
    from PyQt6.QtGui import QColor
    return QColor("#0d0d0d" if theme == "dark" else "#f6f4f1")


class SkNotesApp(QObject):
    event_ready = pyqtSignal(str, str)  # name, json (thread-safe hop to the UI thread)

    def __init__(self, qapp: QApplication, vault_path: str | None = None):
        super().__init__()
        self.qapp = qapp
        self.settings = config.GlobalSettings.load()
        self.language = self.settings.language or i18n.system_language()
        self.theme = config.read_skai_theme()
        self.service: VaultService | None = None
        self.watcher: VaultWatcher | None = None
        self.windows: list[MainWindow] = []
        self.big_events: dict[int, str] = {}
        self._big_id = 0
        self.network_plugins: set[str] = set()
        self.page_ready = False
        self.pending_uris: list[str] = []
        self.uri_server: QLocalServer | None = None
        self.api = Api()
        self.event_ready.connect(self._deliver)

        storage = config.cache_dir() / "webengine"
        self.profile = QWebEngineProfile("sk_notes", qapp)
        self.profile.setPersistentStoragePath(str(storage))
        self.profile.setCachePath(str(storage / "cache"))
        self.profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.MemoryHttpCache)
        self.profile.setSpellCheckEnabled(False)
        s = self.profile.settings()
        A = QWebEngineSettings.WebAttribute
        for attr, on in ((A.LocalStorageEnabled, True), (A.JavascriptCanAccessClipboard, True),
                         (A.JavascriptCanPaste, True), (A.PluginsEnabled, False), (A.PdfViewerEnabled, True),
                         (A.LocalContentCanAccessRemoteUrls, False), (A.FullScreenSupportEnabled, True),
                         (A.ScrollAnimatorEnabled, False), (A.PlaybackRequiresUserGesture, False),
                         (A.JavascriptCanOpenWindows, True)):
            s.setAttribute(attr, on)
        self.guard = NetworkGuard(self)
        self.profile.setUrlRequestInterceptor(self.guard)
        self.scheme = SchemeHandler(self.api, self.vault_root, self)
        self.profile.installUrlSchemeHandler(b"skn", self.scheme)

        self.theme_watch = QFileSystemWatcher(self)
        self._watch_theme()
        self.theme_watch.fileChanged.connect(self._theme_changed)
        self.theme_watch.directoryChanged.connect(self._theme_changed)

        from . import api_core
        api_core.register(self)
        self._register_optional()

        if vault_path:
            self.open_vault(vault_path)
        elif self.settings.last_vault and Path(self.settings.last_vault).is_dir():
            self.open_vault(self.settings.last_vault)

    def _register_optional(self) -> None:
        """Feature modules register their own API methods."""
        import importlib
        for mod in ("sk_notes.ai.api", "sk_notes.plugins.api", "sk_notes.extras.api"):
            try:
                importlib.import_module(mod).register(self)
            except ModuleNotFoundError as exc:
                if exc.name and exc.name.startswith("sk_notes"):
                    continue
                raise

    # ------------------------------------------------------------------ vault
    def vault_root(self) -> Path | None:
        return self.service.vault.root if self.service else None

    def open_vault(self, path: str) -> dict:
        path = str(Path(path).expanduser().resolve())
        if self.service is not None and str(self.service.vault.root) == path:
            return {"path": path}
        if self.service is not None:
            raise ApiError("vault-already-open")
        try:
            self.service = VaultService(path, emit=self.emit)
        except VaultError as exc:
            raise ApiError(str(exc), path) from exc
        t0 = time.perf_counter()
        stats = self.service.open()
        log.info("vault ready in %.2fs (%s)", time.perf_counter() - t0, stats)
        self.watcher = VaultWatcher(self.service.vault.root, self)
        self.watcher.changed.connect(self.service.external_change)
        self.watcher.rescan.connect(self.service.rescan)
        self.settings.vaults[path] = {"ts": int(time.time() * 1000)}
        self.settings.last_vault = path
        self.settings.save()
        for w in self.windows:
            w.setWindowTitle(f"{self.service.vault.name} – sk_notes")
        self._listen_for_links(path)
        return {"path": path, **stats}

    # ------------------------------------------------------------------ sknotes:// links
    def _listen_for_links(self, vault: str) -> None:
        """Other `sk-notes sknotes://...` processes hand their link to us (we own this vault)."""
        name = sknotes_uri.server_name(vault)
        server = QLocalServer(self)
        server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        if not server.listen(name):
            QLocalServer.removeServer(name)  # stale socket left by a crash
            if not server.listen(name):
                log.warning("cannot listen for sknotes:// links: %s", server.errorString())
                return
        server.newConnection.connect(lambda: self._read_link(server))
        self.uri_server = server

    def _read_link(self, server: QLocalServer) -> None:
        sock = server.nextPendingConnection()
        if sock is None:
            return

        def done():
            data = bytes(sock.readAll()).decode("utf-8", "replace").strip()
            sock.disconnectFromServer()
            if data:
                self.handle_uri(data)
        sock.readyRead.connect(done)

    def handle_uri(self, link: str) -> None:
        try:
            action, params = sknotes_uri.parse(link)
        except sknotes_uri.UriError as exc:
            log.warning("ignored link %r: %s", link, exc)
            return
        if not self.page_ready:
            self.pending_uris.append(link)
            return
        if self.service:
            params = sknotes_uri.vault_relative(params, str(self.service.vault.root))
        self.emit("open-uri", {"action": action, "params": params})
        for w in self.windows[:1]:
            if w.isMinimized():
                w.showNormal()
            w.raise_()
            w.activateWindow()

    def set_page_ready(self) -> None:
        self.page_ready = True
        pending, self.pending_uris = self.pending_uris, []
        for link in pending:
            self.handle_uri(link)

    def remote_network_allowed(self) -> bool:
        return bool(self.network_plugins)

    # ------------------------------------------------------------------ windows
    def new_window(self, popout: bool = False) -> MainWindow:
        w = MainWindow(self, popout=popout)
        self.windows.append(w)
        w.destroyed.connect(lambda *_: self.windows.remove(w) if w in self.windows else None)
        if self.service:
            w.setWindowTitle(f"{self.service.vault.name} – sk_notes")
        return w

    def spawn_process(self, args: list[str]) -> None:
        main = Path(__file__).resolve().parent.parent.parent / "main.py"
        cmd = [sys.executable, str(main), *args] if main.exists() else ["sk-notes", *args]
        subprocess.Popen(cmd, start_new_session=True)  # noqa: S603 - our own launcher

    # ------------------------------------------------------------------ events
    def emit(self, name: str, payload: dict) -> None:
        """Send an event to every window (callable from any thread)."""
        self.event_ready.emit(name, json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    def _deliver(self, name: str, data: str) -> None:
        if len(data) > BIG_EVENT:
            self._big_id += 1
            self.big_events[self._big_id] = data
            data = json.dumps({"_fetch": self._big_id})
            # forget big payloads nobody fetched
            bid = self._big_id
            QTimer.singleShot(60_000, lambda: self.big_events.pop(bid, None))
        script = f"window.__skn && window.__skn.emit({json.dumps(name)}, {data});"
        for w in list(self.windows):
            w.view.page().runJavaScript(script)

    # ------------------------------------------------------------------ theme
    def _watch_theme(self) -> None:
        f = config.SKAI_THEME_FILE
        for p in (str(f), str(f.parent)):
            if Path(p).exists() and p not in self.theme_watch.files() + self.theme_watch.directories():
                self.theme_watch.addPath(p)

    def _theme_changed(self, *_):
        self._watch_theme()  # atomic replace drops the file watch
        theme = config.read_skai_theme()
        if theme != self.theme:
            self.theme = theme
            self.emit("skai-theme", {"theme": theme})

    def quit(self) -> None:
        if self.uri_server:
            self.uri_server.close()
        if self.watcher:
            self.watcher.close()
        if self.service:
            self.service.close()
