import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mrt, cat, attr, bgpUpdate } from '../scripts/fixtures.mjs';

test('诊断按 MRT 类型、子类型和 MP 地址族汇总并保留代表记录', () => {
  const unknown = [mrt(99, 1, Buffer.from('a')), mrt(99, 1, Buffer.from('b')), mrt(99, 2, Buffer.from('c')), mrt(13, 12, Buffer.alloc(0))];
  const mp = bgpUpdate(undefined, undefined, cat(attr(14, Buffer.from([0, 2, 128, 0, 0]), 128), attr(15, Buffer.from([3, 231, 1]), 128)));
  const result = spawnSync(process.execPath, ['cli/mrtkit.mjs', 'parse', '-'], { input: cat(...unknown, mp, mp), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const report = result.stderr.split('\n').filter(line => line.startsWith('{')).map(JSON.parse).find(item => item.type === 'diagnostics');
  assert.equal(report.skipped_records, 4);
  assert.equal(report.ignored_families, 4);
  assert.equal(report.groups.filter(g => g.kind === 'mrt').reduce((n, g) => n + g.count, 0), 4);
  assert.equal(report.groups.filter(g => g.kind === 'mp').reduce((n, g) => n + g.count, 0), 4);
  assert.equal(report.groups.find(g => g.mrt_type === 99 && g.subtype === 1).count, 2);
  assert.deepEqual(report.groups.find(g => g.mrt_type === 99 && g.subtype === 1).sample, { file: '-', record: '1', offset: '0' });
  assert.equal(report.groups.find(g => g.afi === 2 && g.safi === 128).count, 2);
  assert.equal(report.groups.find(g => g.afi === 999 && g.safi === 1).count, 2);
});
