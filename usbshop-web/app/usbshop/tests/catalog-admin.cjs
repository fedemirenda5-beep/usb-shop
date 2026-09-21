// Serve the static build on port 3010. All API responses are isolated fixtures.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3010';
const products = Array.from({ length: 225 }, (_, index) => ({
  id: index + 1, name: `Producto ${String(index + 1).padStart(3, '0')}`,
  category: index >= 200 ? 'Categoria final' : 'Cables', price: 1000, stock: 10,
  is_featured: index === 0,
}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const requests = [];
    let failSecondPage = true;
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: {
        apiBaseUrl: 'http://127.0.0.1:8000',
      } });
      if (url.pathname === '/products') {
        requests.push(url);
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 50);
        if (offset === 100 && failSecondPage) return route.fulfill({ status: 503, json: { detail: 'temporary' } });
        return route.fulfill({ json: products.slice(offset, offset + limit) });
      }
      if (url.pathname === '/featured') return route.fulfill({ json: products.slice(0, 1) });
      if (url.pathname === '/categories') return route.fulfill({ json: [
        { id: 1, name: 'Cables', product_count: 200 },
        { id: 2, name: 'Categoria final', product_count: 25 },
      ] });
      if (url.origin !== base) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${base}/?categoria=Categoria%20final`);
    await page.getByRole('button', { name: 'Reintentar', exact: true }).waitFor();
    assert(requests.some((url) => url.searchParams.get('offset') === '100'));
    failSecondPage = false;
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await page.locator('#featured-grid .product-card').first().waitFor();
    await page.getByRole('button', { name: 'Mostrar mas', exact: true }).waitFor();
    assert.equal(await page.locator('#featured-grid .product-card').count(), 12);
    await page.getByRole('button', { name: 'Mostrar mas', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#featured-grid .product-card').length === 24);
    await page.getByRole('button', { name: 'Mostrar mas', exact: true }).click();
    await page.getByText('Producto 225', { exact: true }).first().waitFor();
    assert.equal(await page.locator('#featured-grid .product-card').count(), 25);
    assert(requests.every((url) => url.origin === 'http://127.0.0.1:8000'), 'runtime config controls requests');
    console.log('PASS category pagination, partial failure, retry, bounded rendering, runtime config');

    await page.getByRole('button', { name: 'Volver al inicio', exact: true }).click();
    await page.getByRole('button', { name: 'Ver catalogo completo', exact: true }).first().click();
    await page.locator('#catalogo-grid .product-card').first().waitFor();
    assert.equal(await page.locator('#catalogo-grid .product-card').count(), 12);
    assert(await page.locator('#catalogo-grid').getByText('Producto 002', { exact: true }).count(), 'unfeatured products remain in catalog');
    console.log('PASS full catalog includes unfeatured products');

    const search = page.locator('input[type="search"], input[placeholder*="Buscar"]').first();
    await search.fill('SKU-ONLY');
    await page.waitForFunction(() => document.querySelectorAll('#resultados .product-card').length === 12);
    // Server search results may match SKU/description, even when the title does not.
    while (await page.getByRole('button', { name: 'Mostrar mas', exact: true }).count()) {
      await page.getByRole('button', { name: 'Mostrar mas', exact: true }).click();
    }
    await page.getByText('Producto 225', { exact: true }).first().waitFor();
    assert(requests.some((url) => url.searchParams.get('q') === 'SKU-ONLY' && Number(url.searchParams.get('offset')) >= 192));
    console.log('PASS search beyond 48 results and server-only matches');
    await context.close();

    const admin = await browser.newContext();
    const user = { id: 1, username: 'test-admin', role: 'admin' };
    await admin.addInitScript((user) => {
      localStorage.setItem('usbshop_admin_session_v1', JSON.stringify({ user }));
    }, user);
    let sessionStatus = 503;
    let adminRequests = 0;
    let expireOnAdminRequest = false;
    let successfulSessionChecks = 0;
    await admin.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
      if (url.pathname === '/auth/me') {
        if (sessionStatus === 200) successfulSessionChecks++;
        return route.fulfill({ status: sessionStatus, json: sessionStatus === 200 ? user : { detail: 'unavailable' } });
      }
      if (url.origin === 'http://127.0.0.1:8000' && url.pathname.startsWith('/admin/')) {
        adminRequests++;
        if (expireOnAdminRequest) sessionStatus = 401;
        return route.fulfill({ status: 401, json: { detail: 'expired' } });
      }
      if (url.pathname === '/auth/users') return route.fulfill({ json: [] });
      if (url.origin !== base) return route.abort();
      return route.continue();
    });
    const adminPage = await admin.newPage();
    await adminPage.goto(`${base}/admin/`);
    await adminPage.getByRole('button', { name: 'Reintentar conexion', exact: true }).waitFor();
    assert.equal(adminRequests, 0, 'do not load protected sections before session verification');
    sessionStatus = 200;
    await adminPage.getByRole('button', { name: 'Reintentar conexion', exact: true }).click();
    await adminPage.getByText('No se pudo cargar el escritorio', { exact: true }).waitFor();
    await adminPage.waitForTimeout(1000);
    assert(successfulSessionChecks >= 2, '401 rechecks the actual session');
    assert.equal(adminRequests, 1, 'an endpoint permission error must not cause a remount/request loop');
    expireOnAdminRequest = true;
    await adminPage.reload();
    await adminPage.waitForURL('**/login/**');
    assert.equal(adminRequests, 2);
    assert.equal(await adminPage.evaluate(() => localStorage.getItem('usbshop_admin_session_v1')), null);
    console.log('PASS unavailable session retry and expired admin session redirect');
    await admin.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
