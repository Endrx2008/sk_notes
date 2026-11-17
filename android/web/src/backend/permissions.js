// sk_notes for Android – per-plugin permissions.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Everything that decides what community plugins may do is stored in the app's private
// storage, not in the vault (a shared, synced or downloaded vault must not arrive with its
// plugins already allowed): <private>/vault-trust/<vault hash>.json with
// {"plugins": bool, "trusted": [ids], "permissions": {id: {perm: "allow"|"deny"}}, "paths": [...]}.
// "plugins" replaces the vault's restricted-mode switch. Questions are asked in native
// Android dialogs, which page code (plugins included) cannot answer for the user.

import { native } from './native.js';
import { roots, state, t } from './state.js';
import { ApiError, CONFIG_DIR, sha1 } from './util.js';

export const PERMISSIONS = ['fs-outside-vault', 'exec', 'network', 'open-external', 'clipboard'];
const session = new Set(); // "allow once" answers for this run
const chosenPaths = new Set();

function storePath() {
  if (!state.service) return null;
  return `${roots().private}/vault-trust/${sha1(state.service.vault.root).slice(0, 20)}.json`;
}

function load() {
  let data = {};
  const p = storePath();
  if (p) {
    try { if (native.sync('fs.exists', { path: p })) data = JSON.parse(native.sync('fs.readText', { path: p }).text); } catch { data = {}; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  if (typeof data.plugins !== 'boolean') data.plugins = false;
  if (!Array.isArray(data.trusted)) data.trusted = [];
  if (!data.permissions || typeof data.permissions !== 'object' || Array.isArray(data.permissions)) data.permissions = {};
  if (!Array.isArray(data.paths)) data.paths = [];
  return data;
}

function save(data) {
  const p = storePath();
  if (!p) return;
  native.sync('fs.mkdirs', { path: p.slice(0, p.lastIndexOf('/')) });
  native.sync('fs.writeText', { path: p, text: JSON.stringify(data, null, 1) });
}

export function allPermissions() {
  const out = {};
  for (const [k, v] of Object.entries(load().permissions)) if (v && typeof v === 'object') out[k] = v;
  return out;
}

export function status(plugin, perm) {
  return (load().permissions[plugin] || {})[perm] ?? null;
}

export function setStatus(plugin, perm, value) {
  const data = load();
  const entry = data.permissions[plugin] || (data.permissions[plugin] = {});
  if (value === null || value === undefined) delete entry[perm]; else entry[perm] = value;
  save(data);
  if (perm === 'network') refreshNetwork();
}

/** A removed plugin loses its trust and answers: a new copy must be confirmed again. */
export function forgetPlugin(plugin) {
  const data = load();
  delete data.permissions[plugin];
  data.trusted = data.trusted.filter((x) => x !== plugin);
  save(data);
  refreshNetwork();
}

/** Community plugins may run in this vault (restricted mode off), decided on this device. */
export function pluginsAllowed() {
  return !!state.service && !!load().plugins;
}

export function setPluginsAllowed(value) {
  const data = load();
  data.plugins = !!value;
  save(data);
  refreshNetwork();
}

export function isTrusted(plugin) {
  return load().trusted.includes(plugin);
}

export function trust(plugin, value = true) {
  const data = load();
  data.trusted = data.trusted.filter((x) => x !== plugin);
  if (value) data.trusted.push(plugin);
  save(data);
}

/** Plugins that may run: enabled in the vault, trusted here, and plugins allowed. */
export function activePlugins() {
  if (!state.service || state.safeMode) return [];
  const data = load();
  if (!data.plugins) return [];
  const enabled = state.service.configRead('community-plugins.json', []) || [];
  return (Array.isArray(enabled) ? enabled : []).filter((p) => data.trusted.includes(p));
}

/** Remote requests from the page itself (fetch, images) are allowed only while an active
 * plugin holds 'network'; the native side blocks them otherwise. */
export function refreshNetwork() {
  let allow = false;
  try {
    const perms = load().permissions;
    allow = activePlugins().some((p) => (perms[p] || {}).network === 'allow');
  } catch { allow = false; }
  try { native.sync('net.policy', { allowRemote: allow }); } catch { /* native side without the switch (tests) */ }
  return allow;
}

/** Native yes/no dialog. */
export function confirm(title, text, { detail = '', ok = '' } = {}) {
  return !!native.sync('ui.confirm', {
    title, text, detail: (detail ? detail.slice(0, 600) + '\n\n' : '') + t('perm.warning'),
    ok: ok || t('perm.always'), cancel: t('perm.cancel'),
  });
}

export function pluginName(plugin) {
  try {
    const m = JSON.parse(native.sync('fs.readText', { path: `${state.service.vault.configDir}/plugins/${plugin}/manifest.json` }).text);
    return m.name || plugin;
  } catch { return plugin; }
}

/** A path the user picked in a native dialog or in the folder browser. */
export function rememberPath(path, persist = false) {
  const real = String(path).replace(/\/+$/, '');
  chosenPaths.add(real);
  if (persist && state.service) {
    const data = load();
    data.paths = [...data.paths.filter((x) => x !== real).slice(-19), real];
    save(data);
  }
}

/** True if `path` is, or is inside, a location the user picked. */
export function chosen(path) {
  const real = String(path).replace(/\/+$/, '');
  const picked = new Set([...chosenPaths, ...load().paths]);
  for (const c of picked) if (real === c || real.startsWith(c.replace(/\/+$/, '') + '/')) return true;
  return false;
}

/** Throws ApiError('permission-denied') unless the plugin may use `perm`. */
export function require(ctx, perm, detail = '') {
  // no plugin token: page code that is not a plugin's own shims. Permissions belong to
  // identified plugins only.
  if (!ctx.plugin) throw new ApiError('permission-denied', `unidentified caller: ${perm}`);
  const plugin = ctx.plugin;
  const st = status(plugin, perm);
  if (st === 'allow' || session.has(plugin + '\u0000' + perm)) return;
  if (st === 'deny') throw new ApiError('permission-denied', `${plugin}: ${perm}`);
  const answer = native.sync('ui.choose', {
    title: t('perm.title'),
    text: t('perm.question', { plugin: pluginName(plugin), what: t(`perm.${perm}`) }),
    detail: (detail ? detail.slice(0, 400) + '\n\n' : '') + t('perm.warning'),
    buttons: [t('perm.once'), t('perm.always'), t('perm.deny')],
  });
  if (answer === 1) { setStatus(plugin, perm, 'allow'); return; }
  if (answer === 0) { session.add(plugin + '\u0000' + perm); return; }
  setStatus(plugin, perm, 'deny');
  throw new ApiError('permission-denied', `${plugin}: ${perm}`);
}

// Written only by the backend (plugin install, enable, permission dialogs): page code,
// plugins included, can never change what plugins may do or replace a plugin's code.
const PROTECTED = /^(permissions\.json|community-plugins\.json|rename-journal\.json(\.tmp)?|plugins(\/[^/]+(\/(main\.js|manifest\.json|styles\.css))?)?)$/;

/** name: path inside .sk_notes/ (e.g. 'plugins/x/main.js'). */
export function protectedConfig(name) {
  const n = name.replace(/^\/+|\/+$/g, '');
  return n === '' || PROTECTED.test(n);
}

/** True if the absolute path is a place page code must not touch: the app's private
 * storage (never), and in the vault the files that decide what plugins may do (writes). */
export function protectedPath(abs, write) {
  const real = String(abs).replace(/\/+$/, '');
  const inside = (base) => (real === base ? '.' : real.startsWith(base + '/') ? real.slice(base.length + 1) : null);
  const r = roots();
  // the files of an open encrypted vault are in the private storage, and are a vault like any other
  const open = state.crypt ? inside(state.crypt.where.work) !== null : false;
  if (!open) for (const base of [r.private, r.dataDir].filter(Boolean)) if (inside(base.replace(/\/+$/, '')) !== null) return true;
  if (!state.service || !write) return false;
  const root = state.service.vault.root;
  if (inside(root + '/.git') !== null) return true;
  const rel = inside(root + '/' + CONFIG_DIR);
  if (rel !== null) return rel === '.' || protectedConfig(rel);
  return false;
}
