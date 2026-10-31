# Plugin compatibility

sk_notes can run many community plugins written for Obsidian through its own
compatibility layer (`require('obsidian')`, see `sk_notes/web/src/compat/`). That layer
was written from scratch from the public API typings and documentation.

> sk_notes is not affiliated with Obsidian or Dynalist Inc. "Obsidian" is used here
> only to say which plugin format sk_notes can read.

## How this was tested

`qa/plugin_compat.py` installs each of the 50 most downloaded community plugins
(release files from their public repositories, kept in `research/`, not committed)
into a fresh scratch vault, starts sk_notes, enables the plugin and checks that it
loads, that its commands are registered and that its views open. Every permission
prompt is answered "Deny", so features that need the network, external programs or
files outside the vault are reported as blocked even though they work once the user
allows them.

Last full run: 2026-10-31 (sk_notes 0.1.0, Qt WebEngine 6.8). 43 of 50 plugins load.

## Results

**Works**: loads, commands and views work, no errors.
**Works with limits**: loads and its main features work; some parts need a permission,
or touch app internals sk_notes does not have (errors are caught and logged).
**Not supported**: does not load, or its core feature cannot work in sk_notes.

| Plugin | Status | Notes |
|---|---|---|
| better-word-count | Works | |
| calendar | Works | |
| cmdr | Works | |
| dataview | Works | |
| editing-toolbar | Works | needed the large request body fix |
| highlightr-plugin | Works | |
| homepage | Works | |
| nldates-obsidian | Works | |
| obsidian-admonition | Works | |
| obsidian-advanced-uri | Works | |
| obsidian-day-planner | Works | |
| obsidian-icon-folder | Works | |
| obsidian-importer | Works | sk_notes also has its own importer |
| obsidian-latex-suite | Works | |
| obsidian-linter | Works | |
| obsidian-livesync | Works | needs the network permission to sync |
| obsidian-minimal-settings | Works | |
| obsidian-pandoc | Works | needs the "run programs" permission to call pandoc |
| obsidian-spaced-repetition | Works | |
| obsidian-style-settings | Works | |
| obsidian-tasks-plugin | Works | |
| obsidian-textgenerator-plugin | Works | needs the network permission for remote models |
| obsidian-zotero-desktop-connector | Works | talks to Zotero on localhost |
| obsidian42-brat | Works | needs the network permission to download |
| periodic-notes | Works | |
| recent-files-obsidian | Works | |
| remotely-save | Works | needs the network permission |
| smart-connections | Works | |
| table-editor-obsidian | Works | |
| tag-wrangler | Works | |
| tasknotes | Works | |
| templater-obsidian | Works | system commands need the "run programs" permission |
| various-complements | Works | |
| obsidian-git | Works with limits | needs the "run programs" permission for `git`; sk_notes also has built-in Git sync |
| notebook-navigator | Works with limits | downloads language data only with the network permission |
| omnisearch | Works with limits | search works; its local HTTP API server is not available |
| obsidian-outliner | Works with limits | vim-mode integration not available |
| obsidian-meta-bind-plugin | Works with limits | some input fields report errors |
| obsidian-markmind | Works with limits | error when closing a mind map view |
| obsidian-excalidraw-plugin | Works with limits | drawing works; embedding notes in drawings uses internal canvas APIs that sk_notes does not have |
| advanced-canvas | Works with limits | patches internal canvas/metadata classes; most extras do not apply to the sk_notes canvas |
| copilot | Works with limits | loads; its chat panel shows errors |
| obsidian-local-rest-api | Not supported | loads, but it is an HTTP server and plugins cannot open server sockets |
| obsidian-advanced-slides | Not supported | needs a local HTTP server |
| obsidian-kanban | Not supported | builds on the internal Markdown editor class (`embedRegistry`) |
| obsidian-hover-editor | Not supported | patches internal graph and popover classes |
| obsidian-mind-map | Not supported | calls the Plugin class as an ES5 function (`Plugin.call(this)`), which modern classes forbid |
| obsidian-annotator | Not supported | bundled PDF/EPUB viewer fails to read its own resources |
| pdf-plus | Not supported | depends on internal PDF viewer and Electron `remote` |
| realclaudian | Not supported | needs synchronous `zlib` |

## What the compatibility layer provides

- The public plugin API: `Plugin`, `ItemView`, `Modal`, `Setting`, `Notice`, `Menu`,
  suggest modals, `MarkdownRenderer`, `requestUrl`, the vault, metadata cache,
  workspace and file manager, editor (CodeMirror 6, shared with the app), and the
  helpers listed in `docs/api.md`.
- Commonly used internals: `app.setting`, `app.commands`, `app.hotkeyManager`,
  `app.internalPlugins` (with the core plugin options), `app.plugins`, `vault.getConfig`.
- Node/Electron modules as controlled shims (`fs`, `path`, `child_process`, `crypto`,
  `os`, `events`, `stream`, `util`, `vm`, `string_decoder`, `punycode`, `electron`...).
  Anything that leaves the vault goes through the permission system:
  files outside the vault, running programs, network, opening external links, clipboard.
  HTTP servers, raw sockets, worker threads and `zlib` are not available.

## Reporting a problem

Open the developer console (Ctrl+Shift+I), reproduce the problem and attach the
messages that start with `plugin <id>` to the bug report, with the plugin version.
