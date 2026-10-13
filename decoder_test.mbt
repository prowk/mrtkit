///|
test "任意分块边界解码结果一致" {
  let record = b"\x00\x00\x00\x01\x00\x63\x00\x01\x00\x00\x00\x02ab"
  let data = record + record
  for split = 0; split <= data.length(); split = split + 1 {
    let decoder = @mrtkit.StreamDecoder::new()
    let first = decoder.feed(data[0:split].to_owned())
    let second = decoder.feed(data[split:].to_owned())
    assert_eq(first.length() + second.length(), 2)
    decoder.finish()
  }
}

///|
test "EOF 截断和失败会话不能继续" {
  let decoder = @mrtkit.StreamDecoder::new()
  ignore(decoder.feed(b"\x00"))
  assert_true(
    try {
      decoder.finish()
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ignore(decoder.feed(b""))
      false
    } catch {
      _ => true
    },
  )
}

///|
test "RIB 缺少 peer 表不能静默忽略" {
  let decoder = @mrtkit.Decoder::new()
  let record = b"\x00\x00\x00\x01\x00\x0d\x00\x02\x00\x00\x00\x00"
  assert_true(
    try {
      ignore(decoder.decode(record))
      false
    } catch {
      _ => true
    },
  )
}
