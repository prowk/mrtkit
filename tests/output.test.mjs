import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import { bgpUpdate, attributes, attr, mrt, cat, u32 } from '../scripts/fixtures.mjs';
import { options } from '../cli/options.mjs';

function configure(mode = 'changes') {
  assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({ mode, format: 'json', from_time: 0, to_time: 4294967295, window_seconds: 60, threshold: 10, capacity: 1000 }))), {});
}
test('同一事件的路径、起源、下一跳和社区差异均为结构化前后值', () => {
  configure();
  const prefix = Buffer.from([24, 203, 0, 113]);
  const update = (micros, path, communities, hop = 1) => {
    const basic = attributes(path);
    const attrs = cat(basic.subarray(0, -1), Buffer.from([hop]), attr(8, cat(...communities.map(u32)), 192));
    const raw = bgpUpdate(prefix, undefined, attrs, 100);
    return mrt(17, 4, cat(u32(micros), raw.subarray(12)), 100);
  };
  const first = update(500, [64512, 1], [1, 2]);
  const second = update(600, [64512, 2], [2, 3], 2);
  assert.equal(JSON.parse(bridge.consume_at(first, 'before.mrt.gz', 1n, 0n)).lines.length, 0);
  const changes = JSON.parse(bridge.consume_at(second, 'after.mrt.gz', 5n, 900n)).lines.map(JSON.parse);
  assert.deepEqual(changes.map(c => c.kind), ['path_change', 'origin_change', 'attribute_change']);
  for (const change of changes) {
    assert.equal(change.schema_version, '2.0');
    assert.equal(change.microseconds, 600);
    assert.equal(typeof change.before, 'object');
    assert.equal(typeof change.after.attributes, 'object');
    assert.deepEqual(change.diff.origin_as, { before: 1, after: 2 });
    assert.deepEqual(change.diff.next_hop, { before: '192.0.2.1', after: '192.0.2.2' });
    assert.deepEqual(change.diff.communities, { before: [1, 2], after: [2, 3], added: [3], removed: [1] });
    assert.equal(change.before.source.file, 'before.mrt.gz');
    assert.deepEqual(change.source, { file: 'after.mrt.gz', record: '5', offset: '900', event_index: 0 });
    assert.equal(change.after.source.offset, '900');
  }
  const state = JSON.parse(bridge.state())[0];
  assert.equal(state.source.file, 'after.mrt.gz');
  assert.equal(state.action, 'active');
});

test('同一记录内多事件具有不同索引且来源偏移指记录起点', () => {
  configure('parse');
  const raw = bgpUpdate(Buffer.from([24, 192, 0, 2, 24, 203, 0, 113]), undefined, attributes([64512, 1]), 100);
  const reply = JSON.parse(bridge.consume_at(raw, '多前缀.mrt', 2n, 55n));
  assert.deepEqual(reply.lines.map(JSON.parse).map(e => e.source), [0, 1].map(event_index => ({ file: '多前缀.mrt', record: '2', offset: '55', event_index })));
  assert.throws(() => options(['parse', '--output-version', '1', '-']));
});
