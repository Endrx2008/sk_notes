// sk_notes for Android – the screens of encrypted vaults.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The work is done by the backend (backend/vault-crypt.js, vault-lock.js). Here: the
// recovery code shown when a vault is encrypted, the forms to change or recover a password,
// and Settings → General: lock now, lock by itself after…, a new recovery code, encrypt
// this vault, turn this vault back into a normal folder.

import { call } from './api.js';
import { errorText, t } from '@desktop/core/i18n.js';
import { ButtonComponent, Modal, Setting, TextComponent, confirmDialog } from '@desktop/ui/kit.js';

/** A password field: no capital letter, no correction, no suggestion. */
export function secret(parent, placeholder) {
  const x = new TextComponent(parent).setPlaceholder(placeholder);
  x.inputEl.type = 'password';
  x.inputEl.addClass('modal-wide-input');
  for (const [k, v] of [['autocapitalize', 'off'], ['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false']]) x.inputEl.setAttr(k, v);
  return x;
}

function plain(parent, placeholder) {
  const x = new TextComponent(parent).setPlaceholder(placeholder);
  x.inputEl.addClass('modal-wide-input', 'vault-crypt-code-input');
  for (const [k, v] of [['autocapitalize', 'characters'], ['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false']]) x.inputEl.setAttr(k, v);
  return x;
}

/** Show the recovery code until the user says it is written down. Resolves then. */
export function showRecoveryCode(app, code) {
  return new Promise((resolve) => {
    const m = new Modal(app);
    m.modalEl.addClass('mod-recovery-code');
    m.setTitle(t('mobile.crypt.code-title'));
    const c = m.contentEl;
    c.createEl('p', { text: t('mobile.crypt.code-text') });
    c.createDiv({ cls: 'vault-crypt-code', text: code });
    const row = c.createDiv('modal-button-container');
    new ButtonComponent(row).setButtonText(t('mobile.crypt.code-copy')).onClick(async () => {
      try { await call('clipboard.write', { text: code }); app?.notice ? app.notice(t('mobile.crypt.code-copied')) : null; } catch { /* the code stays on screen */ }
    });
    const label = c.createEl('label', { cls: 'vault-crypt-code-ok' });
    const tick = label.createEl('input', { attr: { type: 'checkbox' } });
    label.createSpan({ text: t('mobile.crypt.code-written') });
    const go = new ButtonComponent(c.createDiv('modal-button-container')).setButtonText(t('mobile.crypt.code-done')).setCta().setDisabled(true).onClick(() => m.close());
    tick.addEventListener('change', () => go.setDisabled(!tick.checked));
    m.onClose = () => resolve();
    m.open();
  });
}

/** Old password, new one twice. */
export function passwordChangeForm(parent, path, notify, done = () => {}) {
  const box = parent.createDiv('vault-crypt-form');
  const old = secret(box, t('mobile.crypt.old'));
  const next = secret(box, t('mobile.crypt.new'));
  const again = secret(box, t('mobile.crypt.again'));
  const b = new ButtonComponent(box).setButtonText(t('mobile.crypt.change')).setCta().onClick(async () => {
    if (next.getValue() !== again.getValue()) { notify(t('mobile.crypt.mismatch')); return; }
    b.setDisabled(true);
    try {
      await call('vaults.changePassword', { path, old: old.getValue(), password: next.getValue() });
      notify(t('mobile.crypt.changed'));
      box.remove();
      done();
    } catch (e) { notify(errorText(e)); } finally { b.setDisabled(false); }
  });
  old.inputEl.focus();
  return box;
}

/** A forgotten password: the recovery code, then a new password twice. */
export function recoveryForm(parent, path, notify, done = () => {}) {
  const box = parent.createDiv('vault-crypt-form');
  box.createDiv({ cls: 'vault-manager-place-desc', text: t('mobile.crypt.recover-text') });
  const code = plain(box, 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX');
  const next = secret(box, t('mobile.crypt.new'));
  const again = secret(box, t('mobile.crypt.again'));
  const b = new ButtonComponent(box).setButtonText(t('mobile.crypt.recover')).setCta().onClick(async () => {
    if (next.getValue() !== again.getValue()) { notify(t('mobile.crypt.mismatch')); return; }
    b.setDisabled(true);
    try {
      await call('vaults.recover', { path, code: code.getValue(), password: next.getValue() });
      notify(t('mobile.crypt.changed'));
      box.remove();
      done();
    } catch (e) { notify(errorText(e)); } finally { b.setDisabled(false); }
  });
  code.inputEl.focus();
  return box;
}

/** A folder: shown, with a button to choose another one. Returns () => the folder. */
function folderChoice(parent, start, title) {
  let folder = start;
  const s = new Setting(parent).setName(t('mobile.crypt.where')).setDesc(folder);
  s.addButton((b) => b.setButtonText(t('mobile.crypt.where-choose')).onClick(async () => {
    const p = await call('vaults.pickFolder', { title, start: folder }).catch(() => null);
    if (p) { folder = p; s.setDesc(p); }
  }));
  return () => folder;
}

const parentOf = (p) => String(p).slice(0, String(p).lastIndexOf('/'));

/** Settings → General, for an encrypted vault that is open. */
async function encryptedSection(app, el, info) {
  const file = info.vault.file;
  const notify = (m) => app.notice(m, 8000);
  new Setting(el).setName(t('mobile.crypt.title')).setHeading();
  el.createEl('p', { cls: 'setting-item-description', text: t('mobile.crypt.about', { file }) });
  const cfg = await call('crypt.settings').catch(() => ({ lockAfter: 5, choices: [0, 1, 5, 15, 60, -1], recovery: true }));
  const opts = {};
  for (const m of cfg.choices) opts[m] = m === 0 ? t('mobile.crypt.lock-now-away') : m < 0 ? t('mobile.crypt.lock-never') : t('mobile.crypt.lock-minutes', { n: m });
  new Setting(el).setName(t('mobile.crypt.auto')).setDesc(t('mobile.crypt.auto-desc'))
    .addDropdown((d) => d.addOptions(opts).setValue(String(cfg.lockAfter)).onChange((v) => call('crypt.setLockAfter', { minutes: Number(v) }).catch(() => {})));
  new Setting(el).setName(t('mobile.crypt.lock')).setDesc(t('mobile.crypt.lock-desc')).addButton((b) => b.setButtonText(t('mobile.crypt.lock')).setCta().onClick(() => app.lockVault()));

  let pane = null;
  const open = (draw) => { pane.empty(); draw(pane); };
  new Setting(el).setName(t('mobile.crypt.change')).setDesc(t('mobile.crypt.change-desc'))
    .addButton((b) => b.setButtonText(t('mobile.crypt.change')).onClick(() => open((p) => passwordChangeForm(p, file, notify))));
  new Setting(el).setName(t('mobile.crypt.new-code')).setDesc(cfg.recovery ? t('mobile.crypt.new-code-desc') : t('mobile.crypt.no-code-desc'))
    .addButton((b) => b.setButtonText(t('mobile.crypt.new-code')).onClick(() => open((p) => {
      const box = p.createDiv('vault-crypt-form');
      const pw = secret(box, t('mobile.crypt.password'));
      const go = new ButtonComponent(box).setButtonText(t('mobile.crypt.new-code')).setCta().onClick(async () => {
        go.setDisabled(true);
        try {
          const code = await call('vaults.newRecovery', { password: pw.getValue() });
          box.remove();
          await showRecoveryCode(app, code);
        } catch (e) { notify(errorText(e)); go.setDisabled(false); }
      });
      pw.inputEl.focus();
    })));
  new Setting(el).setName(t('mobile.crypt.decrypt')).setDesc(t('mobile.crypt.decrypt-desc'))
    .addButton((b) => b.setButtonText(t('mobile.crypt.decrypt')).setWarning().onClick(() => open((p) => {
      const box = p.createDiv('vault-crypt-form');
      const pw = secret(box, t('mobile.crypt.password'));
      const where = folderChoice(box, parentOf(file), t('mobile.crypt.decrypt'));
      const label = box.createEl('label', { cls: 'vault-crypt-code-ok' });
      const tick = label.createEl('input', { attr: { type: 'checkbox' } });
      label.createSpan({ text: t('mobile.crypt.remove-encrypted') });
      const go = new ButtonComponent(box).setButtonText(t('mobile.crypt.decrypt')).setCta().onClick(async () => {
        if (tick.checked && !(await confirmDialog(app, { title: t('mobile.crypt.decrypt'), message: t('mobile.crypt.remove-encrypted-confirm', { file }), confirm: t('common.delete'), warning: true }))) return;
        go.setDisabled(true);
        go.setButtonText(t('mobile.crypt.working'));
        try {
          try { await app.flush(); } catch { /* what is on disk goes */ }
          await call('vaults.decrypt', { password: pw.getValue(), parent: where(), removeEncrypted: tick.checked });
          location.hash = '';
          location.reload();
        } catch (e) { notify(errorText(e)); go.setDisabled(false); go.setButtonText(t('mobile.crypt.decrypt')); }
      });
      pw.inputEl.focus();
    })));
  pane = el.createDiv('vault-crypt-pane');
}

/** Settings → General, for a normal vault: make it encrypted. */
function plainSection(app, el, info) {
  const notify = (m) => app.notice(m, 8000);
  new Setting(el).setName(t('mobile.crypt.title')).setHeading();
  let pane = null;
  new Setting(el).setName(t('mobile.crypt.encrypt')).setDesc(t('mobile.crypt.encrypt-desc'))
    .addButton((b) => b.setButtonText(t('mobile.crypt.encrypt')).onClick(() => {
      pane.empty();
      const box = pane.createDiv('vault-crypt-form');
      const pw1 = secret(box, t('mobile.crypt.password'));
      const pw2 = secret(box, t('mobile.crypt.again'));
      box.createDiv({ cls: 'vault-manager-encrypt-warning', text: t('mobile.crypt.warning') });
      const where = folderChoice(box, parentOf(info.vault.path), t('mobile.crypt.encrypt'));
      const label = box.createEl('label', { cls: 'vault-crypt-code-ok' });
      const tick = label.createEl('input', { attr: { type: 'checkbox' } });
      tick.checked = true;
      label.createSpan({ text: t('mobile.crypt.remove-original') });
      box.createDiv({ cls: 'vault-manager-place-desc', text: t('mobile.crypt.remove-original-desc') });
      const go = new ButtonComponent(box).setButtonText(t('mobile.crypt.encrypt')).setCta().onClick(async () => {
        if (pw1.getValue() !== pw2.getValue()) { notify(t('mobile.crypt.mismatch')); return; }
        if (tick.checked && !(await confirmDialog(app, { title: t('mobile.crypt.encrypt'), message: t('mobile.crypt.remove-original-confirm', { folder: info.vault.path }), confirm: t('mobile.crypt.encrypt'), warning: true }))) return;
        go.setDisabled(true);
        go.setButtonText(t('mobile.crypt.working'));
        try {
          try { await app.flush(); } catch { /* what is on disk goes */ }
          const r = await call('vaults.encrypt', { password: pw1.getValue(), parent: where(), removeOriginal: tick.checked });
          await showRecoveryCode(app, r.recovery);
          location.hash = '';
          location.reload();
        } catch (e) { notify(errorText(e)); go.setDisabled(false); go.setButtonText(t('mobile.crypt.encrypt')); }
      });
      pw1.inputEl.focus();
    }));
  pane = el.createDiv('vault-crypt-pane');
}

export function installCryptUi(app, info) {
  if (!info.vault) return;
  if (info.vault.encrypted) {
    app.lockVault = async () => {
      try { await app.flush(); } catch { /* what is on disk is saved */ }
      try { await call('vaults.lock'); } catch (e) { app.notice(errorText(e)); }
    };
    app.on('ready', async () => {
      const n = await call('crypt.takeNotes').catch(() => null);
      if (n?.torn) app.notice(t('mobile.crypt.torn'), 12000);
      if (n?.conflicts?.length) app.notice(t('mobile.crypt.conflicts', { n: n.conflicts.length, list: n.conflicts.slice(0, 5).join('\n') }), 15000);
    });
  }
  app.renderVaultSecurity = (el) => {
    const box = el.createDiv();
    if (!info.vault.encrypted) { plainSection(app, box, info); return; }
    encryptedSection(app, box, info).catch((e) => box.setText(String(e.message || e)));
  };
}
