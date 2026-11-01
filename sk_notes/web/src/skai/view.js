// SKAI side panel: chat about the open note or the whole vault, summaries, tags,
// links, proofreading and rewriting – every change is shown as a diff first.

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { Component } from '../model/component.js';
import { postProcess, renderSections } from '../render/markdown.js';
import { MarkdownView } from '../views/markdown.js';
import { ItemView } from '../views/base.js';
import { ButtonComponent, Menu } from '../ui/kit.js';
import { confirmDiff, buildIndex } from './skai.js';

export class SkaiView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'sparkles';
    this.navButtonsEl.hide();
    this.mode = 'note';
    this.history = [];
    this.current = null;
    this.contentEl.addClass('skai-view');
    this.addAction('trash', t('skai.clear'), () => this.clear());
    this._build();
  }

  getViewType() { return 'skai'; }
  getDisplayText() { return 'SKAI'; }
  getIcon() { return 'sparkles'; }

  get client() { return this.app.skai; }

  _build() {
    const c = this.contentEl;
    const modes = c.createDiv('skai-modes');
    const mk = (id, label) => {
      const b = modes.createDiv({ cls: 'skai-mode', text: label });
      b.addEventListener('click', () => { this.mode = id; modes.findAll('.skai-mode').forEach((x) => x.toggleClass('is-active', x === b)); this._placeholder(); });
      if (id === this.mode) b.addClass('is-active');
    };
    mk('note', t('skai.mode.note'));
    mk('vault', t('skai.mode.vault'));
    const actions = c.createDiv('skai-actions');
    const act = (icon, label, action) => {
      const b = actions.createDiv({ cls: 'skai-action clickable-icon', attr: { 'aria-label': label } });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: label });
      b.addEventListener('click', () => this.run(action));
    };
    act('clipboard', t('skai.act.summarize'), 'summarize');
    act('tags', t('skai.act.tags'), 'tags');
    act('link', t('skai.act.links'), 'links');
    act('check-check', t('skai.act.proofread'), 'proofread');
    this.offlineEl = c.createDiv('skai-offline');
    this.messagesEl = c.createDiv('skai-messages');
    const input = c.createDiv('skai-input');
    this.textarea = input.createEl('textarea', { attr: { rows: 3 } });
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
      e.stopPropagation();
    });
    this.sendBtn = input.createEl('button', { cls: 'mod-cta skai-send' });
    setIcon(this.sendBtn, 'send');
    this.sendBtn.addEventListener('click', () => (this.current ? this.cancel() : this.send()));
    this._placeholder();
  }

  async onOpen() {
    this.registerEvent(this.app.workspace.on('skai-status', (st) => this._offline(st)));
    this._offline(this.client?.status || {});
    this.client?.refreshStatus();
  }

  _offline(st) {
    this.offlineEl.empty();
    if (!this.client?.enabled) {
      this.offlineEl.setText(t('skai.disabled-notice'));
      this.offlineEl.show();
      return;
    }
    if (st && st.online === false) {
      this.offlineEl.setText(t('skai.offline-panel'));
      this.offlineEl.show();
    } else this.offlineEl.hide();
  }

  _placeholder() {
    this.textarea.placeholder = this.mode === 'vault' ? t('skai.ask-vault') : t('skai.ask-note');
  }

  clear() {
    this.history = [];
    this.messagesEl.empty();
  }

  _activeNote() {
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) this.app.workspace.iterateRootLeaves((l) => { if (!view && l.view instanceof MarkdownView && l.view.file) view = l.view; });
    return view && view.file ? view : null;
  }

  _bubble(role, text) {
    const el = this.messagesEl.createDiv(`skai-message is-${role}`);
    const body = el.createDiv('skai-message-body markdown-rendered');
    if (role === 'user') body.setText(text);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return { el, body };
  }

  async _render(body, md) {
    body.empty();
    const comp = new Component();
    comp.load();
    this.addChild(comp);
    const secs = renderSections(this.app, md, body, this._activeNote()?.file?.path || '', comp);
    await postProcess(this.app, secs, '', comp, undefined, md);
  }

  _stream(messages, { onDone, json = false, bubble } = {}) {
    const b = bubble || this._bubble('assistant', '');
    b.el.addClass('is-streaming');
    let last = 0;
    const job = this.client.chat(messages, {
      json,
      onChunk: (full) => {
        const now = performance.now();
        if (now - last > 120) { last = now; if (json) b.body.setText(full); else this._render(b.body, full); this.messagesEl.scrollTop = this.messagesEl.scrollHeight; }
      },
    });
    this.current = job;
    this._setBusy(true);
    return job.promise.then(async (text) => {
      b.el.removeClass('is-streaming');
      if (!json) await this._render(b.body, text);
      onDone?.(text, b);
      return text;
    }, (e) => {
      b.el.removeClass('is-streaming');
      b.el.addClass('is-error');
      b.body.setText(this.client.errorText(e));
      if (e.kind === 'unreachable') this.client.refreshStatus();
      return null;
    }).finally(() => { this.current = null; this._setBusy(false); });
  }

  _setBusy(b) {
    this.sendBtn.empty();
    setIcon(this.sendBtn, b ? 'stop' : 'send');
    this.sendBtn.setAttr('aria-label', b ? t('skai.stop') : t('skai.send'));
  }

  cancel() { this.current?.cancel(); }

  // ---------------------------------------------------------------- chat
  async send() {
    const q = this.textarea.value.trim();
    if (!q || this.current) return;
    this.textarea.value = '';
    this._bubble('user', q);
    const sys = [this.client.system()];
    let context = '';
    let sources = [];
    if (this.mode === 'note') {
      const v = this._activeNote();
      if (v) context = this.client.noteContext(v.file, v.getViewData());
    } else {
      const info = this._bubble('info', '');
      info.body.setText(t('skai.searching'));
      try {
        const r = await this.client.retrieve(q);
        sources = r.hits;
        info.body.setText(r.method === 'embeddings' ? t('skai.found-semantic', { n: r.hits.length }) : t('skai.found-keywords', { n: r.hits.length }));
        context = r.hits.map((h, i) => `[${i + 1}] Note "${h.path.replace(/\.md$/, '')}":\n${h.text}`).join('\n\n');
        if (r.memory?.length) context += '\n\nShared SKAI memory:\n' + r.memory.map((m) => m.text).join('\n');
      } catch (e) { info.body.setText(this.client.errorText(e)); }
    }
    const instr = this.mode === 'vault'
      ? 'Answer using only the numbered excerpts of the user\'s notes below. Cite the notes you use as [[Note name]] links. If the excerpts do not contain the answer, say that the notes do not mention it.'
      : 'The user is looking at the note below. Answer about it.';
    const messages = [...sys, ...this.history.slice(-6)];
    messages.push({ role: 'user', content: `${instr}\n\n${context || '(no note is open)'}\n\nQuestion: ${q}` });
    const answer = await this._stream(messages, { onDone: (text, b) => {
      if (sources.length) {
        const src = b.el.createDiv('skai-sources');
        src.createSpan({ text: t('skai.sources') });
        for (const h of sources) {
          const a = src.createEl('a', { cls: 'internal-link', text: h.path.replace(/\.md$/, '').split('/').pop(), attr: { 'data-href': h.path } });
          a.addEventListener('click', (e) => { e.preventDefault(); this.app.workspace.openLinkText(h.path, '', 'tab'); });
        }
      }
      this._insertButton(b, text);
    } });
    if (answer) this.history.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
  }

  _insertButton(b, text) {
    const bar = b.el.createDiv('skai-message-actions');
    new ButtonComponent(bar).setButtonText(t('common.copy')).onClick(() => navigator.clipboard.writeText(text));
    new ButtonComponent(bar).setButtonText(t('skai.insert')).onClick(() => this._insertIntoNote(text));
  }

  async _insertIntoNote(text) {
    const v = this._activeNote();
    if (!v) { this.app.notice(t('skai.no-note')); return; }
    const before = v.getViewData();
    const pos = v.editor.posToOffset(v.editor.getCursor());
    const after = before.slice(0, pos) + text + before.slice(pos);
    if (await confirmDiff(this.app, { title: t('skai.insert-title', { name: v.file.basename }), before, after })) {
      v.editor.replaceRange(text, v.editor.offsetToPos(pos));
    }
  }

  // ---------------------------------------------------------------- actions
  async run(action) {
    if (this.current) return;
    if (action === 'vault') { this.mode = 'vault'; this.contentEl.findAll('.skai-mode').forEach((x, i) => x.toggleClass('is-active', i === 1)); this._placeholder(); this.textarea.focus(); return; }
    const v = this._activeNote();
    if (!v) { this._bubble('info', '').body.setText(t('skai.no-note')); return; }
    const file = v.file;
    const text = v.getViewData();
    const sys = this.client.system();
    if (action === 'summarize') {
      this._bubble('user', t('skai.act.summarize') + ': ' + file.basename);
      await this._stream([sys, { role: 'user', content: `Summarize this note in a few bullet points (at most 8), keeping names, numbers and decisions.\n\n${this.client.noteContext(file, text)}` }],
        { onDone: (out, b) => this._insertButton(b, out) });
    } else if (action === 'tags') {
      this._bubble('user', t('skai.act.tags') + ': ' + file.basename);
      const existing = Object.keys(this.app.metadataCache.getTags()).slice(0, 150).join(' ');
      const b = this._bubble('assistant', '');
      const out = await this._stream([sys, { role: 'user', content: `Suggest 3 to 6 tags for this note. Prefer tags that already exist in the vault when they fit: ${existing || '(none yet)'}.\nReply only with JSON: {"tags": ["tag1", "tag2"]} (no # sign, lowercase, use - instead of spaces).\n\n${this.client.noteContext(file, text)}` }], { json: true, bubble: b });
      if (out) this._tagChoices(b, file, out);
    } else if (action === 'links') {
      this._bubble('user', t('skai.act.links') + ': ' + file.basename);
      const info = this._bubble('info', '');
      info.body.setText(t('skai.searching'));
      let hits = [];
      try { hits = (await this.client.retrieve(`${file.basename}\n${text.slice(0, 1500)}`)).hits.filter((h) => h.path !== file.path); } catch (e) { info.body.setText(this.client.errorText(e)); return; }
      const linked = new Set(Object.keys(this.app.metadataCache.resolvedLinks[file.path] || {}));
      hits = hits.filter((h) => !linked.has(h.path));
      if (!hits.length) { info.body.setText(t('skai.no-related')); return; }
      info.body.setText(t('skai.related-found', { n: hits.length }));
      const b = this._bubble('assistant', '');
      const out = await this._stream([sys, { role: 'user', content: `The note below may be related to these other notes. For each one that is really related, explain in one short sentence why. Reply only with JSON: {"links": [{"note": "exact note name", "why": "..."}]}.\n\nOther notes:\n${hits.map((h) => `- "${h.path.replace(/\.md$/, '')}": ${h.text.slice(0, 300).replace(/\n/g, ' ')}`).join('\n')}\n\n${this.client.noteContext(file, text)}` }], { json: true, bubble: b });
      if (out) this._linkChoices(b, v, hits, out);
    } else if (action === 'proofread' || action === 'proofread-selection' || action === 'rewrite') {
      const sel = v.editor.getSelection();
      const useSel = action !== 'proofread' && sel;
      const target = useSel ? sel : text;
      // take the range now: the answer comes minutes later, when the selection is gone
      const before = v.getViewData();
      const from = v.editor.posToOffset(v.editor.getCursor('from'));
      const to = v.editor.posToOffset(v.editor.getCursor('to'));
      let instruction = 'Correct spelling, grammar and punctuation. Keep the meaning, the language, the Markdown formatting, links ([[...]]), tags and the frontmatter exactly as they are.';
      if (action === 'rewrite') {
        const choice = await this._askStyle();
        if (!choice) return;
        instruction = `Rewrite the text: ${choice}. Keep the language, the Markdown, links ([[...]]) and tags.`;
      }
      this._bubble('user', `${action === 'rewrite' ? t('skai.act.rewrite') : t('skai.act.proofread')}: ${useSel ? t('skai.selection') : file.basename}`);
      const out = await this._stream([sys, { role: 'user', content: `${instruction}\nReply with the corrected text only, no comments.\n\n"""\n${target.slice(0, 16000)}\n"""` }], { temperature: 0.2 });
      if (out === null) return;
      const clean = out.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/m, '$1').replace(/^"""\n?|\n?"""$/g, '').trim();
      if (v.getViewData() !== before) { this.app.notice(t('skai.note-changed')); return; }
      let after;
      if (useSel) after = before.slice(0, from) + clean + before.slice(to);
      else after = clean + (text.endsWith('\n') && !clean.endsWith('\n') ? '\n' : '');
      if (after === before) { this._bubble('info', '').body.setText(t('skai.no-changes')); return; }
      const bar = this.messagesEl.lastChild.createDiv('skai-message-actions');
      new ButtonComponent(bar).setButtonText(t('skai.review-apply')).setCta().onClick(async () => {
        if (v.getViewData() !== before) { this.app.notice(t('skai.note-changed')); return; }
        if (await confirmDiff(this.app, { title: t('skai.apply-title', { name: file.basename }), before, after })) {
          await call('vault.write', { path: file.path, text: before, reason: 'skai' }).catch(() => {});
          v.setViewData(after, false);
          v.requestSave();
          this.app.notice(t('skai.applied'));
        }
      });
    }
  }

  _askStyle() {
    return new Promise((resolve) => {
      const m = new Menu();
      const styles = [['clearer', 'make it clearer and easier to read'], ['shorter', 'make it shorter, keep only the essential'], ['longer', 'expand it with more detail'],
        ['formal', 'use a more formal tone'], ['friendly', 'use a friendlier tone'], ['bullets', 'turn it into a bullet list']];
      let chosen = null;
      for (const [k, prompt] of styles) m.addItem((i) => i.setTitle(t(`skai.style.${k}`)).onClick(() => { chosen = prompt; }));
      m.onHide(() => setTimeout(() => resolve(chosen), 0));
      const r = this.contentEl.getBoundingClientRect();
      m.showAtPosition({ x: r.left + 20, y: r.top + 120 });
    });
  }

  _tagChoices(b, file, out) {
    let tags = [];
    try { tags = (JSON.parse(out).tags || []).map((x) => String(x).replace(/^#/, '').trim().replace(/\s+/g, '-')).filter(Boolean).slice(0, 10); } catch { b.body.setText(t('skai.error.invalid')); return; }
    b.body.empty();
    if (!tags.length) { b.body.setText(t('skai.no-tags')); return; }
    const box = b.body.createDiv('skai-chips');
    const chosen = new Set(tags);
    for (const tg of tags) {
      const chip = box.createDiv({ cls: 'skai-chip is-active', text: '#' + tg });
      chip.addEventListener('click', () => { if (chosen.has(tg)) chosen.delete(tg); else chosen.add(tg); chip.toggleClass('is-active', chosen.has(tg)); });
    }
    const bar = b.el.createDiv('skai-message-actions');
    new ButtonComponent(bar).setButtonText(t('skai.add-tags')).setCta().onClick(async () => {
      if (!chosen.size) return;
      const before = await this.app.vault.read(file);
      const { parseYaml, stringifyYaml, getFrontMatterInfo } = await import('../model/filemanager.js');
      const info = getFrontMatterInfo(before);
      let fm = {};
      try { fm = info.exists ? parseYaml(info.frontmatter) || {} : {}; } catch { this.app.notice(t('notice.yaml-invalid')); return; }
      const cur = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === 'string' ? fm.tags.split(/[,\s]+/).filter(Boolean) : [];
      fm.tags = [...new Set([...cur, ...chosen])];
      const after = `---\n${stringifyYaml(fm).trimEnd()}\n---\n${info.exists ? before.slice(info.contentStart) : before}`;
      if (await confirmDiff(this.app, { title: t('skai.add-tags'), before, after })) {
        await this.app.fileManager.processFrontMatter(file, (f) => { f.tags = fm.tags; });
        this.app.notice(t('skai.applied'));
      }
    });
  }

  _linkChoices(b, view, hits, out) {
    let links = [];
    try { links = JSON.parse(out).links || []; } catch { b.body.setText(t('skai.error.invalid')); return; }
    b.body.empty();
    const byName = new Map(hits.map((h) => [h.path.replace(/\.md$/, '').toLowerCase(), h]));
    const valid = links.map((l) => ({ ...l, hit: byName.get(String(l.note || '').toLowerCase()) || hits.find((h) => h.path.toLowerCase().includes(String(l.note || '').toLowerCase())) })).filter((l) => l.hit);
    if (!valid.length) { b.body.setText(t('skai.no-related')); return; }
    for (const l of valid) {
      const row = b.body.createDiv('skai-link-row');
      const f = this.app.vault.getFileByPath(l.hit.path);
      const a = row.createEl('a', { cls: 'internal-link', text: f ? f.basename : l.hit.path });
      a.addEventListener('click', (e) => { e.preventDefault(); this.app.workspace.openLinkText(l.hit.path, '', 'tab'); });
      row.createDiv({ cls: 'skai-link-why', text: String(l.why || '') });
      const add = row.createEl('button', { text: t('skai.insert-link') });
      add.addEventListener('click', async () => {
        if (!f) return;
        const link = this.app.fileManager.generateMarkdownLink(f, view.file.path);
        const before = view.getViewData();
        const pos = view.editor.posToOffset(view.editor.getCursor());
        const after = before.slice(0, pos) + link + before.slice(pos);
        if (await confirmDiff(this.app, { title: t('skai.insert-link'), before, after })) view.editor.replaceRange(link, view.editor.offsetToPos(pos));
      });
    }
  }

  onPaneMenu(menu) {
    menu.addItem((i) => i.setTitle(t('skai.cmd.index')).setIcon('database').onClick(() => buildIndex(this.app)));
  }
}
