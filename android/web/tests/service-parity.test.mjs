// The JS vault service must behave like the desktop (Python) one: same index, same
// search results, same link rewriting on rename.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setNative } from '../src/backend/native.js';
import * as links from '../src/backend/links.js';
import { search } from '../src/backend/search.js';
import { VaultService } from '../src/backend/service.js';
import { createNative } from './mock-native.mjs';
import { makeVault, readTree } from './parity/vault.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const plain = (x) => JSON.parse(JSON.stringify(x));

const QUERIES = ['garden', 'coffee kernel', '"the garden"', 'garden OR river', 'garden -river', 'tag:#todo', 'tag:daily', 'tag:area',
  'file:Plan', 'path:Projects', 'path:"Projects/Sub"', 'content:coffee', 'line:(garden river)', 'line:(coffee garden)', 'section:(Details coffee)',
  'block:(Goal one)', 'task:garden', 'task-todo:garden', 'task-done:garden', 'task-todo:""', '[status]', '[status:open]', '[rating:4]', '[done:false]',
  '[missing]', '[due:2024]', '/abc\\d+def/', 'match-case:TEXT', 'match-case:text', 'ignore-case:TEXT', 'text', '(garden OR coffee) path:Projects',
  'garden)', 'café', 'ünïcödé', '-garden', 'Card', 'Group label', 'plain', 'nothingmatchesthisquery', 'a', 'OR', 'tag:#tag😀', '[status:]', '[tags:project]'];

const OPS = [
  { op: 'snapshot' },
  ...QUERIES.map((query) => ({ op: 'search', query })),
  { op: 'search', query: 'garden', context: 3 },
  { op: 'search', query: 'TEXT', cs: true },
  ...[['Plan', 'Home.md'], ['Plan', 'Projects/Ideas Box.md'], ['Plan', 'Archive/x.md'], ['plan', ''], ['Projects/Plan', 'Home.md'], ['../Plan', 'Projects/Sub/Deep.md'],
    ['pic.png', 'Home.md'], ['pic', 'Home.md'], ['Ideas Box', ''], ['ideas box.md', ''], ['Nowhere', 'Home.md'], ['', 'Home.md'], ['Alpha copy', 'Home.md'], ['Sub/Deep', 'Home.md'],
    ['doc.pdf', ''], ['Attachments/doc.pdf', ''], ['beta', 'Alpha.md'], ['/', 'Home.md'], ['Daily/2024-03-05', '']].map(([link, source]) => ({ op: 'resolve', link, source })),
  ...[['Projects/Plan.md', 'Home.md'], ['Archive/Plan.md', 'Home.md'], ['Alpha.md', 'Projects/Sub/Deep.md'], ['pic.png', 'Home.md'], ['Projects/Plan.md', 'Projects/Ideas Box.md']].map(([target, source]) => ({ op: 'linktext', target, source })),
  { op: 'tags' },
  { op: 'properties' },
  { op: 'rename', path: 'Alpha.md', newPath: 'Gamma.md' },
  { op: 'snapshot' },
  { op: 'rename', path: 'Projects/Plan.md', newPath: 'Projects/Roadmap.md' },
  { op: 'rename', path: 'Projects', newPath: 'Work/Active' },
  { op: 'snapshot' },
  { op: 'rename', path: 'Gamma.md', newPath: 'Archive/Deep/Gamma.md' },
  { op: 'rename', path: 'Home.md', newPath: 'Start/Home.md' },
  { op: 'rename', path: 'pic.png', newPath: 'Attachments/picture.png' },
  { op: 'rename', path: 'Beta.md', newPath: 'Beta 2.md', updateLinks: false },
  { op: 'rename', path: 'Nowhere.md', newPath: 'X.md' },
  { op: 'rename', path: 'Start/Home.md', newPath: 'Archive/Plan.md' },
  { op: 'write', path: 'New note.md', text: 'fresh [[Roadmap]] [[Nowhere]] #new\n' },
  { op: 'write', path: 'Nowhere.md', text: 'now it exists\n' },
  { op: 'snapshot' },
  { op: 'delete', path: 'Work/Active/Sub' },
  { op: 'delete', path: 'Archive' },
  { op: 'snapshot' },
  { op: 'search', query: 'garden' },
];

const strip = (snap) => ({
  files: snap.files.map((f) => ({ path: f.path, folder: f.folder, size: f.folder ? null : f.size })),
  metadata: snap.metadata, resolved: snap.resolvedLinks, unresolved: snap.unresolvedLinks,
});

test('vault service parity with the desktop service', async () => {
  const jsDir = makeVault('skn-js-');
  const pyDir = makeVault('skn-py-');
  const r = spawnSync('python3', [join(here, 'parity', 'py_service.py'), repo, pyDir], { input: JSON.stringify(OPS), maxBuffer: 1 << 28, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const expected = JSON.parse(r.stdout);

  setNative(createNative());
  const svc = new VaultService(jsDir, () => {});
  await svc.open();
  const got = [];
  for (const op of OPS) {
    try {
      if (op.op === 'snapshot') got.push(strip(svc.index.snapshot()));
      else if (op.op === 'search') {
        const res = await search(svc.index, op.query, { caseSensitive: !!op.cs, context: op.context || 1 });
        got.push({ total: res.total, results: res.results.map((x) => ({ path: x.path, matches: x.matches })).sort((a, b) => (a.path < b.path ? -1 : 1)) });
      } else if (op.op === 'rename') {
        const res = svc.rename(op.path, op.newPath, { updateLinks: op.updateLinks ?? null });
        got.push({ path: res.path, updated: res.updated.slice().sort() });
      } else if (op.op === 'write') { svc.write(op.path, op.text); got.push(true); } else if (op.op === 'delete') {
        const res = svc.delete(op.path, { mode: op.mode || 'permanent' });
        got.push({ mode: res.mode, removed: res.removed.slice().sort() });
      } else if (op.op === 'resolve') got.push(svc.index.resolve(op.link, op.source || ''));
      else if (op.op === 'linktext') got.push(links.linkpathFor(svc.index, op.target, op.source));
      else if (op.op === 'tags') got.push(svc.index.allTags());
      else if (op.op === 'properties') got.push(svc.index.properties());
    } catch (e) { got.push({ error: String(e.code || e.message) }); }
  }
  let bad = 0;
  OPS.forEach((op, i) => {
    let a = plain(got[i]);
    let b = expected[i];
    if (a && b && a.error && b.error) return; // both refuse (messages differ)
    // the phone leaves databases (.base) out of the vault on purpose (backend/vault.js isTableFile)
    const isBase = (p) => /\.base$/i.test(String(p || ''));
    if (b && op.op === 'snapshot') {
      b = { ...b, files: b.files.filter((f) => !isBase(f.path)) };
      for (const k of ['metadata', 'resolved', 'unresolved']) if (b[k]) b[k] = Object.fromEntries(Object.entries(b[k]).filter(([p]) => !isBase(p)));
    }
    if (b && op.op === 'search' && Array.isArray(b.results)) {
      const kept = b.results.filter((r) => !isBase(r.path));
      b = { ...b, results: kept, total: b.total - (b.results.length - kept.length) };
    }
    if (op.op === 'search') {
      // result order inside the list is by path on both sides already
    }
    if (op.op === 'snapshot') {
      const norm = (s) => ({ ...s, files: s.files.slice().sort((x, y) => (x.path < y.path ? -1 : 1)) });
      a = norm(a); b = norm(b);
    }
    try { assert.deepEqual(a, b); } catch (e) {
      bad++;
      if (bad <= 6) console.error(`op ${i} ${JSON.stringify(op).slice(0, 100)}:\n${String(e.message).slice(0, 1800)}`);
    }
  });
  assert.equal(bad, 0, `${bad} of ${OPS.length} operations differ`);
  assert.deepEqual(readTree(jsDir), readTree(pyDir), 'files after the renames');
  fs.rmSync(jsDir, { recursive: true, force: true });
  fs.rmSync(pyDir, { recursive: true, force: true });
});
