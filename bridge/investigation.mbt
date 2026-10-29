///|
let investigation : Ref[@mrt.Investigation?] = Ref(None)

///|
let investigation_decoder : Ref[@mrt.Decoder] = Ref(@mrt.Decoder::new())

///|
pub fn investigation_configure(text : String) -> String {
  investigation.val = None
  try {
    investigation.val = Some(@mrt.Investigation::new(text))
    "{}"
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn investigation_reset_file() -> Unit {
  investigation_decoder.val = @mrt.Decoder::new()
}

///|
pub fn investigation_consume(
  data : Bytes,
  file : String,
  record : Int64,
  offset : Int64,
  collector : String,
  view : String,
  baseline : Bool,
) -> String {
  try {
    let current = match investigation.val {
      Some(value) => value
      None => return error_json(0, "调查未配置")
    }
    let batch = investigation_decoder.val.decode_scoped(
      data, file, record, offset, collector, view,
    )
    if baseline && (batch.header.kind != 13 || batch.skipped) {
      return error_json(0, "基线包含非 RIB 数据")
    }
    if baseline && batch.header.subtype == 1 {
      current.set_baseline_scope(collector, view)
    }
    for event in batch.events {
      current.observe(event, baseline~)
    }
    for state in batch.states {
      current.observe_state(state)
    }
    Json::object({
      "events": Json(batch.events.length()),
      "diagnostics": Json(batch.diagnostics),
    }).stringify()
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn investigation_finish() -> String {
  try {
    match investigation.val {
      Some(value) => value.report().stringify()
      None => error_json(0, "调查未配置")
    }
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn investigation_match(query : String, row : String) -> String {
  Json::object({ "matches": Json(@mrt.investigation_match_json(query, row)) }).stringify() catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn investigation_summary(rules : String, rows : String) -> String {
  @mrt.investigation_summary_json(rules, rows).stringify() catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}
