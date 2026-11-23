// sk_notes for Android – the spell checker in the editor: wavy underline, suggestions on
// tap, autocorrect at the end of a word.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Only the visible part of a note is checked. Code, links' addresses, tags, math, comments
// and the frontmatter are never checked; the word being typed is checked once it ends.

import { syntaxTree } from '@codemirror/language';
import { StateEffect } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import { frontmatterRange } from '@desktop/editor/livepreview.js';
import { t } from '@desktop/core/i18n.js';
import { Menu } from '@desktop/ui/kit.js';
import { addWord, ignoreWord, isKnownWrong, onSpellChange, spell, suggestions, wrongWords } from './checker.js';

const SKIP = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'CodeInfo', 'URL', 'Autolink', 'HTMLTag', 'HTMLBlock',
  'Comment', 'CommentBlock', 'ProcessingInstruction', 'InlineMath', 'BlockMath', 'WikiLinkTarget', 'WikiLinkMark', 'Hashtag',
  'BlockId', 'LinkMark', 'LinkLabel', 'LinkTitle', 'Escape', 'Entity']);
const WORD_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const SEPARATOR_RE = /^[\s.,;:!?)\]}»"”]$/u;
const wrongMark = Decoration.mark({ class: 'sk-misspelled' });
const redraw = StateEffect.define();

const norm = (w) => w.replace(/’/g, "'");
const stripAccents = (w) => w.normalize('NFD').replace(/\p{M}/gu, '');

function skippable(word, before, after, cfg) {
  if (word.length < 2) return true;
  if (/[\p{N}_]/u.test(before + after)) return true; // part of a name like abc123 or snake_case
  if (after === '@' || before === '@' || before === '/' || after === '/') return true;
  if (cfg.ignoreCaps && word === word.toUpperCase()) return true;
  if (/\p{Ll}\p{Lu}/u.test(word)) return true; // camelCase
  return false;
}

/** Words to check in [from, to): [{from, to, word}], without the parts that are never checked. */
function wordsIn(state, from, to, cfg) {
  const skip = [];
  const fm = frontmatterRange(state.doc);
  if (fm) skip.push([fm.from, fm.to]);
  syntaxTree(state).iterate({ from, to, enter: (n) => { if (SKIP.has(n.name)) { skip.push([n.from, n.to]); return false; } return undefined; } });
  const text = state.doc.sliceString(from, to);
  const out = [];
  for (const m of text.matchAll(WORD_RE)) {
    const a = from + m.index;
    const b = a + m[0].length;
    if (skip.some(([x, y]) => a < y && b > x)) continue;
    const before = state.doc.sliceString(Math.max(0, a - 1), a);
    const after = state.doc.sliceString(b, Math.min(state.doc.length, b + 1));
    if (skippable(m[0], before, after, cfg)) continue;
    out.push({ from: a, to: b, word: norm(m[0]) });
  }
  return out;
}

function wordAt(state, pos, cfg) {
  const line = state.doc.lineAt(pos);
  return wordsIn(state, line.from, line.to, cfg).find((w) => w.from <= pos && pos <= w.to) || null;
}

/** Damerau–Levenshtein distance, stopped early above 2. */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** A correction safe enough to make without asking: accents, capitals, or one letter in a longer word. */
export function safeCorrection(word, list) {
  const lw = word.toLowerCase();
  for (const s of list.slice(0, 3)) {
    if (/[\s-]/.test(s)) continue;
    const ls = s.toLowerCase();
    if (ls === lw || stripAccents(ls) === stripAccents(lw) || (word.length >= 4 && distance(lw, ls) === 1)) {
      // keep the capital the user typed at the start
      return word[0] !== word[0].toLowerCase() && s[0] === s[0].toLowerCase() ? s[0].toUpperCase() + s.slice(1) : s;
    }
  }
  return null;
}

const live = new Set();

class SpellView {
  constructor(view) {
    this.view = view;
    this.decorations = Decoration.none;
    this.timer = 0;
    this.typing = -1; // end of the word being typed (not underlined until it ends)
    this.lastAuto = null;
    live.add(this);
    this.schedule(50);
  }

  update(u) {
    if (u.docChanged) {
      this.decorations = this.decorations.map(u.changes);
      this.typing = -1;
      for (const tr of u.transactions) {
        if (!tr.docChanged) continue;
        const ev = tr.isUserEvent('input.type') ? 'type' : tr.isUserEvent('delete.backward') ? 'back' : tr.isUserEvent('input.autocorrect') ? 'auto' : 'other';
        if (ev === 'auto') continue;
        if (ev === 'back' && this.lastAuto && this.undoAuto(tr)) continue;
        this.lastAuto = null;
        if (ev !== 'type') continue;
        tr.changes.iterChanges((fa, ta, fb, tb, ins) => {
          const s = ins.toString();
          if (s.length === 1 && SEPARATOR_RE.test(s)) this.autocorrect(fb);
          else this.typing = tb;
        });
      }
    }
    if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(redraw) && e.value === 'all'))) this.schedule(u.docChanged ? 400 : 120);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), ms);
  }

  async check() {
    const view = this.view;
    const cfg = spell.config;
    if (!spell.active || !cfg || !cfg.underline) {
      if (this.decorations.size) { this.decorations = Decoration.none; view.dispatch({ effects: redraw.of('marks') }); }
      return;
    }
    const found = [];
    for (const { from, to } of view.visibleRanges) found.push(...wordsIn(view.state, from, to, cfg));
    const bad = await wrongWords(found.map((w) => w.word));
    if (!live.has(this) || view.state.doc.length < (found.at(-1)?.to || 0)) return;
    const head = view.state.selection.main.head;
    const marks = [];
    for (const w of found) {
      if (!bad.has(w.word)) continue;
      if (view.state.doc.sliceString(w.from, w.to) !== w.word && norm(view.state.doc.sliceString(w.from, w.to)) !== w.word) continue; // changed meanwhile
      if (this.typing >= 0 && w.to === this.typing && head === w.to) continue; // still being typed
      marks.push(wrongMark.range(w.from, w.to));
    }
    this.decorations = Decoration.set(marks, true);
    view.dispatch({ effects: redraw.of('marks') });
  }

  /** The word that ends before `sepPos` (where a space or a stop was typed): replaced when the
   * correction is nearly certain. */
  async autocorrect(sepPos) {
    const cfg = spell.config;
    if (!spell.active || !cfg?.autocorrect) return;
    const view = this.view;
    const w = wordAt(view.state, sepPos, cfg);
    if (!w || w.to !== sepPos) return;
    const bad = await wrongWords([w.word]);
    if (!bad.has(w.word)) return;
    const fix = safeCorrection(w.word, await suggestions(w.word));
    if (!fix || !live.has(this)) return;
    const st = view.state;
    // the user went on typing in that word meanwhile: leave it
    if (norm(st.doc.sliceString(w.from, w.to)) !== w.word || !SEPARATOR_RE.test(st.doc.sliceString(w.to, w.to + 1))) return;
    view.dispatch({ changes: { from: w.from, to: w.to, insert: fix }, userEvent: 'input.autocorrect' });
    this.lastAuto = { from: w.from, to: w.from + fix.length, original: st.doc.sliceString(w.from, w.to) };
  }

  /** Backspace right after an autocorrection: the separator goes and the typed word comes back. */
  undoAuto(tr) {
    const a = this.lastAuto;
    this.lastAuto = null;
    let ok = false;
    tr.changes.iterChanges((fa, ta) => { if (fa === a.to && ta === a.to + 1) ok = true; });
    if (!ok) return false;
    const original = a.original;
    setTimeout(() => {
      if (!live.has(this)) return;
      this.view.dispatch({ changes: { from: a.from, to: a.to, insert: original }, selection: { anchor: a.from + original.length }, userEvent: 'input.autocorrect' });
      ignoreWord(norm(original));
    }, 0);
    return true;
  }

  wrongAt(pos) {
    let hit = null;
    this.decorations.between(pos, pos, (from, to) => { hit = { from, to }; return false; });
    return hit;
  }

  destroy() {
    clearTimeout(this.timer);
    live.delete(this);
  }
}

const spellPlugin = ViewPlugin.fromClass(SpellView, { decorations: (v) => v.decorations });

async function showSuggestions(view, range, evt) {
  const word = norm(view.state.doc.sliceString(range.from, range.to));
  if (!isKnownWrong(word)) return;
  const list = await suggestions(word);
  const m = new Menu();
  m.addItem((it) => it.setTitle(word).setIsLabel(true).setDisabled(true));
  const replace = (s) => {
    if (norm(view.state.doc.sliceString(range.from, range.to)) !== word) return;
    view.dispatch({ changes: { from: range.from, to: range.to, insert: s }, selection: { anchor: range.from + s.length }, userEvent: 'input.spellfix' });
    view.focus();
  };
  if (!list.length) m.addItem((it) => it.setTitle(t('mobile.spell.no-suggestions')).setDisabled(true));
  for (const s of list) m.addItem((it) => it.setTitle(s).setSection('fix').onClick(() => replace(s)));
  m.addItem((it) => it.setTitle(t('mobile.spell.add-word')).setIcon('plus').setSection('word').onClick(() => addWord(word)));
  m.addItem((it) => it.setTitle(t('mobile.spell.ignore')).setIcon('eye-off').setSection('word').onClick(() => ignoreWord(word)));
  m.showAtMouseEvent(evt);
}

const tapHandler = EditorView.domEventHandlers({
  click(evt, view) {
    if (!spell.active || !spell.config?.suggest || !spell.config?.underline) return false;
    const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
    if (pos === null) return false;
    const range = view.plugin(spellPlugin)?.wrongAt(pos);
    if (!range) return false;
    showSuggestions(view, range, evt);
    return false; // the cursor still goes where the finger was
  },
});

const theme = EditorView.baseTheme({
  '.sk-misspelled': { textDecoration: 'underline wavy var(--color-red, #e5484d)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
});

export const spellExtension = [spellPlugin, tapHandler, theme];

// a change of languages, words or options: every open editor checks again
onSpellChange(() => {
  for (const v of live) v.view.dispatch({ effects: redraw.of('all') });
});
