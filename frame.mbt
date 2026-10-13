///|
pub struct Header {
  timestamp : UInt
  kind : Int
  subtype : Int
  length : Int
} derive(Eq, ToJson)

///|
pub struct Frame {
  header : Header
  microseconds : Int?
  payload : Bytes
} derive(Eq)

///|
/// 单条记录上限为 16 MiB，未知类型仍保留完整记录。
pub fn read_frame(data : Bytes) -> Frame raise ParseError {
  let c = Cursor::new(data)
  let timestamp = c.u32()
  let kind = c.u16()
  let subtype = c.u16()
  let size = c.u32()
  if size > 16777216U {
    raise Invalid(8, "MRT 记录超过 16 MiB 上限")
  }
  let length = size.to_int()
  let body = c.take(length)
  c.finish()
  let microseconds = if kind == 17 || kind == 33 || kind == 49 {
    let micros = body.u32()
    if micros >= 1000000U {
      raise Invalid(12, "微秒字段超出范围")
    }
    Some(micros.to_int())
  } else {
    None
  }
  let payload = body.bytes(body.remaining())
  { header: { timestamp, kind, subtype, length, }, microseconds, payload, }
}
