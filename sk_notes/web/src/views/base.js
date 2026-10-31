// View base classes.

import { Component } from '../model/component.js';
import { Scope } from '../model/keymap.js';
import { TFile } from '../model/vault.js';
import { setIcon } from '../core/icons.js';
import { setTooltip, Menu } from '../ui/kit.js';
import { t } from '../core/i18n.js';
import { debounce } from '../core/util.js';

export class View extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.icon = 'file';
    this.navigation = false;
    this.scope = null;
    this.containerEl = createDiv({ cls: 'workspace-leaf-content' });
  }

  getViewType() { return 'unknown'; }
  getDisplayText() { return ''; }
  getIcon() { return this.icon; }
  getState() { return {}; }
  async setState(state, result) {}
  getEphemeralState() { return {}; }
  setEphemeralState(state) {}
  async onOpen() {}
  async onClose() {}
  onResize() {}
  onPaneMenu(menu, source) {}
  onHeaderMenu(menu) {}
  async open(parentEl) {
    this.containerEl.setAttr('data-type', this.getViewType());
    parentEl.appendChild(this.containerEl);
    this.load();
    await this.onOpen();
  }
  async close() {
    await this.onClose();
    this.unload();
    this.containerEl.detach();
  }
}

export class ItemView extends View {
  constructor(leaf) {
    super(leaf);
    this.headerEl = this.containerEl.createDiv('view-header');
    this.leftEl = this.headerEl.createDiv('view-header-left');
    this.navButtonsEl = this.leftEl.createDiv('view-header-nav-buttons');
    this.backButtonEl = this.navButtonsEl.createEl('button', { cls: 'clickable-icon' });
    this.forwardButtonEl = this.navButtonsEl.createEl('button', { cls: 'clickable-icon' });
    setIcon(this.backButtonEl, 'arrow-left');
    setIcon(this.forwardButtonEl, 'arrow-right');
    setTooltip(this.backButtonEl, t('view.back'));
    setTooltip(this.forwardButtonEl, t('view.forward'));
    this.backButtonEl.addEventListener('click', () => this.leaf.history.back());
    this.forwardButtonEl.addEventListener('click', () => this.leaf.history.forward());
    this.titleContainerEl = this.headerEl.createDiv('view-header-title-container');
    this.titleParentEl = this.titleContainerEl.createDiv('view-header-title-parent');
    this.titleEl = this.titleContainerEl.createDiv('view-header-title');
    this.actionsEl = this.headerEl.createDiv('view-actions');
    this.moreOptionsButton = this.actionsEl.createEl('button', { cls: 'clickable-icon view-action mod-more' });
    setIcon(this.moreOptionsButton, 'more-horizontal');
    setTooltip(this.moreOptionsButton, t('view.more-options'));
    this.moreOptionsButton.addEventListener('click', (e) => {
      const menu = new Menu();
      this.onPaneMenu(menu, 'more-options');
      this.app.workspace.trigger('leaf-menu', menu, this.leaf);
      const r = this.moreOptionsButton.getBoundingClientRect();
      menu.showAtPosition({ x: r.right, y: r.bottom + 4, left: true });
    });
    this.contentEl = this.containerEl.createDiv('view-content');
  }

  addAction(icon, title, callback) {
    const el = createEl('button', { cls: 'clickable-icon view-action' });
    setIcon(el, icon);
    setTooltip(el, title);
    el.addEventListener('click', callback);
    this.actionsEl.insertBefore(el, this.moreOptionsButton);
    return el;
  }

  updateNavButtons() {
    const h = this.leaf.history;
    this.backButtonEl.toggleClass('is-disabled', !h.canBack());
    this.forwardButtonEl.toggleClass('is-disabled', !h.canForward());
  }

  updateTitle() {
    this.titleEl.setText(this.getDisplayText());
    this.titleParentEl.empty();
    this.navButtonsEl.toggle(this.navigation);
    this.updateNavButtons();
  }

  onPaneMenu(menu, source) {
    menu.addItem((i) => i.setTitle(t('tab.split-right')).setIcon('split-right').setSection('pane')
      .onClick(() => this.app.workspace.duplicateLeaf(this.leaf, 'vertical')));
    menu.addItem((i) => i.setTitle(t('tab.split-down')).setIcon('split-down').setSection('pane')
      .onClick(() => this.app.workspace.duplicateLeaf(this.leaf, 'horizontal')));
    menu.addItem((i) => i.setTitle(t('tab.close')).setIcon('x').setSection('close').onClick(() => this.leaf.detach()));
  }
}

export class FileView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.file = null;
    this.allowNoFile = false;
    this.navigation = true;
  }

  getDisplayText() { return this.file ? this.file.basename : t('view.no-file'); }
  canAcceptExtension(ext) { return false; }
  getState() { return { file: this.file?.path ?? null }; }

  async setState(state, result) {
    if (state && typeof state.file === 'string') {
      const f = this.app.vault.getAbstractFileByPath(state.file);
      if (f instanceof TFile && f !== this.file) await this.loadFile(f);
    }
  }

  async loadFile(file) {
    if (this.file) await this.onUnloadFile(this.file);
    this.file = file;
    this.updateTitle();
    await this.onLoadFile(file);
    this.leaf.updateHeader();
    this.app.workspace._fileOpened(this.leaf, file);
  }

  async onLoadFile(file) {}
  async onUnloadFile(file) {}
  async onRename(file) { this.updateTitle(); this.leaf.updateHeader(); }

  updateTitle() {
    super.updateTitle();
    if (!this.file) return;
    const parent = this.file.parent && this.file.parent.path !== '/' ? this.file.parent.path : '';
    this.titleParentEl.empty();
    if (parent) {
      for (const part of parent.split('/')) {
        this.titleParentEl.createSpan({ cls: 'view-header-breadcrumb', text: part });
        this.titleParentEl.createSpan({ cls: 'view-header-breadcrumb-separator', text: '/' });
      }
    }
  }

  async onClose() {
    if (this.file) await this.onUnloadFile(this.file);
  }
}

export class EditableFileView extends FileView {}

export class TextFileView extends EditableFileView {
  constructor(leaf) {
    super(leaf);
    this.data = '';
    this.lastSavedData = null;
    this.dirty = false;
    this._saving = null;
    this.requestSave = debounce(() => this.save(), 1000, true);
  }

  async onLoadFile(file) {
    const text = await this.app.vault.read(file);
    this._mtime = file.stat.mtime;
    this.data = text;
    this.lastSavedData = text;
    this.setViewData(text, true);
  }

  async onUnloadFile(file) {
    await this.save();
    this.clear();
  }

  async save(clear) {
    if (!this.file) return;
    const data = this.getViewData();
    if (data === this.lastSavedData) return;
    this.data = data;
    const file = this.file;
    const prev = this._saving;
    this._saving = (async () => {
      await prev;
      try {
        await this.app.vault.modify(file, data);
        this.lastSavedData = data;
        this.dirty = false;
      } catch (e) {
        console.error('save failed', e);
        this.app.notice(t('notice.save-failed', { name: file.basename, error: e.code || e.message }));
      }
    })();
    await this._saving;
    if (clear) this.clear();
  }

  getViewData() { return this.data; }
  setViewData(data, clear) { this.data = data; }
  clear() {}

  /** External change on disk: reload unless the user has unsaved edits. */
  async onExternalModify(file) {
    if (file !== this.file) return;
    const text = await this.app.vault.read(file);
    const current = this.getViewData();
    if (text === current) { this.lastSavedData = text; return; }
    if (current === this.lastSavedData) {
      this.lastSavedData = text;
      this.data = text;
      this.setViewData(text, false);
    } else {
      this.app.notice(t('notice.external-change', { name: file.basename }));
    }
  }
}

export class EmptyView extends ItemView {
  getViewType() { return 'empty'; }
  getDisplayText() { return t('view.new-tab'); }
  getIcon() { return 'file'; }
  async onOpen() {
    this.navigation = true;
    this.updateTitle();
    const box = this.contentEl.createDiv('empty-state');
    const inner = box.createDiv('empty-state-container');
    inner.createDiv({ cls: 'empty-state-title', text: t('empty.title') });
    const actions = inner.createDiv('empty-state-action-list');
    const add = (label, hk, fn) => {
      const a = actions.createDiv({ cls: 'empty-state-action', text: label });
      if (hk) a.createSpan({ cls: 'empty-state-hotkey', text: hk });
      a.addEventListener('click', fn);
    };
    add(t('empty.new-note'), 'Ctrl+N', () => this.app.commands.executeCommandById('file:new'));
    add(t('empty.go-to-file'), 'Ctrl+O', () => this.app.commands.executeCommandById('switcher:open'));
    add(t('empty.recent'), '', () => this.app.commands.executeCommandById('switcher:recent'));
    add(t('empty.close'), 'Ctrl+W', () => this.leaf.detach());
  }
}
