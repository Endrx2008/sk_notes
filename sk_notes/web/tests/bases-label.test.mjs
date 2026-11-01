// Bases column headers use displayName from the properties section (A-20).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { documentElement: {} };

const { propLabel } = await import('../src/bases/labels.js');

test('displayName with or without the note. prefix', () => {
  assert.equal(propLabel({ properties: { status: { displayName: 'Status' } } }, 'note.status'), 'Status');
  assert.equal(propLabel({ properties: { 'note.rating': { displayName: 'Rating' } } }, 'note.rating'), 'Rating');
  assert.equal(propLabel({ properties: { 'formula.x': { displayName: 'X2' } } }, 'formula.x'), 'X2');
  assert.equal(propLabel({}, 'note.status'), 'status');
});
