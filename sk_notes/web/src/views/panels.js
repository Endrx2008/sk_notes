// Sidebar panels: backlinks, outgoing links, tags, outline, bookmarks, properties.

import { call } from '../core/api.js';
import { setIcon } from '../core/icons.js';
import { t, tn } from '../core/i18n.js';
import { debounce, escapeRegExp } from '../core/util.js';
import { Keymap } from '../model/keymap.js';
import { getAllTags, getLinkpath } from '../model/metadata.js';
import { TFile, TFolder } from '../model/vault.js';
import { Menu, promptDialog } from '../ui/kit.js';
import { ItemView } from './base.js';

/** Base for panels that follow the active note (or a linked/pinned one). */
class FollowView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.file = null;
    this.navButtonsEl.hide();
    this.update = debounce(() => this.render(), 200, true);
  }

  async onOpen() {
    this.registerEvent(this.app.workspace.on('file-open', (f) => { if (!this._fixed()) { this.file = f; this.update(); } }));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.update()));
    this.file = this.app.workspace.getActiveFile();
    this.update();
  }

  _fixed() { return this.leaf.pinned || (this.leaf.group && this.app.workspace.getGroupLeaves(this.leaf.group).length > 1 && this._groupFile()); }

  _groupFile() {
    for (const l of this.app.workspace.getGroupLeaves(this.leaf.group)) if (l !== this.leaf && l.view?.file) { this.file = l.view.file; return true; }
    return false;
  }

  getState() { return { file: this.file?.path }; }
  async setState(st) {
    if (st.file) { const f = this.app.vault.getFileByPath(st.file); if (f) this.file = f; }
    this.update();
  }

  onPaneMenu() {}
  render() {}
}

function tree(container, title, count, collapsed) {
  const item = container.createDiv('tree-item' + (collapsed ? ' is-collapsed' : ''));
  const self = item.createDiv('tree-item-self is-clickable');
  const ic = self.createDiv('tree-item-icon collapse-icon');
  setIcon(ic, 'chevron-down');
  self.createDiv({ cls: 'tree-item-inner', text: title });
  if (count !== undefined) self.createDiv('tree-item-flair-outer').createSpan({ cls: 'tree-item-flair', text: String(count) });
  self.addEventListener('click', () => item.toggleClass('is-collapsed', !item.hasClass('is-collapsed')));
  return item.createDiv('tree-item-children');
}

function lineSnippet(text, line, from, to) {
  const lines = text.split('\n');
  const l = lines[line] ?? '';
  return { text: l, from, to };
}

// ------------------------------------------------------------------- backlinks
export class BacklinkView extends FollowView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'link';
    this.contentEl.addClass('backlink-pane');
    this.unlinkedOpen = false;
  }
  getViewType() { return 'backlink'; }
  getDisplayText() { return this.file ? t('backlinks.title-for', { name: this.file.basename }) : t('backlinks.title'); }
  getIcon() { return 'link'; }

  async render() {
    const c = this.contentEl;
    c.empty();
    this.leaf.updateHeader();
    const file = this.file;
    if (!file || file.extension !== 'md') { c.createDiv({ cls: 'pane-empty', text: t('backlinks.no-file') }); return; }
    const mc = this.app.metadataCache;
    const bl = mc.getBacklinksForFile(file);
    const linked = tree(c, t('backlinks.linked'), bl.count());
    if (!bl.count()) linked.createDiv({ cls: 'search-empty-state', text: t('backlinks.none') });
    for (const src of bl.keys().sort()) {
      const srcFile = this.app.vault.getFileByPath(src);
      if (!srcFile) continue;
      const refs = bl.get(src);
      const box = tree(linked, srcFile.basename, refs.length);
      box.parentElement.querySelector('.tree-item-self').addEventListener('dblclick', () => this.app.workspace.openFile(srcFile, false));
      const text = await this.app.vault.cachedRead(srcFile).catch(() => '');
      for (const ref of refs) {
        const row = box.createDiv('search-result-file-match tree-item-self is-clickable');
        if (ref.position) {
          const sn = lineSnippet(text, ref.position.start.line);
          row.appendText(sn.text.slice(0, ref.position.start.col));
          row.createSpan({ cls: 'search-result-file-matched-text', text: ref.original });
          row.appendText(sn.text.slice(ref.position.end.col).slice(0, 120));
        } else {
          row.createSpan({ cls: 'search-result-file-matched-text', text: ref.original });
          row.appendText(` (${t('backlinks.in-property', { key: ref.key })})`);
        }
        row.addEventListener('click', (e) => this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(srcFile, { eState: ref.position ? { line: ref.position.start.line } : {} }));
      }
    }
    // unlinked mentions: computed on demand (can be slow on big vaults)
    const un = tree(c, t('backlinks.unlinked'), undefined, !this.unlinkedOpen);
    const header = un.parentElement.querySelector('.tree-item-self');
    header.addEventListener('click', () => { this.unlinkedOpen = !un.parentElement.hasClass('is-collapsed'); if (this.unlinkedOpen) this.renderUnlinked(un, file); });
    if (this.unlinkedOpen) this.renderUnlinked(un, file);
  }

  async renderUnlinked(container, file) {
    container.empty();
    const names = [file.basename, ...(this.app.metadataCache.getFileCache(file)?.frontmatter?.aliases || [])].filter((x) => typeof x === 'string' && x.trim());
    const q = names.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(' OR ');
    let res;
    try { res = await call('search.query', { query: q, limit: 300 }); } catch { return; }
    const linkedSrc = new Set(this.app.metadataCache.getBacklinksForFile(file).keys());
    const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[])(${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}\\]])`, 'giu');
    let count = 0;
    for (const r of res.results) {
      if (r.path === file.path || linkedSrc.has(r.path)) continue;
      const srcFile = this.app.vault.getFileByPath(r.path);
      if (!srcFile || srcFile.extension !== 'md') continue;
      const text = await this.app.vault.cachedRead(srcFile).catch(() => '');
      const lines = text.split('\n');
      const hits = [];
      lines.forEach((l, i) => {
        if (/\[\[[^\]]*$/.test(l)) return;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(l))) hits.push({ line: i, col: m.index + m[1].length, len: m[2].length, text: l });
      });
      if (!hits.length) continue;
      count++;
      const box = tree(container, srcFile.basename, hits.length);
      for (const h of hits.slice(0, 20)) {
        const row = box.createDiv('search-result-file-match tree-item-self is-clickable');
        row.appendText(h.text.slice(Math.max(0, h.col - 60), h.col));
        row.createSpan({ cls: 'search-result-file-matched-text', text: h.text.substr(h.col, h.len) });
        row.appendText(h.text.slice(h.col + h.len, h.col + h.len + 80));
        const btn = row.createEl('button', { cls: 'search-result-hover-button mod-cta', text: t('backlinks.link') });
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.app.vault.process(srcFile, (txt) => {
            const ls = txt.split('\n');
            const l = ls[h.line];
            const word = l.substr(h.col, h.len);
            const link = word === file.basename ? `[[${this.app.metadataCache.fileToLinktext(file, srcFile.path)}]]`
              : `[[${this.app.metadataCache.fileToLinktext(file, srcFile.path)}|${word}]]`;
            ls[h.line] = l.slice(0, h.col) + link + l.slice(h.col + h.len);
            return ls.join('\n');
          });
        });
        row.addEventListener('click', (e) => this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(srcFile, { eState: { line: h.line } }));
      }
    }
    if (!count) container.createDiv({ cls: 'search-empty-state', text: t('backlinks.none-unlinked') });
  }
}

// ------------------------------------------------------------------- outgoing links
export class OutgoingLinkView extends FollowView {
  constructor(leaf) { super(leaf); this.icon = 'arrow-right'; }
  getViewType() { return 'outgoing-link'; }
  getDisplayText() { return this.file ? t('outgoing.title-for', { name: this.file.basename }) : t('outgoing.title'); }
  getIcon() { return 'arrow-right'; }

  render() {
    const c = this.contentEl;
    c.empty();
    this.leaf.updateHeader();
    const file = this.file;
    if (!file) { c.createDiv({ cls: 'pane-empty', text: t('backlinks.no-file') }); return; }
    const mc = this.app.metadataCache;
    const cache = mc.getFileCache(file) || {};
    const refs = [...(cache.links || []), ...(cache.embeds || []), ...(cache.frontmatterLinks || [])];
    const seen = new Map();
    for (const r of refs) {
      const lp = getLinkpath(r.link);
      const dest = lp ? mc.getFirstLinkpathDest(lp, file.path) : null;
      const key = dest ? dest.path : '?' + lp;
      if (!seen.has(key)) seen.set(key, { dest, lp, n: 0 });
      seen.get(key).n++;
    }
    const links = tree(c, t('outgoing.links'), [...seen.values()].length);
    for (const { dest, lp, n } of [...seen.values()].sort((a, b) => (a.dest ? 0 : 1) - (b.dest ? 0 : 1))) {
      const row = links.createDiv('tree-item-self is-clickable outgoing-link-item' + (dest ? '' : ' is-unresolved'));
      setIcon(row.createDiv('tree-item-icon'), dest ? this.app.fileTypeIcon(dest) : 'file-plus');
      row.createDiv({ cls: 'tree-item-inner', text: dest ? (dest.extension === 'md' ? dest.basename : dest.name) : lp });
      row.createDiv('tree-item-flair-outer').createSpan({ cls: 'tree-item-flair', text: String(n) });
      row.addEventListener('click', (e) => this.app.workspace.openLinkText(lp, file.path, Keymap.isModEvent(e)));
    }
    if (!seen.size) links.createDiv({ cls: 'search-empty-state', text: t('outgoing.none') });
  }
}

// ------------------------------------------------------------------- tags
export class TagView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'tag';
    this.navButtonsEl.hide();
    this.sortByCount = true;
    this.nested = true;
    this.collapsed = new Set();
    this.update = debounce(() => this.render(), 300, true);
    const sortBtn = this.addAction('sort', t('tags.sort'), () => { this.sortByCount = !this.sortByCount; this.render(); });
    void sortBtn;
    this.addAction('layers', t('tags.nested'), () => { this.nested = !this.nested; this.render(); });
  }
  getViewType() { return 'tag'; }
  getDisplayText() { return t('tags.title'); }
  getIcon() { return 'tag'; }
  async onOpen() { this.registerEvent(this.app.metadataCache.on('resolved', () => this.update())); this.render(); }

  render() {
    const c = this.contentEl;
    c.empty();
    const counts = this.app.metadataCache.getTags();
    const entries = Object.entries(counts);
    if (!entries.length) { c.createDiv({ cls: 'pane-empty', text: t('tags.none') }); return; }
    // build a tree of nested tags (#a/b/c)
    const root = { children: new Map(), count: 0 };
    for (const [tag, n] of entries) {
      const parts = this.nested ? tag.slice(1).split('/') : [tag.slice(1)];
      let node = root;
      let path = '';
      for (const p of parts) {
        path = path ? `${path}/${p}` : p;
        if (!node.children.has(p)) node.children.set(p, { name: p, path, children: new Map(), count: 0 });
        node = node.children.get(p);
        node.count += n;
      }
    }
    const renderNode = (node, parentEl) => {
      const kids = [...node.children.values()].sort((a, b) => (this.sortByCount ? b.count - a.count : 0) || a.name.localeCompare(b.name));
      for (const k of kids) {
        const item = parentEl.createDiv('tree-item tag-pane-tag' + (this.collapsed.has(k.path) ? ' is-collapsed' : ''));
        const self = item.createDiv('tree-item-self is-clickable');
        if (k.children.size) {
          const ic = self.createDiv('tree-item-icon collapse-icon');
          setIcon(ic, 'chevron-down');
          ic.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.collapsed.has(k.path)) this.collapsed.delete(k.path); else this.collapsed.add(k.path);
            item.toggleClass('is-collapsed', this.collapsed.has(k.path));
          });
        }
        self.createDiv({ cls: 'tree-item-inner tag-pane-tag-text', text: '#' + k.name });
        self.createDiv('tree-item-flair-outer').createSpan({ cls: 'tree-item-flair tag-pane-tag-count', text: String(k.count) });
        self.addEventListener('click', (e) => this.app.openTagSearch(k.path));
        self.addEventListener('contextmenu', (e) => {
          const m = new Menu();
          m.addItem((i) => i.setTitle(t('tags.rename')).setIcon('pencil').onClick(() => this.renameTag(k.path)));
          this.app.workspace.trigger('tag-menu', m, k.path);
          m.showAtMouseEvent(e);
        });
        if (k.children.size) renderNode(k, item.createDiv('tree-item-children'));
      }
    };
    renderNode(root, c);
  }

  async renameTag(tag) {
    const nt = await promptDialog(this.app, { title: t('tags.rename'), value: tag });
    if (!nt || nt === tag) return;
    const clean = nt.replace(/^#/, '').replace(/\s+/g, '-');
    const re = new RegExp(`(^|[\\s(])#${escapeRegExp(tag)}(?=$|[\\s/,.;:!?)\\]])`, 'gmu');
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      const tags = getAllTags(this.app.metadataCache.getFileCache(f)) || [];
      if (!tags.some((x) => x === '#' + tag || x.startsWith('#' + tag + '/'))) continue;
      await this.app.vault.process(f, (text) => text.replace(re, (m, pre) => `${pre}#${clean}`));
      await this.app.fileManager.processFrontMatter(f, (fm) => {
        for (const key of ['tags', 'tag']) {
          if (Array.isArray(fm[key])) fm[key] = fm[key].map((x) => (String(x).replace(/^#/, '') === tag ? clean : String(x).replace(/^#/, '').startsWith(tag + '/') ? clean + String(x).replace(/^#/, '').slice(tag.length) : x));
          else if (typeof fm[key] === 'string' && fm[key].replace(/^#/, '') === tag) fm[key] = clean;
        }
      }).catch(() => {});
      n++;
    }
    this.app.notice(tn('tags.renamed', n));
  }
}

// ------------------------------------------------------------------- outline
export class OutlineView extends FollowView {
  constructor(leaf) { super(leaf); this.icon = 'outline'; }
  getViewType() { return 'outline'; }
  getDisplayText() { return this.file ? t('outline.title-for', { name: this.file.basename }) : t('outline.title'); }
  getIcon() { return 'outline'; }

  async onOpen() {
    await super.onOpen();
    this.registerEvent(this.app.workspace.on('editor-change', debounce(() => this.update(), 800, true)));
  }

  render() {
    const c = this.contentEl;
    c.empty();
    this.leaf.updateHeader();
    const file = this.file;
    const hs = file ? this.app.metadataCache.getFileCache(file)?.headings || [] : [];
    if (!hs.length) { c.createDiv({ cls: 'pane-empty', text: t('outline.none') }); return; }
    const minLevel = Math.min(...hs.map((h) => h.level));
    for (const h of hs) {
      const row = c.createDiv({ cls: `tree-item-self is-clickable outline-heading level-${h.level}` });
      row.style.paddingLeft = `${(h.level - minLevel) * 16 + 8}px`;
      row.createDiv({ cls: 'tree-item-inner', text: h.heading });
      row.addEventListener('click', async (e) => {
        let leaf = null;
        this.app.workspace.iterateRootLeaves((l) => { if (!leaf && l.view?.file === file) leaf = l; });
        leaf ||= this.app.workspace.getLeaf(Keymap.isModEvent(e));
        if (leaf.view?.file !== file) await leaf.openFile(file);
        leaf.view.setEphemeralState({ line: h.position.start.line });
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      });
    }
  }
}

// ------------------------------------------------------------------- bookmarks
export class Bookmarks {
  constructor(app) {
    this.app = app;
    this.items = [];
    this.listeners = new Set();
    app.vault.on('rename', (f, old) => {
      let changed = false;
      const walk = (list) => list.forEach((b) => {
        if ((b.type === 'file' || b.type === 'folder') && (b.path === old || b.path.startsWith(old + '/'))) { b.path = f.path + b.path.slice(old.length); changed = true; }
        if (b.items) walk(b.items);
      });
      walk(this.items);
      if (changed) this.save();
    });
  }
  async load() { const d = await this.app.config.read('bookmarks.json').catch(() => null); this.items = d?.items || []; this.changed(); }
  save() { this.app.config.write('bookmarks.json', { items: this.items }); this.changed(); }
  changed() { for (const fn of this.listeners) fn(); }
  addFile(file, subpath) {
    this.items.push({ type: file instanceof TFolder ? 'folder' : 'file', path: file.path, ...(subpath ? { subpath } : {}), ctime: Date.now() });
    this.save();
  }
  addSearch(query) { this.items.push({ type: 'search', query, ctime: Date.now() }); this.save(); }
  addUrl(url, title) { this.items.push({ type: 'url', url, title, ctime: Date.now() }); this.save(); }
  addGroup(title) { this.items.push({ type: 'group', title, items: [], ctime: Date.now() }); this.save(); }
  remove(item) {
    const walk = (list) => { const i = list.indexOf(item); if (i !== -1) { list.splice(i, 1); return true; } return list.some((b) => b.items && walk(b.items)); };
    walk(this.items);
    this.save();
  }
  isBookmarked(path) {
    const walk = (list) => list.some((b) => b.path === path || (b.items && walk(b.items)));
    return walk(this.items);
  }
}

export class BookmarksView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'bookmark';
    this.navButtonsEl.hide();
    this.addAction('folder-plus', t('bookmarks.new-group'), async () => {
      const name = await promptDialog(this.app, { title: t('bookmarks.new-group') });
      if (name) this.app.bookmarks.addGroup(name);
    });
  }
  getViewType() { return 'bookmarks'; }
  getDisplayText() { return t('bookmarks.title'); }
  getIcon() { return 'bookmark'; }
  async onOpen() {
    const fn = () => this.render();
    this.app.bookmarks.listeners.add(fn);
    this.register(() => this.app.bookmarks.listeners.delete(fn));
    this.render();
  }

  render() {
    const c = this.contentEl;
    c.empty();
    const items = this.app.bookmarks.items;
    if (!items.length) { c.createDiv({ cls: 'pane-empty', text: t('bookmarks.none') }); return; }
    const renderList = (list, parentEl) => {
      for (const b of list) {
        const item = parentEl.createDiv('tree-item');
        const self = item.createDiv({ cls: 'tree-item-self is-clickable bookmark', attr: { draggable: 'true' } });
        const icon = { file: 'file-text', folder: 'folder', search: 'search', url: 'globe', group: 'folder', heading: 'heading', block: 'link', graph: 'graph' }[b.type] || 'bookmark';
        setIcon(self.createDiv('tree-item-icon'), icon);
        const label = b.title || (b.type === 'search' ? b.query : b.type === 'url' ? b.url : (b.path || '').split('/').pop().replace(/\.md$/, '') + (b.subpath || ''));
        self.createDiv({ cls: 'tree-item-inner', text: label });
        self.addEventListener('click', (e) => this.openItem(b, e));
        self.addEventListener('contextmenu', (e) => {
          const m = new Menu();
          m.addItem((i) => i.setTitle(t('bookmarks.rename')).setIcon('pencil').onClick(async () => {
            const name = await promptDialog(this.app, { title: t('bookmarks.rename'), value: label });
            if (name !== null) { b.title = name; this.app.bookmarks.save(); }
          }));
          m.addItem((i) => i.setTitle(t('bookmarks.remove')).setIcon('trash').onClick(() => this.app.bookmarks.remove(b)));
          m.showAtMouseEvent(e);
        });
        self.addEventListener('dragstart', (e) => { this._drag = b; e.dataTransfer.effectAllowed = 'move'; });
        self.addEventListener('dragover', (e) => { if (this._drag) e.preventDefault(); });
        self.addEventListener('drop', (e) => {
          if (!this._drag || this._drag === b) return;
          e.preventDefault();
          const bm = this.app.bookmarks;
          const dragged = this._drag;
          bm.remove(dragged);
          if (b.type === 'group') b.items.push(dragged);
          else { const host = findParent(bm.items, b) || bm.items; host.splice(host.indexOf(b), 0, dragged); }
          bm.save();
          this._drag = null;
        });
        if (b.type === 'group') renderList(b.items || [], item.createDiv('tree-item-children'));
      }
    };
    renderList(items, c);
  }

  async openItem(b, e) {
    const mode = Keymap.isModEvent(e);
    if (b.type === 'file') {
      const f = this.app.vault.getFileByPath(b.path);
      if (f) await this.app.workspace.getLeaf(mode).openFile(f, { eState: b.subpath ? { subpath: b.subpath } : {} });
    } else if (b.type === 'folder') {
      const f = this.app.vault.getAbstractFileByPath(b.path);
      const ex = this.app.workspace.getLeavesOfType('file-explorer')[0];
      if (f && ex) { this.app.workspace.revealLeaf(ex); ex.view.expanded.add(f.path); ex.view._render(); }
    } else if (b.type === 'search') {
      this.app.commands.executeCommandById('global-search:open');
      this.app.workspace.getLeavesOfType('search')[0]?.view?.setQuery(b.query);
    } else if (b.type === 'url') this.app.openExternal(b.url);
  }

  onPaneMenu() {}
}

function findParent(list, item) {
  for (const b of list) {
    if (b.items?.includes(item)) return b.items;
    if (b.items) { const r = findParent(b.items, item); if (r) return r; }
  }
  return list.includes(item) ? list : null;
}

// ------------------------------------------------------------------- all properties
export class AllPropertiesView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.icon = 'sliders';
    this.navButtonsEl.hide();
    this.update = debounce(() => this.render(), 500, true);
  }
  getViewType() { return 'all-properties'; }
  getDisplayText() { return t('properties.all'); }
  getIcon() { return 'sliders'; }
  async onOpen() { this.registerEvent(this.app.metadataCache.on('resolved', () => this.update())); this.render(); }

  async render() {
    const c = this.contentEl;
    c.empty();
    const props = await call('index.properties').catch(() => ({}));
    const entries = Object.entries(props).sort((a, b) => b[1].count - a[1].count);
    if (!entries.length) { c.createDiv({ cls: 'pane-empty', text: t('properties.none') }); return; }
    for (const [key, info] of entries) {
      const row = c.createDiv('tree-item-self is-clickable');
      setIcon(row.createDiv('tree-item-icon'), this.app.propertyTypeIcon?.(info.type) || 'type');
      row.createDiv({ cls: 'tree-item-inner', text: key });
      row.createDiv('tree-item-flair-outer').createSpan({ cls: 'tree-item-flair', text: String(info.count) });
      row.addEventListener('click', () => {
        this.app.commands.executeCommandById('global-search:open');
        this.app.workspace.getLeavesOfType('search')[0]?.view?.setQuery(`[${key}]`);
      });
    }
  }
}

export { TFile };
