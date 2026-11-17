// sk_notes for Android – sync of the open vault with GitHub, GitLab or another Git server.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The user gives a site, a name and a password or access token; the app does the rest by
// itself (see git-sync.js for what one round does). Kept apart, per vault:
//   - what is not secret (site, name, address of the repository, options) in sync.json of
//     the app's private folder for the vault: it does not travel with the vault;
//   - the password or token in the native secret store (encrypted with a key of the
//     Android Keystore), never in a file of the vault nor in the settings;
//   - the Git data in the app's private storage, not inside the vault.
// Community plugins cannot call any of these routes.

import { basicAuth, createGitFs, createGitHttp } from './git-adapters.js';
import { GitSync, SyncError, classify } from './git-sync.js';
import { native } from './native.js';
import { route } from './router.js';
import { emit, state, svc, vaultDataDir } from './state.js';
import { ApiError, TEXT_EXT, b64ToText, extOf, sha1, textToB64 } from './util.js';

const PROVIDERS = new Set(['github', 'gitlab', 'other']);
const INTERVALS = new Set([0, 5, 10, 15, 30, 60]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local|\[::1\])$/i;
const strict = new TextDecoder('utf-8', { fatal: true });

let gitModule = null;
let running = null; // the round in progress
let secretCache = null; // {name, value}

/** The Git library is large: loaded the first time a sync needs it. */
async function loadGit() {
  gitModule ||= await import('isomorphic-git'); // its Buffer is given by the build (shims/buffer.js)
  return gitModule;
}

// ---------------------------------------------------------------- what is kept
const dataDir = () => vaultDataDir(svc().vault.root);
const configPath = () => dataDir() + '/sync.json';
const gitDir = () => dataDir() + '/git';
const secretName = () => 'sync-' + sha1(svc().vault.root).slice(0, 20);

function readConfig() {
  try {
    const data = JSON.parse(native.sync('fs.readText', { path: configPath() }).text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function writeConfig(cfg) {
  native.sync('fs.mkdirs', { path: dataDir() });
  native.sync('fs.writeText', { path: configPath(), text: JSON.stringify(cfg, null, 2) });
}

function readSecret() {
  const name = secretName();
  if (secretCache && secretCache.name === name) return secretCache.value;
  const value = native.sync('secret.get', { name });
  secretCache = { name, value: typeof value === 'string' ? value : '' };
  return secretCache.value;
}

function status() {
  // an encrypted vault is not sent to a site: its notes would be readable there
  if (state.crypt) return { linked: false, offered: true, busy: false, encrypted: true, auto: false, interval: 0, lastSync: 0, lastError: null };
  const cfg = readConfig();
  const linked = !!cfg.url;
  return {
    linked, offered: !!cfg.offered, busy: !!running,
    provider: cfg.provider || '', host: cfg.host || '', user: cfg.user || '', url: cfg.url || '', branch: cfg.branch || '',
    repo: linked ? repoLabel(cfg.url) : '',
    auto: cfg.auto !== false, interval: INTERVALS.has(cfg.interval) ? cfg.interval : 10,
    lastSync: cfg.lastSync || 0, lastError: cfg.lastError || null,
  };
}

// ---------------------------------------------------------------- addresses
function repoLabel(url) {
  try {
    const u = new URL(url);
    return (u.host === 'github.com' || u.host === 'gitlab.com' ? '' : u.host + '/') + u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  } catch { return url; }
}

function siteHost(provider, host) {
  if (provider === 'github') return 'github.com';
  const h = String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (provider === 'gitlab' && !h) return 'gitlab.com';
  if (!HOST_RE.test(h)) throw new ApiError('sync-bad-url', h);
  return h;
}

/** What the user typed for the repository → its HTTPS address. Accepts "name/notes", a
 * web address, or the SSH form "git@site:name/notes.git". */
export function repoUrl(provider, host, input) {
  let s = String(input || '').trim();
  if (!s) throw new ApiError('sync-bad-url');
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(s);
  if (ssh) s = `https://${ssh[1]}/${ssh[2]}`;
  if (!/^https?:\/\//i.test(s)) {
    if (provider === 'other') throw new ApiError('sync-bad-url', s);
    s = `https://${siteHost(provider, host)}/${s.replace(/^\/+/, '')}`;
  }
  let u;
  try { u = new URL(s); } catch { throw new ApiError('sync-bad-url', s); }
  u.username = '';
  u.password = '';
  u.hash = '';
  u.search = '';
  // a password must not travel in the clear, except to a server of the home network
  if (u.protocol !== 'https:' && !LOCAL_HOST.test(u.hostname)) throw new ApiError('sync-not-https');
  let path = u.pathname.replace(/\/+$/, '');
  if (path.split('/').filter(Boolean).length < (provider === 'other' ? 1 : 2)) throw new ApiError('sync-bad-url', s);
  if (provider !== 'other' && !path.endsWith('.git')) path += '.git';
  return `${u.protocol}//${u.host}${path}`;
}

function authorOf(provider, user, url) {
  let host = 'localhost';
  try { host = new URL(url).hostname; } catch { /* keep */ }
  const name = user || 'sk_notes';
  const mail = String(name).replace(/[^A-Za-z0-9._-]+/g, '-');
  if (provider === 'github') return { name, email: `${mail}@users.noreply.github.com` };
  return { name, email: provider === 'gitlab' ? `${mail}@users.noreply.${host}` : `${mail}@${host}` };
}

// ---------------------------------------------------------------- the sites' own APIs (lists, new repository)
async function api(provider, host, token, method, path, body = null) {
  const github = provider === 'github';
  const url = (github ? 'https://api.github.com' : `https://${siteHost(provider, host)}/api/v4`) + path;
  const headers = github
    ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sk_notes' }
    : { 'PRIVATE-TOKEN': token, 'User-Agent': 'sk_notes' };
  if (body) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await native.async('net.request', { url, method, headers, body: body ? textToB64(JSON.stringify(body)) : '', timeout: 30, maxBytes: 8 * 1024 * 1024 });
  } catch (e) { throw new ApiError('network-error', e.detail || e.code || ''); }
  let data = null;
  try { data = JSON.parse(b64ToText(r.b64 || '')); } catch { data = null; }
  return { status: r.status, data };
}

function needOk(r) {
  if (r.status === 401 || r.status === 403) throw new ApiError('sync-auth', String(r.status));
  if (r.status < 200 || r.status >= 300) throw new ApiError('sync-http', `${r.status} ${String(r.data?.message?.name || r.data?.message || '').slice(0, 200)}`);
  return r.data;
}

/** {user, canList, repos: [{name, url, private, branch}]} for a name and token. */
async function check(p) {
  const provider = String(p.provider || '');
  const token = String(p.token || '');
  let user = String(p.user || '').trim();
  if (!PROVIDERS.has(provider)) throw new ApiError('sync-bad-url');
  if (!token) throw new ApiError('sync-auth');
  if (provider === 'other') return { user, canList: false, repos: [] };
  const me = await api(provider, p.host, token, 'GET', '/user');
  if (provider === 'gitlab' && me.status === 401) return { user, canList: false, repos: [] }; // an account password: Git accepts it, the lists do not
  const who = needOk(me);
  user = user || String((provider === 'github' ? who?.login : who?.username) || '');
  const list = needOk(await api(provider, p.host, token, 'GET', provider === 'github'
    ? '/user/repos?per_page=100&sort=pushed'
    : '/projects?membership=true&min_access_level=30&simple=true&order_by=last_activity_at&per_page=100'));
  const repos = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (provider === 'github') {
      if (r?.permissions && r.permissions.push === false) continue;
      if (r?.full_name && r?.clone_url) repos.push({ name: String(r.full_name), url: String(r.clone_url), private: !!r.private, branch: String(r.default_branch || '') });
    } else if (r?.path_with_namespace && r?.http_url_to_repo) {
      repos.push({ name: String(r.path_with_namespace), url: String(r.http_url_to_repo), private: r.visibility !== 'public', branch: String(r.default_branch || '') });
    }
  }
  return { user, canList: true, repos };
}

async function createRepo(p) {
  const provider = String(p.provider || '');
  const name = String(p.name || '').trim();
  if (provider !== 'github' && provider !== 'gitlab') throw new ApiError('unsupported');
  if (!NAME_RE.test(name)) throw new ApiError('invalid-name');
  const r = await api(provider, p.host, String(p.token || ''), 'POST', provider === 'github' ? '/user/repos' : '/projects',
    provider === 'github' ? { name, private: true, description: 'Notes (sk_notes)' } : { name, path: name, visibility: 'private', description: 'Notes (sk_notes)' });
  if (r.status === 422 || r.status === 400) throw new ApiError('already-exists', name);
  const data = needOk(r);
  const url = provider === 'github' ? data?.clone_url : data?.http_url_to_repo;
  if (!url) throw new ApiError('sync-http', 'no address in the reply');
  return { name: String((provider === 'github' ? data.full_name : data.path_with_namespace) || name), url: String(url) };
}

// ---------------------------------------------------------------- sync
async function engine(cfg, token) {
  const service = svc();
  const git = await loadGit();
  const header = { Authorization: basicAuth(cfg.user || 'git', token) };
  return new GitSync({
    git, fs: createGitFs(), dir: service.vault.root, gitdir: gitDir(), url: cfg.url, branch: cfg.branch || 'main',
    author: authorOf(cfg.provider, cfg.user, cfg.url),
    http: createGitHttp({ tmpDir: dataDir() + '/sync-tmp', auth: () => ({ base: cfg.url, header }) }),
    // what a sync replaces stays in the version history of the note
    beforeOverwrite: (path, bytes) => {
      if (!TEXT_EXT.has(extOf(path))) return;
      try { service.history.snapshot(path, strict.decode(bytes), { reason: 'external', force: true }); } catch { /* not text */ }
    },
  });
}

/** One round, alone: a second request while one runs gets the same result. */
function run() {
  if (running) return running;
  const cfg = readConfig();
  if (!cfg.url) throw new ApiError('sync-not-linked');
  const service = svc();
  running = (async () => {
    emit('sync', { state: 'running' });
    try {
      try { native.sync('fs.delete', { path: dataDir() + '/sync-tmp', recursive: true }); } catch { /* none */ }
      const s = await engine(cfg, readSecret());
      if (!(await s.isInitialised())) await s.init();
      const result = await s.sync();
      if (result.pulled) await service.rescan();
      const now = { ...readConfig(), lastSync: Date.now(), lastError: null };
      writeConfig(now);
      emit('sync', { state: 'idle', result, lastSync: now.lastSync });
      return result;
    } catch (e) {
      const err = classify(e);
      try { await service.rescan(); } catch { /* the files are shown at the next look */ }
      const error = { code: err.code, detail: String(err.detail || '').slice(0, 300) };
      try { writeConfig({ ...readConfig(), lastError: error }); } catch { /* shown anyway */ }
      emit('sync', { state: err.code === 'network-error' ? 'offline' : 'error', error });
      throw new ApiError(err.code, error.detail);
    } finally { running = null; }
  })();
  return running;
}

async function link(p) {
  const provider = String(p.provider || '');
  if (!PROVIDERS.has(provider)) throw new ApiError('sync-bad-url');
  if (running) throw new ApiError('sync-busy');
  const token = String(p.token || '');
  const user = String(p.user || '').trim();
  if (!token) throw new ApiError('sync-auth');
  const url = repoUrl(provider, p.host, p.url);
  const cfg = { ...readConfig(), provider, host: provider === 'github' ? '' : String(p.host || '').trim(), user, url, branch: 'main', auto: true, interval: 10, offered: true, lastSync: 0, lastError: null };
  // the address and the sign-in are tried before anything is kept
  const s = await engine(cfg, token);
  let info;
  try { info = await s.remoteInfo(); } catch (e) { const err = classify(e); throw new ApiError(err.code, err.detail); }
  cfg.branch = info.defaultBranch || 'main';
  s.branch = cfg.branch;
  native.sync('secret.set', { name: secretName(), value: token });
  secretCache = { name: secretName(), value: token };
  writeConfig(cfg);
  await s.init(); // a repository of its own for this vault (the notes are not touched)
  return run();
}

function unlink() {
  if (running) throw new ApiError('sync-busy');
  try { native.sync('secret.delete', { name: secretName() }); } catch { /* none kept */ }
  secretCache = null;
  try { native.sync('fs.delete', { path: gitDir(), recursive: true }); } catch { /* none */ }
  writeConfig({ offered: true });
  emit('sync', { state: 'unlinked' });
  return true;
}

export function registerSync() {
  const r = (name, fn) => route(name, (p, ctx) => {
    if (ctx.plugin) throw new ApiError('permission-denied');
    if (state.crypt && name !== 'sync.status') throw new ApiError('sync-encrypted');
    return fn(p);
  });
  r('sync.status', () => status());
  r('sync.check', (p) => check(p));
  r('sync.createRepo', (p) => createRepo(p));
  r('sync.link', (p) => link(p));
  r('sync.run', () => run());
  r('sync.unlink', () => unlink());
  r('sync.options', (p) => {
    const cfg = readConfig();
    if (typeof p.auto === 'boolean') cfg.auto = p.auto;
    if (INTERVALS.has(p.interval)) cfg.interval = p.interval;
    if (p.offered === true) cfg.offered = true;
    writeConfig(cfg);
    return status();
  });
}

export { SyncError };
