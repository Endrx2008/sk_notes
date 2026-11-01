// Settings modal: left list of sections, right pane of setting items.

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { getLanguage, t } from '../core/i18n.js';
import { hotkeyToString, keyOf, modifiersOf } from '../model/keymap.js';
import { AbstractInputSuggest, Modal, Setting, SearchComponent, confirmDialog } from './kit.js';

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createDiv('vertical-tab-content');
    this.id = plugin?.manifest?.id;
    this.name = plugin?.manifest?.name;
    this.icon = 'puzzle';
  }
  /** Tabs that declare getSettingDefinitions() (newer plugin API) are drawn from it; a tab
   * that defines display() itself overrides this (A2-1). */
  display() {
    if (typeof this.getSettingDefinitions !== 'function') return;
    this.update();
  }

  /** Draw the declared settings again (after state they depend on changed). */
  update() {
    if (typeof this.getSettingDefinitions !== 'function') return;
    const el = this.containerEl;
    el.empty();
    let defs = [];
    try { defs = this.getSettingDefinitions() || []; } catch (e) { console.error('getSettingDefinitions failed', e); }
    this._renderDefs(el, defs);
  }

  getControlValue(key) { return this.plugin?.settings?.[key]; }

  async setControlValue(key, value) {
    if (!this.plugin) return;
    this.plugin.settings = this.plugin.settings || {};
    this.plugin.settings[key] = value;
    await this.plugin.saveSettings?.();
  }

  _renderDefs(el, defs) {
    const on = (v) => (typeof v === 'function' ? v() : v) !== false;
    for (const def of defs) {
      if (!def || !on(def.visible)) continue;
      if (def.type === 'group' || def.type === 'list' || def.type === 'page') {
        if (def.type === 'page') { new Setting(el).setName(def.name).setDesc(def.desc || '').setHeading(); }
        else if (def.heading) new Setting(el).setName(def.heading).setHeading();
        const box = el.createDiv(def.cls || '');
        this._renderDefs(box, def.items || []);
        if (def.type === 'list' && def.addItem) {
          new Setting(box).setName(def.addItem.name).addButton((b) => b.setIcon?.('plus').onClick(() => def.addItem.action(b.buttonEl)));
        }
        continue;
      }
      const st = new Setting(el).setName(def.name || '').setDesc(def.desc || '');
      if (def.render) { def.render(st.controlEl, st); continue; }
      if (def.action) {
        const dis = typeof def.disabled === 'function' ? def.disabled() : def.disabled;
        st.addButton((b) => { b.setButtonText(def.buttonText || def.name || '›').setDisabled(!!dis).onClick(() => def.action(st.settingEl, 0)); });
        st.settingEl.addClass('mod-clickable');
        continue;
      }
      const c = def.control;
      if (!c) continue;
      const cur = () => {
        const v = this.getControlValue(c.key);
        return v === undefined ? c.defaultValue : v;
      };
      const set = async (v) => {
        if (c.validate) { const bad = await c.validate(v); if (typeof bad === 'string' && bad) { this.app.notice(bad); return; } }
        await this.setControlValue(c.key, v);
      };
      const dis = typeof def.disabled === 'function' ? def.disabled() : def.disabled;
      if (c.type === 'toggle') st.addToggle((x) => x.setValue(!!cur()).setDisabled(!!dis).onChange(set));
      else if (c.type === 'dropdown') st.addDropdown((x) => { x.addOptions(c.options || {}); x.setValue(String(cur() ?? '')); x.onChange(set); });
      else if (c.type === 'textarea') st.addTextArea((x) => x.setPlaceholder(c.placeholder || '').setValue(String(cur() ?? '')).onChange(set));
      else if (c.type === 'slider') st.addSlider((x) => x.setLimits(c.min, c.max, c.step).setValue(Number(cur() ?? c.min)).setDynamicTooltip().onChange(set));
      else if (c.type === 'color') st.addColorPicker((x) => x.setValue(String(cur() ?? '#000000')).onChange(set));
      else if (c.type === 'number') st.addText((x) => { x.inputEl.type = 'number'; if (c.min !== undefined) x.inputEl.min = c.min; if (c.max !== undefined) x.inputEl.max = c.max;
        x.setPlaceholder(c.placeholder || '').setValue(String(cur() ?? '')).onChange((v) => { if (v !== '' && !Number.isNaN(Number(v))) set(Number(v)); }); });
      else if (c.type === 'folder') st.addText((x) => { x.setPlaceholder(c.placeholder || '').setValue(String(cur() ?? '')).onChange(set); new FolderSuggest(this.app, x.inputEl).onSelect((v) => { x.setValue(v); set(v); }); });
      else st.addText((x) => { if (c.type === 'secret') x.inputEl.type = 'password'; x.setPlaceholder(c.placeholder || '').setValue(String(cur() ?? '')).onChange(set); });
    }
  }

  hide() {}
}
export class SettingTab extends PluginSettingTab {}

let current = null;

export function openSettings(app, tabId) {
  if (current) { current.openTabById(tabId || current.activeId); return current; }
  current = new SettingsModal(app);
  current.open();
  if (tabId) current.openTabById(tabId);
  return current;
}

class SettingsModal extends Modal {
  constructor(app) {
    super(app);
    this.modalEl.addClass('mod-settings', 'mod-sidebar-layout');
    this.modalEl.querySelector('.modal-header')?.detach();
    this.containerEl.addClass('mod-settings');
    this.navEl = this.contentEl.createDiv('vertical-tab-header');
    this.paneEl = this.contentEl.createDiv('vertical-tab-content-container');
    this.tabs = [];
    this.activeId = 'general';
    app.setting = this;
  }

  get pluginTabs() { return this.tabs.filter((x) => x.group === 'plugins'); }

  _builtinTabs() {
    const a = this.app;
    return [
      { id: 'general', name: t('settings.general'), icon: 'settings', group: 'options', render: (el) => this.general(el) },
      { id: 'editor', name: t('settings.editor'), icon: 'pencil', group: 'options', render: (el) => this.editor(el) },
      { id: 'files', name: t('settings.files'), icon: 'folder', group: 'options', render: (el) => this.files(el) },
      { id: 'appearance', name: t('settings.appearance'), icon: 'palette', group: 'options', render: (el) => this.appearance(el) },
      { id: 'hotkeys', name: t('settings.hotkeys'), icon: 'keyboard', group: 'options', render: (el) => this.hotkeys(el) },
      { id: 'core', name: t('settings.core'), icon: 'layers', group: 'options', render: (el) => this.core(el) },
      { id: 'skai', name: t('settings.skai'), icon: 'sparkles', group: 'options', render: (el) => a.skai?.renderSettings(el) || el.setText(t('skai.unavailable')) },
      { id: 'community-plugins', name: t('settings.community'), icon: 'puzzle', group: 'options', render: (el) => a.plugins?.renderSettings(el, this) },
    ];
  }

  onOpen() {
    this.tabs = this._builtinTabs();
    for (const tab of this.app.plugins?.settingTabs || []) this.tabs.push({ id: tab.id || tab.plugin?.manifest?.id, name: tab.name || tab.plugin?.manifest?.name, icon: tab.icon, group: 'plugins', tab });
    this.renderNav();
    this.openTabById(this.activeId);
  }

  onClose() {
    this._activeTab?.hide?.();
    current = null;
    this.app.setting = null;
  }

  renderNav() {
    this.navEl.empty();
    const groups = [['options', t('settings.options')], ['plugins', t('settings.plugin-options')]];
    for (const [g, label] of groups) {
      const list = this.tabs.filter((x) => x.group === g);
      if (!list.length) continue;
      const grp = this.navEl.createDiv('vertical-tab-header-group');
      grp.createDiv({ cls: 'vertical-tab-header-group-title', text: label });
      const items = grp.createDiv('vertical-tab-header-group-items');
      for (const tab of list) {
        const it = items.createDiv({ cls: 'vertical-tab-nav-item', attr: { 'data-id': tab.id } });
        const ic = it.createDiv('vertical-tab-nav-item-icon');
        setIcon(ic, tab.icon || 'puzzle');
        it.createSpan({ text: tab.name });
        it.addEventListener('click', () => this.openTabById(tab.id));
      }
    }
  }

  openTabById(id) {
    const tab = this.tabs.find((x) => x.id === id) || this.tabs[0];
    this._activeTab?.hide?.();
    this._activeTab = null;
    this.activeId = tab.id;
    this.navEl.findAll('.vertical-tab-nav-item').forEach((el) => el.toggleClass('is-active', el.getAttr('data-id') === tab.id));
    this.paneEl.empty();
    if (tab.tab) {
      this.paneEl.appendChild(tab.tab.containerEl);
      tab.tab.containerEl.empty();
      try { tab.tab.display(); } catch (e) { console.error('plugin settings failed', e); tab.tab.containerEl.setText(String(e)); }
      this._activeTab = tab.tab;
    } else {
      const el = this.paneEl.createDiv('vertical-tab-content');
      tab.render(el);
    }
  }

  openTab(tab) { this.openTabById(tab.id || tab.plugin?.manifest?.id); }

  addSettingTab(tab) {
    this.tabs.push({ id: tab.id || tab.plugin?.manifest?.id, name: tab.name || tab.plugin?.manifest?.name, icon: tab.icon, group: 'plugins', tab });
    this.renderNav();
  }

  removeSettingTab(tab) {
    this.tabs = this.tabs.filter((x) => x.tab !== tab);
    this.renderNav();
  }

  // ---------------------------------------------------------------- helpers
  toggle(el, key, name, desc) {
    return new Setting(el).setName(name).setDesc(desc || '').addToggle((tg) => tg.setValue(!!this.app.settings.get(key))
      .onChange((v) => this.app.settings.set(key, v)));
  }

  dropdown(el, key, name, desc, options) {
    return new Setting(el).setName(name).setDesc(desc || '').addDropdown((d) => d.addOptions(options).setValue(String(this.app.settings.get(key))).onChange((v) => this.app.settings.set(key, v)));
  }

  text(el, key, name, desc, placeholder) {
    return new Setting(el).setName(name).setDesc(desc || '').addText((x) => x.setPlaceholder(placeholder || '').setValue(this.app.settings.get(key) || '').onChange((v) => this.app.settings.set(key, v)));
  }

  /** Text setting holding a vault folder, with folder suggestions (A-21). */
  folder(el, key, name, desc, placeholder) {
    return new Setting(el).setName(name).setDesc(desc || '').addText((x) => {
      x.setPlaceholder(placeholder || '').setValue(this.app.settings.get(key) || '').onChange((v) => this.app.settings.set(key, v));
      new FolderSuggest(this.app, x.inputEl).onSelect((v) => { x.setValue(v); this.app.settings.set(key, v); });
    });
  }

  heading(el, text) { new Setting(el).setName(text).setHeading(); }

  // ---------------------------------------------------------------- sections
  async general(el) {
    const a = this.app;
    el.createDiv({ cls: 'setting-item-heading-app', text: `sk_notes ${a.info.version}` });
    const langs = {};
    langs[''] = t('settings.language-auto');
    for (const l of a.info.languages) langs[l.code] = l.name + (l.review ? ` (${t('settings.needs-review')})` : '');
    new Setting(el).setName(t('settings.language')).setDesc(t('settings.language-desc')).addDropdown((d) => d.addOptions(langs).setValue(a.info.languageSetting ?? '').onChange(async (v) => {
      await call('app.setLanguage', { language: v });
      a.info.languageSetting = v;
      const ok = await confirmDialog(a, { title: t('settings.language'), message: t('settings.relaunch-needed'), confirm: t('settings.relaunch') });
      if (ok) { await a.flush(); call('app.relaunch'); }
    }));
    new Setting(el).setName(t('settings.vaults')).setDesc(t('settings.vaults-desc')).addButton((b) => b.setButtonText(t('settings.manage')).onClick(() => a.commands.executeCommandById('app:open-vault')));
    new Setting(el).setName(t('settings.config-folder')).setDesc(t('settings.config-folder-desc')).addButton((b) => b.setButtonText(t('settings.open')).onClick(() => call('config.openFolder', {})));
    this.heading(el, t('settings.about'));
    el.createEl('p', { cls: 'setting-item-description', text: t('settings.about-text') });
  }

  editor(el) {
    const s = this.app.settings;
    this.heading(el, t('settings.editor.display'));
    this.dropdown(el, 'defaultViewMode', t('settings.default-view'), t('settings.default-view-desc'), { source: t('view.edit-mode'), preview: t('view.reading-mode') });
    new Setting(el).setName(t('settings.default-editing')).setDesc(t('settings.default-editing-desc')).addDropdown((d) => d
      .addOptions({ live: t('view.live-preview'), source: t('view.source-mode') }).setValue(s.get('livePreview') === false ? 'source' : 'live')
      .onChange((v) => s.set('livePreview', v === 'live')));
    this.toggle(el, 'readableLineLength', t('settings.readable'), t('settings.readable-desc'));
    this.toggle(el, 'showInlineTitle', t('settings.inline-title'), t('settings.inline-title-desc'));
    this.toggle(el, 'lineWrap', t('settings.wrap'), t('settings.wrap-desc'));
    this.dropdown(el, 'propertiesInDocument', t('settings.properties'), t('settings.properties-desc'), { visible: t('settings.visible'), hidden: t('settings.hidden'), source: t('settings.as-source') });
    this.heading(el, t('settings.editor.behaviour'));
    this.toggle(el, 'spellcheck', t('settings.spellcheck'), t('settings.spellcheck-desc'));
    this.toggle(el, 'autoPair', t('settings.autopair'), t('settings.autopair-desc'));
    this.toggle(el, 'foldGutter', t('settings.fold'), t('settings.fold-desc'));
    this.toggle(el, 'slashCommands', t('settings.slash'), t('settings.slash-desc'));
    new Setting(el).setName(t('settings.tab-size')).addSlider((sl) => sl.setLimits(2, 8, 1).setValue(s.get('tabSize') || 4).setDynamicTooltip().onChange((v) => s.set('tabSize', v)));
  }

  files(el) {
    const a = this.app;
    this.dropdown(el, 'newFileLocation', t('settings.new-file-location'), t('settings.new-file-location-desc'), { root: t('settings.vault-root'), current: t('settings.same-folder'), folder: t('settings.in-folder') });
    this.folder(el, 'newFileFolderPath', t('settings.new-file-folder'), t('settings.new-file-folder-desc'), 'Inbox');
    this.folder(el, 'attachmentFolderPath', t('settings.attachments'), t('settings.attachments-desc'), '/');
    this.toggle(el, 'alwaysUpdateLinks', t('settings.update-links'), t('settings.update-links-desc'));
    this.toggle(el, 'useMarkdownLinks', t('settings.md-links'), t('settings.md-links-desc'));
    this.dropdown(el, 'trashOption', t('settings.deleted-files'), t('settings.deleted-files-desc'), { system: t('settings.trash-system'), local: t('settings.trash-local'), none: t('settings.trash-none') });
    this.toggle(el, 'promptDelete', t('settings.confirm-delete'), t('settings.confirm-delete-desc'));
    this.heading(el, t('settings.import'));
    new Setting(el).setName(t('settings.import-notes')).setDesc(t('settings.import-notes-desc')).addButton((b) => b.setButtonText(t('settings.import-open')).onClick(() => { this.close(); a.commands.executeCommandById('importer:open'); }));
    new Setting(el).setName(t('settings.migrate')).setDesc(t('settings.migrate-desc')).addButton((b) => b.setButtonText(t('settings.migrate-open')).onClick(() => { this.close(); a.commands.executeCommandById('migration:open'); }));
  }

  async appearance(el) {
    const a = this.app;
    const s = a.settings;
    this.dropdown(el, 'theme', t('settings.base-theme'), t('settings.base-theme-desc'), { skai: t('settings.theme-skai'), dark: t('settings.theme-dark'), light: t('settings.theme-light') });
    new Setting(el).setName(t('settings.font-size')).setDesc(t('settings.font-size-desc')).addSlider((sl) => sl.setLimits(10, 30, 1).setValue(s.get('baseFontSize') || 16).setDynamicTooltip().onChange((v) => s.set('baseFontSize', v)));
    this.text(el, 'textFont', t('settings.text-font'), t('settings.text-font-desc'), 'Inter, sans-serif');
    this.text(el, 'monospaceFont', t('settings.mono-font'), '', 'JetBrains Mono');
    this.toggle(el, 'showRibbon', t('settings.show-ribbon'), t('settings.show-ribbon-desc'));
    new Setting(el).setName(t('settings.zoom')).setDesc(t('settings.zoom-desc')).addSlider((sl) => sl.setLimits(50, 200, 10).setValue(Math.round((a.info.zoom || 1) * 100)).setDynamicTooltip().onChange((v) => a.changeZoom(v / 100 - (a.info.zoom || 1))));
    this.heading(el, t('settings.themes'));
    const themes = await call('config.list', { kind: 'themes' }).catch(() => []);
    const opts = { '': t('settings.theme-none') };
    for (const th of themes) opts[th] = th;
    new Setting(el).setName(t('settings.community-theme')).setDesc(t('settings.community-theme-desc')).addDropdown((d) => d.addOptions(opts).setValue(s.get('cssTheme') || '').onChange((v) => s.set('cssTheme', v)))
      .addExtraButton((b) => b.setIcon('folder-open').setTooltip(t('settings.open-folder')).onClick(() => call('config.openFolder', { sub: 'themes' })));
    this.heading(el, t('settings.snippets'));
    const snippets = await call('config.list', { kind: 'snippets' }).catch(() => []);
    new Setting(el).setName(t('settings.snippets-folder')).setDesc(t('settings.snippets-desc'))
      .addExtraButton((b) => b.setIcon('refresh').setTooltip(t('settings.reload')).onClick(() => { a.loadCss?.(); this.openTabById('appearance'); }))
      .addExtraButton((b) => b.setIcon('folder-open').setTooltip(t('settings.open-folder')).onClick(() => call('config.openFolder', { sub: 'snippets' })));
    for (const sn of snippets) {
      new Setting(el).setName(sn.replace(/\.css$/, '')).addToggle((tg) => tg.setValue((s.get('enabledCssSnippets') || []).includes(sn)).onChange((v) => {
        const list = new Set(s.get('enabledCssSnippets') || []);
        if (v) list.add(sn); else list.delete(sn);
        s.set('enabledCssSnippets', [...list]);
      }));
    }
  }

  hotkeys(el) {
    const a = this.app;
    const search = new SearchComponent(el).setPlaceholder(t('settings.hotkeys-filter'));
    let onlyCustom = false;
    const filterBtn = el.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': t('settings.hotkeys-only-assigned') } });
    setIcon(filterBtn, 'filter');
    filterBtn.addEventListener('click', () => { onlyCustom = !onlyCustom; filterBtn.toggleClass('is-active', onlyCustom); render(); });
    const list = el.createDiv('hotkey-list-container');
    const render = () => {
      list.empty();
      const q = search.getValue().toLowerCase();
      const cmds = a.commands.allCommands().filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(q))
        .filter((c) => !onlyCustom || a.commands.hotkeysFor(c.id).length).sort((x, y) => x.name.localeCompare(y.name));
      for (const c of cmds) {
        const st = new Setting(list).setName(c.name);
        const box = st.controlEl.createDiv('setting-command-hotkeys');
        for (const hk of a.commands.hotkeysFor(c.id)) {
          const chip = box.createSpan({ cls: 'setting-hotkey', text: hotkeyToString(hk) });
          const x = chip.createSpan('setting-hotkey-icon setting-delete-hotkey');
          setIcon(x, 'x');
          x.addEventListener('click', () => {
            const rest = a.commands.hotkeysFor(c.id).filter((h) => h !== hk);
            a.commands.setHotkeys(c.id, rest);
            render();
          });
        }
        if (a.commands.customHotkeys[c.id]) {
          st.addExtraButton((b) => b.setIcon('undo').setTooltip(t('settings.hotkeys-reset')).onClick(() => { a.commands.setHotkeys(c.id, null); render(); }));
        }
        st.addExtraButton((b) => b.setIcon('plus').setTooltip(t('settings.hotkeys-add')).onClick(() => {
          const chip = box.createSpan({ cls: 'setting-hotkey mod-active', text: t('settings.hotkeys-press') });
          const onKey = (e) => {
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            document.removeEventListener('keydown', onKey, true);
            if (e.key === 'Escape') { chip.detach(); return; }
            const hk = { modifiers: modifiersOf(e), key: keyOf(e) };
            const clash = a.commands.conflicts(hk, c.id);
            a.commands.setHotkeys(c.id, [...a.commands.hotkeysFor(c.id), hk]);
            if (clash.length) a.notice(t('settings.hotkeys-conflict', { names: clash.map((id) => a.commands.findCommand(id)?.name || id).join(', ') }));
            render();
          };
          document.addEventListener('keydown', onKey, true);
        }));
      }
    };
    search.onChange(render);
    render();
  }

  core(el) {
    this.heading(el, t('settings.daily'));
    this.folder(el, 'dailyNoteFolder', t('settings.daily-folder'), t('settings.daily-folder-desc'), 'Journal');
    this.text(el, 'dailyNoteFormat', t('settings.daily-format'), t('settings.daily-format-desc'), 'YYYY-MM-DD');
    this.text(el, 'dailyNoteTemplate', t('settings.daily-template'), t('settings.daily-template-desc'), 'Templates/Daily');
    this.heading(el, t('settings.templates'));
    this.folder(el, 'templatesFolder', t('settings.templates-folder'), t('settings.templates-folder-desc'), 'Templates');
    this.text(el, 'templateDateFormat', t('settings.template-date'), '', 'YYYY-MM-DD');
    this.text(el, 'templateTimeFormat', t('settings.template-time'), '', 'HH:mm');
    this.heading(el, t('settings.unique'));
    this.text(el, 'uniqueNotePrefix', t('settings.unique-format'), '', 'YYYYMMDDHHmm');
    this.folder(el, 'uniqueNoteFolder', t('settings.unique-folder'), '', '');
    this.heading(el, t('settings.status-bar'));
    new Setting(el).setName(t('settings.word-count')).setDesc(t('settings.word-count-desc')).addToggle((tg) => tg
      .setValue(this.app.settings.get('wordCount') !== false)
      .onChange((v) => { this.app.settings.set('wordCount', v); this.app.statusBar?.updateCounts(this.app.workspace.activeLeaf?.view); }));
    this.heading(el, t('settings.preview'));
    this.toggle(el, 'pagePreviewRequireMod', t('settings.preview-mod'), t('settings.preview-mod-desc'));
    this.heading(el, t('settings.sync-publish'));
    new Setting(el).setName(t('settings.git')).setDesc(t('settings.git-desc')).addButton((b) => b.setButtonText(t('settings.open')).onClick(() => { this.close(); this.app.commands.executeCommandById('sync:open'); }));
    new Setting(el).setName(t('settings.publish')).setDesc(t('settings.publish-desc')).addButton((b) => b.setButtonText(t('settings.open')).onClick(() => { this.close(); this.app.commands.executeCommandById('publish:open'); }));
    void getLanguage;
  }
}

class FolderSuggest extends AbstractInputSuggest {
  getSuggestions(q) {
    const low = q.toLowerCase();
    return this.app.vault.getAllFolders(false).map((f) => f.path).filter((p) => p.toLowerCase().includes(low) && p !== q)
      .sort((a, b) => a.localeCompare(b)).slice(0, 50);
  }
  renderSuggestion(v, el) { el.setText(v); }
}
