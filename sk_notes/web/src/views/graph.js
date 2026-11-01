// Graph view (global and local): force layout in a Web Worker, canvas rendering.

import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { debounce } from '../core/util.js';
import { Keymap } from '../model/keymap.js';
import { getAllTags } from '../model/metadata.js';
import { ItemView } from './base.js';
import { Setting } from '../ui/kit.js';

// --------------------------------------------------------------- layout worker
function workerMain() {
  let n = 0;
  let x;
  let y;
  let vx;
  let vy;
  let fixed;
  let links = new Int32Array(0);
  let weights = new Float32Array(0);
  let params = { center: 0.08, repel: 900, linkForce: 0.6, linkDistance: 70 };
  let alpha = 1;
  let running = false;

  function buildTree() {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < minX) minX = x[i]; if (y[i] < minY) minY = y[i];
      if (x[i] > maxX) maxX = x[i]; if (y[i] > maxY) maxY = y[i];
    }
    const size = Math.max(maxX - minX, maxY - minY) + 1;
    const root = { x0: minX, y0: minY, s: size, mass: 0, cx: 0, cy: 0, kids: null, idx: -1 };
    const insert = (node, i, depth) => {
      if (node.idx === -1 && !node.kids && node.mass === 0) { node.idx = i; node.mass = 1; node.cx = x[i]; node.cy = y[i]; return; }
      if (!node.kids) {
        if (depth > 24) { node.mass += 1; node.cx += (x[i] - node.cx) / node.mass; node.cy += (y[i] - node.cy) / node.mass; return; }
        node.kids = [null, null, null, null];
        const old = node.idx;
        node.idx = -1;
        node.mass = 0; node.cx = 0; node.cy = 0;
        if (old !== -1) place(node, old, depth);
      }
      place(node, i, depth);
    };
    const place = (node, i, depth) => {
      node.mass += 1;
      node.cx += (x[i] - node.cx) / node.mass;
      node.cy += (y[i] - node.cy) / node.mass;
      const h = node.s / 2;
      const q = (x[i] >= node.x0 + h ? 1 : 0) + (y[i] >= node.y0 + h ? 2 : 0);
      if (!node.kids[q]) node.kids[q] = { x0: node.x0 + (q & 1 ? h : 0), y0: node.y0 + (q & 2 ? h : 0), s: h, mass: 0, cx: 0, cy: 0, kids: null, idx: -1 };
      insert(node.kids[q], i, depth + 1);
    };
    for (let i = 0; i < n; i++) insert(root, i, 0);
    return root;
  }

  function repel(root, i, k) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || node.mass === 0) continue;
      const dx = node.cx - x[i];
      const dy = node.cy - y[i];
      const d2 = dx * dx + dy * dy + 0.01;
      if (node.kids && (node.s * node.s) / d2 > 0.81) { for (const c of node.kids) if (c) stack.push(c); continue; }
      if (node.idx === i) continue;
      const f = (k * node.mass) / d2;
      vx[i] -= dx * f;
      vy[i] -= dy * f;
    }
  }

  function tick() {
    if (!n) return;
    const root = buildTree();
    const k = params.repel * alpha * 0.02;
    for (let i = 0; i < n; i++) {
      repel(root, i, k);
      vx[i] -= x[i] * params.center * alpha * 0.05;
      vy[i] -= y[i] * params.center * alpha * 0.05;
    }
    for (let e = 0; e < links.length; e += 2) {
      const a = links[e];
      const b = links[e + 1];
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = ((d - params.linkDistance) / d) * params.linkForce * alpha * 0.1;
      const wa = weights[b] / (weights[a] + weights[b]);
      vx[a] += dx * f * wa; vy[a] += dy * f * wa;
      vx[b] -= dx * f * (1 - wa); vy[b] -= dy * f * (1 - wa);
    }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) { vx[i] = 0; vy[i] = 0; continue; }
      vx[i] *= 0.6; vy[i] *= 0.6;
      x[i] += vx[i]; y[i] += vy[i];
    }
    alpha = Math.max(0.0005, alpha * 0.985);
  }

  function loop() {
    if (!running) return;
    const steps = n > 3000 ? 1 : 2;
    for (let s = 0; s < steps; s++) tick();
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { out[i * 2] = x[i]; out[i * 2 + 1] = y[i]; }
    self.postMessage({ type: 'pos', pos: out, alpha }, [out.buffer]);
    if (alpha <= 0.002) { running = false; self.postMessage({ type: 'idle' }); return; }
    setTimeout(loop, 16);
  }

  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
      const old = m.keep || {};
      n = m.n;
      x = new Float32Array(n); y = new Float32Array(n); vx = new Float32Array(n); vy = new Float32Array(n);
      fixed = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (old[i]) { x[i] = old[i][0]; y[i] = old[i][1]; } else {
          const r = 30 * Math.sqrt(i + 1); const a = i * 2.4;
          x[i] = Math.cos(a) * r; y[i] = Math.sin(a) * r;
        }
      }
      links = m.links;
      weights = new Float32Array(n).fill(1);
      for (let i = 0; i < links.length; i++) weights[links[i]] += 1;
      alpha = m.warm ? 0.3 : 1;
      if (!running) { running = true; loop(); }
    } else if (m.type === 'params') {
      params = { ...params, ...m.params };
      alpha = Math.max(alpha, 0.3);
      if (!running) { running = true; loop(); }
    } else if (m.type === 'drag') {
      x[m.i] = m.x; y[m.i] = m.y; fixed[m.i] = m.fix ? 1 : 0;
      alpha = Math.max(alpha, 0.15);
      if (!running) { running = true; loop(); }
    } else if (m.type === 'stop') {
      running = false;
    }
  };
}

const workerUrl = URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' }));

const DEFAULT_OPTIONS = {
  search: '', showTags: false, showAttachments: false, hideUnresolved: true, showOrphans: true,
  colorGroups: [], showArrow: false, textFadeMultiplier: 0, nodeSizeMultiplier: 1, lineSizeMultiplier: 1,
  centerStrength: 0.5, repelStrength: 10, linkStrength: 1, linkDistance: 250, scale: 1, depth: 1,
  localJumps: 1, localBacklinks: true, localForelinks: true, localNeighbors: false,
};

export class GraphView extends ItemView {
  constructor(leaf, local = false) {
    super(leaf);
    this.local = local;
    this.icon = 'graph';
    this.options = { ...DEFAULT_OPTIONS };
    this.file = null;
    this.contentEl.addClass('graph-view');
    this.canvas = this.contentEl.createEl('canvas', { cls: 'graph-canvas' });
    this.ctx = this.canvas.getContext('2d');
    this.controlsEl = this.contentEl.createDiv('graph-controls is-close');
    this.nodes = [];
    this.links = [];
    this.pos = null;
    this.view = { x: 0, y: 0, k: 1 };
    this.autoFit = true; // follow the layout until the user pans or zooms
    this.hover = -1;
    this.dirty = true;
    this.rebuild = debounce(() => this.build(true), 400, true);
    this._buildControls();
    this._setupInput();
  }

  getViewType() { return this.local ? 'localgraph' : 'graph'; }
  getDisplayText() { return this.local ? t('graph.local-title', { name: this.file?.basename || '' }) : t('graph.title'); }
  getIcon() { return 'graph'; }
  getState() { return { file: this.file?.path, options: this.options }; }

  async setState(st) {
    if (st.options) this.options = { ...DEFAULT_OPTIONS, ...st.options };
    if (st.file) this.file = this.app.vault.getFileByPath(st.file);
    this._buildControls();
    this.build(false);
  }

  async onOpen() {
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (e) => {
      if (e.data.type === 'pos') {
        this.pos = e.data.pos;
        if (this.autoFit) this._fit();
        this.dirty = true;
      }
    };
    this.register(() => this.worker.terminate());
    const draw = () => {
      if (!this._loaded) return;
      if (this.dirty) { this.dirty = false; this.draw(); }
      this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
    this.register(() => cancelAnimationFrame(this.raf));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.rebuild()));
    if (this.local) {
      this.registerEvent(this.app.workspace.on('file-open', (f) => {
        if (f && !this.leaf.pinned && !(this.leaf.group && this.app.workspace.getGroupLeaves(this.leaf.group).length > 1)) { this.file = f; this.build(true); this.leaf.updateHeader(); }
      }));
      if (!this.file) this.file = this.app.workspace.getActiveFile();
    }
    this.registerEvent(this.app.workspace.on('css-change', () => { this.dirty = true; }));
    if (!this.local) {
      const saved = await this.app.config.read('graph.json').catch(() => null);
      if (saved) { this.options = { ...DEFAULT_OPTIONS, ...saved }; this._buildControls(); }
    }
    this.registerDomEvent(window, 'mouseup', this._onMouseUp);
    this.onResize();
    this.build(false);
  }

  onResize() {
    const r = this.contentEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.dpr = dpr;
    this.dirty = true;
  }

  // ------------------------------------------------------------- data
  build(keep) {
    if (!this.worker) return;
    const app = this.app;
    const o = this.options;
    const mc = app.metadataCache;
    const nodes = [];
    const index = new Map();
    const add = (id, label, type, file) => {
      if (index.has(id)) return index.get(id);
      index.set(id, nodes.length);
      nodes.push({ id, label, type, file, degree: 0 });
      return nodes.length - 1;
    };
    const q = (o.search || '').toLowerCase().trim();
    const matches = (path) => {
      if (!q) return true;
      if (q.startsWith('path:')) return path.toLowerCase().includes(q.slice(5).replace(/"/g, ''));
      if (q.startsWith('tag:')) {
        const tag = q.slice(4).replace(/^#/, '');
        return (getAllTags(mc.getCache(path)) || []).some((x) => x.slice(1).toLowerCase() === tag || x.slice(1).toLowerCase().startsWith(tag + '/'));
      }
      return path.toLowerCase().includes(q);
    };
    const links = [];
    const files = app.vault.getFiles().filter((f) => f.extension === 'md' || (o.showAttachments && f.extension !== 'md'));
    let allowed = null;
    if (this.local && this.file) {
      allowed = new Set([this.file.path]);
      let frontier = [this.file.path];
      for (let d = 0; d < (o.depth || 1); d++) {
        const next = [];
        for (const p of frontier) {
          if (o.localForelinks) for (const dest of Object.keys(mc.resolvedLinks[p] || {})) if (!allowed.has(dest)) { allowed.add(dest); next.push(dest); }
          if (o.localBacklinks) for (const src in mc.resolvedLinks) if (mc.resolvedLinks[src][p] && !allowed.has(src)) { allowed.add(src); next.push(src); }
        }
        frontier = next;
      }
    }
    for (const f of files) {
      if (allowed && !allowed.has(f.path)) continue;
      if (!matches(f.path)) continue;
      add(f.path, f.extension === 'md' ? f.basename : f.name, f.extension === 'md' ? 'note' : 'attachment', f);
    }
    for (const src in mc.resolvedLinks) {
      const a = index.get(src);
      if (a === undefined) continue;
      for (const dest in mc.resolvedLinks[src]) {
        const b = index.get(dest);
        if (b === undefined || a === b) continue;
        links.push(a, b);
      }
      if (!o.hideUnresolved) {
        for (const name in mc.unresolvedLinks[src] || {}) {
          const b = add('?' + name, name, 'unresolved', null);
          links.push(a, b);
        }
      }
    }
    if (o.showTags) {
      for (let i = 0, len = nodes.length; i < len; i++) {
        if (nodes[i].type !== 'note') continue;
        for (const tag of new Set(getAllTags(mc.getCache(nodes[i].id)) || [])) {
          const b = add('#' + tag, tag, 'tag', null);
          links.push(i, b);
        }
      }
    }
    for (let e = 0; e < links.length; e++) nodes[links[e]].degree++;
    let finalNodes = nodes;
    let finalLinks = links;
    if (!o.showOrphans) {
      const keepIdx = nodes.map((nd, i) => (nd.degree > 0 || (this.local && nd.id === this.file?.path) ? i : -1)).filter((i) => i >= 0);
      const remap = new Map(keepIdx.map((old, i) => [old, i]));
      finalNodes = keepIdx.map((i) => nodes[i]);
      finalLinks = [];
      for (let e = 0; e < links.length; e += 2) {
        if (remap.has(links[e]) && remap.has(links[e + 1])) finalLinks.push(remap.get(links[e]), remap.get(links[e + 1]));
      }
    }
    // groups
    for (const nd of finalNodes) {
      nd.color = null;
      for (const g of o.colorGroups || []) {
        if (g.query && nd.type !== 'tag' && nd.type !== 'unresolved') {
          const gq = g.query.toLowerCase();
          const ok = gq.startsWith('tag:') ? (getAllTags(mc.getCache(nd.id)) || []).some((x) => x.slice(1).toLowerCase().startsWith(gq.slice(4).replace(/^#/, '')))
            : gq.startsWith('path:') ? nd.id.toLowerCase().includes(gq.slice(5)) : nd.id.toLowerCase().includes(gq);
          if (ok) { nd.color = g.color; break; }
        }
      }
    }
    const keepPos = {};
    if (keep && this.pos && this.nodes.length) {
      const old = new Map(this.nodes.map((nd, i) => [nd.id, i]));
      finalNodes.forEach((nd, i) => {
        const j = old.get(nd.id);
        if (j !== undefined) keepPos[i] = [this.pos[j * 2], this.pos[j * 2 + 1]];
      });
    }
    this.nodes = finalNodes;
    this.links = new Int32Array(finalLinks);
    this.neighbors = finalNodes.map(() => []);
    for (let e = 0; e < this.links.length; e += 2) {
      this.neighbors[this.links[e]].push(this.links[e + 1]);
      this.neighbors[this.links[e + 1]].push(this.links[e]);
    }
    if (!keep) this.pos = null;
    this.worker.postMessage({ type: 'init', n: finalNodes.length, links: this.links.slice(), keep: keepPos, warm: keep && Object.keys(keepPos).length > 0 });
    this._sendParams();
    if (this.countEl) this.countEl.setText(t('graph.count', { nodes: finalNodes.length, links: this.links.length / 2 }));
  }

  _sendParams() {
    const o = this.options;
    this.worker?.postMessage({ type: 'params', params: {
      center: o.centerStrength * 0.16, repel: o.repelStrength * 90, linkForce: o.linkStrength * 0.6, linkDistance: o.linkDistance * 0.28,
    } });
  }

  // ------------------------------------------------------------- drawing
  _colors() {
    const cs = getComputedStyle(document.body);
    const v = (n) => cs.getPropertyValue(n).trim();
    return { bg: v('--background-primary'), node: v('--text-muted'), focus: v('--sk-accent'), line: v('--sk-border'),
      text: v('--text-normal'), tag: v('--color-green'), unresolved: v('--text-faint'), attachment: v('--color-yellow'), hl: v('--sk-accent2') };
  }

  /** Fit all nodes in the view; big graphs end up zoomed out, where labels fade. */
  _fit() {
    const pos = this.pos;
    const n = pos ? pos.length / 2 : 0;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    if (!n || w < 10 || h < 10) return;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2]; const y = pos[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const pad = 40;
    const k = Math.clamp(Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY)), 0.05, 1.5);
    this.view = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k };
  }

  toScreen(px, py) {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    return [(px - this.view.x) * this.view.k + w / 2, (py - this.view.y) * this.view.k + h / 2];
  }

  toWorld(sx, sy) {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    return [(sx - w / 2) / this.view.k + this.view.x, (sy - h / 2) / this.view.k + this.view.y];
  }

  radius(i) {
    const nd = this.nodes[i];
    return (3 + Math.sqrt(nd.degree) * 1.6) * this.options.nodeSizeMultiplier;
  }

  draw() {
    const c = this.ctx;
    const pos = this.pos;
    const col = this._colors();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    c.fillStyle = col.bg;
    c.fillRect(0, 0, w, h);
    if (!pos || pos.length < this.nodes.length * 2) return;
    const k = this.view.k;
    const hov = this.hover;
    const hl = hov >= 0 ? new Set([hov, ...this.neighbors[hov]]) : null;
    c.lineWidth = Math.max(0.5, 1 * this.options.lineSizeMultiplier * Math.min(1, k));
    // links
    c.beginPath();
    c.strokeStyle = col.line;
    c.globalAlpha = hl ? 0.25 : 0.8;
    for (let e = 0; e < this.links.length; e += 2) {
      const a = this.links[e];
      const b = this.links[e + 1];
      const [x1, y1] = this.toScreen(pos[a * 2], pos[a * 2 + 1]);
      const [x2, y2] = this.toScreen(pos[b * 2], pos[b * 2 + 1]);
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
    }
    c.stroke();
    if (hl) {
      c.beginPath();
      c.strokeStyle = col.hl;
      c.globalAlpha = 0.9;
      for (const nb of this.neighbors[hov]) {
        const [x1, y1] = this.toScreen(pos[hov * 2], pos[hov * 2 + 1]);
        const [x2, y2] = this.toScreen(pos[nb * 2], pos[nb * 2 + 1]);
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
      }
      c.stroke();
    }
    if (this.options.showArrow && k > 0.6) {
      c.fillStyle = col.line;
      for (let e = 0; e < this.links.length; e += 2) {
        const a = this.links[e];
        const b = this.links[e + 1];
        const [x1, y1] = this.toScreen(pos[a * 2], pos[a * 2 + 1]);
        const [x2, y2] = this.toScreen(pos[b * 2], pos[b * 2 + 1]);
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const r = this.radius(b) * k + 2;
        const tx = x2 - Math.cos(ang) * r;
        const ty = y2 - Math.sin(ang) * r;
        c.beginPath();
        c.moveTo(tx, ty);
        c.lineTo(tx - Math.cos(ang - 0.4) * 7, ty - Math.sin(ang - 0.4) * 7);
        c.lineTo(tx - Math.cos(ang + 0.4) * 7, ty - Math.sin(ang + 0.4) * 7);
        c.fill();
      }
    }
    // nodes
    const activePath = this.local ? this.file?.path : this.app.workspace.getActiveFile()?.path;
    for (let i = 0; i < this.nodes.length; i++) {
      const nd = this.nodes[i];
      const [sx, sy] = this.toScreen(pos[i * 2], pos[i * 2 + 1]);
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
      const r = Math.max(1.5, this.radius(i) * Math.sqrt(k));
      c.globalAlpha = hl && !hl.has(i) ? 0.25 : 1;
      c.fillStyle = nd.id === activePath ? col.focus : nd.color || (nd.type === 'tag' ? col.tag : nd.type === 'unresolved' ? col.unresolved : nd.type === 'attachment' ? col.attachment : col.node);
      if (i === hov) c.fillStyle = col.hl;
      c.beginPath();
      c.arc(sx, sy, r, 0, Math.PI * 2);
      c.fill();
    }
    // labels
    const fade = 0.6 + this.options.textFadeMultiplier * 0.3;
    c.font = `${Math.max(9, Math.min(14, 11 * Math.sqrt(k)))}px ${getComputedStyle(document.body).fontFamily}`;
    c.textAlign = 'center';
    c.fillStyle = col.text;
    for (let i = 0; i < this.nodes.length; i++) {
      const show = i === hov || (hl && hl.has(i)) || k > fade;
      if (!show) continue;
      const [sx, sy] = this.toScreen(pos[i * 2], pos[i * 2 + 1]);
      if (sx < -50 || sy < -20 || sx > w + 50 || sy > h + 20) continue;
      c.globalAlpha = i === hov || (hl && hl.has(i)) ? 1 : Math.min(1, (k - fade) * 2);
      c.fillText(this.nodes[i].label, sx, sy + this.radius(i) * Math.sqrt(k) + 12);
    }
    c.globalAlpha = 1;
  }

  // ------------------------------------------------------------- input
  _nodeAt(sx, sy) {
    if (!this.pos) return -1;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const [x, y] = this.toScreen(this.pos[i * 2], this.pos[i * 2 + 1]);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      const r = Math.max(6, this.radius(i) * Math.sqrt(this.view.k) + 3);
      if (d < r * r && d < bd) { bd = d; best = i; }
    }
    return best;
  }

  _setupInput() {
    const cv = this.canvas;
    let drag = null;
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('mousemove', (e) => {
      const [sx, sy] = local(e);
      if (drag) {
        if (drag.node >= 0) {
          const [wx, wy] = this.toWorld(sx, sy);
          this.worker.postMessage({ type: 'drag', i: drag.node, x: wx, y: wy, fix: true });
        } else {
          this.autoFit = false;
          this.view.x = drag.vx - (sx - drag.sx) / this.view.k;
          this.view.y = drag.vy - (sy - drag.sy) / this.view.k;
        }
        drag.moved = drag.moved || Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3;
        this.dirty = true;
        return;
      }
      const h = this._nodeAt(sx, sy);
      if (h !== this.hover) { this.hover = h; this.dirty = true; cv.style.cursor = h >= 0 ? 'pointer' : 'default'; }
    });
    cv.addEventListener('mousedown', (e) => {
      const [sx, sy] = local(e);
      drag = { node: this._nodeAt(sx, sy), sx, sy, vx: this.view.x, vy: this.view.y, moved: false };
    });
    this._onMouseUp = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.node >= 0) this.worker.postMessage({ type: 'drag', i: d.node, x: this.pos[d.node * 2], y: this.pos[d.node * 2 + 1], fix: false });
      if (!d.moved && d.node >= 0 && e.target === cv) this._open(d.node, e);
    };
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.autoFit = false;
      const [sx, sy] = local(e);
      const [wx, wy] = this.toWorld(sx, sy);
      const k = Math.clamp(this.view.k * Math.exp(-e.deltaY * 0.0015), 0.05, 8);
      this.view.k = k;
      const [nx, ny] = this.toWorld(sx, sy);
      this.view.x += wx - nx;
      this.view.y += wy - ny;
      this.dirty = true;
    }, { passive: false });
    cv.addEventListener('mouseleave', () => { this.hover = -1; this.dirty = true; });
  }

  async _open(i, e) {
    const nd = this.nodes[i];
    if (nd.type === 'tag') { this.app.openTagSearch(nd.label); return; }
    if (nd.type === 'unresolved') { this.app.workspace.openLinkText(nd.label, '', Keymap.isModEvent(e) || false); return; }
    if (nd.file) await this.app.workspace.getLeaf(Keymap.isModEvent(e) || (this.leaf.getRoot() === this.app.workspace.rootSplit && !this.local ? 'tab' : false)).openFile(nd.file);
  }

  // ------------------------------------------------------------- controls panel
  _buildControls() {
    const el = this.controlsEl;
    el.empty();
    const btn = el.createDiv({ cls: 'graph-controls-button clickable-icon', attr: { 'aria-label': t('graph.settings') } });
    setIcon(btn, 'settings');
    btn.addEventListener('click', () => el.toggleClass('is-close', !el.hasClass('is-close')));
    const reset = el.createDiv({ cls: 'graph-controls-button mod-reset clickable-icon', attr: { 'aria-label': t('graph.reset') } });
    setIcon(reset, 'refresh');
    reset.addEventListener('click', () => { this.options = { ...DEFAULT_OPTIONS }; this._buildControls(); this.build(false); this._save(); });
    const body = el.createDiv('graph-controls-body');
    this.countEl = body.createDiv('graph-count');
    const o = this.options;
    const section = (title) => {
      const s = body.createDiv('graph-control-section');
      const head = s.createDiv({ cls: 'graph-control-section-header', text: title });
      const inner = s.createDiv('graph-control-section-body');
      head.addEventListener('click', () => s.toggleClass('is-collapsed', !s.hasClass('is-collapsed')));
      return inner;
    };
    const change = (key, rebuild) => (v) => { o[key] = v; if (rebuild) this.rebuild(); else { this._sendParams(); this.dirty = true; } this._save(); };
    const f = section(t('graph.filters'));
    new Setting(f).setName(t('graph.search')).addSearch((s) => s.setValue(o.search).setPlaceholder(t('graph.search-placeholder')).onChange(change('search', true)));
    if (this.local) {
      new Setting(f).setName(t('graph.depth')).addSlider((s) => s.setLimits(1, 5, 1).setValue(o.depth).setDynamicTooltip().onChange(change('depth', true)));
      new Setting(f).setName(t('graph.incoming')).addToggle((tg) => tg.setValue(o.localBacklinks).onChange(change('localBacklinks', true)));
      new Setting(f).setName(t('graph.outgoing')).addToggle((tg) => tg.setValue(o.localForelinks).onChange(change('localForelinks', true)));
    }
    new Setting(f).setName(t('graph.tags')).addToggle((tg) => tg.setValue(o.showTags).onChange(change('showTags', true)));
    new Setting(f).setName(t('graph.attachments')).addToggle((tg) => tg.setValue(o.showAttachments).onChange(change('showAttachments', true)));
    new Setting(f).setName(t('graph.existing-only')).addToggle((tg) => tg.setValue(o.hideUnresolved).onChange(change('hideUnresolved', true)));
    new Setting(f).setName(t('graph.orphans')).addToggle((tg) => tg.setValue(o.showOrphans).onChange(change('showOrphans', true)));
    const g = section(t('graph.groups'));
    (o.colorGroups || []).forEach((grp, i) => {
      new Setting(g).addText((x) => x.setValue(grp.query).setPlaceholder('tag:#project').onChange((v) => { grp.query = v; this.rebuild(); this._save(); }))
        .addColorPicker((cp) => cp.setValue(grp.color).onChange((v) => { grp.color = v; this.rebuild(); this._save(); }))
        .addExtraButton((b) => b.setIcon('x').onClick(() => { o.colorGroups.splice(i, 1); this._buildControls(); this.rebuild(); this._save(); }));
    });
    new Setting(g).addButton((b) => b.setButtonText(t('graph.new-group')).onClick(() => {
      o.colorGroups = [...(o.colorGroups || []), { query: '', color: '#e05c00' }];
      this._buildControls();
    }));
    const d = section(t('graph.display'));
    new Setting(d).setName(t('graph.arrows')).addToggle((tg) => tg.setValue(o.showArrow).onChange(change('showArrow')));
    new Setting(d).setName(t('graph.text-fade')).addSlider((s) => s.setLimits(-3, 3, 0.1).setValue(o.textFadeMultiplier).onChange(change('textFadeMultiplier')));
    new Setting(d).setName(t('graph.node-size')).addSlider((s) => s.setLimits(0.1, 5, 0.1).setValue(o.nodeSizeMultiplier).onChange(change('nodeSizeMultiplier')));
    new Setting(d).setName(t('graph.link-thickness')).addSlider((s) => s.setLimits(0.1, 5, 0.1).setValue(o.lineSizeMultiplier).onChange(change('lineSizeMultiplier')));
    new Setting(d).addButton((b) => b.setButtonText(t('graph.animate')).onClick(() => this.build(false)));
    const fo = section(t('graph.forces'));
    new Setting(fo).setName(t('graph.center')).addSlider((s) => s.setLimits(0, 1, 0.01).setValue(o.centerStrength).onChange(change('centerStrength')));
    new Setting(fo).setName(t('graph.repel')).addSlider((s) => s.setLimits(0, 20, 0.5).setValue(o.repelStrength).onChange(change('repelStrength')));
    new Setting(fo).setName(t('graph.link-force')).addSlider((s) => s.setLimits(0, 1, 0.01).setValue(o.linkStrength).onChange(change('linkStrength')));
    new Setting(fo).setName(t('graph.link-distance')).addSlider((s) => s.setLimits(30, 500, 1).setValue(o.linkDistance).onChange(change('linkDistance')));
  }

  _save() {
    this.app.workspace.requestSaveLayout();
    if (!this.local) this.app.config.write('graph.json', this.options).catch(() => {});
  }

  onPaneMenu(menu, source) {
    menu.addItem((i) => i.setTitle(t('graph.export')).setIcon('image').onClick(() => {
      const a = document.createElement('a');
      a.href = this.canvas.toDataURL('image/png');
      a.download = 'graph.png';
      a.click();
    }));
    super.onPaneMenu(menu, source);
  }
}

export class LocalGraphView extends GraphView {
  constructor(leaf) { super(leaf, true); }
}
