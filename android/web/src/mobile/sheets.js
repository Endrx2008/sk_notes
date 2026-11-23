// sk_notes for Android – dialogs on a phone.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dialogs and menus are restyled as sheets by the mobile stylesheet. The settings need
// more than styles: their two panes (sections | options) become two pages on a phone, the
// list of sections first, then the options of the section that was tapped.

import { isPhone } from './device.js';
import { setIcon } from '@desktop/core/icons.js';
import { t } from '@desktop/core/i18n.js';
import { Modal } from '@desktop/ui/kit.js';
import { renderUpdateBar } from './update.js';

let settings = null; // the open settings dialog

/** One step back inside the settings; false when they show their list (or are closed). */
export function settingsBack() {
  if (!settings || !settings.modalEl.isConnected || !isPhone()) return false;
  if (!settings.modalEl.hasClass('is-detail')) return false;
  settings.modalEl.removeClass('is-detail');
  settings._mobileTitle?.setText(t('cmd.settings'));
  return true;
}

function adaptSettings(modal) {
  settings = modal;
  const bar = createDiv('mobile-settings-header');
  const back = bar.createDiv({ cls: 'clickable-icon mobile-settings-back', attr: { 'aria-label': t('view.back'), 'data-no-tooltip': '' } });
  setIcon(back, 'arrow-left');
  modal._mobileTitle = bar.createDiv({ cls: 'mobile-settings-title', text: t('cmd.settings') });
  const close = bar.createDiv({ cls: 'clickable-icon mobile-settings-close', attr: { 'aria-label': t('common.close'), 'data-no-tooltip': '' } });
  setIcon(close, 'x');
  modal.modalEl.insertBefore(bar, modal.modalEl.firstChild);
  back.addEventListener('click', () => { if (!settingsBack()) modal.close(); });
  close.addEventListener('click', () => modal.close());
  const openTab = modal.openTabById.bind(modal);
  modal.openTabById = (id) => {
    openTab(id);
    modal.modalEl.addClass('is-detail');
    const tab = modal.tabs.find((x) => x.id === modal.activeId);
    modal._mobileTitle.setText(tab?.name || t('cmd.settings'));
    modal.paneEl.scrollTop = 0;
  };
}

export function installSheets(app) {
  const open = Modal.prototype.open;
  Modal.prototype.open = function openOnMobile() {
    const isSettings = this.modalEl.hasClass('mod-settings') && typeof this.openTabById === 'function';
    if (isSettings && !this._mobileTitle) adaptSettings(this);
    document.activeElement?.blur?.(); // the keyboard of the note leaves with it
    const r = open.call(this);
    if (isSettings) { // opening draws the first section; a phone starts from the list
      this.modalEl.removeClass('is-detail');
      this._mobileTitle.setText(t('cmd.settings'));
      renderUpdateBar(app, this.modalEl); // a newer sk_notes: the orange button at the bottom
    }
    return r;
  };
}
