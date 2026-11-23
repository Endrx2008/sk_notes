// sk_notes for Android – a newer sk_notes on GitHub: a notice at start, a button in the settings.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The notice shows once per release (ignored, it does not come back at the next start); the
// orange "Update to …" button stays at the bottom of the settings while the release is newer.
// Both open the APK of the release in the browser, which downloads it and offers to install it.

import { call } from './api.js';
import { setIcon } from '@desktop/core/icons.js';
import { t } from '@desktop/core/i18n.js';
import { Notice } from '@desktop/ui/kit.js';

let info = null; // {current, latest: {tag, name, url}, available}

function openUpdate(app) {
  if (info?.latest?.url) app.openExternal(info.latest.url);
}

function label() {
  return t('mobile.update.to', { name: info.latest.name || info.latest.tag });
}

/** The orange button at the bottom of the settings (above Android's navigation bar). */
export function renderUpdateBar(app, modalEl) {
  modalEl.querySelector(':scope > .mobile-update-bar')?.remove();
  if (!info?.available) return;
  const b = modalEl.createDiv({ cls: 'mobile-update-bar', attr: { role: 'button', tabindex: '0' } });
  setIcon(b.createSpan('mobile-update-icon'), 'download');
  b.createSpan({ cls: 'mobile-update-label', text: label() });
  b.addEventListener('click', () => openUpdate(app));
}

export async function checkUpdate(app) {
  try { info = await call('update.check'); } catch { return; }
  if (!info.available) return;
  app.setting?.modalEl && renderUpdateBar(app, app.setting.modalEl); // settings already open
  if (info.notified) return;
  const box = createDiv('mobile-update-notice');
  box.createDiv({ cls: 'mobile-update-text', text: t('mobile.update.available', { name: info.latest.name || info.latest.tag }) });
  const btn = box.createEl('button', { cls: 'mod-cta mobile-update-button' });
  setIcon(btn.createSpan('mobile-update-icon'), 'download');
  btn.createSpan({ text: t('mobile.update.button') });
  btn.addEventListener('click', () => openUpdate(app));
  new Notice(box, 15000); // a tap elsewhere on it, or time, closes it
  call('update.notified', { tag: info.latest.tag }).catch(() => {});
}
