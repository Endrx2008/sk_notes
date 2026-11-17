// sk_notes for Android – the versions of a note.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// What a version system does, with the words and the steps of a phone:
//   - a timeline of the note: now, and every version kept, each with what it added and removed;
//   - "Go back to this version": the note becomes that version. The work it replaces is kept
//     as a version of its own, so the same button also goes forward again;
//   - "Take changes from this version": the changes that version made, one by one, to tick and
//     apply to the note as it is now. This is how work done later is brought onto a note
//     that was taken back to an earlier point and changed there.
// Nothing is ever lost: every step first keeps the note as it was.

import { call } from './api.js';
import { diffLines, diffStats, renderDiff } from '@desktop/core/diff.js';
import { setIcon } from '@desktop/core/icons.js';
import { errorText, t } from '@desktop/core/i18n.js';
import { Modal, confirmDialog } from '@desktop/ui/kit.js';

const CONTEXT = 3;

/** The changes between two texts as separate pieces: {del, add, before, after}. */
export function hunksOf(ops) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'same') { i++; continue; }
    let j = i;
    while (j < ops.length && ops[j].type !== 'same') j++;
    const piece = ops.slice(i, j);
    const before = [];
    for (let k = i - 1; k >= 0 && before.length < CONTEXT && ops[k].type === 'same'; k--) before.unshift(ops[k].text);
    const after = [];
    for (let k = j; k < ops.length && after.length < CONTEXT && ops[k].type === 'same'; k++) after.push(ops[k].text);
    out.push({ del: piece.filter((o) => o.type === 'del').map((o) => o.text), add: piece.filter((o) => o.type === 'add').map((o) => o.text), before, after, atStart: i === 0, atEnd: j === ops.length });
    i = j;
  }
  return out;
}

function findAll(lines, seq, from = 0) {
  const hits = [];
  if (!seq.length) return hits;
  for (let i = from; i + seq.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < seq.length; k++) if (lines[i + k] !== seq[k]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  return hits;
}

/** How well the lines around a position match the lines the change had around it. */
function fit(lines, start, end, h) {
  let score = 0;
  for (let k = 1; k <= h.before.length; k++) { if (lines[start - k] === h.before[h.before.length - k]) score++; else break; }
  for (let k = 0; k < h.after.length; k++) { if (lines[end + k] === h.after[k]) score++; else break; }
  return score;
}

/** Apply one change to the lines of a note. Returns 'applied', 'present' (it is already there)
 * or 'conflict' (the place it belongs to is not in this note any more). */
export function applyHunk(lines, h) {
  // already there?
  if (h.add.length) {
    for (const at of findAll(lines, h.add)) {
      if (fit(lines, at, at + h.add.length, h) > 0 || (!h.before.length && !h.after.length)) return 'present';
    }
  }
  if (h.del.length) {
    const places = findAll(lines, h.del);
    if (!places.length) return 'conflict';
    let best = places[0];
    let bestScore = -1;
    for (const at of places) {
      const s = fit(lines, at, at + h.del.length, h);
      if (s > bestScore) { best = at; bestScore = s; }
    }
    if (places.length > 1 && bestScore <= 0) return 'conflict'; // several places, none like the original
    lines.splice(best, h.del.length, ...h.add);
    return 'applied';
  }
  // only added lines: after the lines that came before them, or before the ones that followed
  for (let k = h.before.length; k >= 1; k--) {
    const places = findAll(lines, h.before.slice(h.before.length - k));
    if (places.length === 1 || (places.length > 1 && k === h.before.length)) {
      let best = places[0];
      let bestScore = -1;
      for (const at of places) {
        const s = fit(lines, at + k, at + k, h);
        if (s > bestScore) { best = at; bestScore = s; }
      }
      lines.splice(best + k, 0, ...h.add);
      return 'applied';
    }
  }
  for (let k = h.after.length; k >= 1; k--) {
    const places = findAll(lines, h.after.slice(0, k));
    if (places.length === 1) { lines.splice(places[0], 0, ...h.add); return 'applied'; }
  }
  if (h.atStart && !h.before.length) { lines.splice(0, 0, ...h.add); return 'applied'; }
  if (h.atEnd && !h.after.length) { lines.push(...h.add); return 'applied'; }
  return 'conflict';
}

class VersionsModal extends Modal {
  constructor(app, file) {
    super(app);
    this.file = file;
    this.modalEl.addClass('mod-version-history', 'mod-versions');
    this.texts = new Map(); // snapshot id → text
  }

  text(id) {
    if (!this.texts.has(id)) this.texts.set(id, call('history.read', { id }).then((x) => x ?? ''));
    return this.texts.get(id);
  }

  when(ts) {
    const m = window.moment(ts);
    return m.isSame(window.moment(), 'day') ? `${t('mobile.versions.today')} ${m.format('HH:mm')}` : m.format('D MMM YYYY, HH:mm');
  }

  async onOpen() {
    this.setTitle(t('mobile.versions.title', { name: this.file.basename }));
    this.body = this.contentEl.createDiv('versions');
    await this.showList();
  }

  async reload() {
    try { await this.app.flush?.(); } catch { /* what is on disk is used */ }
    this.current = await this.app.vault.read(this.file);
    this.snaps = await call('history.list', { path: this.file.path }); // newest first
  }

  chips(el, st) {
    const box = el.createDiv('versions-chips');
    if (st.added) box.createSpan({ cls: 'versions-chip is-add', text: `+${st.added}` });
    if (st.removed) box.createSpan({ cls: 'versions-chip is-del', text: `−${st.removed}` });
    if (!st.added && !st.removed) box.createSpan({ cls: 'versions-chip', text: '=' });
  }

  // ---------------------------------------------------------------- the timeline
  async showList() {
    await this.reload();
    const run = (this.run = (this.run || 0) + 1);
    const el = this.body;
    el.empty();
    el.createEl('p', { cls: 'versions-intro', text: t('mobile.versions.intro') });
    const list = el.createDiv('versions-list');
    const row = (title, sub, cls) => {
      const r = list.createDiv('versions-item' + (cls ? ' ' + cls : ''));
      setIcon(r.createDiv('versions-dot'), cls === 'is-now' ? 'pencil' : 'history');
      const tx = r.createDiv('versions-text');
      tx.createDiv({ cls: 'versions-when', text: title });
      if (sub) tx.createDiv({ cls: 'versions-reason', text: sub });
      return r;
    };
    const now = row(t('mobile.versions.now'), t('mobile.versions.now-desc'), 'is-now');
    if (!this.snaps.length) {
      el.createDiv({ cls: 'pane-empty', text: t('history.none') });
      return;
    }
    now.addEventListener('click', () => this.showVersion(null));
    const rows = this.snaps.map((s) => {
      const r = row(this.when(s.ts), t(`history.reason.${s.reason}`));
      r.addEventListener('click', () => this.showVersion(s));
      return r;
    });
    // what each one changed, worked out a few at a time so the list is there at once
    (async () => {
      const newest = await this.text(this.snaps[0].id);
      if (run !== this.run) return;
      this.chips(now, diffStats(diffLines(newest, this.current)));
      if (newest === this.current) now.addClass('is-same');
      for (let i = 0; i < this.snaps.length; i++) {
        const text = await this.text(this.snaps[i].id);
        const older = this.snaps[i + 1] ? await this.text(this.snaps[i + 1].id) : '';
        if (run !== this.run) return;
        this.chips(rows[i], diffStats(diffLines(older, text)));
        if (text === this.current) rows[i].addClass('is-current');
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
    })().catch((e) => console.error('versions', e));
  }

  header(title, sub) {
    const el = this.body;
    el.empty();
    const head = el.createDiv('versions-head');
    const back = head.createDiv({ cls: 'clickable-icon versions-back', attr: { 'aria-label': t('view.back') } });
    setIcon(back, 'arrow-left');
    back.addEventListener('click', () => this.showList());
    const tx = head.createDiv('versions-head-text');
    tx.createDiv({ cls: 'versions-when', text: title });
    if (sub) tx.createDiv({ cls: 'versions-reason', text: sub });
    return el;
  }

  /** Android's back: from a version to the timeline, from the timeline out. */
  goBack() {
    if (this.body?.querySelector('.versions-head')) { this.showList(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- one version
  async showVersion(s) {
    const isNow = s === null;
    const el = this.header(isNow ? t('mobile.versions.now') : this.when(s.ts), isNow ? t('mobile.versions.now-desc') : t(`history.reason.${s.reason}`));
    const i = isNow ? -1 : this.snaps.indexOf(s);
    const text = isNow ? this.current : await this.text(s.id);
    const olderSnap = this.snaps[i + 1];
    const older = olderSnap ? await this.text(olderSnap.id) : '';
    let mode = 'previous';
    const seg = el.createDiv('versions-seg');
    const tabs = {};
    const diffEl = el.createDiv('versions-diff');
    const sumEl = el.createDiv('versions-summary');
    const draw = () => {
      for (const k of Object.keys(tabs)) tabs[k].toggleClass('is-active', k === mode);
      diffEl.empty();
      // previous: what this version changed. current: what separates this version from the note now
      const ops = mode === 'previous' ? diffLines(older, text) : diffLines(text, this.current);
      const st = diffStats(ops);
      sumEl.setText(st.added || st.removed ? t(mode === 'previous' ? 'mobile.versions.sum-previous' : 'mobile.versions.sum-current', { added: st.added, removed: st.removed })
        : t(mode === 'previous' ? 'mobile.versions.same-previous' : 'mobile.versions.same-current'));
      if (st.added || st.removed) renderDiff(diffEl, ops, 2);
    };
    const tab = (id, label) => {
      const b = seg.createDiv({ cls: 'versions-seg-item', text: label });
      b.addEventListener('click', () => { mode = id; draw(); });
      tabs[id] = b;
    };
    tab('previous', t('mobile.versions.tab-previous'));
    if (!isNow) tab('current', t('mobile.versions.tab-current'));
    el.insertBefore(sumEl, diffEl);
    draw();
    if (isNow) return;
    const bar = el.createDiv('versions-actions');
    const same = text === this.current;
    const go = bar.createEl('button', { cls: 'mod-cta', text: t('mobile.versions.go') });
    go.disabled = same;
    go.addEventListener('click', async () => {
      const ok = await confirmDialog(this.app, { title: t('mobile.versions.go'), message: t('mobile.versions.go-confirm'), confirm: t('mobile.versions.go') });
      if (!ok) return;
      try {
        await this.app.flush?.();
        await call('history.restore', { path: this.file.path, id: s.id });
        this.app.notice(t('mobile.versions.went', { when: this.when(s.ts) }));
        await this.showList();
      } catch (e) { this.app.notice(e.detail || errorText(e)); }
    });
    const take = bar.createEl('button', { text: t('mobile.versions.take') });
    const pieces = hunksOf(diffLines(older, text));
    take.disabled = !pieces.length;
    take.addEventListener('click', () => this.showTake(s, pieces));
  }

  // ---------------------------------------------------------------- take changes of a version
  showTake(s, pieces) {
    const el = this.header(t('mobile.versions.take'), this.when(s.ts));
    el.querySelector('.versions-back').addEventListener('click', (e) => { e.stopImmediatePropagation(); this.showVersion(s); }, true);
    el.createEl('p', { cls: 'versions-intro', text: t('mobile.versions.take-intro') });
    const list = el.createDiv('versions-pieces');
    const picked = new Set(pieces.map((_, i) => i));
    const lines = this.current.split('\n');
    pieces.forEach((h, i) => {
      // tried on a copy: the user sees beforehand which ones fit the note as it is now
      const state = applyHunk(lines.slice(), h);
      const card = list.createDiv('versions-piece is-picked' + (state !== 'applied' ? ' is-' + state : ''));
      const top = card.createDiv('versions-piece-top');
      const box = top.createDiv('versions-check');
      setIcon(box, 'check');
      top.createDiv({ cls: 'versions-piece-title', text: t('mobile.versions.piece', { n: i + 1 }) });
      if (state !== 'applied') top.createSpan({ cls: 'versions-piece-flag', text: t(state === 'present' ? 'mobile.versions.present' : 'mobile.versions.conflict') });
      const d = card.createDiv('sk-diff versions-piece-diff');
      const line = (type, text) => {
        const r = d.createDiv(`sk-diff-line is-${type}`);
        r.createSpan({ cls: 'sk-diff-sign', text: type === 'add' ? '+' : type === 'del' ? '−' : ' ' });
        r.createSpan({ cls: 'sk-diff-text', text: text || ' ' });
      };
      for (const x of h.before.slice(-2)) line('same', x);
      for (const x of h.del) line('del', x);
      for (const x of h.add) line('add', x);
      for (const x of h.after.slice(0, 2)) line('same', x);
      if (state !== 'applied') { picked.delete(i); card.removeClass('is-picked'); }
      if (state === 'applied') {
        card.addEventListener('click', () => {
          if (picked.has(i)) picked.delete(i); else picked.add(i);
          card.toggleClass('is-picked', picked.has(i));
          apply.disabled = !picked.size;
          apply.setText(t('mobile.versions.apply', { n: picked.size }));
        });
      }
    });
    const bar = el.createDiv('versions-actions');
    const apply = bar.createEl('button', { cls: 'mod-cta', text: t('mobile.versions.apply', { n: picked.size }) });
    apply.disabled = !picked.size;
    apply.addEventListener('click', async () => {
      try {
        await this.app.flush?.();
        const now = (await this.app.vault.read(this.file)).split('\n');
        let done = 0;
        let failed = 0;
        pieces.forEach((h, i) => {
          if (!picked.has(i)) return;
          const r = applyHunk(now, h);
          if (r === 'applied') done++; else if (r === 'conflict') failed++;
        });
        if (done) {
          await call('history.checkpoint', { path: this.file.path }); // the note as it was stays a version
          await this.app.vault.modify(this.file, now.join('\n'));
        }
        this.app.notice(t('mobile.versions.applied', { n: done }) + (failed ? ' ' + t('mobile.versions.not-applied', { n: failed }) : ''));
        await this.showList();
      } catch (e) { this.app.notice(e.detail || errorText(e)); }
    });
  }
}

export function installVersions(app) {
  const use = () => { app.openVersionHistory = (file) => new VersionsModal(app, file).open(); };
  use();
  app.on('ready', use); // the features of a PC set their own dialog while the app starts
  app.versionsBack = () => {
    const open = document.querySelector('.modal.mod-versions');
    return !!open && !!open.__versions?.goBack();
  };
  const onOpen = VersionsModal.prototype.onOpen;
  VersionsModal.prototype.onOpen = function tagged() { this.modalEl.__versions = this; return onOpen.call(this); };
}
