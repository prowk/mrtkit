///|
pub struct PeerRecord {
  peer : String
  data : Bytes
  event_indices : Array[Int]
}

///|
pub impl ToJson for PeerRecord with fn to_json(self) {
  Json::object({
    "peer": self.peer.to_json(),
    "data": self.data.to_array().map(fn(b) { b.to_int() }).to_json(),
    "event_indices": self.event_indices.to_json(),
  })
}

///|
pub extend PeerRecord with ToJson::{to_json}

///|
pub struct PartitionedBatch {
  header : Header
  microseconds : Int?
  skipped : Bool
  ignored_families : Int
  diagnostics : Array[Diagnostic]
  route_events : Int
  state_events : Int
  peer_table : Bool
  parts : Array[PeerRecord]
} derive(ToJson)

///|
pub extend PartitionedBatch with ToJson::{to_json}

///|
fn partition_peer(asn : UInt, ip : String) -> String {
  Json::array([asn.to_json(), ip.to_json()]).stringify()
}

///|
/// 原记录先完整解码校验，再原样拼接各 peer 的 RIB 条目，只改头长度与条目数。
/// 双向 UPDATE 与会话事件使用同一 peer 分区，重置水位不会跨分区丢失。
pub fn Decoder::partition_record(
  self : Decoder,
  data : Bytes,
) -> PartitionedBatch raise ParseError {
  let batch = self.decode(data)
  let parts = []
  if batch.header.kind == 13 && [2, 4, 8, 10].contains(batch.header.subtype) {
    let frame = read_frame(data)
    let c = Cursor::new(frame.payload)
    ignore(c.u32())
    ignore(
      read_prefix(c, if [2, 8].contains(batch.header.subtype) { 1 } else { 2 }),
    )
    let count_position = 12 + c.pos
    let count = c.u16()
    if count != batch.events.length() {
      raise Invalid(0, "分区条目数不一致")
    }
    let groups : Map[String, Array[(Int, Int, Int)]] = Map([])
    for index = 0; index < count; index = index + 1 {
      let start = 12 + c.pos
      ignore(c.u16())
      ignore(c.u32())
      if batch.header.subtype == 8 || batch.header.subtype == 10 {
        ignore(c.u32())
      }
      ignore(c.bytes(c.u16()))
      let event = batch.events[index]
      let key = partition_peer(event.peer_asn, event.peer_ip)
      groups.get_or_init(key, fn() { [] }).push((index, start, 12 + c.pos))
    }
    c.finish()
    for key, ranges in groups {
      let bytes = data[:count_position].to_owned().to_array()
      bytes.push((ranges.length() >> 8).to_byte())
      bytes.push((ranges.length() & 255).to_byte())
      let indices = []
      for range in ranges {
        indices.push(range.0)
        for byte in data[range.1:range.2] {
          bytes.push(byte)
        }
      }
      let length = (bytes.length() - 12).reinterpret_as_uint()
      for i = 0; i < 4; i = i + 1 {
        bytes[8 + i] = ((length >> (24 - 8 * i)) & 255U).to_byte()
      }
      parts.push({
        peer: key,
        data: Bytes::from_array(bytes),
        event_indices: indices,
      })
    }
  } else {
    let key = match batch.events.get(0) {
      Some(e) => Some(partition_peer(e.peer_asn, e.peer_ip))
      None =>
        batch.states.get(0).map(fn(s) { partition_peer(s.peer_asn, s.peer_ip) })
    }
    if key is Some(peer) {
      if batch.events.any(fn(e) {
          partition_peer(e.peer_asn, e.peer_ip) != peer
        }) ||
        batch.states.any(fn(s) { partition_peer(s.peer_asn, s.peer_ip) != peer }) {
        raise Invalid(0, "单条非 RIB 记录出现多个 peer")
      }
      parts.push({
        peer,
        data,
        event_indices: Array::makei(batch.events.length(), fn(i) { i }),
      })
    }
  }
  {
    header: batch.header,
    microseconds: batch.microseconds,
    skipped: batch.skipped,
    ignored_families: batch.ignored_families,
    diagnostics: batch.diagnostics,
    route_events: batch.events.length(),
    state_events: batch.states.length(),
    peer_table: batch.header.kind == 13 && batch.header.subtype == 1,
    parts,
  }
}

///|
/// 临时帧重新解码后恢复原始记录内索引；文件、记录号和偏移保持原始档案位置。
pub fn Batch::with_event_indices(
  self : Batch,
  indices : Array[Int],
) -> Batch raise ParseError {
  if indices.length() != self.events.length() {
    raise Invalid(0, "原始事件索引数量不一致")
  }
  for i = 0; i < indices.length(); i = i + 1 {
    if indices[i] < 0 || (i > 0 && indices[i] <= indices[i - 1]) {
      raise Invalid(0, "原始事件索引须严格递增且非负")
    }
  }
  {
    ..self,
    events: self.events.mapi(fn(i, event) {
      {
        ..event,
        source: event.source.map(fn(source) {
          { ..source, event_index: indices[i], }
        }),
      }
    }),
  }
}

///|
/// 分区摘要按整数路径总长和样本数合并，避免合并均值带来的舍入误差。
pub fn Analyzer::path_totals(self : Analyzer) -> (Int64, Int64) {
  (self.path_sum, self.path_samples)
}

///|
pub fn Analyzer::route_count(self : Analyzer) -> Int {
  self.routes.length()
}
