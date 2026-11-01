#!/usr/bin/env python3
"""Bad community plugins must not lock the user out (QA cycle 1, B-19, B-20).

1. `never-ready` (onload() never resolves) is loaded before `after`: `after` must still load.
2. The app is killed with SIGKILL while plugins run: the next start offers safe mode
   (answered yes) and loads no plugin; after a normal close the next start is normal.

Usage: qa/plugin_safety.py
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import App  # noqa: E402

PLUGINS = {
    "never-ready": "module.exports = class extends require('obsidian').Plugin { onload() { return new Promise(() => {}); } };",
    "after": "module.exports = class extends require('obsidian').Plugin { onload() { window.__after = true; } };",
}


def build(base: Path) -> Path:
    v = base / "vault"
    cfg = v / ".sk_notes"
    for pid, src in PLUGINS.items():
        d = cfg / "plugins" / pid
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps({"id": pid, "name": pid, "version": "1", "minAppVersion": "0"}))
        (d / "main.js").write_text(src)
    (cfg / "community-plugins.json").write_text(json.dumps(list(PLUGINS)))
    (cfg / "app.json").write_text(json.dumps({"restrictedMode": False}))
    (v / "Home.md").write_text("# Home\n")
    return v


def main() -> int:
    results = []
    with tempfile.TemporaryDirectory(prefix="skn-psafe-") as tmp:
        vault = build(Path(tmp))
        home = Path(tmp) / "home"
        home.mkdir()
        env = {"SKN_TEST_CONFIRM": "yes"}
        app = App(vault, port=9441, home=str(home), env=env)
        with app:
            ok = app.page.js("new Promise((r) => { const end = Date.now() + 30000;"
                             " (function w() { if (window.__after) r(true); else if (Date.now() > end) r(false); else setTimeout(w, 200); })(); })",
                             timeout=40)
            results.append(("plugin after a never-ready one loads", ok))
            results.append(("not in safe mode", app.page.js("!app.info.safeMode")))
            os.killpg(app.proc.pid, signal.SIGKILL)  # crash while plugins run
            app.proc.wait(10)
        with App(vault, port=9442, home=str(home), env=env) as app2:
            time.sleep(2)
            results.append(("safe mode offered after the crash", app2.page.js("app.info.safeMode === true")))
            results.append(("no plugin loaded in safe mode", app2.page.js("Object.keys(app.plugins.plugins).length === 0")))
        # closed normally (SIGTERM): the next start is normal
        with App(vault, port=9443, home=str(home), env={"SKN_TEST_CONFIRM": "no"}) as app3:
            time.sleep(2)
            results.append(("normal start after a normal close", app3.page.js("app.info.safeMode === false && !!app.plugins.plugins.after")))
        shutil.rmtree(home, ignore_errors=True)
    failed = 0
    for name, ok in results:
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
