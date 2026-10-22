///|
pub struct ObservationGap {
  from_time : UInt
  from_micros : Int
  to_time : UInt
  to_micros : Int
} derive(ToJson)

///|
pub extend ObservationGap with ToJson::{to_json}

///|
pub fn ObservationGap::new(
  from_time : UInt,
  to_time : UInt,
  from_micros? : Int = 0,
  to_micros? : Int = 0,
) -> ObservationGap {
  { from_time, to_time, from_micros, to_micros, }
}

///|
pub struct TimelineEntry {
  timestamp : UInt
  microseconds : Int?
  kind : String
  prefix : String
  path_id : UInt?
  peer_asn : UInt?
  peer_ip : String?
  outbound : Bool?
  accepted : Bool
  source : Source?
  before : RouteSnapshot?
  after : RouteSnapshot?
  changes : Array[Change]
} derive(ToJson)

///|
pub extend TimelineEntry with ToJson::{to_json}

///|
pub struct VisibilityInterval {
  scope : String
  prefix : String
  path_id : UInt?
  peer_asn : UInt
  peer_ip : String
  outbound : Bool
  started_at : UInt64
  measured_from : UInt64
  observed_until : UInt64
  recovery_time : UInt64?
  known_invisible_microseconds : UInt64?
  left_censored : Bool
  right_censored : Bool
  quality : String
  closed_by : String
  start_source : Source?
  end_source : Source?
} derive(ToJson)

///|
pub extend VisibilityInterval with ToJson::{to_json}

///|
pub struct TimelinePath {
  prefix : String
  path_id : UInt?
  peer_asn : UInt
  peer_ip : String
  outbound : Bool
  visibility : String
  observed_at : UInt64
  source : Source?
} derive(ToJson)

///|
pub extend TimelinePath with ToJson::{to_json}

///|
pub struct TimelinePeer {
  peer_asn : UInt
  peer_ip : String
  outbound : Bool
  visibility : String
  visible_paths : Int
  not_visible_paths : Int
  unobserved_paths : Int
  baseline_present : Bool
} derive(ToJson)

///|
pub extend TimelinePeer with ToJson::{to_json}

///|
pub struct TimelineReport {
  schema_version : String
  prefix : String
  interpretation : String
  baseline_status : String
  continuous_observation : Bool
  last_input_time : UInt64?
  observed_window_end : UInt64?
  gaps : Array[ObservationGap]
  entries : Array[TimelineEntry]
  intervals : Array[VisibilityInterval]
  peer_intervals : Array[VisibilityInterval]
  paths : Array[TimelinePath]
  peers : Array[TimelinePeer]
} derive(ToJson)

///|
pub extend TimelineReport with ToJson::{to_json}

///|
priv struct TracePath {
  mut event : RouteEvent
  mut visibility : String
  mut last_time : UInt64
  mut source : Source?
  mut invisible_since : UInt64?
  mut invisible_source : Source?
  mut left_censored : Bool
}

///|
pub struct Timeline {
  priv analyzer : Analyzer
  priv prefix : String
  priv continuous : Bool
  priv gaps : Array[ObservationGap]
  priv capacity : Int
  priv peer_asn : UInt?
  priv entries : Array[TimelineEntry]
  priv intervals : Array[VisibilityInterval]
  priv peer_intervals : Array[VisibilityInterval]
  priv peer_paths : Map[String, TracePath]
  priv paths : Map[String, TracePath]
  priv baselines : Map[String, (Peer, UInt64)]
  priv sessions : Map[String, (Peer, UInt64)]
  priv mut last_input : UInt64?
}

///|
pub fn Timeline::new(
  prefix : String,
  analyzer : Analyzer,
  continuous? : Bool = false,
  gaps? : Array[ObservationGap] = [],
  capacity? : Int = 1000000,
  peer_asn? : UInt,
) -> Timeline raise ParseError {
  if capacity < 1 {
    raise Invalid(0, "时间线容量必须为正数")
  }
  let sorted = gaps.copy()
  for gap in sorted {
    if gap.from_micros < 0 ||
      gap.from_micros > 999999 ||
      gap.to_micros < 0 ||
      gap.to_micros > 999999 ||
      event_time(gap.from_time, Some(gap.from_micros)) >=
      event_time(gap.to_time, Some(gap.to_micros)) {
      raise Invalid(0, "观测中断时间范围无效")
    }
  }
  sorted.sort_by_key(fn(g) { event_time(g.from_time, Some(g.from_micros)) })
  {
    analyzer,
    prefix: parse_prefix_text(prefix).text(),
    continuous,
    gaps: sorted,
    capacity,
    peer_asn,
    entries: [],
    intervals: [],
    peer_intervals: [],
    peer_paths: Map([]),
    paths: Map([]),
    baselines: Map([]),
    sessions: Map([]),
    last_input: None,
  }
}

///|
pub fn Timeline::seed_peers(
  self : Timeline,
  table : PeerTable,
  timestamp : UInt,
) -> Unit raise ParseError {
  if event_time(timestamp, None) > self.analyzer.from_time {
    raise Invalid(0, "初始 peer 表晚于时间线窗口")
  }
  for peer in table.peers {
    if self.peer_asn.map(fn(n) { n == peer.asn }).unwrap_or(true) {
      self.baselines[peer_key(peer.asn, peer.address, false)] = (
        peer,
        event_time(timestamp, None),
      )
      let time = event_time(timestamp, None)
      self.peer_paths[peer_key(peer.asn, peer.address, false)] = {
        event: {
          schema_version: "2.0",
          source: None,
          timestamp,
          microseconds: None,
          action: "baseline_absence",
          prefix: self.prefix,
          path_id: None,
          peer_asn: peer.asn,
          peer_ip: peer.address,
          outbound: false,
          originated: None,
          attributes: empty_attributes(),
        },
        visibility: "not_visible",
        last_time: time,
        source: None,
        invisible_since: Some(time),
        invisible_source: None,
        left_censored: true,
      }
    }
  }
  self.timeline_time(event_time(timestamp, None))
}

///|
fn Timeline::timeline_time(self : Timeline, time : UInt64) -> Unit {
  if self.last_input.map(fn(t) { time > t }).unwrap_or(true) {
    self.last_input = Some(time)
  }
}

///|
pub fn Timeline::seed(
  self : Timeline,
  event : RouteEvent,
) -> Unit raise ParseError {
  if event.prefix != self.prefix {
    raise Invalid(0, "时间线要求精确匹配一个前缀")
  }
  if !self.peer_asn.map(fn(n) { n == event.peer_asn }).unwrap_or(true) {
    return
  }
  if !self.paths.contains(snapshot_route_key(event)) &&
    self.paths.length() >= self.capacity {
    raise Invalid(0, "时间线路径数量超过容量")
  }
  self.analyzer.seed(event)
  self.timeline_time(event_time(event.timestamp, event.microseconds))
  self.paths[snapshot_route_key(event)] = {
    event,
    visibility: "visible",
    last_time: event_time(event.timestamp, event.microseconds),
    source: event.source,
    invisible_since: None,
    invisible_source: None,
    left_censored: false,
  }
  self.update_peer(event, seeding=true)
}

///|
fn Timeline::append(
  self : Timeline,
  entry : TimelineEntry,
) -> Unit raise ParseError {
  if self.entries.length() >= self.capacity {
    raise Invalid(0, "时间线事件数量超过容量")
  }
  self.entries.push(entry)
}

///|
fn Timeline::interval(
  self : Timeline,
  trace : TracePath,
  until : UInt64,
  closed_by : String,
  end_source : Source?,
  scope? : String = "path",
) -> VisibilityInterval? {
  let since = match trace.invisible_since {
    Some(t) => t
    None => return None
  }
  let start = if since > self.analyzer.from_time {
    since
  } else {
    self.analyzer.from_time
  }
  let end = if until < self.analyzer.to_time {
    until
  } else {
    self.analyzer.to_time
  }
  if end < start {
    return None
  }
  let interrupted = self.gaps.any(fn(g) {
    event_time(g.from_time, Some(g.from_micros)) < end &&
    event_time(g.to_time, Some(g.to_micros)) > since
  })
  let recovered = closed_by == "announce" && until <= self.analyzer.to_time
  let event = trace.event
  Some({
    scope,
    prefix: event.prefix,
    path_id: event.path_id,
    peer_asn: event.peer_asn,
    peer_ip: event.peer_ip,
    outbound: event.outbound,
    started_at: since,
    measured_from: start,
    observed_until: end,
    recovery_time: if recovered {
      Some(until)
    } else {
      None
    },
    known_invisible_microseconds: if self.continuous && !interrupted {
      Some(end - start)
    } else {
      None
    },
    left_censored: trace.left_censored || since < self.analyzer.from_time,
    right_censored: !recovered,
    quality: if interrupted {
      "observation_gap"
    } else if !self.continuous {
      "continuity_unverified"
    } else {
      "observed_route_visibility_only"
    },
    closed_by,
    start_source: trace.invisible_source,
    end_source,
  })
}

///|
pub fn Timeline::observe(
  self : Timeline,
  event : RouteEvent,
) -> Unit raise ParseError {
  if event.prefix != self.prefix {
    raise Invalid(0, "时间线要求精确匹配一个前缀")
  }
  let time = event_time(event.timestamp, event.microseconds)
  self.timeline_time(time)
  if !self.peer_asn.map(fn(n) { n == event.peer_asn }).unwrap_or(true) {
    return
  }
  if time > self.analyzer.to_time {
    return
  }
  let key = snapshot_route_key(event)
  let peer = peer_key(event.peer_asn, event.peer_ip, event.outbound)
  let old = self.analyzer.routes.get(key)
  let stale = old.map(fn(r) { time < r.time }).unwrap_or(false) ||
    self.analyzer.peer_resets.get(peer).map(fn(t) { time < t }).unwrap_or(false)
  let changes = self.analyzer.observe(event)
  let measured = time >= self.analyzer.from_time
  if stale {
    if measured {
      self.append({
        timestamp: event.timestamp,
        microseconds: event.microseconds,
        kind: "out_of_order",
        prefix: event.prefix,
        path_id: event.path_id,
        peer_asn: Some(event.peer_asn),
        peer_ip: Some(event.peer_ip),
        outbound: Some(event.outbound),
        accepted: false,
        source: event.source,
        before: None,
        after: None,
        changes: [],
      })
    }
    return
  }
  if !self.paths.contains(key) && self.paths.length() >= self.capacity {
    raise Invalid(0, "时间线路径数量超过容量")
  }
  let baseline = if self.analyzer.peer_resets.contains(peer) {
    None
  } else {
    self.baselines.get(peer)
  }
  let trace = self.paths.get_or_init(key, fn() {
    {
      event,
      visibility: if baseline is Some(_) {
        "not_visible"
      } else {
        "unobserved"
      },
      last_time: baseline.map(fn(b) { b.1 }).unwrap_or(time),
      source: None,
      invisible_since: baseline.map(fn(b) { b.1 }),
      invisible_source: None,
      left_censored: true,
    }
  })
  if self.gaps.any(fn(g) {
      event_time(g.from_time, Some(g.from_micros)) <= time &&
      event_time(g.to_time, Some(g.to_micros)) > trace.last_time
    }) {
    if self.interval(trace, time, "observation_gap", event.source)
      is Some(interval) {
      self.intervals.push(interval)
    }
    trace.invisible_since = None
    trace.visibility = "unobserved"
  }
  let kind = if event.action == "withdraw" {
    "withdraw"
  } else if event.action == "rib" {
    "rib"
  } else if old is Some(previous) && !previous.active {
    "reannounce"
  } else if changes.any(fn(c) { c.kind == "path_change" }) {
    "path_change"
  } else if changes.any(fn(c) { c.kind == "attribute_change" }) {
    "attribute_change"
  } else {
    "announce"
  }
  if event.action != "withdraw" {
    if self.interval(trace, time, "announce", event.source) is Some(interval) {
      self.intervals.push(interval)
    }
    trace.invisible_since = None
    trace.invisible_source = None
    trace.visibility = "visible"
  } else {
    if trace.invisible_since is None {
      trace.invisible_since = Some(time)
      trace.invisible_source = event.source
      trace.left_censored = trace.visibility != "visible"
    }
    trace.visibility = "not_visible"
  }
  trace.event = event
  trace.last_time = time
  trace.source = event.source
  self.update_peer(event)
  if measured {
    let next = self.analyzer.routes.get(key).unwrap()
    self.append({
      timestamp: event.timestamp,
      microseconds: event.microseconds,
      kind,
      prefix: event.prefix,
      path_id: event.path_id,
      peer_asn: Some(event.peer_asn),
      peer_ip: Some(event.peer_ip),
      outbound: Some(event.outbound),
      accepted: true,
      source: event.source,
      before: old.map(fn(r) { route_snapshot(r.event, r.active, r.shared.wire) }),
      after: Some(route_snapshot(next.event, next.active, next.shared.wire)),
      changes,
    })
  }
}

///|
pub fn Timeline::record_batch(
  self : Timeline,
  batch : Batch,
) -> Unit raise ParseError {
  let time = event_time(batch.header.timestamp, batch.microseconds)
  self.timeline_time(time)
  self.analyzer.record_batch({ ..batch, states: [], })
  for state in batch.states {
    let state_time = event_time(state.timestamp, state.microseconds)
    let reset = state.old_state == 6 && state.new_state != 6
    let stale = [false, true].any(fn(direction) {
      self.analyzer.peer_latest
      .get(peer_key(state.peer_asn, state.peer_ip, direction))
      .map(fn(t) { t > state_time })
      .unwrap_or(false)
    })
    self.analyzer.observe_state(state)
    if !reset ||
      state_time > self.analyzer.to_time ||
      stale ||
      !self.peer_asn.map(fn(n) { n == state.peer_asn }).unwrap_or(true) {
      continue
    }
    self.sessions[peer_key(state.peer_asn, state.peer_ip, false)] = (
      { bgp_id: 0U, asn: state.peer_asn, address: state.peer_ip, },
      state_time,
    )
    for _, trace in self.paths {
      if trace.event.peer_asn == state.peer_asn &&
        trace.event.peer_ip == state.peer_ip {
        if self.interval(trace, state_time, "session_reset", state.source)
          is Some(interval) {
          self.intervals.push(interval)
        }
        trace.invisible_since = None
        trace.visibility = "unobserved"
        trace.last_time = state_time
        trace.source = state.source
      }
    }
    for _, trace in self.peer_paths {
      if trace.event.peer_asn == state.peer_asn &&
        trace.event.peer_ip == state.peer_ip {
        if self.interval(
            trace,
            state_time,
            "session_reset",
            state.source,
            scope="peer_prefix",
          )
          is Some(interval) {
          self.peer_intervals.push(interval)
        }
        trace.invisible_since = None
        trace.visibility = "unobserved"
        trace.last_time = state_time
        trace.source = state.source
      }
    }
    if state_time >= self.analyzer.from_time {
      self.append({
        timestamp: state.timestamp,
        microseconds: state.microseconds,
        kind: "session_reset",
        prefix: self.prefix,
        path_id: None,
        peer_asn: Some(state.peer_asn),
        peer_ip: Some(state.peer_ip),
        outbound: None,
        accepted: true,
        source: state.source,
        before: None,
        after: None,
        changes: [],
      })
    }
  }
}

///|
/// peer 可见性取所选路径的并集，撤回单条 ADD-PATH 不代表前缀消失。
fn Timeline::update_peer(
  self : Timeline,
  event : RouteEvent,
  seeding? : Bool = false,
) -> Unit {
  let peer = peer_key(event.peer_asn, event.peer_ip, event.outbound)
  let time = event_time(event.timestamp, event.microseconds)
  let mut visible = false
  let mut unknown = false
  let mut addpath = false
  for _, path in self.paths {
    if peer_key(path.event.peer_asn, path.event.peer_ip, path.event.outbound) !=
      peer {
      continue
    }
    let interrupted = self.gaps.any(fn(g) {
      event_time(g.from_time, Some(g.from_micros)) <= time &&
      event_time(g.to_time, Some(g.to_micros)) > path.last_time
    })
    let state = if interrupted { "unobserved" } else { path.visibility }
    if state == "visible" {
      visible = true
    }
    if state == "unobserved" {
      unknown = true
    }
    if path.event.path_id is Some(_) {
      addpath = true
    }
  }
  let full_baseline = self.baselines.contains(peer) &&
    !self.analyzer.peer_resets.contains(peer)
  let next = if visible {
    "visible"
  } else if unknown || (addpath && !full_baseline) {
    "unobserved"
  } else {
    "not_visible"
  }
  let trace = self.peer_paths.get_or_init(peer, fn() {
    {
      event: { ..event, path_id: None, },
      visibility: "unobserved",
      last_time: time,
      source: None,
      invisible_since: None,
      invisible_source: None,
      left_censored: true,
    }
  })
  let interrupted = self.gaps.any(fn(g) {
    event_time(g.from_time, Some(g.from_micros)) <= time &&
    event_time(g.to_time, Some(g.to_micros)) > trace.last_time
  })
  if interrupted {
    if !seeding &&
      self.interval(
        trace,
        time,
        "observation_gap",
        event.source,
        scope="peer_prefix",
      )
      is Some(interval) {
      self.peer_intervals.push(interval)
    }
    trace.invisible_since = None
    trace.visibility = "unobserved"
  }
  if next != "not_visible" {
    if !seeding &&
      self.interval(
        trace,
        time,
        if next == "visible" {
          "announce"
        } else {
          "observation_gap"
        },
        event.source,
        scope="peer_prefix",
      )
      is Some(interval) {
      self.peer_intervals.push(interval)
    }
    trace.invisible_since = None
  } else if trace.invisible_since is None {
    trace.invisible_since = Some(time)
    trace.invisible_source = event.source
    trace.left_censored = trace.visibility != "visible"
  }
  trace.event = { ..event, path_id: None, }
  trace.visibility = next
  trace.last_time = time
  trace.source = event.source
}

///|
fn Timeline::visibility(
  self : Timeline,
  since : UInt64,
  visibility : String,
  until : UInt64,
) -> String {
  if until < self.analyzer.from_time ||
    self.gaps.any(fn(g) {
      event_time(g.to_time, Some(g.to_micros)) > since &&
      event_time(g.from_time, Some(g.from_micros)) <= until
    }) {
    "unobserved"
  } else {
    visibility
  }
}

///|
pub fn Timeline::report(self : Timeline) -> TimelineReport raise ParseError {
  let end = self.last_input.unwrap_or(0UL)
  let until = if end < self.analyzer.to_time {
    end
  } else {
    self.analyzer.to_time
  }
  let entries = self.entries.copy()
  for gap in self.gaps {
    let time = event_time(gap.from_time, Some(gap.from_micros))
    if time >= self.analyzer.from_time && time <= until {
      entries.push({
        timestamp: gap.from_time,
        microseconds: Some(gap.from_micros),
        kind: "observation_gap",
        prefix: self.prefix,
        path_id: None,
        peer_asn: None,
        peer_ip: None,
        outbound: None,
        accepted: true,
        source: None,
        before: None,
        after: None,
        changes: [],
      })
    }
  }
  if entries.length() > self.capacity {
    raise Invalid(0, "时间线事件数量超过容量")
  }
  entries.sort_by_key(fn(e) {
    (
      event_time(e.timestamp, e.microseconds),
      e.source.map(fn(s) { s.file }).unwrap_or(""),
      e.source.map(fn(s) { s.record }).unwrap_or(0L),
      e.source.map(fn(s) { s.event_index }).unwrap_or(0),
      e.kind,
    )
  })
  let intervals = self.intervals.copy()
  let peer_intervals = self.peer_intervals.copy()
  for _, trace in self.peer_paths {
    if self.interval(trace, until, "observation_end", None, scope="peer_prefix")
      is Some(interval) {
      peer_intervals.push(interval)
    }
  }
  let paths = []
  let peers : Map[String, TimelinePeer] = Map([])
  for key, pair in self.baselines {
    peers[key] = {
      peer_asn: pair.0.asn,
      peer_ip: pair.0.address,
      outbound: false,
      visibility: self.visibility(pair.1, "not_visible", until),
      visible_paths: 0,
      not_visible_paths: 0,
      unobserved_paths: 0,
      baseline_present: true,
    }
  }
  for key, pair in self.sessions {
    peers[key] = {
      peer_asn: pair.0.asn,
      peer_ip: pair.0.address,
      outbound: false,
      visibility: "unobserved",
      visible_paths: 0,
      not_visible_paths: 0,
      unobserved_paths: 0,
      baseline_present: self.baselines.contains(key),
    }
  }
  let keys = self.paths.keys().to_array()
  keys.sort()
  for key in keys {
    let trace = self.paths.get(key).unwrap()
    if self.interval(trace, until, "observation_end", None) is Some(interval) {
      intervals.push(interval)
    }
    let event = trace.event
    let visibility = self.visibility(trace.last_time, trace.visibility, until)
    paths.push({
      prefix: event.prefix,
      path_id: event.path_id,
      peer_asn: event.peer_asn,
      peer_ip: event.peer_ip,
      outbound: event.outbound,
      visibility,
      observed_at: trace.last_time,
      source: trace.source,
    })
    let peer = peer_key(event.peer_asn, event.peer_ip, event.outbound)
    let old = peers
      .get(peer)
      .unwrap_or({
        peer_asn: event.peer_asn,
        peer_ip: event.peer_ip,
        outbound: event.outbound,
        visibility: "unobserved",
        visible_paths: 0,
        not_visible_paths: 0,
        unobserved_paths: 0,
        baseline_present: false,
      })
    let active = old.visible_paths +
      (if visibility == "visible" { 1 } else { 0 })
    let absent = old.not_visible_paths +
      (if visibility == "not_visible" { 1 } else { 0 })
    let unknown = old.unobserved_paths +
      (if visibility == "unobserved" { 1 } else { 0 })
    peers[peer] = {
      ..old,
      visible_paths: active,
      not_visible_paths: absent,
      unobserved_paths: unknown,
      visibility: if active > 0 {
        "visible"
      } else if unknown > 0 {
        "unobserved"
      } else {
        "not_visible"
      },
    }
  }
  intervals.sort_by_key(fn(i) {
    (i.measured_from, i.peer_asn, i.peer_ip, i.outbound, i.prefix, i.path_id)
  })
  let peer_keys = peers.keys().to_array()
  peer_keys.sort()
  peer_intervals.sort_by_key(fn(i) {
    (i.measured_from, i.peer_asn, i.peer_ip, i.outbound)
  })
  {
    schema_version: "2.0",
    prefix: self.prefix,
    interpretation: "collector_route_visibility_not_business_outage",
    baseline_status: self.analyzer.summary().baseline_status,
    continuous_observation: self.continuous,
    last_input_time: self.last_input,
    observed_window_end: if until >= self.analyzer.from_time {
      Some(until)
    } else {
      None
    },
    gaps: self.gaps,
    entries,
    intervals,
    peer_intervals,
    paths,
    peers: peer_keys.map(fn(k) {
      let peer = peers.get(k).unwrap()
      if self.peer_paths.get(k) is Some(trace) {
        {
          ..peer,
          visibility: self.visibility(trace.last_time, trace.visibility, until),
        }
      } else {
        peer
      }
    }),
  }
}
