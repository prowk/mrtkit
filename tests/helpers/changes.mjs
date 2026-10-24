import {correlation_key_from_json} from '../../_build/js/release/build/bridge/bridge.js';

export const attributes=(path=[1])=>({origin:0,path:[{kind:2,asns:path}],wire_path:[],as4_path:[],
  atomic_aggregate:false,raw_attributes:[],communities:[],large_communities:[],other:[]});

// 测试数据也由核心生成键，不复制生产代码中的路径和属性规范化规则。
export function makeChange(collector,time,record='1',extra={}){
  const change={schema_version:'2.0',timestamp:time,prefix:'203.0.113.0/24',kind:'path_change',peer_asn:64512,peer_ip:'192.0.2.1',outbound:false,
    source:{collector,view:'v',file:'input',record,offset:'0',event_index:0},
    before:{timestamp:Math.max(0,time-1),active:true,attributes:attributes([1])},
    after:{timestamp:time,active:true,attributes:attributes([2])},...extra};
  if(!Object.hasOwn(extra,'correlation_key'))change.correlation_key=correlation_key_from_json(JSON.stringify(change));
  return change;
}
