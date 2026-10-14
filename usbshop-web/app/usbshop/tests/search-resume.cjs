// Local browser regression: every API call is simulated; no real sales are made.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3020';
const product = { id: 704, name: 'Holder para auto rejilla', sku: 'HD-710', price: 100, cost: 50,
  stock: 3, category: 'Accesorios', category_id: 1, is_active: true, imageUrl: null };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1366, 390]) {
      for (const path of ['/', '/catalog/', '/admin/productos/', '/admin/generar-comprobante/']) {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        let searches = 0, release;
        const suspended = new Promise(resolve => { release = resolve; });
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
          if (url.pathname === '/auth/me') return route.fulfill({ json: { id: 1, username: 'test', role: 'admin' } });
          if (['/products', '/admin/products'].includes(url.pathname)) {
            if (url.searchParams.get('q') === 'holder' && ++searches === 1) await suspended;
            return route.fulfill({ json: [product] }).catch(() => {});
          }
          if (url.pathname === '/featured') return route.fulfill({ json: [] });
          if (url.pathname === '/storefront/collections') return route.fulfill({ json: { new_arrivals: [], restocked: [] } });
          if (['/categories', '/admin/categories'].includes(url.pathname)) return route.fulfill({ json: [{ id: 1, name: 'Accesorios' }] });
          if (url.origin !== base) return route.fulfill({ json: [] });
          return route.continue();
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}${path}`);
        const search = path === '/admin/generar-comprobante/'
          ? page.locator('input[placeholder*="SKU"]')
          : path === '/admin/productos/' ? page.getByPlaceholder('Buscar por nombre, SKU, codigo, rubro o descripcion...')
          : page.locator('input[type="search"]').first();
        if (path === '/admin/generar-comprobante/') {
          await search.fill('HD-710');
          await page.locator('#invoice-product-options').getByRole('option').first().waitFor();
          await search.press('ArrowDown');
          await search.press('Enter');
          await page.locator('tbody tr').filter({ hasText: product.name }).waitFor();
        }
        await search.fill('holder');
        await page.waitForRequest(request => new URL(request.url()).searchParams.get('q') === 'holder');
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          const originalNow = Date.now;
          Date.now = () => originalNow() + 60000;
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('focus'));
        });
        const result = path === '/' ? page.locator('#resultados .product-card').filter({ hasText: product.name })
          : path === '/catalog/' ? page.locator('.product-grid .product-card').filter({ hasText: product.name })
          : path === '/admin/generar-comprobante/' ? page.getByRole('option').filter({ hasText: product.name })
          : page.getByText(product.name, { exact: true }).first();
        await result.first().waitFor({ timeout: 10000 });
        assert(searches >= 2, 'wake must replace the stalled search');
        assert.equal(await search.inputValue(), 'holder');
        if (path === '/admin/generar-comprobante/') {
          const row = page.locator('tbody tr').filter({ hasText: product.name });
          assert.equal(await row.count(), 1, 'resume must preserve the sale draft');
          assert.equal(await row.locator('input[type="number"]').first().inputValue(), '1');
        }
        release();
        await page.waitForTimeout(100);
        assert.deepEqual(errors, []);
        console.log(`PASS ${width}px ${path}: stalled holder search resumes and preserves input/draft`);
        await context.close();
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
