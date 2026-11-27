// Notes in folders like a tree: a note linked from a "mother" note goes into a folder named
// after the mother, beside it; the notes it links to go one folder deeper, and so on.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
//   Maths.md  links to [[Derivatives]], which links to [[Limits]]
//   →  Maths.md, Maths/Derivatives.md, Maths/Derivatives/Limits.md
//
// A setting (Files and links), off unless the user turns it on; when it is on, the vault is put in
// order again a few seconds after links change. Mothers are the notes no other note links to; a
// note linked from several notes goes under the one nearest to a mother. Notes in a loop of links
// with no mother, and notes whose place is taken by another file, stay where they are. Moving a
// note updates the links to it (the same as moving it by hand).

import { t, errorText } from '../core/i18n.js';
import { debounce } from '../core/util.js';
import { confirmDialog } from '../ui/kit.js';

const SKIP = /^(\.trash|\.sk_notes|\.obsidian|\.git)(\/|$)/;

/** The moves that put the vault in tree order: [{ file, to }], mothers' children first. */
export function planTree(app) {
  const mc = app.metadataCache;
  const notes = app.vault.getMarkdownFiles().filter((f) => !SKIP.test(f.path));
  const known = new Set(notes.map((f) => f.path));
  const kids = new Map();
  const incoming = new Map(notes.map((f) => [f.path, 0]));
  for (const f of notes) {
    const out = Object.keys(mc.resolvedLinks[f.path] || {}).filter((p) => known.has(p) && p !== f.path).sort();
    kids.set(f.path, out);
    for (const p of out) incoming.set(p, incoming.get(p) + 1);
  }
  const roots = notes.filter((f) => incoming.get(f.path) === 0 && kids.get(f.path).length).map((f) => f.path).sort();
  const parent = new Map();
  const depth = new Map(roots.map((r) => [r, 0]));
  const queue = [...roots];
  while (queue.length) {
    const p = queue.shift();
    for (const c of kids.get(p) || []) {
      if (depth.has(c)) continue;
      depth.set(c, depth.get(p) + 1);
      parent.set(c, p);
      queue.push(c);
    }
  }
  // where every note of the tree goes: a mother stays; a child goes into "<mother's folder>/<mother's name>/"
  const place = new Map(roots.map((r) => [r, r]));
  const order = [...depth.keys()].sort((a, b) => depth.get(a) - depth.get(b));
  const taken = new Set(app.vault.getFiles().map((f) => f.path));
  const moves = [];
  for (const path of order) {
    if (place.has(path)) continue;
    const mom = place.get(parent.get(path));
    const momFolder = mom.includes('/') ? mom.slice(0, mom.lastIndexOf('/')) : '';
    const momName = mom.slice(mom.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const name = path.slice(path.lastIndexOf('/') + 1);
    const to = `${momFolder ? momFolder + '/' : ''}${momName}/${name}`;
    if (to === path) { place.set(path, path); continue; }
    if (taken.has(to)) { place.set(path, path); continue; } // another file is there: this note stays
    taken.delete(path);
    taken.add(to);
    place.set(path, to);
    moves.push({ file: app.vault.getFileByPath(path), from: path, to });
  }
  return moves.filter((m) => m.file);
}

/** Move the notes; returns how many were moved. */
export async function applyTree(app, moves) {
  let done = 0;
  for (const m of moves) {
    const file = app.vault.getFileByPath(m.from);
    if (!file || app.vault.getAbstractFileByPath(m.to)) continue;
    const folder = m.to.slice(0, m.to.lastIndexOf('/'));
    try {
      if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder).catch(() => {});
      await app.fileManager.renameFile(file, m.to);
      done += 1;
    } catch (e) { app.notice(`${file.name}: ${errorText(e)}`); }
  }
  return done;
}

/** Show what would move and ask; true when the user agreed (or nothing had to move). */
export async function confirmTree(app, moves) {
  if (!moves.length) { app.notice(t('tree.nothing')); return true; }
  const list = moves.slice(0, 8).map((m) => `${m.from}  →  ${m.to}`).join('\n') + (moves.length > 8 ? `\n… (+${moves.length - 8})` : '');
  return confirmDialog(app, { title: t('tree.confirm-title', { n: moves.length }), message: `${t('tree.confirm-text')}\n\n${list}`, confirm: t('tree.confirm') });
}

export function registerTreeFolders(app) {
  let busy = false;
  const run = async () => {
    if (busy || !app.settings.get('treeFolders') || app.info?.vault?.protected) return;
    busy = true;
    try {
      const moves = planTree(app);
      if (moves.length) {
        const n = await applyTree(app, moves);
        if (n) app.notice(t('tree.moved', { n }));
      }
    } finally { busy = false; }
  };
  const later = debounce(run, 4000, true);
  app.workspace.onLayoutReady(() => {
    app.metadataCache.on('resolved', () => { if (app.settings.get('treeFolders')) later(); });
    if (app.settings.get('treeFolders')) later();
  });
  app.treeFolders = { plan: () => planTree(app), apply: (m) => applyTree(app, m), confirm: (m) => confirmTree(app, m), run };
}
