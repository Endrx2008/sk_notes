// sk_notes for Android – choosing a folder.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Vaults are normal folders, so that sync apps and file managers can work on them. The
// folder browser shows the two places sk_notes can use: its own folder (always there,
// removed when the app is uninstalled) and the device storage, which Android only opens
// after the user allows "access to all files" for sk_notes.

import { setFolderPicker } from '../backend/index.js';
import { call } from './api.js';
import { setIcon } from '@desktop/core/icons.js';
import { errorText, t } from '@desktop/core/i18n.js';
import { Modal, promptDialog } from '@desktop/ui/kit.js';

class FolderPicker extends Modal {
  constructor(app, params, done) {
    super(app);
    this.params = params || {};
    this.done = done;
    this.result = null;
    this.path = this.params.start || '';
  }

  onOpen() {
    this.modalEl.addClass('mod-folder-picker');
    this.setTitle(this.params.title || t('mobile.pick-folder'));
    this.placesEl = this.contentEl.createDiv('folder-picker-places');
    this.accessEl = this.contentEl.createDiv('folder-picker-access');
    this.pathEl = this.contentEl.createDiv('folder-picker-path');
    this.listEl = this.contentEl.createDiv('folder-picker-list');
    const row = this.contentEl.createDiv('modal-button-container');
    const mk = row.createEl('button', { text: t('file.new-folder') });
    mk.addEventListener('click', async () => {
      const name = await promptDialog(this.app, { title: t('file.new-folder'), placeholder: t('mobile.folder-name') });
      if (!name || !name.trim()) return;
      try { this.path = await call('mobile.mkdir', { parent: this.path, name: name.trim() }); } catch (e) { this.note(errorText(e)); }
      this.render();
    });
    this.useBtn = row.createEl('button', { cls: 'mod-cta', text: t('mobile.use-folder') });
    this.useBtn.addEventListener('click', () => { this.result = this.path; this.close(); });
    this.render();
  }

  note(msg) { if (this.app?.notice) this.app.notice(msg); else alert(msg); }

  async render() {
    let storage;
    let dir;
    try {
      storage = await call('mobile.storage');
      dir = await call('mobile.browse', { path: this.path });
    } catch (e) { this.listEl.setText(errorText(e)); return; }
    this.path = dir.path;
    this.placesEl.empty();
    const names = { app: t('mobile.place-app'), device: t('mobile.place-device'), card: t('mobile.place-card') };
    const icons = { app: 'vault', device: 'folder', card: 'archive' };
    for (const top of dir.tops) {
      const chip = this.placesEl.createDiv('folder-picker-place' + (top.id === dir.top && (dir.path === top.path || dir.path.startsWith(top.path + '/')) ? ' is-active' : ''));
      setIcon(chip.createSpan(), icons[top.id] || 'folder');
      chip.createSpan({ text: names[top.id] || top.path });
      chip.addEventListener('click', () => { this.path = top.path; this.render(); });
    }
    this.accessEl.empty();
    if (!storage.granted) {
      this.accessEl.createDiv({ cls: 'folder-picker-access-text', text: t('mobile.storage-explain') });
      const b = this.accessEl.createEl('button', { cls: 'mod-cta', text: t('mobile.storage-allow') });
      b.addEventListener('click', async () => {
        const r = await call('mobile.requestStorage').catch(() => ({ granted: false }));
        if (r.granted) this.path = r.documents || r.shared || this.path;
        else this.note(t('mobile.storage-denied'));
        this.render();
      });
    }
    this.accessEl.toggle(!storage.granted);
    const top = dir.tops.find((x) => x.id === dir.top) || dir.tops[0];
    const shown = (names[top.id] || '') + dir.path.slice(top.path.length);
    this.pathEl.setText(shown);
    this.listEl.empty();
    if (dir.parent) {
      const up = this.listEl.createDiv('folder-picker-item mod-up');
      setIcon(up.createSpan(), 'arrow-up');
      up.createSpan({ text: t('mobile.folder-up') });
      up.addEventListener('click', () => { this.path = dir.parent; this.render(); });
    }
    if (!dir.readable) this.listEl.createDiv({ cls: 'folder-picker-empty', text: t('error.permission-denied') });
    else if (!dir.folders.length) this.listEl.createDiv({ cls: 'folder-picker-empty', text: t('mobile.folder-empty') });
    for (const name of dir.folders) {
      const it = this.listEl.createDiv('folder-picker-item');
      setIcon(it.createSpan(), 'folder');
      it.createSpan({ text: name });
      it.addEventListener('click', () => { this.path = `${dir.path}/${name}`; this.render(); });
    }
    // encrypted vaults kept in this folder: a tap chooses that file
    if (this.params.vaultFiles) {
      for (const name of dir.vaults || []) {
        const it = this.listEl.createDiv('folder-picker-item mod-vault-file');
        setIcon(it.createSpan(), 'lock');
        it.createSpan({ text: name.replace(/\.skvault$/i, '') });
        it.createSpan({ cls: 'folder-picker-flag', text: t('mobile.crypt.flag') });
        it.addEventListener('click', () => { this.result = `${dir.path}/${name}`; this.close(); });
      }
    }
    this.listEl.scrollTop = 0;
    if (dir.isVault) this.pathEl.createSpan({ cls: 'folder-picker-flag', text: t('mobile.folder-is-vault') });
    else if (dir.notes) this.pathEl.createSpan({ cls: 'folder-picker-flag', text: t('mobile.folder-notes', { n: dir.notes }) });
  }

  onClose() { this.done(this.result); }
}

/** Ask for a folder; resolves with its path, or null when the dialog is dismissed. */
export function pickFolder(app, params) {
  return new Promise((resolve) => new FolderPicker(app, params, resolve).open());
}

export function installFolderPicker(app) {
  setFolderPicker((params) => pickFolder(app, params));
}
