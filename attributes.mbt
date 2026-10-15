///|
pub struct AsSegment {
  kind : Int
  asns : Array[UInt]
} derive(Eq, ToJson)

///|
pub extend AsSegment with Eq::{equal, not_equal}

///|
pub extend AsSegment with ToJson::{to_json}

///|
pub struct RawAttribute {
  flags : Int
  code : Int
  value : Bytes
} derive(Eq)

///|
pub impl ToJson for RawAttribute with fn to_json(self) {
  Json::object({
    "flags": self.flags.to_json(),
    "code": self.code.to_json(),
    "value": self.value.to_array().map(fn(b) { b.to_int() }).to_json(),
  })
}

///|
pub extend RawAttribute with Eq::{equal, not_equal}

///|
pub extend RawAttribute with ToJson::{to_json}

///|
pub struct Attributes {
  origin : Int?
  path : Array[AsSegment]
  wire_path : Array[AsSegment]
  as4_path : Array[AsSegment]
  next_hop : String?
  med : UInt?
  local_pref : UInt?
  communities : Array[UInt]
  large_communities : Array[(UInt, UInt, UInt)]
  other : Array[RawAttribute]
} derive(Eq, ToJson)

///|
pub extend Attributes with Eq::{equal, not_equal}

///|
pub extend Attributes with ToJson::{to_json}

///|
fn empty_attributes() -> Attributes {
  {
    origin: None,
    path: [],
    wire_path: [],
    as4_path: [],
    next_hop: None,
    med: None,
    local_pref: None,
    communities: [],
    large_communities: [],
    other: [],
  }
}

///|
fn read_as_path(c : Cursor, width : Int) -> Array[AsSegment] raise ParseError {
  let segments = []
  while c.remaining() > 0 {
    let kind = c.u8()
    let count = c.u8()
    if kind < 1 || kind > 4 || count == 0 {
      raise Invalid(c.pos - 2, "无效 AS 路径段")
    }
    let asns = []
    for i = 0; i < count; i = i + 1 {
      asns.push(
        if width == 4 {
          c.u32()
        } else {
          c.u16().reinterpret_as_uint()
        },
      )
    }
    segments.push({ kind, asns, })
  }
  segments
}

///|
pub fn parse_attributes(
  data : Bytes,
  asn_width : Int,
) -> Attributes raise ParseError {
  if asn_width != 2 && asn_width != 4 {
    raise Invalid(0, "ASN 宽度必须为 2 或 4")
  }
  let c = Cursor::new(data)
  let seen : Map[Int, Bool] = Map([])
  let mut origin = None
  let mut path = []
  let mut as4_path = []
  let mut next_hop = None
  let mut med = None
  let mut local_pref = None
  let communities = []
  let large_communities = []
  let other = []
  while c.remaining() > 0 {
    let flags = c.u8()
    let code = c.u8()
    let length = if (flags & 16) != 0 { c.u16() } else { c.u8() }
    if seen.contains(code) {
      raise Invalid(c.pos, "重复 BGP 属性")
    }
    seen[code] = true
    let value = c.take(length)
    match code {
      1 => {
        let n = value.u8()
        if n > 2 {
          raise Invalid(value.pos - 1, "无效 ORIGIN 属性")
        }
        origin = Some(n)
      }
      2 => path = read_as_path(value, asn_width)
      3 => next_hop = Some(ip_text(value.bytes(4)))
      4 => med = Some(value.u32())
      5 => local_pref = Some(value.u32())
      8 =>
        while value.remaining() > 0 {
          communities.push(value.u32())
        }
      17 => as4_path = read_as_path(value, 4)
      32 => {
        let raw = value.bytes(value.remaining())
        if raw.length() == 0 || raw.length() % 12 != 0 {
          raise Invalid(
            value.pos - raw.length(),
            "LARGE_COMMUNITY 长度必须是非零的 12 字节倍数",
          )
        }
        let values = Cursor::new(raw)
        while values.remaining() > 0 {
          large_communities.push((values.u32(), values.u32(), values.u32()))
        }
        other.push({ flags, code, value: raw, })
      }
      _ => other.push({ flags, code, value: value.bytes(value.remaining()), })
    }
    value.finish()
  }
  {
    origin,
    path: effective_path(path, as4_path, other, asn_width),
    wire_path: path,
    as4_path,
    next_hop,
    med,
    local_pref,
    communities,
    large_communities: unique_large_communities(large_communities),
    other,
  }
}

///|
/// AS_SET 计一个跳数，联盟路径不参与常规路径长度统计。
pub fn path_length(path : Array[AsSegment]) -> Int {
  let mut length = 0
  for segment in path {
    if segment.kind == 1 {
      length += 1
    }
    if segment.kind == 2 {
      length += segment.asns.length()
    }
  }
  length
}

///|
/// 末段为 AS_SET 时无法唯一确定起源 AS。
pub fn origin_as(path : Array[AsSegment]) -> UInt? {
  for i = path.length() - 1; i >= 0; i = i - 1 {
    let segment = path[i]
    if segment.kind == 1 {
      return None
    }
    if segment.kind == 2 {
      return segment.asns.last()
    }
  }
  None
}
