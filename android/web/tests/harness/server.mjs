// Test bench for the Android page: serves the built app to a desktop browser and plays the
// native side (Bridge.java) with real files in a folder. Not shipped in the APK.
//   node server.mjs --data <folder> [--port 8765] [--confirm yes|no] [--storage granted|denied]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNative } from '../mock-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i === -1 ? dflt : process.argv[i + 1]; };
const assets = path.resolve(arg('assets', path.join(here, '..', '..', '..', 'build', 'assets')));
const data = path.resolve(arg('data', path.join(here, 'data')));
const port = Number(arg('port', 8765));
const state = { confirm: arg('confirm', 'yes') === 'yes', storage: arg('storage', 'granted') === 'granted', dark: arg('theme', 'dark') === 'dark', log: [], pick: arg('pick', '') };
const dirs = { private: path.join(data, 'private'), cache: path.join(data, 'cache'), appVaults: path.join(data, 'app-vaults'), shared: path.join(data, 'shared') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(dirs.shared, 'Documents'), { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.webp': 'image/webp', '.gif': 'image/gif' };

// ---------------------------------------------------------------- events to the page (in order)
const clients = new Set();
const backlog = [];
function push(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  if (!clients.size) backlog.push(line);
  for (const c of clients) c.write(line);
}
const emit = (name, payload) => push({ type: 'event', name, payload });

// ---------------------------------------------------------------- the native side
const streams = new Map();
const native = createNative({
  confirm: (p) => { state.log.push(['dialog', p.title, p.text]); return p.buttons ? (state.confirm ? 1 : 2) : state.confirm; },
});
Object.assign(native.methods, {
  'fs.roots': () => ({ ...dirs, shared: state.storage ? dirs.shared : null, documents: state.storage ? path.join(dirs.shared, 'Documents') : null, volumes: [] }),
  'perm.storage': () => ({ granted: state.storage, canAsk: true }),
  'perm.requestStorage': () => { state.storage = true; return true; },
  'app.device': () => ({ dark: state.dark, sdk: 34, model: 'test bench', webview: '120.0', insets: { top: 0, bottom: 0 } }),
  'app.ready': () => true,
  'app.exit': () => true,
  'app.background': () => { state.log.push(['background']); return true; },
  'ui.zoom': () => true,
  'ui.fullscreen': () => true,
  'ui.printHtml': (p) => { fs.writeFileSync(path.join(dirs.cache, 'print.html'), p.html); state.log.push(['print', p.name]); return true; },
  'ui.pickFiles': () => (state.pick ? [{ path: state.pick, name: path.basename(state.pick) }] : []),
  'sys.openExternal': (p) => { state.log.push(['open', p.url]); return true; },
  'sys.openPath': (p) => { state.log.push(['openPath', p.path]); return true; },
  'sys.openFolder': (p) => { state.log.push(['openFolder', p.path]); return true; },
  'sys.share': (p) => { state.log.push(['share', p.title || p.path || p.text]); return true; },
  'sys.hasApp': () => false,
  // reminders and home-screen widgets (MainActivity/Reminders/Widgets.java): kept in files to look at
  'reminders.set': (p) => { fs.writeFileSync(path.join(dirs.private, 'reminders.json'), JSON.stringify(p, null, 1)); state.log.push(['reminders', p.items.length]); return true; },
  'reminders.permission': () => { state.log.push(['notifyPermission']); return true; },
  'widgets.notes': (p) => { fs.writeFileSync(path.join(dirs.private, 'widget-notes.json'), JSON.stringify(p, null, 1)); return true; },
  'widgets.changed': (p) => { state.log.push(['widgetChanged', p.path]); return true; },
  'widgets.graph': (p) => { fs.writeFileSync(path.join(dirs.private, 'widget-graph.png'), Buffer.from(p.b64, 'base64')); state.log.push(['widgetGraph', p.uri]); return true; },
  'clip.read': () => state.clip || '',
  'clip.write': (p) => { state.clip = String(p.text || ''); return true; },
  'net.policy': (p) => { state.allowRemote = !!p.allowRemote; return true; },
  'hash': ({ algo, b64 }) => { const h = crypto.createHash(algo).update(Buffer.from(b64 || '', 'base64')); const d = h.digest(); return { hex: d.toString('hex'), b64: d.toString('base64') }; },
  'fs.unzip': ({ path: zip, dest }) => {
    fs.mkdirSync(dest, { recursive: true });
    const r = spawnSync('python3', ['-I', '-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dest]);
    if (r.status !== 0) throw Object.assign(new Error('EIO'), { code: 'EIO', detail: String(r.stderr) });
    return dest;
  },
  'net.request': async (p) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), (p.timeout || 60) * 1000);
    try {
      const res = await fetch(p.url, { method: p.method || 'GET', headers: p.headers || {}, body: p.body ? Buffer.from(p.body, 'base64') : undefined, signal: ctl.signal, redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (p.maxBytes && buf.length > p.maxBytes) throw Object.assign(new Error('too-large'), { code: 'too-large', detail: p.url });
      return { status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])), b64: buf.toString('base64') };
    } catch (e) {
      if (e.code === 'too-large') throw e;
      throw Object.assign(new Error('network-error'), { code: 'network-error', detail: ctl.signal.aborted ? 'timed out' : String(e.cause?.message || e.message || e) });
    } finally { clearTimeout(timer); }
  },
  'net.stream': async (p) => {
    const ctl = new AbortController();
    streams.set(String(p.id), ctl);
    try {
      const res = await fetch(p.url, { method: p.method || 'POST', headers: p.headers || {}, body: p.body ? Buffer.from(p.body, 'base64') : undefined, signal: ctl.signal });
      if (res.status >= 400) return { status: res.status, body: (await res.text()).slice(0, 65536) };
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) { emit('net.line', { id: p.id, line: buf.slice(0, nl) }); buf = buf.slice(nl + 1); }
      }
      if (buf.trim()) emit('net.line', { id: p.id, line: buf });
      return { status: res.status };
    } catch (e) {
      throw Object.assign(new Error('x'), { code: ctl.signal.aborted ? 'cancelled' : 'network-error', detail: String(e.cause?.message || e.message || e) });
    } finally { streams.delete(String(p.id)); }
  },
  'net.cancel': (p) => { streams.get(String(p.id))?.abort(); return true; },
  'net.scan': async () => state.scan || [],
});

function reply(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const fail = (e) => JSON.stringify({ ok: false, error: e.code || 'native-error', detail: e.detail || String(e.message || e) });

function currentVault() {
  try { return JSON.parse(fs.readFileSync(path.join(dirs.private, 'settings.json'), 'utf8')).lastVault || ''; } catch { return ''; }
}

function serveFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch { reply(res, 404, 'not found', 'text/plain'); return; }
  if (!st.isFile()) { reply(res, 404, 'not found', 'text/plain'); return; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/native') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const method = url.searchParams.get('m');
      const asyncId = url.searchParams.get('async');
      let params = {};
      try { params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* empty */ }
      if (asyncId !== null) {
        reply(res, 202, '{}');
        let body;
        try { body = JSON.stringify({ ok: true, result: (await native.async(method, params)) ?? null }); } catch (e) { body = fail(e); }
        push({ type: 'result', id: Number(asyncId), body });
        return;
      }
      try { reply(res, 200, JSON.stringify({ ok: true, result: native.sync(method, params) ?? null })); } catch (e) { reply(res, 200, fail(e)); }
    });
    return;
  }
  if (p === '/native-events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    for (const line of backlog.splice(0)) res.write(line);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/harness/native.js') { serveFile(req, res, path.join(here, 'native-shim.js')); return; }
  if (p === '/harness/state') { // tests read what happened and change the bench: /harness/state?confirm=no&event=app.resume
    for (const [k, v] of url.searchParams) {
      if (k === 'confirm') state.confirm = v === 'yes';
      else if (k === 'storage') state.storage = v === 'granted';
      else if (k === 'theme') { state.dark = v === 'dark'; emit('ui.theme', { dark: state.dark }); }
      else if (k === 'pick') state.pick = v;
      else if (k === 'event') emit(v, JSON.parse(url.searchParams.get('payload') || 'null'));
      else if (k === 'scan') state.scan = JSON.parse(v);
      else if (k === 'clear') state.log.length = 0;
    }
    reply(res, 200, JSON.stringify({ ...state, calls: native.calls.length }));
    return;
  }
  if (p === '/' || p === '/app/' || p === '/app/index.html') {
    const html = fs.readFileSync(path.join(assets, 'app', 'index.html'), 'utf8').replace('<script type="module"', '<script src="/harness/native.js"></script>\n<script type="module"');
    reply(res, 200, html, MIME['.html']);
    return;
  }
  if (p.startsWith('/app/')) { serveFile(req, res, path.join(assets, 'app', path.normalize(p.slice(5)).replace(/^(\.\.[/\\])+/, ''))); return; }
  if (p.startsWith('/vault/')) {
    const root = currentVault();
    const rel = path.normalize(p.slice(7));
    if (!root || rel.startsWith('..')) { reply(res, 404, 'not found', 'text/plain'); return; }
    serveFile(req, res, path.join(root, rel));
    return;
  }
  reply(res, 404, 'not found', 'text/plain');
});
server.listen(port, '127.0.0.1', () => console.log(`sk_notes test bench: http://127.0.0.1:${port}/app/index.html  (data: ${data})`));
