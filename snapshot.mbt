///|
pub struct Snapshot {
  priv collector : String
  priv decoder : Decoder
  priv mut table : PeerTable?
  priv mut table_source : Source?
  priv peers : Map[String, Peer]
  priv routes : Map[String, RouteEvent]
  priv capacity : Int
  priv mut first_time : UInt?
  priv mut last_time : UInt?
}

///|
pub fn Snapshot::new(
  collector : String,
  capacity? : Int = 1000000,
) -> Snapshot raise ParseError {
  if collector == "" || capacity < 1 {
    raise Invalid(0, "快照需要采集器名称和正数容量")
  }
  {
    collector,
    capacity,
    decoder: Decoder::new(),
    table: None,
    table_source: None,
    peers: Map([]),
    routes: Map([]),
    first_time: None,
    last_time: None,
  }
}

///|
/// 快照保留 peer 表，避免把整个 peer 未采集误判为单条路由消失。
pub fn Snapshot::ingest(
  self : Snapshot,
  data : Bytes,
  file : String,
  record : Int64,
  offset : Int64,
  query? : Query,
  peer_asn? : UInt,
) -> Unit raise ParseError {
  let frame = read_frame(data)
  if frame.header.kind != 13 || ![1, 2, 4, 8, 10].contains(frame.header.subtype) {
    raise Invalid(0, "快照仅接受支持的 TABLE_DUMP_V2 单播记录")
  }
  if frame.header.subtype == 1 {
    if self.table is Some(_) {
      raise Invalid(0, "单个快照只能包含一个 peer 表")
    }
    let table = parse_peers(frame.payload)
    self.table = Some(table)
    self.table_source = Some({ file, record, offset, event_index: 0, })
    for peer in table.peers {
      if peer_asn.map(fn(asn) { asn == peer.asn }).unwrap_or(true) {
        self.peers[peer_key(peer.asn, peer.address, false)] = peer
      }
    }
  }
  let batch = self.decoder.decode_at(data, file, record, offset)
  let time = frame.header.timestamp
  if self.first_time.map(fn(t) { time < t }).unwrap_or(true) {
    self.first_time = Some(time)
  }
  if self.last_time.map(fn(t) { time > t }).unwrap_or(true) {
    self.last_time = Some(time)
  }
  for event in batch.events {
    if !self.peers.contains(
        peer_key(event.peer_asn, event.peer_ip, event.outbound),
      ) ||
      !query.map(fn(q) { q.matches(event) }).unwrap_or(true) {
      continue
    }
    let key = snapshot_route_key(event)
    if self.routes.contains(key) {
      raise Invalid(0, "快照含重复路由键，不能按条目顺序覆盖")
    }
    if self.routes.length() >= self.capacity {
      raise Invalid(0, "快照路由数量超过容量")
    }
    self.routes[key] = event
  }
}

///|
fn snapshot_route_key(event : RouteEvent) -> String {
  peer_key(event.peer_asn, event.peer_ip, event.outbound) +
  "|" +
  event.prefix +
  "|" +
  event.path_id.map(fn(n) { n.to_string() }).unwrap_or("none")
}

///|
pub struct SnapshotChange {
  schema_version : String
  collector : String
  kind : String
  peer_asn : UInt
  peer_ip : String
  outbound : Bool
  prefix : String?
  path_id : UInt?
  before : RouteEvent?
  after : RouteEvent?
  diff : RouteDiff?
  before_source : Source?
  after_source : Source?
} derive(ToJson)

///|
pub extend SnapshotChange with ToJson::{to_json}

///|
pub struct SnapshotReport {
  schema_version : String
  collector : String
  interpretation : String
  before_source : Source?
  after_source : Source?
  before_time : UInt?
  after_time : UInt?
  before_peers : Int
  after_peers : Int
  before_routes : Int
  after_routes : Int
  changes : Array[SnapshotChange]
} derive(ToJson)

///|
pub extend SnapshotReport with ToJson::{to_json}

///|
/// 比较显式同源、同视图的两个快照；缺失不等同于观测到撤回。
pub fn Snapshot::diff(
  self : Snapshot,
  after : Snapshot,
) -> SnapshotReport raise ParseError {
  let before_table = match self.table {
    Some(t) => t
    None => raise Invalid(0, "前快照为空或缺少 peer 表")
  }
  let after_table = match after.table {
    Some(t) => t
    None => raise Invalid(0, "后快照为空或缺少 peer 表")
  }
  if self.collector != after.collector ||
    before_table.collector_id != after_table.collector_id ||
    before_table.view_name != after_table.view_name {
    raise Invalid(
      0, "采集器名称、Collector BGP ID 或视图名称不同，快照不可比较",
    )
  }
  if self.first_time.unwrap() > after.first_time.unwrap() {
    raise Invalid(0, "前快照时间晚于后快照")
  }
  let changes = []
  let peer_keys = self.peers.keys().to_array()
  for key in after.peers.keys() {
    if !self.peers.contains(key) {
      peer_keys.push(key)
    }
  }
  peer_keys.sort()
  for key in peer_keys {
    let a = self.peers.get(key)
    let b = after.peers.get(key)
    if a is None || b is None {
      let peer = match a {
        Some(p) => p
        None => b.unwrap()
      }
      changes.push({
        schema_version: "2.0",
        collector: self.collector,
        kind: if a is None {
          "peer_added"
        } else {
          "peer_missing"
        },
        peer_asn: peer.asn,
        peer_ip: peer.address,
        outbound: false,
        prefix: None,
        path_id: None,
        before: None,
        after: None,
        diff: None,
        before_source: self.table_source,
        after_source: after.table_source,
      })
    }
  }
  let route_keys = self.routes.keys().to_array()
  for key in after.routes.keys() {
    if !self.routes.contains(key) {
      route_keys.push(key)
    }
  }
  route_keys.sort()
  for key in route_keys {
    let a = self.routes.get(key)
    let b = after.routes.get(key)
    let event = match a {
      Some(e) => e
      None => b.unwrap()
    }
    let peer = peer_key(event.peer_asn, event.peer_ip, event.outbound)
    if !self.peers.contains(peer) || !after.peers.contains(peer) {
      continue
    }
    let kinds = []
    match (a, b) {
      (None, Some(_)) => kinds.push("route_added")
      (Some(_), None) => kinds.push("route_missing")
      (Some(before), Some(next)) => {
        if !same_path(before.attributes.path, next.attributes.path) {
          kinds.push("path_change")
        }
        if origin_as(before.attributes.path) != origin_as(next.attributes.path) {
          kinds.push("origin_change")
        }
        if !route_attributes_equal({ ..before.attributes, path: [], }, {
            ..next.attributes,
            path: [],
          }) {
          kinds.push("attribute_change")
        }
      }
      _ => ()
    }
    for kind in kinds {
      changes.push({
        schema_version: "2.0",
        collector: self.collector,
        kind,
        peer_asn: event.peer_asn,
        peer_ip: event.peer_ip,
        outbound: event.outbound,
        prefix: Some(event.prefix),
        path_id: event.path_id,
        before: a,
        after: b,
        diff: match (a, b) {
          (Some(x), Some(y)) => Some(route_diff(x.attributes, y.attributes))
          _ => None
        },
        before_source: match a {
          Some(e) => e.source
          None => None
        },
        after_source: match b {
          Some(e) => e.source
          None => None
        },
      })
    }
  }
  {
    schema_version: "2.0",
    collector: self.collector,
    interpretation: "snapshot_presence_difference_not_observed_bgp_withdrawal",
    before_source: self.table_source,
    after_source: after.table_source,
    before_time: self.first_time,
    after_time: after.first_time,
    before_peers: self.peers.length(),
    after_peers: after.peers.length(),
    before_routes: self.routes.length(),
    after_routes: after.routes.length(),
    changes,
  }
}
