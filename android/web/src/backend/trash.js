// sk_notes for Android – deleting files.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Android has no trash for ordinary files, so "system trash" means the vault's own
// .trash folder here (the same fallback the desktop app uses when the system trash
// cannot take a file); "permanent" deletes at once.

import { native } from './native.js';
import { fsCall } from './vault.js';
import { basename } from './util.js';

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

export function toLocalTrash(vault, rel) {
  const src = vault.abs(rel);
  const trash = vault.root + '/.trash';
  fsCall('fs.mkdirs', { path: trash });
  const dest = unique(trash, basename(src));
  fsCall('fs.rename', { from: src, to: dest });
  return basename(dest);
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
