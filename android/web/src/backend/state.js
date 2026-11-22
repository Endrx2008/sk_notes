// sk_notes for Android – state of the in-app backend (settings, open vault, events).
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { native } from './native.js';
import { ApiError, sha1 } from './util.js';

export const VERSION = '0.5.3';
export const LANGUAGES = [
  { code: 'en', name: 'English' }, { code: 'it', name: 'Italiano' }, { code: 'es', name: 'Español' }, { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' }, { code: 'pt', name: 'Português' }, { code: 'ru', name: 'Русский' }, { code: 'zh-CN', name: '简体中文' }, { code: 'ja', name: '日本語' },
];

const DEFAULTS = {
  language: '', // '' = follow the system
  vaults: {}, // path → {ts: last open (ms)}
  lastVault: '',
  zoom: 1.0,
  // SKAI: a PC on the same network running Skorpion OS (or Ollama with an open endpoint)
  ollamaHost: '', // '' = SKAI not set up
  ollamaModel: '', // '' = automatic: the biggest installed chat model
  pendingUri: '', // a link to show after switching to the vault it names
  cryptLockAfter: 5, // minutes away from the app before an encrypted vault locks itself (0 = at once, -1 = never)
  cryptNotes: null, // what to tell once after an encrypted vault was opened (conflict copies, a save cut short)
};

export const state = {
  roots: null, // folders given by the native side: {private, cache, appVaults, shared, documents}
  settings: { ...DEFAULTS },
  service: null, // VaultService of the open vault
  language: 'en',
  strings: {},
  english: {},
  theme: 'dark',
  safeMode: false,
  startError: null, // why the last vault could not be opened
  crypt: null, // the encrypted vault that is open (vault-crypt.js OpenVault)
  locked: null, // {path, name}: the last vault is an encrypted one, waiting for its password
};

// ---------------------------------------------------------------- events to the page
const listeners = new Map();
const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

export function onEvent(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

/** Send an event to the page. It is delivered after the current call returns, as a copy
 * (the page never shares objects with the backend), like events from the desktop backend. */
export function emit(name, payload) {
  let copy;
  try { copy = plain(payload); } catch (e) { console.error('event not sent', name, e); return; }
  queueMicrotask(() => {
    for (const fn of listeners.get(name) || []) {
      try { fn(copy); } catch (e) { console.error('backend event', name, e); }
    }
  });
}

// ---------------------------------------------------------------- settings
export function roots() {
  if (!state.roots) state.roots = native.sync('fs.roots', {});
  return state.roots;
}

const settingsFile = () => roots().private + '/settings.json';

export function loadSettings() {
  let data = {};
  try {
    if (native.sync('fs.exists', { path: settingsFile() })) data = JSON.parse(native.sync('fs.readText', { path: settingsFile() }).text);
  } catch { data = {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (data[k] !== undefined && typeof data[k] === typeof DEFAULTS[k]) s[k] = data[k];
  if (!s.vaults || typeof s.vaults !== 'object' || Array.isArray(s.vaults)) s.vaults = {};
  state.settings = s;
  return s;
}

export function saveSettings() {
  native.sync('fs.writeText', { path: settingsFile(), text: JSON.stringify(state.settings, null, 2) });
}

export function svc() {
  if (!state.service) throw new ApiError('no-vault');
  return state.service;
}

/** Private folder of the app for one vault (metadata cache, history, embeddings). */
export function vaultDataDir(root) {
  // an encrypted vault keeps these beside its decrypted files: emptied together when it is locked
  if (state.crypt && root === state.crypt.where.work) return state.crypt.where.data;
  return `${roots().private}/vaults/${sha1(root).slice(0, 20)}`;
}

/** Where an encrypted vault file is decrypted while it is open (vault-crypt.js places()). */
export function cryptPlaces(blob) {
  const dir = `${roots().private}/encrypted/${sha1(blob).slice(0, 20)}`;
  const name = blob.slice(blob.lastIndexOf('/') + 1).replace(/\.skvault$/i, '');
  return { dir, work: `${dir}/vault/${name}`, data: `${dir}/data`, state: `${dir}/state.json` };
}

export function t(key, vars) {
  let s = state.strings[key] ?? state.english[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}

export function systemLanguage() {
  const want = (globalThis.navigator?.languages || [globalThis.navigator?.language || 'en']).map((x) => String(x));
  for (const w of want) {
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === w.toLowerCase());
    if (exact) return exact.code;
    const base = w.split('-')[0].toLowerCase();
    const loose = LANGUAGES.find((l) => l.code.split('-')[0].toLowerCase() === base);
    if (loose) return loose.code;
  }
  return 'en';
}
