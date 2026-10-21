import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import {cat, u16, u32, attr, mrt} from '../scripts/fixtures.mjs';

const prefix = Buffer.from([24, 203, 0, 113]);
const hop = Buffer.from([192, 0, 2, 1]);
const asPath = (values, width = 4, kind = 2) => cat(Buffer.from([kind, values.length]), ...values.map(width === 4 ? u32 : u16));
const aggregator = (asn, width = 4, last = 1) => cat(width === 4 ? u32(asn) : u16(asn), Buffer.from([192, 0, 2, last]));
function decode(parts, width = 4, mode = 'parse', time = 100) {
  const configuration = {mode, format: 'json', from_time: 0, to_time: 4294967295, window_seconds: 60, threshold: 10, capacity: 100};
  assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify(configuration))), {});
  return consume(parts, width, time);
}
function consume(parts, width = 4, time = 100) {
  const attributes = cat(...parts);
  const body = cat(u16(0), u16(attributes.length), attributes, prefix);
  const message = cat(Buffer.alloc(16, 255), u16(body.length + 19), Buffer.from([2]), body);
  const transport = cat(width === 4 ? u32(64512) : u16(64512), width === 4 ? u32(64513) : u16(64513), u16(0), u16(1), hop, Buffer.from([192, 0, 2, 2]));
  return JSON.parse(bridge.consume_at(mrt(16, width === 4 ? 4 : 1, cat(transport, message), time), 'attributes.mrt', BigInt(time), 42n));
}
const basics = width => [attr(1, Buffer.from([0])), attr(2, asPath([64512, width === 4 ? 70000 : 23456], width)), attr(3, hop)];
function parsed(parts, width = 4) {
  const result = decode(parts, width);
  assert.equal(result.error, undefined, result.error);
  return JSON.parse(result.lines[0]).attributes;
}

test('三种聚合属性区分缺失、原始值和有效值，保存原始 TLV 信息', () => {
  const empty = parsed(basics(4));
  assert.equal(empty.atomic_aggregate, false);
  assert.equal(empty.aggregator, undefined);
  assert.equal(empty.as4_aggregator, undefined);
  const old = aggregator(23456, 2), next = aggregator(70000, 4, 9);
  const attrs = parsed([...basics(2), attr(6, Buffer.alloc(0)), attr(7, old, 192), attr(18, next, 192)], 2);
  assert.equal(attrs.atomic_aggregate, true);
  assert.deepEqual(attrs.wire_aggregator, {asn: 23456, address: '192.0.2.1'});
  assert.deepEqual(attrs.aggregator, {asn: 70000, address: '192.0.2.9'});
  assert.deepEqual(attrs.as4_aggregator, attrs.aggregator);
  for (const [code, value] of [[6, Buffer.alloc(0)], [7, old], [18, next]]) {
    assert.deepEqual(attrs.raw_attributes.find(a => a.code === code).value, [...value]);
    assert.deepEqual(attrs.other.find(a => a.code === code).value, [...value]);
  }
});

test('AGGREGATOR 与 AS4_AGGREGATOR 的存在、AS_TRANS、ASN 宽度矩阵', () => {
  for (const width of [2, 4]) for (const old of [null, 23456, 64500]) for (const newer of [null, 70000]) for (const withPath of [false, true]) {
    const parts = [...basics(width), ...(old === null ? [] : [attr(7, aggregator(old, width), 192)]),
      ...(newer === null ? [] : [attr(18, aggregator(newer, 4, 9), 192)]),
      ...(withPath ? [attr(17, asPath([80000]), 192)] : [])];
    const result = parsed(parts, width);
    // 此表直接表达 RFC 6793 的存在组合，不调用生产兼容函数。
    const replace = width === 2 && newer !== null && (old === null || old === 23456);
    const expected = replace ? {asn: newer, address: '192.0.2.9'} : old === null ? undefined : {asn: old, address: '192.0.2.1'};
    assert.deepEqual(result.aggregator, expected, JSON.stringify({width, old, newer, withPath}));
    const suppress = width === 4 || (old !== null && old !== 23456 && newer !== null);
    const origin = withPath && !suppress ? 80000 : width === 4 ? 70000 : 23456;
    assert.equal(result.path.at(-1).asns.at(-1), origin);
    assert.equal(result.wire_path[0].asns.at(-1), width === 4 ? 70000 : 23456);
  }
});

test('聚合属性严格检查宽度、非法长度及每个截断点', () => {
  for (const width of [2, 4]) for (const code of [6, 7, 18]) {
    const valid = code === 6 ? Buffer.alloc(0) : aggregator(64512, code === 18 ? 4 : width);
    for (const length of [0, 1, 5, 6, 7, 8, 9]) {
      if (length === valid.length) continue;
      const result = decode([...basics(width), attr(code, Buffer.alloc(length), code === 6 ? 64 : 192)], width);
      assert.match(result.error, /AGGREGATE|AGGREGATOR/);
    }
    const encoded = attr(code, valid, code === 6 ? 64 : 192);
    for (let end = 1; end < encoded.length; end++) {
      const result = decode([...basics(width), encoded.subarray(0, end)], width);
      assert.equal(typeof result.error, 'string');
      assert.ok(Number.isInteger(result.position));
    }
  }
});

test('已知类型验证 Optional、Transitive、Partial；保留位与扩展长度正常接收', () => {
  const values = new Map([[1, [64, Buffer.from([0])]], [2, [64, asPath([64512])]], [3, [64, hop]],
    [4, [128, u32(1)]], [5, [64, u32(100)]], [6, [64, Buffer.alloc(0)]], [7, [192, aggregator(70000)]],
    [8, [192, u32(1)]], [14, [128, cat(u16(2), Buffer.from([1, 16]), Buffer.alloc(16), Buffer.from([0]))]],
    [15, [128, Buffer.from([0, 2, 1])]], [17, [192, asPath([70000])]], [18, [192, aggregator(70000)]],
    [32, [192, cat(u32(70000), u32(1), u32(2))]]]);
  for (const [code, [required, value]] of values) {
    const others = basics(4).filter(a => a[1] !== code);
    for (const flags of [required, required | 15, required | 16, required | 31, ...(required === 192 ? [224, 255] : [])]) {
      const encoded = cat(Buffer.from([flags, code]), flags & 16 ? u16(value.length) : Buffer.from([value.length]), value);
      const attrs = parsed([...others, encoded]);
      assert.deepEqual(attrs.raw_attributes.find(a => a.code === code), {flags, code, value: [...value]});
    }
    for (const flags of [0, 32, 64, 96, 128, 160, 192, 224]) {
      if ((flags & 192) === required && (!(flags & 32) || required === 192)) continue;
      const result = decode([...others, attr(code, value, flags)]);
      assert.match(result.error, /标志/);
    }
  }
});

test('未知 well-known 明确失败；未知 optional 属性完整保留且不修改标志', () => {
  for (const flags of [128, 143, 192, 207, 224, 239]) {
    const attrs = parsed([...basics(4), attr(250, Buffer.from([0, 255, 7]), flags)]);
    assert.deepEqual(attrs.other.find(a => a.code === 250), {flags, code: 250, value: [0, 255, 7]});
  }
  for (const flags of [0, 64]) assert.match(decode([...basics(4), attr(250, Buffer.alloc(0), flags)]).error, /未知 well-known/);
  assert.match(decode([...basics(4), attr(250, Buffer.alloc(0), 160)]).error, /Partial/);
  for (const length of [0, 1, 2, 3, 5]) assert.match(decode([...basics(4), attr(8, Buffer.alloc(length), 192)]).error, /COMMUNITY/);
});

test('聚合与未知属性仅改变保留位/长度编码时不触发变化提醒', () => {
  decode([...basics(4), attr(6, Buffer.alloc(0)), attr(7, aggregator(70000), 192), attr(250, Buffer.from([1]), 128)], 4, 'changes');
  const changed = consume([...basics(4), attr(6, Buffer.alloc(0), 95), attr(7, aggregator(70000), 223), attr(250, Buffer.from([1]), 159)], 4, 101);
  assert.equal(changed.error, undefined);
  assert.deepEqual(changed.lines, []);
  assert.equal(JSON.parse(bridge.finish()).duplicate_announcements, '1');
});
