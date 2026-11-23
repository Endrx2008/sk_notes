# sk_notes for Android

The workspace of the desktop app (`../sk_notes/web/src`, unchanged) packaged as an APK, for phones
and tablets with Android 8.0 or newer.

- **Page** – the desktop workspace plus `web/src/mobile/` (drawers, bottom bar, editing toolbar,
  touch for the graph and the canvas, folder browser, SKAI and plugin settings for a phone).
- **Backend** – `web/src/backend/`: what the Python backend does on the desktop, in JavaScript
  inside the page (vault, index, search, history, plugins and their permissions, importers).
- **Native side** – `app/java/`: a small Java part without libraries. `Bridge` is `SkNative` of the
  page (files, network, dialogs, other apps); `MainActivity` holds the WebView and serves the
  app's files and the vault's files to it; `VaultProvider` hands single files to other apps.

SKAI runs on a PC of the same network (Skorpion OS, or Ollama listening on the network): set its
address in Settings → SKAI. Vaults are normal folders, in the app's storage or (with Android's
"access to all files" permission) anywhere in the device storage, where sync apps reach them.

## Notes other apps read well

A vault is a folder of plain Markdown files, read as they are by Obsidian, Foam, Tolaria and any
Markdown editor: UTF-8, YAML front matter for properties and tags, `[[wikilinks]]` by file name.

- **Title heading** (Settings → Files and links, on by default here): a new note starts with
  `# Name`. Foam and Tolaria take the title of a note from that first heading, not from the file
  name; renaming the note updates the heading while it still is the old name.
- **Markdown links** (same page, off by default): `[Name](../Folder/Name.md)`, relative to the note
  holding the link, for apps and sites that do not follow wikilinks.

## Themes on a phone

- The colours of the phone interface are variables a theme may set (`--mobile-new-color`,
  `--mobile-view-color`, `--mobile-view-tile-color`, `--mobile-mark-color`, `--mobile-mark-text`,
  `--mobile-bar-background`, `--mobile-tile-icon-color`, and for the graph `--graph-node`,
  `--graph-node-focused`, `--graph-text`, `--graph-line`): see "themes" in `web/styles/90-mobile.css`
  and `web/themes/Anna.g_3/theme.css`, the theme that comes with the app.
- Community themes set the variables of the app they were written for. While one is in use
  (`body.has-css-theme`) the `--sk-*` colours follow those variables, so the bottom bar, Home and
  the logo take the theme; the header keeps its place whatever the theme does to it.

## Commands on a phone

There is no list of every command: what the app does has a button or a menu entry. Typing `/` in
a note offers the insertions without a button (`SLASH` in `web/src/mobile/mobile.js`). "Plugin
commands" (wheel menu, bar above the keyboard) exists only while a community plugin has commands.
Home is not a tab and not a step of the back/forward arrows.

## Encrypted vaults

A vault can be made encrypted, or an existing one encrypted later (Settings → General); an
encrypted one can be turned back into a normal folder. Never single notes. The vault is one file
`<Name>.skvault` in the folder the user picks. Code: `web/src/backend/vault-crypt.js` (format,
keys), `vault-lock.js` (locking by itself), `web/src/mobile/crypt-ui.js` (screens).

- Pieces of AES-256-GCM with a random vault key. The header holds that key twice: encrypted with
  the password (PBKDF2-HMAC-SHA256, 600 000 rounds) and with a recovery code (24 characters, shown
  once when the vault is encrypted; it sets a new password when the old one is forgotten; a new
  code can be made with the password). Changing the password rewrites the header only.
- One segment per save: only what changed is added at the end of the file; the file is written
  whole again when old versions take more room than the vault. Every piece is authenticated with
  its segment and position: swapped, moved or dropped pieces are refused; a save cut short (app
  killed) leaves an incomplete last piece, which is noticed and repaired.
- While open, the notes are in the app's private storage (`files/encrypted/<id>/`). The vault
  locks by itself when the app has been left for the chosen time (at once, 1–60 minutes, never);
  leaving to pick a file, share or print does not count. Locked: saved, private folder emptied,
  key forgotten. After a fresh start of the app the password is always asked.
- Encrypting an existing vault checks every note of the new file against the folder before the
  readable folder (and the history, search index and sync data the app kept for it) is deleted.
  `.git` and `.trash` stay out of the file.
- A file replaced by another device's copy (a sync app) is never overwritten: an open vault keeps
  the other copy beside it, and unsaved notes of this device come back as conflict copies.
- Files in the first encrypted format (one stream of pieces, no segments) open and are written
  again in the present form.
- No Git sync for an encrypted vault (its notes would be readable on the site).

## Other things a phone does its own way

- File list: a long press starts a choice of several rows (`web/src/mobile/multiselect.js`):
  rename them one dialog after the other, or delete them together.
- Graph: a long press on a dot gives that note a colour (its size stays the graph's own); a long
  press on more dots selects them all (a ring around each) and the colour goes to every one. A tap on
  the empty graph or back ends the choice.
- Back: closes what is on top, goes back in the tab, then to Home; only a back from Home leaves the
  app. Of the graph and the file list, only the one opened last is a step of back.
- File list: a long press then a slide of the finger chooses every note in between; the bar with
  rename and delete appears at the top of the screen, above the list even when it is a drawer.
- No new database (.base) files on a phone: existing ones open; on a PC the database is a view.
- Canvas: a long press on an arrow opens its menu (colour, direction, label, delete); the menu of a
  card can remove all its arrows; a tap on the title of the board renames it; a site typed without
  `https://` gets it; "Save a picture" draws the whole board to a JPG in the vault
  (`views/canvas-image.js`). The graph's "save as image" does the same with a PNG.

## Vaults made with Obsidian (or Logseq)

A folder made with another app opens as it is ("Open a folder as vault"). The first time, the
settings in its `.obsidian` folder are used straight away (`web/src/backend/migrate.js`, `adopt`):
attachment folder, where new notes go, link format, daily notes, templates, theme and CSS snippets,
bookmarks, graph; new notes get no `# Name` heading (that app shows the file name as the title).
They are copied into `.sk_notes`: `.obsidian` is only read, never written. Community plugins are
code, so they are not taken by themselves: a notice offers to review them. The first change of a
file in a session says that the vault belongs to that app too (`web/src/mobile/foreign.js`):
*Continue*, or *Don't show again* for that vault.

## Settings that differ from the PC

- No "static site" (Settings → Core features) and no command for it.
- Appearance (`web/src/mobile/appearance.js`): fonts are chosen from a list of those the phone
  has; the base theme (dark/light) is offered only when the community theme in use has both looks.

## Spell checker

Settings → Editor → Spell check: off, the phone keyboard's checker, or the sk_notes checker
(`web/src/mobile/spell/`, `web/src/backend/routes-spell.js`). Nothing of the sk_notes checker is in
the APK but its glue code (`dist/spell-worker.js`, about 57 KB): the engine (Hunspell built for
WebAssembly, npm `hunspell-wasm` 0.3.0) is downloaded with the first language and installed only if
it has the SHA-256 written in `routes-spell.js`; the dictionaries (90 languages, licence shown for
each) come from one fixed commit of [wooorm/dictionaries](https://github.com/wooorm/dictionaries).
They live in the app's private storage, not in the vault. The checker runs in a worker: wavy
underline, suggestions on tap, personal dictionary, optional autocorrect (only nearly certain fixes;
backspace right after brings the typed word back). Code, links, tags, math and frontmatter are skipped.

## Updates

At every start the app asks the public GitHub API for the latest release of this repository
(`web/src/backend/routes-update.js`, one anonymous request). When it is newer, a notice with an
**Update** button appears once; ignored, it does not come back, but an orange "Update to …" button
stays at the bottom of the settings. Both open the release's APK in the browser, which downloads it
and hands it to Android's installer.

## Sync with GitHub, GitLab or another Git server

Settings → Sync (also proposed once on Home). The user gives a site, a name and a password or
access token and picks a repository (or lets the app make a private one); from then on the app
commits, fetches, merges and pushes by itself: at the start, a little after the last change, at an
interval, when it comes back to the front. The repository is a normal one: the PC uses the same
notes with Git, the Git plugin of Obsidian, Foam or Tolaria.

- GitHub accepts access tokens only (not the account password): the screen opens the page that
  makes one. GitLab accepts a token, or the password of an account without two-step sign-in.
- Code: `web/src/backend/git-sync.js` (one round, the merge rules), `git-adapters.js` (files and
  network for isomorphic-git, the Git library), `routes-sync.js` (set-up, what is kept),
  `web/src/mobile/sync.js` (screens and timing).
- Merges never leave conflict markers and never drop text: different lines of a note are merged;
  the same lines changed twice keep the server's text and save this device's as
  `Name (conflict <date>).md`; delete against change keeps the file.
- The Git data is in the app's private storage (not a `.git` inside the vault); the password or
  token is in `files/secrets`, encrypted with a key of the Android Keystore (`Secrets.java`).
  Neither is reachable by community plugins, and the token is added to requests for that
  repository only.
- Not synced: `.trash/`, the layout of this device (`.sk_notes/workspace-mobile.json`), files over
  50 MB. A `.gitignore` is written when the vault has none.

## Build

    npm ci                 # once, in the repository root
    sh android/build.sh    # → android/dist/sk_notes-<version>.apk

Needs node, a JDK (17+), `zip`, and the Android SDK (build-tools and one platform; `ANDROID_HOME`,
default `~/android-sdk`). No Gradle. The version is the one in `android/package.json`.

The first build creates the signing key `~/.config/sk_notes-android/release.jks` (password in
`release.jks.pass` beside it). **Keep both**: Android installs an update only when it is signed
with the same key. Use `SKN_KEYSTORE` / `SKN_KEYSTORE_PASS` for a key kept elsewhere.

Install on a device with USB debugging: `adb install -r android/dist/sk_notes-<version>.apk`.

## Tests

    cd android && npm test                 # parser and vault service against the Python ones; Git sync
                                           # against a real Git server (git http-backend) and real Git
    node web/tests/harness/server.mjs --data /tmp/skn-bench    # the page in a desktop browser,
                                                               # with a stand-in for the native side

`web/tests/harness/shot.py` drives that page in Qt WebEngine at phone or tablet size.

## Notes on the native side

- The page lives at `https://appassets.androidplatform.net/app/` (a name reserved for pages packed
  inside apps; nothing is asked to the network for it) and vault files under `/vault/`. Any other
  address is refused unless an active plugin holds the `network` permission.
- Web cards of a canvas show the site inside the card: the backend names the site's host
  (`net.allowFrame`) and only frames may load it. The card's page is fetched by the native side so
  that `X-Frame-Options` / `frame-ancestors` do not leave the card empty.
- PDFs: the WebView has no PDF viewer; `/pdf/<path>` serves the pages as pictures drawn with
  Android's `PdfRenderer` (`web/src/mobile/pdf.js` shows them in the PDF view, in embeds and in canvas cards).
- Every load of the page gets a new key for `SkNative`, given once to the backend before any
  plugin runs: community plugins cannot call the native side directly.
- Languages: `web/locales/*.json` hold the strings that exist only on Android; every language must
  have every key of `en.json` (the build stops otherwise). Like on the desktop, the translations
  are marked "needs review".
