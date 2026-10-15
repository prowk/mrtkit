///|
test "Large Communities 保留原始编码、规范化三元组并忽略重复" {
  let attrs = parse_attributes(
    b"\xc0\x20\x18\x00\x01\x00\x00\xff\xff\xff\xff\x00\x00\x00\x02\x00\x01\x00\x00\xff\xff\xff\xff\x00\x00\x00\x02",
    4,
  )
  assert_eq(attrs.large_communities, [(65536U, 4294967295U, 2U)])
  assert_eq(attrs.other[0].value.length(), 24)
  let changed = { ..attrs, large_communities: [(65536U, 1U, 2U)], }
  let diff = route_diff(attrs, changed).large_communities.unwrap()
  assert_eq(diff.added, [(65536U, 1U, 2U)])
  assert_eq(diff.removed, [(65536U, 4294967295U, 2U)])
  assert_true(
    route_attributes_equal(attrs, {
      ..attrs,
      large_communities: attrs.large_communities + attrs.large_communities,
    }),
  )
}

///|
test "Large Communities 畸形长度产生可识别的解析错误" {
  for raw in [b"\xc0\x20\x00", b"\xc0\x20\x01a", b"\xc0\x20\x0babcdefghijk"] {
    assert_true(
      try {
        ignore(parse_attributes(raw, 4))
        false
      } catch {
        Invalid(_, message) => message.contains("LARGE_COMMUNITY")
      },
    )
  }
}
