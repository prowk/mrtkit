///|
priv struct PrefixAggregate {
  events : Map[Source, Unit]
  peers : Map[String, Unit]
  types : Map[String, Int64]
  mut notices : Int64
}

///|
pub struct Aggregation {
  priv prefixes : Map[String, PrefixAggregate]
  priv peers : Map[String, Unit]
  priv types : Map[String, Int64]
  priv mut notices : Int64
}

///|
pub struct PrefixRanking {
  prefix : String
  changed_events : Int32
  change_notices : Int64
  affected_peers : Int32
  change_types : Map[String, Int64]
} derive(ToJson)

///|
pub extend PrefixRanking with ToJson::{to_json}

///|
pub struct AggregationReport {
  schema_version : String
  scope : String
  deduplication : String
  ordering : String
  changed_prefixes : Int32
  affected_peers : Int32
  change_notices : Int64
  change_types : Map[String, Int64]
  top_prefixes : Array[PrefixRanking]
} derive(ToJson)

///|
pub extend AggregationReport with ToJson::{to_json}

///|
pub fn Aggregation::new() -> Aggregation {
  { prefixes: Map([]), peers: Map([]), types: Map([]), notices: 0L, }
}

///|
/// 同一输入事件的多个变化类型只占一次前缀事件计数。
pub fn Aggregation::observe(
  self : Aggregation,
  change : Change,
) -> Unit raise ParseError {
  let source = match change.source {
    Some(s) => s
    None => raise Invalid(0, "聚合要求事件来源以便去重")
  }
  let entry = self.prefixes.get_or_init(change.prefix, fn() {
    { events: Map([]), peers: Map([]), types: Map([]), notices: 0L, }
  })
  let peer = scoped_peer_key(
    change.peer_asn,
    change.peer_ip,
    change.outbound,
    change.source,
  )
  entry.events[source] = ()
  entry.peers[peer] = ()
  self.peers[peer] = ()
  entry.types[change.kind] = entry.types.get(change.kind).unwrap_or(0L) + 1L
  self.types[change.kind] = self.types.get(change.kind).unwrap_or(0L) + 1L
  entry.notices += 1L
  self.notices += 1L
}

///|
pub fn Aggregation::report(
  self : Aggregation,
  top~ : Int32 = 20,
) -> AggregationReport raise ParseError {
  if top < 1 {
    raise Invalid(0, "排名条数必须为正数")
  }
  let ranking = []
  for prefix, entry in self.prefixes {
    ranking.push({
      prefix,
      changed_events: entry.events.length(),
      change_notices: entry.notices,
      affected_peers: entry.peers.length(),
      change_types: entry.types,
    })
  }
  ranking.sort_by(fn(a, b) {
    if a.changed_events != b.changed_events {
      b.changed_events.compare(a.changed_events)
    } else {
      a.prefix.compare(b.prefix)
    }
  })
  {
    schema_version: "2.0",
    scope: "filtered_changes_in_analysis_window",
    deduplication: "prefix_and_file_record_offset_event_index; peer=ASN_IP_direction",
    ordering: "changed_events_desc_then_prefix_text_asc",
    changed_prefixes: ranking.length(),
    affected_peers: self.peers.length(),
    change_notices: self.notices,
    change_types: self.types,
    top_prefixes: ranking[:if top < ranking.length() {
      top
    } else {
      ranking.length()
    }].to_owned(),
  }
}
