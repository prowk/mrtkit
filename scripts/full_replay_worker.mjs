import {readFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {replayDisk} from '../cli/disk-replay.mjs';

const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const start=process.hrtime.bigint();
try{
  const result=await replayDisk(config.manifest,config.output,{rssBytes:config.rss_bytes,diskBytes:config.disk_bytes,memoryBytes:67108864,keepPartitions:config.keep_partitions,secondsBudget:config.seconds,
    onProgress:row=>process.stderr.write(JSON.stringify({iteration:config.iteration,...row})+'\n')});
  const index=JSON.parse(await readFile(result.index,'utf8'));
  async function size(directory){let bytes=0;for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('验收输出不允许符号链接');const path=join(directory,entry.name);bytes+=entry.isDirectory()?await size(path):(await stat(path)).size;}return bytes;}
  console.log(JSON.stringify({complete:true,iteration:config.iteration,point:index.collectors[0],output_directory_bytes:await size(config.output),elapsed_seconds:Number(process.hrtime.bigint()-start)/1e9}));
}catch(error){let partial=null;try{partial=JSON.parse(await readFile(join(config.output,'index.json'),'utf8')).collectors[0];}catch{}
  console.log(JSON.stringify({complete:false,iteration:config.iteration,error:error.message,partial_point:partial,elapsed_seconds:Number(process.hrtime.bigint()-start)/1e9}));process.exitCode=2;}
