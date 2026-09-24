// Static build, isolated API fixtures; no real sales are created.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3016';
const products = [344, 1, 0, undefined].map((soldCount, i) => ({
  id: 910001 + i, name: `Cargador ${i + 1}`, category: 'Cargadores',
  price: 1000, stock: 5, soldCount, imageUrl: '/icons/headphones.svg',
}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
        if (url.pathname === '/products') return route.fulfill({ json: products });
        if (url.pathname === '/categories') return route.fulfill({ json: [] });
        if (url.pathname === '/featured') return route.fulfill({ json: [] });
        if (url.pathname === '/storefront/collections') return route.fulfill({ json: { new_arrivals: products, restocked: [] } });
        if (url.origin !== base) return route.abort();
        return route.continue();
      });
      await page.goto(base);
      const cards = page.locator('#novedades .product-card');
      await cards.first().getByText('344 vendidos', { exact: true }).waitFor();
      await cards.nth(1).getByText('1 vendido', { exact: true }).waitFor();
      assert.equal(await cards.nth(2).locator('.product-sold-count').count(), 0);
      assert.equal(await cards.nth(3).locator('.product-sold-count').count(), 0);
      const fits = await cards.first().evaluate(card => {
        const media = card.querySelector('.product-media').getBoundingClientRect();
        const badge = card.querySelector('.product-sold-count').getBoundingClientRect();
        return badge.left >= media.left && badge.right <= media.right && badge.bottom <= media.bottom;
      });
      assert(fits, 'sold badge stays inside the photo');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      console.log(`PASS ${width}px: sold units, singular, hidden empty counts, badge placement`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
