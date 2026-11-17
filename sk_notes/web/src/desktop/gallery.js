// Community directories (desktop): themes, plugins, note templates, without looking for
// files and copying them into folders by hand. Python downloads (sk_notes/extras/gallery_api.py);
// nothing is asked to the network until a list is opened.
//   - Settings → Appearance: "Community themes" (download and apply in one click)
//   - Settings → Community plugins: "Browse" and "Check for updates"
//   - the template chooser: "Community templates"

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { errorText, getLanguage, t } from '../core/i18n.js';
import { TemplateModal } from '../features/core.js';
import { ButtonComponent, Modal, SearchComponent, Setting } from '../ui/kit.js';

const PAGE = 90;

class ListModal extends Modal {
  onOpen() {
    this.modalEl.addClass('mod-pc-gallery');
    this.setTitle(this.title());
    this.contentEl.createEl('p', { cls: 'setting-item-description', text: this.note() });
    const top = this.contentEl.createDiv('pc-gallery-top');
    this.search = new SearchComponent(top).setPlaceholder(this.placeholder());
    this.search.onChange(() => { this.shown = PAGE; this.render(); });
    this.statusEl = top.createDiv('pc-gallery-status');
    new ButtonComponent(top).setButtonText(t('settings.reload')).onClick(() => this.load(true));
    this.listEl = this.contentEl.createDiv('pc-gallery-grid');
    this.shown = PAGE;
    setTimeout(() => this.search.inputEl.focus(), 30);
    this.load(false);
  }

  placeholder() { return t('pc.gallery.search'); }

  async load(refresh) {
    this.statusEl.setText(t('pc.plugins.loading'));
    this.listEl.empty();
    try { await this.fetch(refresh); } catch (e) {
      this.statusEl.setText(t('pc.plugins.load-failed', { error: e.detail || errorText(e) }));
      new ButtonComponent(this.statusEl).setButtonText(t('settings.reload')).onClick(() => this.load(true));
      return;
    }
    this.render();
  }

  words() { return this.search.getValue().trim().toLowerCase().split(/\s+/).filter(Boolean); }

  card(name, meta, desc, flag) {
    const card = this.listEl.createDiv('pc-gallery-card');
    const head = card.createDiv('pc-gallery-head');
    head.createDiv({ cls: 'pc-gallery-name', text: name });
    if (flag) head.createSpan({ cls: 'pc-gallery-flag', text: flag });
    if (meta) card.createDiv({ cls: 'pc-gallery-meta', text: meta });
    if (desc) card.createDiv({ cls: 'pc-gallery-desc', text: desc });
    card.setAttr('tabindex', '0');
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') card.click(); });
    return card;
  }

  more(total) {
    if (total <= this.shown) return;
    const b = this.contentEl.createEl('button', { cls: 'pc-gallery-more', text: t('pc.plugins.more') });
    b.addEventListener('click', () => { this.shown += PAGE; b.remove(); this.render(); });
  }

  render() {
    this.contentEl.querySelector('.pc-gallery-more')?.remove();
    this.draw();
  }
}

// ---------------------------------------------------------------- themes
class ThemeBrowser extends ListModal {
  constructor(app, onChange) {
    super(app);
    this.onChange = onChange;
    this.themes = [];
    this.installed = new Set();
    this.busy = false;
  }

  title() { return t('pc.themes.title'); }
  note() { return t('pc.themes.note'); }

  async fetch(refresh) {
    const r = await call('themes.catalog', { refresh });
    this.themes = r.themes;
    this.stale = !!r.stale;
    this.installed = new Set(await call('config.list', { kind: 'themes' }).catch(() => []));
  }

  draw() {
    const words = this.words();
    const builtin = [{ name: 'Anna.g_3', author: 'sk_notes', modes: ['dark'], builtin: true }];
    const all = [...builtin, ...this.themes];
    const hits = all.filter((x) => words.every((w) => `${x.name} ${x.author}`.toLowerCase().includes(w)));
    this.statusEl.setText(t('pc.themes.count', { n: hits.length.toLocaleString() }) + (this.stale ? ' · ' + t('pc.plugins.offline-list') : ''));
    this.listEl.empty();
    const current = this.app.settings.get('cssTheme') || '';
    const none = this.card(t('settings.theme-none'), '', '', current ? '' : t('pc.themes.in-use'));
    none.addEventListener('click', () => { this.app.settings.set('cssTheme', ''); this.onChange?.(); this.draw(); });
    for (const x of hits.slice(0, this.shown)) {
      const modes = (x.modes || []).map((m) => t(m === 'dark' ? 'settings.theme-dark' : 'settings.theme-light')).join(' · ');
      const flag = current === x.name ? t('pc.themes.in-use') : x.builtin ? t('pc.themes.builtin') : this.installed.has(x.name) ? t('pc.plugins.installed-flag') : '';
      const card = this.card(x.name, [x.author, modes].filter(Boolean).join('  –  '), '', flag);
      if (current === x.name) card.addClass('is-current');
      card.addEventListener('click', () => this.use(x));
      if (this.installed.has(x.name) && !x.builtin && current !== x.name) {
        const rm = card.createDiv({ cls: 'clickable-icon pc-gallery-remove', attr: { 'aria-label': t('common.delete') } });
        setIcon(rm, 'trash');
        rm.addEventListener('click', async (e) => {
          e.stopPropagation();
          await call('themes.remove', { name: x.name }).catch(() => {});
          this.installed.delete(x.name);
          this.onChange?.();
          this.draw();
        });
      }
    }
    this.more(hits.length);
  }

  async use(x) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!x.builtin && !this.installed.has(x.name)) {
        this.statusEl.setText(t('pc.themes.downloading', { name: x.name }));
        await call('themes.install', { name: x.name });
        this.installed.add(x.name);
      }
      this.app.settings.set('cssTheme', x.name);
      this.app.notice(t('pc.themes.applied', { name: x.name }));
      this.onChange?.();
    } catch (e) { this.app.notice(e.detail || errorText(e)); }
    this.busy = false;
    this.draw();
  }
}

// ---------------------------------------------------------------- plugins
class PluginBrowser extends ListModal {
  constructor(app, onChange) {
    super(app);
    this.onChange = onChange;
    this.all = [];
  }

  title() { return t('pc.plugins.browse'); }
  note() { return t('pc.plugins.browse-note'); }
  placeholder() { return t('pc.plugins.search'); }

  async fetch(refresh) {
    const r = await call('plugins.catalog', { refresh });
    this.all = r.plugins;
    this.stale = !!r.stale;
    await this.app.plugins.refresh();
  }

  draw() {
    const words = this.words();
    const hits = !words.length ? this.all : this.all.filter((p) => words.every((w) => `${p.name} ${p.author} ${p.description} ${p.id}`.toLowerCase().includes(w)));
    this.statusEl.setText(t('pc.plugins.count', { n: hits.length.toLocaleString() }) + (this.stale ? ' · ' + t('pc.plugins.offline-list') : ''));
    this.listEl.empty();
    const installed = this.app.plugins.manifests || {};
    for (const p of hits.slice(0, this.shown)) {
      const meta = p.author + (p.downloads ? `  ·  ↓ ${p.downloads.toLocaleString()}` : '');
      const card = this.card(p.name, meta, p.description, installed[p.id] ? t('pc.plugins.installed-flag') : '');
      card.addEventListener('click', () => new PluginDetail(this.app, p, () => { this.onChange?.(); this.app.plugins.refresh().then(() => this.draw()); }).open());
    }
    this.more(hits.length);
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
    this.modalEl.addClass('mod-pc-plugin');
    this.setTitle(p.name);
    const c = this.contentEl;
    c.createDiv({ cls: 'pc-gallery-meta', text: `${p.author} · ${p.repo}${p.downloads ? ' · ↓ ' + p.downloads.toLocaleString() : ''}` });
    c.createEl('p', { text: p.description });
    c.createEl('p', { cls: 'setting-item-description', text: t('plugins.warning-text') });
    const out = c.createDiv('import-result');
    const row = c.createDiv('modal-button-container');
    const has = !!mgr.manifests?.[p.id];
    const install = new ButtonComponent(row).setButtonText(has ? t('pc.plugins.update') : t('plugins.install-ok')).setCta().onClick(async () => {
      install.setDisabled(true);
      out.setText(t('plugins.downloading', { repo: p.repo }));
      try {
        const m = await call('plugins.installGithub', { repo: p.repo });
        await mgr.refresh();
        out.setText(t('plugins.installed', { name: m.name || m.id }) + (mgr.restricted ? '\n' + t('pc.plugins.restricted-hint') : ''));
        this.onChange?.();
        if (has && mgr.plugins[p.id]) { await mgr.unloadPlugin(p.id); await mgr.loadPlugin(p.id); }
        if (!has && !mgr.restricted) {
          new ButtonComponent(row).setButtonText(t('plugins.trust-ok')).setCta().onClick(async () => {
            if (await mgr.enablePluginAndSave(p.id)) { this.onChange?.(); this.close(); this.app.notice(t('pc.plugins.enabled', { name: m.name || m.id })); }
          });
        }
      } catch (e) {
        out.setText(e.code === 'cancelled' ? '' : t('plugins.install-failed', { error: e.detail || errorText(e) }));
        install.setDisabled(false);
      }
    });
    new ButtonComponent(row).setButtonText(t('pc.plugins.page')).onClick(() => this.app.openExternal(`https://github.com/${p.repo}`));
    new ButtonComponent(row).setButtonText(t('common.close')).onClick(() => this.close());
  }
}

async function checkUpdates(app, redraw) {
  const n = app.notice(t('pc.plugins.checking'), 0);
  let list;
  try { list = await call('plugins.checkUpdates'); } catch (e) { n.setMessage(t('pc.plugins.load-failed', { error: e.detail || errorText(e) })); setTimeout(() => n.hide(), 5000); return; }
  if (!list.length) { n.setMessage(t('pc.plugins.up-to-date')); setTimeout(() => n.hide(), 4000); return; }
  n.hide();
  const m = new Modal(app);
  m.setTitle(t('pc.plugins.updates'));
  for (const u of list) {
    new Setting(m.contentEl).setName(u.name).setDesc(`${u.installed} → ${u.latest}`).addButton((b) => b.setButtonText(t('pc.plugins.update')).setCta().onClick(async () => {
      b.setDisabled(true);
      try {
        await call('plugins.installGithub', { repo: u.repo });
        await app.plugins.refresh();
        b.setButtonText(t('pc.plugins.updated'));
        redraw();
      } catch (e) { b.setDisabled(false); if (e.code !== 'cancelled') app.notice(t('plugins.install-failed', { error: e.detail || errorText(e) })); }
    }));
  }
  m.open();
}

// ---------------------------------------------------------------- templates
class TemplateGallery extends ListModal {
  constructor(app, onDone) {
    super(app);
    this.onDone = onDone;
    this.items = [];
    this.added = new Set();
  }

  title() { return t('pc.templates.title'); }
  note() { return t('pc.templates.note'); }
  folder() { return (this.app.settings.get('templatesFolder') || '').replace(/\/+$/, '') || 'Templates'; }

  async fetch(refresh) {
    const r = await call('templates.catalog', { refresh });
    const mine = r.templates.filter((x) => x.lang === getLanguage());
    this.items = mine.length ? mine : r.templates.filter((x) => x.lang === 'en');
    this.online = r.online;
  }

  draw() {
    const words = this.words();
    const hits = this.items.filter((x) => words.every((w) => `${x.name} ${x.description}`.toLowerCase().includes(w)));
    this.statusEl.setText(t('pc.templates.count', { n: hits.length }) + (this.online ? '' : ' · ' + t('pc.templates.bundled')));
    this.listEl.empty();
    const folder = this.folder();
    for (const x of hits) {
      const have = this.added.has(x.id) || !!this.app.vault.getFileByPath(`${folder}/${x.name}.md`);
      const card = this.card(x.name, '', x.description, have ? t('pc.templates.added') : '');
      card.addEventListener('click', async () => {
        if (have) return;
        try {
          await call('templates.install', { id: x.id, folder });
          if (!this.app.settings.get('templatesFolder')) this.app.settings.set('templatesFolder', folder);
          this.added.add(x.id);
          this.app.notice(t('pc.templates.added-notice', { name: x.name }));
          this.draw();
        } catch (e) { this.app.notice(e.detail || errorText(e)); }
      });
    }
  }

  onClose() { if (this.onDone) setTimeout(() => this.onDone(this.added.size), 0); }
}

export function installGallery(app) {
  app.browseThemes = (onChange) => new ThemeBrowser(app, onChange).open();
  app.commands.addCommand({ id: 'themes:browse', name: t('pc.themes.title'), icon: 'palette', callback: () => app.browseThemes() });

  const mgr = app.plugins;
  if (mgr) {
    const draw = mgr.renderSettings.bind(mgr);
    mgr.renderSettings = async (el, modal) => {
      await draw(el, modal);
      if (el.querySelector('.pc-gallery-entry')) return;
      const redraw = () => mgr.renderSettings(el, modal);
      const s = new Setting(el).setName(t('pc.plugins.browse')).setDesc(t('pc.plugins.browse-desc'))
        .addButton((b) => b.setButtonText(t('pc.plugins.browse-button')).setCta().onClick(() => new PluginBrowser(app, redraw).open()))
        .addButton((b) => b.setButtonText(t('pc.plugins.check')).onClick(() => checkUpdates(app, redraw)));
      s.settingEl.addClass('pc-gallery-entry');
      const first = el.querySelector('.setting-item');
      if (first?.nextSibling) el.insertBefore(s.settingEl, first.nextSibling);
    };
    app.commands.addCommand({ id: 'plugins:browse', name: t('pc.plugins.browse'), icon: 'puzzle', callback: () => new PluginBrowser(app, null).open() });
  }

  const open = TemplateModal.prototype.onOpen;
  TemplateModal.prototype.onOpen = function onOpenWithGallery() {
    open.call(this);
    const bar = this.modalEl.createDiv('pc-template-gallery-entry');
    const b = bar.createEl('button', { text: t('pc.templates.browse') });
    b.addEventListener('click', () => {
      const choose = this.onChoose;
      this.close();
      new TemplateGallery(app, () => new TemplateModal(app, choose).open()).open();
    });
  };
  app.commands.addCommand({ id: 'templates:community', name: t('pc.templates.title'), icon: 'template', callback: () => new TemplateGallery(app, null).open() });
}
