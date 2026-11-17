// Screens of encrypted vaults (desktop): recovery code, password forms, and the section of
// Settings → General (lock, lock by itself, new recovery code, encrypt / decrypt the vault).
// The work is done by Python (sk_notes/core/crypt.py, sk_notes/app/crypt_session.py).

import { call } from '../core/api.js';
import { errorText, t } from '../core/i18n.js';
import { ButtonComponent, Modal, Setting, TextComponent, confirmDialog } from './kit.js';

export function secret(parent, placeholder) {
  const x = new TextComponent(parent).setPlaceholder(placeholder);
  x.inputEl.type = 'password';
  x.inputEl.addClass('crypt-input');
  for (const [k, v] of [['autocomplete', 'off'], ['spellcheck', 'false']]) x.inputEl.setAttr(k, v);
  return x;
}

/** Enter in the last field presses the button. */
function enterSubmits(fields, button) {
  const last = fields[fields.length - 1];
  last.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); button.buttonEl.click(); } });
}

/** Show the recovery code until the user says it is written down. */
export function showRecoveryCode(app, code) {
  return new Promise((resolve) => {
    const m = new Modal(app);
    m.modalEl.addClass('mod-recovery-code');
    m.setTitle(t('pc.crypt.code-title'));
    const c = m.contentEl;
    c.createEl('p', { text: t('pc.crypt.code-text') });
    c.createDiv({ cls: 'crypt-code', text: code });
    const label = c.createEl('label', { cls: 'crypt-check' });
    const tick = label.createEl('input', { attr: { type: 'checkbox' } });
    label.createSpan({ text: t('pc.crypt.code-written') });
    const row = c.createDiv('modal-button-container');
    new ButtonComponent(row).setButtonText(t('pc.crypt.code-copy')).onClick(async () => {
      try { await navigator.clipboard.writeText(code); if (app?.notice) app.notice(t('pc.crypt.code-copied')); } catch { /* the code stays on screen */ }
    });
    const go = new ButtonComponent(row).setButtonText(t('pc.crypt.code-done')).setCta().setDisabled(true).onClick(() => m.close());
    tick.addEventListener('change', () => go.setDisabled(!tick.checked));
    m.onClose = () => resolve();
    m.open();
  });
}

export function passwordChangeForm(parent, path, notify, done = () => {}) {
  const box = parent.createDiv('crypt-form');
  const old = secret(box, t('pc.crypt.old'));
  const next = secret(box, t('pc.crypt.new'));
  const again = secret(box, t('pc.crypt.again'));
  const b = new ButtonComponent(box).setButtonText(t('pc.crypt.change')).setCta().onClick(async () => {
    if (next.getValue() !== again.getValue()) { notify(t('pc.crypt.mismatch')); return; }
    b.setDisabled(true);
    try {
      await call('vaults.changePassword', { path, old: old.getValue(), password: next.getValue() });
      notify(t('pc.crypt.changed'));
      box.remove();
      done();
    } catch (e) { notify(errorText(e)); } finally { b.setDisabled(false); }
  });
  enterSubmits([old, next, again], b);
  old.inputEl.focus();
  return box;
}

export function recoveryForm(parent, path, notify, done = () => {}) {
  const box = parent.createDiv('crypt-form');
  box.createDiv({ cls: 'setting-item-description', text: t('pc.crypt.recover-text') });
  const code = new TextComponent(box).setPlaceholder('XXXX-XXXX-XXXX-XXXX-XXXX-XXXX');
  code.inputEl.addClass('crypt-input', 'crypt-code-input');
  const next = secret(box, t('pc.crypt.new'));
  const again = secret(box, t('pc.crypt.again'));
  const b = new ButtonComponent(box).setButtonText(t('pc.crypt.recover')).setCta().onClick(async () => {
    if (next.getValue() !== again.getValue()) { notify(t('pc.crypt.mismatch')); return; }
    b.setDisabled(true);
    try {
      await call('vaults.recover', { path, code: code.getValue(), password: next.getValue() });
      notify(t('pc.crypt.changed'));
      box.remove();
      done();
    } catch (e) { notify(errorText(e)); } finally { b.setDisabled(false); }
  });
  enterSubmits([code, next, again], b);
  code.inputEl.focus();
  return box;
}

/** Password field + "Open" for a locked vault; links to change or recover the password. */
export function unlockForm(parent, path, notify, opened, redraw) {
  const box = parent.createDiv('crypt-form crypt-unlock');
  const pw = secret(box, t('pc.crypt.password'));
  const go = new ButtonComponent(box).setButtonText(t('pc.crypt.unlock')).setCta().onClick(async () => {
    go.setDisabled(true);
    go.setButtonText(t('pc.crypt.opening'));
    try { opened(await call('vaults.open', { path, password: pw.getValue() })); } catch (e) {
      notify(errorText(e));
      go.setDisabled(false);
      go.setButtonText(t('pc.crypt.unlock'));
      pw.inputEl.select();
    }
  });
  enterSubmits([pw], go);
  const links = box.createDiv('crypt-links');
  const change = links.createEl('a', { text: t('pc.crypt.change'), href: '#' });
  change.addEventListener('click', (e) => { e.preventDefault(); links.remove(); passwordChangeForm(box, path, notify, redraw); });
  const forgot = links.createEl('a', { text: t('pc.crypt.forgot'), href: '#' });
  forgot.addEventListener('click', (e) => { e.preventDefault(); links.remove(); recoveryForm(box, path, notify, redraw); });
  setTimeout(() => pw.inputEl.focus(), 30);
  return box;
}

/** Encrypt option and fields of the "create vault" form. Returns () => password or null (not encrypted). */
export function encryptOption(parent, notify) {
  const wrap = parent.createDiv('crypt-option');
  const label = wrap.createEl('label', { cls: 'crypt-check' });
  const tick = label.createEl('input', { attr: { type: 'checkbox' } });
  const txt = label.createDiv();
  txt.createDiv({ cls: 'crypt-option-title', text: t('pc.crypt.option') });
  txt.createDiv({ cls: 'setting-item-description', text: t('pc.crypt.option-desc') });
  const fields = wrap.createDiv('crypt-form');
  fields.hide();
  const pw1 = secret(fields, t('pc.crypt.password'));
  const pw2 = secret(fields, t('pc.crypt.again'));
  fields.createDiv({ cls: 'crypt-warning', text: t('pc.crypt.warning') });
  tick.addEventListener('change', () => { fields.toggle(tick.checked); wrap.toggleClass('is-active', tick.checked); if (tick.checked) pw1.inputEl.focus(); });
  return () => {
    if (!tick.checked) return null;
    if (pw1.getValue() !== pw2.getValue()) { notify(t('pc.crypt.mismatch')); return false; }
    return pw1.getValue();
  };
}

/** A folder shown with a button to choose another one. Returns () => the folder. */
function folderChoice(parent, start, title) {
  let folder = start;
  const s = new Setting(parent).setName(t('pc.crypt.where')).setDesc(folder);
  s.addButton((b) => b.setButtonText(t('pc.crypt.choose')).onClick(async () => {
    const p = await call('vaults.pickFolder', { title, start: folder }).catch(() => null);
    if (p) { folder = p; s.setDesc(p); }
  }));
  return () => folder;
}

const parentOf = (p) => String(p).slice(0, String(p).lastIndexOf('/'));

async function encryptedSection(app, el, info) {
  const file = info.vault.file;
  const notify = (m) => app.notice(m, 8000);
  new Setting(el).setName(t('pc.crypt.title')).setHeading();
  el.createEl('p', { cls: 'setting-item-description', text: t('pc.crypt.about', { file }) });
  const cfg = await call('crypt.settings').catch(() => ({ lockAfter: 5, choices: [0, 1, 5, 15, 60, -1], recovery: true }));
  const opts = {};
  for (const m of cfg.choices) opts[m] = m === 0 ? t('pc.crypt.lock-now-away') : m < 0 ? t('pc.crypt.lock-never') : t('pc.crypt.lock-minutes', { n: m });
  new Setting(el).setName(t('pc.crypt.auto')).setDesc(t('pc.crypt.auto-desc'))
    .addDropdown((d) => d.addOptions(opts).setValue(String(cfg.lockAfter)).onChange((v) => call('crypt.setLockAfter', { minutes: Number(v) }).catch(() => {})));
  new Setting(el).setName(t('pc.crypt.lock')).setDesc(t('pc.crypt.lock-desc')).addButton((b) => b.setButtonText(t('pc.crypt.lock')).setCta().onClick(() => app.lockVault()));
  let pane = null;
  const show = (draw) => { pane.empty(); draw(pane); };
  new Setting(el).setName(t('pc.crypt.change')).setDesc(t('pc.crypt.change-desc'))
    .addButton((b) => b.setButtonText(t('pc.crypt.change')).onClick(() => show((p) => passwordChangeForm(p, file, notify))));
  new Setting(el).setName(t('pc.crypt.new-code')).setDesc(cfg.recovery ? t('pc.crypt.new-code-desc') : t('pc.crypt.no-code-desc'))
    .addButton((b) => b.setButtonText(t('pc.crypt.new-code')).onClick(() => show((p) => {
      const box = p.createDiv('crypt-form');
      const pw = secret(box, t('pc.crypt.password'));
      const go = new ButtonComponent(box).setButtonText(t('pc.crypt.new-code')).setCta().onClick(async () => {
        go.setDisabled(true);
        try {
          const code = await call('vaults.newRecovery', { password: pw.getValue() });
          box.remove();
          await showRecoveryCode(app, code);
        } catch (e) { notify(errorText(e)); go.setDisabled(false); }
      });
      enterSubmits([pw], go);
      pw.inputEl.focus();
    })));
  new Setting(el).setName(t('pc.crypt.decrypt')).setDesc(t('pc.crypt.decrypt-desc'))
    .addButton((b) => b.setButtonText(t('pc.crypt.decrypt')).setWarning().onClick(() => show((p) => {
      const box = p.createDiv('crypt-form');
      const pw = secret(box, t('pc.crypt.password'));
      const where = folderChoice(box, parentOf(file), t('pc.crypt.decrypt'));
      const label = box.createEl('label', { cls: 'crypt-check' });
      const tick = label.createEl('input', { attr: { type: 'checkbox' } });
      label.createSpan({ text: t('pc.crypt.remove-encrypted') });
      const go = new ButtonComponent(box).setButtonText(t('pc.crypt.decrypt')).setCta().onClick(async () => {
        if (tick.checked && !(await confirmDialog(app, { title: t('pc.crypt.decrypt'), message: t('pc.crypt.remove-encrypted-confirm', { file }), confirm: t('common.delete'), warning: true }))) return;
        go.setDisabled(true);
        go.setButtonText(t('pc.crypt.working'));
        try {
          await app.flush?.();
          await call('vaults.decrypt', { password: pw.getValue(), parent: where(), removeEncrypted: tick.checked });
          location.hash = '';
          location.reload();
        } catch (e) { notify(errorText(e)); go.setDisabled(false); go.setButtonText(t('pc.crypt.decrypt')); }
      });
      pw.inputEl.focus();
    })));
  pane = el.createDiv('crypt-pane');
}

function plainSection(app, el, info) {
  const notify = (m) => app.notice(m, 8000);
  new Setting(el).setName(t('pc.crypt.title')).setHeading();
  let pane = null;
  new Setting(el).setName(t('pc.crypt.encrypt')).setDesc(t('pc.crypt.encrypt-desc'))
    .addButton((b) => b.setButtonText(t('pc.crypt.encrypt')).onClick(() => {
      pane.empty();
      const box = pane.createDiv('crypt-form');
      const pw1 = secret(box, t('pc.crypt.password'));
      const pw2 = secret(box, t('pc.crypt.again'));
      box.createDiv({ cls: 'crypt-warning', text: t('pc.crypt.warning') });
      const where = folderChoice(box, parentOf(info.vault.path), t('pc.crypt.encrypt'));
      const label = box.createEl('label', { cls: 'crypt-check' });
      const tick = label.createEl('input', { attr: { type: 'checkbox' } });
      tick.checked = true;
      label.createSpan({ text: t('pc.crypt.remove-original') });
      box.createDiv({ cls: 'setting-item-description', text: t('pc.crypt.remove-original-desc') });
      const go = new ButtonComponent(box).setButtonText(t('pc.crypt.encrypt')).setCta().onClick(async () => {
        if (pw1.getValue() !== pw2.getValue()) { notify(t('pc.crypt.mismatch')); return; }
        if (tick.checked && !(await confirmDialog(app, { title: t('pc.crypt.encrypt'), message: t('pc.crypt.remove-original-confirm', { folder: info.vault.path }), confirm: t('pc.crypt.encrypt'), warning: true }))) return;
        go.setDisabled(true);
        go.setButtonText(t('pc.crypt.working'));
        try {
          await app.flush?.();
          const r = await call('vaults.encrypt', { password: pw1.getValue(), parent: where(), removeOriginal: tick.checked });
          await showRecoveryCode(app, r.recovery);
          location.hash = '';
          location.reload();
        } catch (e) { notify(errorText(e)); go.setDisabled(false); go.setButtonText(t('pc.crypt.encrypt')); }
      });
      pw1.inputEl.focus();
    }));
  pane = el.createDiv('crypt-pane');
}

export function installCryptUi(app, info) {
  if (!info.vault) return;
  if (info.vault.encrypted) {
    app.lockVault = async () => {
      try { await app.flush?.(); } catch { /* what is on disk is saved */ }
      try { await call('vaults.lock'); } catch (e) { app.notice(errorText(e)); }
    };
    app.commands.addCommand({ id: 'vault:lock', name: t('pc.crypt.lock'), icon: 'lock', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'L' }], callback: () => app.lockVault() });
    app.on('ready', async () => {
      const n = await call('crypt.takeNotes').catch(() => null);
      if (n?.torn) app.notice(t('pc.crypt.torn'), 12000);
      if (n?.conflicts?.length) app.notice(t('pc.crypt.conflicts', { n: n.conflicts.length, list: n.conflicts.slice(0, 5).join('\n') }), 15000);
    });
  }
  app.renderVaultSecurity = (el) => {
    const box = el.createDiv();
    (info.vault.encrypted ? encryptedSection(app, box, info) : Promise.resolve(plainSection(app, box, info))).catch((e) => box.setText(String(e.message || e)));
  };
}
