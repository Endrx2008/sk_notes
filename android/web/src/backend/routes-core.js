// sk_notes for Android – core API: app, vaults, vault files, config, search, history, system.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { native } from './native.js';
import * as permissions from './permissions.js';
import { route } from './router.js';
import { search, snippets } from './search.js';
import { LANGUAGES, VERSION, cryptPlaces, emit, roots, saveSettings, state, svc, systemLanguage, t, vaultDataDir } from './state.js';
import { ApiError, CONFIG_DIR, basename, checkName, normalizePath } from './util.js';
import * as crypt from './vault-crypt.js';
import { LOCK_CHOICES, lockAfter, lockNow, setLockAfter } from './vault-lock.js';

const CONFIG_NAME_RE = /^(?:[A-Za-z0-9_.-]+\.json|plugins\/[A-Za-z0-9_.-]+\/data\.json|snippets\/[^/]+\.css|themes\/[^/]+\/theme\.css)$/;
// the layout of a phone is not the layout of a PC: the same vault keeps one of each
const MOBILE_NAMES = { 'workspace.json': 'workspace-mobile.json', 'workspaces.json': 'workspaces-mobile.json' };

/** Community plugins may write inside the vault (default permission) but never into
 * sk_notes' own configuration folder except their own data. Nobody writes the files that
 * decide what plugins may do through these routes. */
function checkPluginWrite(ctx, path) {
  if (permissions.protectedPath(svc().vault.root + '/' + path, true)) throw new ApiError('permission-denied', path);
  if (path === '.git' || path.startsWith('.git/')) throw new ApiError('permission-denied', path);
  if (path === CONFIG_DIR || path.startsWith(CONFIG_DIR + '/')) {
    if (path === CONFIG_DIR || permissions.protectedConfig(path.slice(CONFIG_DIR.length + 1))) throw new ApiError('permission-denied', path);
    if (ctx.plugin && !path.startsWith(`${CONFIG_DIR}/plugins/${ctx.plugin}/`)) throw new ApiError('permission-denied', path);
  }
}

export async function loadStrings(lang) {
  const get = async (code) => {
    try {
      const r = await fetch(`locales/${code}.json`);
      return r.ok ? await r.json() : {};
    } catch { return {}; }
  };
  if (!Object.keys(state.english).length) state.english = await get('en');
  state.strings = lang === 'en' ? state.english : { ...state.english, ...(await get(lang)) };
  state.language = lang;
  return state.strings;
}

export function appInfo() {
  const s = state.service;
  return {
    version: VERSION,
    language: state.language,
    languageSetting: state.settings.language,
    languages: LANGUAGES.map((l) => (l.code === 'en' ? l : { ...l, review: true })), // machine translations, marked "needs review"
    strings: state.strings,
    theme: state.theme,
    vault: s ? { name: s.vault.name, path: s.vault.root, protected: false, encrypted: !!state.crypt, file: state.crypt ? state.crypt.blob : null } : null,
    locked: state.locked, // an encrypted vault waiting for its password
    home: roots().shared || roots().appVaults,
    zoom: state.settings.zoom,
    safeMode: state.safeMode,
    pluginsAllowed: !!s && permissions.pluginsAllowed(),
    renameRecovered: s ? s.recoveredRename : null,
    mobile: true,
    startError: state.startError,
  };
}

export function registerCore() {
  const r = route;

  // ------------------------------------------------------------- app
  r('app.info', () => appInfo());

  r('app.setLanguage', async (p) => {
    const lang = p.language || '';
    if (lang && !LANGUAGES.some((l) => l.code === lang)) throw new ApiError('unknown-language', lang);
    state.settings.language = lang;
    saveSettings();
    const strings = await loadStrings(lang || systemLanguage());
    return { language: state.language, strings };
  });

  r('app.setZoom', (p) => {
    const z = Math.max(0.5, Math.min(3.0, Number(p.zoom) || 1.0));
    state.settings.zoom = z;
    saveSettings();
    native.sync('ui.zoom', { zoom: z });
    return z;
  });

  r('app.relaunch', () => { native.sync('app.reload', {}); return true; });
  r('app.ready', () => true); // replaced at start (see index.js)
  r('app.quit', () => { native.sync('app.exit', {}); return true; });
  r('events.fetch', () => { throw new ApiError('not-found'); });

  // ------------------------------------------------------------- vaults
  r('vaults.list', () => {
    const cur = state.service ? state.service.vault.root : '';
    return Object.entries(state.settings.vaults).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0)).map(([path, info]) => {
      const st = (() => { try { return native.sync('fs.stat', { path }); } catch { return null; } })();
      if (crypt.isBlobPath(path)) return { path, name: crypt.blobName(path), ts: info?.ts || 0, exists: !!st && st.type === 'file', current: state.crypt?.blob === path, encrypted: true };
      return { path, name: basename(path), ts: info?.ts || 0, exists: !!st && st.type === 'dir', current: !state.crypt && cur === path };
    });
  });

  /** Before another vault takes its place: an encrypted vault is written to its file. */
  const settle = async () => { if (state.crypt) await state.crypt.seal(); };
  const remember = (path) => {
    state.settings.vaults[path] = { ts: Date.now() };
    state.settings.lastVault = path;
    saveSettings();
    return { opened: 'here', path };
  };
  const openEncrypted = async (path, password) => {
    if (state.crypt && state.crypt.blob === path) return { opened: 'already' };
    await settle();
    const v = await crypt.unlockVault(path, password, cryptPlaces(path));
    crypt.saveSession(v);
    // told once, at the start: notes put beside as conflict copies, a save that was cut short
    state.settings.cryptNotes = { path, conflicts: v.conflicts, torn: !!v.torn };
    return remember(path);
  };

  const openVault = (path, password = null) => {
    const clean = String(path).replace(/\/+$/, '');
    const st = native.sync('fs.stat', { path: clean });
    if (crypt.isBlobPath(clean) && st && st.type === 'file') {
      if (password === null || password === undefined) throw new ApiError('vault-locked', clean);
      return openEncrypted(clean, password);
    }
    if (!st || st.type !== 'dir') throw new ApiError('not-a-folder', clean);
    if (state.service && !state.crypt && state.service.vault.root === clean) return { opened: 'already' };
    if (state.crypt) return settle().then(() => remember(clean));
    return remember(clean); // the page reloads and starts with this vault
  };

  r('vaults.open', (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    return openVault(p.path, p.password ?? null);
  });

  /** An encrypted vault file found by the user (copied from another device): listed, still closed. */
  r('vaults.remember', (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    const path = String(p.path || '');
    if (!crypt.isBlobPath(path) || native.sync('fs.stat', { path })?.type !== 'file') throw new ApiError('not-found', path);
    if (!state.settings.vaults[path]) { state.settings.vaults[path] = { ts: Date.now() }; saveSettings(); }
    return true;
  });

  /** Lock the encrypted vault that is open: saved to its file, its decrypted files removed. */
  r('vaults.lock', async (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    if (!(await lockNow())) return false;
    native.sync('app.reload', {});
    return true;
  });

  // an encrypted vault file given by path, or the one that is open
  const blobOf = (p) => {
    const path = String(p.path || state.crypt?.blob || '');
    if (!crypt.isBlobPath(path)) throw new ApiError('not-found', path);
    return { path, open: state.crypt && state.crypt.blob === path ? state.crypt : null };
  };
  const appOnly = (fn) => (p, ctx) => { if (ctx.plugin) throw new ApiError('permission-denied'); return fn(p); };

  r('vaults.changePassword', appOnly((p) => { const b = blobOf(p); return crypt.changePassword(b.path, p.old, p.password, b.open); }));
  r('vaults.recover', appOnly((p) => { const b = blobOf(p); return crypt.recoverPassword(b.path, p.code, p.password, b.open); }));
  r('vaults.newRecovery', appOnly((p) => { const b = blobOf(p); return crypt.newRecoveryCode(b.path, p.password, b.open); }));

  r('crypt.settings', appOnly(async () => ({
    lockAfter: lockAfter(), choices: LOCK_CHOICES,
    recovery: state.crypt ? await crypt.hasRecovery(state.crypt.blob) : false,
  })));
  r('crypt.setLockAfter', appOnly((p) => setLockAfter(Number(p.minutes))));
  /** What happened when the vault was opened (conflict copies, a save cut short): told once. */
  r('crypt.takeNotes', appOnly(() => {
    const n = state.settings.cryptNotes;
    if (!n) return null;
    state.settings.cryptNotes = null;
    saveSettings();
    return state.crypt && n.path === state.crypt.blob ? { conflicts: n.conflicts || [], torn: !!n.torn } : null;
  }));

  /** The open (normal) vault made into an encrypted vault file. The file is checked against
   * the folder before anything else; with removeOriginal the readable folder is deleted then. */
  r('vaults.encrypt', appOnly(async (p) => {
    const s = svc();
    if (state.crypt) throw new ApiError('already-encrypted');
    const folder = s.vault.root;
    const parent = String(p.parent || folder.slice(0, folder.lastIndexOf('/'))).replace(/\/+$/, '');
    if (parent === folder || parent.startsWith(folder + '/')) throw new ApiError('into-itself-vault', parent);
    const blob = `${parent}/${basename(folder)}.${crypt.BLOB_EXT}`;
    crypt.checkPassword(p.password);
    if (native.sync('fs.exists', { path: blob })) throw new ApiError('already-exists', blob);
    const data = vaultDataDir(folder);
    const { vault, recovery } = await crypt.encryptFolder(folder, `${data}/history`, blob, p.password, cryptPlaces(blob));
    crypt.saveSession(vault);
    if (p.removeOriginal) {
      // the readable copy goes: the folder, and what the app kept about it (history, search index, sync)
      try { s.close(); } catch { /* closed */ }
      state.service = null;
      native.sync('fs.delete', { path: folder, recursive: true });
      crypt.wipe(data);
      try { native.sync('secret.delete', { name: 'sync-' + data.slice(data.lastIndexOf('/') + 1) }); } catch { /* no sync */ }
      delete state.settings.vaults[folder];
    }
    return { ...remember(blob), recovery };
  }));

  /** The open encrypted vault turned back into a normal folder (the password is asked again). */
  r('vaults.decrypt', appOnly(async (p) => {
    const v = state.crypt;
    if (!v) throw new ApiError('not-encrypted');
    await crypt.verifyPassword(v.blob, p.password);
    const name = crypt.blobName(v.blob);
    const parent = String(p.parent || crypt.parentOf(v.blob)).replace(/\/+$/, '');
    const target = `${parent}/${name}`;
    if (target === v.where.work || target.startsWith(roots().private + '/')) throw new ApiError('permission-denied', target);
    const st = native.sync('fs.stat', { path: target });
    if (st && (st.type !== 'dir' || native.sync('fs.list', { path: target }).length)) throw new ApiError('already-exists', target);
    await crypt.decryptTo(v, target, `${vaultDataDir(target)}/history`);
    const blob = v.blob;
    await lockNow();
    if (p.removeEncrypted) {
      for (const f of [blob, blob + '.old', blob + '.tmp']) { try { native.sync('fs.delete', { path: f, recursive: false }); } catch { /* none */ } }
      delete state.settings.vaults[blob];
    }
    return remember(target);
  }));

  r('vaults.create', (p) => {
    const name = String(p.name || '').trim();
    try { checkName(name); } catch { throw new ApiError('invalid-name'); }
    const target = String(p.parent).replace(/\/+$/, '') + '/' + name;
    const st = native.sync('fs.stat', { path: target });
    if (st && (st.type !== 'dir' || native.sync('fs.list', { path: target }).length)) throw new ApiError('already-exists', target);
    // with a password: an encrypted vault, one file "<name>.skvault" in that folder
    if (p.password !== undefined && p.password !== null) {
      const blob = `${target}.${crypt.BLOB_EXT}`;
      crypt.checkPassword(p.password);
      if (native.sync('fs.exists', { path: blob })) throw new ApiError('already-exists', blob);
      return (async () => {
        await settle();
        let made;
        try { made = await crypt.createVault(blob, p.password, cryptPlaces(blob)); } catch (e) {
          if (e instanceof ApiError) throw e;
          throw new ApiError('read-only', e.detail || blob);
        }
        crypt.saveSession(made.vault);
        // the recovery code is shown once, by the page, before it loads the new vault
        return { ...remember(blob), recovery: made.recovery };
      })();
    }
    try { native.sync('fs.mkdirs', { path: target }); } catch (e) { throw new ApiError('read-only', e.detail || target); }
    return openVault(target);
  });

  r('vaults.forget', (p) => {
    delete state.settings.vaults[p.path];
    if (state.settings.lastVault === p.path && !state.service) state.settings.lastVault = '';
    saveSettings();
    return true;
  });

  // the page shows its own folder browser on Android (ui/folder-picker); it answers here
  r('vaults.pickFolder', async (p) => {
    const picked = await pickFolder(p);
    if (picked) permissions.rememberPath(picked);
    return picked;
  });

  r('vaults.close', () => {
    state.settings.lastVault = '';
    saveSettings();
    return true;
  });

  // ------------------------------------------------------------- vault files
  r('vault.snapshot', () => svc().index.snapshot());
  r('vault.read', (p) => svc().read(p.path));
  r('memory.status', () => ({ protected: false, unlocked: false }));
  r('memory.unlock', () => { throw new ApiError('memory-unsupported'); });
  r('memory.lock', () => ({ unlocked: false }));
  r('vault.readBinary', (p) => svc().vault.readB64(normalizePath(p.path)));

  r('vault.write', (p, ctx) => {
    const path = normalizePath(p.path);
    checkPluginWrite(ctx, path);
    return svc().write(path, p.text ?? '', { expectedMtime: p.expectedMtime ?? null, reason: p.reason || 'edit', mtime: p.mtime || null });
  });

  r('vault.writeBinary', (p, ctx) => {
    const path = normalizePath(p.path);
    checkPluginWrite(ctx, path);
    return svc().writeBinary(path, p.data || '');
  });

  r('vault.create', (p, ctx) => {
    const path = normalizePath(p.path);
    checkPluginWrite(ctx, path);
    return svc().create(path, p.text ?? '');
  });

  r('vault.createUnique', (p, ctx) => {
    // the name with the numeric suffix it will really get is what is checked
    const path = svc().vault.availablePath(p.folder || '', p.base || 'Untitled', p.ext ?? 'md');
    checkPluginWrite(ctx, normalizePath(path));
    return svc().write(path, p.text ?? '');
  });

  r('vault.availablePath', (p) => svc().vault.availablePath(p.folder || '', p.base || 'Untitled', p.ext ?? 'md'));

  r('vault.mkdir', (p, ctx) => {
    const path = normalizePath(p.path);
    checkPluginWrite(ctx, path);
    return svc().mkdir(path);
  });

  r('vault.rename', (p, ctx) => {
    checkPluginWrite(ctx, normalizePath(p.path));
    checkPluginWrite(ctx, normalizePath(p.newPath));
    return svc().rename(p.path, p.newPath, { updateLinks: p.updateLinks ?? null });
  });

  r('vault.copy', (p, ctx) => {
    checkPluginWrite(ctx, normalizePath(p.newPath));
    return svc().copy(p.path, p.newPath);
  });

  r('vault.delete', (p, ctx) => {
    checkPluginWrite(ctx, normalizePath(p.path));
    return svc().delete(p.path, { mode: p.mode || null });
  });

  r('vault.exists', (p) => (normalizePath(p.path) === '/' ? true : svc().vault.exists(p.path)));

  r('vault.stat', (p) => {
    const e = svc().vault.stat(p.path);
    if (e === null) return null;
    return { type: e.isDir ? 'folder' : 'file', size: e.size || 0, mtime: e.mtime || 0, ctime: e.ctime || 0 };
  });

  r('vault.list', (p) => svc().vault.listDir(p.path || '/'));
  r('vault.rescan', async () => { await svc().rescan(); return true; });

  // ------------------------------------------------------------- vault config (.sk_notes/*)
  const configPath = (name) => svc().vault.configDir + '/' + (MOBILE_NAMES[name] || name);

  r('config.read', (p, ctx) => {
    const name = String(p.name || '');
    if (!CONFIG_NAME_RE.test(name) || name.includes('..')) throw new ApiError('bad-name', name);
    if (ctx.plugin && !name.startsWith(`plugins/${ctx.plugin}/`)) throw new ApiError('permission-denied', name);
    const path = configPath(name);
    if (!native.sync('fs.exists', { path })) return null;
    let text;
    try { text = native.sync('fs.readText', { path }).text; } catch { return null; }
    if (name.endsWith('.css')) return text;
    try { return JSON.parse(text); } catch { return null; }
  });

  r('config.write', (p, ctx) => {
    const name = String(p.name || '');
    if (!CONFIG_NAME_RE.test(name) || name.includes('..') || name.endsWith('.css')) throw new ApiError('bad-name', name);
    if (permissions.protectedConfig(name)) throw new ApiError('permission-denied', name);
    if (ctx.plugin && !name.startsWith(`plugins/${ctx.plugin}/`)) throw new ApiError('permission-denied', name);
    const path = configPath(name);
    native.sync('fs.mkdirs', { path: path.slice(0, path.lastIndexOf('/')) });
    native.sync('fs.writeText', { path, text: JSON.stringify(p.data ?? null, null, 2) });
    state.crypt?.touch();
    return true;
  });

  r('config.list', (p) => {
    const base = svc().vault.configDir;
    const list = (dir) => { try { return native.sync('fs.exists', { path: dir }) ? native.sync('fs.list', { path: dir }) : []; } catch { return []; } };
    if (p.kind === 'snippets') return list(base + '/snippets').filter((e) => e.type === 'file' && e.name.endsWith('.css')).map((e) => e.name).sort();
    if (p.kind === 'themes') {
      const found = list(base + '/themes').filter((e) => e.type === 'dir' && native.sync('fs.exists', { path: `${base}/themes/${e.name}/theme.css` })).map((e) => e.name);
      return [...new Set(['Anna.g_3', ...found])].sort(); // Anna.g_3 comes with the app
    }
    throw new ApiError('bad-kind');
  });

  r('config.openFolder', (p) => {
    const sub = p.sub || '';
    if (!['', 'snippets', 'themes', 'plugins'].includes(sub)) throw new ApiError('bad-name');
    const d = svc().vault.configDir + (sub ? '/' + sub : '');
    native.sync('fs.mkdirs', { path: d });
    return native.sync('sys.openFolder', { path: d });
  });

  // ------------------------------------------------------------- search & history
  r('search.query', (p) => search(svc().index, p.query || '', {
    caseSensitive: !!p.caseSensitive, context: Number(p.context ?? 1) || 1, limitFiles: Number(p.limit ?? 2000) || 2000,
    snippetFiles: p.snippetFiles === null || p.snippetFiles === undefined ? null : Number(p.snippetFiles),
  }));

  r('search.snippets', (p) => snippets(svc().index, p.query || '', Array.isArray(p.paths) ? p.paths : [], { caseSensitive: !!p.caseSensitive, context: Number(p.context ?? 1) || 1 }));
  r('index.tags', () => svc().index.allTags());
  r('index.properties', () => svc().index.properties());
  r('history.list', (p) => svc().history.list(normalizePath(p.path)));
  r('history.files', () => svc().history.files().map((f) => ({ ...f, exists: svc().index.files.has(f.path) })));
  r('history.read', (p) => svc().history.read(Number(p.id)));
  r('history.restore', (p) => svc().restoreSnapshot(p.path, Number(p.id)));
  /** Keep the note as it is now as a version (before changes are brought in from another version). */
  r('history.checkpoint', (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    const path = normalizePath(p.path);
    const s = svc();
    if (!s.vault.exists(path)) throw new ApiError('not-found');
    return s.history.snapshot(path, s.vault.readText(path), { reason: 'manual', force: true });
  });

  // ------------------------------------------------------------- system
  r('system.openExternal', (p, ctx) => {
    const url = String(p.url || '');
    if (!/^(https?|mailto):/i.test(url)) throw new ApiError('bad-url');
    if (ctx.plugin) permissions.require(ctx, 'open-external', url);
    return native.sync('sys.openExternal', { url });
  });

  r('system.openPath', (p) => native.sync('sys.openPath', { path: svc().vault.abs(p.path) }));

  r('system.showInFolder', (p) => {
    const rel = normalizePath(p.path || '/');
    const abs = svc().vault.abs(rel);
    return native.sync('sys.openFolder', { path: rel !== '/' && !svc().vault.isDir(rel) ? abs.slice(0, abs.lastIndexOf('/')) : abs });
  });

  /** Files picked with Android's own file chooser, as copies in the app's cache. */
  r('system.pickFiles', async (p) => {
    const files = await native.async('ui.pickFiles', { multiple: p.multiple !== false, mime: p.mime || ['*/*'] });
    for (const f of files) permissions.rememberPath(f.path);
    return files.map((f) => f.path);
  });

  /** Copy external files (picker, shared from another app) into the vault. */
  r('system.importFiles', (p, ctx) => {
    const s = svc();
    const out = [];
    for (const src of p.files || []) {
      const st = native.sync('fs.stat', { path: src });
      if (!st || st.type !== 'file') continue;
      if (!permissions.chosen(src)) permissions.require(ctx, 'fs-outside-vault', src); // only files the user picked
      const name = basename(src);
      const dot = name.lastIndexOf('.');
      const dest = s.vault.availablePath(p.folder || '', dot > 0 ? name.slice(0, dot) : name, dot > 0 ? name.slice(dot + 1) : '');
      s.writeBinary(dest, native.sync('fs.readB64', { path: src }));
      out.push(dest);
    }
    return out;
  });

  /** A site the user put on a board may load inside its card (frames only; see MainActivity). */
  r('web.allow', (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    const m = /^https:\/\/([^/?#@:]+|\[[^\]]+\])(?::\d+)?(?:[/?#]|$)/i.exec(String(p.url || ''));
    if (!m) throw new ApiError('bad-url', String(p.url || ''));
    try { native.sync('net.allowFrame', { host: m[1].toLowerCase() }); } catch { /* a native side without frames (tests) */ }
    return true;
  });

  // the clipboard, through Android (asked only by the app's own code: see mobile.js)
  r('clipboard.read', (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    return String(native.sync('clip.read', {}) ?? '');
  });
  r('clipboard.write', (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    native.sync('clip.write', { text: String(p.text ?? '') });
    return true;
  });

  r('system.env', () => ({ desktop: 'android', wayland: false, hyprland: false, i3: false, android: true }));
  r('system.share', (p) => native.sync('sys.share', { text: p.text || '', path: p.path ? svc().vault.abs(p.path) : '', title: p.title || '' }));

  // ------------------------------------------------------------- windows
  r('window.setTitle', () => true);
  r('window.toggleDevtools', () => false);
  r('window.fullscreen', () => native.sync('ui.fullscreen', {}));
  r('window.popout', () => { throw new ApiError('unsupported', t('mobile.no-windows')); });
}

// ---------------------------------------------------------------- folder picker (shown by the page)
let folderPicker = null;
export function setFolderPicker(fn) { folderPicker = fn; }
export function askFolder(params) { return pickFolder(params); }
function pickFolder(params) {
  if (!folderPicker) throw new ApiError('unsupported');
  return folderPicker(params || {});
}

export { emit };
