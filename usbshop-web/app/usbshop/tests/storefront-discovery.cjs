// Run against a local build with simulated API responses; no real orders.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3016';
const products = Array.from({ length: 210 }, (_, i) => ({
  id: i + 1, name: `Producto ${i + 1}`, category: ['Audio', 'Hogar', 'Cables', 'Juguetes'][i % 4],
  price: 1000, stock: i > 10 && i % 17 === 0 ? 0 : 10, imageUrl: '/logo-small.jpeg',
}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of (process.env.TEST_WIDTH ? [Number(process.env.TEST_WIDTH)] : [1366, 390])) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      let fail = false;
      const discoveryRequests = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
        if (url.pathname === '/products') {
          if (url.searchParams.get('sort') === 'discover') {
            discoveryRequests.push(url);
            if (fail) return route.fulfill({ status: 503, json: {} });
          }
          const ids = url.searchParams.get('ids')?.split(',').map(Number);
          const query = url.searchParams.get('q');
          const items = ids ? products.filter(p => ids.includes(p.id)) : query ? products.filter(p => p.name === query) : products;
          const offset = Number(url.searchParams.get('offset') || 0);
          return route.fulfill({ json: items.slice(offset, offset + Number(url.searchParams.get('limit') || 50)) });
        }
        if (url.pathname === '/featured') return route.fulfill({ json: products.slice(0, 10) });
        if (url.pathname === '/categories') return route.fulfill({ json: ['Audio', 'Hogar', 'Cables', 'Juguetes'].map((name, i) => ({ id: i + 1, name })) });
        if (url.pathname === '/storefront/collections') return route.fulfill({ json: { new_arrivals: products.slice(0, 4), restocked: products.slice(2, 6) } });
        if (url.origin !== base) return route.fulfill({ json: [] });
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      const discovery = page.locator('#descubri-productos');
      await discovery.locator('.product-card:not(.product-skeleton)').first().waitFor();
      const names = area => area.locator('.product-title').allTextContents();
      const first = await names(discovery);
      assert.equal(first.length, 8);
      assert.ok(discoveryRequests[0].searchParams.has('seed'));
      assert(await page.locator('#catalogo').isVisible(), 'Full catalog is visible by default');
      const curatedNames = await names(page.locator('#novedades, #reposiciones, #destacados, #ofertas, #bajaron-de-precio, #descubri-productos'));
      assert.equal(new Set(curatedNames).size, curatedNames.length, 'Promoted sections do not repeat products');
      const categories = await discovery.locator('.product-meta > span').allTextContents();
      assert.ok(new Set(categories).size > 1);
      if (process.env.SCREENSHOT_DIR) {
        await discovery.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/storefront-discovery-${width}.png` });
      }
      await discovery.getByRole('button', { name: 'Agregar', exact: true }).first().click();
      assert.deepEqual(await names(discovery), first, 'Adding to cart keeps the selection stable');
      await discovery.getByRole('button', { name: 'Ver otros', exact: true }).click();
      await page.waitForFunction(previous => {
        const current = [...document.querySelectorAll('#descubri-productos .product-title')].map(el => el.textContent);
        return current.length === 8 && current.every(name => !previous.includes(name));
      }, first);
      const second = await names(discovery);
      assert.ok(second.every(name => !first.includes(name)));
      const seed = discoveryRequests[0].searchParams.get('seed');
      const seen = new Set([...first, ...second]);
      // Cross the server page boundary, retry a failed read, then continue.
      for (let i = 0; i < 8; i++) {
        await discovery.getByRole('button', { name: 'Ver otros', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#descubri-productos .product-grid').getAttribute('aria-busy') === 'false');
        for (const name of await names(discovery)) { assert.ok(!seen.has(name)); seen.add(name); }
      }
      const beforeError = await names(discovery);
      fail = true;
      await discovery.getByRole('button', { name: 'Ver otros', exact: true }).click();
      await discovery.getByRole('alert').waitFor();
      assert.deepEqual(await names(discovery), beforeError, 'A failed request preserves the current selection');
      fail = false;
      await discovery.getByRole('button', { name: 'Reintentar', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#descubri-productos [role=alert]'));
      assert.ok((await names(discovery)).every(name => !seen.has(name)));
      assert.ok(discoveryRequests.every(url => url.searchParams.get('seed') === seed));
      const current = await names(discovery);
      await page.getByRole('button', { name: 'Audio', exact: true }).click();
      await page.locator('#selected-category-results .product-card').first().waitFor();
      assert.equal(await discovery.isVisible(), false);
      await page.getByRole('button', { name: 'Volver al inicio', exact: true }).click();
      assert.deepEqual(await names(discovery), current, 'Returning from a category keeps the selection');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}px`);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: visible catalog, diverse sections, stable cart, discovery pagination, retry and categories`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
