// sk_notes for Android – vaults made with another app (Obsidian, Logseq).
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Such a vault opens as it is: at the first opening its settings are used (backend migrate.js,
// "adopt"), and the first change of a file in a session says that the vault belongs to that
// app too. "Continue" lets it be for this session; "Don't show again" for good (this vault).

import { call, setWriteGuard } from './api.js';
import { t } from '@desktop/core/i18n.js';
import { Modal, Notice } from '@desktop/ui/kit.js';

class ForeignVaultModal extends Modal {
  constructor(app, other) {
    super(app);
    this.other = other;
  }

  onOpen() {
    this.modalEl.addClass('mod-foreign-vault');
    this.titleEl.setText(t('mobile.foreign.title', { app: this.other }));
    this.contentEl.createEl('p', { text: t('mobile.foreign.text', { app: this.other }) });
    this.contentEl.createEl('p', { cls: 'setting-item-description', text: t('mobile.foreign.detail', { app: this.other }) });
    const row = this.contentEl.createDiv('modal-button-container');
    row.createEl('button', { text: t('mobile.foreign.never') }).addEventListener('click', () => {
      call('vault.foreignAck').catch(() => {});
      this.close();
    });
    row.createEl('button', { cls: 'mod-cta', text: t('mobile.foreign.continue') }).addEventListener('click', () => this.close());
  }
}

export async function installForeign(app) {
  let info;
  try { info = await call('vault.foreign'); } catch { return; }
  if (!info?.app) return;
  if (info.adopted) {
    const box = createDiv();
    box.createDiv({ text: t('mobile.foreign.adopted', { app: info.adopted.from || info.app }) });
    if (info.adopted.plugins?.length) {
      box.createDiv({ cls: 'setting-item-description', text: t('mobile.foreign.plugins', { n: info.adopted.plugins.length }) });
      const b = box.createEl('button', { cls: 'mod-cta', text: t('mobile.foreign.plugins-review') });
      b.style.marginTop = '8px';
      b.addEventListener('click', () => app.commands.executeCommandById('migration:open'));
    }
    new Notice(box, info.adopted.plugins?.length ? 12000 : 6000);
  }
  if (!info.ack) setWriteGuard(() => setTimeout(() => new ForeignVaultModal(app, info.app).open(), 0));
}
