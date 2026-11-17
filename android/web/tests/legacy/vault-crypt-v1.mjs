// sk_notes for Android – encrypted vaults: a whole vault kept as one encrypted file.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// An encrypted vault is a file "<Name>.skvault" in the folder the user chose. It holds every
// file of the vault (and the version history of its notes), encrypted with a password set
// when the vault is made. Encryption is for a vault as a whole, never for single notes.
//
// How it works while the vault is open: the file is decrypted into a private folder of the
// app (which other apps cannot read), sk_notes works there as with any vault, and the file
// is written again, encrypted, a little after every change and whenever the app is left.
// When the vault is locked (or the app starts again) the private folder is emptied.
//
// The file:
//   "SKNVAULT1\n"  u32 length  header (JSON)
//   then pieces:   u32 length  AES-256-GCM(piece)        (the last one is marked as last)
// The pieces are encrypted with a random key (the vault key). The header holds that key
// encrypted with a key made from the password (PBKDF2-HMAC-SHA256, 600 000 rounds): a new
// password re-encrypts the vault key only, and a wrong password is noticed at once.
// Each save uses a fresh random nonce; the number of the piece is part of it, so pieces
// cannot be swapped, and a file cut short does not open.
// Forgetting the password means losing the vault: nothing here can open it without it.

import { native } from '../../src/backend/native.js';
import { ApiError, b64ToBytes, bytesToB64 } from '../../src/backend/util.js';

export const BLOB_EXT = 'skvault';
const MAGIC = 'SKNVAULT1\n';
const PIECE = 1024 * 1024;
const ROUNDS = 600000;
const MIN_PASSWORD = 8;
const SESSION = 'vault-session'; // native secret: the key of the vault that is open, while it is open

// taken now, before any plugin runs (plugins share the page)
const subtle = globalThis.crypto?.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8');

export const isBlobPath = (path) => new RegExp(`\\.${BLOB_EXT}$`, 'i').test(String(path || ''));
export const blobName = (path) => String(path).slice(String(path).lastIndexOf('/') + 1).replace(new RegExp(`\\.${BLOB_EXT}$`, 'i'), '');

function need() {
  if (!subtle) throw new ApiError('crypt-unavailable');
}

export function checkPassword(password) {
  const p = String(password ?? '').normalize('NFC');
  if (p.length < MIN_PASSWORD) throw new ApiError('password-short', String(MIN_PASSWORD));
  return p;
}

// ---------------------------------------------------------------- keys
async function passwordKey(password, salt, rounds) {
  const base = await subtle.importKey('raw', utf8.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const dataKey = (raw) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** The part of the header that depends on the password: the vault key, encrypted with it. */
async function wrapKey(raw, password) {
  const salt = random(16);
  const iv = random(12);
  const kek = await passwordKey(password, salt, ROUNDS);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw));
  return { kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ROUNDS, salt: bytesToB64(salt) }, wrap: { iv: bytesToB64(iv), key: bytesToB64(wrapped) } };
}

/** The vault key, from the header and the password; "wrong-password" when it is not the one. */
async function unwrapKey(header, password) {
  const rounds = Number(header?.kdf?.iterations) || 0;
  if (header?.kdf?.name !== 'PBKDF2' || rounds < 1000 || rounds > 50000000) throw new ApiError('crypt-damaged', 'header');
  const kek = await passwordKey(password, b64ToBytes(header.kdf.salt), rounds);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(header.wrap.iv) }, kek, b64ToBytes(header.wrap.key)));
  } catch { throw new ApiError('wrong-password'); }
}

// ---------------------------------------------------------------- the file
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const readRange = async (path, offset, length) => b64ToBytes(await native.async('fs.readRange', { path, offset, length }));
const append = (path, bytes) => native.async('fs.append', { path, b64: bytesToB64(bytes) });

function join(parts) {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function pieceIv(nonce, index) {
  const iv = new Uint8Array(12);
  iv.set(nonce, 0);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

/** {header, bodyAt, size} of an encrypted vault file. */
export async function readHeader(blob) {
  const st = native.sync('fs.stat', { path: blob });
  if (!st || st.type !== 'file') throw new ApiError('not-found', blob);
  const head = await readRange(blob, 0, MAGIC.length + 4);
  if (head.length < MAGIC.length + 4 || fromUtf8.decode(head.subarray(0, MAGIC.length)) !== MAGIC) throw new ApiError('crypt-damaged', 'not an encrypted vault');
  const len = new DataView(head.buffer, head.byteOffset + MAGIC.length, 4).getUint32(0);
  if (!len || len > 65536) throw new ApiError('crypt-damaged', 'header');
  let header;
  try { header = JSON.parse(fromUtf8.decode(await readRange(blob, MAGIC.length + 4, len))); } catch { throw new ApiError('crypt-damaged', 'header'); }
  if (!header || header.v !== 1 || !header.data?.nonce || !header.wrap?.key) throw new ApiError('crypt-damaged', 'header');
  return { header, bodyAt: MAGIC.length + 4 + len, size: Number(st.size) || 0 };
}

const headerBytes = (header) => { const h = utf8.encode(JSON.stringify(header)); return join([utf8.encode(MAGIC), u32(h.length), h]); };

/** Put `tmp` in the place of `blob`; the old file is kept until the new one is there. */
function replaceFile(tmp, blob) {
  const old = blob + '.old';
  try { native.sync('fs.delete', { path: old, recursive: false }); } catch { /* none */ }
  const had = native.sync('fs.exists', { path: blob });
  if (had) native.sync('fs.rename', { from: blob, to: old });
  try { native.sync('fs.rename', { from: tmp, to: blob }); } catch (e) {
    if (had) native.sync('fs.rename', { from: old, to: blob });
    throw e;
  }
  if (had) { try { native.sync('fs.delete', { path: old, recursive: false }); } catch { /* left beside: harmless */ } }
}

/** A save stopped half-way (the app was killed): the file that was there is put back. */
export function recoverFile(blob) {
  try {
    if (!native.sync('fs.exists', { path: blob }) && native.sync('fs.exists', { path: blob + '.old' })) native.sync('fs.rename', { from: blob + '.old', to: blob });
    native.sync('fs.delete', { path: blob + '.tmp', recursive: false });
  } catch { /* nothing to put back */ }
}

// ---------------------------------------------------------------- writing
/** Encrypt the folders of `sources` ({prefix: folder}) into the vault file. */
async function writeBlob(blob, raw, wrapped, name, sources) {
  need();
  const key = await dataKey(raw);
  const nonce = random(8);
  const header = { v: 1, app: 'sk_notes', name, ...wrapped, data: { cipher: 'AES-256-GCM', nonce: bytesToB64(nonce), piece: PIECE } };
  const tmp = blob + '.tmp';
  native.sync('fs.writeB64', { path: tmp, b64: bytesToB64(headerBytes(header)) });
  let pending = [];
  let size = 0;
  let index = 0;
  const flush = async (last) => {
    const all = join(pending);
    let at = 0;
    while (all.length - at >= PIECE || (last && at <= all.length)) {
      const isLast = last && all.length - at <= PIECE;
      const part = all.subarray(at, at + PIECE);
      const enc = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: pieceIv(nonce, index), additionalData: new Uint8Array([isLast ? 1 : 0]) }, key, part));
      await append(tmp, join([u32(enc.length), enc]));
      index += 1;
      at += part.length;
      if (isLast) break;
    }
    pending = at < all.length ? [all.subarray(at)] : [];
    size = all.length - at;
  };
  const push = async (bytes) => {
    pending.push(bytes);
    size += bytes.length;
    if (size >= PIECE) await flush(false);
  };
  const record = async (kind, path, data, mtime) => {
    const p = utf8.encode(path);
    const head = new Uint8Array(1 + 2 + p.length + 4 + 8);
    const dv = new DataView(head.buffer);
    head[0] = kind;
    dv.setUint16(1, p.length);
    head.set(p, 3);
    dv.setUint32(3 + p.length, data ? data.length : 0);
    dv.setFloat64(7 + p.length, Number(mtime) || 0);
    await push(head);
    if (data && data.length) await push(data);
  };
  for (const [prefix, folder] of Object.entries(sources)) {
    if (!native.sync('fs.exists', { path: folder })) continue;
    const rows = await native.async('fs.scan', { path: folder, ignore: [], skipHidden: false });
    for (const [rel, isDir, , mtime] of rows) {
      if (/(^|\/)\.skn-tmp-[^/]*$/.test(rel)) continue;
      if (isDir) await record(2, `${prefix}/${rel}`, null, 0);
      else await record(1, `${prefix}/${rel}`, b64ToBytes(await native.async('fs.readB64', { path: `${folder}/${rel}` })), mtime);
    }
  }
  await record(0, '', null, 0);
  await flush(true);
  replaceFile(tmp, blob);
  return header;
}

// ---------------------------------------------------------------- reading
/** Decrypt the vault file into the folders of `targets` ({prefix: folder}). */
async function readBlob(blob, raw, targets) {
  need();
  const { header, bodyAt, size } = await readHeader(blob);
  const key = await dataKey(raw);
  const nonce = b64ToBytes(header.data.nonce);
  let buf = new Uint8Array(0);
  let ended = false;
  const consume = () => {
    for (;;) {
      if (ended || buf.length < 3) return;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const plen = dv.getUint16(1);
      if (buf.length < 15 + plen) return;
      const kind = buf[0];
      const dlen = dv.getUint32(3 + plen);
      if (buf.length < 15 + plen + dlen) return;
      const path = fromUtf8.decode(buf.subarray(3, 3 + plen));
      const mtime = dv.getFloat64(7 + plen);
      const data = buf.subarray(15 + plen, 15 + plen + dlen);
      buf = buf.subarray(15 + plen + dlen);
      if (kind === 0) { ended = true; return; }
      const slash = path.indexOf('/');
      const folder = targets[path.slice(0, slash)];
      const rel = path.slice(slash + 1);
      // a file may only land inside its folder
      if (!folder || !rel || rel.split('/').some((x) => x === '..' || x === '.' || x === '') || rel.includes('\\') || rel.includes('\u0000')) throw new ApiError('crypt-damaged', 'path');
      if (kind === 2) native.sync('fs.mkdirs', { path: `${folder}/${rel}` });
      else if (kind === 1) native.sync('fs.writeB64', { path: `${folder}/${rel}`, b64: bytesToB64(data), mtime: Math.floor(mtime) || 0 });
      else throw new ApiError('crypt-damaged', 'record');
    }
  };
  let at = bodyAt;
  let index = 0;
  let sawLast = false;
  while (at < size) {
    const lenBytes = await readRange(blob, at, 4);
    if (lenBytes.length < 4) throw new ApiError('crypt-damaged', 'cut short');
    const len = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0);
    if (len < 16 || len > PIECE + 64 || at + 4 + len > size) throw new ApiError('crypt-damaged', 'cut short');
    const enc = await readRange(blob, at + 4, len);
    const last = at + 4 + len === size;
    let plain;
    try {
      plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: pieceIv(nonce, index), additionalData: new Uint8Array([last ? 1 : 0]) }, key, enc));
    } catch { throw new ApiError('crypt-damaged', `piece ${index}`); }
    buf = buf.length ? join([buf, plain]) : plain;
    consume();
    at += 4 + len;
    index += 1;
    sawLast = last;
  }
  if (!sawLast || !ended) throw new ApiError('crypt-damaged', 'cut short');
  return header;
}

// ---------------------------------------------------------------- an open vault
/** A number that changes when anything in the folders changes (names, sizes, times). */
async function fingerprint(folders) {
  let text = '';
  for (const folder of folders) {
    if (!native.sync('fs.exists', { path: folder })) continue;
    const rows = await native.async('fs.scan', { path: folder, ignore: [], skipHidden: false });
    for (const [rel, isDir, size, mtime] of rows) if (!/(^|\/)\.skn-tmp-[^/]*$/.test(rel)) text += `${rel}\u0000${isDir ? 'd' : size}\u0000${isDir ? 0 : mtime}\n`;
    text += '\u0001';
  }
  const hash = new Uint8Array(await subtle.digest('SHA-256', utf8.encode(text)));
  return bytesToB64(hash);
}

/** Where a vault file is worked on: {dir, work: its files, data: history and caches}. */
export function places(privateRoot, blob, idOf) {
  const dir = `${privateRoot}/encrypted/${idOf(blob)}`;
  return { dir, work: `${dir}/vault/${blobName(blob)}`, data: `${dir}/data`, state: `${dir}/state.json` };
}

const readJson = (path) => { try { return JSON.parse(native.sync('fs.readText', { path }).text); } catch { return null; } };
const wipe = (path) => { try { native.sync('fs.delete', { path, recursive: true }); } catch { /* none */ } };

export class OpenVault {
  constructor(blob, raw, header, where) {
    Object.assign(this, { blob, raw, header, where });
    this.sealed = null; // fingerprint of what the file holds
    this.busy = null;
    this.timer = null;
  }

  get sources() { return { v: this.where.work, h: `${this.where.data}/history` }; }

  async changed() { return (await fingerprint(Object.values(this.sources))) !== this.sealed; }

  /** Write the vault file again if anything changed since it was written. */
  seal(force = false) {
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = (async () => {
      try {
        do {
          this.again = false;
          const now = await fingerprint(Object.values(this.sources));
          if (!force && now === this.sealed) continue;
          this.header = await writeBlob(this.blob, this.raw, { kdf: this.header.kdf, wrap: this.header.wrap }, blobName(this.blob), this.sources);
          this.sealed = now;
          native.sync('fs.writeText', { path: this.where.state, text: JSON.stringify({ blob: this.blob, sealed: now }) });
          force = false;
        } while (this.again);
      } finally { this.busy = null; }
    })();
    return this.busy;
  }

  /** Something changed: the file is written again shortly (changes made in a row are written once). */
  touch(delay = 8000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.seal().catch((e) => console.error('encrypted vault not saved', e)); }, delay);
  }
}

/** Make a new, empty encrypted vault file and open it. */
export async function createVault(blob, password, where) {
  need();
  const pw = checkPassword(password);
  if (native.sync('fs.exists', { path: blob })) throw new ApiError('already-exists', blob);
  const raw = random(32);
  const wrapped = await wrapKey(raw, pw);
  wipe(where.dir);
  native.sync('fs.mkdirs', { path: where.work });
  const v = new OpenVault(blob, raw, wrapped, where);
  await v.seal(true);
  return v;
}

/** Open a vault file with its password. Changes of a session that ended without a save
 * (the app was killed) are still in the private folder: they are kept and saved now. */
export async function unlockVault(blob, password, where) {
  need();
  recoverFile(blob);
  const { header } = await readHeader(blob);
  const raw = await unwrapKey(header, String(password ?? ''));
  const v = new OpenVault(blob, raw, header, where);
  const left = readJson(where.state);
  const kept = left && left.blob === blob && native.sync('fs.exists', { path: where.work }) && (await fingerprint(Object.values(v.sources))) !== left.sealed;
  if (kept) await v.seal(true);
  else {
    wipe(where.dir);
    native.sync('fs.mkdirs', { path: where.work });
    await readBlob(blob, raw, v.sources);
    v.sealed = await fingerprint(Object.values(v.sources));
    native.sync('fs.writeText', { path: where.state, text: JSON.stringify({ blob, sealed: v.sealed }) });
  }
  return v;
}

/** A new password for a vault file: the old one is asked and checked first. */
export async function changePassword(blob, oldPassword, newPassword, open = null) {
  need();
  const pw = checkPassword(newPassword);
  const { header, bodyAt, size } = await readHeader(blob);
  const raw = await unwrapKey(header, String(oldPassword ?? ''));
  const next = { ...header, ...(await wrapKey(raw, pw)) };
  if (open) await open.seal(); // what is not saved yet goes in with the old header first
  const cur = open ? await readHeader(blob) : { header, bodyAt, size };
  const fresh = { ...cur.header, kdf: next.kdf, wrap: next.wrap };
  const tmp = blob + '.tmp';
  native.sync('fs.writeB64', { path: tmp, b64: bytesToB64(headerBytes(fresh)) });
  for (let at = cur.bodyAt; at < cur.size; at += 4 * PIECE) await append(tmp, await readRange(blob, at, Math.min(4 * PIECE, cur.size - at)));
  replaceFile(tmp, blob);
  if (open) open.header = fresh;
  return true;
}

// ---------------------------------------------------------------- the session (a vault left open across a reload of the page)
export function saveSession(v) {
  native.sync('secret.set', { name: SESSION, value: JSON.stringify({ blob: v.blob, key: bytesToB64(v.raw) }) });
  try { globalThis.sessionStorage?.setItem('skn-vault-session', v.blob); } catch { /* the vault is asked for again after a reload */ }
}

export function endSession() {
  try { native.sync('secret.delete', { name: SESSION }); } catch { /* none */ }
  try { globalThis.sessionStorage?.removeItem('skn-vault-session'); } catch { /* none */ }
}

/** The vault that was open before the page was loaded again, or null (a fresh start of the app:
 * the key kept for the session is thrown away). */
export async function resumeSession(whereOf) {
  let flag = null;
  try { flag = globalThis.sessionStorage?.getItem('skn-vault-session') || null; } catch { flag = null; }
  let kept = null;
  try { kept = JSON.parse(native.sync('secret.get', { name: SESSION }) || 'null'); } catch { kept = null; }
  if (!flag || !kept || kept.blob !== flag || !native.sync('fs.exists', { path: kept.blob })) { endSession(); return null; }
  const where = whereOf(kept.blob);
  const st = readJson(where.state);
  if (!st || st.blob !== kept.blob || !native.sync('fs.exists', { path: where.work })) { endSession(); return null; }
  let header;
  try { header = (await readHeader(kept.blob)).header; } catch { endSession(); return null; }
  const v = new OpenVault(kept.blob, b64ToBytes(kept.key), header, where);
  v.sealed = st.sealed;
  return v;
}

/** Empty the private folders of vaults that are not open. A folder with changes that never
 * reached its file is kept: they are saved the next time that vault is opened. */
export async function tidy(privateRoot, keepDir = null) {
  const base = `${privateRoot}/encrypted`;
  let dirs = [];
  try { dirs = native.sync('fs.exists', { path: base }) ? native.sync('fs.list', { path: base }) : []; } catch { dirs = []; }
  for (const d of dirs) {
    const dir = `${base}/${d.name}`;
    if (dir === keepDir) continue;
    const st = readJson(`${dir}/state.json`);
    let unsaved = false;
    if (st && st.blob && native.sync('fs.exists', { path: st.blob })) {
      const work = `${dir}/vault/${blobName(st.blob)}`;
      try { unsaved = native.sync('fs.exists', { path: work }) && (await fingerprint([work, `${dir}/data/history`])) !== st.sealed; } catch { unsaved = false; }
    }
    if (!unsaved) wipe(dir);
  }
}

export { wipe };
