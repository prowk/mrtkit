import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import {demo} from '../scripts/fixtures.mjs';

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
