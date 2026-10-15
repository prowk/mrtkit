import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import { cat, u16, u32, mrt, attr } from '../scripts/fixtures.mjs';
import { ReferenceModel } from './reference_model.mjs';

function encode(event) {
  const transport = cat(u32(64512), u32(64514), u16(0), u16(1), Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]));
  if (event.kind === 'reset') return mrt(17, 5, cat(u32(event.time), transport, u16(6), u16(1)), 100);
  const nlri = cat(u32(event.id), Buffer.from([24, 203, 0, 113]));
  const isWithdraw = event.kind === 'withdraw';
  const attrs = isWithdraw ? Buffer.alloc(0) : cat(attr(1, Buffer.from([0])), attr(2, cat(Buffer.from([2, event.path.length]), ...event.path.map(u32))), attr(3, Buffer.from([192, 0, 2, event.attributes[0]])), attr(8, u32(event.attributes[1]), 192));
  const withdrawn = isWithdraw ? nlri : Buffer.alloc(0), announced = isWithdraw ? Buffer.alloc(0) : nlri;
  const body = cat(u16(withdrawn.length), withdrawn, u16(attrs.length), attrs, announced);
  return mrt(17, 9, cat(u32(event.time), transport, Buffer.alloc(16, 255), u16(body.length + 19), Buffer.from([2]), body), 100);
}

function compare(sequence, config = {}) {
  const lower = config.lower ?? 500, upper = config.upper ?? 900;
  assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({ mode: 'changes', format: 'json', from_time: 100, from_micros: lower, to_time: 100, to_micros: upper, window_seconds: 60, threshold: 3, capacity: 100 }))), {});
  const model = new ReferenceModel({ lower, upper });
  if (config.seed) {
    assert.deepEqual(JSON.parse(bridge.begin_baseline()), {});
    const attrs = cat(attr(1, Buffer.from([0])), attr(2, cat(Buffer.from([2, 2]), u32(64512), u32(1))), attr(3, Buffer.from([192, 0, 2, 1])), attr(8, u32(1), 192));
    const peers = mrt(13, 1, cat(u32(0), u16(0), u16(1), Buffer.from([2]), u32(0), Buffer.from([192, 0, 2, 1]), u32(64512)), 100);
    const rib = mrt(13, 8, cat(u32(0), Buffer.from([24, 203, 0, 113]), u16(1), u16(0), u32(99), u32(0), u16(attrs.length), attrs), 100);
    for (const data of [peers, rib]) assert.equal(JSON.parse(bridge.consume(data)).error, undefined);
    bridge.reset_file();
    model.seed(0, [64512, 1], [1, 1]);
  }
  const actualChanges = [];
  for (let i = 0; i < sequence.length; i++) {
    const event = { path: [64512, 1], attributes: [1, 1], id: 0, ...sequence[i], ordinal: i + 1 };
    model.apply(event);
    const result = JSON.parse(bridge.consume_at(encode(event), `part-${i % 3}.mrt`, BigInt(i + 1), BigInt(i * 1000)));
    assert.equal(result.error, undefined, `第 ${i + 1} 个输入解析失败`);
    actualChanges.push(...result.lines.map(JSON.parse).map(c => ({ kind: c.kind, id: c.path_id, ordinal: Number(c.source.record) })));
    const actualState = JSON.parse(bridge.state()).map(e => ({ id: e.path_id, active: e.action === 'active', path: e.attributes.path.flatMap(s => s.asns), time: e.microseconds ?? 0, attributes: e.attributes.next_hop ? [Number(e.attributes.next_hop.split('.').at(-1)), e.attributes.communities[0]] : [] })).sort((a, b) => a.id - b.id);
    assert.deepEqual(actualState, model.state(), `输入 ${i + 1} 后的状态不同`);
  }
  assert.deepEqual(actualChanges, model.changes);
  const actual = JSON.parse(bridge.finish());
  for (const [key, expected] of Object.entries(model.counts)) assert.equal(Number(actual[key]), expected, key);
}

test('独立模型覆盖预热、重复、撤回、恢复、属性、路径、重置和乱序', () => {
  compare([
    { kind: 'announce', time: 350 }, { kind: 'reset', time: 400 }, { kind: 'announce', time: 390 },
    { kind: 'announce', time: 499 }, { kind: 'announce', time: 500 }, { kind: 'announce', time: 510 },
    { kind: 'withdraw', time: 520 }, { kind: 'withdraw', time: 530 }, { kind: 'announce', time: 540 },
    { kind: 'announce', time: 550, path: [64512, 2] }, { kind: 'announce', time: 560, path: [64512, 3], attributes: [2, 2] },
    { kind: 'announce', time: 570, id: 1 }, { kind: 'reset', time: 565 }, { kind: 'reset', time: 580 },
    { kind: 'announce', time: 579 }, { kind: 'announce', time: 590 }, { kind: 'reset', time: 901 },
    { kind: 'announce', time: 900 }, { kind: 'withdraw', time: 902 },
  ]);
});

test('独立模型逐步核对 1200 个确定性状态事件', () => {
  let seed = 6396;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const sequence = [];
  for (let i = 0; i < 1200; i++) {
    const time = Math.min(999, Math.floor(i * 999 / 1200));
    sequence.push({ kind: random() % 31 === 0 ? 'reset' : random() % 4 === 0 ? 'withdraw' : 'announce', time: random() % 9 === 0 ? Math.max(0, time - 3) : time, id: random() % 5, path: [64512, 1 + random() % 3], attributes: [1 + random() % 2, random() % 3] });
  }
  compare(sequence);
  compare(sequence, { seed: true });
});
