// The set-up side of the Git sync: addresses typed by the user and the sites' lists.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setNative } from '../src/backend/native.js';
import { handle } from '../src/backend/router.js';
import { registerSync, repoUrl } from '../src/backend/routes-sync.js';
import { createNative } from './mock-native.mjs';

const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64');
registerSync();

test('repository addresses', () => {
  assert.equal(repoUrl('github', '', 'anna/notes'), 'https://github.com/anna/notes.git');
  assert.equal(repoUrl('github', '', 'https://github.com/anna/notes'), 'https://github.com/anna/notes.git');
  assert.equal(repoUrl('github', '', 'git@github.com:anna/notes.git'), 'https://github.com/anna/notes.git');
  assert.equal(repoUrl('github', '', 'https://anna:pw@github.com/anna/notes.git?x=1#y'), 'https://github.com/anna/notes.git');
  assert.equal(repoUrl('gitlab', '', 'group/sub/notes'), 'https://gitlab.com/group/sub/notes.git');
  assert.equal(repoUrl('gitlab', 'git.example.org', 'anna/notes/'), 'https://git.example.org/anna/notes.git');
  assert.equal(repoUrl('other', '', 'https://gitea.example.org/anna/notes'), 'https://gitea.example.org/anna/notes');
  assert.equal(repoUrl('other', '', 'http://192.168.1.20:3000/anna/notes.git'), 'http://192.168.1.20:3000/anna/notes.git');
  assert.throws(() => repoUrl('other', '', 'http://example.org/anna/notes.git'), { code: 'sync-not-https' });
  assert.throws(() => repoUrl('other', '', 'anna/notes'), { code: 'sync-bad-url' });
  assert.throws(() => repoUrl('github', '', 'notes'), { code: 'sync-bad-url' });
  assert.throws(() => repoUrl('github', '', ''), { code: 'sync-bad-url' });
});

test('lists and new repositories: GitHub and GitLab', async () => {
  const asked = [];
  setNative(createNative({ http: async (p) => {
    asked.push(p);
    const u = new URL(p.url);
    if (u.host === 'api.github.com') {
      if (p.headers.Authorization !== 'Bearer good') return { status: 401, headers: {}, b64: b64({ message: 'Bad credentials' }) };
      if (u.pathname === '/user') return { status: 200, headers: {}, b64: b64({ login: 'anna' }) };
      if (u.pathname === '/user/repos' && p.method === 'GET') return { status: 200, headers: {}, b64: b64([
        { full_name: 'anna/notes', clone_url: 'https://github.com/anna/notes.git', private: true, default_branch: 'main', permissions: { push: true } },
        { full_name: 'org/readonly', clone_url: 'https://github.com/org/readonly.git', private: false, permissions: { push: false } }]) };
      if (u.pathname === '/user/repos' && p.method === 'POST') {
        const body = JSON.parse(Buffer.from(p.body, 'base64').toString());
        if (body.name === 'taken') return { status: 422, headers: {}, b64: b64({ message: 'exists' }) };
        return { status: 201, headers: {}, b64: b64({ full_name: 'anna/' + body.name, clone_url: `https://github.com/anna/${body.name}.git`, private: body.private }) };
      }
    }
    if (u.host === 'gitlab.com' || u.host === 'git.example.org') {
      if (p.headers['PRIVATE-TOKEN'] !== 'good') return { status: 401, headers: {}, b64: b64({ message: '401 Unauthorized' }) };
      if (u.pathname === '/api/v4/user') return { status: 200, headers: {}, b64: b64({ username: 'anna' }) };
      if (u.pathname === '/api/v4/projects' && p.method === 'GET') return { status: 200, headers: {}, b64: b64([{ path_with_namespace: 'anna/notes', http_url_to_repo: `https://${u.host}/anna/notes.git`, visibility: 'private', default_branch: 'main' }]) };
      if (u.pathname === '/api/v4/projects' && p.method === 'POST') return { status: 201, headers: {}, b64: b64({ path_with_namespace: 'anna/new', http_url_to_repo: `https://${u.host}/anna/new.git` }) };
    }
    return { status: 404, headers: {}, b64: b64({}) };
  } }));
  let r = await handle('sync.check', { provider: 'github', user: '', token: 'good' });
  assert.deepEqual(r, { user: 'anna', canList: true, repos: [{ name: 'anna/notes', url: 'https://github.com/anna/notes.git', private: true, branch: 'main' }] });
  await assert.rejects(async () => handle('sync.check', { provider: 'github', token: 'bad' }), { code: 'sync-auth' });
  r = await handle('sync.createRepo', { provider: 'github', token: 'good', name: 'notes2' });
  assert.deepEqual(r, { name: 'anna/notes2', url: 'https://github.com/anna/notes2.git' });
  assert.equal(JSON.parse(Buffer.from(asked.at(-1).body, 'base64').toString()).private, true, 'a new repository is private');
  await assert.rejects(async () => handle('sync.createRepo', { provider: 'github', token: 'good', name: 'taken' }), { code: 'already-exists' });
  await assert.rejects(async () => handle('sync.createRepo', { provider: 'github', token: 'good', name: 'bad name' }), { code: 'invalid-name' });
  r = await handle('sync.check', { provider: 'gitlab', host: 'git.example.org', user: 'anna', token: 'good' });
  assert.equal(r.repos[0].url, 'https://git.example.org/anna/notes.git');
  assert.ok(asked.at(-1).url.startsWith('https://git.example.org/api/v4/projects?membership=true'));
  // an account password instead of a token: Git may accept it, the lists do not
  r = await handle('sync.check', { provider: 'gitlab', user: 'anna', token: 'account-password' });
  assert.deepEqual(r, { user: 'anna', canList: false, repos: [] });
  r = await handle('sync.createRepo', { provider: 'gitlab', token: 'good', name: 'new' });
  assert.equal(r.url, 'https://gitlab.com/anna/new.git');
  // community plugins may not use these routes
  const { issueToken } = await import('../src/backend/router.js');
  const tok = issueToken('some-plugin');
  assert.throws(() => handle('sync.status', {}, tok), { code: 'permission-denied' });
  assert.throws(() => handle('sync.run', {}, tok), { code: 'permission-denied' });
});
