// The JS parser must give the same metadata as the desktop (Python) parser.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aliases, allTags, parse } from '../src/backend/parser.js';
import { corpus } from './parity/corpus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

test('parser parity with the desktop parser', () => {
  const texts = corpus([repo, process.env.SKN_PARITY_VAULT].filter(Boolean));
  const r = spawnSync('python3', [join(here, 'parity', 'py_parse.py'), repo], { input: JSON.stringify(texts), maxBuffer: 1 << 30, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const expected = JSON.parse(r.stdout);
  let bad = 0;
  texts.forEach((text, i) => {
    const meta = parse(text);
    const got = JSON.parse(JSON.stringify({ meta, tags: allTags(meta), aliases: aliases(meta) }));
    // the two YAML libraries word their error messages differently
    if (got.meta.frontmatterError && expected[i].meta.frontmatterError) got.meta.frontmatterError = expected[i].meta.frontmatterError;
    try { assert.deepEqual(got, expected[i]); } catch (e) {
      bad++;
      if (bad <= 5) console.error(`sample ${i} (${JSON.stringify(text.slice(0, 80))}):\n${String(e.message).slice(0, 1500)}`);
    }
  });
  assert.equal(bad, 0, `${bad} of ${texts.length} samples differ`);
});
