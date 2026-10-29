import {readFile,writeFile,mkdir,open,rename,stat,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname,join,basename} from 'node:path';
import {discoverArchives,utcMicros,microValue,hashText} from './archive-discovery.mjs';
import {bundlePath} from './bundle.mjs';
import {frames,inputChunks} from './input.mjs';

export async function fileHash(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export const jsonFile=async path=>JSON.parse(await readFile(path,'utf8'));
export async function saveJson(path,value){await writeFile(path,JSON.stringify(value,null,2)+'\n','utf8');}
export function argumentsMap(argv,allowed,{multiple=[]}={}){const result={};for(let i=0;i<argv.length;i++){const key=argv[i];if(!allowed.includes(key)||argv[i+1]===undefined||argv[i+1].startsWith('--'))throw new Error(`缺少值或未知选项: ${key}`);const value=argv[++i];if(multiple.includes(key))(result[key]??=[]).push(value);else{if(Object.hasOwn(result,key))throw new Error(`重复选项: ${key}`);result[key]=value;}}return result;}
export const positive=(value,fallback,max=Number.MAX_SAFE_INTEGER)=>{const number=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(number)||number<1||number>max)throw new Error('预算或数量必须为范围内正整数');return number;};

export function validatePlan(plan){
  if(plan.schema_version!=='1.0'||plan.type!=='archive_plan'||!Array.isArray(plan.collectors)||!plan.collectors.length||plan.collectors.length>128)throw new Error('需要 archive_plan 1.0');
  const from=microValue(plan.window?.from_us,'from_us'),to=microValue(plan.window?.to_us,'to_us');if(from>=to)throw new Error('窗口倒置');const scopes=new Set();
  let count=0;for(const point of plan.collectors){if(typeof point.collector!=='string'||!point.collector||typeof point.view!=='string'||!point.view||!Array.isArray(point.files))throw new Error('缺少观测点或文件');const scope=JSON.stringify([point.collector,point.view]);if(scopes.has(scope))throw new Error('重复观测点');scopes.add(scope);
    for(const file of point.files){count++;if(count>10000)throw new Error('档案计划超过 10000 文件');if(!['rib','update'].includes(file.kind)||typeof file.path!=='string'||!file.path||file.path.includes('\\')||file.path.startsWith('/')||file.path.split('/').some(part=>!part||part==='..')||/^[A-Za-z]:/.test(file.path))throw new Error('非法档案路径或类型');const start=microValue(file.from_us,'file.from_us'),end=microValue(file.to_us,'file.to_us');if(start>end||(file.kind==='update'&&start===end))throw new Error('档案区间无效');if(file.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('非法本地 SHA-256');if(file.source_sha256!==undefined&&file.source_sha256!==null&&!/^[a-f0-9]{64}$/.test(file.source_sha256))throw new Error('非法来源 SHA-256');}
  }return plan;
}

export async function planCommand(argv){const args=argumentsMap(argv,['--collector','--from','--to','--output','--metadata'],{multiple:['--collector']});if(!args['--from']||!args['--to']||!args['--output'])throw new Error('plan 需要 --collector --from --to --output');const snapshots=args['--metadata']?(await jsonFile(args['--metadata'])).metadata_snapshots:null;
  const plan=await discoverArchives(args['--collector']??[],utcMicros(args['--from']),utcMicros(args['--to']),{snapshots});await writeFile(args['--output'],JSON.stringify(plan,null,2)+'\n',{encoding:'utf8',flag:'wx'});return {status:plan.status,collectors:plan.collectors.length,files:plan.collectors.reduce((sum,p)=>sum+p.files.length,0),unsatisfied:plan.unsatisfied,plan_sha256:await fileHash(args['--output'])};}

export async function cachePlan(planPath,directory,{timeout=60000,retries=2,concurrency=2,maxBytes=2147483648,offline=false,fetcher=fetch}={}){
  const plan=validatePlan(await jsonFile(planPath));directory=resolve(directory);await mkdir(directory,{recursive:true});
  const manifestPath=join(directory,'manifest.json');let old=null;try{old=await jsonFile(manifestPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  const previous=new Map((old?.collectors??[]).flatMap(point=>point.files).map(file=>[file.path,file]));
  const output=structuredClone(plan);output.type='archive_plan';output.plan_sha256=await fileHash(planPath);output.status='cached';
  let used=0,next=0;const files=output.collectors.flatMap(point=>point.files),seen=new Set();
  for(const file of files){if(seen.has(file.path))throw new Error('缓存路径重复');seen.add(file.path);if(basename(file.path)!==file.path)throw new Error('下载缓存只接受平面文件标签');}
  const errors=[];
  async function worker(){for(;;){const file=files[next++];if(!file)return;const path=join(directory,file.path);try{
    let existing=null;try{existing=await stat(path);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing){const hash=await fileHash(path),expected=file.sha256??previous.get(file.path)?.sha256??file.source_sha256;if(!expected||hash!==expected)throw new Error(`缓存缺少可信本地记录或哈希不符: ${file.path}`);used+=existing.size;if(used>maxBytes)throw new Error('缓存超过磁盘预算');Object.assign(file,{sha256:hash,bytes:existing.size,source_sha256:file.source_sha256??null,hash_provenance:previous.get(file.path)?.hash_provenance??'local_first_download'});continue;}
    if(offline)throw new Error(`离线缓存缺失: ${file.path}`);if(typeof file.url!=='string'||!file.url.startsWith('https://'))throw new Error('下载需要 HTTPS 来源 URL');
    let failure;
    for(let attempt=0;attempt<=retries;attempt++){const temp=path+`.${randomUUID()}.partial`;let size=0;try{
      const response=await fetcher(file.url,{signal:AbortSignal.timeout(timeout)});if(!response.ok)throw new Error(`HTTP ${response.status}`);const stream=await open(temp,'wx'),hash=createHash('sha256');
      try{for await(const chunk of response.body){size+=chunk.length;used+=chunk.length;if(used>maxBytes)throw new Error('下载超过磁盘预算');hash.update(chunk);await stream.writeFile(chunk);}await stream.sync();}finally{await stream.close();}
      const expected=response.headers.get('content-length');if(expected!==null&&size!==Number(expected))throw new Error('下载长度不符');const sha256=hash.digest('hex');if(file.source_sha256&&sha256!==file.source_sha256)throw new Error('来源 SHA-256 不符');if(file.sha256&&sha256!==file.sha256)throw new Error('固定本地 SHA-256 不符');
      await rename(temp,path);Object.assign(file,{sha256,bytes:size,source_sha256:file.source_sha256??null,hash_provenance:file.source_sha256?'provider_and_local':'local_first_download',http_metadata:{etag:response.headers.get('etag'),last_modified:response.headers.get('last-modified')}});failure=null;break;
    }catch(error){failure=error;used-=size;await rm(temp,{force:true});if(attempt<retries)await new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**attempt,5000)));}}
    if(failure)throw failure;
  }catch(error){errors.push({file:file.path,error:error.message});}}}
  await Promise.all(Array.from({length:concurrency},worker));
  output.status=errors.length?'partial':'cached';output.cache_errors=errors;
  const temporary=manifestPath+'.'+randomUUID()+'.partial';await saveJson(temporary,output);await rename(temporary,manifestPath);
  return {status:output.status,manifest:manifestPath,sha256:await fileHash(manifestPath),bytes:used,errors};
}

export async function cacheCommand(argv){const args=argumentsMap(argv,['--plan','--directory','--timeout-ms','--retries','--concurrency','--max-bytes','--offline']);if(!args['--plan']||!args['--directory'])throw new Error('cache 需要 --plan --directory');if(args['--offline']&&!['true','false'].includes(args['--offline']))throw new Error('--offline 使用 true/false');return cachePlan(args['--plan'],args['--directory'],{timeout:positive(args['--timeout-ms'],60000,300000),retries:positive(args['--retries'],3,6)-1,concurrency:positive(args['--concurrency'],2,8),maxBytes:positive(args['--max-bytes'],2147483648),offline:args['--offline']==='true'});}

// 元数据检查不会把无路由更新的安静期当作缺档；完整检查才读到解压流 EOF。
export async function qualityCheck(manifestPath,{full=false}={}){
  const plan=validatePlan(await jsonFile(manifestPath)),diagnostics=[],files=[];const add=(code,severity,point,file,extra={})=>diagnostics.push({code,severity,collector:point.collector,view:point.view,file:file?.path??null,...extra});
  const root=dirname(resolve(manifestPath));
  for(const point of plan.collectors){let rib=null,covered=null;const identities=new Set();const updates=point.files.filter(file=>file.kind==='update').sort((a,b)=>BigInt(a.from_us)<BigInt(b.from_us)?-1:1);
    for(const file of point.files){if(file.kind==='rib'){if(rib)add('multiple_baselines','blocking',point,file);rib=file;if(BigInt(file.from_us)>BigInt(plan.window.from_us))add('baseline_too_late','blocking',point,file);}const identity=file.url??file.path;if(identities.has(identity))add('duplicate_archive','blocking',point,file);identities.add(identity);
      let path;try{path=await bundlePath(root,file.path);}catch(error){add('missing_or_unsafe_file','blocking',point,file,{message:error.message});continue;}
      const metadata={file:file.path,sha256:null,records:null,eof:false};files.push(metadata);
      if(!file.sha256)add('missing_fixed_hash','blocking',point,file);else{metadata.sha256=await fileHash(path);if(metadata.sha256!==file.sha256)add('hash_mismatch','blocking',point,file);}
      if(file.bytes!==undefined&&(await stat(path)).size!==file.bytes)add('size_mismatch','blocking',point,file);
      if(full){try{const bridge=await import(new URL('../_build/js/release/build/bridge/bridge.js',import.meta.url));const config={mode:'parse',format:'json',from_time:0,to_time:4294967295,window_seconds:60,threshold:10,capacity:1,collector:point.collector,view:point.view};const configured=JSON.parse(bridge.configure(JSON.stringify(config)));if(configured.error)throw new Error(configured.error);let count=0,peers=0;
          for await(const frame of frames(inputChunks(path))){count++;const kind=frame.data.readUInt16BE(4),subtype=frame.data.readUInt16BE(6),time=BigInt(frame.data.readUInt32BE(0))*1000000n;
            if(file.kind==='rib'&&kind!==13||file.kind==='update'&&kind===13)add('type_conflict','blocking',point,file,{record:count});if(kind===13&&subtype===1)peers++;
            if(file.kind==='update'&&(time<BigInt(file.from_us)||time>=BigInt(file.to_us)))add('record_outside_declared_slot','quality',point,file,{record:count});
            const decoded=JSON.parse(bridge.decode_record(frame.data,file.path,BigInt(count),BigInt(frame.offset)));if(decoded.error)throw new Error(decoded.error);
          }metadata.records=count;metadata.eof=true;if(file.kind==='rib'&&peers!==1)add('invalid_baseline_peer_table','blocking',point,file);
        }catch(error){add('invalid_or_truncated_mrt','blocking',point,file,{message:error.message});}}
    }
    if(!rib)add('baseline_missing','quality',point,null);covered=rib?BigInt(rib.from_us):updates.length&&BigInt(updates[0].from_us)<BigInt(plan.window.from_us)?BigInt(updates[0].from_us):BigInt(plan.window.from_us);
    for(const file of updates){const start=BigInt(file.from_us),end=BigInt(file.to_us);if(start>covered)add('declared_gap','quality',point,file,{from_us:String(covered),to_us:String(start)});if(start<covered)add('declared_overlap','blocking',point,file);if(end>covered)covered=end;}
    if(covered<BigInt(plan.window.to_us))add('declared_gap','quality',point,null,{from_us:String(covered),to_us:plan.window.to_us});
    if(point.continuous!==true)add('continuity_unverified','quality',point,null);
  }
  return {schema_version:'1.0',type:'input_quality',mode:full?'full_eof':'metadata_and_hash',status:diagnostics.some(item=>item.severity==='blocking')?'blocked':diagnostics.length?'partial':'ready',manifest_sha256:await fileHash(manifestPath),diagnostics,files};
}
export async function qualityCommand(argv){const args=argumentsMap(argv,['--manifest','--mode','--output']);if(!args['--manifest']||args['--mode']&&!['quick','full'].includes(args['--mode']))throw new Error('check-input 需要 --manifest，--mode quick/full');const result=await qualityCheck(args['--manifest'],{full:args['--mode']==='full'});if(args['--output'])await saveJson(args['--output'],result);return result;}
