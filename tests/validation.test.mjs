import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validateTimestamp,validateChange,validateBundle} from '../cli/validation.mjs';
import {correlateObservations,correlateBundle} from '../cli/correlate.mjs';
import {generateReport} from '../cli/report.mjs';
import {replayManifest} from '../cli/multi.mjs';
import {makeChange,attributes} from './helpers/changes.mjs';

const point={collector:'a',view:'v',status:'complete',baseline_status:'explicit_rib',continuous:true,gaps:[]};
test('同来源去重比较完整身份和规范化前后语义；输入顺序不影响冲突结论',()=>{
  const original=makeChange('a',100);
  for(const extra of [{peer_asn:64513},{peer_ip:'2001:db8::1'},{outbound:true},{path_id:0},{microseconds:1},
    {after:{...original.after,attributes:{...original.after.attributes,med:1}}}]){
    const modified={...original,...extra};
    for(const order of [[original,modified],[modified,original]])assert.throws(()=>correlateObservations(order.map(change=>[change,point]),[point]),/冲突/);
  }
  const id0={...original,path_id:0},id1={...original,path_id:1};
  assert.throws(()=>correlateObservations([[id0,point],[id1,point]],[point]),/冲突/);
  const zero={...original,microseconds:0};
  assert.equal(correlateObservations([[original,point],[zero,point]],[point]).duplicates,1);
  const same={...original,after:{...original.after,attributes:{...original.after.attributes,path:[{kind:2,asns:[2]}],communities:[]}}};
  assert.equal(correlateObservations([[original,point],[same,point]],[point]).duplicates,1);
});

test('关联键必须匹配核心规范化前后状态，旧 2.0 无键时由核心补齐',()=>{
  const event=makeChange('a',100),key=JSON.parse(event.correlation_key);
  key.rule.after=[{kind:2,asns:[999]}];
  assert.throws(()=>validateChange({...event,correlation_key:JSON.stringify(key)},point),/语义不一致/);
  assert.throws(()=>validateChange({...event,after:{...event.after,attributes:attributes([3])}},point),/语义不一致/);
  const attr=makeChange('a',100,'2',{kind:'attribute_change',before:{timestamp:99,active:true,attributes:{...attributes(),med:1}},after:{timestamp:100,active:true,attributes:{...attributes(),med:2}}});
  assert.throws(()=>validateChange({...attr,after:{...attr.after,attributes:{...attr.after.attributes,med:3}}},point),/语义不一致/);
  const legacy={...event};delete legacy.correlation_key;assert.equal(validateChange(legacy,point).correlation_key,event.correlation_key);
});

test('时间端点包含完整结束秒，微秒缺失与零合法，非法秒和微秒拒绝',()=>{
  const window={from:100,to:110};
  for(const timestamp of [100,110])for(const microseconds of [undefined,0,999999])assert.doesNotThrow(()=>validateTimestamp({timestamp,...(microseconds===undefined?{}:{microseconds})},window));
  for(const timestamp of [-1,99,111,999,4294967296,1.5])assert.throws(()=>validateTimestamp({timestamp},window));
  for(const microseconds of [-1,1000000,0.5,null,'0'])assert.throws(()=>validateTimestamp({timestamp:100,microseconds},window));
});

test('correlate 和 report 对非法结果包统一拒绝；旧 2.0 可省略可选哈希',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mrtkit-validation-'));
  try{
    const bundle=join(root,'bundle');await replayManifest(resolve('fixtures/multi/manifest.json'),bundle);
    const input=join(bundle,'index.json'),original=JSON.parse(await readFile(input,'utf8'));
    const point=original.collectors[0],changesPath=join(bundle,point.changes_file),bytes=await readFile(changesPath,'utf8');
    const originalChanges=bytes.trim().split('\n').map(JSON.parse);
    let ordinal=0;
    const rejectBoth=async(index,changes=originalChanges)=>{
      await writeFile(input,JSON.stringify(index),'utf8');await writeFile(changesPath,changes.map(value=>JSON.stringify(value)).join('\n')+'\n','utf8');
      const errors=[];
      for(const run of [()=>correlateBundle(input),()=>generateReport(input,join(root,'bad-'+ordinal++))]){
        try{await run();assert.fail('非法结果包未失败');}catch(error){assert.notEqual(error.code,'ERR_ASSERTION');errors.push(error.message);}
      }
      assert.equal(errors[0],errors[1]);return errors[0];
    };
    for(const edit of [index=>{index.schema_version='1.0';},index=>{index.window={from:100,to:110};},index=>{index.collectors[0].collector='';},index=>{index.collectors[0].change_notices++;},index=>{index.collectors[0].status='partial';},index=>{index.collectors[0].changes_file='../absent.jsonl';index.collectors[0].status='partial';index.status='partial';}]){
      const index=structuredClone(original);edit(index);await rejectBoth(index);
    }
    for(const edit of [event=>{event.timestamp=999;event.microseconds=-1;},event=>{event.microseconds=-1;},event=>{event.source.record='0';},event=>{event.peer_ip='invalid';},event=>{event.kind='fabricated';},event=>{event.correlation_key='{}';}]){
      const index=structuredClone(original);delete index.collectors[0].changes_sha256;
      const events=structuredClone(originalChanges);edit(events[0]);await rejectBoth(index,events);
    }
    const missing=structuredClone(original);missing.collectors[0].changes_file='missing.jsonl';assert.match(await rejectBoth(missing),/ENOENT/);
    await writeFile(changesPath,bytes,'utf8');await writeFile(input,JSON.stringify(original),'utf8');
    const old=structuredClone(original);for(const point of old.collectors)for(const key of ['changes_sha256','timeline_sha256','state_sha256'])delete point[key];
    await writeFile(input,JSON.stringify(old),'utf8');assert.equal((await correlateBundle(input)).type,'cross_collector_correlation');assert.equal((await generateReport(input,join(root,'old'))).status,'complete');
    const partial={...old,status:'partial',collectors:old.collectors.map(point=>({...point,status:'partial',changes_file:'missing.jsonl',timeline_file:undefined,state_file:undefined}))};
    await writeFile(input,JSON.stringify(partial),'utf8');assert.equal((await correlateBundle(input)).unique_observations,0);assert.equal((await generateReport(input,join(root,'partial'))).input_status,'partial');
    const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'changes.jsonl'),bytes,'utf8');
    await symlink(outside,join(bundle,'escape'),process.platform==='win32'?'junction':'dir');
    const index=structuredClone(old);index.collectors[0].changes_file='escape/changes.jsonl';assert.match(await rejectBoth(index),/越出/);
  }finally{await rm(root,{recursive:true,force:true});}
});
