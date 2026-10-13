import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { demo } from '../scripts/fixtures.mjs';

function cli(args, input) {
  return spawnSync(process.execPath, ['cli/mrtkit.mjs', ...args], { input, encoding: 'utf8', windowsHide: true });
}

test('MRT 标准输入解析和过滤', () => {
  const result = cli(['parse', '-'], demo());
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 6);
  assert.equal(events[0].action, 'rib');
  assert.equal(events[4].prefix, '2001:db8::/32');
  assert.match(result.stderr, /跳过 1 条/);
  const filtered = cli(['parse', '--prefix', '203.0.113.5/24', '--from', '1700000001', '--to', '1700000001', '-'], demo());
  assert.equal(JSON.parse(filtered.stdout).attributes.path.at(-1).asns.at(-1), 65537);
  const csv = cli(['parse', '--format', 'csv', '-'], demo());
  assert.equal(csv.status, 0, csv.stderr);
  assert.equal(csv.stdout.trim().split('\n').length, 7);
});

test('快照接续更新的统计和变化分析', () => {
  const stats = cli(['stats', '--threshold', '3', '-'], demo());
  assert.equal(stats.status, 0, stats.stderr);
  const summary = JSON.parse(stats.stdout);
  assert.equal(Number(summary.records), 8);
  assert.equal(Number(summary.rib_routes), 1);
  assert.equal(Number(summary.announcements), 3);
  assert.equal(Number(summary.withdrawals), 2);
  assert.equal(Number(summary.origin_changes), 1);
  assert.equal(Number(summary.churn_alerts), 1);
  assert.equal(summary.active_routes, 1);
  const changes = cli(['changes', '--threshold', '3', '-'], demo());
  assert.equal(changes.status, 0, changes.stderr);
  assert.deepEqual(changes.stdout.trim().split('\n').map(JSON.parse).map(item => item.kind), ['path_change', 'origin_change', 'churn']);
});

test('gzip 输入和错误退出码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-test-'));
  try {
    const path = join(dir, '测试.mrt.gz');
    writeFileSync(path, gzipSync(demo()));
    const compressed = cli(['stats', path]);
    assert.equal(compressed.status, 0, compressed.stderr);
    const broken = join(dir, 'broken.mrt.gz');
    writeFileSync(broken, Buffer.from('bad gzip'));
    assert.equal(cli(['stats', broken]).status, 1);
    assert.equal(cli(['stats', join(dir, 'missing.mrt')]).status, 1);
    assert.equal(cli(['parse', '-'], demo().subarray(0, 14)).status, 1);
    assert.equal(cli(['stats', '--capacity', '1', '-'], demo()).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
