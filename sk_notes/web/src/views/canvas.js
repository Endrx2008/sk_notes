// Canvas view for .canvas files (JSON Canvas 1.0 open format).

import { resourceUrl } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { isImage, isAudio, isVideo, uid } from '../core/util.js';
import { Component } from '../model/component.js';
import { TFile } from '../model/vault.js';
import { renderSections, postProcess, renderEmbed } from '../render/markdown.js';
import { Menu, setTooltip, promptDialog } from '../ui/kit.js';
import { QuickSwitcher } from '../ui/palette.js';
import { TextFileView } from './base.js';

const PRESET = { 1: 'var(--color-red)', 2: 'var(--color-orange)', 3: 'var(--color-yellow)', 4: 'var(--color-green)', 5: 'var(--color-cyan)', 6: 'var(--color-purple)' };
const colorOf = (c) => (!c ? null : PRESET[c] || c);
const SIDES = ['top', 'right', 'bottom', 'left'];

export class CanvasView extends TextFileView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'canvas';
    this.data = { nodes: [], edges: [] };
    this.contentEl.addClass('canvas-wrapper');
    this.viewport = { x: 0, y: 0, k: 1 };
    this.selection = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.nodeEls = new Map();
    this.comp = new Component();
    this.addChild(this.comp);
    this._build();
  }

  getViewType() { return 'canvas'; }
  canAcceptExtension(ext) { return ext === 'canvas'; }
  getIcon() { return 'canvas'; }

  _build() {
    const c = this.contentEl;
    c.setAttr('tabindex', '0');
    this.boardEl = c.createDiv('canvas');
    this.edgesSvg = this.boardEl.createSvg('svg', { cls: 'canvas-edges' });
    this.nodesEl = this.boardEl.createDiv('canvas-nodes');
    this.marqueeEl = c.createDiv('canvas-selection-box');
    this.marqueeEl.hide();
    // bottom toolbar
    const tb = c.createDiv('canvas-card-menu');
    const tool = (icon, label, fn) => {
      const b = tb.createDiv({ cls: 'canvas-card-menu-button clickable-icon', attr: { 'aria-label': label, 'data-tooltip-position': 'top' } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
    };
    tool('file-text', t('canvas.add-card'), () => this.addText(this._center()));
    tool('file', t('canvas.add-note'), () => this.addFileFromVault(this._center()));
    tool('image', t('canvas.add-media'), () => this.addFileFromVault(this._center(), true));
    tool('globe', t('canvas.add-link'), async () => {
      const url = await promptDialog(this.app, { title: t('canvas.add-link'), placeholder: 'https://' });
      if (url) this.addNode({ type: 'link', url, ...this._center(), width: 400, height: 300 });
    });
    tool('folder', t('canvas.add-group'), () => this.addGroup());
    // right controls
    const ctr = c.createDiv('canvas-controls');
    const ctl = (icon, label, fn) => {
      const b = ctr.createDiv({ cls: 'canvas-control-item clickable-icon', attr: { 'aria-label': label, 'data-tooltip-position': 'left' } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    ctl('zoom-in', t('canvas.zoom-in'), () => this.zoomBy(1.2));
    ctl('zoom-out', t('canvas.zoom-out'), () => this.zoomBy(1 / 1.2));
    ctl('maximize', t('canvas.zoom-fit'), () => this.zoomToFit());
    ctl('refresh', t('canvas.zoom-reset'), () => { this.viewport = { x: 0, y: 0, k: 1 }; this._applyViewport(); });
    ctl('undo', t('canvas.undo'), () => this.undo());
    ctl('redo', t('canvas.redo'), () => this.redo());
    ctl('help', t('canvas.help'), () => this.app.notice(t('canvas.help-text'), 9000));
    this._setupInput();
  }

  // ---------------------------------------------------------------- data
  /** Unchanged canvases are saved back byte for byte (no reformatting). */
  getViewData() { return this._changed || this._origText === undefined ? JSON.stringify(this.data, null, '\t') : this._origText; }

  setViewData(text, clear) {
    this._origText = text;
    this._changed = false;
    let data;
    try { data = JSON.parse(text || '{}'); } catch {
      this.nodesEl.empty();
      this.nodesEl.createDiv({ cls: 'canvas-error', text: t('canvas.invalid') });
      this.readOnly = true;
      return;
    }
    this.readOnly = false;
    data.nodes = Array.isArray(data.nodes) ? data.nodes.filter((n) => n && n.id) : [];
    data.edges = Array.isArray(data.edges) ? data.edges.filter((e) => e && e.id && e.fromNode && e.toNode) : [];
    this.data = data;
    if (clear) { this.undoStack = []; this.redoStack = []; this.selection.clear(); }
    this.render();
    if (clear) requestAnimationFrame(() => this.zoomToFit(true));
  }

  getViewDataForSave() { return this.getViewData(); }

  _commit() {
    this.undoStack.push(this._lastSnapshot ?? JSON.stringify({ nodes: [], edges: [] }));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this._lastSnapshot = JSON.stringify(this.data);
    this._changed = true;
    this.requestSave();
  }

  _snapshotBefore() { this._lastSnapshot = JSON.stringify(this.data); }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.data));
    this.data = JSON.parse(this.undoStack.pop());
    this._lastSnapshot = JSON.stringify(this.data);
    this._changed = true;
    this.render();
    this.requestSave();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.data));
    this.data = JSON.parse(this.redoStack.pop());
    this._lastSnapshot = JSON.stringify(this.data);
    this._changed = true;
    this.render();
    this.requestSave();
  }

  // ---------------------------------------------------------------- nodes
  _center() {
    const r = this.contentEl.getBoundingClientRect();
    const [x, y] = this.toWorld(r.width / 2, r.height / 2);
    return { x: Math.round(x - 125), y: Math.round(y - 60) };
  }

  addNode(node) {
    if (this.readOnly) return null;
    this._snapshotBefore();
    const n = { id: uid(16), width: 250, height: 120, ...node };
    this.data.nodes.push(n);
    this._commit();
    this.render();
    this.select([n.id]);
    return n;
  }

  addText(pos, edit = true) {
    const n = this.addNode({ type: 'text', text: '', ...pos });
    if (n && edit) setTimeout(() => this.editText(n), 30);
  }

  addFileFromVault(pos, media) {
    new QuickSwitcher(this.app, { all: true, onChoose: (file) => {
      const img = isImage(file.extension);
      this.addNode({ type: 'file', file: file.path, ...pos, width: img ? 320 : 400, height: img ? 240 : 400 });
    } }).open();
    void media;
  }

  addGroup() {
    const sel = this.data.nodes.filter((n) => this.selection.has(n.id));
    let box = { x: this._center().x, y: this._center().y, width: 500, height: 400 };
    if (sel.length) {
      const minX = Math.min(...sel.map((n) => n.x)) - 30;
      const minY = Math.min(...sel.map((n) => n.y)) - 50;
      const maxX = Math.max(...sel.map((n) => n.x + n.width)) + 30;
      const maxY = Math.max(...sel.map((n) => n.y + n.height)) + 30;
      box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    this.addNode({ type: 'group', label: t('canvas.group'), ...box });
  }

  deleteSelection() {
    if (!this.selection.size || this.readOnly) return;
    this._snapshotBefore();
    this.data.nodes = this.data.nodes.filter((n) => !this.selection.has(n.id));
    this.data.edges = this.data.edges.filter((e) => !this.selection.has(e.id) && !this.selection.has(e.fromNode) && !this.selection.has(e.toNode));
    this.selection.clear();
    this._commit();
    this.render();
  }

  select(ids, add = false) {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    for (const [id, el] of this.nodeEls) el.toggleClass('is-selected', this.selection.has(id));
    this.edgesSvg.findAll('.canvas-edge').forEach((p) => p.toggleClass('is-selected', this.selection.has(p.getAttr('data-id'))));
  }

  // ---------------------------------------------------------------- rendering
  render() {
    for (const el of this.nodeEls.values()) el.detach();
    this.nodeEls.clear();
    this.comp.unload();
    this.comp.load();
    // groups first (below other nodes)
    const nodes = this.data.nodes.slice().sort((a, b) => (a.type === 'group' ? 0 : 1) - (b.type === 'group' ? 0 : 1));
    for (const n of nodes) this.nodesEl.appendChild(this._renderNode(n));
    this.renderEdges();
    this.select([...this.selection]);
    this._applyViewport();
  }

  _renderNode(n) {
    const el = createDiv({ cls: `canvas-node canvas-node-${n.type}`, attr: { 'data-id': n.id } });
    this.nodeEls.set(n.id, el);
    this._place(el, n);
    const col = colorOf(n.color);
    if (col) el.style.setProperty('--canvas-color', col);
    if (n.color) el.addClass('is-themed');
    const content = el.createDiv('canvas-node-container');
    if (n.type === 'group') {
      el.createDiv({ cls: 'canvas-group-label', text: n.label || '' });
      if (n.background) { content.style.backgroundImage = `url("${resourceUrl(n.background)}")`; content.style.backgroundSize = n.backgroundStyle === 'repeat' ? 'auto' : n.backgroundStyle === 'ratio' ? 'contain' : 'cover'; }
    } else if (n.type === 'text') {
      const box = content.createDiv('canvas-node-content markdown-rendered');
      const secs = renderSections(this.app, n.text || '', box, this.file?.path || '', this.comp);
      postProcess(this.app, secs, this.file?.path || '', this.comp, undefined, n.text || '');
    } else if (n.type === 'file') {
      const file = this.app.vault.getFileByPath(n.file);
      const label = el.createDiv({ cls: 'canvas-node-label', text: file ? file.name : n.file });
      label.addEventListener('dblclick', (e) => { e.stopPropagation(); if (file) this.app.workspace.openFile(file, 'tab'); });
      const box = content.createDiv('canvas-node-content');
      if (!file) box.createDiv({ cls: 'canvas-missing', text: t('canvas.missing-file', { path: n.file }) });
      else if (isImage(file.extension)) box.createEl('img', { attr: { src: resourceUrl(file.path, file.stat.mtime), draggable: 'false' } });
      else if (isAudio(file.extension)) box.createEl('audio', { attr: { controls: true, src: resourceUrl(file.path) } });
      else if (isVideo(file.extension)) box.createEl('video', { attr: { controls: true, src: resourceUrl(file.path) } });
      else if (file.extension === 'md') {
        box.addClass('markdown-rendered');
        const span = box.createSpan({ cls: 'internal-embed', attr: { src: file.path + (n.subpath || '') } });
        renderEmbed(this.app, span, this.file?.path || '', this.comp, 1);
      } else box.createDiv({ cls: 'canvas-file', text: file.name });
    } else if (n.type === 'link') {
      const box = content.createDiv('canvas-node-content canvas-link');
      setIcon(box.createDiv('canvas-link-icon'), 'globe');
      const a = box.createEl('a', { cls: 'external-link', text: n.url, href: n.url });
      a.addEventListener('click', (e) => { e.preventDefault(); this.app.openExternal(n.url); });
      box.createDiv({ cls: 'canvas-link-note', text: t('canvas.link-offline') });
    }
    // resize handle and connection points
    const rh = el.createDiv('canvas-node-resizer');
    rh.addEventListener('mousedown', (e) => this._startResize(e, n));
    for (const side of SIDES) {
      const cp = el.createDiv({ cls: `canvas-node-connection-point mod-${side}` });
      cp.addEventListener('mousedown', (e) => this._startConnect(e, n, side));
    }
    el.addEventListener('mousedown', (e) => this._nodeMouseDown(e, n));
    el.addEventListener('dblclick', (e) => {
      if (n.type === 'text') { e.stopPropagation(); this.editText(n); }
      if (n.type === 'group') { e.stopPropagation(); this.editGroupLabel(n); }
    });
    el.addEventListener('contextmenu', (e) => this._nodeMenu(e, n));
    return el;
  }

  _place(el, n) {
    Object.assign(el.style, { left: n.x + 'px', top: n.y + 'px', width: n.width + 'px', height: n.height + 'px' });
  }

  editText(n) {
    const el = this.nodeEls.get(n.id);
    if (!el) return;
    const box = el.find('.canvas-node-container');
    box.empty();
    const ta = box.createEl('textarea', { cls: 'canvas-node-editor', value: n.text || '' });
    ta.focus();
    el.addClass('is-editing');
    const done = () => {
      el.removeClass('is-editing');
      if (ta.value !== (n.text || '')) {
        this._snapshotBefore();
        n.text = ta.value;
        this._commit();
      }
      this.render();
    };
    ta.addEventListener('blur', done);
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') ta.blur(); });
    ta.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  async editGroupLabel(n) {
    const name = await promptDialog(this.app, { title: t('canvas.group-name'), value: n.label || '' });
    if (name === null) return;
    this._snapshotBefore();
    n.label = name;
    this._commit();
    this.render();
  }

  renderEdges() {
    const svg = this.edgesSvg;
    svg.empty();
    const defs = svg.createSvg('defs');
    const marker = defs.createSvg('marker', { attr: { id: 'skn-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' } });
    marker.createSvg('path', { attr: { d: 'M0 0L10 5L0 10z', fill: 'context-stroke' } });
    const byId = new Map(this.data.nodes.map((n) => [n.id, n]));
    for (const e of this.data.edges) {
      const a = byId.get(e.fromNode);
      const b = byId.get(e.toNode);
      if (!a || !b) continue;
      const fs = e.fromSide || this._autoSide(a, b);
      const ts = e.toSide || this._autoSide(b, a);
      const p1 = this._anchor(a, fs);
      const p2 = this._anchor(b, ts);
      const d = this._bezier(p1, fs, p2, ts);
      const g = svg.createSvg('g', { cls: 'canvas-edge-group' });
      const hit = g.createSvg('path', { cls: 'canvas-edge-hit', attr: { d, 'data-id': e.id } });
      const path = g.createSvg('path', { cls: 'canvas-edge', attr: { d, 'data-id': e.id } });
      const col = colorOf(e.color);
      if (col) path.style.stroke = col;
      if ((e.toEnd || 'arrow') === 'arrow') path.setAttr('marker-end', 'url(#skn-arrow)');
      if (e.fromEnd === 'arrow') path.setAttr('marker-start', 'url(#skn-arrow)');
      if (e.label) {
        const mid = this._mid(p1, fs, p2, ts);
        const txt = g.createSvg('text', { cls: 'canvas-edge-label', attr: { x: mid[0], y: mid[1] } });
        txt.textContent = e.label;
      }
      const pick = (ev) => {
        ev.stopPropagation();
        if (ev.button === 2) return;
        this.select([e.id], ev.shiftKey);
      };
      hit.addEventListener('mousedown', pick);
      hit.addEventListener('contextmenu', (ev) => this._edgeMenu(ev, e));
      hit.addEventListener('dblclick', async (ev) => {
        ev.stopPropagation();
        const label = await promptDialog(this.app, { title: t('canvas.edge-label'), value: e.label || '' });
        if (label === null) return;
        this._snapshotBefore();
        e.label = label || undefined;
        this._commit();
        this.renderEdges();
      });
    }
  }

  _autoSide(a, b) {
    const dx = (b.x + b.width / 2) - (a.x + a.width / 2);
    const dy = (b.y + b.height / 2) - (a.y + a.height / 2);
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
  }

  _anchor(n, side) {
    return { top: [n.x + n.width / 2, n.y], bottom: [n.x + n.width / 2, n.y + n.height], left: [n.x, n.y + n.height / 2], right: [n.x + n.width, n.y + n.height / 2] }[side];
  }

  _dir(side) { return { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[side]; }

  _bezier(p1, s1, p2, s2) {
    const d = Math.max(40, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2.5);
    const [ax, ay] = this._dir(s1);
    const [bx, by] = this._dir(s2);
    return `M${p1[0]} ${p1[1]} C${p1[0] + ax * d} ${p1[1] + ay * d} ${p2[0] + bx * d} ${p2[1] + by * d} ${p2[0]} ${p2[1]}`;
  }

  _mid(p1, s1, p2, s2) {
    const d = Math.max(40, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2.5);
    const [ax, ay] = this._dir(s1);
    const [bx, by] = this._dir(s2);
    const c1 = [p1[0] + ax * d, p1[1] + ay * d];
    const c2 = [p2[0] + bx * d, p2[1] + by * d];
    return [(p1[0] + 3 * c1[0] + 3 * c2[0] + p2[0]) / 8, (p1[1] + 3 * c1[1] + 3 * c2[1] + p2[1]) / 8];
  }

  // ---------------------------------------------------------------- viewport
  toWorld(sx, sy) { return [(sx - this.viewport.x) / this.viewport.k, (sy - this.viewport.y) / this.viewport.k]; }

  _applyViewport() {
    const { x, y, k } = this.viewport;
    this.boardEl.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    this.contentEl.style.backgroundPosition = `${x}px ${y}px`;
    this.contentEl.style.backgroundSize = `${20 * k}px ${20 * k}px`;
    this.contentEl.toggleClass('is-zoomed-out', k < 0.4);
  }

  zoomBy(f, cx, cy) {
    const r = this.contentEl.getBoundingClientRect();
    cx ??= r.width / 2;
    cy ??= r.height / 2;
    const k = Math.clamp(this.viewport.k * f, 0.05, 4);
    const [wx, wy] = this.toWorld(cx, cy);
    this.viewport.k = k;
    this.viewport.x = cx - wx * k;
    this.viewport.y = cy - wy * k;
    this._applyViewport();
  }

  zoomToFit(initial) {
    const ns = this.data.nodes;
    const r = this.contentEl.getBoundingClientRect();
    if (!ns.length || !r.width) { this.viewport = { x: r.width / 2, y: r.height / 2, k: 1 }; this._applyViewport(); return; }
    const minX = Math.min(...ns.map((n) => n.x));
    const minY = Math.min(...ns.map((n) => n.y));
    const maxX = Math.max(...ns.map((n) => n.x + n.width));
    const maxY = Math.max(...ns.map((n) => n.y + n.height));
    const k = Math.clamp(Math.min((r.width - 80) / (maxX - minX || 1), (r.height - 80) / (maxY - minY || 1)), 0.05, initial ? 1 : 2);
    this.viewport = { k, x: r.width / 2 - ((minX + maxX) / 2) * k, y: r.height / 2 - ((minY + maxY) / 2) * k };
    this._applyViewport();
  }

  // ---------------------------------------------------------------- input
  _setupInput() {
    const c = this.contentEl;
    let pan = null;
    let space = false;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || space) this.zoomBy(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
      else { this.viewport.x -= e.deltaX; this.viewport.y -= e.deltaY; this._applyViewport(); }
    }, { passive: false });
    c.addEventListener('mousedown', (e) => {
      if (e.target.closest('.canvas-node, .canvas-card-menu, .canvas-controls, .canvas-edge-hit')) return;
      c.focus();
      const r = c.getBoundingClientRect();
      if (e.button === 1 || space || e.button === 2) {
        pan = { sx: e.clientX, sy: e.clientY, x: this.viewport.x, y: this.viewport.y };
        return;
      }
      // marquee selection
      const start = [e.clientX - r.left, e.clientY - r.top];
      if (!e.shiftKey) this.select([]);
      const mm = (ev) => {
        const cur = [ev.clientX - r.left, ev.clientY - r.top];
        const x = Math.min(start[0], cur[0]); const y = Math.min(start[1], cur[1]);
        const w = Math.abs(cur[0] - start[0]); const h = Math.abs(cur[1] - start[1]);
        Object.assign(this.marqueeEl.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        this.marqueeEl.show();
        const [ax, ay] = this.toWorld(x, y);
        const [bx, by] = this.toWorld(x + w, y + h);
        this.select(this.data.nodes.filter((n) => n.x >= ax && n.y >= ay && n.x + n.width <= bx && n.y + n.height <= by).map((n) => n.id), e.shiftKey);
      };
      const mu = () => { this.marqueeEl.hide(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
    this.registerDomEvent(document, 'mousemove', (e) => {
      if (!pan) return;
      this.viewport.x = pan.x + e.clientX - pan.sx;
      this.viewport.y = pan.y + e.clientY - pan.sy;
      this._applyViewport();
    });
    this.registerDomEvent(document, 'mouseup', () => { pan = null; });
    c.addEventListener('dblclick', (e) => {
      if (e.target.closest('.canvas-node, .canvas-card-menu, .canvas-controls')) return;
      const r = c.getBoundingClientRect();
      const [x, y] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      this.addText({ x: Math.round(x - 125), y: Math.round(y - 30) });
    });
    c.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.canvas-node, .canvas-edge-hit')) return;
      e.preventDefault();
      if (pan && (Math.abs(e.clientX - pan.sx) + Math.abs(e.clientY - pan.sy) > 4)) return;
      const r = c.getBoundingClientRect();
      const [x, y] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      const m = new Menu();
      m.addItem((i) => i.setTitle(t('canvas.add-card')).setIcon('file-text').onClick(() => this.addText({ x, y })));
      m.addItem((i) => i.setTitle(t('canvas.add-note')).setIcon('file').onClick(() => this.addFileFromVault({ x, y })));
      m.addItem((i) => i.setTitle(t('canvas.add-group')).setIcon('folder').onClick(() => this.addGroup()));
      m.showAtMouseEvent(e);
    });
    c.addEventListener('keydown', (e) => {
      if (e.target.closest('textarea, input, [contenteditable]')) return;
      if (e.key === ' ') space = true;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) { e.preventDefault(); this.deleteSelection(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.select(this.data.nodes.map((n) => n.id)); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) this.redo(); else this.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopPropagation(); this.redo(); }
      if (e.key === 'Escape') this.select([]);
    });
    c.addEventListener('keyup', (e) => { if (e.key === ' ') space = false; });
    // drop files from the explorer
    c.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-sk-path')) e.preventDefault(); });
    c.addEventListener('drop', (e) => {
      const path = e.dataTransfer.getData('text/x-sk-path');
      if (!path) return;
      e.preventDefault();
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return;
      const r = c.getBoundingClientRect();
      const [x, y] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      this.addNode({ type: 'file', file: f.path, x: Math.round(x), y: Math.round(y), width: 400, height: isImage(f.extension) ? 260 : 400 });
    });
  }

  _nodeMouseDown(e, n) {
    if (e.button !== 0 || e.target.closest('textarea, .canvas-node-resizer, .canvas-node-connection-point, a, audio, video')) return;
    e.stopPropagation();
    this.contentEl.focus();
    if (!this.selection.has(n.id)) this.select([n.id], e.shiftKey);
    const start = [e.clientX, e.clientY];
    const moving = this.data.nodes.filter((x) => this.selection.has(x.id));
    // dragging a group drags the nodes inside it
    for (const g of moving.filter((x) => x.type === 'group')) {
      for (const x of this.data.nodes) {
        if (x !== g && !moving.includes(x) && x.x >= g.x && x.y >= g.y && x.x + x.width <= g.x + g.width && x.y + x.height <= g.y + g.height) moving.push(x);
      }
    }
    const orig = moving.map((x) => [x.x, x.y]);
    let moved = false;
    this._snapshotBefore();
    const mm = (ev) => {
      const dx = (ev.clientX - start[0]) / this.viewport.k;
      const dy = (ev.clientY - start[1]) / this.viewport.k;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      moved = true;
      moving.forEach((x, i) => { x.x = Math.round(orig[i][0] + dx); x.y = Math.round(orig[i][1] + dy); this._place(this.nodeEls.get(x.id), x); });
      this.renderEdges();
    };
    const mu = () => {
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
      if (moved) this._commit();
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  }

  _startResize(e, n) {
    e.stopPropagation();
    e.preventDefault();
    const start = [e.clientX, e.clientY, n.width, n.height];
    this._snapshotBefore();
    const mm = (ev) => {
      n.width = Math.max(60, Math.round(start[2] + (ev.clientX - start[0]) / this.viewport.k));
      n.height = Math.max(40, Math.round(start[3] + (ev.clientY - start[1]) / this.viewport.k));
      this._place(this.nodeEls.get(n.id), n);
      this.renderEdges();
    };
    const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); this._commit(); };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  }

  _startConnect(e, n, side) {
    e.stopPropagation();
    e.preventDefault();
    const r = this.contentEl.getBoundingClientRect();
    const temp = this.edgesSvg.createSvg('path', { cls: 'canvas-edge mod-temp' });
    const p1 = this._anchor(n, side);
    const mm = (ev) => {
      const [x, y] = this.toWorld(ev.clientX - r.left, ev.clientY - r.top);
      temp.setAttr('d', `M${p1[0]} ${p1[1]} L${x} ${y}`);
    };
    const mu = (ev) => {
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
      temp.detach();
      const targetEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.canvas-node');
      const [x, y] = this.toWorld(ev.clientX - r.left, ev.clientY - r.top);
      let target = targetEl ? this.data.nodes.find((m) => m.id === targetEl.getAttr('data-id')) : null;
      if (!target) {
        // dropping on empty space creates a new card, connected
        this.addText({ x: Math.round(x - 125), y: Math.round(y - 60) }, false);
        target = this.data.nodes[this.data.nodes.length - 1];
      }
      if (!target || target.id === n.id) return;
      this._snapshotBefore();
      const toSide = this._autoSide(target, n);
      this.data.edges.push({ id: uid(16), fromNode: n.id, fromSide: side, toNode: target.id, toSide, toEnd: 'arrow' });
      this._commit();
      this.renderEdges();
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  }

  _colorMenu(m, target, rerender) {
    for (const [k, label] of [['', t('canvas.color-none')], ['1', t('canvas.color-red')], ['2', t('canvas.color-orange')], ['3', t('canvas.color-yellow')],
      ['4', t('canvas.color-green')], ['5', t('canvas.color-cyan')], ['6', t('canvas.color-purple')]]) {
      m.addItem((i) => i.setTitle(label).setChecked((target.color || '') === k).setSection('color').onClick(() => {
        this._snapshotBefore();
        if (k) target.color = k; else delete target.color;
        this._commit();
        rerender();
      }));
    }
  }

  _nodeMenu(e, n) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.selection.has(n.id)) this.select([n.id]);
    const m = new Menu();
    if (n.type === 'text') m.addItem((i) => i.setTitle(t('canvas.edit')).setIcon('pencil').onClick(() => this.editText(n)));
    if (n.type === 'file') {
      const f = this.app.vault.getFileByPath(n.file);
      if (f) m.addItem((i) => i.setTitle(t('file.open-new-tab')).setIcon('file').onClick(() => this.app.workspace.openFile(f, 'tab')));
    }
    if (n.type === 'text') {
      m.addItem((i) => i.setTitle(t('canvas.convert-note')).setIcon('file-plus').onClick(async () => {
        const name = await promptDialog(this.app, { title: t('composer.extract-title'), value: (n.text || '').split('\n')[0].replace(/^#+\s*/, '').slice(0, 50) });
        if (!name) return;
        const f = await this.app.fileManager.createNewMarkdownFile(this.app.fileManager.getNewFileParent(this.file?.path), name, n.text || '');
        this._snapshotBefore();
        n.type = 'file';
        n.file = f.path;
        delete n.text;
        this._commit();
        this.render();
      }));
    }
    if (n.type === 'group') m.addItem((i) => i.setTitle(t('canvas.group-name')).setIcon('pencil').onClick(() => this.editGroupLabel(n)));
    this._colorMenu(m, n, () => this.render());
    m.addItem((i) => i.setTitle(t('common.delete')).setIcon('trash').setWarning(true).setSection('danger').onClick(() => this.deleteSelection()));
    m.showAtMouseEvent(e);
  }

  _edgeMenu(ev, edge) {
    ev.preventDefault();
    ev.stopPropagation();
    const m = new Menu();
    m.addItem((i) => i.setTitle(t('canvas.edge-label')).setIcon('pencil').onClick(async () => {
      const label = await promptDialog(this.app, { title: t('canvas.edge-label'), value: edge.label || '' });
      if (label === null) return;
      this._snapshotBefore();
      edge.label = label || undefined;
      this._commit();
      this.renderEdges();
    }));
    m.addItem((i) => i.setTitle(t('canvas.edge-direction')).setIcon('arrow-right').onClick(() => {
      this._snapshotBefore();
      const both = edge.fromEnd === 'arrow';
      const none = edge.toEnd === 'none';
      if (none) { edge.toEnd = 'arrow'; delete edge.fromEnd; } else if (both) { edge.toEnd = 'none'; delete edge.fromEnd; } else edge.fromEnd = 'arrow';
      this._commit();
      this.renderEdges();
    }));
    this._colorMenu(m, edge, () => this.renderEdges());
    m.addItem((i) => i.setTitle(t('common.delete')).setIcon('trash').setWarning(true).onClick(() => {
      this._snapshotBefore();
      this.data.edges.remove(edge);
      this._commit();
      this.renderEdges();
    }));
    m.showAtMouseEvent(ev);
  }

  onResize() { this._applyViewport(); }
  clear() { this.data = { nodes: [], edges: [] }; }
}

export { setTooltip };
