# sk_notes

Notes and knowledge base for **Skorpion OS**: a folder of Markdown files on your computer,
linked notes, graph, canvas, database views, community plugins, and **SKAI**, the local AI
of Skorpion OS — all offline. *Italiano: [README.it.md](README.it.md).*

- **Your files, your computer.** A vault is a normal folder of `.md` files. No account, no
  telemetry. The network is used only for the local SKAI service (Ollama) and for what you ask: Git sync, and the community directories of plugins, themes and templates.
- **Familiar.** If you used another Markdown knowledge-base app, panels, menus and shortcuts
  are where you expect them; an existing vault opens as it is, and a wizard offers to import
  its settings (read-only — the original files are never changed).
- **Light.** Python 3 + Qt; search answers in under 100 ms on 10,000 notes.

License: **GPL-3.0-or-later**. sk_notes is not affiliated with Obsidian or Dynalist Inc.

## Features

| Area | What you get |
|---|---|
| Vault | open/create/switch vaults, file explorer with sorting, drag & drop, several files at once (Ctrl/Shift+click: rename one after the other, move, delete), rename (links are updated automatically), system trash or `.trash`, file recovery and version history |
| Editor | Live Preview and Source mode, Reading view, syntax highlighting, tasks, tables, code blocks, math (KaTeX), callouts, footnotes, highlights, comments, multiple cursors, folding, find & replace, slash commands |
| Links | `[[wikilinks]]` with autocomplete, aliases, heading and block links, embeds of notes, sections, images, audio, video and PDF, backlinks and unlinked mentions, outgoing links, page preview |
| Search | full-text index with `file:`, `path:`, `tag:`, `line:()`, `section:()`, `task-todo:`, `[property:value]`, `OR`, `-`, regex… |
| Home | an empty tab is Home, as in sk_notes for Android: the logo with the name of the open vault, recent notes in one row, create (note — with a calendar button for today's note —, canvas, and a smaller bar for a note from a template), view (graph, database of the vault — a view, no file is made; the file list is always in the left sidebar); every tile is a command with a shortcut (Settings → Hotkeys) shown on the tile — note Ctrl+N, canvas Ctrl+C when there is nothing to copy; arrows and Enter work on Home. The left ribbon hides while only Home is on screen. The "+" of the tabs shows two bubbles (note, canvas) to click, or press and pull towards one |
| Panes | the "new pane on the right" button in every pane's header (or Ctrl+Alt+D) adds a pane at the right edge, all the same width, with the last note used that is not on screen (or Home). Panes move like windows inside the window, never pulled out: drag a tab by its name and let go on the half of a pane where it should go (left, right, top, bottom), in its middle to join its tabs, on a tab bar to sit among those tabs; drag the empty part of a tab bar to move the whole pane; Escape cancels. A file of the list dropped on an edge of a pane opens beside. Closing the last note of a pane closes the pane and the others share its room |
| Navigation | quick switcher, command palette, nested tags, outline, bookmarks, tabs, split panes, saved layouts, pop-out windows |
| Graph | global and local graph, filters, color groups, a colour for a single note (right click on its dot), forces |
| Canvas | `.canvas` files (open JSON Canvas format): cards, notes, media, groups, connections (colour, label, direction, remove all arrows of a card), rename by the title, picture of the whole board (JPG) |
| Properties | typed property editor and **Bases** (`.base`): table, cards, list and board views with filters and formulas |
| Organisation | templates, daily notes, unique notes, note composer (merge/extract), word count |
| Export & import | PDF export; import from Markdown folders, Evernote, Notion, Bear/TextBundle, Logseq, Roam, Google Keep, HTML, CSV |
| Sync & publish (optional) | sync with **GitHub, GitLab or any Git server** with a name and a token: commit, pull and push by themselves, merges without conflict markers (the other version is kept beside the note); the same vault opens in sk_notes for Android, Obsidian with its Git plugin, Foam or Tolaria. Git by hand and Syncthing status; static website generated locally |
| Encryption (optional) | a whole vault as one encrypted file (`.skvault`, AES-256-GCM, password + recovery code), made new or from an existing vault and back; locks by itself after the time chosen; the same file opens in sk_notes for Android |
| Plugins & themes | native sk_notes API with explicit permissions, and a compatibility layer for community plugins ([compatibility table](docs/compatibility.md)); the public directories of community plugins, themes and note templates browsed and installed in one click; the Anna.g_3 theme included |
| SKAI | questions about the open note or the whole vault (local embedding index), summaries, tag and link suggestions, proofreading and rewriting — streamed, cancellable, and never applied without your confirmation (diff first) |
| Languages | English, Italiano, Español, Français, Deutsch, Português, Русский, 简体中文, 日本語 |

## SKAI_ Memory

The package also installs SKAI's shared Markdown memory (`/var/lib/skai/SKAI_ Memory`, see `skai_memory/README.md`): every SKAI app and plugin identifies itself through the `skai_memory` library, keeps its own notes under `plugins/<app>/` and can read all the others. To let a user's apps write: `sudo usermod -aG skai <user>`.

## Android

`android/` holds sk_notes for Android 8.0 or newer: the same workspace as on the PC in an APK, with
Git sync and encrypted vaults that open on both. Build, signing, tests and what a phone does its own
way: [android/README.md](android/README.md).

```sh
npm ci && sh android/build.sh   # → android/dist/sk_notes-0.5.1.apk
```

## Install

### Skorpion OS / Debian

```sh
sudo apt install ./sk-notes_0.5.1_all.deb      # package built by tools/build_deb.sh
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
sh tools/build_tarball.sh       # dist/sk_notes-0.5.1.tar.gz + dist/PKGBUILD (with checksum)
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
keyword search. Without Ollama, or without a model, sk_notes works normally: the status bar says "AI
unavailable" and the SKAI panel shows the same message as every SKAI tool ("AI features are disabled…").

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
- `npm test` — JavaScript unit tests (Node.js shims for plugins, metadata cache, Bases labels)
- `cd android && npm test` — Android backend against the Python one, encrypted vaults, Git sync against a real Git server
- `python3 qa/smoke.py` — UI smoke test under Xvfb (keyboard-driven, Chrome DevTools Protocol)
- `python3 qa/plugin_compat.py <dir> [ids]` — community plugin compatibility ([results](docs/compatibility.md))
- `python3 qa/plugin_flows.py` — main flows of Templater, Calendar, Tasks and Dataview
- `python3 qa/security.py` — a hostile plugin tries to get around the permission system
- `python3 qa/plugin_safety.py` — plugins that never finish loading or crash the app (safe mode)
- `python3 qa/startup_time.py` — start-up time; `SK_NOTES_DEBUG=1` adds debug lines to the log
- Architecture: [docs/architecture.md](docs/architecture.md); native plugin API: [docs/api.md](docs/api.md); contributing and translations: [CONTRIBUTING.md](CONTRIBUTING.md)
