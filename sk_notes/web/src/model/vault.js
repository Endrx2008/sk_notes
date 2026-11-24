// Vault model: file tree objects, read/write through the Python side, events.

import { call, callSync, resourceUrl } from '../core/api.js';
import { Events } from '../core/events.js';

export class TAbstractFile {
  constructor(vault, path) {
    this.vault = vault;
    this.path = path;
    this.name = path.split('/').pop() || '';
    this.parent = null;
    this.deleted = false;
  }
}

export class TFile extends TAbstractFile {
  constructor(vault, path, stat) {
    super(vault, path);
    this.stat = stat || { ctime: 0, mtime: 0, size: 0 };
    this._setNames();
  }

  _setNames() {
    const dot = this.name.lastIndexOf('.');
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1).toLowerCase() : '';
  }
}

export class TFolder extends TAbstractFile {
  constructor(vault, path) {
    super(vault, path);
    this.children = [];
  }

  isRoot() {
    return this.path === '/';
  }
}

export function normalizePath(path) {
  let p = String(path ?? '').replace(/[\\/]+/g, '/').replace(/[  ]/g, ' ');
  p = p.split('/').filter((x) => x && x !== '.').join('/');
  p = p.normalize('NFC');
  return p === '' ? '/' : p;
}

function parentPath(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '/' : path.slice(0, i);
}

export class DataAdapter {
  constructor(vault) {
    this.vault = vault;
  }
  getName() { return this.vault.getName(); }
  getBasePath() { return this.vault._basePath; }
  getFullPath(p) { return this.vault._basePath + '/' + normalizePath(p); }
  getResourcePath(p) { return resourceUrl(normalizePath(p), Date.now()); }
  async exists(p) { return call('vault.exists', { path: p }); }
  async stat(p) { return call('vault.stat', { path: p }); }
  async list(p) { return call('vault.list', { path: p }); }
  async read(p) { return (await call('vault.read', { path: p })).text; }
  async readBinary(p) { return b64ToBuffer(await call('vault.readBinary', { path: p })); }
  async write(p, data) {
    const path = normalizePath(p);
    await this.vault._writeText(path, data);
    const f = this.vault.getFileByPath?.(path);
    if (f) this.vault.app?.workspace?._onFileModified?.(f);
  }
  async writeBinary(p, data) { await call('vault.writeBinary', { path: normalizePath(p), data: bufferToB64(data) }); }
  async append(p, data) {
    const old = (await this.exists(p)) ? await this.read(p) : '';
    await this.write(p, old + data);
  }
  async process(p, fn) {
    const text = await this.read(p);
    const out = fn(text);
    await this.write(p, out);
    return out;
  }
  async mkdir(p) { await call('vault.mkdir', { path: p }); }
  async remove(p) { await call('vault.delete', { path: p, mode: 'permanent' }); }
  async rmdir(p) { await call('vault.delete', { path: p, mode: 'permanent' }); }
  async trashSystem(p) { return (await call('vault.delete', { path: p, mode: 'system' })).mode === 'system'; }
  async trashLocal(p) { await call('vault.delete', { path: p, mode: 'local' }); }
  async rename(a, b) { await call('vault.rename', { path: a, newPath: b, updateLinks: false }); }
  async copy(a, b) { await call('vault.copy', { path: a, newPath: b }); }
  // synchronous helpers used by Node shims
  existsSync(p) { return callSync('vault.exists', { path: p }); }
  readSync(p) { return callSync('vault.read', { path: p }).text; }
}

export function b64ToBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bufferToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Vault extends Events {
  constructor(app, info) {
    super();
    this.app = app;
    this._readOnly = new Map();
    this._name = info.name;
    this._basePath = info.path;
    this.fileMap = Object.create(null);
    this.root = new TFolder(this, '/');
    this.root.name = info.name;
    this.fileMap['/'] = this.root;
    this.adapter = new DataAdapter(this);
    this.config = {};
    this._cache = new Map(); // path -> {text, mtime}
    this._writing = new Map(); // path -> writes of this page still running (their 'modify' is not news)
    this.configDir = '.sk_notes';
  }

  getName() { return this._name; }
  getRoot() { return this.root; }

  // ---------------------------------------------------------------- tree
  _load(files) {
    this.fileMap = Object.create(null);
    this.root.children = [];
    this.fileMap['/'] = this.root;
    const folders = files.filter((f) => f.folder).sort((a, b) => a.path.length - b.path.length);
    for (const f of folders) this._addFolder(f.path);
    for (const f of files) if (!f.folder) this._addFile(f);
    this._sortAll();
  }

  _addFolder(path) {
    if (this.fileMap[path]) return this.fileMap[path];
    const parent = this._addFolder(parentPath(path));
    const folder = new TFolder(this, path);
    folder.parent = parent;
    parent.children.push(folder);
    this.fileMap[path] = folder;
    return folder;
  }

  _addFile(info) {
    const existing = this.fileMap[info.path];
    const stat = { ctime: info.ctime || 0, mtime: info.mtime || 0, size: info.size || 0 };
    if (existing instanceof TFile) {
      existing.stat = stat;
      return existing;
    }
    const parent = this._addFolder(parentPath(info.path));
    const file = new TFile(this, info.path, stat);
    file.parent = parent;
    parent.children.push(file);
    this.fileMap[info.path] = file;
    return file;
  }

  _remove(path) {
    const f = this.fileMap[path];
    if (!f) return null;
    const drop = (x) => {
      if (x instanceof TFolder) for (const c of x.children.slice()) drop(c);
      delete this.fileMap[x.path];
      this._cache.delete(x.path);
      x.deleted = true;
    };
    drop(f);
    if (f.parent) f.parent.children.remove(f);
    return f;
  }

  _move(oldPath, newPath) {
    const f = this.fileMap[oldPath];
    if (!f) return null;
    const relink = (x, path) => {
      delete this.fileMap[x.path];
      const cached = this._cache.get(x.path);
      if (cached) { this._cache.delete(x.path); this._cache.set(path, cached); }
      x.path = path;
      x.name = path.split('/').pop();
      if (x instanceof TFile) x._setNames();
      this.fileMap[path] = x;
      if (x instanceof TFolder) for (const c of x.children) relink(c, path + '/' + c.name);
    };
    if (f.parent) f.parent.children.remove(f);
    const parent = this._addFolder(parentPath(newPath));
    f.parent = parent;
    parent.children.push(f);
    relink(f, newPath);
    return f;
  }

  _sortAll() {
    const sort = (folder) => {
      folder.children.sort((a, b) => a.name.localeCompare(b.name));
      for (const c of folder.children) if (c instanceof TFolder) sort(c);
    };
    sort(this.root);
  }

  // ---------------------------------------------------------------- lookups
  getAbstractFileByPath(path) {
    return this.fileMap[normalizePath(path)] || null;
  }

  getAbstractFileByPathInsensitive(path) {
    const p = normalizePath(path).toLowerCase();
    for (const k in this.fileMap) if (k.toLowerCase() === p) return this.fileMap[k];
    return null;
  }

  getFileByPath(path) {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  getFolderByPath(path) {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }

  getFiles() { return Object.values(this.fileMap).filter((f) => f instanceof TFile); }
  getMarkdownFiles() { return this.getFiles().filter((f) => f.extension === 'md'); }
  getAllLoadedFiles() { return Object.values(this.fileMap); }
  getAllFolders(includeRoot = false) {
    return Object.values(this.fileMap).filter((f) => f instanceof TFolder && (includeRoot || f !== this.root));
  }

  static recurseChildren(root, cb) {
    const stack = [root];
    while (stack.length) {
      const f = stack.pop();
      cb(f);
      if (f instanceof TFolder) stack.push(...f.children);
    }
  }

  getResourcePath(file) { return resourceUrl(file.path, file.stat.mtime); }

  getConfig(key) { return this.config[key]; }
  setConfig(key, value) {
    this.config[key] = value;
    this.app._saveAppConfig?.();
  }

  // ---------------------------------------------------------------- read
  async read(file) {
    const r = await call('vault.read', { path: file.path });
    this._cache.set(file.path, { text: r.text, mtime: r.mtime });
    if (r.readOnly) this._readOnly.set(file.path, r.readOnly); else this._readOnly.delete(file.path);
    return r.text;
  }

  /** Why a text file must not be saved back ('not-utf8', 'read-only'), from its last read. */
  getReadOnlyReason(file) { return this._readOnly.get(file.path) || null; }

  async cachedRead(file) {
    const c = this._cache.get(file.path);
    if (c && c.mtime === file.stat.mtime) return c.text;
    return this.read(file);
  }

  async readBinary(file) { return this.adapter.readBinary(file.path); }

  // ---------------------------------------------------------------- write
  async _writeText(path, text, opts = {}) {
    // a view's save says which version of the file it started from: if another program
    // changed the file since, Python keeps that version in the history and reports it (B2-11, A2-3)
    const expectedMtime = opts.checkConflict ? this._cache.get(path)?.mtime : undefined;
    this._writing.set(path, (this._writing.get(path) || 0) + 1);
    let res;
    let conflict = false;
    try {
      res = await call('vault.write', { path, text, mtime: opts.mtime, reason: opts.reason, expectedMtime });
      if (res.conflict) {
        conflict = true;
        res = await call('vault.write', { path, text, mtime: opts.mtime, reason: opts.reason });
      }
    } finally {
      const n = (this._writing.get(path) || 1) - 1;
      if (n > 0) this._writing.set(path, n); else this._writing.delete(path);
    }
    const info = res.file;
    this._cache.set(path, { text, mtime: info.mtime });
    return Object.assign({}, info, { conflict });
  }

  async create(path, data, options) {
    path = normalizePath(path);
    if (this.getAbstractFileByPath(path)) throw new Error('File already exists.');
    await call('vault.create', { path, text: data ?? '' });
    return this._ensure(path);
  }

  async createBinary(path, data) {
    path = normalizePath(path);
    if (this.getAbstractFileByPath(path)) throw new Error('File already exists.');
    await this.adapter.writeBinary(path, data);
    return this._ensure(path);
  }

  async createFolder(path) {
    path = normalizePath(path);
    if (this.getAbstractFileByPath(path)) throw new Error('Folder already exists.');
    await call('vault.mkdir', { path });
    return this._addFolder(path);
  }

  _ensure(path) {
    // the backend event normally arrives first; if not, create the entry now
    return this.getAbstractFileByPath(path) || this._addFile({ path, mtime: Date.now(), ctime: Date.now(), size: 0 });
  }

  async modify(file, data, options) {
    const info = await this._writeText(file.path, data, options || {});
    if (info.conflict && options?.onConflict) options.onConflict(file);
    // writes from plugins, templates, properties: open editors must show them, or their
    // next autosave writes the old text back (a view's own save passes itself as fromView)
    this.app?.workspace?._onFileModified?.(file, options?.fromView);
  }

  async modifyBinary(file, data) { await this.adapter.writeBinary(file.path, data); }

  async append(file, data) {
    const text = await this.read(file);
    await this.modify(file, text + data);
  }

  async process(file, fn, options) {
    const text = await this.read(file);
    const out = fn(text);
    if (out !== text) await this.modify(file, out, options);
    return out;
  }

  async delete(file, force) {
    await call('vault.delete', { path: file.path, mode: 'permanent' });
  }

  async trash(file, system) {
    await call('vault.delete', { path: file.path, mode: system ? 'system' : 'local' });
  }

  async rename(file, newPath) {
    await call('vault.rename', { path: file.path, newPath: normalizePath(newPath), updateLinks: false });
  }

  async copy(file, newPath) {
    await call('vault.copy', { path: file.path, newPath: normalizePath(newPath) });
    return this._ensure(normalizePath(newPath));
  }

  // ---------------------------------------------------------------- backend events
  _onBackend(name, d) {
    if (name === 'create') {
      const f = d.file.folder ? this._addFolder(d.file.path) : this._addFile(d.file);
      if (f.parent) f.parent.children.sort((a, b) => a.name.localeCompare(b.name));
      this.trigger('create', f);
      return f;
    }
    if (name === 'modify') {
      const f = this.fileMap[d.file.path];
      if (f instanceof TFile) {
        f.stat = { ctime: d.file.ctime, mtime: d.file.mtime, size: d.file.size };
        if (d.external) this._cache.delete(f.path);
        else if (!this._writing.get(f.path)) {
          // written by sk_notes itself, but not through this page (a version restored, the title
          // heading after a rename, SKAI): open editors must take the new text, and the next save
          // must not take it for a change made by another program
          const c = this._cache.get(f.path);
          if (c && d.file.mtime > c.mtime) { this._cache.delete(f.path); d.internal = true; }
        }
        this.trigger('modify', f);
      } else {
        this._onBackend('create', d);
      }
      return f;
    }
    if (name === 'delete') {
      const f = this._remove(d.file.path);
      if (f) this.trigger('delete', f);
      return f;
    }
    if (name === 'rename') {
      const f = this._move(d.oldPath, d.file.path);
      if (f) {
        if (f instanceof TFile && d.file.mtime) f.stat = { ctime: d.file.ctime, mtime: d.file.mtime, size: d.file.size };
        if (f.parent) f.parent.children.sort((a, b) => a.name.localeCompare(b.name));
        this.trigger('rename', f, d.oldPath);
        for (const p of d.updated || []) {
          const u = this.fileMap[p];
          if (u) { this._cache.delete(p); this.trigger('modify', u); }
        }
      }
      return f;
    }
    return null;
  }
}
