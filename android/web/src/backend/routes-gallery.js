// sk_notes for Android – things made by others that the app can fetch: templates and themes.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Templates: the folder community/templates of the sk_notes repository. The app carries a
// copy (assets), and uses the one on GitHub when it can be read.
// Themes: the public directory of community themes (the one the app these themes were
// written for reads); a theme is the theme.css of its GitHub repository.
// Nothing is asked to the network until the user opens one of the two lists.

import { native } from './native.js';
import { route } from './router.js';
import { roots, svc } from './state.js';
import { ApiError, b64ToText, checkName, normalizePath } from './util.js';

const TEMPLATES_URL = 'https://raw.githubusercontent.com/Endrx2008/sk_notes/main/community/templates/';
const TEMPLATES_LOCAL = 'community/templates/';
const THEMES_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-css-themes.json';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,60}$/i;
const FILE_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9 _.-]+)*\.md$/;
const MAX_TEMPLATE = 512 * 1024;
const MAX_THEME = 8 * 1024 * 1024;
const MAX_AGE = 24 * 3600 * 1000;

/** Text of an address; null for 404. Throws download-failed otherwise. */
async function fetchText(url, { timeout = 30, maxBytes = MAX_THEME } = {}) {
  let r;
  try {
    r = await native.async('net.request', { url, method: 'GET', headers: { 'User-Agent': 'sk_notes' }, timeout, maxBytes });
  } catch (e) {
    throw new ApiError(e.code === 'too-large' ? 'too-large' : 'download-failed', e.detail || e.code || String(e));
  }
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw new ApiError('download-failed', `HTTP ${r.status}`);
  return b64ToText(r.b64 || '');
}

async function bundled(name) {
  const r = await fetch(TEMPLATES_LOCAL + name);
  if (!r.ok) throw new ApiError('not-found', name);
  return r.text();
}

function cleanTemplates(data) {
  const out = [];
  for (const x of Array.isArray(data?.templates) ? data.templates : []) {
    if (!x || !ID_RE.test(String(x.id || '')) || !FILE_RE.test(String(x.file || '')) || String(x.file).split('/').includes('..')) continue;
    const name = String(x.name || '').trim().slice(0, 80);
    try { checkName(name); } catch { continue; }
    out.push({ id: x.id, name, description: String(x.description || '').slice(0, 300), lang: String(x.lang || 'en').slice(0, 8), file: x.file, author: String(x.author || '').slice(0, 80) });
  }
  return out;
}

let templates = null; // {items, online}

async function templateList(refresh) {
  if (templates && !refresh) return templates;
  let items = null;
  let online = false;
  try {
    const text = await fetchText(TEMPLATES_URL + 'index.json', { timeout: 8, maxBytes: MAX_TEMPLATE });
    if (text) { items = cleanTemplates(JSON.parse(text)); online = items.length > 0; }
  } catch { items = null; }
  if (!items || !items.length) items = cleanTemplates(JSON.parse(await bundled('index.json')));
  templates = { items, online };
  return templates;
}

function cacheFile() { return roots().cache + '/community-themes.json'; }

async function themeList(refresh) {
  let cached = null;
  try { if (native.sync('fs.exists', { path: cacheFile() })) cached = JSON.parse(native.sync('fs.readText', { path: cacheFile() }).text); } catch { cached = null; }
  if (cached && Array.isArray(cached.themes) && !refresh && Date.now() - (cached.ts || 0) < MAX_AGE) return { themes: cached.themes };
  let list;
  try {
    list = JSON.parse(await fetchText(THEMES_URL));
    if (!Array.isArray(list)) throw new ApiError('download-failed', 'list');
  } catch (e) {
    if (cached && Array.isArray(cached.themes)) return { themes: cached.themes, stale: true };
    throw e instanceof ApiError ? e : new ApiError('download-failed', String(e));
  }
  const themes = [];
  const seen = new Set();
  for (const x of list) {
    if (!x || typeof x.repo !== 'string' || !REPO_RE.test(x.repo)) continue;
    const name = String(x.name || '').trim().slice(0, 80);
    try { checkName(name); } catch { continue; }
    if (name.startsWith('.') || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    themes.push({ name, author: String(x.author || '').slice(0, 80), repo: x.repo, modes: (Array.isArray(x.modes) ? x.modes : []).filter((m) => m === 'dark' || m === 'light'), legacy: !!x.legacy });
  }
  themes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  try { native.sync('fs.writeText', { path: cacheFile(), text: JSON.stringify({ ts: Date.now(), themes }) }); } catch { /* no cache this time */ }
  return { themes };
}

export function registerGallery() {
  const r = route;
  const appOnly = (ctx) => { if (ctx.plugin) throw new ApiError('permission-denied'); };

  // ------------------------------------------------------------- templates
  r('templates.catalog', async (p, ctx) => {
    appOnly(ctx);
    const t = await templateList(!!p.refresh);
    return { templates: t.items, online: t.online };
  });

  /** Put one template into the templates folder of the vault. An existing note is kept. */
  r('templates.install', async (p, ctx) => {
    appOnly(ctx);
    const t = await templateList(false);
    const item = t.items.find((x) => x.id === p.id);
    if (!item) throw new ApiError('not-found', String(p.id));
    let text = null;
    if (t.online) { try { text = await fetchText(TEMPLATES_URL + item.file.split('/').map(encodeURIComponent).join('/'), { timeout: 15, maxBytes: MAX_TEMPLATE }); } catch { text = null; } }
    if (text === null) text = await bundled(item.file);
    const folder = normalizePath(String(p.folder || 'Templates'));
    if (folder === '/' || folder.split('/').some((x) => x === '..' || x.startsWith('.'))) throw new ApiError('bad-path', folder);
    const s = svc();
    if (!s.vault.exists(folder)) s.mkdir(folder);
    const path = `${folder}/${item.name}.md`;
    if (s.vault.exists(path)) return { path, existed: true };
    s.write(path, text, { reason: 'template' });
    return { path, existed: false };
  });

  // ------------------------------------------------------------- themes
  r('themes.catalog', async (p, ctx) => {
    appOnly(ctx);
    return themeList(!!p.refresh);
  });

  /** Download the stylesheet of a theme into .sk_notes/themes/<name>/theme.css. */
  r('themes.install', async (p, ctx) => {
    appOnly(ctx);
    const { themes } = await themeList(false);
    const theme = themes.find((x) => x.name === p.name);
    if (!theme) throw new ApiError('not-found', String(p.name));
    const base = `https://raw.githubusercontent.com/${theme.repo}/HEAD/`;
    let css = await fetchText(base + 'theme.css');
    if (css === null) css = await fetchText(base + 'obsidian.css'); // themes of the first generation
    if (css === null) throw new ApiError('download-failed', 'theme.css');
    const dir = `${svc().vault.configDir}/themes/${theme.name}`;
    native.sync('fs.mkdirs', { path: dir });
    native.sync('fs.writeText', { path: dir + '/theme.css', text: css });
    native.sync('fs.writeText', { path: dir + '/manifest.json', text: JSON.stringify({ name: theme.name, author: theme.author, repo: theme.repo }, null, 2) });
    return { name: theme.name };
  });

  r('themes.remove', (p, ctx) => {
    appOnly(ctx);
    const name = String(p.name || '');
    try { checkName(name); } catch { throw new ApiError('bad-name', name); }
    if (name.startsWith('.')) throw new ApiError('bad-name', name);
    const dir = `${svc().vault.configDir}/themes/${name}`;
    if (!native.sync('fs.exists', { path: dir + '/theme.css' })) return false;
    native.sync('fs.delete', { path: dir, recursive: true });
    return true;
  });
}
