///|
fn sample_event(
  timestamp : UInt,
  action : String,
  asns : Array[UInt],
) -> RouteEvent {
  {
    timestamp,
    microseconds: None,
    action,
    prefix: "192.0.2.0/24",
    peer_asn: 64512U,
    peer_ip: "198.51.100.1",
    outbound: false,
    originated: None,
    attributes: { ..empty_attributes(), path: [{ kind: 2, asns, }], },
  }
}

///|
test "筛选包含端点且支持路径 ASN" {
  let event = sample_event(100U, "announce", [64512U, 65536U])
  assert_true(
    Query::new(asn=65536U, from_time=100U, to_time=100U).matches(event),
  )
  assert_true(!Query::new(prefix="203.0.113.0/24").matches(event))
  assert_true(!Query::new(asn=42U).matches(event))
  assert_true(
    try {
      ignore(Query::new(from_time=2U, to_time=1U))
      false
    } catch {
      _ => true
    },
  )
}

///|
test "导出 CSV 转义与 JSON 结构" {
  assert_eq(csv_quote("a,\"b\"\nc"), "\"a,\"\"b\"\"\nc\"")
  let event = sample_event(100U, "announce", [65536U])
  assert_eq(
    event_csv(event),
    "100,,\"announce\",\"192.0.2.0/24\",64512,\"198.51.100.1\",false,65536,\"65536\",\"\",",
  )
  assert_true(event_json(event).contains("\"peer_asn\":64512"))
  assert_eq(path_text([{ kind: 1, asns: [1U, 2U], }]), "{1,2}")
}
