// Vault-level settings (.sk_notes/app.json + appearance.json) with defaults.

import { call } from '../core/api.js';
import { Events } from '../core/events.js';
import { debounce } from '../core/util.js';

export const DEFAULTS = {
  // editor
  livePreview: true,
  defaultViewMode: 'source',
  readableLineLength: true,
  showInlineTitle: true,
  spellcheck: false,
  lineWrap: true,
  foldGutter: true,
  autoPair: true,
  tabSize: 4,
  propertiesInDocument: 'visible',
  slashCommands: true,
  // files & links
  alwaysUpdateLinks: true,
  newFileLocation: 'root',
  newFileFolderPath: '',
  attachmentFolderPath: '/',
  useMarkdownLinks: false,
  trashOption: 'system',
  promptDelete: true,
  // appearance
  theme: 'skai',
  baseFontSize: 16,
  textFont: '',
  monospaceFont: '',
  showRibbon: true,
  enabledCssSnippets: [],
  cssTheme: '',
  // core features
  dailyNoteFolder: '',
  dailyNoteFormat: 'YYYY-MM-DD',
  dailyNoteTemplate: '',
  templatesFolder: '',
  templateDateFormat: 'YYYY-MM-DD',
  templateTimeFormat: 'HH:mm',
  uniqueNotePrefix: 'YYYYMMDDHHmm',
  uniqueNoteFolder: '',
  pagePreviewRequireMod: true,
  fileExplorerSort: 'alphabetical',
  // SKAI
  skaiEnabled: true,
  skaiMemory: false,
  // plugins
  restrictedMode: true,
};

const APPEARANCE_KEYS = new Set(['theme', 'baseFontSize', 'textFont', 'monospaceFont', 'showRibbon', 'enabledCssSnippets', 'cssTheme']);

export class Settings extends Events {
  constructor() {
    super();
    this.values = { ...DEFAULTS };
    this._saveApp = debounce(() => this._write('app.json', false), 400, true);
    this._saveAppearance = debounce(() => this._write('appearance.json', true), 400, true);
  }

  async load() {
    const [app, appearance] = await Promise.all([
      call('config.read', { name: 'app.json' }).catch(() => null),
      call('config.read', { name: 'appearance.json' }).catch(() => null),
    ]);
    Object.assign(this.values, app || {}, appearance || {});
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    if (APPEARANCE_KEYS.has(key)) this._saveAppearance(); else this._saveApp();
    this.trigger('change', key, value);
  }

  _write(name, appearance) {
    const out = {};
    for (const [k, v] of Object.entries(this.values)) {
      if (APPEARANCE_KEYS.has(k) !== appearance) continue;
      if (JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])) out[k] = v;
    }
    return call('config.write', { name, data: out }).catch((e) => console.error('settings save failed', e));
  }
}
