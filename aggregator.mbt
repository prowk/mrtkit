///|
pub struct Aggregator {
  asn : UInt
  address : String
} derive(Eq, Hash, ToJson)

///|
pub extend Aggregator with Eq::{equal, not_equal}

///|
pub extend Aggregator with Hash::{hash, hash_combine}

///|
pub extend Aggregator with ToJson::{to_json}

///|
pub struct AtomicAggregateDiff {
  before : Bool
  after : Bool
} derive(ToJson)

///|
pub extend AtomicAggregateDiff with ToJson::{to_json}

///|
pub struct AggregatorDiff {
  before : Aggregator?
  after : Aggregator?
}

///|
pub impl ToJson for AggregatorDiff with fn to_json(self) {
  Json::object({
    "before": self.before.map(fn(a) { a.to_json() }).unwrap_or(Json::null()),
    "after": self.after.map(fn(a) { a.to_json() }).unwrap_or(Json::null()),
  })
}

///|
pub extend AggregatorDiff with ToJson::{to_json}

///|
fn read_aggregator(c : Cursor, width : Int) -> Aggregator raise ParseError {
  if c.remaining() != width + 4 {
    raise Invalid(c.pos, "AGGREGATOR 长度与 ASN 编码宽度不匹配")
  }
  let asn = if width == 4 { c.u32() } else { c.u16().reinterpret_as_uint() }
  { asn, address: ip_text(c.bytes(4)), }
}

///|
/// 旧环境的非 AS_TRANS 配对优先旧值，其余 AS4 聚合器兼容为有效值。
fn effective_aggregator(
  wire : Aggregator?,
  as4 : Aggregator?,
  width : Int,
) -> Aggregator? {
  match (wire, as4) {
    (Some(old), Some(new)) if width == 2 && old.asn == 23456U => Some(new)
    (None, Some(new)) if width == 2 => Some(new)
    _ => wire
  }
}
