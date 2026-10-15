///|
pub struct Query {
  priv prefix : String?
  priv asn : UInt?
  priv from_time : UInt?
  priv to_time : UInt?
}

///|
pub fn Query::new(
  prefix? : String,
  asn? : UInt,
  from_time? : UInt,
  to_time? : UInt,
) -> Query raise ParseError {
  match (from_time, to_time) {
    (Some(a), Some(b)) if a > b =>
      raise Invalid(0, "开始时间晚于结束时间")
    _ => ()
  }
  { prefix, asn, from_time, to_time, }
}

///|
/// 前缀精确匹配；ASN 匹配 peer 或有效 AS 路径，时间包含端点。
pub fn Query::matches(self : Query, event : RouteEvent) -> Bool {
  if self.prefix is Some(prefix) && event.prefix != prefix {
    return false
  }
  if self.from_time is Some(t) && event.timestamp < t {
    return false
  }
  if self.to_time is Some(t) && event.timestamp > t {
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
  "schema_version,timestamp,microseconds,action,prefix,peer_asn,peer_ip,outbound,origin_as,path,next_hop,originated,source_file,source_record,source_offset,event_index"
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
  "\{event.schema_version},\{event.timestamp},\{micros},\{csv_quote(event.action)},\{csv_quote(event.prefix)},\{event.peer_asn},\{csv_quote(event.peer_ip)},\{event.outbound},\{origin},\{csv_quote(path_text(event.attributes.path))},\{csv_quote(hop)},\{originated},\{source}"
}
