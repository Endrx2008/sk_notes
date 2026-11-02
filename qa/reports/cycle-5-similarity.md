# Cycle 5 - similarity check (shortcuts + Obsidian-vault file compatibility)

Method: real app run through `qa/cdp.py` (ports 9500-9505, one at a time, closed), command registry dumped (134 commands),
real key events sent via CDP. Obsidian side = public help docs from memory (Obsidian was never installed or read).
Scratch: `qa/tmp/agent-S/` (vault `vault/`, pristine copy `orig/vault/`, scripts `mk.py`, `run*.py`).

## Mismatches
| Area | Obsidian default / behaviour | sk_notes | Severity |
|---|---|---|---|
| Extra hotkeys | no default for Ctrl+S, Ctrl+D, Ctrl+L, Ctrl+Shift+N (as I recall the docs) | Mod+S save, Mod+D delete paragraph, Mod+L toggle checklist, Mod+Shift+N new note in new tab | minor (additions, no clash with a core key) |
| Toggle sidebars, split, pin tab, daily note, insert template, bookmarks | no default hotkey (user-assigned) | no default either (commands exist, verified) | none |
| Two tabs on the same note | both views stay in sync live | second view of the same file is NOT updated live (observed: tab B kept `[ ]` while tab A had `[x]`); disk stayed correct, no loss seen after a later edit in the stale view | minor |
| `.obsidian` import | n/a (Obsidian-native) | detected, offered once by a notice at start (`migration.scan`); import is opt-in per item; after "Import selected" the files are written but the running session still shows old values (font 16, hotkeys `{}`) until restart | minor |
| `.obsidian` items not imported | - | `workspace.json` (open tabs), `core-plugins.json` not read; `.obsidian` is ignored by the indexer/watcher | minor |
| Plugin folder | `.obsidian/plugins/<id>/{manifest.json,main.js,styles.css,data.json}` | same file layout, but under `.sk_notes/plugins/<id>/`; `.obsidian/plugins` is never loaded in place, only copied by the migration (plugins item unchecked by default; copied incl. `data.json`, added to `.sk_notes/community-plugins.json`, still needs trust/restricted-mode off) | minor (documented, safe) |
| Not verified | - | canvas/base editing and saving, Live Preview rendering of `%%comments%%`/callouts (only reading view and metadata checked) | n/a |

No blocking mismatch found.

## Shortcuts matching (default hotkey in registry; "KEY" = also verified with a real key press in the running app)
- Ctrl+O quick switcher (KEY: "Find or create a note..."), Ctrl+P command palette (KEY: "Select a command..."), Ctrl+N new note
- Ctrl+T new tab (KEY, 1 new empty tab), Ctrl+W close tab (KEY, 10 -> 9), Ctrl+Shift+T reopen closed tab (KEY, 9 -> 10)
- Ctrl+Tab / Ctrl+Shift+Tab next/prev tab; Ctrl+1..8 go to tab, Ctrl+9 last tab (same as Obsidian)
- Ctrl+Alt+Left/Right back/forward (KEY: Alpha -> Home -> Alpha)
- Ctrl+E toggle reading/edit (KEY: source <-> preview), Ctrl+G graph view (KEY), Ctrl+, settings (KEY, modal opens)
- Ctrl+Shift+F search in vault (KEY, search leaf opens), Ctrl+F find, Ctrl+H replace, F2 rename (KEY, title input focused)
- Ctrl+B bold, Ctrl+I italic (KEY on a selection: `**done**`, `*done*`), Ctrl+K insert link, Ctrl+/ toggle comment
- Ctrl+Enter toggle checklist (KEY: `- [ ]` -> `- [x]`), Ctrl+Enter on a link opens it in a new tab (KEY, tabs 10 -> 11),
  Alt+Enter follow link (KEY, `[[Alpha|the alpha]]` opened Alpha.md)
- Tab / Shift+Tab indent / unindent list item (KEY: 2-space indent and back), Ctrl+] / Ctrl+[ indent/unindent
- Ctrl+= / Ctrl+- / Ctrl+0 zoom, F11 fullscreen, Ctrl+Alt+Up/Down add cursor; strikethrough / highlight / inline code have no
  default in either app
- Not bound by default (same as Obsidian): toggle left/right sidebar, split, pin, daily note, insert template, bookmarks, fold

## Format checks OK (vault in `qa/tmp/agent-S/vault`, 22 files incl. `.obsidian/*`)
- Opened an Obsidian-style vault: properties parsed with correct types (text, tags, aliases, date, checkbox, number, datetime);
  links incl. `[[a|b]]`, `[[a#H]]`, `[[a#^id]]`, markdown link `[x](Alpha.md)` all resolved (0 unresolved); block id `^blk1` and
  headings in the cache; nested tags `#nested/tag/deep`, `#project/alpha` listed; `[[Start]]` (alias) unresolved by
  `getFirstLinkpathDest`, same as Obsidian (aliases only feed suggestions).
- Reading view: callout, 4 embeds (note, section, image, PDF), table, footnote, `==mark==`, math (2), 3 task checkboxes, tags,
  `%%comment%%` hidden. `.canvas` (JSON Canvas: 4 nodes, edge) opens in the canvas view; `.base` opens in the bases table view
  (2 results, Status column from properties).
- Opening/reading 8 notes + canvas + base + attachments changed nothing: `sha256sum -c` identical for every file except the one
  I edited deliberately; `.obsidian/` byte-identical after open, key tests and migration; app state goes only to `.sk_notes/`.
- Edits are minimal: one inserted word in a CRLF note changed only that line (CRLF kept); in a file without trailing newline,
  tabs, odd spacing and `*`/`+` lists changed only the typed char; `![[pic.png|300]]`, `[ ]`/`[x]`/`[/]`, `%%`, `==` untouched.
- Property edit via `processFrontMatter` (count 42 -> 43): other keys, order and date strings kept; only the inline list
  `aliases: [Start, Index]` was rewritten as a block list (Obsidian does the same).
- Rename `Alpha.md` -> `Renamed Alpha.md`: all `[[...]]` forms (alias, heading, block, embeds) updated in place and stay
  wikilinks (`useMarkdownLinks=false`); the markdown link became `Renamed%20Alpha.md` (as in Obsidian);
  `generateMarkdownLink` returns `[[Renamed Alpha]]`.
- Migration (`migration:open`): detects `.obsidian`; imports app.json keys (14 settings incl. attachment folder, new-file folder,
  tab size, readable line length), appearance (font size 18, theme obsidian -> dark), daily-notes and templates settings,
  2 custom hotkeys (same `Mod`/`Shift` format, same command ids); original folder only read.

VERDICT: APPROVED
