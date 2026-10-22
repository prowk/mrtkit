import {createReadStream} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

// 结果包只允许读取自身目录中的明细，包含符号链接时也检查实际目标。
export async function bundlePath(directory,name){
  if(typeof name!=='string'||!name)throw new Error('结果包缺少明细路径');
  const root=await realpath(directory),path=await realpath(resolve(root,name)),part=relative(root,path);
  if(isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw new Error('结果包明细路径越出包目录');
  return path;
}

export async function* jsonLines(path,maxBytes=16777216){
  const decoder=new StringDecoder('utf8');let pending='',ordinal=0;
  for await(const chunk of createReadStream(path)){
    pending+=decoder.write(chunk);
    for(;;){const end=pending.indexOf('\n');if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);ordinal++;
      if(Buffer.byteLength(line)>maxBytes)throw new Error(`JSONL 第 ${ordinal} 行超限`);
      if(line.trim()){try{yield JSON.parse(line);}catch(error){throw new Error(`${path} 第 ${ordinal} 行: ${error.message}`);}}
    }
    if(Buffer.byteLength(pending)>maxBytes)throw new Error(`JSONL 第 ${ordinal+1} 行超限`);
  }
  pending+=decoder.end();
  if(pending.trim()){try{yield JSON.parse(pending);}catch(error){throw new Error(`${path} 第 ${ordinal+1} 行: ${error.message}`);}}
}
