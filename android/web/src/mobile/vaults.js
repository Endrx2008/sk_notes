// sk_notes for Android – vault manager: known vaults, create a vault, open a folder.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Takes the place of ui/vaults.js of the desktop app (same exports). One vault is open at
// a time: choosing another one restarts the page with it.

import { call } from './api.js';
import { installFolderPicker } from './folder-picker.js';
import { passwordChangeForm, recoveryForm, secret, showRecoveryCode } from './crypt-ui.js';
import { themedLogo } from './logo.js';
import { setIcon } from '@desktop/core/icons.js';
import { errorText, t } from '@desktop/core/i18n.js';
import { ButtonComponent, Modal, Notice, TextComponent } from '@desktop/ui/kit.js';

export { passwordChangeForm } from './crypt-ui.js';

export function renderVaultManager(container, { onOpened, app, locked = null } = {}) {
  if (!app) installFolderPicker(null); // the start screen has no workspace yet
  container.addClass('vault-manager', 'mod-mobile');
  const head = container.createDiv('vault-manager-head');
  const logo = head.createDiv('vault-manager-logo');
  logo.createEl('img', { attr: { src: 'logo.svg', alt: '' } });
  themedLogo(logo); // the accent colour of the theme in use, like on Home
  const titles = head.createDiv();
  titles.createDiv({ cls: 'vault-manager-title', text: 'sk_notes' });
  titles.createDiv({ cls: 'vault-manager-version', text: t('mobile.tagline') });
  // what a vault is, for whoever meets the word here for the first time: open on the first
  // start (no vaults yet), a tap away afterwards
  const about = container.createEl('details', { cls: 'vault-manager-about' });
  about.createEl('summary', { text: t('mobile.vaults.what') });
  for (const k of ['mobile.vaults.what-1', 'mobile.vaults.what-md', 'mobile.vaults.what-2', 'mobile.vaults.what-3']) about.createEl('p', { text: t(k) });
  const actions = container.createDiv('vault-manager-actions');
  const listTitle = container.createDiv({ cls: 'vault-manager-list-title', text: t('mobile.vaults.list') });
  const list = container.createDiv('vault-manager-list');

  const notify = (msg) => new Notice(msg, 7000);
  const opened = (r) => {
    if (r.opened !== 'here') return;
    if (onOpened) onOpened();
    location.hash = '';
    location.reload();
  };
  const open = async (path) => {
    try { opened(await call('vaults.open', { path })); } catch (e) { notify(t('vaults.open-failed', { error: errorText(e) })); }
  };

  let asking = locked; // the encrypted vault whose password is being asked
  let firstList = true;
  const renderList = async () => {
    list.empty();
    const vaults = await call('vaults.list');
    listTitle.toggle(vaults.length > 0);
    if (firstList) { firstList = false; about.open = vaults.length === 0; }
    for (const v of vaults) {
      const row = list.createDiv('vault-manager-item' + (v.current ? ' is-active' : '') + (v.exists ? '' : ' is-missing') + (v.encrypted ? ' is-encrypted' : ''));
      setIcon(row.createDiv('vault-manager-item-icon'), v.encrypted ? 'lock' : 'vault');
      const txt = row.createDiv('vault-manager-item-text');
      txt.createDiv({ cls: 'vault-manager-item-name', text: v.name });
      txt.createDiv({ cls: 'vault-manager-item-path', text: v.exists ? v.path : t('vaults.missing') });
      const rm = row.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': t('vaults.forget'), 'data-no-tooltip': '' } });
      setIcon(rm, 'x');
      rm.addEventListener('click', async (e) => { e.stopPropagation(); await call('vaults.forget', { path: v.path }); renderList(); });
      if (v.encrypted) {
        // an encrypted vault: its password is asked here, under its row
        if (v.exists && !v.current) row.addEventListener('click', () => { asking = asking === v.path ? null : v.path; renderList(); });
        if (v.exists && asking === v.path) {
          const box = list.createDiv('vault-crypt-form');
          const pw = secret(box, t('mobile.crypt.password'));
          const go = new ButtonComponent(box).setButtonText(t('mobile.crypt.unlock')).setCta().onClick(async () => {
            go.setDisabled(true);
            go.setButtonText(t('mobile.crypt.opening'));
            try { opened(await call('vaults.open', { path: v.path, password: pw.getValue() })); } catch (e) {
              notify(errorText(e));
              go.setDisabled(false);
              go.setButtonText(t('mobile.crypt.unlock'));
              pw.inputEl.select();
            }
          });
          pw.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.buttonEl.click(); } });
          const links = box.createDiv('vault-crypt-links');
          const other = links.createEl('button', { cls: 'vault-crypt-link', text: t('mobile.crypt.change') });
          other.addEventListener('click', () => { links.remove(); passwordChangeForm(box, v.path, notify, renderList); });
          const forgot = links.createEl('button', { cls: 'vault-crypt-link', text: t('mobile.crypt.forgot') });
          forgot.addEventListener('click', () => { links.remove(); recoveryForm(box, v.path, notify, renderList); });
          setTimeout(() => pw.inputEl.focus(), 50);
        }
      } else if (v.exists && !v.current) row.addEventListener('click', () => open(v.path));
    }
  };

  const action = (icon, title, desc, fn) => {
    const row = actions.createDiv('vault-manager-action');
    setIcon(row.createDiv('vault-manager-action-icon'), icon);
    const info = row.createDiv('vault-manager-action-info');
    info.createDiv({ cls: 'vault-manager-action-title', text: title });
    info.createDiv({ cls: 'vault-manager-action-desc', text: desc });
    row.addEventListener('click', fn);
    return row;
  };

  // ---- create
  const createRow = action('plus', t('vaults.create'), t('vaults.create-desc'), () => form.toggle(!form.isShown()));
  const form = actions.createDiv('vault-manager-create');
  form.hide();
  const name = new TextComponent(form).setPlaceholder(t('vaults.name'));
  name.inputEl.addClass('modal-wide-input');
  let parent = '';
  let place = 'app';
  const places = form.createDiv('vault-manager-places');
  const where = form.createDiv('vault-manager-create-where');
  const renderPlaces = async () => {
    const st = await call('mobile.storage');
    places.empty();
    const option = (id, title, desc, path) => {
      const el = places.createDiv('vault-manager-place' + (place === id ? ' is-active' : ''));
      el.createDiv({ cls: 'vault-manager-place-title', text: title });
      el.createDiv({ cls: 'vault-manager-place-desc', text: desc });
      el.addEventListener('click', async () => {
        if (id === 'device' && !st.granted) {
          const r = await call('mobile.requestStorage').catch(() => ({ granted: false }));
          if (!r.granted) { notify(t('mobile.storage-denied')); return; }
        }
        if (id === 'other') {
          const p = await call('vaults.pickFolder', { title: t('vaults.choose-location') });
          if (!p) return;
          parent = p;
        }
        place = id;
        renderPlaces();
      });
      if (place === id && id !== 'other') parent = path;
    };
    option('app', t('mobile.place-app'), t('mobile.place-app-desc'), st.appVaults);
    option('device', t('mobile.place-device'), t('mobile.place-device-desc'), st.documents || st.shared || '');
    option('other', t('mobile.place-other'), t('mobile.place-other-desc'), parent);
    where.setText(place === 'other' ? parent : '');
  };
  createRow.addEventListener('click', () => { if (form.isShown()) { renderPlaces(); name.inputEl.focus(); } });
  // encryption: chosen here, for the vault as a whole, and only when it is made
  let encrypted = false;
  const lock = form.createDiv('vault-manager-encrypt');
  const lockHead = lock.createDiv('vault-manager-encrypt-head');
  const lockText = lockHead.createDiv();
  lockText.createDiv({ cls: 'vault-manager-place-title', text: t('mobile.crypt.option') });
  lockText.createDiv({ cls: 'vault-manager-place-desc', text: t('mobile.crypt.option-desc') });
  const tick = lockHead.createEl('input', { attr: { type: 'checkbox' } });
  const fields = lock.createDiv('vault-crypt-form');
  fields.hide();
  const pw1 = secret(fields, t('mobile.crypt.password'));
  const pw2 = secret(fields, t('mobile.crypt.again'));
  fields.createDiv({ cls: 'vault-manager-encrypt-warning', text: t('mobile.crypt.warning') });
  const setEncrypted = (on) => { encrypted = on; tick.checked = on; fields.toggle(on); lock.toggleClass('is-active', on); if (on) pw1.inputEl.focus(); };
  tick.addEventListener('click', (e) => e.stopPropagation());
  tick.addEventListener('change', () => setEncrypted(tick.checked));
  lockHead.addEventListener('click', () => setEncrypted(!encrypted));
  const go = new ButtonComponent(form).setButtonText(t('vaults.create-button')).setCta().onClick(async () => {
    if (!name.getValue().trim() || !parent) { notify(t('vaults.need-name-location')); return; }
    const params = { parent, name: name.getValue().trim() };
    if (encrypted) {
      if (pw1.getValue() !== pw2.getValue()) { notify(t('mobile.crypt.mismatch')); return; }
      params.password = pw1.getValue();
    }
    go.setDisabled(true);
    try {
      const r = await call('vaults.create', params);
      if (r.recovery) await showRecoveryCode(app || null, r.recovery); // shown once: before the new vault opens
      opened(r);
    } catch (e) { notify(t('vaults.open-failed', { error: errorText(e) })); } finally { go.setDisabled(false); }
  });
  go.buttonEl.addClass('vault-manager-create-go');

  // ---- open
  action('folder-open', t('vaults.open-folder'), t('vaults.open-folder-desc'), async () => {
    const p = await call('vaults.pickFolder', { title: t('vaults.open-folder'), vaultFiles: true });
    if (!p) return;
    if (/\.skvault$/i.test(p)) { // an encrypted vault file: listed, then its password is asked
      try { await call('vaults.remember', { path: p }); asking = p; await renderList(); } catch (e) { notify(errorText(e)); }
      return;
    }
    open(p);
  });
  renderList();
}

export class VaultManagerModal extends Modal {
  onOpen() {
    this.modalEl.addClass('mod-vault-manager');
    this.setTitle(t('vaults.title'));
    renderVaultManager(this.contentEl.createDiv(), { app: this.app, onOpened: () => this.app.flush?.() });
  }
}

/** The first screen, when no vault is open. */
export function renderStartScreen(el, info) {
  renderVaultManager(el, { locked: info?.locked?.path || null });
  if (info?.startError) new Notice(t('vaults.open-failed', { error: info.startError.detail || info.startError.code }), 10000);
}
