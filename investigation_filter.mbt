///|
priv struct FilterMetadata {
  time_us : UInt64
  prefix : String
  peer_asn : UInt32
  peer_ip : String
  path_id : UInt32?
  outbound : Bool
  collector : String
  view : String
  kind : String
  kinds : Array[String]
} derive(@json.FromJson)

///|
/// 报告只传紧凑索引元数据；属性条件必须查询完整结果事件。
pub fn investigation_filter_metadata(
  query : String,
  row : String,
) -> Bool raise ParseError {
  let query : AnalysisQuery = @json.from_json(analysis_json(@json.parse(query))) catch {
    _ => raise Invalid(0, "筛选 JSON 无效")
  }
  let meta : FilterMetadata = @json.from_json(analysis_json(@json.parse(row))) catch {
    _ => raise Invalid(0, "筛选索引无效")
  }
  if query.origin_asns is Some(_) ||
    query.path_asns is Some(_) ||
    query.communities is Some(_) ||
    query.origin_unknown.unwrap_or(false) {
    raise Invalid(0, "属性查询需要完整事件")
  }
  ignore(
    Query::new(
      prefix?=query.prefix,
      prefix_mode=query.prefix_mode.unwrap_or("exact"),
    ),
  )
  if query.kind is Some(kind) && !meta.kinds.contains(kind) {
    return false
  }
  let source : Source = {
    collector: Some(meta.collector),
    view: Some(meta.view),
    file: "",
    record: 0L,
    offset: 0L,
    event_index: 0,
  }
  analysis_matches(Some({ ..query, kind: None, }), {
    id: "",
    time_us: meta.time_us,
    prefix: meta.prefix,
    peer: "",
    peer_asn: meta.peer_asn,
    peer_ip: meta.peer_ip,
    outbound: meta.outbound,
    path_id: meta.path_id,
    source: Some(source),
    kind: meta.kind,
    accepted: true,
    changes_state: false,
    before: None,
    after: None,
    changes: [],
    selected: false,
    before_path: None,
    after_path: None,
  })
}
