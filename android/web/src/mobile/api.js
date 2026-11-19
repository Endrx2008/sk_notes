// sk_notes for Android – the page's calls into the backend.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Takes the place of core/api.js of the desktop app (same exports). There the backend is
// Python behind the skn:// scheme; here it is the JavaScript backend of this page, so a
// call is a function call. Values are copied on the way in and out, like they were when
// they travelled as JSON: the page and the backend never share an object.

import { startBackend } from '../backend/index.js';
import { handle } from '../backend/router.js';
import { onEvent } from '../backend/state.js';
import { ApiError } from '../backend/util.js';

export { ApiError };

// Plugins share this page: the functions used here are taken now, before any plugin runs.
const stringify = JSON.stringify;
const parseJson = JSON.parse;
const setProto = Object.setPrototypeOf;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;

const copy = (x) => (x === undefined ? undefined : parseJson(stringify(x)));
const copyIn = (x) => { const c = copy(x ?? {}); return c && typeof c === 'object' ? c : {}; };

function fail(e) {
  if (e instanceof ApiError) return e;
  console.error('backend call failed', e);
  return new ApiError(e?.code || e?.name || 'error', e?.detail || String(e?.message || e));
}

// window.open() never opens a page: web links go to the browser like a clicked link
if (globalThis.window && globalThis.document) {
  window.open = (u) => {
    const s = String(u ?? '');
    if (/^(https?|mailto):/i.test(s)) window.app?.openExternal?.(s);
    return null;
  };
}

/** Asynchronous call: `await call('vault.read', {path})`. `caller` is a plugin's token
 * (only its own shims have it); without one the call is the app's. */
export async function call(method, params = {}, caller = null) {
  await startBackend();
  let result;
  try { result = await handle(method, copyIn(params), caller); } catch (e) { throw fail(e); }
  return copy(result);
}

/** Synchronous call: only for plugin APIs that must be synchronous. */
export function callSync(method, params = {}, caller = null) {
  let result;
  try { result = handle(method, copyIn(params), caller); } catch (e) { throw fail(e); }
  if (result && typeof result.then === 'function') {
    result.catch(() => {});
    throw new ApiError('unsupported', `${method} cannot be called synchronously`);
  }
  return copy(result);
}

/** Tokens for the plugins that may run (one each); only the plugin manager calls this.
 * The reply has no prototype, so nothing a plugin put on Object.prototype sees it. */
export async function pluginTokens() {
  await startBackend();
  let r;
  try { r = handle('plugins.tokens', {}, null); } catch (e) { throw fail(e); }
  const out = setProto({}, null);
  for (const k in r) if (apply(hasOwn, Object, [r, k])) out[k] = r[k];
  return out;
}

export async function pluginToken(id) {
  await startBackend();
  try { return String(handle('plugins.token', { id: String(id) }, null)); } catch (e) { throw fail(e); }
}

/** Where vault files are served to the page (images, PDFs, media). */
export const RESOURCE_PREFIX = (globalThis.location ? location.origin : '') + '/vault/';

/** URL of a vault file usable in <img>, <video>, CSS. */
export function resourceUrl(path, mtime) {
  const enc = String(path).split('/').map(encodeURIComponent).join('/');
  return RESOURCE_PREFIX + enc + (mtime ? '?' + mtime : '');
}

// ---- events from the backend
export function onBackend(name, fn) {
  return onEvent(name, fn);
}

if (globalThis.window) window.__skn = window.__skn || {};

// A script clicking a link (a.click()) must not open the browser: opening external links
// needs the user's own tap or the open-external permission. Registered in the capture
// phase before any plugin runs.
if (globalThis.document) {
  document.addEventListener('click', (e) => {
    if (e.isTrusted) return;
    const a = e.target?.closest?.('a[href]');
    if (a && /^(https?|mailto):/i.test(a.getAttribute('href') || '')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
