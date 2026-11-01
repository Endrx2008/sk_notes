"""The ``skn://`` scheme: web assets, vault files and the JSON API used by the UI.

  skn://app/<file>              files of sk_notes/web/dist
  skn://vault/<path>            files of the open vault (images, PDFs, media)
  skn://print/<token>.html      one-off pages handed to an off-screen print page
  skn://api/<method>?a=key|c=token  POST JSON (app key / plugin token, see callers.py) → JSON {"ok": true, "result": ...} or
                                {"ok": false, "error": "<code>", "detail": "..."}

Handlers are plain functions ``fn(params: dict, ctx: Ctx) -> JSON``. Handlers
registered with ``slow=True`` run in a worker thread; the HTTP reply is sent when
they finish, so ``await fetch()`` simply waits. Everything else runs on the UI thread
(fast, and safe to show native dialogs from – needed for plugin permission prompts).
A UI-thread handler that has to wait for Qt signals returns a ``Deferred`` and settles it
later; it must never spin a nested event loop inside the request (that froze the window
and the page it waited for never loaded).
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

from .callers import Callers

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
    key: str | None = None  # the app key, when the app itself is calling (see callers.py)


Handler = Callable[[dict, Ctx], Any]


class Deferred:
    """Result of a UI-thread handler that finishes later: call resolve() or reject() once."""

    def __init__(self):
        self._body: bytes | None = None
        self._cb: Callable[[bytes], None] | None = None

    def resolve(self, value: Any = None) -> None:
        self._settle(_json({"ok": True, "result": value}))

    def reject(self, code: str, detail: str = "") -> None:
        self._settle(_json({"ok": False, "error": code, "detail": detail}))

    @property
    def settled(self) -> bool:
        return self._body is not None

    def _settle(self, body: bytes) -> None:
        if self._body is not None:
            return
        self._body = body
        if self._cb:
            self._cb(body)

    def on_settled(self, cb: Callable[[bytes], None]) -> None:
        self._cb = cb
        if self._body is not None:
            cb(self._body)


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

    def call(self, name: str, params: dict, ctx: Ctx) -> bytes | Deferred:
        entry = self.handlers.get(name)
        if entry is None:
            return _json({"ok": False, "error": "unknown-method", "detail": name})
        try:
            result = entry[0](params, ctx)
            if isinstance(result, Deferred):
                return result
            return _json({"ok": True, "result": result})
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
            elif isinstance(exc, OSError) and exc.errno == 36:
                code = "name-too-long"
            elif isinstance(exc, OSError) and exc.errno in (28, 122):
                code = "disk-full"
            elif isinstance(exc, OSError) and exc.errno == 30:
                code = "read-only"
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
        self._uploads: dict[str, dict] = {}
        self.print_pages: dict[str, bytes] = {}  # token -> HTML, removed by the printer
        self.callers = Callers()
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
            elif host == "print":
                body = self.print_pages.get(path.strip("/").removesuffix(".html"))
                if body is None:
                    job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
                else:
                    self._reply(job, b"text/html", body)
            else:
                job.fail(QWebEngineUrlRequestJob.Error.UrlInvalid)
        except Exception:  # noqa: BLE001
            log.error("scheme handler failed for %s:\n%s", url.toString(), traceback.format_exc())
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)

    def _serve_file(self, job, base: Path, rel: str, vault: bool = False) -> None:
        base = base.resolve()
        if vault and rel and not (base / rel).exists():
            import unicodedata
            from ..core.vault import on_disk
            real = on_disk(base, unicodedata.normalize("NFC", rel))  # NFD names on disk
            if real is not None:
                rel = real.relative_to(base).as_posix()
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

    # large bodies arrive in parts (see core/api.js)
    def _store_part(self, upload_id: str, index: str, data: bytes) -> None:
        import time
        now = time.time()
        for k in [k for k, v in self._uploads.items() if now - v["ts"] > 120]:
            del self._uploads[k]
        entry = self._uploads.setdefault(upload_id, {"ts": now, "parts": {}, "size": 0})
        if entry["size"] + len(data) > MAX_BODY:
            return
        entry["parts"][int(index)] = data
        entry["size"] += len(data)

    def _take_upload(self, upload_id: str, count: int) -> bytes | None:
        entry = self._uploads.pop(upload_id, None)
        if not entry or len(entry["parts"]) != count:
            return None
        return b"".join(entry["parts"][i] for i in range(count))

    def _api(self, job, method: str, query: str) -> None:
        q = parse_qs(query)
        try:
            length = int((q.get("len") or ["0"])[0])
        except ValueError:
            length = 0
        raw = _read_body(job, length)
        # who is calling: the app (a=), a plugin (c=), or nobody (B3-1)
        caller = (q.get("c") or [None])[0]
        app_key = (q.get("a") or [None])[0]
        if method == "app.auth":
            key = self.callers.auth(json.loads(raw or b"{}").get("boot", "")) if raw else None
            body = _json({"ok": True, "result": key}) if key else _json({"ok": False, "error": "permission-denied", "detail": "no boot secret"})
            self._reply(job, b"application/json", body)
            return
        plugin = self.callers.plugin_for(caller)
        if plugin is None and not self.callers.is_app(app_key):
            self._reply(job, b"application/json", _json({"ok": False, "error": "permission-denied", "detail": "unauthenticated"}))
            return
        if method == "_upload":
            self._store_part((q.get("id") or [""])[0], (q.get("i") or ["0"])[0], raw)
            self._reply(job, b"application/json", _json({"ok": True, "result": True}))
            return
        if q.get("upload"):
            raw = self._take_upload(q["upload"][0], int((q.get("parts") or ["0"])[0]))
            if raw is None:
                self._reply(job, b"application/json", _json({"ok": False, "error": "upload-incomplete"}))
                return
        try:
            params = json.loads(raw) if raw else {}
            if not isinstance(params, dict):
                raise ValueError
        except ValueError:
            self._reply(job, b"application/json", _json({"ok": False, "error": "bad-request"}))
            return
        # the caller is known only from its token (c=); a "plugin=" in the URL proves nothing
        ctx = Ctx(plugin=plugin, sync=(q.get("sync") or ["0"])[0] == "1", key=app_key if plugin is None else None)
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
        res = self.api.call(method, params, ctx)
        if isinstance(res, Deferred):
            with self._lock:
                key = self._next
                self._next += 1
            self._jobs[key] = job
            job.destroyed.connect(lambda *_a, k=key: self._jobs.pop(k, None))
            res.on_settled(lambda body, k=key: self._finish(k, b"application/json", body))
            return
        self._reply(job, b"application/json", res)


MAX_BODY = 64 * 1024 * 1024


def _read_body(job, length: int) -> bytes:
    """Read exactly `length` bytes of the POST body (sent by core/api.js, at most 64 KB).
    Qt WebEngine 6.8's body device is sequential, reports size 0 and repeats its first
    64 KB block when read past the end, so the length must come from the client."""
    if length <= 0:
        return b""
    dev = job.requestBody()
    if dev is None:
        return b""
    if not dev.isOpen():
        dev.open(QIODevice.OpenModeFlag.ReadOnly)
    chunks, total = [], 0
    while total < length:
        data = dev.read(min(65536, length - total))  # None at the end / on error
        if not data:
            break
        chunks.append(bytes(data))
        total += len(chunks[-1])
    return b"".join(chunks)[:length]


def QUrlFormattingOptions():  # noqa: N802 - small helper to keep the call above readable
    from PyQt6.QtCore import QUrl
    return QUrl.ComponentFormattingOption.FullyDecoded
