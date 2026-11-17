// sk_notes for Android – link text generation and link rewriting after renames/moves.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import * as parser from './parser.js';
import { basenameNoExt, dirname, extOf, normpath, quote, relpath, unquote } from './util.js';

/** Shortest link path that resolves to `target` from `source`. */
export function linkpathFor(index, target, source, preferFull = false) {
  const isMd = extOf(target) === 'md';
  const noExt = isMd ? target.slice(0, -3) : target;
  if (!preferFull) {
    const short = isMd ? basenameNoExt(target) : target.slice(target.lastIndexOf('/') + 1);
    if (index.resolve(short, source) === target) return short;
  }
  return noExt;
}

export function markdownUrlFor(target, source, relative) {
  const path = relative ? relpath(target, dirname(source) || '.') : target;
  return quote(path, '/#^');
}

const WIKI_INNER_RE = /^(!?)\[\[([^\]|]*)(\|[^\]]*)?\]\]$/;
const MD_RE = /^(!?)\[([\s\S]*)\]\(\s*(<[^>]*>|[^\s)]*)(\s+["'][^"']*["'])?\s*\)$/;

/** The reference text pointing to `newTarget`, keeping alias, subpath and style; null if unknown. */
export function rewriteReference(original, newTarget, index, source) {
  let m = WIKI_INNER_RE.exec(original);
  if (m) {
    const [, bang, linktext, alias = ''] = m;
    const [oldPath, subpath] = parser.parseLinktext(linktext);
    let lp = linkpathFor(index, newTarget, source, oldPath.includes('/'));
    if (extOf(oldPath) === 'md' && extOf(newTarget) === 'md') lp += '.md';
    return `${bang}[[${lp}${subpath}${alias}]]`;
  }
  m = MD_RE.exec(original);
  if (m) {
    const [, bang, text, dest, title = ''] = m;
    const bracketed = dest.startsWith('<');
    const raw = unquote(bracketed ? dest.slice(1, -1) : dest);
    const hash = raw.indexOf('#');
    const pathPart = hash === -1 ? raw : raw.slice(0, hash);
    const frag = hash === -1 ? '' : raw.slice(hash + 1);
    const relative = !index.files.has(pathPart) && !pathPart.startsWith('/');
    let url = markdownUrlFor(newTarget, source, relative && source.includes('/'));
    if (frag) url += '#' + quote(frag, '^');
    if (bracketed) url = '<' + url.replaceAll('%20', ' ') + '>';
    return `${bang}[${text}](${url}${title})`;
  }
  return null;
}

/** Before a rename: for every note, the references whose resolved target is one of the
 * moved files → Map(source → [[entry, newTarget]]). `moved` is a Map(old → new). */
export function collectReferences(index, moved) {
  const out = new Map();
  const sources = new Set();
  for (const old of moved.keys()) for (const s of index.backlinks.get(old) || []) sources.add(s);
  for (const src of sources) {
    const meta = index.meta[src] || {};
    for (const list of [[...(meta.links || []), ...(meta.embeds || [])], meta.frontmatterLinks || []]) {
      for (const ref of list) {
        const target = parser.parseLinktext(ref.link)[0];
        const dest = target ? index.resolve(target, src) : null;
        if (dest !== null && moved.has(dest)) {
          if (!out.has(src)) out.set(src, []);
          out.get(src).push([ref, moved.get(dest)]);
        }
      }
    }
  }
  return out;
}

/** Rewrite the given references in `text` (positions from metadata; frontmatter links
 * have no position and are replaced by their original text inside the YAML). */
export function applyRewrites(text, refs, index, source) {
  let out = text;
  const positioned = refs.filter(([r]) => r.position).sort((x, y) => y[0].position.start.offset - x[0].position.start.offset);
  const floating = refs.filter(([r]) => !r.position);
  for (const [ref, newTarget] of positioned) {
    let a = ref.position.start.offset;
    let b = ref.position.end.offset;
    if (out.slice(a, b) !== ref.original) {
      const idx = out.indexOf(ref.original); // file changed since it was parsed: search for the text
      if (idx === -1) continue;
      a = idx;
      b = idx + ref.original.length;
    }
    const repl = rewriteReference(ref.original, newTarget, index, source);
    if (repl !== null) out = out.slice(0, a) + repl + out.slice(b);
  }
  if (floating.length) {
    const [yamlText, , end] = parser.splitFrontmatter(out);
    if (yamlText !== null) {
      let head = out.slice(0, end);
      for (const [ref, newTarget] of floating) {
        const repl = rewriteReference(ref.original, newTarget, index, source);
        if (repl) head = head.replaceAll(ref.original, repl);
      }
      out = head + out.slice(end);
    }
  }
  return out;
}

/** A note moved to another folder: fix its own *relative* Markdown links. */
export function relinkMovedNote(text, oldPath, newPath, index) {
  if (dirname(oldPath) === dirname(newPath)) return text;
  // positions refer to the text with \n line ends, like every other rewrite
  const meta = parser.parse(text);
  const refs = [];
  for (const ref of [...(meta.links || []), ...(meta.embeds || [])]) {
    if (!MD_RE.test(ref.original)) continue;
    const target = parser.parseLinktext(ref.link)[0];
    if (index.files.has(target)) continue; // absolute vault path: still valid
    const joined = dirname(oldPath) ? dirname(oldPath) + '/' + target : target;
    const oldAbs = target.startsWith('/') ? normpath(target) : normpath(joined);
    if (index.files.has(oldAbs)) refs.push([ref, oldAbs]);
  }
  return refs.length ? applyRewrites(text, refs, index, newPath) : text;
}

/** Point the file cards of a JSON Canvas at their new paths. null when nothing changed
 * (or the file is not valid canvas JSON, which is left alone). */
export function relinkCanvas(text, moved) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.nodes)) return null;
  let changed = false;
  for (const node of data.nodes) {
    if (node && typeof node === 'object' && node.type === 'file' && typeof node.file === 'string') {
      const next = moved.get(node.file);
      if (next) {
        node.file = next;
        changed = true;
      }
    }
  }
  // same layout the canvas view writes
  return changed ? JSON.stringify(data, null, '\t') : null;
}
