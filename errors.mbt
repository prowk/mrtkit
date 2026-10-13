///|
/// 解析错误包含字节位置，便于定位损坏记录。
pub suberror ParseError {
  Invalid(Int, String)
}
