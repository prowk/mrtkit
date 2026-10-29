///|
priv struct WireAnalysisEvent {
  id : String
  time_us : UInt64
  prefix : String
  peer : String
  peer_asn : UInt32
  peer_ip : String
  outbound : Bool
  path_id : UInt32?
  source : Source?
  kind : String
  accepted : Bool
  changes_state : Bool
  before : WireSemanticSnapshot?
  after : WireSemanticSnapshot?
  changes : Array[Json]
  selected : Bool
} derive(@json.FromJson)

///|
fn read_analysis_event(row : Json) -> InvestigationEvent raise ParseError {
  let wire : WireAnalysisEvent = @json.from_json(analysis_json(row)) catch {
    _ => raise Invalid(0, "结果事件 JSON 无效")
  }
  let snapshot = fn(value : WireSemanticSnapshot) raise ParseError {
    {
      timestamp: 0U,
      microseconds: None,
      active: value.active,
      attributes: value.attributes.attributes(),
      source: None,
    }
  }
  {
    id: wire.id,
    time_us: wire.time_us,
    prefix: wire.prefix,
    peer: wire.peer,
    peer_asn: wire.peer_asn,
    peer_ip: wire.peer_ip,
    outbound: wire.outbound,
    path_id: wire.path_id,
    source: wire.source,
    kind: wire.kind,
    accepted: wire.accepted,
    changes_state: wire.changes_state,
    before: wire.before.map(snapshot),
    after: wire.after.map(snapshot),
    changes: wire.changes.map(row => semantic_change_from_json(row.stringify())),
    selected: wire.selected,
    before_path: None,
    after_path: None,
  }
}

///|
pub fn investigation_match_json(
  query : String,
  row : String,
) -> Bool raise ParseError {
  let query : AnalysisQuery = @json.from_json(analysis_json(@json.parse(query))) catch {
    _ => raise Invalid(0, "查询 JSON 无效")
  }
  if !["before", "after", "either"].contains(query.side.unwrap_or("either")) {
    raise Invalid(0, "查询 side 无效")
  }
  ignore(
    Query::new(
      prefix?=query.prefix,
      prefix_mode=query.prefix_mode.unwrap_or("exact"),
    ),
  )
  analysis_matches(
    Some(query),
    read_analysis_event(
      @json.parse(row) catch {
        _ => raise Invalid(0, "事件 JSON 无效")
      },
    ),
  )
}

///|
pub fn investigation_summary_json(
  rules_text : String,
  rows : String,
) -> Json raise ParseError {
  let rules = Investigation::new(rules_text).rules
  let values : Array[Json] = @json.from_json(analysis_json(@json.parse(rows))) catch {
    _ => raise Invalid(0, "事件列表 JSON 无效")
  }
  if values.length() > rules.capacity.unwrap_or(20000) {
    raise Invalid(0, "摘要超过容量")
  }
  let counts = chart_counts()
  for value in values {
    let row = read_analysis_event(value)
    if row.time_us >= rules.from_us && row.time_us < rules.to_us {
      counts.observe(row, rules)
    }
  }
  counts.report("query", rules)
}
