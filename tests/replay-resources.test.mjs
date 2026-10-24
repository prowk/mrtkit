import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayRss} from '../cli/replay-resources.mjs';

test('串行 peer 并发峰值与后续父进程独占峰值取最大，不跨阶段相加',()=>{
  const rss=new ReplayRss();assert.equal(rss.completePeer(100,1600),1700);assert.equal(rss.completePeer(150,1200),1700);
  assert.equal(rss.result(700).peak_rss_upper_bound_bytes,1700);assert.equal(rss.result(1900).peak_rss_upper_bound_bytes,1900);
  assert.equal(rss.completePeer(1900,300),2200);assert.equal(rss.result(2000).peak_rss_upper_bound_bytes,2200);
  assert.throws(()=>rss.completePeer(-1,100),/无效/);assert.throws(()=>rss.result(NaN),/无效/);
});
