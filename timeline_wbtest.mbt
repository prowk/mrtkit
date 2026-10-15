///|
test "时间线区分已知不可见时长与缺少连续观测声明" {
  for continuous in [true, false] {
    let analyzer = Analyzer::new(from_time=100U, to_time=110U)
    let timeline = Timeline::new("192.0.2.0/24", analyzer, continuous~)
    timeline.observe(sample_event(100U, "announce", [1U]))
    timeline.observe(sample_event(101U, "withdraw", []))
    timeline.observe(sample_event(104U, "announce", [2U]))
    let report = timeline.report()
    assert_eq(report.entries.map(fn(e) { e.kind }), [
      "announce", "withdraw", "reannounce",
    ])
    assert_eq(report.peer_intervals[0].scope, "peer_prefix")
    assert_eq(
      report.peer_intervals[0].known_invisible_microseconds,
      if continuous {
        Some(3000000UL)
      } else {
        None
      },
    )
    assert_eq(report.peers[0].visibility, "visible")
    assert_eq(analyzer.summary().active_routes, 1)
  }
}

///|
test "时间线的观测中断与微秒边界不冒充完整恢复区间" {
  let analyzer = Analyzer::new(from_time=100U, to_time=110U)
  let timeline = Timeline::new("192.0.2.0/24", analyzer, continuous=true, gaps=[
    ObservationGap::new(101U, 102U),
  ])
  timeline.observe(sample_event(100U, "withdraw", []))
  timeline.observe(sample_event(103U, "announce", [1U]))
  let report = timeline.report()
  assert_eq(report.intervals[0].quality, "observation_gap")
  assert_eq(report.intervals[0].known_invisible_microseconds, None)
  assert_true(report.intervals[0].right_censored)
  assert_eq(report.entries[1].kind, "observation_gap")
}
