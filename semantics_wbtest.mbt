///|
test "路径分段和集合顺序不产生误报" {
  let a : Array[AsSegment] = [
    { kind: 2, asns: [1U, 2U], },
    { kind: 1, asns: [3U, 4U], },
  ]
  let b : Array[AsSegment] = [
    { kind: 2, asns: [1U], },
    { kind: 2, asns: [2U], },
    { kind: 1, asns: [4U, 3U], },
  ]
  assert_true(same_path(a, b))
  assert_true(!same_path(a, [{ kind: 2, asns: [1U, 2U, 3U, 4U], }]))
  let analyzer = Analyzer::new()
  let event = sample_event(100U, "announce", [1U, 2U])
  ignore(
    analyzer.observe({ ..event, attributes: { ..event.attributes, path: a, }, }),
  )
  assert_eq(
    analyzer
    .observe({
      ..event,
      timestamp: 101U,
      attributes: { ..event.attributes, path: b, },
    })
    .length(),
    0,
  )
  assert_eq(analyzer.summary().duplicate_announcements, 1L)
}

///|
test "MP 编码中的其他前缀和社区顺序不改变路由" {
  let a = {
    ..empty_attributes(),
    communities: [1U, 2U],
    other: [{ flags: 128, code: 14, value: b"abc", }],
  }
  let b = {
    ..a,
    communities: [2U, 1U],
    other: [{ flags: 128, code: 14, value: b"def", }],
  }
  assert_true(route_attributes_equal(a, b))
  assert_true(!route_attributes_equal(a, { ..b, next_hop: Some("192.0.2.1"), }))
}
