// sk_notes for Android – Home (what an empty tab shows) and the base views.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Home is where everything starts: what to make (a note – or today's note, the small button
// of the same tile –, a canvas,
// note, a note from a template) and how to look at the vault (graph or file list).
// The graph and the file list are the two base views of the app: they are not tabs to
// close. They show in the tab in use, give way to the file the user opens from them, and
// come back when the user leaves that file ("back").

import { setIcon } from '@desktop/core/icons.js';
import { t } from '@desktop/core/i18n.js';
import { TemplateModal, applyTemplateVars } from '@desktop/features/core.js';
import { themedLogo } from './logo.js';

export const BASE_VIEWS = ['graph', 'file-explorer'];

/** Choose a template, then make a new note with its text. */
export function newNoteFromTemplate(app) {
  new TemplateModal(app, async (template) => {
    try {
      const folder = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path || '');
      const file = await app.fileManager.createNewMarkdownFile(folder);
      if (!file) return;
      await app.vault.modify(file, applyTemplateVars(app, await app.vault.read(template), file.basename));
      await app.workspace.openFile(file, false);
    } catch (e) { app.notice(String(e.message || e)); }
  }).open();
}

/** Put away the base views shown in tabs other than `keep`: the tab goes back to the file it
 * had; a tab that held nothing else is closed. Base views are never left behind as tabs. */
export async function leaveBase(app, keep) {
  const ws = app.workspace;
  const leaves = [];
  ws.iterateLeaves(ws.rootSplit, (l) => { if (l !== keep && BASE_VIEWS.includes(l.view?.getViewType())) leaves.push(l); });
  for (const l of leaves) {
    try {
      while (BASE_VIEWS.includes(l.view?.getViewType()) && l.history?.canBack()) await l.history.back();
      if (BASE_VIEWS.includes(l.view?.getViewType())) await l.detach();
    } catch (e) { console.warn('base view not put away', e); }
  }
}

/** Forget the base views among the steps of the tab: only the one shown now stays a step of
 * back (graph after the list: back returns to the file under them, or Home, not to the list). */
export function dropBaseSteps(leaf) {
  const h = leaf.history;
  if (!h) return;
  const keep = (s) => !BASE_VIEWS.includes(s?.state?.type);
  h.backHistory = h.backHistory.filter(keep);
  h.forwardHistory = h.forwardHistory.filter(keep);
}

/** Show a base view (graph or file list) in the tab in use. */
export async function openBase(app, type) {
  const ws = app.workspace;
  for (const dock of [ws.leftSplit, ws.rightSplit]) if (dock && !dock.collapsed && document.body.classList.contains('is-phone')) dock.collapse();
  let leaf = ws.activeLeaf && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf : ws.getMostRecentLeaf(ws.rootSplit);
  if (!leaf || leaf.pinned) leaf = ws.getLeaf('tab');
  await leaveBase(app, leaf);
  if (leaf.view?.getViewType() !== type) await leaf.setViewState({ type, active: true });
  dropBaseSteps(leaf);
  if (leaf.view) leaf.view.navigation = true; // leaving it for a file is a step "back" undoes
  ws.setActiveLeaf(leaf, { focus: false });
}

export function renderHome(app, view) {
  const run = (id) => () => app.commands.executeCommandById(id);
  const box = view.contentEl.createDiv('mobile-home');
  const head = box.createDiv('mobile-home-head');
  const logo = head.createDiv('mobile-home-logo');
  logo.createEl('img', { attr: { src: 'logo.svg', alt: '' } });
  themedLogo(logo);
  head.createDiv({ cls: 'mobile-home-name', text: 'sk_notes' });
  app.renderSyncCard?.(box); // proposes the sync once, then shows its state
  const section = (title, items, cls) => {
    box.createDiv({ cls: 'mobile-home-title', text: title });
    const grid = box.createDiv('mobile-home-grid' + (cls ? ' ' + cls : ''));
    for (const [icon, label, fn, mod, extra] of items) {
      const tile = grid.createDiv({ cls: 'mobile-home-tile' + (mod ? ' ' + mod : ''), attr: { role: 'button', tabindex: '0' } });
      setIcon(tile.createDiv('mobile-home-icon'), icon);
      tile.createDiv({ cls: 'mobile-home-label', text: label });
      tile.addEventListener('click', fn);
      // a small button at the right of the tile, for a second thing to make (today's note)
      if (extra) {
        const b = tile.createDiv({ cls: 'mobile-home-extra', attr: { role: 'button', tabindex: '0', 'aria-label': extra.label, 'data-no-tooltip': '' } });
        setIcon(b, extra.icon);
        b.addEventListener('click', (e) => { e.stopPropagation(); extra.fn(); });
      }
    }
  };
  section(t('mobile.home.create'), [
    ['file-plus', t('cmd.new-note'), run('file:new'), 'mod-cta', { icon: 'calendar-day', label: t('cmd.daily-note'), fn: run('daily-notes') }],
    ['canvas', t('cmd.new-canvas'), run('canvas:new-file')],
    ['template', t('mobile.home.template'), () => newNoteFromTemplate(app)],
    ['alarm-clock', t('cmd.reminders'), run('reminders:open')],
  ]);
  section(t('mobile.home.view'), [
    ['graph', t('mobile.home.graph'), () => openBase(app, 'graph'), 'mod-view'],
    ['list', t('mobile.home.list'), () => openBase(app, 'file-explorer'), 'mod-view'],
  ], 'mod-views');
}
