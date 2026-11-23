// sk_notes for Android – the spell checker of sk_notes: what it downloads and keeps.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Nothing of the checker is in the APK but a small piece of glue code: the engine (Hunspell
// built for WebAssembly) and a dictionary per language are downloaded when the user asks
// for them, into the private storage of the app (not the vault). The engine is code, so the
// file must have the exact SHA-256 written here; the dictionaries come from one fixed
// commit of a public collection of Hunspell dictionaries.

import { native } from './native.js';
import { route } from './router.js';
import { roots } from './state.js';
import { ApiError } from './util.js';

// the engine: the .wasm of the npm package hunspell-wasm 0.3.0 (its glue code is bundled)
const ENGINE = {
  version: '0.3.0',
  sha256: '72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0',
  size: 811567,
  urls: ['https://cdn.jsdelivr.net/npm/hunspell-wasm@0.3.0/wasm/hunspell.wasm', 'https://unpkg.com/hunspell-wasm@0.3.0/wasm/hunspell.wasm'],
};
const DICT_BASE = 'https://raw.githubusercontent.com/wooorm/dictionaries/8cfea406b505e4d7df52d5a19bce525df98c54ab/dictionaries/';
// [language code, licence of the dictionary, bytes of .aff + .dic]
export const DICTIONARIES = [
  ["bg", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 1624431],
  ["br", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 3981514],
  ["ca-valencia", "(GPL-2.0 OR LGPL-2.1)", 2931226],
  ["ca", "(GPL-2.0 OR LGPL-2.1)", 2926530],
  ["cs", "GPL-2.0", 3760848],
  ["cy", "LGPL-3.0", 896140],
  ["da", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 3800884],
  ["de-AT", "(GPL-2.0 OR GPL-3.0)", 1141021],
  ["de-CH", "(GPL-2.0 OR GPL-3.0)", 1138909],
  ["de", "(GPL-2.0 OR GPL-3.0)", 1137393],
  ["el-polyton", "GPL-3.0", 16687833],
  ["el", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 19442025],
  ["en-AU", "(MIT AND BSD)", 557422],
  ["en-CA", "(MIT AND BSD)", 554669],
  ["en-GB", "(MIT AND BSD)", 555192],
  ["en-ZA", "LGPL-2.1", 632249],
  ["en", "(MIT AND BSD)", 554848],
  ["eo", "GPL-2.0", 398459],
  ["es-AR", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 867495],
  ["es-BO", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 853417],
  ["es-CL", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 856042],
  ["es-CO", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 900318],
  ["es-CR", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 851467],
  ["es-CU", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 853378],
  ["es-DO", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 850171],
  ["es-EC", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 852058],
  ["es-GT", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 851096],
  ["es-HN", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 853102],
  ["es-MX", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 872058],
  ["es-NI", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 852018],
  ["es-PA", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 850754],
  ["es-PE", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 863780],
  ["es-PH", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 958086],
  ["es-PR", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 850293],
  ["es-PY", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 850885],
  ["es-SV", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 851458],
  ["es-US", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 855897],
  ["es-UY", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 853010],
  ["es-VE", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 852783],
  ["es", "(GPL-3.0 OR LGPL-3.0 OR MPL-1.1)", 873337],
  ["et", "LGPL-2.1", 4697457],
  ["eu", "GPL-2.0", 5032811],
  ["fa", "Apache-2.0", 2581430],
  ["fo", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 1886312],
  ["fr", "MPL-2.0", 1429003],
  ["fur", "GPL-2.0", 402558],
  ["fy", "GPL-3.0", 10632581],
  ["ga", "GPL-2.0", 1602866],
  ["gd", "GPL-3.0", 2372657],
  ["gl", "GPL-3.0", 9796316],
  ["he", "AGPL-3.0", 5766994],
  ["hr", "(LGPL-2.1 OR SISSL)", 828688],
  ["hu", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 3961688],
  ["hy", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 2236399],
  ["hyw", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 2165166],
  ["ia", "GPL-3.0", 747506],
  ["ie", "Apache-2.0", 258603],
  ["is", "CC-BY-SA-3.0", 2763872],
  ["it", "GPL-3.0", 1365774],
  ["ka", "MIT", 3948156],
  ["ko", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 13958943],
  ["la", "GPL-2.0", 2152063],
  ["lb", "EUPL-1.1", 3783157],
  ["lt", "BSD-3-Clause", 1280898],
  ["ltg", "LGPL-2.1", 344455],
  ["lv", "LGPL-2.1", 1975306],
  ["mk", "GPL-3.0", 2461397],
  ["mn", "LPPL-1.3c", 17907872],
  ["nb", "GPL-2.0", 5367105],
  ["nds", "GPL-3.0", 115859],
  ["ne", "LGPL-2.1", 946122],
  ["nl", "(BSD-3-Clause OR CC-BY-3.0)", 2535898],
  ["nn", "GPL-2.0", 3352250],
  ["oc", "GPL-2.0", 2786638],
  ["pl", "(GPL-3.0 OR LGPL-3.0 OR MPL-2.0)", 4952403],
  ["pt-PT", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 1570417],
  ["pt", "(LGPL-3.0 OR MPL-2.0)", 5457481],
  ["ro", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 2257434],
  ["ru", "BSD-3-Clause", 3544427],
  ["rw", "GPL-3.0", 38204509],
  ["sk", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1)", 3601445],
  ["sl", "(GPL-3.0 OR LGPL-2.1)", 3099502],
  ["sr-Latn", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1 OR CC-BY-SA-3.0)", 2490531],
  ["sr", "(GPL-2.0 OR LGPL-2.1 OR MPL-1.1 OR CC-BY-SA-3.0)", 4449266],
  ["sv-FI", "LGPL-3.0", 2357945],
  ["sv", "LGPL-3.0", 2362780],
  ["tk", "Apache-2.0", 1153954],
  ["tr", "MIT", 9358006],
  ["uk", "GPL-3.0", 8696386],
  ["vi", "GPL-2.0", 40939],
];
const CODES = new Map(DICTIONARIES.map((d) => [d[0], d]));
const MAX_FILE = 48 * 1024 * 1024;
const WORD_MAX = 80;
export const SPELL_DEFAULTS = { mode: 'off', langs: [], underline: true, suggest: true, autocorrect: false, ignoreCaps: true };

function appOnly(ctx) {
  if (ctx.plugin) throw new ApiError('permission-denied');
}

function dir() {
  const d = roots().private + '/spell';
  native.sync('fs.mkdirs', { path: d });
  return d;
}

const exists = (path) => { try { return native.sync('fs.exists', { path }); } catch { return false; } };
const enginePath = () => dir() + '/hunspell-' + ENGINE.version + '.wasm';
const dictPath = (code, ext) => `${dir()}/${code}.${ext}`;
const installed = (code) => exists(dictPath(code, 'aff')) && exists(dictPath(code, 'dic'));

function readJson(name, fallback) {
  try { return JSON.parse(native.sync('fs.readText', { path: dir() + '/' + name }).text); } catch { return fallback; }
}
function writeJson(name, value) {
  native.sync('fs.writeText', { path: dir() + '/' + name, text: JSON.stringify(value) });
}

export function spellConfig() {
  const c = { ...SPELL_DEFAULTS, ...readJson('config.json', {}) };
  c.langs = (Array.isArray(c.langs) ? c.langs : []).filter((x) => CODES.has(x) && installed(x));
  if (!['off', 'system', 'sknotes'].includes(c.mode)) c.mode = 'off';
  return c;
}

function words() {
  const w = readJson('words.json', []);
  return Array.isArray(w) ? w.filter((x) => typeof x === 'string') : [];
}

/** Download one address into a file (through a temporary file: a broken download leaves nothing). */
async function fetchTo(url, path) {
  const tmp = path + '.part';
  let r;
  try {
    r = await native.async('net.request', { url, method: 'GET', headers: { 'User-Agent': 'sk_notes' }, timeout: 120, maxBytes: MAX_FILE, toFile: tmp });
  } catch (e) {
    native.async('fs.delete', { path: tmp, recursive: false }).catch(() => {});
    if (e.code === 'too-large') throw e;
    throw new ApiError('download-failed', e.detail || e.code || String(e));
  }
  if (typeof r.b64 === 'string') native.sync('fs.writeB64', { path: tmp, b64: r.b64 }); // a native side without "toFile"
  if (r.status < 200 || r.status >= 300) {
    native.async('fs.delete', { path: tmp, recursive: false }).catch(() => {});
    throw new ApiError('download-failed', `${url.slice(url.lastIndexOf('/') + 1)}: HTTP ${r.status}`);
  }
  native.sync('fs.rename', { from: tmp, to: path });
}

function engineOk(path) {
  try { return native.sync('hash', { algo: 'sha256', b64: native.sync('fs.readB64', { path }) }).hex === ENGINE.sha256; } catch { return false; }
}

async function installEngine() {
  const path = enginePath();
  if (exists(path)) return;
  let last = null;
  for (const url of ENGINE.urls) {
    try {
      await fetchTo(url, path);
      if (engineOk(path)) return;
      native.sync('fs.delete', { path, recursive: false });
      last = new ApiError('spell-bad-engine', url);
    } catch (e) { last = e; }
  }
  throw last || new ApiError('download-failed', 'engine');
}

function state() {
  const engine = exists(enginePath());
  return {
    engine: { installed: engine, size: ENGINE.size, version: ENGINE.version },
    dictionaries: DICTIONARIES.map(([code, license, size]) => ({ code, license, size, installed: installed(code) })),
    config: spellConfig(),
    words: words(),
  };
}

export function registerSpell() {
  route('spell.state', (p, ctx) => { appOnly(ctx); return state(); });

  route('spell.install', async (p, ctx) => {
    appOnly(ctx);
    const code = String(p.code || '');
    if (!CODES.has(code)) throw new ApiError('bad-id', code);
    await installEngine();
    if (!installed(code)) {
      await fetchTo(DICT_BASE + code + '/index.aff', dictPath(code, 'aff'));
      try { await fetchTo(DICT_BASE + code + '/index.dic', dictPath(code, 'dic')); } catch (e) {
        native.async('fs.delete', { path: dictPath(code, 'aff'), recursive: false }).catch(() => {});
        throw e;
      }
    }
    const c = spellConfig();
    if (!c.langs.includes(code)) { c.langs.push(code); writeJson('config.json', c); }
    return state();
  });

  route('spell.remove', (p, ctx) => {
    appOnly(ctx);
    const code = String(p.code || '');
    if (!CODES.has(code)) throw new ApiError('bad-id', code);
    for (const ext of ['aff', 'dic']) { try { native.sync('fs.delete', { path: dictPath(code, ext), recursive: false }); } catch { /* already gone */ } }
    const c = spellConfig();
    writeJson('config.json', c); // the language leaves the list of those in use
    // no dictionary left: the engine goes too (it is downloaded again with the next language)
    if (!DICTIONARIES.some(([x]) => installed(x))) { try { native.sync('fs.delete', { path: enginePath(), recursive: false }); } catch { /* gone */ } }
    return state();
  });

  route('spell.setConfig', (p, ctx) => {
    appOnly(ctx);
    const c = spellConfig();
    const n = p.config || {};
    for (const k of ['underline', 'suggest', 'autocorrect', 'ignoreCaps']) if (typeof n[k] === 'boolean') c[k] = n[k];
    if (['off', 'system', 'sknotes'].includes(n.mode)) c.mode = n.mode;
    if (Array.isArray(n.langs)) c.langs = n.langs.filter((x) => CODES.has(x) && installed(x));
    writeJson('config.json', c);
    return c;
  });

  route('spell.words', (p, ctx) => {
    appOnly(ctx);
    let w = words();
    const word = String(p.word || '').trim().slice(0, WORD_MAX);
    if (word && p.add && !w.includes(word)) w.push(word);
    if (word && p.remove) w = w.filter((x) => x !== word);
    w.sort((a, b) => a.localeCompare(b));
    writeJson('words.json', w);
    return w;
  });

  /** What the checker needs to start: the engine and the dictionaries in use. */
  route('spell.load', (p, ctx) => {
    appOnly(ctx);
    const c = spellConfig();
    if (!c.langs.length || !exists(enginePath())) return null;
    const wasm = native.sync('fs.readB64', { path: enginePath() });
    if (native.sync('hash', { algo: 'sha256', b64: wasm }).hex !== ENGINE.sha256) throw new ApiError('spell-bad-engine', 'file');
    const dicts = c.langs.map((code) => ({
      code,
      aff: native.sync('fs.readText', { path: dictPath(code, 'aff') }).text,
      dic: native.sync('fs.readText', { path: dictPath(code, 'dic') }).text,
    }));
    return { wasm, dicts, words: words() };
  });
}

