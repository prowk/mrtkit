import {open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';

const MAX_PACKET=17825792;
const validIndex=value=>Number.isInteger(value)&&value>=0&&value<=65535;

// 临时二进制包只记录文件索引、原记录位置、原事件索引和完整的重编码 MRT 帧。
export function encodePacket({fileIndex,record,offset,indices,data}){
  record=BigInt(record);offset=BigInt(offset);
  if(!validIndex(fileIndex)||record<1n||record>9223372036854775807n||offset<0n||offset>9223372036854775807n||!Array.isArray(indices)||indices.length>65535||indices.some((value,i)=>!Number.isInteger(value)||value<0||value>2147483647||i>0&&value<=indices[i-1]))throw new Error('分区包来源位置无效');
  if(!Buffer.isBuffer(data))data=Buffer.from(data);
  const length=30+indices.length*4+data.length;if(length>MAX_PACKET||data.length<12||data.readUInt32BE(8)+12!==data.length)throw new Error('分区包 MRT 长度无效');
  const packet=Buffer.allocUnsafe(length);packet.writeUInt32BE(length-4,0);packet.writeUInt16BE(fileIndex,4);packet.writeBigUInt64BE(record,6);packet.writeBigUInt64BE(offset,14);packet.writeUInt32BE(indices.length,22);
  for(let i=0;i<indices.length;i++)packet.writeUInt32BE(indices[i],26+i*4);
  packet.writeUInt32BE(data.length,26+indices.length*4);data.copy(packet,30+indices.length*4);return packet;
}

function decodePacket(packet){
  const count=packet.readUInt32BE(22);if(count>65535||30+count*4>packet.length)throw new Error('分区包索引数量无效');
  const length=packet.readUInt32BE(26+count*4);if(30+count*4+length!==packet.length||length<12)throw new Error('分区包长度不一致');
  const indices=Array.from({length:count},(_,i)=>packet.readUInt32BE(26+i*4));
  const value={fileIndex:packet.readUInt16BE(4),record:packet.readBigUInt64BE(6),offset:packet.readBigUInt64BE(14),indices,data:packet.subarray(30+count*4)};
  if(value.record<1n||value.record>9223372036854775807n||value.offset>9223372036854775807n||indices.some((n,i)=>n>2147483647||i>0&&n<=indices[i-1])||value.data.readUInt32BE(8)+12!==value.data.length)throw new Error('分区包来源或 MRT 信封无效');
  return value;
}

export async function* packets(chunks,signal){
  let packet=Buffer.alloc(4),filled=0;
  for await(const chunk of chunks){let position=0;
    while(position<chunk.length){signal?.throwIfAborted();const take=Math.min(packet.length-filled,chunk.length-position);chunk.copy(packet,filled,position,position+take);filled+=take;position+=take;if(filled!==packet.length)continue;
      if(packet.length===4){const length=packet.readUInt32BE(0)+4;if(length<42||length>MAX_PACKET)throw new Error('分区包声明长度无效');const next=Buffer.allocUnsafe(length);packet.copy(next);packet=next;continue;}
      yield decodePacket(packet);packet=Buffer.alloc(4);filled=0;
    }
  }
  if(filled)throw new Error('分区包文件结束时截断');
}
export const packetFile=(path,signal)=>packets(createReadStream(path,{highWaterMark:65536}),signal);

// 二进制分区、变化流和状态流共用有界缓冲；分别记录写盘与哈希成本。
export class BufferedFile {
  static async create(path,{budget,append=false}={}){return new BufferedFile(await open(path,append?'a':'wx'),budget);}
  constructor(file,budget){this.file=file;this.budget=budget;this.buffers=[];this.buffered=0;this.bytes=0;this.hash=createHash('sha256');this.writeNs=0n;this.hashNs=0n;this.closed=false;}
  async write(data){if(this.closed)throw new Error('文件已关闭');const bytes=typeof data==='string'?Buffer.from(data,'utf8'):data;this.budget?.reserve(bytes.length);this.bytes+=bytes.length;
    const before=process.hrtime.bigint();this.hash.update(bytes);this.hashNs+=process.hrtime.bigint()-before;this.buffers.push(bytes);this.buffered+=bytes.length;if(this.buffered>=65536)await this.flush();}
  async flush(){if(!this.buffered)return;const data=Buffer.concat(this.buffers,this.buffered);this.buffers=[];this.buffered=0;const before=process.hrtime.bigint();await this.file.writeFile(data);this.writeNs+=process.hrtime.bigint()-before;}
  async close(){if(!this.closed){this.closed=true;try{await this.flush();}finally{await this.file.close();}}return {bytes:this.bytes,sha256:this.hash.copy().digest('hex'),write_seconds:Number(this.writeNs)/1e9,hash_seconds:Number(this.hashNs)/1e9};}
}

export const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function portable(value,labels){return Array.isArray(value)?value.map(row=>portable(row,labels)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,key==='file'&&value.record!==undefined&&value.offset!==undefined?(labels.get(child)??child):portable(child,labels)])):value;}
export function stateAccumulator(){let rows=0,sum=0n,xor=0n;const mask=(1n<<256n)-1n;
  return {add(value){const digest=BigInt('0x'+createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'));rows++;sum=(sum+digest)&mask;xor^=digest;},
    merge(value){rows+=value.rows;sum=(sum+BigInt('0x'+value.sha256_sum))&mask;xor^=BigInt('0x'+value.sha256_xor);},
    result(){return {rows,sha256_sum:sum.toString(16).padStart(64,'0'),sha256_xor:xor.toString(16).padStart(64,'0')};}};
}
