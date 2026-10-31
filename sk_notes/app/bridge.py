"""The ``skn://`` scheme: web assets, vault files and the JSON API used by the UI.

  skn://app/<file>              files of sk_notes/web/dist
  skn://vault/<path>            files of the open vault (images, PDFs, media)
  skn://api/<method>[?plugin=x] POST JSON → JSON {"ok": true, "result": ...} or
                                {"ok": false, "error": "<code>", "detail": "..."}

Handlers are plain functions ``fn(params: dict, ctx: Ctx) -> JSON``. Handlers
registered with ``slow=True`` run in a worker thread; the HTTP reply is sent when
they finish, so ``await fetch()`` simply waits. Everything else runs on the UI thread
(fast, and safe to show native dialogs from – needed for plugin permission prompts).
"""

from __future__ import annotations

import json
import logging
import mimetypes
import threading
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs

from PyQt6.QtCore import QBuffer, QByteArray, QFile, QIODevice, QObject, QRunnable, QThreadPool, pyqtSignal
from PyQt6.QtWebEngineCore import QWebEngineUrlRequestJob, QWebEngineUrlScheme, QWebEngineUrlSchemeHandler

log = logging.getLogger(__name__)
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
SCHEME = b"skn"

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("application/json", ".canvas")
mimetypes.add_type("text/markdown", ".md")


def register_scheme() -> None:
    """Must run before the QApplication is created."""
    s = QWebEngineUrlScheme(SCHEME)
    s.setSyntax(QWebEngineUrlScheme.Syntax.Host)
    F = QWebEngineUrlScheme.Flag
    s.setFlags(F.SecureScheme | F.LocalAccessAllowed | F.CorsEnabled | F.FetchApiAllowed
               | F.ContentSecurityPolicyIgnored)
    QWebEngineUrlScheme.registerScheme(s)


class ApiError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(code)
        self.code, self.detail = code, detail


@dataclass
class Ctx:
    plugin: str | None  # id of the community plugin making the call, if any
    sync: bool  # synchronous XHR (renderer blocked)


Handler = Callable[[dict, Ctx], Any]


class Api:
    def __init__(self):
        self.handlers: dict[str, tuple[Handler, bool]] = {}

    def register(self, name: str, fn: Handler, *, slow: bool = False) -> None:
        self.handlers[name] = (fn, slow)

    def route(self, name: str, *, slow: bool = False):
        def deco(fn):
            self.register(name, fn, slow=slow)
            return fn
        return deco

    def call(self, name: str, params: dict, ctx: Ctx) -> bytes:
        entry = self.handlers.get(name)
        if entry is None:
            return _json({"ok": False, "error": "unknown-method", "detail": name})
        try:
            return _json({"ok": True, "result": entry[0](params, ctx)})
        except ApiError as exc:
            return _json({"ok": False, "error": exc.code, "detail": exc.detail})
        except Exception as exc:  # noqa: BLE001 - every failure becomes a JSON error
            code = type(exc).__name__
            from ..core.vault import VaultError
            if isinstance(exc, VaultError):
                code = str(exc)
            elif isinstance(exc, FileNotFoundError):
                code = "not-found"
            elif isinstance(exc, PermissionError):
                code = "permission-denied"
            elif isinstance(exc, IsADirectoryError):
                code = "is-a-folder"
            else:
                log.error("API %s failed:\n%s", name, traceback.format_exc())
            return _json({"ok": False, "error": code, "detail": str(exc)})


def _json(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class _Task(QRunnable):
    def __init__(self, fn):
        super().__init__()
        self.fn = fn

    def run(self):
        self.fn()


class SchemeHandler(QWebEngineUrlSchemeHandler):
    _done = pyqtSignal(int, bytes, bytes)  # job key, mime, body (worker → UI thread)

    def __init__(self, api: Api, vault_root: Callable[[], Path | None], parent: QObject | None = None):
        super().__init__(parent)
        self.api = api
        self.vault_root = vault_root
        self.pool = QThreadPool(self)
        self.pool.setMaxThreadCount(4)
        self._jobs: dict[int, QWebEngineUrlRequestJob] = {}
        self._next = 0
        self._lock = threading.Lock()
        self._done.connect(self._finish)

    # ------------------------------------------------------------------ helpers
    def _reply(self, job: QWebEngineUrlRequestJob, mime: bytes, body: bytes) -> None:
        buf = QBuffer(parent=job)
        buf.setData(QByteArray(body))
        buf.open(QIODevice.OpenModeFlag.ReadOnly)
        job.reply(mime, buf)

    def _finish(self, key: int, mime: bytes, body: bytes) -> None:
        job = self._jobs.pop(key, None)
        if job is not None:
            try:
                self._reply(job, mime, body)
            except RuntimeError:
                pass  # request cancelled meanwhile

    # ------------------------------------------------------------------ entry
    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:  # noqa: N802 - Qt API
        url = job.requestUrl()
        host = url.host()
        path = url.path(QUrlFormattingOptions())
        try:
            if host == "app":
                self._serve_file(job, WEB_DIR, path.lstrip("/") or "index.html")
            elif host == "vault":
                root = self.vault_root()
                if root is None:
                    job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
                else:
                    self._serve_file(job, root, path.lstrip("/"), vault=True)
            elif host == "api":
                self._api(job, path.lstrip("/"), url.query())
            else:
                job.fail(QWebEngineUrlRequestJob.Error.UrlInvalid)
        except Exception:  # noqa: BLE001
            log.error("scheme handler failed for %s:\n%s", url.toString(), traceback.format_exc())
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)

    def _serve_file(self, job, base: Path, rel: str, vault: bool = False) -> None:
        base = base.resolve()
        target = (base / rel).resolve() if rel else base
        if base != target and base not in target.parents:
            if not (vault and (base / rel).parent.resolve().is_relative_to(base)):  # symlink inside vault
                job.fail(QWebEngineUrlRequestJob.Error.RequestDenied)
                return
        if not target.is_file():
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        mime = (mimetypes.guess_type(target.name)[0] or "application/octet-stream").encode()
        f = QFile(str(target), job)  # seekable device: media ranges work
        if not f.open(QIODevice.OpenModeFlag.ReadOnly):
            job.fail(QWebEngineUrlRequestJob.Error.RequestDenied)
            return
        job.reply(mime, f)

    def _api(self, job, method: str, query: str) -> None:
        q = parse_qs(query)
        dev = job.requestBody()
        raw = b""
        if dev is not None:
            dev.open(QIODevice.OpenModeFlag.ReadOnly)
            raw = bytes(dev.readAll())
        try:
            params = json.loads(raw) if raw else {}
            if not isinstance(params, dict):
                raise ValueError
        except ValueError:
            self._reply(job, b"application/json", _json({"ok": False, "error": "bad-request"}))
            return
        ctx = Ctx(plugin=(q.get("plugin") or [None])[0], sync=(q.get("sync") or ["0"])[0] == "1")
        entry = self.api.handlers.get(method)
        if entry is not None and entry[1] and not ctx.sync:
            with self._lock:
                key = self._next
                self._next += 1
            self._jobs[key] = job
            job.destroyed.connect(lambda *_a, k=key: self._jobs.pop(k, None))
            self.pool.start(_Task(lambda: self._done.emit(key, b"application/json",
                                                           self.api.call(method, params, ctx))))
            return
        self._reply(job, b"application/json", self.api.call(method, params, ctx))


def QUrlFormattingOptions():  # noqa: N802 - small helper to keep the call above readable
    from PyQt6.QtCore import QUrl
    return QUrl.ComponentFormattingOption.FullyDecoded
