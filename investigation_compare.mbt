///|
fn overlap_us(
  a : UInt64,
  b : UInt64,
  window : ComparisonWindow,
) -> (UInt64, UInt64)? {
  let start = if a > window.from_us { a } else { window.from_us }
  let end = if b < window.to_us { b } else { window.to_us }
  if start < end {
    Some((start, end))
  } else {
    None
  }
}

///|
fn confirmed_peer_time(
  intervals : Array[InvestigationInterval],
  peer : String,
  window : ComparisonWindow,
) -> UInt64 {
  let ranges = []
  for interval in intervals {
    if interval.peer == peer && interval.duration_us is Some(_) {
      if overlap_us(interval.from_us, interval.to_us, window) is Some(range) {
        ranges.push(range)
      }
    }
  }
  ranges.sort()
  let mut total = 0UL
  let mut end = window.from_us
  for range in ranges {
    let start = if range.0 > end { range.0 } else { end }
    if range.1 > start {
      total += range.1 - start
    }
    if range.1 > end {
      end = range.1
    }
  }
  total
}

///|
fn investigation_comparison(
  events : Array[InvestigationEvent],
  intervals : Array[InvestigationInterval],
  rules : InvestigationRules,
) -> Json {
  let windows = match rules.comparison {
    Some(w) => w
    None => return Json::object({ "status": Json("not_configured") })
  }
  let resource = rules.sequence_prefix.unwrap_or("")
  let intervals = intervals.filter(fn(row) { row.prefix == resource })
  let peers : Map[String, Unit] = Map([])
  for interval in intervals {
    peers[interval.peer] = ()
  }
  let common = peers
    .keys()
    .to_array()
    .filter(fn(peer) {
      confirmed_peer_time(intervals, peer, windows[0]) > 0UL &&
      confirmed_peer_time(intervals, peer, windows[1]) > 0UL
    })
  common.sort()
  let reports = []
  for window in windows {
    let mut duration = 0UL
    let mut changes = 0
    let lengths : Map[Int32, Int32] = Map([])
    let origins : Map[UInt32, Unit] = Map([])
    for peer in common {
      duration += confirmed_peer_time(intervals, peer, window)
    }
    for event in events {
      if !event.accepted ||
        event.prefix != resource ||
        !common.contains(event.peer) ||
        event.time_us < window.from_us ||
        event.time_us >= window.to_us {
        continue
      }
      if event.changes_state {
        changes += 1
      }
      if event.after is Some(snapshot) && snapshot.active {
        let length = path_length(snapshot.attributes.path)
        lengths[length] = lengths.get(length).unwrap_or(0) + 1
        if origin_as(snapshot.attributes.path) is Some(asn) {
          origins[asn] = ()
        }
      }
    }
    for interval in intervals {
      if common.contains(interval.peer) &&
        overlap_us(interval.from_us, interval.to_us, window) is Some(_) {
        if interval.origin_as is Some(asn) {
          origins[asn] = ()
        }
      }
    }
    let ordered = origins.keys().to_array()
    ordered.sort()
    let histogram = lengths.to_array()
    histogram.sort_by_key(fn(pair) { pair.0 })
    reports.push(
      Json::object({
        "from_us": Json(window.from_us),
        "to_us": Json(window.to_us),
        "window_us": Json(window.to_us - window.from_us),
        "confirmed_peer_us": Json(duration),
        "changed_events": Json(changes),
        "frequency_per_peer_second": if duration > 0UL {
          Json(changes.to_double() * 1000000.0 / duration.to_double())
        } else {
          Json::null()
        },
        "path_length_samples": Json(histogram),
        "origins": Json(ordered),
        "coverage_peers": Json(common.length()),
      }),
    )
  }
  Json::object({
    "status": Json(
      if common.is_empty() {
        "not_computable"
      } else {
        "comparable_observations"
      },
    ),
    "resource": Json(resource),
    "common_peers": Json(common),
    "windows": Json(reports),
    "baseline_quality": Json("see_bundle_quality"),
    "interpretation": Json(
      "coverage_normalized_observations_not_route_anomaly_verdict",
    ),
  })
}
