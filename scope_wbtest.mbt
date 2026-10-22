///|
fn scoped_sample(
  collector : String,
  view : String,
  time : UInt,
  asn : UInt,
) -> RouteEvent {
  {
    ..sample_event(time, "announce", [asn]),
    path_id: Some(0U),
    source: Some({
      file: "same.mrt",
      record: 1L,
      offset: 0L,
      event_index: 0,
      collector: Some(collector),
      view: Some(view),
    }),
  }
}

///|
test "同名 peer 前缀与路径 ID 的采集器和视图状态独立，会话只重置匹配身份" {
  let analyzer = Analyzer::new()
  let a = scoped_sample("collector-a", "view", 100U, 1U)
  let b = scoped_sample("collector-b", "view", 100U, 2U)
  let c = scoped_sample("collector-a", "another-view", 100U, 3U)
  for event in [a, b, c] {
    assert_true(analyzer.observe(event).is_empty())
  }
  assert_eq(analyzer.summary().active_routes, 3)
  let changes = analyzer.observe(scoped_sample("collector-a", "view", 101U, 4U))
  assert_eq(changes[0].before.unwrap().attributes.path[0].asns[0], 1U)
  assert_eq(changes[0].source.unwrap().collector, Some("collector-a"))
  analyzer.observe_state({
    source: a.source,
    timestamp: 102U,
    microseconds: None,
    peer_asn: a.peer_asn,
    peer_ip: a.peer_ip,
    old_state: 6,
    new_state: 1,
  })
  assert_eq(analyzer.summary().active_routes, 2)
  ignore(analyzer.observe({ ..a, timestamp: 101U, }))
  assert_eq(analyzer.summary().active_routes, 2)
  assert_eq(analyzer.summary().out_of_order, 1L)
  assert_true(
    analyzer
    .route_states()
    .all(fn(event) {
      event.source.unwrap().collector == Some("collector-b") ||
      event.source.unwrap().view == Some("another-view")
    }),
  )
}

///|
test "来源身份在聚合和去重中保留，含分隔符的名称不会碰撞" {
  let analyzer = Analyzer::new()
  let aggregation = Aggregation::new()
  for (collector, view) in [("a|b", "c"), ("a", "b|c")] {
    ignore(analyzer.observe(scoped_sample(collector, view, 100U, 1U)))
    for change in analyzer.observe(scoped_sample(collector, view, 101U, 2U)) {
      aggregation.observe(change)
    }
  }
  let report = aggregation.report()
  assert_eq(report.affected_peers, 2)
  assert_eq(report.top_prefixes[0].changed_events, 2)
  assert_eq(analyzer.storage_stats().route_keys, 2)
}

///|
test "单前缀时间线拒绝混用采集器，避免伪造观测连续性" {
  let analyzer = Analyzer::new()
  let timeline = Timeline::new("192.0.2.0/24", analyzer)
  timeline.observe(scoped_sample("a", "default", 100U, 1U))
  assert_true(
    try {
      timeline.observe(scoped_sample("b", "default", 101U, 2U))
      false
    } catch {
      _ => true
    },
  )
  assert_eq(analyzer.summary().active_routes, 1)
}
