import {readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {bundlePath,jsonLines} from './bundle.mjs';

const textCompare=(a,b)=>a<b?-1:a>b?1:0;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const sha=text=>createHash('sha256').update(text).digest('hex');
const pointId=point=>JSON.stringify([point.collector,point.view]);
function windowMicros(seconds){const match=/^(\d+)(?:\.(\d{1,6}))?$/.exec(String(seconds));if(!match)throw new Error('关联窗口须为正秒数，最多六位小数');const value=BigInt(match[1])*1000000n+BigInt((match[2]??'').padEnd(6,'0'));if(value<=0n||value>4294967295000000n)throw new Error('关联窗口超出范围');return value;}
function validatePoints(points){
  if(!Array.isArray(points)||!points.length||points.length>128)throw new Error('关联需要 1..128 个明确观测点');
  const seen=new Set();
  for(const point of points){
    if(typeof point.collector!=='string'||!point.collector.trim()||typeof point.view!=='string'||!point.view.trim()||!['complete','partial'].includes(point.status))throw new Error('观测点身份或状态无效');
    if(seen.has(pointId(point)))throw new Error('关联观测点身份重复');seen.add(pointId(point));
    if(!Array.isArray(point.gaps??[]))throw new Error('观测缺档必须为数组');
    for(const gap of point.gaps??[])if(!Number.isSafeInteger(gap.from)||!Number.isSafeInteger(gap.to)||gap.from<0||gap.from>=gap.to)throw new Error('观测缺档时间无效');
  }
}

function observation(change,point){
  const source=change.source;
  if(change.schema_version!=='2.0'||!['path_change','origin_change','attribute_change','churn'].includes(change.kind)||typeof change.prefix!=='string'||!source||source.collector!==point.collector||source.view!==point.view)throw new Error('变化版本、类型或观测点身份不一致');
  if(!Number.isInteger(change.timestamp)||change.timestamp<0||change.timestamp>4294967295||!Number.isInteger(change.microseconds??0)||(change.microseconds??0)<0||(change.microseconds??0)>999999)throw new Error('变化时间无效');
  if(typeof source.file!=='string'||typeof source.record!=='string'||typeof source.offset!=='string'||!/^[1-9]\d*$/.test(source.record)||!/^\d+$/.test(source.offset)||!Number.isInteger(source.event_index)||source.event_index<0)throw new Error('变化来源位置无效');
  if(!Number.isInteger(change.peer_asn)||change.peer_asn<0||change.peer_asn>4294967295||typeof change.peer_ip!=='string'||typeof change.outbound!=='boolean'||(change.path_id!==undefined&&(!Number.isInteger(change.path_id)||change.path_id<0||change.path_id>4294967295)))throw new Error('变化 peer 或路径身份无效');
  if(typeof change.correlation_key!=='string')throw new Error('缺少 MoonBit 语义关联键，请重新生成 multi 结果包');
  const key=JSON.parse(change.correlation_key);
  if(key.prefix!==change.prefix||key.kind!==change.kind||!key.rule||typeof key.rule!=='object')throw new Error('关联键与变化内容不匹配');
  const signature=sha(JSON.stringify(canonical(key)));
  const id=sha(JSON.stringify([source.collector,source.view,source.file,source.record,source.offset,source.event_index,change.kind]));
  return {id,signature,prefix:change.prefix,kind:change.kind,at:BigInt(change.timestamp)*1000000n+BigInt(change.microseconds??0),
    point:pointId(point),collector:point.collector,view:point.view,peer_asn:change.peer_asn,peer_ip:change.peer_ip,
    outbound:change.outbound,path_id:change.path_id,source};
}

// 时间接近仅表示采集观测共现；固定窗口锚定首次事件，不沿后续事件链式延长。
export function correlateObservations(items,points,{windowSeconds=60,capacity=1000000,window=null,inputStatus='complete'}={}){
  validatePoints(points);
  if(!Number.isSafeInteger(capacity)||capacity<1)throw new Error('关联容量须为正整数');
  const state={seen:new Map(),events:[],duplicates:0};
  for(const [change,point]of items)accumulate(state,change,point,capacity);
  return correlatePrepared(state.events,state.duplicates,points,{windowSeconds,window,inputStatus});
}

function accumulate(state,change,point,capacity){
  const event=observation(change,point),previous=state.seen.get(event.id);
  if(previous){if(previous.signature!==event.signature||previous.at!==event.at)throw new Error('同一来源位置存在冲突的变化');state.duplicates++;return;}
  if(state.events.length>=capacity)throw new Error('关联事件超过容量，请缩小窗口或提高 --capacity');
  state.seen.set(event.id,event);state.events.push(event);
}

function correlatePrepared(events,duplicates,points,{windowSeconds,window,inputStatus}){
  const duration=windowMicros(windowSeconds);
  points=[...points].sort((a,b)=>textCompare(pointId(a),pointId(b)));
  if(window)for(const event of events)if(event.at<BigInt(window.from)*1000000n||event.at>BigInt(window.to)*1000000n+999999n)throw new Error('变化超出结果包时间窗口');
  events.sort((a,b)=>{
    if(a.at!==b.at)return a.at<b.at?-1:1;
    const context=textCompare(a.point,b.point)||textCompare(a.source.file,b.source.file);if(context)return context;
    for(const field of ['record','offset']){const left=BigInt(a.source[field]),right=BigInt(b.source[field]);if(left!==right)return left<right?-1:1;}
    return a.source.event_index-b.source.event_index||textCompare(a.kind,b.kind);
  });
  const active=new Map(),groups=[];
  for(const event of events){
    let group=active.get(event.signature);
    if(!group||event.at-group.first>=duration){group={signature:event.signature,prefix:event.prefix,kind:event.kind,first:event.at,last:event.at,observations:[]};groups.push(group);active.set(event.signature,group);}
    group.last=event.at;group.observations.push(event);
  }
  const result=groups.map((group,index)=>{
    const observedPoints=new Set(group.observations.map(event=>event.point)),collectors=[...new Set(group.observations.map(event=>event.collector))].sort(textCompare);
    const peers=new Set(group.observations.map(event=>JSON.stringify([event.point,event.peer_asn,event.peer_ip,event.outbound])));
    let end=group.first+duration;if(window)end=end<BigInt(window.to)*1000000n+1000000n?end:BigInt(window.to)*1000000n+1000000n;
    const missing=points.filter(point=>!observedPoints.has(pointId(point))).map(point=>{
      const quality=[];
      if(point.status!=='complete')quality.push('partial_input');
      if(point.baseline_status!=='explicit_rib')quality.push('baseline_'+(point.baseline_status??'unknown'));
      if(!point.continuous)quality.push('continuity_unverified');
      if((point.gaps??[]).some(gap=>BigInt(gap.from)*1000000n<end&&BigInt(gap.to)*1000000n>group.first))quality.push('observation_gap');
      return {collector:point.collector,view:point.view,from:String(group.first),to:String(end),quality:[...quality,'no_matching_notice_observed']};
    });
    return {id:`group-${index+1}`,prefix:group.prefix,kind:group.kind,signature_sha256:group.signature,
      first_observed_at:String(group.first),last_observed_at:String(group.last),window_end_exclusive:String(end),
      observed_collectors:collectors,observed_points:observedPoints.size,affected_peers:peers.size,
      cross_collector:collectors.length>1,unobserved:missing,
      observations:group.observations.map(({at,...event})=>({...event,observed_at:String(at)}))};
  });
  return {schema_version:'2.0',type:'cross_collector_correlation',input_status:inputStatus,
    interpretation:'temporal_cooccurrence_not_propagation_delay_or_causation',
    rule:'same_prefix_kind_and_MoonBit_semantic_transition_within_fixed_half_open_window',
    window_microseconds:String(duration),deduplication:'collector_view_file_record_offset_event_index_kind',
    input_observations:events.length+duplicates,unique_observations:events.length,duplicates,
    points:points.map(point=>({collector:point.collector,view:point.view,status:point.status,baseline_status:point.baseline_status,continuous:point.continuous,gaps:point.gaps??[]})),groups:result};
}

export async function correlateBundle(input,options={}){
  const path=resolve(input),index=JSON.parse(await readFile(path,'utf8'));
  if(index.schema_version!=='2.0'||index.type!=='collector_replay_bundle'||!Array.isArray(index.collectors)||!['complete','partial'].includes(index.status))throw new Error('输入不是完整或明确部分的回放结果包索引');
  validatePoints(index.collectors);
  if(!Number.isInteger(index.window?.from)||!Number.isInteger(index.window?.to)||index.window.from<0||index.window.from>index.window.to||index.window.to>4294967295)throw new Error('结果包时间窗口无效');
  const capacity=options.capacity??1000000;
  if(!Number.isSafeInteger(capacity)||capacity<1)throw new Error('关联容量须为正整数');
  windowMicros(options.windowSeconds??60);
  const state={seen:new Map(),events:[],duplicates:0};
  for(const point of index.collectors){
    let file;try{file=await bundlePath(dirname(path),point.changes_file);}catch(error){if(point.status==='partial'&&error.code==='ENOENT')continue;throw error;}
    if(point.changes_sha256){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);if(hash.digest('hex')!==point.changes_sha256)throw new Error('变化明细哈希不一致');}
    for await(const change of jsonLines(file))accumulate(state,change,point,capacity);
  }
  return correlatePrepared(state.events,state.duplicates,index.collectors,{windowSeconds:options.windowSeconds??60,window:index.window,inputStatus:index.status});
}

export async function correlateCommand(argv){
  const options={};for(let i=0;i<argv.length;i+=2){if(!['--input','--window','--capacity'].includes(argv[i])||!argv[i+1]||options[argv[i]])throw new Error('correlate 用法: --input index.json [--window 秒] [--capacity 事件数]');options[argv[i]]=argv[i+1];}
  if(!options['--input'])throw new Error('correlate 需要 --input index.json');
  return correlateBundle(options['--input'],{windowSeconds:options['--window']??60,capacity:Number(options['--capacity']??1000000)});
}
