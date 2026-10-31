// The application object (also exposed as window.app for plugins).

import { call, onBackend } from '../core/api.js';
import { Events } from '../core/events.js';
import { t } from '../core/i18n.js';
import { applyTheme } from '../core/theme.js';
import { isAudio, isImage, isVideo, uid } from '../core/util.js';
import { Commands } from '../model/commands.js';
import { FileManager } from '../model/filemanager.js';
import { KeymapManager, Scope } from '../model/keymap.js';
import { MetadataCache } from '../model/metadata.js';
import { Settings } from '../model/settings.js';
import { TFile, TFolder, Vault } from '../model/vault.js';
import { Menu, Notice, setKitApp } from '../ui/kit.js';
import { Workspace } from '../ui/workspace.js';
import { MarkdownView } from '../views/markdown.js';
import { StatusBar } from '../ui/statusbar.js';
import { registerCoreFeatures } from '../features/core.js';
import { getAllTags, resolveSubpath } from '../model/metadata.js';

class ViewRegistry extends Events {
  constructor() {
    super();
    this.viewByType = Object.create(null);
    this.typeByExtension = Object.create(null);
  }
  registerView(type, creator) {
    if (this.viewByType[type]) throw new Error(`view type "${type}" already registered`);
    this.viewByType[type] = creator;
    this.trigger('view-registered', type);
  }
  unregisterView(type) { delete this.viewByType[type]; this.trigger('view-unregistered', type); }
  registerExtensions(exts, type) {
    for (const e of exts) {
      if (this.typeByExtension[e]) throw new Error(`extension "${e}" already registered`);
      this.typeByExtension[e] = type;
    }
    this.trigger('extensions-updated');
  }
  unregisterExtensions(exts) { for (const e of exts) delete this.typeByExtension[e]; this.trigger('extensions-updated'); }
  getTypeByExtension(ext) { return this.typeByExtension[ext]; }
  isExtensionRegistered(ext) { return !!this.typeByExtension[ext]; }
}

class MarkdownProcessors {
  constructor() {
    this.list = [];
    this.codeBlocks = new Map();
  }
  add(fn, sortOrder = 0) { fn.sortOrder = sortOrder; this.list.push(fn); return fn; }
  remove(fn) { this.list.remove(fn); }
  sorted() { return this.list.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)); }
}

export class App extends Events {
  constructor(info) {
    super();
    window.app = this;
    this.info = info;
    this.appId = uid(16);
    this.isMobile = false;
    this.isPopout = /popout=/.test(location.hash);
    this.api = call;
    this.scope = new Scope();
    this.keymap = new KeymapManager(this.scope);
    this.settings = new Settings();
    this.vault = new Vault(this, info.vault);
    this.metadataCache = new MetadataCache(this);
    this.viewRegistry = new ViewRegistry();
    this.markdownProcessors = new MarkdownProcessors();
    this.editorExtensions = [];
    this.editorSuggests = [];
    this.commands = new Commands(this);
    this.fileManager = new FileManager(this);
    this.workspace = new Workspace(this);
    this.config = {
      read: (name) => call('config.read', { name }),
      write: (name, data) => call('config.write', { name, data }),
    };
    this.internalPlugins = { plugins: {}, getPluginById: (id) => this.internalPlugins.plugins[id] || null,
      getEnabledPluginById: (id) => (this.internalPlugins.plugins[id]?.enabled ? this.internalPlugins.plugins[id].instance : null) };
    this.plugins = null; // community plugins manager, set by plugins/manager.js
    setKitApp(this);
  }

  // ---------------------------------------------------------------- boot
  async start(rootEl) {
    await this.settings.load();
    this.applyAppearance();
    this.settings.on('change', (key) => this._settingChanged(key));
    const hk = await this.config.read('hotkeys.json').catch(() => null);
    if (hk) this.commands.customHotkeys = hk;

    this.containerEl = rootEl.createDiv('app-container');
    const main = this.containerEl.createDiv('horizontal-main-container');
    main.appendChild(this.workspace.containerEl);
    this.statusBar = new StatusBar(this, this.containerEl);

    this.viewRegistry.registerView('markdown', (leaf) => new MarkdownView(leaf));
    this.viewRegistry.registerExtensions(['md'], 'markdown');
    registerCoreFeatures(this);

    const snap = await call('vault.snapshot');
    performance.mark('skn:snapshot');
    this.vault._load(snap.files);
    this.metadataCache._load(snap.metadata, snap.resolvedLinks, snap.unresolvedLinks);
    this._wireBackend();
    this._wireKeys();
    this._wireGlobalClicks();

    let layout = null;
    if (this.isPopout) {
      try { layout = { main: { type: 'split', direction: 'vertical', children: [{ type: 'leaf', state: JSON.parse(decodeURIComponent(location.hash.split('popout=')[1])) }] } }; } catch { layout = null; }
      document.body.addClass('is-popout-window');
    } else {
      layout = await this.config.read('workspace.json').catch(() => null);
    }
    await this.workspace.changeLayout(layout || this._defaultLayout());
    this._ensureSidebars();
    this.workspace._setLayoutReady();
    performance.mark('skn:layout');
    this.metadataCache.trigger('resolved');
    if (this.plugins) await this.plugins.loadAll();
    performance.mark('skn:plugins');
    this.trigger('ready');
    window.__skn.flush = () => this.flush();
  }

  _defaultLayout() {
    return {
      main: { type: 'split', direction: 'vertical', children: [{ type: 'tabs', children: [{ type: 'leaf', state: { type: 'empty' } }] }] },
      left: { type: 'split', direction: 'horizontal', width: 280, children: [{ type: 'tabs', children: [
        { type: 'leaf', state: { type: 'file-explorer' } }, { type: 'leaf', state: { type: 'search' } }, { type: 'leaf', state: { type: 'bookmarks' } }] }] },
      right: { type: 'split', direction: 'horizontal', width: 300, collapsed: true, children: [{ type: 'tabs', children: [
        { type: 'leaf', state: { type: 'backlink' } }, { type: 'leaf', state: { type: 'outgoing-link' } }, { type: 'leaf', state: { type: 'tag' } },
        { type: 'leaf', state: { type: 'outline' } }, { type: 'leaf', state: { type: 'skai' } }] }] },
    };
  }

  _ensureSidebars() {
    if (this.isPopout) {
      this.workspace.leftSplit.setCollapsed(true);
      this.workspace.rightSplit.setCollapsed(true);
      return;
    }
    for (const type of ['file-explorer', 'search', 'bookmarks']) {
      if (!this.workspace.getLeavesOfType(type).length && this.viewRegistry.viewByType[type]) {
        this.workspace.getLeftLeaf(false).setViewState({ type });
      }
    }
    for (const type of ['backlink', 'outgoing-link', 'tag', 'outline', 'skai']) {
      if (!this.workspace.getLeavesOfType(type).length && this.viewRegistry.viewByType[type]) {
        this.workspace.getRightLeaf(false).setViewState({ type });
      }
    }
    const first = this.workspace._firstTabs(this.workspace.leftSplit);
    if (first) first.selectTab(first.children.find((l) => l.view?.getViewType() === 'file-explorer') || first.children[0]);
  }

  async flush() {
    const saves = [];
    this.workspace.iterateAllLeaves((l) => { if (l.view?.save) saves.push(l.view.save()); });
    await Promise.all(saves);
    await this.workspace.saveLayout();
    this.workspace.trigger('quit');
    return true;
  }

  // ---------------------------------------------------------------- backend events
  _wireBackend() {
    const handle = (name) => (d) => {
      const file = this.vault._onBackend(name, d);
      this.metadataCache._onBackend(name, d, file);
      if (name === 'rename' && file) this.workspace._onFileRenamed(file, d.oldPath);
      if (name === 'delete' && file) this.workspace._onFileDeleted(file);
      if (name === 'modify' && file instanceof TFile && d.external) this.workspace._onFileModified(file);
      if (name === 'rename') for (const p of d.updated || []) {
        const f = this.vault.getFileByPath(p);
        if (f) this.workspace._onFileModified(f);
      }
    };
    for (const n of ['create', 'modify', 'delete', 'rename']) onBackend(n, handle(n));
    onBackend('refresh', (snap) => {
      this.vault._load(snap.files);
      this.metadataCache._load(snap.metadata, snap.resolvedLinks, snap.unresolvedLinks);
      this.metadataCache._invalidateNames();
      this.vault.trigger('refresh');
      this.metadataCache.trigger('resolved');
      this.workspace.iterateAllLeaves((l) => {
        const v = l.view;
        if (v?.file && v.file.deleted) {
          const f = this.vault.getFileByPath(v.file.path);
          if (f) { v.file = f; v.onExternalModify?.(f); } else this.workspace._onFileDeleted(v.file);
        }
      });
    });
    onBackend('skai-theme', (d) => { this.info.theme = d.theme; this.applyAppearance(); });
  }

  // ---------------------------------------------------------------- keys & clicks
  _wireKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      const res = this.keymap.handle(e);
      if (res === false) { e.preventDefault(); e.stopPropagation(); return; }
      if (this.keymap.stack.length) return; // a modal/menu owns the keyboard
      if (this.commands.handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    document.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.changeZoom(e.deltaY < 0 ? 0.1 : -0.1);
    }, { passive: false });
  }

  _wireGlobalClicks() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a');
      if (!a || e.defaultPrevented) return;
      if (a.closest('.cm-editor') || a.closest('.markdown-reading-view')) return;
      if (a.hasClass('internal-link')) {
        e.preventDefault();
        const src = a.closest('[data-source-path]')?.getAttr('data-source-path') || this.workspace.getActiveFile()?.path || '';
        this.workspace.openLinkFromEvent(a.getAttr('data-href') || a.getAttr('href'), src, e);
      } else if (a.hasClass('tag')) {
        e.preventDefault();
        this.openTagSearch(a.getText().replace(/^#/, ''));
      } else if (/^(https?|mailto):/i.test(a.getAttr('href') || '')) {
        e.preventDefault();
        this.openExternal(a.getAttr('href'));
      }
    });
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest?.('input, textarea, .cm-editor, [contenteditable]')) e.preventDefault();
    });
  }

  // ---------------------------------------------------------------- helpers used across the UI
  notice(msg, ms) { return new Notice(msg, ms); }

  openExternal(url) {
    if (!/^(https?|mailto):/i.test(url)) return;
    call('system.openExternal', { url }).catch((e) => this.notice(String(e.code || e)));
  }

  openTagSearch(tag) {
    this.commands.executeCommandById('global-search:open');
    const leaf = this.workspace.getLeavesOfType('search')[0];
    leaf?.view?.setQuery?.(`tag:#${tag.replace(/^#/, '')}`);
  }

  async openLinkedView(leaf, type) {
    const target = this.workspace.createLeafBySplit(leaf, 'vertical');
    const file = leaf.view?.file;
    await target.setViewState({ type, state: { file: file?.path } });
    target.setGroupMember(leaf);
  }

  editorSettings() {
    const s = this.settings;
    return { lineWrap: s.get('lineWrap'), spellcheck: s.get('spellcheck'), tabSize: s.get('tabSize'), foldGutter: s.get('foldGutter'), autoPair: s.get('autoPair') };
  }

  /** Context menu entries shared by the file explorer, tab headers and "more options". */
  fileMenu(menu, file, source, leaf) {
    if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
    if (file instanceof TFile && source !== 'tab-header' && source !== 'more-options') {
      menu.addItem((i) => i.setTitle(t('file.open-new-tab')).setIcon('file').setSection('open').onClick(() => this.workspace.openFile(file, 'tab')));
      menu.addItem((i) => i.setTitle(t('file.open-right')).setIcon('split-right').setSection('open').onClick(() => this.workspace.openFile(file, 'split')));
      menu.addItem((i) => i.setTitle(t('file.open-window')).setIcon('window').setSection('open').onClick(() => this.workspace.openFile(file, 'window')));
    }
    if (file instanceof TFolder) {
      menu.addItem((i) => i.setTitle(t('file.new-note')).setIcon('file-plus').setSection('new').onClick(async () => {
        const f = await this.fileManager.createNewMarkdownFile(file);
        this.workspace.openFile(f, false).then((l) => l.view?.inlineTitleEl?.focus());
      }));
      menu.addItem((i) => i.setTitle(t('file.new-folder')).setIcon('folder-plus').setSection('new').onClick(() => this.commands._newFolderIn?.(file)));
      menu.addItem((i) => i.setTitle(t('file.new-canvas')).setIcon('canvas').setSection('new').onClick(() => this.commands._newCanvasIn?.(file)));
      menu.addItem((i) => i.setTitle(t('file.new-base')).setIcon('database').setSection('new').onClick(() => this.commands._newBaseIn?.(file)));
      menu.addItem((i) => i.setTitle(t('file.search-in-folder')).setIcon('search').setSection('action').onClick(() => {
        this.commands.executeCommandById('global-search:open');
        this.workspace.getLeavesOfType('search')[0]?.view?.setQuery?.(`path:"${file.path}"`);
      }));
    }
    if (file instanceof TFile) {
      menu.addItem((i) => i.setTitle(t('file.make-copy')).setIcon('copy').setSection('action').onClick(async () => {
        const folder = file.parent?.path === '/' ? '' : file.parent.path;
        const target = await call('vault.availablePath', { folder, base: file.basename, ext: file.extension });
        await this.vault.copy(file, target);
      }));
    }
    menu.addItem((i) => i.setTitle(t('file.move')).setIcon('folder-open').setSection('action').onClick(() => this.commands._moveFile?.(file)));
    menu.addItem((i) => i.setTitle(t('file.bookmark')).setIcon('bookmark').setSection('action').onClick(() => this.bookmarks?.addFile(file)));
    menu.addItem((i) => i.setTitle(t('file.copy-path')).setIcon('clipboard').setSection('info').onClick(() => navigator.clipboard.writeText(file.path)));
    if (file instanceof TFile) {
      menu.addItem((i) => i.setTitle(t('file.open-default-app')).setIcon('external-link').setSection('system')
        .onClick(() => call('system.openPath', { path: file.path })));
    }
    menu.addItem((i) => i.setTitle(t('file.show-in-system')).setIcon('folder-open').setSection('system')
      .onClick(() => call('system.showInFolder', { path: file.path })));
    menu.addItem((i) => i.setTitle(t('file.rename')).setIcon('pencil').setSection('danger').onClick(() => this.fileManager.promptForFileRename(file)));
    menu.addItem((i) => i.setTitle(t('common.delete')).setIcon('trash').setSection('danger').setWarning(true)
      .onClick(() => this.fileManager.promptForDeletion(file)));
  }

  // ---------------------------------------------------------------- attachments: paste & drop
  async saveAttachment(name, data, sourcePath) {
    const path = await this.fileManager.getAvailablePathForAttachment(name, sourcePath);
    const file = await this.vault.createBinary(path, data);
    return file;
  }

  handleEditorPaste(e, view, info) {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length || !info?.file) return false;
    e.preventDefault();
    (async () => {
      const links = [];
      for (const f of files) {
        const ext = (f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        const name = f.name && f.name !== 'image.png' ? f.name : `${t('file.pasted-image')} ${window.moment().format('YYYYMMDDHHmmss')}.${ext}`;
        const file = await this.saveAttachment(name, await f.arrayBuffer(), info.file.path);
        links.push(this.fileManager.generateMarkdownLink(file, info.file.path));
      }
      view.dispatch(view.state.replaceSelection(links.join('\n')));
    })().catch((err) => this.notice(String(err.message || err)));
    return true;
  }

  handleEditorDrop(e, view, info) {
    const files = Array.from(e.dataTransfer?.files || []);
    const vaultPath = e.dataTransfer?.getData('text/x-sk-path');
    if (!info?.file) return false;
    if (vaultPath) {
      e.preventDefault();
      const f = this.vault.getAbstractFileByPath(vaultPath);
      if (f instanceof TFile) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
        view.dispatch({ changes: { from: pos, insert: this.fileManager.generateMarkdownLink(f, info.file.path) } });
      }
      return true;
    }
    if (!files.length) return false;
    e.preventDefault();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    (async () => {
      const links = [];
      for (const f of files) {
        const file = await this.saveAttachment(f.name, await f.arrayBuffer(), info.file.path);
        links.push(this.fileManager.generateMarkdownLink(file, info.file.path));
      }
      view.dispatch({ changes: { from: pos, insert: links.join('\n') } });
    })().catch((err) => this.notice(String(err.message || err)));
    return true;
  }

  // ---------------------------------------------------------------- appearance
  applyAppearance() {
    const s = this.settings;
    applyTheme(this.info.theme, s.get('theme') || 'skai');
    const root = document.documentElement;
    root.style.setProperty('--font-text-size', `${s.get('baseFontSize') || 16}px`);
    if (s.get('textFont')) root.style.setProperty('--font-text-theme', s.get('textFont')); else root.style.removeProperty('--font-text-theme');
    if (s.get('monospaceFont')) root.style.setProperty('--font-monospace-theme', s.get('monospaceFont'));
    document.body.toggleClass('hide-ribbon', s.get('showRibbon') === false);
    this.loadCss?.();
    this.workspace?.trigger('css-change');
  }

  setAppearance(obj) { for (const [k, v] of Object.entries(obj)) this.settings.set(k, v); }

  _settingChanged(key) {
    if (['theme', 'baseFontSize', 'textFont', 'monospaceFont', 'showRibbon', 'enabledCssSnippets', 'cssTheme'].includes(key)) this.applyAppearance();
    if (['lineWrap', 'spellcheck', 'tabSize', 'foldGutter', 'autoPair'].includes(key)) {
      this.workspace.iterateAllLeaves((l) => l.view?.cmHandle?.setSettings(this.editorSettings()));
    }
    if (key === 'readableLineLength') this.workspace.iterateAllLeaves((l) => l.view?.sourceEl?.toggleClass('is-readable-line-width', this.settings.get(key) !== false));
    if (key === 'showInlineTitle') this.workspace.iterateAllLeaves((l) => l.view?.inlineTitleEl?.toggle(this.settings.get(key) !== false));
    this.workspace.trigger('options-change');
  }

  changeZoom(delta) {
    const z = Math.clamp(Math.round(((this.info.zoom || 1) + delta) * 10) / 10, 0.5, 3);
    this.info.zoom = z;
    call('app.setZoom', { zoom: z });
  }

  updateEditorExtensions() {
    this.workspace.iterateAllLeaves((l) => l.view?.cmHandle?.setPluginExtensions(this.editorExtensions.flat(Infinity)));
  }

  // shared helper for the subpath resolution exported to plugins
  resolveSubpath(cache, subpath) { return resolveSubpath(cache, subpath); }
  allTagsOf(cache) { return getAllTags(cache) || []; }

  isVaultPath(p) { return !!this.vault.getAbstractFileByPath(p); }
  fileTypeIcon(file) {
    if (file instanceof TFolder) return 'folder';
    if (file.extension === 'md') return 'file-text';
    if (file.extension === 'canvas') return 'canvas';
    if (file.extension === 'base') return 'database';
    if (file.extension === 'pdf') return 'pdf';
    if (isImage(file.extension)) return 'image';
    if (isAudio(file.extension)) return 'music';
    if (isVideo(file.extension)) return 'film';
    return 'file';
  }

  menu() { return new Menu(); }
}
