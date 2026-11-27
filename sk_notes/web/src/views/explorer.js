// File explorer (left sidebar).

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t, errorText } from '../core/i18n.js';
import { debounce } from '../core/util.js';
import { Keymap } from '../model/keymap.js';
import { TFile, TFolder } from '../model/vault.js';
import { Menu, SearchComponent, setTooltip } from '../ui/kit.js';
import { ItemView } from './base.js';

const SORTS = ['alphabetical', 'alphabeticalReverse', 'byModifiedTime', 'byModifiedTimeReverse', 'byCreatedTime', 'byCreatedTimeReverse'];

export class FileExplorerView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'folder';
    this.expanded = new Set();
    this.items = new Map(); // path -> {el, selfEl, childrenEl}
    this.activePath = null;
    this.autoReveal = false;
    this.headerEl.addClass('nav-header-view');
    this.navButtonsEl.hide();
    this.titleContainerEl.hide();
    this.moreOptionsButton.hide();
    const btns = this.headerEl.createDiv('nav-buttons-container');
    const btn = (icon, label, fn) => {
      const b = btns.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    btn('file-plus', t('explorer.new-note'), () => this.newNote(this._targetFolder()));
    btn('folder-plus', t('explorer.new-folder'), () => this.newFolder(this._targetFolder()));
    this.sortBtn = btn('sort', t('explorer.sort'), (e) => this.sortMenu(e));
    this.revealBtn = btn('focus', t('explorer.auto-reveal'), () => {
      this.autoReveal = !this.autoReveal;
      this.revealBtn.toggleClass('is-active', this.autoReveal);
      if (this.autoReveal) this.revealActive();
      this.app.workspace.requestSaveLayout();
    });
    this.collapseBtn = btn('chevrons-down-up', t('explorer.collapse-all'), () => this.toggleCollapseAll());
    this.contentEl.addClass('nav-files-container', 'node-insert-event');
    this.contentEl.setAttr('tabindex', '0');
    // a search among the names of the files, at the top of the list (shown when the list fills the
    // main area: the list view of a phone or tablet). The words inside the notes are searched in the
    // Search tab (the magnifier) of the sidebar.
    this.searchEl = this.contentEl.createDiv('nav-search');
    this.searchInput = new SearchComponent(this.searchEl).setPlaceholder(t('explorer.search-names'));
    this.searchInput.inputEl.addClass('nav-search-input');
    this.searchInput.onChange(debounce(() => this._search(), 120, true));
    this.treeEl = this.contentEl.createDiv('nav-folder mod-root');
    this.rootChildrenEl = this.treeEl.createDiv('nav-folder-children');
    this.searchResultsEl = this.contentEl.createDiv('nav-search-results');
    this.searchResultsEl.hide();
    this.render = debounce(() => this._render(), 50, true);
  }

  /** The files whose name has what was typed (every word, in any order), the closest names first. */
  _search() {
    const q = this.searchInput.getValue().trim().toLowerCase();
    const out = this.searchResultsEl;
    if (!q) { out.empty(); out.hide(); this.treeEl.show(); return; }
    const words = q.split(/\s+/);
    const hits = this.app.vault.getFiles().filter((f) => {
      const name = (f.extension === 'md' ? f.basename : f.name).toLowerCase();
      return words.every((w) => name.includes(w));
    }).sort((a, b) => {
      const na = a.basename.toLowerCase();
      const nb = b.basename.toLowerCase();
      return (nb.startsWith(words[0]) - na.startsWith(words[0])) || na.length - nb.length || na.localeCompare(nb);
    });
    out.empty();
    this.treeEl.hide();
    out.show();
    for (const file of hits.slice(0, 300)) {
      const item = out.createDiv({ cls: 'tree-item-self nav-file-title nav-search-result is-clickable', attr: { 'data-path': file.path } });
      const head = item.createDiv('nav-search-result-head');
      head.createDiv({ cls: 'tree-item-inner nav-file-title-content', text: file.extension === 'md' ? file.basename : file.name });
      if (file.parent && file.parent.path !== '/') head.createDiv({ cls: 'nav-search-result-folder', text: file.parent.path });
      item.addEventListener('click', (e) => this.app.workspace.getLeaf(Keymap.isModEvent(e) || false).openFile(file));
    }
    if (!hits.length) out.createDiv({ cls: 'nav-search-empty', text: t('explorer.search-names-none') });
  }

  /** path → item elements (plugins decorate explorer items through this). */
  get fileItems() {
    const out = {};
    for (const [path, it] of this.items) {
      out[path] = { el: it.el, selfEl: it.self, titleEl: it.self, innerEl: it.inner, titleInnerEl: it.inner, coverEl: it.el, file: it.file,
        childrenEl: it.childrenEl, collapsed: it.el.hasClass('is-collapsed'), setCollapsed: (c) => { if (c) this.expanded.delete(path); else this.expanded.add(path); this.render(); } };
    }
    return out;
  }

  getViewType() { return 'file-explorer'; }
  getDisplayText() { return t('explorer.title'); }
  getIcon() { return 'folder'; }

  getState() { return { sort: this.sort, autoReveal: this.autoReveal, expanded: [...this.expanded] }; }
  async setState(st) {
    if (st.sort) this.sort = st.sort;
    if (st.autoReveal !== undefined) { this.autoReveal = !!st.autoReveal; this.revealBtn.toggleClass('is-active', this.autoReveal); }
    if (st.expanded) this.expanded = new Set(st.expanded);
    this.render();
  }

  async onOpen() {
    this.sort = this.sort || this.app.settings.get('fileExplorerSort') || 'alphabetical';
    const v = this.app.vault;
    this.registerEvent(v.on('create', () => this.render()));
    this.registerEvent(v.on('delete', () => this.render()));
    this.registerEvent(v.on('rename', (f, old) => {
      if (this.expanded.has(old)) { this.expanded.delete(old); this.expanded.add(f.path); }
      this.render();
    }));
    this.registerEvent(v.on('refresh', () => this.render()));
    this.registerEvent(this.app.workspace.on('file-open', (f) => { this.setActive(f?.path || null); if (this.autoReveal && f) this.reveal(f); }));
    this.registerDomEvent(this.contentEl, 'keydown', (e) => this.onKey(e));
    this._setupDrop(this.contentEl, () => this.app.vault.getRoot());
    this.contentEl.addEventListener('contextmenu', (e) => {
      if (e.target === this.contentEl || e.target === this.treeEl || e.target === this.rootChildrenEl) {
        const m = new Menu();
        this.app.fileMenu(m, this.app.vault.getRoot(), 'file-explorer');
        m.showAtMouseEvent(e);
      }
    });
    this._render();
  }

  _targetFolder() {
    const f = this.app.workspace.getActiveFile();
    if (this.app.settings.get('newFileLocation') === 'current' && f?.parent) return f.parent;
    return this.app.fileManager.getNewFileParent();
  }

  async newNote(folder) {
    const f = await this.app.fileManager.createNewMarkdownFile(folder);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(f, { state: { mode: 'source' } });
    setTimeout(() => { const el = leaf.view?.inlineTitleEl; if (el) { el.focus(); document.getSelection().selectAllChildren(el); } }, 50);
  }

  async newFolder(folder) {
    const base = folder && folder.path !== '/' ? folder.path : '';
    const path = await call('vault.availablePath', { folder: base, base: t('explorer.untitled-folder'), ext: '' });
    await this.app.vault.createFolder(path);
    if (base) this.expanded.add(base);
    this._render();
    this.startRename(this.app.vault.getAbstractFileByPath(path));
  }

  sortMenu(e) {
    const menu = new Menu();
    for (const s of SORTS) menu.addItem((i) => i.setTitle(t(`explorer.sort.${s}`)).setChecked(this.sort === s).onClick(() => {
      this.sort = s;
      this.app.settings.set('fileExplorerSort', s);
      this._render();
    }));
    menu.showAtMouseEvent(e);
  }

  toggleCollapseAll() {
    if (this.expanded.size) this.expanded.clear();
    else for (const f of this.app.vault.getAllFolders()) this.expanded.add(f.path);
    this._render();
    this.app.workspace.requestSaveLayout();
  }

  _sorted(children) {
    const s = this.sort;
    const folders = children.filter((c) => c instanceof TFolder).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const files = children.filter((c) => c instanceof TFile);
    const cmpName = (a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' });
    const cmp = {
      alphabetical: cmpName,
      alphabeticalReverse: (a, b) => -cmpName(a, b),
      byModifiedTime: (a, b) => b.stat.mtime - a.stat.mtime,
      byModifiedTimeReverse: (a, b) => a.stat.mtime - b.stat.mtime,
      byCreatedTime: (a, b) => b.stat.ctime - a.stat.ctime,
      byCreatedTimeReverse: (a, b) => a.stat.ctime - b.stat.ctime,
    }[s] || cmpName;
    if (s === 'alphabeticalReverse') folders.reverse();
    return [...folders, ...files.sort(cmp)];
  }

  _render() {
    const scroll = this.contentEl.scrollTop;
    this.items.clear();
    this.rootChildrenEl.empty();
    this._renderChildren(this.app.vault.getRoot(), this.rootChildrenEl);
    this.setActive(this.app.workspace.getActiveFile()?.path || null);
    this.contentEl.scrollTop = scroll;
    this.collapseBtn.empty();
    setIcon(this.collapseBtn, this.expanded.size ? 'chevrons-down-up' : 'chevrons-up-down');
  }

  _renderChildren(folder, container) {
    const frag = document.createDocumentFragment();
    for (const c of this._sorted(folder.children)) frag.appendChild(this._renderItem(c));
    container.appendChild(frag);
  }

  _renderItem(file) {
    const isFolder = file instanceof TFolder;
    const el = createDiv(isFolder ? 'tree-item nav-folder' : 'tree-item nav-file');
    const self = el.createDiv({ cls: `tree-item-self ${isFolder ? 'nav-folder-title mod-collapsible' : 'nav-file-title'} is-clickable`,
      attr: { 'data-path': file.path, draggable: 'true' } });
    if (isFolder) {
      const icon = self.createDiv('tree-item-icon collapse-icon nav-folder-collapse-indicator');
      setIcon(icon, 'chevron-right');
    }
    const inner = self.createDiv({ cls: `tree-item-inner ${isFolder ? 'nav-folder-title-content' : 'nav-file-title-content'}`, text: isFolder ? file.name : (file.extension === 'md' ? file.basename : file.basename) });
    if (!isFolder && file.extension !== 'md') self.createDiv({ cls: 'nav-file-tag', text: file.extension.toUpperCase() });
    const item = { el, self, inner, file, childrenEl: null };
    this.items.set(file.path, item);
    if (isFolder) {
      const open = this.expanded.has(file.path);
      el.toggleClass('is-collapsed', !open);
      if (open) {
        item.childrenEl = el.createDiv('tree-item-children nav-folder-children');
        this._renderChildren(file, item.childrenEl);
      }
    }
    self.addEventListener('click', (e) => this.onClick(e, file));
    self.addEventListener('auxclick', (e) => { if (e.button === 1 && file instanceof TFile) this.app.workspace.openFile(file, 'tab'); });
    self.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const m = new Menu();
      this.app.fileMenu(m, file, 'file-explorer');
      this.app.workspace.trigger('file-menu', m, file, 'file-explorer', this.leaf);
      m.showAtMouseEvent(e);
    });
    self.addEventListener('dragstart', (e) => {
      this._dragging = file;
      e.dataTransfer.setData('text/x-sk-path', file.path);
      e.dataTransfer.setData('text/plain', file instanceof TFile ? this.app.fileManager.generateMarkdownLink(file, '') : file.path);
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    self.addEventListener('dragend', () => { this._dragging = null; });
    self.addEventListener('mouseover', (e) => {
      if (file instanceof TFile && file.extension === 'md') this.app.pagePreview?.onHover(e, self, file.path, '', true, true);
    });
    if (isFolder) this._setupDrop(self, () => file);
    return el;
  }

  _setupDrop(el, getFolder) {
    el.addEventListener('dragover', (e) => {
      const internal = e.dataTransfer.types.includes('text/x-sk-path');
      const external = e.dataTransfer.types.includes('Files');
      if (!internal && !external) return;
      e.preventDefault();
      e.stopPropagation();
      el.addClass('is-being-dragged-over');
    });
    el.addEventListener('dragleave', () => el.removeClass('is-being-dragged-over'));
    el.addEventListener('drop', async (e) => {
      el.removeClass('is-being-dragged-over');
      const folder = getFolder();
      const path = e.dataTransfer.getData('text/x-sk-path');
      if (path) {
        e.preventDefault();
        e.stopPropagation();
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!f || f === folder || (f instanceof TFolder && (folder.path + '/').startsWith(f.path + '/'))) return;
        const target = (folder.path === '/' ? '' : folder.path + '/') + f.name;
        if (target === f.path) return;
        try { await this.app.fileManager.renameFile(f, target); } catch (err) { this.app.notice(t('notice.move-failed', { error: err.code || err.message })); }
        return;
      }
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) {
        e.preventDefault();
        e.stopPropagation();
        for (const f of files) {
          const p = await call('vault.availablePath', { folder: folder.path === '/' ? '' : folder.path, base: f.name.replace(/\.[^.]+$/, ''), ext: (f.name.match(/\.([^.]+)$/) || [])[1] || '' });
          await this.app.vault.createBinary(p, await f.arrayBuffer());
        }
      }
    });
  }

  onClick(e, file) {
    this._focusPath = file.path;
    if (file instanceof TFolder) {
      if (this.expanded.has(file.path)) this.expanded.delete(file.path); else this.expanded.add(file.path);
      this._render();
      this.app.workspace.requestSaveLayout();
      return;
    }
    const mode = Keymap.isModEvent(e);
    const viewType = this.app.viewRegistry.getTypeByExtension(file.extension);
    if (!viewType && !['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'mp3', 'mp4', 'wav', 'ogg', 'webm', 'bmp', 'avif', 'm4a', 'flac'].includes(file.extension)) {
      call('system.openPath', { path: file.path });
      return;
    }
    this.app.workspace.openFile(file, mode);
  }

  setActive(path) {
    if (this.activePath) this.items.get(this.activePath)?.self.removeClass('is-active');
    this.activePath = path;
    if (path) this.items.get(path)?.self.addClass('is-active');
  }

  reveal(file) {
    let p = file.parent;
    let changed = false;
    while (p && p.path !== '/') { if (!this.expanded.has(p.path)) { this.expanded.add(p.path); changed = true; } p = p.parent; }
    if (changed) this._render();
    const it = this.items.get(file.path);
    it?.self.scrollIntoView({ block: 'nearest' });
    this.setActive(file.path);
  }

  revealActive() {
    const f = this.app.workspace.getActiveFile();
    if (f) this.reveal(f);
  }

  revealInFolder(file) {
    this.app.workspace.revealLeaf(this.leaf);
    this.reveal(file);
  }

  startRename(file) {
    const it = file && this.items.get(file.path);
    if (!it) return;
    const inner = it.inner;
    const old = inner.getText();
    inner.setAttr('contenteditable', 'true');
    inner.addClass('is-being-renamed');
    inner.focus();
    document.getSelection().selectAllChildren(inner);
    const finish = async (commit) => {
      inner.removeAttribute('contenteditable');
      inner.removeClass('is-being-renamed');
      inner.removeEventListener('keydown', onKey);
      inner.removeEventListener('blur', onBlur);
      const name = inner.getText().trim().replace(/[\\/:]/g, '-');
      if (!commit || !name || name === old) { inner.setText(old); return; }
      const parent = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
      const target = file instanceof TFile ? `${parent}${name}.${file.extension}` : `${parent}${name}`;
      try { await this.app.fileManager.renameFile(file, target); } catch (e) {
        inner.setText(old);
        this.app.notice(t('notice.rename-failed', { error: errorText(e) }));
      }
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    };
    const onBlur = () => finish(true);
    inner.addEventListener('keydown', onKey);
    inner.addEventListener('blur', onBlur);
  }

  onKey(e) {
    if (e.target.isContentEditable) return;
    const visible = Array.from(this.contentEl.querySelectorAll('.tree-item-self')).filter((x) => x.offsetParent);
    const cur = visible.findIndex((x) => x.getAttr('data-path') === (this._focusPath || this.activePath));
    const pick = (i) => {
      const el = visible[Math.clamp(i, 0, visible.length - 1)];
      if (!el) return;
      this._focusPath = el.getAttr('data-path');
      visible.forEach((v) => v.toggleClass('has-focus', v === el));
      el.scrollIntoView({ block: 'nearest' });
    };
    const file = this._focusPath && this.app.vault.getAbstractFileByPath(this._focusPath);
    if (e.key === 'ArrowDown') { e.preventDefault(); pick(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pick(cur - 1); }
    else if (e.key === 'ArrowRight' && file instanceof TFolder && !this.expanded.has(file.path)) { this.expanded.add(file.path); this._render(); }
    else if (e.key === 'ArrowLeft' && file instanceof TFolder && this.expanded.has(file.path)) { this.expanded.delete(file.path); this._render(); }
    else if (e.key === 'Enter' && file) { e.preventDefault(); this.onClick(e, file); }
    else if (e.key === 'F2' && file) { e.preventDefault(); this.startRename(file); }
    else if (e.key === 'Delete' && file) { e.preventDefault(); this.app.fileManager.promptForDeletion(file); }
  }

  onPaneMenu() {}
}

export { SORTS, setTooltip };
