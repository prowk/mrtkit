///|
pub struct Query {
  priv prefix : Prefix?
  priv prefix_mode : String
  priv asn : UInt?
  priv path_id : UInt?
  priv from_time : UInt?
  priv to_time : UInt?
  priv from_micros : Int
  priv to_micros : Int
}

///|
pub fn Query::new(
  prefix? : String,
  prefix_mode? : String = "exact",
  asn? : UInt,
  path_id? : UInt,
  from_time? : UInt,
  to_time? : UInt,
  from_micros? : Int = 0,
  to_micros? : Int = 999999,
) -> Query raise ParseError {
  match (from_time, to_time) {
    (Some(a), Some(b)) if a > b =>
      raise Invalid(0, "开始时间晚于结束时间")
    _ => ()
  }
  if prefix_mode != "exact" &&
    prefix_mode != "more-specific" &&
    prefix_mode != "covering" {
    raise Invalid(0, "前缀模式无效")
  }
  if from_micros < 0 ||
    from_micros > 999999 ||
    to_micros < 0 ||
    to_micros > 999999 {
    raise Invalid(0, "微秒端点无效")
  }
  match (from_time, to_time) {
    (Some(a), Some(b)) if event_time(a, Some(from_micros)) >
      event_time(b, Some(to_micros)) =>
      raise Invalid(0, "开始时间晚于结束时间")
    _ => ()
  }
  let normalized = match prefix {
    Some(text) => Some(parse_prefix_text(text))
    None => None
  }
  {
    prefix: normalized,
    prefix_mode,
    asn,
    path_id,
    from_time,
    to_time,
    from_micros,
    to_micros,
  }
}

///|
/// 前缀精确匹配；ASN 匹配 peer 或有效 AS 路径，时间包含端点。
pub fn Query::matches(self : Query, event : RouteEvent) -> Bool {
  if self.path_id is Some(id) && event.path_id != Some(id) {
    return false
  }
  if self.prefix is Some(prefix) {
    let target = parse_prefix_text(event.prefix) catch { _ => return false }
    let accepted = match self.prefix_mode {
      "more-specific" =>
        prefix.length < target.length && prefix.contains(target)
      "covering" => target.contains(prefix)
      _ => prefix == target
    }
    if !accepted {
      return false
    }
  }
  if self.from_time is Some(t) &&
    event_time(event.timestamp, event.microseconds) <
    event_time(t, Some(self.from_micros)) {
    return false
  }
  if self.to_time is Some(t) &&
    event_time(event.timestamp, event.microseconds) >
    event_time(t, Some(self.to_micros)) {
    return false
  }
  if self.asn is Some(asn) {
    if event.peer_asn == asn {
      return true
    }
    return event.attributes.path.any(fn(segment) { segment.asns.contains(asn) })
  }
  true
}

///|
pub fn path_text(path : Array[AsSegment]) -> String {
  let out = StringBuilder()
  for i = 0; i < path.length(); i = i + 1 {
    if i > 0 {
      out.write_string(" ")
    }
    let segment = path[i]
    let (open, close, separator) = match segment.kind {
      1 => ("{", "}", ",")
      3 => ("(", ")", " ")
      4 => ("[", "]", ",")
      _ => ("", "", " ")
    }
    out.write_string(open)
    for j = 0; j < segment.asns.length(); j = j + 1 {
      if j > 0 {
        out.write_string(separator)
      }
      out.write_string(segment.asns[j].to_string())
    }
    out.write_string(close)
  }
  out.to_string()
}

///|
pub fn event_json(event : RouteEvent) -> String {
  event.to_json().stringify()
}

///|
fn csv_quote(value : String) -> String {
  let out = StringBuilder()
  out.write_string("\"")
  for ch in value {
    if ch == '"' {
      out.write_string("\"\"")
    } else {
      out.write_char(ch)
    }
  }
  out.write_string("\"")
  out.to_string()
}

///|
pub fn csv_header() -> String {
  "schema_version,timestamp,microseconds,action,prefix,peer_asn,peer_ip,outbound,origin_as,path,next_hop,originated,source_file,source_record,source_offset,event_index,large_communities,path_id,atomic_aggregate,aggregator_asn,aggregator_address,wire_aggregator_asn,wire_aggregator_address,as4_aggregator_asn,as4_aggregator_address"
}

///|
pub fn event_csv(event : RouteEvent) -> String {
  let micros = match event.microseconds {
    Some(n) => n.to_string()
    None => ""
  }
  let origin = match origin_as(event.attributes.path) {
    Some(n) => n.to_string()
    None => ""
  }
  let hop = match event.attributes.next_hop {
    Some(s) => s
    None => ""
  }
  let originated = match event.originated {
    Some(n) => n.to_string()
    None => ""
  }
  let source = match event.source {
    Some(s) => "\{csv_quote(s.file)},\{s.record},\{s.offset},\{s.event_index}"
    None => ",,,"
  }
  let large = StringBuilder()
  for i, (global, local1, local2) in event.attributes.large_communities {
    if i > 0 {
      large.write_string(" ")
    }
    large.write_string("\{global}:\{local1}:\{local2}")
  }
  let id = event.path_id.map(fn(n) { n.to_string() }).unwrap_or("")
  let aggregator = csv_aggregator(event.attributes.aggregator)
  let wire = csv_aggregator(event.attributes.wire_aggregator)
  let as4 = csv_aggregator(event.attributes.as4_aggregator)
  "\{event.schema_version},\{event.timestamp},\{micros},\{csv_quote(event.action)},\{csv_quote(event.prefix)},\{event.peer_asn},\{csv_quote(event.peer_ip)},\{event.outbound},\{origin},\{csv_quote(path_text(event.attributes.path))},\{csv_quote(hop)},\{originated},\{source},\{csv_quote(large.to_string())},\{id},\{event.attributes.atomic_aggregate},\{aggregator},\{wire},\{as4}"
}

///|
fn csv_aggregator(value : Aggregator?) -> String {
  match value {
    Some(a) => "\{a.asn},\{csv_quote(a.address)}"
    None => ","
  }
}
