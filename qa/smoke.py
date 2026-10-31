#!/usr/bin/env python3
"""UI smoke test: start sk_notes on a scratch vault (Xvfb + remote debugging) and walk
the main paths with real key presses. Prints one line per check and exits non-zero if
any check fails.

Usage: qa/smoke.py [--screenshots DIR]
Needs: xvfb-run, python3-websocket, the built front-end (node tools/build_web.mjs).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import App  # noqa: E402

NOTES = {
    "Home.md": "---\ntags: [start]\n---\n# Home\n\nWelcome. See [[Ideas]] and [[Projects/Plan|the plan]].\n\n- [ ] first task\n",
    "Ideas.md": "# Ideas\n\nA quiet garden of thoughts. #idea\n\n## Later\n\nsomething for later\n",
    "Projects/Plan.md": "# Plan\n\nStep one links back to [[Home]].\n",
}


def make_vault(base: Path) -> Path:
    v = base / "smoke-vault"
    for rel, text in NOTES.items():
        p = v / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return v


class Smoke:
    def __init__(self, app: App, vault: Path, shots: Path | None):
        self.app, self.page, self.vault, self.shots = app, app.page, vault, shots
        self.results: list[tuple[str, bool, str]] = []

    def check(self, name: str, fn) -> None:
        try:
            detail = fn() or ""
            self.results.append((name, True, str(detail)))
        except Exception as exc:  # noqa: BLE001
            self.results.append((name, False, f"{type(exc).__name__}: {exc}"))
            traceback.print_exc(file=sys.stderr)
        if self.shots:
            self.page.screenshot(self.shots / f"{len(self.results):02d}-{name.replace(' ', '-')}.png")
        self.page.key("Escape")
        time.sleep(0.2)

    def active_path(self):
        return self.page.js("app.workspace.getActiveFile()?.path || null")

    def open_with_switcher(self, query: str, expect: str):
        self.page.key("o", "ctrl")
        self.page.wait("!!document.querySelector('.prompt input')")
        self.page.type(query)
        self.page.wait("!!document.querySelector('.suggestion-item.is-selected')")
        self.page.key("Enter")
        # the note loads asynchronously: wait until its tab is the active leaf, not only the active file
        self.page.wait(f"(() => {{ const v = app.workspace.activeLeaf?.view; return v?.file?.path === {json.dumps(expect)} && !v.isLoading; }})()")

    # ------------------------------------------------------------------ checks
    def startup(self):
        assert self.app.startup < 15, self.app.startup
        return f"{self.app.startup:.1f}s including Xvfb"

    def switcher(self):
        self.open_with_switcher("idea", "Ideas.md")

    def edit_and_save(self):
        self.open_with_switcher("idea", "Ideas.md")
        self.page.js("(() => { const e = app.workspace.activeEditor.editor; e.setCursor(e.lastLine(), 0); e.focus(); })()")
        self.page.key("End", "ctrl")
        self.page.type("\nTyped by the smoke test [[Home]]")
        self.page.key("s", "ctrl")
        path = self.vault / "Ideas.md"
        end = time.time() + 10
        while time.time() < end and "Typed by the smoke test" not in path.read_text(encoding="utf-8"):
            time.sleep(0.2)
        assert "Typed by the smoke test [[Home]]" in path.read_text(encoding="utf-8")

    def backlinks(self):
        # Ideas.md (typed above) and Projects/*.md link to Home
        n = self.page.wait("Object.keys(app.metadataCache.resolvedLinks).filter((f) => app.metadataCache.resolvedLinks[f]['Home.md']).length >= 2"
                           " && Object.keys(app.metadataCache.resolvedLinks).filter((f) => app.metadataCache.resolvedLinks[f]['Home.md']).length", timeout=10)
        return f"{n} notes link to Home"

    def follow_link(self):
        self.open_with_switcher("home", "Home.md")
        self.page.js("(() => { const e = app.workspace.activeEditor.editor; const l = e.getValue().split('\\n').findIndex((x) => x.includes('[[Ideas]]'));"
                     " e.setCursor(l, e.getLine(l).indexOf('[[Ideas]]') + 3); e.focus(); })()")
        self.page.wait("!!document.activeElement?.closest('.workspace-leaf.mod-active .cm-editor')")
        self.page.key("Enter", "ctrl")
        try:
            self.page.wait("app.workspace.getActiveFile()?.path === 'Ideas.md'", timeout=10)
        except Exception:
            state = self.page.js("(() => { const e = app.workspace.activeEditor?.editor; return { file: app.workspace.getActiveFile()?.path,"
                                 " cursor: e?.getCursor(), line: e?.getLine(e.getCursor().line), focus: document.activeElement?.className }; })()")
            raise AssertionError(f"link not followed: {state}") from None

    def new_note(self):
        before = len(list(self.vault.rglob("*.md")))
        self.page.key("n", "ctrl")
        self.page.wait(f"app.vault.getMarkdownFiles().length === {before + 1}")
        name = self.page.wait("(() => { const p = app.workspace.getActiveFile()?.path; return p && p.startsWith('Untitled') ? p : null; })()")
        assert (self.vault / name).exists(), name
        # the editor must not paint CodeMirror's light default gutter on the dark theme
        bg = self.page.js("getComputedStyle(document.querySelector('.workspace-leaf.mod-active .cm-gutters')).backgroundColor")
        assert bg in ("rgba(0, 0, 0, 0)", "transparent"), bg
        return name

    def command_palette(self):
        self.page.key("p", "ctrl")
        self.page.wait("!!document.querySelector('.prompt input')")
        self.page.type("graph view")
        self.page.wait("!!document.querySelector('.suggestion-item.is-selected')")
        self.page.key("Enter")
        self.page.wait("app.workspace.getLeavesOfType('graph').length > 0")

    def search(self):
        self.page.key("f", "ctrl+shift")
        self.page.wait("!!document.activeElement?.closest('[data-type=\"search\"]')")
        self.page.type("garden")
        self.page.wait("document.querySelectorAll('[data-type=\"search\"] .tree-item.search-result').length >= 1", timeout=10)

    def rename_updates_links(self):
        self.page.js("(async () => { await app.fileManager.renameFile(app.vault.getAbstractFileByPath('Projects/Plan.md'), 'Projects/Roadmap.md'); return 1; })()")
        end = time.time() + 10
        home = self.vault / "Home.md"
        while time.time() < end and "Projects/Roadmap" not in home.read_text(encoding="utf-8"):
            time.sleep(0.2)
        text = home.read_text(encoding="utf-8")
        assert "[[Projects/Roadmap|the plan]]" in text, text

    def reading_view(self):
        self.open_with_switcher("home", "Home.md")
        self.page.key("e", "ctrl")
        self.page.wait("!!document.querySelector('.workspace-leaf.mod-active .markdown-reading-view h1')")
        self.page.key("e", "ctrl")

    def settings_languages(self):
        self.page.key(",", "ctrl")
        self.page.wait("!!document.querySelector('.modal.mod-settings')")
        n = self.page.js("Array.from(document.querySelectorAll('.modal.mod-settings select option')).filter((o) => /^(en|it|es|fr|de|pt|ru|zh-CN|ja)$/.test(o.value)).length")
        assert n >= 9, n

    def history(self):
        n = self.page.js("(async () => { const b = new TextEncoder().encode(JSON.stringify({ path: 'Home.md' }));"
                         " const r = await (await fetch('skn://api/history.list?len=' + b.length, { method: 'POST', body: b })).json();"
                         " return r.ok ? r.result.length : -1; })()")
        assert n >= 1, n

    def typing_during_file_switch(self):
        """Regression: a slow read while switching notes must not save the old text into the new file."""
        self.open_with_switcher("home", "Home.md")
        home_before = (self.vault / "Home.md").read_text(encoding="utf-8")
        ideas_before = (self.vault / "Ideas.md").read_text(encoding="utf-8")
        self.page.js("(() => { const r = app.vault.read.bind(app.vault); app.vault.__origRead = r;"
                     " app.vault.read = (f) => new Promise((ok) => setTimeout(() => ok(r(f)), 2500)); return 1; })()")
        try:
            self.page.js("(() => { app.workspace.openFile(app.vault.getAbstractFileByPath('Ideas.md')); return 1; })()")
            self.page.wait("app.workspace.activeLeaf?.view?.isLoading === true", timeout=5)
            self.page.js("(() => { const v = app.workspace.activeLeaf.view; v.cm.dispatch({ changes: { from: 0, insert: 'TYPED ' } }); return 1; })()")
            time.sleep(1.5)  # longer than the 1 s autosave delay, still loading
            self.page.wait("app.workspace.activeLeaf?.view?.isLoading === false", timeout=10)
            time.sleep(1.5)
        finally:
            self.page.js("(() => { app.vault.read = app.vault.__origRead; return 1; })()")
        assert (self.vault / "Ideas.md").read_text(encoding="utf-8") == ideas_before, "Ideas.md was overwritten"
        assert (self.vault / "Home.md").read_text(encoding="utf-8") == home_before, "Home.md was changed"
        assert self.page.js("app.workspace.activeLeaf.view.getViewData()") == ideas_before

    def _link(self, link: str) -> float:
        """Run a second `main.py <link>` like a desktop launcher would; it must hand over and exit."""
        h = self.app.home
        env = dict(os.environ, XDG_CONFIG_HOME=f"{h}/config", XDG_CACHE_HOME=f"{h}/cache", XDG_DATA_HOME=f"{h}/data")
        t0 = time.time()
        r = subprocess.run([sys.executable, str(Path(__file__).resolve().parent.parent / "main.py"), link], env=env,
                           capture_output=True, timeout=30)
        assert r.returncode == 0, r.stderr.decode()[-500:]
        return time.time() - t0

    def sknotes_links(self):
        secs = self._link("sknotes://open?vault=smoke-vault&file=Ideas")
        self.page.wait("app.workspace.activeLeaf?.view?.file?.path === 'Ideas.md'", timeout=10)
        self._link(f"sknotes://open?path={self.vault / 'Home.md'}")
        self.page.wait("app.workspace.activeLeaf?.view?.file?.path === 'Home.md'", timeout=10)
        self._link("sknotes://new?vault=smoke-vault&name=From%20link&content=hello%20link")
        self.page.wait("app.workspace.activeLeaf?.view?.file?.path === 'From link.md'", timeout=10)
        self._link("sknotes://new?vault=smoke-vault&file=From%20link&content=more&append=true&silent=true")
        end = time.time() + 10
        while time.time() < end and "more" not in (self.vault / "From link.md").read_text(encoding="utf-8"):
            time.sleep(0.2)
        assert (self.vault / "From link.md").read_text(encoding="utf-8") == "hello link\nmore"
        self._link("sknotes://search?vault=smoke-vault&query=quiet")
        self.page.wait("app.workspace.getLeavesOfType('search')[0]?.view?.input?.getValue() === 'quiet'", timeout=10)
        return f"hand-over {secs:.1f}s"

    def no_uncaught_errors(self):
        bad = [c for c in self.page.console if c.startswith("exception")]
        assert not bad, bad[:3]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--screenshots", type=Path)
    args = ap.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="skn-smoke-") as tmp:
        vault = make_vault(Path(tmp))
        with App(vault, port=9411) as app:
            time.sleep(1)
            s = Smoke(app, vault, args.screenshots)
            for name in ("startup", "switcher", "edit_and_save", "backlinks", "follow_link", "new_note", "command_palette",
                         "search", "rename_updates_links", "reading_view", "settings_languages", "history",
                         "typing_during_file_switch", "sknotes_links", "no_uncaught_errors"):
                s.check(name.replace("_", " "), getattr(s, name))
    failed = 0
    for name, ok, detail in s.results:
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    print(f"\n{len(s.results) - failed}/{len(s.results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
