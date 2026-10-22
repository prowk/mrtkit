import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo} from '../scripts/fixtures.mjs';
import {replayManifest,readManifest} from '../cli/multi.mjs';
import {spawnSync} from 'node:child_process';

async function setup(run){const dir=await mkdtemp(join(tmpdir(),'mrtkit-multi-'));try{
  const data=demo();let p=0;for(let i=0;i<2;i++)p+=12+data.readUInt32BE(p+8);
  await writeFile(join(dir,'rib.mrt'),data.subarray(0,p));await writeFile(join(dir,'updates.mrt'),data.subarray(p));
  const files=[{path:'rib.mrt',kind:'rib',from:1700000000,to:1700000000},{path:'updates.mrt',kind:'update',from:1700000001,to:1700000006}];
  const groups=[{collector:'same|name',view:'a',files},{collector:'same|name',view:'b',files}];
  await run(dir,groups);
}finally{await rm(dir,{recursive:true,force:true});}}
const load=async path=>JSON.parse(await readFile(path,'utf8'));
const lines=async path=>(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);

test('联合回放按采集器/视图拆分后与单独运行完全一致，基线及来源保留',()=>setup(async(dir,groups)=>{
  for(const prefix of [undefined,'203.0.113.0/24']){
    const manifest={schema_version:'1.0',window:{from:1700000002,to:1700000005},analysis:{prefix,threshold:3},collectors:groups};
    const config=join(dir,'multi.json');await writeFile(config,JSON.stringify(manifest),'utf8');
    const joint=join(dir,prefix?'joint-timeline':'joint');await replayManifest(config,joint);
    const combined=await load(join(joint,'index.json'));
    assert.equal(combined.status,'complete');
    for(const [i,group] of groups.entries()){
      const config=join(dir,`single-${i}.json`);await writeFile(config,JSON.stringify({...manifest,collectors:[group]}),'utf8');
      const single=join(dir,`single-${prefix?'timeline':'changes'}-${i}`);await replayManifest(config,single);
      const own=(await load(join(single,'index.json'))).collectors[0],together=combined.collectors[i];
      assert.deepEqual(together.summary,own.summary);
      assert.equal(together.baseline_status,'explicit_rib');
      for(const field of ['state_file','changes_file']){
        const left=await lines(join(joint,together[field])),right=await lines(join(single,own[field]));
        assert.deepEqual(left,right);
        for(const event of left){assert.equal(event.source.collector,group.collector);assert.equal(event.source.view,group.view);}
      }
      if(prefix)assert.deepEqual(await load(join(joint,together.timeline_file)),await load(join(single,own.timeline_file)));
      assert.equal(together.files.length,2);assert.ok(together.files.every(file=>/^[0-9a-f]{64}$/.test(file.sha256)));
    }
  }
}));

test('身份重复、输入类型、时间范围及哈希错误明确失败，其他观测点仍独立完成',()=>setup(async(dir,groups)=>{
  const base={schema_version:'1.0',window:{from:1700000002,to:1700000005},collectors:groups};
  const config=join(dir,'bad.json');
  await writeFile(config,JSON.stringify({...base,collectors:[groups[0],groups[0]]}),'utf8');
  await assert.rejects(readManifest(config),/重复/);
  for(const file of [{...groups[0].files[0],kind:'other'},{...groups[0].files[0],from:1700000003,to:1700000000}]){
    await writeFile(config,JSON.stringify({...base,collectors:[{...groups[0],files:[file]}]}),'utf8');
    await assert.rejects(readManifest(config),/类型|倒置/);
  }
  const bad={...groups[0],files:groups[0].files.map((file,i)=>i?file:{...file,sha256:'0'.repeat(64)})};
  await writeFile(config,JSON.stringify({...base,collectors:[bad,groups[1]]}),'utf8');
  const output=join(dir,'partial');await assert.rejects(replayManifest(config,output),/部分结果/);
  const index=await load(join(output,'index.json'));
  assert.equal(index.status,'partial');assert.equal(index.collectors[0].status,'partial');assert.match(index.collectors[0].error,/SHA-256/);
  assert.equal(index.collectors[1].status,'complete');
  assert.equal(index.collectors[0].files[0].expected_sha256,'0'.repeat(64));
  const failed=spawnSync(process.execPath,['cli/mrtkit.mjs','multi','--manifest',config,'--output',join(dir,'cli-partial')],{encoding:'utf8',windowsHide:true});
  assert.equal(failed.status,1);assert.equal(failed.stdout,'');assert.match(failed.stderr,/部分结果/);
  await assert.rejects(replayManifest(config,output),/EEXIST/);
  assert.equal((await load(join(output,'index.json'))).collectors[1].status,'complete');
}));

test('声明缺档与未验证连续性进入时间线，不将基线缺失伪装为完整观测',()=>setup(async(dir,groups)=>{
  const group={...groups[0],files:[groups[0].files[1]],gaps:[{from:1700000002,to:1700000003}],continuous:false};
  const config=join(dir,'gap.json');await writeFile(config,JSON.stringify({schema_version:'1.0',window:{from:1700000001,to:1700000005},analysis:{prefix:'203.0.113.0/24'},collectors:[group]}),'utf8');
  const output=join(dir,'gap');await replayManifest(config,output);
  const index=await load(join(output,'index.json')),result=index.collectors[0];
  assert.equal(result.baseline_status,'missing');assert.equal(result.continuous,false);assert.equal(result.gaps.length,1);
  const report=await load(join(output,result.timeline_file));
  assert.equal(report.timeline.continuous_observation,false);assert.equal(report.timeline.gaps.length,1);
}));
