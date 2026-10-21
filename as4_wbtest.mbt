///|
test "AS_TRANS 还原且保留旧网络前缀" {
  let path : Array[AsSegment] = [{ kind: 2, asns: [64512U, 23456U, 23456U], }]
  let as4 : Array[AsSegment] = [{ kind: 2, asns: [65536U, 4200000000U], }]
  let merged = reconstruct_path(path, as4)
  assert_eq(path_length(merged), 3)
  assert_eq(merged[0].asns, [64512U])
  assert_eq(origin_as(merged), Some(4200000000U))
  assert_true(reconstruct_path(as4, path) == as4)
  let attrs = parse_attributes(
    b"\x40\x02\x06\x02\x02\xfc\x00\x5b\xa0\xc0\x11\x06\x02\x01\x00\x01\x00\x00",
    2,
  )
  assert_eq(origin_as(attrs.path), Some(65536U))
}

///|
test "联盟段及聚合器规则" {
  let path : Array[AsSegment] = [
    { kind: 3, asns: [65000U], },
    { kind: 2, asns: [23456U], },
  ]
  let as4 : Array[AsSegment] = [{ kind: 2, asns: [65536U], }]
  assert_eq(reconstruct_path(path, as4)[0].kind, 3)
  let aggregator : Aggregator = { asn: 64512U, address: "192.0.2.1", }
  let as4_aggregator : Aggregator = { asn: 65536U, address: "192.0.2.2", }
  assert_true(
    effective_path(path, as4, Some(aggregator), Some(as4_aggregator), 2) == path,
  )
  assert_eq(
    origin_as(effective_path(path, as4, Some(aggregator), None, 2)),
    Some(65536U),
  )
  assert_true(effective_path(path, as4, None, None, 4) == path)
}
