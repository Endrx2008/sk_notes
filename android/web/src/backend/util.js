// sk_notes for Android – shared helpers of the in-app backend.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

/** Error with a machine-readable code, shown to the user through `error.<code>` strings. */
export class ApiError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export const CONFIG_DIR = '.sk_notes';
export const IGNORED_DIRS = ['.git', '.trash', 'node_modules', '.obsidian', CONFIG_DIR];
export const TEXT_EXT = new Set(['md', 'canvas', 'base', 'txt']);
export const MAX_NAME_BYTES = 255;

const encoder = new TextEncoder();

/** Same rules as the plugin API normalizePath(): '/' separators, no leading or trailing
 * slash, no duplicated slashes, NFC unicode, non-breaking spaces → spaces. */
export function normalizePath(path) {
  const p = String(path ?? '').replace(/\\/g, '/').replace(/[\u00a0\u202f]/g, ' ');
  const out = p.split('/').filter((x) => x !== '' && x !== '.').join('/');
  return out ? out.normalize('NFC') : '/';
}

export function extOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.slice(1).includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
}

export function basenameNoExt(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.slice(1).includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
}

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Join and normalise a POSIX path ('..' and '.' resolved; may climb above the start). */
export function normpath(path) {
  const abs = path.startsWith('/');
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!abs) parts.push('..');
    } else parts.push(part);
  }
  const out = parts.join('/');
  return abs ? '/' + out : out || '.';
}

export function relpath(target, start) {
  const a = normpath(target).split('/').filter((x) => x && x !== '.');
  const b = normpath(start || '.').split('/').filter((x) => x && x !== '.');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const out = [...b.slice(i).map(() => '..'), ...a.slice(i)];
  return out.join('/') || '.';
}

export function utf8Length(s) {
  return encoder.encode(s).length;
}

export function checkName(name) {
  if (!name || name === '.' || name === '..') throw new ApiError('empty-name');
  // names that Android's shared storage (and the PCs a vault is synced with) refuse
  if (/[/\u0000]/.test(name)) throw new ApiError('invalid-characters');
  if (/[\\:*?"<>|]/.test(name)) throw new ApiError('invalid-characters');
  if (utf8Length(name) > MAX_NAME_BYTES) throw new ApiError('name-too-long');
}

/** Percent-encode like Python's urllib.parse.quote(s, safe). */
export function quote(s, safe = '/') {
  const keep = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~', ...safe]);
  let out = '';
  for (const ch of s) {
    if (keep.has(ch)) { out += ch; continue; }
    for (const b of encoder.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Percent-decode; malformed sequences are left as they are. */
export function unquote(s) {
  if (!s.includes('%')) return s;
  try { return decodeURIComponent(s); } catch { /* piece by piece below */ }
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
}

/** SHA-1 of a string (UTF-8), hex. Synchronous: the Web Crypto API is asynchronous only. */
export function sha1(text) {
  const msg = encoder.encode(text);
  const ml = msg.length;
  const withPad = new Uint8Array(((ml + 9 + 63) >> 6) << 6);
  withPad.set(msg);
  withPad[ml] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor((ml * 8) / 0x100000000));
  dv.setUint32(withPad.length - 4, (ml * 8) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; } else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export function b64ToBytes(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function textToB64(text) {
  return bytesToB64(encoder.encode(text));
}

export function b64ToText(b64) {
  return new TextDecoder('utf-8').decode(b64ToBytes(b64));
}

/** Let the page paint and handle input during long loops. */
export function breathe() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
