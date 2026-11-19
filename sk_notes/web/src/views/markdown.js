// Markdown note view: editing (Live Preview / Source) and Reading mode.

import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { setIcon } from '../core/icons.js';
import { t, errorText } from '../core/i18n.js';
import { debounce, wordCount } from '../core/util.js';
import { Component } from '../model/component.js';
import { Keymap } from '../model/keymap.js';
import { resolveSubpath } from '../model/metadata.js';
import { postProcess, renderSections } from '../render/markdown.js';
import { Menu, setTooltip } from '../ui/kit.js';
import { TextFileView } from './base.js';
import { createEditor, Editor } from '../editor/editor.js';

class MarkdownPreviewView extends Component {
  constructor(view, containerEl) {
    super();
    this.view = view;
    this.app = view.app;
    this.containerEl = containerEl;
    this.containerEl.addClass('markdown-reading-view');
    this.previewEl = containerEl.createDiv('markdown-preview-view markdown-rendered');
    this.sizerEl = this.previewEl.createDiv('markdown-preview-sizer markdown-preview-section');
    this.renderer = this;
    this._renderComp = null;
    this._version = 0;
  }

  get file() { return this.view.file; }

  async set(text, clear) {
    this.text = text;
    if (this.containerEl.isShown() || clear) await this.rerender(true);
  }

  async rerender(full) {
    const version = ++this._version;
    const scroll = this.previewEl.scrollTop;
    this._renderComp?.unload();
    this._renderComp = new Component();
    this.addChild(this._renderComp);
    const frag = createDiv('markdown-preview-sizer markdown-preview-section');
    const file = this.view.file;
    if (file && this.app.settings.get('showInlineTitle') !== false) frag.createDiv({ cls: 'inline-title', text: file.basename });
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    if (fm && Object.keys(fm).length && this.app.settings.get('propertiesInDocument') !== 'hidden') {
      const box = frag.createDiv('metadata-container mod-reading');
      this.app.renderPropertiesReadOnly?.(box, fm, file);
    }
    const secs = renderSections(this.app, this.text || '', frag, file?.path || '', this._renderComp);
    await postProcess(this.app, secs, file?.path || '', this._renderComp, fm, this.text || '');
    if (version !== this._version) return;
    this.sizerEl.replaceWith(frag);
    this.sizerEl = frag;
    this.previewEl.scrollTop = scroll;
    this.view.app.workspace.trigger('markdown-preview-rendered', this.view);
  }

  getScroll() { return this.previewEl.scrollTop; }
  applyScroll(top) { this.previewEl.scrollTop = top; }

  scrollToLine(line, highlight) {
    const els = this.sizerEl.findAll('[data-sk-line]');
    let target = null;
    for (const el of els) { if (Number(el.getAttr('data-sk-line')) <= line) target = el; else break; }
    if (target) {
      const pr = this.previewEl.getBoundingClientRect();
      this.previewEl.scrollTop += target.getBoundingClientRect().top - pr.top - 10;
      if (highlight) { target.addClass('is-flashing'); setTimeout(() => target.removeClass('is-flashing'), 1500); }
    }
  }
}

export class MarkdownView extends TextFileView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'file-text';
    this.contentEl.addClass('markdown-view-content');
    this.sourceEl = this.contentEl.createDiv('markdown-source-view mod-cm6');
    this.sourceEl.toggleClass('is-readable-line-width', this.app.settings.get('readableLineLength') !== false);
    this.previewContainerEl = this.contentEl.createDiv();
    this.previewMode = new MarkdownPreviewView(this, this.previewContainerEl);
    this.addChild(this.previewMode);
    this.mode = this.app.settings.get('defaultViewMode') === 'preview' ? 'preview' : 'source';
    this.sourceMode = this.app.settings.get('livePreview') === false; // true = Source mode, false = Live Preview
    this.inlineTitleEl = createDiv({ cls: 'inline-title', attr: { contenteditable: 'true', spellcheck: 'false', tabindex: '-1' } });
    this._buildEditor();
    this.modeButtonEl = this.addAction('reading-mode', t('view.toggle-mode'), (e) => {
      if (Keymap.isModEvent(e)) this.app.workspace.duplicateLeaf(this.leaf, 'vertical').then((l) => l.view.setMode?.(this.mode === 'source' ? 'preview' : 'source'));
      else this.toggleMode();
    });
    this._applyMode();
    this._onTitleKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.editor.focus(); }
      if (e.key === 'Escape') { this.inlineTitleEl.setText(this.file?.basename || ''); this.editor.focus(); }
    };
    this.inlineTitleEl.addEventListener('keydown', this._onTitleKey);
    this.inlineTitleEl.addEventListener('blur', () => this._commitTitle());
    this.previewContainerEl.addEventListener('click', (e) => this._previewClick(e));
    this.previewContainerEl.addEventListener('auxclick', (e) => this._previewClick(e));
    this.previewContainerEl.addEventListener('mouseover', (e) => this._hoverLink(e));
    this.sourceEl.addEventListener('mouseover', (e) => this._hoverLink(e));
    this.sourceEl.addEventListener('contextmenu', (e) => this._editorMenu(e));
    this.registerEvent(this.app.metadataCache.on('resolved', debounce(() => this._metaChanged(), 300, true)));
  }

  getViewType() { return 'markdown'; }
  canAcceptExtension(ext) { return ext === 'md'; }
  getIcon() { return 'file-text'; }

  _buildEditor() {
    const info = { app: this.app, view: this, file: null, editor: null };
    this.cmHandle = createEditor({
      parent: this.sourceEl,
      doc: '',
      info,
      livePreview: !this.sourceMode,
      settings: this.app.editorSettings(),
      pluginExtensions: this.app.pluginEditorExtensions(),
      onChange: (u) => this._onDocChange(u),
      onFocus: () => this.app.workspace.activeEditor = this,
      openLink: (target, evt) => {
        if (target.tag) this.app.openTagSearch(target.tag);
        else this.app.workspace.openLinkFromEvent(target.href, this.file?.path || '', evt);
      },
    });
    this.cm = this.cmHandle.view;
    this.editor = new Editor(this.cm, this);
    info.editor = this.editor;
    this.cmInfo = info;
    // the note scrolls as a whole: inline title above the editor
    this.sourceEl.insertBefore(this.inlineTitleEl, this.cm.dom);
    this.cm.dom.addClass('markdown-source-view-cm');
  }

  focus() {
    if (this.mode === 'source') this.cm.focus();
    else this.previewMode.previewEl.focus?.();
  }

  // ---------------------------------------------------------------- data
  getViewData() { return this.cm.state.doc.toString(); }

  onReadOnlyChange() {
    this.cmHandle.setReadOnly(!!this.readOnlyReason);
    this.inlineTitleEl.setAttr('contenteditable', this.readOnlyReason ? 'false' : 'true');
    this.containerEl.toggleClass('is-readonly', !!this.readOnlyReason);
  }

  setViewData(data, clear) {
    if (data !== this.getViewData()) {
      this._settingData = true;
      if (clear) {
        // loading a file is not an edit: it must not be undoable
        this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: data }, selection: { anchor: 0 },
          annotations: Transaction.addToHistory.of(false) });
        this.cmHandle.resetHistory();
      } else {
        // keep the cursor where it is as far as possible
        const head = Math.min(this.cm.state.selection.main.head, data.length);
        this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: data }, selection: { anchor: head } });
      }
      this._settingData = false;
    }
    this.data = data;
    if (this.mode === 'preview' || clear) this.previewMode.set(data, this.mode === 'preview');
  }

  clear() {}

  _onDocChange(u) {
    if (this._settingData || this._loadingFile) return; // typing during a file switch is replaced by the new text
    this.dirty = true;
    this.requestSave();
    this.app.workspace.trigger('editor-change', this.editor, this);
    this._countWords();
  }

  _countWords = debounce(() => this.app.statusBar?.updateCounts(this), 300, true);

  async onLoadFile(file) {
    this.cmInfo.file = file;
    this.cmHandle.setInfo({ ...this.cmInfo });
    this.inlineTitleEl.setText(file.basename);
    this.inlineTitleEl.toggle(this.app.settings.get('showInlineTitle') !== false);
    await super.onLoadFile(file);
    this.app.statusBar?.updateCounts(this);
  }

  async onRename(file) {
    await super.onRename(file);
    this.inlineTitleEl.setText(file.basename);
    this.cmInfo.file = file;
    this.cmHandle.setInfo({ ...this.cmInfo });
  }

  async _commitTitle() {
    if (!this.file) return;
    const name = this.inlineTitleEl.getText().trim().replace(/[\\/:]/g, '-');
    if (!name || name === this.file.basename) { this.inlineTitleEl.setText(this.file.basename); return; }
    const parent = this.file.parent && this.file.parent.path !== '/' ? this.file.parent.path + '/' : '';
    try {
      await this.app.fileManager.renameFile(this.file, `${parent}${name}.${this.file.extension}`);
    } catch (e) {
      this.app.notice(t('notice.rename-failed', { error: errorText(e) }));
      this.inlineTitleEl.setText(this.file.basename);
    }
  }

  _metaChanged() {
    if (this.mode === 'preview' && this.file) this.previewMode.rerender(false);
    this.cmHandle.refresh();
  }

  // ---------------------------------------------------------------- modes
  getMode() { return this.mode; }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._applyMode();
  }

  toggleMode() { this.setMode(this.mode === 'source' ? 'preview' : 'source'); }

  setSourceMode(source) {
    this.sourceMode = !!source;
    this.cmHandle.setLivePreview(!this.sourceMode);
    this.sourceEl.toggleClass('is-live-preview', !this.sourceMode);
    this.app.workspace.requestSaveLayout();
  }

  _applyMode() {
    const preview = this.mode === 'preview';
    if (preview) {
      const line = this.editor ? this.editor.getCursor().line : 0;
      this.previewMode.set(this.getViewData(), true).then(() => this.previewMode.scrollToLine(this._topLine() ?? line));
    }
    this.sourceEl.toggle(!preview);
    this.previewContainerEl.toggle(preview);
    this.sourceEl.toggleClass('is-live-preview', !this.sourceMode);
    setIcon(this.modeButtonEl, preview ? 'edit-mode' : 'reading-mode');
    setTooltip(this.modeButtonEl, preview ? t('view.edit-mode') : t('view.reading-mode'));
    this.containerEl.toggleClass('is-reading', preview);
    this.app.statusBar?.updateMode(this);
    this.app.workspace.trigger('layout-change');
    this.app.workspace.requestSaveLayout();
    if (!preview) setTimeout(() => this.cm.requestMeasure(), 0);
  }

  _topLine() {
    if (!this.cm) return null;
    const top = this.sourceEl.scrollTop - (this.cm.dom.offsetTop || 0);
    const block = this.cm.lineBlockAtHeight(Math.max(0, top));
    return this.cm.state.doc.lineAt(block.from).number - 1;
  }

  getState() {
    return { file: this.file?.path ?? null, mode: this.mode, source: this.sourceMode };
  }

  async setState(state, result) {
    if (state.mode && state.mode !== this.mode) { this.mode = state.mode; this._applyMode(); }
    if (state.source !== undefined && state.source !== this.sourceMode) this.setSourceMode(state.source);
    await super.setState(state, result);
  }

  getEphemeralState() {
    return { cursor: this.editor ? { from: this.editor.getCursor('from'), to: this.editor.getCursor('to') } : undefined,
      scroll: this.mode === 'preview' ? this.previewMode.getScroll() : this.sourceEl.scrollTop };
  }

  setEphemeralState(st) {
    if (!st) return;
    if (st.subpath && this.file) {
      const cache = this.app.metadataCache.getFileCache(this.file);
      const sp = resolveSubpath(cache, st.subpath);
      if (sp) this._goToLine(sp.start.line, true);
      return;
    }
    if (st.line !== undefined) { this._goToLine(st.line, true); return; }
    if (st.match && this.file) {
      const { from, to } = st.match;
      this.cm.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      return;
    }
    if (st.cursor) {
      try { this.editor.setSelection(st.cursor.from, st.cursor.to); } catch { /* file changed */ }
    }
    if (st.scroll !== undefined) {
      requestAnimationFrame(() => {
        if (this.mode === 'preview') this.previewMode.applyScroll(st.scroll); else this.sourceEl.scrollTop = st.scroll;
      });
    }
    if (st.focus) this.focus();
  }

  _goToLine(line, flash) {
    if (this.mode === 'preview') {
      setTimeout(() => this.previewMode.scrollToLine(line, flash), 50);
      return;
    }
    const n = Math.clamp(line + 1, 1, this.cm.state.doc.lines);
    const pos = this.cm.state.doc.line(n).from;
    this.cm.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }) });
    if (flash) {
      setTimeout(() => {
        const el = this.cm.domAtPos(pos)?.node;
        const lineEl = (el?.nodeType === 3 ? el.parentElement : el)?.closest?.('.cm-line');
        if (lineEl) { lineEl.addClass('is-flashing'); setTimeout(() => lineEl.removeClass('is-flashing'), 1500); }
      }, 50);
    }
    this.cm.focus();
  }

  showSearch(replace) {
    if (this.mode === 'preview') this.setMode('source');
    this.editor.openSearch();
    if (replace) setTimeout(() => this.cm.dom.querySelector('.cm-search input[name=replace]')?.focus(), 0);
  }

  // ---------------------------------------------------------------- interaction
  _previewClick(e) {
    const a = e.target.closest?.('a');
    const box = e.target.closest?.('input.task-list-item-checkbox');
    if (box) {
      const line = Number(box.getAttr('data-line'));
      const section = box.closest('[data-sk-line]');
      const base = section ? Number(section.getAttr('data-sk-line')) : 0;
      if (!Number.isNaN(line)) this._toggleTaskAtLine(this._frontmatterLines() + line, box.checked);
      void base;
      return;
    }
    if (!a) return;
    if (a.hasClass('internal-link')) {
      e.preventDefault();
      this.app.workspace.openLinkFromEvent(a.getAttr('data-href'), this.file?.path || '', e);
    } else if (a.hasClass('tag')) {
      e.preventDefault();
      this.app.openTagSearch(a.getText().slice(1));
    } else if (a.hasClass('footnote-link')) {
      e.preventDefault();
      this.previewMode.previewEl.querySelector(a.getAttr('href'))?.scrollIntoView({ block: 'center' });
    } else if (a.hasClass('external-link') || /^[a-z]+:/i.test(a.getAttr('href') || '')) {
      e.preventDefault();
      this.app.openExternal(a.getAttr('href'));
    }
  }

  _frontmatterLines() {
    const m = /^---\n[\s\S]*?\n(---|\.\.\.)[ \t]*(\n|$)/.exec(this.getViewData());
    return m ? m[0].split('\n').length - 1 : 0;
  }

  _toggleTaskAtLine(line, checked) {
    const doc = this.cm.state.doc;
    if (line < 0 || line >= doc.lines) return;
    const l = doc.line(line + 1);
    // also inside quotes and callouts: "> - [ ] task"
    const m = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\])/.exec(l.text);
    if (!m) return false;
    const at = l.from + m[1].length;
    this.cm.dispatch({ changes: { from: at, to: at + 1, insert: checked ? 'x' : ' ' } });
    return true;
  }

  _hoverLink(e) {
    const el = e.target.closest?.('a.internal-link, .cm-sk-link, .cm-hmd-internal-link');
    if (!el) return;
    const href = el.getAttr('data-href') || el.getAttr('href');
    if (!href) return;
    this.app.pagePreview?.onHover(e, el, href, this.file?.path || '', this.mode === 'source');
  }

  _editorMenu(e) {
    e.preventDefault();
    const menu = new Menu();
    const ed = this.editor;
    const sel = ed.somethingSelected();
    menu.addItem((i) => i.setTitle(t('editor.cut')).setIcon('scissors').setDisabled(!sel).setSection('clipboard')
      .onClick(() => { navigator.clipboard.writeText(ed.getSelection()); ed.replaceSelection(''); }));
    menu.addItem((i) => i.setTitle(t('editor.copy')).setIcon('copy').setDisabled(!sel).setSection('clipboard')
      .onClick(() => navigator.clipboard.writeText(ed.getSelection())));
    menu.addItem((i) => i.setTitle(t('editor.paste')).setIcon('clipboard').setSection('clipboard')
      .onClick(async () => ed.replaceSelection(await navigator.clipboard.readText())));
    const fmt = (id, icon, key) => menu.addItem((i) => i.setTitle(t(key)).setIcon(icon).setSection('format')
      .onClick(() => this.app.commands.executeCommandById(id)));
    fmt('editor:toggle-bold', 'bold', 'cmd.toggle-bold');
    fmt('editor:toggle-italics', 'italic', 'cmd.toggle-italics');
    fmt('editor:toggle-highlight', 'highlighter', 'cmd.toggle-highlight');
    fmt('editor:insert-wikilink', 'link', 'cmd.insert-wikilink');
    fmt('editor:toggle-checklist-status', 'check-square', 'cmd.toggle-checklist');
    this.app.workspace.trigger('editor-menu', menu, ed, this);
    this.app.skai?.editorMenu?.(menu, ed, this);
    menu.showAtMouseEvent(e);
  }

  onPaneMenu(menu, source) {
    const f = this.file;
    menu.addItem((i) => i.setTitle(this.mode === 'preview' ? t('view.edit-mode') : t('view.reading-mode'))
      .setIcon(this.mode === 'preview' ? 'edit-mode' : 'reading-mode').setSection('view').onClick(() => this.toggleMode()));
    menu.addItem((i) => i.setTitle(this.sourceMode ? t('view.live-preview') : t('view.source-mode')).setIcon('code').setSection('view')
      .onClick(() => this.setSourceMode(!this.sourceMode)));
    if (f) {
      menu.addItem((i) => i.setTitle(t('view.local-graph')).setIcon('graph').setSection('linked')
        .onClick(() => this.app.openLinkedView(this.leaf, 'localgraph')));
      menu.addItem((i) => i.setTitle(t('view.backlinks')).setIcon('link').setSection('linked')
        .onClick(() => this.app.openLinkedView(this.leaf, 'backlink')));
      menu.addItem((i) => i.setTitle(t('view.outline')).setIcon('outline').setSection('linked')
        .onClick(() => this.app.openLinkedView(this.leaf, 'outline')));
      menu.addItem((i) => i.setTitle(t('cmd.find')).setIcon('search').setSection('find').onClick(() => this.showSearch(false)));
      menu.addItem((i) => i.setTitle(t('cmd.replace')).setIcon('replace').setSection('find').onClick(() => this.showSearch(true)));
      menu.addItem((i) => i.setTitle(t('cmd.export-pdf')).setIcon('printer').setSection('export')
        .onClick(() => this.app.commands.executeCommandById('workspace:export-pdf')));
      menu.addItem((i) => i.setTitle(t('cmd.version-history')).setIcon('history').setSection('export')
        .onClick(() => this.app.openVersionHistory(f)));
      this.app.fileMenu(menu, f, 'more-options', this.leaf);
      this.app.workspace.trigger('file-menu', menu, f, 'more-options', this.leaf);
    }
    super.onPaneMenu(menu, source);
  }

  async onClose() {
    await this.save();
    this.cm.destroy();
    await super.onClose();
  }

  onResize() { this.cm.requestMeasure(); }

  get currentMode() { return this.mode === 'preview' ? this.previewMode : this.editor; }

  getWordCount() {
    const sel = this.editor.getSelection();
    const text = sel || this.getViewData().replace(/^---\n[\s\S]*?\n---\n?/, '');
    return { words: wordCount(text), chars: text.length, selection: !!sel };
  }
}
