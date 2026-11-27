// Reminders: a line of a note flagged with a date and a time calls the user at that time.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A reminder is plain text at the end of a line, the form the Obsidian "Reminder" plugin uses:
//     - [ ] study chapter 3 (@2026-11-28 15:00)
// Any line may carry one (a task is the usual place); a ticked task ([x]) is done and calls no
// more. A date without a time calls at 09:00. The notes stay plain Markdown: nothing is kept
// anywhere else, apart from which reminders were already shown (reminders-shown.json, per device).
//
// The app around this module decides how the user is called: app.reminderHost
//   sync(list)   every reminder of the vault, each time they change (Android: alarms and widget)
//   notify(item) one reminder is due while the app is open (PC: a desktop notification)

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { debounce } from '../core/util.js';
import { Modal } from '../ui/kit.js';

export const REMINDER_RE = /\s*\(@(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\)/;
const DONE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX-]\]/;
const PREFIX_RE = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[.\]\s+)?(?:#{1,6}\s+)?/;
const SHOWN_FILE = 'reminders-shown.json';
const LATE = 24 * 3600 * 1000; // missed while the app was closed: still shown when it opens, up to a day late
const pad = (n) => String(n).padStart(2, '0');

/** The reminder of one line of text, or null. */
export function parseReminder(line) {
  const m = REMINDER_RE.exec(line);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const at = new Date(Number(y), Number(mo) - 1, Number(d), h === undefined ? 9 : Number(h), mi === undefined ? 0 : Number(mi)).getTime();
  if (!Number.isFinite(at)) return null;
  const text = (line.slice(0, m.index) + line.slice(m.index + m[0].length)).replace(PREFIX_RE, '').replace(/<span style="color:[^"]*">([^<]*)<\/span>/g, '$1').trim();
  return { at, text, done: DONE_RE.test(line), hasTime: h !== undefined };
}

/** The text written in a note for a time: "(@2026-11-28 15:00)". */
export function reminderMark(at) {
  const d = new Date(at);
  return `(@${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())})`;
}

/** A line with this reminder (or none: at = null). A plain line becomes a task to tick. */
export function setLineReminder(line, at) {
  let out = line.replace(REMINDER_RE, '').replace(/\s+$/, '');
  if (at === null) return out;
  if (!/^\s*(?:[-*+]|\d+[.)])\s+\[.\]/.test(out)) {
    const list = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(out);
    out = list ? `${out.slice(0, list[0].length)}[ ] ${out.slice(list[0].length)}` : `- [ ] ${out.trimStart()}`;
  }
  return `${out} ${reminderMark(at)}`;
}

/** "today 15:00", "tomorrow 09:00", "Fri 28 Nov 15:00" in the user's language. */
export function whenText(at) {
  const d = new Date(at);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return t('reminders.today', { time });
  if (diff === 1) return t('reminders.tomorrow', { time });
  if (diff === -1) return t('reminders.yesterday', { time });
  const lang = document.documentElement.lang || undefined;
  let date;
  try { date = d.toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }); } catch { date = d.toDateString(); }
  return `${date} ${time}`;
}

export class Reminders {
  constructor(app) {
    this.app = app;
    this.byFile = new Map(); // path → [{ path, line, text, at, done }]
    this.timer = null;
    this.shown = {};
    this.ready = false;
    this.changed = debounce(() => this._changed(), 600, true);
  }

  async start() {
    const app = this.app;
    const saved = await app.config.read(SHOWN_FILE).catch(() => null);
    this.shown = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const files = app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : app.vault.getFiles().filter((f) => f.extension === 'md');
    for (const f of files) await this._scan(f, false);
    this.ready = true;
    const ev = (name, fn) => app.vault.on(name, fn);
    this._refs = [
      ev('modify', (f) => { if (f?.extension === 'md') this._scan(f, true); }),
      ev('create', (f) => { if (f?.extension === 'md') this._scan(f, true); }),
      ev('delete', (f) => { if (f && this.byFile.delete(f.path)) this.changed(); }),
      ev('rename', (f, old) => {
        const items = this.byFile.get(old);
        if (items) { this.byFile.delete(old); if (f?.extension === 'md') this.byFile.set(f.path, items.map((r) => ({ ...r, path: f.path }))); this.changed(); }
      }),
    ];
    this._changed();
    // a phone asleep, a PC suspended: timers stop, so the due ones are looked at again when the page wakes
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this._arm(); });
  }

  async _scan(file, notify) {
    let text = '';
    try { text = await this.app.vault.cachedRead(file); } catch { text = ''; }
    const out = [];
    if (text.includes('(@')) {
      const lines = text.split('\n');
      let fence = false;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
        if (fence || !lines[i].includes('(@')) continue;
        const r = parseReminder(lines[i]);
        if (r) out.push({ path: file.path, line: i, ...r });
      }
    }
    const before = JSON.stringify(this.byFile.get(file.path) || []);
    if (out.length) this.byFile.set(file.path, out); else this.byFile.delete(file.path);
    if (notify && before !== JSON.stringify(out)) this.changed();
  }

  /** Every reminder of the vault, the earliest first. */
  list({ done = false } = {}) {
    const all = [];
    for (const items of this.byFile.values()) for (const r of items) if (done || !r.done) all.push(r);
    return all.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path) || a.line - b.line);
  }

  _key(r) { return `${r.path}|${r.at}|${r.text}`; }

  _changed() {
    const list = this.list();
    try { this.app.reminderHost?.sync?.(list); } catch (e) { console.error('reminders sync', e); }
    this.app.workspace.trigger('reminders-change', list);
    this._arm();
  }

  _arm() {
    clearTimeout(this.timer);
    if (!this.ready) return;
    const now = Date.now();
    const due = this.list().filter((r) => r.at <= now && r.at > now - LATE && !this.shown[this._key(r)]);
    for (const r of due) this._fire(r);
    if (due.length) this._saveShown();
    const next = this.list().find((r) => r.at > now);
    if (next) this.timer = setTimeout(() => this._arm(), Math.min(next.at - now + 50, 6 * 3600 * 1000));
  }

  _fire(r) {
    this.shown[this._key(r)] = Date.now();
    const file = this.app.vault.getFileByPath(r.path);
    const name = file?.basename || r.path;
    const n = this.app.notice(`⏰ ${r.text || name}\n${name} · ${whenText(r.at)}`, 0);
    // a tap on the notice opens the note at the line
    n?.noticeEl?.addEventListener('click', () => this.open(r));
    try { this.app.reminderHost?.notify?.(r, name); } catch (e) { console.error('reminder notify', e); }
  }

  _saveShown() {
    const old = Date.now() - 60 * 86400000;
    for (const [k, v] of Object.entries(this.shown)) if (v < old) delete this.shown[k];
    this.app.config.write(SHOWN_FILE, this.shown).catch(() => {});
  }

  /** Open the note of a reminder at its line. */
  async open(r) {
    const file = this.app.vault.getFileByPath(r.path);
    if (!file) return;
    await this.app.workspace.getLeaf(false).openFile(file, { active: true, eState: { line: r.line } });
  }

  /** Tick (or untick) the task of a reminder in its note. */
  async setDone(r, done) {
    const file = this.app.vault.getFileByPath(r.path);
    if (!file) return;
    await this.app.vault.process(file, (text) => {
      const lines = text.split('\n');
      const i = lines[r.line] !== undefined && parseReminder(lines[r.line])?.at === r.at ? r.line : lines.findIndex((l) => parseReminder(l)?.at === r.at && l.includes(r.text));
      if (i < 0) return text;
      if (/^\s*(?:[-*+]|\d+[.)])\s+\[.\]/.test(lines[i])) lines[i] = lines[i].replace(/\[.\]/, done ? '[x]' : '[ ]');
      else if (done) lines[i] = lines[i].replace(REMINDER_RE, '');
      return lines.join('\n');
    });
  }
}

// ---------------------------------------------------------------- set a reminder on a line
/** The value of <input type=datetime-local> for a time. */
const localValue = (at) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export class ReminderModal extends Modal {
  constructor(app, current, onDone) {
    super(app);
    this.current = current; // ms or null
    this.onDone = onDone; // (ms | null) => void
    this.modalEl.addClass('mod-reminder');
  }

  onOpen() {
    this.titleEl.setText(t('reminders.set-title'));
    const c = this.contentEl;
    c.createEl('p', { cls: 'reminder-explain', text: t('reminders.set-explain') });
    const start = this.current || (() => { const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); return d.getTime(); })();
    const input = c.createEl('input', { cls: 'reminder-input', attr: { type: 'datetime-local', value: localValue(start) } });
    const quick = c.createDiv('reminder-quick');
    const preset = (label, fn) => {
      const b = quick.createEl('button', { cls: 'reminder-chip', text: label });
      b.addEventListener('click', () => { input.value = localValue(fn()); });
    };
    const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.getTime(); };
    preset(t('reminders.in-hour'), () => Date.now() + 3600000);
    preset(t('reminders.this-evening'), () => at(0, 18));
    preset(t('reminders.tomorrow-morning'), () => at(1, 9));
    preset(t('reminders.next-week'), () => at(7, 9));
    const foot = c.createDiv('modal-button-container');
    if (this.current) {
      const rm = foot.createEl('button', { cls: 'mod-warning', text: t('reminders.remove') });
      rm.addEventListener('click', () => { this.close(); this.onDone(null); });
    }
    const cancel = foot.createEl('button', { text: t('common.cancel') });
    cancel.addEventListener('click', () => this.close());
    const ok = foot.createEl('button', { cls: 'mod-cta', text: t('reminders.save') });
    ok.addEventListener('click', () => {
      const v = new Date(input.value).getTime();
      if (!Number.isFinite(v)) { input.focus(); return; }
      this.close();
      this.onDone(v);
    });
  }
}

/** Add, change or remove the reminder of the line the caret is on. */
export function editLineReminder(app, editor) {
  const ln = editor.getCursor().line;
  const line = editor.getLine(ln);
  const cur = parseReminder(line);
  new ReminderModal(app, cur ? cur.at : null, (at) => {
    const now = editor.getLine(ln) === line ? line : editor.getLine(ln);
    const out = setLineReminder(now, at);
    editor.replaceRange(out, { line: ln, ch: 0 }, { line: ln, ch: now.length });
    editor.setCursor({ line: ln, ch: out.length });
    if (at && at > Date.now()) app.notice(t('reminders.set-done', { when: whenText(at) }));
    app.reminderHost?.askPermission?.();
  }).open();
}

// ---------------------------------------------------------------- the list of things to do
export class RemindersModal extends Modal {
  constructor(app) {
    super(app);
    this.modalEl.addClass('mod-reminders');
  }

  onOpen() {
    this.titleEl.setText(t('reminders.title'));
    this.listEl = this.contentEl.createDiv('reminders-list');
    this.render();
    this._ref = this.app.workspace.on('reminders-change', () => this.render());
  }

  onClose() { if (this._ref) this.app.workspace.offref(this._ref); }

  render() {
    const el = this.listEl;
    el.empty();
    const rem = this.app.reminders;
    const all = rem ? rem.list() : [];
    if (!all.length) {
      const empty = el.createDiv('reminders-empty');
      empty.createDiv({ cls: 'reminders-empty-title', text: t('reminders.none') });
      empty.createDiv({ cls: 'reminders-empty-text', text: t('reminders.none-explain') });
      return;
    }
    const now = Date.now();
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
    const groups = [
      ['late', t('reminders.group-late'), all.filter((r) => r.at < now)],
      ['today', t('reminders.group-today'), all.filter((r) => r.at >= now && r.at <= endOfDay.getTime())],
      ['later', t('reminders.group-later'), all.filter((r) => r.at > endOfDay.getTime())],
    ];
    for (const [cls, title, items] of groups) {
      if (!items.length) continue;
      el.createDiv({ cls: `reminders-group-title mod-${cls}`, text: title });
      for (const r of items) {
        const row = el.createDiv({ cls: `reminders-item mod-${cls}` });
        const check = row.createDiv({ cls: 'reminders-check', attr: { role: 'checkbox', 'aria-checked': 'false', 'aria-label': t('reminders.done') } });
        setIcon(check, 'check');
        check.addEventListener('click', async (e) => {
          e.stopPropagation();
          row.addClass('is-done');
          await rem.setDone(r, true);
        });
        const body = row.createDiv('reminders-body');
        body.createDiv({ cls: 'reminders-text', text: r.text || this.app.vault.getFileByPath(r.path)?.basename || r.path });
        const meta = body.createDiv('reminders-meta');
        meta.createSpan({ cls: 'reminders-when', text: whenText(r.at) });
        meta.createSpan({ cls: 'reminders-file', text: this.app.vault.getFileByPath(r.path)?.basename || r.path });
        row.addEventListener('click', () => { this.close(); rem.open(r); });
      }
    }
  }
}

export function registerReminders(app) {
  app.reminders = new Reminders(app);
  // the PC: a notification of the desktop while sk_notes is open (the Android app replaces the host)
  app.reminderHost ??= { notify: (r, name) => call('app.notify', { title: `⏰ ${r.text || name}`, body: `${name} · ${whenText(r.at)}` }).catch(() => {}) };
  app.commands.addCommand({ id: 'editor:add-reminder', name: t('cmd.add-reminder'), icon: 'alarm-clock', editorCallback: (editor) => editLineReminder(app, editor) });
  app.commands.addCommand({ id: 'reminders:open', name: t('cmd.reminders'), icon: 'alarm-clock', callback: () => new RemindersModal(app).open() });
  app.openReminders = () => new RemindersModal(app).open();
  app.workspace.onLayoutReady(() => { app.reminders.start().catch((e) => console.error('reminders', e)); });
}
