import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {correlateObservations,correlateBundle} from '../cli/correlate.mjs';
import {replayManifest} from '../cli/multi.mjs';

const point=(collector,extra={})=>({collector,view:'v',status:'complete',baseline_status:'explicit_rib',continuous:true,gaps:[],...extra});
function change(collector,time,record='1',extra={}){
  const prefix='203.0.113.0/24',kind='path_change';
  return {schema_version:'2.0',timestamp:time,prefix,kind,peer_asn:64512,peer_ip:'192.0.2.1',outbound:false,
    correlation_key:JSON.stringify({prefix,kind,rule:{before:[1],after:[2]}}),
    source:{collector,view:'v',file:'input',record,offset:'0',event_index:0},...extra};
}

test('重复去重、乱序及同秒并列稳定，固定半开窗口不链式扩展',()=>{
  const a=point('a'),b=point('b'),c=point('c',{status:'partial',baseline_status:'missing',continuous:false,gaps:[{from:100,to:105}]});
  const items=[[change('a',100),a],[change('b',100),b],[change('a',109,'2'),a],[change('b',118,'2'),b],[change('a',100),a]];
  const report=correlateObservations(items,[a,b,c],{windowSeconds:10});
  const reordered=correlateObservations([...items].reverse(),[a,b,c],{windowSeconds:10});
  assert.deepEqual(report,reordered);assert.equal(report.duplicates,1);assert.equal(report.groups.length,2);
  const group=report.groups[0];assert.deepEqual(group.observed_collectors,['a','b']);assert.equal(group.affected_peers,2);
  assert.equal(group.first_observed_at,'100000000');assert.equal(group.last_observed_at,'109000000');
  assert.equal(group.window_end_exclusive,'110000000');assert.equal(group.observations.length,3);
  assert.ok(group.unobserved[0].quality.includes('partial_input'));assert.ok(group.unobserved[0].quality.includes('observation_gap'));
  const boundary=correlateObservations([[change('a',100),a],[change('b',110),b]],[a,b],{windowSeconds:10});
  assert.equal(boundary.groups.length,2);
  assert.equal(report.interpretation,'temporal_cooccurrence_not_propagation_delay_or_causation');
});

test('关联拒绝身份冲突、缺少核心规则、超限和同来源内容冲突',()=>{
  const a=point('a');
  assert.throws(()=>correlateObservations([[change('b',100),a]],[a]),/身份/);
  assert.throws(()=>correlateObservations([[change('a',100,'1',{correlation_key:undefined}),a]],[a]),/关联键/);
  assert.throws(()=>correlateObservations([[change('a',100),a],[change('a',101),a]],[a]),/冲突/);
  assert.throws(()=>correlateObservations([[change('a',100),a],[change('a',101,'2'),a]],[a],{capacity:1}),/容量/);
  assert.throws(()=>correlateObservations([],[a],{windowSeconds:0}),/窗口/);
});

test('真实联合命令产物可关联，语义由核心提供，篡改及越界明细路径失败',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrtkit-correlation-'));
  try{
    const directory=join(root,'bundle');await replayManifest(resolve('fixtures/multi/manifest.json'),directory);
    const report=await correlateBundle(join(directory,'index.json'),{windowSeconds:10});
    const path=report.groups.find(group=>group.kind==='path_change'&&group.cross_collector);
    assert.deepEqual(path.observed_collectors,['synthetic-a','synthetic-b']);assert.equal(path.affected_peers,2);
    const index=JSON.parse(await readFile(join(directory,'index.json'),'utf8'));
    const file=join(directory,index.collectors[0].changes_file);await writeFile(file,'{}\n','utf8');
    await assert.rejects(correlateBundle(join(directory,'index.json')),/哈希/);
    await writeFile(join(root,'outside.jsonl'),'{}\n','utf8');
    index.collectors[0].changes_file='../outside.jsonl';await writeFile(join(directory,'index.json'),JSON.stringify(index),'utf8');
    await assert.rejects(correlateBundle(join(directory,'index.json')),/越出/);
  }finally{await rm(root,{recursive:true,force:true});}
});
