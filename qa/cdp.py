"""Minimal Chrome DevTools Protocol driver for UI tests of sk_notes.

The app is started with QTWEBENGINE_REMOTE_DEBUGGING=<port> under Xvfb; this module
connects to the page, evaluates JavaScript, sends real keyboard/mouse events and takes
screenshots. (Playwright's connectOverCDP does not support Qt WebEngine.)
Requires python3-websocket (Debian package), used only by tests."""

from __future__ import annotations

import base64
import itertools
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket

ROOT = Path(__file__).resolve().parent.parent

KEYCODES = {"Enter": 13, "Escape": 27, "Tab": 9, "Backspace": 8, "Delete": 46, "ArrowLeft": 37, "ArrowUp": 38,
            "ArrowRight": 39, "ArrowDown": 40, "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34, "F2": 113, "F11": 122,
            " ": 32, ",": 188, ".": 190, "/": 191, "[": 219, "]": 221, "-": 189, "=": 187, ";": 186}
CODES = {"Enter": "Enter", "Escape": "Escape", "Tab": "Tab", "Backspace": "Backspace", "Delete": "Delete",
         "ArrowLeft": "ArrowLeft", "ArrowUp": "ArrowUp", "ArrowRight": "ArrowRight", "ArrowDown": "ArrowDown",
         "Home": "Home", "End": "End", "F2": "F2", " ": "Space", ",": "Comma", ".": "Period", "/": "Slash",
         "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", ";": "Semicolon"}


class CdpError(RuntimeError):
    pass


class Page:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.ids = itertools.count(1)
        self.console: list[str] = []
        self.send("Runtime.enable")
        self.send("Page.enable")

    def send(self, method: str, params: dict | None = None, timeout: float = 60):
        mid = next(self.ids)
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            msg = json.loads(self.ws.recv())
            if msg.get("method") == "Runtime.consoleAPICalled":
                args = msg["params"].get("args", [])
                self.console.append(msg["params"]["type"] + ": " + " ".join(str(a.get("value", a.get("description", ""))) for a in args))
            elif msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                self.console.append("exception: " + (d.get("exception", {}).get("description") or d.get("text", "")))
            if msg.get("id") == mid:
                if "error" in msg:
                    raise CdpError(f"{method}: {msg['error']}")
                return msg.get("result", {})
        raise CdpError(f"{method}: timeout")

    def js(self, expr: str, timeout: float = 60):
        """Evaluate an expression (awaits promises) and return its JSON value."""
        r = self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True,
                                           "timeout": int(timeout * 1000)}, timeout=timeout + 5)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise CdpError("JS: " + (d.get("exception", {}).get("description") or d.get("text", "")))
        return r.get("result", {}).get("value")

    def wait(self, expr: str, timeout: float = 30, interval: float = 0.2):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = self.js(expr)
                if last:
                    return last
            except CdpError as e:
                last = str(e)
            time.sleep(interval)
        raise CdpError(f"wait timeout for {expr!r} (last={last!r})")

    # ------------------------------------------------------------- input
    def key(self, key: str, modifiers: str = ""):
        """key: 'a', 'Enter', 'F2'...; modifiers: e.g. 'ctrl', 'ctrl+shift', 'alt'."""
        mods = {m.strip().lower() for m in modifiers.split("+") if m.strip()}
        bits = (1 if "alt" in mods else 0) | (2 if "ctrl" in mods else 0) | (4 if "meta" in mods else 0) | (8 if "shift" in mods else 0)
        if len(key) == 1 and key not in CODES:
            code = ("Digit" + key) if key.isdigit() else ("Key" + key.upper())
            vk = ord(key.upper())
        else:
            code = CODES.get(key, key)
            vk = KEYCODES.get(key, 0)
        text = key if len(key) == 1 and not (mods & {"ctrl", "alt", "meta"}) else ""
        if text and "shift" in mods:
            text = text.upper()
        if key == "Enter" and not mods & {"ctrl", "alt", "meta"}:
            text = "\r"
        base = {"modifiers": bits, "key": key if not (len(key) == 1 and "shift" in mods) else key.upper(), "code": code,
                "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
        self.send("Input.dispatchKeyEvent", {"type": "keyDown" if text else "rawKeyDown", **base, "text": text, "unmodifiedText": text})
        self.send("Input.dispatchKeyEvent", {"type": "keyUp", **base})

    def type(self, text: str):
        self.send("Input.insertText", {"text": text})

    def type_keys(self, text: str):
        """Type character by character with key events (triggers input rules)."""
        for ch in text:
            if ch == "\n":
                self.key("Enter")
            else:
                self.send("Input.dispatchKeyEvent", {"type": "keyDown", "text": ch, "unmodifiedText": ch, "key": ch})
                self.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": ch})

    def click(self, x: float, y: float, button: str = "left", modifiers: int = 0, count: int = 1):
        for t in ("mousePressed", "mouseReleased"):
            self.send("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y, "button": button, "clickCount": count, "modifiers": modifiers})

    def click_selector(self, selector: str, **kw):
        r = self.js(f"(() => {{ const el = document.querySelector({json.dumps(selector)}); if (!el) return null; el.scrollIntoView({{block:'center'}}); const r = el.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; }})()")
        if not r:
            raise CdpError(f"no element {selector}")
        self.click(r[0], r[1], **kw)
        return r

    def screenshot(self, path: str | os.PathLike):
        data = self.send("Page.captureScreenshot", {"format": "png"})["data"]
        Path(path).write_bytes(base64.b64decode(data))

    def close(self):
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass


class App:
    """Start sk_notes on a vault under Xvfb with remote debugging; context manager."""

    def __init__(self, vault: str | os.PathLike, port: int = 9340, home: str | None = None, env: dict | None = None,
                 size: str = "1366x800"):
        self.vault, self.port, self.size = str(vault), port, size
        # a home made here is removed on exit (set SKN_KEEP_HOME=1 to keep logs and config)
        self._own_home = home is None
        self.home = home or tempfile.mkdtemp(prefix="skn-home-")
        self.env = env or {}
        self.proc = None
        self.page: Page | None = None
        self.log_path = Path(self.home) / "app.log"

    def __enter__(self) -> "App":
        try:
            return self._start()
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def _start(self) -> "App":
        env = dict(os.environ)
        env.update({"QTWEBENGINE_REMOTE_DEBUGGING": str(self.port), "XDG_CONFIG_HOME": f"{self.home}/config",
                    "XDG_CACHE_HOME": f"{self.home}/cache", "XDG_DATA_HOME": f"{self.home}/data",
                    "QT_QPA_PLATFORM": "xcb", "LANG": env.get("SKN_TEST_LANG", "en_US.UTF-8"), "LANGUAGE": ""})
        env.update(self.env)
        cmd = ["xvfb-run", "-a", "-s", f"-screen 0 {self.size}x24", sys.executable, str(ROOT / "main.py"), "--vault", self.vault]
        self.t0 = time.time()
        self.log = open(self.log_path, "w")
        self.proc = subprocess.Popen(cmd, env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        end = time.time() + 90
        url = None
        while time.time() < end and url is None:
            if self.proc.poll() is not None:
                raise CdpError("app exited: " + self.log_path.read_text()[-2000:])
            try:
                pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json", timeout=2))
                for p in pages:
                    if p.get("type") == "page" and p.get("url", "").startswith("skn://app"):
                        url = p["webSocketDebuggerUrl"]
            except Exception:  # noqa: BLE001
                time.sleep(0.3)
        if url is None:
            raise CdpError("no page")
        self.page = Page(url)
        self.page.wait("window.__sknReady === true || document.body.classList.contains('is-vault-manager')", timeout=90)
        self.startup = time.time() - self.t0
        return self

    def __exit__(self, *exc):
        if self.page:
            self.page.close()
        if self.proc and self.proc.poll() is None:  # whole group: xvfb-run, Xvfb, python, QtWebEngine
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        if getattr(self, "log", None):
            self.log.close()
        if self._own_home and not os.environ.get("SKN_KEEP_HOME"):
            shutil.rmtree(self.home, ignore_errors=True)
