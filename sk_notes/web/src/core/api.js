// Calls into the Python side through the skn://api/ scheme.

export class ApiError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

// Qt WebEngine 6.8 hands request bodies over 64 KB to the scheme handler wrongly (the
// device repeats its first block), so bodies are sent in parts of at most PART bytes
// and the exact length always travels in the URL.
const PART = 60000;
const enc = new TextEncoder();

function url(method, plugin, sync, extra = {}) {
  const q = [];
  if (plugin) q.push('plugin=' + encodeURIComponent(plugin));
  if (sync) q.push('sync=1');
  for (const [k, v] of Object.entries(extra)) q.push(`${k}=${encodeURIComponent(v)}`);
  return 'skn://api/' + method + (q.length ? '?' + q.join('&') : '');
}

function unwrap(data) {
  if (!data || data.ok !== true) throw new ApiError(data?.error || 'bad-response', data?.detail || '');
  return data.result;
}

function partsOf(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += PART) out.push(bytes.subarray(i, i + PART));
  return out;
}

/** Asynchronous call: `await call('vault.read', {path})`. */
export async function call(method, params = {}, plugin = null) {
  const bytes = enc.encode(JSON.stringify(params));
  if (bytes.length <= PART) {
    const res = await fetch(url(method, plugin, false, { len: bytes.length }), { method: 'POST', body: bytes });
    return unwrap(await res.json());
  }
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const parts = partsOf(bytes);
  for (let i = 0; i < parts.length; i++) {
    const r = await fetch(url('_upload', null, false, { id, i, len: parts[i].length }), { method: 'POST', body: parts[i] });
    unwrap(await r.json());
  }
  const res = await fetch(url(method, plugin, false, { upload: id, parts: parts.length, len: 0 }), { method: 'POST' });
  return unwrap(await res.json());
}

function syncPost(u, body) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', u, false);
  xhr.send(body);
  return JSON.parse(xhr.responseText);
}

/** Synchronous call (blocks the page): only for plugin APIs that must be synchronous. */
export function callSync(method, params = {}, plugin = null) {
  const bytes = enc.encode(JSON.stringify(params));
  if (bytes.length <= PART) return unwrap(syncPost(url(method, plugin, true, { len: bytes.length }), bytes));
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const parts = partsOf(bytes);
  parts.forEach((p, i) => unwrap(syncPost(url('_upload', null, true, { id, i, len: p.length }), p)));
  return unwrap(syncPost(url(method, plugin, true, { upload: id, parts: parts.length, len: 0 }), null));
}

/** URL of a vault file usable in <img>, <video>, CSS. */
export function resourceUrl(path, mtime) {
  const enc = String(path).split('/').map(encodeURIComponent).join('/');
  return 'skn://vault/' + enc + (mtime ? '?' + mtime : '');
}

// ---- events from Python: window.__skn.emit(name, payload)
const listeners = new Map();
export function onBackend(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

async function dispatch(name, payload) {
  if (payload && payload._fetch !== undefined) payload = await call('events.fetch', { id: payload._fetch });
  for (const fn of listeners.get(name) || []) {
    try { fn(payload); } catch (e) { console.error('backend event', name, e); }
  }
}

window.__skn = window.__skn || {};
window.__skn.emit = (name, payload) => { dispatch(name, payload); };
