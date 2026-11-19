// The database of the vault (desktop): a way of looking at all the notes as a table, cards,
// a list or a board, without making a .base file. Its views, filters and columns are kept in
// .sk_notes/vault-base.json (the settings of the vault), like the layout of the graph.
// Notes are made as always (Home, Ctrl+N); this only looks at them.

import { t } from '../core/i18n.js';
import { debounce } from '../core/util.js';
import { ButtonComponent, Modal } from '../ui/kit.js';
import { BasesView } from '../views/bases.js';

export const VAULT_BASE = 'vault-base';
const CONFIG = 'vault-base.json';

function defaultText() {
  return [
    'filters:',
    '  and:',
    '    - file.ext == "md"',
    'views:',
    '  - type: table',
    `    name: ${JSON.stringify(t('pc.home.all-notes'))}`,
    '    order:',
    '      - file.name',
    '      - file.folder',
    '      - file.mtime',
    '      - file.tags',
    '  - type: cards',
    `    name: ${JSON.stringify(t('bases.cards'))}`,
    '',
  ].join('\n');
}

export class VaultBaseView extends BasesView {
  constructor(leaf) {
    super(leaf);
    this.allowNoFile = true;
    this.navigation = true;
    this.contentEl.addClass('pc-vault-base');
    this._store = debounce(() => this.app.config.write(CONFIG, { text: this._text || '' }).catch(() => {}), 600, true);
  }

  getViewType() { return VAULT_BASE; }
  getDisplayText() { return t('pc.home.database'); }
  getIcon() { return 'database'; }
  getState() { return {}; }
  async setState() {}

  async onOpen() {
    await super.onOpen();
    const saved = await this.app.config.read(CONFIG).catch(() => null);
    this.setViewData(typeof saved?.text === 'string' && saved.text.trim() ? saved.text : defaultText());
    this.updateTitle();
  }

  // the configuration lives in the vault's settings, not in a file
  requestSave() { this._store(); }
  async save() { this._store(); }

  onPaneMenu(menu, source) {
    menu.addItem((i) => i.setTitle(t('bases.edit-yaml')).setIcon('code').onClick(() => {
      const m = new Modal(this.app);
      m.setTitle(t('pc.home.database'));
      const ta = m.contentEl.createEl('textarea', { cls: 'bases-yaml-editor', value: this._text || '' });
      const row = m.contentEl.createDiv('modal-button-container');
      new ButtonComponent(row).setButtonText(t('common.ok')).setCta().onClick(() => { this.setViewData(ta.value); this.requestSave(); m.close(); });
      new ButtonComponent(row).setButtonText(t('pc.home.database-reset')).onClick(() => { this.setViewData(defaultText()); this.requestSave(); m.close(); });
      m.open();
    }));
  }
}
