// Status bar (bottom right): backlinks count, editor mode, word/character count,
// SKAI state, plus items added by plugins.

import { setIcon } from '../core/icons.js';
import { t, tn } from '../core/i18n.js';
import { setTooltip } from './kit.js';

export class StatusBar {
  constructor(app, parent) {
    this.app = app;
    this.containerEl = parent.createDiv('status-bar');
    this.pluginEl = this.containerEl.createDiv('status-bar-plugin-items');
    this.backlinksEl = this.item('status-bar-item mod-clickable plugin-backlink');
    this.modeEl = this.item('status-bar-item mod-clickable plugin-editor-status');
    this.countEl = this.item('status-bar-item plugin-word-count');
    this.skaiEl = this.item('status-bar-item mod-clickable plugin-skai');
    this.backlinksEl.addEventListener('click', () => app.commands.executeCommandById('backlink:open'));
    this.modeEl.addEventListener('click', () => {
      const v = app.workspace.activeLeaf?.view;
      if (v?.setSourceMode && v.getMode() === 'source') v.setSourceMode(!v.sourceMode);
      else v?.toggleMode?.();
      this.updateMode(v);
    });
    this.skaiEl.addEventListener('click', () => app.commands.executeCommandById('skai:open'));
    app.workspace.on('active-leaf-change', () => this.refresh());
    app.workspace.on('file-open', () => this.refresh());
    app.metadataCache.on('resolved', () => this.updateBacklinks());
    this.setSkai('unknown');
  }

  item(cls) { return this.containerEl.createDiv(cls); }

  addStatusBarItem() {
    const el = this.pluginEl.createDiv('status-bar-item plugin-item');
    return el;
  }

  refresh() {
    const v = this.app.workspace.activeLeaf?.view;
    this.updateMode(v);
    this.updateCounts(v);
    this.updateBacklinks();
  }

  updateMode(view) {
    const v = view || this.app.workspace.activeLeaf?.view;
    if (!v || v.getViewType?.() !== 'markdown') { this.modeEl.hide(); return; }
    this.modeEl.show();
    this.modeEl.empty();
    const icon = v.getMode() === 'preview' ? 'reading-mode' : v.sourceMode ? 'code' : 'edit-mode';
    setIcon(this.modeEl.createSpan('status-bar-item-icon'), icon);
    setTooltip(this.modeEl, v.getMode() === 'preview' ? t('view.reading-mode') : v.sourceMode ? t('view.source-mode') : t('view.live-preview'), { placement: 'top' });
  }

  updateCounts(view) {
    const v = view || this.app.workspace.activeLeaf?.view;
    if (!v || !v.getWordCount || this.app.settings.get('wordCount') === false) { this.countEl.hide(); return; }
    const c = v.getWordCount();
    this.countEl.show();
    this.countEl.setText(`${tn('status.words', c.words)} ${tn('status.chars', c.chars)}`);
  }

  updateBacklinks() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { this.backlinksEl.hide(); return; }
    let n = 0;
    const rl = this.app.metadataCache.resolvedLinks;
    for (const src in rl) if (rl[src][file.path] && src !== file.path) n++;
    this.backlinksEl.show();
    this.backlinksEl.setText(tn('status.backlinks', n));
  }

  setSkai(state, detail) {
    this.skaiEl.empty();
    if (this.app.settings.get('skaiEnabled') === false) { this.skaiEl.hide(); return; }
    this.skaiEl.show();
    const icon = this.skaiEl.createSpan('status-bar-item-icon');
    setIcon(icon, state === 'offline' ? 'wifi-off' : 'sparkles');
    this.skaiEl.createSpan({ text: t(`skai.status.${state}`) });
    this.skaiEl.toggleClass('is-offline', state === 'offline');
    this.skaiEl.toggleClass('is-busy', state === 'thinking');
    setTooltip(this.skaiEl, detail || t(`skai.status.${state}`), { placement: 'top' });
  }
}
