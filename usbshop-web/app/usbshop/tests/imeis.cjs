// Serve the static export locally. All API requests are intercepted.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3012';
const imei = '356789012345678';
const product = { id: 1, name: 'Samsung A16', sku: 'SAM-A16', category_id: 1, category_name: 'Celulares', stock: 3, price: 1000, imeis: [imei] };
const warranty = { status: 'active', days: 30, expires_at: '2026-10-22T15:00:00Z' };
const invoice = { id: 10, customer_id: 1, customer_name: 'Cliente Uno', customer_phone: '1122334455', created_at: '2026-09-22T15:00:00Z', document_type: 'FACTURA', total: 1000, warranty };
const detail = { invoice, items: [{ id: 1, product_id: 1, product_name: product.name, quantity: 1, unit_price: 1000, line_total: 1000, imeis: [imei] }], payments: [], summary: { subtotal: 1000, total: 1000, payments_total: 0, balance_due: 1000 } };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    let sold = false;
    let submitted = null;
    let soldCustomer = 1;
    let invoicePosts = 0;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
      if (url.pathname === '/auth/me') return route.fulfill({ json: { id: 1, username: 'test', role: 'admin' } });
      if (url.pathname === '/admin/categories') return route.fulfill({ json: [{ id: 1, name: 'Celulares' }] });
      if (url.pathname === '/admin/products') return route.fulfill({ json: [product] });
      if (url.pathname === '/admin/dashboard') return route.fulfill({ json: { summary: { products: 1, active_customers: 2, stock_units: 2, sales_count: 1, sales_total: 1000, estimated_margin: 0, expenses_total: 0, cc_open_balance: 0 } } });
      if (url.pathname === '/admin/backoffice-customers') return route.fulfill({ json: [{ id: 1, name: 'Cliente Uno', phone: '1122334455', sale_mode: 'CONTADO' }] });
      if (url.pathname === '/admin/sellers') return route.fulfill({ json: [{ id: 1, name: 'Vendedor', is_active: true, commission_percent: 0 }] });
      if (url.pathname === '/admin/imei-lookup') return route.fulfill({ json: url.searchParams.get('q') !== imei ? { found: false, imei: url.searchParams.get('q'), status: 'unknown' } : {
        found: true, imei, is_own: true, status: sold ? 'sold' : 'available', product,
        sale: sold ? { invoice_id: 10, sold_at: invoice.created_at, customer_id: soldCustomer, customer_name: soldCustomer === 1 ? invoice.customer_name : 'Cliente Dos', customer_phone: invoice.customer_phone } : {},
        warranty: sold ? warranty : null, history: sold ? [invoice] : [],
      } });
      if (url.pathname === '/admin/invoices') {
        if (route.request().method() === 'POST') { invoicePosts++; submitted = route.request().postDataJSON(); sold = submitted.document_type !== 'NOTA_CREDITO'; return route.fulfill({ json: { id: 10 } }); }
        return route.fulfill({ json: sold ? [invoice] : [] });
      }
      if (url.pathname === '/admin/invoices/10') return route.fulfill({ json: detail });
      if (url.origin !== base) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(`${base}/admin/productos/nueva/`);
    await page.locator('select[name="category_id"]').selectOption('1');
    await page.getByLabel('Escanear IMEI de ingreso').fill(imei);
    await page.getByLabel('Escanear IMEI de ingreso').press('Enter');
    assert.equal(await page.locator('#imeis').inputValue(), imei);
    await page.getByLabel('Escanear IMEI de ingreso').fill(imei);
    await page.getByLabel('Escanear IMEI de ingreso').press('Enter');
    await page.getByRole('status').filter({ hasText: 'Este IMEI ya está cargado.' }).waitFor();
    assert.equal(await page.locator('#imeis').inputValue(), imei);
    console.log('PASS receipt scan appends once without submitting product form');

    await page.goto(`${base}/admin/generar-comprobante/`);
    await page.getByPlaceholder('Buscar cliente por nombre, mail, telefono o CUIT').fill('Cliente');
    await page.getByRole('button').filter({ hasText: 'Cliente Uno' }).click();
    await page.getByLabel(/^Vendedor/).selectOption('1');
    await page.getByPlaceholder('Buscar por nombre, SKU, codigo o ID').fill('Samsung');
    await page.getByRole('button', { name: 'Agregar', exact: true }).first().click();
    await page.getByRole('button', { name: 'Emitir factura', exact: true }).click();
    await page.getByText(/Escanea un IMEI por cada celular antes de emitir/).waitFor();
    assert.equal(submitted, null);
    await page.getByPlaceholder('Escanear IMEI 1').fill(imei);
    await page.getByPlaceholder('Escanear IMEI 1').press('Enter');
    await page.getByText('IMEIs cargados: 1/1', { exact: true }).waitFor();
    await page.getByRole('button', { name: `Quitar IMEI ${imei}` }).click();
    await page.getByText('IMEIs cargados: 0/1', { exact: true }).waitFor();
    await page.getByPlaceholder('Escanear IMEI 1').fill(imei);
    await page.getByPlaceholder('Escanear IMEI 1').press('Enter');
    await page.getByRole('button', { name: 'Emitir factura', exact: true }).click();
    await page.waitForURL(/created=10/);
    assert.deepEqual(submitted.items[0].imeis, [imei]);
    assert.equal(submitted.customer_id, 1);
    console.log('PASS sale requires IMEI, supports correcting scan, submits IMEI and customer');

    const popupPromise = page.waitForEvent('popup');
    await page.goto(`${base}/admin/comprobantes/imprimir/?invoice=10`);
    const popup = await popupPromise;
    await popup.getByText(`IMEI: ${imei}`, { exact: false }).waitFor();
    await popup.getByText(/Garantía comercial: 30 días. Vence:/).waitFor();
    await popup.close();
    console.log('PASS customer printout contains IMEI and warranty expiration');

    await page.goto(`${base}/admin/imeis/?q=${imei}`);
    await page.getByRole('heading', { name: 'Garantía comercial: Vigente' }).waitFor();
    await page.getByText('1122334455', { exact: true }).waitFor();
    assert.match(await page.getByRole('link', { name: 'Ver comprobante #10' }).getAttribute('href'), /^\/admin\/comprobantes\/?\?invoice=10$/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByLabel('IMEI del equipo').fill('111111111111111');
    await page.getByLabel('IMEI del equipo').press('Enter');
    await page.getByRole('heading', { name: 'IMEI no registrado' }).waitFor();
    assert.equal(await page.getByText('1122334455', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS lookup shows sale and warranty, works on mobile and clears stale results');

    await page.goto(`${base}/admin/`);
    await page.getByRole('heading', { name: 'Escritorio', exact: true }).waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.type(imei);
    await page.keyboard.press('Enter');
    const report = page.getByRole('dialog', { name: 'Informe del equipo escaneado' });
    await report.waitFor();
    await report.getByRole('heading', { name: 'Samsung A16', exact: true }).waitFor();
    await report.getByRole('heading', { name: 'Garantía comercial: Vigente' }).waitFor();
    assert.match(await report.innerText(), /Cliente Uno/);
    assert.match(await report.innerText(), /22\/09\/2026/);
    assert.equal(await report.getByRole('link', { name: 'Ver comprobante #10' }).getAttribute('target'), '_blank');
    assert.equal(await report.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'mobile report must not overflow');
    await report.getByRole('button', { name: 'Cerrar informe' }).click();
    assert.match(page.url(), /\/admin\/$/);
    assert.equal(invoicePosts, 1);
    console.log('PASS general scanner opens a read-only mobile report without navigating away');

    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(`${base}/admin/generar-comprobante/`);
    await page.getByPlaceholder('Buscar cliente por nombre, mail, telefono o CUIT').fill('Cliente');
    await page.getByRole('button').filter({ hasText: 'Cliente Uno' }).click();
    await page.getByPlaceholder('Buscar por nombre, SKU, codigo o ID').fill('Samsung');
    await page.getByRole('button', { name: 'Agregar', exact: true }).first().click();
    soldCustomer = 2;
    // Product options still advertise this IMEI as available: the lookup must win.
    await page.getByPlaceholder('Escanear IMEI 1').fill(imei);
    await page.getByPlaceholder('Escanear IMEI 1').press('Enter');
    await report.getByRole('status').filter({ hasText: 'no a Cliente Uno' }).waitFor();
    await report.getByRole('button', { name: 'Cerrar informe' }).click();
    await page.getByText('IMEIs cargados: 0/1', { exact: true }).waitFor();
    soldCustomer = 1;
    await page.getByPlaceholder('Buscar por nombre, SKU, codigo o ID').fill(imei);
    await page.getByPlaceholder('Buscar por nombre, SKU, codigo o ID').press('Enter');
    await report.getByRole('status').filter({ hasText: 'Este equipo corresponde al cliente seleccionado' }).waitFor();
    await page.keyboard.press('Escape');
    await report.waitFor({ state: 'detached' });
    await page.getByText('IMEIs cargados: 0/1', { exact: true }).waitFor();
    assert.equal(invoicePosts, 1, 'consulting a sold phone must not create another sale or return');
    assert.deepEqual(errors, []);
    console.log('PASS sold-device report compares customers and preserves invoice draft without assigning sold IMEI');

    // A multi-device sale with a discount must return just the scanned unit at its original price.
    detail.invoice.seller_id = 1;
    detail.invoice.special_discount = 100;
    detail.items[0].quantity = 2;
    detail.items[0].imeis.push('356789012345679');
    await page.getByPlaceholder('Buscar por nombre, SKU, codigo o ID').fill(imei);
    await page.getByPlaceholder('Buscar por nombre, SKU, codigo o ID').press('Enter');
    await report.waitFor();
    const returnPopupPromise = page.waitForEvent('popup');
    await report.getByRole('link', { name: 'Devolver al stock', exact: true }).click();
    const returnPage = await returnPopupPromise;
    returnPage.on('pageerror', error => errors.push(error.message));
    await returnPage.getByLabel('Motivo de devolución').selectOption({ label: 'Facturado por error' });
    await returnPage.getByText('IMEIs cargados: 1/1', { exact: true }).waitFor();
    assert.equal(await returnPage.getByLabel(/^Vendedor/).inputValue(), '1');
    assert.equal(invoicePosts, 1, 'opening the return must not change stock');
    await returnPage.getByRole('button', { name: 'Emitir nota de crédito', exact: true }).click();
    await returnPage.waitForURL(/created=10/);
    assert.equal(submitted.document_type, 'NOTA_CREDITO');
    assert.equal(submitted.expected_sale_invoice_id, 10);
    assert.equal(submitted.customer_id, 1);
    assert.equal(submitted.items.length, 1);
    assert.equal(submitted.items[0].quantity, 1);
    assert.equal(submitted.items[0].unit_price, 1000);
    assert.deepEqual(submitted.items[0].imeis, [imei]);
    assert.equal(submitted.special_discount, 50);
    assert.match(submitted.notes, /Facturado por error.*Venta original #10/);
    await report.getByRole('button', { name: 'Cerrar informe' }).click();
    await page.getByText('IMEIs cargados: 0/1', { exact: true }).waitFor();
    await returnPage.goto(`${base}/admin/imeis/?q=${imei}`);
    await returnPage.getByText('Disponible', { exact: true }).waitFor();
    assert.equal(await returnPage.getByRole('link', { name: 'Devolver al stock', exact: true }).count(), 0);
    await returnPage.goto(`${base}/admin/generar-comprobante/?return_imei=${imei}&return_invoice_id=10`);
    await returnPage.getByText(/Este equipo ya no tiene esa venta vigente/).waitFor();
    assert.equal(await returnPage.getByRole('button', { name: 'Emitir nota de crédito', exact: true }).count(), 0);
    assert.equal(invoicePosts, 2);
    assert.deepEqual(errors, []);
    await returnPage.close();
    console.log('PASS return preloads one IMEI and original discount, preserves draft, requires confirmation and rejects stale links');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
