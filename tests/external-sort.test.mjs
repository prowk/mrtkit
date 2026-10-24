import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {externalSort,DiskBudget} from '../cli/external-sort.mjs';

test('外部排序多轮归并与内存排序一致，预算记账及清理确定',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mrtkit-sort-'));
  try{
    const rows=Array.from({length:7000},(_,i)=>({key:(i*1543)%997,ordinal:i,payload:'路由'.repeat(20)})),compare=(a,b)=>a.key-b.key||a.ordinal-b.ordinal;
    const budget=new DiskBudget(10000000);
    const actual=await Array.fromAsync(externalSort(rows,{directory,compare,memoryBytes:65536,fanIn:3,budget}));
    assert.deepEqual(actual,[...rows].sort(compare));assert.ok(budget.peak>100000);assert.equal(budget.used,0);assert.deepEqual(await readdir(directory),[]);
    await assert.rejects(async()=>Array.fromAsync(externalSort(rows,{directory,compare,memoryBytes:65536,budget:new DiskBudget(1000)})),/磁盘预算/);
    assert.deepEqual(await readdir(directory),[]);
    const controller=new AbortController();
    async function* cancelled(){for(let i=0;i<rows.length;i++){if(i===600)controller.abort();yield rows[i];}}
    const cancelledBudget=new DiskBudget(10000000);
    await assert.rejects(async()=>Array.fromAsync(externalSort(cancelled(),{directory,compare,memoryBytes:65536,budget:cancelledBudget,signal:controller.signal})),/abort/i);
    assert.deepEqual(await readdir(directory),[]);assert.equal(cancelledBudget.used,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
