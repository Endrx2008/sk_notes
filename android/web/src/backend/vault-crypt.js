// sk_notes for Android – encrypted vaults: a whole vault kept as one encrypted file.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// An encrypted vault is a file "<Name>.skvault" in the folder the user chose. It holds every
// file of the vault (and the version history of its notes), encrypted with a password.
// Encryption is for a vault as a whole, never for single notes. A vault can be made
// encrypted, or an existing one encrypted later; an encrypted one can be turned back into a
// normal folder.
//
// While the vault is open its files are decrypted into a private folder of the app (which
// other apps cannot read) and sk_notes works there as with any vault. Changes go into the
// file a little after they are made and whenever the app is left: only what changed is
// added at the end of the file, and the whole file is written again (compacted) only when
// old versions take more room than the vault itself. The vault locks by itself after the
// time the user chose; locked, the private folder is emptied.
//
// The file:
//   "SKNVAULT1\n"  u32 length  header (JSON)
//   then segments, one per save:  "SEG2"  nonce (8 bytes)  pieces
//   a piece:  u32 length  AES-256-GCM(up to 1 MiB of records)
// Records: a file (path, time, bytes), a folder, a removal, the end of the segment.
// Every piece is authenticated with the number of its segment, its own number and whether
// it is the last of its segment: pieces cannot be swapped, moved between segments or
// dropped from the middle. A save cut short (the app killed while writing) leaves an
// incomplete last piece: it is noticed, what was complete before it is kept, and the
// file is written whole again. A complete piece that does not open is refused as damage.
//
// Keys: the pieces are encrypted with a random vault key. The header holds that key
// encrypted with a key made from the password (PBKDF2-HMAC-SHA256, 600 000 rounds), and a
// second time with a key made from the recovery code shown when the vault is made: with
// the code a forgotten password can be replaced. Without both, nothing can open the vault.

import { native } from './native.js';
import { ApiError, b64ToBytes, bytesToB64 } from './util.js';

export const BLOB_EXT = 'skvault';
const MAGIC = 'SKNVAULT1\n';
const SEG = 'SEG2';
const PIECE = 1024 * 1024;
const MB = 1024 * 1024;
const ROUNDS = 600000;
const RECOVERY_ROUNDS = 100000; // the code itself is long and random
const MIN_PASSWORD = 8;
const SESSION = 'vault-session'; // native secret: the key of the vault that is open, while it is open
const SKIP = ['.git', '.trash']; // repository data of other tools and the trash stay out of the file
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

// taken now, before any plugin runs (plugins share the page)
const subtle = globalThis.crypto?.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8');

export const isBlobPath = (path) => new RegExp(`\\.${BLOB_EXT}$`, 'i').test(String(path || ''));
export const blobName = (path) => String(path).slice(String(path).lastIndexOf('/') + 1).replace(new RegExp(`\\.${BLOB_EXT}$`, 'i'), '');
const parentOf = (path) => String(path).slice(0, String(path).lastIndexOf('/'));

function need() {
  if (!subtle) throw new ApiError('crypt-unavailable');
}

export function checkPassword(password) {
  const p = String(password ?? '').normalize('NFC');
  if (p.length < MIN_PASSWORD) throw new ApiError('password-short', String(MIN_PASSWORD));
  return p;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

/** A name beside `path` that is not in use: "Name (<what> <date>).ext". */
function besideName(path, what, taken) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const when = stamp();
  for (let n = 1; ; n++) {
    const c = `${dir}${base} (${what} ${when}${n > 1 ? ' ' + n : ''})${ext}`;
    if (!taken(c)) return c;
  }
}

// ---------------------------------------------------------------- keys
async function slowKey(secret, salt, rounds) {
  const base = await subtle.importKey('raw', utf8.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const dataKey = (raw) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

async function wrapWith(raw, secret, rounds) {
  const salt = random(16);
  const iv = random(12);
  const kek = await slowKey(secret, salt, rounds);
  const key = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw));
  return { kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: rounds, salt: bytesToB64(salt) }, wrap: { iv: bytesToB64(iv), key: bytesToB64(key) } };
}

async function unwrapWith(part, secret, wrongCode) {
  const rounds = Number(part?.kdf?.iterations) || 0;
  if (part?.kdf?.name !== 'PBKDF2' || rounds < 1000 || rounds > 50000000 || !part.wrap?.key) throw new ApiError('crypt-damaged', 'header');
  const kek = await slowKey(secret, b64ToBytes(part.kdf.salt), rounds);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(part.wrap.iv) }, kek, b64ToBytes(part.wrap.key)));
  } catch { throw new ApiError(wrongCode); }
}

const wrapPassword = (raw, password) => wrapWith(raw, String(password).normalize('NFC'), ROUNDS);
const unwrapPassword = (header, password) => unwrapWith(header, String(password ?? '').normalize('NFC'), 'wrong-password');

/** A recovery code: 24 letters and digits in groups of four (120 random bits). */
function newCode() {
  const b = random(24);
  let s = '';
  for (let i = 0; i < 24; i++) s += CODE_CHARS[b[i] % 32];
  return s.match(/.{4}/g).join('-');
}
const cleanCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1');

async function wrapRecovery(raw) {
  const code = newCode();
  return { code, part: await wrapWith(raw, cleanCode(code), RECOVERY_ROUNDS) };
}

async function unwrapRecovery(header, code) {
  if (!header.recovery) throw new ApiError('no-recovery');
  return unwrapWith(header.recovery, cleanCode(code), 'wrong-code');
}

// ---------------------------------------------------------------- the file: header
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const readRange = async (path, offset, length) => b64ToBytes(await native.async('fs.readRange', { path, offset, length }));
const append = (path, bytes) => native.async('fs.append', { path, b64: bytesToB64(bytes) });
const statOf = (path) => { try { return native.sync('fs.stat', { path }); } catch { return null; } };

function join(parts) {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** {header, bodyAt, size} of an encrypted vault file. */
export async function readHeader(blob) {
  const st = statOf(blob);
  if (!st || st.type !== 'file') throw new ApiError('not-found', blob);
  const head = await readRange(blob, 0, MAGIC.length + 4);
  if (head.length < MAGIC.length + 4 || fromUtf8.decode(head.subarray(0, MAGIC.length)) !== MAGIC) throw new ApiError('crypt-damaged', 'not an encrypted vault');
  const len = new DataView(head.buffer, head.byteOffset + MAGIC.length, 4).getUint32(0);
  if (!len || len > 65536) throw new ApiError('crypt-damaged', 'header');
  let header;
  try { header = JSON.parse(fromUtf8.decode(await readRange(blob, MAGIC.length + 4, len))); } catch { throw new ApiError('crypt-damaged', 'header'); }
  if (!header || (header.v !== 1 && header.v !== 2) || !header.wrap?.key) throw new ApiError('crypt-damaged', 'header');
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

/** A full save stopped half-way (the app was killed): the file that was there is put back. */
export function recoverFile(blob) {
  try {
    if (!native.sync('fs.exists', { path: blob }) && native.sync('fs.exists', { path: blob + '.old' })) native.sync('fs.rename', { from: blob + '.old', to: blob });
    native.sync('fs.delete', { path: blob + '.tmp', recursive: false });
  } catch { /* nothing to put back */ }
}

// ---------------------------------------------------------------- records and segments
const aad = (seg, piece, last) => { const b = new Uint8Array(9); const dv = new DataView(b.buffer); dv.setUint32(0, seg); dv.setUint32(4, piece); b[8] = last ? 1 : 0; return b; };
const pieceIv = (nonce, index) => { const iv = new Uint8Array(12); iv.set(nonce, 0); new DataView(iv.buffer).setUint32(8, index); return iv; };

function recordHead(kind, path, size, mtime) {
  const p = utf8.encode(path);
  const head = new Uint8Array(15 + p.length);
  const dv = new DataView(head.buffer);
  head[0] = kind;
  dv.setUint16(1, p.length);
  head.set(p, 3);
  dv.setUint32(3 + p.length, size);
  dv.setFloat64(7 + p.length, Number(mtime) || 0);
  return head;
}

/** Append one segment to `target`; `produce(file, folder, remove)` gives its records. Returns its size. */
async function writeSegment(target, key, seg, produce) {
  const nonce = random(8);
  await append(target, join([utf8.encode(SEG), nonce]));
  let written = 12;
  let index = 0;
  let pending = [];
  let size = 0;
  const piece = async (bytes, last) => {
    const enc = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: pieceIv(nonce, index), additionalData: aad(seg, index, last) }, key, bytes));
    const out = join([u32(enc.length), enc]);
    await append(target, out);
    written += out.length;
    index += 1;
  };
  const flush = async (last) => {
    const all = join(pending);
    let at = 0;
    while (all.length - at >= PIECE && !(last && all.length - at === PIECE)) { await piece(all.subarray(at, at + PIECE), false); at += PIECE; }
    if (last) { await piece(all.subarray(at), true); pending = []; size = 0; return; }
    pending = at < all.length ? [all.slice(at)] : [];
    size = all.length - at;
  };
  const push = async (bytes) => { pending.push(bytes); size += bytes.length; if (size >= 2 * PIECE) await flush(false); };
  await produce({
    file: async (path, data, mtime) => { await push(recordHead(1, path, data.length, mtime)); if (data.length) await push(data); },
    folder: (path) => push(recordHead(2, path, 0, 0)),
    remove: (path) => push(recordHead(3, path, 0, 0)),
  });
  await push(recordHead(0, '', 0, 0));
  await flush(true);
  return written;
}

/** Apply the records of a vault file to the folders of `targets` ({prefix: folder}).
 * → {segments, torn, end}: torn when the last segment is incomplete (a save cut short). */
async function replay(blob, raw, targets) {
  need();
  const { header, bodyAt, size } = await readHeader(blob);
  if (header.v === 1) return replayV1(blob, raw, targets, header, bodyAt, size);
  const key = await dataKey(raw);
  let buf = new Uint8Array(0);
  let ended = false;
  const apply = (kind, path, data, mtime) => {
    const slash = path.indexOf('/');
    const folder = targets[path.slice(0, slash)];
    const rel = path.slice(slash + 1);
    // a file may only land inside its folder
    if (!folder || !rel || rel.split('/').some((x) => x === '..' || x === '.' || x === '') || rel.includes('\\') || rel.includes('\u0000')) throw new ApiError('crypt-damaged', 'path');
    if (kind === 2) native.sync('fs.mkdirs', { path: `${folder}/${rel}` });
    else if (kind === 1) native.sync('fs.writeB64', { path: `${folder}/${rel}`, b64: bytesToB64(data), mtime: Math.floor(mtime) || 0 });
    else if (kind === 3) native.sync('fs.delete', { path: `${folder}/${rel}`, recursive: true });
    else throw new ApiError('crypt-damaged', 'record');
  };
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
      apply(kind, path, data, mtime);
    }
  };
  let at = bodyAt;
  let seg = 0;
  let end = bodyAt; // where the last complete segment ends
  while (at < size) {
    if (size - at < 12) return { segments: seg, torn: true, end, version: 2 };
    const head = await readRange(blob, at, 12);
    if (fromUtf8.decode(head.subarray(0, 4)) !== SEG) {
      if (seg === 0) throw new ApiError('crypt-damaged', 'segment');
      return { segments: seg, torn: true, end, version: 2 };
    }
    const nonce = head.subarray(4, 12);
    at += 12;
    buf = new Uint8Array(0);
    ended = false;
    let index = 0;
    let done = false;
    while (!done) {
      if (size - at < 4) return { segments: seg, torn: true, end, version: 2 };
      const lb = await readRange(blob, at, 4);
      const len = new DataView(lb.buffer, lb.byteOffset, 4).getUint32(0);
      if (len < 16 || len > PIECE + 64 || at + 4 + len > size) {
        if (at + 4 + len > size || len > PIECE + 64) return { segments: seg, torn: true, end, version: 2 };
        throw new ApiError('crypt-damaged', `piece ${seg}.${index}`);
      }
      const enc = await readRange(blob, at + 4, len);
      let plain = null;
      for (const last of [false, true]) {
        try {
          plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: pieceIv(nonce, index), additionalData: aad(seg, index, last) }, key, enc));
          done = last;
          break;
        } catch { /* the other flag */ }
      }
      // a save cut short leaves a piece shorter than its length (handled above); a whole piece
      // that does not open is damage, or a piece moved from elsewhere, even at the end of the file
      if (!plain) throw new ApiError('crypt-damaged', `piece ${seg}.${index}`);
      buf = buf.length ? join([buf, plain]) : plain;
      consume();
      at += 4 + len;
      index += 1;
    }
    if (!ended) throw new ApiError('crypt-damaged', `segment ${seg}`);
    seg += 1;
    end = at;
  }
  if (seg === 0) throw new ApiError('crypt-damaged', 'empty');
  return { segments: seg, torn: false, end, version: 2 };
}

/** Files in the first format: one stream of pieces, no segments. Opened, then written again in the new form. */
async function replayV1(blob, raw, targets, header, bodyAt, size) {
  const key = await dataKey(raw);
  const nonce = b64ToBytes(header.data?.nonce || '');
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
    const lb = await readRange(blob, at, 4);
    if (lb.length < 4) throw new ApiError('crypt-damaged', 'cut short');
    const len = new DataView(lb.buffer, lb.byteOffset, 4).getUint32(0);
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
  return { segments: 1, torn: false, end: size, version: 1 };
}

// ---------------------------------------------------------------- what the folders hold
/** {map: Map("v/rel" → "d" | "size:mtime"), key, live (bytes)} of the folders of `sources`. */
async function scanState(sources) {
  const map = new Map();
  let live = 0;
  for (const [prefix, folder] of Object.entries(sources)) {
    if (!native.sync('fs.exists', { path: folder })) continue;
    const rows = await native.async('fs.scan', { path: folder, ignore: prefix === 'v' ? SKIP : [], skipHidden: false });
    for (const [rel, isDir, size, mtime] of rows) {
      if (/(^|\/)\.skn-tmp-[^/]*$/.test(rel)) continue;
      map.set(`${prefix}/${rel}`, isDir ? 'd' : `${size}:${Math.floor(mtime)}`);
      if (!isDir) live += Number(size) || 0;
    }
  }
  const text = [...map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}\u0000${v}`).join('\n');
  const key = bytesToB64(new Uint8Array(await subtle.digest('SHA-256', utf8.encode(text))));
  return { map, key, live };
}

const sourcesOf = (where) => ({ v: where.work, h: `${where.data}/history` });
const readJson = (path) => { try { return JSON.parse(native.sync('fs.readText', { path }).text); } catch { return null; } };
export const wipe = (path) => { try { native.sync('fs.delete', { path, recursive: true }); } catch { /* none */ } };

/** Where a vault file is worked on: {dir, work: its files, data: history and caches}. */
export function places(privateRoot, blob, idOf) {
  const dir = `${privateRoot}/encrypted/${idOf(blob)}`;
  return { dir, work: `${dir}/vault/${blobName(blob)}`, data: `${dir}/data`, state: `${dir}/state.json` };
}

/** Write the whole vault file again from `sources`: one segment with every file. */
async function writeWhole(blob, raw, header, sources) {
  const key = await dataKey(raw);
  const tmp = blob + '.tmp';
  native.sync('fs.writeB64', { path: tmp, b64: bytesToB64(headerBytes(header)) });
  const state = await scanState(sources);
  await writeSegment(tmp, key, 0, async (r) => {
    for (const [k, sig] of state.map) if (sig === 'd') await r.folder(k);
    for (const [k, sig] of state.map) {
      if (sig === 'd') continue;
      const slash = k.indexOf('/');
      const abs = `${sources[k.slice(0, slash)]}/${k.slice(slash + 1)}`;
      let data;
      try { data = b64ToBytes(await native.async('fs.readB64', { path: abs })); } catch { continue; } // gone meanwhile
      await r.file(k, data, Number(sig.split(':')[1]) || 0);
    }
  });
  replaceFile(tmp, blob);
  return state;
}

// ---------------------------------------------------------------- an open vault
export class OpenVault {
  constructor(blob, raw, header, where) {
    Object.assign(this, { blob, raw, header, where });
    this.manifest = null; // Map: what the file holds ("v/rel" → signature)
    this.sealedKey = null;
    this.segments = 0;
    this.fileSize = 0;
    this.needsWhole = true;
    this.busy = null;
    this.timer = null;
    this.conflicts = [];
  }

  get sources() { return sourcesOf(this.where); }

  async changed() { return (await scanState(this.sources)).key !== this.sealedKey; }

  _remember(state) {
    this.manifest = state.map;
    this.sealedKey = state.key;
    this.fileSize = Number(statOf(this.blob)?.size) || 0;
    native.sync('fs.mkdirs', { path: this.where.dir });
    native.sync('fs.writeText', { path: this.where.state, text: JSON.stringify({ v: 2, blob: this.blob, sealed: state.key, segments: this.segments, size: this.fileSize, manifest: Object.fromEntries(state.map) }) });
  }

  /** Take back what an earlier session of this vault wrote down (state.json). */
  adopt(st) {
    this.sealedKey = st.sealed;
    this.segments = Number(st.segments) || 0;
    this.fileSize = Number(st.size) || 0;
    this.manifest = st.manifest ? new Map(Object.entries(st.manifest)) : null;
    this.needsWhole = !st.manifest || !this.segments;
  }

  /** The file was replaced by someone else (a sync app brought another device's copy): that copy is kept beside. */
  _keepForeign() {
    const st = statOf(this.blob);
    if (!st || !this.fileSize || Number(st.size) === this.fileSize) return null;
    const copy = besideName(this.blob, 'other version', (p) => native.sync('fs.exists', { path: p }));
    native.sync('fs.rename', { from: this.blob, to: copy });
    this.needsWhole = true;
    return copy;
  }

  /** Bring the file up to date with the folders. Only what changed is added, unless the file
   * must be written whole (first save, old format, cut-short save, too many old versions). */
  seal(whole = false) {
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = (async () => {
      try {
        do {
          this.again = false;
          const cur = await scanState(this.sources);
          if (!whole && !this.needsWhole && cur.key === this.sealedKey) continue;
          const foreign = this._keepForeign();
          if (foreign) this.foreign = foreign;
          const bulky = this.fileSize > 2 * cur.live + MB; // old versions take more room than the vault
          if (whole || this.needsWhole || !this.manifest || bulky) {
            // written whole: always in the present form (a file of the first format says so in its header)
            if (this.header.v !== 2) this.header = { ...this.header, v: 2, data: { cipher: 'AES-256-GCM', piece: PIECE, form: 'segments' } };
            const done = await writeWhole(this.blob, this.raw, this.header, this.sources);
            this.segments = 1;
            this.needsWhole = false;
            this._remember(done);
          } else {
            await this._append(cur);
          }
          whole = false;
        } while (this.again);
      } finally { this.busy = null; }
    })();
    return this.busy;
  }

  async _append(cur) {
    const key = await dataKey(this.raw);
    const old = this.manifest;
    const gone = [...old.keys()].filter((k) => !cur.map.has(k) || (old.get(k) === 'd') !== (cur.map.get(k) === 'd'));
    // removals of what is inside a removed folder go with the folder
    const removed = gone.filter((k) => !gone.some((g) => g !== k && old.get(g) === 'd' && k.startsWith(g + '/')));
    const folders = [...cur.map].filter(([k, s]) => s === 'd' && old.get(k) !== 'd').map(([k]) => k);
    const files = [...cur.map].filter(([k, s]) => s !== 'd' && old.get(k) !== s).map(([k]) => k);
    await writeSegment(this.blob, key, this.segments, async (r) => {
      for (const k of removed) await r.remove(k);
      for (const k of folders) await r.folder(k);
      for (const k of files) {
        const slash = k.indexOf('/');
        let data;
        try { data = b64ToBytes(await native.async('fs.readB64', { path: `${this.sources[k.slice(0, slash)]}/${k.slice(slash + 1)}` })); } catch { continue; }
        await r.file(k, data, Number(cur.map.get(k).split(':')[1]) || 0);
      }
    });
    this.segments += 1;
    this._remember(cur);
  }

  /** Something changed: the file is brought up to date shortly (changes made in a row go in once). */
  touch(delay = 8000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.seal().catch((e) => console.error('encrypted vault not saved', e)); }, delay);
  }
}

/** Decrypt the file into the vault's private folder (emptied first). */
async function openFresh(v) {
  wipe(v.where.dir);
  native.sync('fs.mkdirs', { path: v.where.work });
  const r = await replay(v.blob, v.raw, v.sources);
  v.segments = r.segments;
  v.needsWhole = r.torn || r.version === 1;
  v.torn = r.torn;
  v._remember(await scanState(v.sources));
  if (v.needsWhole) await v.seal(); // an old format, or a save cut short: written whole now
}

/** Open with the vault key. Changes of a session that never reached the file (the app was
 * killed) are still in the private folder: they are added now. If meanwhile the file was
 * replaced (by a sync app), those changes are put beside the notes as conflict copies. */
async function openWithKey(blob, raw, header, where) {
  const v = new OpenVault(blob, raw, header, where);
  const left = readJson(where.state);
  if (left && left.blob === blob && native.sync('fs.exists', { path: where.work })) {
    const cur = await scanState(v.sources);
    if (cur.key !== left.sealed) {
      const sameFile = Number(statOf(blob)?.size) === Number(left.size);
      if (sameFile && left.manifest) {
        v.adopt(left);
        await v.seal();
        return v;
      }
      // the file changed elsewhere: it wins, and the unsaved notes of this device are kept as copies
      const stale = `${where.dir}/stale`;
      wipe(stale);
      native.sync('fs.rename', { from: where.work, to: stale });
      const before = left.manifest || {};
      const keep = [];
      for (const [k, sig] of cur.map) if (k.startsWith('v/') && sig !== 'd' && before[k] !== sig) keep.push(k.slice(2));
      const saved = [];
      for (const rel of keep) saved.push([rel, native.sync('fs.readB64', { path: `${stale}/${rel}` })]);
      wipe(where.work);
      wipe(`${where.data}`);
      await openFresh(v);
      for (const [rel, b64] of saved) {
        const here = `${where.work}/${rel}`;
        let same = false;
        try { same = native.sync('fs.readB64', { path: here }) === b64; } catch { same = false; }
        if (same) continue;
        const clash = native.sync('fs.exists', { path: here });
        const copy = clash ? besideName(here, 'conflict', (p) => native.sync('fs.exists', { path: p })) : here;
        native.sync('fs.writeB64', { path: copy, b64 });
        if (clash) v.conflicts.push(copy.slice(where.work.length + 1));
      }
      wipe(stale);
      if (saved.length) await v.seal();
      return v;
    }
  }
  await openFresh(v);
  return v;
}

// ---------------------------------------------------------------- making, opening, changing
/** A new, empty encrypted vault file, opened. → {vault, recovery} (the code to write down). */
export async function createVault(blob, password, where) {
  need();
  const pw = checkPassword(password);
  if (native.sync('fs.exists', { path: blob })) throw new ApiError('already-exists', blob);
  const raw = random(32);
  const rec = await wrapRecovery(raw);
  const header = { v: 2, app: 'sk_notes', name: blobName(blob), ...(await wrapPassword(raw, pw)), recovery: rec.part, data: { cipher: 'AES-256-GCM', piece: PIECE, form: 'segments' } };
  wipe(where.dir);
  native.sync('fs.mkdirs', { path: where.work });
  const v = new OpenVault(blob, raw, header, where);
  await v.seal(true);
  return { vault: v, recovery: rec.code };
}

/** Same bytes in both folders (names, sizes and contents)? */
async function sameTree(a, b) {
  const sa = await scanState({ v: a });
  const sb = await scanState({ v: b });
  if (sa.map.size !== sb.map.size) return false;
  for (const [k, s] of sa.map) {
    const t = sb.map.get(k);
    if (t === undefined || (s === 'd') !== (t === 'd') || (s !== 'd' && s.split(':')[0] !== t.split(':')[0])) return false;
  }
  for (const [k, s] of sa.map) {
    if (s === 'd') continue;
    const rel = k.slice(2);
    const [x, y] = [native.sync('fs.readB64', { path: `${a}/${rel}` }), native.sync('fs.readB64', { path: `${b}/${rel}` })];
    if (x !== y) return false;
  }
  return true;
}

/** An existing vault (a folder) made into an encrypted vault file. The file is opened again
 * and compared with the folder before anything else happens. → {vault, recovery}. */
export async function encryptFolder(folder, historyDir, blob, password, where) {
  need();
  const pw = checkPassword(password);
  if (native.sync('fs.exists', { path: blob })) throw new ApiError('already-exists', blob);
  const raw = random(32);
  const rec = await wrapRecovery(raw);
  const header = { v: 2, app: 'sk_notes', name: blobName(blob), ...(await wrapPassword(raw, pw)), recovery: rec.part, data: { cipher: 'AES-256-GCM', piece: PIECE, form: 'segments' } };
  await writeWhole(blob, raw, header, { v: folder, h: historyDir });
  const v = new OpenVault(blob, raw, header, where);
  try {
    await openFresh(v);
    // every file of the folder (but .git and .trash, which stay out) came back the same
    if (!(await sameTree(folder, v.where.work))) throw new ApiError('crypt-verify-failed');
  } catch (e) {
    wipe(where.dir);
    try { native.sync('fs.delete', { path: blob, recursive: false }); } catch { /* none */ }
    throw e;
  }
  return { vault: v, recovery: rec.code };
}

/** Open a vault file with its password. */
export async function unlockVault(blob, password, where) {
  need();
  recoverFile(blob);
  const { header } = await readHeader(blob);
  const raw = await unwrapPassword(header, password);
  return openWithKey(blob, raw, header, where);
}

/** Is this the password of the vault file? Throws "wrong-password" when not. */
export async function verifyPassword(blob, password) {
  need();
  const { header } = await readHeader(blob);
  await unwrapPassword(header, password);
  return true;
}

/** Write a new header (the notes are copied as they are, still encrypted). */
async function rewriteHeader(blob, change, open) {
  if (open) await open.seal(); // what is not saved yet goes in first
  const cur = await readHeader(blob);
  const fresh = await change(cur.header);
  const tmp = blob + '.tmp';
  native.sync('fs.writeB64', { path: tmp, b64: bytesToB64(headerBytes(fresh)) });
  for (let at = cur.bodyAt; at < cur.size; at += 4 * PIECE) await append(tmp, await readRange(blob, at, Math.min(4 * PIECE, cur.size - at)));
  replaceFile(tmp, blob);
  if (open) {
    open.header = fresh;
    open._remember(await scanState(open.sources));
  }
  return fresh;
}

/** A new password: the old one is asked and checked first. */
export async function changePassword(blob, oldPassword, newPassword, open = null) {
  need();
  const pw = checkPassword(newPassword);
  const raw = await unwrapPassword((await readHeader(blob)).header, oldPassword);
  await rewriteHeader(blob, async (h) => ({ ...h, ...(await wrapPassword(raw, pw)) }), open);
  return true;
}

/** A forgotten password replaced with the recovery code. */
export async function recoverPassword(blob, code, newPassword, open = null) {
  need();
  const pw = checkPassword(newPassword);
  const raw = await unwrapRecovery((await readHeader(blob)).header, code);
  await rewriteHeader(blob, async (h) => ({ ...h, ...(await wrapPassword(raw, pw)) }), open);
  return true;
}

/** A new recovery code (the old one stops working). Needs the password. → the code. */
export async function newRecoveryCode(blob, password, open = null) {
  need();
  const raw = await unwrapPassword((await readHeader(blob)).header, password);
  const rec = await wrapRecovery(raw);
  await rewriteHeader(blob, async (h) => ({ ...h, recovery: rec.part }), open);
  return rec.code;
}

export async function hasRecovery(blob) {
  try { return !!(await readHeader(blob)).header.recovery; } catch { return false; }
}

/** The open vault turned back into a normal folder `target` (which must not exist yet). */
export async function decryptTo(open, target, historyTarget) {
  await open.seal();
  if (native.sync('fs.exists', { path: target })) {
    if (native.sync('fs.list', { path: target }).length) throw new ApiError('already-exists', target);
    native.sync('fs.delete', { path: target, recursive: true });
  }
  native.sync('fs.copy', { from: open.where.work, to: target });
  const hist = `${open.where.data}/history`;
  if (native.sync('fs.exists', { path: hist })) {
    wipe(historyTarget);
    native.sync('fs.copy', { from: hist, to: historyTarget });
  }
  if (!(await sameTree(open.where.work, target))) {
    wipe(target);
    throw new ApiError('crypt-verify-failed');
  }
  return target;
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
  v.adopt(st);
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
      const where = { work: `${dir}/vault/${blobName(st.blob)}`, data: `${dir}/data` };
      try { unsaved = native.sync('fs.exists', { path: where.work }) && (await scanState(sourcesOf(where))).key !== st.sealed; } catch { unsaved = false; }
    }
    if (!unsaved) wipe(dir);
  }
}

export { parentOf };
