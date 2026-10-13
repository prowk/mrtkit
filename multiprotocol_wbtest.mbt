///|
test "IPv6 宣告、撤回及不支持的 SAFI" {
  let mp = parse_mp(
    b"\x00\x02\x01\x10\x20\x01\x0d\xb8\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x20\x20\x01\x0d\xb8",
    true,
  )
  assert_eq(mp.prefixes[0], "2001:db8::/32")
  assert_eq(mp.next_hop, Some("2001:db8::1"))
  let withdrawn = parse_mp(b"\x00\x02\x01\x20\x20\x01\x0d\xb8", false)
  assert_eq(withdrawn.prefixes[0], "2001:db8::/32")
  assert_true(!parse_mp(b"\x00\x02\x80", true).supported)
}

///|
test "快照精简下一跳编码" {
  let attrs = parse_attributes(
    b"\x80\x0e\x11\x10\x20\x01\x0d\xb8\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01",
    4,
  )
  assert_eq(rib_next_hop(attrs, 2).next_hop, Some("2001:db8::1"))
  assert_true(
    try {
      ignore(parse_mp(b"\x00\x02\x01\x04abcd\x00", true))
      false
    } catch {
      _ => true
    },
  )
}
