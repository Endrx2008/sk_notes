// Calls into the Python side through the skn://api/ scheme.

export class ApiError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

function url(method, plugin, sync) {
  const q = [];
  if (plugin) q.push('plugin=' + encodeURIComponent(plugin));
  if (sync) q.push('sync=1');
  return 'skn://api/' + method + (q.length ? '?' + q.join('&') : '');
}

function unwrap(data) {
  if (!data || data.ok !== true) throw new ApiError(data?.error || 'bad-response', data?.detail || '');
  return data.result;
}

/** Asynchronous call: `await call('vault.read', {path})`. */
export async function call(method, params = {}, plugin = null) {
  const res = await fetch(url(method, plugin, false), { method: 'POST', body: JSON.stringify(params) });
  return unwrap(await res.json());
}

/** Synchronous call (blocks the page): only for plugin APIs that must be synchronous. */
export function callSync(method, params = {}, plugin = null) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', url(method, plugin, true), false);
  xhr.send(JSON.stringify(params));
  return unwrap(JSON.parse(xhr.responseText));
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
