///|
test "IPv4 非整字节前缀清除主机位" {
  assert_eq(
    @mrtkit.parse_prefix(b"\x19\xc0\x00\x02\xff", 1).text(),
    "192.0.2.128/25",
  )
  assert_eq(@mrtkit.parse_prefix(b"\x00", 1).text(), "0.0.0.0/0")
}

///|
test "IPv6 压缩和默认路由" {
  assert_eq(
    @mrtkit.parse_prefix(b"\x20\x20\x01\x0d\xb8", 2).text(),
    "2001:db8::/32",
  )
  assert_eq(@mrtkit.parse_prefix(b"\x00", 2).text(), "::/0")
}

///|
test "非法地址族、长度和截断" {
  for
    (data, afi) in [(b"\x21", 1), (b"\x81", 2), (b"\x18\x01", 1), (b"\x00", 3)] {
    assert_true(
      try {
        ignore(@mrtkit.parse_prefix(data, afi))
        false
      } catch {
        _ => true
      },
    )
  }
}
