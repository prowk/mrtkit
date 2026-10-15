import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cat, mrt, u16, u32, attributes, bgpUpdate } from '../scripts/fixtures.mjs';

const prefix = Buffer.from([24, 203, 0, 113]);
const announce = (time, origin = 1) => bgpUpdate(prefix, undefined, attributes([64512, origin]), time);
const withdraw = time => bgpUpdate(undefined, prefix, undefined, time);
const tick = time => mrt(99, 0, Buffer.alloc(0), time);
const reset = time => mrt(16, 5, cat(u32(64512), u32(64513), u16(0), u16(1),
  Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]), u16(6), u16(1)), time);
function micros(data, fraction) {return mrt(17, data.readUInt16BE(6), cat(u32(fraction), data.subarray(12)), data.readUInt32BE(0));}
function addpath(id, time, withdrawn = false) {
  const record = withdrawn ? bgpUpdate(undefined, cat(u32(id), prefix), undefined, time)
    : bgpUpdate(cat(u32(id), prefix), undefined, attributes([64512, 1]), time);
  record.writeUInt16BE(9, 6); return record;
}
function baseline(ids = null, includeRoute = true) {
  const peers = mrt(13, 1, cat(u32(1), u16(0), u16(2), ...[64512, 64514].map((asn, i) =>
    cat(Buffer.from([2]), u32(asn), Buffer.from([192, 0, 2, i + 1]), u32(asn)))), 90);
  if (!includeRoute) return peers;
  const attrs = attributes([64512, 1]);
  const entries = (ids ?? [null]).map(id => cat(u16(0), u32(89), ...(id === null ? [] : [u32(id)]), u16(attrs.length), attrs));
  return cat(peers, mrt(13, ids === null ? 2 : 8, cat(u32(0), prefix, u16(entries.length), ...entries), 90));
}
function run(data, extra = [], initial = null) {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-timeline-'));
  try {
    const args = ['cli/mrtkit.mjs', 'timeline', '--prefix', '203.0.113.5/24', ...extra];
    if (initial) {const file = join(dir, 'initial.mrt'); writeFileSync(file, initial); args.push('--initial-rib', file);}
    const result = spawnSync(process.execPath, [...args, '-'], {input: data, encoding: 'utf8', windowsHide: true});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {rmSync(dir, {recursive: true, force: true});}
}

test('时间线按秒/微秒排序，记录路径变化、撤回、恢复、重置和被忽略的乱序', () => {
  const data = cat(announce(100), announce(101), announce(102, 2), withdraw(103), withdraw(104),
    announce(106, 2), reset(107), announce(105, 3), tick(109));
  const {summary, timeline: t} = run(data, ['--continuous-observation']);
  assert.deepEqual(t.entries.map(e => e.kind), ['announce', 'announce', 'path_change', 'withdraw', 'withdraw', 'out_of_order', 'reannounce', 'session_reset']);
  assert.equal(t.entries.find(e => e.kind === 'out_of_order').accepted, false);
  assert.equal(t.entries.find(e => e.kind === 'path_change').changes.length, 2);
  assert.equal(t.entries.find(e => e.kind === 'withdraw').source.record, '4');
  assert.equal(summary.active_routes, 0);
  assert.equal(summary.out_of_order, '1');
  assert.equal(t.interpretation, 'collector_route_visibility_not_business_outage');
  for (const intervals of [t.intervals, t.peer_intervals]) {
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].known_invisible_microseconds, '3000000');
    assert.equal(intervals[0].left_censored, false);
    assert.equal(intervals[0].right_censored, false);
  }
  assert.equal(t.peers[0].visibility, 'unobserved');
  const precise = run(cat(micros(announce(100), 100), micros(withdraw(100), 500), micros(announce(100), 900)), ['--continuous-observation']).timeline;
  assert.equal(precise.peer_intervals[0].known_invisible_microseconds, '400');
});

test('缺少基线、恢复、连续性或存在观测中断时明确表达不确定性', () => {
  const data = cat(withdraw(101), announce(103), tick(105));
  const noClaim = run(data).timeline;
  assert.equal(noClaim.baseline_status, 'missing');
  assert.equal(noClaim.intervals[0].known_invisible_microseconds, undefined);
  assert.equal(noClaim.intervals[0].quality, 'continuity_unverified');
  assert.equal(noClaim.intervals[0].left_censored, true);
  const open = run(cat(withdraw(101), tick(105)), ['--continuous-observation', '--to', '104', '--to-micros', '0']).timeline;
  assert.equal(open.peer_intervals[0].known_invisible_microseconds, '3000000');
  assert.equal(open.peer_intervals[0].right_censored, true);
  assert.equal(open.peer_intervals[0].recovery_time, undefined);
  assert.equal(open.peer_intervals[0].closed_by, 'observation_end');
  const gap = run(data, ['--continuous-observation', '--observation-gap', '101.5:102.5']).timeline;
  assert.equal(gap.intervals[0].known_invisible_microseconds, undefined);
  assert.equal(gap.intervals[0].quality, 'observation_gap');
  assert.ok(gap.entries.some(e => e.kind === 'observation_gap' && e.microseconds === 500000));
  const afterGap = run(cat(announce(100), tick(110)), ['--continuous-observation', '--observation-gap', '105:108']).timeline;
  assert.equal(afterGap.peers[0].visibility, 'unobserved');
  const priorGap = run(cat(withdraw(95), announce(103)), ['--from', '100', '--continuous-observation', '--observation-gap', '96:99']).timeline;
  assert.equal(priorGap.intervals[0].known_invisible_microseconds, undefined);
});

test('显式 RIB 和预热不输出时间线事件，peer 表保留未出现前缀的 peer', () => {
  const {summary, timeline: t} = run(cat(announce(95), withdraw(101), announce(103), tick(104)),
    ['--from', '100', '--continuous-observation'], baseline());
  assert.equal(summary.rib_routes, '0');
  assert.equal(summary.warmup_records, '1');
  assert.deepEqual(t.entries.map(e => e.kind), ['withdraw', 'reannounce']);
  assert.equal(t.baseline_status, 'explicit_rib');
  assert.equal(t.peers.find(p => p.peer_asn === 64514).visibility, 'not_visible');
  const absent = t.peer_intervals.find(i => i.peer_asn === 64514);
  assert.equal(absent.measured_from, '100000000');
  assert.equal(absent.left_censored, true);
  assert.equal(absent.right_censored, true);
  assert.equal(absent.known_invisible_microseconds, '4000000');
  const resetAbsent = run(cat(reset(101), tick(104)), ['--from', '100'], baseline(null, false)).timeline;
  assert.equal(resetAbsent.peers.find(p => p.peer_asn === 64512).visibility, 'unobserved');
});

test('ADD-PATH 撤回一条路径不改变 peer 可见性，缺少完整基线时不假设路径集完整', () => {
  const data = cat(addpath(0, 100), addpath(7, 101), addpath(0, 102, true), addpath(7, 103, true), addpath(7, 105), tick(106));
  const t = run(data, ['--from', '100', '--continuous-observation'], baseline([0, 7])).timeline;
  assert.equal(t.intervals.find(i => i.path_id === 0).known_invisible_microseconds, '4000000');
  assert.equal(t.peer_intervals.filter(i => i.peer_asn === 64512).length, 1);
  assert.equal(t.peer_intervals.find(i => i.peer_asn === 64512).known_invisible_microseconds, '2000000');
  assert.equal(t.peers.find(p => p.peer_asn === 64512).visible_paths, 1);
  const unknown = run(cat(addpath(0, 100), addpath(0, 102, true), tick(104)), ['--continuous-observation']).timeline;
  assert.equal(unknown.peers[0].visibility, 'unobserved');
  assert.equal(unknown.peer_intervals.length, 0);
});

test('跨文件窗口和 peer 筛选生效，非法参数及事件超限明确失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrtkit-timeline-files-'));
  try {
    const a = join(dir, 'a.mrt'), b = join(dir, 'b.mrt');
    writeFileSync(a, cat(announce(99), withdraw(100))); writeFileSync(b, cat(announce(101), reset(102)));
    const cli = args => spawnSync(process.execPath, ['cli/mrtkit.mjs', ...args], {encoding: 'utf8', windowsHide: true});
    const result = cli(['timeline', '--prefix', '203.0.113.0/24', '--from', '100', '--to', '101', '--peer-asn', '64512', a, b]);
    assert.equal(result.status, 0, result.stderr);
    const t = JSON.parse(result.stdout).timeline;
    assert.deepEqual(t.entries.map(e => e.kind), ['withdraw', 'reannounce']);
    assert.equal(t.peers[0].visibility, 'visible');
    assert.equal(t.entries[1].source.file, b);
    for (const args of [['timeline', a], ['timeline', '--prefix', '203.0.113.0/24', '--prefix-mode', 'covering', a],
      ['timeline', '--prefix', '203.0.113.0/24', '--observation-gap', '105:100', a],
      ['timeline', '--prefix', '203.0.113.0/24', '--capacity', '1', a, b]]) assert.equal(cli(args).status, 1);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
