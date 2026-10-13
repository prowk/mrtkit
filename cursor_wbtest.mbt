///|
test "网络字节序和无符号上界" {
  let c = Cursor::new(b"\x01\x02\xff\xff\xff\xff")
  assert_eq(c.u16(), 258)
  assert_eq(c.u32(), 4294967295U)
  c.finish()
}

///|
test "子游标不越过父边界" {
  let c = Cursor::new(b"\x00\x01\x02")
  let child = c.take(1)
  assert_true(
    try {
      ignore(child.u16())
      false
    } catch {
      _ => true
    },
  )
  assert_eq(c.u16(), 258)
  assert_true(
    try {
      ignore(c.take(-1))
      false
    } catch {
      _ => true
    },
  )
}
