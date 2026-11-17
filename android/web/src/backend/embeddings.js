// sk_notes for Android – local embedding index for questions about the whole vault.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Notes are split into chunks (by heading/paragraph, about 800 characters), embedded by
// the Ollama embedding model of the PC set up for SKAI and kept in the app's private
// storage (one small file per note, so nothing extra is synced with the vault). Only
// changed notes are embedded again. Retrieval = cosine similarity. Without an embedding
// model, retrieval falls back to the full-text index.

import { native } from './native.js';
import { search } from './search.js';
import { b64ToBytes, breathe, bytesToB64, sha1 } from './util.js';

const CHUNK = 800;
const BATCH = 16;
const READ_BATCH = 40;

export function splitChunks(input) {
  const text = input.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const parts = [];
  let cur = '';
  for (let block of text.split(/\n(?=#{1,6}\s)|\n\s*\n/)) {
    block = block.trim();
    if (!block) continue;
    if (cur.length + block.length + 2 <= CHUNK) cur = cur ? `${cur}\n\n${block}` : block;
    else {
      if (cur) parts.push(cur);
      while (block.length > CHUNK) {
        parts.push(block.slice(0, CHUNK));
        block = block.slice(CHUNK - 100);
      }
      cur = block;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

function vecToB64(vecs, dim) {
  const arr = new Float32Array(vecs.length * dim);
  vecs.forEach((v, i) => arr.set(v.slice(0, dim), i * dim));
  return bytesToB64(new Uint8Array(arr.buffer));
}

function b64ToVec(b64) {
  const bytes = b64ToBytes(b64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

export class EmbeddingIndex {
  /** dir: folder of this vault's embeddings in the app's private storage. */
  constructor(dir) {
    this.dir = dir;
    this.entries = {}; // path → {mtime, n, dim, model, file}
    this.running = false;
    this.cancelled = false;
    this._matrix = null; // {model, paths[], texts[], vecs[] (normalised Float32Array)}
    try {
      native.sync('fs.mkdirs', { path: dir });
      if (native.sync('fs.exists', { path: dir + '/index.json' })) {
        const data = JSON.parse(native.sync('fs.readText', { path: dir + '/index.json' }).text);
        if (data && typeof data.entries === 'object' && !Array.isArray(data.entries)) this.entries = data.entries;
      }
    } catch (e) { console.warn('embedding index unreadable, starting a new one', e); this.entries = {}; }
  }

  _save() {
    try { native.sync('fs.writeText', { path: this.dir + '/index.json', text: JSON.stringify({ entries: this.entries }) }); } catch (e) { console.warn('embedding index not written', e); }
  }

  _file(path) { return `${this.dir}/${sha1(path)}.json`; }

  _drop(path) {
    try { native.sync('fs.delete', { path: this._file(path), recursive: false }); } catch { /* already gone */ }
    delete this.entries[path];
  }

  status(model) {
    let notes = 0;
    let chunks = 0;
    for (const e of Object.values(this.entries)) if (e.model === (model || '')) { notes += 1; chunks += e.n; }
    return { notes, chunks, model: model || '', running: this.running };
  }

  /** Embed new and changed notes. Safe to call repeatedly. */
  async build(service, ollama, model, progress) {
    if (this.running) return { busy: true };
    this.running = true;
    this.cancelled = false;
    try {
      const files = new Map([...service.index.files].filter(([p]) => p.endsWith('.md')));
      for (const gone of Object.keys(this.entries)) if (!files.has(gone)) this._drop(gone);
      const todo = [...files.keys()].filter((p) => {
        const e = this.entries[p];
        return !e || e.model !== model || Math.abs(e.mtime - files.get(p).mtime) > 1;
      });
      let done = 0;
      for (const path of todo) {
        if (this.cancelled) break;
        const text = service.index.content(path) || '';
        const chunks = splitChunks(text).slice(0, 200);
        const vecs = [];
        for (let i = 0; i < chunks.length; i += BATCH) {
          if (this.cancelled) break;
          vecs.push(...await ollama.embed(chunks.slice(i, i + BATCH).map((c) => `${path}\n${c}`), model));
        }
        if (this.cancelled) break;
        const entry = files.get(path);
        if (!entry) continue; // deleted meanwhile
        const dim = vecs.length ? vecs[0].length : 0;
        native.sync('fs.writeText', { path: this._file(path), text: JSON.stringify({ path, model, dim, chunks, vec: vecToB64(vecs, dim) }) });
        this.entries[path] = { mtime: entry.mtime, n: chunks.length, dim, model };
        this._matrix = null;
        done += 1;
        if (done % 5 === 0 || done === todo.length) { this._save(); progress?.(done, todo.length); }
        await breathe();
      }
      this._save();
      return { embedded: done, pending: todo.length - done };
    } finally {
      this.running = false;
    }
  }

  async _load(model) {
    if (this._matrix && this._matrix.model === model) return this._matrix;
    const wanted = Object.keys(this.entries).filter((p) => this.entries[p].model === model && this.entries[p].n > 0);
    const paths = [];
    const texts = [];
    const vecs = [];
    for (let i = 0; i < wanted.length; i += READ_BATCH) {
      const batch = wanted.slice(i, i + READ_BATCH);
      let raw;
      try { raw = await native.async('fs.readTexts', { paths: batch.map((p) => this._file(p)) }); } catch { raw = []; }
      batch.forEach((p, k) => {
        let data;
        try { data = JSON.parse(raw[k] ?? ''); } catch { return; }
        if (!data || data.model !== model || !Array.isArray(data.chunks) || !data.dim) return;
        const all = b64ToVec(data.vec || '');
        for (let c = 0; c < data.chunks.length; c++) {
          const v = all.slice(c * data.dim, (c + 1) * data.dim);
          if (v.length !== data.dim) break;
          let norm = 0;
          for (let j = 0; j < v.length; j++) norm += v[j] * v[j];
          norm = Math.sqrt(norm) || 1;
          for (let j = 0; j < v.length; j++) v[j] /= norm;
          paths.push(p);
          texts.push(data.chunks[c]);
          vecs.push(v);
        }
      });
      await breathe();
    }
    this._matrix = { model, paths, texts, vecs };
    return this._matrix;
  }

  async search(queryVec, model, k = 6) {
    const { paths, texts, vecs } = await this._load(model);
    if (!paths.length) return [];
    const q = Float32Array.from(queryVec);
    let qn = 0;
    for (let j = 0; j < q.length; j++) qn += q[j] * q[j];
    qn = Math.sqrt(qn) || 1;
    const scored = [];
    for (let i = 0; i < vecs.length; i++) {
      const v = vecs[i];
      if (v.length !== q.length) continue;
      let dot = 0;
      for (let j = 0; j < v.length; j++) dot += v[j] * q[j];
      scored.push([dot / qn, i]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const out = [];
    const seen = new Map();
    for (const [score, i] of scored.slice(0, k * 3)) {
      const n = seen.get(paths[i]) || 0;
      if (n >= 2) continue; // at most two chunks per note
      seen.set(paths[i], n + 1);
      out.push({ path: paths[i], text: texts[i], score: Math.round(score * 10000) / 10000 });
      if (out.length >= k) break;
    }
    return out;
  }

  close() { this.cancelled = true; }
}

const count = (text, word) => text.split(word).length - 1;

/** Fallback retrieval with the full-text index: the notes containing most query words. */
export async function keywordRetrieve(service, query, k = 6) {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || []).slice(0, 8);
  if (!words.length) return [];
  const res = await search(service.index, words.map((w) => `"${w}"`).join(' OR '), { limitFiles: 200, context: 2, maxMatches: 3 });
  const scored = [];
  for (const r of res.results) {
    const text = service.index.content(r.path) || '';
    const low = text.toLowerCase();
    const score = words.reduce((n, w) => n + count(low, w), 0) / (1 + text.length / 4000);
    scored.push([score, r.path, text]);
  }
  scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : -1));
  return scored.slice(0, k).map(([score, path, text]) => {
    const chunks = splitChunks(text);
    if (!chunks.length) chunks.push(text.slice(0, CHUNK));
    let best = chunks[0];
    let bestN = -1;
    for (const c of chunks) {
      const low = c.toLowerCase();
      const n = words.reduce((x, w) => x + count(low, w), 0);
      if (n > bestN) { best = c; bestN = n; }
    }
    return { path, text: best, score: Math.round(score * 1000) / 1000 };
  });
}
