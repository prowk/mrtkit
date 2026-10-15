import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { bgpUpdate, attributes } from '../scripts/fixtures.mjs';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';

test('库桥接和 CLI 的全部查询模式返回同样结果', () => {
  const data = bgpUpdate(Buffer.from([0, 24, 192, 0, 2, 25, 192, 0, 2, 128, 32, 192, 0, 2, 200]), undefined, attributes([64512, 1]), 100);
  for (const [prefix, prefix_mode, expected] of [
    ['192.0.2.255/24', 'exact', ['192.0.2.0/24']],
    ['192.0.2.1/24', 'more-specific', ['192.0.2.128/25', '192.0.2.200/32']],
    ['192.0.2.200', 'covering', ['0.0.0.0/0', '192.0.2.0/24', '192.0.2.128/25', '192.0.2.200/32']],
    ['0.0.0.0/0', 'exact', ['0.0.0.0/0']],
  ]) {
    assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({ prefix, prefix_mode, mode: 'parse', format: 'json', from_time: 0, to_time: 4294967295, window_seconds: 60, threshold: 10, capacity: 100 }))), {});
    const library = JSON.parse(bridge.consume(data)).lines.map(JSON.parse).map(e => e.prefix);
    const cli = spawnSync(process.execPath, ['cli/mrtkit.mjs', 'parse', '--prefix', prefix, '--prefix-mode', prefix_mode, '-'], { input: data, encoding: 'utf8', windowsHide: true });
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = cli.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).map(e => e.prefix);
    assert.deepEqual(parsed, expected);
    assert.deepEqual(parsed, library);
  }
});
