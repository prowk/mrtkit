///|
/// UPDATE 宣告才适用此检查；独立属性块与 RIB 没有 UPDATE 信封。
fn require_announcement_attributes(
  attributes : Attributes,
  classic : Bool,
) -> Unit raise ParseError {
  let required = if classic { [1, 2, 3] } else { [1, 2] }
  for code in required {
    if !attributes.raw_attributes.any(fn(a) { a.code == code }) {
      let name = match code {
        1 => "ORIGIN"
        2 => "AS_PATH"
        _ => "NEXT_HOP"
      }
      raise Invalid(0, "UPDATE 宣告缺少必需属性 \{name}")
    }
  }
}
