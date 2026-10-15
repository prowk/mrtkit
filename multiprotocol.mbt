///|
priv struct MpRoutes {
  prefixes : Array[String]
  path_ids : Array[UInt?]
  next_hop : String?
  supported : Bool
}

///|
fn read_next_hop(c : Cursor, afi : Int) -> String raise ParseError {
  let length = c.u8()
  if length != 4 && length != 16 && length != 32 {
    raise Invalid(c.pos - 1, "不支持的单播下一跳长度")
  }
  if afi == 2 && length == 4 {
    raise Invalid(c.pos - 1, "IPv6 下一跳长度错误")
  }
  let raw = c.bytes(length)
  // IPv6 双地址编码保留全局地址，链路本地地址仍在原始属性中。
  ip_text(if length == 32 { raw[0:16].to_owned() } else { raw })
}

///|
fn parse_mp(
  value : Bytes,
  reach : Bool,
  addpath? : Bool = false,
) -> MpRoutes raise ParseError {
  let c = Cursor::new(value)
  let afi = c.u16()
  let safi = c.u8()
  if (afi != 1 && afi != 2) || safi != 1 {
    return { prefixes: [], path_ids: [], next_hop: None, supported: false, }
  }
  let next_hop = if reach {
    let hop = read_next_hop(c, afi)
    ignore(c.u8())
    Some(hop)
  } else {
    None
  }
  let entries = read_nlri_paths(c, afi, addpath)
  {
    prefixes: entries.map(fn(entry) { entry.0 }),
    path_ids: entries.map(fn(entry) { entry.1 }),
    next_hop,
    supported: true,
  }
}

///|
fn rib_next_hop(
  attributes : Attributes,
  afi : Int,
) -> Attributes raise ParseError {
  for attr in attributes.other {
    if attr.code == 14 {
      let c = Cursor::new(attr.value)
      // RFC 6396 精简编码与历史采集器完整编码均可读取。
      let hop = if c.remaining() > 0 && attr.value[0].to_int() != 0 {
        let hop = read_next_hop(c, afi)
        c.finish()
        Some(hop)
      } else {
        parse_mp(attr.value, true).next_hop
      }
      return { ..attributes, next_hop: hop, }
    }
  }
  attributes
}
