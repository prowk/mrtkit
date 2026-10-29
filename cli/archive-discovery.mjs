import {createHash} from 'node:crypto';

export const hashText=text=>createHash('sha256').update(text).digest('hex');
export function utcMicros(text){
  if(/^\d+(?:\.\d{1,6})?$/.test(text)){const [seconds,fraction='']=text.split('.');return String(BigInt(seconds)*1000000n+BigInt(fraction.padEnd(6,'0')));}
  const match=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(text);
  if(!match)throw new Error('时间使用 UTC ISO 8601（Z）或 Unix 秒，最多六位小数');
  const seconds=Date.parse(match[1]+'Z');if(!Number.isFinite(seconds)||new Date(seconds).toISOString().slice(0,19)!==match[1])throw new Error('无效 UTC 时间');
  return String(BigInt(seconds)*1000n+BigInt((match[2]??'').padEnd(6,'0')));
}
export const microValue=(value,name)=>{if(typeof value!=='string'||!/^\d+$/.test(value)||BigInt(value)>4294967296000000n)throw new Error(`${name} 必须是 MRT 范围内的整数字符串微秒`);return BigInt(value);};
export function provider(identity){
  const [type,name,...rest]=identity.split(':');if(rest.length)throw new Error('采集器格式 ris:rrc23 或 rv:route-views.sfmix');
  if(type==='ris'&&/^rrc\d{2}$/.test(name))return {collector:`ris-${name}`,view:'default',step:300,docs:'https://ris.ripe.net/docs/mrt/',directories:month=>[`https://data.ris.ripe.net/${name}/${month}/`]};
  if(type==='rv'&&/^(route-views(?:[2-6]|\.[a-z0-9-]+)?)$/.test(name))return {collector:`rv-${name}`,view:'default',step:900,docs:'https://assets.routeviews.org/presos/RV_ThaiNOG_2023-2.pdf',directories:month=>['RIBS','UPDATES'].map(part=>`https://archive.routeviews.org/${name==='route-views'?'':name+'/'}bgpdata/${month}/${part}/`)};
  throw new Error('不支持的采集器，使用 ris:rrcNN 或 rv:route-views.sfmix');
}

// 发现层只读取提供方目录快照；文件名时点结合提供方归档周期，不能证明数据连续。
export async function discoverArchives(identities,from,to,{snapshots=null,fetcher=fetch,timeout=30000}={}){
  from=microValue(from,'from_us');to=microValue(to,'to_us');if(from>=to||to-from>31n*86400000000n)throw new Error('计划窗口须为正且不超过 31 天');
  const snapshotMap=new Map((snapshots??[]).map(item=>[item.url,item]));const metadata=[],collectors=[],unsatisfied=[];
  const first=new Date(Number(from/1000n)-2*86400000),last=new Date(Number((to-1n)/1000n));
  const months=[];for(let date=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),1));date<=last;date=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)))months.push(date.toISOString().slice(0,7).replace('-','.'));
  if(!identities.length||identities.length>16||new Set(identities).size!==identities.length)throw new Error('计划需要 1..16 个不同采集器');
  for(const identity of identities){const adapter=provider(identity),archives=[];
    for(const month of months)for(const url of adapter.directories(month)){
      let snapshot=snapshotMap.get(url);
      if(snapshot){if(hashText(snapshot.body)!==snapshot.sha256)throw new Error('元数据快照哈希不符');}
      else{if(snapshots)throw new Error(`离线元数据缺少 ${url}`);const response=await fetcher(url,{signal:AbortSignal.timeout(timeout)});if(!response.ok)throw new Error(`发现失败 ${response.status}: ${url}`);
        const reader=response.body.getReader();let body='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8388608){await reader.cancel();throw new Error('目录元数据超过 8 MiB');}body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();snapshot={url,body,sha256:hashText(body),etag:response.headers.get('etag'),last_modified:response.headers.get('last-modified')};}
      metadata.push(snapshot);
      for(const match of snapshot.body.matchAll(/href\s*=\s*["']((?:bview|rib|updates)\.(\d{8})\.(\d{4})\.(?:gz|bz2))["']/gi)){
        const [,name,day,clock]=match,time=Date.parse(`${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}T${clock.slice(0,2)}:${clock.slice(2)}:00Z`);if(!Number.isFinite(time))continue;
        const start=BigInt(time)*1000n,kind=name.startsWith('updates')?'update':'rib';
        archives.push({kind,url:new URL(name,url).href,path:`${adapter.collector}-${name}`,from_us:String(start),to_us:String(kind==='rib'?start:start+BigInt(adapter.step)*1000000n),metadata_sha256:snapshot.sha256,selection_basis:{listing_url:url,cadence_seconds:adapter.step,provider_documentation:adapter.docs,coverage:'nominal_archive_slot_not_verified_continuity'}});
      }
    }
    const unique=[...new Map(archives.map(item=>[item.url,item])).values()];const ribs=unique.filter(item=>item.kind==='rib'&&BigInt(item.from_us)<=from).sort((a,b)=>BigInt(a.from_us)<BigInt(b.from_us)?1:-1),rib=ribs[0];
    if(!rib){unsatisfied.push({collector:adapter.collector,reason:'no_rib_not_later_than_start'});collectors.push({collector:adapter.collector,view:adapter.view,continuous:false,files:[]});continue;}
    const files=[rib],available=new Map(unique.filter(item=>item.kind==='update').map(item=>[item.from_us,item]));
    for(let time=BigInt(rib.from_us);time<to;time+=BigInt(adapter.step)*1000000n){const item=available.get(String(time));if(item)files.push({...item,purpose:time<from?'warmup':'analysis'});else unsatisfied.push({collector:adapter.collector,reason:'missing_archive_slot',from_us:String(time),to_us:String(time+BigInt(adapter.step)*1000000n)});}
    collectors.push({collector:adapter.collector,view:adapter.view,continuous:false,files});
  }
  return {schema_version:'1.0',type:'archive_plan',window:{from_us:String(from),to_us:String(to)},status:unsatisfied.length?'partial':'planned',identities,collectors,unsatisfied,metadata_snapshots:metadata,coverage:'provider_nominal_slots_continuity_unverified'};
}
