///|
fn[T : ToJson] analysis_optional(value : T?) -> Json {
  value.map(fn(item) { Json(item) }).unwrap_or(Json::null())
}

///|
/// 可空字段统一接受 null 与缺省，数组中的空值仍由各字段类型校验。
fn analysis_json(value : Json) -> Json {
  match value {
    Object(fields) => {
      let result : Map[String, Json] = Map([])
      for key, child in fields {
        if !(child is Null) {
          result[key] = analysis_json(child)
        }
      }
      Json::object(result)
    }
    Array(values) => Json(values.map(analysis_json))
    _ => value
  }
}

///|
pub struct InvestigationGap {
  from_us : UInt64
  to_us : UInt64
  collector : String?
  view : String?
} derive(ToJson, @json.FromJson)

///|
pub struct FocusRule {
  prefix : String
  expected_origins : Array[UInt32]?
  allowed_more_specifics : Array[String]?
} derive(ToJson, @json.FromJson)

///|
pub struct AnalysisQuery {
  side : String?
  origin_asns : Array[UInt32]?
  path_asns : Array[UInt32]?
  communities : Array[UInt32]?
  origin_unknown : Bool?
  prefix : String?
  prefix_mode : String?
  peer_asn : UInt32?
  outbound : Bool?
  path_id : UInt32?
  collector : String?
  view : String?
  from_us : UInt64?
  to_us : UInt64?
  kind : String?
} derive(ToJson, @json.FromJson)

///|
pub struct ComparisonWindow {
  from_us : UInt64
  to_us : UInt64
} derive(ToJson, @json.FromJson)

///|
pub struct InvestigationRules {
  schema_version : String
  version : String
  from_us : UInt64
  to_us : UInt64
  bucket_us : UInt64?
  incident_us : UInt64?
  capacity : Int32?
  max_bytes : Int32?
  continuous : Bool?
  gaps : Array[InvestigationGap]?
  focus : Array[FocusRule]?
  query : AnalysisQuery?
  comparison : Array[ComparisonWindow]?
  sequence_prefix : String?
  scope_prefixes : Array[String]?
  scope_peer_asns : Array[UInt32]?
} derive(ToJson, @json.FromJson)

///|
pub extend InvestigationRules with ToJson::{to_json}

///|
pub struct InvestigationEvent {
  id : String
  time_us : UInt64
  prefix : String
  peer : String
  peer_asn : UInt32
  peer_ip : String
  outbound : Bool
  path_id : UInt32?
  source : Source?
  kind : String
  accepted : Bool
  changes_state : Bool
  before : RouteSnapshot?
  after : RouteSnapshot?
  changes : Array[Change]
  selected : Bool
  before_path : Json?
  after_path : Json?
} derive(ToJson)

///|
pub extend InvestigationEvent with ToJson::{to_json}

///|
pub struct InvestigationInterval {
  key : String
  prefix : String
  peer : String
  peer_asn : UInt32
  peer_ip : String
  outbound : Bool
  collector : String?
  view : String?
  path_id : UInt32?
  from_us : UInt64
  to_us : UInt64
  state : String
  duration_us : UInt64?
  left_censored : Bool
  right_censored : Bool
  start_source : Source?
  end_source : Source?
  origin_as : UInt32?
  path_length : Int32?
} derive(ToJson)

///|
priv struct InvestigationInput {
  event : RouteEvent?
  state : StateChange?
  source : Source?
  time : UInt64
  baseline : Bool
  gap : InvestigationGap?
  late : Bool
}

///|
/// 邻接只取可证明有序的 AS_SEQUENCE，集合和联盟段不连接为有序链。
fn investigation_path_view(snapshot : RouteSnapshot?) -> Json? {
  let snapshot = match snapshot {
    Some(value) => value
    None => return None
  }
  let edges = []
  let mut previous : UInt32? = None
  for segment in snapshot.attributes.path {
    if segment.kind != 2 {
      previous = None
      continue
    }
    for asn in segment.asns {
      if previous is Some(before) {
        edges.push((before, asn))
      }
      previous = Some(asn)
    }
  }
  Some(
    Json::object({
      "text": Json(path_text(snapshot.attributes.path)),
      "segments": Json(snapshot.attributes.path),
      "adjacencies": Json(edges),
      "origin_as": origin_as(snapshot.attributes.path)
      .map(fn(asn) { Json(asn) })
      .unwrap_or(Json::null()),
      "active": Json(snapshot.active),
      "interpretation": Json("observed_as_adjacency_not_physical_link"),
    }),
  )
}

///|
pub struct Investigation {
  priv rules : InvestigationRules
  priv inputs : Array[InvestigationInput]
  priv mut bytes : Int32
  priv sources : Map[String, Unit]
  priv latest_routes : Map[String, UInt64]
  priv latest_peers : Map[String, UInt64]
  priv resets : Map[String, UInt64]
}

///|
pub fn Investigation::new(text : String) -> Investigation raise ParseError {
  if text.length() > 1048576 {
    raise Invalid(0, "规则配置超过 1 MiB")
  }
  let rules : InvestigationRules = @json.from_json(
    analysis_json(@json.parse(text)),
  ) catch {
    _ => raise Invalid(0, "调查规则 JSON 无效")
  }
  if rules.schema_version != "1.0" ||
    rules.version == "" ||
    rules.from_us >= rules.to_us ||
    rules.to_us > 4294967296000000UL ||
    rules.bucket_us.unwrap_or(60000000UL) < 1UL ||
    rules.incident_us.unwrap_or(60000000UL) < 1UL ||
    rules.capacity.unwrap_or(20000) < 1 ||
    rules.capacity.unwrap_or(20000) > 1000000 ||
    rules.max_bytes.unwrap_or(67108864) < 1024 {
    raise Invalid(0, "规则版本、半开时间窗口或资源预算无效")
  }
  if (rules.to_us - rules.from_us) / rules.bucket_us.unwrap_or(60000000UL) >
    10000UL {
    raise Invalid(0, "时间桶数量超过 10000")
  }
  for gap in rules.gaps.unwrap_or([]) {
    if gap.from_us >= gap.to_us ||
      gap.to_us > rules.to_us ||
      (gap.collector is Some(_)) != (gap.view is Some(_)) {
      raise Invalid(0, "缺档区间或观测点无效")
    }
  }
  for focus in rules.focus.unwrap_or([]) {
    let parent = parse_prefix_text(focus.prefix)
    for child in focus.allowed_more_specifics.unwrap_or([]) {
      let child = parse_prefix_text(child)
      if !parent.contains(child) || child.length <= parent.length {
        raise Invalid(
          0, "允许的更具体前缀必须严格包含于关注前缀",
        )
      }
    }
  }
  if rules.sequence_prefix is Some(prefix) {
    ignore(parse_prefix_text(prefix))
  }
  for prefix in rules.scope_prefixes.unwrap_or([]) {
    ignore(parse_prefix_text(prefix))
  }
  if rules.focus.unwrap_or([]).length() > 128 ||
    rules.gaps.unwrap_or([]).length() > 1000 {
    raise Invalid(0, "关注前缀或缺档条目过多")
  }
  if rules.query is Some(query) {
    if !["before", "after", "either"].contains(query.side.unwrap_or("either")) {
      raise Invalid(0, "查询 side 必须为 before/after/either")
    }
    ignore(
      Query::new(
        prefix?=query.prefix,
        prefix_mode=query.prefix_mode.unwrap_or("exact"),
      ),
    )
  }
  if rules.comparison is Some(windows) {
    if rules.sequence_prefix is None {
      raise Invalid(0, "对比需要 sequence_prefix 指定同一资源")
    }
    if windows.length() != 2 {
      raise Invalid(0, "对比需要两个窗口")
    }
    for window in windows {
      if window.from_us < rules.from_us ||
        window.to_us > rules.to_us ||
        window.from_us >= window.to_us {
        raise Invalid(0, "对比窗口必须位于调查范围内")
      }
    }
  }
  {
    rules,
    inputs: [],
    bytes: 0,
    sources: Map([]),
    latest_routes: Map([]),
    latest_peers: Map([]),
    resets: Map([]),
  }
}

///|
/// 稳定标识只使用来源元组，调用方必须传入包内文件标签。
pub fn investigation_source_id(source : Source?) -> String {
  match source {
    Some(s) =>
      Json([
        s.collector.map(fn(value) { Json(value) }).unwrap_or(Json::null()),
        s.view.map(fn(value) { Json(value) }).unwrap_or(Json::null()),
        Json(s.file),
        Json(s.record),
        Json(s.offset),
        Json(s.event_index),
      ]).stringify()
    None => "unknown"
  }
}

///|
fn Investigation::append(
  self : Investigation,
  input : InvestigationInput,
  bytes : Int32,
) -> Unit raise ParseError {
  if self.inputs.length() >= self.rules.capacity.unwrap_or(20000) ||
    bytes > self.rules.max_bytes.unwrap_or(67108864) - self.bytes {
    raise Invalid(
      0, "调查输入超过事件数或内存预算，请缩小范围",
    )
  }
  let id = investigation_source_id(input.source)
  if id == "unknown" {
    raise Invalid(0, "调查要求显式来源")
  }
  if self.sources.contains(id) {
    raise Invalid(0, "重复来源事件")
  }
  self.sources[id] = ()
  self.bytes += bytes
  self.inputs.push(input)
}

///|
pub fn Investigation::observe(
  self : Investigation,
  event : RouteEvent,
  baseline~ : Bool = false,
) -> Unit raise ParseError {
  if self.rules.scope_peer_asns is Some(peers) &&
    !peers.is_empty() &&
    !peers.contains(event.peer_asn) {
    return
  }
  if self.rules.scope_prefixes is Some(prefixes) &&
    !prefixes.is_empty() &&
    !prefixes.any(prefix => {
      parse_prefix_text(prefix).contains(parse_prefix_text(event.prefix))
    }) {
    return
  }
  if baseline &&
    (
      event.action != "rib" ||
      event_time(event.timestamp, event.microseconds) > self.rules.from_us
    ) {
    raise Invalid(0, "基线必须是起点以前的 RIB")
  }
  let time = event_time(event.timestamp, event.microseconds)
  let key = snapshot_route_key(event)
  let peer = scoped_peer_key(
    event.peer_asn,
    event.peer_ip,
    event.outbound,
    event.source,
  )
  let late = self.latest_routes
    .get(key)
    .map(fn(t) { t > time })
    .unwrap_or(false) ||
    self.resets.get(peer).map(fn(t) { t > time }).unwrap_or(false)
  if !late {
    self.latest_routes[key] = time
    if self.latest_peers.get(peer).map(fn(t) { time > t }).unwrap_or(true) {
      self.latest_peers[peer] = time
    }
  }
  // 四倍字符数作为输入体积预算，宿主另限制派生输出体积。
  self.append(
    {
      event: Some(event),
      state: None,
      source: event.source,
      time,
      baseline,
      gap: None,
      late,
    },
    event.to_json().stringify().length() * 4 + 512,
  )
}

///|
pub fn Investigation::observe_state(
  self : Investigation,
  state : StateChange,
) -> Unit raise ParseError {
  let time = event_time(state.timestamp, state.microseconds)
  let peers = [false, true].map(fn(direction) {
    scoped_peer_key(state.peer_asn, state.peer_ip, direction, state.source)
  })
  let late = peers.any(fn(peer) {
    self.latest_peers.get(peer).map(fn(t) { t > time }).unwrap_or(false)
  })
  if !late && state.old_state == 6 && state.new_state != 6 {
    for peer in peers {
      self.resets[peer] = time
      self.latest_peers[peer] = time
    }
  }
  self.append(
    {
      event: None,
      state: Some(state),
      source: state.source,
      time,
      baseline: false,
      gap: None,
      late,
    },
    1024,
  )
}

///|
fn analysis_side_matches(
  query : AnalysisQuery,
  snapshot : RouteSnapshot?,
) -> Bool {
  let snapshot = match snapshot {
    Some(s) if s.active => s
    _ => return false
  }
  let attributes = snapshot.attributes
  if query.origin_unknown.unwrap_or(false) &&
    origin_as(attributes.path) is Some(_) {
    return false
  }
  if query.origin_asns is Some(values) &&
    !values.is_empty() &&
    !origin_as(attributes.path)
    .map(fn(asn) { values.contains(asn) })
    .unwrap_or(false) {
    return false
  }
  if query.path_asns is Some(values) &&
    !values.is_empty() &&
    !attributes.path.any(fn(segment) {
      segment.asns.any(fn(asn) { values.contains(asn) })
    }) {
    return false
  }
  if query.communities is Some(values) &&
    !values.is_empty() &&
    !attributes.communities.any(fn(value) { values.contains(value) }) {
    return false
  }
  true
}

///|
fn analysis_matches(
  query : AnalysisQuery?,
  event : InvestigationEvent,
) -> Bool raise ParseError {
  let query = match query {
    Some(q) => q
    None => return true
  }
  if query.from_us is Some(t) && event.time_us < t {
    return false
  }
  if query.to_us is Some(t) && event.time_us >= t {
    return false
  }
  if query.kind is Some(kind) &&
    event.kind != kind &&
    !event.changes.any(fn(change) { change.kind == kind }) {
    return false
  }
  if query.peer_asn is Some(asn) && asn != event.peer_asn {
    return false
  }
  if query.path_id is Some(id) && event.path_id != Some(id) {
    return false
  }
  if query.outbound is Some(direction) && direction != event.outbound {
    return false
  }
  if query.collector is Some(c) &&
    event.source.map(fn(s) { s.collector }) != Some(Some(c)) {
    return false
  }
  if query.view is Some(v) &&
    event.source.map(fn(s) { s.view }) != Some(Some(v)) {
    return false
  }
  if query.prefix is Some(prefix) {
    let parent = parse_prefix_text(prefix)
    let target = parse_prefix_text(event.prefix)
    let matches = match query.prefix_mode.unwrap_or("exact") {
      "more-specific" =>
        parent.length < target.length && parent.contains(target)
      "covering" => target.contains(parent)
      _ => parent == target
    }
    if !matches {
      return false
    }
  }
  let has_attributes = !query.origin_asns.unwrap_or([]).is_empty() ||
    !query.path_asns.unwrap_or([]).is_empty() ||
    !query.communities.unwrap_or([]).is_empty() ||
    query.origin_unknown.unwrap_or(false)
  if !has_attributes {
    return true
  }
  match query.side.unwrap_or("either") {
    "before" => analysis_side_matches(query, event.before)
    "after" => analysis_side_matches(query, event.after)
    _ =>
      analysis_side_matches(query, event.before) ||
      analysis_side_matches(query, event.after)
  }
}

///|
priv struct ChartCounts {
  mut events : Int32
  mut notices : Int32
  types : Map[String, Int32]
  notice_types : Map[String, Int32]
  prefixes : Map[String, (Int32, Int32)]
  peers : Map[String, (Int32, Int32)]
  buckets : Map[UInt64, (Int32, Int32)]
}

///|
fn chart_counts() -> ChartCounts {
  {
    events: 0,
    notices: 0,
    types: Map([]),
    notice_types: Map([]),
    prefixes: Map([]),
    peers: Map([]),
    buckets: Map([]),
  }
}

///|
fn ChartCounts::observe(
  self : ChartCounts,
  event : InvestigationEvent,
  rules : InvestigationRules,
) -> Unit {
  self.events += 1
  self.notices += event.changes.length()
  self.types[event.kind] = self.types.get(event.kind).unwrap_or(0) + 1
  for change in event.changes {
    self.notice_types[change.kind] = self.notice_types
      .get(change.kind)
      .unwrap_or(0) +
      1
  }
  for (map, key) in [(self.prefixes, event.prefix), (self.peers, event.peer)] {
    let old = map.get(key).unwrap_or((0, 0))
    map[key] = (old.0 + 1, old.1 + event.changes.length())
  }
  let bucket = rules.from_us +
    (event.time_us - rules.from_us) /
    rules.bucket_us.unwrap_or(60000000UL) *
    rules.bucket_us.unwrap_or(60000000UL)
  let old = self.buckets.get(bucket).unwrap_or((0, 0))
  self.buckets[bucket] = (old.0 + 1, old.1 + event.changes.length())
}

///|
fn chart_ranking(map : Map[String, (Int32, Int32)]) -> Json {
  let rows = map.to_array()
  rows.sort_by(fn(a, b) {
    if a.1.0 != b.1.0 {
      b.1.0.compare(a.1.0)
    } else {
      a.0.compare(b.0)
    }
  })
  Json(
    rows.map(fn(pair) {
      Json::object({
        "key": Json(pair.0),
        "events": Json(pair.1.0),
        "notices": Json(pair.1.1),
      })
    }),
  )
}

///|
fn ChartCounts::report(
  self : ChartCounts,
  scope : String,
  rules : InvestigationRules,
) -> Json {
  let buckets = []
  let mut start = rules.from_us
  while start < rules.to_us {
    let counts = self.buckets.get(start).unwrap_or((0, 0))
    let end = if rules.to_us - start < rules.bucket_us.unwrap_or(60000000UL) {
      rules.to_us
    } else {
      start + rules.bucket_us.unwrap_or(60000000UL)
    }
    let interrupted = !rules.continuous.unwrap_or(false) ||
      rules.gaps.unwrap_or([]).any(fn(g) { g.from_us < end && g.to_us > start })
    buckets.push(
      Json::object({
        "from_us": Json(start),
        "to_us": Json(end),
        "events": if interrupted {
          Json::null()
        } else {
          Json(counts.0)
        },
        "notices": if interrupted {
          Json::null()
        } else {
          Json(counts.1)
        },
        "observed_events": Json(counts.0),
        "observed_notices": Json(counts.1),
        "complete": Json(!interrupted),
      }),
    )
    start = end
  }
  Json::object({
    "scope": Json(scope),
    "events": Json(self.events),
    "notices": Json(self.notices),
    "types": Json(self.types),
    "notice_types": Json(self.notice_types),
    "prefixes": chart_ranking(self.prefixes),
    "peers": chart_ranking(self.peers),
    "buckets": Json(buckets),
    "announcement_withdrawal_basis": Json("accepted_raw_events_only"),
  })
}

///|
pub extend InvestigationGap with @json.FromJson::{from_json}

///|
pub extend InvestigationGap with ToJson::{to_json}

///|
pub extend FocusRule with @json.FromJson::{from_json}

///|
pub extend FocusRule with ToJson::{to_json}

///|
pub extend AnalysisQuery with @json.FromJson::{from_json}

///|
pub extend AnalysisQuery with ToJson::{to_json}

///|
pub extend ComparisonWindow with @json.FromJson::{from_json}

///|
pub extend ComparisonWindow with ToJson::{to_json}

///|
pub extend InvestigationRules with @json.FromJson::{from_json}

///|
pub extend InvestigationInterval with ToJson::{to_json}
