///|
test "必需属性检查区分缺失与空 AS_PATH，不施加到独立属性块" {
  let attrs = parse_attributes(b"\x40\x01\x01\x00\x40\x02\x00", 4)
  require_announcement_attributes(attrs, false)
  assert_true(
    try {
      require_announcement_attributes(attrs, true)
      false
    } catch {
      _ => true
    },
  )
  let classic = parse_attributes(
    b"\x40\x01\x01\x00\x40\x02\x00\x40\x03\x04\xc0\x00\x02\x01", 4,
  )
  require_announcement_attributes(classic, true)
  for data in [b"", b"\x40\x01\x01\x00", b"\x40\x02\x00"] {
    let partial = parse_attributes(data, 4)
    assert_true(
      try {
        require_announcement_attributes(partial, false)
        false
      } catch {
        _ => true
      },
    )
  }
}
