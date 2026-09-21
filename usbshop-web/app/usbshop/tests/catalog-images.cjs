// Run against the static export on port 3010. All network traffic is isolated.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3010';
const products = Array.from({ length: 24 }, (_, index) => ({
  id: 900001 + index, name: `Cargador ${index + 1}`, category: 'Cargadores', price: 100, stock: 5,
  imageUrl: `https://images.invalid/original-${index + 1}.jpg`,
}));
const firstRow = new Set(products.slice(-4).map(product => product.id));
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHn8AAAAASUVORK5CYII=', 'base64');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const imageRequests = [];
    const originals = [];
    const started = new Set();
    let noveltyMode = false;
    let releaseSlowImage;
    const slowImage = new Promise(resolve => { releaseSlowImage = resolve; });
    let release;
    const firstRowStarted = new Promise(resolve => { release = resolve; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
      if (url.pathname === '/products') return route.fulfill({ json: Number(url.searchParams.get('offset')) > 0 ? [] : products });
      if (url.pathname === '/categories') return route.fulfill({ json: [{ id: 1, name: 'Cargadores', product_count: 24 }] });
      if (url.pathname === '/featured') return route.fulfill({ json: [] });
      if (url.pathname === '/storefront/collections') return route.fulfill({ json: { new_arrivals: noveltyMode ? products.slice(-2) : [], restocked: [] } });
      if (url.hostname === 'images.invalid') {
        originals.push(url.href);
        return route.fulfill({ contentType: 'image/png', body: pixel });
      }
      const match = url.pathname.match(/^\/products\/(\d+)\/image$/);
      if (match) {
        const id = Number(match[1]);
        if (noveltyMode && id === 900024) return route.fulfill({ status: 503, body: 'unavailable' });
        if (noveltyMode && id === 900023) await slowImage;
        if (id >= 900001) {
          imageRequests.push({ id, url });
          if (firstRow.has(id)) {
            started.add(id);
            if (started.size === 4) release();
            // No first-row image may finish before all four have started.
            await firstRowStarted;
          }
        }
        return route.fulfill({ contentType: 'image/png', body: pixel });
      }
      if (url.origin !== base) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${base}/?categoria=Cargadores`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('#featured-grid .product-image')].slice(0, 4);
      return images.length === 4 && images.every(image => image.fetchPriority === 'high' && image.loading === 'eager' && image.complete && image.naturalWidth > 0);
    });
    assert.equal(started.size, 4);
    assert.equal(originals.length, 0, 'do not start a second download of the full-size originals');
    for (const id of firstRow) assert.equal(imageRequests.filter(request => request.id === id).length, 1, 'one stable thumbnail request per first-row image');
    assert(imageRequests.every(request => request.url.searchParams.get('w') === '420'));
    assert.equal(await page.locator('#featured-grid .product-card').count(), 12, 'keep catalog rendering bounded');
    console.log('PASS first row downloads concurrently, uses only thumbnails and retains bounded rendering');
    noveltyMode = true;
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#novedades').getByRole('heading', { name: 'Novedades', exact: true }).waitFor();
    const delayed = page.locator('#novedades .product-card').filter({ hasText: 'Cargador 23' });
    await delayed.getByRole('status').filter({ hasText: 'Cargando imagen' }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('#novedades img')].some(image => image.src.includes('original-24.jpg') && image.complete && image.naturalWidth > 0));
    assert(originals.some(url => url.includes('original-24.jpg')), 'failed thumbnail should recover using the original');
    releaseSlowImage();
    await delayed.getByRole('status').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#novedades .product-image-loading').count(), 0);
    assert.equal(await page.locator('#novedades img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
    console.log('PASS Novedades title, visible loading status and original-image recovery after thumbnail failure');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
