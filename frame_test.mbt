///|
test "未知记录可保留且时间戳无符号" {
  let f = @mrtkit.read_frame(
    b"\xff\xff\xff\xff\x00\x63\x00\x07\x00\x00\x00\x02ab",
  )
  assert_eq(f.header.timestamp, 4294967295U)
  assert_eq(f.header.kind, 99)
  assert_eq(f.payload, b"ab")
}

///|
test "扩展时间戳包含在记录长度中" {
  let f = @mrtkit.read_frame(
    b"\x00\x00\x00\x01\x00\x11\x00\x04\x00\x00\x00\x05\x00\x00\x00\x09x",
  )
  assert_eq(f.microseconds, Some(9))
  assert_eq(f.payload, b"x")
}

///|
test "拒绝截断、超限及尾部" {
  for
    data in [
      b"", b"\x00\x00\x00\x00\x00\x10\x00\x01\xff\xff\xff\xff", b"\x00\x00\x00\x00\x00\x10\x00\x01\x00\x00\x00\x00x",
    ] {
    let rejected = try {
      ignore(@mrtkit.read_frame(data))
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}
