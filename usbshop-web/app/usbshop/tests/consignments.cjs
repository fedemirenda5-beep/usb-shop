// Requires: local Next dev server and `python test_consignments.py --serve` (disposable DB).
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  try {
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8011' } });
      if (url.pathname === '/auth/me') return route.fulfill({ json: { id: 1, username: 'Prueba', role: 'admin' } });
      if (url.port === '8000' || url.port === '8011' || url.hostname === 'api.usbshop.com.ar') {
        const response = await route.fetch({ url: `http://127.0.0.1:8011${url.pathname}${url.search}` });
        return route.fulfill({ response });
      }
      if (url.hostname !== '127.0.0.1') return route.fulfill({ status: 404, body: '' });
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('http://127.0.0.1:3000/admin/consignaciones/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByRole('button', { name: 'Nueva entrega', exact: true }).click();
    await page.getByLabel('Buscar cliente', { exact: true }).fill('Cliente Uno');
    await page.getByRole('button', { name: 'Cliente Uno', exact: true }).click();
    await page.getByLabel('Buscar producto', { exact: true }).fill('Cable');
    await page.getByRole('button', { name: /Cable USB · General/ }).click();
    await page.getByLabel('Cantidad de Cable USB').fill('6');
    await page.getByRole('button', { name: 'Registrar entrega y reservar' }).click();
    await page.getByRole('status').filter({ hasText: 'Entrega registrada' }).waitFor();
    const apiStock = async () => {
      const response = await context.request.get('http://127.0.0.1:8011/admin/products?ids=1');
      assert.equal(response.ok(), true);
      const [product] = await response.json();
      return [product.stock, product.consigned_stock, product.available_stock];
    };
    assert.deepEqual(await apiStock(), [10, 6, 4]);
    console.log('PASS delivery: general 10, consigned 6, available 4');
    await page.getByRole('link', { name: 'Emitir venta de esta consignación' }).click();
    await page.getByRole('button', { name: 'Agregar a la venta', exact: true }).click();
    // One unit is selected explicitly; no automatic sale of all pending stock.
    await page.getByLabel(/^Vendedor/).selectOption('1');
    await page.getByRole('button', { name: 'Emitir factura', exact: true }).click();
    await page.waitForURL(/\/admin\/comprobantes\/?\?created=/, { timeout: 60000 });
    assert.deepEqual(await apiStock(), [9, 5, 4]);
    console.log('PASS ordinary invoice from consignment: general 9, consigned 5, available 4');
    await page.goto('http://127.0.0.1:3000/admin/consignaciones/?q=USB-1');
    await page.getByRole('button', { name: 'Ver detalle', exact: true }).first().click();
    await page.getByLabel('Devolver Cable USB').fill('2');
    await page.getByRole('button', { name: 'Registrar devolución', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Devolución registrada' }).waitFor();
    assert.deepEqual(await apiStock(), [9, 3, 6]);
    console.log('PASS return and product search: general 9, consigned 3, available 6');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('heading', { name: 'Consignaciones', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile page must not overflow horizontally');
    await page.getByRole('button', { name: 'Nueva entrega', exact: true }).click();
    await page.getByLabel('Buscar cliente', { exact: true }).fill('Cliente Dos');
    await page.getByRole('button', { name: 'Cliente Dos', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log('PASS mobile layout and customer picker; no browser errors');
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
