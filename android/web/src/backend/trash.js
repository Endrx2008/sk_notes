// sk_notes for Android – deleting files, and the trash.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Android has no trash for ordinary files, so "system trash" means the vault's own
// .trash folder here (the same fallback the desktop app uses when the system trash
// cannot take a file); "permanent" deletes at once.
//
// The trash keeps what was deleted for three months. When and from where each file came is
// written in .trash/.skn-trash.json (beside the files, so it goes where the folder goes).
// A file put in .trash by another app (Obsidian) counts from the day sk_notes first sees it.
// Older files are removed for good when the vault opens and whenever the trash is shown.

import { native } from './native.js';
import { fsCall } from './vault.js';
import { ApiError, basename, normalizePath } from './util.js';

export const KEEP_MS = 90 * 24 * 60 * 60 * 1000; // three months
const LOG = '.skn-trash.json';

const trashDir = (vault) => vault.root + '/.trash';

function unique(dir, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  let candidate = `${dir}/${name}`;
  let n = 1;
  while (native.sync('fs.exists', { path: candidate })) {
    const name = ext ? `${stem} ${n}.${ext}` : `${stem} ${n}`;
    candidate = `${dir}/${name}`;
    n += 1;
  }
  return candidate;
}

function readLog(vault) {
  try {
    const v = JSON.parse(native.sync('fs.readText', { path: `${trashDir(vault)}/${LOG}` }).text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeLog(vault, log) {
  try {
    native.sync('fs.mkdirs', { path: trashDir(vault) });
    native.sync('fs.writeText', { path: `${trashDir(vault)}/${LOG}`, text: JSON.stringify(log, null, 1) });
  } catch { /* read-only vault: dates are guessed again next time */ }
}

export function toLocalTrash(vault, rel) {
  const src = vault.abs(rel);
  const trash = trashDir(vault);
  fsCall('fs.mkdirs', { path: trash });
  const dest = unique(trash, basename(src));
  fsCall('fs.rename', { from: src, to: dest });
  const name = basename(dest);
  const log = readLog(vault);
  log[name] = { from: normalizePath(rel), at: Date.now() };
  writeLog(vault, log);
  return name;
}

/** mode: 'system' | 'local' | 'permanent'. Returns the mode actually used. */
export function deleteFile(vault, rel, mode) {
  if (mode === 'system' || mode === 'local') {
    toLocalTrash(vault, rel);
    return 'local';
  }
  vault.deletePermanently(rel);
  return 'permanent';
}

function checkTrashName(name) {
  const n = String(name || '');
  if (!n || n === LOG || n.includes('/') || n === '.' || n === '..') throw new ApiError('not-found');
  return n;
}

/** What is in the trash now, newest first: [{name, from, at, folder, size}]. Removes what is older than three months. */
export function listTrash(vault, now = Date.now()) {
  let rows;
  try { rows = native.sync('fs.list', { path: trashDir(vault) }); } catch { return []; } // no trash yet
  const log = readLog(vault);
  const next = {};
  const out = [];
  let changed = false;
  for (const e of rows) {
    if (e.name === LOG) continue;
    let entry = log[e.name];
    if (!entry || typeof entry.at !== 'number') { entry = { from: entry?.from || e.name, at: now }; changed = true; }
    if (now - entry.at > KEEP_MS) {
      try { fsCall('fs.delete', { path: `${trashDir(vault)}/${e.name}`, recursive: true }); changed = true; continue; } catch { /* kept for now */ }
    }
    next[e.name] = entry;
    out.push({ name: e.name, from: entry.from || e.name, at: entry.at, folder: e.type === 'dir', size: e.size || 0 });
  }
  if (changed || Object.keys(log).length !== Object.keys(next).length) writeLog(vault, next);
  out.sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : 1));
  return out;
}

/** Put a file back where it was (under another name when that place is taken). Returns its path in the vault. */
export function restoreFromTrash(vault, rawName) {
  const name = checkTrashName(rawName);
  const src = `${trashDir(vault)}/${name}`;
  if (!native.sync('fs.exists', { path: src })) throw new ApiError('not-found');
  const log = readLog(vault);
  let rel = normalizePath(log[name]?.from || name);
  if (rel === '/' || rel.split('/').some((p) => p === '..' || p === '.trash')) rel = name;
  const slash = rel.lastIndexOf('/');
  const folder = slash > 0 ? rel.slice(0, slash) : '';
  const parentAbs = folder ? vault.abs(folder) : vault.root;
  fsCall('fs.mkdirs', { path: parentAbs });
  const dest = unique(parentAbs, basename(rel));
  fsCall('fs.rename', { from: src, to: dest });
  delete log[name];
  writeLog(vault, log);
  return (folder ? folder + '/' : '') + basename(dest);
}

/** Remove one file of the trash for good; without a name, all of them. */
export function purgeTrash(vault, rawName = null) {
  const log = readLog(vault);
  if (rawName === null) {
    for (const e of listTrash(vault)) {
      try { fsCall('fs.delete', { path: `${trashDir(vault)}/${e.name}`, recursive: true }); delete log[e.name]; } catch { /* left */ }
    }
  } else {
    const name = checkTrashName(rawName);
    fsCall('fs.delete', { path: `${trashDir(vault)}/${name}`, recursive: true });
    delete log[name];
  }
  writeLog(vault, log);
  return true;
}
