// Workspace layout: splits, tab groups, leaves, sidebars, ribbon; layout persistence.

import { Events } from '../core/events.js';
import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { debounce, uid } from '../core/util.js';
import { Keymap } from '../model/keymap.js';
import { TFile, TFolder, normalizePath } from '../model/vault.js';
import { parseLinktext } from '../model/metadata.js';
import { Menu, setTooltip } from './kit.js';
import { EmptyView, FileView, TextFileView } from '../views/base.js';

// ------------------------------------------------------------------- items
export class WorkspaceItem extends Events {
  constructor(ws, id) {
    super();
    this.workspace = ws;
    this.app = ws.app;
    this.id = id || uid(16);
    this.parent = null;
    this.dimension = null;
  }
  getRoot() { let x = this; while (x.parent) x = x.parent; return x; }
  getContainer() { return this.getRoot(); }
  setDimension(d) { this.dimension = d; if (this.containerEl) this.containerEl.style.flexGrow = d ?? 100; }
}

export class WorkspaceParent extends WorkspaceItem {
  constructor(ws, id) {
    super(ws, id);
    this.children = [];
  }

  insertChild(index, child) {
    if (child.parent) child.parent.removeChild(child, true);
    child.parent = this;
    index = index < 0 || index > this.children.length ? this.children.length : index;
    this.children.splice(index, 0, child);
    this._render();
  }

  replaceChild(index, child) {
    const old = this.children[index];
    if (child.parent) child.parent.removeChild(child, true);
    old.parent = null;
    child.parent = this;
    child.setDimension(old.dimension);
    this.children[index] = child;
    this._render();
  }

  removeChild(child, keepAlive) {
    const i = this.children.indexOf(child);
    if (i === -1) return;
    this.children.splice(i, 1);
    child.parent = null;
    child.containerEl?.detach();
    this._render();
    if (!this.children.length && !keepAlive) this._onEmpty();
  }

  _onEmpty() {
    if (this.parent && !(this instanceof WorkspaceRoot) && !(this instanceof WorkspaceSidedock)) this.parent.removeChild(this);
  }

  _render() {}
}

export class WorkspaceSplit extends WorkspaceParent {
  constructor(ws, direction = 'vertical', id) {
    super(ws, id);
    this.direction = direction;
    this.containerEl = createDiv('workspace-split');
    this._setDirClass();
  }

  _setDirClass() {
    this.containerEl.toggleClass('mod-vertical', this.direction === 'vertical');
    this.containerEl.toggleClass('mod-horizontal', this.direction === 'horizontal');
  }

  _render() {
    const el = this.containerEl;
    const want = [];
    this.children.forEach((c, i) => {
      if (i > 0) {
        c._handle ||= this._makeHandle();
        want.push(c._handle);
      }
      want.push(c.containerEl);
      c.containerEl.style.flexGrow = c.dimension ?? 100;
    });
    for (const c of Array.from(el.children)) if (!want.includes(c) && !c.hasClass('mod-keep')) c.detach();
    want.forEach((node, i) => { if (el.children[i] !== node) el.insertBefore(node, el.children[i] || null); });
    for (const keep of Array.from(el.children).filter((c) => c.hasClass('mod-keep'))) el.appendChild(keep);
    // a split with one child that is also a split: flatten
    if (this.children.length === 1 && this.children[0] instanceof WorkspaceSplit && !(this instanceof WorkspaceSidedock)
      && !(this.children[0] instanceof WorkspaceSidedock)) {
      const only = this.children[0];
      this.direction = only.direction;
      this._setDirClass();
      const kids = only.children.slice();
      this.children = [];
      for (const k of kids) { k.parent = null; this.insertChild(-1, k); }
    }
  }

  _makeHandle() {
    const h = createDiv('workspace-leaf-resize-handle');
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const idx = Array.from(this.containerEl.children).indexOf(h);
      const prevEl = this.containerEl.children[idx - 1];
      const nextEl = this.containerEl.children[idx + 1];
      const prev = this.children.find((c) => c.containerEl === prevEl);
      const next = this.children.find((c) => c.containerEl === nextEl);
      if (!prev || !next) return;
      const vertical = this.direction === 'vertical';
      const total = (vertical ? prevEl.offsetWidth + nextEl.offsetWidth : prevEl.offsetHeight + nextEl.offsetHeight);
      const sum = (prev.dimension ?? 100) + (next.dimension ?? 100);
      const start = vertical ? e.clientX : e.clientY;
      const startPrev = vertical ? prevEl.offsetWidth : prevEl.offsetHeight;
      document.body.addClass('is-resizing');
      const move = (ev) => {
        const delta = (vertical ? ev.clientX : ev.clientY) - start;
        const px = Math.clamp(startPrev + delta, 60, total - 60);
        prev.setDimension((px / total) * sum);
        next.setDimension(sum - prev.dimension);
        this.workspace.onLayoutResize();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.removeClass('is-resizing');
        this.workspace.requestSaveLayout();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    return h;
  }

  serialize() {
    return { id: this.id, type: 'split', direction: this.direction, dimension: this.dimension,
      children: this.children.map((c) => c.serialize()) };
  }
}

export class WorkspaceSidedock extends WorkspaceSplit {
  constructor(ws, side, id) {
    super(ws, 'horizontal', id);
    this.side = side;
    this.collapsed = false;
    this.size = 280;
    this.containerEl.addClass('mod-sidedock', side === 'left' ? 'mod-left-split' : 'mod-right-split');
    this.containerEl.style.width = this.size + 'px';
    this.resizeHandle = createDiv('workspace-sidedock-resize-handle');
    this.resizeHandle.addEventListener('mousedown', (e) => this._resize(e));
  }

  _resize(e) {
    e.preventDefault();
    const start = e.clientX;
    const startW = this.size;
    document.body.addClass('is-resizing');
    const move = (ev) => {
      const d = ev.clientX - start;
      this.setSize(Math.clamp(startW + (this.side === 'left' ? d : -d), 160, Math.max(200, innerWidth * 0.6)));
      this.workspace.onLayoutResize();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.removeClass('is-resizing');
      this.workspace.requestSaveLayout();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  setSize(px) {
    this.size = px;
    if (!this.collapsed) this.containerEl.style.width = px + 'px';
  }

  collapse() { this.setCollapsed(true); }
  expand() { this.setCollapsed(false); }
  toggle() { this.setCollapsed(!this.collapsed); }

  setCollapsed(v) {
    this.collapsed = !!v;
    this.containerEl.toggleClass('is-collapsed', this.collapsed);
    this.containerEl.style.width = this.collapsed ? '0px' : this.size + 'px';
    this.resizeHandle.toggle(!this.collapsed);
    document.body.toggleClass(`is-${this.side}-sidedock-collapsed`, this.collapsed);
    this.workspace.trigger('layout-change');
    this.workspace.onLayoutResize();
    this.workspace.requestSaveLayout();
    this.workspace._updateToggles();
  }

  _onEmpty() {}

  serialize() {
    return { ...super.serialize(), collapsed: this.collapsed, width: this.size };
  }
}

export class WorkspaceRoot extends WorkspaceSplit {
  constructor(ws, id) {
    super(ws, 'vertical', id);
    this.containerEl.addClass('mod-root');
  }
  _onEmpty() {}
}

export class WorkspaceTabs extends WorkspaceParent {
  constructor(ws, id) {
    super(ws, id);
    this.currentTab = 0;
    this.isStacked = false;
    this.containerEl = createDiv('workspace-tabs');
    this.tabHeaderContainerEl = this.containerEl.createDiv('workspace-tab-header-container');
    this.tabsInnerEl = this.tabHeaderContainerEl.createDiv('workspace-tab-header-container-inner');
    this.newTabButtonEl = this.tabHeaderContainerEl.createDiv({ cls: 'workspace-tab-header-new-tab' });
    const nb = this.newTabButtonEl.createEl('span', { cls: 'clickable-icon' });
    setIcon(nb, 'plus');
    setTooltip(nb, t('tab.new'));
    nb.addEventListener('click', () => {
      const leaf = new WorkspaceLeaf(this.workspace);
      this.insertChild(-1, leaf);
      leaf.setViewState({ type: 'empty' });
      this.workspace.setActiveLeaf(leaf, { focus: true });
    });
    this.tabHeaderSpacer = this.tabHeaderContainerEl.createDiv('workspace-tab-header-spacer');
    this.tabListEl = this.tabHeaderContainerEl.createDiv({ cls: 'workspace-tab-header-tab-list' });
    const tl = this.tabListEl.createEl('span', { cls: 'clickable-icon' });
    setIcon(tl, 'chevron-down');
    setTooltip(tl, t('tab.list'));
    tl.addEventListener('click', () => this._tabListMenu(tl));
    this.tabsContainerEl = this.containerEl.createDiv('workspace-tab-container');
    this.tabHeaderContainerEl.addEventListener('dblclick', (e) => {
      if (e.target === this.tabHeaderSpacer || e.target === this.tabsInnerEl) nb.click();
    });
    this._setupDrop();
  }

  get isSidedock() { const r = this.getRoot(); return r instanceof WorkspaceSidedock; }

  _tabListMenu(anchor) {
    const menu = new Menu();
    this.children.forEach((leaf, i) => menu.addItem((it) => it.setTitle(leaf.getDisplayText()).setIcon(leaf.getIcon())
      .setChecked(i === this.currentTab).onClick(() => this.selectTab(leaf))));
    menu.addSeparator();
    menu.addItem((it) => it.setTitle(this.isStacked ? t('tab.unstack') : t('tab.stack')).setIcon('stack')
      .onClick(() => this.setStacked(!this.isStacked)));
    menu.addItem((it) => it.setTitle(t('tab.close-all')).setIcon('x')
      .onClick(() => this.children.slice().forEach((l) => l.detach())));
    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.right, y: r.bottom + 4, left: true });
  }

  setStacked(v) {
    this.isStacked = !!v;
    this.containerEl.toggleClass('mod-stacked', this.isStacked);
    this._render();
    this.workspace.requestSaveLayout();
  }

  _render() {
    this.tabsInnerEl.empty();
    this.tabsContainerEl.empty();
    if (this.currentTab >= this.children.length) this.currentTab = Math.max(0, this.children.length - 1);
    this.children.forEach((leaf, i) => {
      this.tabsInnerEl.appendChild(leaf.tabHeaderEl);
      this.tabsContainerEl.appendChild(leaf.containerEl);
      const active = i === this.currentTab;
      leaf.tabHeaderEl.toggleClass('is-active', active);
      leaf.containerEl.toggle(active || this.isStacked);
      if (this.isStacked) leaf.containerEl.style.left = (i * 40) + 'px';
    });
  }

  selectTab(leaf) {
    const i = this.children.indexOf(leaf);
    if (i === -1) return;
    this.currentTab = i;
    this._render();
    leaf.view?.onResize?.();
  }

  selectTabIndex(i) { const l = this.children[i]; if (l) this.selectTab(l); }

  _onEmpty() {
    const root = this.getRoot();
    if (root instanceof WorkspaceRoot && this.parent === root && root.children.length === 1) {
      // never leave the main area without a tab group
      const leaf = new WorkspaceLeaf(this.workspace);
      this.insertChild(0, leaf);
      leaf.setViewState({ type: 'empty' });
      this.workspace.setActiveLeaf(leaf);
      return;
    }
    super._onEmpty();
  }

  _setupDrop() {
    const ws = this.workspace;
    this.tabHeaderContainerEl.addEventListener('dragover', (e) => {
      if (!ws._draggedLeaf) return;
      e.preventDefault();
      this.tabHeaderContainerEl.addClass('is-drop-target');
    });
    this.tabHeaderContainerEl.addEventListener('dragleave', () => this.tabHeaderContainerEl.removeClass('is-drop-target'));
    this.tabHeaderContainerEl.addEventListener('drop', (e) => {
      this.tabHeaderContainerEl.removeClass('is-drop-target');
      const leaf = ws._draggedLeaf;
      if (!leaf) return;
      e.preventDefault();
      // insert before the tab under the cursor
      let idx = this.children.length;
      for (let i = 0; i < this.children.length; i++) {
        const r = this.children[i].tabHeaderEl.getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) { idx = i; break; }
      }
      if (leaf.parent === this && this.children.indexOf(leaf) < idx) idx--;
      ws._moveLeaf(leaf, this, idx);
    });
    this.tabsContainerEl.addEventListener('dragover', (e) => {
      if (!ws._draggedLeaf && !e.dataTransfer.types.includes('Files')) return;
      if (!ws._draggedLeaf) return;
      e.preventDefault();
      ws._showDropOverlay(this, e);
    });
    this.tabsContainerEl.addEventListener('dragleave', (e) => {
      if (!this.tabsContainerEl.contains(e.relatedTarget)) ws._hideDropOverlay();
    });
    this.tabsContainerEl.addEventListener('drop', (e) => {
      const leaf = ws._draggedLeaf;
      const zone = ws._dropZone;
      ws._hideDropOverlay();
      if (!leaf || !zone) return;
      e.preventDefault();
      if (zone === 'center') ws._moveLeaf(leaf, this, this.children.length);
      else ws._splitWith(leaf, this, zone);
    });
  }

  serialize() {
    return { id: this.id, type: 'tabs', dimension: this.dimension, stacked: this.isStacked || undefined,
      currentTab: this.currentTab, children: this.children.map((c) => c.serialize()) };
  }
}

class LeafHistory {
  constructor(leaf) {
    this.leaf = leaf;
    this.backHistory = [];
    this.forwardHistory = [];
  }
  canBack() { return this.backHistory.length > 0; }
  canForward() { return this.forwardHistory.length > 0; }
  push(state) {
    this.backHistory.push(state);
    if (this.backHistory.length > 50) this.backHistory.shift();
    this.forwardHistory = [];
  }
  async back() {
    if (!this.canBack()) return;
    const prev = this.backHistory.pop();
    this.forwardHistory.push(this.leaf._currentNavState());
    await this.leaf.setViewState(prev.state, prev.eState, true);
  }
  async forward() {
    if (!this.canForward()) return;
    const next = this.forwardHistory.pop();
    this.backHistory.push(this.leaf._currentNavState());
    await this.leaf.setViewState(next.state, next.eState, true);
  }
}

export class WorkspaceLeaf extends WorkspaceItem {
  constructor(ws, id) {
    super(ws, id);
    this.view = null;
    this.pinned = false;
    this.group = null;
    this.history = new LeafHistory(this);
    this.containerEl = createDiv('workspace-leaf');
    this.tabHeaderEl = createDiv({ cls: 'workspace-tab-header', attr: { draggable: 'true' } });
    this.tabHeaderInnerEl = this.tabHeaderEl.createDiv('workspace-tab-header-inner');
    this.tabHeaderInnerIconEl = this.tabHeaderInnerEl.createDiv('workspace-tab-header-inner-icon');
    this.tabHeaderInnerTitleEl = this.tabHeaderInnerEl.createDiv('workspace-tab-header-inner-title');
    this.tabHeaderStatusContainerEl = this.tabHeaderInnerEl.createDiv('workspace-tab-header-status-container');
    this.tabHeaderCloseEl = this.tabHeaderInnerEl.createDiv({ cls: 'workspace-tab-header-inner-close-button', attr: { 'aria-label': t('tab.close') } });
    setIcon(this.tabHeaderCloseEl, 'x');
    this.tabHeaderCloseEl.addEventListener('click', (e) => { e.stopPropagation(); this.detach(); });
    this.tabHeaderEl.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); this.detach(); return; }
      if (e.button === 0) this.workspace.setActiveLeaf(this, { focus: true });
    });
    this.tabHeaderEl.addEventListener('contextmenu', (e) => this._tabMenu(e));
    this.tabHeaderEl.addEventListener('dragstart', (e) => {
      ws._draggedLeaf = this;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.getDisplayText());
      document.body.addClass('is-dragging-tab');
    });
    this.tabHeaderEl.addEventListener('dragend', () => {
      ws._draggedLeaf = null;
      ws._hideDropOverlay();
      document.body.removeClass('is-dragging-tab');
    });
    this.containerEl.addEventListener('mousedown', () => {
      if (this.workspace.activeLeaf !== this) this.workspace.setActiveLeaf(this, { focus: false });
    }, true);
    this.containerEl.addEventListener('focusin', () => {
      if (this.workspace.activeLeaf !== this) this.workspace.setActiveLeaf(this, { focus: false });
    });
  }

  get tabHeaderInnerIcon() { return this.tabHeaderInnerIconEl; }

  _tabMenu(e) {
    e.preventDefault();
    const menu = new Menu();
    const ws = this.workspace;
    menu.addItem((i) => i.setTitle(t('tab.close')).setIcon('x').setSection('close').onClick(() => this.detach()));
    menu.addItem((i) => i.setTitle(t('tab.close-others')).setSection('close')
      .onClick(() => this.parent?.children.filter((l) => l !== this && !l.pinned).forEach((l) => l.detach())));
    menu.addItem((i) => i.setTitle(t('tab.close-right')).setSection('close').onClick(() => {
      const kids = this.parent?.children || [];
      kids.slice(kids.indexOf(this) + 1).filter((l) => !l.pinned).forEach((l) => l.detach());
    }));
    menu.addItem((i) => i.setTitle(t('tab.close-all')).setSection('close')
      .onClick(() => this.parent?.children.slice().filter((l) => !l.pinned).forEach((l) => l.detach())));
    menu.addItem((i) => i.setTitle(this.pinned ? t('tab.unpin') : t('tab.pin')).setIcon('pin').setSection('action')
      .onClick(() => this.togglePinned()));
    menu.addItem((i) => i.setTitle(t('tab.split-right')).setIcon('split-right').setSection('action')
      .onClick(() => ws.duplicateLeaf(this, 'vertical')));
    menu.addItem((i) => i.setTitle(t('tab.split-down')).setIcon('split-down').setSection('action')
      .onClick(() => ws.duplicateLeaf(this, 'horizontal')));
    menu.addItem((i) => i.setTitle(t('tab.new-window')).setIcon('window').setSection('action')
      .onClick(() => ws.moveLeafToPopout(this)));
    const file = this.view instanceof FileView ? this.view.file : null;
    if (file) {
      ws.trigger('file-menu', menu, file, 'tab-header', this);
      this.app.fileMenu?.(menu, file, 'tab-header', this);
    }
    ws.trigger('leaf-menu', menu, this);
    menu.showAtMouseEvent(e);
  }

  _currentNavState() { return { state: this.getViewState(), eState: this.getEphemeralState() }; }

  getViewState() {
    if (!this.view) return { type: 'empty', state: {} };
    return { type: this.view.getViewType(), state: this.view.getState(), pinned: this.pinned || undefined,
      active: this.workspace.activeLeaf === this || undefined, group: this.group || undefined };
  }

  getEphemeralState() { return this.view?.getEphemeralState() || {}; }

  setEphemeralState(state) { this.view?.setEphemeralState(state); }

  async setViewState(viewState, eState, fromHistory) {
    if (!viewState || !viewState.type) viewState = { type: 'empty' };
    const reg = this.app.viewRegistry;
    const creator = reg.viewByType[viewState.type];
    if (!creator && viewState.type !== 'empty') {
      viewState = { type: 'empty' };
    }
    if (!fromHistory && this.view && this.view.navigation && this.view.getViewType() !== 'empty') {
      const cur = this._currentNavState();
      if (JSON.stringify(cur.state.state) !== JSON.stringify(viewState.state) || cur.state.type !== viewState.type) {
        this.history.push(cur);
      }
    }
    if (this.view && this.view.getViewType() === viewState.type && viewState.type !== 'empty') {
      await this.view.setState(viewState.state || {}, { history: !!fromHistory });
    } else {
      if (this.view) {
        const old = this.view;
        this.view = null;
        try { await old.close(); } catch (e) { console.error('view close failed', e); }
      }
      let view;
      try {
        view = viewState.type === 'empty' ? new EmptyView(this) : creator(this);
      } catch (e) {
        console.error('view creation failed', viewState.type, e);
        view = new EmptyView(this);
      }
      this.view = view;
      try {
        await view.open(this.containerEl);
        await view.setState(viewState.state || {}, { history: !!fromHistory });
      } catch (e) {
        console.error('view open failed', viewState.type, e);
      }
    }
    if (viewState.pinned !== undefined) this.setPinned(!!viewState.pinned);
    if (viewState.group) this.group = viewState.group;
    if (eState) this.setEphemeralState(eState);
    this.updateHeader();
    this.view?.updateNavButtons?.();
    if (this.workspace.activeLeaf === this) this.workspace._syncActiveEditor(this);
    this.workspace.trigger('layout-change');
    this.workspace.requestSaveLayout();
    if (viewState.active) this.workspace.setActiveLeaf(this, { focus: true });
  }

  async open(view) {
    if (this.view) await this.view.close();
    this.view = view;
    await view.open(this.containerEl);
    this.updateHeader();
    return view;
  }

  async openFile(file, openState = {}) {
    if (!(file instanceof TFile)) return;
    const type = this.app.viewRegistry.getTypeByExtension(file.extension) || 'markdown-unknown';
    const st = { type: this.app.viewRegistry.viewByType[type] ? type : 'unknown-file', state: { file: file.path, ...(openState.state || {}) },
      active: openState.active };
    await this.setViewState(st, openState.eState);
    if (openState.active !== false) this.workspace.setActiveLeaf(this, { focus: true });
  }

  getDisplayText() { return this.view ? this.view.getDisplayText() : ''; }
  getIcon() { return this.view ? this.view.getIcon() : 'file'; }

  updateHeader() {
    setIcon(this.tabHeaderInnerIconEl, this.getIcon());
    const text = this.getDisplayText();
    this.tabHeaderInnerTitleEl.setText(text);
    this.tabHeaderEl.setAttr('aria-label', text);
    this.tabHeaderEl.setAttr('data-type', this.view?.getViewType() || 'empty');
    this.tabHeaderEl.toggleClass('mod-pinned', this.pinned);
    if (this.view?.updateTitle) this.view.updateTitle();
    if (this.workspace.activeLeaf === this) this.workspace._updateTitle();
  }

  setPinned(p) {
    this.pinned = !!p;
    this.tabHeaderEl.toggleClass('mod-pinned', this.pinned);
    this.tabHeaderStatusContainerEl.empty();
    if (this.pinned) {
      const pin = this.tabHeaderStatusContainerEl.createDiv('workspace-tab-header-status-icon mod-pinned');
      setIcon(pin, 'pin');
      pin.addEventListener('click', (e) => { e.stopPropagation(); this.setPinned(false); });
    }
    this.trigger('pinned-change', this.pinned);
    this.workspace.requestSaveLayout();
  }

  togglePinned() { this.setPinned(!this.pinned); }

  setGroup(group) { this.group = group; this.trigger('group-change', group); }
  setGroupMember(other) { const g = other.group || uid(8); other.setGroup(g); this.setGroup(g); }

  getContainer() { return this.getRoot(); }

  isDeferred = false;
  async loadIfDeferred() {}

  onResize() { this.view?.onResize(); }

  async detach() {
    const ws = this.workspace;
    const parent = this.parent;
    if (this.view) {
      const v = this.view;
      this.view = null;
      try { await v.close(); } catch (e) { console.error('close view failed', e); }
    }
    this.tabHeaderEl.detach();
    if (parent) parent.removeChild(this);
    ws._closed.push(this._lastState || null);
    if (ws.activeLeaf === this) {
      ws.activeLeaf = null;
      const next = (parent && parent.children[Math.min(parent.currentTab, parent.children.length - 1)]) || ws.getMostRecentLeaf();
      if (next) ws.setActiveLeaf(next, { focus: true });
      else ws.trigger('active-leaf-change', null);
    }
    this.trigger('detach');
    ws.trigger('layout-change');
    ws.requestSaveLayout();
  }

  serialize() {
    const s = { id: this.id, type: 'leaf', state: this.getViewState() };
    delete s.state.active;
    if (this.pinned) s.pinned = true;
    if (this.group) s.group = this.group;
    return s;
  }
}

// ------------------------------------------------------------------- ribbon
export class WorkspaceRibbon {
  constructor(ws, side) {
    this.workspace = ws;
    this.side = side;
    this.containerEl = createDiv(`workspace-ribbon side-dock-ribbon mod-${side}`);
    this.actionsEl = this.containerEl.createDiv('side-dock-actions');
    this.settingsEl = this.containerEl.createDiv('side-dock-settings');
    this.items = [];
    this.hidden = new Set();
    this.order = [];
    this.containerEl.addEventListener('contextmenu', (e) => this._menu(e));
  }

  addRibbonItemButton(id, icon, title, callback) {
    const el = createDiv({ cls: 'clickable-icon side-dock-ribbon-action', attr: { 'aria-label': title, 'data-tooltip-position': 'right', draggable: 'true' } });
    setIcon(el, icon);
    el.addEventListener('click', (e) => callback(e));
    const item = { id, icon, title, el, callback };
    this.items.push(item);
    el.addEventListener('dragstart', (e) => { this._dragging = item; e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragover', (e) => { if (this._dragging) e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      if (!this._dragging || this._dragging === item) return;
      e.preventDefault();
      const ids = this.items.map((x) => x.id);
      ids.remove(this._dragging.id);
      ids.splice(ids.indexOf(id), 0, this._dragging.id);
      this.order = ids;
      this._render();
      this.workspace.requestSaveLayout();
      this._dragging = null;
    });
    this._render();
    return el;
  }

  removeItem(el) {
    const i = this.items.findIndex((x) => x.el === el);
    if (i !== -1) this.items.splice(i, 1);
    el.detach();
  }

  _render() {
    const rank = (id) => { const i = this.order.indexOf(id); return i === -1 ? 1e6 : i; };
    const sorted = this.items.slice().sort((a, b) => rank(a.id) - rank(b.id));
    this.actionsEl.empty();
    for (const it of sorted) if (!this.hidden.has(it.id)) this.actionsEl.appendChild(it.el);
  }

  _menu(e) {
    e.preventDefault();
    const menu = new Menu();
    for (const it of this.items) {
      menu.addItem((m) => m.setTitle(it.title).setIcon(it.icon).setChecked(!this.hidden.has(it.id)).onClick(() => {
        if (this.hidden.has(it.id)) this.hidden.delete(it.id); else this.hidden.add(it.id);
        this._render();
        this.workspace.requestSaveLayout();
      }));
    }
    menu.addSeparator();
    menu.addItem((m) => m.setTitle(t('ribbon.hide')).setIcon('eye-off').onClick(() => this.workspace.app.setAppearance({ showRibbon: false })));
    menu.showAtMouseEvent(e);
  }

  serialize() { return { hiddenItems: Object.fromEntries([...this.hidden].map((x) => [x, true])), order: this.order }; }
}

// ------------------------------------------------------------------- workspace
export class Workspace extends Events {
  constructor(app) {
    super();
    this.app = app;
    this.containerEl = createDiv('workspace');
    this.leftRibbon = new WorkspaceRibbon(this, 'left');
    this.rightRibbon = new WorkspaceRibbon(this, 'right');
    this.leftSplit = new WorkspaceSidedock(this, 'left');
    this.rightSplit = new WorkspaceSidedock(this, 'right');
    this.rootSplit = new WorkspaceRoot(this);
    this.activeLeaf = null;
    this.activeEditor = null;
    this.layoutReady = false;
    this._layoutReadyCbs = [];
    this._recentLeaves = [];
    this._closed = [];
    this.lastOpenFiles = [];
    this.containerEl.append(this.leftRibbon.containerEl, this.leftSplit.containerEl, this.leftSplit.resizeHandle,
      this.rootSplit.containerEl, this.rightSplit.resizeHandle, this.rightSplit.containerEl);
    this.dropOverlay = createDiv('workspace-drop-overlay');
    this.requestSaveLayout = debounce(() => this.saveLayout(), 800, true);
    this.onLayoutResize = debounce(() => {
      this.iterateAllLeaves((l) => l.onResize());
      this.trigger('resize');
    }, 50, true);
    window.addEventListener('resize', () => this.onLayoutResize());
    // sidebar toggles live in the tab header rows
    this.leftToggleEl = createDiv({ cls: 'sidebar-toggle-button mod-left clickable-icon', attr: { 'aria-label': t('sidebar.toggle-left') } });
    setIcon(this.leftToggleEl, 'sidebar-left');
    this.leftToggleEl.addEventListener('click', () => this.leftSplit.toggle());
    this.rightToggleEl = createDiv({ cls: 'sidebar-toggle-button mod-right clickable-icon', attr: { 'aria-label': t('sidebar.toggle-right') } });
    setIcon(this.rightToggleEl, 'sidebar-right');
    this.rightToggleEl.addEventListener('click', () => this.rightSplit.toggle());
  }

  get leftSidebar() { return this.leftSplit; }
  get rightSidebar() { return this.rightSplit; }

  _updateToggles() {
    // left toggle: in the left sidebar header when open, else in the first root header
    const firstRootTabs = this._firstTabs(this.rootSplit);
    const lastRootTabs = this._lastTabs(this.rootSplit);
    const leftTabs = this._firstTabs(this.leftSplit);
    const rightTabs = this._firstTabs(this.rightSplit);
    if (!this.leftSplit.collapsed && leftTabs) leftTabs.tabHeaderContainerEl.appendChild(this.leftToggleEl);
    else if (firstRootTabs) firstRootTabs.tabHeaderContainerEl.insertBefore(this.leftToggleEl, firstRootTabs.tabHeaderContainerEl.firstChild);
    if (!this.rightSplit.collapsed && rightTabs) rightTabs.tabHeaderContainerEl.insertBefore(this.rightToggleEl, rightTabs.tabHeaderContainerEl.firstChild);
    else if (lastRootTabs) lastRootTabs.tabHeaderContainerEl.appendChild(this.rightToggleEl);
    for (const t2 of this._allTabs()) t2.containerEl.toggleClass('mod-top-left-space', t2 === firstRootTabs && this.leftSplit.collapsed);
  }

  _firstTabs(item) {
    if (item instanceof WorkspaceTabs) return item;
    for (const c of item.children || []) { const x = this._firstTabs(c); if (x) return x; }
    return null;
  }

  _lastTabs(item) {
    if (item instanceof WorkspaceTabs) return item;
    const kids = item.children || [];
    // for vertical splits the rightmost column, for horizontal the top row
    const order = item.direction === 'horizontal' ? kids : kids.slice().reverse();
    for (const c of order) { const x = this._lastTabs(c); if (x) return x; }
    return null;
  }

  _allTabs() {
    const out = [];
    const walk = (x) => { if (x instanceof WorkspaceTabs) out.push(x); for (const c of x.children || []) walk(c); };
    walk(this.rootSplit); walk(this.leftSplit); walk(this.rightSplit);
    return out;
  }

  // ---------------------------------------------------------------- iteration
  iterateLeaves(root, cb) {
    const walk = (x) => {
      if (x instanceof WorkspaceLeaf) return cb(x) === true;
      for (const c of (x.children || []).slice()) if (walk(c)) return true;
      return false;
    };
    if (typeof root === 'function') { [cb, root] = [root, cb]; }
    walk(root);
  }

  iterateAllLeaves(cb) {
    this.iterateLeaves(this.rootSplit, cb);
    this.iterateLeaves(this.leftSplit, cb);
    this.iterateLeaves(this.rightSplit, cb);
    for (const w of this.floatingSplit?.children || []) this.iterateLeaves(w, cb);
  }

  iterateRootLeaves(cb) { this.iterateLeaves(this.rootSplit, cb); }

  getLeavesOfType(type) {
    const out = [];
    this.iterateAllLeaves((l) => { if (l.view?.getViewType() === type) out.push(l); });
    return out;
  }

  getLeafById(id) {
    let found = null;
    this.iterateAllLeaves((l) => { if (l.id === id) { found = l; return true; } return false; });
    return found;
  }

  getActiveViewOfType(type) {
    const v = this.activeLeaf?.view;
    return v instanceof type ? v : null;
  }

  getActiveFile() {
    const v = this.activeLeaf?.view;
    if (v instanceof FileView && v.file) return v.file;
    const recent = this.getMostRecentLeaf();
    return recent?.view instanceof FileView ? recent.view.file : null;
  }

  getMostRecentLeaf(root = this.rootSplit) {
    for (const l of this._recentLeaves) if (l.getRoot() === root && l.parent) return l;
    let first = null;
    this.iterateLeaves(root, (l) => { first = l; return true; });
    return first;
  }

  getGroupLeaves(group) {
    const out = [];
    this.iterateAllLeaves((l) => { if (l.group === group) out.push(l); });
    return out;
  }

  getLastOpenFiles() { return this.lastOpenFiles.slice(0, 10); }

  // ---------------------------------------------------------------- leaves
  _activeTabsInRoot() {
    const l = this.activeLeaf && this.activeLeaf.getRoot() === this.rootSplit ? this.activeLeaf : this.getMostRecentLeaf();
    return l?.parent instanceof WorkspaceTabs ? l.parent : this._firstTabs(this.rootSplit);
  }

  createLeafInParent(parent, index) {
    const leaf = new WorkspaceLeaf(this);
    parent.insertChild(index ?? -1, leaf);
    return leaf;
  }

  createLeafBySplit(leaf, direction = 'vertical', before = false) {
    const tabs = leaf?.parent instanceof WorkspaceTabs ? leaf.parent : this._activeTabsInRoot();
    const newTabs = new WorkspaceTabs(this);
    const newLeaf = new WorkspaceLeaf(this);
    newTabs.insertChild(0, newLeaf);
    this._insertBeside(tabs, newTabs, direction, before);
    return newLeaf;
  }

  _insertBeside(target, item, direction, before) {
    const parent = target.parent;
    if (parent instanceof WorkspaceSplit && parent.direction === direction) {
      const i = parent.children.indexOf(target);
      const half = (target.dimension ?? 100) / 2;
      target.setDimension(half);
      item.setDimension(half);
      parent.insertChild(before ? i : i + 1, item);
    } else {
      const split = new WorkspaceSplit(this, direction);
      const i = parent.children.indexOf(target);
      split.setDimension(target.dimension);
      parent.replaceChild(i, split);
      target.setDimension(50);
      item.setDimension(50);
      split.insertChild(0, target);
      split.insertChild(before ? 0 : 1, item);
    }
    this._updateToggles();
    this.trigger('layout-change');
    this.requestSaveLayout();
  }

  splitActiveLeaf(direction = 'vertical') {
    return this.createLeafBySplit(this.activeLeaf || this.getMostRecentLeaf(), direction);
  }

  async duplicateLeaf(leaf, direction) {
    const target = direction === 'tab' || direction === true ? this.getLeaf('tab') : this.createLeafBySplit(leaf, direction || 'vertical');
    await target.setViewState({ ...leaf.getViewState(), active: true }, leaf.getEphemeralState());
    return target;
  }

  getUnpinnedLeaf() { return this.getLeaf(false); }

  /** false/undefined: reuse the active tab unless pinned; true/'tab': new tab; 'split'; 'window'. */
  getLeaf(newLeaf, direction) {
    if (newLeaf === 'split') return this.createLeafBySplit(this.activeLeaf?.getRoot() === this.rootSplit ? this.activeLeaf : this.getMostRecentLeaf(), direction);
    if (newLeaf === 'window') return this.openPopoutLeaf();
    if (newLeaf === true || newLeaf === 'tab') {
      const tabs = this._activeTabsInRoot();
      const cur = tabs.children[tabs.currentTab];
      const leaf = new WorkspaceLeaf(this);
      tabs.insertChild(cur ? tabs.children.indexOf(cur) + 1 : -1, leaf);
      return leaf;
    }
    let leaf = this.activeLeaf && this.activeLeaf.getRoot() === this.rootSplit ? this.activeLeaf : this.getMostRecentLeaf();
    if (!leaf || leaf.pinned) return this.getLeaf('tab');
    return leaf;
  }

  getLeftLeaf(split) { return this._sideLeaf(this.leftSplit, split); }
  getRightLeaf(split) { return this._sideLeaf(this.rightSplit, split); }

  _sideLeaf(dock, split) {
    let tabs = this._firstTabs(dock);
    if (!tabs || split) {
      tabs = new WorkspaceTabs(this);
      dock.insertChild(-1, tabs);
      this._updateToggles();
    }
    const leaf = new WorkspaceLeaf(this);
    tabs.insertChild(-1, leaf);
    return leaf;
  }

  async ensureSideLeaf(type, side, opts = {}) {
    const existing = this.getLeavesOfType(type)[0];
    if (existing) {
      if (opts.reveal) this.revealLeaf(existing);
      return existing;
    }
    const leaf = side === 'left' ? this.getLeftLeaf(opts.split) : this.getRightLeaf(opts.split);
    await leaf.setViewState({ type, state: opts.state || {}, active: !!opts.active });
    if (opts.reveal) this.revealLeaf(leaf);
    return leaf;
  }

  async revealLeaf(leaf) {
    const root = leaf.getRoot();
    if (root instanceof WorkspaceSidedock && root.collapsed) root.expand();
    if (leaf.parent instanceof WorkspaceTabs) leaf.parent.selectTab(leaf);
  }

  setActiveLeaf(leaf, params = {}) {
    if (typeof params === 'boolean') params = { focus: params };
    if (!leaf || !leaf.parent) return;
    if (leaf.parent instanceof WorkspaceTabs) leaf.parent.selectTab(leaf);
    const changed = this.activeLeaf !== leaf;
    if (changed) {
      this.activeLeaf?.containerEl.removeClass('mod-active');
      this.activeLeaf?.tabHeaderEl.removeClass('mod-active');
      this.activeLeaf = leaf;
      leaf.containerEl.addClass('mod-active');
      leaf.tabHeaderEl.addClass('mod-active');
      this._recentLeaves = [leaf, ...this._recentLeaves.filter((l) => l !== leaf)].slice(0, 30);
      this._syncActiveEditor(leaf);
      this.trigger('active-leaf-change', leaf);
      const file = leaf.view instanceof FileView ? leaf.view.file : null;
      if (leaf.getRoot() === this.rootSplit) this.trigger('file-open', file);
      this._updateTitle();
      this.requestSaveLayout();
    }
    else this._syncActiveEditor(leaf); // same leaf, but it may show a new view now
    if (params.focus) leaf.view?.focus?.();
  }

  /** The editor of the active leaf; a sidebar leaf keeps the last main-area editor. */
  _syncActiveEditor(leaf) {
    const v = leaf.view;
    if (v?.editor || v?.getViewType?.() === 'markdown') this.activeEditor = v;
    else if (leaf.getRoot() === this.rootSplit) this.activeEditor = null;
  }

  _updateTitle() {
    const leaf = this.activeLeaf;
    const vault = this.app.vault.getName();
    const text = leaf && leaf.getRoot() === this.rootSplit ? leaf.getDisplayText() : '';
    const title = text ? `${text} – ${vault} – sk_notes` : `${vault} – sk_notes`;
    if (document.title !== title) {
      document.title = title;
      this.app.api('window.setTitle', { title }).catch(() => {});
    }
  }

  _fileOpened(leaf, file) {
    if (!file) return;
    this.lastOpenFiles = [file.path, ...this.lastOpenFiles.filter((p) => p !== file.path)].slice(0, 50);
    if (this.activeLeaf === leaf) {
      this.trigger('file-open', file);
      this._updateTitle();
    }
    this.requestSaveLayout();
  }

  detachLeavesOfType(type) {
    for (const l of this.getLeavesOfType(type)) l.detach();
  }

  async moveLeafToPopout(leaf) {
    const state = leaf.getViewState();
    await this.app.api('window.popout', { state: JSON.stringify(state) });
    leaf.detach();
  }

  openPopoutLeaf() {
    // pop-out windows run a separate workspace; open a new tab here and move it
    const leaf = this.getLeaf('tab');
    setTimeout(() => this.moveLeafToPopout(leaf), 300);
    return leaf;
  }

  // ---------------------------------------------------------------- links
  async openLinkText(linktext, sourcePath = '', newLeaf = false, openViewState = {}) {
    const { path, subpath } = parseLinktext(linktext);
    let file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!file && path) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(path)) { this.app.openExternal(linktext); return; }
      // create the note (in the configured folder for new notes)
      file = await this.app.fileManager.createNewMarkdownFileFromLinktext(path, sourcePath);
    }
    if (!file) return;
    const leaf = this.getLeaf(newLeaf);
    await leaf.openFile(file, { ...openViewState, eState: { ...(openViewState.eState || {}), subpath } });
  }

  /** Called with a link click event: picks the target leaf from the modifier keys. */
  async openLinkFromEvent(linktext, sourcePath, evt) {
    const mode = Keymap.isModEvent(evt);
    await this.openLinkText(linktext, sourcePath, mode);
  }

  async openFile(file, newLeaf) {
    const leaf = this.getLeaf(newLeaf);
    await leaf.openFile(file);
    return leaf;
  }

  // ---------------------------------------------------------------- drag & drop
  _moveLeaf(leaf, tabs, index) {
    if (leaf.parent === tabs && tabs.children.indexOf(leaf) === index) return;
    const oldParent = leaf.parent;
    tabs.insertChild(index, leaf);
    if (oldParent && !oldParent.children.length) oldParent._onEmpty();
    this.setActiveLeaf(leaf, { focus: true });
    this._updateToggles();
    this.trigger('layout-change');
    this.requestSaveLayout();
  }

  _splitWith(leaf, tabs, zone) {
    const oldParent = leaf.parent;
    if (oldParent === tabs && tabs.children.length === 1) return;
    const newTabs = new WorkspaceTabs(this);
    newTabs.insertChild(0, leaf);
    if (oldParent && !oldParent.children.length) oldParent._onEmpty();
    const dir = zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal';
    this._insertBeside(tabs, newTabs, dir, zone === 'left' || zone === 'top');
    this.setActiveLeaf(leaf, { focus: true });
  }

  _showDropOverlay(tabs, e) {
    const r = tabs.tabsContainerEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    let zone = 'center';
    if (x < 0.25) zone = 'left'; else if (x > 0.75) zone = 'right'; else if (y < 0.25) zone = 'top'; else if (y > 0.75) zone = 'bottom';
    this._dropZone = zone;
    const o = this.dropOverlay;
    document.body.appendChild(o);
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (zone === 'left') rect.width /= 2;
    if (zone === 'right') { rect.left += r.width / 2; rect.width /= 2; }
    if (zone === 'top') rect.height /= 2;
    if (zone === 'bottom') { rect.top += r.height / 2; rect.height /= 2; }
    Object.assign(o.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }

  _hideDropOverlay() {
    this._dropZone = null;
    this.dropOverlay.detach();
  }

  // ---------------------------------------------------------------- layout persistence
  getLayout() {
    return {
      main: this.rootSplit.serialize(),
      left: this.leftSplit.serialize(),
      right: this.rightSplit.serialize(),
      'left-ribbon': this.leftRibbon.serialize(),
      active: this.activeLeaf?.id,
      lastOpenFiles: this.lastOpenFiles.slice(0, 50),
    };
  }

  async saveLayout() {
    if (!this.layoutReady || this.app.isPopout) return;
    try { await this.app.config.write('workspace.json', this.getLayout()); } catch (e) { console.error(e); }
  }

  async changeLayout(layout) {
    // remove everything
    for (const dock of [this.rootSplit, this.leftSplit, this.rightSplit]) {
      const leaves = [];
      this.iterateLeaves(dock, (l) => { leaves.push(l); });
      for (const l of leaves) { if (l.view) await l.view.close().catch(() => {}); l.view = null; }
      dock.children = [];
      dock.containerEl.empty();
    }
    this.activeLeaf = null;
    this._recentLeaves = [];
    const build = (data, parentItem) => {
      if (!data) return null;
      if (data.type === 'leaf') {
        const leaf = new WorkspaceLeaf(this, data.id);
        parentItem.insertChild(-1, leaf);
        if (data.pinned) leaf.pinned = true;
        if (data.group) leaf.group = data.group;
        leaf._pending = data.state;
        return leaf;
      }
      if (data.type === 'tabs') {
        const tabs = new WorkspaceTabs(this, data.id);
        tabs.setDimension(data.dimension);
        parentItem.insertChild(-1, tabs);
        for (const c of data.children || []) build(c, tabs);
        tabs.currentTab = data.currentTab || 0;
        if (data.stacked) tabs.setStacked(true);
        if (!tabs.children.length) parentItem.removeChild(tabs);
        else tabs._render();
        return tabs;
      }
      if (data.type === 'split') {
        const split = new WorkspaceSplit(this, data.direction, data.id);
        split.setDimension(data.dimension);
        parentItem.insertChild(-1, split);
        for (const c of data.children || []) {
          if (c.type === 'leaf') {
            const tabs = new WorkspaceTabs(this);
            split.insertChild(-1, tabs);
            build(c, tabs);
          } else build(c, split);
        }
        if (!split.children.length) parentItem.removeChild(split);
        return split;
      }
      return null;
    };
    for (const [key, dock] of [['main', this.rootSplit], ['left', this.leftSplit], ['right', this.rightSplit]]) {
      const data = layout?.[key];
      if (!data) continue;
      for (const c of data.children || []) {
        if (c.type === 'leaf') {
          const tabs = new WorkspaceTabs(this);
          dock.insertChild(-1, tabs);
          build(c, tabs);
        } else build(c, dock);
      }
      if (dock instanceof WorkspaceSidedock) {
        if (data.width) dock.setSize(data.width);
        dock.setCollapsed(!!data.collapsed);
      } else if (data.direction) {
        dock.direction = data.direction;
        dock._setDirClass();
      }
    }
    if (!this._firstTabs(this.rootSplit)) {
      const tabs = new WorkspaceTabs(this);
      this.rootSplit.insertChild(0, tabs);
      const leaf = new WorkspaceLeaf(this);
      tabs.insertChild(0, leaf);
      leaf._pending = { type: 'empty' };
    }
    const ribbon = layout?.['left-ribbon'];
    if (ribbon) {
      this.leftRibbon.hidden = new Set(Object.keys(ribbon.hiddenItems || {}).filter((k) => ribbon.hiddenItems[k]));
      this.leftRibbon.order = ribbon.order || [];
      this.leftRibbon._render();
    }
    this.lastOpenFiles = (layout?.lastOpenFiles || []).filter((p) => this.app.vault.getAbstractFileByPath(p));
    // instantiate views
    const all = [];
    this.iterateAllLeaves((l) => all.push(l));
    for (const l of all) {
      const st = l._pending || { type: 'empty' };
      delete l._pending;
      await l.setViewState(st);
    }
    const active = (layout?.active && this.getLeafById(layout.active)) || this.getMostRecentLeaf();
    if (active) this.setActiveLeaf(active, { focus: true });
    this._updateToggles();
    this.trigger('layout-change');
  }

  onLayoutReady(cb) {
    if (this.layoutReady) setTimeout(cb, 0);
    else this._layoutReadyCbs.push(cb);
  }

  _setLayoutReady() {
    this.layoutReady = true;
    for (const cb of this._layoutReadyCbs.splice(0)) {
      try { cb(); } catch (e) { console.error('onLayoutReady callback failed', e); }
    }
    this.trigger('layout-ready');
  }

  // ---------------------------------------------------------------- vault events → views
  _onFileRenamed(file, oldPath) {
    this.lastOpenFiles = this.lastOpenFiles.map((p) => (p === oldPath ? file.path : p.startsWith(oldPath + '/') ? file.path + p.slice(oldPath.length) : p));
    this.iterateAllLeaves((l) => {
      const v = l.view;
      if (v instanceof FileView && v.file && (v.file === file || v.file.path.startsWith(file.path + '/'))) v.onRename(v.file);
    });
    this.requestSaveLayout();
  }

  _onFileDeleted(file) {
    this.lastOpenFiles = this.lastOpenFiles.filter((p) => p !== file.path && !p.startsWith(file.path + '/'));
    this.iterateAllLeaves((l) => {
      const v = l.view;
      if (v instanceof FileView && v.file && v.file.deleted) {
        if (l.getRoot() === this.rootSplit) l.setViewState({ type: 'empty' });
        else v.file = null;
      }
    });
  }

  _onFileModified(file, except) {
    this.iterateAllLeaves((l) => {
      const v = l.view;
      if (v instanceof TextFileView && v !== except && v.file === file && !v._saving) v.onExternalModify(file);
    });
  }

  reopenClosed() {
    // the last closed leaf state is not kept in detail; reopen the last file
    const path = this.lastOpenFiles.find((p) => {
      let open = false;
      this.iterateRootLeaves((l) => { if (l.view?.file?.path === p) open = true; });
      return !open;
    });
    const f = path && this.app.vault.getFileByPath(path);
    if (f) this.openFile(f, 'tab');
  }

  updateOptions() { this.trigger('options-change'); }

  // page preview sources registered by plugins (display info only)
  registerHoverLinkSource(id, info) { (this.hoverLinkSources ||= {})[id] = info; }
  unregisterHoverLinkSource(id) { if (this.hoverLinkSources) delete this.hoverLinkSources[id]; }
}
