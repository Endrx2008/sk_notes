# sk_notes – architecture

Status: adopted on 2026-10-31.

## Requirements that shape the design

1. **Speed** on modest hardware (reference box: 1 CPU i3-5005U, 1.7 GB RAM): start
   in about 2 s, search < 100 ms on 10,000 notes, smooth with big vaults.
2. **SKAI style**: same base technology as the SK apps (Python 3 + Qt 6, Debian
   packages, `python3 main.py`), same theme file, same Ollama connection.
3. **Plugin runtime**: community plugins are CommonJS bundles that expect a browser
   DOM, CodeMirror 6, Moment.js and (desktop plugins) parts of Node/Electron.
4. **UI map**: the layout in `docs/research/ui-map.md` must be reproducible closely.

## Decision: Python/Qt shell + Qt WebEngine workspace

```
┌──────────────────────── sk_notes process (Python 3, PyQt6) ────────────────────────┐
│ main.py → sk_notes.app                                                               │
│   QMainWindow ─ QWebEngineView (one page = whole workspace UI)                       │
│   SchemeHandler "skn://"                                                             │
│     skn://app/…    web UI assets (sk_notes/web/dist)                                 │
│     skn://vault/…  vault files (images, PDFs, attachments) = getResourcePath()       │
│     skn://api/…    JSON RPC (POST): async fetch() or synchronous XHR when a plugin   │
│                    API must be synchronous (fs.readFileSync, existsSync, …)          │
│   Events Python → JS: page.runJavaScript("window.__skn.emit(...)")                  │
│                                                                                      │
│ core/ (no Qt widgets, unit-tested)                                                   │
│   vault.py        file tree, CRUD, trash (system or .trash), attachments            │
│   watcher.py      external changes (QFileSystemWatcher on folders + mtime diff)      │
│   parser.py       Markdown metadata: frontmatter, links, embeds, tags, headings,    │
│                   blocks, list items/tasks, sections, with positions                 │
│   index.py        SQLite (.sk_notes/cache.db): metadata cache keyed by mtime/size,  │
│                   FTS5 full-text index, link graph, properties table                 │
│   search.py       query language → SQL/FTS, filters tag/path/property/task          │
│   links.py        link resolution + rename/move rewriting                            │
│   history.py      version snapshots (zlib, dedup) and file recovery                  │
│   ai/ollama.py    REST client (stream, cancel), model choice like skcore             │
│   ai/embeddings.py local vector index (numpy-free, float32 arrays in SQLite)         │
│   ai/memory.py    interface to future SKAI shared memory (null implementation)      │
│   plugins.py      install (folder / GitHub release), enable, permissions store      │
│   shims.py        Python side of Node shims (fs, child_process, …) with permissions │
│   i18n.py         locale detection, translation files                                │
│   theme.py        SKAI theme file + watcher                                          │
│   importers/      ENEX, HTML, Notion, Bear/Textbundle, Logseq, Roam JSON, CSV, Keep │
│   export_pdf.py   QWebEnginePage.printToPdf                                          │
│   sync_git.py, sync_syncthing.py, publish_site.py  (optional built-in plugins)       │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────── web workspace (sk_notes/web, ES2022, bundled by esbuild) ───────────┐
│ ui/ workspace, ribbon, sidebars, tab groups/splits, status bar, modals, menus,      │
│     command palette, quick switcher, settings, notices, vault manager                │
│ editor/ CodeMirror 6: live preview decorations, source mode, wikilink/tag/slash     │
│     completion, folding, multiple cursors, properties widget                         │
│ render/ reading view: markdown-it + own rules (wikilinks, embeds, callouts, tags,    │
│     highlights, comments, footnotes, tasks, math via KaTeX, block ids)               │
│ views/ graph (canvas 2D + force layout in a Web Worker), canvas (JSON Canvas),       │
│     bases (table/cards/list), backlinks, outline, tags, bookmarks, search, SKAI      │
│ compat/ the "obsidian" module: App, Vault, Workspace, MetadataCache, FileManager,    │
│     Plugin, Component, views, Modal, Setting…, DOM helpers, moment, CodeMirror      │
│     re-exports, Node shims (JS side) – plugins run with a per-plugin require()      │
│ i18n/ t() over locales/*.json                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Why not Electron or Tauri
- Electron: a second Chromium + Node runtime (~150 MB package, more RAM), different from
  every other SK app, not in Debian. Plugins would run "natively", but Node access
  would be unrestricted – the opposite of the required permission system.
- Tauri/WebKitGTK: plugins are tested on Chromium; WebKit differences break CM6
  extensions and CSS; Rust toolchain not used anywhere else in SKAI.
- Qt WebEngine is Chromium too (Qt 6.8, Chromium 122 base), is packaged by Debian
  (`python3-pyqt6.qtwebengine`) and Arch (`python-pyqt6-webengine`), and keeps Python
  as the app language like the rest of the suite. The SK apps' PyQt6 base is kept.

### Why the metadata parser lives in Python
One parser, unit-tested, feeds: the SQLite cache (fast restarts: only changed files are
re-parsed), search filters, link rewriting on rename, the graph, and the JS
`MetadataCache` (sent as one compact JSON at start, then incremental events). The
editor never waits for it: the JS side renders with markdown-it/CM6 and receives the
updated cache entry after each save (debounced 300 ms, like autosave).

### Data flow examples
- Open vault: Python scans the tree, loads cached metadata (mtime/size check), parses
  only changed files, sends `{files, metadata, resolvedLinks}` → UI ready. FTS index
  updated in a background thread.
- Type in a note: CM6 → debounce → `api/vault.write` → history snapshot (throttled) →
  parser → cache → event `metadata-changed` → backlinks/outline/graph update.
- External change: watcher → re-parse → `vault-modify` event → open editors reload if
  not dirty, otherwise show a merge notice (no data loss).
- Search: `api/search` with the query string → FTS5 + filters → results with snippets
  (target < 100 ms on 10k notes; measured in tests).

## Plugin runtime

- Each plugin is loaded from `<vault>/.sk_notes/plugins/<id>/` (`manifest.json`,
  `main.js`, `styles.css`, `data.json`). The source is wrapped as
  `(function(module, exports, require, app){…})` and evaluated with `new Function` in
  the page; `require` is per plugin:
  - `obsidian` → compat module; `@codemirror/*`, `@lezer/*` → the exact instances used
    by the editor (plugins declare them as externals, so they must be shared);
  - `moment` → shared Moment;
  - Node/Electron names → shims (`fs`, `fs/promises`, `path`, `os`, `crypto`,
    `child_process`, `electron`, `url`, `events`, `buffer`) whose privileged calls go to
    Python through `skn://api/shim.*` with the plugin's caller token (`app/callers.py`:
    one-time boot secret per page → one token per plugin, held only in closures);
    Python checks the permission store and, the first time, asks the user (native
    dialog: Allow once / Always / Deny). Granting, installing and first-time enabling
    are native confirmations; the permission and plugin files are Python-only.
- Permissions: `vault-read` (granted), `vault-write` (granted), `fs-outside-vault`,
  `exec` (child processes), `network` (requestUrl to remote hosts), `clipboard`,
  `open-external`. Direct `fetch`/XHR from the page (local services included, except
  the configured Ollama server) are blocked by a request interceptor unless the
  "network" permission was granted to at least one enabled plugin (Chromium cannot tell
  which plugin issued a raw fetch – documented).
- Restricted mode (default on): no community plugin runs until the user turns it off
  after reading the third-party-code warning.
- Theme variables and DOM classes: plugins style themselves with the publicly
  documented CSS variable names (`--background-primary`, `--text-normal`,
  `--interactive-accent`, …) and structural class names (`workspace-leaf`,
  `view-content`, `modal`, `setting-item`, `markdown-preview-view`, …). sk_notes defines
  those names (values from the SKAI palette, rules written from scratch).
- Native sk_notes API: `window.sknotes` (documented in `docs/api.md`), event bus,
  permissions declared in `manifest.json` → `"skPermissions": [...]`. Core features
  (daily notes, templates, word count, …) are internal plugins using the same API.

## SKAI integration

- Host/model: read `~/.config/skorpion-suite/settings.json` (`ollama_host`,
  `ollama_model`), defaults `http://localhost:11434` and automatic = the installed chat
  model with the most parameters (embedding-only models excluded). No separate
  setting inside sk_notes, only an on/off switch for SKAI features.
- Embeddings: the installed model with the `embedding` capability (biggest first);
  if none, vault Q&A falls back to BM25 retrieval from the FTS index.
- All answers stream and can be cancelled; edits are proposed as a diff and applied only
  on explicit confirmation; offline Ollama → status bar shows "SKAI offline", no dialogs
  that block work.

## Theme

Read `~/.config/pylauncher_settings/theme_config.json` (`dark`/`light`), watch it, and
map the SKAI palette to CSS variables at runtime; sk_notes' own Appearance setting
offers "Follow SKAI" (default), Dark, Light, plus CSS snippets and community themes
from `.sk_notes/themes`.

## Files on disk

- Vault: plain `.md`, `.canvas`, `.base`, attachments.
- `<vault>/.sk_notes/`: `app.json`, `appearance.json`, `hotkeys.json`, `workspace.json`,
  `workspaces.json`, `bookmarks.json`, `plugins/`, `themes/`, `snippets/`,
  `community-plugins.json`, `core-plugins.json`, `permissions.json`, `cache.db`
  (rebuildable), `history/`.
- Global: `~/.config/sk_notes/vaults.json` (known vaults, last opened), logs in
  `~/.cache/sk_notes/sk_notes.log`.

## Testing

- Python `unittest` for core (parser, index, search, rename, history, importers,
  permissions, i18n completeness).
- `node --test` for pure JS modules (link suggestion ranking, compat helpers).
- UI tests drive the real app under Xvfb through the Chrome DevTools Protocol that
  Qt WebEngine exposes (`QTWEBENGINE_REMOTE_DEBUGGING`), with a small Python CDP driver
  (`qa/cdp.py`, `python3-websocket` from Debian, test-only). Playwright was tried first:
  its `connectOverCDP` fails on Qt WebEngine ("Browser context management is not
  supported"), so the equivalent driver is used (keyboard/mouse events, evaluate,
  screenshots).
