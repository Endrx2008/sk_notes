#!/usr/bin/env python3
"""Main flows of popular community plugins, with real key presses (QA cycle 1, A-7, A-8).

Uses the release files kept in research/plugins/<id>/release (not committed); a plugin
whose files are missing is skipped. One app instance per plugin (1.7 GB machine).

Usage: qa/plugin_flows.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import App  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def vault_with(base: Path, pid: str, files: dict[str, str], data: dict | None = None) -> Path | None:
    src = ROOT / "research" / "plugins" / pid / "release"
    if not (src / "main.js").exists():
        return None
    v = base / pid
    cfg = v / ".sk_notes"
    shutil.copytree(src, cfg / "plugins" / pid)
    if data is not None:
        (cfg / "plugins" / pid / "data.json").write_text(json.dumps(data))
    (cfg / "app.json").write_text(json.dumps({"restrictedMode": False}))
    (cfg / "community-plugins.json").write_text(json.dumps([pid]))
    (cfg / "permissions.json").write_text(json.dumps({"__trusted__": [pid]}))
    for rel, text in files.items():
        p = v / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return v


def open_note(page, path: str) -> None:
    page.js(f"(async () => {{ await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath({json.dumps(path)})); return 1; }})()")
    page.wait(f"(() => {{ const v = app.workspace.activeLeaf?.view; return v?.file?.path === {json.dumps(path)} && !v.isLoading; }})()")


def templater(base: Path):
    """A-8: inserting a template from Templater's modal crashed the editor (CM5 mode without token())."""
    v = vault_with(base, "templater-obsidian", {"Templates/Tp.md": 'Created <% tp.date.now("YYYY") %> for <% tp.file.title %>',
                                                 "QA/Tpl.md": "# Tpl\n\n"}, {"templates_folder": "Templates"})
    if v is None:
        return "skip"
    with App(v, port=9461) as app:
        p = app.page
        time.sleep(2)
        open_note(p, "QA/Tpl.md")
        p.js("(() => { const e = app.workspace.activeEditor.editor; e.setCursor(e.lastLine(), 0); e.focus(); return 1; })()")
        p.console.clear()
        p.js("(() => { app.commands.executeCommandById('templater-obsidian:insert-templater'); return 1; })()")
        p.wait("!!document.querySelector('.suggestion-item')")
        p.type("Tp")
        time.sleep(0.5)
        p.key("Enter")
        end = time.time() + 10
        while "Created" not in (v / "QA/Tpl.md").read_text() and time.time() < end:
            time.sleep(0.3)
        text = (v / "QA/Tpl.md").read_text()
        assert "for Tpl" in text and "<%" not in text, text
        crashes = [c for c in p.console if "exception" in c or "crashed" in c]
        assert not crashes, crashes[:2]


def calendar(base: Path):
    """A-7: clicking a day must offer to create the daily note, and open an existing one."""
    today = time.strftime("%Y-%m-%d")
    other = time.strftime("%Y-%m-") + ("02" if time.strftime("%d") != "02" else "03")
    v = vault_with(base, "calendar", {"Home.md": "# Home", f"{other}.md": "# other day"})
    if v is None:
        return "skip"
    with App(v, port=9462, env={"SKN_TEST_CONFIRM": "yes"}) as app:
        p = app.page
        time.sleep(2)
        p.js("(() => { app.commands.executeCommandById('calendar:show-calendar-view'); return 1; })()")
        p.wait("!!document.querySelector('.calendar .day.today')")
        p.js("(() => { document.querySelector('.calendar .day.today').dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()")
        p.wait("!!document.querySelector('.modal button')")
        p.js("(() => { [...document.querySelectorAll('.modal button')].find((b) => b.classList.contains('mod-cta')).click(); return 1; })()")
        p.wait(f"app.workspace.getActiveFile()?.path === '{today}.md'", timeout=10)
        day = str(int(other[-2:]))
        p.js(f"(() => {{ const d = [...document.querySelectorAll('.calendar .day:not(.adjacent-month)')].find((x) => x.innerText.trim() === '{day}');"
             " d.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()")
        p.wait(f"app.workspace.getActiveFile()?.path === '{other}.md'", timeout=10)


def tasks(base: Path):
    """A-6: a `tasks` query block showed 1 of 5 tasks and threw DOM exceptions (the
    renderer kept section wrappers that Tasks does not expect)."""
    files = {f"Projects/P{i}.md": f"# P{i}\n\n- [ ] open task {i}\n- [x] done task {i}\n" for i in range(8)}
    files["QA/Tasks.md"] = "# Q\n\n```tasks\nnot done\npath includes Projects\nlimit 5\n```\n"
    v = vault_with(base, "obsidian-tasks-plugin", files)
    if v is None:
        return "skip"
    with App(v, port=9463) as app:
        p = app.page
        time.sleep(3)
        open_note(p, "QA/Tasks.md")
        p.console.clear()
        p.key("e", "ctrl")
        p.wait("document.querySelectorAll('.workspace-leaf.mod-active .markdown-reading-view .task-list-item').length >= 5", timeout=20)
        n = p.js("document.querySelectorAll('.workspace-leaf.mod-active .markdown-reading-view .task-list-item').length")
        assert n == 5, n
        errors = [c for c in p.console if c.startswith("exception")]
        assert not errors, errors[:2]


def dataview(base: Path):
    """A-5: inline queries rendered empty, plugin code blocks stayed raw in Live Preview and
    Dataview's Live Preview plugin crashed."""
    files = {f"Projects/P{i}.md": f"# P{i}" for i in range(3)}
    files["QA/Dv.md"] = 'top line\n\nInline: `= this.file.name`\n\n```dataview\nLIST FROM "Projects"\n```\n'
    v = vault_with(base, "dataview", files)
    if v is None:
        return "skip"
    with App(v, port=9464) as app:
        p = app.page
        time.sleep(3)
        open_note(p, "QA/Dv.md")
        p.js("(() => { app.workspace.activeEditor.editor.setCursor(0, 0); return 1; })()")
        p.wait("document.querySelectorAll('.workspace-leaf.mod-active .cm-sk-block-code .list-view-ul li').length === 3", timeout=20)
        p.key("e", "ctrl")
        p.wait("document.querySelector('.workspace-leaf.mod-active .markdown-reading-view .dataview-inline-query')?.innerText.trim() === 'Dv'", timeout=20)
        errors = [c for c in p.console if c.startswith("exception") or "crashed" in c]
        assert not errors, errors[:2]


def main() -> int:
    failed = 0
    with tempfile.TemporaryDirectory(prefix="skn-flows-") as tmp:
        for fn in (templater, calendar, tasks, dataview):
            try:
                r = fn(Path(tmp))
                print(f"{'SKIP' if r == 'skip' else 'PASS'}  {fn.__name__}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"FAIL  {fn.__name__}: {type(exc).__name__}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
