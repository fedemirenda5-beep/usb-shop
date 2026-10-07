// Exercise retirement without modifying real sellers or customers.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3012';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
      try {
        const sellers = [
          { id: 1, name: 'Saliente', is_active: true, commission_percent: 10, customer_count: 2 },
          { id: 2, name: 'Reemplazo', is_active: true, commission_percent: 10, customer_count: 1 },
          { id: 3, name: 'Inactivo', is_active: false, commission_percent: 10, customer_count: 0 },
        ];
        const writes = [];
        let rejectTransfer = true;
        await context.route('**/*', route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
          if (url.pathname === '/auth/me') return route.fulfill({ json: { id: 1, username: 'test', role: 'admin' } });
          if (url.pathname === '/admin/sellers' && request.method() === 'GET') {
            return route.fulfill({ json: url.searchParams.has('q') ? [sellers[0]] : sellers });
          }
          if (url.pathname === '/admin/sellers/monthly-summary') return route.fulfill({ json: { period: '2026-10', items: [] } });
          if (url.pathname === '/admin/sellers/performance-summary') return route.fulfill({ json: { items: [] } });
          if (url.pathname === '/admin/sellers/1' && request.method() === 'DELETE') {
            writes.push(url);
            if (rejectTransfer) return route.fulfill({ status: 400, json: { detail: 'El vendedor de destino debe estar activo' } });
            sellers[0].is_active = false;
            sellers[0].customer_count = 0;
            sellers[1].customer_count = 3;
            return route.fulfill({ json: { id: 1, reassigned_customers: 2 } });
          }
          if (url.origin !== new URL(base).origin) return route.abort();
          return route.continue();
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/admin/vendedores/`);
        await page.getByRole('button', { name: 'Ver ficha', exact: true }).first().waitFor();
        // The destination must remain available when the list only shows the source.
        const search = page.locator('input[placeholder]').first();
        await search.fill('Saliente');
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: 'Ver ficha', exact: true }).first().click();
        const open = page.getByRole('button', { name: 'Dar de baja y reasignar clientes', exact: true });
        await open.click();
        let dialog = page.getByRole('dialog');
        const select = dialog.getByLabel('Reasignar clientes a');
        await select.locator('option[value="2"]').waitFor({ state: 'attached' });
        assert.equal(await select.locator('option[value="1"], option[value="3"]').count(), 0);
        assert.equal(await dialog.getByRole('button', { name: 'Confirmar baja', exact: true }).isDisabled(), true);
        await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
        assert.equal(writes.length, 0, 'cancelling must never modify the portfolio');
        await open.click();
        dialog = page.getByRole('dialog');
        await dialog.getByLabel('Reasignar clientes a').selectOption('2');
        await dialog.getByRole('button', { name: 'Confirmar baja y reasignar clientes', exact: true }).click();
        await dialog.getByRole('alert').waitFor();
        assert.equal(writes.length, 1);
        assert.equal(sellers[0].is_active, true, 'a rejected transfer must keep the seller active');
        rejectTransfer = false;
        await dialog.getByRole('button', { name: 'Confirmar baja y reasignar clientes', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '2 clientes reasignados a Reemplazo' }).waitFor();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(writes.length, 2);
        assert.equal(writes[1].searchParams.get('replacement_seller_id'), '2');
        await page.getByText('Vendedor inactivo', { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        console.log(`PASS ${mobile ? 'mobile' : 'desktop'} retirement: destinations, cancel, rejection, transfer and inactive state`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
