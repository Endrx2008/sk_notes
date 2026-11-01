# QA cycle 4 - agent B (final verification, destructive tester)

Commit under test: `48fa78f` (main). One instance at a time under Xvfb (`qa/cdp.py`), ports 9550-9569, `systemd-run --scope MemoryMax=700M`, `TMPDIR=qa/tmp/agent-B4/tmp`. Scripts and outputs: `qa/tmp/agent-B4/` (`out/*.txt`), cycle-3 scripts re-run unchanged from `qa/tmp/agent-B3/`. Native dialogs answered "no" unless noted.

## Re-run of earlier bugs

| Bug | Status | Evidence |
|---|---|---|
| B3-1 note HTML (`<img>`, iframe form) calls the API | fixed | `p3_hostile.py view`: `outside = []`, Victim.md intact, git log unchanged; every raw call answers `permission-denied / unauthenticated`; `qa/smoke.py` 32/32 incl. "note html cannot call the api" |
| B3-2 symlinks to `.git`, plugin folder, trust store | fixed | new `p_sym.py` (plugin with its own token, via adapter, vault, fs): all writes/renames/copies/removes/mkdir through `gl/`, `pl/`, `tl/` -> `permission-denied` / `EACCES`; trust file, `.git/config`, `trusted/main.js` unchanged; `p2_symlink.py` same |
| B3-3 plugin re-enables dormant trusted plugin by raw call | fixed for raw calls (`unauthenticated`); via `app.plugins` objects it is an accepted limit | `p7_dormant.py`, `p4_misc.py` |
| B3-4 scripted link clicks / openPath(html) | fixed | `sec5_net.py`: synthetic click does not call xdg-open (`xdg-open log: None`); `openPath_html`, `publish_open` unauthenticated |
| B3-5 / B2-7 createUnique into plugin folders | fixed | `sec2.py`: `createUnique_*` unauthenticated; with token (`p_sym.py`) `create` into `pl/trusted/` denied |
| B2-1 navigate main window to vault HTML | fixed | `sec7_nav.py`: only `skn://app` loads, `nav-pwn.txt: None` |
| B2-2 pop-up steals boot secret | fixed | `sec4_popup.py`: `popup-pwn.txt exists: False` |
| B2-3 token theft by patching globals | fixed for patching of Function/fetch/XHR/encodeURIComponent/Resource Timing (`sec2.py` `stolen_passive: 0`); **a new route exists, see B4-1** | `sec2.py`, `p_then.py` |
| B2-4 shell commands through Git config | fixed (direct and symlink writes denied); hostile vault shipped with its own `.git`: see B4-3 | `p_sym.py`, `sec2.py` |
| B2-5 hostile vault runs plugins with pre-granted rights | fixed | `p3_hostile.py open` (vault ships `permissions.json`, `trust.json`, enabled plugin): `plugin-ran.txt` absent, plugins list empty; `sec3_nested.py`: no `nested-pwn.txt` after 150 s |
| B2-6 loading a disabled plugin | fixed | `sec2.py` `load_disabled` produces no file |
| B2-8 delete root | fixed | unauthenticated / `vault-root` (cycle-3 offline tests unchanged code path) |
| B2-9 network / exfiltration | fixed except WebRTC (accepted) | `sec5_net.py`: `ollama_pull` "Failed to fetch", `img_remote` blocked, click does not open |
| B2-10 non-UTF-8 file name crashes start | fixed (not re-run offline; code path covered by unit tests, `unittest discover` OK) | - |
| B2-11 external change within 2 s of a save overwritten | fixed | `t_data2.py` / `t_data3.py` (delays 0.1-0.7 s after a save, single and two panes): external text is in history as `external` snapshot every time, user text kept, notice shown (appears ~1-2 s after the write) |
| regression suites | pass | `q_security.py` "all attacks blocked"; `qa/smoke.py` 32/32; `unittest discover tests` OK |

## New bugs

### B4-1: A running plugin can steal another plugin's token (and so its rights) by hooking `Object.prototype.then` / promise resolution
**Severity:** high (permission bypass, needs one user action: enabling a second plugin in the same session)
**Steps:** `qa/tmp/agent-B4/p_then.py`. Vault: `evil` (enabled, trusted, every permission denied) and `newp` (installed and trusted with `exec: allow`, not enabled). `evil.onload` installs
`Object.defineProperty(Object.prototype, 'then', {get(){ record(this); return undefined; }})`; `record` keeps every object that looks like `{ok:true, result:"<string>"}`. The user then enables `newp` through the app (`app.plugins.enablePluginAndSave('newp')`; in the real UI: the toggle in Settings > Community plugins). `evil` then calls `skn://api/shim.exec?c=<captured token>` directly.
**Expected:** a plugin never sees the token of another plugin (documented in `app/callers.py`, `plugins/manager.js`).
**Actual:** `seen: ['qxCC-1h2R...']`; `newp` token captured; `shim.exec` with it returned `{ok:true, result:{code:0}}` and `stolen-0.txt` / `stolen-1.txt` were created outside the vault - arbitrary commands with `newp`'s `exec` right, though `evil` has none. Reason: `plugins.token` (`tokenFor` -> `pluginToken` -> `call`) returns the token inside an object that is resolved through async functions (`fetchJson`, `call`); resolving a promise with an object does `Get(obj, "then")`, which a plugin can intercept (so can `Promise.prototype.then` for the `.json()` promise that `fetchJson` returns). The early capture of `fetch`, `Response.json`, `Reflect.apply` etc. in `core/api.js` does not protect values that travel through promises. The startup batch (`plugins.tokens`) is safe because it completes before any plugin runs; every later token request is exposed (enabling a plugin, install + enable, anything calling `tokenFor` after startup).
**Suggested fix:** fetch tokens without handing the object to a promise chain a plugin can observe (e.g. synchronous XHR with the captured natives writing straight into the module variable, or a null-prototype result created with captured primitives and consumed by `await` on a native promise only), or issue all tokens at startup for every installed trusted plugin and never again.
**Evidence:** `qa/tmp/agent-B4/out/agent-B4_p_then.py.txt`.

### B4-2: Plugin read / copy / rename / delete reach outside the vault through a symlinked folder (the documented limit says only "write")
**Severity:** low-medium (same trust boundary as the accepted limit; the documentation understates it)
**Steps:** `qa/tmp/agent-B4/p_sym.py`: vault contains `out -> <folder outside the vault>`. Plugin with every permission denied, through `app.vault.adapter`: `read('out/secret.txt')` -> content; `copy('out/secret.txt','stolen.txt')` and `rename('out/secret2.txt','moved.txt')` pull outside files into the vault; `remove('out/secret3.txt')` and `rmdir('out/victimdir', true)` delete outside files/folders recursively; `mkdir`, `write`, `list` work. `fs.promises.readFile('out/secret.txt')` correctly gives `EACCES`.
**Expected:** `fs-outside-vault` applies to the adapter as it does to `fs` (at least for read, rename and recursive delete).
**Actual:** all succeed; `outside:` lost `secret3.txt` and `victimdir`. Plain `skn://vault/out/secret.txt` fetches still time out (fine).
Also: the trust store file can be **read** through a symlink `tl -> <config>/sk_notes/vault-trust` (`trust_read`); writes are denied.
**Note:** a symlink pointing outside the vault must be created by the user (plugins cannot create symlinks: `fs.promises.symlink is not a function`), so this is the accepted class; reported because the docs only list "write".

### B4-3: A cloned/unzipped vault's own `.git` (hooks, `[filter]` clean commands) runs on commit; no trust prompt
**Severity:** medium
**Steps:** manual reproduction with the same flags as `git()` in `extras/api.py`: repo with `.git/hooks/pre-commit` (executable) and `[filter "pw"] clean = ...` plus `.gitattributes` `* filter=pw`, then `git -c core.fsmonitor=false add -A && git commit` -> both hooks and filter ran (`ran.txt`: FILTER x4, HOOK). `git status` alone did not run the filter. In the app the trigger is the Commit/Sync button, the auto-commit timer (`features/extras.js` line 38) or the earlier B3-1 route (now closed). The `git()` wrapper only turns off `core.fsmonitor`.
**Expected:** a vault that arrives from outside gets the same "trust on this machine" treatment as its plugins: run git with `-c core.hooksPath=/dev/null`, ignore repo-local `filter.*.clean/smudge/process` (e.g. `GIT_CONFIG_*`/`-c` overrides, or refuse until the user accepts the repo).
**Actual:** shell commands from the vault run with the user's rights as soon as a commit happens (by user click or timer).

### B4-4: Replacing a trusted plugin by "Install from GitHub/folder" shows no hint that it overwrites an existing trusted plugin
**Severity:** low (needs a user click on a native dialog)
**Steps (code reading, not run: no network in the test VM):** a running plugin calls `app.plugins.installPlugin('attacker/repo')` (`compat/internals.js` -> `plugins.installGithub` as the app). The release's `manifest.json` has `id` of an already trusted plugin (e.g. `trusted`) and any `name`. `_confirm_install` shows only the attacker-chosen name and the source; on "Install" `main.js` of `trusted` is replaced and keeps its trust and `exec` right (trust is by plugin id, not by code hash). Same for code arriving by sync/git pull.
**Suggested fix:** say "replaces installed plugin X (has: exec...)" in the dialog, or drop trust when `main.js` changes.

## Cosmetic / minor
- `.SK_NOTES/plugins/trusted/main.js` (upper case) is accepted by `check_plugin_write` (`p_sym.py` `plug_write_case: ok`); harmless on ext4 (creates a separate folder) but would hit the real plugin folder on a case-insensitive file system (exFAT/NTFS/vfat vault).
- Notice "changed outside sk_notes" after an external write appears only after the debounce (~1-2 s) - fine, noted because a quick check looks as if there were none.
- A same-size external edit that also keeps the identical mtime (to the ms) cannot be detected (`t_data.py` step 7, crafted with `os.utime`; not realistic).

## Data integrity re-check (task 3)
`t_data.py`: six typing+save rounds, rename then edit, move to folder then edit, `vault.process` plugin-style write then edit, two panes of one note (four alternating edits), edit of a second note: **zero** "changed outside" notices, all edits and the plugin line present on disk. B2-11 (above) fine. B-6...B-18 are unchanged code paths covered by `qa/smoke.py` (32/32) and the unit tests; no regression seen.

## Attacks that failed
- Raw `skn://api` calls from notes (`<img>`, iframe + `enctype=text/plain` form), from a plugin's own `fetch`, from CSS snippet `url(skn://api/...)`: all `unauthenticated` / no effect.
- Boot secret: hash navigation, `pushState`, anchor click, rendered-note anchor click and `location.reload()` keep the page working and do not expose the secret (`p_hash.py`).
- Stealing the app key: patching `Function`, `fetch`, `XMLHttpRequest`, `Response`, `encodeURIComponent`, Resource Timing: nothing (the key only crosses a promise during `app.auth`, before plugins run, so B4-1 does not reveal it).
- Writes to `.git`, `.sk_notes/plugins/*`, `permissions.json`, the trust store via adapter, `vault.*`, `fs`, `createBinary`, rename/copy/remove/mkdir, `./`, `//`, `\` variants and symlinks: denied (except the case variant above).
- `fs`/`child_process` without permission, `symlink` creation by plugins, popout/pop-up windows (`window.open` returns null), main-window navigation away from `skn://app`, nested/foreign vault with its own `permissions.json`/`trust.json`: blocked.
- `getSettingDefinitions()` renderer, `plugins.source`: they only run plugin callbacks in the plugin's own context; no app key or token is in scope there.

## Summary
Cycle-3 and cycle-2 bugs B3-1...B3-5 and B2-1...B2-11 are all fixed (B2-3 only partially, see B4-1); regression suites pass (`q_security` all blocked, `smoke` 32/32, unit tests OK) and saving/rename/move/plugin writes/two panes/external-change detection behave correctly. New findings: 0 critical, 1 high (B4-1: token theft through `Object.prototype.then`/promise resolution, reproduced with arbitrary command execution by a plugin that has no `exec` right), 1 medium (B4-3: hostile vault `.git` hooks/filters run on commit), 2 low (B4-2 outside-vault read/copy/rename/delete through a user-made symlink, broader than the documented "write"; B4-4 trusted plugin silently replaceable through a misleading install dialog), plus 3 cosmetic items.
