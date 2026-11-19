// SKAI integration: client (streaming, cancel), commands, settings, diff confirmation.

import { call, onBackend } from '../core/api.js';
import { diffLines, diffStats, renderDiff } from '../core/diff.js';
import { getLanguage, t } from '../core/i18n.js';
import { uid } from '../core/util.js';
import { ButtonComponent, Modal, Setting } from '../ui/kit.js';

const LANG_NAMES = { en: 'English', it: 'Italian', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian', 'zh-CN': 'Simplified Chinese', ja: 'Japanese' };
const NOTE_LIMIT = 12000;

export class SkaiClient {
  constructor(app) {
    this.app = app;
    this.jobs = new Map();
    this.status = { online: false };
    onBackend('ai-chunk', (d) => this.jobs.get(d.id)?.onChunk(d.text));
    onBackend('ai-done', (d) => { const j = this.jobs.get(d.id); this.jobs.delete(d.id); j?.resolve(j.text); this._busy(); });
    onBackend('ai-error', (d) => { const j = this.jobs.get(d.id); this.jobs.delete(d.id); j?.reject(Object.assign(new Error(d.kind), { kind: d.kind, detail: d.detail })); this._busy(); });
  }

  get enabled() { return this.app.settings.get('skaiEnabled') !== false; }

  async refreshStatus() {
    if (!this.enabled) { this.app.statusBar?.setSkai('disabled'); return this.status; }
    try { this.status = await call('ai.status'); } catch { this.status = { online: false }; }
    // Ollama answering without a chat model is "AI unavailable" too, like in every SKAI tool.
    this.status.available = Boolean(this.status.online && this.status.chatModel);
    const detail = this.status.available ? `${this.status.chatModel} · ${this.status.host}` : t('skai.offline-panel');
    this.app.statusBar?.setSkai(this.status.available ? 'online' : 'offline', detail);
    this.app.workspace.trigger('skai-status', this.status);
    return this.status;
  }

  _busy() { this.app.statusBar?.setSkai(this.jobs.size ? 'thinking' : this.status.available ? 'online' : 'offline'); }

  /** Stream a chat. Returns {promise, cancel}. onChunk(fullTextSoFar, piece). */
  chat(messages, { onChunk, json = false, temperature } = {}) {
    if (!this.enabled) return { promise: Promise.reject(Object.assign(new Error('disabled'), { kind: 'disabled' })), cancel() {} };
    const id = uid(12);
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const job = { text: '', resolve, reject, onChunk: (piece) => { job.text += piece; onChunk?.(job.text, piece); } };
    this.jobs.set(id, job);
    this._busy();
    call('ai.chat', { id, messages, json, temperature }).catch((e) => { this.jobs.delete(id); reject(Object.assign(e, { kind: e.code })); this._busy(); });
    return { promise, cancel: () => call('ai.cancel', { id }).catch(() => {}) };
  }

  system(extra = '') {
    const lang = LANG_NAMES[getLanguage()] || 'English';
    return { role: 'system', content: `You are SKAI, the local assistant of Skorpion OS, inside the note app sk_notes. You help the user with their own notes; you never claim to have changed a note yourself – the user applies changes. Be concise and accurate; if the notes do not contain the answer, say so. Answer in the language of the user's message (default: ${lang}). Use Markdown. ${extra}`.trim() };
  }

  errorText(e) {
    const kind = e?.kind || e?.code || 'bug';
    return t(`skai.error.${['unreachable', 'no_model', 'model_missing', 'timeout', 'interrupted', 'server', 'empty', 'invalid', 'cancelled', 'disabled'].includes(kind) ? kind : 'bug'}`, { detail: e?.detail || '' });
  }

  noteContext(file, text) {
    const body = text.length > NOTE_LIMIT ? text.slice(0, NOTE_LIMIT) + '\n[…]' : text;
    return `Note "${file.basename}" (${file.path}):\n"""\n${body}\n"""`;
  }

  async retrieve(query) {
    return call('ai.retrieve', { query, k: 6 });
  }
}

/** Show a diff and resolve true when the user applies it. */
export function confirmDiff(app, { title, before, after, apply = t('skai.apply') }) {
  return new Promise((resolve) => {
    const m = new Modal(app);
    m.modalEl.addClass('mod-skai-diff');
    m.setTitle(title);
    const ops = diffLines(before, after);
    const st = diffStats(ops);
    m.contentEl.createDiv({ cls: 'setting-item-description', text: t('skai.diff-summary', { added: st.added, removed: st.removed }) });
    renderDiff(m.contentEl.createDiv('skai-diff'), ops);
    let ok = false;
    const row = m.contentEl.createDiv('modal-button-container');
    new ButtonComponent(row).setButtonText(apply).setCta().onClick(() => { ok = true; m.close(); });
    new ButtonComponent(row).setButtonText(t('common.cancel')).onClick(() => m.close());
    m.onClose = () => resolve(ok);
    m.open();
  });
}

export function installSkai(app) {
  const client = new SkaiClient(app);
  app.skai = client;
  const openPanel = async (action) => {
    if (!client.enabled) { app.notice(t('skai.disabled-notice')); return null; }
    const leaf = await app.workspace.ensureSideLeaf('skai', 'right', { reveal: true });
    app.workspace.revealLeaf(leaf);
    if (action) leaf.view?.run?.(action);
    return leaf;
  };
  const cmd = (id, key, opts) => app.commands.addCommand({ id: `skai:${id}`, name: t(key), ...opts });
  cmd('open', 'skai.cmd.open', { callback: () => openPanel() });
  const noteCmd = (id, key, action) => cmd(id, key, { checkCallback: (check) => {
    const f = app.workspace.getActiveFile();
    if (!client.enabled || !f || f.extension !== 'md') return false;
    if (!check) openPanel(action);
    return true;
  } });
  noteCmd('summarize', 'skai.cmd.summarize', 'summarize');
  noteCmd('suggest-tags', 'skai.cmd.tags', 'tags');
  noteCmd('suggest-links', 'skai.cmd.links', 'links');
  noteCmd('proofread', 'skai.cmd.proofread', 'proofread');
  cmd('rewrite-selection', 'skai.cmd.rewrite', { editorCheckCallback: (check, editor) => {
    if (!client.enabled || !editor.somethingSelected()) return false;
    if (!check) openPanel('rewrite');
    return true;
  } });
  cmd('ask-vault', 'skai.cmd.ask-vault', { callback: () => openPanel('vault') });
  cmd('build-index', 'skai.cmd.index', { callback: () => buildIndex(app) });
  client.editorMenu = (menu, editor) => {
    if (!client.enabled) return;
    const sel = editor.somethingSelected();
    menu.addItem((i) => i.setTitle(t(sel ? 'skai.menu.rewrite' : 'skai.menu.summarize')).setIcon('sparkles').setSection('skai')
      .onClick(() => openPanel(sel ? 'rewrite' : 'summarize')));
    if (sel) menu.addItem((i) => i.setTitle(t('skai.menu.proofread')).setIcon('check-check').setSection('skai').onClick(() => openPanel('proofread-selection')));
  };
  client.renderSettings = (el) => renderSkaiSettings(app, el);
  app.on('ready', () => {
    client.refreshStatus();
    setInterval(() => client.refreshStatus(), 60_000);
  });
  app.settings.on('change', (k) => { if (k === 'skaiEnabled') client.refreshStatus(); });
}

export async function buildIndex(app) {
  const r = await call('ai.index.build').catch((e) => ({ error: e.code }));
  if (!r.model) { app.notice(t('skai.index-no-model')); return; }
  const n = app.notice(t('skai.index-started', { model: r.model }), 0);
  const off = onBackend('ai-index', (d) => {
    if (d.total) n.setMessage(t('skai.index-progress', { done: d.done, total: d.total }));
    if (d.finished || d.error) {
      n.setMessage(d.error ? t('skai.index-failed', { error: d.error }) : t('skai.index-done', { n: d.embedded ?? 0 }));
      setTimeout(() => n.hide(), 4000);
      off();
    }
  });
}

async function renderSkaiSettings(app, el) {
  const s = app.settings;
  el.createEl('p', { cls: 'setting-item-description', text: t('skai.settings-intro') });
  new Setting(el).setName(t('skai.enable')).setDesc(t('skai.enable-desc')).addToggle((tg) => tg.setValue(s.get('skaiEnabled') !== false).onChange((v) => s.set('skaiEnabled', v)));
  const st = await app.skai.refreshStatus();
  const info = new Setting(el).setName(t('skai.connection'));
  info.setDesc(st.online ? t('skai.connected', { host: st.host, model: st.chatModel || '—', embed: st.embedModel || t('skai.none') }) : t('skai.offline-detail', { host: st.host || 'localhost:11434' }));
  info.addButton((b) => b.setButtonText(t('skai.check')).onClick(() => { el.empty(); renderSkaiSettings(app, el); }));
  const idx = st.index;
  new Setting(el).setName(t('skai.index')).setDesc(idx ? t('skai.index-status', { notes: idx.notes, chunks: idx.chunks, model: idx.model || t('skai.none') }) : t('skai.index-desc'))
    .addButton((b) => b.setButtonText(t('skai.index-build')).onClick(() => buildIndex(app)))
    .addExtraButton((b) => b.setIcon('stop').setTooltip(t('skai.index-stop')).onClick(() => call('ai.index.stop')));
  new Setting(el).setName(t('skai.memory')).setDesc(st.memory ? t('skai.memory-on') : t('skai.memory-off'));
  el.createEl('p', { cls: 'setting-item-description', text: t('skai.model-note') });
}
