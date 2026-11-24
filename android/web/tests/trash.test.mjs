// The trash: deleted files are kept with their date and place, put back, and removed after three months.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setNative } from '../src/backend/native.js';
import { VaultService } from '../src/backend/service.js';
import { KEEP_MS, listTrash, purgeTrash, restoreFromTrash } from '../src/backend/trash.js';
import { createNative } from './mock-native.mjs';

test('trash keeps date and place, restores, and forgets after three months', async () => {
  setNative(createNative());
  const root = fs.mkdtempSync(join(os.tmpdir(), 'skn-trash-'));
  fs.mkdirSync(join(root, 'Projects'));
  fs.writeFileSync(join(root, 'Projects', 'Plan.md'), '# Plan\n');
  fs.writeFileSync(join(root, 'Old.md'), '# Old\n');
  fs.writeFileSync(join(root, 'Keep.md'), '# Keep\n');
  try {
    const s = new VaultService(root, () => {});
    await s.open();
    const before = Date.now();
    s.delete('Projects/Plan.md', { mode: 'system' });
    s.delete('Old.md', { mode: 'local' });
    let items = listTrash(s.vault);
    assert.deepEqual(items.map((x) => x.name).sort(), ['Old.md', 'Plan.md']);
    const plan = items.find((x) => x.name === 'Plan.md');
    assert.equal(plan.from, 'Projects/Plan.md');
    assert.ok(plan.at >= before && plan.at <= Date.now());

    // a file another app put in .trash counts from the day it is first seen
    fs.writeFileSync(join(root, '.trash', 'Foreign.md'), 'x');
    items = listTrash(s.vault);
    assert.ok(items.find((x) => x.name === 'Foreign.md').at >= before);

    // back where it was; when the place is taken, beside it under another name
    fs.writeFileSync(join(root, 'Projects', 'Plan.md'), 'new one');
    assert.equal(restoreFromTrash(s.vault, 'Plan.md'), 'Projects/Plan 1.md');
    assert.equal(fs.readFileSync(join(root, 'Projects', 'Plan 1.md'), 'utf8'), '# Plan\n');
    assert.throws(() => restoreFromTrash(s.vault, '../Keep.md'));
    assert.throws(() => restoreFromTrash(s.vault, '.skn-trash.json'));

    // three months and a day later Old.md and Foreign.md are gone for good
    items = listTrash(s.vault, Date.now() + KEEP_MS + 24 * 3600 * 1000);
    assert.deepEqual(items, []);
    assert.ok(!fs.existsSync(join(root, '.trash', 'Old.md')));
    assert.ok(fs.existsSync(join(root, 'Keep.md')));

    // delete for good, one or all
    s.delete('Keep.md', { mode: 'system' });
    fs.writeFileSync(join(root, 'A.md'), 'a');
    s.delete('A.md', { mode: 'system' });
    purgeTrash(s.vault, 'Keep.md');
    assert.deepEqual(listTrash(s.vault).map((x) => x.name), ['A.md']);
    purgeTrash(s.vault, null);
    assert.deepEqual(listTrash(s.vault), []);
    s.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
