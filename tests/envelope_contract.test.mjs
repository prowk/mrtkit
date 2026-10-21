import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import {cat, mrt, u16, u32} from '../scripts/fixtures.mjs';

function decode(data) {
  assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({mode: 'parse', format: 'json', from_time: 0,
    to_time: 4294967295, window_seconds: 60, threshold: 3, capacity: 100}))), {});
  return JSON.parse(bridge.consume(data));
}
function message(kind, body, marker = 255, declared = 19 + body.length) {
  return mrt(16, 4, cat(u32(64512), u32(64513), u16(0), u16(1),
    Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]), Buffer.alloc(16, marker), u16(declared), Buffer.from([kind]), body));
}

test('非 UPDATE 的四种消息只承诺信封和基本长度校验，合法消息不生成路由', () => {
  for (const [kind, body] of [[1, Buffer.alloc(10)], [1, Buffer.alloc(12)], [3, Buffer.alloc(2)],
    [3, Buffer.alloc(4)], [4, Buffer.alloc(0)], [5, Buffer.alloc(4)]]) {
    const result = decode(message(kind, body));
    assert.equal(result.error, undefined);
    assert.deepEqual(result.lines, []);
    assert.equal(result.skipped, false);
  }
  for (const [kind, size] of [[1, 9], [3, 1], [4, 1], [5, 3], [5, 5]]) {
    assert.equal(typeof decode(message(kind, Buffer.alloc(size))).error, 'string');
  }
});

test('BGP marker、长度、类型、MRT 会话 AFI 与扩展微秒的正反边界', () => {
  for (const data of [message(4, Buffer.alloc(0), 0), message(4, Buffer.alloc(0), 255, 18),
    message(4, Buffer.alloc(0), 255, 20), message(0, Buffer.alloc(0)), message(6, Buffer.alloc(0))]) {
    assert.equal(typeof decode(data).error, 'string');
  }
  const valid = message(4, Buffer.alloc(0));
  const invalidAfi = Buffer.from(valid); invalidAfi.writeUInt16BE(3, 22);
  assert.equal(typeof decode(invalidAfi).error, 'string');
  for (const micros of [0, 999999]) assert.equal(decode(mrt(17, 4, cat(u32(micros), valid.subarray(12)))).error, undefined);
  assert.equal(typeof decode(mrt(17, 4, cat(u32(1000000), valid.subarray(12)))).error, 'string');
});

test('peer 表保留位和条目截断失败，空表合法，范围外 MRT 子类型明确跳过', () => {
  assert.equal(decode(mrt(13, 1, cat(u32(0), u16(0), u16(0)))).error, undefined);
  for (const flags of [4, 128]) {
    assert.equal(typeof decode(mrt(13, 1, cat(u32(0), u16(0), u16(1), Buffer.from([flags]), Buffer.alloc(14)))).error, 'string');
  }
  assert.equal(typeof decode(mrt(13, 1, cat(u32(0), u16(0), u16(1), Buffer.from([2])))).error, 'string');
  for (const [kind, subtype] of [[12, 1], [13, 6], [13, 12], [16, 2]]) {
    const result = decode(mrt(kind, subtype, Buffer.alloc(0)));
    assert.equal(result.error, undefined);
    assert.equal(result.skipped, true);
  }
});
