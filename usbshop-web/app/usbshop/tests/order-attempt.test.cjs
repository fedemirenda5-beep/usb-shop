const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../src/lib/orderAttempt.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function checkoutSession(storage, now = Date.now()) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'localStorage', 'Date', compiled)(mod, mod.exports, storage, { now: () => now });
  return mod.exports;
}
function checkout(storage, now = Date.now()) {
  return checkoutSession(storage, now).getOrderAttemptKey;
}
function storage() {
  let value = null;
  return { getItem: () => value, setItem: (_, next) => { value = next; }, removeItem: () => { value = null; } };
}

test('reload and another checkout reuse the saved attempt', () => {
  const store = storage();
  assert.equal(checkout(store)('cart', () => 'first'), 'first');
  assert.equal(checkout(store)('cart', () => 'duplicate'), 'first');
});
test('changed orders receive new keys', () => {
  const store = storage();
  checkout(store, 1000)('cart', () => 'first');
  assert.equal(checkout(store, 1001)('changed', () => 'second'), 'second');
});
test('a lost response can be retried after the server duplicate detection window', () => {
  const store = storage();
  checkout(store, 1000)('cart', () => 'first');
  for (const now of [1000 + 16 * 60 * 1000, 1000 + 24 * 60 * 60 * 1000, 500]) {
    assert.equal(checkout(store, now)('cart', () => 'duplicate'), 'first');
  }
});
test('blocked storage retains retries in memory', () => {
  const getKey = checkout({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  assert.equal(getKey('cart', () => 'first'), 'first');
  assert.equal(getKey('cart', () => 'second'), 'first');
});
test('a confirmed order allows a new identical purchase', () => {
  const store = storage();
  const session = checkoutSession(store);
  assert.equal(session.getOrderAttemptKey('cart', () => 'first'), 'first');
  session.clearOrderAttemptKey();
  assert.equal(session.getOrderAttemptKey('cart', () => 'second'), 'second');
  assert.equal(checkout(store)('cart', () => 'third'), 'second');
});
test('malformed saved data can be replaced', () => {
  for (const value of ['{', '{}', 'null', '42']) {
    assert.equal(checkout({ getItem: () => value, setItem() {} })('cart', () => 'valid'), 'valid');
  }
});
