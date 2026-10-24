import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';
import {mrt,cat,u16,u32,attr,attributes,bgpUpdate} from '../scripts/fixtures.mjs';

const configure=()=>assert.deepEqual(JSON.parse(bridge.configure(JSON.stringify({mode:'parse',format:'json',from_time:0,to_time:4294967295,window_seconds:60,threshold:3,capacity:100}))),{});
const checked=text=>{const value=JSON.parse(text);assert.equal(value.error,undefined,value.error);return value;};
const peers=mrt(13,1,cat(u32(0),u16(0),u16(2),...[[1,64512],[3,64512]].map(([address,asn])=>cat(Buffer.from([2]),u32(address),Buffer.from([192,0,2,address]),u32(asn)))),100);

test('IPv4/IPv6 及 ADD-PATH RIB 分区逐字节保留条目并恢复原始事件索引',()=>{
  for(const subtype of [2,4,8,10]){
    const v6=[4,10].includes(subtype),addpath=subtype>=8;
    const prefix=v6?Buffer.from([32,0x20,1,0x0d,0xb8]):Buffer.from([24,203,0,113]);
    const attrs=cat(attributes([64512,65536]),...(v6?[attr(14,cat(Buffer.from([16]),Buffer.from('20010db8000000000000000000000001','hex')),0x80)]:[]));
    const record=mrt(13,subtype,cat(u32(7),prefix,u16(3),...[0,1,0].map((peer,i)=>cat(u16(peer),u32(90),...(addpath?[u32(i===0?0:7)]:[]),u16(attrs.length),attrs))),100);
    configure();checked(bridge.decode_record(peers,'original',1n,0n));const original=checked(bridge.decode_record(record,'original',7n,1000n)).events;
    configure();checked(bridge.partition_record(peers));const split=checked(bridge.partition_record(record));
    assert.equal(split.route_events,3);assert.equal(split.parts.length,2);assert.deepEqual(split.parts.map(part=>part.event_indices.length).sort(),[1,2]);
    const restored=[];
    for(const part of split.parts){configure();checked(bridge.decode_record(peers,'original',1n,0n));
      const batch=checked(bridge.consume_selected(Uint8Array.from(part.data),'original',7n,1000n,JSON.stringify(part.event_indices)));
      restored.push(...batch.lines.map(JSON.parse));
    }
    restored.sort((a,b)=>a.source.event_index-b.source.event_index);assert.deepEqual(restored,original);
    configure();checked(bridge.partition_record(peers));const broken=Buffer.from(record);const peerOffset=12+4+prefix.length+2;broken.writeUInt16BE(9,peerOffset);
    assert.match(JSON.parse(bridge.partition_record(broken)).error,/peer 索引/);
  }
});

test('双向更新和状态重置进入同一 peer 分区，错误索引拒绝',()=>{
  const input=bgpUpdate(Buffer.from([24,203,0,113]),undefined,attributes([64512,1]),100),outbound=Buffer.from(input);outbound.writeUInt16BE(7,6);
  const reset=mrt(16,5,cat(u32(64512),u32(64513),u16(0),u16(1),Buffer.from([192,0,2,1,192,0,2,2]),u16(6),u16(1)),101);
  configure();const a=checked(bridge.partition_record(input)),b=checked(bridge.partition_record(outbound)),c=checked(bridge.partition_record(reset));
  assert.equal(a.parts[0].peer,b.parts[0].peer);assert.equal(a.parts[0].peer,c.parts[0].peer);assert.equal(c.state_events,1);
  for(const indices of ['[]','[-1]','[0,0]','invalid']){configure();assert.ok(JSON.parse(bridge.consume_selected(input,'file',1n,0n,indices)).error);}
});
