import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import { cat, u16, u32, mrt, attr, attributes, bgpUpdate } from '../scripts/fixtures.mjs';

export function addpathUpdate({ afi = 1, width = 4, outbound = false, id = 0, withdraw = false, time = 100, origin = 64513 } = {}) {
  const prefix = afi === 1 ? Buffer.from([24, 203, 0, 113]) : Buffer.from('2020010db8', 'hex');
  const nlri = cat(u32(id), prefix);
  const path = attr(2, cat(Buffer.from([2, 2]), width === 4 ? u32(64512) : u16(64512), width === 4 ? u32(origin) : u16(origin)));
  let attrs = withdraw ? Buffer.alloc(0) : cat(attr(1, Buffer.from([0])), path);
  let announced = Buffer.alloc(0), withdrawn = Buffer.alloc(0);
  if (afi === 1) {
    if (withdraw) withdrawn = nlri;
    else {announced = nlri; attrs = cat(attrs, attr(3, Buffer.from([192, 0, 2, 1])));}
  }
  else {
    const body = withdraw ? cat(u16(2), Buffer.from([1]), nlri) : cat(u16(2), Buffer.from([1, 16]), Buffer.from('20010db8000000000000000000000001', 'hex'), Buffer.from([0]), nlri);
    attrs = cat(attrs, attr(withdraw ? 15 : 14, body, 128));
  }
  const body = cat(u16(withdrawn.length), withdrawn, u16(attrs.length), attrs, announced);
  const message = cat(Buffer.alloc(16, 255), u16(19 + body.length), Buffer.from([2]), body);
  const transport = cat(width === 4 ? u32(64512) : u16(64512), width === 4 ? u32(64514) : u16(64514), u16(0), u16(1), Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]));
  return mrt(16, width === 4 ? outbound ? 11 : 9 : outbound ? 10 : 8, cat(transport, message), time);
}

export function addpathRib(afi = 1, peerWidth = 4) {
  const peer = mrt(13, 1, cat(u32(0), u16(0), u16(1), Buffer.from([peerWidth === 4 ? 2 : 0]), u32(0xc0000201), Buffer.from([192, 0, 2, 1]), peerWidth === 4 ? u32(64512) : u16(64512)), 100);
  const prefix = afi === 1 ? Buffer.from([24, 203, 0, 113]) : Buffer.from('2020010db8', 'hex');
  const attrs = attributes([64512, 65536]);
  const entries = [0, 4294967295].map(id => cat(u16(0), u32(99), u32(id), u16(attrs.length), attrs));
  return [peer, mrt(13, afi === 1 ? 8 : 10, cat(u32(0), prefix, u16(2), ...entries), 100)];
}
function configure(mode, extra = {}) {
  const result = JSON.parse(bridge.configure(JSON.stringify({ mode, format: 'json', from_time: 0, to_time: 4294967295, window_seconds: 60, threshold: 10, capacity: 100, ...extra })));
  assert.deepEqual(result, {});
}
for (const afi of [1, 2]) for (const width of [2, 4]) for (const outbound of [false, true]) {
  test(`ADD-PATH 扩展时间戳 afi=${afi} ASN=${width} LOCAL=${outbound}`, () => {
    configure('parse');
    const raw = addpathUpdate({afi, width, outbound, id: 4294967295, time: 100});
    const extended = mrt(17, raw.readUInt16BE(6), cat(u32(999999), raw.subarray(12)), 100);
    const result = JSON.parse(bridge.consume(extended));
    assert.equal(result.error, undefined);
    const event = JSON.parse(result.lines[0]);
    assert.equal(event.path_id, 4294967295);
    assert.equal(event.microseconds, 999999);
    assert.equal(event.outbound, outbound);
    assert.equal(event.prefix, afi === 1 ? '203.0.113.0/24' : '2001:db8::/32');
  });
}
for (const afi of [1, 2]) for (const width of [2, 4]) for (const outbound of [false, true]) {
  test(`ADD-PATH UPDATE afi=${afi} ASN=${width} LOCAL=${outbound}`, () => {
    configure('stats');
    for (const data of [addpathUpdate({ afi, width, outbound, id: 0 }), addpathUpdate({ afi, width, outbound, id: 7, time: 101 }), addpathUpdate({ afi, width, outbound, id: 0, time: 102, withdraw: true })]) {
      assert.equal(JSON.parse(bridge.consume(data)).error, undefined);
    }
    const summary = JSON.parse(bridge.finish()), state = JSON.parse(bridge.state());
    assert.equal(summary.active_routes, 1);
    assert.equal(summary.tracked_routes, 2);
    assert.deepEqual(state.map(e => [e.path_id, e.action]), [[0, 'withdrawn'], [7, 'active']]);
    assert.ok(state.every(e => e.outbound === outbound));
    configure('parse', { path_id: 7 });
    assert.equal(JSON.parse(bridge.consume(addpathUpdate({ afi, width, outbound, id: 0 }))).lines.length, 0);
    const event = JSON.parse(JSON.parse(bridge.consume(addpathUpdate({ afi, width, outbound, id: 7 }))).lines[0]);
    assert.equal(event.path_id, 7);
    assert.equal(event.prefix, afi === 1 ? '203.0.113.0/24' : '2001:db8::/32');
  });
}
for (const afi of [1, 2]) for (const width of [2, 4]) {
  test(`ADD-PATH RIB afi=${afi} peer ASN=${width}`, () => {
    configure('parse');
    const [peer, rib] = addpathRib(afi, width);
    bridge.consume(peer);
    const events = JSON.parse(bridge.consume(rib)).lines.map(JSON.parse);
    assert.deepEqual(events.map(e => e.path_id), [0, 4294967295]);
    assert.equal(events[1].attributes.path[0].asns[1], 65536);
    const cli = spawnSync(process.execPath, ['cli/mrtkit.mjs', 'parse', '--path-id', '0', '--format', 'csv', '-'], { input: cat(peer, rib), encoding: 'utf8', windowsHide: true });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trim().split('\n').length, 2);
    const csv = cli.stdout.trim().split('\n');
    assert.equal(csv[1].split(',')[csv[0].split(',').indexOf('path_id')], '0');
  });
}

test('普通路径与 ADD-PATH 标识 0 不共用状态键', () => {
  configure('stats');
  bridge.consume(addpathUpdate());
  bridge.consume(bgpUpdate(Buffer.from([24, 203, 0, 113]), undefined, attributes([64512, 2]), 101));
  assert.equal(JSON.parse(bridge.finish()).active_routes, 2);
});
