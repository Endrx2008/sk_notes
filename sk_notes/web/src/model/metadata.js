// MetadataCache: per-file metadata parsed by the Python side, link maps, lookups.

import { Events } from '../core/events.js';
import { TFile, normalizePath } from './vault.js';

export function parseLinktext(linktext) {
  const i = linktext.indexOf('#');
  return i === -1 ? { path: linktext, subpath: '' } : { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

export function getLinkpath(linktext) {
  return parseLinktext(linktext).path;
}

export function stripHeading(heading) {
  return heading.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function resolveSubpath(cache, subpath) {
  if (!cache || !subpath) return null;
  const parts = subpath.split('#').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0].startsWith('^')) {
    const id = parts[0].slice(1).toLowerCase();
    const block = cache.blocks?.[id];
    if (!block) return null;
    const list = cache.listItems?.find((li) => li.id?.toLowerCase() === id);
    return { type: 'block', block, list, start: block.position.start, end: block.position.end };
  }
  const headings = cache.headings || [];
  let idx = -1;
  let level = 0;
  for (const part of parts) {
    const want = stripHeading(part).toLowerCase();
    let found = -1;
    for (let i = idx + 1; i < headings.length; i++) {
      if (idx !== -1 && headings[i].level <= level) break;
      if (stripHeading(headings[i].heading).toLowerCase() === want) { found = i; break; }
    }
    if (found === -1) return null;
    idx = found;
    level = headings[found].level;
  }
  const current = headings[idx];
  let next = null;
  for (let i = idx + 1; i < headings.length; i++) if (headings[i].level <= current.level) { next = headings[i]; break; }
  return { type: 'heading', current, next, start: current.position.start, end: next ? next.position.start : null };
}

export function getAllTags(cache) {
  if (!cache) return null;
  const out = (cache.tags || []).map((t) => t.tag);
  const fm = cache.frontmatter;
  if (fm) {
    for (const key of ['tags', 'tag']) {
      let v = fm[key];
      if (typeof v === 'string') v = v.split(/[,\s]+/).filter(Boolean);
      if (Array.isArray(v)) for (const t of v) if (t !== null && String(t).trim()) out.push(String(t).startsWith('#') ? String(t) : '#' + t);
    }
  }
  return out;
}

export function parseFrontMatterTags(fm) {
  if (!fm) return null;
  const out = [];
  for (const key of ['tags', 'tag']) {
    let v = fm[key];
    if (typeof v === 'string') v = v.split(/[,\s]+/).filter(Boolean);
    if (Array.isArray(v)) for (const t of v) if (t !== null && String(t).trim()) out.push(String(t).startsWith('#') ? String(t) : '#' + t);
  }
  return out.length ? out : null;
}

export function parseFrontMatterAliases(fm) {
  if (!fm) return null;
  for (const key of ['aliases', 'alias']) {
    let v = fm[key];
    if (typeof v === 'string') v = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(v)) return v.map(String);
  }
  return null;
}

export function parseFrontMatterEntry(fm, key) {
  if (!fm) return null;
  if (key instanceof RegExp) {
    for (const k of Object.keys(fm)) if (key.test(k)) return fm[k];
    return null;
  }
  return fm[key] ?? null;
}

export function parseFrontMatterStringArray(fm, key, nospaces) {
  const v = parseFrontMatterEntry(fm, key);
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(String);
  return String(v).split(nospaces ? /[,\s]+/ : ',').map((s) => s.trim()).filter(Boolean);
}

export class MetadataCache extends Events {
  constructor(app) {
    super();
    this.app = app;
    this.vault = app.vault;
    this.meta = Object.create(null);
    this.resolvedLinks = Object.create(null);
    this.unresolvedLinks = Object.create(null);
    this.resolved = false;
    this.initialized = false;
    this._nameIndex = null;
  }

  _load(metadata, resolved, unresolved) {
    this.meta = metadata || Object.create(null);
    this.resolvedLinks = resolved || Object.create(null);
    this.unresolvedLinks = unresolved || Object.create(null);
    this._nameIndex = null;
    this.initialized = true;
    this.resolved = true;
  }

  getFileCache(file) {
    return file ? this.meta[file.path] || (file.extension === 'md' ? {} : null) : null;
  }

  getCache(path) {
    return this.meta[normalizePath(path)] || null;
  }

  fileToLinktext(file, sourcePath, omitMdExtension = true) {
    const name = omitMdExtension && file.extension === 'md' ? file.basename : file.name;
    const dest = this.getFirstLinkpathDest(name, sourcePath || '');
    if (dest === file) return name;
    return omitMdExtension && file.extension === 'md' ? file.path.slice(0, -3) : file.path;
  }

  _names() {
    if (this._nameIndex) return this._nameIndex;
    const idx = new Map();
    for (const f of this.vault.getFiles()) {
      for (const key of [f.name.toLowerCase(), f.extension === 'md' ? f.basename.toLowerCase() : null]) {
        if (!key) continue;
        if (!idx.has(key)) idx.set(key, []);
        idx.get(key).push(f);
      }
    }
    this._nameIndex = idx;
    return idx;
  }

  _invalidateNames() {
    this._nameIndex = null;
  }

  /** Same rules as the Python resolver (core/index.py). */
  getFirstLinkpathDest(linkpath, sourcePath) {
    linkpath = (linkpath || '').trim();
    if (!linkpath) return this.vault.getFileByPath(sourcePath || '') || null;
    const lp = normalizePath(linkpath);
    if (lp === '/') return null;
    const hasExt = /\.[^/.]+$/.test(lp);
    const candidates = hasExt ? [lp, lp + '.md'] : [lp + '.md', lp];
    const folder = sourcePath && sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    const map = this.vault.fileMap;
    if (folder && !lp.includes('/')) {
      for (const c of candidates) if (map[folder + '/' + c] instanceof TFile) return map[folder + '/' + c];
    }
    for (const c of candidates) if (map[c] instanceof TFile) return map[c];
    if (folder && lp.includes('/')) {
      for (const c of candidates) {
        const parts = [];
        for (const part of (folder + '/' + c).split('/')) {
          if (part === '..') parts.pop();
          else if (part && part !== '.') parts.push(part);
        }
        const rel = parts.join('/');
        if (map[rel] instanceof TFile) return map[rel];
      }
    }
    const name = lp.split('/').pop().toLowerCase();
    let matches = this._names().get(name) || [];
    if (lp.includes('/')) {
      const low = lp.toLowerCase();
      matches = matches.filter((f) => {
        const p = f.path.toLowerCase();
        return p === low || p === low + '.md' || p.endsWith('/' + low) || p.endsWith('/' + low + '.md');
      });
    }
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];
    const same = matches.filter((f) => (f.parent?.path === '/' ? '' : f.parent?.path) === folder);
    if (same.length) return same[0];
    return matches.slice().sort((a, b) => ((!hasExt && a.extension !== 'md') - (!hasExt && b.extension !== 'md'))
      || (a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path))[0];
  }

  getLinkpathDest(linkpath, sourcePath) {
    const f = this.getFirstLinkpathDest(linkpath, sourcePath);
    return f ? [f] : [];
  }

  getBacklinksForFile(file) {
    const data = new Map();
    for (const src in this.resolvedLinks) {
      if (!this.resolvedLinks[src][file.path]) continue;
      const cache = this.meta[src];
      const refs = [...(cache?.links || []), ...(cache?.embeds || []), ...(cache?.frontmatterLinks || [])]
        .filter((l) => this.getFirstLinkpathDest(getLinkpath(l.link), src) === file);
      if (refs.length) data.set(src, refs);
    }
    return { data, keys: () => [...data.keys()], get: (k) => data.get(k), count: () => data.size };
  }

  getTags() {
    const out = {};
    for (const path in this.meta) for (const t of getAllTags(this.meta[path]) || []) out[t] = (out[t] || 0) + 1;
    return out;
  }

  getFrontmatterPropertyValuesForKey(key) {
    const out = new Set();
    for (const path in this.meta) {
      const v = this.meta[path].frontmatter?.[key];
      if (v === undefined || v === null) continue;
      for (const x of Array.isArray(v) ? v : [v]) if (x !== null && x !== '') out.add(String(x));
    }
    return [...out];
  }

  isUserIgnored() { return false; }

  // ---------------------------------------------------------------- backend events
  _apply(d) {
    if (d.metadata !== undefined && d.file && !d.file.folder) {
      if (d.metadata) this.meta[d.file.path] = d.metadata;
    }
    if (d.resolvedLinks) {
      this.resolvedLinks = d.resolvedLinks;
      this.unresolvedLinks = d.unresolvedLinks;
    }
    if (d.resolvedPatch) {
      Object.assign(this.resolvedLinks, d.resolvedPatch);
      Object.assign(this.unresolvedLinks, d.unresolvedPatch);
    }
  }

  _onBackend(name, d, file) {
    if (name === 'delete') {
      for (const p of d.removed || [d.file.path]) {
        const prev = this.meta[p];
        delete this.meta[p];
        delete this.resolvedLinks[p];
        delete this.unresolvedLinks[p];
        if (prev) this.trigger('deleted', file, prev);
      }
      this._invalidateNames();
      this._apply(d);
      this.trigger('resolved');
      return;
    }
    if (name === 'rename') {
      for (const [a, b] of d.moved || []) {
        if (this.meta[a]) { this.meta[b] = this.meta[a]; delete this.meta[a]; }
      }
      // here `metadata` maps path -> metadata for every moved or relinked file
      for (const [p, m] of Object.entries(d.metadata || {})) if (m) this.meta[p] = m;
      this._invalidateNames();
      this._apply({ ...d, metadata: undefined });
      for (const p of d.updated || []) {
        const f = this.vault.getFileByPath(p);
        if (f && this.meta[p]) this.trigger('changed', f, '', this.meta[p]);
      }
      this.trigger('resolved');
      return;
    }
    if (name === 'create') this._invalidateNames();
    this._apply(d);
    if (file instanceof TFile && d.metadata) {
      this.trigger('changed', file, '', d.metadata);
      this.trigger('resolve', file);
    }
    this.trigger('resolved');
  }
}
