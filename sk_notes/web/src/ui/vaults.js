// Vault manager: list of known vaults, open folder as vault, create a vault.

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t, errorText } from '../core/i18n.js';
import { encryptOption, showRecoveryCode, unlockForm } from './crypt-ui.js';
import { ButtonComponent, Modal, Notice, TextComponent } from './kit.js';

export function renderVaultManager(container, { onOpened, app, locked = null } = {}) {
  container.addClass('vault-manager');
  const left = container.createDiv('vault-manager-list');
  const right = container.createDiv('vault-manager-actions');
  const logo = right.createDiv('vault-manager-logo');
  logo.createEl('img', { attr: { src: 'logo.svg', alt: '' } });
  right.createDiv({ cls: 'vault-manager-title', text: 'sk_notes' });
  right.createDiv({ cls: 'vault-manager-version', text: t('vaults.tagline') });

  // a notice, also on the start screen (an alert() box would block the whole page)
  const notify = (msg) => (app ? app.notice(msg, 7000) : new Notice(msg, 7000));
  const open = async (path) => {
    try {
      const r = await call('vaults.open', { path });
      if (r.opened === 'here') { if (onOpened) onOpened(); else location.hash = ''; location.reload(); }
      else if (r.opened === 'new-window') notify(t('vaults.opening-window'));
    } catch (e) { notify(t('vaults.open-failed', { error: errorText(e) })); }
  };

  const opened = (r) => {
    if (r.opened === 'here') { if (onOpened) onOpened(); location.hash = ''; location.reload(); }
    else if (r.opened === 'new-window') notify(t('vaults.opening-window'));
  };
  let asking = locked; // the encrypted vault whose password is asked (under its row)
  const renderList = async () => {
    left.empty();
    const list = await call('vaults.list');
    if (!list.length) left.createDiv({ cls: 'vault-manager-empty', text: t('vaults.none') });
    for (const v of list) {
      const row = left.createDiv('vault-manager-item' + (v.current ? ' is-active' : '') + (v.exists ? '' : ' is-missing') + (v.encrypted ? ' is-encrypted' : ''));
      if (v.encrypted) setIcon(row.createDiv('vault-manager-item-icon'), 'lock');
      const txt = row.createDiv('vault-manager-item-text');
      txt.createDiv({ cls: 'vault-manager-item-name', text: v.name });
      txt.createDiv({ cls: 'vault-manager-item-path', text: v.exists ? v.path : t('vaults.missing') });
      const rm = row.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': t('vaults.forget') } });
      setIcon(rm, 'x');
      rm.addEventListener('click', async (e) => { e.stopPropagation(); await call('vaults.forget', { path: v.path }); renderList(); });
      if (v.encrypted) {
        // a window with a vault open asks for the password in a new window; otherwise here
        if (v.exists && !v.current) row.addEventListener('click', async () => {
          if (app) { open(v.path); return; }
          asking = asking === v.path ? null : v.path;
          renderList();
        });
        if (v.exists && !app && asking === v.path) unlockForm(left, v.path, notify, opened, renderList);
      } else if (v.exists && !v.current) row.addEventListener('click', () => open(v.path));
    }
  };

  const action = (title, desc, label, cta, fn) => {
    const row = right.createDiv('vault-manager-action');
    const info = row.createDiv('vault-manager-action-info');
    info.createDiv({ cls: 'vault-manager-action-title', text: title });
    info.createDiv({ cls: 'vault-manager-action-desc', text: desc });
    const b = new ButtonComponent(row).setButtonText(label).onClick(fn);
    if (cta) b.setCta();
  };
  action(t('vaults.create'), t('vaults.create-desc'), t('vaults.create-button'), true, () => {
    right.find('.vault-manager-create')?.detach();
    const box = right.createDiv('vault-manager-create');
    const name = new TextComponent(box).setPlaceholder(t('vaults.name'));
    let parent = '';
    const where = box.createDiv({ cls: 'vault-manager-create-where', text: t('vaults.choose-location') });
    new ButtonComponent(box).setButtonText(t('vaults.browse')).onClick(async () => {
      const p = await call('vaults.pickFolder', { title: t('vaults.choose-location') });
      if (p) { parent = p; where.setText(p); }
    });
    const password = encryptOption(box, notify);
    const go = new ButtonComponent(box).setButtonText(t('vaults.create-button')).setCta().onClick(async () => {
      if (!name.getValue().trim() || !parent) { notify(t('vaults.need-name-location')); return; }
      const params = { parent, name: name.getValue().trim() };
      const pw = password();
      if (pw === false) return;
      if (pw !== null) params.password = pw;
      go.setDisabled(true);
      try {
        const r = await call('vaults.create', params);
        if (r.recovery) await showRecoveryCode(app || null, r.recovery); // shown once, before the vault opens
        opened(r);
      } catch (e) { notify(t('vaults.open-failed', { error: errorText(e) })); } finally { go.setDisabled(false); }
    });
    name.inputEl.focus();
  });
  action(t('vaults.open-folder'), t('vaults.open-folder-desc'), t('vaults.browse'), false, async () => {
    const p = await call('vaults.pickFolder', { title: t('vaults.open-folder') });
    if (p) open(p);
  });
  action(t('pc.crypt.open-file'), t('pc.crypt.open-file-desc'), t('vaults.browse'), false, async () => {
    const p = await call('vaults.pickVaultFile', { title: t('pc.crypt.open-file') });
    if (!p) return;
    try { await call('vaults.remember', { path: p }); } catch (e) { notify(errorText(e)); return; }
    if (app) { open(p); return; }
    asking = p;
    renderList();
  });
  renderList();
}

export class VaultManagerModal extends Modal {
  onOpen() {
    this.modalEl.addClass('mod-vault-manager');
    this.setTitle(t('vaults.title'));
    renderVaultManager(this.contentEl.createDiv(), { app: this.app, onOpened: () => this.close() });
  }
}
