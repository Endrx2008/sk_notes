#!/usr/bin/env python3
"""Measure sk_notes start-up: process start → window ready (logged by the app).

Starts one Xvfb, then launches the app N times on a vault and reads the
"window ready" line from its log. The first run builds the cache; later runs are
the normal case.

Usage: qa/startup_time.py [--runs 4] [--notes 200] [--vault PATH]
"""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
READY = re.compile(r"window ready ([\d.]+)s after process start \(page (\d+) ms\)")


def make_vault(base: Path, n: int) -> Path:
    v = base / "vault"
    for i in range(n):
        p = v / f"folder {i % 10}" / f"Note {i}.md"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"# Note {i}\n\nLinks to [[Note {(i * 7) % n}]] and #tag{i % 5}.\n\n" + "Some text. " * 40, encoding="utf-8")
    return v


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=4)
    ap.add_argument("--notes", type=int, default=200)
    ap.add_argument("--vault", type=Path)
    a = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="skn-start-") as tmp:
        base = Path(tmp)
        vault = a.vault or make_vault(base, a.notes)
        display = ":87"
        xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", "1366x800x24", "-nolisten", "tcp"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        time.sleep(1.5)
        times = []
        try:
            for i in range(a.runs):
                home = base / f"home{i if i == 0 else 1}"  # run 0: fresh config; later runs share one
                env = dict(os.environ, DISPLAY=display, QT_QPA_PLATFORM="xcb", XDG_CONFIG_HOME=str(home / "config"),
                           XDG_CACHE_HOME=str(home / "cache"), XDG_DATA_HOME=str(home / "data"), SK_NOTES_DEBUG="1")
                log = home / "cache" / "sk_notes" / "sk_notes.log"
                if log.exists():
                    log.unlink()
                proc = subprocess.Popen([sys.executable, str(ROOT / "main.py"), "--vault", str(vault)], env=env,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                found = None
                end = time.time() + 60
                while time.time() < end and not found:
                    time.sleep(0.2)
                    if log.exists():
                        found = READY.search(log.read_text(encoding="utf-8", errors="replace"))
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(10)
                if not found:
                    print(f"run {i}: no 'window ready' line in {log}")
                    return 1
                secs, page = float(found.group(1)), int(found.group(2))
                times.append(secs)
                text = log.read_text(encoding="utf-8", errors="replace")
                phases = " ".join(f"{m.group(1)}={m.group(2)}s" for m in re.finditer(r"startup: ([\w ]+?) at ([\d.]+)s", text))
                marks = re.search(r"page \d+ ms\) (\{.*\})", text)
                print(f"run {i} ({'cold cache' if i == 0 else 'warm'}): {secs:.2f}s | python: {phases} | page ms: {marks.group(1) if marks else '-'}")
                time.sleep(1)
        finally:
            os.killpg(xvfb.pid, signal.SIGTERM)
        warm = times[1:] or times
        print(f"warm median: {sorted(warm)[len(warm) // 2]:.2f}s over {len(warm)} runs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
