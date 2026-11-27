// Drawings on a board: a card that is a picture drawn by hand (finger, pen or mouse).
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A drawing is a plain SVG file of the vault (attachment folder), put on the board as a normal
// file card: Obsidian and every other app show it as a picture. The strokes are also kept inside
// the SVG (<metadata id="sk-drawing">), so sk_notes can open it again to go on drawing.

import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { Modal } from '../ui/kit.js';

// the colours of the pen are the user's own: fixed values, no theme changes them
export const PEN_COLORS = ['#111111', '#ffffff', '#e5484d', '#f08c2e', '#e3b341', '#39d353', '#3fc1c9', '#3b82f6', '#b98bf0'];
const WIDTHS = [2, 5, 12];
const W = 1200;
const H = 900;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Is this SVG text a drawing made here? */
export function isDrawing(text) { return /<metadata id="sk-drawing">/.test(String(text || '')); }

/** The strokes kept in a drawing (an empty one for anything else). */
export function readDrawing(text) {
  const m = /<metadata id="sk-drawing">([\s\S]*?)<\/metadata>/.exec(String(text || ''));
  if (!m) return { width: W, height: H, strokes: [] };
  try {
    const raw = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const d = JSON.parse(raw);
    return { width: Number(d.width) || W, height: Number(d.height) || H, background: d.background || '', strokes: Array.isArray(d.strokes) ? d.strokes : [] };
  } catch { return { width: W, height: H, strokes: [] }; }
}

/** SVG path of a stroke (points smoothed with quadratic curves). */
function pathOf(points) {
  if (!points.length) return '';
  const r = (v) => Math.round(v * 10) / 10;
  if (points.length === 1) return `M${r(points[0][0])} ${r(points[0][1])}l0.1 0`;
  let d = `M${r(points[0][0])} ${r(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${r(x)} ${r(y)} ${r((x + nx) / 2)} ${r((y + ny) / 2)}`;
  }
  const last = points[points.length - 1];
  return d + `L${r(last[0])} ${r(last[1])}`;
}

/** The SVG file of a drawing. */
export function writeDrawing(d) {
  const meta = esc(JSON.stringify({ width: d.width, height: d.height, background: d.background || '', strokes: d.strokes }));
  const bg = d.background ? `<rect width="100%" height="100%" fill="${esc(d.background)}"/>` : '';
  const paths = d.strokes.map((s) => `<path d="${pathOf(s.points)}" stroke="${esc(s.color)}" stroke-width="${s.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}">\n<metadata id="sk-drawing">${meta}</metadata>\n${bg}\n${paths}\n</svg>\n`;
}

export function emptyDrawing() { return writeDrawing({ width: W, height: H, background: '#ffffff', strokes: [] }); }

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
    this.undone = [];
    this.changed = false;
    this.modalEl.addClass('mod-drawing');
  }

  onOpen() {
    this.titleEl.setText(t('drawing.title'));
    const c = this.contentEl;
    const bar = c.createDiv('drawing-toolbar');
    const btn = (icon, label, fn, cls = '') => {
      const b = bar.createDiv({ cls: `drawing-tool clickable-icon ${cls}`, attr: { 'aria-label': label, role: 'button' } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    this.penBtn = btn('pencil', t('drawing.pen'), () => this._tool('pen'));
    this.eraserBtn = btn('eraser', t('drawing.eraser'), () => this._tool('eraser'));
    bar.createDiv('drawing-sep');
    this.widthBtns = WIDTHS.map((w) => {
      const b = bar.createDiv({ cls: 'drawing-width', attr: { 'aria-label': t('drawing.width'), role: 'button' } });
      b.createDiv({ cls: 'drawing-width-dot' }).style.setProperty('--w', `${Math.min(18, w + 2)}px`);
      b.addEventListener('click', () => { this.width = w; this._sync(); });
      return [b, w];
    });
    bar.createDiv('drawing-sep');
    this.swatches = PEN_COLORS.map((col) => {
      const s = bar.createDiv({ cls: 'drawing-swatch', attr: { role: 'button', 'aria-label': col } });
      s.style.setProperty('--swatch', col);
      s.addEventListener('click', () => { this.color = col; this._tool('pen'); });
      return [s, col];
    });
    const custom = bar.createEl('input', { cls: 'drawing-custom', attr: { type: 'color', value: '#e05c00', 'aria-label': t('graph.color-custom') } });
    custom.addEventListener('input', () => { this.color = custom.value; this._tool('pen'); });
    custom.addEventListener('change', () => { this.color = custom.value; this._tool('pen'); });
    bar.createDiv('drawing-sep');
    btn('undo', t('canvas.undo'), () => this._undo());
    btn('redo', t('canvas.redo'), () => this._redo());
    btn('trash', t('drawing.clear'), () => { if (!this.data.strokes.length) return; this.undone = []; this._history = this.data.strokes; this.data.strokes = []; this.changed = true; this._redraw(); });

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

  _tool(tool) { this.tool = tool; this._sync(); }

  _sync() {
    this.penBtn.toggleClass('is-active', this.tool === 'pen');
    this.eraserBtn.toggleClass('is-active', this.tool === 'eraser');
    for (const [b, w] of this.widthBtns) b.toggleClass('is-active', w === this.width);
    for (const [s, col] of this.swatches) s.toggleClass('is-active', this.tool === 'pen' && col === this.color);
  }

  _undo() {
    if (this._history) { this.data.strokes = this._history; this._history = null; this.changed = true; this._redraw(); return; }
    const s = this.data.strokes.pop();
    if (!s) return;
    this.undone.push(s);
    this.changed = true;
    this._redraw();
  }

  _redo() {
    const s = this.undone.pop();
    if (!s) return;
    this.data.strokes.push(s);
    this.changed = true;
    this._redraw();
  }

  _redraw() {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.data.background) { c.fillStyle = this.data.background; c.fillRect(0, 0, this.canvas.width, this.canvas.height); }
    for (const s of this.data.strokes) this._stroke(s);
  }

  _stroke(s) {
    const c = this.ctx;
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke(new Path2D(pathOf(s.points)));
  }

  _point(e) {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.canvas.width, ((e.clientY - r.top) / r.height) * this.canvas.height];
  }

  /** Strokes passing near a point (the eraser takes whole strokes away). */
  _erase(p) {
    const r = (this.width * 2 + 10) * (this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width));
    const keep = this.data.strokes.filter((s) => !s.points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < r + s.width / 2));
    if (keep.length !== this.data.strokes.length) {
      this.undone = [];
      this.data.strokes = keep;
      this.changed = true;
      this._redraw();
    }
  }

  _input() {
    const cv = this.canvas;
    let cur = null;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* still draws */ }
      const p = this._point(e);
      if (this.tool === 'eraser') { cur = { erase: true, id: e.pointerId }; this._erase(p); return; }
      cur = { id: e.pointerId, s: { color: this.color, width: this.width, points: [p] } };
      this._history = null;
    });
    cv.addEventListener('pointermove', (e) => {
      if (!cur || e.pointerId !== cur.id) return;
      e.preventDefault();
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const p = this._point(ev);
        if (cur.erase) { this._erase(p); continue; }
        const last = cur.s.points[cur.s.points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) continue;
        cur.s.points.push(p);
      }
      if (!cur.erase) { this._redraw(); this._stroke(cur.s); }
    });
    const end = (e) => {
      if (!cur || e.pointerId !== cur.id) return;
      if (!cur.erase && cur.s.points.length) {
        this.data.strokes.push(cur.s);
        this.undone = [];
        this.changed = true;
      }
      cur = null;
      this._redraw();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }
}
