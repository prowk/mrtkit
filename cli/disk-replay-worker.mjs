import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {DiskBudget} from './external-sort.mjs';
import {packetFile,BufferedFile,canonical,portable,stateAccumulator} from './disk-storage.mjs';

const config=JSON.parse(await readFile(process.argv[2],'utf8')),bridge=await import(pathToFileURL(config.bridge));
const checked=text=>{const value=JSON.parse(text);if(value.error)throw Object.assign(new Error(value.error),{details:value});return value;};
const digest=createHash('sha256');for await(const bytes of createReadStream(config.input))digest.update(bytes);if(digest.digest('hex')!==config.input_sha256)throw new Error('分区输入哈希不一致');
checked(bridge.configure(JSON.stringify({...config.analysis,mode:'changes',format:'json',metrics_changes:true,correlation_keys:true,
  collector:config.collector,view:config.view,from_time:config.window.from,to_time:config.window.to,window_seconds:config.analysis.window_seconds??60,threshold:config.analysis.threshold??10,capacity:config.analysis.capacity??1000000})));
const budget=new DiskBudget(config.disk_budget_bytes),changes=await BufferedFile.create(config.changes,{budget}),states=await BufferedFile.create(config.state,{budget});
const capacityTrace=config.capacity_trace?await BufferedFile.create(config.capacity_trace,{budget}):null;
const labels=new Map(config.files.map((file,index)=>[file.path,`input-${String(index+1).padStart(4,'0')}/${file.label}`]));
const fingerprint=stateAccumulator(),start=process.hrtime.bigint();let previousFile=-1,baseline=false,records=0,events=0,stateEvents=0,notices=0,analysisNs=0n,noticeNs=0n,stateNs=0n,failure=null,origin=null,partialSummary=null;
try{
  for await(const packet of packetFile(config.input)){
    if(records%256===0&&process.memoryUsage().rss>config.rss_budget_bytes)throw new Error('peer 分区超过 RSS 预算');
    if(packet.fileIndex<previousFile||!config.files[packet.fileIndex])throw new Error('分区文件索引无效或倒序');
    const source=config.files[packet.fileIndex];
    origin={file:source.path,record:String(packet.record),offset:String(packet.offset)};
    if(packet.fileIndex!==previousFile){if(baseline)checked(bridge.end_baseline());bridge.reset_file();baseline=source.kind==='rib';if(baseline)checked(bridge.begin_baseline());previousFile=packet.fileIndex;}
    const oldCount=capacityTrace?bridge.route_count():0;
    const before=process.hrtime.bigint();const batch=checked(bridge.consume_selected_metrics(packet.data,source.path,packet.record,packet.offset,JSON.stringify(packet.indices)));analysisNs+=process.hrtime.bigint()-before;
    if(capacityTrace){const delta=bridge.route_count()-oldCount;if(delta)await capacityTrace.write(JSON.stringify({file_index:packet.fileIndex,record:String(packet.record),event_index:packet.indices.at(-1)??0,delta})+'\n');}
    records++;events+=batch.route_events;stateEvents+=batch.state_events;
    const serial=process.hrtime.bigint(),rows=checked(bridge.drain_changes());noticeNs+=process.hrtime.bigint()-serial;
    for(const row of rows){const before=process.hrtime.bigint(),text=JSON.stringify(row)+'\n';noticeNs+=process.hrtime.bigint()-before;await changes.write(text);notices++;}
    if(records%50000===0)process.stderr.write(JSON.stringify({phase:'peer_replay',peer:config.peer,records,rss:process.memoryUsage().rss})+'\n');
  }
  if(baseline)checked(bridge.end_baseline());
  checked(bridge.state_export_begin());let exported=0;
  for(;;){if(process.memoryUsage().rss>config.rss_budget_bytes)throw new Error('状态导出超过 RSS 预算');const before=process.hrtime.bigint(),rows=checked(bridge.state_export_chunk(128));if(!rows.length)break;
    const lines=rows.map(row=>{fingerprint.add(portable(row,labels));return JSON.stringify(canonical(row))+'\n';});stateNs+=process.hrtime.bigint()-before;
    await states.write(lines.join(''));exported+=rows.length;if(exported%128000===0)process.stderr.write(JSON.stringify({phase:'peer_export',peer:config.peer,rows:exported,rss:process.memoryUsage().rss})+'\n');
  }
  if(process.resourceUsage().maxRSS*1024>config.rss_budget_bytes)throw new Error('peer 峰值 RSS 超过预算');
}catch(error){failure={code:error.code??error.name,message:error.message,origin,temporary_frame_position:error.details?.position};partialSummary=error.details?.summary??null;}
const changeInfo=await changes.close(),stateInfo=await states.close();
const traceInfo=capacityTrace?await capacityTrace.close():null;
let summary=partialSummary,totals=null;
try{summary=checked(bridge.finish());totals=checked(bridge.path_totals());}catch(error){if(!failure)throw error;}
const receipt={complete:failure===null,failure,peer:config.peer,records,route_events:events,state_events:stateEvents,notices,summary,path_totals:totals,
  changes:changeInfo,state:stateInfo,capacity_trace:traceInfo,state_fingerprint:fingerprint.result(),seconds:Number(process.hrtime.bigint()-start)/1e9,peak_rss_bytes:process.resourceUsage().maxRSS*1024,
  costs:{redecode_and_analysis_seconds:Number(analysisNs)/1e9,notice_serialization_seconds:Number(noticeNs)/1e9,state_serialization_and_fingerprint_seconds:Number(stateNs)/1e9}};
process.stdout.write(JSON.stringify(receipt)+'\n');process.exitCode=failure?2:0;
