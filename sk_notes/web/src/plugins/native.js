// sk_notes native plugin API: require('sknotes') inside a plugin (also window.sknotes).
// A small, stable, documented surface (docs/api.md). Permissions a plugin needs are
// declared in manifest.json → "skPermissions" and confirmed by the user on enable.

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { getLanguage } from '../core/i18n.js';
import { Plugin } from '../compat/plugin.js';
import { Menu, Modal, Notice, Setting } from '../ui/kit.js';
import { PluginSettingTab } from '../ui/settings.js';

export const NATIVE_API_VERSION = '1.0.0';

export function makeNativeApi(app, pluginId) {
  const vault = app.vault;
  const file = (path) => {
    const f = vault.getFileByPath(path);
    if (!f) throw new Error(`file not found: ${path}`);
    return f;
  };
  return Object.freeze({
    version: NATIVE_API_VERSION,
    Plugin,
    PluginSettingTab,
    Setting,
    Modal,
    Menu,
    Notice,
    setIcon,
    language: () => getLanguage(),
    notice: (message, ms) => new Notice(message, ms),

    vault: Object.freeze({
      name: () => vault.getName(),
      list: (ext = 'md') => vault.getFiles().filter((f) => !ext || f.extension === ext).map((f) => f.path),
      exists: (path) => !!vault.getAbstractFileByPath(path),
      read: (path) => vault.read(file(path)),
      write: async (path, text) => {
        const f = vault.getFileByPath(path);
        if (f) await vault.modify(f, text); else await vault.create(path, text);
      },
      append: (path, text) => vault.append(file(path), text),
      rename: (path, newPath) => app.fileManager.renameFile(file(path), newPath),
      trash: (path) => app.fileManager.trashFile(file(path)),
      onChange: (cb) => {
        const refs = ['create', 'modify', 'delete', 'rename'].map((ev) => vault.on(ev, (f, old) => cb({ type: ev, path: f.path, oldPath: old })));
        return () => refs.forEach((r) => vault.offref(r));
      },
    }),

    metadata: Object.freeze({
      get: (path) => app.metadataCache.getCache(path),
      tags: () => app.metadataCache.getTags(),
      backlinks: (path) => Object.keys(app.metadataCache.resolvedLinks).filter((src) => app.metadataCache.resolvedLinks[src][path]),
      resolveLink: (linktext, sourcePath = '') => app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null,
      setProperty: (path, key, value) => app.fileManager.processFrontMatter(file(path), (fm) => { fm[key] = value; }),
    }),

    workspace: Object.freeze({
      activeFile: () => app.workspace.getActiveFile()?.path ?? null,
      open: (path, newTab = false) => app.workspace.openFile(file(path), newTab ? 'tab' : false),
      selection: () => app.workspace.activeEditor?.editor?.getSelection() ?? '',
      insert: (text) => app.workspace.activeEditor?.editor?.replaceSelection(text),
      onFileOpen: (cb) => { const r = app.workspace.on('file-open', (f) => cb(f?.path ?? null)); return () => app.workspace.offref(r); },
    }),

    search: (query) => call('search.query', { query }, pluginId),

    skai: Object.freeze({
      available: () => !!app.skai?.enabled && !!app.skai?.status?.available,
      /** Ask SKAI; resolves to the full answer text. Streamed pieces go to onChunk. */
      ask: (prompt, { system, onChunk } = {}) => {
        if (!app.skai?.enabled) return Promise.reject(new Error('SKAI is turned off'));
        const msgs = [app.skai.system(system || ''), { role: 'user', content: String(prompt) }];
        return app.skai.chat(msgs, { onChunk }).promise;
      },
    }),
  });
}

export function installNativeApi(app) {
  window.sknotes = makeNativeApi(app, null);
}
