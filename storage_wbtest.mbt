///|
test "相同属性跨前缀共享，重复替换与重置按引用回收，不丢弃撤回历史" {
  let analyzer = Analyzer::new()
  let event = sample_event(100U, "announce", [64512U, 70000U])
  for i = 0; i < 100; i = i + 1 {
    ignore(analyzer.observe({ ..event, prefix: "10.0.\{i}.0/24", }))
  }
  assert_eq(analyzer.storage_stats().unique_attribute_sets, 1)
  assert_eq(analyzer.storage_stats().attribute_references, 100)
  for i = 0; i < 100; i = i + 1 {
    ignore(
      analyzer.observe({ ..event, prefix: "10.0.\{i}.0/24", timestamp: 101U, }),
    )
  }
  assert_eq(analyzer.storage_stats().unique_attribute_sets, 1)
  assert_eq(analyzer.storage_stats().attribute_references, 100)
  ignore(
    analyzer.observe({
      ..event,
      prefix: "10.0.0.0/24",
      timestamp: 102U,
      action: "withdraw",
    }),
  )
  assert_eq(analyzer.summary().active_routes, 99)
  assert_eq(analyzer.storage_stats().attribute_references, 100)
  assert_true(analyzer.route_states()[0].attributes == event.attributes)
  analyzer.observe_state({
    source: None,
    timestamp: 103U,
    microseconds: None,
    peer_asn: event.peer_asn,
    peer_ip: event.peer_ip,
    old_state: 6,
    new_state: 1,
  })
  assert_eq(analyzer.storage_stats().unique_attribute_sets, 0)
  assert_eq(analyzer.storage_stats().attribute_references, 0)
  ignore(analyzer.observe({ ..event, timestamp: 102U, }))
  assert_eq(analyzer.storage_stats().unique_attribute_sets, 0)
}

///|
test "原始编码不同的属性不错误共享，替换最后一个引用后旧编码可回收" {
  let analyzer = Analyzer::new()
  let first = sample_event(100U, "announce", [1U])
  let a = {
    ..first,
    attributes: {
      ..first.attributes,
      raw_attributes: [{ flags: 64, code: 6, value: b"", }],
      atomic_aggregate: true,
    },
  }
  let b = {
    ..a,
    prefix: "203.0.113.0/24",
    attributes: {
      ..a.attributes,
      raw_attributes: [{ flags: 95, code: 6, value: b"", }],
    },
  }
  ignore(analyzer.observe(a))
  ignore(analyzer.observe(b))
  assert_eq(analyzer.storage_stats().unique_attribute_sets, 2)
  assert_true(
    analyzer.observe({ ..b, prefix: a.prefix, timestamp: 101U, }).is_empty(),
  )
  assert_eq(analyzer.storage_stats().unique_attribute_sets, 1)
  assert_eq(analyzer.storage_stats().attribute_references, 2)
  assert_true(
    analyzer.route_states()[0].attributes.raw_attributes ==
    b.attributes.raw_attributes,
  )
}
