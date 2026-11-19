// sk_notes for Android – vault index: metadata cache, searchable text and link graph.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Everything lives in memory. The parsed metadata is also kept in the app's private
// storage (MetaStore, keyed by modification time and size), so only changed notes are
// parsed again at the next start. Nothing is written into the vault for this: the
// desktop app's cache.db is left alone and synced vaults get no extra files.

import { native } from './native.js';
import * as parser from './parser.js';
import { ApiError, TEXT_EXT, breathe, extOf, normalizePath } from './util.js';

export const MAX_INDEXED_BYTES = 8 * 1024 * 1024; // bigger notes are listed but not parsed
const CONTENT_BUDGET = 48 * 1024 * 1024; // characters of note text kept in memory for search
const READ_BATCH = 60;
// paths that need no normalisation (fast path of resolve())
const SIMPLE_PATH = /^[^\\/\u00a0\u202f]+(?:\/[^\\/\u00a0\u202f.][^\\/\u00a0\u202f]*)*$/;

/** What search sees of a file: canvases by the text of their cards and group labels
 * (not their JSON), other text files as they are. */
export function searchableText(path, text) {
  const ext = extOf(path);
  if (ext === 'canvas') {
    let data;
    try { data = text.trim() ? JSON.parse(text) : {}; } catch { return ''; }
    const parts = [];
    const nodes = data && typeof data === 'object' && Array.isArray(data.nodes) ? data.nodes : [];
    for (const n of nodes) {
      if (n && typeof n === 'object') {
        for (const key of ['text', 'label']) if (typeof n[key] === 'string' && n[key].trim()) parts.push(n[key].trim());
      }
    }
    return parts.join('\n\n');
  }
  return TEXT_EXT.has(ext) ? text : '';
}

/** Parsed metadata kept between runs: a snapshot file plus a small log of later changes. */
export class MetaStore {
  constructor(dir) {
    this.dir = dir; // null: nothing is kept (tests, storage not writable)
    this.logLines = 0;
  }

  async load() {
    const out = new Map();
    if (!this.dir) return out;
    try {
      const snap = await native.async('fs.readText', { path: this.dir + '/meta.json' });
      const data = JSON.parse(snap.text);
      if (data && data.v === 1 && data.files) for (const [p, row] of Object.entries(data.files)) out.set(p, row);
    } catch { /* first start or unreadable: everything is parsed again */ }
    try {
      const log = await native.async('fs.readText', { path: this.dir + '/meta.log' });
      for (const line of log.text.split('\n')) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; } // a line cut by a crash
        this.logLines += 1;
        if (row[0] === 'p') out.set(row[1], [row[2], row[3], row[4]]);
        else if (row[0] === 'd') out.delete(row[1]);
      }
    } catch { /* no log */ }
    return out;
  }

  _append(row) {
    if (!this.dir) return;
    try {
      native.sync('fs.append', { path: this.dir + '/meta.log', text: JSON.stringify(row) + '\n' });
      this.logLines += 1;
    } catch { /* cache only */ }
  }

  put(path, entry, meta) { this._append(['p', path, entry.mtime, entry.size, meta]); }
  del(path) { this._append(['d', path]); }

  /** Write everything as one snapshot and start a new log. */
  async saveAll(files, meta) {
    if (!this.dir) return;
    const rows = {};
    for (const p in meta) {
      const e = files.get(p);
      if (e) rows[p] = [e.mtime, e.size, meta[p]];
    }
    try {
      await native.async('fs.mkdirs', { path: this.dir });
      await native.async('fs.writeText', { path: this.dir + '/meta.json', text: JSON.stringify({ v: 1, files: rows }) });
      await native.async('fs.writeText', { path: this.dir + '/meta.log', text: '' });
      this.logLines = 0;
    } catch (e) { console.warn('metadata cache not written', e); }
  }
}

const dict = () => Object.create(null);

export class VaultIndex {
  constructor(vault, store = new MetaStore(null)) {
    this.vault = vault;
    this.store = store;
    this.files = new Map(); // path → {path, isDir:false, size, mtime, ctime}
    this.folders = new Set();
    this.meta = dict(); // path → metadata (Markdown notes)
    this.byName = new Map(); // lower-case name → paths
    this.resolved = dict();
    this.unresolved = dict();
    this.backlinks = new Map(); // target → Set of sources
    this._resolveCache = null; // only during bulk rebuilds
    this._content = new Map(); // path → searchable text
    this._contentSize = 0;
    this.synced = false;
  }

  // ------------------------------------------------------------- full sync
  /** Scan the vault and bring the index up to date. Returns change counts. */
  async sync(progress) {
    // What is written while the folder is being read (a file imported from another app, a note
    // saved meanwhile) is not in that reading: those paths are looked at again before the
    // reading replaces the index, or they would vanish from it.
    const touched = new Set();
    this._touched = touched;
    try {
      return await this._sync(progress, touched);
    } finally {
      if (this._touched === touched) this._touched = null;
    }
  }

  async _sync(progress, touched) {
    const entries = await this.vault.scan();
    const first = !this.synced;
    const cached = first ? await this.store.load() : null;
    const files = new Map();
    const folders = new Set();
    for (const e of entries) (e.isDir ? folders.add(e.path) : files.set(e.path, e));
    const changed = [];
    const removed = [];
    let other = 0; // new or changed files that are not notes, and folder changes
    if (first) {
      for (const [path, e] of files) {
        if (extOf(path) !== 'md') continue;
        const c = cached.get(path);
        if (c && c[0] === e.mtime && c[1] === e.size) this.meta[path] = c[2]; else changed.push(path);
      }
      for (const p of cached.keys()) if (!files.has(p)) removed.push(p);
    } else {
      for (const [path, e] of files) {
        const old = this.files.get(path);
        if (old && old.mtime === e.mtime && old.size === e.size) continue;
        if (extOf(path) === 'md') changed.push(path); else other += 1;
        this._dropContent(path);
      }
      for (const p of this.files.keys()) {
        if (!files.has(p)) { removed.push(p); delete this.meta[p]; this._dropContent(p); }
      }
      if (folders.size !== this.folders.size || [...folders].some((f) => !this.folders.has(f))) other += 1;
    }
    // read and parse the changed notes in batches, letting the page breathe
    const parsed = [];
    for (let i = 0; i < changed.length; i += READ_BATCH) {
      const batch = changed.slice(i, i + READ_BATCH);
      const small = batch.filter((p) => files.get(p).size <= MAX_INDEXED_BYTES);
      let texts = [];
      try { texts = await native.async('fs.readTexts', { paths: small.map((p) => this.vault.root + '/' + p) }); } catch { texts = small.map(() => null); }
      const byPath = new Map(small.map((p, k) => [p, texts[k]]));
      for (const p of batch) {
        const text = byPath.get(p) ?? '';
        let meta = {};
        try { meta = parser.parse(text); } catch (e) { console.warn('could not parse', p, e); }
        parsed.push([p, meta, text]);
      }
      progress?.(Math.min(i + READ_BATCH, changed.length), changed.length);
      await breathe();
    }
    // paths changed while this was running: the disk as it is now decides
    for (const p of touched) {
      const st = this.vault.stat(p);
      if (st === null) { files.delete(p); folders.delete(p); continue; }
      if (st.isDir) { folders.add(p); continue; }
      files.set(p, st);
      for (let d = p.lastIndexOf('/'); d > 0; d = p.lastIndexOf('/', d - 1)) folders.add(p.slice(0, d));
    }
    const stale = (p) => touched.has(p); // parsed before the newer write: the index entry made by that write stays
    // apply everything at once: no other operation sees a half-updated index
    this.files = files;
    this.folders = folders;
    for (const p of Object.keys(this.meta)) if (!files.has(p)) delete this.meta[p];
    for (const [p, meta, text] of parsed) {
      if (!files.has(p) || stale(p)) continue;
      this.meta[p] = meta;
      this._setContent(p, searchableText(p, text));
    }
    this._rebuildNames();
    this._rebuildLinks();
    this.synced = true;
    if (first ? changed.length || removed.length : changed.length) {
      // a snapshot when much changed, single log entries otherwise
      if (first || parsed.length > 50 || this.store.logLines > 2000) await this.store.saveAll(this.files, this.meta);
      else for (const [p, meta] of parsed) if (files.has(p)) this.store.put(p, files.get(p), meta);
    }
    if (!first) for (const p of removed) if (extOf(p) === 'md' && !files.has(p)) this.store.del(p);
    return { files: files.size, changed: changed.length + other, removed: removed.filter((p) => !files.has(p)).length };
  }

  // ------------------------------------------------------------- searchable text
  _setContent(path, text) {
    this._dropContent(path);
    if (this._contentSize + text.length > CONTENT_BUDGET) return;
    this._content.set(path, text);
    this._contentSize += text.length;
  }

  _dropContent(path) {
    const old = this._content.get(path);
    if (old !== undefined) {
      this._contentSize -= old.length;
      this._content.delete(path);
    }
  }

  /** Searchable text of a file (read from disk when it is not in memory). */
  content(path) {
    const hit = this._content.get(path);
    if (hit !== undefined) return hit;
    const e = this.files.get(path);
    if (!e || !TEXT_EXT.has(extOf(path)) || e.size > MAX_INDEXED_BYTES) return '';
    let text = '';
    try { text = searchableText(path, this.vault.readText(path)); } catch { text = ''; }
    this._setContent(path, text);
    return text;
  }

  /** Bring the text of these files into memory without blocking the page. */
  async loadContents(paths) {
    const missing = paths.filter((p) => !this._content.has(p) && this.files.has(p) && TEXT_EXT.has(extOf(p)) && this.files.get(p).size <= MAX_INDEXED_BYTES);
    for (let i = 0; i < missing.length; i += READ_BATCH) {
      if (this._contentSize >= CONTENT_BUDGET) return false; // very large vault: the rest is read during the search
      const batch = missing.slice(i, i + READ_BATCH);
      let texts;
      try { texts = await native.async('fs.readTexts', { paths: batch.map((p) => this.vault.abs(p)) }); } catch { return false; }
      batch.forEach((p, k) => { if (this.files.has(p) && !this._content.has(p)) this._setContent(p, searchableText(p, texts[k] ?? '')); });
      await breathe();
    }
    return true;
  }

  // ------------------------------------------------------------- incremental
  /** (Re)index one file after a write or an external change. Returns its new metadata. */
  update(path, text = null) {
    const p = normalizePath(path);
    this._touched?.add(p);
    const entry = this.vault.stat(p);
    if (entry === null) {
      this.remove(p);
      return null;
    }
    if (entry.isDir) {
      this.folders.add(p);
      return null;
    }
    const isNew = !this.files.has(p);
    this.files.set(p, entry);
    this._addParentFolders(p);
    const ext = extOf(p);
    if (!TEXT_EXT.has(ext)) {
      if (isNew) {
        this._nameAdd(p);
        this._rebuildLinks();
      }
      return null;
    }
    let body = text;
    if (body === null) {
      body = '';
      if (entry.size <= MAX_INDEXED_BYTES) { try { body = this.vault.readText(p); } catch { body = ''; } }
    }
    const meta = ext === 'md' ? parser.parse(body) : {};
    this._setContent(p, searchableText(p, body));
    if (isNew) this._nameAdd(p);
    if (ext === 'md') {
      this.meta[p] = meta;
      this.store.put(p, entry, meta);
    }
    if (isNew) this._rebuildLinks(); // a new name may resolve old dangling links
    else this._linksFor(p);
    return meta;
  }

  /** Forget a file or a whole folder. Returns the removed file paths. */
  remove(path) {
    const p = normalizePath(path);
    const gone = [...this.files.keys()].filter((f) => f === p || f.startsWith(p + '/'));
    if (this._touched) { this._touched.add(p); for (const f of gone) this._touched.add(f); }
    for (const f of gone) {
      this.files.delete(f);
      this._dropContent(f);
      if (f in this.meta) {
        delete this.meta[f];
        this.store.del(f);
      }
    }
    for (const f of [...this.folders]) if (f === p || f.startsWith(p + '/')) this.folders.delete(f);
    if (gone.length) {
      this._rebuildNames();
      this._rebuildLinks();
    }
    return gone;
  }

  /** Move index entries old→new (file or folder). Returns [[old, new]] file pairs. */
  rename(oldPath, newPath) {
    const a0 = normalizePath(oldPath);
    const b0 = normalizePath(newPath);
    const pairs = [...this.files.keys()].filter((p) => p === a0 || p.startsWith(a0 + '/')).map((p) => [p, b0 + p.slice(a0.length)]);
    if (this._touched) { this._touched.add(a0); this._touched.add(b0); }
    for (const [a, b] of pairs) {
      this._touched?.add(a);
      this._touched?.add(b);
      const e = this.files.get(a);
      this.files.delete(a);
      this.files.set(b, { ...e, path: b });
      const text = this._content.get(a);
      if (text !== undefined) { this._content.delete(a); this._content.set(b, text); }
      if (a in this.meta) {
        this.meta[b] = this.meta[a];
        delete this.meta[a];
        this.store.del(a);
        this.store.put(b, this.files.get(b), this.meta[b]);
      }
    }
    for (const f of [...this.folders]) {
      if (f === a0 || f.startsWith(a0 + '/')) {
        this.folders.delete(f);
        this.folders.add(b0 + f.slice(a0.length));
      }
    }
    this._addParentFolders(b0 + '/x');
    this._rebuildNames();
    this._rebuildLinks();
    return pairs;
  }

  _addParentFolders(path) {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }

  // ------------------------------------------------------------- names & links
  _nameAdd(path) {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const add = (key) => { const l = this.byName.get(key); if (l) l.push(path); else this.byName.set(key, [path]); };
    add(name);
    if (extOf(path) === 'md') add(name.slice(0, -3));
  }

  _rebuildNames() {
    this.byName = new Map();
    for (const p of [...this.files.keys()].sort()) this._nameAdd(p);
  }

  /** Resolve a link path (without #subpath) to a vault file path: a bare name next to
   * the source note → exact vault path → path relative to the source → by name,
   * case-insensitive (same folder first, then shortest path). */
  resolve(linkpath, source = '') {
    const cache = this._resolveCache;
    const folder = source && source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
    if (cache === null) return this._resolve(linkpath, source, folder);
    const key = linkpath + '\u0000' + folder;
    if (cache.has(key)) return cache.get(key);
    const res = this._resolve(linkpath, source, folder);
    cache.set(key, res);
    return res;
  }

  _resolve(rawLink, source, folder) {
    const linkpath = rawLink.trim();
    if (!linkpath) return source || null;
    const lp = SIMPLE_PATH.test(linkpath) ? linkpath : normalizePath(linkpath);
    if (lp === '/') return null;
    const bare = extOf(lp) === '';
    const candidates = bare ? [lp + '.md', lp] : [lp, lp + '.md'];
    const files = this.files;
    const hasSlash = lp.includes('/');
    if (folder && !hasSlash) for (const c of candidates) if (files.has(`${folder}/${c}`)) return `${folder}/${c}`;
    for (const c of candidates) if (files.has(c)) return c;
    if (folder && hasSlash) {
      for (const c of candidates) {
        const parts = [];
        for (const part of (folder + '/' + c).split('/')) {
          if (part === '..') parts.pop();
          else if (part !== '' && part !== '.') parts.push(part);
        }
        const rel = parts.join('/');
        if (files.has(rel)) return rel;
      }
    }
    const name = lp.slice(lp.lastIndexOf('/') + 1).toLowerCase();
    let matches = this.byName.get(name) || [];
    if (hasSlash) {
      const low = lp.toLowerCase();
      matches = matches.filter((m) => {
        const ml = m.toLowerCase();
        return ml === low || ml === low + '.md' || ml.endsWith('/' + low) || ml.endsWith('/' + low + '.md');
      });
    }
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];
    const same = matches.filter((m) => (m.includes('/') ? m.slice(0, m.lastIndexOf('/')) : '') === folder);
    if (same.length) return same[0];
    const rank = (m) => [bare && extOf(m) !== 'md' ? 1 : 0, m.split('/').length - 1, m];
    return matches.slice().sort((x, y) => {
      const a = rank(x);
      const b = rank(y);
      return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
    })[0];
  }

  _linksFor(path) {
    for (const t of Object.keys(this.resolved[path] || {})) this.backlinks.get(t)?.delete(path);
    const res = dict();
    const unres = dict();
    const meta = this.meta[path] || {};
    for (const list of [meta.links, meta.embeds, meta.frontmatterLinks]) {
      if (!list) continue;
      for (const ref of list) {
        const target = parser.parseLinktext(ref.link)[0];
        if (!target) continue;
        const dest = this.resolve(target, path);
        if (dest) {
          res[dest] = (res[dest] || 0) + 1;
          let set = this.backlinks.get(dest);
          if (!set) {
            set = new Set();
            this.backlinks.set(dest, set);
          }
          set.add(path);
        } else unres[target] = (unres[target] || 0) + 1;
      }
    }
    this.resolved[path] = res;
    this.unresolved[path] = unres;
  }

  _rebuildLinks() {
    this.resolved = dict();
    this.unresolved = dict();
    this.backlinks = new Map();
    this._resolveCache = new Map();
    try {
      for (const p in this.meta) this._linksFor(p);
    } finally {
      this._resolveCache = null;
    }
  }

  // ------------------------------------------------------------- queries
  fileList() {
    const out = [...this.folders].sort().map((f) => ({ path: f, folder: true }));
    for (const p of [...this.files.keys()].sort()) {
      const e = this.files.get(p);
      out.push({ path: p, folder: false, size: e.size, mtime: e.mtime, ctime: e.ctime });
    }
    return out;
  }

  allTags() {
    const counts = dict();
    for (const p in this.meta) for (const t of parser.allTags(this.meta[p])) counts[t] = (counts[t] || 0) + 1;
    return counts;
  }

  /** Every frontmatter key with its count and inferred type. */
  properties() {
    const out = dict();
    for (const p in this.meta) {
      const fm = this.meta[p].frontmatter;
      if (!fm) continue;
      for (const [k, v] of Object.entries(fm)) {
        const info = out[k] || (out[k] = { count: 0, type: inferType(k, v) });
        info.count += 1;
      }
    }
    return out;
  }

  /** Everything the UI needs at start. */
  snapshot() {
    return { files: this.fileList(), metadata: this.meta, resolvedLinks: this.resolved, unresolvedLinks: this.unresolved };
  }
}

function inferType(key, value) {
  if (key === 'tags' || key === 'tag') return 'tags';
  if (key === 'aliases' || key === 'alias') return 'aliases';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'multitext';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return 'datetime';
  }
  return 'text';
}

export { ApiError };
