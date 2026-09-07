const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

const source = readFileSync(join(__dirname, '../src/lib/cart.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const cartModule = { exports: {} };
new Function('module', 'exports', compiled)(cartModule, cartModule.exports);
const { reconcileCartItems } = cartModule.exports;
const product = { id: 1, name: 'Cable USB', category: 'Cables', price: 1000, stock: 10 };

test('unchanged API objects allow checkout and stop the refresh loop', () => {
  let items = [{ product, qty: 2 }];
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = reconcileCartItems(items, [{ ...product }]);
    assert.equal(result.changed, false);
    items = result.items;
  }
});

test('price and stock changes require review once, then allow confirmation', () => {
  for (const update of [{ price: 1200 }, { stock: 1 }, { stock: 8 }]) {
    const live = { ...product, ...update };
    const result = reconcileCartItems([{ product, qty: 2 }], [live]);
    assert.equal(result.changed, true);
    assert.equal(result.items[0].qty, Math.min(2, live.stock));
    assert.equal(result.items[0].product.price, live.price);
    assert.equal(reconcileCartItems(result.items, [{ ...live }]).changed, false);
  }
});

test('unavailable or removed products are removed before checkout', () => {
  for (const products of [[], [{ ...product, stock: 0 }]]) {
    const result = reconcileCartItems([{ product, qty: 2 }], products);
    assert.equal(result.changed, true);
    assert.deepEqual(result.items, []);
  }
});
