///|
test "聚合器结构化编码及严格长度在所有后端一致" {
  let attrs = parse_attributes(
    b"\x40\x06\x00\xc0\x07\x06\x5b\xa0\xc0\x00\x02\x01\xc0\x12\x08\x00\x01\x11\x70\xc0\x00\x02\x09",
    2,
  )
  assert_true(attrs.atomic_aggregate)
  assert_eq(attrs.wire_aggregator.unwrap().asn, 23456U)
  assert_eq(attrs.aggregator.unwrap().asn, 70000U)
  assert_eq(attrs.aggregator.unwrap().address, "192.0.2.9")
  assert_eq(attrs.raw_attributes.length(), 3)
  for raw in [b"\x40\x06\x01x", b"\xc0\x07\x05abcde", b"\xc0\x12\x07abcdefg"] {
    assert_true(
      try {
        ignore(parse_attributes(raw, 2))
        false
      } catch {
        _ => true
      },
    )
  }
}

///|
test "AS4 路径的长度、集合、联盟和聚合器组合独立规则案例" {
  let wire : Array[AsSegment] = [
    { kind: 3, asns: [65000U], },
    { kind: 2, asns: [64512U], },
    { kind: 4, asns: [65001U, 65002U], },
    { kind: 1, asns: [23456U, 64513U], },
  ]
  let suffix : Array[AsSegment] = [
    { kind: 3, asns: [65010U], },
    { kind: 2, asns: [70000U], },
  ]
  assert_true(
    reconstruct_path(wire, suffix) ==
    [
      { kind: 3, asns: [65000U], },
      { kind: 2, asns: [64512U], },
      { kind: 4, asns: [65001U, 65002U], },
      { kind: 2, asns: [70000U], },
    ],
  )
  assert_true(
    reconstruct_path(wire, [{ kind: 2, asns: [1U, 2U, 3U], }]) == wire,
  )
  let set_suffix : Array[AsSegment] = [
    { kind: 1, asns: [70000U, 80000U, 90000U], },
  ]
  assert_eq(path_length(reconstruct_path(wire, set_suffix)), 2)
  assert_true(reconstruct_path(wire, set_suffix).last() == Some(set_suffix[0]))
  assert_true(reconstruct_path(wire, [{ kind: 4, asns: [1U], }]) == wire)
  let a : Aggregator = { asn: 64500U, address: "192.0.2.1", }
  let b : Aggregator = { asn: 70000U, address: "192.0.2.9", }
  assert_true(effective_path(wire, set_suffix, Some(a), Some(b), 2) == wire)
  assert_true(
    effective_path(wire, set_suffix, Some(a), None, 2) ==
    reconstruct_path(wire, set_suffix),
  )
  assert_true(effective_aggregator(None, Some(b), 2) == Some(b))
  assert_true(effective_aggregator(None, Some(b), 4) == None)
}

///|
test "未知属性标志、接收保留位与 Partial 边界" {
  let attrs = parse_attributes(b"\x9f\xfa\x00\x02ab", 4)
  assert_eq(attrs.other[0].flags, 159)
  assert_eq(attrs.other[0].value, b"ab")
  for
    raw in [
      b"\x40\xfa\x00", b"\xa0\xfa\x00", b"\x80\x01\x01\x00", b"\x60\x06\x00",
    ] {
    assert_true(
      try {
        ignore(parse_attributes(raw, 4))
        false
      } catch {
        _ => true
      },
    )
  }
}
