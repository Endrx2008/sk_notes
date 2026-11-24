// SKAI's scorpion on the graph (desktop only; the Android app has none, also when it calls SKAI
// on the local network).
//
// A small house sits at the bottom left of the graph. When the model works on the notes, a
// scorpion comes out of it and walks to the dots of the files: it lights a note it reads with
// a beam, it writes on a note it edits, makes a new dot appear, draws the thread between two
// notes it links, and sweeps the whole graph when it scans all of the memory. With nothing left
// to do it walks back home and sleeps there (small "z" rise from the house) until the next job,
// and comes out again towards the files it works on.
//
// What it shows:
//   - in SKAI_ Memory (the model's own memory): what other programs do with the notes – the apps
//     of SKAI reading them (the watcher reports files opened by others), writing, creating,
//     deleting them and adding links between them; and what the SKAI sidebar does;
//   - in every other vault: only what the SKAI sidebar does, when the user asks it something
//     (the notes it reads to answer, the changes applied to a note, the links inserted).
// Jobs come as workspace event 'skai-activity' {kind: read|edit|create|link|delete|scan, path, to}.

import { onBackend } from '../core/api.js';
import { t } from '../core/i18n.js';

const SPEED = 260; // px per second, at least
const MAX_WALK = 1.4; // seconds: far dots are reached faster
const DURATION = { read: 1.5, edit: 1.8, create: 1.6, delete: 1.3, scan: 2.4, link: 0.6 };
const IDLE_BEFORE_HOME = 2.5; // seconds without work before going home
const MAX_QUEUE = 40;

export function installScorpion(app) {
  const pet = new ScorpionPet(app);
  app.skaiPet = pet; // tests and plugins: app.skaiPet.queue
  app.workspace.on('skai-activity', (job) => pet.add(job));
  app.on('ready', () => pet.attach());
  app.workspace.on('layout-change', () => pet.attach());
  app.workspace.on('active-leaf-change', () => pet.attach());
  if (app.info?.vault?.protected) watchMemory(app, pet);
}

/** SKAI_ Memory: what other programs do with the notes becomes jobs of the scorpion. */
function watchMemory(app, pet) {
  const linksOf = (p) => new Set(Object.keys(app.metadataCache.resolvedLinks[p] || {}));
  let known = null; // path -> Set of linked paths, to see which links are new
  const snapshot = () => {
    known = new Map();
    for (const p of Object.keys(app.metadataCache.resolvedLinks)) known.set(p, linksOf(p));
  };
  app.metadataCache.on('resolved', () => { if (!known) snapshot(); });
  onBackend('read', (d) => {
    if (d.scan) pet.add({ kind: 'scan', path: d.paths?.[0] });
    else for (const p of d.paths || []) pet.add({ kind: 'read', path: p });
  });
  const after = (fn) => setTimeout(fn, 0); // once the app has taken the change in
  onBackend('create', (d) => { if (d.external && !d.file?.folder) after(() => { pet.add({ kind: 'create', path: d.file.path }); newLinks(d.file.path); }); });
  onBackend('modify', (d) => { if (d.external) after(() => { pet.add({ kind: 'edit', path: d.file.path }); newLinks(d.file.path); }); });
  onBackend('delete', (d) => { if (d.external && !d.file?.folder) pet.add({ kind: 'delete', path: d.file.path }); });
  function newLinks(path) {
    if (!known) snapshot();
    const now = linksOf(path);
    const before = known.get(path) || new Set();
    for (const to of now) if (!before.has(to) && to !== path) pet.add({ kind: 'link', path, to });
    known.set(path, now);
  }
}

class ScorpionPet {
  constructor(app) {
    this.app = app;
    this.queue = [];
    this.recent = new Map(); // kind|path -> time, to drop the same job twice in a row
    this.view = null; // the graph view it lives on
    this.layer = null;
    this.state = 'sleep'; // sleep | out (walking or working) | home (walking back)
    this.x = 0; this.y = 0; this.angle = -Math.PI / 4;
    this.job = null; // {kind, path, to, phase: 'walk'|'work'|'walk2', t}
    this.effects = []; // drawn on their own: beams fading, rings, threads
    this.idleSince = 0;
    this.last = 0;
    this.raf = 0;
    this.sleepTimer = 0;
    this.colors = null;
    app.workspace.on('css-change', () => { this.colors = null; });
  }

  // ------------------------------------------------------------- where it lives
  /** The first global graph on screen; none: the jobs wait (a few) until one is shown. */
  attach() {
    const leaves = this.app.workspace.getLeavesOfType('graph').filter((l) => l.view?.contentEl?.isConnected && l.view.contentEl.offsetParent !== null);
    const view = leaves[0]?.view || null;
    if (view === this.view && this.layer?.isConnected) return;
    this.layer?.remove();
    this.layer = null;
    this.view = view;
    if (!view) return;
    this.layer = view.contentEl.createDiv({ cls: 'skai-pet-layer', attr: { 'aria-hidden': 'true' } });
    this.canvas = this.layer.createEl('canvas', { cls: 'skai-pet-canvas' });
    this.ctx = this.canvas.getContext('2d');
    this.colors = null;
    if (this.state !== 'out') { this.state = 'sleep'; [this.x, this.y] = this.door(); }
    this.kick();
  }

  door() {
    const h = this.layer ? this.layer.clientHeight : 300;
    return [40, h - 24];
  }

  // ------------------------------------------------------------- jobs
  add(job) {
    if (!job || !job.kind || (!job.path && job.kind !== 'scan')) return;
    const key = `${job.kind}|${job.path}|${job.to || ''}`;
    const now = performance.now();
    if (now - (this.recent.get(key) || -1e9) < 3000) return;
    this.recent.set(key, now);
    if (this.recent.size > 200) this.recent.clear();
    this.queue.push({ ...job });
    while (this.queue.length > MAX_QUEUE) {
      const i = this.queue.findIndex((j) => j.kind === 'read'); // reads are dropped first
      this.queue.splice(i >= 0 ? i : 0, 1);
    }
    this.attach();
    this.kick();
  }

  /** The screen place of a note's dot in the graph, or null when it is not drawn. */
  dot(path) {
    const v = this.view;
    if (!v?.pos || !path) return null;
    const i = v.nodes.findIndex((n) => n.id === path);
    if (i < 0 || v.pos.length < (i + 1) * 2) return null;
    const [x, y] = v.toScreen(v.pos[i * 2], v.pos[i * 2 + 1]);
    return { x, y, r: Math.max(1.5, v.radius(i) * Math.sqrt(v.view.k)) };
  }

  center() {
    return { x: this.layer.clientWidth / 2, y: this.layer.clientHeight / 2, r: 0 };
  }

  next() {
    while (this.queue.length) {
      const job = this.queue.shift();
      if (job.kind === 'scan' || this.dot(job.path)) { this.job = { ...job, phase: 'walk', t: 0 }; return true; }
      // a note the graph does not show (filtered, not loaded yet): a create may show up a moment later
      if (job.kind === 'create' && !job.retried) { job.retried = true; setTimeout(() => { this.queue.push(job); this.kick(); }, 600); }
    }
    return false;
  }

  label(job) {
    const name = (p) => String(p || '').split('/').pop().replace(/\.md$/, '');
    if (job.kind === 'link') return t('pc.pet.link', { name: name(job.path), to: name(job.to) });
    if (job.kind === 'scan') return t('pc.pet.scan');
    return t(`pc.pet.${job.kind}`, { name: name(job.path) });
  }

  // ------------------------------------------------------------- the loop
  kick() {
    if (!this.layer) return;
    clearTimeout(this.sleepTimer);
    this.sleepTimer = 0;
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame((ts) => this.frame(ts)); }
  }

  frame(ts) {
    this.raf = 0;
    if (!this.layer?.isConnected) { this.attach(); if (!this.layer) return; }
    const dt = Math.min(0.1, (ts - this.last) / 1000);
    this.last = ts;
    this.step(dt, ts / 1000);
    this.draw(ts / 1000);
    if (this.state === 'sleep' && !this.effects.length && !this.queue.length) {
      // asleep: only the "z" move, a few times a second
      this.sleepTimer = setTimeout(() => this.kick(), 120);
      return;
    }
    this.raf = requestAnimationFrame((t2) => this.frame(t2));
  }

  step(dt, now) {
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter((e) => e.t < e.life);
    const [hx, hy] = this.door();
    if (this.state === 'sleep') {
      this.x = hx; this.y = hy;
      if (this.queue.length && this.next()) { this.state = 'out'; this.angle = -Math.PI / 3; }
      return;
    }
    if (this.state === 'home') {
      if (this.queue.length && this.next()) { this.state = 'out'; return; }
      if (this.walkTo(hx, hy, dt, 0)) this.state = 'sleep';
      return;
    }
    // out
    if (!this.job) {
      if (this.next()) return;
      if (!this.idleSince) this.idleSince = now;
      if (now - this.idleSince > IDLE_BEFORE_HOME) { this.state = 'home'; this.idleSince = 0; }
      return;
    }
    this.idleSince = 0;
    const job = this.job;
    const target = job.kind === 'scan' ? this.center() : (job.phase === 'walk2' ? this.dot(job.to) : this.dot(job.path));
    if (!target) { this.job = null; return; } // the dot went away (filter, delete)
    if (job.phase === 'walk' || job.phase === 'walk2') {
      const stand = job.kind === 'scan' ? 0 : target.r + 44;
      if (job.phase === 'walk2') {
        const from = this.dot(job.path);
        if (from) job.from = from;
      }
      if (this.walkTo(target.x, target.y, dt, stand)) {
        job.phase = job.phase === 'walk2' ? 'done' : 'work';
        job.t = 0;
        if (job.kind === 'create') this.effects.push({ type: 'ring', path: job.path, t: 0, life: 1.2 });
        if (job.kind === 'delete') this.effects.push({ type: 'gone', path: job.path, t: 0, life: 1.2 });
        if (job.phase === 'done') this.effects.push({ type: 'thread', path: job.path, to: job.to, t: 0, life: 1.6 });
      }
    } else if (job.phase === 'work') {
      job.t += dt;
      const face = Math.atan2(target.y - this.y, target.x - this.x);
      if (job.kind !== 'scan') this.turn(face, dt);
      else this.angle += dt * (Math.PI * 2 / DURATION.scan);
      if (job.t >= (DURATION[job.kind] || 1.4)) {
        if (job.kind === 'read') this.effects.push({ type: 'beam-out', path: job.path, t: 0, life: 0.5 });
        if (job.kind === 'link') { job.phase = 'walk2'; job.t = 0; return; }
        this.job = null;
      }
    } else {
      this.job = null;
    }
  }

  turn(goal, dt) {
    let d = goal - this.angle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.angle += d * Math.min(1, dt * 10);
  }

  /** One step towards (x, y), stopping `stand` px before it; true when there. */
  walkTo(x, y, dt, stand) {
    const dx = x - this.x;
    const dy = y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= stand + 1) { this.walking = false; return true; }
    this.turn(Math.atan2(dy, dx), dt);
    const speed = Math.max(SPEED, dist / MAX_WALK);
    const stepLen = Math.min(dist - stand, speed * dt);
    this.x += (dx / dist) * stepLen;
    this.y += (dy / dist) * stepLen;
    this.walking = true;
    return dist - stepLen <= stand + 1;
  }

  // ------------------------------------------------------------- drawing
  palette() {
    if (this.colors) return this.colors;
    const cs = getComputedStyle(document.body);
    // any CSS colour (hsl, names, variables of a theme) becomes '#rrggbb' or 'rgba(…)' for the canvas
    const probe = document.createElement('canvas').getContext('2d');
    const v = (n, d) => { probe.fillStyle = d; probe.fillStyle = cs.getPropertyValue(n).trim() || d; return probe.fillStyle; };
    this.colors = {
      accent: v('--sk-accent', '#e05c00'), text: v('--text-normal', '#ddd'), muted: v('--text-muted', '#999'),
      bg: v('--background-secondary', '#1a1a1a'), border: v('--sk-border', '#444'), beam: v('--text-accent', '#ffcf6b'),
      red: v('--text-error', '#e5484d'), label: v('--background-primary', '#0d0d0d'),
      font: cs.fontFamily || 'monospace',
    };
    return this.colors;
  }

  draw(now) {
    const cv = this.canvas;
    const w = this.layer.clientWidth;
    const h = this.layer.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const c = this.ctx;
    const col = this.palette();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    this.drawEffects(c, col);
    const job = this.job;
    if (this.state === 'out' && job?.phase === 'work') {
      if (job.kind === 'read') this.drawBeam(c, col, this.dot(job.path), Math.min(1, job.t * 3));
      if (job.kind === 'edit') this.drawWriting(c, col, this.dot(job.path), job.t);
      if (job.kind === 'scan') this.drawSweep(c, col, job.t);
    }
    if (this.state === 'out' && job?.phase === 'walk2') {
      const a = this.dot(job.path);
      if (a) this.drawThread(c, col, a, { x: this.x, y: this.y }, 1);
    }
    this.drawHouse(c, col, now);
    if (this.state !== 'sleep') {
      drawScorpion(c, this.x, this.y, this.angle, now, { walking: this.walking, color: col.accent, working: job?.phase === 'work' });
      if (job) this.drawLabel(c, col, this.label(job));
    }
  }

  drawHouse(c, col, now) {
    const [dx, dy] = this.door();
    const x = dx - 22;
    const base = dy + 12;
    c.save();
    c.lineJoin = 'round';
    c.lineWidth = 1.5;
    // walls
    c.fillStyle = col.bg;
    c.strokeStyle = col.border;
    c.beginPath();
    c.rect(x, base - 26, 44, 26);
    c.fill(); c.stroke();
    // roof
    c.fillStyle = col.accent;
    c.beginPath();
    c.moveTo(x - 6, base - 25); c.lineTo(dx, base - 46); c.lineTo(x + 50, base - 25); c.closePath();
    c.fill();
    // door: dark when the scorpion is inside
    c.fillStyle = this.state === 'sleep' ? 'rgba(0,0,0,.65)' : 'rgba(0,0,0,.35)';
    c.beginPath();
    c.moveTo(dx - 8, base); c.lineTo(dx - 8, base - 11); c.arc(dx, base - 11, 8, Math.PI, 0); c.lineTo(dx + 8, base);
    c.closePath(); c.fill();
    // asleep: "z" rising from the roof
    if (this.state === 'sleep') {
      c.fillStyle = col.muted;
      for (let i = 0; i < 3; i++) {
        const p = ((now * 0.45) + i / 3) % 1;
        c.globalAlpha = Math.sin(p * Math.PI) * 0.9;
        c.font = `${9 + p * 7}px ${col.font}`;
        c.fillText('z', dx + 12 + p * 14, base - 44 - p * 26);
      }
      c.globalAlpha = 1;
    }
    c.restore();
  }

  drawBeam(c, col, dot, k) {
    if (!dot) return;
    const hx = this.x + Math.cos(this.angle) * 24;
    const hy = this.y + Math.sin(this.angle) * 24;
    const ang = Math.atan2(dot.y - hy, dot.x - hx);
    const spread = dot.r + 9;
    const px = -Math.sin(ang) * spread;
    const py = Math.cos(ang) * spread;
    const g = c.createLinearGradient(hx, hy, dot.x, dot.y);
    g.addColorStop(0, withAlpha(col.beam, 0.75 * k));
    g.addColorStop(1, withAlpha(col.beam, 0.18 * k));
    c.save();
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(hx, hy); c.lineTo(dot.x + px, dot.y + py); c.lineTo(dot.x - px, dot.y - py); c.closePath();
    c.fill();
    const halo = c.createRadialGradient(dot.x, dot.y, dot.r, dot.x, dot.y, dot.r + 14);
    halo.addColorStop(0, withAlpha(col.beam, 0.7 * k));
    halo.addColorStop(1, withAlpha(col.beam, 0));
    c.fillStyle = halo;
    c.beginPath(); c.arc(dot.x, dot.y, dot.r + 14, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  drawWriting(c, col, dot, tt) {
    if (!dot) return;
    c.save();
    // the dot pulses while it is written
    const pulse = (tt * 1.6) % 1;
    c.strokeStyle = withAlpha(col.accent, 1 - pulse);
    c.lineWidth = 2;
    c.beginPath(); c.arc(dot.x, dot.y, dot.r + 4 + pulse * 14, 0, Math.PI * 2); c.stroke();
    // small strokes of writing around it
    c.strokeStyle = col.accent;
    c.lineWidth = 1.6;
    for (let i = 0; i < 4; i++) {
      const a = tt * 3 + i * (Math.PI / 2);
      const r = dot.r + 9;
      const x = dot.x + Math.cos(a) * r;
      const y = dot.y + Math.sin(a) * r;
      c.globalAlpha = 0.5 + 0.5 * Math.sin(tt * 9 + i);
      c.beginPath(); c.moveTo(x - 3, y + 1); c.quadraticCurveTo(x, y - 3, x + 3, y + 1); c.stroke();
    }
    c.restore();
  }

  drawSweep(c, col, tt) {
    const r = Math.hypot(this.layer.clientWidth, this.layer.clientHeight);
    const a = this.angle;
    const g = c.createRadialGradient(this.x, this.y, 10, this.x, this.y, r * 0.6);
    g.addColorStop(0, withAlpha(col.beam, 0.45));
    g.addColorStop(1, withAlpha(col.beam, 0));
    c.save();
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(this.x, this.y);
    c.arc(this.x, this.y, r, a - 0.35, a + 0.35);
    c.closePath();
    c.fill();
    c.restore();
  }

  drawThread(c, col, a, b, k) {
    c.save();
    c.strokeStyle = withAlpha(col.accent, 0.9 * k);
    c.shadowColor = col.accent;
    c.shadowBlur = 8 * k;
    c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    c.restore();
  }

  drawEffects(c, col) {
    for (const e of this.effects) {
      const k = 1 - e.t / e.life;
      const d = this.dot(e.path);
      if (e.type === 'thread') {
        const b = this.dot(e.to);
        if (d && b) this.drawThread(c, col, d, b, k);
      } else if (e.type === 'beam-out') {
        if (d) this.drawBeam(c, col, d, k);
      } else if (e.type === 'ring' && d) {
        c.save();
        c.strokeStyle = withAlpha(col.accent, k);
        c.lineWidth = 2.5;
        c.beginPath(); c.arc(d.x, d.y, d.r + 4 + (1 - k) * 26, 0, Math.PI * 2); c.stroke();
        c.restore();
      } else if (e.type === 'gone' && d) {
        c.save();
        c.strokeStyle = withAlpha(col.red, k);
        c.lineWidth = 2.5;
        const s = d.r + 6;
        c.beginPath(); c.moveTo(d.x - s, d.y - s); c.lineTo(d.x + s, d.y + s); c.moveTo(d.x + s, d.y - s); c.lineTo(d.x - s, d.y + s); c.stroke();
        c.restore();
      }
    }
  }

  drawLabel(c, col, text) {
    c.save();
    c.font = `11px ${col.font}`;
    const w = c.measureText(text).width + 12;
    const x = Math.max(4, Math.min(this.layer.clientWidth - w - 4, this.x - w / 2));
    const y = Math.max(4, this.y - 46);
    c.globalAlpha = 0.88;
    c.fillStyle = col.label;
    c.strokeStyle = col.border;
    c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 18, 9) : c.rect(x, y, w, 18); c.fill(); c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = col.text;
    c.fillText(text, x + 6, y + 13);
    c.restore();
  }
}

/** A scorpion seen from above, head towards +x: claws in front, four legs a side, and two tails
 * like the Skorpion OS logo. Legs move while it walks; the tails sway faster while it works. */
export function drawScorpion(c, x, y, angle, now, { walking = false, color = '#e05c00', working = false, scale = 1.5 } = {}) {
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.scale(scale, scale);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const dark = 'rgba(0,0,0,.55)';
  // legs
  c.strokeStyle = color;
  c.lineWidth = 1.3;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const bx = 4 - i * 3;
      const wig = walking ? Math.sin(now * 16 + i * 1.4 + (side > 0 ? Math.PI : 0)) * 1.8 : 0;
      c.beginPath();
      c.moveTo(bx, side * 3);
      c.lineTo(bx + 1 + wig * 0.5, side * 6.5);
      c.lineTo(bx - 1.5 + wig, side * 9);
      c.stroke();
    }
  }
  // claws (pedipalps)
  c.lineWidth = 1.6;
  for (const side of [-1, 1]) {
    const open = working ? Math.abs(Math.sin(now * 8)) * 0.5 : 0.15;
    c.beginPath();
    c.moveTo(9, side * 2.2); c.lineTo(12, side * 5.5); c.lineTo(15, side * 6);
    c.stroke();
    c.fillStyle = color;
    c.beginPath(); c.ellipse(17, side * 6, 3.2, 2, side * 0.2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = dark;
    c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(20, side * (6 - open * 2)); c.lineTo(17.5, side * 6); c.stroke();
    c.strokeStyle = color;
    c.lineWidth = 1.6;
  }
  // body and head
  c.fillStyle = color;
  c.strokeStyle = dark;
  c.lineWidth = 0.8;
  c.beginPath(); c.ellipse(0, 0, 7.5, 4.6, 0, 0, Math.PI * 2); c.fill(); c.stroke();
  c.beginPath(); c.ellipse(7.5, 0, 3.8, 3.4, 0, 0, Math.PI * 2); c.fill(); c.stroke();
  c.beginPath();
  for (const sx of [-4, -1.5, 1, 3.5]) { c.moveTo(sx, -4); c.quadraticCurveTo(sx + 0.8, 0, sx, 4); }
  c.stroke();
  c.fillStyle = 'rgba(0,0,0,.7)';
  c.beginPath(); c.arc(9.5, -1.2, 0.7, 0, Math.PI * 2); c.arc(9.5, 1.2, 0.7, 0, Math.PI * 2); c.fill();
  // two tails, as in the Skorpion OS logo: from the end of the body each goes back towards the
  // middle, then out to its side and forward again, the sting at its tip turned inwards. They
  // sway (faster while it works), one a little after the other.
  for (const side of [-1, 1]) {
    const sway = Math.sin(now * (working ? 10 : 3) + (side > 0 ? 0.9 : 0)) * (working ? 1.3 : 0.5);
    const pts = [[-7.5, side * 1.2], [-11.2, side * 2.4], [-14, side * 4.6], [-15.4, side * 7.8],
      [-14.4 + sway * 0.3, side * 11], [-11.6 + sway * 0.6, side * 13.2], [-8.4 + sway, side * 13.6]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      c.fillStyle = color;
      c.strokeStyle = dark;
      c.lineWidth = 0.8;
      c.beginPath(); c.arc(ax, ay, 2.1 - i * 0.17, 0, Math.PI * 2); c.fill(); c.stroke();
    }
    const [sx, sy] = pts[pts.length - 1];
    c.fillStyle = color;
    c.beginPath(); c.arc(sx, sy, 1.6, 0, Math.PI * 2); c.fill(); c.stroke();
    // the sting: forward and bent towards the body
    c.strokeStyle = dark;
    c.lineWidth = 1.1;
    c.beginPath(); c.moveTo(sx + 1.1, sy); c.quadraticCurveTo(sx + 3.4, sy - side * 0.2, sx + 3.6, sy - side * 2.4); c.stroke();
  }
  c.restore();
}

/** '#rrggbb' / 'rgb(…)' / any CSS colour with an alpha. */
function withAlpha(color, a) {
  const al = Math.max(0, Math.min(1, a));
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${al})`;
  }
  const r = /^rgba?\(([^)]+)\)$/.exec(color);
  if (r) {
    const p = r[1].split(',').map((x) => x.trim());
    return `rgba(${p[0]},${p[1]},${p[2]},${al})`;
  }
  return color;
}
