# QA cycle 1 – Agent A (user coming from Obsidian)

**Summary:** 21 bugs — critical 1 (A-1), high 3 (A-2, A-3, A-4), medium 11 (A-5 – A-14, A-17), low 6 (A-15, A-16, A-18 – A-21); 6 cosmetic issues. Evidence (screenshots, corrupted files, scripts) is in `qa/tmp/agent-A/` (gitignored).

- **Date:** 2026-10-31 → 2026-11-01
- **Environment:** this VM (1 CPU i3-5005U, 1.7 GB RAM, ~600–850 MB free, shared with agent B and Ollama), Debian 13, Qt WebEngine 6.8, Xvfb 1366×800, app started with `qa/cdp.py` `App` (isolated XDG dirs, CDP ports 9500–9506). Front-end as built in `sk_notes/web/dist` (not rebuilt).
- **Vaults** (generator: `qa/tmp/agent-A/genvault.py <dir> <n>`):
  - main vault `qa/tmp/agent-A/vault`: 2,000 notes in 10 folders + `Home`, 30 daily notes, 2 templates (2,033 `.md` total, 8.2 MB), 20 PNG attachments, 3 JSON Canvas files, 1 `.base`. Every note has YAML frontmatter (tags list, aliases, date, text, number, checkbox), inline + nested tags (`#topic/a/b`), 4 links each (plain, `[[a|alias]]`, `[[a#Details]]`, `[[a#^blkN]]`, `![[a#Details]]`), block ids, tasks, a table, a code block and display math; 2 % embed a PNG.
  - plugin vaults `pv-<plugin>` (150 notes + QA test notes), SKAI vault `skv` (60 notes), canvas vault `canv` (2 files), language vault `langvault` (2 notes).
- **Covered:** start-up/indexing, search API + pane, quick switcher, command palette, new note + inline title, `[[` autocomplete, follow link (click, Ctrl+click, Ctrl+Enter, Alt+Enter), back/forward, reading view, graph (2,034 nodes), tabs/splits, rename (inline title, F2, API) with link updates, move, delete + restore via file recovery, backlinks + unlinked mentions, outline, tags, all-properties, outgoing links, bookmarks, daily notes, templates, canvas, bases, PDF export, hotkey rebinding, theme switch, workspace layouts, 8 community plugins, SKAI (summary, tags, rewrite + diff, stop, ask the vault with `all-minilm`), 9 UI languages.
- **Not covered:** pop-out windows, sync/publish, importers, mobile-size layout, drag & drop with the mouse in the file explorer.

## Measurements

| What | Result | Target / note |
|---|---|---|
| First open of the 2,000-note vault (index) | **8.66 s** "vault ready" (2,037 files), window ready **14.1 s** after process start | — |
| Warm start, same vault, restored workspace (2 tab groups, 6 tabs incl. graph/base/canvas, right sidebar) | vault ready 1.76–1.99 s, window ready **18.0–18.4 s** (page 11.8–12.9 s, of which `layout` 9.1–9.7 s) | ~2 s (documented 6.1–6.8 s on this VM with 200 notes) |
| Warm start, fresh small vault | 16.6 s (canvas vault, under memory pressure from agent B) | — |
| `search.query` server time (`result.ms`), 2,000 notes, best of 3 | `garden` 65 ms · `coffee kernel` 103 ms · `"open task"` 70 ms · `/qu.ntum/` 103 ms · `garden OR river` 137 ms · `line:(garden river)` **246 ms** · `section:(Details coffee)` **208 ms** · `task-todo:coffee` 80 ms · `[rating:5]` 15 ms · `Alias7` 5 ms · `tag:#coffee` ~20 ms | < 100 ms on **10,000** notes |
| `search.query` round trip from the page, limit 1000 | 60–415 ms (JSON for 1,000 results ≈ 0.5 MB) | — |
| Search pane: typing `quantum` → first result rendered | 1.57 s (1,866 results, 500 rendered) | — |
| Quick switcher: type → selected suggestion | 0.40–0.58 s (incl. CDP overhead) | OK |
| Graph view, 2,034 nodes / 15,984 links | tab opens in 0.1 s; **2–3 fps for the first ~10 s** (layout simulation), 60 fps once settled | — |
| Unlinked mentions (21 hits) | 0.34 s | OK |
| SKAI summary (qwen2.5:0.5b) | 58 s · tag suggestion 65 s · vault question (keywords) 33 s, (semantic) 9 s to retrieval | model-bound |
| SKAI index build, 96 chunks (`all-minilm`) | ~3 min | — |

## Bugs

### A-1: Typing in a canvas card corrupts the `.canvas` file (saved as a JSON *string*) and the card text is lost
**Severity:** critical (data loss)

**Steps to reproduce** (fresh app instance, UI only):
1. Vault with `B.canvas` = `{"nodes":[{"id":"a","type":"text","text":"hello","x":0,"y":0,"width":250,"height":120},{"id":"b","type":"file","file":"n/A.md","x":400,"y":0,"width":300,"height":200}],"edges":[]}` and `n/A.md`.
2. Ctrl+O → `B` → Enter (canvas opens).
3. Click **Add card** in the bottom toolbar, type `typed`, press Escape. *(Same result: double-click an existing text card, type, Escape; also with a brand-new canvas from "Create new canvas".)*
4. Wait 3 s and read the file.

**Expected:** the card is added and the file stays a JSON Canvas object (`{"nodes":[…]}`) with the new text node.

**Actual:** the file becomes a JSON string literal: `"{\n\t\"nodes\": [\n\t\t{ …"` (the whole canvas double-encoded). The typed text is not in it (the new node has `"text": ""`). Console on the first keystroke: `TypeError: Cannot read properties of undefined (reading 'slice') at Y.render (canvas-HBH5Q33D.js)`; later `TypeError: Cannot read properties of undefined (reading 'push') at Y.addNode` and `(reading 'filter') at Y._nodeMouseDown`. Reopening the canvas shows an empty board; on the next start the restored tab fails with `view open failed canvas TypeError: Cannot create property 'nodes' on string …`. Obsidian or any JSON Canvas reader can no longer open the file. Moving a card (drag) without typing saves correctly.

**Evidence:** `qa/tmp/agent-A/evidence-B-corrupted.canvas`, `qa/tmp/agent-A/evidence-board1-corrupted.canvas`, screenshots `s20-canvas-add.png`, `s21-canvas-fresh.png`, `s22-canvas-reopen.png`.

### A-2: After a rename/move, the renamed note has an empty metadata cache (no headings, links, tags, frontmatter) until it is edited or the app restarts
**Severity:** high

**Steps to reproduce:**
1. Open any note with headings and links, e.g. `Zettel/Note 0005 review.md` (`app.metadataCache.getCache(path)` → 2 headings, 3 links).
2. Rename it (inline title, F2 or `app.fileManager.renameFile(file, 'Zettel/Renamed by API.md')`).
3. Open the Outline and Outgoing links panes, or evaluate `app.metadataCache.getCache('Zettel/Renamed by API.md')`.

**Expected:** same headings/links/tags/frontmatter as before the rename.

**Actual:** `getCache()` returns an object with no `headings`, `links`, `tags` or `frontmatter`. Outline says "No headings found.", Outgoing links "No outgoing links.", the note drops out of the Tags pane and the Properties counts, and plugins (Dataview, Tasks…) see an empty note. `resolvedLinks` for the file is still right. Typing anything in the note, or restarting, fixes it. Reproduced on 3 notes (inline title, F2 dialog, API).

### A-3: Renaming a note does not update `file` references in `.canvas` files
**Severity:** high

**Steps:** `Board 0.canvas` has a file card `Projects/Active/Note 0000 alpha.md`. Select that note in the file explorer, press F2, rename it to `Canvas Target`. Open `Board 0.canvas`.

**Expected (Obsidian):** the canvas file card follows the rename (`"file": "Projects/Active/Canvas Target.md"`).

**Actual:** the canvas still points to the old path; the card shows "File not found: Projects/Active/Note 0000 alpha.md". Markdown links in other notes *were* updated correctly (`Home.md` → `[[Canvas Target]]`).

### A-4: PDF export never produces a file ("pdf-failed" after ~80 s)
**Severity:** high

**Steps:** open a note → ⋯ → Export to PDF (or command `workspace:export-pdf`) → in the save dialog enter `/home/kadmin/Scaricati/sk_notes/qa/tmp/agent-A/export-test.pdf` → Save. Direct API call gives the same: `call('export.pdf', {html:'<h1>Hello PDF</h1>', css:'', name:'direct'})` → after the dialog, ~80 s later `{"ok":false,"error":"pdf-failed"}`.

**Expected:** a PDF next to the chosen path within a few seconds (Obsidian also first shows export options: page size, margins, "include file name").

**Actual:** no file is written (tried 3 times). While the save dialog and the following wait run, the whole window and the DevTools endpoint are frozen (nested event loop in `extras/api.py export_pdf`). The failure notice disappears quickly, so a user sees nothing. Possibly environment-related (Xvfb, no GPU), but nothing in the log explains it. Also: the default folder is `~` because the code looks for `~/Documents` and this system's folder is `~/Documenti` (should use `QStandardPaths.DocumentsLocation`).

**Evidence:** `s25-pdfdialog.png`, `s27.png`.

### A-5: Code-block processors and inline queries do not render in Live Preview; Dataview inline queries render empty
**Severity:** medium

**Steps:** vault with Dataview 0.5.68 enabled; note `QA/Dataview.md`:
````
```dataview
TABLE status, rating FROM "Projects" WHERE rating >= 4 SORT rating DESC LIMIT 5
```
Inline: `= this.file.name`
````
1. Reading view (Ctrl+E): the table renders (5 rows) ✔, but `Inline:` is followed by nothing.
2. Back to the editor (Live Preview, cursor on line 1): the block is shown as raw source with the backticks; same for an `ad-note` block with Admonition.

**Expected (Obsidian):** in Live Preview, code blocks handled by `registerMarkdownCodeBlockProcessor` are rendered when the cursor is outside them; the inline query shows `Dataview`.

**Actual:** raw source in Live Preview; empty inline query in Reading view; console: `CodeMirror plugin crashed: TypeError: Cannot read properties of undefined (reading 'id') at s.prop (chunk-XGM2AM5Y.js) at view.ViewPlugin.fromClass.decorations.renderNode (plugin:dataview/main.js:19999)` (Dataview's Live-Preview inline plugin uses a syntax-tree node property that sk_notes does not provide). Note: built-in embeds/callouts *do* render in Live Preview.

### A-6: Tasks plugin query block renders broken (1 of 5 tasks, stray text, DOM exceptions)
**Severity:** medium (docs/compatibility.md says "Works")

**Steps:** Tasks 8.6.0 enabled; note `QA/Tasks.md` with
````
```tasks
not done
path includes Projects
limit 5
```
````
(47 notes under `Projects/` contain `- [ ] open task …`). Reading view.

**Expected:** a list of 5 open tasks with checkboxes, backlinks to their notes and "5 tasks".

**Actual:** a stray "alpha due task" paragraph (task from the same note, not from Projects), the "Filter by description" box, then one line "open task python" without checkbox or link. Console (twice): `DOMException: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node. at plugin:obsidian-tasks-plugin/main.js:519`. Screenshot `plug-obsidian-tasks-plugin.png`.

### A-7: Calendar plugin: clicking a day does nothing
**Severity:** medium (docs/compatibility.md says "Works")

**Steps:** Calendar 2.0.0 enabled → command "Calendar: Open view" → click today's cell (`.calendar .day.today`).

**Expected:** opens today's daily note, or asks to create it (Calendar's default "confirm before creating").

**Actual:** nothing happens: no note, no modal, no notice, no console error. The calendar itself renders (42 day cells, today highlighted). The core daily-notes options are not exposed where the plugin looks for them (`app.internalPlugins.getPluginById('daily-notes').instance.options` → `{}`), which the daily-notes helper library used by Calendar/Periodic Notes needs.

### A-8: Templater: "Open insert template modal" lists templates but inserting does nothing; markdown view crashes
**Severity:** medium

**Steps:** Templater 2.26.0 with `templates_folder: "Templates"`; open `QA/Tpl.md`, click in the editor, run `templater-obsidian:insert-templater`, type `Tp`, Enter.

**Expected:** `Created 2026-11-01 for Tpl` inserted at the cursor.

**Actual:** the modal shows `Meeting`, `Tp`; after Enter the file is unchanged. Console: `view open failed markdown TypeError: s is not a function at ya (chunk-XGM2AM5Y.js:14) at Yr.parseLine …`. ("Replace templates in the active file" works: `<% tp.file.title %>` → `Tpl`.)

### A-9: `app.workspace.activeEditor` is null after `openFile()` until the user clicks into the editor
**Severity:** medium (plugin compatibility)

**Steps:** fresh vault, `const l = app.workspace.getLeaf(); await l.openFile(file);` wait until the view is loaded; evaluate `app.workspace.activeEditor`.

**Expected:** the active MarkdownView's editor (Obsidian sets it on `active-leaf-change`), since `app.workspace.activeLeaf.view` is that markdown view.

**Actual:** `null` (while `activeLeaf.view.getViewType()` is `markdown`) until a click in `.cm-content`. Plugins that open a note and then edit through `activeEditor` (Templater, QuickAdd-style scripts, Linter commands launched from code) fail with "Cannot read properties of null (reading 'editor')".

### A-10: Link autocomplete puts "create note" first, so Enter links to a note that does not exist
**Severity:** medium

**Steps:** new note, type `Link to [[Note 0042` (the vault has `Projects/Archive/Note 0042 python.md`), wait for the popup, press Enter.

**Expected (Obsidian):** the best existing match is selected first; Enter gives `[[Note 0042 python]]`. Obsidian does not offer a "create" entry in the link popup at all.

**Actual:** first (selected) item is `Note 0042 — create note`; Enter inserts `[[Note 0042]]` (unresolved). The existing note is second. Screenshot `s03-linksuggest.png`. Also see cosmetic C-1 (popup colours).

### A-11: Graph view of a large vault opens at zoom 1 with every label drawn, unreadable; 2–3 fps while settling
**Severity:** medium

**Steps:** 2,000-note vault, Ctrl+G.

**Expected (Obsidian):** the graph is fitted to the view, labels fade out when zoomed out (text-fade threshold), interaction stays fluid.

**Actual:** viewport `{x:0,y:0,k:1}`, the nodes overflow the view and all 2,034 labels overlap into a grey wall (screenshots `s06-graph.png`, `s07-graph30.png`); the gear button is hidden behind the labels. Only after ~8 wheel steps (k=0.05) is the shape visible (`s08-graphzoom.png`). Frame rate measured with `requestAnimationFrame`: 3.3 fps at 1 s, 2.3 fps at 6 s, 60 fps at 30 s. `textFadeMultiplier` is 0 by default.

### A-12: Search is slower than the target already at 2,000 notes
**Severity:** medium (performance target)

**Steps:** `call('search.query', {query, limit: 1000})` on the 2,000-note vault, read `result.ms` (best of 3): see the Measurements table.

**Expected:** < 100 ms on 10,000 notes (README, architecture.md).

**Actual:** common-word queries 100–140 ms and `line:()`/`section:()` 200–450 ms on 2,000 notes (5× fewer than the target size). Machine is shared and slow, but the simple single-word query `garden` is already 65 ms on 2k notes, which extrapolates well above 100 ms at 10k.

### A-13: Warm start with a restored workspace takes ~18 s
**Severity:** medium (performance target)

**Steps:** open the 2,000-note vault, leave a layout with a graph tab, a base, two canvases and the right sidebar, quit, start again (`App(vault)`).

**Expected:** about 2 s (architecture.md); 6–7 s is the documented VM baseline.

**Actual:** window ready 18.0–18.4 s, of which `layout` (restoring the workspace) 9.1–9.7 s, although the vault itself is ready in 1.8–2.0 s. All restored tabs are fully loaded at start instead of lazily when first shown (Obsidian defers background tabs).

### A-14: Template insertion drops the template's properties
**Severity:** medium

**Steps:** Settings → Core features → Templates → Template folder `Templates`. Open `My Test Note.md` (no frontmatter), run "Insert template", choose `Meeting` (`---\ntype: meeting\n---\n# Meeting {{title}} …`).

**Expected (Obsidian):** the template's properties are merged into the note's properties (`type: meeting` appears), the body is inserted at the cursor.

**Actual:** the body is inserted (`{{title}}`, `{{date}}`, `{{time}}` are replaced correctly) but `type: meeting` is lost; the note has no properties.

### A-15: Ctrl+Enter / follow-link commands differ from Obsidian; Alt+Enter does nothing
**Severity:** low

**Steps:** cursor inside `[[Note 0000 alpha]]` in `Home.md`. (a) Alt+Enter; (b) run command `editor:follow-link`.

**Expected (Obsidian):** "Follow link under cursor" (Alt+Enter) opens the link in the same tab; "Open link under cursor in new tab" (Ctrl+Enter) is a separate command (`editor:open-link-in-new-leaf`, also `…-new-split`, `…-new-window`).

**Actual:** (a) nothing; (b) `editor:follow-link` is bound to Ctrl+Enter and always opens a new tab. There is no way to follow a link under the cursor in the same tab from the keyboard. (Mouse click / Ctrl+click and Ctrl+Alt+←/→ behave like Obsidian.)

### A-16: Missing commands and core features an Obsidian user looks for
**Severity:** low

126 commands exist. Missing compared with Obsidian's default core set: Note composer *extract current selection / split by heading*; *Toggle fold* / *Fold more / less* on the current line; *Open link in new tab/split/window* (see A-15); *Toggle backlinks in document*; *Open outgoing links / backlinks for the current file* (linked panes); *Bookmark all tabs / current search / current heading*; *Graph: animate*; *Reload app without saving*, *Show debug info*; Slides, Audio recorder and Format converter core plugins; Insert attachment. Settings → **Core features** has options but no on/off toggles for the core features (Obsidian's "Core plugins" list), so e.g. the built-in word count cannot be turned off when Better Word Count adds a second counter (both show in the status bar).

### A-17: SKAI "Rewrite selection" inserts the rewrite after the selection instead of replacing it
**Severity:** medium

**Steps:** `skv` vault, open `Projects/Note 0024 health.md`, select the line `Intro about health and beta #design #topic/health/beta`, command "SKAI: rewrite selection" → "Clearer", wait (~3 min), click "Review changes…".

**Expected:** the diff replaces the selected line (1 removed, n added).

**Actual:** "3 lines added, 0 removed": the original line stays and the model's text is added below it. (Nothing is written before Apply — confirmation works; Cancel leaves the file unchanged.)

### A-18: SKAI "Stop" takes 20–30 s and the panel keeps showing "Stop"; vault questions claim "no embedding model installed" when one is installed
**Severity:** low

**Steps:** (a) "SKAI: summarize current note", after 4 s click Stop. (b) Before running "SKAI: update the vault index", switch to *Whole vault* and ask a question (Ollama has `all-minilm`).

**Expected:** (a) the request stops at once (Obsidian-style plugins abort the fetch), the input returns to "Send". (b) a message saying the vault index has not been built yet / offering to build it.

**Actual:** (a) status bar returns to "SKAI" after ~2 s but the panel shows only "Stop" (no "Send") for another ~20–30 s, then "Stopped."; Ollama keeps generating meanwhile. (b) "6 notes found by keywords (no embedding model installed)." – misleading; after building the index the same question uses semantic retrieval ("6 relevant passages found").

### A-19: Search results include raw `.canvas` JSON
**Severity:** low

**Steps:** Ctrl+Shift+F, `quantum`.

**Expected (Obsidian):** canvas matches show the card text, not the file's JSON.

**Actual:** the first result is `Board 1.canvas` with the snippet `"file": "Areas/Finance/Note 0001 quantum.md",` (a JSON key/path line). Screenshot `s02-search.png`.

### A-20: Bases ignore `displayName` in the `properties` section
**Severity:** low

**Steps:** `Tasks.base` with `properties: { status: { displayName: Status } }`, open it.

**Expected:** column header "Status".

**Actual:** header "status". (Filter `file.inFolder("Projects")` – 571 results incl. subfolders, sort by rating DESC, formula `rating * 2` all correct.) Screenshot `s23-base.png`.

### A-21: Settings folder fields have no folder autocomplete
**Severity:** low

**Steps:** Settings → Core features → Templates → Template folder, type `Templ`.

**Expected (Obsidian):** a folder suggestion list.

**Actual:** no suggestions (plain text field).

## Cosmetic issues

- **C-1:** the `[[` link suggestion popup is light (white/peach background) in the dark theme; the secondary text ("python" in "Note 0042 python") is light grey on white and barely readable (`s03-linksuggest.png`).
- **C-2:** with two tab groups + both sidebars at 1366 px, tab titles shrink to one letter ("C", "H", "N…") instead of a minimum width with ellipsis (`s19-canvas.png`, `s23-base.png`).
- **C-3:** Tags pane nested children are shown with a leading `#` (`#recipe` under `#area`) – Obsidian shows the child part only.
- **C-4:** right sidebar is collapsed on first start of a new vault (Obsidian shows it open with Backlinks/Outline tabs).
- **C-6:** the SKAI chat input placeholder ("Ask about the open note… (Enter to send, Shift+Enter for a new line)") needs 3 lines in a 2-line box and is cut off; worst in German and Japanese (`lang-de-settings.png` background, `lang-ja-main.png`).
- **C-5:** SKAI "Add selected tags" with only already-present tags still opens a diff that just reformats `aliases: [Alias24]` into a block list.

## Language check (9 languages)

Method (`qa/tmp/agent-A/langtest.py`): fresh config, `LANG=<locale>` at first start, then read the whole window, the Backlinks / Tags / Outline / Outgoing links / Properties / Bookmarks / Search / SKAI panes, the command palette and every Settings section, looking for English sentences and raw keys (`settings.foo`). Static check: all 8 locale files have all 781 keys of `en.json`; strings identical to English are product names or legitimate loanwords (SKAI, Editor, Link, Git commit/pull/push, ENEX/TextBundle…).

| Language | First-start UI language | `<html lang>` | Raw keys | English left in scanned UI | Layout |
|---|---|---|---|---|---|
| en | English | en | none | – | OK |
| it | Italiano | it | none | none | OK |
| es | Español | es | none | none | OK |
| fr | Français | fr | none | none | OK |
| de | Deutsch | de | none | none | SKAI input placeholder clipped (C-6) |
| pt | Português | pt | none | none | OK |
| ru | Русский | ru | none | none | OK |
| zh-CN | 简体中文 | zh-CN | none | none | OK |
| ja | 日本語 | ja | none | none | SKAI input placeholder clipped (C-6) |

No missing/raw keys and no untranslated text found in the scanned areas in any language; no console errors in any language run. Hotkey labels show `Ctrl+…` in every language (Obsidian does the same; German users may expect `Strg`). Screenshots: `qa/tmp/agent-A/lang-<code>-{main,palette,settings}.png`. Not scanned: context menus, modals of individual features, notices, plugin settings.

## Plugins (one per app instance, permissions default)

| Plugin | Version | Loads | Main feature used | Result |
|---|---|---|---|---|
| dataview | 0.5.68 | yes | DQL `TABLE … FROM "Projects" WHERE … SORT … LIMIT 5` | table OK in Reading view; inline query empty, nothing in Live Preview, CM plugin crash (A-5). DataviewJS disabled by its own default setting (OK) |
| templater-obsidian | 2.26.0 | yes | replace templates in file; insert template | replace OK; insert from modal fails (A-8) |
| obsidian-tasks-plugin | 8.6.0 | yes | `tasks` query block | broken output + exceptions (A-6) |
| calendar | 2.0.0 | yes | open view, click today | view OK, click does nothing (A-7) |
| obsidian-linter | 1.34.2 | yes | lint file (after enabling 5 rules) | OK (blank lines, trailing spaces, heading spacing fixed) |
| better-word-count | 0.10.1 | yes | live word count | OK (updates 6 → 9 words); duplicates the built-in counter (A-16) |
| obsidian-admonition | 12.0.11 | yes | ` ```ad-note ` block | OK in Reading view, raw in Live Preview (A-5) |
| table-editor-obsidian | 0.23.2 | yes | format table | OK |

Mismatch with `docs/compatibility.md`: dataview, obsidian-tasks-plugin, calendar and templater-obsidian are listed as "Works" but their main feature is partly broken (A-5 – A-8).

## Checked and OK

- First indexing of 2,000 notes (8.7 s) with all links resolved (2,033 files in `resolvedLinks`).
- Quick switcher (Ctrl+O): file names, aliases (`Alias15`), folders shown, "Enter to create" for no match, footer key hints; < 0.6 s.
- Command palette (Ctrl+P), new note (Ctrl+N) with the inline title focused, renaming via inline title.
- Rename via inline title updates all 12 linking notes, all forms (`[[x]]`, `[[x|alias]]`, `[[x#h]]`, `[[x#^id]]`, `![[x#h]]`) and nothing else in those files; F2 rename and "Move file to…" (links still resolve).
- Delete (confirmation dialog, isolated system trash), File recovery lists deleted files, "Recreate this file" restores content and links.
- Reading view (Ctrl+E): properties, tags, tables, code, KaTeX math, tasks, section embeds, image embed, `Note > Details` link text.
- Mouse click / Ctrl+click on links (same tab / new tab), Ctrl+Alt+←/→ back/forward.
- Tabs: Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1, Ctrl+9, Ctrl+Shift+T; split right.
- Backlinks: linked + unlinked mentions (21 found in 0.34 s), "Link" button turns a mention into `[[Home]]`.
- Tags pane (nested tree with counts), All properties (counts correct), Outline and Outgoing links (except after rename, A-2).
- Bookmarks (bookmark current file, `bookmarks.json`), daily notes (create today, previous/next with folder set), Templates `{{title}}/{{date}}/{{time}}`.
- Canvas: opening, rendering of text/file/group/link cards and edges, dragging a card saves correctly.
- Bases: table view with folder filter, sort, formula; 571 results.
- Hotkeys: filter, add `Ctrl+Alt+J` to "Open local graph", saved to `.sk_notes/hotkeys.json`, works immediately.
- Appearance: switching to the light theme applies at once.
- Workspace layouts: save "QA layout", close tabs, load → same tabs back.
- SKAI never wrote to a note without confirmation: summary/tags/rewrite all left the file unchanged until "Apply"; Cancel in the diff leaves it unchanged; summary, tag suggestion, index build and semantic retrieval work with `qwen2.5:0.5b` + `all-minilm`.
- No uncaught exceptions during the plain-note flows above (exceptions only in canvas and plugins, listed in the bugs).
