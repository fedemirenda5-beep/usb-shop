const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../src/lib/orderAttempt.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function checkout(storage, now = Date.now()) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'localStorage', 'Date', compiled)(mod, mod.exports, storage, { now: () => now });
  return mod.exports.getOrderAttemptKey;
}
function storage() {
  let value = null;
  return { getItem: () => value, setItem: (_, next) => { value = next; } };
}

test('reload and another checkout reuse the saved attempt', () => {
  const store = storage();
  assert.equal(checkout(store)('cart', () => 'first'), 'first');
  assert.equal(checkout(store)('cart', () => 'duplicate'), 'first');
});
test('changed orders and expired attempts receive new keys', () => {
  const store = storage();
  checkout(store, 1000)('cart', () => 'first');
  assert.equal(checkout(store, 1001)('changed', () => 'second'), 'second');
  assert.equal(checkout(store, 1001 + 15 * 60 * 1000)('changed', () => 'third'), 'third');
});
test('blocked storage retains retries in memory', () => {
  const getKey = checkout({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  assert.equal(getKey('cart', () => 'first'), 'first');
  assert.equal(getKey('cart', () => 'second'), 'first');
});
test('malformed saved data can be replaced', () => {
  for (const value of ['{', '{}', 'null', '42']) {
    assert.equal(checkout({ getItem: () => value, setItem() {} })('cart', () => 'valid'), 'valid');
  }
});
