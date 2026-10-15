///|
test "属性变化不能误计为重复宣告" {
  let analyzer = Analyzer::new()
  let first = sample_event(100U, "announce", [65536U])
  ignore(analyzer.observe(first))
  let next = {
    ..first,
    timestamp: 101U,
    attributes: { ..first.attributes, next_hop: Some("192.0.2.1"), },
  }
  assert_eq(analyzer.observe(next)[0].kind, "attribute_change")
  assert_eq(analyzer.summary().duplicate_announcements, 0L)
  assert_eq(analyzer.summary().path_changes, 0L)
  assert_eq(analyzer.summary().attribute_changes, 1L)
}

///|
test "IPv6 压缩优先最长且同长选前段" {
  assert_eq(
    ip_text(b"\x00\x01\x00\x00\x00\x00\x00\x02\x00\x00\x00\x00\x00\x03\x00\x04"),
    "1::2:0:0:3:4",
  )
  assert_eq(
    ip_text(b"\x00\x01\x00\x00\x00\x00\x00\x02\x00\x00\x00\x00\x00\x00\x00\x04"),
    "1:0:0:2::4",
  )
}

///|
test "每个截断点都抛出解析错误而非越界" {
  let record = b"\x00\x00\x00\x01\x00\x63\x00\x01\x00\x00\x00\x03abc"
  for end = 0; end < record.length(); end = end + 1 {
    let failed = try {
      ignore(read_frame(record[0:end].to_owned()))
      false
    } catch {
      Invalid(_, _) => true
    }
    assert_true(failed)
  }
}

///|
test "过期会话事件不能清除更新的路由状态" {
  let analyzer = Analyzer::new()
  let event = {
    ..sample_event(100U, "announce", [65536U]),
    microseconds: Some(500),
  }
  ignore(analyzer.observe(event))
  analyzer.observe_state({
    source: None,
    timestamp: 100U,
    microseconds: Some(499),
    peer_asn: event.peer_asn,
    peer_ip: event.peer_ip,
    old_state: 6,
    new_state: 1,
  })
  assert_eq(analyzer.summary().active_routes, 1)
  assert_eq(analyzer.summary().session_resets, 0L)
  assert_eq(analyzer.summary().out_of_order, 1L)
  analyzer.observe_state({
    source: None,
    timestamp: 100U,
    microseconds: Some(501),
    peer_asn: event.peer_asn,
    peer_ip: event.peer_ip,
    old_state: 6,
    new_state: 1,
  })
  assert_eq(analyzer.summary().active_routes, 0)
}
