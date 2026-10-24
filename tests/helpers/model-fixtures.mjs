import {cat,u16,u32,mrt,attr} from '../../scripts/fixtures.mjs';

// 独立模型的协议编码器，不调用被测解析器或状态实现。
export function encodeModelEvent(event){
  const transport=cat(u32(64512),u32(64514),u16(0),u16(1),Buffer.from([192,0,2,1,192,0,2,2]));
  if(event.kind==='reset')return mrt(17,5,cat(u32(event.time),transport,u16(6),u16(1)),100);
  const nlri=cat(u32(event.id),Buffer.from([24,203,0,113])),withdraw=event.kind==='withdraw';
  const attrs=withdraw?Buffer.alloc(0):cat(attr(1,Buffer.from([0])),attr(2,cat(Buffer.from([2,event.path.length]),...event.path.map(u32))),attr(3,Buffer.from([192,0,2,event.attributes[0]])),attr(8,u32(event.attributes[1]),192));
  const withdrawn=withdraw?nlri:Buffer.alloc(0),announced=withdraw?Buffer.alloc(0):nlri,body=cat(u16(withdrawn.length),withdrawn,u16(attrs.length),attrs,announced);
  return mrt(17,9,cat(u32(event.time),transport,Buffer.alloc(16,255),u16(body.length+19),Buffer.from([2]),body),100);
}

export function modelSequence(count=1200){let seed=6396;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;},sequence=[];
  for(let i=0;i<count;i++){const time=Math.min(999,Math.floor(i*999/count));sequence.push({kind:random()%31===0?'reset':random()%4===0?'withdraw':'announce',time:random()%9===0?Math.max(0,time-3):time,id:random()%5,path:[64512,1+random()%3],attributes:[1+random()%2,random()%3]});}
  return sequence;
}
