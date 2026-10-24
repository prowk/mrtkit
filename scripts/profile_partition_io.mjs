import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {PeerStore} from '../cli/disk-replay.mjs';
import {DiskBudget} from '../cli/external-sort.mjs';
import {encodePacket} from '../cli/disk-storage.mjs';
import {frames,inputChunks} from '../cli/input.mjs';
import * as bridge from '../_build/js/release/build/bridge/bridge.js';

const directory=resolve('.validation/partition-io-profile');await mkdir(directory,{recursive:false});
const results=[];
for(const maxOpen of [8,64]){
  const output=join(directory,'handles-'+maxOpen);await mkdir(output);const store=new PeerStore(output,new DiskBudget(1073741824),{maxOpen});
  bridge.configure(JSON.stringify({mode:'parse',format:'json',from_time:0,to_time:4294967295,window_seconds:60,threshold:3,capacity:12000000}));
  let records=0,events=0,decodeSeconds=0;const start=performance.now(),cpu=process.cpuUsage();
  for await(const frame of frames(inputChunks('.validation/archives/ris-rrc23-bview.20250101.0000.gz'))){records++;const before=performance.now(),batch=JSON.parse(bridge.partition_record(frame.data));decodeSeconds+=(performance.now()-before)/1000;if(batch.error)throw new Error(batch.error);
    if(batch.peer_table)store.initial=encodePacket({fileIndex:0,record:records,offset:frame.offset,indices:[],data:frame.data});
    for(const part of batch.parts)await store.append(part.peer,encodePacket({fileIndex:0,record:records,offset:frame.offset,indices:part.event_indices,data:Buffer.from(part.data)}),part.event_indices.length,batch.state_events);
    events+=batch.route_events;if(records===4000)break;
  }
  const peers=await store.finish(),usage=process.cpuUsage(cpu),row={max_open:maxOpen,records,events,seconds:(performance.now()-start)/1000,cpu_seconds:(usage.user+usage.system)/1000000,
    decode_and_transport_seconds:decodeSeconds,write_seconds:store.writeSeconds,handle_opens:store.handleOpens,partitions:peers.length,bytes:peers.reduce((sum,peer)=>sum+peer.bytes,0)};results.push(row);console.log(JSON.stringify(row));
}
await writeFile(join(directory,'report.json'),JSON.stringify({partial_input_profile:true,scope:'first 4000 complete MRT records; I/O tuning only, not complete replay success',results},null,2)+'\n','utf8');
