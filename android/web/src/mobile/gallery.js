// sk_notes for Android – lists of community templates and community themes.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// So that nobody has to find files and put them in folders by hand: the template chooser
// has "Community templates", the appearance settings have "Community themes".

import { call } from './api.js';
import { errorText, getLanguage, t } from '@desktop/core/i18n.js';
import { TemplateModal } from '@desktop/features/core.js';
import { ButtonComponent, Modal, SearchComponent } from '@desktop/ui/kit.js';

class ListModal extends Modal {
  onOpen() {
    this.modalEl.addClass('mod-plugin-browser');
    this.setTitle(this.title());
    this.contentEl.createEl('p', { cls: 'setting-item-description', text: this.note() });
    this.search = new SearchComponent(this.contentEl).setPlaceholder(t('mobile.gallery.search'));
    this.search.onChange(() => this.render());
    this.statusEl = this.contentEl.createDiv('plugin-browser-status');
    this.listEl = this.contentEl.createDiv('plugin-browser-list');
    this.load(false);
  }

  async load(refresh) {
    this.statusEl.setText(t('mobile.plugins.loading'));
    this.listEl.empty();
    try {
      await this.fetch(refresh);
    } catch (e) {
      this.statusEl.setText(t('mobile.plugins.load-failed', { error: e.detail || errorText(e) }));
      new ButtonComponent(this.statusEl).setButtonText(t('settings.reload')).onClick(() => this.load(true));
      return;
    }
    this.render();
  }

  words() { return this.search.getValue().trim().toLowerCase().split(/\s+/).filter(Boolean); }

  row(name, meta, desc, flag) {
    const row = this.listEl.createDiv('plugin-browser-item');
    const head = row.createDiv('plugin-browser-head');
    head.createDiv({ cls: 'plugin-browser-name', text: name });
    if (flag) head.createSpan({ cls: 'plugin-browser-flag', text: flag });
    if (meta) row.createDiv({ cls: 'plugin-browser-meta', text: meta });
    if (desc) row.createDiv({ cls: 'plugin-browser-desc', text: desc });
    return row;
  }
}

// ---------------------------------------------------------------- templates
class TemplateGallery extends ListModal {
  constructor(app, onDone) {
    super(app);
    this.onDone = onDone;
    this.items = [];
    this.added = new Set();
  }

  title() { return t('mobile.templates.title'); }
  note() { return t('mobile.templates.note'); }

  folder() { return (this.app.settings.get('templatesFolder') || '').replace(/\/+$/, '') || 'Templates'; }

  async fetch(refresh) {
    const r = await call('templates.catalog', { refresh });
    const lang = getLanguage();
    const mine = r.templates.filter((x) => x.lang === lang);
    // the language of the app first; English where there is none
    this.items = mine.length ? mine : r.templates.filter((x) => x.lang === 'en');
    this.online = r.online;
  }

  render() {
    const words = this.words();
    const hits = this.items.filter((x) => words.every((w) => `${x.name} ${x.description}`.toLowerCase().includes(w)));
    this.statusEl.setText(t('mobile.templates.count', { n: hits.length }) + (this.online ? '' : ' · ' + t('mobile.templates.bundled')));
    this.listEl.empty();
    const folder = this.folder();
    for (const x of hits) {
      const have = this.added.has(x.id) || !!this.app.vault.getFileByPath(`${folder}/${x.name}.md`);
      const row = this.row(x.name, '', x.description, have ? t('mobile.templates.added') : '');
      row.addEventListener('click', async () => {
        if (have) return;
        try {
          if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
          await call('templates.install', { id: x.id, folder });
          // the chooser lists the notes of the templates folder: make sure one is set
          if (!this.app.settings.get('templatesFolder')) this.app.settings.set('templatesFolder', folder);
          this.added.add(x.id);
          this.app.notice(t('mobile.templates.added-notice', { name: x.name }));
          this.render();
        } catch (e) { this.app.notice(e.detail || errorText(e)); }
      });
    }
  }

  onClose() { if (this.added.size || this.onDone) setTimeout(() => this.onDone?.(this.added.size), 0); }
}

/** The template chooser gets a way to the community templates. */
export function installTemplateGallery(app) {
  const open = TemplateModal.prototype.onOpen;
  TemplateModal.prototype.onOpen = function onOpenWithGallery() {
    open.call(this);
    const bar = this.modalEl.createDiv('template-gallery-entry');
    const b = bar.createEl('button', { cls: 'mod-cta', text: t('mobile.templates.browse') });
    b.addEventListener('click', () => {
      const choose = this.onChoose;
      this.close();
      // back to the chooser afterwards, with the new templates in it
      new TemplateGallery(app, () => new TemplateModal(app, choose).open()).open();
    });
  };
  app.commands.addCommand({ id: 'mobile:community-templates', name: t('mobile.templates.title'), callback: () => new TemplateGallery(app, null).open() });
}

// ---------------------------------------------------------------- themes
class ThemeBrowser extends ListModal {
  constructor(app, onChange) {
    super(app);
    this.onChange = onChange;
    this.themes = [];
    this.installed = new Set();
    this.shown = 60;
    this.busy = false;
  }

  title() { return t('mobile.themes.title'); }
  note() { return t('mobile.themes.note'); }

  async fetch(refresh) {
    const r = await call('themes.catalog', { refresh });
    this.themes = r.themes;
    this.stale = !!r.stale;
    this.installed = new Set(await call('config.list', { kind: 'themes' }).catch(() => []));
  }

  render() {
    const words = this.words();
    const hits = this.themes.filter((x) => words.every((w) => `${x.name} ${x.author}`.toLowerCase().includes(w)));
    this.statusEl.setText(t('mobile.themes.count', { n: hits.length.toLocaleString() }) + (this.stale ? ' · ' + t('mobile.plugins.offline-list') : ''));
    this.listEl.empty();
    const current = this.app.settings.get('cssTheme') || '';
    for (const x of hits.slice(0, this.shown)) {
      const modes = x.modes.map((m) => t(m === 'dark' ? 'settings.theme-dark' : 'settings.theme-light')).join(' · ');
      const flag = current === x.name ? t('mobile.themes.in-use') : this.installed.has(x.name) ? t('mobile.plugins.installed-flag') : '';
      const row = this.row(x.name, [x.author, modes].filter(Boolean).join('  –  '), '', flag);
      row.addEventListener('click', () => this.use(x));
    }
    if (hits.length > this.shown) {
      const more = this.listEl.createEl('button', { cls: 'plugin-browser-more', text: t('mobile.plugins.more') });
      more.addEventListener('click', () => { this.shown += 60; this.render(); });
    }
  }

  /** Download the theme (once) and switch to it. */
  async use(x) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.installed.has(x.name)) {
        this.statusEl.setText(t('mobile.themes.downloading', { name: x.name }));
        await call('themes.install', { name: x.name });
        this.installed.add(x.name);
      }
      this.app.settings.set('cssTheme', x.name);
      this.app.notice(t('mobile.themes.applied', { name: x.name }));
      this.onChange?.();
    } catch (e) { this.app.notice(e.detail || errorText(e)); }
    this.busy = false;
    this.render();
  }
}

export function installThemeBrowser(app) {
  app.browseThemes = (onChange) => new ThemeBrowser(app, onChange).open();
}
