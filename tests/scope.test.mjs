import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import {bgpUpdate, attributes, mrt, cat, u16, u32} from '../scripts/fixtures.mjs';

const configure=(mode,extra={})=>assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({mode,format:'json',from_time:0,
  to_time:4294967295,window_seconds:60,threshold:3,capacity:100,collector:'ris-test',view:'v4',...extra}))),{});
test('桥接将采集器和视图附加到路由、会话诊断与变化前后来源',()=>{
  configure('changes');
  const prefix=Buffer.from([24,203,0,113]);
  const first=bgpUpdate(prefix,undefined,attributes([64512,1]),100);
  const second=bgpUpdate(prefix,undefined,attributes([64512,2]),101);
  bridge.consume_at(first,'same.mrt',1n,0n);
  const changes=JSON.parse(bridge.consume_at(second,'same.mrt',2n,BigInt(first.length))).lines.map(JSON.parse);
  for(const change of changes)for(const source of [change.source,change.before.source,change.after.source]){
    assert.equal(source.collector,'ris-test');assert.equal(source.view,'v4');
  }
  assert.equal(JSON.parse(bridge.state())[0].source.collector,'ris-test');
  const skipped=JSON.parse(bridge.consume_at(mrt(99,0,Buffer.alloc(0),102),'unknown',1n,0n));
  assert.equal(skipped.diagnostics[0].source.view,'v4');
  const reset=mrt(16,5,cat(u32(64512),u32(64513),u16(0),u16(1),Buffer.from([192,0,2,1,192,0,2,2]),u16(6),u16(1)),103);
  bridge.consume_at(reset,'state',1n,0n);
  assert.equal(JSON.parse(bridge.finish()).active_routes,0);
  configure('parse',{collector:'a',view:''});
  assert.match(JSON.parse(bridge.consume_at(first,'file',1n,0n)).error,/身份不能为空/);
  configure('parse',{format:'csv',collector:'c, "x"',view:'v'});
  const csv=JSON.parse(bridge.consume_at(first,'file',1n,0n)).lines[0];
  assert.ok(bridge.csv_header().endsWith('source_collector,source_view'));
  assert.ok(csv.endsWith('"c, ""x""","v"'));
});
