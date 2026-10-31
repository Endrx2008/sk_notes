// Import, migration, Git/Syncthing sync and static site publishing (UI side).

import { call, resourceUrl } from '../core/api.js';
import { t, tn } from '../core/i18n.js';
import { isImage } from '../core/util.js';
import { Component } from '../model/component.js';
import { TFile } from '../model/vault.js';
import { postProcess, renderSections } from '../render/markdown.js';
import { ButtonComponent, Modal, Setting, TextComponent, confirmDialog } from '../ui/kit.js';

const FORMATS = ['markdown', 'enex', 'notion', 'html', 'textbundle', 'logseq', 'roam', 'keep', 'csv'];
const NEEDS_FOLDER = new Set(['markdown', 'logseq', 'keep']);

export function installExtras(app) {
  const cmd = (id, key, cb) => app.commands.addCommand({ id, name: t(key), callback: cb });
  cmd('importer:open', 'import.cmd', () => new ImportModal(app).open());
  cmd('migration:open', 'migration.cmd', () => new MigrationModal(app).open());
  cmd('sync:open', 'sync.cmd', () => new SyncModal(app).open());
  cmd('sync:commit-and-push', 'sync.cmd-quick', () => quickSync(app));
  cmd('publish:open', 'publish.cmd', () => new PublishModal(app).open());
  app.on('ready', async () => {
    if (app.settings.get('migrationOffered')) return;
    const scan = await call('migration.scan').catch(() => null);
    if (!scan?.found || !scan.items?.length) return;
    app.settings.set('migrationOffered', true);
    const frag = createFragment((f) => {
      f.createDiv({ text: t('migration.found') });
      const b = f.createEl('button', { cls: 'mod-cta', text: t('migration.review') });
      b.addEventListener('click', () => new MigrationModal(app).open());
    });
    app.notice(frag, 15000);
  });
  // optional automatic commit
  setInterval(() => {
    const mins = Number(app.settings.get('gitAutoCommitMinutes') || 0);
    if (!mins) return;
    const last = app._lastAutoCommit || 0;
    if (Date.now() - last >= mins * 60000) { app._lastAutoCommit = Date.now(); call('git.commit', { message: `sk_notes: ${window.moment().format('YYYY-MM-DD HH:mm')}` }).catch(() => {}); }
  }, 60000);
}

// ------------------------------------------------------------------- import
class ImportModal extends Modal {
  onOpen() {
    this.setTitle(t('import.title'));
    const c = this.contentEl;
    c.createEl('p', { cls: 'setting-item-description', text: t('import.intro') });
    let format = 'markdown';
    let source = '';
    let folder = t('import.default-folder');
    const srcSetting = new Setting(c).setName(t('import.source'));
    const fmt = new Setting(c).setName(t('import.format')).addDropdown((d) => {
      for (const f of FORMATS) d.addOption(f, t(`import.format.${f}`));
      d.setValue(format).onChange((v) => { format = v; srcSetting.setDesc(t(`import.hint.${v}`)); });
    });
    void fmt;
    srcSetting.setDesc(t('import.hint.markdown'));
    const srcLabel = srcSetting.controlEl.createSpan({ cls: 'import-source', text: t('import.none') });
    srcSetting.addButton((b) => b.setButtonText(t('import.choose')).onClick(async () => {
      const p = await call('import.pick', { folder: NEEDS_FOLDER.has(format), title: t('import.source'),
        filter: { enex: 'Evernote (*.enex)', notion: 'Zip (*.zip)', html: 'HTML (*.html *.htm)', roam: 'JSON (*.json)', csv: 'CSV (*.csv *.tsv)', textbundle: 'TextBundle (*.textbundle *.textpack)' }[format] || '' });
      if (p) { source = p; srcLabel.setText(p); }
    }));
    srcSetting.addButton((b) => b.setButtonText(t('import.choose-folder')).onClick(async () => {
      const p = await call('import.pick', { folder: true, title: t('import.source') });
      if (p) { source = p; srcLabel.setText(p); }
    }));
    new Setting(c).setName(t('import.folder')).setDesc(t('import.folder-desc')).addText((x) => x.setValue(folder).onChange((v) => { folder = v; }));
    const out = c.createDiv('import-result');
    const row = c.createDiv('modal-button-container');
    const go = new ButtonComponent(row).setButtonText(t('import.run')).setCta().onClick(async () => {
      if (!source) { out.setText(t('import.need-source')); return; }
      go.setDisabled(true);
      out.setText(t('import.running'));
      try {
        const r = await call('import.run', { format, source, folder });
        out.setText(t('import.done', { notes: r.notes, files: r.files }) + (r.errors.length ? '\n' + r.errors.join('\n') : ''));
      } catch (e) { out.setText(t('import.failed', { error: e.detail || e.code })); }
      go.setDisabled(false);
    });
    new ButtonComponent(row).setButtonText(t('common.close')).onClick(() => this.close());
  }
}

// ------------------------------------------------------------------- migration
class MigrationModal extends Modal {
  async onOpen() {
    this.setTitle(t('migration.title'));
    const c = this.contentEl;
    c.createEl('p', { cls: 'setting-item-description', text: t('migration.intro') });
    const scan = await call('migration.scan');
    if (!scan.found || !scan.items.length) { c.createEl('p', { text: t('migration.nothing') }); return; }
    const chosen = new Set(scan.items.map((i) => i.id).filter((id) => id !== 'plugins'));
    for (const item of scan.items) {
      const s = new Setting(c).setName(t(`migration.item.${item.id}`)).setDesc(tn('migration.count', item.count));
      if (item.id === 'plugins') {
        s.setDesc(createFragment((f) => {
          f.createDiv({ text: tn('migration.count', item.count) });
          f.createDiv({ cls: 'mod-warning', text: t('migration.plugins-warning') });
          f.createDiv({ text: item.data.map((p) => p.name || p.dir).join(', ') });
        }));
      }
      s.addToggle((tg) => tg.setValue(chosen.has(item.id)).onChange((v) => { if (v) chosen.add(item.id); else chosen.delete(item.id); }));
    }
    const row = c.createDiv('modal-button-container');
    new ButtonComponent(row).setButtonText(t('migration.apply')).setCta().onClick(async () => {
      const r = await call('migration.apply', { items: [...chosen] });
      this.close();
      const ok = await confirmDialog(this.app, { title: t('migration.title'), message: t('migration.done', { n: Object.keys(r).length }), confirm: t('settings.relaunch') });
      if (ok) { await this.app.flush(); call('app.relaunch'); }
    });
    new ButtonComponent(row).setButtonText(t('common.cancel')).onClick(() => this.close());
  }
}

// ------------------------------------------------------------------- sync
async function quickSync(app) {
  const n = app.notice(t('sync.working'), 0);
  try {
    await call('git.commit', { message: `sk_notes: ${window.moment().format('YYYY-MM-DD HH:mm')}` });
    const st = await call('git.status');
    if (st.remotes?.length) { await call('git.pull'); await call('git.push'); }
    n.setMessage(t('sync.done'));
  } catch (e) { n.setMessage(t('sync.failed', { error: e.detail || e.code })); }
  setTimeout(() => n.hide(), 4000);
}

class SyncModal extends Modal {
  async onOpen() {
    this.setTitle(t('sync.title'));
    await this.render();
  }

  async render() {
    const c = this.contentEl;
    c.empty();
    c.createEl('p', { cls: 'setting-item-description', text: t('sync.intro') });
    new Setting(c).setName(t('sync.git')).setHeading();
    const st = await call('git.status').catch((e) => ({ error: e.code }));
    const run = async (fn) => { try { await fn(); } catch (e) { this.app.notice(t('sync.failed', { error: e.detail || e.code })); } await this.render(); };
    if (!st.available) {
      c.createEl('p', { text: t('sync.git-missing') });
    } else if (!st.repo) {
      new Setting(c).setName(t('sync.git-init')).setDesc(t('sync.git-init-desc')).addButton((b) => b.setButtonText(t('sync.git-init')).setCta().onClick(() => run(() => call('git.init'))));
    } else {
      new Setting(c).setName(t('sync.branch')).setDesc(`${st.branch} · ${st.last || t('sync.no-commits')}`);
      let msg = '';
      new Setting(c).setName(tn('sync.changes', st.changes)).addText((x) => x.setPlaceholder(t('sync.message')).onChange((v) => { msg = v; }))
        .addButton((b) => b.setButtonText(t('sync.commit')).setCta().onClick(() => run(() => call('git.commit', { message: msg }))));
      new Setting(c).setName(t('sync.remote')).setDesc(st.remotes.length ? st.remotes.join(', ') : t('sync.no-remote'))
        .addButton((b) => b.setButtonText(t('sync.pull')).setDisabled(!st.remotes.length).onClick(() => run(() => call('git.pull'))))
        .addButton((b) => b.setButtonText(t('sync.push')).setDisabled(!st.remotes.length).onClick(() => run(() => call('git.push'))));
      let url = '';
      new Setting(c).setName(t('sync.set-remote')).setDesc(t('sync.set-remote-desc')).addText((x) => x.setPlaceholder('git@server:notes.git').onChange((v) => { url = v; }))
        .addButton((b) => b.setButtonText(t('common.ok')).onClick(() => run(() => call('git.setRemote', { url }))));
      new Setting(c).setName(t('sync.auto')).setDesc(t('sync.auto-desc')).addDropdown((d) => d.addOptions({ 0: t('sync.auto-off'), 5: '5 min', 15: '15 min', 30: '30 min', 60: '60 min' })
        .setValue(String(this.app.settings.get('gitAutoCommitMinutes') || 0)).onChange((v) => this.app.settings.set('gitAutoCommitMinutes', Number(v))));
    }
    new Setting(c).setName(t('sync.syncthing')).setHeading();
    const sy = await call('syncthing.status').catch(() => ({}));
    let desc;
    if (!sy.installed && !sy.configured) desc = t('sync.syncthing-missing');
    else if (!sy.configured) desc = t('sync.syncthing-not-configured');
    else if (!sy.shared) desc = t('sync.syncthing-not-shared');
    else desc = sy.running ? t('sync.syncthing-state', { state: sy.state || '?', n: sy.folder.devices }) : t('sync.syncthing-not-running');
    const s = new Setting(c).setName(t('sync.syncthing-status')).setDesc(desc);
    if (sy.gui) s.addButton((b) => b.setButtonText(t('sync.syncthing-open')).onClick(() => this.app.openExternal(sy.gui)));
  }
}

// ------------------------------------------------------------------- publish (static site)
const SITE_CSS = `:root{--bg:#0d0d0d;--bg2:#141414;--text:#e8e8e8;--muted:#9a9a9a;--accent:#e05c00;--border:#2a2a2a}
@media (prefers-color-scheme: light){:root{--bg:#f6f4f1;--bg2:#fff;--text:#1a1a1a;--muted:#5e5a55;--accent:#c75200;--border:#d9d3cb}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,sans-serif;display:flex;min-height:100vh}
nav{width:270px;flex-shrink:0;background:var(--bg2);border-right:1px solid var(--border);padding:18px;font:13px/1.6 'JetBrains Mono',monospace;overflow-y:auto;max-height:100vh;position:sticky;top:0}
nav a{color:var(--muted);text-decoration:none;display:block;padding:2px 4px;border-radius:4px}nav a:hover,nav a.active{color:var(--text);background:rgba(224,92,0,.18)}
nav .site{color:var(--accent);font-weight:800;font-size:16px;margin-bottom:12px;display:block}nav .folder{color:var(--muted);margin-top:8px;font-weight:700}
main{flex:1;max-width:780px;margin:0 auto;padding:32px 28px 80px}a{color:var(--accent)}a.unresolved{opacity:.6;text-decoration-style:dashed}
pre,code{font-family:'JetBrains Mono',monospace;font-size:.88em;background:var(--bg2);border-radius:4px}pre{padding:12px;overflow:auto;border:1px solid var(--border)}
blockquote{border-left:3px solid var(--accent);margin:1em 0;padding-left:14px;color:var(--muted)}img{max-width:100%}
table{border-collapse:collapse}td,th{border:1px solid var(--border);padding:4px 10px}.tag{color:var(--accent);text-decoration:none}
.callout{border-left:3px solid var(--accent);background:rgba(224,92,0,.08);padding:8px 14px;border-radius:6px;margin:1em 0}.callout-title{font-weight:700}
.backlinks{margin-top:3em;border-top:1px solid var(--border);padding-top:1em;font-size:.9em;color:var(--muted)}
@media(max-width:800px){body{display:block}nav{width:auto;position:static;max-height:none}}`;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function relUrl(fromPath, toPath) {
  const from = fromPath.split('/').slice(0, -1);
  const to = toPath.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].map(encodeURIComponent).join('/');
}

class PublishModal extends Modal {
  onOpen() {
    this.setTitle(t('publish.title'));
    const c = this.contentEl;
    c.createEl('p', { cls: 'setting-item-description', text: t('publish.intro') });
    let folder = '';
    let onlyMarked = false;
    let siteName = this.app.vault.getName();
    const f = new Setting(c).setName(t('publish.output')).setDesc(t('publish.output-desc'));
    const label = f.controlEl.createSpan({ text: t('import.none') });
    f.addButton((b) => b.setButtonText(t('import.choose-folder')).onClick(async () => {
      const p = await call('publish.pickFolder', { title: t('publish.output') });
      if (p) { folder = p; label.setText(p); }
    }));
    new Setting(c).setName(t('publish.name')).addText((x) => x.setValue(siteName).onChange((v) => { siteName = v; }));
    new Setting(c).setName(t('publish.only-marked')).setDesc(t('publish.only-marked-desc')).addToggle((tg) => tg.setValue(false).onChange((v) => { onlyMarked = v; }));
    const out = c.createDiv('import-result');
    const row = c.createDiv('modal-button-container');
    const go = new ButtonComponent(row).setButtonText(t('publish.generate')).setCta().onClick(async () => {
      if (!folder) { out.setText(t('publish.need-folder')); return; }
      go.setDisabled(true);
      try {
        const r = await generateSite(this.app, { folder, onlyMarked, siteName, progress: (n, total) => out.setText(t('publish.progress', { n, total })) });
        out.setText(t('publish.done', { n: r.pages, folder: r.folder }));
        new ButtonComponent(row).setButtonText(t('publish.open')).onClick(() => call('publish.open', { folder: r.folder }));
      } catch (e) { out.setText(t('publish.failed', { error: e.detail || e.code || e.message })); }
      go.setDisabled(false);
    });
    new ButtonComponent(row).setButtonText(t('common.close')).onClick(() => this.close());
    void TextComponent;
  }
}

async function generateSite(app, { folder, onlyMarked, siteName, progress }) {
  const notes = app.vault.getMarkdownFiles().filter((f) => !onlyMarked || app.metadataCache.getFileCache(f)?.frontmatter?.publish === true)
    .sort((a, b) => a.path.localeCompare(b.path));
  const published = new Set(notes.map((f) => f.path));
  const htmlPath = (p) => p.replace(/\.md$/, '.html');
  const attachments = new Set();
  const nav = (current) => {
    let html = `<a class="site" href="${relUrl(current, 'index.html')}">${esc(siteName)}</a>`;
    let lastFolder = null;
    for (const f of notes) {
      const fold = f.parent?.path === '/' ? '' : f.parent.path;
      if (fold !== lastFolder) { if (fold) html += `<div class="folder">${esc(fold)}</div>`; lastFolder = fold; }
      html += `<a href="${relUrl(current, htmlPath(f.path))}"${htmlPath(f.path) === current ? ' class="active"' : ''}>${esc(f.basename)}</a>`;
    }
    return html;
  };
  const page = (current, title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} – ${esc(siteName)}</title><link rel="stylesheet" href="${relUrl(current, 'style.css')}"></head><body><nav>${nav(current)}</nav><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  const files = [{ path: 'style.css', text: SITE_CSS }];
  let n = 0;
  for (const file of notes) {
    const box = createDiv();
    const comp = new Component();
    comp.load();
    const text = await app.vault.cachedRead(file);
    const secs = renderSections(app, text, box, file.path, comp);
    await postProcess(app, secs, file.path, comp, app.metadataCache.getFileCache(file)?.frontmatter, text);
    comp.unload();
    const me = htmlPath(file.path);
    for (const a of box.findAll('a.internal-link')) {
      const target = app.metadataCache.getFirstLinkpathDest((a.getAttr('data-href') || '').split('#')[0], file.path);
      if (target && published.has(target.path)) a.setAttr('href', relUrl(me, htmlPath(target.path)) + (a.getAttr('data-href').includes('#') ? '' : ''));
      else { a.removeAttribute('href'); a.addClass('unresolved'); }
      a.removeAttribute('data-href');
    }
    for (const img of box.findAll('img')) {
      const src = img.getAttr('src') || '';
      if (src.startsWith('skn://vault/')) {
        const p = decodeURIComponent(src.slice('skn://vault/'.length).split('?')[0]);
        attachments.add(p);
        img.setAttr('src', relUrl(me, p));
      }
    }
    for (const el of box.findAll('.copy-code-button, .markdown-embed-link, input')) el.detach();
    for (const a of box.findAll('a.tag')) a.removeAttribute('href');
    const back = [];
    for (const src in app.metadataCache.resolvedLinks) if (app.metadataCache.resolvedLinks[src][file.path] && published.has(src) && src !== file.path) back.push(src);
    let body = box.innerHTML;
    if (back.length) body += `<div class="backlinks">${esc(t('publish.backlinks'))}: ${back.map((p) => `<a href="${relUrl(me, htmlPath(p))}">${esc(p.replace(/\.md$/, '').split('/').pop())}</a>`).join(', ')}</div>`;
    files.push({ path: me, text: page(me, file.basename, body) });
    n++;
    if (files.length >= 40) { await call('publish.write', { folder, files: files.splice(0) }); progress?.(n, notes.length); }
  }
  const index = notes.find((f) => /^(index|home|readme)$/i.test(f.basename) && f.parent?.path === '/');
  files.push({ path: 'index.html', text: index ? `<!doctype html><meta http-equiv="refresh" content="0; url=${encodeURI(htmlPath(index.path))}">`
    : page('index.html', siteName, `<p>${esc(tn('publish.pages', notes.length))}</p>`) });
  for (const p of attachments) {
    const f = app.vault.getFileByPath(p);
    if (f instanceof TFile && isImage(f.extension)) files.push({ path: p, vault: p });
  }
  void resourceUrl;
  const r = await call('publish.write', { folder, files });
  return { pages: notes.length, folder: r.folder };
}
