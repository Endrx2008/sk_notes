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
    realpath: async (p) => path.resolve(String(p)),
    chmod: async () => {}, chown: async () => {}, utimes: async () => {}, lutimes: async () => {},
  };
  const notSupported = (what) => () => { throw errno({ code: 'ENOTSUP', message: `${what} is not available` }); };
  const realpathSync = Object.assign((p) => path.resolve(String(p)), { native: (p) => path.resolve(String(p)) });
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
    readFile: cbify(promises.readFile), writeFile: cbify(promises.writeFile), stat: cbify(promises.stat), lstat: cbify(promises.lstat),
    access: cbify(promises.access), appendFile: cbify(promises.appendFile), copyFile: cbify(promises.copyFile), rm: cbify(promises.rm),
    rmdir: cbify(promises.rmdir),
    readdir: cbify(promises.readdir), mkdir: cbify(promises.mkdir), unlink: cbify(promises.unlink),
    rename: cbify(promises.rename), exists: (p, cb) => promises.access(p).then(() => cb(true), () => cb(false)),
    watch: () => ({ close() {}, on() {} }),
    watchFile() {}, unwatchFile() {},
    realpathSync, realpath: Object.assign(cbify(promises.realpath), { native: cbify(promises.realpath) }),
    chmod: cbify(promises.chmod), chown: cbify(promises.chown), utimes: cbify(promises.utimes), lutimes: cbify(promises.lutimes),
    chmodSync() {}, chownSync() {}, utimesSync() {}, lutimesSync() {},
    open: notSupported('fs.open'), openSync: notSupported('fs.open'), close: (fd, cb) => cb?.(null), closeSync() {},
    read: notSupported('fs.read'), write: notSupported('fs.write'), fstat: notSupported('fs.fstat'), fsync: (fd, cb) => cb?.(null),
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
// Listener map created on first use, so ES5-style subclasses (Parent.call(this)) work too.
const lis = (o) => o._l || (o._l = new Map());
// A plain function, not a class: Node allows EventEmitter.call(this) in ES5-style subclasses.
export function EventEmitter() { lis(this); }
Object.assign(EventEmitter.prototype, {
  on(n, fn) { const m = lis(this); if (!m.has(n)) m.set(n, []); m.get(n).push(fn); return this; },
  addListener(n, fn) { return this.on(n, fn); },
  prependListener(n, fn) { const m = lis(this); m.set(n, [fn, ...(m.get(n) || [])]); return this; },
  once(n, fn) { const w = (...a) => { this.off(n, w); fn(...a); }; return this.on(n, w); },
  off(n, fn) { const m = lis(this); const l = m.get(n); if (l) m.set(n, l.filter((x) => x !== fn)); return this; },
  removeListener(n, fn) { return this.off(n, fn); },
  removeAllListeners(n) { if (n) lis(this).delete(n); else lis(this).clear(); return this; },
  emit(n, ...a) { const l = lis(this).get(n); if (!l || !l.length) return false; for (const fn of l.slice()) fn.apply(this, a); return true; },
  listenerCount(n) { return lis(this).get(n)?.length || 0; },
  listeners(n) { return (lis(this).get(n) || []).slice(); },
  eventNames() { return [...lis(this).keys()]; },
  setMaxListeners() { return this; },
  getMaxListeners() { return EventEmitter.defaultMaxListeners; },
});
EventEmitter.defaultMaxListeners = 10;
EventEmitter.setMaxListeners = () => {};
EventEmitter.once = (em, n) => new Promise((res) => em.once(n, (...a) => res(a)));
EventEmitter.EventEmitter = EventEmitter;

// ------------------------------------------------------------------- stream (in-memory only)
// Plain constructor functions: old libraries call Stream.call(this) without `new`.
function streamCtor(name, parent) {
  const F = function (opts) {
    if (!(this instanceof F)) return new F(opts);
    lis(this);
    this.readable = name !== 'Writable';
    this.writable = name !== 'Readable';
  };
  F.prototype = Object.create(parent.prototype, { constructor: { value: F, writable: true, configurable: true } });
  Object.setPrototypeOf(F, parent);
  Object.defineProperty(F, 'name', { value: name });
  return F;
}
const Stream = streamCtor('Stream', EventEmitter);
Object.assign(Stream.prototype, {
  pipe(dest) { this.on('data', (c) => dest.write?.(c)); this.on('end', () => dest.end?.()); return dest; },
  write(chunk, enc, cb) { this.emit('data', chunk); (typeof enc === 'function' ? enc : cb)?.(); return true; },
  end(chunk) { if (chunk != null) this.write(chunk); this.emit('end'); this.emit('finish'); return this; },
  push(chunk) { if (chunk === null) this.emit('end'); else this.emit('data', chunk); return true; },
  destroy(err) { if (err) this.emit('error', err); this.emit('close'); return this; },
  pause() { return this; }, resume() { return this; }, setEncoding() { return this; },
});
const Readable = streamCtor('Readable', Stream);
const Writable = streamCtor('Writable', Stream);
const Duplex = streamCtor('Duplex', Stream);
const Transform = streamCtor('Transform', Duplex);
const PassThrough = streamCtor('PassThrough', Transform);
export const stream = Object.assign(Stream, { Stream, Readable, Writable, Duplex, Transform, PassThrough,
  pipeline: (...a) => { const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null; a.reduce((x, y) => x.pipe(y)); cb && a[a.length - 1].on('finish', () => cb()); return a[a.length - 1]; },
  finished: (s, cb) => { s.on('finish', () => cb()); s.on('error', cb); } });

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
  constants: { signals: { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }, errno: {} }, networkInterfaces: () => ({}), loadavg: () => [0, 0, 0],
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
  debuglog: () => Object.assign(() => {}, { enabled: false }),
  deprecate: (fn) => fn,
  inherits: (ctor, parent) => { Object.setPrototypeOf(ctor.prototype, parent.prototype); Object.setPrototypeOf(ctor, parent); ctor.super_ = parent; },
  isArray: Array.isArray,
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
    app: { getPath: () => env().home, getVersion: () => '1.0.0' },
    shell,
  };
  return { shell, clipboard, ipcRenderer, remote, webFrame: { setZoomFactor() {} }, nativeImage: {} };
}

export const process = {
  platform: 'linux', arch: 'x64', env: {}, versions: { node: '20.0.0', electron: '0', chrome: '122' }, version: 'v20.0.0',
  argv: [], pid: 1, cwd: () => window.app?.vault?.adapter?.getBasePath?.() || '/', nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  on() {}, once() {}, off() {}, emit() {}, exit() {}, hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: () => ({ heapUsed: 0 }), uptime: () => performance.now() / 1000,
  umask: () => 0o022, emitWarning: (w) => console.warn(w), getuid: () => 1000, getgid: () => 1000,
  stdout: { isTTY: false, write: (s) => { console.log(String(s)); return true; }, on() {}, once() {} },
  stderr: { isTTY: false, write: (s) => { console.warn(String(s)); return true; }, on() {}, once() {} },
  stdin: { isTTY: false, on() {}, once() {} },
};

function denied(name) {
  return new Proxy({}, { get: (t, k) => (k === '__esModule' ? false : () => { throw Object.assign(new Error(`${name} is not available in sk_notes`), { code: 'ENOTSUP' }); }) });
}

const HTTP_METHODS = ['ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE',
  'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT',
  'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'];
const STATUS_CODES = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable' };

/** http/https: constants are real, servers and raw sockets are not available (use requestUrl). */
function netModule(name) {
  const no = () => { throw Object.assign(new Error(`${name} servers and sockets are not available in sk_notes`), { code: 'ENOTSUP' }); };
  return { METHODS: HTTP_METHODS, STATUS_CODES, IncomingMessage: Readable, ServerResponse: Writable, OutgoingMessage: Writable,
    ClientRequest: Writable, createServer: no, request: no, get: no, Agent: class Agent {}, globalAgent: {}, Server: class Server { constructor() { no(); } } };
}

/** string_decoder: UTF-8 decoder that keeps partial characters between writes. */
class StringDecoder {
  constructor(encoding = 'utf8') { this.encoding = encoding; this._d = new TextDecoder(String(encoding).replace('utf8', 'utf-8')); }
  write(buf) { return typeof buf === 'string' ? buf : this._d.decode(buf, { stream: true }); }
  end(buf) { return (buf ? this.write(buf) : '') + this._d.decode(); }
}

/** vm: plugins already run with page privileges, so this only evaluates code with the given names in scope. */
function runInContext(code, ctx = {}) {
  const keys = Object.keys(ctx).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
  // eslint-disable-next-line no-new-func
  return new Function(...keys, '__code', 'return eval(__code)')(...keys.map((k) => ctx[k]), String(code));
}
const vm = {
  runInNewContext: runInContext, runInContext, runInThisContext: (code) => runInContext(code),
  createContext: (o) => o || {}, isContext: () => true,
  Script: class Script { constructor(code) { this.code = code; } runInNewContext(ctx) { return runInContext(this.code, ctx); } runInContext(ctx) { return runInContext(this.code, ctx); } runInThisContext() { return runInContext(this.code); } },
};

/** punycode: the parts bundled URL libraries use (UCS-2 helpers, toASCII through the URL parser). */
const punycode = {
  ucs2: {
    decode: (str) => Array.from(String(str), (ch) => ch.codePointAt(0)),
    encode: (codes) => String.fromCodePoint(...codes),
  },
  toASCII: (domain) => { try { return new URL('http://' + domain).hostname; } catch { return domain; } },
  toUnicode: (domain) => domain,
  version: '2.1.0',
};

/** Node-style module table for one plugin. */
export function nodeModules(pluginId) {
  const fs = makeFs(pluginId);
  const cp = makeChildProcess(pluginId);
  const cr = makeCrypto(pluginId);
  const el = makeElectron(pluginId);
  return {
    fs, 'fs/promises': fs.promises, 'original-fs': fs, path, 'path/posix': path, os, url, util, events: EventEmitter,
    child_process: cp, crypto: cr, electron: el, '@electron/remote': el.remote, buffer: { Buffer, constants: { MAX_LENGTH: 2 ** 32 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 }, kMaxLength: 2 ** 32 - 1 }, process,
    assert: Object.assign((c, m) => { if (!c) throw new Error(m || 'assertion failed'); }, { ok: (c, m) => { if (!c) throw new Error(m || 'assertion failed'); }, strictEqual: (a, b, m) => { if (a !== b) throw new Error(m || 'not equal'); } }),
    'assert/strict': (c, m) => { if (!c) throw new Error(m || 'assertion failed'); },
    querystring: { parse: (s) => Object.fromEntries(new URLSearchParams(s)), stringify: (o) => new URLSearchParams(o).toString() },
    stream, http: netModule('http'), https: netModule('https'), tty: { isatty: () => false, ReadStream: Readable, WriteStream: Writable },
    string_decoder: { StringDecoder }, vm, console: window.console, punycode, 'punycode/': punycode,
    http2: Object.assign(netModule('http2'), { constants: {}, connect: () => netModule('http2').request() }),
    net: denied('net'), tls: denied('tls'),
    zlib: denied('zlib'), worker_threads: denied('worker_threads'), readline: denied('readline'), async_hooks: { AsyncLocalStorage: class { run(s, f) { return f(); } getStore() { return undefined; } } },
    constants: {}, module: { createRequire: () => () => ({}) }, timers: { setTimeout, clearTimeout, setInterval, clearInterval },
  };
}

export { Events, toB64, fromB64 };
