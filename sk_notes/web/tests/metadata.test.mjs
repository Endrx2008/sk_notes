// Regression tests for MetadataCache event handling.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;

const { MetadataCache } = await import('../src/model/metadata.js');

function cacheWith(files) {
  const vault = { getFileByPath: (p) => files[p] || null, getAbstractFileByPath: (p) => files[p] || null, getMarkdownFiles: () => Object.values(files) };
  return new MetadataCache({ vault });
}

test('rename keeps the metadata of the renamed note (A-2)', () => {
  const mc = cacheWith({});
  const meta = { headings: [{ heading: 'H', level: 1 }], links: [{ link: 'X' }] };
  mc.meta['old.md'] = meta;
  mc._onBackend('rename', {
    oldPath: 'old.md', file: { path: 'new.md', folder: false }, moved: [['old.md', 'new.md']], updated: [],
    metadata: { 'new.md': meta }, resolvedLinks: {}, unresolvedLinks: {},
  }, null);
  assert.equal(mc.meta['old.md'], undefined);
  assert.deepEqual(mc.meta['new.md'], meta);
  assert.equal(mc.meta['new.md']['new.md'], undefined);
});

test('rename stores metadata of notes whose links were rewritten', () => {
  const mc = cacheWith({});
  mc.meta['a.md'] = { links: [{ link: 'old' }] };
  mc._onBackend('rename', {
    oldPath: 'old.md', file: { path: 'new.md' }, moved: [['old.md', 'new.md']], updated: ['a.md'],
    metadata: { 'a.md': { links: [{ link: 'new' }] } },
  }, null);
  assert.equal(mc.meta['a.md'].links[0].link, 'new');
});
