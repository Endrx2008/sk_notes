// sk_notes for Android – the spell checker seen from the page: its worker, its answers.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// One checker for the whole app. It starts when the sk_notes checker is chosen and a
// dictionary is in use, and starts again when the languages or the personal words change.
// Editors ask it which words are wrong; answers are kept per word.

import { call } from '../api.js';
import { b64ToBytes } from '../../backend/util.js';

const listeners = new Set();
let worker = null;
let ready = null; // Promise<boolean>
let nextId = 1;
const waiting = new Map();
const known = new Map(); // word → true (right) / false (wrong)
const ignored = new Set(); // "Ignore" for this session
export const spell = { config: null, active: false, error: null };

function send(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(new Error('stopped'));
  waiting.clear();
}

/** Editors listen: they draw again when the checker starts, stops or learns a word. */
export function onSpellChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } }

/** (Re)start from the saved configuration. */
export async function reloadSpell() {
  stopWorker();
  known.clear();
  spell.error = null;
  spell.active = false;
  let cfg;
  try { cfg = (await call('spell.state')).config; } catch (e) { spell.error = String(e.message || e); changed(); return; }
  spell.config = cfg;
  if (cfg.mode !== 'sknotes' || !cfg.langs.length) { ready = null; changed(); return; }
  ready = (async () => {
    const data = await call('spell.load');
    if (!data) return false;
    worker = new Worker('dist/spell-worker.js');
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data);
    };
    worker.onerror = (e) => { spell.error = e.message || 'worker'; };
    const bytes = b64ToBytes(data.wasm);
    const r = await send({ op: 'init', wasm: bytes.buffer, dicts: data.dicts, words: data.words }, [bytes.buffer]);
    return !!r.ok;
  })().catch((e) => { spell.error = String(e.message || e); console.warn('spell checker not started', e); return false; });
  spell.active = await ready;
  changed();
}

/** The words of `words` that are wrong (a Set). Unknown words are asked to the worker. */
export async function wrongWords(words) {
  if (!ready || !(await ready) || !worker) return new Set();
  const ask = [...new Set(words)].filter((w) => !known.has(w) && !ignored.has(w));
  if (ask.length) {
    try {
      const bad = new Set((await send({ op: 'check', words: ask })).bad);
      for (const w of ask) known.set(w, !bad.has(w));
    } catch { return new Set(); }
  }
  return new Set(words.filter((w) => known.get(w) === false && !ignored.has(w)));
}

/** Only what is already known (no waiting): true when the word is known to be wrong. */
export function isKnownWrong(word) { return known.get(word) === false && !ignored.has(word); }

export async function suggestions(word) {
  if (!ready || !(await ready) || !worker) return [];
  try { return (await send({ op: 'suggest', word })).list; } catch { return []; }
}

export async function addWord(word) {
  await call('spell.words', { word, add: true });
  known.set(word, true);
  if (worker) await send({ op: 'add', word }).catch(() => {});
  changed();
}

export async function removeWord(word) {
  await call('spell.words', { word, remove: true });
  known.delete(word);
  if (worker) await send({ op: 'remove', word }).catch(() => {});
  changed();
}

export function ignoreWord(word) {
  ignored.add(word);
  changed();
}
