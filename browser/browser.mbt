///|
pub fn filter_metadata(query : String, row : String) -> String {
  Json::object({
    "matches": Json(@mrt.investigation_filter_metadata(query, row)),
  }).stringify() catch {
    @mrt.ParseError::Invalid(_, message) =>
      Json::object({ "error": Json(message) }).stringify()
  }
}

///|
pub fn canonical_prefix(text : String) -> String {
  Json::object({ "prefix": Json(@mrt.parse_prefix_text(text).text()) }).stringify() catch {
    @mrt.ParseError::Invalid(_, message) =>
      Json::object({ "error": Json(message) }).stringify()
  }
}
