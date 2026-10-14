const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../src/hooks/usePageResume.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

test('resume refreshes reads once, ignores brief focus changes, reconnects and cleans up', () => {
  const browser = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const navigator = { onLine: true };
  let now = 100000, revision = 0, cleanup, tick;
  browser.setInterval = callback => { tick = callback; return 1; };
  browser.clearInterval = () => {};
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'window', 'document', 'navigator', 'Date', compiled)(
    mod, mod.exports, () => ({ useState: () => [0, update => { revision = update(revision); }],
      useEffect: effect => { cleanup = effect(); } }), browser, document, navigator, { now: () => now },
  );
  mod.exports.usePageResume();
  browser.dispatchEvent(new Event('blur'));
  now += 100;
  browser.dispatchEvent(new Event('focus'));
  assert.equal(revision, 0);
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  now += 60000;
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  browser.dispatchEvent(new Event('focus'));
  browser.dispatchEvent(new Event('online'));
  assert.equal(revision, 1, 'paired wake events must not restart a search repeatedly');
  now += 2000;
  browser.dispatchEvent(new Event('online'));
  assert.equal(revision, 2);
  now += 2000;
  const restored = new Event('pageshow');
  restored.persisted = true;
  browser.dispatchEvent(restored);
  assert.equal(revision, 3);
  now += 60000;
  tick();
  assert.equal(revision, 4, 'sleep with the tab still visible must also recover');
  cleanup();
  now += 2000;
  browser.dispatchEvent(new Event('online'));
  assert.equal(revision, 4);
});
