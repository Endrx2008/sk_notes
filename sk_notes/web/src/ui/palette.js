// Command palette (Ctrl+P) and quick switcher (Ctrl+O).

import { t } from '../core/i18n.js';
import { hotkeyToString } from '../model/keymap.js';
import { TFile } from '../model/vault.js';
import { prepareFuzzySearch, renderMatches, SuggestModal } from './kit.js';

export class CommandPalette extends SuggestModal {
  constructor(app) {
    super(app);
    this.setPlaceholder(t('palette.placeholder'));
    this.setInstructions([
      { command: '↑↓', purpose: t('palette.navigate') },
      { command: '↵', purpose: t('palette.run') },
      { command: 'esc', purpose: t('palette.dismiss') },
    ]);
    this.modalEl.addClass('mod-command-palette');
  }

  getSuggestions(query) {
    const cmds = this.app.commands.listCommands();
    const pinned = this.app.settings.get('pinnedCommands') || [];
    const recent = this.app.commands.recent;
    if (!query) {
      const rank = (c) => (pinned.includes(c.id) ? -1000 + pinned.indexOf(c.id) : recent.includes(c.id) ? -500 + recent.indexOf(c.id) : 0);
      return cmds.map((c) => ({ cmd: c, match: null })).sort((a, b) => rank(a.cmd) - rank(b.cmd) || a.cmd.name.localeCompare(b.cmd.name));
    }
    const fz = prepareFuzzySearch(query);
    const out = [];
    for (const c of cmds) {
      const m = fz(c.name);
      if (m) out.push({ cmd: c, match: m });
    }
    out.sort((a, b) => b.match.score - a.match.score);
    return out;
  }

  renderSuggestion({ cmd, match }, el) {
    el.addClass('mod-complex');
    const content = el.createDiv('suggestion-content');
    renderMatches(content.createDiv('suggestion-title'), cmd.name, match?.matches);
    const aux = el.createDiv('suggestion-aux');
    for (const hk of this.app.commands.hotkeysFor(cmd.id)) aux.createEl('kbd', { cls: 'suggestion-hotkey', text: hotkeyToString(hk) });
  }

  onChooseSuggestion({ cmd }) {
    this.app.commands.executeCommand(cmd);
  }
}

export class QuickSwitcher extends SuggestModal {
  constructor(app, opts = {}) {
    super(app);
    this.opts = opts;
    this.setPlaceholder(t('switcher.placeholder'));
    this.setInstructions([
      { command: '↑↓', purpose: t('palette.navigate') },
      { command: '↵', purpose: t('switcher.open') },
      { command: 'ctrl ↵', purpose: t('switcher.open-tab') },
      { command: 'shift ↵', purpose: t('switcher.create') },
      { command: 'esc', purpose: t('palette.dismiss') },
    ]);
    this.modalEl.addClass('mod-quick-switcher');
    this.emptyStateText = t('switcher.no-match');
    this.scope.register(['Shift'], 'Enter', () => { this._create(); return false; });
    this.scope.register(['Mod'], 'Enter', (e) => { this.chooser.useSelectedItem(e); return false; });
    this.scope.register(['Mod', 'Alt'], 'Enter', (e) => { this.chooser.useSelectedItem(e); return false; });
  }

  getSuggestions(query) {
    const recent = this.app.workspace.getLastOpenFiles();
    const files = this.app.vault.getFiles().filter((f) => this.opts.all || ['md', 'canvas', 'base', 'pdf'].includes(f.extension) || !this.opts.mdOnly);
    if (!query) {
      const rec = recent.map((p) => this.app.vault.getFileByPath(p)).filter(Boolean);
      const rest = this.opts.recentOnly ? [] : files.filter((f) => !recent.includes(f.path)).sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 50);
      return [...rec, ...rest].map((f) => ({ file: f, match: null }));
    }
    const fz = prepareFuzzySearch(query);
    const out = [];
    for (const f of files) {
      const name = f.extension === 'md' ? f.basename : f.name;
      let m = fz(name);
      let alias = null;
      if (!m) {
        const pm = fz(f.path);
        if (pm) m = { score: pm.score - 1, matches: null };
      }
      const aliases = this.app.metadataCache.getFileCache(f)?.frontmatter?.aliases;
      for (const a of Array.isArray(aliases) ? aliases : typeof aliases === 'string' ? [aliases] : []) {
        const am = fz(String(a));
        if (am && (!m || am.score > m.score)) { m = am; alias = String(a); }
      }
      if (m) {
        if (recent.includes(f.path)) m.score += 0.5;
        out.push({ file: f, match: m, alias });
      }
    }
    out.sort((a, b) => b.match.score - a.match.score);
    if (!this.app.metadataCache.getFirstLinkpathDest(query.trim(), '')) out.push({ create: query.trim() });
    return out;
  }

  renderSuggestion(item, el) {
    el.addClass('mod-complex');
    const content = el.createDiv('suggestion-content');
    if (item.create) {
      content.createDiv({ cls: 'suggestion-title', text: item.create });
      el.createDiv('suggestion-aux').createEl('kbd', { cls: 'suggestion-hotkey', text: t('switcher.enter-create') });
      return;
    }
    const f = item.file;
    const title = content.createDiv('suggestion-title');
    if (item.alias) {
      renderMatches(title, item.alias, item.match?.matches);
      content.createDiv({ cls: 'suggestion-note', text: f.path });
    } else {
      renderMatches(title, f.extension === 'md' ? f.basename : f.name, item.match?.matches);
      if (f.parent && f.parent.path !== '/') content.createDiv({ cls: 'suggestion-note', text: f.parent.path });
    }
    if (f.extension !== 'md') el.createDiv('suggestion-aux').createSpan({ cls: 'suggestion-flair nav-file-tag', text: f.extension.toUpperCase() });
  }

  async _create() {
    const name = this.inputEl.value.trim();
    if (!name) return;
    this.close();
    const f = await this.app.fileManager.createNewMarkdownFileFromLinktext(name, this.app.workspace.getActiveFile()?.path || '');
    if (f) this.app.workspace.openFile(f, false);
  }

  async onChooseSuggestion(item, evt) {
    if (item.create) {
      const f = await this.app.fileManager.createNewMarkdownFileFromLinktext(item.create, this.app.workspace.getActiveFile()?.path || '');
      if (f) this.app.workspace.openFile(f, false);
      return;
    }
    if (this.opts.onChoose) { this.opts.onChoose(item.file); return; }
    const mod = evt && (evt.ctrlKey || evt.metaKey);
    const newLeaf = mod && evt.altKey ? 'split' : mod ? 'tab' : false;
    if (item.file instanceof TFile) this.app.workspace.openFile(item.file, newLeaf);
  }
}
