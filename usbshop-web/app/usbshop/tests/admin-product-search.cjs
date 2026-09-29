// Mocked API: no real inventory, sessions or invoices are changed.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3017';
const car = { id: 6427, name: 'Auto acrobático 4x4 con control', sku: '828A', barcode: '123456', stock: 6, price: 100, cost: 50, category_id: 1, is_active: true };
const holder = { ...car, id: 101, name: 'Soporte para auto', sku: 'SOPORTE', stock: 0 };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let oldRequestStarted;
    let releaseOldRequest;
    const oldStarted = new Promise(resolve => { oldRequestStarted = resolve; });
    const oldReleased = new Promise(resolve => { releaseOldRequest = resolve; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
      if (url.pathname === '/auth/me') return route.fulfill({ json: { id: 1, username: 'test', role: 'admin' } });
      if (url.pathname === '/admin/products') {
        const query = url.searchParams.get('q') || '';
        if (query === 'varios') return route.fulfill({ json: Array.from({ length: 13 }, (_, index) => ({ ...car, id: index + 1, name: `Producto ${index + 1}` })).slice(0, Number(url.searchParams.get('limit'))) });
        if (query === 'soporte') {
          oldRequestStarted();
          await oldReleased;
          return route.fulfill({ json: [holder] });
        }
        const rows = query === '828A' || query.includes('acrobatico') ? [car] : [car, holder];
        return route.fulfill({ json: url.searchParams.has('out_of_stock_only') ? [holder] : rows });
      }
      if (url.pathname === '/admin/categories') return route.fulfill({ json: [{ id: 1, name: 'Juguetes' }] });
      if (url.origin === 'http://127.0.0.1:8000') return route.fulfill({ json: [] });
      if (url.origin !== new URL(base).origin) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${base}/admin/productos`);
    const search = page.getByPlaceholder('Buscar por nombre, SKU, codigo, rubro o descripcion...');
    await search.fill('auto');
    await page.getByText(car.name, { exact: true }).first().waitFor();
    await search.press('Enter');
    await page.waitForTimeout(600);
    assert.equal(await search.inputValue(), 'auto', 'Enter preserves a text search');
    assert(!page.url().includes('edit='));
    assert.equal(await page.getByText('No existe un producto', { exact: false }).count(), 0);
    await search.fill('acrobatico auto');
    await page.getByText('1 productos en esta pagina', { exact: false }).waitFor();
    await page.getByText(car.name, { exact: true }).first().waitFor();
    await search.fill('828A');
    await search.press('Enter');
    await page.waitForURL('**/*edit=6427');
    console.log('PASS text Enter, multiword search and exact SKU navigation');

    await page.goto(`${base}/admin/generar-comprobante`);
    // The product field names SKU in its placeholder, unlike customer search.
    const productSearch = page.locator('input[placeholder*="SKU"]');
    await productSearch.fill('soporte');
    await oldStarted;
    await productSearch.fill('acrobatico auto');
    await page.getByText(car.name, { exact: true }).first().waitFor();
    releaseOldRequest();
    await page.waitForTimeout(500);
    assert.equal(await page.getByText(car.name, { exact: true }).count(), 1, 'stale response cannot replace current matches');
    assert.equal(await page.getByText(holder.name, { exact: true }).count(), 0);
    console.log('PASS invoice preserves server matches and ignores stale responses');
    await productSearch.press('ArrowDown');
    assert.equal(await page.locator('#invoice-product-options').getByRole('option', { selected: true }).count(), 1);
    await productSearch.press('Enter');
    assert.equal(await productSearch.inputValue(), '');
    await page.getByText(car.name, { exact: true }).first().waitFor();
    await productSearch.fill('auto');
    await productSearch.press('Escape');
    assert.equal(await productSearch.inputValue(), '');
    console.log('PASS keyboard selection and Escape');
    await productSearch.fill('123456');
    await productSearch.press('Enter');
    await page.waitForTimeout(500);
    const quantity = page.locator('tbody tr').filter({ hasText: car.name }).locator('input[type="number"]').first();
    assert.equal(await quantity.inputValue(), '2', 'Enter plus the scanner timer must add exactly one unit');
    await productSearch.fill('varios');
    await page.getByRole('button', { name: 'Mostrar más coincidencias' }).click();
    await page.getByRole('option', { name: /Producto 13/ }).waitFor();
    assert.equal(await page.locator('#invoice-product-options [role="option"]').count(), 13);
    console.log('PASS scanner Enter adds once and additional invoice results remain reachable');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
