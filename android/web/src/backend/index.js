// sk_notes for Android – start of the in-app backend.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The desktop app has a Python backend; here the same work is done by this JavaScript
// backend inside the page, with a thin native side (Java) for files, network and dialogs.

import { native } from './native.js';
import * as permissions from './permissions.js';
import { route } from './router.js';
import { registerAi } from './routes-ai.js';
import { loadStrings, registerCore, setFolderPicker } from './routes-core.js';
import { registerExtras } from './routes-extras.js';
import { registerGallery } from './routes-gallery.js';
import { registerPlugins } from './routes-plugins.js';
import { registerSpell } from './routes-spell.js';
import { registerSync } from './routes-sync.js';
import { VaultService } from './service.js';
import * as crypt from './vault-crypt.js';
import { installAutoLock } from './vault-lock.js';
import { cryptPlaces, emit, loadSettings, roots, saveSettings, state, systemLanguage, t, vaultDataDir } from './state.js';
import { ApiError, basename, checkName, normpath, unquote } from './util.js';

const RESCAN_EVERY = 20000; // look for changes made by sync apps while sk_notes is in front
const RESCAN_MAX_MS = 400; // …only while a look is cheap

let started = null;
let registered = false;

/** 'sknotes://open?vault=a&file=b' → {action, params}; null if it is not such a link. */
export function parseUri(uri) {
  const m = /^(sknotes|obsidian):\/\/\/?([^?#/]*)[^?#]*(?:\?([^#]*))?/i.exec(String(uri || '').trim());
  if (!m || !m[2]) return null;
  const params = {};
  for (const part of (m[3] || '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = unquote((eq === -1 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
    params[k] = eq === -1 ? '' : unquote(part.slice(eq + 1).replace(/\+/g, ' '));
  }
  return { action: m[2].toLowerCase(), params };
}

/** The vault a link refers to: by absolute file path, by vault path, or by folder name. */
function findVault(params) {
  const known = Object.keys(state.settings.vaults);
  if (params.path) {
    const target = normpath(params.path);
    return known.filter((v) => target === v || target.startsWith(v + '/')).sort((a, b) => b.length - a.length)[0] || null;
  }
  if (params.vault) return known.find((v) => v === params.vault || basename(v) === params.vault) || null;
  return null;
}

let pendingUri = null;

/** A link opened from another app: shown in the open vault, or after switching to its vault. */
function handleUri(uri) {
  const parsed = parseUri(uri);
  if (!parsed) return;
  const { action, params } = parsed;
  const current = state.service ? state.service.vault.root : null;
  const vault = findVault(params);
  if (vault && vault !== current) {
    if (native.sync('fs.stat', { path: vault })?.type !== 'dir') return;
    state.settings.lastVault = vault;
    state.settings.vaults[vault] = { ts: Date.now() };
    state.settings.pendingUri = uri;
    saveSettings();
    native.sync('app.reload', {});
    return;
  }
  if (!current) return;
  if (params.path) {
    const abs = normpath(params.path);
    if (abs.startsWith(current + '/')) params.file = abs.slice(current.length + 1);
    delete params.path;
  }
  emit('open-uri', { action, params });
}

function registerMobile() {
  const r = route;
  const appOnly = (ctx) => { if (ctx.plugin) throw new ApiError('permission-denied'); };

  /** Where vaults can live: the app's own folder (always) and the shared storage (with the permission). */
  r('mobile.storage', () => {
    const st = native.sync('perm.storage', {});
    state.roots = null;
    const rt = roots();
    return { granted: !!st.granted, canAsk: st.canAsk !== false, appVaults: rt.appVaults, shared: rt.shared || null, documents: rt.documents || null };
  });

  r('mobile.requestStorage', async (p, ctx) => {
    appOnly(ctx);
    const granted = !!(await native.async('perm.requestStorage', {}));
    state.roots = null;
    return { granted, shared: roots().shared || null, documents: roots().documents || null };
  });

  /** Folders of one folder, for the folder browser of the page. */
  r('mobile.browse', (p, ctx) => {
    appOnly(ctx);
    const rt = roots();
    const tops = [{ id: 'app', path: rt.appVaults }];
    if (rt.shared) tops.push({ id: 'device', path: rt.shared });
    for (const extra of Array.isArray(rt.volumes) ? rt.volumes : []) tops.push({ id: 'card', path: extra });
    let path = normpath(String(p.path || rt.documents || rt.shared || rt.appVaults));
    const top = tops.filter((x) => path === x.path || path.startsWith(x.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
    if (!top) path = tops[0].path; // nothing outside the places the user may use
    let rows = [];
    let readable = true;
    try { rows = native.sync('fs.list', { path }); } catch { readable = false; }
    const folders = rows.filter((e) => e.type === 'dir' && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const base = (top || tops[0]).path;
    return {
      path, top: (top || tops[0]).id, tops, readable, folders,
      parent: path === base ? null : path.slice(0, path.lastIndexOf('/')),
      isVault: rows.some((e) => e.type === 'dir' && (e.name === '.sk_notes' || e.name === '.obsidian')),
      notes: rows.filter((e) => e.type === 'file' && /\.md$/i.test(e.name)).length,
      // encrypted vaults kept in this folder (one file each)
      vaults: rows.filter((e) => e.type === 'file' && crypt.isBlobPath(e.name)).map((e) => e.name).sort(),
    };
  });

  r('mobile.mkdir', (p, ctx) => {
    appOnly(ctx);
    const name = String(p.name || '').trim();
    try { checkName(name); } catch { throw new ApiError('invalid-name'); }
    const parent = normpath(String(p.parent || ''));
    const rt = roots();
    if (![rt.appVaults, rt.shared, ...(rt.volumes || [])].filter(Boolean).some((b) => parent === b || parent.startsWith(b + '/'))) throw new ApiError('permission-denied', parent);
    const target = `${parent}/${name}`;
    if (native.sync('fs.exists', { path: target })) throw new ApiError('already-exists', target);
    try { native.sync('fs.mkdirs', { path: target }); } catch (e) { throw new ApiError('read-only', e.detail || target); }
    return target;
  });

  r('app.background', () => { native.sync('app.background', {}); return true; });
  r('app.device', () => native.sync('app.device', {}));

  /** Show the link sk_notes was started with, once (after a switch to the vault it names). */
  r('app.takeUri', () => {
    const u = pendingUri;
    pendingUri = null;
    if (!u || !parseUri(u)) return false;
    handleUri(u);
    return true;
  });

  r('mobile.bars', (p) => {
    const color = /^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? p.color : '#0d0d0d';
    try { native.sync('ui.bars', { color, light: !!p.light }); } catch { /* optional */ }
    return true;
  });
}

async function start() {
  if (!registered) {
    registerCore();
    registerPlugins();
    registerAi();
    registerExtras();
    registerGallery();
    registerSync();
    registerSpell();
    registerMobile();
    registered = true;
  }
  loadSettings();
  let dev = {};
  try { dev = native.sync('app.device', {}) || {}; } catch { dev = {}; }
  state.theme = dev.dark === false ? 'light' : 'dark';
  await loadStrings(state.settings.language || systemLanguage());

  // a start that never finished loading the plugins: offer to start without them
  const marker = roots().private + '/starting';
  let crashed = false;
  try { crashed = native.sync('fs.exists', { path: marker }); } catch { crashed = false; }

  const last = state.settings.lastVault;
  // An encrypted vault left open before the page was loaded again is still open; one left by
  // a switch to another vault is saved and its decrypted files are removed. After a fresh
  // start of the app nothing is open: the password is asked again.
  let open = null;
  try { open = await crypt.resumeSession(cryptPlaces); } catch (e) { console.error('encrypted vault session', e); }
  if (open && open.blob !== last) {
    try { await open.seal(); crypt.wipe(open.where.dir); } catch (e) { console.error('encrypted vault not saved', e); }
    crypt.endSession();
    open = null;
  }
  if (last && crypt.isBlobPath(last)) {
    if (open) {
      try {
        state.crypt = open;
        const service = new VaultService(open.where.work, (name, payload) => { emit(name, payload); open.touch(); }, open.where.data);
        state.service = service;
        await service.open();
        state.settings.vaults[last] = { ts: Date.now() };
        saveSettings();
      } catch (e) {
        console.error('encrypted vault not opened', e);
        state.service = null;
        state.crypt = null;
        state.startError = { path: last, code: e.code || 'error', detail: e.detail || String(e.message || e) };
      }
    }
    if (!state.service) state.locked = { path: last, name: crypt.blobName(last) };
  } else if (last) {
    try {
      const service = new VaultService(last, emit, vaultDataDir(last));
      state.service = service;
      await service.open();
      state.settings.vaults[last] = { ts: Date.now() };
      saveSettings();
    } catch (e) {
      console.error('vault not opened', e);
      state.service = null;
      state.startError = { path: last, code: e.code || 'error', detail: e.detail || String(e.message || e) };
      state.settings.lastVault = '';
      saveSettings();
    }
  }
  if (state.service && crashed && permissions.activePlugins().length) {
    state.safeMode = !!native.sync('ui.confirm', { title: t('plugins.unclean-title'), text: t('plugins.unclean-question'), detail: '', ok: t('plugins.unclean-ok'), cancel: t('plugins.unclean-cancel') });
  }
  if (state.service && permissions.activePlugins().length) {
    try { native.sync('fs.writeText', { path: marker, text: String(Date.now()) }); } catch { /* no marker this time */ }
  } else {
    try { native.sync('fs.delete', { path: marker, recursive: false }); } catch { /* none */ }
  }
  route('app.ready', () => {
    try { native.sync('fs.delete', { path: marker, recursive: false }); } catch { /* none */ }
    try { native.sync('app.ready', {}); } catch { /* optional */ }
    return true;
  });
  permissions.refreshNetwork();

  if (state.settings.pendingUri) {
    pendingUri = state.settings.pendingUri;
    state.settings.pendingUri = '';
    saveSettings();
  }

  // changes made by other apps (sync tools, file managers)
  let lastCost = 0;
  let visible = true;
  const rescan = async () => {
    if (!state.service) return;
    const t0 = Date.now();
    try { await state.service.rescan(); } catch (e) { console.warn('rescan failed', e); }
    lastCost = Date.now() - t0;
  };
  native.on('app.resume', () => { visible = true; rescan(); });
  native.on('app.pause', () => {
    visible = false;
    // leaving the app: an encrypted vault is written to its file now
    state.crypt?.seal().catch((e) => console.error('encrypted vault not saved', e));
  });
  installAutoLock();
  crypt.tidy(roots().private, state.crypt ? state.crypt.where.dir : null).catch((e) => console.warn('encrypted folders not tidied', e));
  setInterval(() => { if (visible && lastCost <= RESCAN_MAX_MS) rescan(); }, RESCAN_EVERY);
  native.on('ui.theme', (d) => {
    state.theme = d && d.dark === false ? 'light' : 'dark';
    emit('skai-theme', { theme: state.theme });
  });
  native.on('app.uri', (d) => handleUri(d && d.uri));
  // text or files shared to sk_notes by another app (files arrive as copies in the cache)
  native.on('app.share', (d) => {
    if (!d || !state.service) return;
    const files = (Array.isArray(d.files) ? d.files : []).map((f) => String(f.path || f)).filter(Boolean);
    for (const f of files) permissions.rememberPath(f);
    emit('share', { text: String(d.text || ''), title: String(d.title || ''), files });
  });
  return true;
}

/** Start the backend once; every API call waits for it. */
export function startBackend() {
  started ||= start();
  return started;
}

export { setFolderPicker, handleUri };
