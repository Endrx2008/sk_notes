// sk_notes for Android – the back button (or back gesture).
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Back closes what is on top, in this order: a menu or suggestion list, a dialog (the
// settings go back to their list first), an open drawer, then it goes back in the history
// of the note. With nothing left to close, sk_notes goes to the background.

import { native } from '../backend/native.js';
import { call } from './api.js';
import { drawerOpen } from './drawers.js';
import { BASE_VIEWS } from './home.js';
import { settingsBack } from './sheets.js';
import { closeGraphControls } from './touch.js';

function escape() {
  const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', init));
}

export function goBack(app) {
  if (document.querySelector('.menu, .suggestion-container')) { escape(); return true; }
  if (settingsBack()) return true;
  if (app.versionsBack?.()) return true; // from a version back to the timeline
  if (app.selectionBack?.()) return true; // files chosen in the list: the choice ends
  const modals = document.querySelectorAll('.modal-container');
  if (modals.length) {
    const before = modals.length;
    escape();
    // a dialog that does not listen to Escape is closed by its own button
    if (document.querySelectorAll('.modal-container').length === before) modals[before - 1].querySelector('.modal-close-button')?.click();
    return true;
  }
  if (document.querySelector('.popover.hover-popover')) { document.querySelectorAll('.popover.hover-popover').forEach((p) => p.remove()); return true; }
  if (closeGraphControls()) return true; // the settings panel of the graph
  const drawer = drawerOpen(app);
  if (drawer) { drawer.collapse(); return true; }
  const ws = app.workspace;
  const leaf = ws.activeLeaf && ws.activeLeaf.getRoot() === ws.rootSplit ? ws.activeLeaf : ws.getMostRecentLeaf(ws.rootSplit);
  if (leaf?.history.canBack()) { leaf.history.back(); return true; }
  // the graph or the file list opened from Home: Android's back returns to Home (the arrows
  // of the bar do not: Home is not one of their steps)
  if (leaf && BASE_VIEWS.includes(leaf.view?.getViewType())) {
    leaf.history.backHistory = [];
    leaf.history.forwardHistory = [];
    leaf.setViewState({ type: 'empty' }, null, true);
    return true;
  }
  return false;
}

export function installBack(app) {
  native.on('back', async () => {
    if (goBack(app)) return;
    try { await app.flush(); } catch { /* still leave */ }
    call('app.background').catch(() => {});
  });
  // leaving the app: everything typed is on disk before Android may stop it
  native.on('app.pause', () => { app.flush().catch(() => {}); });
}
