///|
/// 有界游标保证嵌套长度不会跨越父记录边界。
priv struct Cursor {
  data : Bytes
  mut pos : Int
  end : Int
}

///|
fn Cursor::new(data : Bytes) -> Cursor {
  { data, pos: 0, end: data.length(), }
}

///|
fn Cursor::remaining(self : Cursor) -> Int {
  self.end - self.pos
}

///|
fn Cursor::require(self : Cursor, n : Int) -> Unit raise ParseError {
  if n < 0 || n > self.remaining() {
    raise Invalid(self.pos, "截断或无效长度")
  }
}

///|
fn Cursor::u8(self : Cursor) -> Int raise ParseError {
  self.require(1)
  let value = self.data[self.pos].to_int()
  self.pos += 1
  value
}

///|
fn Cursor::u16(self : Cursor) -> Int raise ParseError {
  let a = self.u8()
  let b = self.u8()
  (a << 8) | b
}

///|
fn Cursor::u32(self : Cursor) -> UInt raise ParseError {
  let a = self.u16().reinterpret_as_uint()
  let b = self.u16().reinterpret_as_uint()
  (a << 16) | b
}

///|
fn Cursor::take(self : Cursor, n : Int) -> Cursor raise ParseError {
  self.require(n)
  let child = { data: self.data, pos: self.pos, end: self.pos + n, }
  self.pos += n
  child
}

///|
fn Cursor::bytes(self : Cursor, n : Int) -> Bytes raise ParseError {
  let child = self.take(n)
  child.data[child.pos:child.end].to_owned()
}

///|
fn Cursor::finish(self : Cursor) -> Unit raise ParseError {
  if self.remaining() != 0 {
    raise Invalid(self.pos, "存在未消费的尾部数据")
  }
}
