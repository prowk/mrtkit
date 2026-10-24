import {readFile,writeFile,mkdir,mkdtemp,rm,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,relative,isAbsolute,sep,dirname} from 'node:path';
import {externalSort,DiskBudget,jsonlWriter} from './external-sort.mjs';
import {jsonLines,bundlePath} from './bundle.mjs';
import {validateBundle,canonical} from './validation.mjs';
import {observation,compareObservations,groupSummary,correlateObservations,windowMicros} from './correlate.mjs';

const textCompare=(a,b)=>a<b?-1:a>b?1:0;
const hash=value=>createHash('sha256').update(value).digest('hex');

// 两遍外部排序分别保证来源去重和固定语义窗口；覆盖 peer 也外排计数。
export async function correlateExternal(input,output,{windowSeconds=60,memoryBytes=67108864,diskBytes=8589934592,signal,onProgress=()=>{}}={}){
  if(!Number.isSafeInteger(memoryBytes)||memoryBytes<65536)throw new Error('外部关联排序内存预算无效');
  const budget=new DiskBudget(diskBytes);windowMicros(windowSeconds);signal?.throwIfAborted();
  const inputBytes=await readFile(input);
  const directory=resolve(output);await mkdir(directory,{recursive:false});
  const scratch=await mkdtemp(join(directory,'.work-')),writers=new Set(),temporary=new Map();let metadataBytes=0;
  const started=process.hrtime.bigint();
  let metadata={schema_version:'2.0',type:'cross_collector_correlation_bundle',status:'running',groups_file:'groups.jsonl',observations_file:'observations.jsonl',
    resources:{sort_memory_bytes:memoryBytes,disk_budget_bytes:diskBytes},input_bundle_sha256:hash(inputBytes)};
  const save=async()=>{const text=JSON.stringify(metadata,null,2)+'\n',bytes=Buffer.byteLength(text),delta=bytes-metadataBytes;
    if(delta>0)budget.reserve(delta);else budget.release(-delta);metadataBytes=bytes;await writeFile(join(directory,'index.json'),text,'utf8');};
  async function writer(path,isTemporary=false){const value=await jsonlWriter(path,{budget,signal});writers.add(value);if(isTemporary)temporary.set(path,value);return value;}
  async function close(value){try{return await value.close();}finally{writers.delete(value);}}
  const options={directory:scratch,memoryBytes,budget,signal};
  const remove=async path=>{await unlink(path);budget.release(temporary.get(path).bytes);temporary.delete(path);};
  try{
    await save();
    const descriptors=join(scratch,'input.jsonl'),spool=await writer(descriptors,true);
    const index=await validateBundle(input,{signal,onChange:async(change,point)=>{signal?.throwIfAborted();const item=observation(change,point);await spool.write({...item,at:String(item.at)});onProgress({phase:'validate',observations:spool.rows});}});
    await close(spool);
    const template=correlateObservations([],index.collectors,{windowSeconds,window:index.window,inputStatus:index.status});
    const {groups:ignored,...header}=template;const points=header.points,duration=BigInt(header.window_microseconds);
    let unique=0,duplicates=0,groupCount=0;
    async function* deduplicated(){let previous=null;
      for await(const item of externalSort(jsonLines(descriptors),{...options,compare:(a,b)=>textCompare(a.id,b.id)})){
        if(previous?.id===item.id){if(previous.at!==item.at||previous.signature!==item.signature||previous.evidence_sha256!==item.evidence_sha256)throw new Error('同一来源位置存在冲突的变化');duplicates++;continue;}
        previous=item;unique++;yield item;
      }
    }
    const summariesPath=join(scratch,'summaries.jsonl'),coveragePath=join(scratch,'peers.jsonl');
    const summaries=await writer(summariesPath,true),coverage=await writer(coveragePath,true),observations=await writer(join(directory,metadata.observations_file));
    let current=null;
    const completeGroup=async()=>{if(current){await summaries.write({...groupSummary(current,points,duration,index.window,current.id),first_observation:current.firstObservation});groupCount++;}};
    for await(const item of externalSort(deduplicated(),{...options,compare:(a,b)=>textCompare(a.signature,b.signature)||compareObservations(a,b)})){
      const time=BigInt(item.at);
      if(!current||current.signature!==item.signature||time-current.first>=duration){
        await completeGroup();current={signature:item.signature,prefix:item.prefix,kind:item.kind,first:time,last:time,
          id:'group-'+hash(item.signature+'\n'+item.at),observedPoints:new Set(),collectors:new Set(),affectedPeers:0,observationCount:0,firstObservation:item};
      }
      current.last=time;current.observedPoints.add(item.point);current.collectors.add(item.collector);
      current.observationCount++;
      const {at,...evidence}=item;
      await observations.write({group_id:current.id,observation:{...evidence,observed_at:at}});
      await coverage.write({group_id:current.id,peer:JSON.stringify([item.point,item.peer_asn,item.peer_ip,item.outbound])});
    }
    await completeGroup();await close(summaries);await close(coverage);
    const observationInfo=await close(observations);await remove(descriptors);
    async function* peerCounts(){let group=null,lastPeer=null,count=0;
      for await(const row of externalSort(jsonLines(coveragePath),{...options,compare:(a,b)=>textCompare(a.group_id,b.group_id)||textCompare(a.peer,b.peer)})){
        if(row.group_id!==group){if(group!==null)yield {group_id:group,count};group=row.group_id;lastPeer=null;count=0;}
        if(row.peer!==lastPeer){count++;lastPeer=row.peer;}
      }if(group!==null)yield {group_id:group,count};
    }
    async function* countedGroups(){
      const peers=peerCounts()[Symbol.asyncIterator]();
      try{let head=await peers.next();
        for await(const group of externalSort(jsonLines(summariesPath),{...options,compare:(a,b)=>textCompare(a.id,b.id)})){
          if(head.done||head.value.group_id!==group.id)throw new Error('关联覆盖计数与分组不一致');
          yield {...group,affected_peers:head.value.count};head=await peers.next();
        }
        if(!head.done)throw new Error('关联覆盖中存在多余分组');
      }finally{await peers.return?.();}
    }
    const outputGroups=await writer(join(directory,metadata.groups_file));let ordinal=0;
    for await(const group of externalSort(countedGroups(),{...options,compare:(a,b)=>compareObservations(a.first_observation,b.first_observation)||textCompare(a.id,b.id)})){
      const {first_observation,...summary}=group;await outputGroups.write({...summary,legacy_id:'group-'+(++ordinal)});
    }
    const groupInfo=await close(outputGroups);await remove(summariesPath);await remove(coveragePath);
    if(ordinal!==groupCount||observationInfo.rows!==unique)throw new Error('关联输出计数不一致');
    metadata={...metadata,status:'complete',legacy_header:{...header,input_observations:unique+duplicates,unique_observations:unique,duplicates},
      input_status:index.status,window:index.window,groups:groupCount,unique_observations:unique,duplicates,
      groups_sha256:groupInfo.sha256,groups_bytes:groupInfo.bytes,observations_sha256:observationInfo.sha256,observations_bytes:observationInfo.bytes,
      identifier:'sha256(signature_sha256 + LF + first_observed_unix_microseconds)',
      resources:{...metadata.resources,peak_new_disk_bytes:budget.peak,retained_output_bytes:budget.used,peak_rss_bytes:process.resourceUsage().maxRSS*1024,seconds:Number(process.hrtime.bigint()-started)/1e9}};
    await save();metadata.resources.peak_new_disk_bytes=budget.peak;metadata.resources.retained_output_bytes=budget.used;await save();
    return {schema_version:'2.0',type:metadata.type,status:'complete',index:join(directory,'index.json'),groups:groupCount,observations:unique};
  }catch(error){metadata={schema_version:'2.0',type:'cross_collector_correlation_bundle',status:'partial',
      input_bundle_sha256:metadata.input_bundle_sha256,groups_file:'groups.jsonl',observations_file:'observations.jsonl',
      error:{code:String(error.code??error.name).slice(0,64),message:String(error.message).slice(0,4096)}};
    // 预算失败诊断是必需的固定小型收据，不以同一已耗尽预算阻止记录失败原因。
    await writeFile(join(directory,'index.json'),JSON.stringify(metadata,null,2)+'\n','utf8');throw error;}
  finally{
    await Promise.allSettled([...writers].map(value=>value.close()));
    const part=relative(directory,resolve(scratch));if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new Error('拒绝清理越界关联临时目录');
    await rm(scratch,{recursive:true,force:true});
  }
}

// 仅供显式的小结果兼容重建；正常外部路径不构造全观测大对象。
export async function reconstructCorrelation(input,{capacity=1000000}={}){
  const index=JSON.parse(await readFile(input,'utf8'));
  if(index.schema_version!=='2.0'||index.type!=='cross_collector_correlation_bundle'||index.status!=='complete')throw new Error('关联结果包未完整完成');
  if(!Number.isSafeInteger(capacity)||capacity<1||index.unique_observations>capacity)throw new Error('兼容重建超过内存容量');
  const directory=dirname(resolve(input)),groups=[],map=new Map();
  for(const kind of ['groups','observations']){const file=await bundlePath(directory,index[kind+'_file']),hasher=createHash('sha256');
    const {createReadStream}=await import('node:fs');for await(const chunk of createReadStream(file))hasher.update(chunk);
    if(hasher.digest('hex')!==index[kind+'_sha256'])throw new Error('关联明细哈希不一致');}
  for await(const raw of jsonLines(await bundlePath(directory,index.groups_file))){if(groups.length>=capacity||map.has(raw.id))throw new Error('关联分组超过重建容量或标识重复');const {legacy_id,...group}=raw;const full={...group,id:legacy_id,observations:[]};groups.push(full);map.set(raw.id,full);}
  let count=0;for await(const row of jsonLines(await bundlePath(directory,index.observations_file))){const group=map.get(row.group_id);if(!group)throw new Error('观测引用不存在的关联组');group.observations.push(row.observation);count++;}
  if(count!==index.unique_observations||groups.length!==index.groups)throw new Error('关联重建计数不一致');
  for(const group of groups)if(group.observations.length!==group.observation_count)throw new Error('关联组观测计数不一致');
  return {...index.legacy_header,groups};
}
