// sk_notes for Android – VaultService: the single entry point for vault operations.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// It keeps the files, the index, the version history and the UI in step and emits an
// event (emit(name, payload)) for every change, whether made by sk_notes or by another
// app (a sync tool, a file manager). Same behaviour as the desktop service.

import { History } from './history.js';
import * as links from './links.js';
import { native } from './native.js';
import { deleteFile, listTrash } from './trash.js';
import { ApiError, CONFIG_DIR, TEXT_EXT, extOf, normalizePath, sha1 } from './util.js';
import { Vault, entryJson } from './vault.js';
import { MetaStore, VaultIndex } from './vindex.js';

export class VaultService {
  /** dataDir: private folder of the app for this vault (metadata cache, history), or null. */
  constructor(root, emit, dataDir = null) {
    this.vault = new Vault(root);
    this.emit = emit || (() => {});
    this.dataDir = dataDir;
    this.index = new VaultIndex(this.vault, new MetaStore(dataDir ? dataDir + '/cache' : null));
    this.history = new History(dataDir ? dataDir + '/history' : null);
    this.recoveredRename = null;
  }

  // ------------------------------------------------------------- lifecycle
  async open(progress) {
    this.recoveredRename = this._recoverRename();
    try { listTrash(this.vault); } catch { /* the trash is tidied next time */ } // gone for good after three months
    return this.index.sync(progress);
  }

  close() { this.history.close(); }

  // ------------------------------------------------------------- config files
  configRead(name, fallback = null) {
    try {
      const data = JSON.parse(native.sync('fs.readText', { path: this.vault.configDir + '/' + name }).text);
      return data === undefined ? fallback : data;
    } catch { return fallback; }
  }

  configWrite(name, data) {
    const p = this.vault.configDir + '/' + name;
    native.sync('fs.mkdirs', { path: p.slice(0, p.lastIndexOf('/')) });
    native.sync('fs.writeText', { path: p, text: JSON.stringify(data, null, 2) });
  }

  appSetting(key, fallback = null) {
    const cfg = this.configRead('app.json', {}) || {};
    return cfg[key] === undefined ? fallback : cfg[key];
  }

  _entry(path) {
    const e = this.vault.stat(path);
    return e ? entryJson(e) : { path };
  }

  // ------------------------------------------------------------- read/write
  read(rawPath) {
    const path = normalizePath(rawPath);
    const st = this.vault.stat(path);
    if (st === null || st.isDir) throw new ApiError('not-found');
    const info = this.vault.readInfo(path);
    const out = { text: info.text, mtime: st.mtime, size: st.size };
    // an editor must not save these back: the text is lossy, or the file read-only
    if (TEXT_EXT.has(extOf(path))) out.readOnly = !info.utf8 ? 'not-utf8' : (info.writable ? null : 'read-only');
    return out;
  }

  /** Write a text file. With expectedMtime, refuse (conflict) if the file was changed on
   * disk by someone else since it was read: no silent overwrite. */
  write(rawPath, text, { expectedMtime = null, reason = 'edit', mtime = null } = {}) {
    const path = normalizePath(rawPath);
    const st = this.vault.stat(path);
    const isText = TEXT_EXT.has(extOf(path));
    if (st !== null && st.isDir) throw new ApiError('is-a-folder');
    let info = null;
    if (st !== null && isText) { try { info = this.vault.readInfo(path); } catch { info = null; } }
    if (expectedMtime !== null && expectedMtime !== undefined && st !== null && Math.abs(st.mtime - expectedMtime) > 2) {
      const disk = info ? info.text : this.vault.readText(path);
      if (disk !== text) {
        this.history.snapshot(path, disk, { reason: 'external', force: true });
        return { conflict: true, text: disk, mtime: st.mtime };
      }
    }
    const isNew = st === null;
    // its text was decoded with replacement characters: writing it back would destroy
    // the original bytes (Latin-1 notes, binaries named .md)
    if (info && !info.utf8) throw new ApiError('not-utf8');
    if (info && reason !== 'edit') this.history.snapshot(path, info.text, { reason, force: true });
    // Editing: what is about to be replaced is kept (at most one version every few minutes),
    // so the note as it was before a round of changes is always there to go back to, and so
    // is the note as sk_notes first found it. The newest text is the note itself.
    else if (info && isText) this.history.snapshot(path, info.text, { reason: this.history.has(path) ? 'edit' : 'original', force: !this.history.has(path) });
    const entry = this.vault.writeTextKeepEol(path, text, mtime);
    if (isText && st === null) this.history.snapshot(path, text, { reason: 'edit' });
    const meta = this.index.update(path, text);
    this.emit(isNew ? 'create' : 'modify', { file: entryJson(entry), metadata: meta, ...this._linksPayload(isNew ? null : [path]) });
    return { file: entryJson(entry) };
  }

  writeBinary(rawPath, b64) {
    const path = normalizePath(rawPath);
    const isNew = !this.vault.exists(path);
    const entry = this.vault.writeB64(path, b64);
    this.index.update(path);
    this.emit(isNew ? 'create' : 'modify', { file: entryJson(entry), metadata: null });
    return { file: entryJson(entry) };
  }

  create(rawPath, text = '') {
    const path = normalizePath(rawPath);
    if (this.vault.exists(path)) throw new ApiError('already-exists');
    return this.write(path, text);
  }

  mkdir(rawPath) {
    const path = normalizePath(rawPath);
    const existed = this.vault.exists(path);
    this.vault.mkdir(path);
    this.index.folders.add(path);
    this.index._addParentFolders(path + '/x');
    if (!existed) this.emit('create', { file: { path, folder: true } });
    return { file: { path, folder: true } };
  }

  // ------------------------------------------------------------- rename / move
  rename(rawOld, rawNew, { updateLinks = null } = {}) {
    const old = normalizePath(rawOld);
    const dest = normalizePath(rawNew);
    if (old === '/' || dest === '/') throw new ApiError('vault-root');
    if (old === dest) return { path: dest, updated: [] };
    const doLinks = updateLinks === null || updateLinks === undefined ? this.appSetting('alwaysUpdateLinks', true) : updateLinks;
    const index = this.index;
    const srcIsDir = this.vault.isDir(old);
    const moved = new Map();
    for (const p of index.files.keys()) if (p === old || p.startsWith(old + '/')) moved.set(p, dest + p.slice(old.length));
    const refs = doLinks ? links.collectReferences(index, moved) : new Map();
    for (const p of moved.keys()) {
      if (TEXT_EXT.has(extOf(p))) { try { this.history.snapshot(p, this.vault.readText(p), { reason: 'rename', force: true }); } catch { /* unreadable: moved as it is */ } }
    }
    // journal: a crash between the move and the end of the link updates must not leave
    // broken links behind; see _recoverRename()
    this._journal({ phase: 'move', old, new: dest });
    try {
      this.vault.rename(old, dest);
    } catch (e) {
      this._journal(null);
      throw e;
    }
    index.rename(old, dest);
    this.history.rename(old, dest);
    // every rewrite is planned in memory first, then journaled, then written
    const plan = []; // {path, before, after, counts}
    const planned = new Map();
    for (const [a, b] of moved) {
      if (extOf(b) !== 'md') continue; // a moved note keeps its own relative Markdown links working
      const text = this._editableText(b);
      if (text === null) continue;
      const fixed = links.relinkMovedNote(text, a, b, index);
      if (fixed !== text) {
        const entry = { path: b, before: text, after: fixed, counts: false };
        plan.push(entry);
        planned.set(b, entry);
      }
    }
    for (const [src, items] of refs) {
      const srcNow = moved.get(src) || src;
      const prev = planned.get(srcNow);
      const text = prev ? prev.after : this._editableText(srcNow);
      if (text === null) continue;
      const next = links.applyRewrites(text, items, index, srcNow);
      if (next !== text) {
        if (prev) {
          prev.after = next;
          prev.counts = true;
        } else {
          const entry = { path: srcNow, before: text, after: next, counts: true };
          plan.push(entry);
          planned.set(srcNow, entry);
        }
      }
    }
    if (doLinks) {
      for (const src of [...index.files.keys()].filter((p) => extOf(p) === 'canvas')) {
        const text = this._editableText(src);
        if (text === null) continue;
        const next = links.relinkCanvas(text, moved);
        if (next !== null) plan.push({ path: src, before: text, after: next, counts: true });
      }
    }
    this._journal({ phase: 'write', old, new: dest, writes: plan.map((w) => ({ path: w.path, sha: sha1(w.before), text: w.after })) });
    const updated = [];
    for (const w of plan) {
      if (this._rewrite(w.path, w.before, w.after, w.counts)) {
        index.update(w.path, w.after);
        if (w.counts) updated.push(w.path);
      }
    }
    this._journal(null);
    const metadata = {};
    for (const p of new Set([...updated, ...moved.values()])) if (p in index.meta) metadata[p] = index.meta[p];
    this.emit('rename', {
      oldPath: old,
      file: srcIsDir ? { path: dest, folder: true } : this._entry(dest),
      moved: [...moved.entries()],
      updated,
      metadata,
      ...this._linksPayload(null),
    });
    return { path: dest, updated };
  }

  // ------------------------------------------------------------- rename journal
  _journalPath() { return this.vault.configDir + '/rename-journal.json'; }

  _journal(data) {
    const p = this._journalPath();
    try {
      if (data === null) native.sync('fs.delete', { path: p, recursive: false });
      else native.sync('fs.writeText', { path: p, text: JSON.stringify(data) });
    } catch (e) {
      if (data !== null) console.warn('rename journal not written', e); // read-only vault: rename without a safety net
    }
  }

  /** Finish or undo a rename that a crash interrupted. 'undone' if the files were moved
   * back, 'completed' if the planned link updates were written now, null otherwise. */
  _recoverRename() {
    let data;
    try {
      if (!native.sync('fs.exists', { path: this._journalPath() })) return null;
      data = JSON.parse(native.sync('fs.readText', { path: this._journalPath() }).text);
    } catch { data = undefined; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { // damaged or planted: drop it
      this._journal(null);
      return null;
    }
    let result = null;
    try {
      const { old, new: dest } = data;
      if (typeof old !== 'string' || typeof dest !== 'string') throw new ApiError('bad-journal');
      if (data.phase === 'move') {
        if (this.vault.exists(dest) && !this.vault.exists(old)) {
          this.vault.rename(dest, old);
          result = 'undone';
        }
      } else if (data.phase === 'write') {
        for (const w of Array.isArray(data.writes) ? data.writes : []) {
          let cur;
          try {
            const info = this.vault.readInfo(w.path);
            if (!info.utf8) continue;
            cur = info.text;
          } catch { continue; }
          if (sha1(cur) === w.sha) this.vault.writeText(w.path, w.text); // not written yet, not changed by anyone since
        }
        result = 'completed';
      }
    } catch (e) { console.error('could not recover an interrupted rename', e); }
    this._journal(null);
    return result;
  }

  /** Text of a file that may be rewritten automatically (link updates): null for
   * unreadable, read-only or non-UTF-8 files, which are left alone. */
  _editableText(path) {
    try {
      const info = this.vault.readInfo(path);
      return info.utf8 && info.writable ? info.text : null;
    } catch { return null; }
  }

  /** Automatic rewrite of one file; a failure skips that file instead of aborting. */
  _rewrite(path, before, after, snapshot = true) {
    try {
      if (snapshot) this.history.snapshot(path, before, { reason: 'link-update', force: true });
      this.vault.writeText(path, after);
      return true;
    } catch (e) {
      console.warn('could not update links in', path, e);
      return false;
    }
  }

  async copy(rawOld, rawNew) {
    const old = normalizePath(rawOld);
    const dest = normalizePath(rawNew);
    if (old === '/' || dest === '/') throw new ApiError('vault-root');
    if (dest.startsWith(old + '/')) throw new ApiError('into-itself');
    this.vault.copy(old, dest);
    if (this.vault.isDir(dest)) {
      await this.index.sync();
      this.emit('refresh', this.index.snapshot());
    } else {
      const meta = this.index.update(dest);
      this.emit('create', { file: this._entry(dest), metadata: meta, ...this._linksPayload(null) });
    }
    return { path: dest };
  }

  // ------------------------------------------------------------- delete
  delete(rawPath, { mode = null } = {}) {
    const path = normalizePath(rawPath);
    if (path === '/') throw new ApiError('vault-root'); // an empty folder setting must never delete the whole vault
    const how = mode || this.appSetting('trashOption', 'system');
    const targets = [...this.index.files.keys()].filter((p) => p === path || p.startsWith(path + '/'));
    for (const p of targets) {
      if (TEXT_EXT.has(extOf(p))) { try { this.history.snapshot(p, this.vault.readText(p), { reason: 'delete', force: true }); } catch { /* unreadable */ } }
    }
    const wasDir = this.vault.isDir(path);
    const used = deleteFile(this.vault, path, how);
    const gone = this.index.remove(path);
    this.emit('delete', { file: { path, folder: wasDir }, removed: gone, ...this._linksPayload(null) });
    return { mode: used, removed: gone };
  }

  restoreSnapshot(rawPath, snapId) {
    const text = this.history.read(snapId);
    if (text === null) throw new ApiError('not-found');
    const path = normalizePath(rawPath);
    if (this.vault.exists(path)) this.history.snapshot(path, this.vault.readText(path), { reason: 'restore', force: true });
    return this.write(path, text, { reason: 'restore' });
  }

  // ------------------------------------------------------------- external changes
  /** Called for changes not made by sk_notes (file observer, another app). */
  externalChange(rawPath) {
    const path = normalizePath(rawPath);
    if (path === '/' || path === CONFIG_DIR || path.startsWith(CONFIG_DIR + '/')) return;
    const index = this.index;
    let st;
    try { st = this.vault.stat(path); } catch { return; }
    if (st === null) {
      if (index.files.has(path) || index.folders.has(path)) {
        const wasDir = index.folders.has(path);
        const gone = index.remove(path);
        this.emit('delete', { file: { path, folder: wasDir }, removed: gone, ...this._linksPayload(null) });
      }
      return;
    }
    if (st.isDir) {
      if (!index.folders.has(path)) this.rescan();
      return;
    }
    const known = index.files.get(path);
    if (known && known.mtime === st.mtime && known.size === st.size) return; // our own write
    const meta = index.update(path);
    if (TEXT_EXT.has(extOf(path))) { try { this.history.snapshot(path, this.vault.readText(path), { reason: 'external', force: true }); } catch { /* unreadable */ } }
    this.emit(known ? 'modify' : 'create', { file: entryJson(st), metadata: meta, external: true, ...this._linksPayload(known ? [path] : null) });
  }

  /** Look at the whole vault again (app brought to the front, sync finished, pull to refresh). */
  async rescan() {
    if (this._rescanning) { this._rescanAgain = true; return this._rescanning; }
    this._rescanning = (async () => {
      try {
        do {
          this._rescanAgain = false;
          const stats = await this.index.sync();
          if (stats.changed || stats.removed) this.emit('refresh', this.index.snapshot());
        } while (this._rescanAgain);
      } finally { this._rescanning = null; }
    })();
    return this._rescanning;
  }

  // ------------------------------------------------------------- misc
  /** Link maps to send after a change: the full maps when names changed (create, rename,
   * delete: other notes may resolve differently), otherwise the entries of the changed notes. */
  _linksPayload(paths) {
    if (paths === null) return { resolvedLinks: this.index.resolved, unresolvedLinks: this.index.unresolved };
    const resolvedPatch = {};
    const unresolvedPatch = {};
    for (const p of paths) {
      resolvedPatch[p] = this.index.resolved[p] || {};
      unresolvedPatch[p] = this.index.unresolved[p] || {};
    }
    return { resolvedPatch, unresolvedPatch };
  }
}
