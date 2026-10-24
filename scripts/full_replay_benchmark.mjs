import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';

const args=process.argv.slice(2),at=args.indexOf('--output');if(at<0||args.length!==2)throw new Error('用法: node scripts/full_replay_benchmark.mjs --output 新目录');
const directory=resolve(args[at+1]);await mkdir(directory,{recursive:false});
const target=JSON.parse(await readFile('docs/validation/state-resource-target.json','utf8')),root=resolve('.'),snapshot=join(directory,'snapshot');
await mkdir(join(snapshot,'cli'),{recursive:true});await mkdir(join(snapshot,'scripts'));await mkdir(join(snapshot,'_build/js/release/build/bridge'),{recursive:true});
const codeFiles=(await readdir('cli')).filter(file=>file.endsWith('.mjs')).map(file=>'cli/'+file);codeFiles.push('scripts/full_replay_worker.mjs','_build/js/release/build/bridge/bridge.js');
const codeSha={};let fixedBytes=1048576;
for(const file of codeFiles){const bytes=await readFile(file);codeSha[file]=createHash('sha256').update(bytes).digest('hex');fixedBytes+=bytes.length;await writeFile(join(snapshot,file),bytes);}
await writeFile(join(snapshot,'package.json'),'{"type":"module"}\n','utf8');
const manifest={schema_version:'1.0',window:target.workload.window,analysis:{capacity:target.workload.capacity,threshold:3,window_seconds:60},collectors:[{collector:target.workload.collector,view:'default',continuous:false,
  files:target.workload.sources.map(file=>({path:join(root,'.validation/archives',file.file),kind:file.kind,from:file.from_time,to:file.to_time,sha256:file.sha256,url:file.url}))}]};
const manifestPath=join(directory,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n','utf8');
const report={schema_version:'2.0',type:'complete_unfiltered_state_replay_acceptance',source_revision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).stdout.trim(),
  driver_sha256:createHash('sha256').update(await readFile('scripts/full_replay_benchmark.mjs')).digest('hex'),
  snapshot_sha256:codeSha,target_sha256:createHash('sha256').update(await readFile('docs/validation/state-resource-target.json')).digest('hex'),
  method:'Three fresh serial replay processes, each with fresh serial peer children; immutable JS and compiled core snapshot. No prefix/peer reduction. Driver RSS and earlier retained output are included in conservative global budgets.',
  rss_accounting:'max(parent lifetime peak, max serial peer jobs(parent historical peak at child exit + child lifetime peak)) + controller lifetime peak; gzip inputs do not launch an external decompressor',
  environment:{date:new Date().toISOString(),node:process.version,cpu:os.cpus()[0].model.trim(),total_memory_bytes:os.totalmem(),free_memory_bytes:os.freemem(),platform:os.platform(),release:os.release()},
  budgets:target.budgets,runs:[],complete:false};
const reportPath=join(directory,'report.json'),save=()=>writeFile(reportPath,JSON.stringify(report,null,2)+'\n','utf8');await save();let retained=0;
for(let iteration=1;iteration<=target.budgets.repeats;iteration++){
  const config={iteration,manifest:manifestPath,output:join(directory,'run-'+iteration),keep_partitions:iteration===1,
    rss_bytes:target.budgets.peak_rss_bytes-134217728,disk_bytes:target.budgets.new_temporary_and_output_disk_bytes-fixedBytes-retained,seconds:target.budgets.seconds_per_round};
  const configPath=join(directory,'config-'+iteration+'.json');await writeFile(configPath,JSON.stringify(config),'utf8');
  const child=spawn(process.execPath,['--expose-gc',join(snapshot,'scripts/full_replay_worker.mjs'),configPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1048576)child.kill();});child.stderr.on('data',part=>{stderr=(stderr+part).slice(-8192);process.stderr.write(part);});
  const exit=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});let run;try{run=JSON.parse(stdout);}catch{run={complete:false,iteration,error:'replay process failed',stderr};}
  run.exit_code=exit;run.driver_peak_rss_bytes=process.resourceUsage().maxRSS*1024;run.accepted=false;report.runs.push(run);await save();
  if(exit!==0||!run.complete)throw new Error('完整回放未完成，保留失败报告，待办不能勾选');
  try{
  const storage=run.point.storage;
  assert.equal(storage.original_records,target.workload.expected_input_records);assert.equal(storage.original_route_events,target.workload.expected_route_events);assert.equal(storage.original_state_events,target.workload.expected_state_events);
  assert.ok(run.driver_peak_rss_bytes<=134217728);assert.ok(storage.resources.peak_rss_upper_bound_bytes+run.driver_peak_rss_bytes<=target.budgets.peak_rss_bytes);
  assert.ok(storage.resources.peak_new_disk_bytes+fixedBytes+retained<=target.budgets.new_temporary_and_output_disk_bytes);assert.ok(run.elapsed_seconds<=target.budgets.seconds_per_round);
  if(iteration>1){const reference=report.runs[0].point;assert.deepEqual(run.point.summary,reference.summary);assert.equal(run.point.change_notices,reference.change_notices);assert.deepEqual(storage.state_fingerprint,reference.storage.state_fingerprint);assert.equal(storage.portable_changes_sha256,reference.storage.portable_changes_sha256);assert.deepEqual(storage.output,reference.storage.output);}
  run.global_rss_upper_bound_bytes=storage.resources.peak_rss_upper_bound_bytes+run.driver_peak_rss_bytes;run.global_new_disk_peak_bytes=storage.resources.peak_new_disk_bytes+fixedBytes+retained;retained+=run.output_directory_bytes;
  run.accepted=true;await save();console.log(JSON.stringify({iteration,complete:true,routes:run.point.summary.tracked_routes,active:run.point.summary.active_routes,seconds:run.elapsed_seconds,rss:run.global_rss_upper_bound_bytes}));
  }catch(error){run.validation_error=error.message;await save();throw error;}
}
report.complete=true;await save();console.log(JSON.stringify({complete:true,repeats:report.runs.length,report:reportPath}));
