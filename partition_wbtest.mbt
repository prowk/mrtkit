///|
test "分区及原始索引恢复不依赖 JS 后端" {
  let table = b"\x00\x00\x00\x64\x00\x0d\x00\x01\x00\x00\x00\x15\x00\x00\x00\x00\x00\x00\x00\x01\x02\x00\x00\x00\x01\xc0\x00\x02\x01\x00\x00\xfc\x00"
  let rib = b"\x00\x00\x00\x64\x00\x0d\x00\x02\x00\x00\x00\x26\x00\x00\x00\x00\x18\xcb\x00\x71\x00\x01\x00\x00\x00\x00\x00\x63\x00\x14\x40\x01\x01\x00\x40\x02\x06\x02\x01\x00\x00\xfc\x00\x40\x03\x04\xc0\x00\x02\x01"
  let decoder = Decoder::new()
  assert_true(decoder.partition_record(table).peer_table)
  let split = decoder.partition_record(rib)
  assert_eq(split.route_events, 1)
  assert_eq(split.parts.length(), 1)
  assert_eq(split.parts[0].data, rib)
  assert_eq(split.parts[0].event_indices, [0])
  let batch = decoder
    .decode_at(rib, "original", 7L, 999L)
    .with_event_indices([5])
  assert_eq(batch.events[0].source.unwrap().event_index, 5)
  assert_true(
    try {
      ignore(batch.with_event_indices([-1]))
      false
    } catch {
      _ => true
    },
  )
  let analyzer = Analyzer::new()
  ignore(analyzer.observe(sample_event(100U, "announce", [1U, 2U])))
  assert_eq(analyzer.route_count(), 1)
  assert_eq(analyzer.path_totals(), (2L, 1L))
}
