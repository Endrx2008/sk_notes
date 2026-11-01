#!/usr/bin/env python3
"""Plugin permission regression test (QA cycle 1, B-1 … B-5, B-21).

Starts sk_notes with two community plugins:
- `evil`: every permission denied; tries to get around the permission system;
- `trusted`: allowed to run programs; checks that a plugin's own rights still work.
Every native confirmation is answered "no" (SKN_TEST_CONFIRM). Prints one line per
probe and exits non-zero if any attack worked.

Usage: qa/security.py
"""

from __future__ import annotations

import http.server
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import App  # noqa: E402

EVIL = r"""
const { Plugin } = require('obsidian');
const fs = require('fs');
const cp = require('child_process');
async function raw(method, params, extra = '') {
  const b = new TextEncoder().encode(JSON.stringify(params));
  try { return await (await fetch('skn://api/' + method + '?len=' + b.length + extra, { method: 'POST', body: b })).json(); }
  catch (e) { return { ok: false, error: String(e) }; }
}
module.exports = class Evil extends Plugin {
  onload() {
    // runs once the test has set its globals (onload itself must not wait)
    const go = () => (window.__OUTSIDE ? this.attack() : setTimeout(go, 100));
    go();
  }
  async attack() {
    const P = {}, OUT = window.__OUTSIDE, V = this.app.vault.adapter;
    const t = async (name, fn) => { try { P[name] = await fn(); } catch (e) { P[name] = { ok: false, error: String(e.code || e.message || e) }; } };
    await t('selfgrant', () => raw('plugins.permissions', { id: 'evil', set: { exec: 'allow' } }));
    await t('exec_raw', () => raw('shim.exec', { cmd: 'sh', args: ['-c', 'echo X > ' + OUT + '/exec-raw.txt'] }));
    await t('exec_impersonate', () => raw('shim.exec', { cmd: 'sh', args: ['-c', 'echo X > ' + OUT + '/exec-imp.txt'] }, '&plugin=trusted'));
    await t('config_permissions', () => raw('config.write', { name: 'permissions.json', data: { evil: { exec: 'allow' } } }));
    await t('vault_permissions', () => raw('vault.write', { path: '.sk_notes/permissions.json', text: '{}' }));
    await t('adapter_permissions', () => V.write('.sk_notes/permissions.json', '{}'));
    await t('adapter_plugin_code', () => V.write('.sk_notes/plugins/trusted/main.js', 'x'));
    await t('rename_into_trusted', () => raw('vault.rename', { path: '.sk_notes/plugins/evil', newPath: '.sk_notes/plugins/trusted2' }));
    await t('install', () => raw('plugins.installFolder', { path: OUT + '/dropper' }));
    await t('enable_new', () => raw('plugins.setEnabled', { id: 'dropper', enabled: true }));
    await t('import_outside', () => raw('system.importFiles', { files: [OUT + '/secret.txt'], folder: '' }));
    await t('import_run', () => raw('import.run', { format: 'markdown', source: OUT, folder: 'imp' }));
    await t('publish_outside', () => raw('publish.write', { folder: OUT + '/pub', files: [{ path: 'a.txt', text: 'x' }] }));
    await t('fs_symlink', () => fs.promises.readFile('outlink/secret.txt', 'utf8'));
    await t('fs_symlink_write', () => fs.promises.writeFile('outlink/pwned.txt', 'x'));
    await t('own_exec', () => new Promise((ok, bad) => cp.exec('echo X > ' + OUT + '/exec-own.txt', (e) => (e ? bad(e) : ok('ran')))));
    await t('steal_require', () => (typeof this.app.plugins.makeRequire === 'function' ? 'makeRequire exposed' : { ok: false }));
    await t('localhost', async () => { await fetch('http://127.0.0.1:' + window.__LOCAL_PORT + '/probe', { mode: 'no-cors' }); return 'sent'; });
    window.__probes = P;
  }
};
"""

TRUSTED = r"""
const { Plugin } = require('obsidian');
const cp = require('child_process');
module.exports = class Trusted extends Plugin {
  async onload() {
    window.__trusted = await new Promise((ok) => cp.exec('echo trusted-ran', (e, out) => ok(e ? 'error ' + (e.code || e.message) : String(out).trim())));
  }
};
"""

DENY_ALL = {k: "deny" for k in ("fs-outside-vault", "exec", "network", "open-external", "clipboard")}


def build(base: Path) -> tuple[Path, Path]:
    vault, outside = base / "vault", base / "outside"
    (outside / "dropper").mkdir(parents=True)
    (outside / "secret.txt").write_text("TOP SECRET")
    (outside / "dropper" / "manifest.json").write_text(json.dumps({"id": "dropper", "name": "Dropper", "version": "1"}))
    (outside / "dropper" / "main.js").write_text("module.exports = class extends require('obsidian').Plugin {}")
    cfg = vault / ".sk_notes"
    for pid, src in (("evil", EVIL), ("trusted", TRUSTED)):
        d = cfg / "plugins" / pid
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps({"id": pid, "name": pid, "version": "1", "minAppVersion": "0"}))
        (d / "main.js").write_text(src)
    (cfg / "community-plugins.json").write_text(json.dumps(["trusted", "evil"]))
    (vault / "Home.md").write_text("# Home\n")
    os.symlink(outside, vault / "outlink")
    return vault, outside


class Hits(http.server.BaseHTTPRequestHandler):
    hits: list[str] = []

    def do_GET(self):  # noqa: N802
        Hits.hits.append(self.path)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


def main() -> int:
    srv = http.server.HTTPServer(("127.0.0.1", 0), Hits)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="skn-sec-") as tmp:
        vault, outside = build(Path(tmp))
        env = {"SKN_TEST_CONFIRM": "no"}
        with App(vault, port=9431, env=env, trust={"trusted": ["evil", "trusted"], "permissions": {"evil": DENY_ALL, "trusted": {**DENY_ALL, "exec": "allow"}}}) as app:
            app.page.js(f"(() => {{ window.__OUTSIDE = {json.dumps(str(outside))}; window.__LOCAL_PORT = {srv.server_port}; return 1; }})()")
            app.page.wait("!!window.__probes && window.__trusted !== undefined", timeout=60)
            probes = app.page.js("window.__probes")
            trusted = app.page.js("window.__trusted")
            time.sleep(1)
        failed = []

        def worked(v) -> bool:
            if isinstance(v, dict):
                return v.get("ok") is not False and "error" not in v
            return v not in (None, False)

        for name, v in probes.items():
            bad = worked(v)
            if name == "localhost":
                bad = bool(Hits.hits)
            if name == "selfgrant":  # the route answers; the permission must stay denied
                bad = (v.get("result") or {}).get("exec") == "allow"
            print(f"{'FAIL' if bad else 'ok  '}  {name}: {json.dumps(v)[:140]}")
            if bad:
                failed.append(name)
        for f in ("exec-raw.txt", "exec-imp.txt", "exec-own.txt", "pwned.txt", "pub"):
            if (outside / f).exists():
                failed.append(f"file {f}")
                print(f"FAIL  {f} was created outside the vault")
        if (vault / "secret.txt").exists() or (vault / "imp").exists():
            failed.append("outside file imported")
            print("FAIL  a file from outside the vault was imported")
        ok = trusted == "trusted-ran"
        print(f"{'ok  ' if ok else 'FAIL'}  trusted plugin can still use its own permission: {trusted!r}")
        if not ok:
            failed.append("trusted")
        print(f"\n{'all attacks blocked' if not failed else 'FAILED: ' + ', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
