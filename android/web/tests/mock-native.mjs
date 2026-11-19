// A native side for tests: the same calls as Bridge.java, on a real folder through node:fs.
import fs from 'node:fs';
import path from 'node:path';

function err(code, detail = '') { const e = new Error(code); e.code = code; e.detail = detail; return e; }
function wrap(fn) {
  try { return fn(); } catch (e) {
    if (e.detail !== undefined && typeof e.code === 'string' && !e.syscall) throw e;
    const map = { ENOENT: 'ENOENT', EEXIST: 'EEXIST', EACCES: 'EACCES', EPERM: 'EACCES', EISDIR: 'EISDIR', ENOTDIR: 'ENOTDIR', ENOTEMPTY: 'EEXIST' };
    throw err(map[e.code] || 'EIO', String(e.message || e));
  }
}
function statOf(p) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (st.isDirectory()) return { type: 'dir', size: 0, mtime: Math.floor(st.mtimeMs), ctime: Math.floor(st.mtimeMs), writable: true };
  let writable = true;
  try { fs.accessSync(p, fs.constants.W_OK); } catch { writable = false; }
  return { type: 'file', size: st.size, mtime: Math.floor(st.mtimeMs), ctime: Math.floor(Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs)), writable };
}
function decode(buf) {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), utf8: true }; } catch { return { text: new TextDecoder('utf-8').decode(buf), utf8: false }; }
}
function writeAtomic(p, data, mtime) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) { try { fs.accessSync(p, fs.constants.W_OK); } catch { throw err('EACCES', p); } }
  const tmp = path.join(path.dirname(p), `.skn-tmp-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
}

export function createNative({ confirm = () => true, http = null } = {}) {
  const calls = [];
  const secrets = new Map();
  const methods = {
    'fs.stat': ({ path: p }) => statOf(p),
    'fs.exists': ({ path: p }) => fs.existsSync(p),
    'fs.list': ({ path: p }) => fs.readdirSync(p, { withFileTypes: true }).map((d) => {
      const st = statOf(path.join(p, d.name));
      return { name: d.name, type: st?.type === 'dir' ? 'dir' : 'file', size: st?.size || 0, mtime: st?.mtime || 0 };
    }),
    'fs.scan': ({ path: root, ignore = [], skipHidden = true }) => {
      const out = [];
      const walk = (dir, rel) => {
        let names;
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
          if ((skipHidden && name.startsWith('.')) || ignore.includes(name)) continue;
          const st = statOf(path.join(dir, name));
          if (!st) continue;
          const r = rel ? rel + '/' + name : name;
          if (st.type === 'dir') { out.push([r, true, 0, 0, 0]); walk(path.join(dir, name), r); } else out.push([r, false, st.size, st.mtime, st.ctime]);
        }
      };
      walk(root, '');
      return out;
    },
    'fs.readText': ({ path: p, max = 0 }) => {
      let buf = fs.readFileSync(p);
      if (max && buf.length > max) buf = buf.subarray(0, max);
      const st = statOf(p);
      return { ...decode(buf), writable: st.writable, mtime: st.mtime, size: st.size };
    },
    'fs.readTexts': ({ paths }) => paths.map((p) => { try { return decode(fs.readFileSync(p)).text; } catch { return null; } }),
    'fs.readB64': ({ path: p }) => fs.readFileSync(p).toString('base64'),
    'fs.readRange': ({ path: p, offset = 0, length = 0 }) => {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(length);
        const n = fs.readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n).toString('base64');
      } finally { fs.closeSync(fd); }
    },
    'fs.writeText': ({ path: p, text, mtime = 0 }) => { writeAtomic(p, Buffer.from(text, 'utf8'), mtime); return statOf(p); },
    'fs.writeB64': ({ path: p, b64, mtime = 0 }) => { writeAtomic(p, Buffer.from(b64 || '', 'base64'), mtime); return statOf(p); },
    'fs.append': ({ path: p, text = '', b64 = null }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, b64 !== null ? Buffer.from(b64, 'base64') : text); return true; },
    'fs.mkdirs': ({ path: p }) => { fs.mkdirSync(p, { recursive: true }); return true; },
    'fs.rename': ({ from, to }) => {
      if (!fs.existsSync(from)) throw err('ENOENT', from);
      if (fs.existsSync(to) && fs.realpathSync(from) !== fs.realpathSync(to)) throw err('EEXIST', to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return true;
    },
    'fs.copy': ({ from, to }) => {
      if (!fs.existsSync(from)) throw err('ENOENT', from);
      if (fs.existsSync(to)) throw err('EEXIST', to);
      fs.cpSync(from, to, { recursive: true });
      return true;
    },
    'fs.delete': ({ path: p, recursive = false }) => {
      if (!fs.existsSync(p)) return false;
      fs.rmSync(p, { recursive, force: true });
      return true;
    },
    'ui.confirm': (p) => !!confirm(p),
    'ui.choose': (p) => confirm(p),
    'hash': ({ algo, b64 }) => { throw err('unsupported', algo + b64); },
    'net.request': async (p) => { if (!http) throw err('network-error', 'no network in tests'); return http(p); },
    'secret.set': ({ name, value }) => { secrets.set(String(name), String(value)); return true; },
    'secret.get': ({ name }) => (secrets.has(String(name)) ? secrets.get(String(name)) : null),
    'secret.delete': ({ name }) => secrets.delete(String(name)),
  };
  const run = (method, params) => {
    calls.push(method);
    const fn = methods[method];
    if (!fn) throw err('unknown-method', method);
    return wrap(() => fn(params || {}));
  };
  const toApi = (e) => Object.assign(new Error(e.code + (e.detail ? ': ' + e.detail : '')), { code: e.code || 'native-error', detail: e.detail || '' });
  return {
    calls,
    methods,
    sync(method, params) { try { return JSON.parse(JSON.stringify(run(method, params) ?? null)); } catch (e) { throw toApi(e); } },
    async async(method, params) { try { return JSON.parse(JSON.stringify((await run(method, params)) ?? null)); } catch (e) { throw toApi(e); } },
  };
}
