///|
test "重复宣告、起源变化和波动阈值" {
  let analyzer = Analyzer::new(threshold=3)
  let first = sample_event(100U, "announce", [64512U, 65536U])
  assert_eq(analyzer.observe(first).length(), 0)
  assert_eq(analyzer.observe({ ..first, timestamp: 101U, }).length(), 0)
  let second = sample_event(102U, "announce", [64512U, 65537U])
  assert_eq(analyzer.observe(second).length(), 2)
  assert_eq(
    analyzer.observe({ ..second, timestamp: 103U, action: "withdraw", })[0].kind,
    "churn",
  )
  let stats = analyzer.summary()
  assert_eq(stats.origin_changes, 1L)
  assert_eq(stats.duplicate_announcements, 1L)
  assert_eq(stats.churn_alerts, 1L)
  assert_eq(stats.active_routes, 0)
}

///|
test "peer 隔离、乱序及会话重置" {
  let analyzer = Analyzer::new()
  let event = sample_event(100U, "announce", [65536U])
  ignore(analyzer.observe(event))
  assert_eq(
    analyzer
    .observe({
      ..event,
      peer_ip: "198.51.100.2",
      attributes: { ..event.attributes, path: [{ kind: 2, asns: [65537U], }], },
    })
    .length(),
    0,
  )
  ignore(analyzer.observe({ ..event, timestamp: 99U, action: "withdraw", }))
  assert_eq(analyzer.summary().out_of_order, 1L)
  assert_eq(analyzer.summary().active_routes, 2)
  analyzer.observe_state({
    timestamp: 101U,
    peer_asn: event.peer_asn,
    peer_ip: event.peer_ip,
    old_state: 6,
    new_state: 1,
  })
  assert_eq(analyzer.summary().active_routes, 1)
}

///|
test "分析容量不会静默丢弃状态" {
  let analyzer = Analyzer::new(capacity=1)
  let event = sample_event(100U, "announce", [65536U])
  ignore(analyzer.observe(event))
  assert_true(
    try {
      ignore(analyzer.observe({ ..event, prefix: "203.0.113.0/24", }))
      false
    } catch {
      _ => true
    },
  )
}
