// Find (and replace) inside the open note: the panel at the top of the editor.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// CodeMirror's own panel has English labels only; this one is translated, shows how many
// matches there are, and has the flag "Whole word": "art" then finds "art" but not "party".

import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from '@codemirror/search';
import { setIcon } from '../core/icons.js';
import { t } from '../core/i18n.js';

const MAX_COUNT = 5000;

/** How many matches the query has, and which one the selection is on (1-based, 0 = none). */
function countMatches(state, query) {
  if (!query.valid || !query.search) return { total: 0, current: 0 };
  const cur = query.getCursor(state);
  const sel = state.selection.main;
  let total = 0;
  let current = 0;
  for (let r = cur.next(); !r.done; r = cur.next()) {
    total += 1;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    if (total >= MAX_COUNT) break;
  }
  return { total, current };
}

export function createFindPanel(view) {
  const dom = document.createElement('div');
  dom.className = 'cm-search sk-find';
  const q0 = getSearchQuery(view.state);
  const row = (cls) => { const r = document.createElement('div'); r.className = 'sk-find-row ' + cls; dom.appendChild(r); return r; };
  const input = (name, placeholder, value) => {
    const el = document.createElement('input');
    el.className = 'cm-textfield sk-find-input';
    el.name = name;
    el.placeholder = placeholder;
    el.value = value;
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('main-field', name === 'search' ? 'true' : 'false');
    return el;
  };
  const button = (parent, icon, label, fn, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sk-find-button clickable-icon ' + cls;
    b.setAttribute('aria-label', label);
    b.title = label;
    setIcon(b, icon);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // the field keeps the focus (and the phone keyboard)
    b.addEventListener('click', fn);
    parent.appendChild(b);
    return b;
  };
  const toggle = (parent, label, on, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sk-find-flag ' + cls;
    b.textContent = label;
    b.setAttribute('aria-pressed', String(!!on));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); commit(); });
    parent.appendChild(b);
    return b;
  };

  const top = row('mod-find');
  const search = input('search', t('find.placeholder'), q0.search);
  top.appendChild(search);
  const count = document.createElement('span');
  count.className = 'sk-find-count';
  top.appendChild(count);
  button(top, 'chevron-up', t('find.previous'), () => { findPrevious(view); update(); });
  button(top, 'chevron-down', t('find.next'), () => { findNext(view); update(); });
  button(top, 'x', t('common.close'), () => closeSearchPanel(view), 'mod-close');

  const flags = row('mod-flags');
  const word = toggle(flags, t('find.whole-word'), q0.wholeWord, 'mod-word');
  const cased = toggle(flags, t('find.match-case'), q0.caseSensitive, 'mod-case');
  const showReplace = toggle(flags, t('find.replace'), !!q0.replace, 'mod-show-replace');

  const rep = row('mod-replace');
  const replace = input('replace', t('find.replace-with'), q0.replace);
  rep.appendChild(replace);
  const repOne = document.createElement('button');
  repOne.type = 'button';
  repOne.className = 'sk-find-text-button';
  repOne.textContent = t('find.replace-one');
  repOne.addEventListener('click', () => { replaceNext(view); update(); });
  rep.appendChild(repOne);
  const repAll = document.createElement('button');
  repAll.type = 'button';
  repAll.className = 'sk-find-text-button';
  repAll.textContent = t('find.replace-all');
  repAll.addEventListener('click', () => { replaceAll(view); update(); });
  rep.appendChild(repAll);

  const query = () => new SearchQuery({
    search: search.value, replace: replace.value, literal: true,
    caseSensitive: cased.getAttribute('aria-pressed') === 'true', wholeWord: word.getAttribute('aria-pressed') === 'true',
  });
  let shown = null;
  function update() {
    const q = getSearchQuery(view.state);
    rep.style.display = showReplace.getAttribute('aria-pressed') === 'true' ? '' : 'none';
    if (!q.search) { count.textContent = ''; dom.classList.remove('is-empty'); return; }
    const { total, current } = countMatches(view.state, q);
    count.textContent = total ? (current ? `${current}/${total}` : String(total)) + (total >= MAX_COUNT ? '+' : '') : t('find.none');
    dom.classList.toggle('is-empty', !total);
  }
  function commit() {
    const q = query();
    if (!shown || !q.eq(shown)) {
      shown = q;
      view.dispatch({ effects: setSearchQuery.of(q) });
      // jump to the first match from where the caret is, as typing goes on
      if (q.search) findNext(view);
    }
    update();
  }
  search.addEventListener('input', commit);
  replace.addEventListener('input', commit);
  const keys = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.target === replace) replaceNext(view); else if (e.shiftKey) findPrevious(view); else findNext(view); update(); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); view.focus(); }
  };
  search.addEventListener('keydown', keys);
  replace.addEventListener('keydown', keys);
  update();
  return {
    dom,
    top: true,
    mount() { search.focus(); search.select(); },
    update(u) {
      for (const tr of u.transactions) {
        for (const e of tr.effects) {
          if (e.is(setSearchQuery) && !e.value.eq(query())) {
            search.value = e.value.search;
            replace.value = e.value.replace;
            word.setAttribute('aria-pressed', String(e.value.wholeWord));
            cased.setAttribute('aria-pressed', String(e.value.caseSensitive));
          }
        }
      }
      if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) update();
    },
  };
}

/** Open the panel with the replace row shown (or hidden). */
export function showReplaceRow(view, on) {
  const b = view.dom.querySelector('.sk-find .mod-show-replace');
  if (!b) return;
  b.setAttribute('aria-pressed', String(!!on));
  const row = view.dom.querySelector('.sk-find .mod-replace');
  if (row) row.style.display = on ? '' : 'none';
  if (on) setTimeout(() => view.dom.querySelector('.sk-find input[name=replace]')?.focus(), 0);
}
