///|
/// 关联依据明确的前后语义，身份和 Path Identifier 属于本地来源，不进入跨观测点匹配键。
pub fn Change::correlation_key(self : Change) -> String raise ParseError {
  let before = self.before
    .map(fn(s) { s.attributes })
    .unwrap_or(empty_attributes())
  let after = self.after.attributes
  let rule = match self.kind {
    "path_change" =>
      Json::object({
        "before": Json(canonical_path(before.path)),
        "after": Json(canonical_path(after.path)),
      })
    "origin_change" =>
      Json::object({
        "before": Json(origin_as(before.path)),
        "after": Json(origin_as(after.path)),
      })
    "attribute_change" =>
      Json::object({
        "before": { ..semantic_attributes(before), path: [], }.to_json(),
        "after": { ..semantic_attributes(after), path: [], }.to_json(),
      })
    "churn" =>
      Json::object({
        "threshold": Json(self.churn_count),
        "active": Json(self.after.active),
      })
    _ => raise Invalid(0, "没有定义此变化类型的关联规则")
  }
  Json::object({
    "prefix": Json(self.prefix),
    "kind": Json(self.kind),
    "rule": rule,
  }).stringify()
}

///|
pub fn Change::with_correlation_key(self : Change) -> Change raise ParseError {
  { ..self, correlation_key: Some(self.correlation_key()), }
}

///|
pub fn TimelineReport::with_correlation_keys(
  self : TimelineReport,
) -> TimelineReport raise ParseError {
  let entries = []
  for entry in self.entries {
    let changes = []
    for change in entry.changes {
      changes.push(change.with_correlation_key())
    }
    entries.push({ ..entry, changes, })
  }
  { ..self, entries, }
}
