///|
test "解析常用属性和未知扩展" {
  let attrs = @mrtkit.parse_attributes(
    b"\x40\x01\x01\x00\x40\x02\x06\x02\x02\xfc\x00\xfc\x01\x40\x03\x04\xc0\x00\x02\x01\xc0\x08\x04\xfc\x00\x00\x64\x90\x63\x00\x02ab",
    2,
  )
  assert_eq(attrs.origin, Some(0))
  assert_eq(@mrtkit.path_length(attrs.path), 2)
  assert_eq(@mrtkit.origin_as(attrs.path), Some(64513U))
  assert_eq(attrs.next_hop, Some("192.0.2.1"))
  assert_eq(attrs.communities[0], 4227858532U)
  assert_eq(attrs.other[0].value, b"ab")
}

///|
test "四字节 ASN 和 AS_SET 起源不确定" {
  let attrs = @mrtkit.parse_attributes(
    b"\x40\x02\x06\x01\x01\xff\xff\xff\xff", 4,
  )
  assert_eq(attrs.path[0].asns[0], 4294967295U)
  assert_eq(@mrtkit.origin_as(attrs.path), None)
  assert_eq(@mrtkit.path_length(attrs.path), 1)
}

///|
test "属性长度、重复和路径段错误" {
  for
    data in [
      b"\x40\x01\x02\x00\x00", b"\x40\x02\x02\x02\x00", b"\x40\x01\x01\x03", b"\x40\x01\x01\x00\x40\x01\x01\x00",
      b"\x40\x03\x04\x01",
    ] {
    assert_true(
      try {
        ignore(@mrtkit.parse_attributes(data, 2))
        false
      } catch {
        _ => true
      },
    )
  }
}
