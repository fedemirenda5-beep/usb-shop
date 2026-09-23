// Measure the initial admin downloads with a simulated session and no real data.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3012';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
        isMobile: mobile,
      });
      try {
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
          if (url.pathname === '/auth/me') return route.fulfill({ json: { id: 1, username: 'test', role: 'admin' } });
          if (url.pathname === '/admin/dashboard') return route.fulfill({ json: {
            summary: { products: 0, active_customers: 0, stock_units: 0, sales_count: 0, sales_total: 0,
              estimated_margin: 0, expenses_total: 0, cc_open_balance: 0 }, low_stock: [],
          } });
          if (url.origin !== new URL(base).origin) return route.abort();
          return route.continue();
        });
        const page = await context.newPage();
        const requests = [];
        const errors = [];
        page.on('request', request => requests.push(new URL(request.url()).pathname));
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/admin/`);
        await page.getByText('Panel Administrativo', { exact: true }).waitFor();
        await page.waitForLoadState('networkidle');
        const unusedModules = requests.filter(path =>
          /^\/admin\/[^/]+\/index\.txt$/.test(path) ||
          /^\/_next\/static\/chunks\/app\/admin\/[^/]+\/page-/.test(path));
        assert.deepEqual(unusedModules, [], 'opening the dashboard must not download unopened modules');
        console.log(`PASS ${mobile ? 'mobile' : 'desktop'} dashboard: ${requests.length} requests, no unopened modules`);
        if (mobile) await page.getByRole('button', { name: 'Ver menu', exact: true }).click();
        await page.locator('nav a[href="/admin/imeis/"]').or(page.locator('nav a[href="/admin/imeis"]')).click();
        await page.getByLabel('IMEI del equipo').waitFor();
        assert.deepEqual(errors, []);
        console.log(`PASS ${mobile ? 'mobile' : 'desktop'} navigation loads the requested module`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
