// sk_notes for Android – locking an encrypted vault by itself.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// While an encrypted vault is open its notes are readable in the app's private folder.
// It is locked (saved into its file, the private folder emptied, the password asked again)
// when the user asks, and by itself when the app has been left for the time chosen in the
// settings: at once, after some minutes, or never (until the app is closed by Android).
//
// Leaving the app to pick a photo, share a note or print does not count: those are steps
// of a task started in sk_notes, and the user comes back to it.

import { native } from './native.js';
import { saveSettings, state } from './state.js';
import * as crypt from './vault-crypt.js';

export const LOCK_CHOICES = [0, 1, 5, 15, 60, -1]; // minutes; 0 = at once, -1 = never
const OWN = new Set(['ui.pickFiles', 'sys.share', 'sys.openExternal', 'sys.openPath', 'sys.openFolder', 'ui.printHtml', 'perm.requestStorage']);
const SETTLE = 1500; // after leaving: what the page writes on its way out lands first

let ownStep = false; // the app itself sent the user to another app (a file picker, sharing)
let leftAt = 0;
let timer = null;
let locking = null;
let lockedAway = false;

export const lockAfter = () => (LOCK_CHOICES.includes(state.settings.cryptLockAfter) ? state.settings.cryptLockAfter : 5);

export function setLockAfter(minutes) {
  if (!LOCK_CHOICES.includes(minutes)) return lockAfter();
  state.settings.cryptLockAfter = minutes;
  saveSettings();
  return minutes;
}

/** Save the open encrypted vault, empty its private folder, forget its key. Nothing of it is
 * readable afterwards; the page must be loaded again (it shows the password screen). */
export function lockNow() {
  const v = state.crypt;
  if (!v) return Promise.resolve(false);
  if (locking) return locking;
  locking = (async () => {
    try {
      clearTimeout(v.timer);
      await v.seal();
      if (await v.changed()) await v.seal(); // a last write of the page while saving
      // from now on nothing may write into the private folder (it would be readable again)
      const service = state.service;
      state.service = null;
      state.crypt = null;
      try { service?.close(); } catch { /* closed */ }
      crypt.endSession();
      crypt.wipe(v.where.dir);
      return true;
    } finally { locking = null; }
  })();
  return locking;
}

const reload = () => { try { native.sync('app.reload', {}); } catch { /* the page is loaded again at the next start */ } };

export function installAutoLock() {
  // calls that open another app: remembered, so that coming back is not a reason to lock
  for (const kind of ['sync', 'async']) {
    const call = native[kind];
    native[kind] = (method, params) => {
      if (OWN.has(method)) ownStep = true;
      return call(method, params);
    };
  }
  native.on('app.pause', () => {
    clearTimeout(timer);
    if (!state.crypt) return;
    leftAt = Date.now();
    const limit = lockAfter();
    if (ownStep || limit < 0) return;
    // JavaScript keeps running for a while in the background: the vault is locked there when
    // the time is up; if Android stops the app first, it is locked when the user comes back
    timer = setTimeout(() => {
      lockNow().then((done) => { if (done) lockedAway = true; }).catch((e) => console.error('vault not locked', e));
    }, Math.max(SETTLE, limit * 60000));
  });
  native.on('app.resume', () => {
    clearTimeout(timer);
    const own = ownStep;
    ownStep = false;
    if (lockedAway) { lockedAway = false; reload(); return; }
    const limit = lockAfter();
    if (state.crypt && !own && leftAt && limit >= 0 && Date.now() - leftAt >= limit * 60000) {
      lockNow().then((done) => { if (done) reload(); }).catch((e) => console.error('vault not locked', e));
    }
    leftAt = 0;
  });
}
