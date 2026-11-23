// sk_notes for Android – the spell checker's worker: Hunspell (WebAssembly) away from the page.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Built on its own (build-web.mjs) into dist/spell-worker.js. The engine's .wasm is not in the
// app: the page hands over the bytes it downloaded (and checked) with the dictionaries.
//   {id, op: 'init', wasm: ArrayBuffer, dicts: [{code, aff, dic}], words: [..]}  → {id, ok}
//   {id, op: 'check', words: [..]}                                              → {id, bad: [..]}
//   {id, op: 'suggest', word}                                                   → {id, list: [..]}
//   {id, op: 'add', word} / {id, op: 'remove', word}                            → {id, ok}

import initHunspell from 'hunspell-wasm/wasm/hunspell.js';
import { Hunspell } from 'hunspell-wasm/dist/Hunspell.js';

let spellers = [];
let personal = new Set();

function correct(word) {
  if (personal.has(word) || personal.has(word.toLowerCase())) return true;
  for (const h of spellers) if (h.testSpelling(word)) return true;
  return false;
}

async function init(msg) {
  for (const h of spellers) { try { h.dispose(); } catch { /* gone */ } }
  spellers = [];
  const module = await initHunspell({ wasmBinary: new Uint8Array(msg.wasm) });
  for (const d of msg.dicts) {
    try { spellers.push(new Hunspell(module, d.aff, d.dic)); } catch (e) { console.warn('dictionary not loaded', d.code, e); }
  }
  personal = new Set(msg.words || []);
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.op === 'init') { await init(msg); self.postMessage({ id: msg.id, ok: spellers.length > 0 }); return; }
    if (msg.op === 'check') { self.postMessage({ id: msg.id, bad: (msg.words || []).filter((w) => !correct(w)) }); return; }
    if (msg.op === 'suggest') {
      const seen = new Set();
      const list = [];
      for (const h of spellers) for (const s of h.getSpellingSuggestions(msg.word)) if (!seen.has(s)) { seen.add(s); list.push(s); }
      self.postMessage({ id: msg.id, list: list.slice(0, 8) });
      return;
    }
    if (msg.op === 'add') { personal.add(msg.word); self.postMessage({ id: msg.id, ok: true }); return; }
    if (msg.op === 'remove') { personal.delete(msg.word); self.postMessage({ id: msg.id, ok: true }); return; }
    self.postMessage({ id: msg.id, error: 'unknown op' });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
};
