import {readFile,writeFile,mkdir,mkdtemp,stat,unlink,rm,rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve,join,relative,isAbsolute,sep,basename} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {readManifest,coverageGaps} from './multi.mjs';
import {frames,inputChunks} from './input.mjs';
import {DiagnosticCollector} from './diagnostics.mjs';
import {DiskBudget,externalSort} from './external-sort.mjs';
import {BufferedFile,encodePacket,canonical,portable,stateAccumulator} from './disk-storage.mjs';
import {jsonLines} from './bundle.mjs';
import {validateBundleData} from './validation.mjs';
import {ReplayRss} from './replay-resources.mjs';

const checked=text=>{const value=JSON.parse(text);if(value.error)throw Object.assign(new Error(value.error),{details:value});return value;};
const textCompare=(a,b)=>a<b?-1:a>b?1:0;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function digest(path,signal){const hash=createHash('sha256');for await(const chunk of createReadStream(path)){signal?.throwIfAborted();hash.update(chunk);}return hash.digest('hex');}
function assertOwned(path,parent){const part=relative(resolve(parent),resolve(path));if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new Error('拒绝操作越界的回放临时路径');}

export class PeerStore {
  constructor(directory,budget,{maxPeers=4096,maxOpen=64}={}){if(!Number.isInteger(maxOpen)||maxOpen<1||maxOpen>128)throw new Error('分区写句柄上限无效');this.directory=directory;this.budget=budget;this.maxPeers=maxPeers;this.maxOpen=maxOpen;this.peers=new Map();this.open=new Map();this.initial=null;this.writeSeconds=0;this.handleOpens=0;this.handleEvictions=0;}
  async handle(meta){
    if(this.open.has(meta.peer)){const writer=this.open.get(meta.peer);this.open.delete(meta.peer);this.open.set(meta.peer,writer);return writer;}
    if(this.open.size>=this.maxOpen){const [key,writer]=this.open.entries().next().value;this.writeSeconds+=(await writer.close()).write_seconds;this.open.delete(key);this.handleEvictions++;}
    const writer=await BufferedFile.create(meta.path,{budget:this.budget,append:meta.created});this.handleOpens++;meta.created=true;this.open.set(meta.peer,writer);return writer;
  }
  async append(peer,packet,events=0,states=0){
    let meta=this.peers.get(peer);
    if(!meta){if(this.peers.size>=this.maxPeers)throw new Error('peer 分区数量超过显式上限');const id='peer-'+String(this.peers.size+1).padStart(5,'0');meta={peer,id,path:join(this.directory,id+'.mrtp'),created:false,bytes:0,packets:0,route_events:0,state_events:0,hash:createHash('sha256')};this.peers.set(peer,meta);
      if(this.initial)await this.append(peer,this.initial);
    }
    const writer=await this.handle(meta);await writer.write(packet);meta.hash.update(packet);meta.bytes+=packet.length;meta.packets++;meta.route_events+=events;meta.state_events+=states;
  }
  async finish(){const results=await Promise.allSettled([...this.open.values()].map(writer=>writer.close()));this.open.clear();for(const result of results){if(result.status==='rejected')throw result.reason;this.writeSeconds+=result.value.write_seconds;}
    return [...this.peers.values()].map(({hash,...meta})=>({...meta,sha256:hash.digest('hex')}));}
  async close(){await Promise.allSettled([...this.open.values()].map(writer=>writer.close()));this.open.clear();}
}

// 完整逻辑状态按 peer 落盘，单个 peer 的双向流始终在同一分析器内按原序回放。
export async function replayDisk(manifestPath,outputPath,{rssBytes=2147483648,diskBytes=128849018880,memoryBytes=67108864,maxPeers=4096,keepPartitions=false,secondsBudget=7200,bridgeFile=null,signal,onProgress=()=>{}}={}){
  if(!Number.isSafeInteger(rssBytes)||rssBytes<134217728||!Number.isSafeInteger(memoryBytes)||memoryBytes<65536||!Number.isSafeInteger(maxPeers)||maxPeers<1||maxPeers>65535||!Number.isSafeInteger(secondsBudget)||secondsBudget<1)throw new Error('磁盘回放资源参数无效');
  const budget=new DiskBudget(diskBytes),manifest=await readManifest(manifestPath);
  if(manifest.collectors.length!==1)throw new Error('磁盘回放每次需要一个明确采集器/视图');
  const group=manifest.collectors[0];if(group.files.length>65535||new Set(group.files.map(file=>file.path)).size!==group.files.length)throw new Error('输入文件过多或路径重复，来源位置存在歧义');
  signal?.throwIfAborted();
  const directory=resolve(outputPath);await mkdir(directory,{recursive:false});const scratch=await mkdtemp(join(directory,'.work-'));const partitionDirectory=join(scratch,'partitions');await mkdir(partitionDirectory);
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new Error('完整回放超过预定时间预算')),secondsBudget*1000);timer.unref();const jobSignal=controller.signal;
  const started=process.hrtime.bigint(),temporary=new Map(),store=new PeerStore(partitionDirectory,budget,{maxPeers});
  const rss=new ReplayRss();
  let stateOutput=null,changeOutput=null,jointPeak=0,rootIndexBytes=0,lastOrigin=null,worker=null,phase='original_decode',stateMergeNs=0n;
  const point={collector:group.collector,view:group.view,status:'running',continuous:group.continuous===true,gaps:coverageGaps(group,manifest.window),files:[],changes_file:'collector-0001.changes.jsonl',state_file:'collector-0001.state.jsonl'};
  const index={schema_version:'2.0',type:'collector_replay_bundle',status:'running',interpretation:'independent_collector_route_observations_not_business_outage',window:manifest.window,analysis:manifest.analysis??{},collectors:[point]};
  const save=async()=>{const text=JSON.stringify(index,null,2)+'\n',bytes=Buffer.byteLength(text),delta=bytes-rootIndexBytes;if(delta>0)budget.reserve(delta);else budget.release(-delta);rootIndexBytes=bytes;await writeFile(join(directory,'index.json'),text,'utf8');};
  const addTemporary=async(path,bytes)=>{temporary.set(path,bytes);};
  const remove=async path=>{assertOwned(path,scratch);await unlink(path);budget.release(temporary.get(path));temporary.delete(path);};
  const writeTemporary=async(path,bytes)=>{budget.reserve(bytes.length);await writeFile(path,bytes);temporary.set(path,bytes.length);};
  const progress=value=>{jobSignal.throwIfAborted();if(process.memoryUsage().rss>rssBytes)throw new Error('主进程超过 RSS 预算');onProgress(value);jobSignal.throwIfAborted();};
  try{
    await save();const bridgeBytes=await readFile(bridgeFile??new URL('../_build/js/release/build/bridge/bridge.js',import.meta.url)),bridgePath=join(scratch,'bridge.mjs');await writeTemporary(bridgePath,bridgeBytes);
    point.storage={kind:'peer_disk',bridge_sha256:sha(bridgeBytes)};
    const bridge=await import(pathToFileURL(bridgePath)),analysis={...(manifest.analysis??{})};
    const config={...analysis,mode:'changes',format:'json',collector:group.collector,view:group.view,from_time:manifest.window.from,to_time:manifest.window.to,
      window_seconds:analysis.window_seconds??60,threshold:analysis.threshold??10,capacity:analysis.capacity??1000000};
    checked(bridge.configure(JSON.stringify(config)));const summary=checked(bridge.finish());checked(bridge.configure(JSON.stringify({...config,mode:'parse'})));
    const central={records:0n,warmup_records:0n,skipped_records:0n,ignored_families:0n},diagnostics=new DiagnosticCollector();
    const lower=BigInt(manifest.window.from)*1000000n+BigInt(analysis.from_micros??0),upper=BigInt(manifest.window.to)*1000000n+BigInt(analysis.to_micros??999999);
    let inputRecords=0,inputEvents=0,inputStates=0,decodeNs=0n,inputBytes=0;
    for(const [fileIndex,file]of group.files.entries()){
      const initial=await stat(file.path),hash=await digest(file.path,jobSignal),metadata={...file,expected_sha256:file.sha256??null,sha256:hash,bytes:initial.size,records:0,first_timestamp:null,last_timestamp:null};point.files.push(metadata);
      if(file.sha256&&hash!==file.sha256.toLowerCase())throw new Error('输入 SHA-256 不一致');bridge.reset_file();let sawTable=false;
      for await(const frame of frames(inputChunks(file.path))){jobSignal.throwIfAborted();metadata.records++;inputRecords++;inputBytes+=frame.data.length;lastOrigin={file:file.path,record:String(metadata.records),offset:String(frame.offset)};
        const before=process.hrtime.bigint(),batch=checked(bridge.partition_record(frame.data));decodeNs+=process.hrtime.bigint()-before;
        const time=batch.header.timestamp;if(time<file.from||time>file.to)throw new Error('原记录时间超出声明文件范围');
        if(file.kind==='rib'&&(batch.header.kind!==13||batch.skipped||time>manifest.window.from))throw new Error('初始 RIB 必须是窗口之前的完整受支持快照');
        if(file.kind==='update'&&batch.header.kind===13)throw new Error('UPDATE 输入中不能包含 RIB/peer 表');
        metadata.first_timestamp=metadata.first_timestamp===null?time:Math.min(metadata.first_timestamp,time);metadata.last_timestamp=metadata.last_timestamp===null?time:Math.max(metadata.last_timestamp,time);
        inputEvents+=batch.route_events;inputStates+=batch.state_events;
        const source={...lastOrigin,event_index:0,collector:group.collector,view:group.view};diagnostics.add(batch.diagnostics.map(row=>({...row,source})));
        if(file.kind!=='rib'){const instant=BigInt(time)*1000000n+BigInt(batch.microseconds??0);if(instant<lower)central.warmup_records++;else if(instant<=upper){central.records++;if(batch.skipped)central.skipped_records++;central.ignored_families+=BigInt(batch.ignored_families);}}
        if(batch.peer_table){if(file.kind!=='rib'||sawTable)throw new Error('初始 RIB 只能有一个 peer 表');sawTable=true;store.initial=encodePacket({fileIndex,record:metadata.records,offset:frame.offset,indices:[],data:frame.data});}
        for(const part of batch.parts)await store.append(part.peer,encodePacket({fileIndex,record:metadata.records,offset:frame.offset,indices:part.event_indices,data:Buffer.from(part.data)}),part.event_indices.length,batch.state_events);
        if(inputRecords%25000===0)progress({phase:'partition',records:inputRecords,route_events:inputEvents,partitions:store.peers.size,handle_opens:store.handleOpens,rss:process.memoryUsage().rss});
      }
      if(file.kind==='rib'&&!sawTable)throw new Error('初始 RIB 为空或缺少 peer 表');const final=await stat(file.path);if(final.size!==initial.size||final.mtimeMs!==initial.mtimeMs)throw new Error('原始输入在回放中改变');metadata.complete=true;
    }
    const peers=(await store.finish()).sort((a,b)=>textCompare(a.peer,b.peer));for(const peer of peers)await addTemporary(peer.path,peer.bytes);
    phase='peer_replay';
    if(peers.reduce((sum,peer)=>sum+peer.route_events,0)!==inputEvents||peers.reduce((sum,peer)=>sum+peer.state_events,0)!==inputStates)throw new Error('原始与分区事件总数不一致');
    const partitionSeconds=Number(process.hrtime.bigint()-started)/1e9,files=group.files.map(file=>({...file,label:basename(file.path)})),labels=new Map(files.map((file,i)=>[file.path,`input-${String(i+1).padStart(4,'0')}/${file.label}`]));
    checked(bridge.configure(JSON.stringify({...config,mode:'parse'})));global.gc?.();
    const needCapacityTrace=config.capacity<inputEvents,receipts=[],stateFingerprint=stateAccumulator();let totalNotices=0,pathSum=0n,pathSamples=0n;
    stateOutput=await BufferedFile.create(join(directory,point.state_file),{budget});
    const changePaths=[],tracePaths=[],changeHashes=new Map();
    for(const [ordinal,peer]of peers.entries()){
      progress({phase:'peer_start',peer:peer.peer,partition:ordinal+1,partitions:peers.length});
      const rootPeak=process.resourceUsage().maxRSS*1024,childBudget=rssBytes-rootPeak-67108864;if(childBudget<134217728)throw new Error('RSS 预算不足以启动有界 peer 作业');
      const paths={changes:join(scratch,peer.id+'.changes.jsonl'),state:join(scratch,peer.id+'.state.jsonl'),capacity_trace:needCapacityTrace?join(scratch,peer.id+'.capacity.jsonl'):undefined};
      const job={bridge:bridgePath,input:peer.path,input_sha256:peer.sha256,peer:peer.peer,collector:group.collector,view:group.view,files,window:manifest.window,analysis,
        ...paths,rss_budget_bytes:childBudget,disk_budget_bytes:diskBytes-budget.used-1048576};if(job.disk_budget_bytes<1)throw new Error('磁盘预算不足以启动 peer 作业');
      const jobPath=join(scratch,peer.id+'.json'),jobBytes=Buffer.from(JSON.stringify(job),'utf8');if(jobBytes.length>1048576)throw new Error('peer 作业配置超过 1 MiB');await writeTemporary(jobPath,jobBytes);
      const args=[`--max-old-space-size=${Math.max(128,Math.floor(childBudget/1048576)-128)}`,fileURLToPath(new URL('./disk-replay-worker.mjs',import.meta.url)),jobPath];
      worker=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',pending='';
      const cancelWorker=()=>worker?.kill();jobSignal.addEventListener('abort',cancelWorker,{once:true});
      if(jobSignal.aborted)cancelWorker();
      worker.stdout.setEncoding('utf8');worker.stdout.on('data',text=>{stdout+=text;if(stdout.length>1048576)worker.kill();});worker.stderr.on('data',text=>{stderr=(stderr+text).slice(-8192);pending+=text;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){try{const row=JSON.parse(line);jointPeak=Math.max(jointPeak,process.memoryUsage().rss+(row.rss??0));onProgress(row);}catch{}}});
      const exit=await new Promise((done,fail)=>{worker.once('error',fail);worker.once('close',done);});jobSignal.removeEventListener('abort',cancelWorker);worker=null;jobSignal.throwIfAborted();
      let receipt;try{receipt=JSON.parse(stdout);}catch{throw new Error('peer 进程失败: '+stderr.slice(-2000));}
      for(const kind of ['changes','state','capacity_trace'])if(receipt[kind]){budget.reserve(receipt[kind].bytes);await addTemporary(paths[kind],receipt[kind].bytes);}
      if(exit!==0||!receipt.complete)throw Object.assign(new Error('peer 回放失败: '+(receipt.failure?.message??stderr)),{details:receipt});
      if(rss.completePeer(process.resourceUsage().maxRSS*1024,receipt.peak_rss_bytes)>rssBytes)throw new Error('父进程与 peer 并发阶段 RSS 合计上界超过预算');
      for(const [key,value]of Object.entries(receipt.summary)){if(['schema_version','baseline_status','mean_path_length','max_path_length','warmup_records','records','skipped_records','ignored_families'].includes(key))continue;
        summary[key]=typeof value==='string'?String(BigInt(summary[key])+BigInt(value)):summary[key]+value;}
      summary.max_path_length=Math.max(summary.max_path_length,receipt.summary.max_path_length);if(receipt.summary.baseline_status==='updates_only')summary.baseline_status='updates_only';
      pathSum+=BigInt(receipt.path_totals.path_sum);pathSamples+=BigInt(receipt.path_totals.path_samples);totalNotices+=receipt.notices;stateFingerprint.merge(receipt.state_fingerprint);
      const mergeStart=process.hrtime.bigint(),hash=createHash('sha256');let copied=0,rows=0;for await(const bytes of createReadStream(paths.state)){jobSignal.throwIfAborted();hash.update(bytes);copied+=bytes.length;for(let at=bytes.indexOf(10);at>=0;at=bytes.indexOf(10,at+1))rows++;await stateOutput.write(bytes);}stateMergeNs+=process.hrtime.bigint()-mergeStart;
      if(hash.digest('hex')!==receipt.state.sha256||copied!==receipt.state.bytes||rows!==receipt.state_fingerprint.rows)throw new Error('peer 最终状态文件完整性不一致');
      await remove(paths.state);await remove(jobPath);changePaths.push(paths.changes);changeHashes.set(paths.changes,receipt.changes.sha256);if(paths.capacity_trace)tracePaths.push(paths.capacity_trace);receipts.push(receipt);
    }
    const stateInfo=await stateOutput.close();stateOutput=null;
    for(const [key,value]of Object.entries(central))summary[key]=String(value);summary.baseline_status=group.files.some(file=>file.kind==='rib')?'explicit_rib':summary.baseline_status;summary.mean_path_length=pathSamples===0n?0:Number(pathSum)/Number(pathSamples);
    if(summary.tracked_routes!==stateFingerprint.result().rows)throw new Error('分区统计与导出状态数不一致');
    const sortOptions={directory:scratch,memoryBytes,budget,signal:jobSignal};
    phase='global_capacity';
    if(needCapacityTrace){async function* deltas(){for(const path of tracePaths)yield* jsonLines(path);}let cached=0;
      for await(const row of externalSort(deltas(),{...sortOptions,compare:(a,b)=>a.file_index-b.file_index||(BigInt(a.record)<BigInt(b.record)?-1:BigInt(a.record)>BigInt(b.record)?1:0)||a.event_index-b.event_index})){cached+=row.delta;if(cached<0||cached>config.capacity)throw new Error('按原始顺序重建的全局路由容量超限');}
      if(cached!==summary.tracked_routes)throw new Error('全局容量轨迹与最终状态不一致');}
    phase='notice_export';const noticeStart=process.hrtime.bigint();
    const sourceOrder=new Map(group.files.map((file,i)=>[file.path,i])),kindOrder={path_change:0,origin_change:1,attribute_change:2,churn:3};
    async function* notices(){for(const path of changePaths){if(await digest(path,jobSignal)!==changeHashes.get(path))throw new Error('peer 变化文件哈希不一致');yield* jsonLines(path);}}
    const compare=(a,b)=>(sourceOrder.get(a.source.file)-sourceOrder.get(b.source.file))||(BigInt(a.source.record)<BigInt(b.source.record)?-1:BigInt(a.source.record)>BigInt(b.source.record)?1:0)||a.source.event_index-b.source.event_index||kindOrder[a.kind]-kindOrder[b.kind];
    changeOutput=await BufferedFile.create(join(directory,point.changes_file),{budget});const portableChanges=createHash('sha256');let written=0;
    for await(const change of externalSort(notices(),{...sortOptions,compare})){jobSignal.throwIfAborted();portableChanges.update(JSON.stringify(canonical(portable(change,labels)))+'\n');await changeOutput.write(JSON.stringify(change)+'\n');written++;}
    const changeInfo=await changeOutput.close();changeOutput=null;if(written!==totalNotices)throw new Error('完整变化输出计数不一致');
    for(const path of [...changePaths,...tracePaths])await remove(path);
    point.summary=summary;point.baseline_status=summary.baseline_status;point.change_notices=totalNotices;point.changes_sha256=changeInfo.sha256;point.state_sha256=stateInfo.sha256;
    point.storage={kind:'peer_disk',original_records:inputRecords,original_route_events:inputEvents,original_state_events:inputStates,original_decompressed_bytes:inputBytes,partitions:peers.length,
      temporary_frames:peers.reduce((sum,peer)=>sum+peer.packets,0),capacity_proof:needCapacityTrace?'globally_sorted_cache_deltas':'route_event_upper_bound',bridge_sha256:sha(bridgeBytes),
      state_fingerprint:stateFingerprint.result(),portable_changes_sha256:portableChanges.digest('hex'),portable_source_labels:'input ordinal and archive basename; physical directories excluded only from portable fingerprints',
      costs:{partition_seconds:partitionSeconds,original_decode_and_partition_seconds:Number(decodeNs)/1e9,partition_write_seconds:store.writeSeconds,spool_handle_opens:store.handleOpens,spool_handle_evictions:store.handleEvictions,
        state_merge_and_verification_seconds:Number(stateMergeNs)/1e9,notice_sort_export_and_fingerprint_seconds:Number(process.hrtime.bigint()-noticeStart)/1e9,
        redecode_and_analysis_seconds:receipts.reduce((sum,row)=>sum+row.costs.redecode_and_analysis_seconds,0),notice_serialization_seconds:receipts.reduce((sum,row)=>sum+row.costs.notice_serialization_seconds,0),
        state_serialization_and_fingerprint_seconds:receipts.reduce((sum,row)=>sum+row.costs.state_serialization_and_fingerprint_seconds,0),notice_write_seconds:receipts.reduce((sum,row)=>sum+row.changes.write_seconds,0)+changeInfo.write_seconds,
        state_write_seconds:receipts.reduce((sum,row)=>sum+row.state.write_seconds,0)+stateInfo.write_seconds},output:{changes_bytes:changeInfo.bytes,state_bytes:stateInfo.bytes},peer_runs:receipts};
    if(keepPartitions){const target=join(directory,'partitions');assertOwned(target,directory);assertOwned(partitionDirectory,scratch);await rename(partitionDirectory,target);
      const info={schema_version:'1.0',format:'mrtkit-peer-packet-v1',files,peers:peers.map(peer=>({peer:peer.peer,file:peer.id+'.mrtp',sha256:peer.sha256,bytes:peer.bytes,packets:peer.packets}))};
      const bytes=Buffer.from(JSON.stringify(info,null,2)+'\n','utf8');budget.reserve(bytes.length);await writeFile(join(target,'index.json'),bytes);point.partitions_index='partitions/index.json';for(const peer of peers)temporary.delete(peer.path);
    }else for(const peer of peers)await remove(peer.path);
    await remove(bridgePath);point.diagnostics=diagnostics.report();await save();
    phase='bundle_verification';progress({phase:'bundle_verification'});const verifyStart=process.hrtime.bigint();await validateBundleData({...index,status:'complete',collectors:[{...point,status:'complete'}]},directory,{signal:jobSignal,onState:(_event,_point,rows)=>{if(rows%250000===0)progress({phase:'verify_state',rows});}});
    point.storage.costs.bundle_verification_seconds=Number(process.hrtime.bigint()-verifyStart)/1e9;
    if(worker!==null)throw new Error('最终校验结束时仍有 peer 子进程');
    const rssResult=rss.result(process.resourceUsage().maxRSS*1024);if(rssResult.peak_rss_upper_bound_bytes>rssBytes)throw new Error('完整回放合计峰值 RSS 上界超过预算');
    assertOwned(scratch,directory);await rm(scratch,{recursive:true,force:true});jobSignal.throwIfAborted();
    if(Number(process.hrtime.bigint()-started)/1e9>secondsBudget)throw new Error('完整回放超过预定时间预算');
    point.storage.resources={rss_budget_bytes:rssBytes,disk_budget_bytes:diskBytes,peak_new_disk_bytes:budget.peak,...rssResult,
      sampled_joint_peak_rss_bytes:jointPeak,seconds:Number(process.hrtime.bigint()-started)/1e9,seconds_budget:secondsBudget};
    point.status='complete';index.status='complete';await save();point.storage.resources.peak_new_disk_bytes=budget.peak;await save();
    return {schema_version:'2.0',type:index.type,status:'complete',index:join(directory,'index.json'),collectors:1};
  }catch(error){point.status='partial';index.status='partial';point.error=String(error.message).slice(0,4096);point.failure={phase,origin:error.details?.failure?.origin??lastOrigin,details:error.details??null,resources:{...rss.result(process.resourceUsage().maxRSS*1024),peak_new_disk_bytes:budget.peak,seconds:Number(process.hrtime.bigint()-started)/1e9}};await writeFile(join(directory,'index.json'),JSON.stringify(index,null,2)+'\n','utf8');throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker?.kill();await Promise.allSettled([store.close(),stateOutput?.close(),changeOutput?.close()]);assertOwned(scratch,directory);await rm(scratch,{recursive:true,force:true});}
}

export async function diskReplayCommand(argv){
  const options={};let keep=false;
  for(let i=0;i<argv.length;){if(argv[i]==='--keep-partitions'){keep=true;i++;continue;}if(!['--manifest','--output','--rss-mib','--disk-mib','--memory-mib'].includes(argv[i])||!argv[i+1]||options[argv[i]])throw new Error('replay-disk 用法: --manifest 清单 --output 新目录 [--rss-mib 2048 --disk-mib 122880 --memory-mib 64 --keep-partitions]');options[argv[i]]=argv[i+1];i+=2;}
  if(!options['--manifest']||!options['--output'])throw new Error('replay-disk 需要输入清单与新输出目录');
  const controller=new AbortController(),cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{return await replayDisk(options['--manifest'],options['--output'],{rssBytes:Number(options['--rss-mib']??2048)*1048576,diskBytes:Number(options['--disk-mib']??122880)*1048576,memoryBytes:Number(options['--memory-mib']??64)*1048576,keepPartitions:keep,signal:controller.signal,onProgress:row=>process.stderr.write(JSON.stringify(row)+'\n')});}
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
