#!/usr/bin/env python3
"""Load each studied community plugin in sk_notes and record what happens.

For every plugin in research/plugins/*/release: install it into a scratch vault, enable
it alone, wait, collect load errors and uncaught exceptions, open its views and check
its commands, then unload it. Permissions are pre-set to "deny" so that no dialog
blocks the run (plugins that need them are reported as partial).

Usage: qa/plugin_compat.py <scratch dir> [plugin ids...]  → prints JSON results
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import App  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PERMS = ["fs-outside-vault", "exec", "network", "open-external", "clipboard"]


def make_vault(base: Path, ids: list[str]) -> Path:
    v = base / "compat-vault"
    if v.exists():
        shutil.rmtree(v)
    (v / "Projects").mkdir(parents=True)
    (v / "Home.md").write_text("---\ntags: [home]\nstatus: active\n---\n# Home\n\n- [ ] task one 📅 2026-11-01\n- [x] done\n\n[[Projects/Plan]] #tag\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", encoding="utf-8")
    (v / "Projects" / "Plan.md").write_text("# Plan\n\n```dataview\nLIST FROM #tag\n```\n\n> [!note] Callout\n> body\n", encoding="utf-8")
    cfg = v / ".sk_notes"
    (cfg / "plugins").mkdir(parents=True)
    for pid in ids:
        src = ROOT / "research" / "plugins" / pid / "release"
        if (src / "main.js").exists():
            shutil.copytree(src, cfg / "plugins" / pid)
    (cfg / "app.json").write_text(json.dumps({"restrictedMode": False}), encoding="utf-8")
    (cfg / "permissions.json").write_text(json.dumps({pid: {p: "deny" for p in PERMS} for pid in ids}), encoding="utf-8")
    (cfg / "community-plugins.json").write_text("[]", encoding="utf-8")
    return v


PROBE = r"""
(async (id) => {
  const before = app.plugins.errors[id];
  const views0 = new Set(Object.keys(app.viewRegistry.viewByType));
  const cmds0 = new Set(Object.keys(app.commands.commands));
  let ok = false, err = null;
  try { ok = await app.plugins.enablePluginAndSave(id); } catch (e) { err = String(e && e.message || e); }
  await sleep(2500);
  const views = Object.keys(app.viewRegistry.viewByType).filter((v) => !views0.has(v));
  const cmds = Object.keys(app.commands.commands).filter((c) => !cmds0.has(c));
  const viewResults = {};
  for (const v of views) {
    try {
      const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: v, active: true });
      await sleep(800);
      viewResults[v] = leaf.view && leaf.view.getViewType() === v ? 'ok' : 'empty';
      await leaf.detach();
    } catch (e) { viewResults[v] = 'error: ' + (e && e.message); }
  }
  const available = cmds.filter((c) => { try { return app.commands.isAvailable(app.commands.commands[c]); } catch { return false; } }).length;
  const loaded = !!app.plugins.plugins[id];
  const error = app.plugins.errors[id] || err || null;
  await app.plugins.disablePluginAndSave(id);
  return { loaded, error, views: viewResults, commands: cmds.length, commandsAvailable: available };
})
"""


def main() -> int:
    base = Path(sys.argv[1])
    ids = sys.argv[2:] or sorted(p.name for p in (ROOT / "research" / "plugins").iterdir() if (p / "release" / "main.js").exists())
    results = {}
    # one fresh app per plugin: big plugins never unload their code, and this
    # machine has 1.7 GB of RAM
    for n, pid in enumerate(ids):
        vault = make_vault(base, [pid])
        try:
            with App(vault, port=9399 - (n % 2)) as app:
                page = app.page
                time.sleep(2)
                page.console.clear()
                try:
                    r = page.js(f"({PROBE})({json.dumps(pid)})", timeout=120)
                except Exception as exc:  # noqa: BLE001
                    r = {"loaded": False, "error": f"probe failed: {exc}"}
                exc_lines = [c for c in page.console if c.startswith("exception") or "failed" in c or c.startswith("error")]
                r["exceptions"] = exc_lines[:5]
        except Exception as exc:  # noqa: BLE001
            r = {"loaded": False, "error": f"app failed: {exc}", "exceptions": []}
        results[pid] = r
        print(pid, json.dumps(r)[:400], flush=True, file=sys.stderr)
    print(json.dumps(results, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
