///|
pub struct Peer {
  bgp_id : UInt
  address : String
  asn : UInt
} derive(ToJson)

///|
pub extend Peer with ToJson::{to_json}

///|
pub struct PeerTable {
  collector_id : UInt
  view_name : Bytes
  peers : Array[Peer]
}

///|
pub struct RouteEvent {
  timestamp : UInt
  microseconds : Int?
  action : String
  prefix : String
  peer_asn : UInt
  peer_ip : String
  local : Bool
  originated : UInt?
  attributes : Attributes
} derive(ToJson)

///|
pub extend RouteEvent with ToJson::{to_json}

///|
pub fn parse_peers(data : Bytes) -> PeerTable raise ParseError {
  let c = Cursor::new(data)
  let collector_id = c.u32()
  let view_name = c.bytes(c.u16())
  let count = c.u16()
  let peers = []
  for i = 0; i < count; i = i + 1 {
    let flags = c.u8()
    if (flags & 252) != 0 {
      raise Invalid(c.pos - 1, "Peer Type 保留位非零")
    }
    let bgp_id = c.u32()
    let address = ip_text(c.bytes(if (flags & 1) == 0 { 4 } else { 16 }))
    let asn = if (flags & 2) == 0 {
      c.u16().reinterpret_as_uint()
    } else {
      c.u32()
    }
    peers.push({ bgp_id, address, asn, })
  }
  c.finish()
  { collector_id, view_name, peers, }
}

///|
/// TABLE_DUMP_V2 的 AS_PATH 始终使用四字节 ASN。
pub fn parse_rib(
  frame : Frame,
  peers : Array[Peer],
) -> Array[RouteEvent] raise ParseError {
  let afi = match frame.header.subtype {
    2 => 1
    4 => 2
    _ => raise Invalid(0, "只支持 IPv4/IPv6 单播 RIB 子类型")
  }
  if frame.header.kind != 13 {
    raise Invalid(0, "不是 TABLE_DUMP_V2")
  }
  let c = Cursor::new(frame.payload)
  ignore(c.u32())
  let prefix = read_prefix(c, afi).text()
  let count = c.u16()
  let events = []
  for i = 0; i < count; i = i + 1 {
    let index = c.u16()
    let peer = match peers.get(index) {
      Some(peer) => peer
      None => raise Invalid(c.pos - 2, "RIB 引用了无效 peer 索引")
    }
    let originated = c.u32()
    let raw = c.bytes(c.u16())
    let attributes = parse_attributes(raw, 4)
    events.push({
      timestamp: frame.header.timestamp,
      microseconds: frame.microseconds,
      action: "rib",
      prefix,
      peer_asn: peer.asn,
      peer_ip: peer.address,
      local: false,
      originated: Some(originated),
      attributes,
    })
  }
  c.finish()
  events
}
