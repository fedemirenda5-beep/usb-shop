const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../src/hooks/useStorefrontInventory.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function mount(products, responder) {
  const browser = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const navigator = { onLine: true };
  const calls = [];
  const updates = [];
  const errors = [];
  let now = 100000;
  let tick;
  let cleanup;
  let cleared = false;
  browser.setInterval = callback => { tick = callback; return 1; };
  browser.clearInterval = () => { cleared = true; };
  const module = { exports: {} };
  const requireMock = name => name === 'react' ? {
    useRef: current => ({ current }),
    useEffect: callback => { cleanup = callback(); },
  } : {
    fetchJson: async (path, init, options) => {
      calls.push({ path, init, options });
      return responder(path, init);
    },
  };
  new Function('module', 'exports', 'require', 'window', 'document', 'navigator', 'Date', compiled)(
    module, module.exports, requireMock, browser, document, navigator, { now: () => now },
  );
  module.exports.useStorefrontInventory(products, inventory => updates.push(inventory), () => errors.push(true));
  return {
    calls, updates, errors, browser, document, navigator,
    api: module.exports,
    advance: () => { now += 60000; tick(); },
    cleanup: () => { cleanup(); assert.equal(cleared, true); },
  };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test('suspension releases a stalled refresh and a late response cannot overwrite fresh stock', async () => {
  let oldResponse;
  const state = mount([{ id: 704, stock: 3 }], () => state.calls.length === 1
    ? new Promise(resolve => { oldResponse = resolve; })
    : Promise.resolve([{ id: 704, stock: 2 }]));
  state.browser.dispatchEvent(new Event('focus'));
  state.document.visibilityState = 'hidden';
  state.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(state.calls[0].init.signal.aborted, true);
  state.document.visibilityState = 'visible';
  state.document.dispatchEvent(new Event('visibilitychange'));
  await settled();
  assert.equal(state.calls.length, 2);
  assert.equal(state.updates[0].get(704).stock, 2);
  oldResponse([{ id: 704, stock: 99 }]);
  await settled();
  assert.equal(state.updates.length, 1);
  assert.equal(state.errors.length, 0);
  state.cleanup();
});

test('returning to the tab refreshes stock and sold counts without changing product identity', async () => {
  const product = { id: 6463, name: 'Cargador', stock: 300, soldCount: 0 };
  const state = mount([product], async () => [{ id: 6463, stock: 198, soldCount: 98 }]);
  state.browser.dispatchEvent(new Event('focus'));
  state.document.dispatchEvent(new Event('visibilitychange'));
  await settled();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].init.cache, 'no-store');
  assert.equal(state.calls[0].options.attempts, 1);
  assert.deepEqual(state.api.refreshInventory(product, state.updates[0]), { ...product, stock: 198, soldCount: 98 });
  state.advance();
  await settled();
  assert.equal(state.calls.length, 2);
  state.cleanup();
  state.browser.dispatchEvent(new Event('focus'));
  await settled();
  assert.equal(state.calls.length, 2);
});

test('hidden or offline tabs do not poll; reconnecting refreshes', async () => {
  const state = mount([{ id: 1, stock: 3 }], async () => [{ id: 1, stock: 2 }]);
  state.document.visibilityState = 'hidden';
  state.advance();
  state.document.visibilityState = 'visible';
  state.navigator.onLine = false;
  state.advance();
  assert.equal(state.calls.length, 0);
  state.navigator.onLine = true;
  state.browser.dispatchEvent(new Event('online'));
  await settled();
  assert.equal(state.calls.length, 1);
  state.cleanup();
});

test('failed refresh preserves displayed data and reports the failure', async () => {
  const state = mount([{ id: 1, stock: 3 }], async () => { throw new Error('network unavailable'); });
  state.advance();
  await settled();
  assert.equal(state.updates.length, 0);
  assert.equal(state.errors.length, 1);
  state.cleanup();
});

test('large visible lists respect the API limit and deduplicate IDs', async () => {
  const products = Array.from({ length: 205 }, (_, id) => ({ id: id + 1, stock: 3 }));
  const state = mount([...products, products[0]], async path => {
    const params = new URL(path, 'https://test').searchParams;
    const ids = params.get('ids').split(',').map(Number);
    assert(ids.length <= 100);
    assert.equal(Number(params.get('limit')), ids.length);
    return ids.map(id => ({ id, stock: 2, soldCount: 1 }));
  });
  state.advance();
  await settled();
  assert.equal(state.calls.length, 3);
  assert.equal(state.updates[0].size, 205);
  state.cleanup();
});

test('unmount aborts a pending request and ignores its late response', async () => {
  let resolve;
  const state = mount([{ id: 1, stock: 3 }], () => new Promise(done => { resolve = done; }));
  state.advance();
  state.cleanup();
  assert.equal(state.calls[0].init.signal.aborted, true);
  resolve([{ id: 1, stock: 2 }]);
  await settled();
  assert.equal(state.updates.length, 0);
  assert.equal(state.errors.length, 0);
});
