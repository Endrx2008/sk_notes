// sk_notes for Android – reminders as phone notifications, and what the home-screen widgets show.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The reminders of the notes (shared features/reminders.js) are handed to the native side, which
// sets an alarm for each one: the phone calls the user at that time also when sk_notes is closed.
// The same list feeds the widget of the things to do. The note widget gets the list of notes to
// choose from and a word when one of them changes; the graph widget gets a picture of the graph
// each time the graph stops moving.

import { call } from './api.js';
import { debounce } from '@desktop/core/util.js';

const GRAPH_EVERY = 30 * 1000; // at most one picture of the graph every 30 seconds

export function installNativeReminders(app) {
  const nameOf = (path) => app.vault.getFileByPath(path)?.basename || path.replace(/\.md$/, '');
  let asked = false;
  app.reminderHost = {
    sync: (list) => {
      call('mobile.reminders', { items: list.map((r) => ({ path: r.path, line: r.line, text: r.text, at: r.at, name: nameOf(r.path) })) }).catch((e) => console.warn('reminders not handed to the phone', e));
    },
    // the phone's own notification comes from the alarm (also while the app is open): nothing more here
    notify: () => {},
    // the first reminder set: Android 13+ asks whether sk_notes may show notifications
    askPermission: () => {
      if (asked) return;
      asked = true;
      call('mobile.notifyPermission').catch(() => {});
    },
  };
  if (app.reminders?.ready) app.reminderHost.sync(app.reminders.list());

  // ---- note widget: which notes there are, and which one changed
  const sendNotes = debounce(() => {
    const paths = app.vault.getMarkdownFiles().map((f) => f.path).sort((a, b) => a.localeCompare(b));
    call('mobile.widgetNotes', { paths }).catch(() => {});
  }, 1500, true);
  app.workspace.onLayoutReady(() => {
    sendNotes();
    for (const ev of ['create', 'delete', 'rename']) app.vault.on(ev, () => sendNotes());
    app.vault.on('modify', (f) => { if (f?.extension === 'md') call('mobile.widgetChanged', { path: f.path }).catch(() => {}); });
  });

  // ---- graph widget: a picture of the graph when its dots stopped moving
  let last = 0;
  app.workspace.on('graph-settled', (view) => {
    const now = Date.now();
    if (now - last < GRAPH_EVERY || !view?.picture) return;
    last = now;
    try {
      const url = view.picture(900);
      call('mobile.widgetGraph', { b64: url.slice(url.indexOf(',') + 1) }).catch(() => {});
    } catch (e) { console.warn('graph picture', e); }
  });
}
