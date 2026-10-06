const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadTs(file) {
  const filename = path.resolve(__dirname, '../src/lib', file);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    name => name === './datetime' ? loadTs('datetime.ts') : require(name), module, module.exports
  );
  return module.exports;
}

const { buildPrintableHtml, openAdminSellerCustomersPrint } = loadTs('adminSellerCustomersPrint.ts');
const payload = {
  sellerName: 'Todos los clientes', generatedAtLabel: '06/10/2026', purchaseMonth: '2026-10',
  customers: [
    { id: 1, name: '<script>cliente</script>', monthlySalesTotal: 1234.5, monthlyPurchaseCount: 1,
      lastPurchaseAt: '2026-10-01T02:59:59Z', lastPurchaseMonth: '2026-09', daysWithoutPurchase: 6 },
    { id: 2, name: 'Sin historial', monthlySalesTotal: 0, monthlyPurchaseCount: 0 },
  ],
};
const html = buildPrintableHtml(payload, '/logo.jpeg');
assert.ok(html.includes('octubre de 2026'));
assert.ok(html.includes('septiembre de 2026'));
assert.ok(html.includes('30/09/2026'));
assert.ok(html.includes('6 días'));
assert.ok(html.includes('Sin compras registradas'));
assert.ok(html.includes('Sin compras en el mes'));
assert.ok(html.includes('&lt;script&gt;cliente&lt;/script&gt;'));
assert.ok(!html.includes('<script>cliente</script>'));
assert.ok(html.includes('1.234,50'));
assert.ok(html.includes('A4 landscape'));
assert.ok(!html.includes('.panel, table { break-inside: avoid; }'));
const simple = buildPrintableHtml({ ...payload, purchaseMonth: undefined }, '/logo.jpeg');
assert.ok(!simple.includes('<th>Comprado en el mes</th>'));
assert.ok(simple.includes('A4 portrait'));
const empty = buildPrintableHtml({ ...payload, customers: [] }, '/logo.jpeg');
assert.ok(empty.includes('colspan="9"'));

(async () => {
  let written = '';
  let focused = false;
  global.window = { location: { origin: 'https://example.test' }, open: () => { throw Error('Should reuse window'); } };
  await openAdminSellerCustomersPrint(payload, {
    document: { open() {}, write(value) { written = value; }, close() {} },
    focus() { focused = true; },
  });
  assert.ok(written.includes('Comprado en el mes'));
  assert.ok(focused);
  console.log('Customer purchase print checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
