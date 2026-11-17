// sk_notes for Android – community plugins: install, enable, remove, the catalogue of
// community plugins, and the backend side of the Node shims (files, network, hashes)
// behind permissions.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { native } from './native.js';
import * as permissions from './permissions.js';
import { issueToken, route } from './router.js';
import { roots, state, svc, t } from './state.js';
import { ApiError, CONFIG_DIR, b64ToText, normpath, textToB64 } from './util.js';
import { isOllamaUrl } from './ollama.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_DOWNLOAD = 40 * 1024 * 1024;
// The public list of community plugins (the same list the plugin browser of the app these
// plugins were written for reads) and its download counts.
const CATALOG_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json';
const STATS_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugin-stats.json';
const CATALOG_MAX_AGE = 24 * 3600 * 1000;

function safeId(id) {
  if (!ID_RE.test(id || '')) throw new ApiError('bad-id', String(id));
  return id;
}

function appOnly(ctx) {
  if (ctx.plugin) throw new ApiError('permission-denied');
}

function pluginsDir() {
  const d = svc().vault.configDir + '/plugins';
  try { native.sync('fs.mkdirs', { path: d }); } catch { /* read-only vault: listing finds nothing, installing reports the error */ }
  return d;
}

function enabled() {
  const list = svc().configRead('community-plugins.json', []);
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
}

function listDir(path) {
  try { return native.sync('fs.exists', { path }) ? native.sync('fs.list', { path }) : []; } catch { return []; }
}

function readJson(path) {
  try { return JSON.parse(native.sync('fs.readText', { path }).text); } catch { return null; }
}

function installedIds() {
  return listDir(pluginsDir()).filter((e) => e.type === 'dir' && ID_RE.test(e.name)).map((e) => e.name).sort();
}

function confirmInstall(name, source) {
  if (!permissions.confirm(t('plugins.install-title'), t('plugins.install-question', { plugin: name }), { detail: source, ok: t('plugins.install-ok') })) throw new ApiError('cancelled');
}

async function download(url, { optional = false } = {}) {
  let r;
  try {
    r = await native.async('net.request', { url, method: 'GET', headers: { 'User-Agent': 'sk_notes' }, timeout: 60, maxBytes: MAX_DOWNLOAD });
  } catch (e) {
    if (e.code === 'too-large') throw e;
    throw new ApiError('download-failed', e.detail || e.code || String(e));
  }
  if (r.status === 404 && optional) return null;
  if (r.status < 200 || r.status >= 300) throw new ApiError('download-failed', `${url.slice(url.lastIndexOf('/') + 1)}: HTTP ${r.status}`);
  return r.b64 || '';
}

// ---------------------------------------------------------------- catalogue
async function catalog(refresh) {
  const file = roots().cache + '/community-plugins.json';
  let cached = null;
  try { if (native.sync('fs.exists', { path: file })) cached = JSON.parse(native.sync('fs.readText', { path: file }).text); } catch { cached = null; }
  if (cached && Array.isArray(cached.plugins) && !refresh && Date.now() - (cached.ts || 0) < CATALOG_MAX_AGE) return { plugins: cached.plugins, ts: cached.ts, cached: true };
  let list;
  try {
    list = JSON.parse(b64ToText(await download(CATALOG_URL)));
    if (!Array.isArray(list)) throw new ApiError('download-failed', 'list');
  } catch (e) {
    if (cached && Array.isArray(cached.plugins)) return { plugins: cached.plugins, ts: cached.ts, cached: true, stale: true };
    throw e instanceof ApiError ? e : new ApiError('download-failed', String(e));
  }
  let stats = {};
  try { stats = JSON.parse(b64ToText(await download(STATS_URL))) || {}; } catch { stats = {}; } // the counts are optional
  const plugins = [];
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || typeof p.repo !== 'string' || !ID_RE.test(p.id) || !REPO_RE.test(p.repo)) continue;
    const st = stats[p.id] || {};
    plugins.push({
      id: p.id, name: String(p.name || p.id).slice(0, 120), author: String(p.author || '').slice(0, 120),
      description: String(p.description || '').slice(0, 400), repo: p.repo,
      downloads: Number(st.downloads) || 0, updated: Number(st.updated) || 0,
    });
  }
  plugins.sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));
  const ts = Date.now();
  try { native.sync('fs.writeText', { path: file, text: JSON.stringify({ ts, plugins }) }); } catch { /* no cache this time */ }
  return { plugins, ts, cached: false };
}

async function installFromRepo(repoRaw, version) {
  const repo = String(repoRaw || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!REPO_RE.test(repo)) throw new ApiError('bad-repo', repo);
  const tag = String(version || '');
  if (tag && !/^[A-Za-z0-9._+-]+$/.test(tag)) throw new ApiError('bad-repo', tag);
  const base = `https://github.com/${repo}/releases/` + (tag ? `download/${tag}/` : 'latest/download/');
  const files = {};
  for (const name of ['manifest.json', 'main.js', 'styles.css']) {
    const data = await download(base + name, { optional: name === 'styles.css' });
    if (data !== null) files[name] = data;
  }
  let m;
  try { m = JSON.parse(b64ToText(files['manifest.json'])); } catch { throw new ApiError('not-a-plugin', 'manifest'); }
  if (!m || typeof m !== 'object') throw new ApiError('not-a-plugin', 'manifest');
  const pid = safeId(m.id || '');
  confirmInstall(m.name || pid, `https://github.com/${repo}` + (m.isDesktopOnly ? '\n\n' + t('plugins.desktop-only') : ''));
  permissions.trust(pid, false); // new code under an old id must be enabled (and confirmed) again
  const dest = pluginsDir() + '/' + pid;
  native.sync('fs.mkdirs', { path: dest });
  for (const [name, b64] of Object.entries(files)) native.sync('fs.writeB64', { path: `${dest}/${name}`, b64 });
  m.repo = repo;
  return m;
}

// ---------------------------------------------------------------- Node shims: paths
/** Absolute path for a plugin fs call; outside the vault needs a permission. */
function resolvePath(ctx, raw, write) {
  const root = svc().vault.root;
  let path = String(raw ?? '');
  if (!path.startsWith('/')) path = root + '/' + path;
  path = normpath(path);
  const inside = path === root || path.startsWith(root + '/');
  if (permissions.protectedPath(path, write)) throw new ApiError('permission-denied', 'protected');
  if (inside) {
    const rel = path === root ? '' : path.slice(root.length + 1);
    if (write && (rel === '' || rel === '.git' || rel.startsWith('.git/'))) throw new ApiError('permission-denied', rel || 'vault folder');
    if (rel === CONFIG_DIR || rel.startsWith(CONFIG_DIR + '/')) {
      const own = ctx.plugin ? `${CONFIG_DIR}/plugins/${ctx.plugin}` : null;
      if (!own || !(rel === own || rel.startsWith(own + '/'))) {
        if (write || !rel.startsWith(`${CONFIG_DIR}/plugins/`)) throw new ApiError('permission-denied', rel);
      }
    }
    return path;
  }
  permissions.require(ctx, 'fs-outside-vault', path);
  return path;
}

/** A plugin wrote into the vault through fs: update the index. */
function notify(path) {
  try {
    const root = state.service.vault.root;
    if (path.startsWith(root + '/')) state.service.externalChange(path.slice(root.length + 1));
  } catch { /* not in the vault */ }
}

function shimFs(p, ctx) {
  const op = p.op;
  const write = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'copyFile', 'unlink', 'rmdir'].includes(op);
  const path = resolvePath(ctx, p.path, write);
  const stat = () => native.sync('fs.stat', { path });
  if (op === 'readFile') {
    const st = stat();
    if (!st) throw new ApiError('ENOENT', path);
    if (st.type === 'dir') throw new ApiError('EISDIR', path);
    return { b64: native.sync('fs.readB64', { path }) };
  }
  if (op === 'writeFile') {
    native.sync('fs.writeB64', { path, b64: p.b64 || '' });
    notify(path);
    return true;
  }
  if (op === 'appendFile') {
    native.sync('fs.append', { path, b64: p.b64 || '' });
    notify(path);
    return true;
  }
  if (op === 'exists') return native.sync('fs.exists', { path });
  if (op === 'stat') {
    const st = stat();
    if (!st) throw new ApiError('ENOENT', path);
    const dir = st.type === 'dir';
    return { size: st.size || 0, mtimeMs: st.mtime || 0, ctimeMs: st.ctime || st.mtime || 0, birthtimeMs: st.ctime || st.mtime || 0, isFile: !dir, isDirectory: dir, mode: dir ? 0o40755 : 0o100644 };
  }
  if (op === 'readdir') {
    const st = stat();
    if (!st) throw new ApiError('ENOENT', path);
    if (st.type !== 'dir') throw new ApiError('ENOTDIR', path);
    return native.sync('fs.list', { path }).map((e) => e.name).sort();
  }
  if (op === 'mkdir') {
    if (!p.recursive) {
      if (stat()) throw new ApiError('EEXIST', path);
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      if (!native.sync('fs.exists', { path: parent })) throw new ApiError('ENOENT', parent);
    }
    native.sync('fs.mkdirs', { path });
    return true;
  }
  if (op === 'rm' || op === 'unlink' || op === 'rmdir') {
    const st = stat();
    if (!st) {
      if (!p.force) throw new ApiError('ENOENT', path);
      return true;
    }
    if (st.type === 'dir') {
      if (op === 'rmdir' && !p.recursive) {
        if (native.sync('fs.list', { path }).length) throw new ApiError('ENOTEMPTY', path);
      } else if (!p.recursive) throw new ApiError('EISDIR', path);
      native.sync('fs.delete', { path, recursive: true });
    } else native.sync('fs.delete', { path, recursive: false });
    notify(path);
    return true;
  }
  if (op === 'rename' || op === 'copyFile') {
    const dest = resolvePath(ctx, p.dest, true);
    if (!stat()) throw new ApiError('ENOENT', path);
    const there = native.sync('fs.stat', { path: dest });
    if (there && dest !== path) {
      if (there.type === 'dir') throw new ApiError('EISDIR', dest);
      native.sync('fs.delete', { path: dest, recursive: false }); // like rename(2): the target is replaced
    }
    native.sync(op === 'rename' ? 'fs.rename' : 'fs.copy', { from: path, to: dest });
    if (op === 'rename') notify(path);
    notify(dest);
    return true;
  }
  throw new ApiError('bad-op', String(op));
}

export function registerPlugins() {
  const r = route;

  // ------------------------------------------------------------- management
  r('plugins.list', () => {
    const out = [];
    const dir = pluginsDir();
    for (const e of listDir(dir).filter((x) => x.type === 'dir').sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const base = `${dir}/${e.name}`;
      if (!native.sync('fs.exists', { path: base + '/manifest.json' })) continue;
      const m = readJson(base + '/manifest.json');
      if (!m || typeof m !== 'object' || Array.isArray(m)) { out.push({ id: e.name, broken: true, dir: e.name }); continue; }
      m.dir = e.name;
      m.hasStyles = native.sync('fs.exists', { path: base + '/styles.css' });
      m.hasMain = native.sync('fs.exists', { path: base + '/main.js' });
      out.push(m);
    }
    const en = enabled();
    return { plugins: out, enabled: en, permissions: permissions.allPermissions(), trusted: en.filter((x) => permissions.isTrusted(x)), allowed: permissions.pluginsAllowed() };
  });

  // caller tokens: one per plugin that may run, for the app's plugin manager only
  r('plugins.tokens', (p, ctx) => {
    appOnly(ctx);
    const ids = installedIds();
    const out = {};
    for (const id of permissions.activePlugins()) {
      if (!ids.includes(id)) continue;
      const tok = issueToken(id);
      if (tok) out[id] = tok;
    }
    return out;
  });

  r('plugins.token', (p, ctx) => {
    appOnly(ctx);
    const pid = safeId(p.id);
    if (!permissions.activePlugins().includes(pid)) throw new ApiError('permission-denied', 'plugin not enabled');
    const tok = issueToken(pid);
    if (!tok) throw new ApiError('permission-denied', 'no token');
    return tok;
  });

  r('plugins.source', (p, ctx) => {
    const pid = safeId(p.id);
    if (ctx.plugin || !permissions.activePlugins().includes(pid)) throw new ApiError('permission-denied', 'plugin not enabled'); // only code that may run is handed out
    const d = `${pluginsDir()}/${pid}`;
    let main;
    try { main = native.sync('fs.readText', { path: d + '/main.js' }).text; } catch (e) { throw new ApiError('not-found', e.detail || pid); }
    let css = '';
    try { if (native.sync('fs.exists', { path: d + '/styles.css' })) css = native.sync('fs.readText', { path: d + '/styles.css' }).text; } catch { css = ''; }
    return { main, css };
  });

  r('plugins.setEnabled', (p, ctx) => {
    appOnly(ctx);
    const pid = safeId(p.id);
    const list = enabled().filter((x) => x !== pid);
    if (p.enabled) {
      if (!permissions.isTrusted(pid)) {
        if (!permissions.confirm(t('plugins.trust-title'), t('plugins.trust-question', { plugin: permissions.pluginName(pid) }), { ok: t('plugins.trust-ok') })) throw new ApiError('cancelled');
        permissions.trust(pid);
      }
      list.push(pid);
    }
    svc().configWrite('community-plugins.json', list);
    permissions.refreshNetwork();
    return list;
  });

  r('plugins.remove', (p, ctx) => {
    appOnly(ctx);
    const pid = safeId(p.id);
    if (!permissions.confirm(t('plugins.remove-title'), t('plugins.remove-question', { plugin: permissions.pluginName(pid) }), { ok: t('plugins.remove-ok') })) throw new ApiError('cancelled');
    const d = `${pluginsDir()}/${pid}`;
    if (native.sync('fs.exists', { path: d })) native.sync('fs.delete', { path: d, recursive: true });
    svc().configWrite('community-plugins.json', enabled().filter((x) => x !== pid));
    permissions.forgetPlugin(pid);
    return true;
  });

  // restricted mode is kept on this device: a vault cannot turn it off by itself
  r('plugins.setRestricted', (p, ctx) => {
    appOnly(ctx);
    const allow = !(p.restricted ?? true);
    if (allow && !permissions.pluginsAllowed()) {
      if (!permissions.confirm(t('plugins.allow-title'), t('plugins.allow-question'), { ok: t('plugins.allow-ok') })) throw new ApiError('cancelled');
    }
    permissions.setPluginsAllowed(allow);
    return { allowed: permissions.pluginsAllowed() };
  });

  r('plugins.installFolder', (p, ctx) => {
    appOnly(ctx);
    const src = String(p.path || '').replace(/\/+$/, '');
    if (!permissions.chosen(src)) throw new ApiError('permission-denied', src); // a folder the user picked
    if (!native.sync('fs.exists', { path: src + '/manifest.json' }) || !native.sync('fs.exists', { path: src + '/main.js' })) throw new ApiError('not-a-plugin', src);
    const m = readJson(src + '/manifest.json');
    if (!m || typeof m !== 'object') throw new ApiError('not-a-plugin', src);
    const pid = safeId(m.id || '');
    confirmInstall(m.name || pid, src);
    permissions.trust(pid, false);
    const dest = `${pluginsDir()}/${pid}`;
    native.sync('fs.mkdirs', { path: dest });
    for (const name of ['manifest.json', 'main.js', 'styles.css']) {
      if (native.sync('fs.exists', { path: `${src}/${name}` })) native.sync('fs.writeB64', { path: `${dest}/${name}`, b64: native.sync('fs.readB64', { path: `${src}/${name}` }) });
    }
    return m;
  });

  r('plugins.installGithub', (p, ctx) => {
    appOnly(ctx);
    return installFromRepo(p.repo, p.version);
  });

  r('plugins.catalog', (p, ctx) => {
    appOnly(ctx);
    return catalog(!!p.refresh);
  });

  /** Versions installed and published, for the "check for updates" button. */
  r('plugins.checkUpdates', async (p, ctx) => {
    appOnly(ctx);
    const { plugins } = await catalog(false);
    const byId = new Map(plugins.map((x) => [x.id, x]));
    const out = [];
    for (const id of installedIds()) {
      const m = readJson(`${pluginsDir()}/${id}/manifest.json`);
      const entry = byId.get(id);
      if (!m || !entry) continue;
      const data = await download(`https://github.com/${entry.repo}/releases/latest/download/manifest.json`, { optional: true }).catch(() => null);
      if (!data) continue;
      let latest;
      try { latest = JSON.parse(b64ToText(data)); } catch { continue; }
      if (latest?.version && latest.version !== m.version) out.push({ id, name: m.name || id, repo: entry.repo, installed: m.version || '', latest: latest.version });
    }
    return out;
  });

  r('plugins.permissions', (p, ctx) => {
    appOnly(ctx);
    const pid = safeId(p.id);
    if (p.set && typeof p.set === 'object') {
      for (const [perm, value] of Object.entries(p.set)) {
        if (!permissions.PERMISSIONS.includes(perm) || !['allow', 'deny', null].includes(value)) continue;
        if (value === 'allow' && permissions.status(pid, perm) !== 'allow') {
          if (!permissions.confirm(t('perm.title'), t('perm.question', { plugin: permissions.pluginName(pid), what: t(`perm.${perm}`) }))) continue;
        }
        permissions.setStatus(pid, perm, value);
      }
    }
    return permissions.allPermissions()[pid] || {};
  });

  // ------------------------------------------------------------- Node shims
  r('shim.fs', (p, ctx) => shimFs(p, ctx));

  // Android apps cannot start programs: every command is "not found", as on a PC without it
  r('shim.exec', (p, ctx) => {
    const shown = p.shell ? String(p.cmd) : [p.cmd, ...(p.args || [])].join(' ');
    permissions.require(ctx, 'exec', shown);
    return { code: 127, stdout: '', stderr: textToB64(t('mobile.no-programs')), error: 'ENOENT' };
  });

  r('shim.request', async (p, ctx) => {
    const url = String(p.url || '');
    if (!/^https?:\/\/([^/:]+|\[[^\]]+\])/i.test(url)) throw new ApiError('bad-url', url);
    if (!isOllamaUrl(url)) permissions.require(ctx, 'network', url);
    const headers = {};
    for (const [k, v] of Object.entries(p.headers || {})) if (!['host', 'content-length'].includes(k.toLowerCase())) headers[k] = String(v);
    if (p.contentType) headers['Content-Type'] = String(p.contentType);
    let res;
    try {
      res = await native.async('net.request', { url, method: String(p.method || 'GET').toUpperCase(), headers, body: p.body || '', timeout: 60, maxBytes: MAX_DOWNLOAD });
    } catch (e) {
      if (e.code === 'too-large') throw new ApiError('too-large', url);
      throw new ApiError('network-error', e.detail || e.code || String(e));
    }
    return { status: res.status, headers: res.headers || {}, b64: res.b64 || '' };
  });

  r('shim.hash', (p) => {
    const algo = String(p.algo || 'sha256').toLowerCase().replace(/-/g, '');
    if (!['md5', 'sha1', 'sha256', 'sha512', 'sha384', 'sha224'].includes(algo)) throw new ApiError('bad-algo', algo);
    return native.sync('hash', { algo, b64: p.b64 || '' });
  });

  r('shim.env', () => ({ home: roots().shared || roots().appVaults, tmp: roots().cache, user: '', hostname: 'android', vault: svc().vault.root }));
}
