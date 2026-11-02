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
const encode = encodeURIComponent;
const hasOwn = Object.hasOwn;
const textEncode = TextEncoder.prototype.encode;
const parseJson = JSON.parse;
const setProto = Object.setPrototypeOf;

// Plugins share this page. They must not see the caller tokens of other plugins (see
// app/callers.py), so the browser functions used here are taken now, before any plugin
// runs, and called without going through anything a plugin could replace.
const apply = Reflect.apply;
const nativeFetch = globalThis.fetch;
const responseText = globalThis.Response?.prototype.text; // text, not json(): a promise resolved with a parsed object lets Object.prototype.then see it
const XHR = globalThis.XMLHttpRequest; // absent in Node (unit tests)
const xhrOpen = XHR?.prototype.open;
const xhrSend = XHR?.prototype.send;
const xhrText = XHR && Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText').get;
// The parsed reply has no prototype: when a promise is resolved with an object, JavaScript
// looks up `then` on it, and a plugin hooking Object.prototype.then would see replies that
// carry a plugin token (B4-1).
const fetchJson = async (u, init) => setProto(parseJson(await apply(responseText, await apply(nativeFetch, globalThis, [u, init]), [])), null);

// window.open() never opens a page (see application.Page.createWindow): web links go to the
// browser like a clicked link
if (globalThis.window && globalThis.document) {
  window.open = (u) => {
    const s = String(u ?? '');
    if (/^(https?|mailto):/i.test(s)) window.app?.openExternal?.(s);
    return null;
  };
}

let boot = globalThis.__sknBoot?.token || null;
try { delete globalThis.__sknBoot; } catch { globalThis.__sknBoot = undefined; }

// The app key (see app/callers.py): every call of the app carries it; plugins and the
// HTML of notes never see it. Strings are built by concatenation and the body is not
// produced with JSON.stringify, which a plugin could replace.
let appKey = null;
const authReady = (async () => {
  if (!boot) return; // pages opened by window.open(): no identity (they open none now)
  const b = boot;
  boot = null;
  const bytes = apply(textEncode, enc, ['{"boot":"' + b + '"}']);
  const r = await fetchJson('skn://api/app.auth?len=' + bytes.length, { method: 'POST', body: bytes });
  if (r && r.ok) appKey = r.result;
  else console.error('sk_notes: not authenticated', r?.error, r?.detail);
})();

function bodyOf(obj) {
  return apply(textEncode, enc, [JSON.stringify(obj)]);
}

/** A call whose reply holds a secret: only primitives / prototype-less objects leave here. */
async function secretReply(method, params) {
  await authReady;
  const bytes = bodyOf(params);
  const r = await fetchJson(url(method, null, false, { len: bytes.length }), { method: 'POST', body: bytes });
  if (!r || r.ok !== true) throw new ApiError(r?.error || 'bad-response', r?.detail || '');
  return r.result;
}

/** Tokens for the plugins that may run (one each); only the plugin manager calls this. */
export async function pluginTokens() {
  const r = await secretReply('plugins.tokens', {});
  const out = setProto({}, null);
  for (const k in r) if (apply(hasOwn, Object, [r, k])) out[k] = r[k];
  return out;
}

export async function pluginToken(id) {
  return String(await secretReply('plugins.token', { id }));
}

// Only string concatenation and functions taken above: a plugin that replaces
// encodeURIComponent, Array.prototype.push/join or Object.entries must not see the caller
// token of another plugin's call (B2-3). Tokens and keys are URL-safe, so they need no encoding.
function url(method, caller, sync, extra = {}) {
  let q = '';
  if (caller) q += '&c=' + caller;
  else if (appKey) q += '&a=' + appKey;
  if (sync) q += '&sync=1';
  for (const k in extra) if (apply(hasOwn, Object, [extra, k])) q += '&' + k + '=' + encode(String(extra[k]));
  return 'skn://api/' + method + (q ? '?' + q.slice(1) : '');
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

/** Asynchronous call: `await call('vault.read', {path})`. `caller` is a plugin's token
 * (only its own shims have it); without one the call is the app's. */
export async function call(method, params = {}, caller = null) {
  await authReady;
  const bytes = bodyOf(params);
  if (bytes.length <= PART) {
    return unwrap(await fetchJson(url(method, caller, false, { len: bytes.length }), { method: 'POST', body: bytes }));
  }
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const parts = partsOf(bytes);
  for (let i = 0; i < parts.length; i++) {
    unwrap(await fetchJson(url('_upload', caller, false, { id, i, len: parts[i].length }), { method: 'POST', body: parts[i] }));
  }
  return unwrap(await fetchJson(url(method, caller, false, { upload: id, parts: parts.length, len: 0 }), { method: 'POST' }));
}

function syncPost(u, body) {
  const xhr = new XHR();
  apply(xhrOpen, xhr, ['POST', u, false]);
  apply(xhrSend, xhr, [body]);
  return parseJson(apply(xhrText, xhr, []));
}

/** Synchronous call (blocks the page): only for plugin APIs that must be synchronous. */
export function callSync(method, params = {}, caller = null) {
  const bytes = bodyOf(params);
  if (bytes.length <= PART) return unwrap(syncPost(url(method, caller, true, { len: bytes.length }), bytes));
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const parts = partsOf(bytes);
  parts.forEach((p, i) => unwrap(syncPost(url('_upload', caller, true, { id, i, len: p.length }), p)));
  return unwrap(syncPost(url(method, caller, true, { upload: id, parts: parts.length, len: 0 }), null));
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

// A script clicking a link (a.click()) must not open the browser: opening external links
// needs the user's own click or the open-external permission (B2-9, B3-4). Registered in
// the capture phase before any plugin runs.
if (globalThis.document) {
  document.addEventListener('click', (e) => {
    if (e.isTrusted) return;
    const a = e.target?.closest?.('a[href]');
    if (a && /^(https?|mailto):/i.test(a.getAttribute('href') || '')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
