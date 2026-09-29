// Search UI contract: API order, server-only matches, cancellation and pagination.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3017';
const car = { id: 6427, name: 'Auto acrobático', sku: '828A', category: 'Juguetes', stock: 6, price: 100 };
const holder = { ...car, id: 101, name: 'Soporte para auto', category: 'Accesorios', stock: 0 };
const many = Array.from({ length: 105 }, (_, index) => ({ ...car, id: index + 1, name: `Resultado ${index + 1}` }));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const routePath of ['/', '/catalog']) {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
        const requests = [];
        let fail = false;
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
          if (url.pathname === '/products') {
            requests.push(url);
            const query = url.searchParams.get('q');
            const offset = Number(url.searchParams.get('offset') || 0);
            const limit = Number(url.searchParams.get('limit') || 50);
            if (query === 'error' && fail) return route.fulfill({ status: 503, json: {} });
            const items = query === 'muchos' ? many : query === '828A' ? [car] : query === 'acrobatcio' ? [{ ...car, search_match: 'approximate' }]
              : query === 'zzzzzzzz' ? [] : [car, holder];
            return route.fulfill({ json: items.slice(offset, offset + limit) });
          }
          if (url.pathname === '/categories') return route.fulfill({ json: [{ id: 1, name: 'Accesorios' }, { id: 2, name: 'Juguetes' }] });
          if (url.pathname === '/featured') return route.fulfill({ json: [holder] });
          if (url.pathname === '/storefront/collections') return route.fulfill({ json: { new_arrivals: [], restocked: [] } });
          if (url.origin !== new URL(base).origin) return route.fulfill({ json: [] });
          return route.continue();
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}${routePath}`);
        const search = page.locator('input[type="search"]').first();
        const cards = page.locator(routePath === '/' ? '#resultados .product-card' : '.product-grid .product-card');
        await search.fill('auto');
        await search.press('Enter');
        await cards.filter({ hasText: car.name }).waitFor();
        assert((await cards.first().innerText()).includes(car.name), 'preserve relevance over category order');
        await search.fill('828A');
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1,
          routePath === '/' ? '#resultados .product-card' : '.product-grid .product-card');
        assert((await cards.first().innerText()).includes(car.name), 'SKU matches must survive rendering');
        await search.fill('acrobatcio');
        await page.getByText(/nombres similares/).waitFor();
        await cards.filter({ hasText: car.name }).waitFor();
        await search.fill('zzzzzzzz');
        await page.getByText(/No encontramos.*zzzzzzzz/).waitFor();
        assert.equal(await cards.count(), 0);
        await search.fill('muchos');
        await cards.first().waitFor();
        await page.waitForTimeout(400);
        const firstPageRequests = requests.filter(url => url.searchParams.get('q') === 'muchos');
        assert(firstPageRequests.every(url => Number(url.searchParams.get('offset')) === 0), 'do not download all search pages eagerly');
        while (await page.getByRole('button', { name: 'Mostrar mas', exact: true }).count()) {
          const more = page.getByRole('button', { name: 'Mostrar mas', exact: true });
          await more.click();
          await page.waitForTimeout(100);
        }
        await cards.filter({ hasText: 'Resultado 105' }).waitFor();
        assert.equal(await cards.count(), 105);
        if (!mobile) {
          fail = true;
          await search.fill('error');
          await page.getByRole('button', { name: 'Reintentar', exact: true }).waitFor({ timeout: 45000 });
          fail = false;
          await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
          await cards.filter({ hasText: car.name }).waitFor();
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${routePath} ${mobile ? 'mobile' : 'desktop'} relevance, SKU, suggestions, empty state, pagination and retry`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
