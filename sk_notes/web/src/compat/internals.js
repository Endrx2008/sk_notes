// Members that plugins commonly reach for beyond the documented API (found by scanning
// the released bundles of the 50 most used plugins). Mapped onto sk_notes equivalents.

import { call, callSync, resourceUrl } from '../core/api.js';
import { applyTheme } from '../core/theme.js';
import { FileView } from '../views/base.js';
import { openSettings } from '../ui/settings.js';
import { nodeModules } from './node.js';

const CONFIG_MAP = {
  attachmentFolderPath: 'attachmentFolderPath', newFileLocation: 'newFileLocation', newFileFolderPath: 'newFileFolderPath',
  useMarkdownLinks: 'useMarkdownLinks', alwaysUpdateLinks: 'alwaysUpdateLinks', tabSize: 'tabSize', readableLineLength: 'readableLineLength',
  livePreview: 'livePreview', defaultViewMode: 'defaultViewMode', baseFontSize: 'baseFontSize', cssTheme: 'cssTheme',
  spellcheck: 'spellcheck', showInlineTitle: 'showInlineTitle', foldHeading: 'foldGutter', foldIndent: 'foldGutter',
  autoPairBrackets: 'autoPair', autoPairMarkdown: 'autoPair', promptDelete: 'promptDelete', trashOption: 'trashOption',
};

export function installInternals(app) {
  const ws = app.workspace;
  const mc = app.metadataCache;
  const vault = app.vault;
  const lsPrefix = `sk_notes:${vault.getName()}:`;

  // ---------------------------------------------------------------- app
  app.loadLocalStorage = (key) => {
    try { const v = localStorage.getItem(lsPrefix + key); return v === null ? null : JSON.parse(v); } catch { return null; }
  };
  app.saveLocalStorage = (key, value) => {
    try { if (value === undefined || value === null) localStorage.removeItem(lsPrefix + key); else localStorage.setItem(lsPrefix + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  };
  app.openWithDefaultApp = (path) => call('system.openPath', { path });
  app.showInFolder = (path) => call('system.showInFolder', { path });
  app.getAccentColor = () => getComputedStyle(document.body).getPropertyValue('--sk-accent').trim();
  app.getObsidianUrl = (file) => `sknotes://open?vault=${encodeURIComponent(vault.getName())}&file=${encodeURIComponent(file.path)}`;
  app.getTheme = () => (document.body.hasClass('theme-dark') ? 'obsidian' : 'moonstone');
  app.changeTheme = (theme) => app.settings.set('theme', theme === 'moonstone' ? 'light' : 'dark');
  app.foldManager = { load: () => null, save() {} };
  app.dragManager = { draggable: null, dragFile: (evt, file) => ({ source: 'sk', type: 'file', file }), onDragStart() {}, setAction() {} };
  app.embedRegistry = { embedByExtension: {}, registerExtension() {}, unregisterExtension() {} };
  app.secretStorage = {
    getSecret: (id) => app.loadLocalStorage(`secret:${id}`),
    setSecret: (id, v) => app.saveLocalStorage(`secret:${id}`, v),
    listSecrets: () => [],
  };
  app.metadataTypeManager = {
    properties: {},
    getPropertyInfo: (name) => ({ name, type: app.propertyTypes?.[name] || 'text' }),
    getAllProperties: () => app.metadataTypeManager.properties,
    getAssignedType: (name) => app.propertyTypes?.[name] || null,
    setType: (name, type) => { app.propertyTypes[name] = type; app.config.write('types.json', { types: app.propertyTypes }); },
    on: () => ({}), off() {}, trigger() {},
  };
  app.hotkeyManager = {
    get customKeys() { return app.commands.customHotkeys; },
    getHotkeys: (id) => app.commands.customHotkeys[id],
    getDefaultHotkeys: (id) => app.commands.findCommand(id)?.hotkeys || [],
    printHotkeyForCommand: (id) => (app.commands.hotkeysFor(id)[0] ? `${(app.commands.hotkeysFor(id)[0].modifiers || []).join('+')}+${app.commands.hotkeysFor(id)[0].key}` : ''),
    setHotkeys: (id, list) => app.commands.setHotkeys(id, list),
    removeHotkeys: (id) => app.commands.setHotkeys(id, []),
    save() {}, load() {}, bake() {}, bakedIds: [], bakedHotkeys: [],
  };
  app.customCss = {
    get enabledSnippets() { return new Set(app.settings.get('enabledCssSnippets') || []); },
    get snippets() { return []; },
    get theme() { return app.settings.get('cssTheme') || ''; },
    setTheme: (t) => app.settings.set('cssTheme', t),
    setCssEnabledStatus: (name, on) => {
      const s = new Set(app.settings.get('enabledCssSnippets') || []);
      if (on) s.add(name.endsWith('.css') ? name : name + '.css'); else s.delete(name.endsWith('.css') ? name : name + '.css');
      app.settings.set('enabledCssSnippets', [...s]);
    },
    readSnippets: () => app.loadCss?.(), requestLoadSnippets: () => app.loadCss?.(), getSnippetsFolder: () => '.sk_notes/snippets',
    getThemeFolder: () => '.sk_notes/themes', onConfigChange() {},
  };
  app.mobileNavbar = null;
  app.mobileToolbar = null;
  app.isDarkMode = () => document.body.hasClass('theme-dark');
  app.title = 'sk_notes';
  void applyTheme;

  // settings modal handle that works whether or not the modal is open
  Object.defineProperty(app, 'setting', {
    configurable: true,
    get() {
      return app._settingModal || {
        open: () => openSettings(app), close() {}, openTabById: (id) => openSettings(app, id),
        openTab: (tab) => openSettings(app, tab?.id), activeTab: null, pluginTabs: app.plugins?.settingTabs || [],
        addSettingTab: () => {}, removeSettingTab: () => {}, containerEl: createDiv(), tabContentContainer: createDiv(),
        updatePluginSection() {}, openPage() {}, closePage() {},
      };
    },
    set(v) { app._settingModal = v; },
  });

  // ---------------------------------------------------------------- internal plugins
  const s = app.settings;
  const opt = (map) => new Proxy({}, { get: (tg, k) => (k in map ? s.get(map[k]) : undefined), set: (tg, k, v) => { if (k in map) s.set(map[k], v); return true; } });
  // (no object spread here: it would call the getters of `instance` too early)
  const internal = (id, instance, extra = {}) => {
    if (!('options' in instance)) instance.options = {};
    return Object.assign({ id, enabled: true, instance, enable() {}, disable() {}, _loaded: true }, extra);
  };
  app.internalPlugins.plugins = {
    'daily-notes': internal('daily-notes', { options: opt({ folder: 'dailyNoteFolder', format: 'dailyNoteFormat', template: 'dailyNoteTemplate' }),
      getDailyNote: () => app.commands.executeCommandById('daily-notes') }),
    templates: internal('templates', { options: opt({ folder: 'templatesFolder', dateFormat: 'templateDateFormat', timeFormat: 'templateTimeFormat' }) }),
    'zk-prefixer': internal('zk-prefixer', { options: opt({ format: 'uniqueNotePrefix', folder: 'uniqueNoteFolder' }) }),
    'file-explorer': internal('file-explorer', { revealInFolder: (f) => ws.getLeavesOfType('file-explorer')[0]?.view?.revealInFolder(f) }),
    'global-search': internal('global-search', { openGlobalSearch: (q) => { app.commands.executeCommandById('global-search:open'); ws.getLeavesOfType('search')[0]?.view?.setQuery(q); } }),
    bookmarks: internal('bookmarks', { get items() { return app.bookmarks.items; }, addItem: (it) => { app.bookmarks.items.push(it); app.bookmarks.save(); } }),
    graph: internal('graph', {}), backlink: internal('backlink', {}), 'outgoing-link': internal('outgoing-link', {}),
    'tag-pane': internal('tag-pane', {}), outline: internal('outline', {}), 'page-preview': internal('page-preview', {}),
    'command-palette': internal('command-palette', { options: { pinned: s.get('pinnedCommands') || [] } }),
    'note-composer': internal('note-composer', {}), workspaces: internal('workspaces', {}), 'word-count': internal('word-count', {}),
    canvas: internal('canvas', {}), bases: internal('bases', {}), properties: internal('properties', {}), 'file-recovery': internal('file-recovery', {}),
    switcher: internal('switcher', {}), 'random-note': internal('random-note', {}), 'slash-command': internal('slash-command', {}),
  };
  app.internalPlugins.config = Object.fromEntries(Object.keys(app.internalPlugins.plugins).map((k) => [k, true]));
  app.internalPlugins.getEnabledPlugins = () => Object.values(app.internalPlugins.plugins);

  // ---------------------------------------------------------------- vault / adapter
  vault.getConfig = (key) => {
    if (key === 'theme') return document.body.hasClass('theme-dark') ? 'obsidian' : 'moonstone';
    if (key === 'userIgnoreFilters') return [];
    if (key === 'newLinkFormat') return 'shortest';
    if (key === 'useTab') return false;
    if (key === 'showLineNumber') return false;
    if (key === 'strictLineBreaks') return false;
    if (key === 'vimMode') return false;
    if (key === 'rightToLeft') return false;
    return CONFIG_MAP[key] ? s.get(CONFIG_MAP[key]) : vault.config[key];
  };
  vault.setConfig = (key, value) => { if (CONFIG_MAP[key]) s.set(CONFIG_MAP[key], value); else vault.config[key] = value; };
  vault.getAvailablePath = (base, ext) => {
    const folder = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
    const name = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
    return callSync('vault.availablePath', { folder, base: name, ext: ext || '' });
  };
  vault.getAvailablePathForAttachments = (base, ext, file) => app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, file?.path || '');
  vault.exists = async (p) => !!vault.getAbstractFileByPath(p) || call('vault.exists', { path: p });
  vault.getVaultName = () => vault.getName();
  const adapter = vault.adapter;
  const shared = nodeModules(null);
  Object.defineProperties(adapter, {
    basePath: { get: () => adapter.getBasePath(), configurable: true },
    fs: { get: () => shared.fs, configurable: true },
    fsPromises: { get: () => shared.fs.promises, configurable: true },
    path: { get: () => shared.path, configurable: true },
    url: { get: () => shared.url, configurable: true },
    insensitive: { value: false, configurable: true, writable: true },
  });
  adapter.listRecursive = async (p) => {
    const out = { files: [], folders: [] };
    const walk = async (dir) => { const r = await adapter.list(dir); out.files.push(...r.files); out.folders.push(...r.folders); for (const f of r.folders) await walk(f); };
    await walk(p);
    return out;
  };
  adapter.getFilePath = (p) => resourceUrl(p);
  adapter.watch = () => {};
  adapter.on = () => {};
  adapter.off = () => {};

  // ---------------------------------------------------------------- metadata cache
  mc.getCachedFiles = () => Object.keys(mc.meta);
  mc.getLinks = () => {
    const out = {};
    for (const p in mc.meta) out[p] = [...(mc.meta[p].links || []), ...(mc.meta[p].embeds || [])];
    return out;
  };
  mc.getLinkSuggestions = () => {
    const out = [];
    for (const f of vault.getFiles()) {
      out.push({ file: f, path: f.path });
      const aliases = mc.getFileCache(f)?.frontmatter?.aliases;
      for (const a of Array.isArray(aliases) ? aliases : []) out.push({ file: f, path: f.path, alias: String(a) });
    }
    for (const src in mc.unresolvedLinks) for (const l in mc.unresolvedLinks[src]) out.push({ file: null, path: l });
    return out;
  };
  mc.fileCache = new Proxy({}, { get: (t2, p) => { const f = vault.getFileByPath(p); return f ? { mtime: f.stat.mtime, size: f.stat.size, hash: p } : undefined; } });
  mc.metadataCache = new Proxy({}, { get: (t2, h) => mc.meta[h] });

  // ---------------------------------------------------------------- workspace / file manager
  ws.getActiveFileView = () => (ws.activeLeaf?.view instanceof FileView ? ws.activeLeaf.view : null);
  ws.floatingSplit = { children: [] };
  ws.editorSuggest = { get suggests() { return app.editorSuggests; } };
  ws.handleLinkContextMenu = () => false;
  ws.handleExternalLinkContextMenu = () => false;
  ws.onLayoutChange = () => ws.trigger('layout-change');
  ws.iterateCodeMirrors = (cb) => ws.iterateAllLeaves((l) => { if (l.view?.cm) cb(l.view.cm); });
  ws.protocolHandlers = app.protocolHandlers ||= {};
  ws.registerObsidianProtocolHandler = (action, fn) => { app.protocolHandlers[action] = fn; };
  app.fileManager.promptForFileDeletion = (f) => app.fileManager.promptForDeletion(f);

  // ---------------------------------------------------------------- plugins manager internals
  const pm = app.plugins;
  pm.loadManifests = () => pm.refresh();
  pm.getPluginFolder = () => '.sk_notes/plugins';
  pm.requestSaveConfig = () => {};
  pm.checkForUpdates = async () => {};
  pm.updates = {};
  pm.installPlugin = async (repo) => call('plugins.installGithub', { repo });
}
