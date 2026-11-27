// Colour of the text in a note, kept as plain Markdown.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The chosen words are written as <span style="color:#rrggbb">words</span>: inline HTML is part
// of Markdown, so Obsidian, Foam, GitHub and every other reader shows the colour, and an app
// that does not shows the words. Nothing else of the file changes. The colours are fixed values
// (a theme never changes a colour the user picked).

import { t } from '../core/i18n.js';
import { Menu } from '../ui/kit.js';

export const TEXT_COLORS = [['red', '#e5484d'], ['orange', '#f08c2e'], ['yellow', '#e3b341'], ['green', '#39d353'], ['cyan', '#3fc1c9'], ['blue', '#3b82f6'], ['purple', '#b98bf0']];
const OPEN_END = /<span style="color:[^"<>]*">$/;
const ANY_SPAN = /<span style="color:[^"<>]*">([^<]*)<\/span>/g;

/** Give the selected text (or the word at the caret) a colour; '' takes the colour away. */
export function colorSelection(cm, color) {
  const { state } = cm;
  let { from, to } = state.selection.main;
  if (from === to) {
    const w = state.wordAt(from);
    if (!w) return false;
    ({ from, to } = w);
  }
  // already coloured: the old tags around the selection go, the new colour takes their place
  const line = state.doc.lineAt(from);
  const before = state.doc.sliceString(line.from, from);
  const after = state.doc.sliceString(to, state.doc.lineAt(to).to);
  const open = OPEN_END.exec(before);
  if (open && after.startsWith('</span>')) { from -= open[0].length; to += '</span>'.length; }
  const text = state.doc.sliceString(from, to).replace(ANY_SPAN, '$1');
  const wrap = (s) => (!color || !s.trim() ? s : `<span style="color:${color}">${s}</span>`);
  // a span never crosses a line: each line of the selection is wrapped on its own
  const out = text.split('\n').map((ln) => {
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?|\s*#{1,6}\s+|\s*>\s*)?(.*)$/.exec(ln);
    return (m[1] || '') + wrap(m[2]);
  }).join('\n');
  const inner = out.indexOf('">') >= 0 && color ? out.indexOf('">') + 2 : 0;
  cm.dispatch({
    changes: { from, to, insert: out },
    selection: color && !out.includes('\n') ? { anchor: from + inner, head: from + out.length - (color ? '</span>'.length : 0) } : { anchor: from + out.length },
    userEvent: 'input.format',
  });
  cm.focus();
  return true;
}

/** The colour menu: a few colours, one of the user's own, or none. */
export function textColorMenu(app, cm, at) {
  const m = new Menu();
  m.addItem((it) => it.setTitle(t('editor.text-color')).setIsLabel(true).setDisabled(true));
  for (const [name, hex] of TEXT_COLORS) {
    m.addItem((it) => {
      it.setTitle(t(`text-color.${name}`)).setSection('color').onClick(() => colorSelection(cm, hex));
      it.dom.style.setProperty('--node-color', hex);
      it.dom.addClass('graph-color-item');
    });
  }
  m.addItem((it) => it.setTitle(t('graph.color-custom')).setIcon('palette').setSection('custom').onClick(() => {
    const input = createEl('input', { attr: { type: 'color', value: '#e05c00' } });
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.addEventListener('change', () => { colorSelection(cm, input.value); input.remove(); });
    input.addEventListener('blur', () => setTimeout(() => input.remove(), 500));
    input.click();
  }));
  m.addItem((it) => it.setTitle(t('canvas.color-none')).setIcon('x').setSection('custom').onClick(() => colorSelection(cm, '')));
  if (at) { m.showAtPosition(at); return; }
  const head = cm.coordsAtPos(cm.state.selection.main.head);
  m.showAtPosition(head ? { x: head.left, y: head.bottom + 4 } : { x: window.innerWidth / 2, y: window.innerHeight / 3 });
}
