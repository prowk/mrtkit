import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {jsonLines} from '../cli/bundle.mjs';

test('结果包 JSONL 跨块保留 UTF-8 中文，拒绝非法字节及超长末行',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mrtkit-jsonl-'));
  try{
    const file=join(directory,'lines.jsonl'),value='中'.repeat(22000);
    await writeFile(file,JSON.stringify({value})+'\n'+JSON.stringify({value:'末行'}),'utf8');
    assert.deepEqual(await Array.fromAsync(jsonLines(file)),[{value},{value:'末行'}]);
    await writeFile(file,Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]));
    await assert.rejects(async()=>Array.fromAsync(jsonLines(file)),/encoded|encoding|UTF/i);
    await writeFile(file,JSON.stringify({value:'中文'}),'utf8');
    await assert.rejects(async()=>Array.fromAsync(jsonLines(file,10)),/超限/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
