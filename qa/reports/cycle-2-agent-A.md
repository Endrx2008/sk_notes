# QA cycle 2, agent A (experienced Obsidian user)

## Environment
- Debian 13, 1 CPU, 1.7 GB RAM, Xvfb 1366x800 (page viewport about 1200x800), sk_notes at commit 4a55500 (branch main). Another agent (B) was running at the same time on ports 9550+, so timings are pessimistic.
- Driven with `qa/cdp.py` (real key presses and mouse events over CDP), one instance at a time on port 9501, scripts in `qa/tmp/agent-A2/`.
- Vaults: big (about 2,070 generated notes, canvases, a .base, `Zettel/`, `Daily/`, etc.); plugin vault (about 275 notes) with dataview, templater-obsidian, obsidian-tasks-plugin, calendar, obsidian-linter, better-word-count, obsidian-admonition, table-editor-obsidian, nldates, outliner (release files from `research/plugins/`); `RN/` scratch notes for rename tests.
- Ollama at localhost:11434 (qwen2.5:0.5b, all-minilm).
- A previous attempt of this task was cut off. Only scratch files survived, not its findings. Everything below was re-run and re-verified in this session.
- Note for reproducers: `qa/tmp/agent-A2/drv.py` kills the app on exit. The next start then offers "Start without plugins" (the unclean-exit marker). With `SKN_TEST_CONFIRM=yes` that is answered yes, so plugins silently do not load. This is expected behaviour, not a bug. Delete `running-*` in the home cache dir to avoid it.

## Covered
First start (welcome screen) and vault creation; big vault start; quick switcher; command palette; Source / Live Preview / Reading; list, task and quote continuation; auto-pair with real key events; link autocomplete; Alt+Enter and Ctrl+Enter; rename by F2 (inline title) with link updates (all link forms, frontmatter, canvas file cards, folder rename); canvas text typing; file explorer; right panel tabs; tags pane; graph; search operators; Bases (displayName); core templates (properties merge); daily notes; hotkeys (bind and use); file recovery list; external file change while open; PDF export; SKAI (rewrite, review dialog, cancel, Stop); languages (static check of all 9 locale files, UI check in de and ja); plugin settings of all installed plugins; plugin flows (Dataview, Tasks query and modal, Calendar, Templater insert, Linter, Table editor, Admonition, Better Word Count); narrow panes.

## Not covered (time or machine limits)
Themes and CSS snippets (only the default dark theme seen); bookmarks beyond a glance; layouts (save and restore checked only by startup restoring one); SKAI vault Q&A and embeddings; languages es, fr, it, pt, ru and zh-CN in the UI (only their locale files were checked: 831 keys each, complete, placeholders match); Ctrl+click and mouse-driven link following; delete with trash options; mass operations on 2,000 notes; Excalidraw-class plugins.

## Measurements
| What | Result | Note |
|---|---|---|
| Window ready, big vault, warm index, restored 3-pane layout, plugins off | 14.3 s and 16.3 s after process start (page 9.7 s / 9.9 s) | 1 CPU, agent B running. Time between `snapshot` and `layout` is 3.9 to 4.9 s |
| Same, vault ready (index check) | 1.7 s / 3.3 s | `changed: 0` |
| Plugin vault, 10 plugins, restored layout | 11.0 s (page 9.0 s, of which about 6.5 s are `plugins`) | |
| Small vault, no plugins, restored layout | 8.5 s | |
| First index of 273 notes | vault ready 2.5 s, window 9.4 s | |
| Search (typing the query, Enter, until results are in the DOM; this includes about 1 s of fixed waiting) | `espresso` 2.4 s, `tag:#espresso` 1.1 s, `path:Projects espresso` 1.9 s, `line:(espresso saffron)` 1.0 s, regex `/esp.*sso/` 2.1 s, `OR` 1.5 s, `-term` 1.3 s, quoted phrase 1.1 s, `content:` 1.9 s, `[status:todo]` 1.1 s, `match-case:` 1.7 s | `search.query` `ms` is not reachable from the page; the numbers are wall time. The result list stops at 500 |
| Dataview index of 245 notes | 7.7 s and 13.2 s (two starts) | The app was not blocked, but plugin load is the longest part of start-up |
| SKAI rewrite (qwen2.5:0.5b) | result in less than about 25 s | Stop works (see below) |

## Bugs

### A2-1: Settings tabs of Templater, Tasks, Linter and Admonition are empty
**Severity:** high
**Steps to reproduce**
1. Plugin vault with `templater-obsidian` 2.26.0, `obsidian-tasks-plugin` 8.6.0, `obsidian-linter` 1.34.2 and `obsidian-admonition` 12.0.11 (`research/plugins/*/release`), trusted and enabled.
2. Press Ctrl+, and click "Templater", then "Tasks", "Linter", "Admonition" (also wait 6 s).
3. Inspect `app.setting.pluginTabs.find(t => t.id === 'templater-obsidian')`: `display` is `display(){}` and `getSettingDefinitions()` exists.

**Expected:** each tab shows the plugin's settings (template folder, Tasks status and global filter, Linter rules, Admonition types).
**Actual:** the right-hand page is completely blank. There is no console error. Dataview, Calendar, Outliner, Better Word Count, Advanced Tables and nldates tabs are fine.
**Cause (read from the release files):** the four plugins (minAppVersion 1.13.0 or 1.13.1) use the new declarative settings API, `getSettingDefinitions()`, instead of `display()`. sk_notes only calls `display()`. 27 of the 51 plugins in `research/plugins` contain `getSettingDefinitions` (advanced-canvas, cmdr, copilot, homepage, notebook-navigator, obsidian-git, meta-bind, tasknotes, ...), so the same blank page is likely for them.
**Effect:** these plugins can only be configured by editing `data.json` by hand (for Templater: no template folder, no user scripts, no startup templates).
**Evidence:** `qa/tmp/agent-A2/ev/templater-settings-empty.png`, `ev/settings-last.png`.

### A2-2: Templater "Insert template" silently drops the template's frontmatter
**Severity:** medium (data loss on insert)
**Steps to reproduce**
1. Templater with `templates_folder: Templates`, template `Templates/Tp.md`:
   ```
   ---
   created: <% tp.date.now("YYYY-MM-DD") %>
   ---
   Title: <% tp.file.title %>
   Tomorrow: <% tp.date.tomorrow("YYYY-MM-DD") %>
   ```
2. Open a note whose text is `Plain body`, cursor at the end.
3. Ctrl+P, "Templater: Open insert template modal", Enter, type `Tp`, Enter.

**Expected:** the body is inserted and `created: 2026-11-01` ends up in the note's properties (Templater calls `view.metadataEditor.insertProperties(frontmatter)`).
**Actual:** file on disk is `Plain body\nTitle: Tp target\nTomorrow: 2026-11-02\n`. The `created` property is gone, with no message. `metadataEditor` does not exist on the MarkdownView (`grep metadataEditor sk_notes/web/src` finds nothing), so Templater's optional call is skipped. The core "Insert template" command does merge properties correctly (checked: `status`, `tags` kept and `type`, `attendees` added).
**Evidence:** `qa/tmp/agent-A2/pv/Tp target.md` after the step.

### A2-3: External change to an open note is lost if the note has unsaved typing
**Severity:** medium (silent data loss; matters with Syncthing, Git, Dropbox)
**Steps to reproduce**
1. Open `Coffee.md` in an editor. Put the cursor at the end of the file.
2. Type ` L1`, then within 1 s append `\nEXT-1\n` to the file from another process (`open(f,'a').write(...)`).
3. Wait 5 s, then look at the editor and at the file.

**Expected:** like Obsidian, the two changes are merged. The editor shows both ` L1` and `EXT-1`.
**Actual:** `EXT-1` does not appear in the editor, and the next autosave overwrites the file without it. If the external write happens after the save (3 s later), it is picked up and shown correctly (also verified).
**Evidence:** `qa/tmp/agent-A2/vault/Coffee.md` (ends with ` L3\nEXT-3\n L1`, no `EXT-1`). Reproduced twice (the first time with `LOCAL-EDIT-1` / `EXTERNAL-APPEND`).

### A2-4: The in-note find bar (Ctrl+F) is not themed and overlaps the text
**Severity:** medium
**Steps to reproduce**
1. Open any note in Source or Live Preview mode in the dark theme.
2. Click into the editor and press Ctrl+F.

**Expected:** a dark find bar integrated with the editor (like the dark popups fixed in cycle 1).
**Actual:** a light-grey (`rgb(245,245,245)`, default CodeMirror) box with default-light inputs and large black buttons ("next", "previous", "all", "match case", "regexp", "by word", "replace", "replace all", all lower case, very small). It wraps into several rows in a 290 px pane and covers the first lines of the note (sticky, z-index 300).
**Evidence:** `ev/find-panel.png`, `ev/find-panel2.png`. `.cm-panels` background is computed as `rgb(245, 245, 245)`; the existing `.cm-search` CSS in `dist/app.css` sets no background for `.cm-panels`.

### A2-5: Admonition blocks have no colour (Obsidian `--callout-*` variables are missing)
**Severity:** medium (plugin output looks unstyled; also breaks themes and snippets that use these variables)
**Steps to reproduce**
1. Plugin `obsidian-admonition`. Note with a fence `ad-warning`, `title: Careful`, body text.
2. Open it in Reading mode.

**Expected:** a coloured box (border and tinted background; the plugin sets `--callout-color: var(--callout-warning)`).
**Actual:** no border and no background, only the icon and bold title. The element has `style="--callout-color: var(--callout-warning)"`, and `--callout-warning` is not defined anywhere (`getComputedStyle(body).getPropertyValue('--callout-warning')` is empty), so `border-left: 3px solid var(--callout-color)` and the tinted background in `.callout` become invalid. sk_notes defines `--callout-color` as a colour set from `data-callout`, while Obsidian defines `--callout-<type>` as `r, g, b` triplets.
**Evidence:** `ev/adm-reading.png`, `ev/admonition-no-color.png`.

### A2-6: Editor and Reading panes narrower than about 360 px clip their content instead of reflowing
**Severity:** medium
**Steps to reproduce**
1. Open a note with properties. Make a layout with a left sidebar plus two or three splits (for example by dragging the split divider until a pane is about 300 px wide), 1200 px wide window.
2. Look at the narrow pane: `.cm-scroller` has `scrollWidth 359` and `clientWidth 214` at a pane width of 296 px, and `scrollWidth 359` / `clientWidth 109` at 191 px.

**Expected:** text and the properties table wrap to the pane; a narrow pane still reads normally.
**Actual:** the text column has a minimum width of about 340 px plus a left margin of about 50 px. The right part of the text, property values and tags is cut off and a horizontal scrollbar appears. At 142 px the title wraps one letter per line (`H o m e`). With the saved big-vault layout (three columns) the middle pane shows "Note with (pa" and "[[Gran... 0009]]" cut off.
**Evidence:** `ev/narrow-pane-overflow.png`, `ev/narrow.png`, `ev/narrow2.png`, `ev/narrow3.png`.

### A2-7: Link updates on rename do not reach `[[links]]` in canvas text cards
**Severity:** low (may differ from Obsidian; I could not confirm what Obsidian does here)
**Steps to reproduce**
1. `RN/C.canvas` with a text card `see [[Alpha]]` and file cards pointing at `RN/Alpha.md`; `RN/B.md` with 14 link forms to `Alpha`.
2. Select `RN/Alpha.md`, press F2, type `Beta`, Enter.

**Expected:** links in the canvas text card follow the rename, like the file cards do.
**Actual:** file cards (including the `subpath`) are updated, edges are kept, and all link forms in B.md are rewritten correctly (alias, heading, block, embed, markdown link with and without `<>`, `%20`, frontmatter, `.md` suffix, case-insensitive match; `[[sub/Alpha]]` is left alone and code or fence text is left alone). The `[[Alpha]]` inside the canvas text card is left unchanged and now points nowhere. The cycle-1 fix itself (file cards) holds; this is only a gap.

## Cosmetic issues
- C-1: Japanese UI: the "No file is open" text in the right sidebar is clipped on both sides. `ev/lang-ja.png`.
- C-2: SKAI "Changes to <note>" dialog keeps a very tall empty area below the diff (modal about 640 px high for a 1-line diff). `ev/skai-review.png`.
- C-3: File recovery: the "Filter files..." box is drawn over the first list entry, which is half hidden. `shots/24-recovery.png`.
- C-4: Command palette with an empty query lists plugin commands first in alphabetical order ("Admonition: Collapse all", ...) rather than recently used and core commands. `ev/lang-ja.png`.
- C-5: Welcome window is a small box (860x520) in the top-left of a 1200x800 page, with a lot of empty space. `shots/01-first.png`. May come from the Xvfb setup.
- C-6: PDF export has the file name as title plus the H1, and does not include the properties block. `ev/export.pdf`.

## Checked and OK (cycle-1 fixes and others)
- Canvas typing: double-click a text card, type with spaces, newlines, `**`, `[[ ]]` and `#tag`, Escape. File JSON is valid, 3 nodes and 1 edge kept, the text is exactly what was typed.
- Metadata after rename: backlinks, tags and bases follow; folder rename `RN` to `RN2` updates `[[RN/Beta]]` to `[[RN2/Beta]]`, `[[sub/Alpha]]` to `[[RN2/sub/Alpha]]`, and canvas `file` paths.
- Canvas file cards on rename (file and `#Heading` subpath cards).
- PDF export: valid 59 KB PDF (`pdftotext` reads the whole note).
- Calendar: view opens (Nov 2026), click on a day shows "New Daily Note: File 2026-11-04 does not exist. Would you like to create it?", Create makes the note.
- Templater: commands registered, insert from the modal fills `tp.date`, `tp.file.title` (but see A2-2).
- Tasks: `tasks` query block renders 6 of 72 tasks with sort and limit; "Create or edit task" modal opens (description prefilled with the current line, Apply/Cancel present).
- Dataview: LIST, TABLE (with sort and limit), TASK blocks and inline `= this.file.name` render; dataviewjs shows "disabled" (Dataview's own default).
- Linter: "Lint the current file" removes trailing spaces and adds a blank line after the heading.
- Table editor: Tab, Enter and auto-format work (Tab at the last cell adds a column, as the plugin's code does).
- Better Word Count: status bar shows counts.
- Link popup order: `[[Alp` lists the matching note first; Enter inserts `[[Alpha]]`.
- Alt+Enter follows the link in the current tab; Ctrl+Enter opens it in a new tab.
- Bases `displayName`: columns show "State" and "Twice"; 392 results; formula column works.
- Core templates: properties of the template are merged into the note's properties.
- SKAI: "Rewrite selection" shows a style menu, then "Review changes..." (diff dialog, "Nothing changes until you apply"). Cancel leaves the file byte-identical. Stop ends the stream ("Stopped.") and the status bar returns to "SKAI". A rewrite is applied only after Apply (the earlier attempt's `ev/coffee-after-rewrite.md` shows the applied result).
- Search operators `tag:`, `path:`, `file:`, `line:`, `section:`, `content:`, `match-case:`, regex, `OR`, `-term`, quotes, `[property:value]`, `task-todo:` return plausible sets.
- Hotkeys: bind Ctrl+Alt+9 to "Open today's daily note" in Settings; saved to `hotkeys.json`; the key works.
- Live editing: list nesting with Tab, Enter on an empty item leaves the list, numbered lists, task items and `>` quotes continue, auto-pair of `( [ { "` with real key events.
- External change on an idle open note reloads in the editor.
- Languages: all 9 locale files have 831 keys, no missing or extra, no placeholder mismatch. German UI: no clipped labels or raw keys in the settings tabs.
- Graph view: shows the whole vault in the pane; far outliers are included in the fit.
- Dark popups, quick switcher, command palette: dark in all runs (the find bar is the exception, A2-4).

## Plugin table
| Plugin | Loads | Commands | Main flow | Settings tab | Result |
|---|---|---|---|---|---|
| dataview 0.5.68 | yes | yes | LIST/TABLE/TASK/inline OK | OK | OK |
| templater-obsidian 2.26.0 | yes | yes | insert OK, frontmatter lost (A2-2) | blank (A2-1) | partly |
| obsidian-tasks-plugin 8.6.0 | yes | yes | query and modal OK | blank (A2-1) | partly |
| calendar 2.0.0 | yes | yes | open view, create daily note OK | OK | OK |
| obsidian-linter 1.34.2 | yes | yes | lint file OK | blank (A2-1) | partly |
| better-word-count 0.10.1 | yes | n/a | counts in status bar | OK | OK |
| obsidian-admonition 12.0.11 | yes | yes | renders, no colour (A2-5) | blank (A2-1) | partly |
| table-editor-obsidian 0.23.2 | yes | yes | Tab, Enter, format OK | OK | OK |
| nldates-obsidian 0.6.4 | yes | yes | not tested beyond load | OK | OK |
| obsidian-outliner 4.10.2 | yes | yes | not tested beyond load | OK | OK |

Console: only `Vim adapter not found` (Outliner) was logged as an error in all runs.

## Summary
Cycle-2 agent A re-tested the cycle-1 fixes and found no regression in them (canvas typing, rename metadata and canvas file cards, PDF export, Calendar/Tasks/Dataview flows, link popup order, Alt+Enter, SKAI rewrite and Stop, Bases displayName, template properties, dark popups). It reported 7 bugs: 0 critical, 1 high (A2-1: blank settings tabs for Templater, Tasks, Linter and Admonition, which use the new declarative settings API), 5 medium (A2-2 Templater frontmatter dropped, A2-3 external change lost when the note has unsaved typing, A2-4 unthemed find bar, A2-5 uncoloured admonitions, A2-6 narrow panes clip content) and 1 low (A2-7 canvas text-card links not updated on rename), plus 6 cosmetic issues. Start-up with the 2,070-note vault and a restored layout takes 14 to 16 s on this 1-CPU machine (shared with agent B), so it may be partly environment-related. Themes, bookmarks and six of the nine UI languages were not exercised visually.
