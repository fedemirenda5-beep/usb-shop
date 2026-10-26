const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('exported public HTML and hydration data never contain numeric financial fields', () => {
  for (const file of ['out/index.html', 'out/index.txt']) {
    const content = fs.readFileSync(file, 'utf8').replaceAll('\\"', '"');
    assert.doesNotMatch(content, /"(?:price|originalPrice|cost|price_list_[12])":\s*-?\d/, file);
  }
});
