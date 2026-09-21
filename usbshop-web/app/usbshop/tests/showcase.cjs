// Serve the static export on 3010. These tests never contact production.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3010';
const products = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1, name: `Vidriera ${index + 1}`, sku: `SKU-${index + 1}`,
  stock: index === 0 ? 0 : 5, available_stock: index === 0 ? 0 : 5,
  is_active: true, price: 100, category: 'Cables',
}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let saved = null;
    let failSave = true;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
      if (url.pathname === '/auth/me') return route.fulfill({ json: { id: 1, username: 'test', role: 'admin' } });
      if (url.pathname === '/admin/showcase') {
        if (route.request().method() === 'PUT') {
          if (failSave) return route.fulfill({ status: 409, json: { detail: 'Error de prueba: volvé a guardar' } });
          saved = route.request().postDataJSON().product_ids;
        }
        return route.fulfill({ json: { selected: saved ? saved.map(id => products[id - 1]) : [], legacy_count: saved ? 0 : 100, max_featured: 8 } });
      }
      if (url.pathname === '/admin/products') return route.fulfill({ json: products });
      if (url.pathname === '/products') return route.fulfill({ json: products });
      if (url.pathname === '/categories') return route.fulfill({ json: [] });
      if (url.pathname === '/featured') return route.fulfill({ json: saved ? saved.filter(id => products[id - 1].stock > 0).map(id => products[id - 1]) : [] });
      if (url.pathname === '/storefront/collections') return route.fulfill({ json: { new_arrivals: [products[8]], restocked: [products[9]] } });
      if (url.origin !== base) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/admin/vidriera/`);
    await page.getByText(/Hay 100 productos con la marca anterior/).waitFor();
    for (let index = 0; index < 8; index++) {
      await page.getByRole('button', { name: 'Agregar', exact: true }).first().click();
    }
    await page.getByRole('heading', { name: 'Destacados · 8 de 8', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Agregar', exact: true }).first().isDisabled());
    await page.getByRole('button', { name: 'Subir Vidriera 2', exact: true }).click();
    await page.getByRole('button', { name: 'Guardar Vidriera', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Error de prueba' }).waitFor();
    assert.equal(saved, null);
    failSave = false;
    await page.getByRole('button', { name: 'Guardar Vidriera', exact: true }).click();
    await page.getByText('Vidriera guardada.', { exact: false }).waitFor();
    assert.deepEqual(saved, [2, 1, 3, 4, 5, 6, 7, 8]);
    await page.getByText('SKU: SKU-1 · Pausado: sin disponibilidad', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.goto(`${base}/`);
    await page.locator('#novedades .product-card').getByText('Vidriera 9', { exact: true }).waitFor();
    await page.locator('#reposiciones .product-card').getByText('Vidriera 10', { exact: true }).waitFor();
    assert.equal(await page.locator('#featured-grid .product-card').count(), 4);
    const firstWindow = await page.locator('#featured-grid .product-card h3').allTextContents();
    assert.deepEqual(firstWindow, ['Vidriera 2', 'Vidriera 3', 'Vidriera 4', 'Vidriera 5']);
    await page.waitForTimeout(8200);
    const secondWindow = await page.locator('#featured-grid .product-card h3').allTextContents();
    assert.notDeepEqual(secondWindow, firstWindow);
    saved = [];
    await page.reload();
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#featured-grid .product-card').count(), 0, 'empty curation must not fall back to random products');
    assert.deepEqual(errors, []);
    console.log('PASS showcase limit, reorder, failed save retry, paused item, mobile layout, automatic sections, rotation and empty selection');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
