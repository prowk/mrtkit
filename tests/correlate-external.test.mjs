import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {replayManifest} from '../cli/multi.mjs';
import {correlateBundle} from '../cli/correlate.mjs';
import {correlateExternal,reconstructCorrelation} from '../cli/correlate-external.mjs';
import {correlateObservations} from '../cli/correlate.mjs';
import {makeChange,attributes} from './helpers/changes.mjs';

test('外部关联分离摘要和明细，重建与内存实现完全一致，资源失败及取消可清理',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrtkit-external-correlation-'));
  try{
    const input=join(root,'input');await replayManifest(resolve('fixtures/multi/manifest.json'),input);const path=join(input,'index.json');
    const expected=await correlateBundle(path,{windowSeconds:10}),output=join(root,'external');
    const result=await correlateExternal(path,output,{windowSeconds:10,memoryBytes:65536,diskBytes:10000000});
    assert.equal(result.status,'complete');assert.deepEqual(await reconstructCorrelation(result.index),JSON.parse(JSON.stringify(expected)));
    const index=JSON.parse(await readFile(result.index,'utf8'));
    assert.equal(index.unique_observations,expected.unique_observations);assert.ok(index.groups_sha256);assert.ok(index.observations_sha256);
    assert.deepEqual((await readdir(output)).sort(),['groups.jsonl','index.json','observations.jsonl']);
    assert.ok(index.resources.peak_new_disk_bytes<=10000000);
    await assert.rejects(reconstructCorrelation(result.index,{capacity:1}),/容量/);
    const full=join(root,'budget');await assert.rejects(correlateExternal(path,full,{memoryBytes:65536,diskBytes:1}),/磁盘预算/);
    assert.equal(JSON.parse(await readFile(join(full,'index.json'),'utf8')).status,'partial');assert.deepEqual(await readdir(full),['index.json']);
    const controller=new AbortController(),cancelled=join(root,'cancelled');
    await assert.rejects(correlateExternal(path,cancelled,{signal:controller.signal,onProgress:()=>controller.abort()}),/abort/i);
    assert.equal(JSON.parse(await readFile(join(cancelled,'index.json'),'utf8')).status,'partial');assert.deepEqual(await readdir(cancelled),['index.json']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('多轮落盘的混合语义、微秒、重复和质量标记与内存实现一致',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrtkit-correlation-mixed-'));
  try{
    const input=join(root,'input');await mkdir(input);const points=['a','b','c'].map((collector,i)=>({collector,view:'v',status:i===2?'partial':'complete',baseline_status:i===1?'updates_only':'explicit_rib',continuous:i===0,gaps:i===1?[{from:107,to:109}]:[]}));
    const items=[];
    for(let i=0;i<2100;i++){
      const point=points[i%2],time=100+i%25,microseconds=(i*173)%1000000;
      const event=makeChange(point.collector,time,String(i+1),{microseconds,prefix:`203.0.${i%3}.0/24`,peer_asn:64512+i%17,peer_ip:'2001:db8::'+(1+i%97).toString(16),
        after:{timestamp:time,microseconds,active:true,attributes:attributes([2+i%3])},...(i%5===0?{path_id:0}:{})});
      items.push([event,point]);if(i%200===0)items.push([structuredClone(event),point]);
    }
    for(const point of points){const rows=items.filter(([,p])=>p===point).map(([event])=>event);point.change_notices=rows.length;point.changes_file=point.collector+'.jsonl';await writeFile(join(input,point.changes_file),rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':''),'utf8');}
    const index={schema_version:'2.0',type:'collector_replay_bundle',status:'partial',window:{from:100,to:124},collectors:points};await writeFile(join(input,'index.json'),JSON.stringify(index),'utf8');
    const expected=JSON.parse(JSON.stringify(correlateObservations(items,points,{windowSeconds:10,window:index.window,inputStatus:'partial'})));
    const result=await correlateExternal(join(input,'index.json'),join(root,'result'),{windowSeconds:10,memoryBytes:65536,diskBytes:30000000});
    assert.deepEqual(await reconstructCorrelation(result.index),expected);assert.ok(expected.duplicates>0);assert.ok(expected.groups.length>5);
    const conflict=structuredClone(items[0][0]);conflict.peer_asn++;
    await writeFile(join(input,'a.jsonl'),(await readFile(join(input,'a.jsonl'),'utf8'))+JSON.stringify(conflict)+'\n','utf8');index.collectors[0].change_notices++;await writeFile(join(input,'index.json'),JSON.stringify(index),'utf8');
    await assert.rejects(correlateExternal(join(input,'index.json'),join(root,'conflict'),{memoryBytes:65536,diskBytes:30000000}),/冲突/);
    assert.ok(!(await readdir(join(root,'conflict'))).some(name=>name.startsWith('.work-')));
  }finally{await rm(root,{recursive:true,force:true});}
});
