import {mkdir,mkdtemp,open,unlink,rm,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {jsonLines} from './bundle.mjs';

export class DiskBudget {
  constructor(limit){if(!Number.isSafeInteger(limit)||limit<1)throw new Error('磁盘预算无效');this.limit=limit;this.used=0;this.peak=0;}
  reserve(bytes){if(this.used+bytes>this.limit)throw Object.assign(new Error('临时文件和输出超过磁盘预算'),{code:'DISK_BUDGET'});this.used+=bytes;this.peak=Math.max(this.peak,this.used);}
  release(bytes){this.used-=bytes;if(this.used<0)throw new Error('磁盘预算记账不一致');}
}

// 输出和排序临时文件共用预算，最多缓存 64 KiB，错误时仍关闭文件。
export async function jsonlWriter(path,{budget,signal}={}){
  const file=await open(path,'wx'),hash=createHash('sha256');let buffer=[],buffered=0,bytes=0,rows=0,closed=false;
  const flush=async()=>{if(buffered){const text=buffer.join('');buffer=[];buffered=0;await file.writeFile(text,'utf8');}};
  return {
    async write(value){signal?.throwIfAborted();if(closed)throw new Error('输出已经关闭');const text=JSON.stringify(value)+'\n',length=Buffer.byteLength(text);budget?.reserve(length);bytes+=length;rows++;hash.update(text);buffer.push(text);buffered+=length;if(buffered>=65536)await flush();},
    async close(){if(!closed){closed=true;try{await flush();}finally{await file.close();}}return {bytes,rows,sha256:hash.copy().digest('hex')};},
    get bytes(){return bytes;},get rows(){return rows;},
  };
}

async function* merge(paths,compare,signal){
  const iterators=paths.map(path=>jsonLines(path)[Symbol.asyncIterator]()),heads=[];
  try{
    for(const iterator of iterators)heads.push(await iterator.next());
    for(;;){signal?.throwIfAborted();let smallest=-1;
      for(let i=0;i<heads.length;i++)if(!heads[i].done&&(smallest<0||compare(heads[i].value,heads[smallest].value)<0))smallest=i;
      if(smallest<0)return;yield heads[smallest].value;heads[smallest]=await iterators[smallest].next();
    }
  }finally{for(const iterator of iterators)await iterator.return?.();}
}

// 有界排序运行和有界扇入归并；不随总行数保存对象或文件句柄。
export async function* externalSort(input,{directory,compare,memoryBytes=67108864,budget=new DiskBudget(8589934592),signal,fanIn=16}={}){
  if(typeof compare!=='function'||!Number.isSafeInteger(memoryBytes)||memoryBytes<65536||!Number.isInteger(fanIn)||fanIn<2||fanIn>64)throw new Error('外部排序参数无效');
  const parent=await realpath(directory),owned=await mkdtemp(join(parent,'sort-'));
  const pending=new Map();let generation=0,buffer=[],bufferBytes=0;
  const maxPayload=Math.floor(memoryBytes/4);
  async function writeRun(values){
    if(!Number.isSafeInteger(generation+1))throw new Error('排序运行数量超出范围');
    const path=join(owned,`run-${generation++}.jsonl`),writer=await jsonlWriter(path,{budget,signal});
    try{for await(const value of values)await writer.write(value);}finally{try{await writer.close();}finally{pending.set(path,writer.bytes);}}
    return path;
  }
  const remove=async path=>{await unlink(path);budget.release(pending.get(path));pending.delete(path);};
  const levels=[];
  async function addRun(path,level=0){
    if(level>53)throw new Error('外部排序层数超出安全范围');
    const runs=levels[level]??(levels[level]=[]);runs.push(path);
    if(runs.length===fanIn){const group=runs.splice(0),merged=await writeRun(merge(group,compare,signal));for(const old of group)await remove(old);await addRun(merged,level+1);}
  }
  try{
    for await(const row of input){signal?.throwIfAborted();const bytes=Buffer.byteLength(JSON.stringify(row));
      if(bytes>maxPayload)throw new Error('单条排序数据超过内存预算的四分之一');
      if(buffer.length&&bufferBytes+bytes>maxPayload){buffer.sort(compare);await addRun(await writeRun(buffer));buffer=[];bufferBytes=0;}
      buffer.push(row);bufferBytes+=bytes;
    }
    if(buffer.length){buffer.sort(compare);await addRun(await writeRun(buffer));buffer=[];}
    let runs=levels.flat();
    while(runs.length>fanIn){const next=[];
      for(let i=0;i<runs.length;i+=fanIn){const group=runs.slice(i,i+fanIn),path=await writeRun(merge(group,compare,signal));next.push(path);for(const old of group)await remove(old);}
      runs=next;
    }
    yield* merge(runs,compare,signal);
  }finally{
    // 只清理本次创建且经过边界检查的目录，绝不递归删除调用方目录。
    const absolute=resolve(owned),part=relative(parent,absolute);
    if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new Error('拒绝清理越界临时目录');
    await rm(absolute,{recursive:true,force:true});for(const bytes of pending.values())budget.release(bytes);
  }
}
