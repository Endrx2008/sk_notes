// File recovery: every snapshot of every note, including deleted notes.

import { call } from '../core/api.js';
import { diffLines, renderDiff } from '../core/diff.js';
import { t } from '../core/i18n.js';
import { ButtonComponent, SearchComponent, confirmDialog } from '../ui/kit.js';
import { ItemView } from '../views/base.js';

export class RecoveryView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'history';
    this.navButtonsEl.hide();
    this.contentEl.addClass('file-recovery');
  }
  getViewType() { return 'file-recovery'; }
  getDisplayText() { return t('recovery.title'); }
  getIcon() { return 'history'; }

  async onOpen() {
    const c = this.contentEl;
    const left = c.createDiv('file-recovery-list');
    const right = c.createDiv('file-recovery-detail');
    const search = new SearchComponent(left).setPlaceholder(t('recovery.filter'));
    const listEl = left.createDiv();
    const files = await call('history.files');
    const render = () => {
      listEl.empty();
      const q = search.getValue().toLowerCase();
      for (const f of files.filter((x) => x.path.toLowerCase().includes(q))) {
        const row = listEl.createDiv('tree-item-self is-clickable' + (f.exists ? '' : ' is-deleted'));
        row.createDiv({ cls: 'tree-item-inner', text: f.path });
        row.createDiv('tree-item-flair-outer').createSpan({ cls: 'tree-item-flair', text: f.exists ? String(f.count) : t('recovery.deleted') });
        row.addEventListener('click', () => this.showFile(right, f));
      }
      if (!files.length) listEl.createDiv({ cls: 'pane-empty', text: t('recovery.none') });
    };
    search.onChange(render);
    render();
  }

  async showFile(el, f) {
    el.empty();
    el.createEl('h3', { text: f.path });
    const snaps = await call('history.list', { path: f.path });
    const current = f.exists ? (await call('vault.read', { path: f.path }).catch(() => ({ text: '' }))).text : '';
    const list = el.createDiv('file-recovery-snapshots');
    const detail = el.createDiv('file-recovery-snapshot');
    for (const s of snaps) {
      const row = list.createDiv('version-history-item is-clickable');
      row.setText(`${window.moment(s.ts).format('YYYY-MM-DD HH:mm:ss')} · ${t(`history.reason.${s.reason}`)}`);
      row.addEventListener('click', async () => {
        list.findAll('.is-active').forEach((x) => x.removeClass('is-active'));
        row.addClass('is-active');
        detail.empty();
        const text = await call('history.read', { id: s.id });
        const bar = detail.createDiv('version-history-toolbar');
        new ButtonComponent(bar).setButtonText(f.exists ? t('history.restore') : t('recovery.restore-deleted')).setCta().onClick(async () => {
          const ok = await confirmDialog(this.app, { title: t('history.restore'), message: t('history.restore-confirm'), confirm: t('history.restore') });
          if (!ok) return;
          await call('history.restore', { path: f.path, id: s.id });
          this.app.notice(t('recovery.restored', { path: f.path }));
        });
        new ButtonComponent(bar).setButtonText(t('common.copy')).onClick(() => navigator.clipboard.writeText(text));
        renderDiff(detail.createDiv('version-history-diff'), diffLines(text, current));
      });
    }
  }
}
