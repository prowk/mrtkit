import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import { cat, u16, u32, mrt, attributes, attr, bgpUpdate } from '../scripts/fixtures.mjs';

// 独立构造 peer 索引和任意排序的单播快照。
function table(peers, time = 100, collector = 1, view = '') {
  const name = Buffer.from(view);
  return mrt(13, 1, cat(u32(collector), u16(name.length), name, u16(peers.length), ...peers.map(asn =>
    cat(Buffer.from([2]), u32(asn), Buffer.from([192, 0, asn & 255, 1]), u32(asn)))), time);
}
function rib(index, octet, path, time = 100, extra = Buffer.alloc(0), id = null, v6 = false) {
  const attrs = cat(attributes(path), extra);
  const prefix = v6 ? Buffer.from([33, 0x20, 1, 0xdb, octet, 128]) : Buffer.from([24, 203, 0, octet]);
  return mrt(13, v6 ? id === null ? 4 : 10 : id === null ? 2 : 8,
    cat(u32(octet), prefix, u16(1), u16(index), u32(90), ...(id === null ? [] : [u32(id)]), u16(attrs.length), attrs), time);
}
function setup(a = 'test', b = 'test', extra = {}) {
  assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({ mode: 'snapshot-diff', format: 'json',
    from_time: 0, to_time: 4294967295, window_seconds: 60, threshold: 10, capacity: 100, ...extra }))), {});
  assert.deepEqual(JSON.parse(bridge.snapshot_begin(a, b)), {});
}
function load(parts, after = false) {
  let offset = 0;
  return parts.map((part, i) => {
    const result = JSON.parse(bridge.snapshot_consume(part, after, after ? 'after.mrt' : 'before.mrt', BigInt(i + 1), BigInt(offset)));
    offset += part.length;
    return result;
  });
}
function compare(a, b) {
  setup();
  assert.ok([...load(a), ...load(b, true)].every(r => !r.error));
  return JSON.parse(bridge.snapshot_finish());
}

test('快照同时输出路径、起源、属性变化，区分路由缺失与整个 peer 缺失', () => {
  const report = compare([table([1, 2, 3]), rib(0, 1, [1, 10]), rib(0, 2, [1]), rib(1, 3, [2])],
    [table([1, 3, 4], 200), rib(0, 1, [1, 11], 200, attr(8, u32(123), 192)), rib(0, 4, [1], 200)]);
  assert.equal(report.interpretation, 'snapshot_presence_difference_not_observed_bgp_withdrawal');
  assert.deepEqual(report.changes.map(c => c.kind), ['peer_missing', 'peer_added', 'path_change', 'origin_change', 'attribute_change', 'route_missing', 'route_added']);
  assert.equal(report.changes.filter(c => c.prefix === '203.0.3.0/24').length, 0);
  const changed = report.changes.find(c => c.kind === 'attribute_change');
  assert.deepEqual(changed.diff.communities.added, [123]);
  assert.equal(changed.before.source.record, '2');
  assert.equal(changed.after.source.file, 'after.mrt');
  assert.equal(report.changes.some(c => c.kind.includes('withdraw')), false);
});

test('快照排序不改变语义；peer 存在但零路由仍可判断条目缺失', () => {
  const before = [table([1, 2]), rib(0, 1, [1]), rib(0, 2, [1]), rib(1, 3, [2])];
  const after = [table([2, 1], 200), rib(1, 2, [1], 200), rib(1, 4, [1], 200)];
  const normalize = r => r.changes.map(c => [c.kind, c.peer_asn, c.prefix, c.path_id]);
  assert.deepEqual(normalize(compare(before, after)), normalize(compare([before[0], ...before.slice(1).reverse()], [after[0], ...after.slice(1).reverse()])));
  assert.equal(compare(before, after).changes.some(c => c.kind === 'peer_missing'), false);
  assert.ok(compare(before, after).changes.some(c => c.kind === 'route_missing' && c.peer_asn === 2));
});

test('快照拒绝采集器、视图、时间、重复键、不支持记录和超容量', () => {
  setup('a', 'b'); load([table([1])]); load([table([1], 200)], true);
  assert.match(JSON.parse(bridge.snapshot_finish()).error, /不可比较/);
  for (const [a, b] of [[table([1]), table([1], 200, 2)], [table([1]), table([1], 200, 1, 'x')], [table([1], 300), table([1], 200)]]) {
    setup(); load([a]); load([b], true); assert.ok(JSON.parse(bridge.snapshot_finish()).error);
  }
  setup(); load([table([1])]); assert.match(load([bgpUpdate()])[0].error, /TABLE_DUMP/);
  setup(); load([table([1]), rib(0, 1, [1])]); assert.match(load([rib(0, 1, [2])])[0].error, /重复/);
  setup('test', 'test', { capacity: 1 }); load([table([1]), rib(0, 1, [1])]); assert.match(load([rib(0, 2, [1])])[0].error, /容量/);
  setup(); assert.match(JSON.parse(bridge.snapshot_finish()).error, /为空/);
});

test('快照 ADD-PATH 的 IPv4/IPv6 路径标识分别比较，普通路径与标识零互不覆盖', () => {
  const a = [table([1]), rib(0, 1, [1]), rib(0, 1, [1], 100, undefined, 0), rib(0, 1, [1], 100, undefined, 7), rib(0, 0xb8, [1], 100, undefined, 7, true)];
  const b = [table([1], 200), rib(0, 1, [1], 200), rib(0, 1, [1], 200, undefined, 0), rib(0, 0xb8, [2], 200, undefined, 7, true)];
  const report = compare(a, b);
  assert.equal(report.before_routes, 4);
  assert.deepEqual(report.changes.filter(c => c.kind === 'route_missing').map(c => c.path_id), [7]);
  assert.equal(report.changes.filter(c => c.kind === 'path_change')[0].prefix, '2001:dbb8:8000::/33');
});

test('快照 CLI 要求显式采集器，支持前缀/peer 筛选并保持纯 JSON 输出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-snapshot-'));
  try {
    const a = join(dir, 'a.mrt'), b = join(dir, 'b.mrt');
    writeFileSync(a, cat(table([1, 2]), rib(0, 1, [1]), rib(1, 2, [2])));
    writeFileSync(b, table([1, 2], 200));
    const run = args => spawnSync(process.execPath, ['cli/mrtkit.mjs', 'snapshot-diff', ...args, a, b], { encoding: 'utf8', windowsHide: true });
    assert.equal(run([]).status, 1);
    const result = run(['--collector', 'test', '--peer-asn', '1', '--prefix', '203.0.1.200/24']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout).changes.map(c => [c.kind, c.prefix]), [['route_missing', '203.0.1.0/24']]);
    assert.equal(run(['--collector', 'test', '--from', '100']).status, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
