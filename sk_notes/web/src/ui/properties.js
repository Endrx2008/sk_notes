// Properties (frontmatter) editor: typed widgets at the top of a note.

import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { parseYaml, stringifyYaml } from '../model/filemanager.js';
import { AbstractInputSuggest, Menu, promptDialog } from './kit.js';

const TYPE_ICONS = { text: 'type', multitext: 'list', number: 'binary', checkbox: 'check-square', date: 'calendar', datetime: 'clock', tags: 'tags', aliases: 'link' };

export function inferType(key, value) {
  if (key === 'tags' || key === 'tag') return 'tags';
  if (key === 'aliases' || key === 'alias') return 'aliases';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'multitext';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return 'datetime';
  return 'text';
}

class ValueSuggest extends AbstractInputSuggest {
  constructor(app, input, key) { super(app, input); this.key = key; }
  getSuggestions(q) {
    const vals = this.key === 'tags' ? Object.keys(this.app.metadataCache.getTags()).map((x) => x.slice(1)) : this.app.metadataCache.getFrontmatterPropertyValuesForKey(this.key);
    const low = q.toLowerCase();
    return vals.filter((v) => v.toLowerCase().includes(low) && v !== q).slice(0, 30);
  }
  renderSuggestion(v, el) { el.setText(v); }
}

export function installPropertiesEditor(app) {
  app.propertyTypeIcon = (type) => TYPE_ICONS[type] || 'type';
  app.propertyTypes = {};
  app.config.read('types.json').then((d) => { app.propertyTypes = d?.types || {}; }).catch(() => {});

  /** Editable widget inside the editor (replaces the YAML block in Live Preview). */
  app.renderPropertiesEditor = (box, view, yamlText, info) => {
    const inner = yamlText.replace(/^---\n/, '').replace(/\n(---|\.\.\.)\s*$/, '');
    let data;
    try { data = parseYaml(inner) || {}; } catch (e) {
      box.addClass('is-invalid');
      box.createDiv({ cls: 'metadata-error', text: t('properties.invalid') });
      const b = box.createEl('button', { text: t('properties.edit-source') });
      b.addEventListener('mousedown', (ev) => { ev.preventDefault(); view.dispatch({ selection: { anchor: 4 } }); view.focus(); });
      return;
    }
    if (typeof data !== 'object' || Array.isArray(data)) data = {};
    const write = (next) => {
      const keys = Object.keys(next);
      const text = keys.length ? `---\n${stringifyYaml(next).trimEnd()}\n---` : '';
      const old = view.state.doc.sliceString(0, yamlText.length);
      if (old !== yamlText) return; // document changed meanwhile
      let to = yamlText.length;
      if (!text && view.state.doc.sliceString(to, to + 1) === '\n') to++;
      view.dispatch({ changes: { from: 0, to, insert: text } });
    };
    box.createDiv({ cls: 'metadata-properties-heading', text: t('properties.title') });
    const list = box.createDiv('metadata-content');
    for (const [key, value] of Object.entries(data)) renderRow(app, list, key, value, info?.file, (k, v, remove, newKey) => {
      const next = { ...data };
      if (remove) delete next[k];
      else if (newKey && newKey !== k) {
        const rebuilt = {};
        for (const [kk, vv] of Object.entries(next)) rebuilt[kk === k ? newKey : kk] = kk === k ? v : vv;
        write(rebuilt);
        return;
      } else next[k] = v;
      write(next);
    });
    const add = box.createDiv({ cls: 'metadata-add-button text-icon-button', attr: { tabindex: 0 } });
    setIcon(add.createSpan('text-button-icon'), 'plus');
    add.createSpan({ cls: 'text-button-label', text: t('properties.add') });
    add.addEventListener('click', async () => {
      const key = await promptDialog(app, { title: t('properties.add'), placeholder: t('properties.name') });
      if (!key || key in data) return;
      write({ ...data, [key.trim()]: '' });
    });
  };

  app.renderPropertiesReadOnly = (box, fm, file) => {
    const list = box.createDiv('metadata-content');
    for (const [key, value] of Object.entries(fm)) {
      const row = list.createDiv({ cls: 'metadata-property', attr: { 'data-property-key': key } });
      const k = row.createDiv('metadata-property-key');
      setIcon(k.createSpan('metadata-property-icon'), TYPE_ICONS[app.propertyTypes[key] || inferType(key, value)] || 'type');
      k.createSpan({ cls: 'metadata-property-key-text', text: key });
      const v = row.createDiv('metadata-property-value');
      const vals = Array.isArray(value) ? value : [value];
      for (const x of vals) {
        if (x === null || x === undefined) continue;
        const s = String(x);
        const link = /^\[\[([^\]]+)\]\]$/.exec(s);
        if (key === 'tags' || key === 'tag') v.createEl('a', { cls: 'tag', text: '#' + s.replace(/^#/, ''), href: '#' });
        else if (link) v.createEl('a', { cls: 'internal-link', text: link[1].split('|').pop(), attr: { 'data-href': link[1].split('|')[0] } });
        else v.createSpan({ cls: 'multi-select-pill-content', text: typeof x === 'boolean' ? (x ? '✓' : '✗') : s });
      }
    }
  };

  app.addPropertyPrompt = async (file) => {
    const key = await promptDialog(app, { title: t('properties.add'), placeholder: t('properties.name') });
    if (!key) return;
    await app.fileManager.processFrontMatter(file, (fm) => { if (!(key in fm)) fm[key] = ''; });
  };
}

function renderRow(app, list, key, value, file, update) {
  const type = app.propertyTypes[key] || inferType(key, value);
  const row = list.createDiv({ cls: 'metadata-property', attr: { 'data-property-key': key, 'data-property-type': type } });
  const keyEl = row.createDiv('metadata-property-key');
  const icon = keyEl.createSpan({ cls: 'metadata-property-icon clickable-icon', attr: { 'aria-label': t(`properties.type.${type}`) } });
  setIcon(icon, TYPE_ICONS[type] || 'type');
  const keyInput = keyEl.createEl('input', { cls: 'metadata-property-key-input', value: key, attr: { spellcheck: 'false' } });
  keyInput.addEventListener('change', () => { const nk = keyInput.value.trim(); if (nk && nk !== key) update(key, value, false, nk); });
  icon.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const m = new Menu();
    for (const ty of ['text', 'multitext', 'number', 'checkbox', 'date', 'datetime']) {
      m.addItem((i) => i.setTitle(t(`properties.type.${ty}`)).setIcon(TYPE_ICONS[ty]).setChecked(ty === type).onClick(() => {
        app.propertyTypes[key] = ty;
        app.config.write('types.json', { types: app.propertyTypes });
        update(key, convert(value, ty));
      }));
    }
    m.addSeparator();
    m.addItem((i) => i.setTitle(t('properties.remove')).setIcon('trash').setWarning(true).onClick(() => update(key, null, true)));
    m.showAtMouseEvent(e);
  });
  const valEl = row.createDiv('metadata-property-value');
  const commit = (v) => update(key, v);
  if (type === 'checkbox') {
    const cb = valEl.createEl('input', { type: 'checkbox', cls: 'metadata-input-checkbox' });
    cb.checked = !!value;
    cb.addEventListener('change', () => commit(cb.checked));
  } else if (type === 'number') {
    const inp = valEl.createEl('input', { type: 'number', cls: 'metadata-input metadata-input-number', value: value ?? '' });
    inp.addEventListener('change', () => commit(inp.value === '' ? null : Number(inp.value)));
  } else if (type === 'date' || type === 'datetime') {
    const inp = valEl.createEl('input', { type: type === 'date' ? 'date' : 'datetime-local', cls: 'metadata-input', value: value ?? '' });
    inp.addEventListener('change', () => commit(inp.value || null));
  } else if (type === 'multitext' || type === 'tags' || type === 'aliases') {
    const vals = Array.isArray(value) ? value.map(String) : value ? String(value).split(',').map((s) => s.trim()) : [];
    const box = valEl.createDiv('multi-select-container');
    for (const v of vals) {
      const pill = box.createDiv('multi-select-pill');
      pill.createSpan({ cls: 'multi-select-pill-content', text: v });
      const x = pill.createSpan('multi-select-pill-remove-button');
      setIcon(x, 'x');
      x.addEventListener('mousedown', (e) => { e.preventDefault(); commit(vals.filter((y) => y !== v)); });
    }
    const inp = box.createEl('input', { cls: 'multi-select-input', attr: { placeholder: t('properties.add-value') } });
    new ValueSuggest(app, inp, key).onSelect((v) => { commit([...vals, v]); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); commit([...vals, inp.value.trim().replace(/^#/, '')]); }
      if (e.key === 'Backspace' && !inp.value && vals.length) commit(vals.slice(0, -1));
    });
  } else {
    const inp = valEl.createDiv({ cls: 'metadata-input-longtext', attr: { contenteditable: 'true', spellcheck: 'false' } });
    inp.setText(value === null || value === undefined ? '' : String(value));
    inp.addEventListener('blur', () => { const v = inp.getText(); if (v !== String(value ?? '')) commit(v); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    new ValueSuggest(app, inp, key).onSelect((v) => commit(v));
    const link = /^\[\[([^\]]+)\]\]$/.exec(String(value ?? ''));
    if (link) {
      const a = valEl.createSpan({ cls: 'metadata-link clickable-icon', attr: { 'aria-label': t('properties.open-link') } });
      setIcon(a, 'external-link');
      a.addEventListener('mousedown', (e) => { e.preventDefault(); app.workspace.openLinkText(link[1].split('|')[0], file?.path || '', 'tab'); });
    }
  }
}

function convert(value, type) {
  const arr = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  switch (type) {
    case 'number': { const n = Number(arr[0]); return Number.isFinite(n) ? n : null; }
    case 'checkbox': return arr[0] === true || arr[0] === 'true';
    case 'multitext': return arr.map(String);
    case 'date': return arr[0] ? String(arr[0]).slice(0, 10) : null;
    case 'datetime': return arr[0] ? String(arr[0]) : null;
    default: return arr.length ? arr.map(String).join(', ') : '';
  }
}
