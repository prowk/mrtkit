///|
pub struct Change {
  timestamp : UInt
  prefix : String
  peer_asn : UInt
  peer_ip : String
  outbound : Bool
  kind : String
  before : String
  after : String
} derive(ToJson)

///|
pub extend Change with ToJson::{to_json}

///|
pub struct Summary {
  records : Int64
  skipped_records : Int64
  ignored_families : Int64
  rib_routes : Int64
  announcements : Int64
  withdrawals : Int64
  path_changes : Int64
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
  peer : String
  active : Bool
  path : Array[AsSegment]
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
}

///|
pub fn Analyzer::new(
  window_seconds? : Int = 60,
  threshold? : Int = 10,
  capacity? : Int = 1000000,
) -> Analyzer raise ParseError {
  if window_seconds <= 0 || threshold < 2 || capacity <= 0 {
    raise Invalid(0, "分析窗口、阈值或容量无效")
  }
  {
    routes: Map([]),
    window: window_seconds.to_uint64() * 1000000UL,
    threshold,
    capacity,
    stats: {
      records: 0L,
      skipped_records: 0L,
      ignored_families: 0L,
      rib_routes: 0L,
      announcements: 0L,
      withdrawals: 0L,
      path_changes: 0L,
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
fn peer_key(asn : UInt, ip : String, outbound : Bool) -> String {
  "\{asn}|\{ip}|\{outbound}"
}

///|
fn change(
  event : RouteEvent,
  kind : String,
  before : String,
  after : String,
) -> Change {
  {
    timestamp: event.timestamp,
    prefix: event.prefix,
    peer_asn: event.peer_asn,
    peer_ip: event.peer_ip,
    outbound: event.outbound,
    kind,
    before,
    after,
  }
}

///|
/// 每个 peer、方向和前缀单独跟踪，固定窗口内仅提醒一次波动。
pub fn Analyzer::observe(
  self : Analyzer,
  event : RouteEvent,
) -> Array[Change] raise ParseError {
  let peer = peer_key(event.peer_asn, event.peer_ip, event.outbound)
  let key = peer + "|" + event.prefix
  let micros = match event.microseconds {
    Some(n) => n.to_uint64()
    None => 0UL
  }
  let time = event.timestamp.to_uint64() * 1000000UL + micros
  let old = self.routes.get(key)
  if old is None && self.routes.length() >= self.capacity {
    raise Invalid(0, "分析路由数量超过容量，请缩小筛选范围")
  }
  let mut stats = self.stats
  match event.action {
    "rib" => stats = { ..stats, rib_routes: stats.rib_routes + 1L, }
    "announce" => stats = { ..stats, announcements: stats.announcements + 1L, }
    "withdraw" => stats = { ..stats, withdrawals: stats.withdrawals + 1L, }
    _ => raise Invalid(0, "未知路由事件")
  }
  if event.action != "withdraw" {
    let length = path_length(event.attributes.path)
    self.path_sum += length.to_int64()
    self.path_samples += 1L
    if length > stats.max_path_length {
      stats = { ..stats, max_path_length: length, }
    }
  }
  if old is Some(previous) && time < previous.time {
    self.stats = { ..stats, out_of_order: stats.out_of_order + 1L, }
    return []
  }
  let notices = []
  let active = event.action != "withdraw"
  let mut changed = event.action == "announce"
  let mut start = time
  let mut count = 0
  let mut path = event.attributes.path
  if old is Some(previous) {
    path = if active { event.attributes.path } else { previous.path }
    if event.action == "announce" && previous.active {
      changed = previous.path != path
      if changed {
        stats = { ..stats, path_changes: stats.path_changes + 1L, }
        notices.push(
          change(
            event,
            "path_change",
            path_text(previous.path),
            path_text(path),
          ),
        )
        match (origin_as(previous.path), origin_as(path)) {
          (Some(a), Some(b)) if a != b => {
            stats = { ..stats, origin_changes: stats.origin_changes + 1L, }
            notices.push(
              change(event, "origin_change", a.to_string(), b.to_string()),
            )
          }
          _ => ()
        }
      } else {
        stats = {
          ..stats,
          duplicate_announcements: stats.duplicate_announcements + 1L,
        }
      }
    }
    if event.action == "withdraw" {
      changed = previous.active
    }
    if time - previous.window_start < self.window {
      start = previous.window_start
      count = previous.window_count
    }
  } else if event.action == "withdraw" {
    changed = false
  }
  if changed {
    count += 1
  }
  if count == self.threshold && changed {
    stats = { ..stats, churn_alerts: stats.churn_alerts + 1L, }
    notices.push(
      change(event, "churn", "", "固定窗口内达到 \{count} 次变化"),
    )
  }
  self.routes[key] = {
    peer,
    active,
    path,
    time,
    window_start: start,
    window_count: count,
  }
  self.stats = stats
  notices
}

///|
/// 会话离开 Established 时清除该 peer 的缓存，避免跨会话误报。
pub fn Analyzer::observe_state(self : Analyzer, state : StateChange) -> Unit {
  if state.old_state == 6 && state.new_state != 6 {
    let inbound = peer_key(state.peer_asn, state.peer_ip, false)
    let outbound = peer_key(state.peer_asn, state.peer_ip, true)
    let keys = []
    for key, route in self.routes {
      if route.peer == inbound || route.peer == outbound {
        keys.push(key)
      }
    }
    for key in keys {
      self.routes.remove(key)
    }
    self.stats = {
      ..self.stats,
      session_resets: self.stats.session_resets + 1L,
    }
  }
}

///|
pub fn Analyzer::record_batch(self : Analyzer, batch : Batch) -> Unit {
  let skipped = if batch.skipped { 1L } else { 0L }
  self.stats = {
    ..self.stats,
    records: self.stats.records + 1L,
    skipped_records: self.stats.skipped_records + skipped,
    ignored_families: self.stats.ignored_families +
    batch.ignored_families.to_int64(),
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
