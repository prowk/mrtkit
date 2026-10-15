import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cat, attr, u32, attributes, bgpUpdate } from '../scripts/fixtures.mjs';

function run(mode, data, extra = []) {
  const result = spawnSync(process.execPath, ['cli/mrtkit.mjs', mode, '--threshold', '100', ...extra, '-'],
    { input: data, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('聚合结果可由结构化变化复算，多个类型共用一次来源事件计数', () => {
  const update = (octet, origin, time, community = null, peer = 64512) => {
    const raw = bgpUpdate(Buffer.from([24, 203, 0, octet]), undefined,
      cat(attributes([64512, origin]), ...(community === null ? [] : [attr(8, u32(community), 192)])), time);
    raw.writeUInt32BE(peer, 12);
    return raw;
  };
  const data = cat(update(2, 1, 100), update(2, 2, 101), update(1, 1, 102), update(1, 2, 103),
    update(2, 2, 104, 1), update(2, 1, 105, null, 64513), update(2, 2, 106, null, 64513));
  const changes = run('changes', data).trim().split('\n').map(JSON.parse);
  const { aggregation } = JSON.parse(run('aggregate', data));
  const expected = new Map(), types = {}, peers = new Set();
  for (const c of changes) {
    const row = expected.get(c.prefix) ?? {events: new Set(), peers: new Set(), types: {}, notices: 0};
    row.events.add(JSON.stringify(c.source));
    const peer = JSON.stringify([c.peer_asn, c.peer_ip, c.outbound]);
    row.peers.add(peer); peers.add(peer);
    row.types[c.kind] = String(BigInt(row.types[c.kind] ?? 0) + 1n);
    types[c.kind] = String(BigInt(types[c.kind] ?? 0) + 1n);
    row.notices++; expected.set(c.prefix, row);
  }
  const ranking = [...expected].map(([prefix, r]) => ({prefix, changed_events: r.events.size,
    change_notices: String(r.notices), affected_peers: r.peers.size, change_types: r.types}))
    .sort((a, b) => b.changed_events - a.changed_events || a.prefix.localeCompare(b.prefix));
  assert.deepEqual(aggregation.top_prefixes, ranking);
  assert.deepEqual(aggregation.change_types, types);
  assert.equal(aggregation.affected_peers, peers.size);
  assert.equal(aggregation.change_notices, String(changes.length));
  assert.equal(aggregation.top_prefixes[0].changed_events, 3);
  assert.equal(aggregation.top_prefixes[0].affected_peers, 2);
  assert.equal(JSON.parse(run('aggregate', data, ['--top', '1'])).aggregation.top_prefixes.length, 1);
  const windowed = JSON.parse(run('aggregate', data, ['--from', '105', '--to', '106'])).aggregation;
  assert.equal(windowed.top_prefixes[0].changed_events, 1);
  assert.equal(windowed.affected_peers, 1);
});

test('聚合空流与相同次数的前缀采用明确排序', () => {
  assert.equal(JSON.parse(run('aggregate', Buffer.alloc(0))).aggregation.changed_prefixes, 0);
  const data = cat(...[2, 1].flatMap(octet => [1, 2].map((origin, i) =>
    bgpUpdate(Buffer.from([24, 203, 0, octet]), undefined, attributes([64512, origin]), 100 + octet * 10 + i))));
  const result = JSON.parse(run('aggregate', data)).aggregation;
  assert.deepEqual(result.top_prefixes.map(r => r.prefix), ['203.0.1.0/24', '203.0.2.0/24']);
});
