// Mobile viewport with intercepted API traffic; never uses real credentials.
const assert = require('node:assert/strict');
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_WEB_URL || 'http://127.0.0.1:3012';
const user = { id: 1, username: 'mobile-test', role: 'admin' };

async function fixture(browser, options = {}) {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  if (options.blockStorage) await context.addInitScript(() => {
    for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(window, key, {
      get() { throw new DOMException('Blocked storage', 'SecurityError'); },
    });
  });
  const state = { sessionStatus: 200, loginStatus: 200, loginDelay: 0, sessionSequence: [], sessionCalls: 0, loginCalls: 0 };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/usbshop-config.json') return route.fulfill({ json: { apiBaseUrl: 'http://127.0.0.1:8000' } });
    if (url.pathname === '/auth/users') return route.fulfill({ status: 503, json: { detail: 'temporarily unavailable' } });
    if (url.pathname === '/auth/me') {
      state.sessionCalls++;
      const status = state.sessionSequence.shift() ?? state.sessionStatus;
      return route.fulfill({ status, json: status === 200 ? user : { detail: 'temporary error or expired session' } });
    }
    if (url.pathname === '/auth/login') {
      state.loginCalls++;
      if (state.loginDelay) await new Promise(resolve => setTimeout(resolve, state.loginDelay));
      return route.fulfill({ status: state.loginStatus, json: state.loginStatus === 200 ? user : { detail: 'Credenciales invalidas' } });
    }
    if (url.pathname === '/auth/logout') return route.fulfill({ json: { ok: true } });
    if (url.origin !== base) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, state, errors };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const first = await fixture(browser);
    first.state.sessionSequence = [503, 200];
    await first.page.goto(`${base}/admin/imeis/`);
    await first.page.getByLabel('IMEI del equipo').waitFor();
    assert.equal(first.state.sessionCalls, 2, 'temporary session error recovers automatically');
    await first.page.getByLabel('IMEI del equipo').fill('356789012345678');
    first.state.sessionStatus = 503;
    await first.page.evaluate(() => window.dispatchEvent(new Event('usbshop:admin-session-recheck')));
    await first.page.getByRole('status').filter({ hasText: 'La conexión se interrumpió' }).waitFor();
    assert.equal(await first.page.getByLabel('IMEI del equipo').inputValue(), '356789012345678');
    first.state.sessionStatus = 200;
    await first.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await first.page.getByRole('status').filter({ hasText: 'La conexión se interrumpió' }).waitFor({ state: 'detached' });
    await first.page.waitForLoadState('networkidle');
    assert.equal(await first.page.getByLabel('IMEI del equipo').inputValue(), '356789012345678');
    first.state.sessionStatus = 401;
    await first.page.evaluate(() => window.dispatchEvent(new Event('usbshop:admin-session-recheck')));
    await first.page.waitForURL(/\/login\/?\?from=/);
    assert.equal(await first.page.evaluate(() => localStorage.getItem('usbshop_admin_session_v1')), null);
    assert.deepEqual(first.errors, []);
    await first.context.close();
    console.log('PASS mobile retry, preserved input, reconnect and expired-session redirect');

    const cold = await fixture(browser);
    cold.state.sessionStatus = 503;
    await cold.context.addInitScript(user => localStorage.setItem('usbshop_admin_session_v1', JSON.stringify({ user })), user);
    await cold.page.goto(`${base}/admin/imeis/`);
    await cold.page.getByRole('button', { name: 'Reintentar conexion', exact: true }).waitFor();
    assert.equal(await cold.page.getByLabel('IMEI del equipo').count(), 0, 'stored user alone cannot mount admin');
    cold.state.sessionStatus = 200;
    // Recovery timer, without a manual reload or retry click.
    await cold.page.getByLabel('IMEI del equipo').waitFor();
    assert.deepEqual(cold.errors, []);
    await cold.context.close();
    console.log('PASS first visit waits for verification and automatically recovers');

    const login = await fixture(browser, { blockStorage: true });
    login.state.loginDelay = 9500;
    await login.page.goto(`${base}/login/?from=/admin/imeis`);
    await login.page.getByLabel('Usuario', { exact: true }).fill('mobile-test');
    await login.page.getByLabel('Contrasena', { exact: true }).fill('test-only-password');
    await login.page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await login.page.getByRole('status').filter({ hasText: 'Seguimos intentando conectar' }).waitFor();
    await login.page.waitForURL(/\/admin\/imeis\/?$/);
    await login.page.getByLabel('IMEI del equipo').waitFor();
    assert.equal(login.state.loginCalls, 1, 'a slow login completes without resubmitting credentials');
    assert(login.state.sessionCalls >= 1, 'login checks that session cookie works');
    assert.deepEqual(login.errors, []);
    await login.context.close();
    console.log('PASS login slower than 8 seconds, unavailable suggestions and blocked storage');

    const blockedCookie = await fixture(browser);
    blockedCookie.state.sessionStatus = 401;
    await blockedCookie.page.goto(`${base}/login/?from=/admin/imeis`);
    await blockedCookie.page.getByLabel('Usuario', { exact: true }).fill('mobile-test');
    await blockedCookie.page.getByLabel('Contrasena', { exact: true }).fill('test-only-password');
    await blockedCookie.page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await blockedCookie.page.getByRole('alert').filter({ hasText: 'El navegador no pudo mantener la sesión' }).waitFor();
    assert.match(blockedCookie.page.url(), /\/login\//);
    assert.equal(blockedCookie.state.loginCalls, 1);
    blockedCookie.state.loginStatus = 401;
    await blockedCookie.page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    await blockedCookie.page.getByRole('alert').filter({ hasText: 'Credenciales invalidas' }).waitFor();
    assert.equal(blockedCookie.state.loginCalls, 2, 'invalid credentials do not trigger retry loops');
    assert.deepEqual(blockedCookie.errors, []);
    await blockedCookie.context.close();
    console.log('PASS blocked cookie stays at login with explanation; wrong password is not retried');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
