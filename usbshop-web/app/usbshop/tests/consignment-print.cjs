// Serve the static export locally. API responses are mocked; no real stock is changed.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3016';
const detail = {
  id: 42, customer_id: 7, customer_name: 'Cliente <Prueba> & Hijos',
  created_at: '2026-09-28T15:00:00Z', notes: 'Referencia <presupuesto>\nSegunda línea',
  delivered: 6, sold: 3, returned: 1, pending: 2,
  items: [{ product_id: 1, name: 'Cable <USB>', sku: 'USB-1', price: 1000,
    general_stock: 10, delivered: 6, sold: 3, returned: 1, pending: 2 }], movements: [],
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const open = window.open.bind(window);
      window.open = (...args) => {
        const popup = open(...args);
        if (popup) popup.print = () => { popup.printCalls = (popup.printCalls || 0) + 1; };
        return popup;
      };
    });
    let writes = 0;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') writes++;
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
      if (url.pathname === '/auth/me') return route.fulfill({ json: { id: 1, username: 'Prueba', role: 'admin' } });
      if (url.pathname === '/admin/consignments/42') return route.fulfill({ json: detail });
      if (url.pathname === '/admin/consignments') return route.fulfill({ json: route.request().method() === 'POST' ? detail : [detail] });
      if (url.pathname === '/admin/backoffice-customers') return route.fulfill({ json: [{ id: 7, name: detail.customer_name }] });
      if (url.pathname === '/admin/products') return route.fulfill({ json: [{ id: 1, name: 'Cable USB', stock: 10, available_stock: 10 }] });
      if (url.origin !== base) return route.fulfill({ json: [] });
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const print = async () => {
      const before = writes;
      await page.getByRole('button', { name: 'Imprimir comprobante', exact: true }).waitFor();
      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        page.getByRole('button', { name: 'Imprimir comprobante', exact: true }).click(),
      ]);
      await popup.waitForFunction(() => window.printCalls > 0, null, { timeout: 10000 });
      assert.equal(await popup.locator('h1').textContent(), 'Entrega en consignación #42');
      assert((await popup.locator('.customer').textContent()).includes(detail.customer_name));
      assert.equal(await popup.locator('tbody td').nth(1).textContent(), 'Cable <USB>');
      assert.equal(await popup.locator('tbody td').nth(2).textContent(), '6', 'Reprinting must preserve delivered quantity, not pending stock');
      assert((await popup.locator('.notes').textContent()).includes(detail.notes));
      await popup.getByRole('button', { name: 'Imprimir / Guardar PDF', exact: true }).click();
      assert.equal(await popup.evaluate(() => window.printCalls), 2);
      await popup.emulateMedia({ media: 'print' });
      assert.equal(await popup.locator('.toolbar').isVisible(), false);
      assert.equal(writes, before, 'Printing must not modify stock or create documents');
      await popup.close();
    };
    await page.goto(`${base}/admin/consignaciones/?consignment_id=42`);
    await print();
    console.log('PASS direct link after creation, escaped data, original quantities, print layout and read-only printing');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/admin/consignaciones/`);
    await page.getByRole('button', { name: 'Ver detalle', exact: true }).click();
    await print();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => { window.open = () => null; });
    await page.getByRole('button', { name: 'Imprimir comprobante', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'El navegador bloqueó' }).waitFor();
    console.log('PASS mobile reprint from history and blocked-popup feedback');
    await page.reload();
    await page.getByRole('button', { name: 'Nueva entrega', exact: true }).click();
    await page.locator('form').getByLabel('Buscar cliente', { exact: true }).fill('Cliente');
    await page.getByRole('button', { name: detail.customer_name, exact: true }).click();
    await page.getByLabel('Buscar producto', { exact: true }).fill('Cable');
    await page.getByRole('button', { name: /Cable USB · General/ }).click();
    await page.getByLabel('Cantidad de Cable USB').fill('6');
    await page.getByRole('button', { name: 'Registrar entrega y reservar', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Entrega registrada' }).waitFor();
    await print();
    assert.equal(writes, 1, 'Only registering the delivery sends a write');
    assert.deepEqual(errors, []);
    console.log('PASS print available immediately after registering a delivery');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
