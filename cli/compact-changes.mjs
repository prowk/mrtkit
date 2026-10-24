import {createHash} from 'node:crypto';
import {jsonLines} from './bundle.mjs';
import {BufferedFile,canonical} from './disk-storage.mjs';

export const changeEncodings=['full_jsonl_v1','event_refs_v1'];
const idFor=value=>'ctx-'+createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

// 每行自包含，引用只在当前上下文行内有效，不保存随输入增长的全局字典。
export function expandContext(row){
  if(row?.schema_version!=='2.0'||row.type!=='compact_change_context'||row.encoding!=='event_refs_v1'||!object(row.context)||!object(row.context.value)||row.context.value.schema_version!=='2.0'||typeof row.context.id!=='string'||row.context.id!==idFor(row.context.value))throw new Error('紧凑上下文版本、内容或标识冲突');
  if(['kind','churn_count','correlation_key'].some(key=>Object.hasOwn(row.context.value,key)))throw new Error('公共上下文包含提醒专属字段');
  if(!Array.isArray(row.notices)||!row.notices.length||row.notices.length>4)throw new Error('紧凑上下文提醒数量无效');
  const kinds=new Set();
  return row.notices.map(notice=>{
    if(!object(notice)||notice.context!==row.context.id||typeof notice.kind!=='string'||Object.keys(notice).some(key=>!['context','kind','churn_count','correlation_key'].includes(key))||kinds.has(notice.kind))throw new Error('紧凑提醒存在缺失、冲突引用或重复类型');
    kinds.add(notice.kind);const {context,...fields}=notice;return {...row.context.value,...fields};
  });
}

export async function* readChanges(path,encoding='full_jsonl_v1',{stats}={}){
  if(!changeEncodings.includes(encoding))throw new Error('不支持的变化编码');
  for await(const row of jsonLines(path)){if(encoding==='event_refs_v1'){if(stats)stats.contexts=(stats.contexts??0)+1;yield* expandContext(row);}else yield row;}
}

export class ChangeEncoder {
  constructor(write,{encoding='full_jsonl_v1'}={}){if(!changeEncodings.includes(encoding))throw new Error('不支持的变化编码');this.write=write;this.encoding=encoding;this.current=null;this.notices=0;this.contexts=0;this.closed=false;}
  async push(change){
    if(this.closed)throw new Error('变化编码器已关闭');if(change?.schema_version!=='2.0'||typeof change.kind!=='string')throw new Error('变化编码需要完整 2.0 提醒');
    this.notices++;
    if(this.encoding==='full_jsonl_v1'){await this.write(JSON.stringify(change)+'\n');return;}
    const {kind,churn_count,correlation_key,...value}=change,id=idFor(value);
    if(this.current&&(this.current.context.id!==id||this.current.notices.some(notice=>notice.kind===kind)||this.current.notices.length>=4))await this.flush();
    if(!this.current)this.current={schema_version:'2.0',type:'compact_change_context',encoding:'event_refs_v1',context:{id,value},notices:[]};
    this.current.notices.push({context:id,kind,...(churn_count===undefined?{}:{churn_count}),...(correlation_key===undefined?{}:{correlation_key})});
  }
  async pushLines(lines){if(!lines.length)return;if(this.closed)throw new Error('变化编码器已关闭');if(this.encoding==='full_jsonl_v1'){this.notices+=lines.length;await this.write(lines.join('\n')+'\n');}else for(const line of lines)await this.push(JSON.parse(line));}
  async flush(){if(this.current){const row=this.current;this.current=null;await this.write(JSON.stringify(row)+'\n');this.contexts++;}}
  async close(){if(!this.closed){await this.flush();this.closed=true;}return {encoding:this.encoding,notices:this.notices,contexts:this.contexts};}
}

export async function changeFileWriter(path,options={}){
  const file=await BufferedFile.create(path,options),encoder=new ChangeEncoder(text=>file.write(text),options);
  return {push:row=>encoder.push(row),pushLines:lines=>encoder.pushLines(lines),async close(){const counts=await encoder.close(),output=await file.close();return {...counts,...output};}};
}
