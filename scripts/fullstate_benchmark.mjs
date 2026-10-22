import {spawn, spawnSync} from 'node:child_process';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const option = (name, fallback) => {const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const directory = resolve(option('--archives','.validation/archives'));
const bridge = resolve(option('--bridge','_build/js/release/build/bridge/bridge.js'));
const reportPath = resolve(option('--report','.validation/fullstate/report.json'));
const repeats = Number(option('--repeats','3'));
const budgetMiB = Number(option('--rss-mib','1536'));
const capacity = Number(option('--capacity','12000000'));
const updatesOnly = args.includes('--updates-only');
const traceSource = updatesOnly || args.includes('--trace-source');
if (![repeats,budgetMiB,capacity].every(Number.isSafeInteger)||repeats<1||repeats>10||budgetMiB<128||capacity<1) throw new Error('非法基准参数');
const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
const inputs=manifest.filter(item=>item.collector==='ris-rrc23');
for(const item of inputs){const hash=createHash('sha256');for await(const chunk of createReadStream(resolve(directory,item.file)))hash.update(chunk);if(hash.digest('hex')!==item.sha256)throw new Error('输入哈希错误');}
const version=name=>spawnSync(name,['--version'],{encoding:'utf8',windowsHide:true}).stdout.trim();
const report={method:updatesOnly?'Unfiltered 12 complete UPDATE archives; no initial RIB; buffered JSONL output and chunked final-state export.':'Unfiltered complete RIB plus 12 consecutive UPDATE archives; fresh serial processes; explicit resource budget; no successful full-state claim on incomplete run.',
  environment:{date:new Date().toISOString(),platform:os.platform(),release:os.release(),cpu:os.cpus()[0].model,
    total_memory_bytes:os.totalmem(),free_memory_bytes:os.freemem(),node:process.version,moon:version('moon'),python:version('python')},
  source_revision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).stdout.trim(),
  bridge_source_revision:option('--bridge-revision',null),bridge_sha256:createHash('sha256').update(await readFile(bridge)).digest('hex'),bridge,inputs:updatesOnly?inputs.filter(i=>i.kind==='update'):inputs,repeats,
  configuration:{prefix_filter:null,peer_filter:null,source_positions:traceSource,capacity,rss_budget_bytes:budgetMiB*1048576,
    from:1735689600,to:1735693199},runs:[]};
await mkdir(resolve(reportPath,'..'),{recursive:true});
for(let iteration=1;iteration<=repeats;iteration++){
  const config={...report.configuration,bridge,rib:updatesOnly?null:resolve(directory,inputs.find(i=>i.kind==='rib').file),
    emit:traceSource,save_state:true,
    updates:inputs.filter(i=>i.kind==='update').sort((a,b)=>a.file.localeCompare(b.file)).map(i=>resolve(directory,i.file)),
    output:resolve(reportPath,'..',`output-${iteration}.jsonl`)};
  const configPath=resolve(reportPath,'..',`config-${iteration}.json`);
  await writeFile(configPath,JSON.stringify(config),'utf8');
  const argv=[`--max-old-space-size=${Math.max(256,budgetMiB+512)}`,'scripts/fullstate_worker.mjs',configPath];
  const child=spawn(process.execPath,argv,{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='',pending='';const checkpoints=[];child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1048576)child.kill();});
  child.stderr.on('data',part=>{stderr=(stderr+part).slice(-65536);pending+=part;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){try{checkpoints.push(JSON.parse(line));}catch{}}process.stderr.write(part);});
  const exit=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});
  let result;try{result=JSON.parse(stdout);}catch{result={complete:false,failure:{kind:'process_failure',message:stderr.slice(-8192)}};}
  report.runs.push({iteration,command:[process.execPath,...argv],exit_code:exit,checkpoints,...result});
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n','utf8');
  process.stdout.write(JSON.stringify({iteration,exit_code:exit,complete:result.complete,records:result.records,
    cached_routes:result.cached_routes,peak_rss_bytes:result.peak_rss_bytes,failure:result.failure})+'\n');
}
