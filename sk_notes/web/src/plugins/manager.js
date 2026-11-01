// Community plugin manager: loading with a per-plugin require(), restricted mode,
// enable/disable, install from a folder or a GitHub release, permissions UI.

import * as cmAutocomplete from '@codemirror/autocomplete';
import * as cmCommands from '@codemirror/commands';
import * as cmLanguage from '@codemirror/language';
import * as cmSearch from '@codemirror/search';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as lezerCommon from '@lezer/common';
import * as lezerHighlight from '@lezer/highlight';
import * as lezerMarkdown from '@lezer/markdown';
import * as lezerLr from '@lezer/lr';
import * as cmLint from '@codemirror/lint';
import * as cmLangMarkdown from '@codemirror/lang-markdown';
import moment from 'moment';
import { call, takeBootSecret } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { getLanguage, t } from '../core/i18n.js';
import { Buffer, nodeModules, process as nodeProcess } from '../compat/node.js';
import { notifyPluginError } from '../compat/plugin.js';
import { installInternals } from '../compat/internals.js';
import { installNativeApi, makeNativeApi } from './native.js';
import { ButtonComponent, Modal, Setting, confirmDialog, promptDialog } from '../ui/kit.js';

// Caller tokens (see app/callers.py): kept in this module's private variables and
// handed only to each plugin's own shims, never to the manager object plugins can reach.
const tokens = new Map();
let pageKey = null;
let exchange = null;

function ensureTokens() {
  exchange ||= (async () => {
    const boot = takeBootSecret();
    if (!boot) return; // pages opened by window.open(): plugins run without identity
    try {
      const r = await call('plugins.tokens', { boot });
      pageKey = r.key;
      for (const [id, tok] of Object.entries(r.tokens)) tokens.set(id, tok);
    } catch (e) { console.error('plugin tokens', e); }
  })();
  return exchange;
}

async function tokenFor(id) {
  await ensureTokens();
  if (!tokens.has(id) && pageKey) {
    try { tokens.set(id, await call('plugins.token', { key: pageKey, id })); } catch (e) { console.warn('plugin without identity', id, e); }
  }
  return tokens.get(id) || null;
}

function makeRequire(mgr, token) {
  const node = nodeModules(token);
  return async () => {
    const O = await obsidianModule(mgr);
    const obs = Object.assign({}, O, { requestUrl: O.makeRequestUrl(token), request: O.makeRequest(token) });
    let native = null;
    const req = (name) => {
      if (name === 'obsidian') return obs;
      if (name === 'sknotes') return (native ||= makeNativeApi(mgr.app, token));
      if (SHARED[name]) return SHARED[name];
      const clean = name.replace(/^node:/, '');
      if (node[clean] !== undefined) return node[clean];
      if (clean.startsWith('buffer')) return node.buffer;
      throw new Error(t('plugins.missing-module', { name }));
    };
    req.resolve = (n) => n;
    return req;
  };
}

let compatModule = null;
async function obsidianModule(mgr) {
  if (!compatModule) compatModule = await import('../compat/obsidian.js');
  mgr.compat = compatModule;
  return compatModule;
}

const LOAD_TIMEOUT = 15000;

const SHARED = {
  '@codemirror/state': cmState, '@codemirror/view': cmView, '@codemirror/language': cmLanguage, '@codemirror/commands': cmCommands,
  '@codemirror/search': cmSearch, '@codemirror/autocomplete': cmAutocomplete, '@codemirror/lang-markdown': cmLangMarkdown,
  '@codemirror/lint': cmLint, '@lezer/lr': lezerLr, '@lezer/common': lezerCommon, '@lezer/highlight': lezerHighlight, '@lezer/markdown': lezerMarkdown, moment,
};

const PERMS = ['fs-outside-vault', 'exec', 'network', 'open-external', 'clipboard'];

export function installPluginManager(app) {
  const mgr = new PluginManager(app);
  app.plugins = mgr;
  window.global = window;
  window.Buffer ||= Buffer;
  window.process ||= nodeProcess;
  // The page is not cross-origin isolated, so Chromium hides SharedArrayBuffer; bundled libraries
  // only test for it, so a non-shared stand-in is enough.
  if (typeof window.SharedArrayBuffer === 'undefined') window.SharedArrayBuffer = class SharedArrayBuffer extends ArrayBuffer {};
  // legacy editor globals some plugins touch even when they do not need them
  // (any unknown member is a harmless function, so mode definitions written for it load)
  const noop = function noop() { return undefined; };
  // CodeMirror 5 modes (Templater…): a working registry, so a mode built from them always
  // has a token() function (an empty one crashed every parse of the editor, A-8)
  const plainMode = (name) => ({ name, token(stream) { stream.skipToEnd(); return null; } });
  const cm5 = { modes: {}, mimeModes: {}, commands: {}, keyMap: {}, Pass: {}, helpers: {},
    StringStream: class StringStream { constructor(s) { this.string = s || ''; this.pos = 0; } },
    defineMode(name, factory) { cm5.modes[name] = factory; },
    defineMIME(mime, spec) { cm5.mimeModes[mime] = spec; },
    getMode(config, spec) {
      const name = typeof spec === 'string' ? (cm5.mimeModes[spec]?.name || cm5.mimeModes[spec] || spec) : spec?.name;
      const factory = cm5.modes[name];
      if (typeof factory === 'function') {
        try { const m = factory(config || {}, typeof spec === 'object' ? spec : {}); if (m && typeof m.token === 'function') return m; } catch (e) { console.warn('CodeMirror mode', name, e); }
      }
      return plainMode(name || 'null');
    },
    overlayMode(base, overlay) {
      return {
        name: overlay?.name || base?.name,
        startState: () => ({ base: base?.startState?.() ?? {}, overlay: overlay?.startState?.() ?? {} }),
        copyState: (st) => ({ base: base?.copyState ? base.copyState(st.base) : { ...st.base }, overlay: overlay?.copyState ? overlay.copyState(st.overlay) : { ...st.overlay } }),
        token(stream, st) {
          const start = stream.pos;
          const style = overlay?.token?.(stream, st.overlay);
          if (stream.pos > start) return style ?? null;
          if (base?.token) { const b = base.token(stream, st.base); if (stream.pos > start) return b ?? null; }
          stream.next();
          return null;
        },
      };
    },
    startState(mode, a1, a2) { return mode?.startState ? mode.startState(a1, a2) : true; },
  };
  window.CodeMirror ||= new Proxy(cm5, { get: (tg, k) => (k in tg ? tg[k] : typeof k === 'string' ? noop : undefined) });
  // translation helper some plugins use for the host app's strings
  const i18nShim = { language: getLanguage(), t: (k) => String(k).split('.').pop(), on() {}, off() {}, exists: () => false, init() { return i18nShim; },
    getFixedT: () => (k) => String(k).split('.').pop(), addResourceBundle() {}, changeLanguage: async () => {}, createInstance: () => ({ ...i18nShim }) };
  window.i18next ||= i18nShim;
  window.CodeMirrorAdapter ||= { commands: {}, Vim: null };
  // window.require for plugins that resolve modules at run time (not attributed: asks as "unknown plugin")
  let sharedRequire = null;
  window.require ||= (name) => {
    if (!sharedRequire) throw new Error('modules are not ready yet');
    return sharedRequire(name);
  };
  makeRequire(mgr, null)().then((r) => { sharedRequire = r; });
  app.commands.addCommand({ id: 'plugins:reload', name: t('plugins.reload'), callback: () => mgr.reloadAll() });
  installInternals(app);
  installNativeApi(app);
}

class PluginManager {
  constructor(app) {
    this.app = app;
    this.manifests = {};
    this.plugins = {};
    this.enabledPlugins = new Set();
    this.settingTabs = [];
    this.errors = {};
    this.compat = null;
  }

  get restricted() { return !!this.app.info?.safeMode || this.app.settings.get('restrictedMode') !== false; }

  async obsidianModule() { return obsidianModule(this); }

  async refresh() {
    const r = await call('plugins.list');
    this.manifests = {};
    // the folder name is the identity (a release may ship a different id, e.g. a beta)
    for (const m of r.plugins) this.manifests[m.dir || m.id] = { ...m, id: m.dir || m.id };
    this.enabledList = r.enabled;
    this.permissions = r.permissions || {};
    return r;
  }

  async loadAll() {
    await ensureTokens(); // before any plugin code runs
    await this.refresh();
    if (this.restricted) return;
    for (const id of this.enabledList) await this.loadPlugin(id);
  }

  async loadPlugin(id) {
    if (this.plugins[id]) return this.plugins[id];
    const manifest = this.manifests[id];
    if (!manifest || manifest.broken) return null;
    let src;
    try { src = await call('plugins.source', { id }); } catch (e) { this.errors[id] = String(e.code || e); return null; }
    const req = await (makeRequire(this, await tokenFor(id)))();
    const module = { exports: {} };
    let PluginClass;
    try {
      // the plugin bundle is CommonJS: function(module, exports, require, ...)
      // only CommonJS names as parameters: bundles may declare their own top-level
      // `app`, `process`... (those are available as globals instead)
      const fn = new Function('module', 'exports', 'require', `${src.main}\n//# sourceURL=plugin:${id}/main.js`);
      fn(module, module.exports, req);
      PluginClass = module.exports.default || module.exports;
      if (typeof PluginClass !== 'function') throw new Error(t('plugins.no-class'));
    } catch (e) {
      this.errors[id] = e.message;
      notifyPluginError(this.app, manifest, e);
      return null;
    }
    const style = document.head.createEl('style', { attr: { id: `plugin-style-${id}` } });
    style.textContent = src.css || '';
    let plugin;
    try {
      plugin = new PluginClass(this.app, manifest);
      this.plugins[id] = plugin;
      this.enabledPlugins.add(id);
      // a plugin whose onload() never finishes must not hold back the others (B-19)
      const loading = plugin.load();
      const slow = await Promise.race([loading.then(() => false), new Promise((r) => setTimeout(() => r(true), LOAD_TIMEOUT))]);
      if (slow) {
        this.errors[id] = t('plugins.slow-load');
        this.app.notice(t('plugins.slow-load-notice', { name: manifest.name || id }), 10000);
        loading.then(() => { delete this.errors[id]; this.app.workspace.trigger('plugin-loaded', id); }, (e) => {
          this.errors[id] = e.message;
          notifyPluginError(this.app, manifest, e);
          this.unloadPlugin(id).catch(() => {});
        });
        return plugin;
      }
      this.app.workspace.trigger('plugin-loaded', id);
      delete this.errors[id];
    } catch (e) {
      this.errors[id] = e.message;
      notifyPluginError(this.app, manifest, e);
      try { plugin?.unload(); } catch { /* ignore */ }
      delete this.plugins[id];
      this.enabledPlugins.delete(id);
      style.detach();
      return null;
    }
    return plugin;
  }

  async unloadPlugin(id) {
    const p = this.plugins[id];
    if (!p) return;
    try { p.unload(); } catch (e) { console.error(`unloading ${id} failed`, e); }
    delete this.plugins[id];
    this.enabledPlugins.delete(id);
    document.getElementById(`plugin-style-${id}`)?.detach();
  }

  getPlugin(id) { return this.plugins[id] || null; }
  isEnabled(id) { return this.enabledPlugins.has(id); }

  async enablePlugin(id) { return this.loadPlugin(id); }
  async disablePlugin(id) { return this.unloadPlugin(id); }

  async enablePluginAndSave(id) {
    const m = this.manifests[id];
    const declared = Array.isArray(m?.skPermissions) ? m.skPermissions.filter((p) => PERMS.includes(p)) : [];
    if (declared.length) {
      const ok = await confirmDialog(this.app, { title: m.name, message: t('plugins.declared', { list: declared.map((p) => t(`perm.${p}`)).join(', ') }), confirm: t('plugins.grant') });
      if (!ok) return false;
      await call('plugins.permissions', { id, set: Object.fromEntries(declared.map((p) => [p, 'allow'])) });
    }
    await call('plugins.setEnabled', { id, enabled: true });
    this.enabledList = [...new Set([...(this.enabledList || []), id])];
    if (!this.restricted) {
      const p = await this.loadPlugin(id);
      p?.onUserEnable?.();
      return !!p;
    }
    return true;
  }

  async disablePluginAndSave(id) {
    await call('plugins.setEnabled', { id, enabled: false });
    this.enabledList = (this.enabledList || []).filter((x) => x !== id);
    await this.unloadPlugin(id);
  }

  async reloadAll() {
    for (const id of Object.keys(this.plugins)) await this.unloadPlugin(id);
    await this.loadAll();
    this.app.notice(t('plugins.reloaded'));
  }

  async setRestricted(v) {
    this.app.settings.set('restrictedMode', v);
    if (v) for (const id of Object.keys(this.plugins)) await this.unloadPlugin(id);
    else await this.loadAll();
  }

  // ---------------------------------------------------------------- settings tab
  async renderSettings(el, modal) {
    await this.refresh();
    el.empty();
    const warn = el.createDiv('plugins-warning callout');
    warn.setAttr('data-callout', 'warning');
    warn.createDiv({ cls: 'callout-title', text: t('plugins.warning-title') });
    warn.createDiv({ cls: 'callout-content', text: t('plugins.warning-text') });
    new Setting(el).setName(t('plugins.restricted')).setDesc(t('plugins.restricted-desc')).addToggle((tg) => tg.setValue(this.restricted).onChange(async (v) => {
      if (!v) {
        const ok = await confirmDialog(this.app, { title: t('plugins.restricted-off-title'), message: t('plugins.warning-text'), confirm: t('plugins.restricted-off') });
        if (!ok) { tg.setValue(true); return; }
      }
      await this.setRestricted(v);
      this.renderSettings(el, modal);
    }));
    new Setting(el).setName(t('plugins.install')).setDesc(t('plugins.install-desc'))
      .addButton((b) => b.setButtonText(t('plugins.from-folder')).onClick(async () => {
        const p = await call('vaults.pickFolder', { title: t('plugins.from-folder') });
        if (!p) return;
        try { const m = await call('plugins.installFolder', { path: p }); this.app.notice(t('plugins.installed', { name: m.name || m.id })); } catch (e) { this.app.notice(t('plugins.install-failed', { error: e.detail || e.code })); }
        this.renderSettings(el, modal);
      }))
      .addButton((b) => b.setButtonText(t('plugins.from-github')).onClick(async () => {
        const repo = await promptDialog(this.app, { title: t('plugins.from-github'), placeholder: 'owner/repository' });
        if (!repo) return;
        const ok = await confirmDialog(this.app, { title: t('plugins.from-github'), message: t('plugins.github-confirm', { repo }), confirm: t('plugins.download') });
        if (!ok) return;
        const n = this.app.notice(t('plugins.downloading', { repo }), 0);
        try { const m = await call('plugins.installGithub', { repo }); n.setMessage(t('plugins.installed', { name: m.name || m.id })); } catch (e) { n.setMessage(t('plugins.install-failed', { error: e.detail || e.code })); }
        setTimeout(() => n.hide(), 4000);
        this.renderSettings(el, modal);
      }))
      .addExtraButton((b) => b.setIcon('folder-open').setTooltip(t('settings.open-folder')).onClick(() => call('config.openFolder', { sub: 'plugins' })))
      .addExtraButton((b) => b.setIcon('refresh').setTooltip(t('plugins.reload')).onClick(async () => { await this.reloadAll(); this.renderSettings(el, modal); }));
    new Setting(el).setName(t('plugins.installed-list')).setHeading();
    const ids = Object.keys(this.manifests).sort();
    if (!ids.length) el.createDiv({ cls: 'setting-item-description', text: t('plugins.none') });
    for (const id of ids) {
      const m = this.manifests[id];
      const s = new Setting(el).setName(m.name || id);
      const desc = createFragment((f) => {
        f.createSpan({ text: `${m.version || ''} · ${m.author || ''}` });
        if (m.description) f.createDiv({ text: m.description });
        if (m.isDesktopOnly) f.createDiv({ cls: 'mod-warning', text: t('plugins.desktop-only') });
        if (this.errors[id]) f.createDiv({ cls: 'mod-error', text: t('plugins.failed', { error: this.errors[id] }) });
      });
      s.setDesc(desc);
      const enabled = (this.enabledList || []).includes(id);
      if (enabled && this.plugins[id] && this.settingTabs.some((tab) => tab.id === id)) {
        s.addExtraButton((b) => b.setIcon('settings').setTooltip(t('plugins.options')).onClick(() => modal.openTabById(id)));
      }
      s.addExtraButton((b) => b.setIcon('shield').setTooltip(t('plugins.permissions')).onClick(() => new PermissionsModal(this.app, id, m).open()));
      s.addExtraButton((b) => b.setIcon('trash').setTooltip(t('plugins.uninstall')).onClick(async () => {
        const ok = await confirmDialog(this.app, { title: t('plugins.uninstall'), message: t('plugins.uninstall-confirm', { name: m.name || id }), confirm: t('plugins.uninstall'), warning: true });
        if (!ok) return;
        await this.unloadPlugin(id);
        await call('plugins.remove', { id });
        this.renderSettings(el, modal);
      }));
      s.addToggle((tg) => tg.setValue(enabled).setDisabled(this.restricted).onChange(async (v) => {
        if (v) { const ok = await this.enablePluginAndSave(id); if (!ok) tg.setValue(false); } else await this.disablePluginAndSave(id);
        modal.onOpen();
        modal.openTabById('community-plugins');
      }));
    }
  }
}

class PermissionsModal extends Modal {
  constructor(app, id, manifest) { super(app); this.id = id; this.manifest = manifest; }
  async onOpen() {
    this.setTitle(t('plugins.permissions-of', { name: this.manifest.name || this.id }));
    const cur = await call('plugins.permissions', { id: this.id });
    this.contentEl.createEl('p', { cls: 'setting-item-description', text: t('plugins.permissions-desc') });
    for (const p of PERMS) {
      new Setting(this.contentEl).setName(t(`perm.${p}`)).addDropdown((d) => d.addOptions({ '': t('plugins.ask'), allow: t('plugins.allow'), deny: t('plugins.deny') })
        .setValue(cur[p] || '').onChange((v) => call('plugins.permissions', { id: this.id, set: { [p]: v || null } })));
    }
    const row = this.contentEl.createDiv('modal-button-container');
    new ButtonComponent(row).setButtonText(t('common.close')).onClick(() => this.close());
    void setIcon;
  }
}
