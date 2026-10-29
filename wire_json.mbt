///|
priv struct WireRawAttribute {
  flags : Int32
  code : Int32
  value : Array[Int32]
} derive(@json.FromJson)

///|
priv struct WireAttributes {
  origin : Int32?
  path : Array[AsSegment]
  wire_path : Array[AsSegment]
  as4_path : Array[AsSegment]
  next_hop : String?
  med : UInt32?
  local_pref : UInt32?
  atomic_aggregate : Bool
  aggregator : Aggregator?
  wire_aggregator : Aggregator?
  as4_aggregator : Aggregator?
  raw_attributes : Array[WireRawAttribute]
  communities : Array[UInt32]
  large_communities : Array[(UInt32, UInt32, UInt32)]
  other : Array[WireRawAttribute]
} derive(@json.FromJson)

///|
fn wire_raw(
  values : Array[WireRawAttribute],
) -> Array[RawAttribute] raise ParseError {
  values.map(value => {
    if value.flags < 0 ||
      value.flags > 255 ||
      value.code < 0 ||
      value.code > 255 ||
      value.value.any(fn(n) { n < 0 || n > 255 }) {
      raise Invalid(0, "原始属性字节超出范围")
    }
    {
      flags: value.flags,
      code: value.code,
      value: Bytes::from_array(value.value.map(fn(n) { n.to_byte() })),
    }
  })
}

///|
fn WireAttributes::attributes(
  self : WireAttributes,
) -> Attributes raise ParseError {
  for segment in self.path + self.wire_path + self.as4_path {
    if segment.kind < 1 || segment.kind > 4 {
      raise Invalid(0, "AS 路径分段类型无效")
    }
  }
  if self.origin is Some(n) && (n < 0 || n > 2) {
    raise Invalid(0, "ORIGIN 值无效")
  }
  {
    origin: self.origin,
    path: self.path,
    wire_path: self.wire_path,
    as4_path: self.as4_path,
    next_hop: self.next_hop,
    med: self.med,
    local_pref: self.local_pref,
    atomic_aggregate: self.atomic_aggregate,
    aggregator: self.aggregator,
    wire_aggregator: self.wire_aggregator,
    as4_aggregator: self.as4_aggregator,
    raw_attributes: wire_raw(self.raw_attributes),
    communities: self.communities,
    large_communities: self.large_communities,
    other: wire_raw(self.other),
  }
}

///|
priv struct WireSemanticSnapshot {
  active : Bool
  attributes : WireAttributes
} derive(@json.FromJson)

///|
priv struct WireSemanticChange {
  prefix : String
  kind : String
  before : WireSemanticSnapshot?
  after : WireSemanticSnapshot
  churn_count : Int32?
} derive(@json.FromJson)

///|
/// 从结构化前后状态重算键，仍调用核心规范化逻辑，不信任输入自带的关联键。
fn semantic_change_from_json(text : String) -> Change raise ParseError {
  let wire : WireSemanticChange = @json.from_json(@json.parse(text)) catch {
    _ => raise Invalid(0, "变化前后状态 JSON 无效")
  }
  let after = wire.after.attributes.attributes()
  let before = match wire.before {
    Some(snapshot) =>
      Some({
        timestamp: 0U,
        microseconds: None,
        active: snapshot.active,
        attributes: snapshot.attributes.attributes(),
        source: None,
      })
    None => None
  }
  let change : Change = {
    schema_version: "2.0",
    timestamp: 0U,
    microseconds: None,
    prefix: wire.prefix,
    path_id: None,
    peer_asn: 0U,
    peer_ip: "",
    outbound: false,
    kind: wire.kind,
    source: None,
    before,
    after: {
      timestamp: 0U,
      microseconds: None,
      active: wire.after.active,
      attributes: after,
      source: None,
    },
    diff: route_diff(after, after),
    churn_count: wire.churn_count,
    correlation_key: None,
  }
  change
}

///|
pub fn correlation_key_from_json(text : String) -> String raise ParseError {
  semantic_change_from_json(text).correlation_key()
}

///|
/// 去重比关联规则更严格：比较完整规范化属性，而非只比较某一类变化的键。
pub fn correlation_semantics_from_json(
  text : String,
) -> String raise ParseError {
  let change = semantic_change_from_json(text)
  Json::object({
    "key": @json.parse(change.correlation_key()) catch {
      _ => Json::null()
    },
    "before": change.before
    .map(fn(s) {
      Json::object({
        "active": Json(s.active),
        "origin_as": Json(origin_as(s.attributes.path)),
        "attributes": semantic_attributes(s.attributes).to_json(),
      })
    })
    .unwrap_or(Json::null()),
    "after": Json::object({
      "active": Json(change.after.active),
      "origin_as": Json(origin_as(change.after.attributes.path)),
      "attributes": semantic_attributes(change.after.attributes).to_json(),
    }),
    "churn_count": Json(change.churn_count),
  }).stringify()
}
