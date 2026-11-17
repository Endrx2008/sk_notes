// Test helper: the Android implementation of encrypted vaults, driven from the Python tests
// (a vault written by one side must open on the other).
//   node js_crypt.mjs create <blob> <password> <folder-with-files>   → prints the recovery code
//   node js_crypt.mjs open   <blob> <password> <private-dir>          → prints JSON {work, files}
//   node js_crypt.mjs add    <blob> <password> <private-dir> <rel> <text>
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..', 'android', 'web');
const { setNative } = await import(join(web, 'src/backend/native.js'));
const { createNative } = await import(join(web, 'tests/mock-native.mjs'));
const crypt = await import(join(web, 'src/backend/vault-crypt.js'));
setNative(createNative());

const [cmd, blob, password, dir, ...rest] = process.argv.slice(2);
const where = crypt.places(dir, blob, () => 'js');
const list = (root) => {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(join(d, e.name), r); else out[r] = fs.readFileSync(join(d, e.name)).toString('base64'); } };
  if (fs.existsSync(root)) walk(root, '');
  return out;
};
if (cmd === 'create') {
  const w = crypt.places(dir + '-private', blob, () => 'js');
  const { vault, recovery } = await crypt.createVault(blob, password, w);
  fs.cpSync(dir, vault.where.work, { recursive: true });
  await vault.seal();
  console.log(recovery);
} else if (cmd === 'open') {
  const v = await crypt.unlockVault(blob, password, where);
  console.log(JSON.stringify({ work: v.where.work, files: list(v.where.work), history: list(join(v.where.data, 'history')) }));
} else if (cmd === 'add') {
  const v = await crypt.unlockVault(blob, password, where);
  const [rel, text] = rest;
  fs.mkdirSync(dirname(join(v.where.work, rel)), { recursive: true });
  fs.writeFileSync(join(v.where.work, rel), text);
  await v.seal();
  console.log('ok');
}
