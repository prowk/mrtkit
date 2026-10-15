import test from 'node:test';
import assert from 'node:assert/strict';
import { frames } from '../cli/input.mjs';
import { options } from '../cli/options.mjs';
import { canonical_prefix } from '../_build/js/release/build/bridge/bridge.js';
const canonicalPrefix = text => { const result = JSON.parse(canonical_prefix(text)); if (result.error) throw new Error(result.error); return result.prefix; };

async function* chunks(data, size) { for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size); }
const header = Buffer.from('0000000100630001000000026162', 'hex');

test('每个分块大小都保留记录和偏移', async () => {
  const data = Buffer.concat([header, header]);
  for (let size = 1; size <= data.length; size++) {
    const result = [];
    for await (const frame of frames(chunks(data, size))) result.push(frame);
    assert.deepEqual(result.map(frame => frame.offset), [0, 14]);
    assert.deepEqual(result[0].data, header);
  }
});

test('拒绝超长记录和 EOF 截断', async () => {
  for (const data of [header.subarray(0, 13), Buffer.from('0000000100630001ffffffff', 'hex')]) {
    await assert.rejects(async () => { for await (const frame of frames(chunks(data, 1))) void frame; });
  }
});

test('前缀规范化和参数边界', () => {
  assert.equal(canonicalPrefix('192.0.2.255/25'), '192.0.2.128/25');
  assert.equal(canonicalPrefix('2001:0db8::1234/32'), '2001:db8::/32');
  assert.equal(canonicalPrefix('::ffff:192.0.2.1/128'), '::ffff:c000:201/128');
  assert.throws(() => options(['stats', '--asn', '1', 'a.mrt']));
  assert.throws(() => options(['parse', '--asn', '4294967296', 'a.mrt']));
  assert.throws(() => options(['parse', '--from', '2', '--to', '1', 'a.mrt']));
  assert.deepEqual(options(['parse', '--', '--filename']).files, ['--filename']);
});
