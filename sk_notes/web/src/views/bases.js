// Bases: database-like views of notes based on their properties (.base files).

import { resourceUrl } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t, tn } from '../core/i18n.js';
import { debounce, isImage } from '../core/util.js';
import { Keymap } from '../model/keymap.js';
import { parseYaml, stringifyYaml } from '../model/filemanager.js';
import { TFile } from '../model/vault.js';
import { BDate, Context, Link, SUMMARIES, cmp, compileFilter, evaluate, parse, str, testFilter, toDate } from '../bases/expr.js';
import { Menu, Modal, ButtonComponent, promptDialog } from '../ui/kit.js';
import { TextFileView } from './base.js';
import { propLabel } from '../bases/labels.js';

const VIEW_TYPES = ['table', 'cards', 'list', 'kanban', 'map'];
const VIEW_ICONS = { table: 'table', cards: 'grid', list: 'list', kanban: 'kanban', map: 'map-pin' };

function normId(id) {
  return /^(note|file|formula)\./.test(id) ? id : `note.${id}`;
}

/** Compute the rows of one view of a base config. */
export function queryBase(app, cfg, viewIdx, thisFile) {
  const view = cfg.views?.[viewIdx] || { type: 'table' };
  const formulas = {};
  for (const [k, src] of Object.entries(cfg.formulas || {})) {
    try { formulas[k] = parse(String(src)); } catch (e) { formulas[k] = e; }
  }
  const env = { app, formulas, thisFile };
  const errors = [];
  let gf;
  let vf;
  try { gf = compileFilter(cfg.filters); } catch (e) { errors.push(String(e.message)); }
  try { vf = compileFilter(view.filters); } catch (e) { errors.push(String(e.message)); }
  const rows = [];
  for (const file of app.vault.getFiles()) {
    if (file.extension === 'base') continue;
    const cache = app.metadataCache.getFileCache(file) || {};
    const row = { file, cache, props: cache.frontmatter || {} };
    const ctx = new Context(env, row);
    row.ctx = ctx;
    try {
      if (!testFilter(gf, ctx) || !testFilter(vf, ctx)) continue;
    } catch (e) { if (errors.length < 5) errors.push(String(e.message)); continue; }
    if (!gf && !vf && file.extension !== 'md') continue;
    rows.push(row);
  }
  const value = (row, id) => {
    try {
      return evaluate(parse(id.startsWith('note.') && !/^[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(id.slice(5)) ? `note[${JSON.stringify(id.slice(5))}]` : id), row.ctx);
    } catch (e) { return { __error: e.message }; }
  };
  const sorts = Array.isArray(view.sort) ? view.sort : [];
  if (sorts.length) {
    rows.sort((a, b) => {
      for (const s of sorts) {
        const c = cmp(value(a, normId(s.property)), value(b, normId(s.property)));
        if (c) return (String(s.direction).toUpperCase() === 'DESC' ? -1 : 1) * c;
      }
      return 0;
    });
  } else rows.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
  const limited = view.limit ? rows.slice(0, Number(view.limit)) : rows;
  return { view, rows: limited, total: rows.length, value, errors };
}

export function renderValue(app, el, v, sourcePath) {
  if (v && v.__error) { el.createSpan({ cls: 'bases-error-value', text: '⚠', attr: { 'aria-label': v.__error } }); return; }
  if (v === null || v === undefined || v === '') return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => { if (i) el.appendText(', '); renderValue(app, el, x, sourcePath); });
    return;
  }
  if (v instanceof Link) {
    const a = el.createEl('a', { cls: 'internal-link', text: v.toString(), attr: { 'data-href': v.path } });
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); app.workspace.openLinkText(v.path, sourcePath, Keymap.isModEvent(e)); });
    return;
  }
  if (v && v.__file) {
    const a = el.createEl('a', { cls: 'internal-link', text: v.__file.basename });
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); app.workspace.openFile(v.__file, Keymap.isModEvent(e)); });
    return;
  }
  if (v && v.__render === 'image') {
    const src = v.v instanceof Link ? v.v.path : String(v.v || '');
    const f = app.metadataCache.getFirstLinkpathDest(src, sourcePath);
    if (f) el.createEl('img', { cls: 'bases-image', attr: { src: resourceUrl(f.path, f.stat.mtime) } });
    return;
  }
  if (v && v.__render === 'icon') { setIcon(el.createSpan(), String(v.v)); return; }
  if (v && v.__render === 'html') { el.appendText(String(v.v)); return; }
  if (typeof v === 'boolean') { el.createEl('input', { type: 'checkbox', attr: { disabled: true, ...(v ? { checked: true } : {}) } }); return; }
  if (v instanceof BDate) { el.appendText(v.toString()); return; }
  el.appendText(str(v));
}

export class BasesView extends TextFileView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'database';
    this.cfg = { views: [{ type: 'table', name: 'Table' }] };
    this.viewIdx = 0;
    this.contentEl.addClass('bases-view');
    this.toolbarEl = this.contentEl.createDiv('bases-toolbar');
    this.bodyEl = this.contentEl.createDiv('bases-body');
    this.refresh = debounce(() => this.renderBody(), 300, true);
  }

  getViewType() { return 'bases'; }
  canAcceptExtension(ext) { return ext === 'base'; }
  getIcon() { return 'database'; }

  async onOpen() {
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.refresh()));
  }

  getViewData() { return this._text ?? ''; }

  setViewData(text) {
    this._text = text;
    try {
      const cfg = parseYaml(text || '') || {};
      if (!Array.isArray(cfg.views) || !cfg.views.length) cfg.views = [{ type: 'table', name: t('bases.table') }];
      this.cfg = cfg;
      this.parseError = null;
    } catch (e) {
      this.parseError = String(e.message || e);
    }
    this.viewIdx = Math.min(this.viewIdx, (this.cfg.views?.length || 1) - 1);
    this.render();
  }

  _write() {
    this._text = stringifyYaml(this.cfg);
    this.requestSave();
    this.render();
  }

  render() { this.renderToolbar(); this.renderBody(); }

  renderToolbar() {
    const tb = this.toolbarEl;
    tb.empty();
    if (this.parseError) return;
    const view = this.cfg.views[this.viewIdx];
    const sel = tb.createDiv({ cls: 'bases-view-selector clickable-icon' });
    setIcon(sel.createSpan(), VIEW_ICONS[view.type] || 'table');
    sel.createSpan({ text: view.name || t(`bases.${view.type}`) });
    setIcon(sel.createSpan(), 'chevrons-up-down');
    sel.addEventListener('click', (e) => {
      const m = new Menu();
      this.cfg.views.forEach((v, i) => m.addItem((it) => it.setTitle(v.name || v.type).setIcon(VIEW_ICONS[v.type] || 'table').setChecked(i === this.viewIdx).onClick(() => { this.viewIdx = i; this.render(); })));
      m.addSeparator();
      m.addItem((it) => it.setTitle(t('bases.add-view')).setIcon('plus').onClick(async () => {
        const name = await promptDialog(this.app, { title: t('bases.add-view'), value: t('bases.table') });
        if (!name) return;
        this.cfg.views.push({ type: 'table', name });
        this.viewIdx = this.cfg.views.length - 1;
        this._write();
      }));
      m.addItem((it) => it.setTitle(t('bases.rename-view')).setIcon('pencil').onClick(async () => {
        const name = await promptDialog(this.app, { title: t('bases.rename-view'), value: view.name || '' });
        if (name) { view.name = name; this._write(); }
      }));
      for (const ty of VIEW_TYPES) m.addItem((it) => it.setTitle(t(`bases.${ty}`)).setIcon(VIEW_ICONS[ty]).setSection('type').setChecked(view.type === ty).onClick(() => { view.type = ty; this._write(); }));
      if (this.cfg.views.length > 1) m.addItem((it) => it.setTitle(t('bases.delete-view')).setIcon('trash').setWarning(true).setSection('danger').onClick(() => { this.cfg.views.splice(this.viewIdx, 1); this.viewIdx = 0; this._write(); }));
      m.showAtMouseEvent(e);
    });
    this.countEl = tb.createDiv('bases-result-count');
    tb.createDiv('bases-toolbar-spacer');
    const btn = (icon, label, fn) => {
      const b = tb.createDiv({ cls: 'bases-toolbar-item clickable-icon' });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: label });
      b.addEventListener('click', fn);
      return b;
    };
    btn('sort', t('bases.sort'), (e) => this.sortMenu(e));
    btn('filter', t('bases.filter'), () => new FilterModal(this).open());
    btn('list', t('bases.properties'), (e) => this.propertiesMenu(e));
    btn('plus', t('bases.new'), () => this.newNote());
  }

  _allPropertyIds(rows) {
    const ids = new Set(['file.name', 'file.folder', 'file.ext', 'file.size', 'file.ctime', 'file.mtime', 'file.tags', 'file.links', 'file.backlinks']);
    for (const r of rows) for (const k of Object.keys(r.props || {})) ids.add('note.' + k);
    for (const k of Object.keys(this.cfg.formulas || {})) ids.add('formula.' + k);
    return [...ids];
  }

  _columns(view, rows) {
    if (Array.isArray(view.order) && view.order.length) return view.order.map(normId);
    const props = new Set();
    for (const r of rows.slice(0, 200)) for (const k of Object.keys(r.props || {})) props.add('note.' + k);
    return ['file.name', ...[...props].slice(0, 6)];
  }

  sortMenu(e) {
    const view = this.cfg.views[this.viewIdx];
    const m = new Menu();
    const cur = (view.sort || [])[0];
    const ids = this._allPropertyIds(this._last?.rows || []);
    for (const id of ids) {
      for (const dir of ['ASC', 'DESC']) {
        m.addItem((it) => it.setTitle(`${propLabel(this.cfg, id)} ${dir === 'ASC' ? '↑' : '↓'}`).setChecked(cur && normId(cur.property) === id && String(cur.direction).toUpperCase() === dir)
          .onClick(() => { view.sort = [{ property: id, direction: dir }]; this._write(); }));
      }
    }
    if (cur) m.addItem((it) => it.setTitle(t('bases.no-sort')).setIcon('x').setSection('clear').onClick(() => { delete view.sort; this._write(); }));
    m.showAtMouseEvent(e);
  }

  propertiesMenu(e) {
    const view = this.cfg.views[this.viewIdx];
    const rows = this._last?.rows || [];
    const cols = this._columns(view, rows);
    const m = new Menu();
    for (const id of this._allPropertyIds(rows)) {
      m.addItem((it) => it.setTitle(propLabel(this.cfg, id)).setChecked(cols.includes(id)).onClick(() => {
        const next = cols.includes(id) ? cols.filter((x) => x !== id) : [...cols, id];
        view.order = next;
        this._write();
      }));
    }
    m.addItem((it) => it.setTitle(t('bases.add-formula')).setIcon('sigma').setSection('formula').onClick(async () => {
      const name = await promptDialog(this.app, { title: t('bases.formula-name') });
      if (!name) return;
      const expr = await promptDialog(this.app, { title: t('bases.formula-expr'), placeholder: 'price * quantity' });
      if (!expr) return;
      this.cfg.formulas = { ...(this.cfg.formulas || {}), [name]: expr };
      view.order = [...cols, 'formula.' + name];
      this._write();
    }));
    m.showAtMouseEvent(e);
  }

  async newNote() {
    const view = this.cfg.views[this.viewIdx];
    const props = {};
    const collect = (f) => {
      if (typeof f === 'string') {
        const mm = /^\s*(?:note\.)?([\p{L}_][\p{L}\p{N}_-]*)\s*==\s*(["'])(.*)\2\s*$/u.exec(f);
        if (mm) props[mm[1]] = mm[3];
      } else if (f?.and) f.and.forEach(collect);
    };
    collect(this.cfg.filters);
    collect(view.filters);
    let folder = this.app.fileManager.getNewFileParent(this.file?.path || '');
    const inFolder = /file\.inFolder\(\s*["']([^"']+)["']\s*\)/.exec(JSON.stringify(this.cfg.filters || '') + JSON.stringify(view.filters || ''));
    if (inFolder) folder = this.app.vault.getFolderByPath(inFolder[1]) || folder;
    const tag = /file\.hasTag\(\s*\\?["']([^"'\\]+)\\?["']\s*\)/.exec(JSON.stringify(this.cfg.filters || '') + JSON.stringify(view.filters || ''));
    if (tag) props.tags = [tag[1]];
    const content = Object.keys(props).length ? `---\n${stringifyYaml(props).trimEnd()}\n---\n` : '';
    const f = await this.app.fileManager.createNewMarkdownFile(folder, t('file.untitled'), content);
    this.app.workspace.openFile(f, 'tab');
  }

  // ---------------------------------------------------------------- body
  renderBody() {
    const body = this.bodyEl;
    body.empty();
    if (this.parseError) {
      body.createDiv({ cls: 'bases-error', text: t('bases.invalid-yaml', { error: this.parseError }) });
      return;
    }
    const res = queryBase(this.app, this.cfg, this.viewIdx, this.file);
    this._last = res;
    if (this.countEl) this.countEl.setText(tn('bases.results', res.total));
    for (const err of res.errors) body.createDiv({ cls: 'bases-error', text: err });
    renderBaseView(this.app, body, this.cfg, res, this, this.file?.path || '');
  }

  async editCell(row, id, newValue) {
    if (!id.startsWith('note.')) return;
    const key = id.slice(5);
    await this.app.fileManager.processFrontMatter(row.file, (fm) => {
      if (newValue === '' || newValue === null) delete fm[key]; else fm[key] = newValue;
    });
  }

  onPaneMenu(menu, source) {
    menu.addItem((i) => i.setTitle(t('bases.edit-yaml')).setIcon('code').onClick(async () => {
      const f = this.file;
      if (!f) return;
      const m = new Modal(this.app);
      m.setTitle(f.basename);
      const ta = m.contentEl.createEl('textarea', { cls: 'bases-yaml-editor', value: this._text || '' });
      const row = m.contentEl.createDiv('modal-button-container');
      new ButtonComponent(row).setButtonText(t('common.ok')).setCta().onClick(() => { this.setViewData(ta.value); this.requestSave(); m.close(); });
      m.open();
    }));
    super.onPaneMenu(menu, source);
  }
}

export function renderBaseView(app, el, cfg, res, owner, sourcePath) {
  const { view, rows, value } = res;
  const cols = owner?._columns ? owner._columns(view, rows) : (Array.isArray(view.order) && view.order.length ? view.order.map(normId) : ['file.name']);
  const openRow = (row, e) => app.workspace.openFile(row.file, Keymap.isModEvent(e) || (owner?.leaf ? false : 'tab'));
  if (view.type === 'map') {
    el.createDiv({ cls: 'bases-empty', text: t('bases.map-offline') });
    return;
  }
  if (!rows.length) { el.createDiv({ cls: 'bases-empty', text: t('bases.no-results') }); return; }
  const groupProp = view.groupBy?.property ? normId(view.groupBy.property) : null;
  let groups = [{ key: null, rows }];
  if (groupProp || view.type === 'kanban') {
    const gp = groupProp || cols.find((c) => c.startsWith('note.')) || 'file.folder';
    const map = new Map();
    for (const r of rows) {
      const v = value(r, gp);
      const k = v === null || v === undefined || v === '' ? null : str(v);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    groups = [...map.entries()].map(([key, rs]) => ({ key, rows: rs }));
    groups.sort((a, b) => (String(view.groupBy?.direction).toUpperCase() === 'DESC' ? -1 : 1) * cmp(a.key, b.key));
    if (Array.isArray(view.groupOrder)) {
      const order = view.groupOrder.map((x) => (x === null ? null : String(x)));
      groups = order.map((k) => groups.find((g) => g.key === k) || { key: k, rows: [] });
    }
    groups.forEach((g) => { g.prop = gp; });
  }
  if (view.type === 'kanban') {
    const board = el.createDiv('bases-kanban');
    for (const g of groups) {
      const col = board.createDiv('bases-kanban-column');
      col.createDiv({ cls: 'bases-kanban-title', text: g.key ?? t('bases.no-value') });
      const list = col.createDiv('bases-kanban-list');
      for (const r of g.rows) {
        const card = list.createDiv({ cls: 'bases-card', attr: { draggable: 'true' } });
        card.createDiv({ cls: 'bases-card-title', text: r.file.basename });
        for (const c of cols.filter((x) => x !== 'file.name' && x !== g.prop).slice(0, 3)) renderValue(app, card.createDiv('bases-card-prop'), value(r, c), sourcePath);
        card.addEventListener('click', (e) => openRow(r, e));
        card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-sk-base-row', r.file.path));
      }
      if (g.prop?.startsWith('note.') && owner?.editCell) {
        col.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-sk-base-row')) e.preventDefault(); });
        col.addEventListener('drop', async (e) => {
          const p = e.dataTransfer.getData('text/x-sk-base-row');
          const row = rows.find((r) => r.file.path === p);
          if (row) await owner.editCell(row, g.prop, g.key);
        });
      }
    }
    return;
  }
  for (const g of groups) {
    if (g.prop) el.createDiv({ cls: 'bases-group-title', text: `${propLabel(cfg, g.prop)}: ${g.key ?? t('bases.no-value')} (${g.rows.length})` });
    if (view.type === 'cards') {
      const grid = el.createDiv('bases-cards');
      const imgProp = view.image ? normId(view.image) : null;
      for (const r of g.rows) {
        const card = grid.createDiv('bases-card');
        const img = imgProp ? value(r, imgProp) : null;
        const imgSrc = img instanceof Link ? img.path : typeof img === 'string' ? img : null;
        const imgFile = imgSrc ? app.metadataCache.getFirstLinkpathDest(imgSrc, r.file.path) : (isImage(r.file.extension) ? r.file : null);
        if (imgFile) card.createDiv('bases-card-cover').createEl('img', { attr: { src: resourceUrl(imgFile.path, imgFile.stat.mtime) } });
        card.createDiv({ cls: 'bases-card-title', text: r.file.basename });
        for (const c of cols.filter((x) => x !== 'file.name')) {
          const p = card.createDiv('bases-card-prop');
          p.createSpan({ cls: 'bases-card-prop-label', text: propLabel(cfg, c) });
          renderValue(app, p.createSpan('bases-card-prop-value'), value(r, c), sourcePath);
        }
        card.addEventListener('click', (e) => openRow(r, e));
      }
      continue;
    }
    if (view.type === 'list') {
      const ul = el.createEl('ul', 'bases-list');
      for (const r of g.rows) {
        const li = ul.createEl('li');
        const a = li.createEl('a', { cls: 'internal-link', text: r.file.basename });
        a.addEventListener('click', (e) => { e.preventDefault(); openRow(r, e); });
        const extra = cols.filter((x) => x !== 'file.name');
        if (extra.length) {
          const span = li.createSpan('bases-list-props');
          extra.forEach((c) => { span.appendText(' · '); renderValue(app, span, value(r, c), sourcePath); });
        }
      }
      continue;
    }
    // table
    const wrap = el.createDiv('bases-table-container');
    const table = wrap.createEl('table', 'bases-table');
    const head = table.createEl('thead').createEl('tr');
    for (const c of cols) {
      const th = head.createEl('th');
      const type = c.startsWith('file.') ? 'file' : c.startsWith('formula.') ? 'sigma' : 'type';
      setIcon(th.createSpan('bases-th-icon'), type === 'file' ? 'file' : type);
      th.createSpan({ text: propLabel(cfg, c) });
      if (owner?.cfg) th.addEventListener('click', () => {
        const cur = (view.sort || [])[0];
        const dir = cur && normId(cur.property) === c && String(cur.direction).toUpperCase() === 'ASC' ? 'DESC' : 'ASC';
        view.sort = [{ property: c, direction: dir }];
        owner._write();
      });
    }
    const tbody = table.createEl('tbody');
    for (const r of g.rows) {
      const tr = tbody.createEl('tr');
      for (const c of cols) {
        const td = tr.createEl('td');
        if (c === 'file.name') {
          const a = td.createEl('a', { cls: 'internal-link', text: r.file.extension === 'md' ? r.file.basename : r.file.name });
          a.addEventListener('click', (e) => { e.preventDefault(); openRow(r, e); });
          continue;
        }
        const v = value(r, c);
        renderValue(app, td, v, sourcePath);
        if (c.startsWith('note.') && owner?.editCell) {
          td.addClass('is-editable');
          td.addEventListener('dblclick', () => {
            const raw = r.props[c.slice(5)];
            if (typeof raw === 'boolean') { owner.editCell(r, c, !raw); return; }
            td.empty();
            const input = td.createEl('input', { value: Array.isArray(raw) ? raw.join(', ') : raw ?? '' });
            input.focus();
            const done = (commit) => {
              if (!commit) { owner.renderBody(); return; }
              let nv = input.value;
              if (Array.isArray(raw)) nv = nv.split(',').map((s) => s.trim()).filter(Boolean);
              else if (typeof raw === 'number' && nv !== '' && !Number.isNaN(Number(nv))) nv = Number(nv);
              owner.editCell(r, c, nv);
            };
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
            input.addEventListener('blur', () => done(true));
          });
        }
      }
    }
    // summaries
    const sums = view.summaries || {};
    if (Object.keys(sums).length) {
      const tr = table.createEl('tfoot').createEl('tr');
      for (const c of cols) {
        const td = tr.createEl('td', 'bases-summary');
        const name = sums[c] || sums[c.replace(/^note\./, '')];
        if (!name) continue;
        const vals = g.rows.map((r) => value(r, c)).flat();
        let out = null;
        if (SUMMARIES[name]) out = SUMMARIES[name](vals);
        else if (cfg.summaries?.[name]) {
          try { const ctx = new Context({ app }, { file: null, props: {} }); ctx.values = vals; out = evaluate(parse(cfg.summaries[name]), ctx); } catch (e) { out = { __error: e.message }; }
        }
        td.createSpan({ cls: 'bases-summary-name', text: name + ' ' });
        renderValue(app, td, typeof out === 'number' ? Math.round(out * 1000) / 1000 : out, sourcePath);
      }
    }
  }
}

class FilterModal extends Modal {
  constructor(owner) { super(owner.app); this.owner = owner; }
  onOpen() {
    const view = this.owner.cfg.views[this.owner.viewIdx];
    this.setTitle(t('bases.filter'));
    this.contentEl.createDiv({ cls: 'setting-item-description', text: t('bases.filter-help') });
    this.contentEl.createEl('h4', { text: t('bases.filter-all-views') });
    const g = this.contentEl.createEl('textarea', { cls: 'bases-yaml-editor', value: this.owner.cfg.filters ? stringifyYaml({ filters: this.owner.cfg.filters }) : 'filters:\n  and:\n    - ' });
    this.contentEl.createEl('h4', { text: t('bases.filter-this-view') });
    const v = this.contentEl.createEl('textarea', { cls: 'bases-yaml-editor', value: view.filters ? stringifyYaml({ filters: view.filters }) : 'filters:\n  and:\n    - ' });
    const err = this.contentEl.createDiv('bases-error');
    const row = this.contentEl.createDiv('modal-button-container');
    new ButtonComponent(row).setButtonText(t('common.ok')).setCta().onClick(() => {
      try {
        const clean = (txt) => { const y = parseYaml(txt) || {}; const f = y.filters; if (!f || (f.and && !f.and.filter(Boolean).length)) return undefined; if (f.and) f.and = f.and.filter(Boolean); compileFilter(f); return f; };
        const gf = clean(g.value);
        const vf = clean(v.value);
        if (gf) this.owner.cfg.filters = gf; else delete this.owner.cfg.filters;
        if (vf) view.filters = vf; else delete view.filters;
        this.owner._write();
        this.close();
      } catch (e) { err.setText(String(e.message || e)); }
    });
    new ButtonComponent(row).setButtonText(t('common.cancel')).onClick(() => this.close());
  }
}

/** ```base code blocks and ![[file.base]] embeds. */
export function installBaseEmbeds(app) {
  const render = async (el, cfg, viewName, sourcePath) => {
    let idx = 0;
    if (viewName) idx = Math.max(0, (cfg.views || []).findIndex((v) => v.name === viewName));
    const res = queryBase(app, cfg, idx, app.vault.getFileByPath(sourcePath));
    el.addClass('bases-embed');
    el.createDiv({ cls: 'bases-result-count', text: tn('bases.results', res.total) });
    renderBaseView(app, el, cfg, res, null, sourcePath);
  };
  app.markdownProcessors.codeBlocks.set('base', async (source, el, ctx) => {
    try { await render(el, parseYaml(source) || {}, null, ctx.sourcePath); } catch (e) { el.setText(String(e.message || e)); }
  });
  app.renderBaseEmbed = async (span, file, subpath, component) => {
    const text = await app.vault.cachedRead(file);
    try { await render(span.createDiv(), parseYaml(text) || {}, subpath ? subpath.slice(1) : null, file.path); } catch (e) { span.createDiv({ text: String(e.message || e) }); }
  };
}

export { TFile, toDate };
