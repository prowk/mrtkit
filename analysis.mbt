///|
pub struct Change {
  schema_version : String
  timestamp : UInt
  microseconds : Int?
  prefix : String
  path_id : UInt?
  peer_asn : UInt
  peer_ip : String
  outbound : Bool
  kind : String
  source : Source?
  before : RouteSnapshot?
  after : RouteSnapshot
  diff : RouteDiff
  churn_count : Int?
} derive(ToJson)

///|
pub extend Change with ToJson::{to_json}

///|
pub struct Summary {
  schema_version : String
  baseline_status : String
  warmup_records : Int64
  records : Int64
  skipped_records : Int64
  ignored_families : Int64
  rib_routes : Int64
  announcements : Int64
  withdrawals : Int64
  path_changes : Int64
  attribute_changes : Int64
  origin_changes : Int64
  duplicate_announcements : Int64
  churn_alerts : Int64
  out_of_order : Int64
  session_resets : Int64
  tracked_routes : Int
  active_routes : Int
  mean_path_length : Double
  max_path_length : Int
} derive(ToJson)

///|
pub extend Summary with ToJson::{to_json}

///|
priv struct TrackedRoute {
  event : RouteEvent
  active : Bool
  path : Array[AsSegment]
  attributes : Attributes
  semantic : Attributes
  time : UInt64
  window_start : UInt64
  window_count : Int
}

///|
pub struct Analyzer {
  priv routes : Map[String, TrackedRoute]
  priv window : UInt64
  priv threshold : Int
  priv capacity : Int
  priv mut stats : Summary
  priv mut path_sum : Int64
  priv mut path_samples : Int64
  priv from_time : UInt64
  priv to_time : UInt64
  priv mut seeding : Bool
  priv peer_latest : Map[String, UInt64]
  priv peer_resets : Map[String, UInt64]
  priv peer_routes : Map[String, Map[String, Unit]]
}

///|
pub fn Analyzer::new(
  window_seconds? : Int = 60,
  threshold? : Int = 10,
  capacity? : Int = 1000000,
  from_time? : UInt = 0U,
  to_time? : UInt = 4294967295U,
  from_micros? : Int = 0,
  to_micros? : Int = 999999,
) -> Analyzer raise ParseError {
  if window_seconds <= 0 || threshold < 2 || capacity <= 0 {
    raise Invalid(0, "分析窗口、阈值或容量无效")
  }
  let lower = event_time(from_time, Some(from_micros))
  let upper = event_time(to_time, Some(to_micros))
  if lower > upper ||
    from_micros < 0 ||
    from_micros > 999999 ||
    to_micros < 0 ||
    to_micros > 999999 {
    raise Invalid(0, "分析时间范围无效")
  }
  {
    from_time: lower,
    to_time: upper,
    seeding: false,
    peer_latest: Map([]),
    peer_resets: Map([]),
    peer_routes: Map([]),
    routes: Map([]),
    window: window_seconds.to_uint64() * 1000000UL,
    threshold,
    capacity,
    stats: {
      schema_version: "2.0",
      baseline_status: "missing",
      warmup_records: 0L,
      records: 0L,
      skipped_records: 0L,
      ignored_families: 0L,
      rib_routes: 0L,
      announcements: 0L,
      withdrawals: 0L,
      path_changes: 0L,
      attribute_changes: 0L,
      origin_changes: 0L,
      duplicate_announcements: 0L,
      churn_alerts: 0L,
      out_of_order: 0L,
      session_resets: 0L,
      tracked_routes: 0,
      active_routes: 0,
      mean_path_length: 0.0,
      max_path_length: 0,
    },
    path_sum: 0L,
    path_samples: 0L,
  }
}

///|
fn event_time(seconds : UInt, micros : Int?) -> UInt64 {
  let fraction = match micros {
    Some(n) => n.to_uint64()
    None => 0UL
  }
  seconds.to_uint64() * 1000000UL + fraction
}

///|
pub fn Analyzer::set_baseline(self : Analyzer) -> Unit {
  self.stats = { ..self.stats, baseline_status: "explicit_rib", }
}

///|
/// 基线记录仅建立状态，不参与统计或波动计数。
pub fn Analyzer::seed(
  self : Analyzer,
  event : RouteEvent,
) -> Unit raise ParseError {
  if event.action != "rib" ||
    event_time(event.timestamp, event.microseconds) > self.from_time {
    raise Invalid(0, "初始 RIB 必须不晚于分析开始时间")
  }
  self.set_baseline()
  self.seeding = true
  errdefer {
    self.seeding = false
  }
  ignore(self.observe(event))
  self.seeding = false
}

///|
fn peer_key(asn : UInt, ip : String, outbound : Bool) -> String {
  "\{asn}|\{ip}|\{outbound}"
}

///|
fn change(
  event : RouteEvent,
  kind : String,
  previous : TrackedRoute?,
  attributes : Attributes,
  churn_count? : Int,
) -> Change {
  {
    schema_version: "2.0",
    timestamp: event.timestamp,
    microseconds: event.microseconds,
    prefix: event.prefix,
    path_id: event.path_id,
    peer_asn: event.peer_asn,
    peer_ip: event.peer_ip,
    outbound: event.outbound,
    kind,
    source: event.source,
    before: previous.map(fn(old) {
      route_snapshot(old.event, old.active, old.attributes)
    }),
    after: route_snapshot(event, event.action != "withdraw", attributes),
    diff: route_diff(
      previous.map(fn(old) { old.attributes }).unwrap_or(empty_attributes()),
      attributes,
    ),
    churn_count,
  }
}

///|
/// 每个 peer、方向和前缀单独跟踪，固定窗口内仅提醒一次波动。
pub fn Analyzer::observe(
  self : Analyzer,
  event : RouteEvent,
) -> Array[Change] raise ParseError {
  let peer = peer_key(event.peer_asn, event.peer_ip, event.outbound)
  let key = peer +
    "|" +
    event.prefix +
    "|" +
    event.path_id.map(fn(n) { n.to_string() }).unwrap_or("none")
  let time = event_time(event.timestamp, event.microseconds)
  if time > self.to_time {
    return []
  }
  let measured = !self.seeding && time >= self.from_time
  let old = self.routes.get(key)
  let reset = self.peer_resets.get(peer)
  let stale = (old is Some(previous) && time < previous.time) ||
    (reset is Some(t) && time < t)
  if !stale && old is None && self.routes.length() >= self.capacity {
    raise Invalid(0, "分析路由数量超过容量，请缩小筛选范围")
  }
  let mut stats = self.stats
  match event.action {
    "rib" => stats = { ..stats, rib_routes: stats.rib_routes + 1L, }
    "announce" => stats = { ..stats, announcements: stats.announcements + 1L, }
    "withdraw" => stats = { ..stats, withdrawals: stats.withdrawals + 1L, }
    _ => raise Invalid(0, "未知路由事件")
  }
  if measured && event.action != "withdraw" {
    let length = path_length(event.attributes.path)
    self.path_sum += length.to_int64()
    self.path_samples += 1L
    if length > stats.max_path_length {
      stats = { ..stats, max_path_length: length, }
    }
  }
  if stale {
    if measured {
      self.stats = { ..stats, out_of_order: stats.out_of_order + 1L, }
    }
    return []
  }
  if self.peer_latest.get(peer).map(fn(t) { time > t }).unwrap_or(true) {
    self.peer_latest[peer] = time
  }
  let notices = []
  let active = event.action != "withdraw"
  let semantic = if !active && old is Some(previous) {
    previous.semantic
  } else {
    semantic_attributes(event.attributes)
  }
  let mut changed = event.action == "announce"
  let mut start = time
  let mut count = 0
  let mut path = event.attributes.path
  let mut attributes = event.attributes
  if old is Some(previous) {
    path = if active { event.attributes.path } else { previous.path }
    attributes = if active { event.attributes } else { previous.attributes }
    if event.action == "announce" && previous.active {
      changed = previous.semantic != semantic
      if previous.semantic.path != semantic.path {
        stats = { ..stats, path_changes: stats.path_changes + 1L, }
        notices.push(change(event, "path_change", old, attributes))
        match (origin_as(previous.path), origin_as(path)) {
          (Some(a), Some(b)) if a != b => {
            stats = { ..stats, origin_changes: stats.origin_changes + 1L, }
            notices.push(change(event, "origin_change", old, attributes))
          }
          _ => ()
        }
      }
      let attribute_changed = { ..previous.semantic, path: [], } !=
        { ..semantic, path: [], }
      if attribute_changed {
        stats = { ..stats, attribute_changes: stats.attribute_changes + 1L, }
        notices.push(change(event, "attribute_change", old, attributes))
      }
      if !changed {
        stats = {
          ..stats,
          duplicate_announcements: stats.duplicate_announcements + 1L,
        }
      }
    }
    if event.action == "withdraw" {
      changed = previous.active
    }
    if time >= previous.window_start &&
      time - previous.window_start < self.window {
      start = previous.window_start
      count = previous.window_count
    }
  } else if event.action == "withdraw" {
    changed = false
  }
  if !measured {
    start = self.from_time
    count = 0
  }
  if measured && changed {
    count += 1
  }
  if measured && count == self.threshold && changed {
    stats = { ..stats, churn_alerts: stats.churn_alerts + 1L, }
    notices.push(change(event, "churn", old, attributes, churn_count=count))
  }
  self.routes[key] = {
    event: { ..event, attributes, },
    active,
    path,
    attributes,
    semantic,
    time,
    window_start: start,
    window_count: count,
  }
  if old is None {
    self.peer_routes.get_or_init(peer, fn() { Map([]) })[key] = ()
  }
  if measured {
    self.stats = stats
  } else if !self.seeding && self.stats.baseline_status == "missing" {
    self.stats = { ..self.stats, baseline_status: "updates_only", }
  }
  if measured {
    notices
  } else {
    []
  }
}

///|
/// 返回可审计的结束状态，顺序按状态键排序。
pub fn Analyzer::route_states(self : Analyzer) -> Array[RouteEvent] {
  let keys = self.routes.keys().to_array()
  keys.sort()
  keys.map(fn(key) {
    let state = self.routes.get(key).unwrap()
    {
      ..state.event,
      action: if state.active {
        "active"
      } else {
        "withdrawn"
      },
    }
  })
}

///|
/// 会话离开 Established 时清除该 peer 的缓存，避免跨会话误报。
pub fn Analyzer::observe_state(self : Analyzer, state : StateChange) -> Unit {
  let time = event_time(state.timestamp, state.microseconds)
  if time > self.to_time {
    return
  }
  let measured = !self.seeding && time >= self.from_time
  if state.old_state == 6 && state.new_state != 6 {
    let inbound = peer_key(state.peer_asn, state.peer_ip, false)
    let outbound = peer_key(state.peer_asn, state.peer_ip, true)
    if [inbound, outbound].any(fn(peer) {
        self.peer_latest.get(peer).map(fn(t) { t > time }).unwrap_or(false)
      }) {
      if measured {
        self.stats = {
          ..self.stats,
          out_of_order: self.stats.out_of_order + 1L,
        }
      }
      return
    }
    for peer in [inbound, outbound] {
      if self.peer_routes.get(peer) is Some(keys) {
        for key in keys.keys() {
          self.routes.remove(key)
        }
        self.peer_routes.remove(peer)
      }
      self.peer_resets[peer] = time
      self.peer_latest[peer] = time
    }
    if measured {
      self.stats = {
        ..self.stats,
        session_resets: self.stats.session_resets + 1L,
      }
    }
  }
}

///|
pub fn Analyzer::record_batch(self : Analyzer, batch : Batch) -> Unit {
  let time = event_time(batch.header.timestamp, batch.microseconds)
  if time > self.to_time {
    return
  }
  if time < self.from_time {
    self.stats = {
      ..self.stats,
      warmup_records: self.stats.warmup_records + 1L,
    }
  } else {
    let skipped = if batch.skipped { 1L } else { 0L }
    self.stats = {
      ..self.stats,
      records: self.stats.records + 1L,
      skipped_records: self.stats.skipped_records + skipped,
      ignored_families: self.stats.ignored_families +
      batch.ignored_families.to_int64(),
    }
  }
  for state in batch.states {
    self.observe_state(state)
  }
}

///|
pub fn Analyzer::summary(self : Analyzer) -> Summary {
  let mut active = 0
  for _, route in self.routes {
    if route.active {
      active += 1
    }
  }
  let mean = if self.path_samples == 0L {
    0.0
  } else {
    self.path_sum.to_double() / self.path_samples.to_double()
  }
  {
    ..self.stats,
    tracked_routes: self.routes.length(),
    active_routes: active,
    mean_path_length: mean,
  }
}
