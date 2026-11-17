// sk_notes for Android – a vault is a normal folder of files.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// All paths given to this module are vault-relative POSIX paths ("Folder/Note.md");
// every access is checked to stay inside the vault. Files are read and written through
// the native side (java.io), like the desktop app does with Python.

import { native } from './native.js';
import { ApiError, CONFIG_DIR, IGNORED_DIRS, basename, checkName, normalizePath } from './util.js';

const FS_ERRORS = { ENOENT: 'not-found', EEXIST: 'already-exists', EACCES: 'read-only', EISDIR: 'is-a-folder', ENOTDIR: 'not-a-folder', ENOSPC: 'disk-full' };

/** Native file errors → the error codes the UI has texts for. */
export function fsCall(method, params) {
  try {
    return native.sync(method, params);
  } catch (e) {
    if (e instanceof ApiError && FS_ERRORS[e.code]) throw new ApiError(FS_ERRORS[e.code], e.detail);
    throw e;
  }
}

/** Line ending used by a text: '\r\n', '\r' or '\n' (default). */
export function eolOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const cr = (text.match(/\r/g) || []).length - crlf;
  if (crlf && crlf >= lf) return '\r\n';
  if (cr && !lf && !crlf) return '\r';
  return '\n';
}

export function entryJson(e) {
  return e.isDir ? { path: e.path, folder: true } : { path: e.path, folder: false, size: e.size, mtime: e.mtime, ctime: e.ctime };
}

export class Vault {
  constructor(root) {
    this.root = String(root).replace(/\/+$/, '') || '/';
    const st = native.sync('fs.stat', { path: this.root });
    if (!st || st.type !== 'dir') throw new ApiError('not-a-folder', this.root);
    this.protected = false; // SKAI_ Memory lives on Skorpion OS only
    this.unlocked = false;
    this.hasForeignNames = false; // names stored in another Unicode form (NFD from macOS / sync tools)
  }

  get name() { return basename(this.root); }

  get configDir() {
    const d = this.root + '/' + CONFIG_DIR;
    try { native.sync('fs.mkdirs', { path: d }); } catch { /* read-only vault: callers handle the missing folder */ }
    return d;
  }

  // ------------------------------------------------------------- paths
  abs(rel) {
    const r = normalizePath(rel);
    if (r === '/') return this.root;
    if (r.split('/').some((part) => part === '..')) throw new ApiError('outside-vault');
    const p = this.root + '/' + r;
    if (this.hasForeignNames && !native.sync('fs.exists', { path: p })) return this._onDisk(r) || p;
    return p;
  }

  /** Paths are NFC everywhere in sk_notes; find the real name of a file stored in another Unicode form. */
  _onDisk(rel) {
    let cur = this.root;
    for (const part of rel.split('/')) {
      let next = cur + '/' + part;
      if (!native.sync('fs.exists', { path: next })) {
        let names;
        try { names = native.sync('fs.list', { path: cur }); } catch { return null; }
        const match = names.find((e) => e.name.normalize('NFC') === part);
        if (!match) return null;
        next = cur + '/' + match.name;
      }
      cur = next;
    }
    return cur;
  }

  // ------------------------------------------------------------- listing
  /** Every file and folder of the vault (hidden names and sk_notes' own folders left out). */
  async scan() {
    const rows = await native.async('fs.scan', { path: this.root, ignore: IGNORED_DIRS, skipHidden: true });
    const out = [];
    let foreign = false;
    for (const [rel, isDir, size, mtime, ctime] of rows) {
      if (!isWellFormed(rel)) continue; // a broken name cannot be stored or shown
      const nfc = rel.normalize('NFC');
      if (nfc !== rel) foreign = true;
      out.push(isDir ? { path: nfc, isDir: true } : { path: nfc, isDir: false, size, mtime, ctime: ctime || mtime });
    }
    this.hasForeignNames = foreign;
    return out;
  }

  stat(rel) {
    const st = native.sync('fs.stat', { path: this.abs(rel) });
    if (!st) return null;
    const path = normalizePath(rel);
    if (st.type === 'dir') return { path, isDir: true };
    return { path, isDir: false, size: st.size, mtime: st.mtime, ctime: st.ctime || st.mtime };
  }

  exists(rel) { return native.sync('fs.exists', { path: this.abs(rel) }); }

  isDir(rel) {
    const st = native.sync('fs.stat', { path: this.abs(rel) });
    return !!st && st.type === 'dir';
  }

  listDir(rel) {
    const base = normalizePath(rel);
    const prefix = base === '/' ? '' : base + '/';
    const files = [];
    const folders = [];
    const rows = fsCall('fs.list', { path: this.abs(rel) }).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of rows) (e.type === 'dir' ? folders : files).push((prefix + e.name).normalize('NFC'));
    return { files, folders };
  }

  // ------------------------------------------------------------- read / write
  /** {text, utf8, writable, mtime, size}: bytes that are not UTF-8 are shown with replacement characters. */
  readInfo(rel) { return fsCall('fs.readText', { path: this.abs(rel) }); }

  readText(rel) { return this.readInfo(rel).text; }

  readB64(rel) { return fsCall('fs.readB64', { path: this.abs(rel) }); }

  _checkNames(rel) {
    for (const part of normalizePath(rel).split('/')) checkName(part);
  }

  /** Write text with the line endings the file already has on disk (CRLF/CR vaults). */
  writeTextKeepEol(rel, text, mtime) {
    let out = text;
    let eol = '\n';
    try {
      const head = native.sync('fs.readText', { path: this.abs(rel), max: 65536 });
      eol = eolOf(head.text);
    } catch { /* new file */ }
    if (eol !== '\n') out = out.replace(/\r\n/g, '\n').replace(/\n/g, eol);
    return this.writeText(rel, out, mtime);
  }

  writeText(rel, text, mtime) {
    this._checkNames(rel);
    fsCall('fs.writeText', { path: this.abs(rel), text, mtime: mtime || 0 }); // atomic on the native side
    return this.stat(rel);
  }

  writeB64(rel, b64, mtime) {
    this._checkNames(rel);
    fsCall('fs.writeB64', { path: this.abs(rel), b64, mtime: mtime || 0 });
    return this.stat(rel);
  }

  mkdir(rel) {
    this._checkNames(rel);
    fsCall('fs.mkdirs', { path: this.abs(rel) });
  }

  rename(oldRel, newRel) {
    const src = this.abs(oldRel);
    const dst = this.abs(newRel);
    if (!native.sync('fs.exists', { path: src })) throw new ApiError('not-found');
    this._checkNames(newRel);
    if (dst === src || dst.startsWith(src + '/')) {
      const st = native.sync('fs.stat', { path: src });
      if (st?.type === 'dir' && dst !== src) throw new ApiError('into-itself');
    }
    // the native side handles renames that only change the letter case
    fsCall('fs.rename', { from: src, to: dst });
  }

  copy(oldRel, newRel) {
    const dst = this.abs(newRel);
    if (native.sync('fs.exists', { path: dst })) throw new ApiError('already-exists');
    this._checkNames(newRel);
    fsCall('fs.copy', { from: this.abs(oldRel), to: dst });
  }

  deletePermanently(rel) {
    fsCall('fs.delete', { path: this.abs(rel), recursive: true });
  }

  /** First free 'base.ext', 'base 1.ext', 'base 2.ext' ... inside folder. */
  availablePath(folder, base, ext) {
    const f = normalizePath(folder) === '/' ? '' : normalizePath(folder) + '/';
    const dot = ext ? `.${ext}` : '';
    let candidate = `${f}${base}${dot}`;
    let n = 1;
    while (this.exists(candidate)) {
      candidate = `${f}${base} ${n}${dot}`;
      n += 1;
    }
    return candidate;
  }
}

function isWellFormed(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
