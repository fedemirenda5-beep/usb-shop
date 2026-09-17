const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function browser(fetch, values = new Map(), failWrites = false) {
  const window = new EventTarget();
  window.location = { hostname: 'localhost', origin: 'http://localhost' };
  const context = vm.createContext({
    window, fetch, Headers, AbortController, DOMException, Event, CustomEvent,
    setTimeout, clearTimeout, URL, console,
    process: { env: { NEXT_PUBLIC_API_BASE_URL: 'http://localhost:8011' } },
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => { if (failWrites) throw Error('quota'); values.set(key, value); },
      removeItem: key => values.delete(key),
    },
  });
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const module = { exports: {} };
    cache.set(name, module);
    const source = readFileSync(join(__dirname, '../src/lib', `${name}.ts`), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    } }).outputText;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context)(
      path => load(path.replace('./', '')), module, module.exports);
    return module.exports;
  }
  return { api: load('api'), session: load('checkoutSession'), cart: load('cart') };
}

const payload = () => ({
  idempotency_key: 'original-order-attempt', customer_name: 'Cliente', customer_phone: '123',
  items: [{ product_id: 1, quantity: 6, unit_price: 1000 }],
});

test('lost response, reload and changed quantities cannot create a second order', async () => {
  const values = new Map();
  const orders = new Map();
  let requests = 0;
  const fetch = async (_, init) => {
    requests++;
    const body = JSON.parse(init.body);
    if (!orders.has(body.idempotency_key)) orders.set(body.idempotency_key, {
      id: 199 + orders.size, total: body.items[0].quantity * 1000,
    });
    if (requests === 1) throw Error('connection lost after commit');
    return Response.json(orders.get(body.idempotency_key));
  };
  let client = browser(fetch, values);
  client.cart.writeStoredCart([{ product: { id: 1, name: 'Cable', price: 1000, category: 'USB' }, qty: 6 }]);
  await assert.rejects(client.api.submitOrder(payload()));
  client = browser(fetch, values);
  const changed = { ...payload(), idempotency_key: 'new-order-attempt', items: [{ product_id: 1, quantity: 4 }] };
  await assert.rejects(client.api.submitOrder(changed), /pedido sin confirmar/);
  assert.equal(requests, 1, 'changed order never reaches the server');
  const recovered = await client.api.submitOrder(client.session.readPendingOrder().payload);
  assert.equal(recovered.id, 199);
  assert.equal(recovered.total, 6000);
  assert.equal(orders.size, 1);
  assert.equal(client.session.readPendingOrder(), null);
  assert.equal(client.cart.readStoredCart().items.length, 0);
});

test('server failures and malformed success responses retain the original request', async () => {
  for (const response of [new Response('unavailable', { status: 503 }), Response.json({})]) {
    const client = browser(async () => response);
    await assert.rejects(client.api.submitOrder(payload()));
    assert.equal(client.session.readPendingOrder().payload.idempotency_key, payload().idempotency_key);
  }
});

test('a definitive validation rejection permits correcting the order', async () => {
  const client = browser(async () => Response.json({ detail: 'Sin stock' }, { status: 400 }));
  await assert.rejects(client.api.submitOrder(payload()), /Sin stock/);
  assert.equal(client.session.readPendingOrder(), null);
});

test('storage quota errors retain the pending request in memory', async () => {
  const client = browser(async () => { throw Error('lost'); }, new Map(), true);
  await assert.rejects(client.api.submitOrder(payload()));
  assert.equal(client.session.readPendingOrder().payload.idempotency_key, payload().idempotency_key);
  await assert.rejects(client.api.submitOrder({ ...payload(), customer_name: 'Changed' }), /pedido sin confirmar/);
});
