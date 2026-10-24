import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const safeJson=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
export const sourceId=source=>source?'source-'+createHash('sha256').update(JSON.stringify([source.collector,source.view,source.file,source.record,source.offset,source.event_index])).digest('hex'):'';
const pack=values=>{const bytes=[];let previous=0;for(const value of values){let delta=value-previous;previous=value;while(delta>=128){bytes.push((delta%128)|128);delta=Math.floor(delta/128);}bytes.push(delta);}return Buffer.from(bytes).toString('base64');};

// 数据页和筛选倒排索引分别分块；筛选不读取包含属性与来源的原始数据页。
export async function reportDataset(directory,name,{pageSize=200,indexSize=8192}={}){
  await mkdir(join(directory,name));
  const data={name,rows:0,pages:[],indexes:[],kinds:[]},knownKinds=new Set();let rows=[],bytes=0,indexRows=0,indexStart=0,postings={};
  async function flushPage(){if(!rows.length)return;const id=data.pages.length,file=`${name}/page-${String(id).padStart(6,'0')}.js`,start=data.rows-rows.length;
    await writeFile(join(directory,file),`globalThis.MRTKitReceive(${safeJson(name)},"page",${id},JSON.parse(${safeJson(JSON.stringify(rows))}));\n`,'utf8');
    data.pages.push({id,file,start,rows:rows.length});rows=[];bytes=0;
  }
  async function flushIndex(){if(!indexRows)return;const id=data.indexes.length,file=`${name}/index-${String(id).padStart(6,'0')}.js`,packed=Object.fromEntries(Object.entries(postings).map(([field,values])=>[field,Object.fromEntries(Object.entries(values).map(([value,ids])=>[value,pack(ids)]))]));
    await writeFile(join(directory,file),`globalThis.MRTKitReceive(${safeJson(name)},"index",${id},JSON.parse(${safeJson(JSON.stringify(packed))}));\n`,'utf8');
    data.indexes.push({id,file,start:indexStart,rows:indexRows});indexStart+=indexRows;indexRows=0;postings={};
  }
  return {data,async add(row){const size=Buffer.byteLength(JSON.stringify(row));if(size>16777216)throw new Error('报告单条明细超过 16 MiB');if(rows.length&&(rows.length>=pageSize||bytes+size>1048576))await flushPage();
    const fields={collector:[JSON.stringify([row.collector,row.view])],prefix:[row.prefix??''],peer:[String(row.peer_asn??''),row.peer_ip??''],kind:[row.kind,...(row.changes??[]).map(change=>change.kind)].filter(Boolean),source:[row.event_source_id??sourceId(row.source)],group:[row.group_id??row.id??'']};
    for(const [field,values]of Object.entries(fields))for(const value of new Set(values)){if(!value)continue;const map=postings[field]??=Object.create(null);(map[value]??=[]).push(indexRows);if(field==='kind')knownKinds.add(value);}
    rows.push(row);bytes+=size;data.rows++;indexRows++;if(indexRows>=indexSize)await flushIndex();
  },async close(){await flushPage();await flushIndex();data.kinds=[...knownKinds].sort();return data;}};
}
