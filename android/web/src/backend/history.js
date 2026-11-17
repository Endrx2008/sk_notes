// sk_notes for Android – version history and file recovery.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Snapshots are copies of a note kept in the app's private storage (not in the vault:
// nothing extra is synced). A snapshot is taken at most every `interval` seconds per
// file while editing, and always before destructive operations (delete, rename, AI
// edits, external overwrite). Identical content is never stored twice in a row.

import { native } from './native.js';
import { sha1, utf8Length } from './util.js';

export class History {
  /** dir: folder for this vault's snapshots, or null to keep them for this run only. */
  constructor(dir, { interval = 300, keepDays = 30, keepPerFile = 100 } = {}) {
    this.dir = dir;
    this.interval = interval;
    this.keepDays = keepDays;
    this.keepPerFile = keepPerFile;
    this.rows = []; // {id, path, ts (ms), hash, reason, size}
    this.nextId = 1;
    this.memory = new Map(); // id → text when there is no folder
    this._load();
  }

  _load() {
    if (!this.dir) return;
    try {
      native.sync('fs.mkdirs', { path: this.dir });
      const st = native.sync('fs.stat', { path: this.dir + '/index.json' });
      if (!st) return;
      const data = JSON.parse(native.sync('fs.readText', { path: this.dir + '/index.json' }).text);
      if (data && Array.isArray(data.rows)) {
        this.rows = data.rows.filter((r) => r && typeof r.id === 'number' && typeof r.path === 'string');
        this.nextId = Math.max(data.nextId || 1, ...this.rows.map((r) => r.id + 1), 1);
      }
    } catch (e) {
      console.warn('history index unreadable, starting a new one', e);
      this.rows = [];
    }
  }

  _save() {
    if (!this.dir) return;
    try { native.sync('fs.writeText', { path: this.dir + '/index.json', text: JSON.stringify({ nextId: this.nextId, rows: this.rows }) }); } catch (e) { console.warn('history index not written', e); }
  }

  _file(id) { return `${this.dir}/${id}.txt`; }

  _drop(rows) {
    for (const r of rows) {
      if (this.dir) { try { native.sync('fs.delete', { path: this._file(r.id), recursive: false }); } catch { /* already gone */ } }
      this.memory.delete(r.id);
    }
  }

  snapshot(path, text, { reason = 'edit', force = false } = {}) {
    const digest = sha1(text);
    const now = Date.now();
    let last = null;
    for (const r of this.rows) if (r.path === path && (!last || r.ts > last.ts)) last = r;
    if (last && last.hash === digest) return false;
    if (last && !force && now - last.ts < this.interval * 1000) return false;
    const row = { id: this.nextId++, path, ts: now, hash: digest, reason, size: utf8Length(text) };
    if (this.dir) {
      try { native.sync('fs.writeText', { path: this._file(row.id), text }); } catch (e) { console.warn('snapshot not written', e); return false; }
    } else this.memory.set(row.id, text);
    this.rows.push(row);
    this._prune(path);
    this._save();
    return true;
  }

  _prune(path) {
    const mine = this.rows.filter((r) => r.path === path).sort((a, b) => b.ts - a.ts);
    const cutoff = Date.now() - this.keepDays * 86400000;
    const drop = new Set();
    mine.forEach((r, i) => { if ((i >= 5 && r.ts < cutoff) || i >= this.keepPerFile) drop.add(r.id); });
    if (!drop.size) return;
    this._drop(this.rows.filter((r) => drop.has(r.id)));
    this.rows = this.rows.filter((r) => !drop.has(r.id));
  }

  has(path) { return this.rows.some((r) => r.path === path); }

  list(path) {
    return this.rows.filter((r) => r.path === path).sort((a, b) => b.ts - a.ts).map((r) => ({ id: r.id, ts: r.ts, reason: r.reason, size: r.size }));
  }

  /** All paths with snapshots (deleted files too) for the recovery view. */
  files() {
    const by = new Map();
    for (const r of this.rows) {
      const cur = by.get(r.path) || { path: r.path, ts: 0, count: 0 };
      cur.ts = Math.max(cur.ts, r.ts);
      cur.count += 1;
      by.set(r.path, cur);
    }
    return [...by.values()].sort((a, b) => b.ts - a.ts);
  }

  read(id) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    if (!this.dir) return this.memory.get(id) ?? null;
    try { return native.sync('fs.readText', { path: this._file(id) }).text; } catch { return null; }
  }

  rename(oldPath, newPath) {
    let changed = false;
    for (const r of this.rows) {
      if (r.path === oldPath || r.path.startsWith(oldPath + '/')) {
        r.path = newPath + r.path.slice(oldPath.length);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  close() {}
}
