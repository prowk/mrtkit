import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {replayManifest} from '../cli/multi.mjs';
import {replayDisk} from '../cli/disk-replay.mjs';
import {canonical} from '../cli/disk-storage.mjs';
import {jsonLines} from '../cli/bundle.mjs';
import {mrt,cat,u16,u32,attributes,bgpUpdate,attr} from '../scripts/fixtures.mjs';
import {ReferenceModel} from './reference_model.mjs';
import {encodeModelEvent,modelSequence} from './helpers/model-fixtures.mjs';

const normalize=rows=>rows.map(row=>JSON.stringify(canonical(row))).sort();
async function compare(root,manifest){
  const input=join(root,'manifest.json');await writeFile(input,JSON.stringify(manifest),'utf8');
  const reference=join(root,'memory'),disk=join(root,'disk');await replayManifest(input,reference);await replayDisk(input,disk,{keepPartitions:true,memoryBytes:65536});
  const a=JSON.parse(await readFile(join(reference,'index.json'),'utf8')).collectors[0],b=JSON.parse(await readFile(join(disk,'index.json'),'utf8')).collectors[0];
  assert.deepEqual(a.summary,b.summary);assert.equal(a.change_notices,b.change_notices);
  assert.deepEqual(await Array.fromAsync(jsonLines(join(disk,b.changes_file))),await Array.fromAsync(jsonLines(join(reference,a.changes_file))));
  assert.deepEqual(normalize(await Array.fromAsync(jsonLines(join(disk,b.state_file)))),normalize(await Array.fromAsync(jsonLines(join(reference,a.state_file)))));
  assert.ok(b.storage.resources.peak_rss_upper_bound_bytes<=2147483648);assert.ok(b.storage.resources.peak_new_disk_bytes<=128849018880);
  assert.ok((await readdir(disk)).includes('partitions'));assert.ok(!(await readdir(disk)).some(name=>name.startsWith('.work-')));return {input,a,b,disk};
}

test('完整磁盘回放与内存参考的状态、变化顺序、统计和来源一致',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrtkit-disk-demo-'));
  try{
    const fixture=JSON.parse(await readFile('fixtures/multi/manifest.json','utf8'));delete fixture.analysis.prefix;fixture.collectors=fixture.collectors.slice(0,1);
    for(const file of fixture.collectors[0].files)file.path=resolve('fixtures/multi',file.path);
    const result=await compare(root,fixture);assert.equal(result.b.storage.original_records,result.b.files.reduce((sum,file)=>sum+file.records,0));
    assert.equal(result.b.storage.capacity_proof,'route_event_upper_bound');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('完整磁盘状态和变化与独立 1200 事件内存模型一致，覆盖显式基线和缺基线',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrtkit-disk-model-'));
  try{
    const sequence=modelSequence();await writeFile(join(root,'updates.mrt'),cat(...sequence.map(encodeModelEvent)));
    const attrs=cat(attributes([64512,1]),attr(8,u32(1),192));
    const peers=mrt(13,1,cat(u32(0),u16(0),u16(1),Buffer.from([2]),u32(0),Buffer.from([192,0,2,1]),u32(64512)),100);
    const rib=mrt(13,8,cat(u32(0),Buffer.from([24,203,0,113]),u16(1),u16(0),u32(99),u32(0),u16(attrs.length),attrs),100);await writeFile(join(root,'initial.mrt'),cat(peers,rib));
    for(const seeded of [false,true]){
      const model=new ReferenceModel({lower:500,upper:900});if(seeded)model.seed(0,[64512,1],[1,1]);sequence.forEach((event,i)=>model.apply({...event,ordinal:i+1}));
      const manifest={schema_version:'1.0',window:{from:100,to:100},analysis:{from_micros:500,to_micros:900,threshold:3,capacity:100},collectors:[{collector:'model',view:'v',files:[...(seeded?[{path:join(root,'initial.mrt'),kind:'rib',from:100,to:100}]:[]),{path:join(root,'updates.mrt'),kind:'update',from:100,to:100}]}]};
      const input=join(root,'model-'+seeded+'.json'),output=join(root,'output-'+seeded);await writeFile(input,JSON.stringify(manifest),'utf8');await replayDisk(input,output,{memoryBytes:65536});
      const point=JSON.parse(await readFile(join(output,'index.json'),'utf8')).collectors[0];
      const actual=(await Array.fromAsync(jsonLines(join(output,point.state_file)))).map(event=>({id:event.path_id,active:event.action==='active',path:event.attributes.path.flatMap(segment=>segment.asns),time:event.microseconds??0,attributes:event.attributes.next_hop?[Number(event.attributes.next_hop.split('.').at(-1)),event.attributes.communities[0]]:[]})).sort((a,b)=>a.id-b.id);
      assert.deepEqual(actual,model.state());
      const changes=(await Array.fromAsync(jsonLines(join(output,point.changes_file)))).map(change=>({kind:change.kind,id:change.path_id,ordinal:Number(change.source.record)}));assert.deepEqual(changes,model.changes);
      for(const [key,expected]of Object.entries(model.counts))assert.equal(Number(point.summary[key]),expected,key);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('跨 peer、双向重置、预热和乱序等价，全局容量不能按分区偷渡',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrtkit-disk-peers-'));
  try{
    const prefix=Buffer.from([24,203,0,113]),attrs=attributes([64512,1]);
    const peers=mrt(13,1,cat(u32(0),u16(0),u16(2),...[[1,64512],[3,64512]].map(([address,asn])=>cat(Buffer.from([2]),u32(address),Buffer.from([192,0,2,address]),u32(asn)))),100);
    const rib=mrt(13,2,cat(u32(0),prefix,u16(2),...Array.from({length:2},(_,i)=>cat(u16(i),u32(99),u16(attrs.length),attrs))),100);
    const update=(peer,time,path,outbound=false)=>{const bytes=bgpUpdate(prefix,undefined,attributes(path),time);bytes[27]=peer;if(outbound)bytes.writeUInt16BE(7,6);return bytes;};
    const reset=mrt(16,5,cat(u32(64512),u32(64513),u16(0),u16(1),Buffer.from([192,0,2,1,192,0,2,2]),u16(6),u16(1)),103);
    await writeFile(join(root,'initial.mrt'),cat(peers,rib));await writeFile(join(root,'updates.mrt'),cat(update(1,101,[64512,2]),update(1,102,[64512,3],true),reset,update(1,102,[64512,999]),update(3,104,[64512,4]),update(1,105,[64512,5])));
    const manifest={schema_version:'1.0',window:{from:102,to:105},analysis:{threshold:3,capacity:100},collectors:[{collector:'real-layout-test',view:'v',files:[{path:join(root,'initial.mrt'),kind:'rib',from:100,to:100},{path:join(root,'updates.mrt'),kind:'update',from:101,to:105}]}]};
    const result=await compare(root,manifest);assert.equal(result.b.summary.out_of_order,'1');assert.equal(result.b.summary.session_resets,'1');assert.equal(result.b.summary.warmup_records,'1');assert.equal(result.b.summary.tracked_routes,2);
    manifest.analysis.capacity=2;await writeFile(result.input,JSON.stringify(manifest),'utf8');
    const bad=join(root,'capacity');await assert.rejects(replayDisk(result.input,bad,{memoryBytes:65536}),/容量/);const index=JSON.parse(await readFile(join(bad,'index.json'),'utf8'));assert.equal(index.status,'partial');assert.ok(!(await readdir(bad)).some(name=>name.startsWith('.work-')));
    const controller=new AbortController(),cancelled=join(root,'cancelled');await assert.rejects(replayDisk(result.input,cancelled,{signal:controller.signal,onProgress:()=>controller.abort()}),/abort/i);assert.ok(!(await readdir(cancelled)).some(name=>name.startsWith('.work-')));
  }finally{await rm(root,{recursive:true,force:true});}
});
