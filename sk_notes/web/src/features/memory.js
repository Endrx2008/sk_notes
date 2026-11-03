// SKAI_ Memory: the vault is SKAI's shared memory. Everybody may read it; editing needs the user's
// consent (a checkbox) and their sudo password, checked by the backend, which then keeps it open for
// a few minutes of activity. Nothing about the password is stored by the page.

import { call } from '../core/api.js';
import { t, errorText } from '../core/i18n.js';
import { setIcon } from '../core/icons.js';
import { ButtonComponent, Modal } from '../ui/kit.js';

/** Who a note of SKAI_ Memory belongs to: { app, kind } ('' app = SKAI.md, system.md ...). */
function memoryOwner(path) {
  const m = /^plugins\/([^/]+?)(\.md|\/.*)$/.exec(path || '');
  return m ? { app: m[1], kind: m[2] === '.md' ? 'app' : 'chat' } : { app: '', kind: 'hub' };
}

/** 0 solid (the tree), 1 dashed (inside one app's memory), 2 dotted (between different apps). */
export function memoryEdgeStyle(pathA, pathB) {
  const a = memoryOwner(pathA);
  const b = memoryOwner(pathB);
  if (!a.app || !b.app) return 0;
  if (a.app !== b.app) return 2;
  return a.kind === 'app' || b.kind === 'app' ? 0 : 1;
}

class UnlockModal extends Modal {
  constructor(app, done) {
    super(app);
    this.done = done;
  }

  onOpen() {
    this.setTitle(t('memory.dialog-title'));
    const c = this.contentEl;
    const consentRow = c.createEl('label', { cls: 'sk-memory-consent' });
    const consent = consentRow.createEl('input', { attr: { type: 'checkbox' } });
    consentRow.createSpan({ text: t('memory.consent') });
    c.createDiv({ cls: 'sk-memory-label', text: t('memory.password') });
    const pw = c.createEl('input', { cls: 'sk-memory-password', attr: { type: 'password', autocomplete: 'off', spellcheck: 'false' } });
    const err = c.createDiv('sk-memory-error');
    const go = new ButtonComponent(c.createDiv('modal-button-container')).setButtonText(t('memory.unlock')).setCta();
    go.setDisabled(true);
    const sync = () => go.setDisabled(!consent.checked || !pw.value);
    consent.addEventListener('change', sync);
    pw.addEventListener('input', sync);
    const submit = async () => {
      if (!consent.checked || !pw.value) return;
      go.setDisabled(true);
      err.setText('');
      try {
        await call('memory.unlock', { consent: true, password: pw.value });
        pw.value = '';
        this.close();
        this.done();
      } catch (e) {
        pw.value = '';
        err.setText(errorText(e));
        sync();
        pw.focus();
      }
    };
    go.onClick(submit);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    consent.focus();
  }
}

export async function registerMemory(app) {
  if (!app.info.vault?.protected) return;
  const bar = createDiv('sk-memory-banner');
  const icon = bar.createSpan('sk-memory-icon');
  bar.createSpan({ cls: 'sk-memory-text', text: t('memory.banner') });
  const action = new ButtonComponent(bar);
  app.containerEl.insertBefore(bar, app.containerEl.firstChild);

  const refreshViews = async () => {
    const leaves = [];
    app.workspace.iterateAllLeaves((l) => { if (l.view?.file && 'readOnlyReason' in l.view) leaves.push(l.view); });
    for (const v of leaves) {
      try {
        await app.vault.read(v.file);
        v.readOnlyReason = app.vault.getReadOnlyReason?.(v.file) || null;
        v.onReadOnlyChange?.();
      } catch (e) { console.error('memory: refresh failed', e); }
    }
  };

  let unlocked = false;
  const show = (u) => {
    unlocked = u;
    setIcon(icon, u ? 'unlock' : 'lock');
    bar.toggleClass('is-unlocked', u);
    action.setButtonText(u ? t('memory.lock') : t('memory.unlock'));
  };
  action.onClick(async () => {
    if (unlocked) {
      await call('memory.lock');
      show(false);
      await refreshViews();
      app.notice(t('memory.locked'));
    } else {
      new UnlockModal(app, async () => { show(true); await refreshViews(); app.notice(t('memory.unlocked')); }).open();
    }
  });
  try { show((await call('memory.status')).unlocked); } catch { show(false); }
  // the backend closes the lock by itself after a quiet period: ask again when a note is opened
  app.workspace.on('file-open', async () => {
    try { const s = await call('memory.status'); if (s.unlocked !== unlocked) { show(s.unlocked); await refreshViews(); } } catch { /* ignore */ }
  });
}
