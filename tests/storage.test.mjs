import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import {demo, bgpUpdate, attributes, cat} from '../scripts/fixtures.mjs';

const configure = metrics_changes => assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({mode:'changes',format:'json',
  from_time:0,to_time:4294967295,window_seconds:60,threshold:3,capacity:1000,metrics_changes}))),{});

test('基准变化队列与正式序列化完全一致，每条记录取出后为空', () => {
  const data=demo(), frames=[];
  for(let position=0;position<data.length;){const end=position+12+data.readUInt32BE(position+8);frames.push(data.subarray(position,end));position=end;}
  configure(false);
  const expected=frames.flatMap(frame=>JSON.parse(bridge.consume(frame)).lines.map(JSON.parse));
  const summary=JSON.parse(bridge.finish());
  configure(true);
  const actual=[];
  for(const frame of frames){
    const result=JSON.parse(bridge.consume_metrics(frame));
    assert.equal(result.error,undefined);
    actual.push(...JSON.parse(bridge.drain_changes()));
    assert.deepEqual(JSON.parse(bridge.drain_changes()),[]);
  }
  assert.deepEqual(actual,expected);
  assert.deepEqual(JSON.parse(bridge.finish()),summary);
  const storage=JSON.parse(bridge.storage_stats());
  assert.equal(storage.route_keys,summary.tracked_routes);
  assert.equal(storage.attribute_references,summary.tracked_routes);
  assert.ok(storage.unique_attribute_sets<=storage.route_keys);
});

test('大结果按有界块导出全部状态，顺序不影响完整性，导出期间拒绝写入',()=>{
  assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({mode:'stats',format:'json',from_time:0,
    to_time:4294967295,window_seconds:60,threshold:3,capacity:10000}))),{});
  const nlri=cat(...Array.from({length:5000},(_,i)=>Buffer.from([32,10,0,i>>>8,i&255])));
  const frame=bgpUpdate(nlri,undefined,attributes([64512,1]),100);
  assert.equal(JSON.parse(bridge.consume_at(frame,'many.mrt',1n,0n)).error,undefined);
  assert.deepEqual(JSON.parse(bridge.state_export_begin()),{});
  assert.match(JSON.parse(bridge.consume(frame)).error,/导出过程中/);
  assert.match(JSON.parse(bridge.state_export_chunk(0)).error,/分块/);
  const seen=new Set();
  for(;;){
    const chunk=JSON.parse(bridge.state_export_chunk(128));
    assert.ok(chunk.length<=128);
    if(!chunk.length)break;
    for(const event of chunk){
      assert.equal(event.action,'active');assert.equal(event.source.file,'many.mrt');
      assert.equal(event.prefix,`10.0.${event.source.event_index>>>8}.${event.source.event_index&255}/32`);
      seen.add(event.source.event_index);
    }
  }
  assert.equal(seen.size,5000);
  assert.match(JSON.parse(bridge.state_export_chunk(128)).error,/先开始/);
  assert.equal(JSON.parse(bridge.finish()).announcements,'5000');
});
