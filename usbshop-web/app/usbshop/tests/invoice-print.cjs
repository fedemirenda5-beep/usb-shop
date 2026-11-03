const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3016';

const detail = {
  invoice: {
    id: 10,
    customer_name: 'Cliente de prueba',
    created_at: '2026-09-28T15:00:00Z',
    document_type: 'FACTURA',
  },
  items: [{ id: 1, product_name: 'Mouse con cable', quantity: 1, unit_price: 5000, line_total: 5000 }],
  payments: [],
  summary: { subtotal: 5000, payments_total: 0, balance_due: 5000 },
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.print = () => { window.printCalls = (window.printCalls || 0) + 1; };
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/usbshop-config.json') {
        return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
      }
      if (url.pathname === '/auth/me') {
        return route.fulfill({ json: { id: 1, username: 'Prueba', role: 'admin' } });
      }
      if (url.pathname === '/admin/invoices/10') return route.fulfill({ json: detail });
      if (url.origin !== base) return route.fulfill({ json: [] });
      return route.continue();
    });

    const page = await context.newPage();
    await page.goto(`${base}/admin/comprobantes/imprimir/?invoice=10`);
    await page.getByText('Comprobante listo para imprimir').waitFor();
    assert.equal(context.pages().length, 1, 'Loading the invoice must not open a blocked popup');

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('button', { name: 'Imprimir / Guardar PDF' }).click(),
    ]);
    await popup.waitForFunction(() => window.printCalls > 0);
    assert((await popup.locator('body').textContent()).includes('Mouse con cable'));
    console.log('PASS invoice print opens from the explicit user action after loading');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
