// All API responses are simulated; this never creates real customers or sends mail.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3031';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
      try {
        let buyer = null;
        const customer = { id: 1, name: 'Comercio habitual', email: 'habitual@example.com', phone: '542361234567', is_active: true, balance: 0, invoice_count: 0, documents: [], movements: [] };
        const accounts = [{ id: 1, name: 'habitual Comercio', email: 'nuevo@example.com', phone: '542361234567', status: 'pending', customer_id: null,
          matches: [{ ...customer, match_reasons: ['name'], linked_account_id: null }] }];
        const writes = [];
        let staffReads = 0;
        let buyerReads = 0;
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          const reply = json => route.fulfill({ json });
          if (url.pathname === '/usbshop-config.json') return reply({ apiBaseUrl: 'http://127.0.0.1:8000' });
          if (url.pathname === '/buyer/me') { buyerReads++; return reply(buyer); }
          if (url.pathname === '/auth/me') { staffReads++; return reply({ id: 1, username: 'test', role: 'admin' }); }
          if (url.pathname === '/buyer/login') {
            if (request.postDataJSON().password === 'wrong-password') return route.fulfill({ status: 401, json: { detail: 'Email o contraseña incorrectos' } });
            buyer = { ...customer, status: 'approved', customer_id: 1 };
            return reply(buyer);
          }
          if (url.pathname === '/products' || url.pathname === '/featured') return reply([{ id: 1, name: 'Producto privado', category: 'Audio', stock: 10, price: buyer?.status === 'approved' ? 12345 : null }]);
          if (url.pathname === '/categories') return reply([{ id: 1, name: 'Audio' }]);
          if (url.pathname === '/storefront/collections') return reply({ new_arrivals: [], restocked: [] });
          if (url.pathname === '/buyer/activate') {
            writes.push(request.postDataJSON());
            buyer = { ...customer, status: 'approved', customer_id: 1 };
            return reply(buyer);
          }
          if (url.pathname === '/buyer/register') {
            writes.push(request.postDataJSON());
            const { password, ...profile } = request.postDataJSON();
            buyer = { id: 2, ...profile, status: 'pending', customer_id: null };
            accounts.push({ ...buyer, matches: [] });
            return reply(buyer);
          }
          if (url.pathname === '/admin/buyer-accounts') return reply(accounts);
          if (/^\/admin\/buyer-accounts\/\d+$/.test(url.pathname)) {
            writes.push(request.postDataJSON()); Object.assign(accounts.find(account => account.id === Number(url.pathname.split('/').pop())), request.postDataJSON()); return reply({ ok: true });
          }
          if (url.pathname === '/admin/buyer-invitations/1') {
            writes.push(request.postDataJSON()); return reply({ url: `${base}/mi-cuenta/#token=test-invite`, email: customer.email });
          }
          if (url.pathname === '/admin/backoffice-customers') return reply([customer]);
          if (url.pathname === '/admin/backoffice-customers/1') return reply(customer);
          if (url.pathname === '/admin/backoffice-customer-zones' || url.pathname === '/admin/sellers') return reply([]);
          if (url.origin !== new URL(base).origin) return route.abort();
          return route.continue();
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await page.goto(`${base}/catalog/`);
        await page.getByText('Producto privado', { exact: true }).first().waitFor();
        await page.getByRole('link', { name: 'Ver precios', exact: true }).first().waitFor();
        assert.equal(await page.getByRole('button', { name: 'Agregar', exact: true }).count(), 0);
        assert.equal(await page.locator('.product-price').count(), 0);
        assert.equal(await page.locator('.buyer-welcome').count(), 0);
        await page.goto(`${base}/mi-cuenta/#token=test-invite`);
        await page.getByRole('heading', { name: 'Elegí tu contraseña' }).waitFor();
        assert.equal(await page.locator('input[name="email"]').count(), 0, 'invited clients only choose a password');
        await page.getByLabel('Nueva contraseña').fill('buyer-secret-123');
        await page.getByRole('button', { name: 'Guardar contraseña y entrar' }).click();
        await page.waitForURL(`${base}/`);
        assert.equal(await page.evaluate(() => localStorage.getItem('usbshop_buyer_owner')), '1');
        await page.getByText('Producto privado', { exact: true }).first().waitFor();
        await page.locator('.product-price').filter({ hasText: '12.345' }).first().waitFor();
        await page.getByText('¡Hola, Comercio habitual! Te damos la bienvenida a USB Shop.', { exact: true }).waitFor();
        assert.equal(await page.locator('a[href^="/admin"], a[href^="/login"]').count(), 0);
        assert.equal(staffReads, 0, 'buyers never use staff login');
        assert.equal(writes[0].token, 'test-invite');
        const beforeAdminBuyerReads = buyerReads;
        await page.goto(`${base}/admin/clientes/`);
        await page.getByRole('button', { name: 'Solicitudes pendientes · 1' }).click();
        assert.equal(await page.locator('.buyer-welcome').count(), 0, 'buyer welcome stays outside staff admin');
        assert.equal(buyerReads, beforeAdminBuyerReads, 'staff pages do not load a buyer session');
        assert.equal(await page.getByRole('button', { name: 'Aceptar', exact: true }).isEnabled(), true);
        assert.equal(await page.locator('details').first().getAttribute('open'), null);
        await page.getByRole('button', { name: 'Aceptar', exact: true }).click();
        await page.getByText('Acceso habilitado.', { exact: false }).waitFor();
        assert.ok(writes.some(body => body.status === 'approved' && body.customer_id === 1 && body.create_customer === false));
        // Existing commercial clients keep their record and receive a one-step invitation.
        await page.getByText('Comercio habitual', { exact: true }).first().click();
        await page.getByRole('button', { name: 'Generar invitación', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Generar invitación', exact: true }).click();
        await page.getByLabel('Invitación lista').waitFor();
        assert.ok((await page.getByLabel('Invitación lista').inputValue()).includes('#token='));
        assert.ok(await page.getByRole('link', { name: 'Compartir por WhatsApp' }).isVisible());
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'mobile layout must fit');
        buyer = null;
        await page.goto(`${base}/mi-cuenta/`);
        await page.getByLabel('Email', { exact: true }).fill(customer.email);
        await page.getByLabel('Contraseña', { exact: true }).fill('wrong-password');
        await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'Email o contraseña incorrectos' }).waitFor();
        assert.equal(await page.locator('.buyer-welcome').count(), 0);
        await page.getByLabel('Contraseña', { exact: true }).fill('buyer-secret-123');
        await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
        await page.waitForURL(`${base}/`);
        await page.getByText('¡Hola, Comercio habitual! Te damos la bienvenida a USB Shop.', { exact: true }).waitFor();
        buyer = null;
        await page.goto(`${base}/mi-cuenta/`);
        await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
        await page.getByLabel('Nombre o comercio').fill('Comercio nuevo');
        await page.getByLabel('WhatsApp', { exact: true }).fill('2361234567');
        await page.getByLabel('Email', { exact: true }).fill('nuevo@example.com');
        await page.getByLabel('Contraseña', { exact: true }).fill('buyer-secret-123');
        await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
        await page.getByText('Recibimos tu solicitud.', { exact: false }).waitFor();
        assert.equal(await page.locator('.buyer-welcome').count(), 0);
        await page.goto(`${base}/catalog/`);
        await page.getByRole('link', { name: 'Ver precios', exact: true }).first().waitFor();
        assert.equal(await page.locator('.product-price').count(), 0);
        await page.goto(`${base}/admin/clientes/`);
        await page.getByRole('button', { name: 'Solicitudes pendientes \u00b7 1' }).click();
        const accept = page.getByRole('button', { name: 'Aceptar', exact: true });
        assert.equal(await accept.isEnabled(), true, 'a new customer only needs Accept');
        await accept.click();
        await page.getByText('Acceso habilitado.', { exact: false }).waitFor();
        assert.deepEqual(errors, []);
        console.log(`${mobile ? 'mobile' : 'desktop'} buyer invitation, catalog and admin approval OK`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
