# sk_notes plugin API

sk_notes runs two kinds of plugins from `<vault>/.sk_notes/plugins/<folder>/`:

1. **Native plugins** use the small, stable API below (`require('sknotes')`).
2. **Community plugins** written for the plugin API of other Markdown note apps run through a
   compatibility layer (`require('obsidian')`); see [compatibility.md](compatibility.md).

Both are CommonJS files (`main.js`) with a `manifest.json` and an optional `styles.css`.
No community plugin runs while *restricted mode* is on (Settings → Community plugins).

## Manifest

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "minAppVersion": "0.5.0",
  "description": "What it does.",
  "author": "You",
  "isDesktopOnly": false,
  "skPermissions": ["network"]
}
```

`skPermissions` lists the permissions the plugin needs; they are shown to the user when the
plugin is enabled and granted only if the user accepts.

## Permissions

| Permission | Allows |
|---|---|
| *(always)* | read and write notes inside the vault; read/write its own folder `.sk_notes/plugins/<id>/` |
| `fs-outside-vault` | files outside the vault (Node `fs` with absolute paths) |
| `exec` | running programs (`child_process`) |
| `network` | `requestUrl()` to remote hosts, and remote `fetch()` from the page |
| `open-external` | opening URLs in the browser |
| `clipboard` | reserved |

A permission that was not declared (or a community plugin that declares none) is asked for
the first time it is needed: *Allow once*, *Always allow*, *Deny*. Answers are stored in
`.sk_notes/permissions.json` and can be changed in Settings → Community plugins → 🛡.
Plugins can never write into `.sk_notes` outside their own folder.

Local services count as network: only the configured Ollama server is reachable without
the `network` permission.

### How permissions are enforced

Plugins and the HTML of notes run in the same JavaScript context as sk_notes (needed to
run plugins written for Obsidian), so neither a plugin id nor "being the page" proves
anything. Instead (see `sk_notes/app/callers.py`):

- every API call carries a secret. The page gets an *app key* from a one-time boot secret
  that Python injects before any script runs, and keeps it in a module-private variable;
  each plugin gets its own *token*, held only by that plugin's `require()` modules. A call
  with neither is refused, so a note's `<img>`/`<iframe>`/form or a plugin's raw `fetch`
  cannot use the API;
- what plugins may do is stored on this computer (`<config>/sk_notes/vault-trust/`), never
  in the vault: restricted mode, which plugins are trusted, permission answers and the
  folders you picked. A shared or downloaded vault cannot arrive with plugins allowed;
- turning plugins on, granting a permission, installing, uninstalling and enabling a
  plugin for the first time show a **native** confirmation that page code cannot answer;
- the main window can only show the app itself; `window.open()` opens nothing;
- `.git`, the plugin and permission files and the trust store are never written by page
  code, judged by their real path (symlinks included); the vault folder cannot be
  deleted, renamed or copied;
- files outside the vault (imports, static site output) are only those you picked in a
  native file dialog; symlinks are judged by their real target for Node `fs`;
- only the configured Ollama server, and only for asking models, is reachable without the
  `network` permission; scripted link clicks do not open the browser.

Known limits (accepted, logged): a plugin can still use sk_notes' own JavaScript objects
(`app.vault`, `app.workspace`, `app.plugins`…) like any other plugin, so it can read and
change notes inside the vault, write other plugins' `data.json`, read, write or delete through a
symlinked folder (made by you) that points outside the vault, enable a plugin you already trusted, and open files
with the system's default program. WebRTC (STUN) is not covered by the network guard.
Install only plugins you trust; restricted mode (the default) runs none.

## Native API (`require('sknotes')`)

```js
const sk = require('sknotes');

module.exports = class MyPlugin extends sk.Plugin {
  async onload() {
    this.addCommand({ id: 'hello', name: 'Say hello', callback: () => sk.notice('Hello!') });
  }
};
```

| Member | Description |
|---|---|
| `version` | API version (`1.0.0`) |
| `Plugin` | base class: `onload()`, `onunload()`, `loadData()`, `saveData(data)`, `addCommand()`, `addRibbonIcon()`, `addStatusBarItem()`, `addSettingTab()`, `registerView()`, `registerMarkdownPostProcessor()`, `registerMarkdownCodeBlockProcessor()`, `registerEditorExtension()`, `registerEvent()`, `registerDomEvent()`, `registerInterval()`, `register(cleanup)` |
| `PluginSettingTab`, `Setting`, `Modal`, `Menu`, `Notice`, `setIcon` | UI building blocks |
| `notice(text, ms)` | show a notice |
| `language()` | current UI language code |
| `vault.name()` / `list(ext='md')` / `exists(path)` / `read(path)` / `write(path, text)` / `append(path, text)` / `rename(path, newPath)` / `trash(path)` | files (vault-relative paths) |
| `vault.onChange(cb)` | `cb({type, path, oldPath})` for create/modify/delete/rename; returns an unsubscribe function |
| `metadata.get(path)` | parsed metadata (frontmatter, links, tags, headings, sections, list items, blocks with positions) |
| `metadata.tags()` / `backlinks(path)` / `resolveLink(linktext, sourcePath)` / `setProperty(path, key, value)` | links, tags, properties |
| `workspace.activeFile()` / `open(path, newTab)` / `selection()` / `insert(text)` / `onFileOpen(cb)` | editor and tabs |
| `search(query)` | full search language; resolves to `{total, results: [{path, matches}]}` |
| `skai.available()` / `skai.ask(prompt, {system, onChunk})` | SKAI (local AI), if enabled and online |

A complete example is in [`examples/sample-plugin`](../examples/sample-plugin).

## Metadata format

Positions are `{start: {line, col, offset}, end: {…}}`, 0-based, with offsets and columns
in UTF-16 code units (JavaScript string indices). `listItems[].parent` is the line of the
parent item, or a negative number for top-level items of the same list.
