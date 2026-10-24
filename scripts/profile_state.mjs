import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import os from 'node:os';
import {frames,inputChunks} from '../cli/input.mjs';

const checked=text=>{const value=JSON.parse(text);if(value.error)throw new Error(value.error);return value;};
const directory=resolve('.validation/v020-profile');
if(process.argv[2]==='--worker'){
  if(!global.gc)throw new Error('剖析需要 --expose-gc');
  const scenario=process.argv[3],bridge=await import(pathToFileURL(join(directory,'bridge.mjs')));
  checked(bridge.configure(JSON.stringify({mode:'stats',format:'json',from_time:1735689600,to_time:1735693199,window_seconds:60,threshold:3,capacity:12000000})));
  const files=scenario==='rib_checkpoint'?['ris-rrc23-bview.20250101.0000.gz']:JSON.parse(await readFile('cases/rrc23-path-change/case.json','utf8')).sources.filter(row=>row.kind==='update').map(row=>row.file);
  let records=0;
  for(const file of files){bridge.reset_file();if(scenario==='rib_checkpoint')checked(bridge.begin_baseline());let ordinal=0;
    for await(const frame of frames(inputChunks(join('.validation/archives',file)))){ordinal++;checked(bridge.consume_at(frame.data,file,BigInt(ordinal),BigInt(frame.offset)));records++;if(scenario==='rib_checkpoint'&&records===25000)break;}
  }
  const analyzer=bridge.__profile().analyzer;
  const counts=(()=>{let routes=0,withdrawn=0,sources=new Set(),attributes=new Set(),keyCharacters=0;for(const entry of analyzer.routes.entries)if(entry){routes++;withdrawn+=!entry.value.active;sources.add(entry.value.event.source);attributes.add(entry.value.shared);keyCharacters+=entry.key.length;}
    return {routes,withdrawn,source_objects:sources.size,attribute_sets:attributes.size,route_key_characters:keyCharacters,peer_index_groups:analyzer.peer_routes.size};})();
  async function memory(){global.gc();await new Promise(done=>setImmediate(done));global.gc();return process.memoryUsage();}
  const baseline=await memory(),steps=[];let previous=baseline;
  async function measure(name,mutate){mutate();const after=await memory();steps.push({component:name,reclaimed_heap_bytes:previous.heapUsed-after.heapUsed,reclaimed_array_buffer_bytes:previous.arrayBuffers-after.arrayBuffers,after_heap_bytes:after.heapUsed});previous=after;}
  checked(bridge.state_export_begin());let text=bridge.state_export_chunk(128),rows=checked(text);const exportMemory=await memory();
  const exportCost={rows:rows.length,json_bytes:Buffer.byteLength(text),retained_heap_bytes:exportMemory.heapUsed-baseline.heapUsed,array_buffer_bytes:exportMemory.arrayBuffers-baseline.arrayBuffers};
  text=null;rows=null;bridge.__profile().state_export=undefined;previous=await memory();
  await measure('peer_route_index',()=>{analyzer.peer_routes=null;});
  await measure('attribute_pool_lookup_index',()=>{analyzer.attribute_pool=null;});
  await measure('source_objects_and_exclusive_positions',()=>{for(const entry of analyzer.routes.entries)if(entry?.value)entry.value.event.source=undefined;});
  await measure('withdrawn_payload_and_route_keys',()=>{for(const entry of analyzer.routes.entries)if(entry?.value&&!entry.value.active){entry.value=null;entry.key=null;}});
  await measure('active_route_keys',()=>{for(const entry of analyzer.routes.entries)if(entry)entry.key=null;});
  await measure('remaining_shared_attribute_payload',()=>{for(const entry of analyzer.routes.entries)if(entry?.value){entry.value.event.attributes=null;entry.value.shared=null;}});
  await measure('remaining_route_events_and_watermarks',()=>{for(const entry of analyzer.routes.entries)if(entry)entry.value=null;});
  await measure('route_lookup_index',()=>{analyzer.routes=null;});
  await measure('peer_watermark_indexes',()=>{analyzer.peer_latest=null;analyzer.peer_resets=null;});
  console.log(JSON.stringify({scenario,records,counts,baseline,export:exportCost,steps,peak_rss_bytes:process.resourceUsage().maxRSS*1024}));
}else{
  await mkdir(directory,{recursive:true});const source=await readFile('_build/js/release/build/bridge/bridge.js','utf8');
  const name=source.match(/(\w+) as state[, }]/)?.[1];if(!name)throw new Error('未找到固定编译器状态入口');
  const body=source.slice(source.indexOf('function '+name+'()'),source.indexOf('\n}',source.indexOf('function '+name+'()'))+2),session=body.match(/const _bind = (\w+)\.val;/)?.[1];if(!session)throw new Error('未找到固定编译器会话');
  const probe=source+'\nexport function __profile(){return '+session+'.val;}\n';await writeFile(join(directory,'bridge.mjs'),probe,'utf8');
  const report={schema_version:'2.0',type:'isolated_state_component_profile',source_revision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).stdout.trim(),
    original_bridge_sha256:createHash('sha256').update(source).digest('hex'),probe_sha256:createHash('sha256').update(probe).digest('hex'),
    environment:{date:new Date().toISOString(),node:process.version,cpu:os.cpus()[0].model.trim(),total_memory_bytes:os.totalmem(),platform:os.platform()},
    method:'Fresh isolated process; append-only inspection accessor; full GC before and after destructive reference removal after replay. Deltas are ordered retained heap/ArrayBuffer contributions, not additive intrinsic object sizes. No production analyzer is modified. RIB checkpoint is a profile subset, not full-replay success.',runs:[]};
  for(const scenario of ['rib_checkpoint','updates_complete'])for(let iteration=1;iteration<=3;iteration++){
    const child=spawn(process.execPath,['--expose-gc','--max-old-space-size=3072','scripts/profile_state.mjs','--worker',scenario],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
    const exit=await new Promise((done,fail)=>{child.on('error',fail);child.on('close',done);});if(exit!==0)throw new Error('组件剖析失败: '+stderr.slice(-1500));
    const run={iteration,...JSON.parse(stdout)};report.runs.push(run);await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n','utf8');console.log(JSON.stringify({scenario,iteration,counts:run.counts,heap:run.baseline.heapUsed}));
  }
}
