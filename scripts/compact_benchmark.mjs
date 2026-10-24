import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import assert from 'node:assert/strict';
import {changeFileWriter,readChanges} from '../cli/compact-changes.mjs';
import {jsonLines} from '../cli/bundle.mjs';
import {canonical} from '../cli/disk-storage.mjs';

const hashFile=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const fixed={input:resolve('.validation/fullstate/stream-after/output-1.jsonl'),bytes:4735570592,sha256:'f93aa8792be1e3573f5fd79bb248789c5f4a7794a206a95f7212ed758fd61477',notices:1141740};
if(process.argv[2]==='--worker'){
  const [encoding,output]=process.argv.slice(3),started=performance.now(),writer=await changeFileWriter(output,{encoding});
  try{for await(const row of jsonLines(fixed.input))await writer.push(row);}finally{await writer.close();}
  const encoded=await writer.close(),seconds=(performance.now()-started)/1000,verifyStarted=performance.now(),hash=createHash('sha256'),kinds={};let notices=0;
  for await(const row of readChanges(output,encoding)){notices++;kinds[row.kind]=(kinds[row.kind]??0)+1;hash.update(JSON.stringify(canonical(row))+'\n');}
  const result={encoding,...encoded,seconds,verification_seconds:(performance.now()-verifyStarted)/1000,expanded_sha256:hash.digest('hex'),kinds,peak_rss_bytes:process.resourceUsage().maxRSS*1024};
  assert.equal(notices,fixed.notices);assert.ok(result.peak_rss_bytes<=536870912);assert.ok(seconds<=1200);console.log(JSON.stringify(result));
}else{
  if(process.argv.length!==4||process.argv[2]!=='--output')throw new Error('用法: --output 新目录');
  const directory=resolve(process.argv[3]);await mkdir(directory,{recursive:false});assert.equal(await hashFile(fixed.input),fixed.sha256);
  const source_sha256={};for(const file of ['scripts/compact_benchmark.mjs','cli/compact-changes.mjs','cli/bundle.mjs','cli/disk-storage.mjs'])source_sha256[file]=await hashFile(file);
  const report={scope:'codec_only_not_mrt_decoding_or_analyzer_residency',source_revision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).stdout.trim(),source_sha256,
    input:{...fixed,input:'historical full-state UPDATE benchmark: stream-after/output-1.jsonl'},target:{repeats:3,rss_bytes:536870912,seconds_per_encode:1200},environment:{node:process.version,cpu:os.cpus()[0].model,total_memory_bytes:os.totalmem()},runs:[],complete:false};
  for(let iteration=1;iteration<=3;iteration++)for(const encoding of ['full_jsonl_v1','event_refs_v1']){
    const output=join(directory,`${encoding}-${iteration}.jsonl`),result=await new Promise((accept,reject)=>{
      const child=spawn(process.execPath,[resolve('scripts/compact_benchmark.mjs'),'--worker',encoding,output],{windowsHide:true,stdio:['ignore','pipe','inherit']});let text='';child.stdout.on('data',chunk=>text+=chunk);child.on('error',reject);child.on('exit',code=>code===0?accept(JSON.parse(text)):reject(new Error(`编码子进程退出 ${code}`)));
    });
    report.runs.push({iteration,...result});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n','utf8');console.log(JSON.stringify({iteration,encoding,bytes:result.bytes,seconds:result.seconds,rss:result.peak_rss_bytes}));
  }
  for(const run of report.runs){assert.equal(run.expanded_sha256,report.runs[0].expanded_sha256);assert.deepEqual(run.kinds,report.runs[0].kinds);}
  for(const [file,hash]of Object.entries(source_sha256))assert.equal(await hashFile(file),hash);
  report.complete=true;await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n','utf8');
}
