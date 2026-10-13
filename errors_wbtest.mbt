///|
test "错误携带位置" {
  let error = ParseError::Invalid(12, "截断")
  assert_true(error is ParseError::Invalid(12, _))
}
