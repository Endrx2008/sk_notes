// The trash: what was deleted from this vault in the last three months (desktop and Android).
//
// Opened from the wheel menu (its first, red entry). Each deleted file or folder can be put
// back where it was, or removed for good; older than three months, the backend has already
// removed it (core/trash.py on the desktop, android/web/src/backend/trash.js on Android).
// On the desktop the list also holds what this vault sent to the system trash.

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { errorText, t } from '../core/i18n.js';
import { Modal, confirmDialog } from '../ui/kit.js';

const DAY = 24 * 60 * 60 * 1000;

class TrashModal extends Modal {
  constructor(app) {
    super(app);
    this.modalEl.addClass('mod-trash');
  }

  async onOpen() {
    this.setTitle(t('trash.title'));
    this.body = this.contentEl.createDiv('trash');
    await this.show();
  }

  async show() {
    let res;
    try { res = await call('trash.list'); } catch (e) { this.app.notice(errorText(e)); this.close(); return; }
    const items = res.items || [];
    const keep = res.keep || 90 * DAY;
    const el = this.body;
    el.empty();
    el.createEl('p', { cls: 'trash-intro', text: t('trash.intro') });
    if (this.app.settings.get('trashOption') === 'none') el.createEl('p', { cls: 'trash-intro mod-warning', text: t('trash.off', { setting: t('settings.deleted-files') }) });
    if (!items.length) { el.createDiv({ cls: 'trash-none', text: t('trash.nothing') }); return; }
    const list = el.createDiv('trash-list');
    for (const it of items) {
      const row = list.createDiv('trash-item');
      setIcon(row.createDiv('trash-kind'), it.folder ? 'folder' : 'file');
      const text = row.createDiv('trash-text');
      text.createDiv({ cls: 'trash-name', text: it.name });
      const slash = (it.from || '').lastIndexOf('/');
      const where = slash > 0 ? it.from.slice(0, slash) : ''; // the folder it came from (none at the top of the vault)
      const left = Math.max(1, Math.ceil((it.at + keep - Date.now()) / DAY));
      const parts = [t('trash.deleted-on', { date: window.moment(it.at).format('D MMM YYYY') }), t('trash.days-left', { n: left })];
      if (where) parts.unshift(where);
      text.createDiv({ cls: 'trash-when', text: parts.join(' · ') });
      const restore = row.createDiv({ cls: 'clickable-icon trash-action', attr: { 'aria-label': t('trash.restore'), 'data-no-tooltip': '' } });
      setIcon(restore, 'rotate-ccw');
      restore.addEventListener('click', () => this.restore(it));
      const del = row.createDiv({ cls: 'clickable-icon trash-action mod-danger', attr: { 'aria-label': t('trash.delete'), 'data-no-tooltip': '' } });
      setIcon(del, 'trash');
      del.addEventListener('click', () => this.remove(it));
    }
    const empty = el.createEl('button', { cls: 'mod-warning trash-empty' });
    setIcon(empty.createSpan('trash-empty-icon'), 'trash');
    empty.createSpan({ text: t('trash.empty') });
    empty.addEventListener('click', () => this.emptyAll(items.length));
  }

  async restore(it) {
    try {
      const r = await call('trash.restore', { name: it.id || it.name });
      this.app.notice(t('trash.restored', { path: r.path }));
    } catch (e) { this.app.notice(errorText(e)); }
    await this.show();
  }

  async remove(it) {
    const ok = await confirmDialog(this.app, { title: t('trash.delete-title', { name: it.name }), message: t('trash.forever'), confirm: t('trash.delete'), warning: true });
    if (!ok) return;
    try { await call('trash.delete', { name: it.id || it.name }); } catch (e) { this.app.notice(errorText(e)); }
    await this.show();
  }

  async emptyAll(n) {
    const ok = await confirmDialog(this.app, { title: t('trash.empty-title'), message: t('trash.empty-message', { n }), confirm: t('trash.empty'), warning: true });
    if (!ok) return;
    try { await call('trash.empty'); } catch (e) { this.app.notice(errorText(e)); }
    await this.show();
  }
}

export function openTrash(app) {
  new TrashModal(app).open();
}
