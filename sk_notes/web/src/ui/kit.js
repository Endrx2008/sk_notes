// UI building blocks: Notice, Menu, Modal, Setting + controls, suggestion popups,
// fuzzy search, tooltips. Written for sk_notes; the class names/signatures follow the
// public plugin API so community plugins can use them too.

import { Component } from '../model/component.js';
import { Scope } from '../model/keymap.js';
import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';

let appRef = null;
export function setKitApp(app) { appRef = app; }

// ------------------------------------------------------------------- Notice
let noticeContainer = null;
export class Notice {
  constructor(message, duration) {
    if (!noticeContainer || !noticeContainer.isConnected) noticeContainer = document.body.createDiv('notice-container');
    this.noticeEl = noticeContainer.createDiv('notice');
    this.containerEl = this.noticeEl;
    this.messageEl = this.noticeEl.createDiv('notice-message');
    this.setMessage(message);
    this.noticeEl.addEventListener('click', () => this.hide());
    const ms = duration === undefined ? 4500 : duration;
    if (ms > 0) this._timer = setTimeout(() => this.hide(), ms);
  }

  setMessage(message) {
    this.messageEl.empty();
    if (message instanceof Node) this.messageEl.appendChild(message);
    else this.messageEl.setText(String(message ?? ''));
    return this;
  }

  hide() {
    clearTimeout(this._timer);
    this.noticeEl.addClass('is-hiding');
    setTimeout(() => this.noticeEl.detach(), 150);
  }
}

// ------------------------------------------------------------------- Tooltip
let tipEl = null;
export function setTooltip(el, text, options = {}) {
  if (!el) return;
  el.setAttr('aria-label', text);
  el.setAttr('data-tooltip-position', options.placement || 'bottom');
  if (options.delay !== undefined) el.setAttr('data-tooltip-delay', options.delay);
}

export function installTooltips() {
  let timer = null;
  let current = null;
  const hide = () => {
    clearTimeout(timer);
    tipEl?.detach();
    current = null;
  };
  document.addEventListener('mouseover', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[aria-label]') : null;
    if (el === current) return;
    hide();
    if (!el || el.matches('input, textarea, [contenteditable]') || el.closest('.cm-content') || el.hasAttribute('data-no-tooltip')) return;
    current = el;
    timer = setTimeout(() => {
      if (!el.isConnected) return;
      const text = el.getAttribute('aria-label');
      if (!text) return;
      tipEl = document.body.createDiv('tooltip', (d) => d.setText(text));
      const r = el.getBoundingClientRect();
      const pos = el.getAttribute('data-tooltip-position') || 'bottom';
      const tr = tipEl.getBoundingClientRect();
      let x = r.left + r.width / 2 - tr.width / 2;
      let y = pos === 'top' ? r.top - tr.height - 6 : pos === 'right' ? r.top + r.height / 2 - tr.height / 2 : r.bottom + 6;
      if (pos === 'right') x = r.right + 6;
      if (pos === 'left') { x = r.left - tr.width - 6; y = r.top + r.height / 2 - tr.height / 2; }
      x = Math.clamp(x, 4, innerWidth - tr.width - 4);
      y = Math.clamp(y, 4, innerHeight - tr.height - 4);
      tipEl.style.left = x + 'px';
      tipEl.style.top = y + 'px';
    }, Number(el.getAttribute('data-tooltip-delay') || 500));
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', hide, true);
}

// ------------------------------------------------------------------- Menu
export class MenuItem {
  constructor(menu) {
    this.menu = menu;
    this.dom = createDiv('menu-item');
    this.iconEl = this.dom.createDiv('menu-item-icon');
    this.titleEl = this.dom.createDiv('menu-item-title');
    this.callback = null;
    this.section = '';
    this.disabled = false;
    this.dom.addEventListener('click', (e) => this.handleEvent(e));
    this.dom.addEventListener('mouseenter', () => menu.select(menu.items.indexOf(this)));
  }

  setTitle(title) { this.titleEl.empty(); if (title instanceof Node) this.titleEl.appendChild(title); else this.titleEl.setText(title); return this; }
  setIcon(icon) { setIcon(this.iconEl, icon); return this; }
  setChecked(checked) {
    this.dom.toggleClass('mod-checked', !!checked);
    if (checked) { this.checkEl ||= this.dom.createDiv('menu-item-checked'); setIcon(this.checkEl, 'check'); } else this.checkEl?.detach();
    return this;
  }
  setDisabled(d) { this.disabled = !!d; this.dom.toggleClass('is-disabled', this.disabled); return this; }
  setIsLabel(v) { this.dom.toggleClass('is-label', !!v); return this; }
  setWarning(v) { this.dom.toggleClass('is-warning', !!v); return this; }
  setSection(s) { this.section = s; return this; }
  onClick(cb) { this.callback = cb; return this; }
  setSubmenu() {
    const sub = new Menu();
    this.submenu = sub;
    this.dom.addClass('has-submenu');
    this.dom.createDiv('menu-item-icon mod-submenu', (el) => setIcon(el, 'chevron-right'));
    this.dom.addEventListener('mouseenter', () => {
      const r = this.dom.getBoundingClientRect();
      this.menu._openSub?.hide();
      this.menu._openSub = sub;
      sub.showAtPosition({ x: r.right - 4, y: r.top }, { parent: this.menu });
    });
    return sub;
  }

  handleEvent(evt) {
    if (this.disabled || this.submenu) return;
    evt.preventDefault?.();
    this.menu.hide();
    try { this.callback?.(evt); } catch (e) { console.error('menu action failed', e); }
  }
}

let openMenu = null;
export class Menu extends Component {
  constructor() {
    super();
    this.dom = createDiv('menu');
    this.scrollEl = this.dom.createDiv('menu-scroll');
    this.items = [];
    this.selected = -1;
    this.scope = new Scope();
    this._onHide = [];
    this._sections = null;
    this.scope.register([], 'ArrowDown', () => { this.select(this._step(1)); return false; });
    this.scope.register([], 'ArrowUp', () => { this.select(this._step(-1)); return false; });
    this.scope.register([], 'Enter', (e) => { this.items[this.selected]?.handleEvent(e); return false; });
    this.scope.register([], 'Escape', () => { this.hide(); return false; });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _step(d) {
    if (!this.items.length) return -1;
    let i = this.selected;
    for (let n = 0; n < this.items.length; n++) {
      i = (i + d + this.items.length) % this.items.length;
      if (!this.items[i].disabled && this.items[i] instanceof MenuItem) return i;
    }
    return this.selected;
  }

  select(i) {
    this.items.forEach((it, n) => it.dom?.toggleClass('selected', n === i));
    this.selected = i;
  }

  setNoIcon() { this.dom.addClass('mod-no-icon'); return this; }
  setUseNativeMenu() { return this; }
  setSectionSubmenu() { return this; }

  addItem(cb) {
    const item = new MenuItem(this);
    this.items.push(item);
    cb(item);
    return this;
  }

  addSeparator() {
    const sep = { dom: createDiv('menu-separator'), disabled: true, isSeparator: true };
    this.items.push(sep);
    return this;
  }

  _render() {
    this.scrollEl.empty();
    // group by section in insertion order of first appearance, separators between groups
    const order = [];
    const groups = new Map();
    for (const it of this.items) {
      const s = it.isSeparator ? `__sep${order.length}` : it.section || '';
      if (!groups.has(s)) { groups.set(s, []); order.push(s); }
      groups.get(s).push(it);
    }
    let first = true;
    for (const s of order) {
      const list = groups.get(s).filter((x) => !x.isSeparator);
      if (!list.length) continue;
      if (!first) this.scrollEl.createDiv('menu-separator');
      first = false;
      for (const it of list) this.scrollEl.appendChild(it.dom);
    }
  }

  showAtMouseEvent(evt) {
    evt.preventDefault?.();
    return this.showAtPosition({ x: evt.clientX, y: evt.clientY });
  }

  showAtPosition(pos, opts = {}) {
    if (!opts.parent) openMenu?.hide();
    if (!opts.parent) openMenu = this;
    this._parent = opts.parent;
    this._render();
    document.body.appendChild(this.dom);
    const r = this.dom.getBoundingClientRect();
    let x = pos.x;
    let y = pos.y;
    if (pos.left) x -= r.width;
    if (x + r.width > innerWidth - 4) x = Math.max(4, (pos.overlap === false && pos.width ? pos.x - r.width : innerWidth - r.width - 4));
    if (y + r.height > innerHeight - 4) y = Math.max(4, innerHeight - r.height - 4);
    this.dom.style.left = x + 'px';
    this.dom.style.top = y + 'px';
    appRef?.keymap.pushScope(this.scope);
    this._outside = (e) => {
      if (!this.dom.contains(e.target) && !(this._openSub && this._openSub.dom.contains(e.target))) this.hide();
    };
    setTimeout(() => document.addEventListener('mousedown', this._outside, true), 0);
    this.load();
    return this;
  }

  hide() {
    if (!this.dom.isConnected) return this;
    this._openSub?.hide();
    this.dom.detach();
    document.removeEventListener('mousedown', this._outside, true);
    appRef?.keymap.popScope(this.scope);
    if (openMenu === this) openMenu = null;
    this._parent?.hide?.();
    this.unload();
    for (const cb of this._onHide) try { cb(); } catch (e) { console.error(e); }
    return this;
  }

  close() { this.hide(); }
  onHide(cb) { this._onHide.push(cb); }

  static forEvent(evt) {
    const m = new Menu();
    m._evt = evt;
    return m;
  }
}

// ------------------------------------------------------------------- Modal
export class Modal {
  constructor(app) {
    this.app = app || appRef;
    this.scope = new Scope(this.app?.scope);
    this.containerEl = createDiv('modal-container mod-dim');
    this.bgEl = this.containerEl.createDiv('modal-bg');
    this.modalEl = this.containerEl.createDiv('modal');
    this.closeButtonEl = this.modalEl.createDiv({ cls: 'modal-close-button', attr: { 'aria-label': t('common.close') } });
    setIcon(this.closeButtonEl, 'x');
    this.headerEl = this.modalEl.createDiv('modal-header');
    this.titleEl = this.headerEl.createDiv('modal-title');
    this.contentEl = this.modalEl.createDiv('modal-content');
    this.shouldRestoreSelection = true;
    this._closeCbs = [];
    this.closeButtonEl.addEventListener('click', () => this.close());
    this.bgEl.addEventListener('click', () => this.close());
    this.scope.register([], 'Escape', () => { this.close(); return false; });
  }

  setTitle(title) { this.titleEl.setText(title); return this; }
  setContent(c) { this.contentEl.empty(); if (c instanceof Node) this.contentEl.appendChild(c); else this.contentEl.setText(c); return this; }
  setCloseCallback(cb) { this._closeCbs.push(cb); return this; }

  open() {
    this._focusBefore = document.activeElement;
    document.body.appendChild(this.containerEl);
    this.app?.keymap.pushScope(this.scope);
    try { this.onOpen(); } catch (e) { console.error('modal onOpen failed', e); }
    if (!this.modalEl.contains(document.activeElement)) {
      const f = this.modalEl.querySelector('input:not([type=checkbox]), textarea, button.mod-cta, [tabindex]');
      (f || this.modalEl).focus?.();
    }
  }

  close() {
    if (!this.containerEl.isConnected) return;
    this.containerEl.detach();
    this.app?.keymap.popScope(this.scope);
    try { this.onClose(); } catch (e) { console.error('modal onClose failed', e); }
    for (const cb of this._closeCbs) try { cb(); } catch (e) { console.error(e); }
    if (this.shouldRestoreSelection && this._focusBefore?.isConnected) this._focusBefore.focus?.();
  }

  onOpen() {}
  onClose() {}
}

// ------------------------------------------------------------------- controls
export class BaseComponent {
  constructor() { this.disabled = false; }
  then(cb) { cb(this); return this; }
  setDisabled(d) { this.disabled = !!d; return this; }
}

export class ValueComponent extends BaseComponent {
  registerOptionListener(listeners, key) {
    listeners[key] = (v) => { if (v !== undefined) this.setValue(v); return this.getValue(); };
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.buttonEl = containerEl.createEl('button');
    this.buttonEl.addEventListener('click', (e) => { if (!this.disabled) this._cb?.(e); });
  }
  setButtonText(s) { this.buttonEl.setText(s); return this; }
  setIcon(i) { setIcon(this.buttonEl, i); this.buttonEl.addClass('mod-icon'); return this; }
  setTooltip(s, o) { setTooltip(this.buttonEl, s, o); return this; }
  setCta() { this.buttonEl.addClass('mod-cta'); return this; }
  removeCta() { this.buttonEl.removeClass('mod-cta'); return this; }
  setWarning() { this.buttonEl.addClass('mod-warning'); return this; }
  setClass(c) { this.buttonEl.addClass(c); return this; }
  setDisabled(d) { super.setDisabled(d); this.buttonEl.disabled = !!d; return this; }
  onClick(cb) { this._cb = cb; return this; }
}

export class ExtraButtonComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.extraSettingsEl = containerEl.createDiv('clickable-icon extra-setting-button');
    setIcon(this.extraSettingsEl, 'settings');
    this.extraSettingsEl.addEventListener('click', (e) => { if (!this.disabled) this._cb?.(e); });
  }
  setIcon(i) { setIcon(this.extraSettingsEl, i); return this; }
  setTooltip(s, o) { setTooltip(this.extraSettingsEl, s, o); return this; }
  setDisabled(d) { super.setDisabled(d); this.extraSettingsEl.toggleClass('is-disabled', !!d); return this; }
  onClick(cb) { this._cb = cb; return this; }
}

export class ToggleComponent extends ValueComponent {
  constructor(containerEl) {
    super();
    this.toggleEl = containerEl.createDiv('checkbox-container');
    this.inputEl = this.toggleEl.createEl('input', { type: 'checkbox', attr: { tabindex: 0 } });
    this.value = false;
    this.toggleEl.addEventListener('click', (e) => { e.preventDefault(); if (!this.disabled) this.onClick(); });
    this.inputEl.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.onClick(); } });
  }
  getValue() { return this.value; }
  setValue(v) {
    const changed = this.value !== !!v;
    this.value = !!v;
    this.toggleEl.toggleClass('is-enabled', this.value);
    this.inputEl.checked = this.value;
    if (changed) this._cb?.(this.value);
    return this;
  }
  setTooltip(s, o) { setTooltip(this.toggleEl, s, o); return this; }
  setDisabled(d) { super.setDisabled(d); this.toggleEl.toggleClass('is-disabled', !!d); return this; }
  onClick() { this.setValue(!this.value); }
  onChange(cb) { this._cb = cb; return this; }
}

class InputBase extends ValueComponent {
  constructor(el) {
    super();
    this.inputEl = el;
    el.addEventListener('input', () => this._cb?.(this.getValue()));
  }
  getValue() { return this.inputEl.value; }
  setValue(v) { this.inputEl.value = v ?? ''; return this; }
  setPlaceholder(p) { this.inputEl.placeholder = p; return this; }
  setDisabled(d) { super.setDisabled(d); this.inputEl.disabled = !!d; return this; }
  onChange(cb) { this._cb = cb; return this; }
  onChanged() { this._cb?.(this.getValue()); }
}

export class TextComponent extends InputBase {
  constructor(containerEl) { super(containerEl.createEl('input', { type: 'text', attr: { spellcheck: 'false' } })); }
}
export class TextAreaComponent extends InputBase {
  constructor(containerEl) { super(containerEl.createEl('textarea')); }
}
export class SearchComponent extends InputBase {
  constructor(containerEl) {
    const wrap = containerEl.createDiv('search-input-container');
    super(wrap.createEl('input', { type: 'search', attr: { enterkeyhint: 'search', spellcheck: 'false' } }));
    this.containerEl = wrap;
    this.clearButtonEl = wrap.createDiv({ cls: 'search-input-clear-button', attr: { 'aria-label': t('common.clear') } });
    this.clearButtonEl.addEventListener('click', () => { this.setValue(''); this.onChanged(); this.inputEl.focus(); });
    this.inputEl.addEventListener('input', () => wrap.toggleClass('has-value', !!this.inputEl.value));
  }
  setValue(v) { super.setValue(v); this.containerEl.toggleClass('has-value', !!v); return this; }
  setClass(c) { this.containerEl.addClass(c); return this; }
}
export class MomentFormatComponent extends TextComponent {
  setDefaultFormat(f) { this.defaultFormat = f; this.setPlaceholder(f); return this; }
  setSampleEl(el) {
    this.sampleEl = el;
    const upd = () => el.setText(window.moment().format(this.getValue() || this.defaultFormat || ''));
    this.inputEl.addEventListener('input', upd);
    upd();
    return this;
  }
}

export class DropdownComponent extends ValueComponent {
  constructor(containerEl) {
    super();
    this.selectEl = containerEl.createEl('select', 'dropdown');
    this.selectEl.addEventListener('change', () => this._cb?.(this.selectEl.value));
  }
  addOption(value, display) { this.selectEl.createEl('option', { value, text: display }); return this; }
  addOptions(o) { for (const [k, v] of Object.entries(o)) this.addOption(k, v); return this; }
  getValue() { return this.selectEl.value; }
  setValue(v) { this.selectEl.value = v; return this; }
  setDisabled(d) { super.setDisabled(d); this.selectEl.disabled = !!d; return this; }
  onChange(cb) { this._cb = cb; return this; }
}

export class SliderComponent extends ValueComponent {
  constructor(containerEl) {
    super();
    this.sliderEl = containerEl.createEl('input', { type: 'range', cls: 'slider' });
    this.sliderEl.addEventListener('input', () => { this._tip(); if (this.instant) this._cb?.(this.getValue()); });
    this.sliderEl.addEventListener('change', () => this._cb?.(this.getValue()));
    this.instant = true;
  }
  _tip() { if (this._dyn) setTooltip(this.sliderEl, String(this.getValue())); }
  setLimits(min, max, step) { this.sliderEl.min = min ?? ''; this.sliderEl.max = max ?? ''; this.sliderEl.step = step === 'any' ? 'any' : step ?? 1; return this; }
  setInstant(v) { this.instant = !!v; return this; }
  setDynamicTooltip() { this._dyn = true; this._tip(); return this; }
  showTooltip() { return this; }
  getValue() { return Number(this.sliderEl.value); }
  getValuePretty() { return String(this.getValue()); }
  setValue(v) { this.sliderEl.value = String(v); this._tip(); return this; }
  setDisabled(d) { super.setDisabled(d); this.sliderEl.disabled = !!d; return this; }
  onChange(cb) { this._cb = cb; return this; }
}

export class ColorComponent extends ValueComponent {
  constructor(containerEl) {
    super();
    this.colorPickerEl = containerEl.createEl('input', { type: 'color' });
    this.colorPickerEl.addEventListener('input', () => this._cb?.(this.getValue()));
  }
  getValue() { return this.colorPickerEl.value; }
  setValue(v) { this.colorPickerEl.value = v; return this; }
  getValueRgb() { const h = this.getValue().slice(1); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; }
  setValueRgb({ r, g, b }) { return this.setValue('#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')); }
  getValueHsl() { return { h: 0, s: 0, l: 0 }; }
  setValueHsl() { return this; }
  onChange(cb) { this._cb = cb; return this; }
}

export class ProgressBarComponent extends ValueComponent {
  constructor(containerEl) {
    super();
    this.progressBar = containerEl.createDiv('setting-progress-bar');
    this.lineEl = this.progressBar.createDiv('setting-progress-bar-inner');
    this.value = 0;
  }
  getValue() { return this.value; }
  setValue(v) { this.value = v; this.lineEl.style.width = Math.clamp(v, 0, 100) + '%'; return this; }
}

export class Setting {
  constructor(containerEl) {
    this.settingEl = containerEl.createDiv('setting-item');
    this.infoEl = this.settingEl.createDiv('setting-item-info');
    this.nameEl = this.infoEl.createDiv('setting-item-name');
    this.descEl = this.infoEl.createDiv('setting-item-description');
    this.controlEl = this.settingEl.createDiv('setting-item-control');
    this.components = [];
  }
  setName(n) { this.nameEl.empty(); if (n instanceof Node) this.nameEl.appendChild(n); else this.nameEl.setText(n); return this; }
  setDesc(d) { this.descEl.empty(); if (d instanceof Node) this.descEl.appendChild(d); else this.descEl.setText(d); return this; }
  setClass(c) { this.settingEl.addClass(c); return this; }
  setTooltip(s, o) { setTooltip(this.nameEl, s, o); return this; }
  setHeading() { this.settingEl.addClass('setting-item-heading'); return this; }
  setDisabled(d) { this.settingEl.toggleClass('is-disabled', !!d); this.components.forEach((c) => c.setDisabled(d)); return this; }
  _add(C, cb) { const c = new C(this.controlEl); this.components.push(c); cb?.(c); return this; }
  addButton(cb) { return this._add(ButtonComponent, cb); }
  addExtraButton(cb) { return this._add(ExtraButtonComponent, cb); }
  addToggle(cb) { return this._add(ToggleComponent, cb); }
  addText(cb) { return this._add(TextComponent, cb); }
  addSearch(cb) { return this._add(SearchComponent, cb); }
  addTextArea(cb) { return this._add(TextAreaComponent, cb); }
  addMomentFormat(cb) { return this._add(MomentFormatComponent, cb); }
  addDropdown(cb) { return this._add(DropdownComponent, cb); }
  addColorPicker(cb) { return this._add(ColorComponent, cb); }
  addProgressBar(cb) { return this._add(ProgressBarComponent, cb); }
  addSlider(cb) { return this._add(SliderComponent, cb); }
  addComponent(cb) { const c = cb(this.controlEl); if (c) this.components.push(c); return this; }
  then(cb) { cb(this); return this; }
}

export class SettingGroup {
  constructor(containerEl) {
    this.containerEl = containerEl.createDiv('setting-group');
    this.headerEl = this.containerEl.createDiv('setting-group-heading');
    this.listEl = this.containerEl.createDiv('setting-items');
  }
  setHeading(h) { this.headerEl.setText(h); return this; }
  addSetting(cb) { const s = new Setting(this.listEl); cb(s); return this; }
  addClass(c) { this.containerEl.addClass(c); return this; }
}

// ------------------------------------------------------------------- fuzzy search
export function prepareFuzzySearch(query) {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const words = q.split(' ').filter(Boolean);
  return (text) => {
    if (!words.length) return { score: 0, matches: [] };
    const low = text.toLowerCase();
    const matches = [];
    let score = 0;
    let from = 0;
    for (const w of words) {
      // contiguous match first, otherwise characters in order
      const idx = low.indexOf(w, 0);
      if (idx !== -1) {
        matches.push([idx, idx + w.length]);
        score += (idx === 0 || /[\s/_\-.]/.test(low[idx - 1]) ? 2 : 1) * w.length - idx * 0.01;
        from = idx + w.length;
        continue;
      }
      let pos = from;
      let gaps = 0;
      for (const ch of w) {
        const i = low.indexOf(ch, pos);
        if (i === -1) return null;
        if (i > pos) gaps++;
        matches.push([i, i + 1]);
        pos = i + 1;
      }
      from = pos;
      score += w.length * 0.5 - gaps * 0.3;
    }
    matches.sort((a, b) => a[0] - b[0]);
    return { score: score - text.length * 0.002, matches };
  };
}

export function prepareSimpleSearch(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    const low = text.toLowerCase();
    const matches = [];
    for (const w of words) {
      const i = low.indexOf(w);
      if (i === -1) return null;
      matches.push([i, i + w.length]);
    }
    return { score: -text.length * 0.001, matches };
  };
}

export function fuzzySearch(q, text) { return q(text); }

export function renderMatches(el, text, matches, offset = 0) {
  if (!matches || !matches.length) { el.appendText(text); return; }
  let pos = 0;
  for (const [a0, b0] of matches) {
    const a = a0 - offset;
    const b = b0 - offset;
    if (b <= 0 || a >= text.length) continue;
    const s = Math.max(a, pos);
    if (s > pos) el.appendText(text.slice(pos, s));
    if (b > s) el.createSpan({ cls: 'suggestion-highlight', text: text.slice(s, b) });
    pos = Math.max(pos, b);
  }
  if (pos < text.length) el.appendText(text.slice(pos));
}

export function renderResults(el, text, result, offset) { renderMatches(el, text, result?.matches, offset); }

export function sortSearchResults(results) {
  results.sort((a, b) => b.match.score - a.match.score);
}

// ------------------------------------------------------------------- suggestions
class Chooser {
  constructor(owner, containerEl, scope) {
    this.owner = owner;
    this.containerEl = containerEl;
    this.values = [];
    this.suggestions = [];
    this.selectedItem = 0;
    scope.register([], 'ArrowDown', (e) => { if (!e.isComposing) { this.setSelectedItem(this.selectedItem + 1, true); return false; } });
    scope.register([], 'ArrowUp', (e) => { if (!e.isComposing) { this.setSelectedItem(this.selectedItem - 1, true); return false; } });
    scope.register(['Mod'], 'J', () => { this.setSelectedItem(this.selectedItem + 1, true); return false; });
    scope.register(['Mod'], 'K', () => { this.setSelectedItem(this.selectedItem - 1, true); return false; });
    scope.register([], 'Enter', (e) => { if (!e.isComposing) { this.useSelectedItem(e); return false; } });
  }

  setSuggestions(values) {
    this.containerEl.empty();
    this.values = values || [];
    this.suggestions = this.values.map((v, i) => {
      const el = this.containerEl.createDiv('suggestion-item');
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', (e) => { this.setSelectedItem(i, false); this.useSelectedItem(e); });
      el.addEventListener('mousemove', () => this.setSelectedItem(i, false));
      try { this.owner.renderSuggestion(v, el); } catch (e) { console.error(e); }
      return el;
    });
    this.setSelectedItem(0, false);
  }

  setSelectedItem(i, scroll) {
    const n = this.suggestions.length;
    if (!n) { this.selectedItem = 0; return; }
    i = ((i % n) + n) % n;
    this.suggestions[this.selectedItem]?.removeClass('is-selected');
    this.selectedItem = i;
    const el = this.suggestions[i];
    el.addClass('is-selected');
    if (scroll) el.scrollIntoView({ block: 'nearest' });
    this.owner.onSelectedChange?.(this.values[i], el);
  }

  useSelectedItem(evt) {
    const v = this.values[this.selectedItem];
    if (v === undefined) return false;
    this.owner.selectSuggestion(v, evt);
    return true;
  }
}

export class SuggestModal extends Modal {
  constructor(app) {
    super(app);
    this.limit = 100;
    this.emptyStateText = t('suggest.no-results');
    this.modalEl.addClass('prompt');
    this.modalEl.empty();
    this.inputEl = this.modalEl.createEl('input', { cls: 'prompt-input', attr: { enterkeyhint: 'done', spellcheck: 'false' } });
    this.resultContainerEl = this.modalEl.createDiv('prompt-results');
    this.instructionsEl = this.modalEl.createDiv('prompt-instructions');
    this.chooser = new Chooser(this, this.resultContainerEl, this.scope);
    this.inputEl.addEventListener('input', () => this.onInput());
    this.containerEl.removeClass('mod-dim');
  }

  setPlaceholder(p) { this.inputEl.placeholder = p; }
  setInstructions(list) {
    this.instructionsEl.empty();
    for (const i of list) {
      const el = this.instructionsEl.createDiv('prompt-instruction');
      el.createSpan({ cls: 'prompt-instruction-command', text: i.command });
      el.createSpan({ text: i.purpose });
    }
  }

  onOpen() { this.inputEl.focus(); this.onInput(); }
  onInput() { this.updateSuggestions(); }

  updateSuggestions() {
    const q = this.inputEl.value;
    const res = this.getSuggestions(q);
    const apply = (list) => {
      if (q !== this.inputEl.value) return;
      list = (list || []).slice(0, this.limit);
      if (!list.length) {
        this.chooser.setSuggestions([]);
        if (this.emptyStateText) this.resultContainerEl.createDiv({ cls: 'suggestion-empty', text: this.emptyStateText });
        this.onNoSuggestion?.();
        return;
      }
      this.chooser.setSuggestions(list);
    };
    if (res && typeof res.then === 'function') res.then(apply); else apply(res);
  }

  selectSuggestion(v, evt) {
    this.close();
    this.onChooseSuggestion(v, evt);
  }

  selectActiveSuggestion(evt) { this.chooser.useSelectedItem(evt); }

  getSuggestions() { return []; }
  renderSuggestion(v, el) { el.setText(String(v)); }
  onChooseSuggestion() {}
}

export class FuzzySuggestModal extends SuggestModal {
  getSuggestions(query) {
    const fuzzy = prepareFuzzySearch(query);
    const out = [];
    for (const item of this.getItems()) {
      const m = query ? fuzzy(this.getItemText(item)) : { score: 0, matches: [] };
      if (m) out.push({ item, match: m });
    }
    if (query) sortSearchResults(out);
    return out;
  }
  renderSuggestion(r, el) { renderResults(el, this.getItemText(r.item), r.match); }
  onChooseSuggestion(r, evt) { this.onChooseItem(r.item, evt); }
  getItems() { return []; }
  getItemText(item) { return String(item); }
  onChooseItem() {}
}

/** Floating suggestion list anchored somewhere (used by editor and input suggests). */
export class PopoverSuggest {
  constructor(app, scope) {
    this.app = app || appRef;
    this.scope = scope || new Scope(this.app?.scope);
    this.suggestEl = createDiv('suggestion-container');
    this.suggestionsEl = this.suggestEl.createDiv('suggestion');
    this.suggestEl.addEventListener('mousedown', (e) => e.preventDefault());
    this.suggestions = new Chooser(this, this.suggestionsEl, this.scope);
    this.scope.register([], 'Escape', () => { this.close(); return false; });
    this.isOpen = false;
  }

  open() {
    if (this.isOpen) return;
    document.body.appendChild(this.suggestEl);
    this.app?.keymap.pushScope(this.scope);
    this.isOpen = true;
  }

  close() {
    if (!this.isOpen) return;
    this.suggestEl.detach();
    this.app?.keymap.popScope(this.scope);
    this.isOpen = false;
  }

  reposition(rect) {
    const r = this.suggestEl.getBoundingClientRect();
    let x = rect.left;
    let y = rect.bottom + 4;
    if (y + r.height > innerHeight - 4) y = Math.max(4, rect.top - r.height - 4);
    if (x + r.width > innerWidth - 4) x = Math.max(4, innerWidth - r.width - 4);
    this.suggestEl.style.left = x + 'px';
    this.suggestEl.style.top = y + 'px';
  }

  selectSuggestion(v, evt) { this.selectSuggestionImpl?.(v, evt); }
  renderSuggestion(v, el) { el.setText(String(v)); }
}

export class AbstractInputSuggest extends PopoverSuggest {
  constructor(app, textInputEl) {
    super(app);
    this.textInputEl = textInputEl;
    this.limit = 100;
    this._onSelect = null;
    const update = async () => {
      const q = this.getValue();
      const list = await this.getSuggestions(q);
      if (!list || !list.length || document.activeElement !== textInputEl) { this.close(); return; }
      this.open();
      this.suggestions.setSuggestions(list.slice(0, this.limit));
      this.reposition(textInputEl.getBoundingClientRect());
    };
    textInputEl.addEventListener('input', update);
    textInputEl.addEventListener('focus', update);
    textInputEl.addEventListener('blur', () => setTimeout(() => this.close(), 100));
  }

  getValue() { return this.textInputEl.isContentEditable ? this.textInputEl.textContent : this.textInputEl.value; }
  setValue(v) {
    if (this.textInputEl.isContentEditable) this.textInputEl.textContent = v; else this.textInputEl.value = v;
  }
  onSelect(cb) { this._onSelect = cb; return this; }
  selectSuggestion(v, evt) {
    this._onSelect?.(v, evt);
    this.selectSuggestionImpl?.(v, evt);
    this.close();
  }
  getSuggestions() { return []; }
}

// ------------------------------------------------------------------- confirm dialog
export function confirmDialog(app, { title, message, confirm, cancel, warning = false }) {
  return new Promise((resolve) => {
    const m = new Modal(app);
    let result = false;
    m.setTitle(title);
    m.contentEl.createEl('p', { text: message });
    const row = m.contentEl.createDiv('modal-button-container');
    const ok = new ButtonComponent(row).setButtonText(confirm || t('common.ok')).onClick(() => { result = true; m.close(); });
    if (warning) ok.setWarning(); else ok.setCta();
    new ButtonComponent(row).setButtonText(cancel || t('common.cancel')).onClick(() => m.close());
    m.onClose = () => resolve(result);
    m.open();
    ok.buttonEl.focus();
  });
}

export function promptDialog(app, { title, value = '', placeholder = '', confirm }) {
  return new Promise((resolve) => {
    const m = new Modal(app);
    let result = null;
    m.setTitle(title);
    const input = new TextComponent(m.contentEl).setValue(value).setPlaceholder(placeholder);
    input.inputEl.addClass('modal-wide-input');
    const row = m.contentEl.createDiv('modal-button-container');
    const done = () => { result = input.getValue(); m.close(); };
    new ButtonComponent(row).setButtonText(confirm || t('common.ok')).setCta().onClick(done);
    new ButtonComponent(row).setButtonText(t('common.cancel')).onClick(() => m.close());
    m.scope.register([], 'Enter', () => { done(); return false; });
    m.onClose = () => resolve(result);
    m.open();
    input.inputEl.focus();
    input.inputEl.select();
  });
}
