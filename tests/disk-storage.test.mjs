import test from 'node:test';
import assert from 'node:assert/strict';
import {encodePacket,packets,stateAccumulator} from '../cli/disk-storage.mjs';
import {mrt} from '../scripts/fixtures.mjs';

test('磁盘包任意碎片化保留 Int64 来源和事件索引，损坏及截断明确失败',async()=>{
  const source={fileIndex:65535,record:9223372036854775807n,offset:12345678901234n,indices:[0,2,9],data:mrt(99,0,Buffer.from([1,2,3]),100)};
  const encoded=encodePacket(source);async function* bytes(buffer){for(const byte of buffer)yield Buffer.from([byte]);}
  assert.deepEqual(await Array.fromAsync(packets(bytes(encoded))),[source]);
  await assert.rejects(async()=>Array.fromAsync(packets(bytes(encoded.subarray(0,encoded.length-1)))),/截断/);
  const corrupt=Buffer.from(encoded);corrupt.writeUInt32BE(0xffffffff,22);await assert.rejects(async()=>Array.fromAsync(packets(bytes(corrupt))),/索引/);
  assert.throws(()=>encodePacket({...source,indices:[0,0]}),/来源/);assert.throws(()=>encodePacket({...source,offset:-1n}),/来源/);
});

test('最终状态指纹可按分区组合并与逐条处理相同',()=>{
  const rows=[{prefix:'a',value:1},{value:2,prefix:'b'},{prefix:'c',value:3}];
  const whole=stateAccumulator(),left=stateAccumulator(),right=stateAccumulator(),merged=stateAccumulator();
  rows.forEach(row=>whole.add(row));left.add(rows[0]);rows.slice(1).forEach(row=>right.add(row));merged.merge(right.result());merged.merge(left.result());
  assert.deepEqual(merged.result(),whole.result());
});
