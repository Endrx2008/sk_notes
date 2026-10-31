// Controlled shims of the Node.js / Electron modules desktop plugins require().
// Every privileged call goes to Python with the plugin id, where permissions apply.

import { call, callSync } from '../core/api.js';
import { Events } from '../core/events.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(data, encoding) {
  let bytes;
  if (typeof data === 'string') bytes = encoding === 'base64' ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : enc.encode(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else bytes = enc.encode(String(data ?? ''));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------- Buffer (subset)
export class Buffer extends Uint8Array {
  static from(v, encoding) {
    if (typeof v === 'string') {
      if (encoding === 'base64') return Buffer._wrap(fromB64(v));
      if (encoding === 'hex') return Buffer._wrap(Uint8Array.from(v.match(/../g) || [], (h) => parseInt(h, 16)));
      return Buffer._wrap(enc.encode(v));
    }
    if (v instanceof ArrayBuffer) return Buffer._wrap(new Uint8Array(v));
    if (ArrayBuffer.isView(v) || Array.isArray(v)) return Buffer._wrap(Uint8Array.from(v));
    return Buffer._wrap(new Uint8Array(0));
  }
  static _wrap(u8) { const b = new Buffer(u8.length); b.set(u8); return b; }
  static alloc(n, fill = 0) { const b = new Buffer(n); b.fill(fill); return b; }
  static isBuffer(x) { return x instanceof Buffer; }
  static concat(list) { const n = list.reduce((s, x) => s + x.length, 0); const b = new Buffer(n); let o = 0; for (const x of list) { b.set(x, o); o += x.length; } return b; }
  static byteLength(s) { return enc.encode(String(s)).length; }
  toString(encoding) {
    if (encoding === 'base64') return toB64(this);
    if (encoding === 'hex') return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');
    return dec.decode(this);
  }
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
  equals(o) { return this.length === o.length && this.every((x, i) => x === o[i]); }
  write(str, offset = 0) { const b = enc.encode(str); this.set(b, offset); return b.length; }
}

function errno(e, path) {
  const err = new Error(`${e.code || 'EIO'}: ${e.detail || e.message || ''}${path ? `, '${path}'` : ''}`);
  err.code = e.code === 'not-found' ? 'ENOENT' : e.code === 'permission-denied' ? 'EACCES' : e.code;
  err.path = path;
  return err;
}

// ------------------------------------------------------------------- fs
export function makeFs(pluginId) {
  const sync = (op, path, extra = {}) => {
    try { return callSync('shim.fs', { op, path: String(path), ...extra }, pluginId); } catch (e) { throw errno(e, path); }
  };
  const asy = async (op, path, extra = {}) => {
    try { return await call('shim.fs', { op, path: String(path), ...extra }, pluginId); } catch (e) { throw errno(e, path); }
  };
  const decode = (r, opt) => {
    const encoding = typeof opt === 'string' ? opt : opt?.encoding;
    const bytes = fromB64(r.b64);
    return encoding ? (encoding === 'base64' ? r.b64 : dec.decode(bytes)) : Buffer._wrap(bytes);
  };
  const statObj = (s) => ({ ...s, isFile: () => s.isFile, isDirectory: () => s.isDirectory, isSymbolicLink: () => false,
    mtime: new Date(s.mtimeMs), ctime: new Date(s.ctimeMs), birthtime: new Date(s.birthtimeMs) });
  const promises = {
    readFile: async (p, opt) => decode(await asy('readFile', p), opt),
    writeFile: async (p, data, opt) => { await asy('writeFile', p, { b64: toB64(data, typeof opt === 'string' ? opt : opt?.encoding) }); },
    appendFile: async (p, data) => { await asy('appendFile', p, { b64: toB64(data) }); },
    access: async (p) => { if (!(await asy('exists', p))) throw errno({ code: 'ENOENT' }, p); },
    stat: async (p) => statObj(await asy('stat', p)),
    lstat: async (p) => statObj(await asy('stat', p)),
    readdir: async (p) => asy('readdir', p),
    mkdir: async (p, opt) => { await asy('mkdir', p, { recursive: !!opt?.recursive }); },
    rm: async (p, opt) => { await asy('rm', p, { recursive: !!opt?.recursive, force: !!opt?.force }); },
    rmdir: async (p, opt) => { await asy('rmdir', p, { recursive: !!opt?.recursive }); },
    unlink: async (p) => { await asy('unlink', p); },
    rename: async (a, b) => { await asy('rename', a, { dest: String(b) }); },
    copyFile: async (a, b) => { await asy('copyFile', a, { dest: String(b) }); },
  };
  const cbify = (fn) => (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    fn(...args).then((r) => cb?.(null, r), (e) => cb?.(e));
  };
  return {
    promises,
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    readFileSync: (p, opt) => decode(sync('readFile', p), opt),
    writeFileSync: (p, data, opt) => { sync('writeFile', p, { b64: toB64(data, typeof opt === 'string' ? opt : opt?.encoding) }); },
    appendFileSync: (p, data) => { sync('appendFile', p, { b64: toB64(data) }); },
    existsSync: (p) => { try { return !!sync('exists', p); } catch { return false; } },
    statSync: (p) => statObj(sync('stat', p)),
    lstatSync: (p) => statObj(sync('stat', p)),
    readdirSync: (p) => sync('readdir', p),
    mkdirSync: (p, opt) => { sync('mkdir', p, { recursive: !!opt?.recursive }); },
    rmSync: (p, opt) => { sync('rm', p, { recursive: !!opt?.recursive, force: !!opt?.force }); },
    rmdirSync: (p, opt) => { sync('rmdir', p, { recursive: !!opt?.recursive }); },
    unlinkSync: (p) => { sync('unlink', p); },
    renameSync: (a, b) => { sync('rename', a, { dest: String(b) }); },
    copyFileSync: (a, b) => { sync('copyFile', a, { dest: String(b) }); },
    accessSync: (p) => { if (!sync('exists', p)) throw errno({ code: 'ENOENT' }, p); },
    readFile: cbify(promises.readFile), writeFile: cbify(promises.writeFile), stat: cbify(promises.stat),
    readdir: cbify(promises.readdir), mkdir: cbify(promises.mkdir), unlink: cbify(promises.unlink),
    rename: cbify(promises.rename), exists: (p, cb) => promises.access(p).then(() => cb(true), () => cb(false)),
    watch: () => ({ close() {}, on() {} }),
    createReadStream: () => { throw errno({ code: 'ENOTSUP', message: 'streams are not available' }); },
    createWriteStream: () => { throw errno({ code: 'ENOTSUP', message: 'streams are not available' }); },
  };
}

// ------------------------------------------------------------------- path (POSIX)
function normalizeArray(parts, allowAbove) {
  const res = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { if (res.length && res[res.length - 1] !== '..') res.pop(); else if (allowAbove) res.push('..'); } else res.push(p);
  }
  return res;
}
export const path = {
  sep: '/', delimiter: ':',
  normalize(p) { const abs = p.startsWith('/'); const out = normalizeArray(p.split('/'), !abs).join('/'); return (abs ? '/' : '') + out || (abs ? '/' : '.'); },
  join(...ps) { return path.normalize(ps.filter((x) => x !== '').join('/')); },
  resolve(...ps) { let r = ''; for (let i = ps.length - 1; i >= 0 && !r.startsWith('/'); i--) r = ps[i] + (r ? '/' + r : ''); if (!r.startsWith('/')) r = (window.app?.vault?.adapter?.getBasePath?.() || '/') + '/' + r; return path.normalize(r); },
  isAbsolute(p) { return p.startsWith('/'); },
  dirname(p) { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i === -1 ? '.' : i === 0 ? '/' : p.slice(0, i); },
  basename(p, ext) { let b = p.replace(/\/+$/, '').split('/').pop(); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
  extname(p) { const b = path.basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
  relative(from, to) {
    const a = path.resolve(from).split('/').filter(Boolean);
    const b = path.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  },
  parse(p) { const base = path.basename(p); const ext = path.extname(p); return { root: p.startsWith('/') ? '/' : '', dir: path.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; },
  format(o) { return (o.dir ? o.dir + '/' : '') + (o.base || (o.name || '') + (o.ext || '')); },
};
path.posix = path;

// ------------------------------------------------------------------- events
export class EventEmitter {
  constructor() { this._l = new Map(); }
  on(n, fn) { if (!this._l.has(n)) this._l.set(n, []); this._l.get(n).push(fn); return this; }
  addListener(n, fn) { return this.on(n, fn); }
  once(n, fn) { const w = (...a) => { this.off(n, w); fn(...a); }; return this.on(n, w); }
  off(n, fn) { const l = this._l.get(n); if (l) this._l.set(n, l.filter((x) => x !== fn)); return this; }
  removeListener(n, fn) { return this.off(n, fn); }
  removeAllListeners(n) { if (n) this._l.delete(n); else this._l.clear(); return this; }
  emit(n, ...a) { const l = this._l.get(n); if (!l) return false; for (const fn of l.slice()) fn(...a); return true; }
  listenerCount(n) { return this._l.get(n)?.length || 0; }
  setMaxListeners() { return this; }
}

// ------------------------------------------------------------------- child_process
export function makeChildProcess(pluginId) {
  const run = async (cmd, args, opts, shell) => {
    const r = await call('shim.exec', { cmd, args, cwd: opts?.cwd, shell, timeout: opts?.timeout ? opts.timeout / 1000 : undefined,
      input: opts?.input ? toB64(opts.input) : undefined }, pluginId);
    return { code: r.code, stdout: dec.decode(fromB64(r.stdout || '')), stderr: dec.decode(fromB64(r.stderr || '')), error: r.error };
  };
  const proc = (promise) => {
    const cp = new EventEmitter();
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.stdin = { write() {}, end() {} };
    cp.kill = () => false;
    promise.then((r) => {
      if (r.stdout) cp.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) cp.stderr.emit('data', Buffer.from(r.stderr));
      cp.emit('exit', r.code);
      cp.emit('close', r.code);
    }, (e) => cp.emit('error', errno(e)));
    return cp;
  };
  const execCb = (cmd, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const p = run(cmd, [], opts, true);
    p.then((r) => cb?.(r.code ? Object.assign(new Error(r.stderr || `exit ${r.code}`), { code: r.code }) : null, r.stdout, r.stderr), (e) => cb?.(errno(e), '', ''));
    return proc(p);
  };
  const execFileCb = (file, args, opts, cb) => {
    if (typeof args === 'function') { cb = args; args = []; opts = {}; }
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const p = run(file, args || [], opts, false);
    p.then((r) => cb?.(r.code ? Object.assign(new Error(r.stderr || `exit ${r.code}`), { code: r.code }) : null, r.stdout, r.stderr), (e) => cb?.(errno(e), '', ''));
    return proc(p);
  };
  const syncRun = (cmd, args, opts, shell) => {
    let r;
    try { r = callSync('shim.exec', { cmd, args, cwd: opts?.cwd, shell }, pluginId); } catch (e) { throw errno(e); }
    const out = Buffer._wrap(fromB64(r.stdout || ''));
    if (r.code) throw Object.assign(new Error(dec.decode(fromB64(r.stderr || ''))), { status: r.code, stdout: out });
    return opts?.encoding ? out.toString() : out;
  };
  return {
    exec: execCb,
    execFile: execFileCb,
    spawn: (cmd, args, opts) => proc(run(cmd, args || [], opts, !!opts?.shell)),
    execSync: (cmd, opts) => syncRun(cmd, [], opts, true),
    execFileSync: (file, args, opts) => syncRun(file, args || [], opts, false),
    spawnSync: (cmd, args, opts) => { try { return { status: 0, stdout: syncRun(cmd, args || [], opts, false) }; } catch (e) { return { status: e.status || 1, stdout: e.stdout, error: e }; } },
  };
}

// ------------------------------------------------------------------- crypto
export function makeCrypto(pluginId) {
  return {
    randomBytes: (n) => { const b = new Buffer(n); crypto.getRandomValues(b); return b; },
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (a) => crypto.getRandomValues(a),
    webcrypto: crypto,
    subtle: crypto.subtle,
    createHash: (algo) => {
      const chunks = [];
      const h = {
        update(data, encoding) { chunks.push(typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data)); return h; },
        digest(encoding) {
          const r = callSync('shim.hash', { algo, b64: toB64(Buffer.concat(chunks)) }, pluginId);
          if (encoding === 'hex') return r.hex;
          if (encoding === 'base64') return r.b64;
          return Buffer.from(r.b64, 'base64');
        },
      };
      return h;
    },
  };
}

// ------------------------------------------------------------------- os, url, util, electron, process
let envCache = null;
function env() { if (!envCache) { try { envCache = callSync('shim.env', {}); } catch { envCache = { home: '/home', tmp: '/tmp', user: '', hostname: 'localhost' }; } } return envCache; }

export const os = {
  platform: () => 'linux', type: () => 'Linux', arch: () => 'x64', release: () => '', EOL: '\n',
  homedir: () => env().home, tmpdir: () => env().tmp, hostname: () => env().hostname,
  userInfo: () => ({ username: env().user, homedir: env().home }), cpus: () => [{}], totalmem: () => 0, freemem: () => 0,
};

export const url = {
  URL, URLSearchParams,
  fileURLToPath: (u) => decodeURIComponent(new URL(String(u)).pathname),
  pathToFileURL: (p) => new URL('file://' + encodeURI(p)),
  parse: (u) => new URL(u),
  format: (u) => String(u),
};

export const util = {
  promisify: (fn) => (...args) => new Promise((res, rej) => fn(...args, (err, val) => (err ? rej(err) : res(val)))),
  inspect: (o) => { try { return JSON.stringify(o); } catch { return String(o); } },
  format: (f, ...a) => String(f).replace(/%[sdj]/g, () => String(a.shift())),
  isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  TextEncoder, TextDecoder,
  types: { isDate: (d) => d instanceof Date, isRegExp: (r) => r instanceof RegExp },
};

export function makeElectron(pluginId) {
  const shell = {
    openExternal: (u) => call('system.openExternal', { url: String(u) }, pluginId),
    openPath: (p) => call('system.openPath', { path: String(p).replace((window.app?.vault?.adapter?.getBasePath?.() || '') + '/', '') }, pluginId),
    showItemInFolder: (p) => call('system.showInFolder', { path: String(p).replace((window.app?.vault?.adapter?.getBasePath?.() || '') + '/', '') }, pluginId),
  };
  const clipboard = { writeText: (s) => navigator.clipboard.writeText(s), readText: () => '' };
  const ipcRenderer = Object.assign(new EventEmitter(), { send() {}, sendSync() { return null; }, invoke: async () => null });
  const remote = {
    getCurrentWindow: () => ({ isMaximized: () => false, on() {}, webContents: { on() {} } }),
    dialog: {
      showOpenDialog: async (opts) => {
        const files = await call('system.pickFiles', { title: opts?.title || '' });
        return { canceled: !files?.length, filePaths: files || [] };
      },
    },
    app: { getPath: () => env().home, getVersion: () => '0.1.0' },
    shell,
  };
  return { shell, clipboard, ipcRenderer, remote, webFrame: { setZoomFactor() {} }, nativeImage: {} };
}

export const process = {
  platform: 'linux', arch: 'x64', env: {}, versions: { node: '20.0.0', electron: '0', chrome: '122' }, version: 'v20.0.0',
  argv: [], pid: 1, cwd: () => window.app?.vault?.adapter?.getBasePath?.() || '/', nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  on() {}, once() {}, off() {}, emit() {}, exit() {}, hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: () => ({ heapUsed: 0 }), uptime: () => performance.now() / 1000,
};

function denied(name) {
  return new Proxy({}, { get: (t, k) => (k === '__esModule' ? false : () => { throw Object.assign(new Error(`${name} is not available in sk_notes`), { code: 'ENOTSUP' }); }) });
}

/** Node-style module table for one plugin. */
export function nodeModules(pluginId) {
  const fs = makeFs(pluginId);
  const cp = makeChildProcess(pluginId);
  const cr = makeCrypto(pluginId);
  const el = makeElectron(pluginId);
  return {
    fs, 'fs/promises': fs.promises, 'original-fs': fs, path, 'path/posix': path, os, url, util, events: Object.assign(EventEmitter, { EventEmitter }),
    child_process: cp, crypto: cr, electron: el, '@electron/remote': el.remote, buffer: { Buffer }, process,
    assert: Object.assign((c, m) => { if (!c) throw new Error(m || 'assertion failed'); }, { ok: (c, m) => { if (!c) throw new Error(m || 'assertion failed'); }, strictEqual: (a, b, m) => { if (a !== b) throw new Error(m || 'not equal'); } }),
    'assert/strict': (c, m) => { if (!c) throw new Error(m || 'assertion failed'); },
    querystring: { parse: (s) => Object.fromEntries(new URLSearchParams(s)), stringify: (o) => new URLSearchParams(o).toString() },
    stream: denied('stream'), http: denied('http'), https: denied('https'), net: denied('net'), tls: denied('tls'),
    zlib: denied('zlib'), worker_threads: denied('worker_threads'), readline: denied('readline'), async_hooks: { AsyncLocalStorage: class { run(s, f) { return f(); } getStore() { return undefined; } } },
    constants: {}, module: { createRequire: () => () => ({}) }, timers: { setTimeout, clearTimeout, setInterval, clearInterval },
  };
}

export { Events, toB64, fromB64 };
