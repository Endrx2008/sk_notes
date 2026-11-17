"""Test bench: open the Android page in Qt WebEngine (Chromium, like Android's WebView)
at a phone or tablet size, run steps and save screenshots.

    xvfb-run -a python3 shot.py URL OUTDIR STEPS.json [WIDTH HEIGHT]

Steps: [{"wait": ms}, {"js": "code returning a value"}, {"shot": "name"}, {"until": "js condition", "timeout": ms},
        {"tap": "css selector"}, {"type": "text"}, {"key": "Enter"}, {"size": [w, h]}]
Every js result and every console error is printed, so a run is its own log."""
import json
import os
import sys

from PyQt6.QtCore import QEventLoop, QPoint, QPointF, Qt, QTimer, QUrl
from PyQt6.QtGui import QMouseEvent
from PyQt6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWidgets import QApplication
from PyQt6.QtTest import QTest

url, outdir, steps_file = sys.argv[1:4]
width, height = (int(sys.argv[4]), int(sys.argv[5])) if len(sys.argv) > 5 else (412, 892)
os.makedirs(outdir, exist_ok=True)
app = QApplication(sys.argv[:1] + ["--no-sandbox"])
errors = []


class Page(QWebEnginePage):
    def javaScriptConsoleMessage(self, level, message, line, source):  # noqa: N802
        if level != QWebEnginePage.JavaScriptConsoleMessageLevel.InfoMessageLevel or os.environ.get("SHOT_VERBOSE"):
            text = f"[console {level.name}] {message} ({source.rsplit('/', 1)[-1]}:{line})"
            if "Synchronous XMLHttpRequest" in message:
                return
            errors.append(text)
            print(text, flush=True)


view = QWebEngineView()
page = Page(view)
view.setPage(page)
page.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, True)
view.resize(width, height)
view.show()


def wait(ms):
    loop = QEventLoop()
    QTimer.singleShot(ms, loop.quit)
    loop.exec()


def run(code):
    out = {}
    loop = QEventLoop()
    page.runJavaScript(code, lambda r: (out.__setitem__("r", r), loop.quit()))
    QTimer.singleShot(10000, loop.quit)
    loop.exec()
    return out.get("r")


def js(code, timeout=20000):
    """Run async JS and return its (JSON) value; runJavaScript itself does not wait for promises."""
    run("window.__shot = undefined; (async () => { %s })().then((v) => { window.__shot = JSON.stringify(v === undefined ? null : v); },"
        " (e) => { window.__shot = JSON.stringify({__error: String(e && e.stack || e)}); }); 0" % code)
    left = timeout
    while left > 0:
        r = run("window.__shot")
        if isinstance(r, str):
            try:
                return json.loads(r)
            except ValueError:
                return r
        wait(40)
        left -= 40
    return {"__error": "timeout"}


def target():
    return view.focusProxy() or view


loaded = QEventLoop()
page.loadFinished.connect(lambda ok: loaded.quit())
view.load(QUrl(url))
QTimer.singleShot(30000, loaded.quit)
loaded.exec()

failed = False
for step in json.load(open(steps_file, encoding="utf-8")):
    if "wait" in step:
        wait(step["wait"])
    elif "size" in step:
        view.resize(*step["size"])
        wait(400)
    elif "js" in step:
        r = js(step["js"])
        print("js>", json.dumps(r, ensure_ascii=False)[:2000], flush=True)
        if isinstance(r, dict) and "__error" in r:
            failed = True
    elif "until" in step:
        left = step.get("timeout", 15000)
        ok = False
        while left > 0:
            if js("return !!(%s)" % step["until"]) is True:
                ok = True
                break
            wait(150)
            left -= 150
        if not ok:
            print("TIMEOUT waiting for:", step["until"], flush=True)
            failed = True
    elif "tap" in step:
        pos = js("const e = document.querySelector(%s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]" % json.dumps(step["tap"]))
        if not pos:
            print("NOT FOUND:", step["tap"], flush=True)
            failed = True
        else:
            QTest.mouseClick(target(), Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, QPoint(int(pos[0]), int(pos[1])))
            wait(step.get("after", 350))
    elif "type" in step:
        QTest.keyClicks(target(), step["type"])
        wait(200)
    elif "key" in step:
        QTest.keyClick(target(), getattr(Qt.Key, "Key_" + step["key"]))
        wait(200)
    elif "shot" in step:
        wait(step.get("settle", 250))
        path = os.path.join(outdir, step["shot"] + ".png")
        view.grab().save(path)
        print("shot>", path, flush=True)

print("console problems:", len(errors), flush=True)
sys.exit(1 if failed else 0)
