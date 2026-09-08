// Real browser -> real API -> disposable SQLite. Start test_consignments.py --serve first.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const API = 'http://127.0.0.1:8011';
const WEB = process.env.CHECKOUT_WEB_URL || 'http://127.0.0.1:3000';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [path, width, loseResponse] of [['/', 390, false], ['/carrito/', 1280, false], ['/', 320, true], ['/carrito/', 390, true]]) {
      if (process.env.CHECKOUT_CASE && `${path}:${width}` !== process.env.CHECKOUT_CASE) continue;
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700 });
      const requests = [];
      let dropped = false;
      const name = `Compra navegador ${width} ${Date.now()}`;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: API } });
        if (url.pathname === '/orders' || url.port === '8011' || url.port === '8000' || url.hostname === 'api.usbshop.com.ar') {
          const response = await route.fetch({ url: `${API}${url.pathname}${url.search}` });
          if (url.pathname === '/orders') {
            requests.push(route.request().postDataJSON());
            if (loseResponse && !dropped) {
              assert.equal(response.ok(), true);
              dropped = true;
              return route.abort('connectionreset');
            }
          }
          return route.fulfill({ response });
        }
        if (url.hostname !== new URL(WEB).hostname) return route.fulfill({ status: 404, body: '' });
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Cable USB', exact: true }) }).first();
      await card.getByRole('button', { name: 'Agregar', exact: true }).click();
      let panel;
      // Use the dedicated cart to verify removal, quantity editing and persistence.
      await page.goto(`${WEB}/carrito/`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Cantidad: 1', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Quitar', exact: true }).click();
      await page.getByRole('button', { name: 'Agrega productos para continuar', exact: true }).waitFor();
      await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
      await card.getByRole('button', { name: 'Agregar', exact: true }).click();
      await page.goto(`${WEB}/carrito/`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Cantidad: 1', { exact: true }).waitFor();
      await page.getByRole('button', { name: '+', exact: true }).click();
      await page.getByText('Cantidad: 2', { exact: true }).waitFor();
      await page.getByRole('button', { name: '-', exact: true }).click();
      await page.getByText('Cantidad: 1', { exact: true }).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('Cantidad: 1', { exact: true }).waitFor();
      if (path === '/') await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
      panel = path === '/' ? page.getByRole('dialog', { name: 'Carrito', exact: true }) : page;
      await panel.getByPlaceholder('Nombre y apellido').fill(name);
      await panel.getByPlaceholder('Telefono', { exact: true }).fill('1155555555');
      const before = await (await context.request.get(`${API}/products?ids=1`)).json();
      const confirm = panel.getByRole('button', { name: 'Confirmar pedido', exact: true });
      await confirm.click({ clickCount: 6, delay: 20 });
      if (loseResponse) {
        await page.waitForFunction(() => document.body.innerText.includes('No se pudo') || document.body.innerText.includes('conexion'), null, { timeout: 45000 });
        // Reload destroys component refs; the saved key must still recover the order.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByText('Cantidad: 1', { exact: true }).first().waitFor();
        panel = path === '/' ? page.getByRole('dialog', { name: 'Carrito', exact: true }) : page;
        await panel.getByPlaceholder('Nombre y apellido').fill(name);
        await panel.getByPlaceholder('Telefono', { exact: true }).fill('1155555555');
        await panel.getByRole('button', { name: 'Confirmar pedido', exact: true }).click();
      }
      try { await page.waitForFunction(() => /Gracias Compra|Pedido #\d+ guardado/.test(document.body.innerText), null, { timeout: 15000 }); } catch (err) { console.log(await page.locator('body').innerText(), requests); throw err; }
      const orders = await (await context.request.get(`${API}/admin/orders?status=ALL`)).json();
      const matches = orders.filter(order => order.customer_name === name);
      assert.equal(matches.length, 1, 'exactly one persisted order');
      assert.equal(matches[0].total, 1000);
      assert.equal(matches[0].items.length, 1);
      assert.equal(matches[0].items[0].quantity, 1);
      const after = await (await context.request.get(`${API}/products?ids=1`)).json();
      assert.equal(after[0].stock, before[0].stock - 1, 'reserve stock once');
      assert.equal(requests.length, loseResponse ? 2 : 1, 'rapid repeated clicks must not send extra requests');
      assert.equal(new Set(requests.map(req => req.idempotency_key)).size, 1);
      assert.deepEqual(errors, []);
      // Wait for background stock requests too: these used to resurrect the cart.
      await page.waitForLoadState('networkidle');
      assert.equal(await page.evaluate(() => localStorage.getItem('usbshop_cart_v1')), null);
      await page.goto(`${WEB}/carrito/`, { waitUntil: 'networkidle' });
      try { await page.getByRole('button', { name: 'Agrega productos para continuar', exact: true }).waitFor(); } catch (err) { console.log('AFTER SUCCESS', await page.locator('body').innerText(), await page.evaluate(() => localStorage.getItem('usbshop_cart_v1'))); throw err; }
      assert.equal(await page.getByText('Cantidad: 1', { exact: true }).count(), 0, 'cart stays empty after navigation');
      console.log(`PASS real purchase ${path} ${width}px${loseResponse ? ' + lost response and reload' : ''}: order #${matches[0].id}, total, items, stock, cart cleared`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
