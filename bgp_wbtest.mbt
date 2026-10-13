///|
fn update_frame(body : Bytes) -> Frame {
  {
    header: { timestamp: 100U, kind: 16, subtype: 1, length: body.length(), },
    microseconds: None,
    payload: body,
  }
}

///|
test "IPv4 UPDATE 同时撤回和宣告" {
  let frame = update_frame(
    b"\xfc\x00\xfc\x01\x00\x00\x00\x01\xc0\x00\x02\x01\xc0\x00\x02\x02\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\x00\x2a\x02\x00\x04\x18\xc6\x33\x64\x00\x0b\x40\x01\x01\x00\x40\x02\x04\x02\x01\xfc\x00\x18\xcb\x00\x71",
  )
  let parsed = parse_bgp4mp(frame)
  assert_eq(parsed.events.length(), 2)
  assert_eq(parsed.events[0].action, "withdraw")
  assert_eq(parsed.events[0].prefix, "198.51.100.0/24")
  assert_eq(parsed.events[1].prefix, "203.0.113.0/24")
  assert_eq(origin_as(parsed.events[1].attributes.path), Some(64512U))
}

///|
test "会话状态变化和非法状态" {
  let prefix = b"\xfc\x00\xfc\x01\x00\x00\x00\x01\xc0\x00\x02\x01\xc0\x00\x02\x02"
  let frame = update_frame(prefix + b"\x00\x06\x00\x01")
  let state_frame = { ..frame, header: { ..frame.header, subtype: 0, }, }
  assert_eq(parse_bgp4mp(state_frame).states[0].new_state, 1)
  let bad = { ..state_frame, payload: prefix + b"\x00\x00\x00\x01", }
  assert_true(
    try {
      ignore(parse_bgp4mp(bad))
      false
    } catch {
      _ => true
    },
  )
}

///|
test "拒绝非法 marker 和消息截断" {
  assert_true(
    try {
      ignore(parse_bgp4mp(update_frame(b"\x00")))
      false
    } catch {
      _ => true
    },
  )
}
