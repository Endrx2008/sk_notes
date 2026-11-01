// Plugin base class (shared by community plugins and sk_notes' native API).

import { call } from '../core/api.js';
import { t } from '../core/i18n.js';
import { Component } from '../model/component.js';

export class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this._ribbon = [];
    this._statusItems = [];
    this._commands = [];
    this._views = [];
    this._extensions = [];
    this._settingTabs = [];
    this._processors = [];
    this._codeBlocks = [];
    this._editorExtensions = [];
    this._suggests = [];
    this._protocol = [];
    this._hoverSources = [];
  }

  async onload() {}
  onunload() {}
  onUserEnable() {}
  onExternalSettingsChange() {}

  load() {
    // Component.load calls onload synchronously; plugins return a promise from onload
    if (this._loaded) return this._loadPromise;
    this._loaded = true;
    try {
      const r = this.onload();
      this._loadPromise = Promise.resolve(r);
    } catch (e) {
      this._loadPromise = Promise.reject(e);
    }
    for (const c of this._children.slice()) c.load();
    return this._loadPromise;
  }

  unload() {
    for (const el of this._ribbon) el.detach();
    for (const el of this._statusItems) el.detach();
    for (const id of this._commands) this.app.commands.removeCommand(id);
    for (const type of this._views) {
      this.app.workspace.detachLeavesOfType(type);
      this.app.viewRegistry.unregisterView(type);
    }
    if (this._extensions.length) this.app.viewRegistry.unregisterExtensions(this._extensions);
    for (const tab of this._settingTabs) {
      this.app.plugins.settingTabs.remove(tab);
      this.app.setting?.removeSettingTab(tab);
    }
    for (const fn of this._processors) this.app.markdownProcessors.remove(fn);
    for (const lang of this._codeBlocks) this.app.markdownProcessors.codeBlocks.delete(lang);
    for (const ext of this._editorExtensions) this.app.editorExtensions.remove(ext);
    if (this._editorExtensions.length) this.app.updateEditorExtensions();
    for (const s of this._suggests) { this.app.editorSuggests.remove(s); s.close?.(); }
    for (const p of this._protocol) delete this.app.protocolHandlers?.[p];
    super.unload();
  }

  async loadData() {
    return call('config.read', { name: `plugins/${this.manifest.id}/data.json` });
  }

  async saveData(data) {
    await call('config.write', { name: `plugins/${this.manifest.id}/data.json`, data });
  }

  addRibbonIcon(icon, title, callback) {
    const el = this.app.workspace.leftRibbon.addRibbonItemButton(`${this.manifest.id}:${title}`, icon, title, callback);
    this._ribbon.push(el);
    return el;
  }

  addStatusBarItem() {
    const el = this.app.statusBar.addStatusBarItem();
    el.addClass(`plugin-${this.manifest.id.replace(/[^a-z0-9-]/gi, '-')}`);
    this._statusItems.push(el);
    return el;
  }

  addCommand(cmd) {
    const id = `${this.manifest.id}:${cmd.id}`;
    const full = { ...cmd, id, name: `${this.manifest.name}: ${cmd.name}` };
    this.app.commands.addCommand(full);
    this._commands.push(id);
    return full;
  }

  removeCommand(id) {
    const full = `${this.manifest.id}:${id}`;
    this.app.commands.removeCommand(full);
    this._commands.remove(full);
  }

  addSettingTab(tab) {
    tab.id ||= this.manifest.id;
    tab.name ||= this.manifest.name;
    this.app.plugins.settingTabs.push(tab);
    this._settingTabs.push(tab);
    this.app.setting?.addSettingTab(tab);
  }

  registerView(type, creator) {
    this.app.viewRegistry.registerView(type, creator);
    this._views.push(type);
  }

  registerExtensions(exts, type) {
    this.app.viewRegistry.registerExtensions(exts, type);
    this._extensions.push(...exts);
  }

  registerHoverLinkSource(id, info) { this._hoverSources.push(id); void info; }

  registerMarkdownPostProcessor(fn, sortOrder) {
    this.app.markdownProcessors.add(fn, sortOrder);
    this._processors.push(fn);
    return fn;
  }

  registerMarkdownCodeBlockProcessor(lang, handler, sortOrder) {
    this.app.markdownProcessors.codeBlocks.set(lang, handler);
    this._codeBlocks.push(lang);
    void sortOrder;
    return handler;
  }

  registerEditorExtension(ext) {
    this.app.editorExtensions.push(ext);
    this._editorExtensions.push(ext);
    this.app.updateEditorExtensions();
  }

  registerEditorSuggest(suggest) {
    this.app.editorSuggests.push(suggest);
    this._suggests.push(suggest);
  }

  registerObsidianProtocolHandler(action, handler) {
    this.app.protocolHandlers ||= {};
    this.app.protocolHandlers[action] = handler;
    this._protocol.push(action);
  }

  registerCliHandler() {}
  registerBasesView() { return false; }
}

export function notifyPluginError(app, manifest, e) {
  console.error(`plugin ${manifest.id} failed`, e);
  app.notice(t('plugins.error', { name: manifest.name || manifest.id, error: e?.message || String(e) }), 8000);
}
