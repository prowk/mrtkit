///|
test "peer 表混合 ASN 宽度和地址族" {
  let table = parse_peers(
    b"\x00\x00\x00\x01\x00\x00\x00\x02\x00\xc0\x00\x02\x01\xc0\x00\x02\x02\xfc\x00\x03\xc0\x00\x02\x03\x20\x01\x0d\xb8\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x01\x00\x00",
  )
  assert_eq(table.peers.length(), 2)
  assert_eq(table.peers[0].asn, 64512U)
  assert_eq(table.peers[1].address, "2001:db8::1")
  assert_eq(table.peers[1].asn, 65536U)
}

///|
test "快照记录关联 peer 并解析四字节路径" {
  let frame : Frame = {
    header: { timestamp: 100U, kind: 13, subtype: 2, length: 0, },
    microseconds: None,
    payload: b"\x00\x00\x00\x01\x18\xc0\x00\x02\x00\x01\x00\x00\x00\x00\x00\x63\x00\x09\x40\x02\x06\x02\x01\x00\x01\x00\x00",
  }
  let peers : Array[Peer] = [{ bgp_id: 1U, address: "192.0.2.1", asn: 64512U, }]
  let events = parse_rib(frame, peers)
  assert_eq(events[0].prefix, "192.0.2.0/24")
  assert_eq(events[0].originated, Some(99U))
  assert_eq(origin_as(events[0].attributes.path), Some(65536U))
  assert_true(
    try {
      ignore(parse_rib(frame, []))
      false
    } catch {
      _ => true
    },
  )
}
