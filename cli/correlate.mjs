import {createHash} from 'node:crypto';
import {canonical,pointId,validatePoints,validateWindow,validateChange,changeEvidence,validateBundle} from './validation.mjs';

const textCompare=(a,b)=>a<b?-1:a>b?1:0;
const sha=text=>createHash('sha256').update(text).digest('hex');
function windowMicros(seconds){const match=/^(\d+)(?:\.(\d{1,6}))?$/.exec(String(seconds));if(!match)throw new Error('关联窗口须为正秒数，最多六位小数');const value=BigInt(match[1])*1000000n+BigInt((match[2]??'').padEnd(6,'0'));if(value<=0n||value>4294967295000000n)throw new Error('关联窗口超出范围');return value;}

function observation(change,point){
  change=validateChange(change,point);
  const source=change.source;
  const key=JSON.parse(change.correlation_key);
  const signature=sha(JSON.stringify(canonical(key)));
  const id=sha(JSON.stringify([source.collector,source.view,source.file,source.record,source.offset,source.event_index,change.kind]));
  const origin=snapshot=>snapshot?{timestamp:snapshot.timestamp,microseconds:snapshot.microseconds??0,source:snapshot.source??null}:null;
  const evidence_sha256=sha(JSON.stringify(canonical({semantic:changeEvidence(change),peer_asn:change.peer_asn,peer_ip:change.peer_ip,outbound:change.outbound,
    path_id:change.path_id??null,before_origin:origin(change.before),after_origin:origin(change.after)})));
  return {id,signature,evidence_sha256,prefix:change.prefix,kind:change.kind,at:BigInt(change.timestamp)*1000000n+BigInt(change.microseconds??0),
    point:pointId(point),collector:point.collector,view:point.view,peer_asn:change.peer_asn,peer_ip:change.peer_ip,
    outbound:change.outbound,path_id:change.path_id,source};
}

// 时间接近仅表示采集观测共现；固定窗口锚定首次事件，不沿后续事件链式延长。
export function correlateObservations(items,points,{windowSeconds=60,capacity=1000000,window=null,inputStatus='complete'}={}){
  validatePoints(points);
  if(window)validateWindow(window);
  if(!Number.isSafeInteger(capacity)||capacity<1)throw new Error('关联容量须为正整数');
  const state={seen:new Map(),events:[],duplicates:0};
  for(const [change,point]of items)accumulate(state,change,point,capacity);
  return correlatePrepared(state.events,state.duplicates,points,{windowSeconds,window,inputStatus});
}

function accumulate(state,change,point,capacity){
  const event=observation(change,point),previous=state.seen.get(event.id);
  if(previous){if(previous.signature!==event.signature||previous.at!==event.at||previous.evidence_sha256!==event.evidence_sha256)throw new Error('同一来源位置存在冲突的变化');state.duplicates++;return;}
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
  const capacity=options.capacity??1000000;
  if(!Number.isSafeInteger(capacity)||capacity<1)throw new Error('关联容量须为正整数');
  windowMicros(options.windowSeconds??60);
  const state={seen:new Map(),events:[],duplicates:0};
  const index=await validateBundle(input,{onChange:(change,point)=>accumulate(state,change,point,capacity)});
  return correlatePrepared(state.events,state.duplicates,index.collectors,{windowSeconds:options.windowSeconds??60,window:index.window,inputStatus:index.status});
}

export async function correlateCommand(argv){
  const options={};for(let i=0;i<argv.length;i+=2){if(!['--input','--window','--capacity'].includes(argv[i])||!argv[i+1]||options[argv[i]])throw new Error('correlate 用法: --input index.json [--window 秒] [--capacity 事件数]');options[argv[i]]=argv[i+1];}
  if(!options['--input'])throw new Error('correlate 需要 --input index.json');
  return correlateBundle(options['--input'],{windowSeconds:options['--window']??60,capacity:Number(options['--capacity']??1000000)});
}
