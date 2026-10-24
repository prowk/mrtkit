import {readFile,stat,mkdtemp,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname,join,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {bundlePath,jsonLines} from './bundle.mjs';
import {canonical,validateSource,validateTimestamp,pointId} from './validation.mjs';
import {externalSort,jsonlWriter,DiskBudget} from './external-sort.mjs';
import {sourceId} from './report-data.mjs';

const digest=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

// 校验关联包和原结果包的绑定，外部排序检查所有分组引用和逐组计数。
export async function reportCorrelation(input,replayInput,replay,output,groups,observations){
  if((await stat(input)).size>16777216)throw new Error('关联索引超过 16 MiB');
  const index=JSON.parse(await readFile(input,'utf8')),directory=dirname(input);
  if(index.schema_version!=='2.0'||index.type!=='cross_collector_correlation_bundle'||index.status!=='complete')throw new Error('报告需要完整的分离式关联结果包');
  if(index.input_bundle_sha256!==await digest(replayInput)||!same(index.window,replay.window)||index.input_status!==replay.status)throw new Error('关联包与回放输入不一致');
  const points=new Map(replay.collectors.map(point=>[pointId(point),point]));
  if(!Array.isArray(index.legacy_header?.points)||index.legacy_header.points.length!==points.size||index.legacy_header.points.some(point=>!points.has(pointId(point))))throw new Error('关联观测点与回放输入不一致');
  for(const kind of ['groups','observations']){const file=await bundlePath(directory,index[kind+'_file']);if(await digest(file)!==index[kind+'_sha256'])throw new Error('关联明细哈希不一致');if((await stat(file)).size!==index[kind+'_bytes'])throw new Error('关联明细字节计数不一致');}
  const scratch=await mkdtemp(join(output,'.correlation-check-')),budget=new DiskBudget(4294967296),path=join(scratch,'refs.jsonl'),writer=await jsonlWriter(path,{budget});let groupCount=0,observationCount=0;
  try{
    for await(const row of jsonLines(await bundlePath(directory,index.groups_file))){
      if(!/^group-[0-9a-f]{64}$/.test(row.id??'')||!Number.isSafeInteger(row.observation_count)||row.observation_count<1||!Array.isArray(row.unobserved))throw new Error('关联分组无效');
      await groups.add(row);await writer.write({id:row.id,expected:row.observation_count});groupCount++;
    }
    for await(const row of jsonLines(await bundlePath(directory,index.observations_file))){const event=row.observation,point=points.get(pointId(event));if(!point)throw new Error('关联观测身份无效');validateSource(event.source,point);
      if(!/^(0|[1-9]\d*)$/.test(event.observed_at??''))throw new Error('关联观测时间无效');const at=BigInt(event.observed_at);if(at>4294967295999999n)throw new Error('关联观测时间越界');
      const timestamp=Number(at/1000000n),microseconds=Number(at%1000000n);validateTimestamp({timestamp,microseconds},replay.window);
      await observations.add({...event,event_source_id:sourceId(event.source),group_id:row.group_id,timestamp,microseconds});await writer.write({id:row.group_id});observationCount++;
    }
    await writer.close();let id=null,expected=null,count=0;
    const check=()=>{if(id!==null&&(expected===null||expected!==count))throw new Error('关联分组引用或逐组计数不一致');};
    for await(const row of externalSort(jsonLines(path),{directory:scratch,memoryBytes:16777216,budget,compare:(a,b)=>a.id<b.id?-1:a.id>b.id?1:0})){
      if(row.id!==id){check();id=row.id;expected=null;count=0;}if(row.expected!==undefined){if(expected!==null)throw new Error('关联组标识重复');expected=row.expected;}else count++;
    }check();
    if(groupCount!==index.groups||observationCount!==index.unique_observations)throw new Error('关联总计数不一致');
    return {groups:groupCount,observations:observationCount,duplicates:index.duplicates,interpretation:index.legacy_header.interpretation,points:index.legacy_header.points};
  }finally{await writer.close();const part=relative(output,scratch);if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new Error('拒绝清理越界报告临时目录');await rm(scratch,{recursive:true,force:true});}
}
