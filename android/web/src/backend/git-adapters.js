// sk_notes for Android – files and network for the Git library, through the native side.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Git sync uses isomorphic-git, a Git written in JavaScript. It asks for two things: a file
// system and an HTTP client. Both are given here on top of the native calls (fs.*, net.*).
// Every call is asynchronous: a long sync never freezes the page.

import { native } from './native.js';
import { b64ToBytes, bytesToB64 } from './util.js';

// taken now, before any plugin runs (plugins share the page)
const encodeB64 = globalThis.btoa;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8');

const KNOWN = new Set(['ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EACCES', 'ENOSPC', 'ENOTEMPTY']);

function fsError(code, path) {
  const e = new Error(`${code}: ${path}`);
  e.code = code;
  e.path = path;
  return e;
}

async function fsCall(method, params, path) {
  try {
    return await native.async(method, params);
  } catch (e) {
    throw fsError(KNOWN.has(e?.code) ? e.code : 'EIO', `${path}${e?.detail ? ' (' + e.detail + ')' : ''}`);
  }
}

const toBytes = (data) => (typeof data === 'string' ? utf8.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));

/** The `fs` object isomorphic-git works with (promise style, absolute paths). */
export function createGitFs() {
  const stat = async (path) => {
    const st = await fsCall('fs.stat', { path }, path);
    if (!st) throw fsError('ENOENT', path);
    const dir = st.type === 'dir';
    const ms = Number(st.mtime) || 0;
    return {
      type: dir ? 'dir' : 'file', mode: dir ? 0o40000 : 0o100644, size: dir ? 0 : Number(st.size) || 0, ino: 0, uid: 1, gid: 1, dev: 1,
      mtimeMs: ms, ctimeMs: ms, mtime: new Date(ms), ctime: new Date(ms),
      isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false,
    };
  };
  const readFile = async (path, opts) => {
    const bytes = b64ToBytes(await fsCall('fs.readB64', { path }, path));
    const enc = typeof opts === 'string' ? opts : opts?.encoding;
    return enc === 'utf8' || enc === 'utf-8' ? fromUtf8.decode(bytes) : bytes;
  };
  const writeFile = async (path, data) => { await fsCall('fs.writeB64', { path, b64: bytesToB64(toBytes(data)) }, path); };
  const readdir = async (path) => (await fsCall('fs.list', { path }, path)).map((e) => e.name);
  const promises = {
    readFile,
    writeFile,
    readdir,
    stat,
    lstat: stat,
    mkdir: async (path) => { await fsCall('fs.mkdirs', { path }, path); },
    rmdir: async (path) => {
      if ((await readdir(path)).length) throw fsError('ENOTEMPTY', path);
      await fsCall('fs.delete', { path, recursive: true }, path); // empty: checked above
    },
    unlink: async (path) => {
      if (!(await fsCall('fs.delete', { path, recursive: false }, path))) throw fsError('ENOENT', path);
    },
    // Android's shared storage has no links: a link of the repository is kept as a small
    // file holding the address it points to
    readlink: async (path) => readFile(path, 'utf8'),
    symlink: async (target, path) => writeFile(path, String(target)),
  };
  return { promises };
}

async function collect(body) {
  if (!body) return null;
  const parts = [];
  let size = 0;
  for await (const chunk of body) {
    const c = toBytes(chunk);
    parts.push(c);
    size += c.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const CHUNK = 4 * 1024 * 1024;
let counter = 0;

/** Does `url` belong to the repository at `base` (same site, same repository path)? */
export function sameRepository(url, base) {
  try {
    const a = new URL(url);
    const b = new URL(base);
    if (a.origin !== b.origin) return false;
    const root = b.pathname.replace(/\/+$/, '');
    return a.pathname === root || a.pathname.startsWith(root + '/');
  } catch { return false; }
}

/** HTTP for Git (and for the sites' own APIs).
 * auth() → {base, header: {name: value}} or null. The header with the password or token is
 * added here, at the very last step, and only to requests for that repository: it never
 * passes through other code. Replies are saved to a file of `tmpDir` by the native side and
 * read in pieces, so a large download is never held in memory three times over. */
export function createGitHttp({ tmpDir, auth = () => null, timeout = 300 }) {
  return {
    async request({ url, method = 'GET', headers = {}, body }) {
      const data = await collect(body);
      const h = {};
      for (const [k, v] of Object.entries(headers || {})) if (!/^(authorization|private-token)$/i.test(k)) h[k] = String(v);
      h['User-Agent'] = 'git/sk_notes'; // Git hosting sites answer Git clients only
      const a = auth();
      if (a && sameRepository(url, a.base)) Object.assign(h, a.header);
      const file = `${tmpDir}/reply-${Date.now()}-${++counter}`;
      await native.async('fs.mkdirs', { path: tmpDir });
      const r = await native.async('net.request', { url, method, headers: h, body: data && data.length ? bytesToB64(data) : '', timeout, toFile: file });
      const size = Number(r.size) || 0;
      async function* reply() {
        try {
          if (typeof r.b64 === 'string') { yield b64ToBytes(r.b64); return; } // a native side without "toFile"
          for (let at = 0; at < size; at += CHUNK) yield b64ToBytes(await native.async('fs.readRange', { path: file, offset: at, length: Math.min(CHUNK, size - at) }));
        } finally {
          native.async('fs.delete', { path: file, recursive: false }).catch(() => {});
        }
      }
      return { url, method, statusCode: r.status, statusMessage: String(r.status), headers: r.headers || {}, body: reply() };
    },
  };
}

/** "Basic" sign-in header for a name and a password or token. */
export function basicAuth(user, secret) {
  let bin = '';
  for (const b of utf8.encode(`${user}:${secret}`)) bin += String.fromCharCode(b);
  return 'Basic ' + encodeB64(bin);
}
