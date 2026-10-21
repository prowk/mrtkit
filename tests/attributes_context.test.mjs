import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import {cat, u16, u32, mrt, attr, attributes, bgpUpdate} from '../scripts/fixtures.mjs';

const prefix = Buffer.from([24, 203, 0, 113]);
const origin = attr(1, Buffer.from([0]));
const path = attr(2, Buffer.alloc(0));
const hop = attr(3, Buffer.from([192, 0, 2, 1]));
const reach = attr(14, cat(u16(2), Buffer.from([1, 16]), Buffer.from('20010db8000000000000000000000001', 'hex'),
  Buffer.from([9, 32, 0x20, 1, 0xdb, 0xb8])), 128);
const unreach = attr(15, Buffer.from([0, 2, 1]), 128);
function configure(mode = 'parse', extra = {}) {
  const result = JSON.parse(bridge.configure(JSON.stringify({mode, format: 'json', from_time: 0, to_time: 4294967295,
    window_seconds: 60, threshold: 10, capacity: 100, ...extra})));
  assert.equal(result.error, undefined);
}
function parse(raw) {configure(); return JSON.parse(bridge.consume(raw));}
function peerTable(time = 100) {
  return mrt(13, 1, cat(u32(1), u16(0), u16(1), Buffer.from([2]), u32(1), Buffer.from([192, 0, 2, 1]), u32(64512)), time);
}
function rib(attrs, time = 100) {
  return mrt(13, 2, cat(u32(0), prefix, u16(1), u16(0), u32(90), u16(attrs.length), attrs), time);
}

test('普通 IPv4 宣告要求 ORIGIN/AS_PATH/NEXT_HOP，空 AS_PATH 属于存在而非缺失', () => {
  const mandatory = [origin, path, hop];
  assert.equal(parse(bgpUpdate(prefix, undefined, cat(...mandatory))).error, undefined);
  for (let i = 0; i < mandatory.length; i++) {
    const result = parse(bgpUpdate(prefix, undefined, cat(...mandatory.filter((_, index) => index !== i))));
    assert.match(result.error, new RegExp(['ORIGIN', 'AS_PATH', 'NEXT_HOP'][i]));
    assert.equal(result.position, 0);
  }
  assert.match(parse(bgpUpdate(prefix, undefined, cat(origin, path, reach))).error, /NEXT_HOP/);
});

test('MP_REACH 单独检查宣告上下文，纯撤回、MP_UNREACH 与空 UPDATE 不强求宣告属性', () => {
  assert.equal(parse(bgpUpdate(undefined, undefined, cat(origin, path, reach))).error, undefined);
  for (const attrs of [reach, cat(origin, reach), cat(path, reach)]) assert.match(parse(bgpUpdate(undefined, undefined, attrs)).error, /必需属性/);
  assert.equal(parse(bgpUpdate(undefined, prefix)).error, undefined);
  assert.equal(parse(bgpUpdate(undefined, undefined, unreach)).error, undefined);
  assert.equal(parse(bgpUpdate()).error, undefined);
  assert.equal(parse(bgpUpdate(undefined, prefix, cat(origin, path, reach))).error, undefined);
  const emptyReach = reach.subarray(0, -5);
  const corrected = Buffer.from(emptyReach); corrected[2] -= 5;
  assert.match(parse(bgpUpdate(undefined, undefined, corrected)).error, /ORIGIN/);
  assert.equal(parse(bgpUpdate(undefined, undefined, cat(origin, path, corrected))).error, undefined);
  for (const value of [Buffer.from([0, 2, 128]), Buffer.from([0, 2, 128, 16, 0])]) {
    assert.equal(typeof parse(bgpUpdate(undefined, undefined, attr(14, value, 128))).error, 'string');
  }
});

test('RIB 是属性快照而非 UPDATE，不推断未记录的宣告必需属性，已有属性仍严格校验', () => {
  configure();
  bridge.consume(peerTable());
  assert.equal(JSON.parse(bridge.consume(rib(path))).error, undefined);
  configure(); bridge.consume(peerTable());
  assert.match(JSON.parse(bridge.consume(rib(attr(7, Buffer.alloc(6), 192)))).error, /AGGREGATOR/);
});

test('聚合属性出现、消失及两种兼容编码贯通变化、时间线和聚合，编码等价不误报', () => {
  const aggregate = attr(7, cat(u32(70000), Buffer.from([192, 0, 2, 9])), 192);
  const atomic = attr(6, Buffer.alloc(0));
  const direct = extras => bgpUpdate(prefix, undefined, cat(attributes([64512, 70000]), ...extras), 100);
  const oldPath = attr(2, cat(Buffer.from([2, 2]), u16(64512), u16(23456)));
  const legacyAttrs = cat(origin, oldPath, hop, atomic, attr(17, cat(Buffer.from([2, 1]), u32(70000)), 192),
    attr(7, cat(u16(23456), Buffer.from([192, 0, 2, 1])), 192), attr(18, cat(u32(70000), Buffer.from([192, 0, 2, 9])), 192));
  const updateBody = cat(u16(0), u16(legacyAttrs.length), legacyAttrs, prefix);
  const message = cat(Buffer.alloc(16, 255), u16(updateBody.length + 19), Buffer.from([2]), updateBody);
  const legacy = mrt(16, 1, cat(u16(64512), u16(64513), u16(0), u16(1), Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]), message), 102);
  const raw = [direct([]), direct([atomic, aggregate]), legacy, direct([])].map((frame, i) => {
    const result = Buffer.from(frame); result.writeUInt32BE(100 + i, 0); return result;
  });
  const feed = () => raw.flatMap((frame, i) => {
    const result = JSON.parse(bridge.consume_at(frame, 'aggregate.mrt', BigInt(i + 1), BigInt(i * 100)));
    assert.equal(result.error, undefined, result.error); return result.lines.map(JSON.parse);
  });
  configure('changes');
  const changes = feed();
  assert.deepEqual(changes.map(c => c.kind), ['attribute_change', 'attribute_change']);
  assert.deepEqual(changes[0].diff.atomic_aggregate, {before: false, after: true});
  assert.deepEqual(changes[0].diff.aggregator, {before: null, after: {asn: 70000, address: '192.0.2.9'}});
  assert.equal(changes[1].diff.aggregator.after, null);
  assert.equal(changes[1].before.source.record, '3');
  assert.equal(changes[0].source.record, '2');
  configure('timeline', {prefix: '203.0.113.0/24'}); feed();
  const timeline = JSON.parse(bridge.finish()).timeline;
  assert.equal(timeline.entries.filter(e => e.kind === 'attribute_change').length, 2);
  configure('aggregate'); feed();
  const report = JSON.parse(bridge.finish()).aggregation;
  assert.equal(report.change_types.attribute_change, '2');
  assert.equal(report.top_prefixes[0].changed_events, 2);
  configure('parse', {format: 'csv', asn: 70000});
  const result = JSON.parse(bridge.consume(direct([atomic, aggregate])));
  const names = bridge.csv_header().split(','), values = result.lines[0].split(',');
  assert.equal(values[names.indexOf('atomic_aggregate')], 'true');
  assert.equal(values[names.indexOf('aggregator_asn')], '70000');
  assert.equal(values[names.indexOf('as4_aggregator_asn')], '');
  configure('snapshot-diff'); bridge.snapshot_begin('collector', 'collector');
  for (const after of [false, true]) for (const [i, frame] of [peerTable(after ? 200 : 100), rib(cat(attributes([64512, 70000]), ...(after ? [atomic, aggregate] : [])), after ? 200 : 100)].entries()) {
    assert.equal(JSON.parse(bridge.snapshot_consume(frame, after, after ? 'after' : 'before', BigInt(i + 1), 0n)).error, undefined);
  }
  const snapshot = JSON.parse(bridge.snapshot_finish());
  assert.equal(snapshot.changes[0].kind, 'attribute_change');
  assert.equal(snapshot.changes[0].diff.atomic_aggregate.after, true);
  assert.equal(snapshot.changes[0].diff.aggregator.after.asn, 70000);
});
