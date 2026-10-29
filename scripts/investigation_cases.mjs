import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {demo,bgpUpdate,attributes,attr,mrt,cat,u16,u32} from './fixtures.mjs';
import {saveJson,fileHash} from '../cli/archive.mjs';

// 精选人工案例固定时间、路径和字节；绝不改写真实案例为人工多采集器。
export async function syntheticCase(directory){await mkdir(directory,{recursive:false});const time=1700001000,prefix=Buffer.from([24,203,0,113]),child=Buffer.from([25,203,0,113,0]);let cut=0;const data=demo();for(let i=0;i<2;i++)cut+=12+data.readUInt32BE(cut+8);const rib=Buffer.from(data.subarray(0,cut));let at=0;while(at<rib.length){rib.writeUInt32BE(time,at);at+=12+rib.readUInt32BE(at+8);}
  function addpath(id,withdraw,offset,afi=1){const nlri=cat(u32(id),afi===1?prefix:Buffer.from('2020010db8','hex'));let announced=Buffer.alloc(0),withdrawn=Buffer.alloc(0),attrs=withdraw?Buffer.alloc(0):attributes([64512,65536]);if(afi===1){if(withdraw)withdrawn=nlri;else announced=nlri;}else attrs=cat(attrs,attr(withdraw?15:14,withdraw?cat(u16(2),Buffer.from([1]),nlri):cat(u16(2),Buffer.from([1,16]),Buffer.from('20010db8000000000000000000000001','hex'),Buffer.from([0]),nlri),128));const body=cat(u16(withdrawn.length),withdrawn,u16(attrs.length),attrs,announced),message=cat(Buffer.alloc(16,255),u16(19+body.length),Buffer.from([2]),body);return mrt(17,9,cat(u32(id*100+1),u32(64512),u32(64513),u16(0),u16(1),Buffer.from([192,0,2,1,192,0,2,2]),message),time+offset);}
  const set=cat(attr(1,Buffer.from([0])),attr(2,cat(Buffer.from([1,2]),u32(65536),u32(65537))),attr(3,Buffer.from([192,0,2,1])));
  const long=attributes([64512,...Array.from({length:32},(_,i)=>64520+i),65536]);
  const files={'initial.mrt':rib,'a.mrt':cat(bgpUpdate(prefix,undefined,attributes([64512,65536]),time+1),bgpUpdate(child,undefined,attributes([64512,65536]),time+2),addpath(0,false,3),addpath(7,false,3),addpath(0,true,4),addpath(1,false,5,2),bgpUpdate(prefix,undefined,set,time+6),bgpUpdate(prefix,undefined,long,time+7),bgpUpdate(undefined,prefix,undefined,time+8),bgpUpdate(prefix,undefined,attributes([64512,65536]),time+9),bgpUpdate(prefix,undefined,attributes([64512,65536]),time+12)),
    'b.mrt':cat(bgpUpdate(prefix,undefined,attributes([64512,65537]),time+1),bgpUpdate(prefix,undefined,attributes([64512,65538]),time+2),bgpUpdate(undefined,prefix,undefined,time+5),bgpUpdate(prefix,undefined,attributes([64512,65536]),time+6))};
  for(const [name,bytes]of Object.entries(files))await writeFile(join(directory,name),bytes);
  const entry=async(path,kind)=>({path,kind,from_us:String(BigInt(time)*1000000n),to_us:String(BigInt(time+(kind==='rib'?0:15))*1000000n),sha256:await fileHash(join(directory,path))});
  const plan={schema_version:'1.0',type:'archive_plan',case_kind:'synthetic_multi_collector',window:{from_us:String(BigInt(time+1)*1000000n),to_us:String(BigInt(time+15)*1000000n)},collectors:[]};
  for(const name of ['a','b'])plan.collectors.push({collector:'synthetic-'+name,view:'default',continuous:false,files:[await entry('initial.mrt','rib'),await entry(name+'.mrt','update')]});
  const rules={schema_version:'1.0',version:'synthetic-cases-1',...plan.window,bucket_us:'2000000',incident_us:'4000000',capacity:20000,max_bytes:67108864,continuous:false,
    focus:[{prefix:'203.0.113.0/24',expected_origins:[65536],allowed_more_specifics:['203.0.113.0/25']},{prefix:'2001:db8::/32',expected_origins:[65536]}],
    gaps:[{from_us:String(BigInt(time+10)*1000000n),to_us:String(BigInt(time+11)*1000000n)}],sequence_prefix:'203.0.113.0/24',comparison:[{from_us:plan.window.from_us,to_us:String(BigInt(time+8)*1000000n)},{from_us:String(BigInt(time+8)*1000000n),to_us:plan.window.to_us}]};
  await saveJson(join(directory,'manifest.json'),plan);await saveJson(join(directory,'rules.json'),rules);return {manifest:join(directory,'manifest.json'),rules:join(directory,'rules.json')};
}

export async function realCase(directory){await mkdir(directory,{recursive:false});const spec=JSON.parse(await readFile(new URL('../cases/rrc23-path-change/case.json',import.meta.url),'utf8')),mapping=JSON.parse(await readFile(new URL('../cases/rrc23-path-change/excerpt-map.json',import.meta.url),'utf8'));await cp(new URL('../cases/rrc23-path-change/excerpt.mrt',import.meta.url),join(directory,'excerpt.mrt'));
  if(await fileHash(join(directory,'excerpt.mrt'))!==mapping.sha256)throw new Error('真实摘录哈希与侧表不符');
  const window={from_us:String(BigInt(spec.window.from)*1000000n),to_us:String(BigInt(spec.window.to+1)*1000000n)},plan={schema_version:'1.0',type:'archive_plan',case_kind:'real_single_collector_excerpt',window,collectors:[{collector:spec.collector,view:spec.view,continuous:false,files:[{path:'excerpt.mrt',kind:'update',from_us:String(BigInt(spec.window.from-300)*1000000n),to_us:window.to_us,sha256:mapping.sha256,source_map:mapping.records,original_sources:spec.sources,scope:mapping.scope}]}]};
  const rules={schema_version:'1.0',version:'rrc23-excerpt-1',...window,bucket_us:'60000000',scope_prefixes:[spec.prefix],scope_peer_asns:[spec.peer_asn],sequence_prefix:spec.prefix,continuous:false,focus:[{prefix:spec.prefix}],capacity:20000,max_bytes:67108864};await saveJson(join(directory,'manifest.json'),plan);await saveJson(join(directory,'rules.json'),rules);return {manifest:join(directory,'manifest.json'),rules:join(directory,'rules.json')};
}
