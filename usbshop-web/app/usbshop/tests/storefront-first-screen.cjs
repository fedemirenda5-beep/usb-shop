// Run against the local static export; all API responses are simulated.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3016';
const categories = ['Audio', 'Cables', 'Cargadores', 'Celulares', 'Accesorios', 'Gaming', 'Hogar', 'Juguetes', 'Memorias', 'Soportes', 'Tablets'];
const products = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1, name: `Producto ${index + 1}`, category: categories[index % 2],
  price: 12000, stock: 10, imageUrl: '/logo-small.jpeg',
}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1366, 768, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 768 } });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
        if (url.pathname === '/products' || url.pathname === '/featured') return route.fulfill({ json: products });
        if (url.pathname === '/categories') return route.fulfill({ json: categories.map((name, index) => ({ id: index + 1, name, product_count: 4 })) });
        if (url.pathname === '/storefront/collections') return route.fulfill({ json: { new_arrivals: products.slice(0, 4), restocked: [] } });
        if (url.origin !== base) return route.fulfill({ json: [] });
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      const card = page.locator('#novedades .product-card').first();
      await card.waitFor();
      const photo = await card.locator('.product-media').boundingBox();
      const price = await card.locator('.product-price').last().boundingBox();
      assert(photo.y < 300, `At ${width}px products start at ${photo.y}px`);
      assert(price.y + price.height < 768, `At ${width}px the price must be in the first screen`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}px`);
      const chips = await page.locator('.category-chip').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
      assert(chips.every(top => Math.abs(top - chips[0]) < 2), 'Categories must stay on one row');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/storefront-${width}.png` });
      await page.getByRole('button', { name: 'Audio', exact: true }).click();
      await page.locator('#selected-category-results .product-card').first().waitFor();
      assert.equal(await page.getByRole('button', { name: 'Audio', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.goto(base);
      await page.locator('#novedades .product-card').first().waitFor();
      await page.getByRole('button', { name: /^Carrito/ }).click();
      await page.getByRole('dialog', { name: 'Carrito', exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: product photo at ${Math.round(photo.y)}px, price visible, one category row, filtering and cart`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
