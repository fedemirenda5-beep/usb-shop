const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../src/lib/api.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function apiWith(responses, clock) {
  const calls = [];
  const deadlines = [];
  const mod = { exports: {} };
  const timer = (callback, delay) => {
    deadlines.push(delay);
    if (clock && delay !== 700) return undefined;
    return setTimeout(callback, delay === 700 ? 1 : delay);
  };
  const browser = new EventTarget();
  browser.location = { hostname: 'shop.test', origin: 'https://shop.test' };
  const document = new EventTarget();
  new Function('module', 'exports', 'require', 'process', 'window', 'document', 'Date', 'fetch', 'setTimeout', 'clearTimeout', compiled)(
    mod, mod.exports, () => ({}), { env: { NEXT_PUBLIC_API_BASE_URL: 'https://api.test' } }, browser, document, clock || Date,
    async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('Unexpected extra request');
      return next;
    }, timer, clearTimeout,
  );
  return { api: mod.exports, calls, deadlines, browser, document };
}

test('timeout includes a response body that stalls after headers; writes are not repeated', async () => {
  let stream;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  const { api, calls } = apiWith([response]);
  try {
    await assert.rejects(api.fetchApiResponse('/admin/invoices', { method: 'POST' }, 20), /demoro demasiado/);
    assert.equal(calls.length, 1);
  } finally { stream.close(); }
});

test('returning from sleep expires an old read even when its timer was suspended', async () => {
  let now = 100000;
  let stream;
  const stalled = new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  const state = apiWith([stalled, Response.json([{ id: 704, name: 'Holder' }])], { now: () => now });
  try {
    const pending = state.api.fetchApiResponse('/products?q=holder');
    await new Promise(resolve => setImmediate(resolve));
    now += 60000;
    state.browser.dispatchEvent(new Event('focus'));
    const response = await pending;
    assert.deepEqual(await response.json(), [{ id: 704, name: 'Holder' }]);
    assert.equal(state.calls.length, 2);
    assert.equal(state.calls[0].init.signal.aborted, true);
  } finally { stream.close(); }
});

test('session verification recovers after temporary HTTP failure without using cache', async () => {
  const { api, calls } = apiWith([new Response('', { status: 503 }), Response.json({ username: 'test' })]);
  const res = await api.fetchAuthResponse('/auth/me');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.init.credentials === 'include' && call.init.cache === 'no-store'));
});

test('login allows a slow server and retries temporary failure', async () => {
  const { api, calls, deadlines } = apiWith([new Response('', { status: 502 }), Response.json({ username: 'test' })]);
  assert.equal((await api.fetchAuthResponse('/auth/login', { method: 'POST', body: '{}' })).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(deadlines.filter(delay => delay === 30000).length, 2);
});

test('wrong credentials and login throttling are not retried', async () => {
  for (const status of [401, 403, 429]) {
    const { api, calls } = apiWith([new Response('', { status })]);
    assert.equal((await api.fetchAuthResponse('/auth/login', { method: 'POST' })).status, status);
    assert.equal(calls.length, 1);
  }
});

test('Safari network errors retry reads and show an understandable message', async () => {
  for (const message of ['Load failed', 'The network connection was lost.']) {
    const error = new TypeError(message);
    const { api, calls } = apiWith([error, Response.json([])]);
    assert.equal((await api.fetchApiResponse('/admin/products')).status, 200);
    assert.equal(calls.length, 2);
    assert.match(api.getFriendlyApiError(error, 'fallback'), /conexión con el servidor/);
  }
});

test('a lost sale response never automatically repeats the write', async () => {
  const { api, calls } = apiWith([new TypeError('Load failed')]);
  await assert.rejects(api.fetchApiResponse('/admin/invoices', { method: 'POST', body: '{}' }));
  assert.equal(calls.length, 1);
});

test('a failed write response is not retried', async () => {
  const { api, calls } = apiWith([new Response('', { status: 503 })]);
  assert.equal((await api.fetchApiResponse('/admin/products/1', { method: 'PUT' })).status, 503);
  assert.equal(calls.length, 1);
});

test('caller cancellation is not retried even when its reason resembles a network error', async () => {
  const controller = new AbortController();
  const reason = new TypeError('Load failed');
  controller.abort(reason);
  const { api, calls } = apiWith([reason]);
  await assert.rejects(api.fetchApiResponse('/admin/products', { signal: controller.signal }));
  assert.equal(calls.length, 1);
});
