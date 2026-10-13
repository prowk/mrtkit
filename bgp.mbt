///|
pub struct StateChange {
  timestamp : UInt
  peer_asn : UInt
  peer_ip : String
  old_state : Int
  new_state : Int
} derive(ToJson)

///|
pub extend StateChange with ToJson::{to_json}

///|
pub struct BgpRecord {
  message_type : Int
  events : Array[RouteEvent]
  states : Array[StateChange]
}

///|
fn read_nlri(c : Cursor, afi : Int) -> Array[String] raise ParseError {
  let prefixes = []
  while c.remaining() > 0 {
    prefixes.push(read_prefix(c, afi).text())
  }
  prefixes
}

///|
fn make_event(
  frame : Frame,
  peer_asn : UInt,
  peer_ip : String,
  outbound : Bool,
  action : String,
  prefix : String,
  attributes : Attributes,
) -> RouteEvent {
  {
    timestamp: frame.header.timestamp,
    microseconds: frame.microseconds,
    action,
    prefix,
    peer_asn,
    peer_ip,
    outbound,
    originated: None,
    attributes,
  }
}

///|
pub fn parse_bgp4mp(frame : Frame) -> BgpRecord raise ParseError {
  if frame.header.kind != 16 && frame.header.kind != 17 {
    raise Invalid(0, "不是 BGP4MP")
  }
  let subtype = frame.header.subtype
  let width = match subtype {
    0 | 1 | 6 => 2
    4 | 5 | 7 => 4
    _ => raise Invalid(0, "不支持的 BGP4MP 子类型")
  }
  let c = Cursor::new(frame.payload)
  let peer_asn = if width == 4 {
    c.u32()
  } else {
    c.u16().reinterpret_as_uint()
  }
  if width == 4 {
    ignore(c.u32())
  } else {
    ignore(c.u16())
  }
  ignore(c.u16())
  let afi = c.u16()
  let size = address_size(afi)
  let peer_ip = ip_text(c.bytes(size))
  ignore(c.bytes(size))
  if subtype == 0 || subtype == 5 {
    let old_state = c.u16()
    let new_state = c.u16()
    if old_state < 1 || old_state > 6 || new_state < 1 || new_state > 6 {
      raise Invalid(c.pos - 4, "无效 BGP 会话状态")
    }
    c.finish()
    return {
      message_type: 0,
      events: [],
      states: [
        {
          timestamp: frame.header.timestamp,
          peer_asn,
          peer_ip,
          old_state,
          new_state,
        },
      ],
    }
  }
  let outbound = subtype == 6 || subtype == 7
  let message = c.take(c.remaining())
  for i = 0; i < 16; i = i + 1 {
    if message.u8() != 255 {
      raise Invalid(message.pos - 1, "无效 BGP marker")
    }
  }
  let length = message.u16()
  if length < 19 || length != message.remaining() + 18 {
    raise Invalid(message.pos - 2, "BGP 消息长度不匹配")
  }
  let message_type = message.u8()
  if message_type < 1 || message_type > 5 {
    raise Invalid(message.pos - 1, "无效 BGP 消息类型")
  }
  let events = []
  if message_type == 2 {
    let withdrawn = message.take(message.u16())
    let withdrawals = read_nlri(withdrawn, 1)
    let attributes = parse_attributes(message.bytes(message.u16()), width)
    let announcements = read_nlri(message, 1)
    for prefix in withdrawals {
      events.push(
        make_event(
          frame,
          peer_asn,
          peer_ip,
          outbound,
          "withdraw",
          prefix,
          empty_attributes(),
        ),
      )
    }
    for prefix in announcements {
      events.push(
        make_event(
          frame, peer_asn, peer_ip, outbound, "announce", prefix, attributes,
        ),
      )
    }
  } else {
    if message_type == 4 && message.remaining() != 0 {
      raise Invalid(message.pos, "KEEPALIVE 消息包含额外数据")
    }
    if message_type == 1 && message.remaining() < 10 {
      raise Invalid(message.pos, "OPEN 消息截断")
    }
    if message_type == 3 && message.remaining() < 2 {
      raise Invalid(message.pos, "NOTIFICATION 消息截断")
    }
    if message_type == 5 && message.remaining() != 4 {
      raise Invalid(message.pos, "ROUTE-REFRESH 长度错误")
    }
    ignore(message.bytes(message.remaining()))
  }
  message.finish()
  { message_type, events, states: [], }
}
