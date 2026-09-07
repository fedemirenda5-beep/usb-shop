// Run against a local dev server with Playwright installed (or PLAYWRIGHT_MODULE set).
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const product = { id: 1, name: 'Cable USB', category: 'Cables', price: 1000, stock: 10 };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [path, width] of [['/', 390], ['/', 320], ['/carrito/', 390], ['/carrito/', 1280]]) {
      const context = await browser.newContext({ viewport: { width, height: 740 }, isMobile: width < 700, hasTouch: width < 700 });
      const orders = [];
      let productRequests = 0;
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/usbshop-config.json') {
          return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
        }
        if (url.pathname === '/orders') {
          orders.push(route.request().postDataJSON());
          return route.fulfill({ json: { id: 123, total: 2000 } });
        }
        if (url.pathname === '/products') {
          productRequests++;
          return route.fulfill({ json: [{ ...product }] });
        }
        if (url.port === '8000' || url.hostname !== '127.0.0.1') {
          return route.fulfill({ json: [] });
        }
        return route.continue();
      });
      await context.addInitScript((product) => {
        localStorage.setItem('usbshop_cart_v1', JSON.stringify({ savedAt: new Date().toISOString(), items: [{ product, qty: 2 }] }));
      }, product);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:3000${path}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      // Wait for persisted cart hydration before interacting with server-rendered inputs.
      await page.getByText('Cantidad: 2', { exact: true }).first().waitFor();
      let panel = page;
      if (path === '/') {
        panel = page.getByRole('dialog', { name: 'Carrito', exact: true });
        await panel.waitFor();
        await panel.getByRole('button', { name: 'Cerrar', exact: true }).click();
        await page.getByRole('button', { name: 'Ver carrito', exact: true }).click();
        await panel.waitFor();
      }
      const name = panel.getByPlaceholder('Nombre y apellido');
      await name.click();
      await name.pressSequentially('Cliente Prueba', { delay: 80 });
      assert.equal(await name.inputValue(), 'Cliente Prueba', 'typing must retain focus');
      assert.equal(await name.evaluate((el) => document.activeElement === el), true);
      const phone = panel.getByPlaceholder('Telefono', { exact: true });
      await phone.click();
      await phone.pressSequentially('1155555555', { delay: 80 });
      const before = productRequests;
      await page.waitForTimeout(1500);
      assert.ok(productRequests - before <= 2, 'stock refresh must settle');
      const confirm = panel.getByRole('button', { name: 'Confirmar pedido', exact: true });
      await confirm.scrollIntoViewIfNeeded();
      await confirm.click();
      await page.waitForFunction(() => /Gracias Cliente|Pedido #123/.test(document.body.innerText));
      assert.equal(orders.length, 1, 'one confirmation must submit exactly one order');
      assert.equal(orders[0].customer_name, 'Cliente Prueba');
      assert.equal(orders[0].customer_phone, '1155555555');
      assert.deepEqual(orders[0].items, [{ product_id: 1, quantity: 2, unit_price: 1000 }]);
      assert.deepEqual(errors, []);
      console.log(`PASS ${path} at ${width}px: typing, scrolling, stable stock refresh, checkout`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
