const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Load the actual preview functions without mounting the admin pages or calling the API.
function loadPreview(page) {
  const source = ts.createSourceFile(page, readFileSync(join(__dirname, '../src/app/admin', page, 'page.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(['calculateCommissionPreview', 'normalizeSearchValue', 'normalizeCategoryName', 'isNokia106ExceptionProduct', 'isFedeSellerName', 'round', 'CELULARES_COMMISSION_PERCENT', 'CELULARES_COMMISSION_PERCENT_FEDE', 'LENTES_COMMISSION_PERCENT_FEDE']);
  const declarations = source.statements.filter(statement =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => names.has(declaration.name.getText(source)))
  ).map(statement => statement.getText(source)).join('\n');
  const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function(`${compiled}\nreturn calculateCommissionPreview;`)();
}

const existingPreview = loadPreview('comprobantes');
const newPreview = loadPreview('generar-comprobante');
const products = [
  { id: 1, name: 'Lentes de sol', category_id: 1, category_name: 'Lentes', cost: 100 },
  { id: 2, name: 'Celular', category_id: 2, category_name: 'Celulares', cost: 100 },
  { id: 3, name: 'Cable USB', category_id: 3, category_name: 'Accesorios', cost: 100 },
];

for (const [label, preview] of [['existing invoice', existingPreview], ['new invoice', newPreview]]) {
  function calculate(selected, overrides = {}) {
    return preview({
      sellerName: 'Fede', sellerPercent: 20, specialDiscount: 0,
      celularesCategoryIds: new Set([2]), productMap: new Map(selected.map(p => [p.id, p])),
      items: selected.map(p => ({ product_id: String(p.id), product_name: p.name, category_name: p.category_name, is_cellphone: p.category_id === 2, quantity: 1, unit_price: 1000, line_total: 1000 })),
      ...overrides,
    });
  }
  test(`${label}: lenses, phones and standard products keep their distinct rates`, () => {
    assert.equal(calculate(products), 800);
    assert.equal(calculate(products, { sellerName: 'Otro vendedor' }), 450);
  });
  test(`${label}: discounts are allocated across the invoice`, () => {
    assert.equal(calculate(products, { specialDiscount: 300 }), 720);
    assert.equal(calculate([], {}), 0);
  });
  test(`${label}: Nokia 106 keeps the standard commission exception`, () => {
    assert.equal(calculate([{ ...products[1], name: 'Nokia 106' }]), 200);
  });
  test(`${label}: consignment markup does not increase seller commission`, () => {
    const cable = { ...products[2], price: 1000, price_list_1: 1100 };
    const item = { product_id: '3', quantity: 2, unit_price: 1200, line_total: 2400, commission_base_price: 1000 };
    assert.equal(calculate([cable], { items: [item], isConsignment: true }), 400);
    assert.equal(calculate([cable], { items: [item], isConsignment: true, specialDiscount: 200 }), 360);
    assert.equal(calculate([cable], { items: [{ ...item, unit_price: 900, line_total: 1800 }], isConsignment: true }), 360);
  });
}

test('new invoice: consignment commission uses the selected price list', () => {
  assert.equal(newPreview({
    sellerName: 'Otro', sellerPercent: 20, specialDiscount: 0, isConsignment: true, priceList: 1,
    celularesCategoryIds: new Set(),
    productMap: new Map([[3, { ...products[2], price: 1000, price_list_1: 1100 }]]),
    items: [{ product_id: '3', quantity: 1, unit_price: 1200 }],
  }), 220);
});

test('new invoice: non-phone commission remains capped by the margin', () => {
  assert.equal(newPreview({
    sellerName: 'Fede', sellerPercent: 20, specialDiscount: 0,
    celularesCategoryIds: new Set(),
    productMap: new Map([[1, { ...products[0], cost: 900 }]]),
    items: [{ product_id: '1', quantity: 1, unit_price: 1000 }],
  }), 100);
});

test('existing invoice: consignment markup does not raise the margin cap', () => {
  assert.equal(existingPreview({
    sellerName: 'Otro', sellerPercent: 20, specialDiscount: 0,
    items: [{ quantity: 1, unit_price: 1200, line_total: 1200, commission_base_price: 1000, cost_total: 950 }],
  }), 50);
});
