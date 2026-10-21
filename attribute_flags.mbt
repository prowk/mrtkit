///|
/// 低四位按接收规则忽略；原始编码仍保存在 raw_attributes 中。
fn validate_attribute_flags(
  flags : Int,
  code : Int,
  position : Int,
) -> Unit raise ParseError {
  let optional = (flags & 128) != 0
  let transitive = (flags & 64) != 0
  let partial = (flags & 32) != 0
  if partial && (!optional || !transitive) {
    raise Invalid(
      position, "Partial 标志仅适用于 optional transitive 属性",
    )
  }
  let expected = match code {
    1 | 2 | 3 | 5 | 6 => Some(64)
    4 | 14 | 15 => Some(128)
    7 | 8 | 17 | 18 | 32 => Some(192)
    _ => None
  }
  match expected {
    Some(value) =>
      if (flags & 192) != value {
        raise Invalid(position, "BGP 属性 Optional/Transitive 标志错误")
      }
    None =>
      if !optional {
        raise Invalid(position, "未知 well-known BGP 属性")
      }
  }
}
