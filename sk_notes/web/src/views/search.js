// Search view (left sidebar): full query language, grouped results with snippets.

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t, tn } from '../core/i18n.js';
import { debounce } from '../core/util.js';
import { Keymap } from '../model/keymap.js';
import { Menu, SearchComponent, setTooltip } from '../ui/kit.js';
import { ItemView } from './base.js';

export class SearchView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'search';
    this.navButtonsEl.hide();
    this.titleContainerEl.hide();
    this.moreOptionsButton.hide();
    this.headerEl.addClass('nav-header-view');
    this.caseSensitive = false;
    this.collapsed = false;
    this.moreContext = false;
    this.sort = 'alphabetical';
    const btns = this.headerEl.createDiv('nav-buttons-container');
    const toggle = (icon, label, key) => {
      const b = btns.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', () => { this[key] = !this[key]; b.toggleClass('is-active', this[key]); this.run(); });
      return b;
    };
    this.caseBtn = toggle('type', t('search.match-case'), 'caseSensitive');
    toggle('chevrons-down-up', t('search.collapse'), 'collapsed');
    toggle('rows', t('search.more-context'), 'moreContext');
    const sortBtn = btns.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': t('search.sort') } });
    setIcon(sortBtn, 'sort');
    sortBtn.addEventListener('click', (e) => {
      const m = new Menu();
      for (const s of ['alphabetical', 'alphabeticalReverse', 'byModifiedTime', 'byModifiedTimeReverse', 'byCreatedTime', 'byCreatedTimeReverse']) {
        m.addItem((i) => i.setTitle(t(`explorer.sort.${s}`)).setChecked(this.sort === s).onClick(() => { this.sort = s; this.renderResults(); }));
      }
      m.showAtMouseEvent(e);
    });
    const row = this.contentEl.createDiv('search-row');
    this.input = new SearchComponent(row).setPlaceholder(t('search.placeholder'));
    this.input.inputEl.addClass('search-input');
    this.infoEl = this.contentEl.createDiv('search-result-info');
    this.resultsEl = this.contentEl.createDiv('search-results-children');
    this.input.onChange(debounce(() => this.run(), 250, true));
    this.input.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.run(); } });
    this.result = null;
    this.registerEvent(this.app.metadataCache.on('resolved', debounce(() => { if (this.input.getValue()) this.run(); }, 2000, true)));
  }

  getViewType() { return 'search'; }
  getDisplayText() { return t('search.title'); }
  getIcon() { return 'search'; }
  getState() { return { query: this.input.getValue(), matchingCase: this.caseSensitive, explainSearch: false, collapseAll: this.collapsed, extraContext: this.moreContext, sortOrder: this.sort }; }
  async setState(st) {
    if (st.query !== undefined) this.input.setValue(st.query);
    if (st.sortOrder) this.sort = st.sortOrder;
    if (st.query) this.run();
  }

  setQuery(q) {
    this.input.setValue(q);
    this.run();
    this.app.workspace.revealLeaf(this.leaf);
    this.input.inputEl.focus();
  }

  focus() { this.input.inputEl.focus(); this.input.inputEl.select(); }

  async run() {
    const q = this.input.getValue().trim();
    const token = (this._token = (this._token || 0) + 1);
    if (!q) { this.result = null; this.resultsEl.empty(); this.infoEl.empty(); return; }
    let res;
    try {
      res = await call('search.query', { query: q, caseSensitive: this.caseSensitive, context: this.moreContext ? 3 : 1, limit: 1000 });
    } catch (e) {
      if (token !== this._token) return;
      this.infoEl.setText(t('search.bad-query'));
      this.resultsEl.empty();
      return;
    }
    if (token !== this._token) return;
    this.result = res;
    this.renderResults();
    this.app.workspace.requestSaveLayout();
  }

  renderResults() {
    const res = this.result;
    if (!res) return;
    this.resultsEl.empty();
    this.infoEl.setText(tn('search.results', res.total));
    const sorted = res.results.slice();
    const name = (p) => p.split('/').pop().toLowerCase();
    const cmp = {
      alphabetical: (a, b) => name(a.path).localeCompare(name(b.path)),
      alphabeticalReverse: (a, b) => name(b.path).localeCompare(name(a.path)),
      byModifiedTime: (a, b) => b.mtime - a.mtime,
      byModifiedTimeReverse: (a, b) => a.mtime - b.mtime,
      byCreatedTime: (a, b) => b.ctime - a.ctime,
      byCreatedTimeReverse: (a, b) => a.ctime - b.ctime,
    }[this.sort];
    sorted.sort(cmp);
    for (const r of sorted.slice(0, 500)) {
      const file = this.app.vault.getFileByPath(r.path);
      if (!file) continue;
      const item = this.resultsEl.createDiv('tree-item search-result' + (this.collapsed ? ' is-collapsed' : ''));
      const head = item.createDiv('tree-item-self search-result-file-title is-clickable');
      const col = head.createDiv('tree-item-icon collapse-icon');
      setIcon(col, 'chevron-down');
      head.createDiv({ cls: 'tree-item-inner', text: file.extension === 'md' ? file.basename : file.name });
      if (r.matches.length) head.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(r.matches.length) });
      col.addEventListener('click', (e) => { e.stopPropagation(); item.toggleClass('is-collapsed', !item.hasClass('is-collapsed')); });
      head.addEventListener('click', (e) => this.openResult(file, null, e));
      head.addEventListener('mouseover', (e) => this.app.pagePreview?.onHover(e, head, file.path, '', true, true));
      const kids = item.createDiv('search-result-file-matches');
      for (const m of r.matches) {
        const row = kids.createDiv('search-result-file-match tree-item-self is-clickable');
        for (const [text, hit] of m.segments) {
          if (hit) row.createSpan({ cls: 'search-result-file-matched-text', text });
          else row.appendText(text);
        }
        row.addEventListener('click', (e) => this.openResult(file, m.line, e));
      }
    }
  }

  async openResult(file, line, e) {
    const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e));
    await leaf.openFile(file, { eState: line !== null ? { line } : {} });
  }

  onPaneMenu() {}
}

export { setTooltip };
