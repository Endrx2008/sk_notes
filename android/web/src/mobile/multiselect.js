// sk_notes for Android – choosing several files in the file list.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A long press on a file or folder of the list starts a choice: that row is marked. Without
// lifting the finger, sliding it up or down marks every row from the first to the one under
// the finger (the list scrolls near its edges). Later, a tap on other rows marks or unmarks
// them. A bar at the top of the screen, above the list even when the list is a drawer, says
// how many are chosen and what can be done: rename them (one dialog after the other, one per
// name), delete them (asked once, for all), or, with a single row chosen, open its own menu.
// The bar's "x", Android's back, or unmarking the last row ends the choice.

import { setIcon } from '@desktop/core/icons.js';
import { errorText, t } from '@desktop/core/i18n.js';
import { TFile, TFolder } from '@desktop/model/vault.js';
import { Menu, confirmDialog, promptDialog } from '@desktop/ui/kit.js';
import { FileExplorerView } from '@desktop/views/explorer.js';

const ROW = '.workspace-leaf-content[data-type="file-explorer"] .tree-item-self[data-path]';

export function installMultiSelect(app) {
  const chosen = new Set(); // paths, in the order they were chosen
  let bar = null;
  let countEl = null;
  let menuBtn = null;

  const files = () => [...chosen].map((p) => app.vault.getAbstractFileByPath(p)).filter(Boolean);
  const mark = () => {
    for (const el of document.querySelectorAll(ROW)) el.toggleClass('is-chosen', chosen.has(el.getAttribute('data-path')));
    document.body.classList.toggle('is-choosing-files', chosen.size > 0);
    if (!chosen.size) { bar?.remove(); bar = null; return; }
    if (!bar) build();
    countEl.setText(t('mobile.select.count', { n: chosen.size }));
    menuBtn.toggle(chosen.size === 1);
  };
  const stop = () => { chosen.clear(); mark(); };
  const toggle = (path) => { if (chosen.has(path)) chosen.delete(path); else chosen.add(path); mark(); };

  function build() {
    // at the top of the screen, above everything: also above the file list when it is a drawer
    bar = document.body.createDiv('mobile-select-bar');
    const btn = (icon, label, fn, cls = '') => {
      const el = bar.createDiv({ cls: 'clickable-icon mobile-select-action ' + cls, attr: { 'aria-label': label, 'data-no-tooltip': '' } });
      setIcon(el, icon);
      el.addEventListener('click', (e) => fn(e, el));
      return el;
    };
    btn('x', t('common.cancel'), stop);
    countEl = bar.createDiv('mobile-select-count');
    btn('pencil', t('mobile.select.rename'), renameAll);
    btn('trash', t('common.delete'), deleteAll, 'mod-danger');
    menuBtn = btn('more-horizontal', t('mobile.select.more'), (e, el) => {
      const file = files()[0];
      if (!file) return;
      const m = new Menu();
      app.fileMenu(m, file, 'file-explorer');
      app.workspace.trigger('file-menu', m, file, 'file-explorer', null);
      const r = el.getBoundingClientRect();
      stop();
      m.showAtPosition({ x: r.right, y: r.top - 4, left: true });
    });
  }

  /** One dialog per name, in the order of the choice. Leaving a name as it is skips it; "Cancel" stops. */
  async function renameAll() {
    const list = files();
    stop();
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      const file = app.vault.getAbstractFileByPath(list[i].path);
      if (!file) continue;
      const old = file instanceof TFile ? file.basename : file.name;
      const name = await promptDialog(app, { title: t('mobile.select.rename-title', { i: i + 1, n: list.length }), value: old, confirm: t('common.rename') });
      if (name === null) break;
      const next = name.trim();
      if (!next || next === old) continue;
      const parent = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
      try {
        await app.fileManager.renameFile(file, file instanceof TFile ? `${parent}${next}.${file.extension}` : `${parent}${next}`);
        done += 1;
      } catch (e) { app.notice(t('notice.rename-failed', { error: errorText(e) })); }
    }
    if (list.length > 1) app.notice(t('mobile.select.renamed', { n: done }));
  }

  async function deleteAll() {
    // what is inside a chosen folder goes with the folder
    const list = files().filter((f) => !files().some((g) => g !== f && g instanceof TFolder && f.path.startsWith(g.path + '/')));
    if (!list.length) return;
    const names = list.slice(0, 6).map((f) => f.name).join('\n') + (list.length > 6 ? '\n…' : '');
    const ok = await confirmDialog(app, { title: t('mobile.select.delete-title', { n: list.length }), message: names, confirm: t('common.delete'), warning: true });
    if (!ok) return;
    stop();
    let done = 0;
    for (const f of list) {
      try { await app.fileManager.trashFile(f); done += 1; } catch (e) { app.notice(`${f.name}: ${errorText(e)}`); }
    }
    app.notice(t('mobile.select.deleted', { n: done }));
  }

  // a long press on a row starts the choice (instead of opening the menu of that one file)
  let sweep = null; // {start, before: rows chosen before the press, last} while the finger slides
  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest?.(ROW);
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const path = row.getAttribute('data-path');
    if (!chosen.has(path)) toggle(path);
    sweep = { start: path, before: new Set(chosen), last: path };
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(15); // a short buzz: the choice has started
    // the tap that ends this press must not count as a tap on the row
    swallow = Date.now() + 700;
  }, true);

  const visibleRows = () => [...document.querySelectorAll(ROW)].filter((el) => el.offsetParent !== null);
  const sweepTo = (path) => {
    const rows = visibleRows().map((el) => el.getAttribute('data-path'));
    const a = rows.indexOf(sweep.start);
    const b = rows.indexOf(path);
    if (a === -1 || b === -1) return;
    chosen.clear();
    for (const p of sweep.before) chosen.add(p);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) chosen.add(rows[i]);
    sweep.last = path;
    mark();
  };
  document.addEventListener('touchmove', (e) => {
    if (!sweep || e.touches.length !== 1) return;
    e.preventDefault(); // the finger chooses rows: the list must not scroll under it
    const p = e.touches[0];
    const row = document.elementFromPoint(p.clientX, p.clientY)?.closest?.(ROW);
    if (row && row.getAttribute('data-path') !== sweep.last) sweepTo(row.getAttribute('data-path'));
    // near the top or the bottom of the list, it scrolls so that more rows can be reached
    const list = document.querySelector('.workspace-leaf-content[data-type="file-explorer"] .nav-files-container');
    if (list) {
      const r = list.getBoundingClientRect();
      if (p.clientY < r.top + 48) list.scrollTop -= 14;
      else if (p.clientY > r.bottom - 48) list.scrollTop += 14;
    }
  }, { passive: false, capture: true });
  const endSweep = () => { if (sweep) { sweep = null; swallow = Date.now() + 400; } };
  document.addEventListener('touchend', endSweep, true);
  document.addEventListener('touchcancel', endSweep, true);
  let swallow = 0;
  document.addEventListener('click', (e) => {
    const row = e.target.closest?.(ROW);
    if (!row) return;
    if (Date.now() < swallow) { swallow = 0; e.preventDefault(); e.stopPropagation(); return; }
    if (!chosen.size) return;
    e.preventDefault();
    e.stopPropagation();
    toggle(row.getAttribute('data-path'));
  }, true);

  // the list is drawn again at every change of the vault: the marks are put back
  const render = FileExplorerView.prototype._render;
  FileExplorerView.prototype._render = function renderAndMark(...args) {
    const r = render.apply(this, args);
    for (const p of [...chosen]) if (!app.vault.getAbstractFileByPath(p)) chosen.delete(p);
    mark();
    return r;
  };
  // leaving the list ends the choice
  app.workspace.on('active-leaf-change', () => { if (chosen.size && !document.querySelector(ROW)) stop(); });
  /** Android's back: true when a choice was in progress (and is now ended). */
  app.selectionBack = () => { if (!chosen.size) return false; stop(); return true; };
}
