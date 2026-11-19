// Git sync against a real Git server (git http-backend) and a real Git on the "PC" side.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import * as isogit from 'isomorphic-git';
import { basicAuth, createGitFs, createGitHttp, sameRepository } from '../src/backend/git-adapters.js';
import { GitSync, classify, conflictName, mergeText } from '../src/backend/git-sync.js';
import { setNative } from '../src/backend/native.js';
import { git, nodeHttp, startGitServer } from './git-server.mjs';
import { createNative } from './mock-native.mjs';

const tmp = fs.mkdtempSync(join(os.tmpdir(), 'skn-git-'));
let server;
let n = 0;

before(async () => {
  setNative(createNative({ http: nodeHttp }));
  fs.mkdirSync(join(tmp, 'srv'));
  server = await startGitServer(join(tmp, 'srv'));
});
after(async () => { await server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** A bare repository on the server, a "PC" clone of it, and a phone vault. */
function world({ seed = null } = {}) {
  const id = `w${++n}`;
  const bare = join(tmp, 'srv', `${id}.git`);
  git(tmp, 'init', '--bare', '-b', 'main', bare);
  git(bare, 'config', 'http.receivepack', 'true');
  const authed = server.url.replace('://', '://anna:secret-token@');
  const pc = join(tmp, `${id}-pc`);
  git(tmp, 'clone', '-q', `${authed}/${id}.git`, pc);
  if (seed) {
    for (const [name, text] of Object.entries(seed)) { fs.mkdirSync(join(pc, name, '..'), { recursive: true }); fs.writeFileSync(join(pc, name), text); }
    git(pc, 'add', '-A');
    git(pc, 'commit', '-q', '-m', 'seed');
    git(pc, 'push', '-q', 'origin', 'HEAD:main');
  }
  const vault = join(tmp, `${id}-phone`);
  fs.mkdirSync(vault);
  const url = `${server.url}/${id}.git`;
  const phone = (extra = {}) => new GitSync({
    git: isogit, fs: createGitFs(), dir: vault, gitdir: join(tmp, `${id}-gitdir`), url, branch: 'main', author: { name: 'anna', email: 'anna@example.org' },
    http: createGitHttp({ tmpDir: join(tmp, `${id}-tmp`), auth: () => ({ base: url, header: { Authorization: basicAuth('anna', 'secret-token') } }) }),
    ...extra,
  });
  const pcSync = (msg = 'pc') => { git(pc, 'add', '-A'); try { git(pc, 'commit', '-q', '-m', msg); } catch { /* nothing new */ } git(pc, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'); git(pc, 'push', '-q', 'origin', 'HEAD:main'); };
  const w = (rel, text) => { fs.mkdirSync(join(vault, rel, '..'), { recursive: true }); fs.writeFileSync(join(vault, rel), text); };
  const r = (rel) => fs.readFileSync(join(vault, rel), 'utf8');
  return { pc, vault, url, phone, pcSync, w, r, bare };
}

test('helpers', () => {
  assert.equal(conflictName('a/Note.md', '2026-01-02 03.04', () => false), 'a/Note (conflict 2026-01-02 03.04).md');
  assert.equal(conflictName('Note', 'S', (p) => p === 'Note (conflict S)'), 'Note (conflict S 2)');
  assert.equal(mergeText('A\nb\nc\nd\n', 'a\nb\nc\nd\n', 'a\nb\nc\nD\n'), 'A\nb\nc\nD\n');
  assert.equal(mergeText('a\nX\n', 'a\nb\n', 'a\nY\n'), null);
  assert.equal(sameRepository('https://h/u/r.git/info/refs?x', 'https://h/u/r.git'), true);
  assert.equal(sameRepository('https://h/u/r.git.evil/info/refs', 'https://h/u/r.git'), false);
  assert.equal(sameRepository('https://evil/u/r.git/info/refs', 'https://h/u/r.git'), false);
});

test('a vault with notes goes to an empty repository, and the PC gets them', async () => {
  const x = world();
  x.w('Idea.md', '# Idea\n\nLinked to [[Other]].\n');
  x.w('Folder/Other.md', '# Other\n');
  x.w('.trash/gone.md', 'no');
  x.w('.sk_notes/workspace-mobile.json', '{}');
  x.w('.sk_notes/app.json', '{"a":1}');
  const s = x.phone();
  await s.init();
  const r = await s.sync();
  assert.equal(r.pushed, true);
  git(x.pc, 'pull', '-q', 'origin', 'main');
  assert.equal(fs.readFileSync(join(x.pc, 'Idea.md'), 'utf8'), '# Idea\n\nLinked to [[Other]].\n');
  assert.ok(fs.existsSync(join(x.pc, 'Folder/Other.md')));
  assert.ok(fs.existsSync(join(x.pc, '.gitignore')));
  assert.ok(fs.existsSync(join(x.pc, '.sk_notes/app.json')));
  assert.ok(!fs.existsSync(join(x.pc, '.trash')));
  assert.ok(!fs.existsSync(join(x.pc, '.sk_notes/workspace-mobile.json')));
  assert.ok(!fs.existsSync(join(x.vault, '.git')), 'the repository data is not inside the vault');
  assert.match(git(x.pc, 'log', '-1', '--format=%an <%ae> %s'), /^anna <anna@example.org> sk_notes \(Android\): \d{4}-/);
  // nothing new: one question to the server, no commit, no push
  const before = (await server.requests()).length;
  const again = await s.sync();
  assert.deepEqual([again.committed, again.pushed, again.pulled], [false, false, 0]);
  const asked = await server.requests();
  assert.equal(asked.length - before, 1);
  assert.ok(asked.every((q) => q.agent.startsWith('git/')));
});

test('an empty vault takes the notes of the repository; later changes travel both ways', async () => {
  const x = world({ seed: { 'A.md': 'a\n', 'dir/B.md': 'b\n', 'pic.bin': 'x' } });
  fs.writeFileSync(join(x.pc, 'pic.bin'), Buffer.from([0, 1, 2, 255, 254, 10, 13]));
  x.pcSync();
  const s = x.phone();
  await s.init();
  let r = await s.sync();
  assert.equal(x.r('A.md'), 'a\n');
  assert.equal(x.r('dir/B.md'), 'b\n');
  assert.deepEqual([...fs.readFileSync(join(x.vault, 'pic.bin'))], [0, 1, 2, 255, 254, 10, 13]);
  assert.equal(r.pulled, 3);
  assert.equal(r.pushed, true, 'the .gitignore made on the phone is pushed');
  // phone edits, PC edits another note and deletes one, adds one
  x.pcSync();
  x.w('A.md', 'a phone\n');
  x.w('New on phone.md', 'n\n');
  fs.writeFileSync(join(x.pc, 'dir/B.md'), 'b pc\n');
  fs.writeFileSync(join(x.pc, 'From PC.md'), 'p\n');
  fs.rmSync(join(x.pc, 'pic.bin'));
  git(x.pc, 'add', '-A'); git(x.pc, 'commit', '-q', '-m', 'pc work'); git(x.pc, 'push', '-q', 'origin', 'HEAD:main');
  r = await s.sync();
  assert.equal(x.r('dir/B.md'), 'b pc\n');
  assert.equal(x.r('From PC.md'), 'p\n');
  assert.ok(!fs.existsSync(join(x.vault, 'pic.bin')));
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.pushed, true);
  git(x.pc, 'pull', '-q', 'origin', 'main');
  assert.equal(fs.readFileSync(join(x.pc, 'A.md'), 'utf8'), 'a phone\n');
  assert.equal(fs.readFileSync(join(x.pc, 'New on phone.md'), 'utf8'), 'n\n');
  assert.equal(git(x.pc, 'status', '--porcelain'), '');
  assert.equal(git(x.pc, 'fsck', '--no-dangling').trim(), '');
  // the phone's own view is clean too
  const rows = await isogit.statusMatrix({ fs: s.fs, dir: s.dir, gitdir: s.gitdir });
  assert.deepEqual(rows.filter(([, h, w, st]) => !(h === 1 && w === 1 && st === 1)), []);
  // delete on the phone, rename on the phone
  fs.rmSync(join(x.vault, 'From PC.md'));
  fs.renameSync(join(x.vault, 'A.md'), join(x.vault, 'A renamed.md'));
  await s.sync();
  git(x.pc, 'pull', '-q', 'origin', 'main');
  assert.ok(!fs.existsSync(join(x.pc, 'From PC.md')));
  assert.ok(!fs.existsSync(join(x.pc, 'A.md')));
  assert.equal(fs.readFileSync(join(x.pc, 'A renamed.md'), 'utf8'), 'a phone\n');
  // a folder emptied on the PC goes away on the phone
  fs.rmSync(join(x.pc, 'dir'), { recursive: true });
  x.pcSync('rm dir');
  await s.sync();
  assert.ok(!fs.existsSync(join(x.vault, 'dir')));
});

test('the same note changed on both sides', async () => {
  const x = world({ seed: { 'N.md': 'one\ntwo\nthree\nfour\nfive\n', 'C.md': 'same line\n', 'D.md': 'd\n', 'E.md': 'e\n', 'img.png': 'v1' } });
  const seen = [];
  const s = x.phone({ beforeOverwrite: (p) => seen.push(p), now: () => new Date(2026, 10, 15, 14, 5) });
  await s.init();
  await s.sync();
  x.pcSync();
  // different lines → merged; same line → both kept; delete vs change → kept; binary → both kept
  x.w('N.md', 'ONE\ntwo\nthree\nfour\nfive\n');
  x.w('C.md', 'phone line\n');
  fs.rmSync(join(x.vault, 'D.md'));
  x.w('E.md', 'e phone\n');
  x.w('img.png', 'phone');
  fs.writeFileSync(join(x.pc, 'N.md'), 'one\ntwo\nthree\nfour\nFIVE\n');
  fs.writeFileSync(join(x.pc, 'C.md'), 'pc line\n');
  fs.writeFileSync(join(x.pc, 'D.md'), 'd pc\n');
  fs.rmSync(join(x.pc, 'E.md'));
  fs.writeFileSync(join(x.pc, 'img.png'), 'pc');
  git(x.pc, 'add', '-A'); git(x.pc, 'commit', '-q', '-m', 'pc'); git(x.pc, 'push', '-q', 'origin', 'HEAD:main');
  const r = await s.sync();
  assert.equal(x.r('N.md'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
  assert.equal(x.r('C.md'), 'pc line\n');
  assert.equal(x.r('C (conflict 2026-11-15 14.05).md'), 'phone line\n');
  assert.equal(x.r('D.md'), 'd pc\n');
  assert.equal(x.r('E.md'), 'e phone\n');
  assert.equal(x.r('img.png'), 'pc');
  assert.equal(x.r('img (conflict 2026-11-15 14.05).png'), 'phone');
  assert.deepEqual(r.conflicts.map((c) => c.path).sort(), ['C.md', 'img.png']);
  assert.ok(seen.includes('C.md') && seen.includes('N.md'));
  git(x.pc, 'pull', '-q', 'origin', 'main');
  assert.equal(fs.readFileSync(join(x.pc, 'N.md'), 'utf8'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
  assert.equal(fs.readFileSync(join(x.pc, 'C (conflict 2026-11-15 14.05).md'), 'utf8'), 'phone line\n');
  assert.equal(fs.readFileSync(join(x.pc, 'E.md'), 'utf8'), 'e phone\n');
  assert.match(git(x.pc, 'log', '-1', '--format=%P').trim(), /^\w{40} \w{40}$/, 'a normal merge commit');
  assert.equal(git(x.pc, 'status', '--porcelain'), '');
});

test('both sides already have notes when they are linked', async () => {
  const x = world({ seed: { 'Same.md': 'same\n', 'Differs.md': 'pc\n', 'Only PC.md': 'p\n', '.gitignore': 'private/\n' } });
  x.w('Same.md', 'same\n');
  x.w('Differs.md', 'phone\n');
  x.w('Only phone.md', 'f\n');
  x.w('private/secret.md', 's\n');
  const s = x.phone({ now: () => new Date(2026, 0, 2, 3, 4) });
  await s.init();
  const r = await s.sync();
  assert.equal(x.r('Differs.md'), 'pc\n');
  assert.equal(x.r('Differs (conflict 2026-01-02 03.04).md'), 'phone\n');
  assert.equal(x.r('Only PC.md'), 'p\n');
  assert.equal(x.r('.gitignore'), 'private/\n', 'the .gitignore of the repository wins');
  assert.equal(r.conflicts.length, 1);
  git(x.pc, 'pull', '-q', 'origin', 'main');
  assert.equal(fs.readFileSync(join(x.pc, 'Only phone.md'), 'utf8'), 'f\n');
  assert.ok(!fs.existsSync(join(x.pc, 'private')), 'ignored files stay on the phone');
  assert.ok(fs.existsSync(join(x.vault, 'private/secret.md')));
});

test('files of one device: tracked by the repository, never written nor committed here', async () => {
  const x = world({ seed: { '.sk_notes/workspace-mobile.json': '{"pc":1}', 'A.md': 'a\n' } });
  x.w('.sk_notes/workspace-mobile.json', '{"phone":1}');
  const s = x.phone();
  await s.init();
  await s.sync();
  assert.equal(x.r('.sk_notes/workspace-mobile.json'), '{"phone":1}');
  x.w('A.md', 'a2\n');
  x.w('.sk_notes/workspace-mobile.json', '{"phone":2}');
  await s.sync();
  git(x.pc, 'pull', '-q', 'origin', 'main');
  assert.equal(fs.readFileSync(join(x.pc, '.sk_notes/workspace-mobile.json'), 'utf8'), '{"pc":1}');
  assert.equal(fs.readFileSync(join(x.pc, 'A.md'), 'utf8'), 'a2\n');
});

test('a note typed while the sync runs is not overwritten', async () => {
  const x = world({ seed: { 'A.md': 'a\n' } });
  const s = x.phone({ now: () => new Date(2026, 0, 2, 3, 4) });
  await s.init();
  await s.sync();
  fs.writeFileSync(join(x.pc, 'A.md'), 'a pc\n');
  x.pcSync();
  const apply = s._applyToVault.bind(s);
  s._applyToVault = async (...args) => { x.w('A.md', 'typed meanwhile\n'); return apply(...args); };
  const r = await s.sync();
  assert.equal(x.r('A.md'), 'a pc\n');
  assert.equal(x.r('A (conflict 2026-01-02 03.04).md'), 'typed meanwhile\n');
  assert.equal(r.conflicts.length, 1);
});

test('another device pushes between our fetch and our push', async () => {
  const x = world({ seed: { 'A.md': 'a\n' } });
  const s = x.phone();
  await s.init();
  await s.sync();
  x.pcSync();
  x.w('Phone.md', 'p\n');
  const push = isogit.push;
  let raced = false;
  const racing = { ...isogit, push: async (args) => {
    if (!raced) { raced = true; fs.writeFileSync(join(x.pc, 'Race.md'), 'r\n'); x.pcSync('race'); }
    return push(args);
  } };
  s.git = racing;
  const r = await s.sync();
  assert.equal(r.pushed, true);
  assert.equal(x.r('Race.md'), 'r\n');
  git(x.pc, 'pull', '-q', 'origin', 'main');
  assert.ok(fs.existsSync(join(x.pc, 'Phone.md')));
});

test('wrong password, wrong address, no network', async () => {
  const x = world({ seed: { 'A.md': 'a\n' } });
  const mk = (url, pass) => new GitSync({ git: isogit, fs: createGitFs(), dir: x.vault, gitdir: join(tmp, 'bad-gitdir'), url, author: { name: 'a', email: 'a@b' },
    http: createGitHttp({ tmpDir: join(tmp, 'bad-tmp'), auth: () => ({ base: url, header: { Authorization: basicAuth('anna', pass) } }) }) });
  await assert.rejects(mk(x.url, 'nope').remoteInfo().catch((e) => { throw classify(e); }), { code: 'sync-auth' });
  await assert.rejects(mk(server.url + '/missing.git', 'secret-token').remoteInfo().catch((e) => { throw classify(e); }), { code: 'sync-no-repo' });
  await assert.rejects(mk('http://127.0.0.1:9/x.git', 'x').remoteInfo().catch((e) => { throw classify(e); }), { code: 'network-error' });
  // the password is sent to the repository only
  const leaked = [];
  setNative(createNative({ http: async (p) => { leaked.push(p); return nodeHttp(p); } }));
  const s = mk(x.url, 'secret-token');
  await s.http.request({ url: server.url + '/other.git/info/refs', headers: { Authorization: 'Basic stolen' } });
  assert.equal(leaked[0].headers.Authorization, undefined);
  setNative(createNative({ http: nodeHttp }));
});
