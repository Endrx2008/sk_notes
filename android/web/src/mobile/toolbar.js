// sk_notes for Android – the editing toolbar above the keyboard.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shown while a note is being edited with the on-screen keyboard open. Its buttons never
// take the focus from the editor, so the keyboard stays open and the selection is kept.

import { setIcon } from '@desktop/core/icons.js';
import { t } from '@desktop/core/i18n.js';

const HEADING_RE = /^(#{1,6})\s+/;

export function installToolbar(app) {
  const bar = app.containerEl.createDiv('mobile-toolbar');
  const strip = bar.createDiv('mobile-toolbar-options');
  const editor = () => app.workspace.activeEditor?.editor || null;
  const view = () => app.workspace.activeEditor || null;
  const run = (id) => () => app.commands.executeCommandById(id);

  const cycleHeading = () => {
    const ed = editor();
    if (!ed) return;
    const pos = ed.getCursor();
    const line = ed.getLine(pos.line);
    const m = HEADING_RE.exec(line);
    const level = m ? m[1].length : 0;
    const body = m ? line.slice(m[0].length) : line;
    const next = level >= 4 ? 0 : level + 1;
    const out = (next ? '#'.repeat(next) + ' ' : '') + body;
    ed.setLine(pos.line, out);
    ed.setCursor({ line: pos.line, ch: Math.max(0, pos.ch + (out.length - line.length)) });
  };

  const insert = (text) => () => editor()?.replaceSelection(text);

  const attach = () => {
    const v = view();
    const ed = editor();
    if (!v?.file || !ed) return;
    const input = createEl('input', { attr: { type: 'file', multiple: '' } });
    input.addEventListener('change', async () => {
      const links = [];
      try {
        for (const f of Array.from(input.files || [])) {
          const file = await app.saveAttachment(f.name || 'file', await f.arrayBuffer(), v.file.path);
          links.push(app.fileManager.generateMarkdownLink(file, v.file.path));
        }
      } catch (e) { app.notice(String(e.message || e)); }
      if (links.length) { ed.focus(); ed.replaceSelection(links.join('\n')); }
    });
    input.click();
  };

  const hide = () => { document.activeElement?.blur?.(); };

  const buttons = [
    ['undo', 'mobile.tb.undo', () => editor()?.undo()],
    ['redo', 'mobile.tb.redo', () => editor()?.redo()],
    ['brackets', 'mobile.tb.wikilink', run('editor:insert-wikilink')],
    ['hash', 'mobile.tb.tag', insert('#')],
    ['heading', 'mobile.tb.heading', cycleHeading],
    ['bold', 'mobile.tb.bold', run('editor:toggle-bold')],
    ['italic', 'mobile.tb.italic', run('editor:toggle-italics')],
    ['check-square', 'mobile.tb.task', run('editor:toggle-checklist-status')],
    ['list', 'mobile.tb.bullets', run('editor:toggle-bullet-list')],
    ['list-ordered', 'mobile.tb.numbers', run('editor:toggle-numbered-list')],
    ['arrow-right', 'mobile.tb.indent', run('editor:indent-list')],
    ['arrow-left', 'mobile.tb.unindent', run('editor:unindent-list')],
    ['strikethrough', 'mobile.tb.strike', run('editor:toggle-strikethrough')],
    ['highlighter', 'mobile.tb.highlight', run('editor:toggle-highlight')],
    ['code', 'mobile.tb.code', run('editor:toggle-code')],
    ['quote', 'mobile.tb.quote', run('editor:toggle-blockquote')],
    ['link', 'mobile.tb.link', run('editor:insert-link')],
    ['paperclip', 'mobile.tb.attach', attach],
    ['table', 'mobile.tb.table', run('editor:insert-table')],
    ['template', 'mobile.tb.template', run('insert-template')],
    ['calendar-day', 'mobile.tb.date', run('insert-current-date')],
  ];
  const make = (parent, icon, key, fn, cls = '') => {
    const b = parent.createDiv({ cls: 'mobile-toolbar-option clickable-icon ' + cls, attr: { 'aria-label': t(key), 'data-no-tooltip': '' } });
    setIcon(b, icon);
    // the editor keeps the focus (and the keyboard stays open)
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      try { fn(); } catch (err) { console.error('toolbar action failed', err); }
    });
    return b;
  };
  for (const [icon, key, fn] of buttons) make(strip, icon, key, fn);
  // commands exist on a phone only for what community plugins add: no plugin command, no button
  const commands = make(strip, 'command', 'mobile.palette', run('command-palette:open'));
  make(bar, 'keyboard', 'mobile.tb.hide', hide, 'mod-hide');

  // shown only while the caret is in a note
  const sync = () => {
    const el = document.activeElement;
    const editing = !!el?.closest?.('.cm-editor') && !!el.closest('.workspace-split.mod-root') && !el.closest('.cm-panels');
    document.body.classList.toggle('is-editing-note', editing);
    commands.toggle(!!app.pluginCommands?.().length);
  };
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', () => setTimeout(sync, 0));
  window.addEventListener('skn-keyboard', () => {
    sync();
    // keep the caret above the toolbar when the keyboard opens
    setTimeout(() => { const ed = editor(); if (ed?.hasFocus()) ed.scrollIntoView({ from: ed.getCursor(), to: ed.getCursor() }, false); }, 120);
  });
  sync();
}
