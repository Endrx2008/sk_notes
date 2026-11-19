// sk_notes for Android – the catalogue of community plugins.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Lists the public directory of community plugins (the same one the app these plugins
// were written for reads), with search, and installs a plugin from its GitHub release.
// Nothing is downloaded until the user opens the catalogue.

import { call } from './api.js';
import { setIcon } from '@desktop/core/icons.js';
import { errorText, t } from '@desktop/core/i18n.js';
import { ButtonComponent, Modal, SearchComponent, Setting } from '@desktop/ui/kit.js';

const PAGE = 60;

class PluginBrowser extends Modal {
  constructor(app, onChange) {
    super(app);
    this.onChange = onChange;
    this.all = [];
    this.shown = PAGE;
  }

  async onOpen() {
    this.modalEl.addClass('mod-plugin-browser');
    this.setTitle(t('mobile.plugins.browse'));
    this.contentEl.createEl('p', { cls: 'setting-item-description', text: t('mobile.plugins.browse-note') });
    this.search = new SearchComponent(this.contentEl).setPlaceholder(t('mobile.plugins.search'));
    this.search.onChange(() => { this.shown = PAGE; this.render(); });
    this.statusEl = this.contentEl.createDiv('plugin-browser-status');
    this.listEl = this.contentEl.createDiv('plugin-browser-list');
    await this.load(false);
  }

  async load(refresh) {
    this.statusEl.setText(t('mobile.plugins.loading'));
    this.listEl.empty();
    try {
      const r = await call('plugins.catalog', { refresh });
      this.all = r.plugins;
      this.stale = !!r.stale;
    } catch (e) {
      this.statusEl.setText(t('mobile.plugins.load-failed', { error: e.detail || errorText(e) }));
      new ButtonComponent(this.statusEl).setButtonText(t('settings.reload')).onClick(() => this.load(true));
      return;
    }
    await this.app.plugins.refresh();
    this.render();
  }

  render() {
    const q = this.search.getValue().trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const hits = !words.length ? this.all : this.all.filter((p) => {
      const hay = `${p.name} ${p.author} ${p.description} ${p.id}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    this.statusEl.setText(t('mobile.plugins.count', { n: hits.length.toLocaleString() }) + (this.stale ? ' · ' + t('mobile.plugins.offline-list') : ''));
    this.listEl.empty();
    const installed = this.app.plugins.manifests || {};
    for (const p of hits.slice(0, this.shown)) {
      const row = this.listEl.createDiv('plugin-browser-item');
      const head = row.createDiv('plugin-browser-head');
      head.createDiv({ cls: 'plugin-browser-name', text: p.name });
      if (installed[p.id]) head.createSpan({ cls: 'plugin-browser-flag', text: t('mobile.plugins.installed-flag') });
      const meta = row.createDiv('plugin-browser-meta');
      meta.createSpan({ text: p.author });
      if (p.downloads) {
        const d = meta.createSpan('plugin-browser-downloads');
        setIcon(d.createSpan(), 'download');
        d.createSpan({ text: p.downloads.toLocaleString() });
      }
      row.createDiv({ cls: 'plugin-browser-desc', text: p.description });
      row.addEventListener('click', () => new PluginDetail(this.app, p, () => { this.onChange?.(); this.app.plugins.refresh().then(() => this.render()); }).open());
    }
    if (hits.length > this.shown) {
      const more = this.listEl.createEl('button', { cls: 'plugin-browser-more', text: t('mobile.plugins.more') });
      more.addEventListener('click', () => { this.shown += PAGE; this.render(); });
    }
  }
}

class PluginDetail extends Modal {
  constructor(app, plugin, onChange) {
    super(app);
    this.plugin = plugin;
    this.onChange = onChange;
  }

  onOpen() {
    const p = this.plugin;
    const mgr = this.app.plugins;
    this.setTitle(p.name);
    const c = this.contentEl;
    c.empty();
    c.createDiv({ cls: 'plugin-browser-meta', text: `${p.author} · ${p.repo}` });
    c.createEl('p', { text: p.description });
    c.createEl('p', { cls: 'setting-item-description', text: t('plugins.warning-text') });
    const out = c.createDiv('import-result');
    const row = c.createDiv('modal-button-container');
    const has = !!mgr.manifests?.[p.id];
    const install = new ButtonComponent(row).setButtonText(has ? t('mobile.plugins.update') : t('plugins.install-ok')).setCta().onClick(async () => {
      install.setDisabled(true);
      out.setText(t('plugins.downloading', { repo: p.repo }));
      try {
        const m = await call('plugins.installGithub', { repo: p.repo });
        await mgr.refresh();
        out.setText(t('plugins.installed', { name: m.name || m.id }) + (m.isDesktopOnly ? '\n' + t('plugins.desktop-only') : '') + (mgr.restricted ? '\n' + t('mobile.plugins.restricted-hint') : ''));
        this.onChange?.();
        if (has && mgr.plugins[p.id]) { await mgr.unloadPlugin(p.id); await mgr.loadPlugin(p.id); }
        if (!has && !mgr.restricted) {
          new ButtonComponent(row).setButtonText(t('plugins.trust-ok')).setCta().onClick(async () => {
            const ok = await mgr.enablePluginAndSave(p.id);
            if (ok) { this.onChange?.(); this.close(); this.app.notice(t('mobile.plugins.enabled', { name: m.name || m.id })); }
          });
        }
      } catch (e) {
        if (e.code !== 'cancelled') out.setText(t('plugins.install-failed', { error: e.detail || errorText(e) }));
        else out.setText('');
        install.setDisabled(false);
      }
    });
    new ButtonComponent(row).setButtonText(t('mobile.plugins.page')).onClick(() => this.app.openExternal(`https://github.com/${p.repo}`));
    new ButtonComponent(row).setButtonText(t('common.close')).onClick(() => this.close());
  }
}

async function checkUpdates(app, redraw) {
  const n = app.notice(t('mobile.plugins.checking'), 0);
  let list;
  try { list = await call('plugins.checkUpdates'); } catch (e) { n.setMessage(t('mobile.plugins.load-failed', { error: e.detail || errorText(e) })); setTimeout(() => n.hide(), 5000); return; }
  if (!list.length) { n.setMessage(t('mobile.plugins.up-to-date')); setTimeout(() => n.hide(), 4000); return; }
  n.hide();
  const m = new Modal(app);
  m.setTitle(t('mobile.plugins.updates'));
  for (const u of list) {
    new Setting(m.contentEl).setName(u.name).setDesc(`${u.installed} → ${u.latest}`).addButton((b) => b.setButtonText(t('mobile.plugins.update')).setCta().onClick(async () => {
      b.setDisabled(true);
      try {
        await call('plugins.installGithub', { repo: u.repo });
        await app.plugins.refresh();
        // the new code replaces an enabled plugin's once the user confirms it again
        b.setButtonText(t('mobile.plugins.updated'));
        redraw();
      } catch (e) { b.setDisabled(false); if (e.code !== 'cancelled') app.notice(t('plugins.install-failed', { error: e.detail || errorText(e) })); }
    }));
  }
  m.open();
}

export function installPluginBrowser(app) {
  const mgr = app.plugins;
  if (!mgr) return;
  const draw = mgr.renderSettings.bind(mgr);
  mgr.renderSettings = async (el, modal) => {
    await draw(el, modal);
    if (el.querySelector('.plugin-browser-entry')) return;
    const redraw = () => mgr.renderSettings(el, modal);
    const s = new Setting(el).setName(t('mobile.plugins.browse')).setDesc(t('mobile.plugins.browse-desc'))
      .addButton((b) => b.setButtonText(t('mobile.plugins.browse-button')).setCta().onClick(() => new PluginBrowser(app, redraw).open()))
      .addButton((b) => b.setButtonText(t('mobile.plugins.check')).onClick(() => checkUpdates(app, redraw)));
    s.settingEl.addClass('plugin-browser-entry');
    // right after the restricted-mode switch
    const first = el.querySelector('.setting-item');
    if (first?.nextSibling) el.insertBefore(s.settingEl, first.nextSibling);
  };
}
