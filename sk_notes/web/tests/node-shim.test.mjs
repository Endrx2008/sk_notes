// Regression tests for the Node.js module shims plugins require().
// Run with `npm test` (Node's built-in test runner, no extra packages).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis; // the shims expect a browser page

const { nodeModules, EventEmitter, stream } = await import('../src/compat/node.js');
const mods = nodeModules('test-plugin');

test('EventEmitter works for ES5-style subclasses (Parent.call(this))', () => {
  function Old() { EventEmitter.call?.(this); }
  Old.prototype = Object.create(EventEmitter.prototype);
  const o = new Old();
  let got = null;
  o.on('x', (v) => { got = v; });
  assert.equal(o.emit('x', 5), true);
  assert.equal(got, 5);
});

test('EventEmitter has the static helpers bundled libraries patch', () => {
  assert.equal(typeof EventEmitter.setMaxListeners, 'function');
  assert.equal(mods.events, EventEmitter);
  assert.equal(mods.events.EventEmitter, EventEmitter);
});

test('stream constructors can be called without new and subclassed', () => {
  const S = mods.stream.Stream;
  function Legacy() { S.call(this); }
  Legacy.prototype = Object.create(S.prototype, { constructor: { value: Legacy } });
  assert.ok(new Legacy() instanceof EventEmitter);
  class Modern extends stream.Transform {}
  const m = new Modern();
  const out = [];
  m.on('data', (c) => out.push(c));
  m.write('a');
  m.end('b');
  assert.deepEqual(out, ['a', 'b']);
});

test('util has debuglog, deprecate and inherits', () => {
  const log = mods.util.debuglog('x');
  assert.equal(typeof log, 'function');
  assert.equal(log.enabled, false);
  const f = () => 1;
  assert.equal(mods.util.deprecate(f, 'msg'), f);
  function A() {} function B() {}
  mods.util.inherits(B, A);
  assert.ok(new B() instanceof A);
});

test('http exposes constants but refuses servers', () => {
  assert.ok(mods.http.METHODS.includes('GET'));
  assert.equal(mods.http.STATUS_CODES[404], 'Not Found');
  assert.equal(typeof mods.http.IncomingMessage.prototype.on, 'function');
  assert.throws(() => mods.http.createServer(), /not available/);
  assert.throws(() => mods.https.createServer(), /not available/);
});

test('small modules: tty, string_decoder, vm, punycode, buffer constants', () => {
  assert.equal(mods.tty.isatty(1), false);
  const d = new mods.string_decoder.StringDecoder('utf8');
  const bytes = new TextEncoder().encode('è');
  assert.equal(d.write(bytes.subarray(0, 1)) + d.end(bytes.subarray(1)), 'è');
  assert.equal(mods.vm.runInNewContext('a + b', { a: 2, b: 3 }), 5);
  assert.equal(new mods.vm.Script('x * 2').runInNewContext({ x: 4 }), 8);
  assert.deepEqual(mods.punycode.ucs2.decode('a😀'), [97, 0x1f600]);
  assert.equal(mods.punycode.ucs2.encode([97, 0x1f600]), 'a😀');
  assert.ok(mods.buffer.constants.MAX_LENGTH > 0);
});

test('fs has realpath.native and process has stdout/umask', () => {
  assert.equal(typeof mods.fs.realpath.native, 'function');
  assert.equal(mods.fs.realpathSync.native('/a/../b'), '/b');
  assert.equal(typeof mods.process.umask(), 'number');
  assert.equal(mods.process.stdout.isTTY, false);
});
