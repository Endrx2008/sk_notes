// SKAI in SKAI_ Memory (PC): asked in plain words, she reads the memory and changes it herself.
//
// The model answers with JSON: {"reply": "...", "actions": [{type: write|append|delete, path, text}]}.
// The page checks the actions (invalid ones go back to the model once, with the exact rules),
// shows each change before it is made – the difference for a write or an addition, a yes/no
// question for a deletion – and only then sends it to the backend, which writes through the
// memory helper as SKAI herself (no sudo password: the user confirmed here). At the end it says
// plainly what was done and what was not.

import { call } from '../core/api.js';
import { errorText, t } from '../core/i18n.js';
import { ButtonComponent, confirmDialog } from '../ui/kit.js';
import { confirmDiff } from './skai.js';

const TYPES = ['write', 'append', 'delete'];
const MAX_LIST = 400;

const RULES = `You are working on SKAI_ Memory, the shared Markdown memory of SKAI and of the apps that make her up.
Notes are Markdown files; a note links another with [[path without .md]] (for example [[plugins/sk_mail]]).
SKAI.md is the hub; plugins/<app>.md and plugins/<app>/... belong to each app.
When the user asks to add, change, link or remove something in the memory, you do it with actions; to answer a question, use no actions.
Reply ONLY with JSON: {"reply": "a short answer for the user", "actions": [ ... ]}
Actions:
- {"type": "write", "path": "folder/note.md", "text": "the WHOLE new content of the note"} (creates the note if it does not exist)
- {"type": "append", "path": "folder/note.md", "text": "text added at the end of the note"}
- {"type": "delete", "path": "folder/note.md"}
To link two notes, add the [[link]] to one of them with append or write. Keep the existing content of a note when you write it, unless the user asked to remove it.
Never invent facts: use only what the user said and what the notes contain. The user sees every change before it is made.`;

function parse(text) {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let obj;
  try { obj = JSON.parse(clean); } catch { return null; }
  if (Array.isArray(obj)) obj = { actions: obj };
  if (obj && !obj.actions && obj.type) obj = { actions: [obj] }; // a bare action is accepted too
  if (!obj || typeof obj !== 'object') return null;
  return { reply: typeof obj.reply === 'string' ? obj.reply : '', actions: Array.isArray(obj.actions) ? obj.actions : [] };
}

function problems(app, actions) {
  const out = [];
  actions.forEach((a, i) => {
    const path = typeof a?.path === 'string' ? a.path.trim().replace(/^\/+/, '') : '';
    if (!TYPES.includes(a?.type)) out.push(`action ${i + 1}: "type" must be one of ${TYPES.join(', ')}`);
    else if (!/\.md$/i.test(path) || path.split('/').some((p) => !p || p === '..' || p.startsWith('.'))) out.push(`action ${i + 1}: "path" must be a note path ending in .md, without "..", hidden names or a leading slash`);
    else if (a.type !== 'write' && !app.vault.getFileByPath(path)) out.push(`action ${i + 1}: the note "${path}" does not exist (existing notes are listed in the system message)`);
    else if (a.type !== 'delete' && typeof a.text !== 'string') out.push(`action ${i + 1}: "text" is required for ${a.type}`);
    else a.path = path;
  });
  return out;
}

/** One turn of the chat in SKAI_ Memory. */
export async function memoryTurn(view, q) {
  const app = view.app;
  const files = app.vault.getMarkdownFiles().map((f) => f.path).sort();
  let hits = [];
  try { hits = (await view.client.retrieve(q)).hits || []; } catch { hits = []; }
  for (const h of hits) view._pet('read', h.path);
  const active = view._activeNote();
  let state = `Notes of the memory (${files.length}):\n${files.slice(0, MAX_LIST).join('\n')}${files.length > MAX_LIST ? '\n…' : ''}`;
  if (active) state += `\n\nThe note on screen:\n${view.client.noteContext(active.file, active.getViewData())}`;
  if (hits.length) state += `\n\nNotes that match the request:\n${hits.map((h) => `"${h.path}":\n${h.text}`).join('\n\n')}`;
  const sys = view.client.system(`${RULES}\n\n${state}`);
  const messages = [sys, ...view.history.slice(-6), { role: 'user', content: q }];

  const b = view._bubble('assistant', '');
  const ask = (msgs) => view._stream(msgs, { json: true, bubble: b });
  let raw = await ask(messages);
  if (raw === null) return; // the error is in the bubble
  let res = parse(raw);
  let bad = res ? problems(app, res.actions) : ['the answer is not valid JSON'];
  if (bad.length) { // once more, with the exact rules
    raw = await ask([...messages, { role: 'assistant', content: raw }, { role: 'user', content: `Your answer cannot be used: ${bad.join('; ')}. Allowed "type" values: ${TYPES.join(', ')}. Reply again with JSON only.` }]);
    if (raw === null) return;
    res = parse(raw);
    bad = res ? problems(app, res.actions) : ['the answer is not valid JSON'];
  }
  if (!res) { b.body.setText(t('skai.memory.invalid')); return; }
  const actions = res.actions.filter((a) => !problems(app, [a]).length);
  await view._render(b.body, res.reply || (actions.length ? t('skai.memory.proposed', { n: actions.length }) : t('skai.memory.invalid')));
  view.history.push({ role: 'user', content: q }, { role: 'assistant', content: res.reply || '' });
  if (bad.length && actions.length < res.actions.length) b.el.createDiv({ cls: 'skai-memory-note', text: t('skai.memory.skipped', { n: res.actions.length - actions.length }) });
  if (!actions.length) return;

  const list = b.el.createEl('ul', { cls: 'skai-memory-actions' });
  for (const a of actions) list.createEl('li', { text: t(`skai.memory.op-${a.type}`, { name: a.path }) });
  const bar = b.el.createDiv('skai-message-actions');
  const go = new ButtonComponent(bar).setButtonText(t('skai.memory.review')).setCta();
  go.onClick(async () => {
    go.setDisabled(true);
    const done = [];
    const notDone = [];
    for (const a of actions) {
      const name = a.path;
      try {
        const file = app.vault.getFileByPath(a.path);
        const before = file ? await app.vault.read(file) : '';
        if (a.type === 'delete') {
          const ok = await confirmDialog(app, { title: t('skai.memory.delete-title', { name }), message: t('skai.memory.delete-message'), confirm: t('common.delete'), warning: true });
          if (!ok) { notDone.push(t('skai.memory.declined', { name })); continue; }
          await call('memory.skai', { op: 'delete', path: a.path });
        } else {
          const add = a.type === 'append' ? (before && !before.endsWith('\n') ? '\n' : '') + a.text + (a.text.endsWith('\n') ? '' : '\n') : '';
          const after = a.type === 'append' ? before + add : a.text;
          if (after === before) { notDone.push(t('skai.memory.same', { name })); continue; }
          const ok = await confirmDiff(app, { title: t(a.type === 'append' ? 'skai.memory.append-title' : 'skai.memory.write-title', { name }), before, after });
          if (!ok) { notDone.push(t('skai.memory.declined', { name })); continue; }
          await call('memory.skai', a.type === 'append' ? { op: 'append', path: a.path, text: add } : { op: 'write', path: a.path, text: after });
        }
        done.push(t(`skai.memory.op-${a.type}`, { name }));
      } catch (e) {
        notDone.push(`${name}: ${errorText(e)}`);
      }
    }
    const out = view._bubble('info', '');
    let md = '';
    if (done.length) md += `**${t('skai.memory.done')}**\n${done.map((x) => `- ${x}`).join('\n')}\n\n`;
    if (notDone.length) md += `**${t('skai.memory.not-done')}**\n${notDone.map((x) => `- ${x}`).join('\n')}`;
    await view._render(out.body, md.trim());
  });
}
