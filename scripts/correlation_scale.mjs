import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {jsonlWriter} from '../cli/external-sort.mjs';
import {correlateExternal} from '../cli/correlate-external.mjs';
import {jsonLines} from '../cli/bundle.mjs';
import {makeChange} from '../tests/helpers/changes.mjs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const args=process.argv.slice(2),at=args.indexOf('--output');
if(at<0||args.length!==2)throw new Error('用法: node scripts/correlation_scale.mjs --output 新目录');
const source_revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).stdout.trim(),source_sha256={};
for(const file of ['scripts/correlation_scale.mjs','cli/correlate.mjs','cli/correlate-external.mjs','cli/external-sort.mjs','cli/validation.mjs','_build/js/release/build/bridge/bridge.js'])source_sha256[file]=createHash('sha256').update(await readFile(file)).digest('hex');
const directory=resolve(args[at+1]),count=1000100;await mkdir(directory,{recursive:false});
const input=join(directory,'input');await mkdir(input);
const writer=await jsonlWriter(join(input,'changes.jsonl')),base=makeChange('synthetic-scale',100);
try{for(let i=1;i<=count;i++)await writer.write({...base,source:{...base.source,file:'generated-notices',record:String(i),offset:String((i-1)*128)}});}finally{await writer.close();}
const generated=await writer.close();
const bundle={schema_version:'2.0',type:'collector_replay_bundle',status:'complete',window:{from:100,to:110},collectors:[
  {collector:'synthetic-scale',view:'v',status:'complete',baseline_status:'updates_only',continuous:false,gaps:[],change_notices:count,changes_file:'changes.jsonl',changes_sha256:generated.sha256}]};
const index=join(input,'index.json');await writeFile(index,JSON.stringify(bundle,null,2)+'\n','utf8');
const controller=new AbortController(),rssBudget=536870912,diskBudget=8589934592;
const timeout=setTimeout(()=>controller.abort(new Error('关联负载超过预定 20 分钟预算')),1200000);
const sampler=setInterval(()=>{if(process.memoryUsage().rss>rssBudget)controller.abort(new Error('关联负载超过预定 512 MiB RSS 预算'));},250);
let last=0;
try{
  const result=await correlateExternal(index,join(directory,'result'),{memoryBytes:67108864,diskBytes:diskBudget,signal:controller.signal,
    onProgress:({observations})=>{if(observations-last>=100000){last=observations;console.log(JSON.stringify({phase:'validated',observations}));}}});
  const receipt=JSON.parse(await readFile(result.index,'utf8'));
  assert.equal(receipt.groups,1);assert.equal(receipt.unique_observations,count);assert.equal(receipt.duplicates,0);
  assert.ok(receipt.resources.peak_rss_bytes<=rssBudget);assert.ok(receipt.resources.peak_new_disk_bytes<=diskBudget);
  const groups=await Array.fromAsync(jsonLines(join(directory,'result/groups.jsonl')));
  assert.equal(groups[0].observation_count,count);assert.equal(groups[0].affected_peers,1);
  let rows=0;for await(const row of jsonLines(join(directory,'result/observations.jsonl'))){assert.equal(row.group_id,groups[0].id);rows++;}assert.equal(rows,count);
  assert.ok(process.resourceUsage().maxRSS*1024<=rssBudget);
  const evidence={schema_version:'2.0',synthetic:true,description:'One million and one hundred valid semantic notices; not network archive observations.',source_revision,source_sha256,
    environment:{node:process.version,cpu:os.cpus()[0].model.trim(),total_memory_bytes:os.totalmem(),platform:os.platform()},
    target:{observations:count,rss_budget_bytes:rssBudget,disk_budget_bytes:diskBudget,sort_payload_budget_bytes:67108864,seconds:1200},
    input:{bytes:generated.bytes,sha256:generated.sha256},matched:true,groups:receipt.groups,observations:rows,
    groups_sha256:receipt.groups_sha256,observations_sha256:receipt.observations_sha256,resources:receipt.resources,verification_peak_rss_bytes:process.resourceUsage().maxRSS*1024};
  await writeFile(join(directory,'verification.json'),JSON.stringify(evidence,null,2)+'\n','utf8');console.log(JSON.stringify(evidence));
}finally{clearTimeout(timeout);clearInterval(sampler);}
