// Encrypted vaults: one file, opened with a password.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setNative } from '../src/backend/native.js';
import * as crypt from '../src/backend/vault-crypt.js';
import { createNative } from './mock-native.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(join(os.tmpdir(), 'skn-crypt-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
setNative(createNative());
let n = 0;
const where = (blob) => crypt.places(join(tmp, 'private'), blob, () => `id${++n}`);
const put = (dir, rel, data) => { fs.mkdirSync(join(dir, rel, '..'), { recursive: true }); fs.writeFileSync(join(dir, rel), data); };
const tree = (dir) => {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { out[r + '/'] = 1; walk(join(d, e.name), r); } else out[r] = fs.readFileSync(join(d, e.name)).toString('base64'); } };
  walk(dir, '');
  return out;
};
const size = (p) => fs.statSync(p).size;

test('a vault goes into one encrypted file and comes back whole', async () => {
  const blob = join(tmp, 'Diario.skvault');
  const { vault: a, recovery } = await crypt.createVault(blob, 'correct horse', where(blob));
  assert.match(recovery, /^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);
  assert.ok(a.where.work.endsWith('/vault/Diario'));
  put(a.where.work, 'Nota.md', '# Nota\n\nsegreto: tiramisù 🍰\n');
  put(a.where.work, 'Cartella/Altra nota.md', 'x'.repeat(10));
  put(a.where.work, '.sk_notes/app.json', '{"a":1}');
  fs.mkdirSync(join(a.where.work, 'Vuota'));
  const big = Buffer.alloc(2.5 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 9)) & 255;
  put(a.where.work, 'Allegati/foto.bin', big); // more than one piece
  put(a.where.data, 'history/abc/1.json', '{"v":1}');
  put(a.where.data, 'cache/index.json', 'not kept');
  put(a.where.work, '.trash/gone.md', 'stays out');
  assert.equal(await a.changed(), true);
  await a.seal();
  assert.equal(await a.changed(), false);
  const file = fs.readFileSync(blob);
  for (const secret of ['tiramis', 'Nota.md', 'Altra nota', 'Cartella', 'Allegati']) assert.equal(file.includes(Buffer.from(secret)), false, `"${secret}" is not readable in the file`);
  assert.ok(!fs.existsSync(blob + '.tmp') && !fs.existsSync(blob + '.old'));

  const b = await crypt.unlockVault(blob, 'correct horse', where(blob));
  const want = tree(a.where.work);
  delete want['.trash/']; delete want['.trash/gone.md'];
  assert.deepEqual(tree(b.where.work), want);
  assert.equal(fs.readFileSync(join(b.where.data, 'history/abc/1.json'), 'utf8'), '{"v":1}');
  assert.ok(!fs.existsSync(join(b.where.data, 'cache')), 'caches are not part of the file');
  assert.equal(await b.changed(), false);
  await assert.rejects(crypt.unlockVault(blob, 'correct hors', where(blob)), { code: 'wrong-password' });
  await assert.rejects(crypt.createVault(blob, 'another one', where(blob)), { code: 'already-exists' });
  await assert.rejects(crypt.createVault(join(tmp, 'x.skvault'), 'short', where(blob)), { code: 'password-short' });
});

test('a save adds only what changed; old versions are compacted away', async () => {
  const blob = join(tmp, 'Piccoli.skvault');
  const { vault: a } = await crypt.createVault(blob, 'password-1', where(blob));
  const photo = Buffer.alloc(1.5 * 1024 * 1024, 9);
  put(a.where.work, 'foto.bin', photo);
  for (let i = 0; i < 20; i++) put(a.where.work, `Note/N${i}.md`, `nota ${i}\n`);
  await a.seal();
  const base = size(blob);
  // a small edit: the file grows by about the size of that note, not by the whole vault
  put(a.where.work, 'Note/N3.md', 'nota 3, cambiata\n');
  const saves = a.segments;
  await a.seal();
  assert.ok(size(blob) - base < 400, `grew by ${size(blob) - base} bytes`);
  assert.equal(a.segments, saves + 1);
  // removals, a renamed folder, a file that became a folder
  fs.rmSync(join(a.where.work, 'Note/N5.md'));
  fs.renameSync(join(a.where.work, 'Note'), join(a.where.work, 'Appunti'));
  fs.rmSync(join(a.where.work, 'foto.bin'));
  fs.mkdirSync(join(a.where.work, 'foto.bin'));
  put(a.where.work, 'foto.bin/dentro.md', 'dentro');
  await a.seal();
  const b = await crypt.unlockVault(blob, 'password-1', where(blob));
  assert.deepEqual(tree(b.where.work), tree(a.where.work));
  assert.ok(!fs.existsSync(join(b.where.work, 'Note')));
  // the photo left the vault but was still in the file: as soon as old versions take more
  // room than the vault itself, the save writes the file whole and small again
  assert.equal(a.segments, 1, 'compacted');
  assert.ok(size(blob) < 64 * 1024, `${size(blob)} bytes`);
  const c = await crypt.unlockVault(blob, 'password-1', where(blob));
  assert.deepEqual(tree(c.where.work), tree(a.where.work));
  put(a.where.work, 'x.md', 'x');
  await a.seal();
  assert.equal(a.segments, 2, 'and the next small save is added again');
});

test('damage is refused; a save cut short loses only that save', async () => {
  const blob = join(tmp, 'Rotto.skvault');
  const { vault: a } = await crypt.createVault(blob, 'password-1', where(blob));
  put(a.where.work, 'big.bin', Buffer.alloc(2.2 * 1024 * 1024, 7));
  put(a.where.work, 'N.md', 'n');
  await a.seal();
  const good = fs.readFileSync(blob);
  const { bodyAt } = await crypt.readHeader(blob);
  const flip = Buffer.from(good); flip[bodyAt + 200] ^= 1;
  fs.writeFileSync(blob, flip);
  await assert.rejects(crypt.unlockVault(blob, 'password-1', where(blob)), { code: 'crypt-damaged' });
  // pieces swapped inside the segment that holds the big file
  const s = good.indexOf(Buffer.from('SEG2'), bodyAt + 4);
  const p0 = good.readUInt32BE(s + 12);
  const p1 = good.readUInt32BE(s + 16 + p0);
  const A = good.subarray(s + 12, s + 16 + p0); const B = good.subarray(s + 16 + p0, s + 20 + p0 + p1);
  fs.writeFileSync(blob, Buffer.concat([good.subarray(0, s + 12), B, A, good.subarray(s + 20 + p0 + p1)]));
  await assert.rejects(crypt.unlockVault(blob, 'password-1', where(blob)), { code: 'crypt-damaged' });
  fs.writeFileSync(blob, 'not a vault at all');
  await assert.rejects(crypt.unlockVault(blob, 'password-1', where(blob)), { code: 'crypt-damaged' });
  fs.writeFileSync(blob, good);
  // two more saves, the last one cut short
  const b = await crypt.unlockVault(blob, 'password-1', where(blob));
  put(b.where.work, 'Seconda.md', 'second save');
  await b.seal();
  const two = size(blob);
  put(b.where.work, 'Terza.md', 'third save, cut short');
  await b.seal();
  fs.truncateSync(blob, two + 20);
  const c = await crypt.unlockVault(blob, 'password-1', crypt.places(join(tmp, 'cut'), blob, () => 'c'));
  assert.equal(c.torn, true);
  assert.equal(fs.readFileSync(join(c.where.work, 'Seconda.md'), 'utf8'), 'second save');
  assert.ok(!fs.existsSync(join(c.where.work, 'Terza.md')));
  // and the file was written whole again, without the broken end
  const d = await crypt.unlockVault(blob, 'password-1', where(blob));
  assert.equal(d.torn, false);
  // a segment dropped from the middle does not go unnoticed
  put(d.where.work, 'Quarta.md', '4'); await d.seal();
  const s1 = size(blob);
  put(d.where.work, 'Quinta.md', '5'); await d.seal();
  const all = fs.readFileSync(blob);
  const { bodyAt: at } = await crypt.readHeader(blob);
  const firstEnd = all.indexOf(Buffer.from('SEG2'), at + 4);
  fs.writeFileSync(blob, Buffer.concat([all.subarray(0, firstEnd), all.subarray(s1)]));
  await assert.rejects(crypt.unlockVault(blob, 'password-1', where(blob)), { code: 'crypt-damaged' });
});

test('password: change with the old one, or replace a forgotten one with the recovery code', async () => {
  const blob = join(tmp, 'Cambio.skvault');
  const { vault: a, recovery } = await crypt.createVault(blob, 'old password', where(blob));
  put(a.where.work, 'N.md', 'before');
  await a.seal();
  await assert.rejects(crypt.changePassword(blob, 'not the old one', 'new password', a), { code: 'wrong-password' });
  await assert.rejects(crypt.changePassword(blob, 'old password', 'short', a), { code: 'password-short' });
  put(a.where.work, 'N.md', 'changed, not saved yet');
  await crypt.changePassword(blob, 'old password', 'new password', a);
  await assert.rejects(crypt.unlockVault(blob, 'old password', where(blob)), { code: 'wrong-password' });
  assert.equal(fs.readFileSync(join((await crypt.unlockVault(blob, 'new password', where(blob))).where.work, 'N.md'), 'utf8'), 'changed, not saved yet');
  // the open vault keeps adding saves after the header changed
  put(a.where.work, 'Later.md', 'later');
  await a.seal();
  assert.ok(fs.existsSync(join((await crypt.unlockVault(blob, 'new password', where(blob))).where.work, 'Later.md')));
  // forgotten: the code (typed loosely: small letters, spaces, O for 0) sets a new one
  await assert.rejects(crypt.recoverPassword(blob, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', 'third password'), { code: 'wrong-code' });
  await crypt.recoverPassword(blob, ' ' + recovery.toLowerCase().replace(/-/g, ' ') + ' ', 'third password');
  await crypt.unlockVault(blob, 'third password', where(blob));
  // a new code: the old one stops working
  await assert.rejects(crypt.newRecoveryCode(blob, 'wrong one!'), { code: 'wrong-password' });
  const code2 = await crypt.newRecoveryCode(blob, 'third password');
  await assert.rejects(crypt.recoverPassword(blob, recovery, 'fourth password'), { code: 'wrong-code' });
  await crypt.recoverPassword(blob, code2, 'fourth password');
  await crypt.verifyPassword(blob, 'fourth password');
  await assert.rejects(crypt.verifyPassword(blob, 'third password'), { code: 'wrong-password' });
});

test('an existing vault encrypted, and an encrypted one turned back into a folder', async () => {
  const folder = join(tmp, 'Normale');
  put(folder, 'Uno.md', '# Uno\n[[Due]]\n');
  put(folder, 'Sub/Due.md', '# Due\n');
  put(folder, '.sk_notes/app.json', '{"x":1}');
  put(folder, '.git/HEAD', 'ref: refs/heads/main');
  put(folder, '.trash/old.md', 'old');
  const hist = join(tmp, 'hist-normale');
  put(hist, 'k/1.json', '{"h":1}');
  const blob = join(tmp, 'Normale.skvault');
  const { vault: v, recovery } = await crypt.encryptFolder(folder, hist, blob, 'cifra-adesso', where(blob));
  assert.ok(recovery);
  assert.equal(fs.readFileSync(join(v.where.work, 'Sub/Due.md'), 'utf8'), '# Due\n');
  assert.ok(!fs.existsSync(join(v.where.work, '.git')) && !fs.existsSync(join(v.where.work, '.trash')));
  assert.equal(fs.readFileSync(join(v.where.data, 'history/k/1.json'), 'utf8'), '{"h":1}');
  assert.equal(fs.readFileSync(blob).includes(Buffer.from('Uno')), false);
  await assert.rejects(crypt.encryptFolder(folder, hist, blob, 'cifra-adesso', where(blob)), { code: 'already-exists' });
  // back to a folder
  put(v.where.work, 'Nuova.md', 'scritta da cifrato');
  const back = join(tmp, 'Di nuovo normale');
  await crypt.decryptTo(v, back, join(tmp, 'hist-back'));
  assert.equal(fs.readFileSync(join(back, 'Nuova.md'), 'utf8'), 'scritta da cifrato');
  assert.equal(fs.readFileSync(join(back, 'Uno.md'), 'utf8'), '# Uno\n[[Due]]\n');
  assert.equal(fs.readFileSync(join(tmp, 'hist-back/k/1.json'), 'utf8'), '{"h":1}');
  put(join(tmp, 'occupata'), 'x.md', 'x');
  await assert.rejects(crypt.decryptTo(v, join(tmp, 'occupata'), join(tmp, 'h2')), { code: 'already-exists' });
});

test('changes of a session that never saved are kept; a file replaced elsewhere is not overwritten', async () => {
  const blob = join(tmp, 'Sessione.skvault');
  const fixed = crypt.places(join(tmp, 'p2'), blob, () => 'same');
  const { vault: a } = await crypt.createVault(blob, 'password-1', fixed);
  put(a.where.work, 'N.md', 'saved');
  await a.seal();
  put(a.where.work, 'N.md', 'typed, then the app was killed');
  await crypt.tidy(join(tmp, 'p2'));
  assert.ok(fs.existsSync(join(fixed.work, 'N.md')), 'unsaved changes are not thrown away');
  const saves = a.segments;
  const b = await crypt.unlockVault(blob, 'password-1', fixed);
  assert.equal(fs.readFileSync(join(b.where.work, 'N.md'), 'utf8'), 'typed, then the app was killed');
  assert.equal(b.segments, saves + 1, 'added as one more save');
  const other = crypt.places(join(tmp, 'p3'), blob, () => 'other');
  const c = await crypt.unlockVault(blob, 'password-1', other);
  assert.equal(fs.readFileSync(join(c.where.work, 'N.md'), 'utf8'), 'typed, then the app was killed', 'and they reached the file');
  await crypt.tidy(join(tmp, 'p2'));
  assert.ok(!fs.existsSync(fixed.dir), 'nothing readable is left once everything is in the file');
  // two devices: "c" saves; then "d" (opened before, on the other copy) writes unsaved changes
  // and the file it knew was replaced: its changes come back as conflict copies
  const devD = crypt.places(join(tmp, 'p4'), blob, () => 'd');
  const d = await crypt.unlockVault(blob, 'password-1', devD);
  put(c.where.work, 'N.md', 'from device c'); put(c.where.work, 'C.md', 'c only');
  await c.seal(true);
  put(d.where.work, 'N.md', 'from device d, not saved'); put(d.where.work, 'D.md', 'd only');
  const e = await crypt.unlockVault(blob, 'password-1', devD);
  assert.equal(fs.readFileSync(join(e.where.work, 'N.md'), 'utf8'), 'from device c');
  assert.equal(fs.readFileSync(join(e.where.work, 'C.md'), 'utf8'), 'c only');
  assert.equal(fs.readFileSync(join(e.where.work, 'D.md'), 'utf8'), 'd only');
  assert.equal(e.conflicts.length, 1);
  assert.match(e.conflicts[0], /^N \(conflict .*\)\.md$/);
  assert.equal(fs.readFileSync(join(e.where.work, e.conflicts[0]), 'utf8'), 'from device d, not saved');
  // an open vault whose file was replaced: the other copy is kept beside before writing
  put(c.where.work, 'Z.md', 'z');
  const foreign = Buffer.from(fs.readFileSync(blob));
  await e.seal();
  fs.writeFileSync(blob, Buffer.concat([foreign, Buffer.from('changed elsewhere')]));
  put(e.where.work, 'Y.md', 'y');
  await e.seal();
  assert.ok(e.foreign && fs.existsSync(e.foreign), 'the other copy is kept');
  assert.match(e.foreign, /Sessione \(other version .*\)\.skvault$/);
  // a full save interrupted while the files were swapped
  fs.renameSync(blob, blob + '.old');
  fs.writeFileSync(blob + '.tmp', 'half written');
  await crypt.unlockVault(blob, 'password-1', fixed);
  assert.ok(fs.existsSync(blob) && !fs.existsSync(blob + '.tmp'));
});

test('a vault in the first format opens and is written in the new form', async () => {
  const blob = join(tmp, 'Vecchio.skvault');
  fs.copyFileSync(join(here, 'fixtures/v1.skvault'), blob);
  assert.equal((await crypt.readHeader(blob)).header.v, 1);
  const v = await crypt.unlockVault(blob, 'versione-uno', where(blob));
  assert.equal(fs.readFileSync(join(v.where.work, 'Nota.md'), 'utf8'), '# Nota\n\nfatta con la 1.2.0\n');
  assert.equal(fs.readFileSync(join(v.where.work, 'Cartella/Altra.md'), 'utf8'), 'altra');
  assert.equal(fs.readFileSync(join(v.where.data, 'history/k/1.json'), 'utf8'), '{"h":1}');
  assert.equal((await crypt.readHeader(blob)).header.v, 2, 'written again in the new form at once');
  put(v.where.work, 'Dopo.md', 'dopo');
  await v.seal();
  const w = await crypt.unlockVault(blob, 'versione-uno', where(blob));
  assert.ok(fs.existsSync(join(w.where.work, 'Dopo.md')));
  // no recovery code in a file of that version: one can be made with the password
  assert.equal(await crypt.hasRecovery(blob), false);
  await assert.rejects(crypt.recoverPassword(blob, 'AAAA', 'whatever-new'), { code: 'no-recovery' });
  const code = await crypt.newRecoveryCode(blob, 'versione-uno', w);
  await crypt.recoverPassword(blob, code, 'nuova-versione');
  await crypt.unlockVault(blob, 'nuova-versione', where(blob));
});
