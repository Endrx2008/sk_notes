// Drawings on a board: a card that is a picture drawn by hand (finger, pen or mouse), with words
// and shapes placed on it and moved around like the stickers of a phone's stories.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A drawing is a plain SVG file of the vault (attachment folder), put on the board as a normal
// file card: Obsidian and every other app show it as a picture. The strokes and the items (text,
// circle, rectangle, triangle, heart) are also kept inside the SVG (<metadata id="sk-drawing">),
// so sk_notes can open it again and go on drawing or moving things.
//
// Items: tap one to choose it (with the hand tool, chosen by itself after adding an item); drag it
// to move it; the square handle at a corner stretches it (a square becomes a rectangle); the round
// handle above turns it; two fingers on the sheet make the chosen item bigger, smaller and turn it.
// A double tap on a text changes the words.

import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { Modal, promptDialog } from '../ui/kit.js';

// the colours are the user's own: fixed values, no theme changes them
export const PEN_COLORS = ['#111111', '#ffffff', '#e5484d', '#f08c2e', '#e3b341', '#39d353', '#3fc1c9', '#3b82f6', '#b98bf0'];
const WIDTHS = [2, 5, 12];
const W = 1200;
const H = 900;
const SHAPES = ['circle', 'rect', 'triangle', 'heart'];
const HANDLE = 22; // size of the handles, in sheet pixels at the size the sheet is shown

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (v) => Math.round(v * 10) / 10;

/** Is this SVG text a drawing made here? */
export function isDrawing(text) { return /<metadata id="sk-drawing">/.test(String(text || '')); }

/** The strokes and items kept in a drawing (an empty one for anything else). */
export function readDrawing(text) {
  const m = /<metadata id="sk-drawing">([\s\S]*?)<\/metadata>/.exec(String(text || ''));
  if (!m) return { width: W, height: H, strokes: [], items: [] };
  try {
    const raw = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const d = JSON.parse(raw);
    return { width: Number(d.width) || W, height: Number(d.height) || H, background: d.background || '',
      strokes: Array.isArray(d.strokes) ? d.strokes : [], items: Array.isArray(d.items) ? d.items.filter((it) => it && it.type) : [] };
  } catch { return { width: W, height: H, strokes: [], items: [] }; }
}

/** SVG path of a stroke (points smoothed with quadratic curves). */
function pathOf(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M${r1(points[0][0])} ${r1(points[0][1])}l0.1 0`;
  let d = `M${r1(points[0][0])} ${r1(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${r1(x)} ${r1(y)} ${r1((x + nx) / 2)} ${r1((y + ny) / 2)}`;
  }
  const last = points[points.length - 1];
  return d + `L${r1(last[0])} ${r1(last[1])}`;
}

/** The outline of a shape around (0, 0), w × h (the item is moved and turned by a transform). */
function shapePath(type, w, h) {
  const a = w / 2;
  const b = h / 2;
  if (type === 'circle') return `M${r1(-a)} 0A${r1(a)} ${r1(b)} 0 1 0 ${r1(a)} 0A${r1(a)} ${r1(b)} 0 1 0 ${r1(-a)} 0Z`;
  if (type === 'rect') return `M${r1(-a)} ${r1(-b)}H${r1(a)}V${r1(b)}H${r1(-a)}Z`;
  if (type === 'triangle') return `M0 ${r1(-b)}L${r1(a)} ${r1(b)}L${r1(-a)} ${r1(b)}Z`;
  if (type === 'heart') {
    const X = (k) => r1(k * w);
    const Y = (k) => r1(k * h);
    return `M0 ${Y(0.45)}C${X(-0.5)} ${Y(0.1)} ${X(-0.56)} ${Y(-0.3)} ${X(-0.26)} ${Y(-0.44)}C${X(-0.1)} ${Y(-0.5)} 0 ${Y(-0.4)} 0 ${Y(-0.26)}`
      + `C0 ${Y(-0.4)} ${X(0.1)} ${Y(-0.5)} ${X(0.26)} ${Y(-0.44)}C${X(0.56)} ${Y(-0.3)} ${X(0.5)} ${Y(0.1)} 0 ${Y(0.45)}Z`;
  }
  return '';
}

const FONT = '700 {size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** The SVG file of a drawing. */
export function writeDrawing(d) {
  const items = d.items || [];
  const meta = esc(JSON.stringify({ width: d.width, height: d.height, background: d.background || '', strokes: d.strokes, items }));
  const bg = d.background ? `<rect width="100%" height="100%" fill="${esc(d.background)}"/>` : '';
  const paths = d.strokes.map((s) => `<path d="${pathOf(s.points)}" stroke="${esc(s.color)}" stroke-width="${s.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join('\n');
  const els = items.map((it) => {
    const tr = `transform="translate(${r1(it.x)} ${r1(it.y)}) rotate(${r1((it.rot || 0) * 180 / Math.PI)})"`;
    if (it.type === 'text') {
      const lines = String(it.text || '').split('\n');
      const size = r1(it.h / Math.max(1, lines.length) / 1.2);
      const tspans = lines.map((ln, i) => `<tspan x="0" y="${r1((i - (lines.length - 1) / 2) * size * 1.2)}">${esc(ln)}</tspan>`).join('');
      return `<text ${tr} font-family="system-ui, sans-serif" font-weight="700" font-size="${size}" fill="${esc(it.color)}" text-anchor="middle" dominant-baseline="central">${tspans}</text>`;
    }
    const fill = it.fill ? esc(it.color) : 'none';
    return `<path ${tr} d="${shapePath(it.type, it.w, it.h)}" stroke="${esc(it.color)}" stroke-width="${it.width || 5}" fill="${fill}" stroke-linejoin="round"/>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}">\n<metadata id="sk-drawing">${meta}</metadata>\n${bg}\n${paths}\n${els}\n</svg>\n`;
}

export function emptyDrawing() { return writeDrawing({ width: W, height: H, background: '#ffffff', strokes: [], items: [] }); }

/** The sheet to draw on. onSave(svgText) is called when the user is done. */
export class DrawingModal extends Modal {
  constructor(app, text, onSave) {
    super(app);
    this.data = readDrawing(text);
    if (!isDrawing(text)) this.data.background = '#ffffff';
    this.onSave = onSave;
    this.color = PEN_COLORS[0];
    this.width = WIDTHS[1];
    this.tool = 'pen';
    this.fill = false;
    this.selected = null; // the chosen item
    this.past = [];
    this.future = [];
    this.changed = false;
    this.modalEl.addClass('mod-drawing');
  }

  onOpen() {
    this.titleEl.setText(t('drawing.title'));
    const c = this.contentEl;
    const bar = c.createDiv('drawing-toolbar');
    const btn = (parent, icon, label, fn, cls = '') => {
      const b = parent.createDiv({ cls: `drawing-tool clickable-icon ${cls}`, attr: { 'aria-label': label, role: 'button' } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    this.penBtn = btn(bar, 'pencil', t('drawing.pen'), () => this._tool('pen'));
    this.eraserBtn = btn(bar, 'eraser', t('drawing.eraser'), () => this._tool('eraser'));
    this.moveBtn = btn(bar, 'hand', t('drawing.move'), () => this._tool('move'));
    bar.createDiv('drawing-sep');
    btn(bar, 'type', t('drawing.text'), () => this._addText());
    for (const s of SHAPES) btn(bar, `shape-${s}`, t(`drawing.shape-${s}`), () => this._addShape(s));
    this.fillBtn = btn(bar, 'paint-bucket', t('drawing.fill'), () => {
      this.fill = !this.fill;
      if (this.selected && this.selected.type !== 'text') { this._before(); this.selected.fill = this.fill; this._redraw(); }
      this._sync();
    });
    bar.createDiv('drawing-sep');
    this.widthBtns = WIDTHS.map((w) => {
      const b = bar.createDiv({ cls: 'drawing-width', attr: { 'aria-label': t('drawing.width'), role: 'button' } });
      b.createDiv({ cls: 'drawing-width-dot' }).style.setProperty('--w', `${Math.min(18, w + 2)}px`);
      b.addEventListener('click', () => {
        this.width = w;
        if (this.selected && this.selected.type !== 'text') { this._before(); this.selected.width = w; this._redraw(); }
        this._sync();
      });
      return [b, w];
    });
    bar.createDiv('drawing-sep');
    const setColor = (col) => {
      this.color = col;
      if (this.selected) { this._before(); this.selected.color = col; this._redraw(); } else if (this.tool !== 'move') this._tool('pen');
      this._sync();
    };
    this.swatches = PEN_COLORS.map((col) => {
      const s = bar.createDiv({ cls: 'drawing-swatch', attr: { role: 'button', 'aria-label': col } });
      s.style.setProperty('--swatch', col);
      s.addEventListener('click', () => setColor(col));
      return [s, col];
    });
    const custom = bar.createEl('input', { cls: 'drawing-custom', attr: { type: 'color', value: '#e05c00', 'aria-label': t('graph.color-custom') } });
    custom.addEventListener('change', () => setColor(custom.value));
    bar.createDiv('drawing-sep');
    btn(bar, 'undo', t('canvas.undo'), () => this._undo());
    btn(bar, 'redo', t('canvas.redo'), () => this._redo());
    this.deleteBtn = btn(bar, 'x', t('drawing.delete-item'), () => this._deleteSelected(), 'mod-delete');
    btn(bar, 'trash', t('drawing.clear'), () => {
      if (!this.data.strokes.length && !this.data.items.length) return;
      this._before();
      this.data.strokes = [];
      this.data.items = [];
      this.selected = null;
      this._redraw();
      this._sync();
    });

    const box = c.createDiv('drawing-box');
    this.canvas = box.createEl('canvas', { cls: 'drawing-canvas' });
    this.canvas.width = this.data.width;
    this.canvas.height = this.data.height;
    this.ctx = this.canvas.getContext('2d');
    this._input();
    const foot = c.createDiv('modal-button-container');
    const cancel = foot.createEl('button', { text: t('common.cancel') });
    cancel.addEventListener('click', () => { this.changed = false; this.close(); });
    const ok = foot.createEl('button', { cls: 'mod-cta', text: t('drawing.done') });
    ok.addEventListener('click', () => this.close());
    this._sync();
    this._redraw();
  }

  onClose() {
    if (this.changed) this.onSave?.(writeDrawing(this.data));
  }

  _tool(tool) {
    this.tool = tool;
    if (tool !== 'move') this.selected = null;
    this._sync();
    this._redraw();
  }

  _sync() {
    this.penBtn.toggleClass('is-active', this.tool === 'pen');
    this.eraserBtn.toggleClass('is-active', this.tool === 'eraser');
    this.moveBtn.toggleClass('is-active', this.tool === 'move');
    const sel = this.selected;
    this.fillBtn.toggleClass('is-active', sel ? !!sel.fill : this.fill);
    this.deleteBtn.toggle(!!sel);
    const width = sel && sel.type !== 'text' ? sel.width || 5 : this.width;
    for (const [b, w] of this.widthBtns) b.toggleClass('is-active', w === width);
    const color = sel ? sel.color : this.color;
    for (const [s, col] of this.swatches) s.toggleClass('is-active', col === color && (!!sel || this.tool === 'pen'));
  }

  // ---------------------------------------------------------------- history
  _snap() { return JSON.stringify({ strokes: this.data.strokes, items: this.data.items }); }

  /** Kept before every change (undo goes back to it). */
  _before() {
    this.past.push(this._snap());
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.changed = true;
  }

  _restore(json) {
    const s = JSON.parse(json);
    this.data.strokes = s.strokes;
    this.data.items = s.items;
    this.selected = null;
    this.changed = true;
    this._redraw();
    this._sync();
  }

  _undo() { if (this.past.length) { this.future.push(this._snap()); this._restore(this.past.pop()); } }
  _redo() { if (this.future.length) { this.past.push(this._snap()); this._restore(this.future.pop()); } }

  // ---------------------------------------------------------------- items
  _center() { return [this.canvas.width / 2, this.canvas.height / 2]; }

  _place(item) {
    this._before();
    this.data.items.push(item);
    this.selected = item;
    this.tool = 'move';
    this._redraw();
    this._sync();
  }

  _addShape(type) {
    const [x, y] = this._center();
    const side = Math.min(this.canvas.width, this.canvas.height) * 0.3;
    this._place({ type, x, y, w: side, h: type === 'heart' ? side * 0.9 : side, rot: 0, color: this.color === '#ffffff' ? '#111111' : this.color, width: this.width, fill: this.fill });
  }

  async _addText() {
    const text = await promptDialog(this.app, { title: t('drawing.text'), placeholder: t('drawing.text-placeholder') });
    if (!text || !text.trim()) return;
    const [x, y] = this._center();
    const lines = text.split('\n').length;
    const item = { type: 'text', text: text.trim(), x, y, w: 0, h: 72 * 1.2 * lines, rot: 0, color: this.color };
    this._measure(item);
    this._place(item);
  }

  async _editText(item) {
    const text = await promptDialog(this.app, { title: t('drawing.text'), value: item.text });
    if (text === null) return;
    this._before();
    if (!text.trim()) { this.data.items.remove(item); this.selected = null; } else { item.text = text.trim(); this._measure(item); }
    this._redraw();
    this._sync();
  }

  /** The width of a text item follows its words and size. */
  _measure(item) {
    const lines = String(item.text).split('\n');
    const size = item.h / lines.length / 1.2;
    this.ctx.font = FONT.replace('{size}', String(size));
    item.w = Math.max(...lines.map((l) => this.ctx.measureText(l).width), size) + size * 0.3;
  }

  _deleteSelected() {
    if (!this.selected) return;
    this._before();
    this.data.items.remove(this.selected);
    this.selected = null;
    this._redraw();
    this._sync();
  }

  /** A point of the sheet in the item's own coordinates (centre at 0, 0, not turned). */
  _local(item, p) {
    const dx = p[0] - item.x;
    const dy = p[1] - item.y;
    const c = Math.cos(-(item.rot || 0));
    const s = Math.sin(-(item.rot || 0));
    return [dx * c - dy * s, dx * s + dy * c];
  }

  _scale() { return this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width); }

  /** What is under a point: { item, part: 'body' | 'resize' | 'rotate' }, the chosen item first. */
  _hit(p) {
    const k = this._scale();
    const hs = HANDLE * k;
    const sel = this.selected;
    if (sel) {
      const [lx, ly] = this._local(sel, p);
      if (Math.hypot(lx - sel.w / 2, ly - sel.h / 2) < hs) return { item: sel, part: 'resize' };
      if (Math.hypot(lx, ly + sel.h / 2 + hs * 1.6) < hs) return { item: sel, part: 'rotate' };
    }
    for (let i = this.data.items.length - 1; i >= 0; i--) {
      const it = this.data.items[i];
      const [lx, ly] = this._local(it, p);
      const pad = 8 * k;
      if (Math.abs(lx) <= it.w / 2 + pad && Math.abs(ly) <= it.h / 2 + pad) return { item: it, part: 'body' };
    }
    return null;
  }

  // ---------------------------------------------------------------- drawing
  _redraw() {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.data.background) { c.fillStyle = this.data.background; c.fillRect(0, 0, this.canvas.width, this.canvas.height); }
    for (const s of this.data.strokes) this._stroke(s);
    for (const it of this.data.items) this._item(it);
    if (this.selected && this.data.items.includes(this.selected)) this._frame(this.selected);
  }

  _stroke(s) {
    const c = this.ctx;
    c.strokeStyle = s.color;
    c.lineWidth = s.width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke(new Path2D(pathOf(s.points)));
  }

  _item(it) {
    const c = this.ctx;
    c.save();
    c.translate(it.x, it.y);
    c.rotate(it.rot || 0);
    if (it.type === 'text') {
      const lines = String(it.text).split('\n');
      const size = it.h / lines.length / 1.2;
      c.font = FONT.replace('{size}', String(size));
      c.fillStyle = it.color;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      lines.forEach((ln, i) => c.fillText(ln, 0, (i - (lines.length - 1) / 2) * size * 1.2));
    } else {
      const p = new Path2D(shapePath(it.type, it.w, it.h));
      if (it.fill) { c.fillStyle = it.color; c.fill(p); }
      c.strokeStyle = it.color;
      c.lineWidth = it.width || 5;
      c.lineJoin = 'round';
      c.stroke(p);
    }
    c.restore();
  }

  /** The dashed frame of the chosen item, with its two handles. */
  _frame(it) {
    const c = this.ctx;
    const k = this._scale();
    const hs = HANDLE * k;
    c.save();
    c.translate(it.x, it.y);
    c.rotate(it.rot || 0);
    c.strokeStyle = '#e05c00';
    c.lineWidth = 2 * k;
    c.setLineDash([8 * k, 6 * k]);
    c.strokeRect(-it.w / 2 - 6 * k, -it.h / 2 - 6 * k, it.w + 12 * k, it.h + 12 * k);
    c.setLineDash([]);
    c.beginPath();
    c.moveTo(0, -it.h / 2 - 6 * k);
    c.lineTo(0, -it.h / 2 - hs * 1.6 + hs / 2);
    c.stroke();
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(0, -it.h / 2 - hs * 1.6, hs / 2, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillRect(it.w / 2 - hs / 2, it.h / 2 - hs / 2, hs, hs);
    c.strokeRect(it.w / 2 - hs / 2, it.h / 2 - hs / 2, hs, hs);
    c.restore();
  }

  _point(e) {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.canvas.width, ((e.clientY - r.top) / r.height) * this.canvas.height];
  }

  /** Strokes passing near a point (the eraser takes whole strokes away). */
  _erase(p) {
    const r = (this.width * 2 + 10) * this._scale();
    const keep = this.data.strokes.filter((s) => !s.points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < r + s.width / 2));
    if (keep.length !== this.data.strokes.length) {
      if (!this._erasing) { this._before(); this._erasing = true; }
      this.data.strokes = keep;
      this._redraw();
    }
  }

  _input() {
    const cv = this.canvas;
    const pointers = new Map(); // id → point
    let cur = null; // the gesture of one finger
    let pinch = null; // two fingers on the chosen item
    let lastTap = { time: 0, item: null };
    const startPinch = () => {
      const [a, b] = [...pointers.values()];
      const it = this.selected;
      if (!it) return;
      if (!cur?.moved) this._before();
      pinch = { item: it, d: Math.hypot(b[0] - a[0], b[1] - a[1]), ang: Math.atan2(b[1] - a[1], b[0] - a[0]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        w: it.w, h: it.h, rot: it.rot || 0, x: it.x, y: it.y };
      cur = null;
    };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* still draws */ }
      const p = this._point(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2 && this.selected) { if (cur?.s) cur = null; startPinch(); this._redraw(); return; }
      if (pointers.size > 1) return;
      if (this.tool === 'move') {
        const hit = this._hit(p);
        if (!hit) { this.selected = null; cur = null; this._redraw(); this._sync(); return; }
        const now = Date.now();
        if (hit.part === 'body' && hit.item.type === 'text' && lastTap.item === hit.item && now - lastTap.time < 350) {
          lastTap = { time: 0, item: null };
          this._editText(hit.item);
          return;
        }
        lastTap = { time: now, item: hit.item };
        this.selected = hit.item;
        const it = hit.item;
        cur = { id: e.pointerId, part: hit.part, item: it, start: p, x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot || 0, moved: false };
        this._redraw();
        this._sync();
        return;
      }
      if (this.tool === 'eraser') { this._erasing = false; cur = { erase: true, id: e.pointerId }; this._erase(p); return; }
      cur = { id: e.pointerId, s: { color: this.color, width: this.width, points: [p] } };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      e.preventDefault();
      const p = this._point(e);
      pointers.set(e.pointerId, p);
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const f = Math.max(0.1, d / Math.max(1, pinch.d));
        const it = pinch.item;
        it.w = Math.max(20, pinch.w * f);
        it.h = Math.max(20, pinch.h * f);
        it.rot = pinch.rot + Math.atan2(b[1] - a[1], b[0] - a[0]) - pinch.ang;
        it.x = pinch.x + (a[0] + b[0]) / 2 - pinch.mid[0];
        it.y = pinch.y + (a[1] + b[1]) / 2 - pinch.mid[1];
        if (it.type === 'text') this._measure(it);
        this._redraw();
        return;
      }
      if (!cur || e.pointerId !== cur.id) return;
      if (cur.item) {
        const it = cur.item;
        if (!cur.moved) {
          if (Math.hypot(p[0] - cur.start[0], p[1] - cur.start[1]) < 3 * this._scale()) return;
          cur.moved = true;
          this._before();
        }
        if (cur.part === 'body') {
          it.x = cur.x + p[0] - cur.start[0];
          it.y = cur.y + p[1] - cur.start[1];
        } else if (cur.part === 'rotate') {
          it.rot = Math.atan2(p[1] - it.y, p[0] - it.x) + Math.PI / 2;
        } else if (cur.part === 'resize') {
          const [lx, ly] = this._local({ ...it, rot: cur.rot }, p);
          if (it.type === 'text') { // words keep their proportions
            const f = Math.max(0.15, Math.max(lx / (cur.w / 2), ly / (cur.h / 2)));
            it.h = Math.max(16, cur.h * f);
            this._measure(it);
          } else { // each side on its own: a square becomes a rectangle, a circle an oval
            it.w = Math.max(20, lx * 2);
            it.h = Math.max(20, ly * 2);
          }
        }
        this._redraw();
        return;
      }
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const q = this._point(ev);
        if (cur.erase) { this._erase(q); continue; }
        const last = cur.s.points[cur.s.points.length - 1];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 1.5) continue;
        cur.s.points.push(q);
      }
      if (!cur.erase) { this._redraw(); this._stroke(cur.s); }
    });
    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pinch) { if (pointers.size < 2) pinch = null; this._redraw(); return; }
      if (!cur || e.pointerId !== cur.id) return;
      if (cur.s && cur.s.points.length) {
        this._before();
        this.data.strokes.push(cur.s);
      }
      cur = null;
      this._redraw();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }
}
