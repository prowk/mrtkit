///|
test "RIB 和窗口前更新只建立基线" {
  let analyzer = Analyzer::new(from_time=100U, to_time=102U, threshold=2)
  analyzer.seed(sample_event(90U, "rib", [1U]))
  assert_eq(analyzer.observe(sample_event(99U, "announce", [2U])).length(), 0)
  let changes = analyzer.observe(sample_event(100U, "announce", [3U]))
  assert_eq(changes.length(), 2)
  assert_eq(changes[0].before.unwrap().attributes.path[0].asns[0], 2U)
  let stats = analyzer.summary()
  assert_eq(stats.rib_routes, 0L)
  assert_eq(stats.announcements, 1L)
  assert_eq(stats.churn_alerts, 0L)
  assert_eq(stats.baseline_status, "explicit_rib")
  ignore(analyzer.observe(sample_event(103U, "withdraw", [])))
  assert_eq(analyzer.summary().active_routes, 1)
  assert_eq(analyzer.summary().withdrawals, 0L)
}

///|
test "会话和路由共用微秒边界且重置后拒绝过期宣告" {
  let analyzer = Analyzer::new(
    from_time=100U,
    to_time=100U,
    from_micros=500,
    to_micros=700,
  )
  let event = {
    ..sample_event(100U, "announce", [1U]),
    microseconds: Some(400),
  }
  ignore(analyzer.observe(event))
  let state : StateChange = {
    source: None,
    timestamp: 100U,
    microseconds: Some(450),
    peer_asn: event.peer_asn,
    peer_ip: event.peer_ip,
    old_state: 6,
    new_state: 1,
  }
  analyzer.observe_state(state)
  assert_eq(analyzer.summary().session_resets, 0L)
  assert_eq(analyzer.summary().active_routes, 0)
  ignore(analyzer.observe({ ..event, microseconds: Some(430), }))
  assert_eq(analyzer.summary().active_routes, 0)
  ignore(analyzer.observe({ ..event, microseconds: Some(500), }))
  analyzer.observe_state({ ..state, microseconds: Some(701), })
  assert_eq(analyzer.summary().active_routes, 1)
  analyzer.observe_state({ ..state, microseconds: Some(700), })
  assert_eq(analyzer.summary().active_routes, 0)
  assert_eq(analyzer.summary().session_resets, 1L)
  assert_eq(analyzer.summary().announcements, 1L)
}

///|
test "缺少基线明确标识且未来 RIB 不可加载" {
  let analyzer = Analyzer::new(from_time=100U)
  assert_eq(analyzer.summary().baseline_status, "missing")
  assert_true(
    try {
      analyzer.seed(sample_event(101U, "rib", [1U]))
      false
    } catch {
      _ => true
    },
  )
  ignore(analyzer.observe(sample_event(99U, "announce", [1U])))
  assert_eq(analyzer.summary().baseline_status, "updates_only")
}
