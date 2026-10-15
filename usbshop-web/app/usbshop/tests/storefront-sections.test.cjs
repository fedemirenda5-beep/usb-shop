const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { test } = require('node:test');
const code = ts.transpileModule(fs.readFileSync('src/lib/storefrontSections.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const { uniqueStorefrontSections } = mod.exports;

test('sections fill with distinct available products and leave the source intact', () => {
  const products = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, stock: i === 2 ? 0 : 10 }));
  const sections = uniqueStorefrontSections([
    { key: 'new', products, limit: 4 },
    { key: 'restocked', products, limit: 4 },
    { key: 'featured', products, limit: 4 },
  ]);
  assert.deepEqual(sections.new.map(p => p.id), [1, 2, 4, 5]);
  assert.deepEqual(sections.restocked.map(p => p.id), [6, 7, 8, 9]);
  assert.deepEqual(sections.featured.map(p => p.id), [10, 11, 12]);
  const all = Object.values(sections).flat();
  assert.equal(new Set(all.map(p => p.id)).size, all.length);
  assert.ok(all.every(p => p.stock > 0));
  assert.equal(products.length, 12);
});
