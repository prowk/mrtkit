import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ChangeEncoder,expandContext,readChanges} from '../cli/compact-changes.mjs';
import {replayManifest} from '../cli/multi.mjs';
import {validateBundle} from '../cli/validation.mjs';
import {correlateBundle} from '../cli/correlate.mjs';
import {generateReport} from '../cli/report.mjs';

const load=async path=>JSON.parse(await readFile(path,'utf8'));
const collect=async iterator=>{const rows=[];for await(const row of iterator)rows.push(row);return rows;};
const temporary=async run=>{const root=await mkdtemp(join(tmpdir(),'mrtkit-compact-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}};

test('紧凑上下文只共享同一事件，完整往返并拒绝引用篡改',async()=>{
  const common={schema_version:'2.0',source:{file:'中文/route.mrt',record:'1',offset:'0',event_index:0},before:{active:true},after:{active:false},diff:{path:true}};
  const rows=[{...common,kind:'path_change'},{...common,kind:'attribute_change'},{...common,kind:'churn',churn_count:4}, {...common,kind:'churn',churn_count:4}];
  const output=[],encoder=new ChangeEncoder(text=>output.push(JSON.parse(text)),{encoding:'event_refs_v1'});
  for(const row of rows)await encoder.push(row);
  assert.deepEqual(await encoder.close(),{encoding:'event_refs_v1',notices:4,contexts:2});
  assert.deepEqual(output.flatMap(expandContext),rows);
  await assert.rejects(encoder.push(rows[0]),/关闭/);
  for(const mutate of [row=>row.context.value.after.active=true,row=>row.notices[0].context='missing',row=>row.notices.push({...row.notices[0]}),row=>row.notices[0].source={},row=>row.encoding='unknown']){
    const copy=structuredClone(output[0]);mutate(copy);assert.throws(()=>expandContext(copy),/上下文|冲突|引用/);
  }
});

test('完整与紧凑 multi 的提醒、状态、统计、来源及下游关联报告等价',()=>temporary(async root=>{
  const original=await load(resolve('fixtures/multi/manifest.json'));
  for(const point of original.collectors)for(const file of point.files)file.path=resolve('fixtures/multi',file.path);
  for(const timeline of [false,true]){
    const outputs=[];
    for(const compact of [false,true]){
      const manifest={...original,analysis:{...original.analysis,compact_changes:compact}};
      if(!timeline)delete manifest.analysis.prefix;
      const config=join(root,`manifest-${timeline}-${compact}.json`),output=join(root,`bundle-${timeline}-${compact}`);
      await writeFile(config,JSON.stringify(manifest),'utf8');await replayManifest(config,output);
      const index=await validateBundle(join(output,'index.json'));outputs.push({output,index});
    }
    for(let i=0;i<outputs[0].index.collectors.length;i++){
      const [a,b]=outputs.map(item=>item.index.collectors[i]);
      assert.deepEqual(a.summary,b.summary);
      assert.equal(await readFile(join(outputs[0].output,a.state_file),'utf8'),await readFile(join(outputs[1].output,b.state_file),'utf8'));
      assert.deepEqual(await collect(readChanges(join(outputs[0].output,a.changes_file),a.changes_encoding)),await collect(readChanges(join(outputs[1].output,b.changes_file),b.changes_encoding)));
      assert.ok(b.change_contexts<=b.change_notices);
    }
    assert.deepEqual(await correlateBundle(join(outputs[0].output,'index.json')),await correlateBundle(join(outputs[1].output,'index.json')));
    const reports=await Promise.all(outputs.map((item,i)=>generateReport(join(item.output,'index.json'),join(root,`report-${timeline}-${i}`))));
    assert.equal(reports[0].rows,reports[1].rows);assert.equal(reports[0].change_notices,reports[1].change_notices);
    const index=outputs[1].index;index.collectors[0].change_contexts++;await writeFile(join(outputs[1].output,'index.json'),JSON.stringify(index),'utf8');
    await assert.rejects(validateBundle(join(outputs[1].output,'index.json')),/上下文计数/);
  }
}));

test('changes --compact 可还原完整模式，其他模式及重复参数明确失败',()=>temporary(async root=>{
  const run=args=>spawnSync(process.execPath,['cli/mrtkit.mjs',...args],{encoding:'utf8',windowsHide:true});
  const args=['changes','--threshold','3','fixtures/demo.mrt'];
  const full=run(args),compact=run([...args,'--compact']);assert.equal(full.status,0,full.stderr);assert.equal(compact.status,0,compact.stderr);
  assert.deepEqual(compact.stdout.trim().split('\n').filter(Boolean).flatMap(line=>expandContext(JSON.parse(line))),full.stdout.trim().split('\n').filter(Boolean).map(JSON.parse));
  assert.equal(full.stderr,compact.stderr);
  for(const args of [['stats','--compact','fixtures/demo.mrt'],['changes','--compact','--compact','fixtures/demo.mrt']])assert.notEqual(run(args).status,0);
}));
