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
    name => name.startsWith('./') ? loadTs(`${name.slice(2)}.ts`) : require(name), module, module.exports
  );
  return module.exports;
}

const { buildPrintableHtml, openAdminSellerCustomersPrint } = loadTs('adminSellerCustomersPrint.ts');
const payload = {
  sellerName: 'Todos los clientes', generatedAtLabel: '06/10/2026', purchaseMonth: '2026-10',
  customers: [
    { id: 1, name: '<script>cliente</script>', locality: 'San Martín', address: 'Av. Mitre 123 & 125',
      phone: '11 5555-1234', email: 'cliente@example.test', monthlySalesTotal: 1234.5, monthlyPurchaseCount: 1,
      lastPurchaseAt: '2026-10-01T02:59:59Z', lastPurchaseMonth: '2026-09', daysWithoutPurchase: 6 },
    { id: 2, name: 'Sin historial', monthlySalesTotal: 0, monthlyPurchaseCount: 0 },
    { id: 3, name: 'Sin compras este mes', monthlySalesTotal: 0, monthlyPurchaseCount: 0,
      daysWithoutPurchase: 45 },
  ],
};
const html = buildPrintableHtml(payload, '/logo.jpeg');
assert.ok(html.includes('octubre de 2026'));
assert.ok(!html.includes('septiembre de 2026'));
assert.ok(!html.includes('30/09/2026'));
assert.ok(!html.includes('6 días'));
assert.ok(html.includes('45 días sin comprar'));
assert.ok(html.includes('Sin compras registradas'));
assert.ok(!html.includes('<th>Última compra</th>'));
assert.ok(!html.includes('<th>Días sin comprar</th>'));
assert.match(html, /<th>Cliente<\/th>\s*<th>Compras del mes<\/th>/);
const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1);
assert.deepEqual(rows.map(row => (row[1].match(/<td\b/g) || []).length), [8, 8, 8]);
assert.match(html, /<th>Localidad<\/th>\s*<th>Dirección<\/th>\s*<th>Teléfono<\/th>/);
assert.ok(html.includes('<td>San Martín</td>'));
assert.ok(html.includes('<td>Av. Mitre 123 &amp; 125</td>'));
assert.ok(html.includes('11 5555-1234'));
assert.ok(html.includes('cliente@example.test'));
assert.ok(html.includes('&lt;script&gt;cliente&lt;/script&gt;'));
assert.ok(!html.includes('<script>cliente</script>'));
assert.ok(html.includes('1.234,50'));
assert.ok(html.includes('A4 portrait'));
assert.ok(!html.includes('.panel, table { break-inside: avoid; }'));
const simple = buildPrintableHtml({ ...payload, purchaseMonth: undefined }, '/logo.jpeg');
assert.ok(!simple.includes('<th>Compras del mes</th>'));
assert.ok(!simple.includes('45 días sin comprar'));
assert.ok(simple.includes('A4 portrait'));
const empty = buildPrintableHtml({ ...payload, customers: [] }, '/logo.jpeg');
assert.ok(empty.includes('colspan="8"'));
assert.ok(buildPrintableHtml({ ...payload, purchaseMonth: undefined, customers: [] }, '/logo.jpeg').includes('colspan="7"'));

const { formatCustomerMonthlyPurchases } = loadTs('customerMonthlyPurchases.ts');
assert.equal(formatCustomerMonthlyPurchases({ monthlySalesTotal: 0, monthlyPurchaseCount: 1,
  daysWithoutPurchase: 4 }), new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(0));
assert.equal(formatCustomerMonthlyPurchases({ monthlyPurchaseCount: 0, daysWithoutPurchase: 1 }), '1 día sin comprar');
assert.equal(formatCustomerMonthlyPurchases({ monthlyPurchaseCount: 0, daysWithoutPurchase: 0 }), '0 días sin comprar');
assert.equal(formatCustomerMonthlyPurchases({}), '—');

(async () => {
  let written = '';
  let focused = false;
  global.window = { location: { origin: 'https://example.test' }, open: () => { throw Error('Should reuse window'); } };
  await openAdminSellerCustomersPrint(payload, {
    document: { open() {}, write(value) { written = value; }, close() {} },
    focus() { focused = true; },
  });
  assert.ok(written.includes('Compras del mes'));
  assert.ok(focused);
  console.log('Customer purchase print checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
