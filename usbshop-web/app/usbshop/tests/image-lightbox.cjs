// Serve out locally; all API and product image responses are intercepted.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3012';
const product = {
  id: 900001, name: 'Equipo de prueba', category: 'Celulares', price: 100, stock: 3,
  imageUrl: 'https://images.invalid/portrait.svg',
  imageUrls: ['https://images.invalid/portrait.svg', 'https://images.invalid/landscape.svg'],
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
      if (url.pathname === '/products') return route.fulfill({ json: [product] });
      if (url.pathname === '/categories') return route.fulfill({ json: [{ id: 1, name: 'Celulares', product_count: 1 }] });
      if (url.pathname === '/featured') return route.fulfill({ json: [] });
      if (url.pathname === '/storefront/collections') return route.fulfill({ json: { new_arrivals: [], restocked: [] } });
      if (url.hostname === 'images.invalid' || /\/products\/\d+\/image$/.test(url.pathname)) {
        const landscape = url.pathname.includes('landscape');
        return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${landscape ? 3600 : 2400}" height="${landscape ? 1800 : 3200}"><rect width="100%" height="100%" fill="#93d82d"/></svg>` });
      }
      if (url.origin !== base) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 600 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/?categoria=Celulares`);
      await page.getByRole('button', { name: 'Ver detalle', exact: true }).first().click();
      await page.locator('.modal-media-image').dblclick();
      const dialog = page.getByRole('dialog', { name: `Imagen ampliada de ${product.name}` });
      await dialog.waitFor();
      for (let imageIndex = 0; imageIndex < 2; imageIndex++) {
        const img = dialog.locator('img');
        await img.evaluate(node => node.decode());
        const rect = await img.boundingBox();
        assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1,
          `image must fit ${JSON.stringify(viewport)}: ${JSON.stringify(rect)}`);
        assert(Math.abs(rect.x + rect.width / 2 - viewport.width / 2) <= 1, 'image centered horizontally');
        assert(Math.abs(rect.y + rect.height / 2 - viewport.height / 2) <= 1, 'image centered vertically');
        const close = await dialog.getByRole('button', { name: 'Cerrar imagen', exact: true }).boundingBox();
        assert(close.x >= 0 && close.y >= 0 && close.x + close.width <= viewport.width && close.y + close.height <= viewport.height);
        if (imageIndex === 0) await dialog.getByRole('button', { name: 'Imagen siguiente', exact: true }).click();
      }
      await dialog.getByRole('button', { name: 'Cerrar imagen', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.locator('.modal-media-image').dblclick();
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.getByRole('dialog', { name: `Detalle de ${product.name}` }).waitFor();
      console.log(`PASS centered full-size images and close controls at ${viewport.width}x${viewport.height}`);
    }
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
