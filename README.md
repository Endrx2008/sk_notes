# sk_notes

Notes and knowledge base for **Skorpion OS**: a folder of Markdown files on your computer,
linked notes, graph, canvas, database views, community plugins, and **SKAI**, the local AI
of Skorpion OS — all offline. *Italiano: [README.it.md](README.it.md).*

- **Your files, your computer.** A vault is a normal folder of `.md` files. No account, no
  telemetry. The only network connection is to the local SKAI service (Ollama).
- **Familiar.** If you used another Markdown knowledge-base app, panels, menus and shortcuts
  are where you expect them; an existing vault opens as it is, and a wizard offers to import
  its settings (read-only — the original files are never changed).
- **Light.** Python 3 + Qt; search answers in under 100 ms on 10,000 notes.

License: **GPL-3.0-or-later**. sk_notes is not affiliated with Obsidian or Dynalist Inc.

## Features

| Area | What you get |
|---|---|
| Vault | open/create/switch vaults, file explorer with sorting, drag & drop, rename (links are updated automatically), system trash or `.trash`, file recovery and version history |
| Editor | Live Preview and Source mode, Reading view, syntax highlighting, tasks, tables, code blocks, math (KaTeX), callouts, footnotes, highlights, comments, multiple cursors, folding, find & replace, slash commands |
| Links | `[[wikilinks]]` with autocomplete, aliases, heading and block links, embeds of notes, sections, images, audio, video and PDF, backlinks and unlinked mentions, outgoing links, page preview |
| Search | full-text index with `file:`, `path:`, `tag:`, `line:()`, `section:()`, `task-todo:`, `[property:value]`, `OR`, `-`, regex… |
| Navigation | quick switcher, command palette, nested tags, outline, bookmarks, tabs, split panes, stacked tabs, saved layouts, pop-out windows |
| Graph | global and local graph, filters, color groups, forces |
| Canvas | `.canvas` files (open JSON Canvas format): cards, notes, media, groups, connections |
| Properties | typed property editor and **Bases** (`.base`): table, cards, list and board views with filters and formulas |
| Organisation | templates, daily notes, unique notes, note composer (merge/extract), word count, random note |
| Export & import | PDF export; import from Markdown folders, Evernote, Notion, Bear/TextBundle, Logseq, Roam, Google Keep, HTML, CSV |
| Sync & publish (optional) | Git sync (commit/pull/push, auto-commit), Syncthing status, static website generated locally |
| Plugins | native sk_notes API with explicit permissions, and a compatibility layer for community plugins ([compatibility table](docs/compatibility.md)) |
| SKAI | questions about the open note or the whole vault (local embedding index), summaries, tag and link suggestions, proofreading and rewriting — streamed, cancellable, and never applied without your confirmation (diff first) |
| Languages | English, Italiano, Español, Français, Deutsch, Português, Русский, 简体中文, 日本語 |

## Install

### Skorpion OS / Debian

```sh
sudo apt install ./sk-notes_0.1.0_all.deb      # package built by tools/build_deb.sh
sk-notes
```

### From source

```sh
sh install-deps-apt.sh          # Python 3, PyQt6, Qt WebEngine, PyYAML, NumPy
npm ci && npm run build         # builds sk_notes/web/dist (Node.js needed only to build)
python3 main.py                 # or: python3 main.py --vault ~/Notes
```

### Arch / Skorpion OS Mantis

```sh
sh tools/build_tarball.sh       # dist/sk_notes-0.1.0.tar.gz + dist/PKGBUILD (with checksum)
cd dist && makepkg -si
```

### Building the packages

`sh tools/build_deb.sh` builds `dist/sk-notes_<version>_all.deb`; `sh tools/build_tarball.sh`
builds the Arch source tarball and PKGBUILD. Both include the built web front-end, so end users
never need Node.js.

## Links (`sknotes://`)

The packages register sk_notes for `sknotes://` links, e.g. from a launcher or a script:

| Link | Does |
|---|---|
| `sknotes://open?vault=Notes&file=Projects/Plan` | opens a note (`path=/abs/file.md` also works; `newpane=true` opens a tab) |
| `sknotes://new?vault=Notes&name=Idea&content=…` | creates a note; with `file=…&append=true` (or `prepend`, `overwrite`) adds to an existing one; `silent=true` does not open it |
| `sknotes://search?vault=Notes&query=tag:%23todo` | opens the search pane |

If the vault is already open, the running window takes the link. Other actions are passed to
community plugins that register a handler for them.

## SKAI (local AI)

sk_notes connects to Ollama exactly like the other SK apps: host and model come from
`~/.config/skorpion-suite/settings.json` (`ollama_host`, `ollama_model`; an empty model means
*the installed chat model with the most parameters*). There is no separate host/model setting
in sk_notes, only an on/off switch (Settings → SKAI). Questions about the whole vault use the
installed embedding model if there is one (e.g. `all-minilm`, `nomic-embed-text`), otherwise
keyword search. Without Ollama, sk_notes works normally and shows "SKAI offline" in the status bar.

## Keyboard

Default shortcuts follow the conventions of Markdown note apps (Ctrl+P command palette,
Ctrl+O quick switcher, Ctrl+N new note, Ctrl+E reading view, Ctrl+Shift+F search, Ctrl+G graph,
Ctrl+, settings …). Every command can be rebound in Settings → Hotkeys. No default shortcut
uses the Super key or Alt+F1/Alt+F9, so they never clash with i3 or Hyprland on Skorpion OS.

## Files

| Path | Content |
|---|---|
| `<vault>/.sk_notes/` | settings (`app.json`, `appearance.json`, `hotkeys.json`, `workspace.json` …), plugins, themes, snippets, caches (`cache.db`, `history.db`, `embeddings.db` — safe to delete) |
| `~/.config/sk_notes/settings.json` | known vaults, window size, language |
| `~/.cache/sk_notes/sk_notes.log` | log |

## Development

- `python3 -m unittest discover tests` — core tests (parser, index, search, rename, history, importers, i18n, permissions)
- `npm test` — JavaScript unit tests (Node.js shims for plugins)
- `python3 qa/smoke.py` — UI smoke test under Xvfb (keyboard-driven, Chrome DevTools Protocol)
- `python3 qa/plugin_compat.py <dir> [ids]` — community plugin compatibility ([results](docs/compatibility.md))
- `python3 qa/startup_time.py` — start-up time; `SK_NOTES_DEBUG=1` adds debug lines to the log
- Architecture: [docs/architecture.md](docs/architecture.md); native plugin API: [docs/api.md](docs/api.md); contributing and translations: [CONTRIBUTING.md](CONTRIBUTING.md)
