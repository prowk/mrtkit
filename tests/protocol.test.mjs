import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import { cat, u16, u32, mrt, attr, attributes, bgpUpdate } from '../scripts/fixtures.mjs';

function configure() {
  const reply = JSON.parse(bridge.configure(JSON.stringify({ mode: 'parse', format: 'json', from_time: 0, to_time: 4294967295, window_seconds: 60, threshold: 10, capacity: 1000 })));
  assert.equal(reply.error, undefined);
}
function consume(data) {
  const reply = JSON.parse(bridge.consume(data));
  assert.equal(reply.error, undefined, reply.error);
  return reply.lines.map(JSON.parse);
}

test('扩展微秒时间戳、LOCAL 和 IPv6 会话地址', () => {
  configure();
  const update = bgpUpdate(Buffer.from([24, 192, 0, 2]), undefined, attributes([64512, 65536]));
  const extended = mrt(17, 7, cat(u32(123456), update.subarray(12)));
  const local = consume(extended)[0];
  assert.equal(local.outbound, true);
  assert.equal(local.microseconds, 123456);
  const peer = Buffer.from('20010db8000000000000000000000001', 'hex');
  const self = Buffer.from('20010db8000000000000000000000002', 'hex');
  const v6 = mrt(16, 4, cat(u32(64512), u32(64513), u16(0), u16(2), peer, self, update.subarray(32)));
  assert.equal(consume(v6)[0].peer_ip, '2001:db8::1');
});

test('IPv6 RIB 与精简 MP_REACH 属性', () => {
  configure();
  const address = Buffer.from('20010db8000000000000000000000001', 'hex');
  consume(mrt(13, 1, cat(u32(0), u16(0), u16(1), Buffer.from([3]), u32(0xc0000201), address, u32(65536))));
  const attrs = cat(attr(1, Buffer.from([0])), attr(2, cat(Buffer.from([2, 1]), u32(65536))), attr(14, cat(Buffer.from([16]), address), 0x80));
  const rib = mrt(13, 4, cat(u32(1), Buffer.from('2020010db8', 'hex'), u16(1), u16(0), u32(99), u16(attrs.length), attrs));
  const event = consume(rib)[0];
  assert.equal(event.prefix, '2001:db8::/32');
  assert.equal(event.peer_asn, 65536);
  assert.equal(event.attributes.next_hop, '2001:db8::1');
  assert.equal(event.originated, 99);
});

test('旧式两字节会话保留原始路径并还原 AS4_PATH', () => {
  configure();
  const attrs = cat(attr(1, Buffer.from([0])), attr(2, cat(Buffer.from([2, 2]), u16(64512), u16(23456))), attr(17, cat(Buffer.from([2, 1]), u32(65536)), 0xc0));
  const body = cat(u16(0), u16(attrs.length), attrs, Buffer.from([24, 192, 0, 2]));
  const message = cat(Buffer.alloc(16, 255), u16(19 + body.length), Buffer.from([2]), body);
  const transport = cat(u16(64512), u16(64513), u16(0), u16(1), Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]));
  const event = consume(mrt(16, 1, cat(transport, message)))[0];
  assert.equal(event.attributes.wire_path[0].asns.at(-1), 23456);
  assert.equal(event.attributes.path.at(-1).asns.at(-1), 65536);
});

test('空 UPDATE 和未知 MP 地址族明确统计', () => {
  configure();
  assert.deepEqual(consume(bgpUpdate()), []);
  const unsupported = JSON.parse(bridge.consume(bgpUpdate(undefined, undefined, attr(14, Buffer.from([0, 2, 128]), 0x80))));
  assert.equal(unsupported.ignored_families, 1);
  assert.deepEqual(unsupported.lines, []);
});

test('确定性随机畸形输入不会触发宿主异常', () => {
  let seed = 0x6396;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const valid = bgpUpdate(Buffer.from([24, 192, 0, 2]), undefined, attributes([64512, 65536]));
  for (let i = 0; i < 2000; i++) {
    configure();
    const data = i % 2 === 0 ? Buffer.from(valid) : Buffer.alloc(random() % 256);
    for (let j = 0; j < 1 + random() % 8; j++) {
      if (data.length) data[random() % data.length] = random() & 255;
    }
    const result = JSON.parse(bridge.consume(data));
    assert.ok(typeof result.error === 'string' || Array.isArray(result.lines));
  }
});
