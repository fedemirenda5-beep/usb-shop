// Simulated buyer/catalog responses; never sends orders or changes real accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3031';
const capture = process.env.CAPTURE_ONLY === '1';
const shots = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'usbshop-buyer-layout');

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of capture ? [390] : [320, 360, 390, 430, 1366]) {
      for (const status of capture ? ['guest'] : ['guest', 'approved', 'pending']) {
        const buyer = status === 'guest' ? null : { id: 1, name: 'Distribuidora de accesorios y tecnología Juan José Pérez y Asociados', email: 'buyer@example.com', phone: '2361234567', customer_id: status === 'approved' ? 1 : null, status };
        const products = Array.from({ length: 4 }, (_, id) => ({ id: id + 1, name: `Auriculares Bluetooth con micrófono y batería de larga duración ${id + 1}`, category: 'Audio', stock: 10, price: status === 'approved' ? 12345 : null }));
        const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
        try {
          await context.route('**/*', route => {
            const url = new URL(route.request().url());
            const reply = json => route.fulfill({ json });
            if (url.pathname === '/usbshop-config.json') return reply({ apiBaseUrl: 'http://127.0.0.1:8000' });
            if (url.pathname === '/buyer/me') return reply(buyer);
            if (url.pathname === '/products') return reply(url.searchParams.get('offset') > 0 ? [] : products);
            if (url.pathname === '/featured') return reply(products);
            if (url.pathname === '/categories') return reply([{ id: 1, name: 'Audio' }]);
            if (url.pathname === '/storefront/collections') return reply({ new_arrivals: products, restocked: [] });
            if (url.origin !== new URL(base).origin) return route.abort();
            return route.continue();
          });
          const page = await context.newPage();
          for (const route of ['/', '/catalog/']) {
            await page.goto(base + route);
            await page.locator('.product-title').filter({ hasText: products[0].name }).first().waitFor();
            if (route === '/') await page.locator('.buyer-nav').getByRole('link').filter({ hasText: status === 'guest' ? /Ingreso clientes/ : status === 'pending' ? /Solicitud/ : /Distribuidora/ }).waitFor();
            if (status === 'approved') await page.locator('.product-price').first().waitFor();
            const card = page.locator('.product-card').filter({ has: page.locator('.product-title', { hasText: products[0].name }) }).first();
            if (width === 390 && route === '/') {
              await page.screenshot({ path: path.join(shots, `${capture ? 'before' : 'after'}-${status}.png`) });
              await card.screenshot({ path: path.join(shots, `${capture ? 'before' : 'after'}-${status}-card.png`) });
            }
            if (capture) continue;
            const violations = await page.evaluate(() => {
              const issues = [];
              const rect = element => element.getBoundingClientRect();
              const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
              if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('horizontal overflow');
              const header = [...(document.querySelector('.navbar-top')?.children || [])].filter(element => rect(element).width && rect(element).height);
              for (let i = 0; i < header.length; i++) for (let j = i + 1; j < header.length; j++) if (overlaps(rect(header[i]), rect(header[j]))) issues.push('header elements overlap');
              for (const card of document.querySelectorAll('.product-card')) {
                const parent = rect(card);
                const controls = [...card.querySelectorAll('.product-buttons > button, .product-buttons > a, .product-price-access')];
                for (const control of controls) {
                  const box = rect(control);
                  if (!box.width || !box.height) continue;
                  if (box.left < parent.left - 1 || box.right > parent.right + 1 || box.bottom > parent.bottom + 1) issues.push('card control escapes its card');
                  if (getComputedStyle(control).display === 'inline') issues.push('card control uses overlapping inline layout');
                  if (innerWidth <= 430 && box.height < 40) issues.push('card action is too small to tap');
                }
                for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) if (controls[i] !== controls[j] && overlaps(rect(controls[i]), rect(controls[j]))) issues.push('card actions overlap');
              }
              return issues;
            });
            assert.deepEqual(violations, [], `${width}px ${status} ${route}`);
            if (status !== 'approved') {
              assert.equal(await page.locator('.product-price').count(), 0);
              assert.ok(await page.getByRole('link', { name: 'Ver precios', exact: true }).count() > 0);
            }
          }
          console.log(`${width}px ${status}: layout OK`);
        } finally { await context.close(); }
      }
    }
    console.log(`Screenshots: ${shots}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
