///|
priv struct Config {
  output_version : String?
  prefix : String?
  prefix_mode : String?
  asn : UInt?
  peer_asn : UInt?
  path_id : UInt?
  from_time : UInt
  to_time : UInt
  from_micros : Int?
  to_micros : Int?
  window_seconds : Int
  threshold : Int
  capacity : Int
  top : Int?
  continuous_observation : Bool?
  observation_gaps : Array[WireGap]?
  mode : String
  format : String
  metrics_changes : Bool?
  collector : String?
  view : String?
  correlation_keys : Bool?
} derive(@json.FromJson)

///|
priv struct WireGap {
  from_time : UInt
  to_time : UInt
  from_micros : Int
  to_micros : Int
} derive(@json.FromJson)

///|
priv struct Session {
  decoder : @mrt.Decoder
  query : @mrt.Query
  analyzer : @mrt.Analyzer?
  aggregation : @mrt.Aggregation?
  timeline : @mrt.Timeline?
  config : Config
  mut baseline : Bool
  mut baseline_seen : Bool
  pending_changes : Array[@mrt.Change]
  mut state_export : Iter[@mrt.RouteEvent]?
}

///|
let session : Ref[Session?] = Ref(None)

///|
pub fn correlation_key_from_json(text : String) -> String {
  @mrt.correlation_key_from_json(text) catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn correlation_semantics_from_json(text : String) -> String {
  @mrt.correlation_semantics_from_json(text) catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
let stream_decoder : Ref[@mrt.StreamDecoder] = Ref(@mrt.StreamDecoder::new())

///|
pub fn stream_reset() -> Unit {
  stream_decoder.val = @mrt.StreamDecoder::new()
}

///|
pub fn stream_metrics(data : Bytes) -> String {
  try {
    let batches = stream_decoder.val.feed(data)
    let mut events = 0
    for batch in batches {
      events += batch.events.length()
    }
    Json::object({
      "records": batches.length().to_json(),
      "route_events": events.to_json(),
    }).stringify()
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn stream_end() -> String {
  try {
    stream_decoder.val.finish()
    "{}"
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
let snapshots : Ref[(@mrt.Snapshot, @mrt.Snapshot)?] = Ref(None)

///|
fn error_json(position : Int, message : String) -> String {
  Json::object({
    "error": Json::string(message),
    "position": position.to_json(),
  }).stringify()
}

///|
pub fn configure(text : String) -> String {
  session.val = None
  snapshots.val = None
  try {
    let config : Config = @json.from_json(@json.parse(text))
    if config.output_version.unwrap_or("2.0") != "2.0" {
      return error_json(0, "仅支持输出版本 2.0")
    }
    if config.mode != "parse" &&
      config.mode != "stats" &&
      config.mode != "changes" &&
      config.mode != "timeline" &&
      config.mode != "aggregate" &&
      config.mode != "snapshot-diff" {
      return error_json(0, "不支持的命令")
    }
    if config.format != "json" && config.format != "csv" {
      return error_json(0, "格式必须为 json 或 csv")
    }
    if config.mode != "parse" && config.asn is Some(_) {
      return error_json(
        0, "分析请使用 peer_asn，路径 ASN 筛选仅支持 parse",
      )
    }
    let query = @mrt.Query::new(
      prefix?=config.prefix,
      prefix_mode=config.prefix_mode.unwrap_or("exact"),
      asn?=config.asn,
      path_id?=config.path_id,
      from_micros=config.from_micros.unwrap_or(0),
      to_micros=config.to_micros.unwrap_or(999999),
      from_time?=if config.mode == "parse" {
        Some(config.from_time)
      } else {
        None
      },
      to_time?=if config.mode == "parse" { Some(config.to_time) } else { None },
    )
    let analyzer = if config.mode == "parse" || config.mode == "snapshot-diff" {
      None
    } else {
      Some(
        @mrt.Analyzer::new(
          window_seconds=config.window_seconds,
          threshold=config.threshold,
          capacity=config.capacity,
          from_time=config.from_time,
          to_time=config.to_time,
          from_micros=config.from_micros.unwrap_or(0),
          to_micros=config.to_micros.unwrap_or(999999),
        ),
      )
    }
    let timeline = if config.mode == "timeline" {
      let gaps = []
      for gap in config.observation_gaps.unwrap_or([]) {
        gaps.push(
          @mrt.ObservationGap::new(
            gap.from_time,
            gap.to_time,
            from_micros=gap.from_micros,
            to_micros=gap.to_micros,
          ),
        )
      }
      if config.prefix is None ||
        config.prefix_mode.unwrap_or("exact") != "exact" {
        return error_json(
          0, "timeline 需要 --prefix 并仅支持 exact 模式",
        )
      }
      Some(
        @mrt.Timeline::new(
          config.prefix.unwrap(),
          analyzer.unwrap(),
          continuous=config.continuous_observation.unwrap_or(false),
          gaps~,
          capacity=config.capacity,
          peer_asn?=config.peer_asn,
        ),
      )
    } else {
      None
    }
    session.val = Some({
      decoder: @mrt.Decoder::new(),
      query,
      analyzer,
      timeline,
      aggregation: if config.mode == "aggregate" {
        Some(@mrt.Aggregation::new())
      } else {
        None
      },
      config,
      baseline: false,
      baseline_seen: false,
      pending_changes: [],
      state_export: None,
    })
    "{}"
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
    _ => error_json(0, "配置 JSON 无效")
  }
}

///|
fn consume_inner(
  data : Bytes,
  origin : (String, Int64, Int64)?,
  emit? : Bool = true,
  event_indices? : Array[Int],
) -> String {
  let current = match session.val {
    Some(s) => s
    None => return error_json(0, "会话未配置")
  }
  if current.state_export is Some(_) {
    return error_json(0, "状态导出过程中不能继续输入记录")
  }
  try {
    current.pending_changes.clear()
    let decoded = match origin {
      Some((file, record, offset)) =>
        match (current.config.collector, current.config.view) {
          (Some(collector), Some(view)) =>
            current.decoder.decode_scoped(
              data, file, record, offset, collector, view,
            )
          (None, None) => current.decoder.decode_at(data, file, record, offset)
          _ => return error_json(0, "采集器与视图须同时提供")
        }
      None => current.decoder.decode(data)
    }
    let batch = match event_indices {
      Some(indices) => decoded.with_event_indices(indices)
      None => decoded
    }
    if current.baseline {
      if batch.header.kind != 13 || batch.skipped {
        session.val = None
        return error_json(
          0, "初始 RIB 文件只能包含支持的 TABLE_DUMP_V2 单播记录",
        )
      }
      if batch.header.timestamp > current.config.from_time {
        session.val = None
        return error_json(
          0, "初始 RIB 记录必须不晚于分析开始时间",
        )
      }
      if batch.header.subtype == 1 {
        if current.baseline_seen {
          session.val = None
          return error_json(0, "初始 RIB 只能包含一个 peer 表")
        }
        current.baseline_seen = true
        if current.timeline is Some(timeline) {
          timeline.seed_peers(
            @mrt.parse_peers(@mrt.read_frame(data).payload),
            batch.header.timestamp,
          )
        }
      }
    }
    if !current.baseline && current.analyzer is Some(analyzer) {
      if current.timeline is Some(timeline) {
        timeline.record_batch(batch)
      } else {
        analyzer.record_batch(batch)
      }
    }
    let lines = []
    for event in batch.events {
      if current.config.peer_asn is Some(asn) && event.peer_asn != asn {
        continue
      }
      if !current.query.matches(event) {
        continue
      }
      match current.analyzer {
        Some(analyzer) => {
          if current.baseline {
            if current.timeline is Some(timeline) {
              timeline.seed(event)
            } else {
              analyzer.seed(event)
            }
            continue
          }
          if current.timeline is Some(timeline) {
            timeline.observe(event)
            continue
          }
          let changes = analyzer.observe(event)
          if !emit && current.config.metrics_changes.unwrap_or(false) {
            for item in changes {
              current.pending_changes.push(item)
            }
          }
          if current.aggregation is Some(aggregation) {
            for item in changes {
              aggregation.observe(item)
            }
          }
          if emit && current.config.mode == "changes" {
            for item in changes {
              lines.push(
                if current.config.correlation_keys.unwrap_or(false) {
                  item.with_correlation_key().to_json().stringify()
                } else {
                  item.to_json().stringify()
                },
              )
            }
          }
        }
        None =>
          if emit {
            lines.push(
              if current.config.format == "csv" {
                @mrt.event_csv(event)
              } else {
                @mrt.event_json(event)
              },
            )
          }
      }
    }
    Json::object({
      "lines": lines.to_json(),
      "skipped": batch.skipped.to_json(),
      "ignored_families": batch.ignored_families.to_json(),
      "diagnostics": batch.diagnostics.to_json(),
      "route_events": batch.events.length().to_json(),
      "state_events": batch.states.length().to_json(),
    }).stringify()
  } catch {
    @mrt.ParseError::Invalid(pos, message) => {
      let summary = current.analyzer
        .map(fn(a) { a.summary().to_json() })
        .unwrap_or(Json::null())
      session.val = None
      Json::object({
        "error": message.to_json(),
        "position": pos.to_json(),
        "summary": summary,
      }).stringify()
    }
  }
}

///|
pub fn consume(data : Bytes) -> String {
  consume_inner(data, None)
}

///|
/// 基准入口只省略结果序列化，解析、筛选和状态逻辑与命令行相同。
pub fn consume_metrics(data : Bytes) -> String {
  consume_inner(data, None, emit=false)
}

///|
pub fn consume_at(
  data : Bytes,
  file : String,
  record : Int64,
  offset : Int64,
) -> String {
  consume_inner(data, Some((file, record, offset)))
}

///|
pub fn consume_selected(
  data : Bytes,
  file : String,
  record : Int64,
  offset : Int64,
  indices : String,
) -> String {
  let values : Array[Int] = @json.from_json(@json.parse(indices)) catch {
    _ => return error_json(0, "原始事件索引 JSON 无效")
  }
  consume_inner(data, Some((file, record, offset)), event_indices=values)
}

///|
pub fn consume_selected_metrics(
  data : Bytes,
  file : String,
  record : Int64,
  offset : Int64,
  indices : String,
) -> String {
  let values : Array[Int] = @json.from_json(@json.parse(indices)) catch {
    _ => return error_json(0, "原始事件索引 JSON 无效")
  }
  consume_inner(
    data,
    Some((file, record, offset)),
    event_indices=values,
    emit=false,
  )
}

///|
pub fn partition_record(data : Bytes) -> String {
  match session.val {
    Some(s) =>
      s.decoder.partition_record(data).to_json().stringify() catch {
        @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
      }
    None => error_json(0, "会话未配置")
  }
}

///|
pub fn path_totals() -> String {
  match session.val {
    Some(s) =>
      match s.analyzer {
        Some(a) => {
          let totals = a.path_totals()
          Json::object({
            "path_sum": totals.0.to_json(),
            "path_samples": totals.1.to_json(),
          }).stringify()
        }
        None => error_json(0, "没有分析器")
      }
    None => error_json(0, "会话未配置")
  }
}

///|
pub fn route_count() -> Int {
  match session.val {
    Some(s) => s.analyzer.map(fn(a) { a.route_count() }).unwrap_or(-1)
    None => -1
  }
}

///|
/// 用于逐记录验证和工具集成，不累计完整档案的输出。
pub fn decode_record(
  data : Bytes,
  file : String,
  record : Int64,
  offset : Int64,
) -> String {
  let current = match session.val {
    Some(s) => s
    None => return error_json(0, "会话未配置")
  }
  current.decoder.decode_at(data, file, record, offset).to_json().stringify() catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn csv_header() -> String {
  @mrt.csv_header()
}

///|
pub fn canonical_prefix(text : String) -> String {
  Json::object({ "prefix": @mrt.parse_prefix_text(text).text().to_json() }).stringify() catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn state() -> String {
  match session.val {
    Some(s) =>
      match s.analyzer {
        Some(analyzer) => analyzer.route_states().to_json().stringify()
        None => "[]"
      }
    None => error_json(0, "会话不可用")
  }
}

///|
pub fn storage_stats() -> String {
  match session.val {
    Some(s) =>
      s.analyzer
      .map(fn(a) { a.storage_stats().to_json().stringify() })
      .unwrap_or("{}")
    None => error_json(0, "会话不可用")
  }
}

///|
pub fn state_export_begin() -> String {
  match session.val {
    Some(s) =>
      match s.analyzer {
        Some(analyzer) => {
          if s.state_export is Some(_) {
            return error_json(0, "状态导出已经开始")
          }
          s.state_export = Some(analyzer.route_state_iter())
          "{}"
        }
        None => error_json(0, "当前命令没有路由状态")
      }
    None => error_json(0, "会话不可用")
  }
}

///|
pub fn state_export_chunk(limit : Int) -> String {
  if limit < 1 || limit > 1024 {
    return error_json(0, "状态分块须为 1..1024")
  }
  match session.val {
    Some(s) =>
      match s.state_export {
        Some(iterator) => {
          let rows = []
          for i = 0; i < limit; i = i + 1 {
            match iterator.next() {
              Some(event) => rows.push(event)
              None => break
            }
          }
          if rows.is_empty() {
            s.state_export = None
          }
          rows.to_json().stringify()
        }
        None => error_json(0, "请先开始状态分块导出")
      }
    None => error_json(0, "会话不可用")
  }
}

///|
/// 基准在每条记录后取出变化，队列始终只覆盖上一条记录。
pub fn drain_changes() -> String {
  match session.val {
    Some(s) => {
      let result = if s.config.correlation_keys.unwrap_or(false) {
        s.pending_changes
        .map(change => change.with_correlation_key())
        .to_json()
        .stringify() catch {
          @mrt.ParseError::Invalid(pos, message) =>
            return error_json(pos, message)
        }
      } else {
        s.pending_changes.to_json().stringify()
      }
      s.pending_changes.clear()
      result
    }
    None => error_json(0, "会话不可用")
  }
}

///|
pub fn reset_file() -> Unit {
  if session.val is Some(s) {
    s.decoder.reset()
    s.baseline = false
  }
}

///|
pub fn begin_baseline() -> String {
  match session.val {
    Some(s) =>
      match s.analyzer {
        Some(_) => {
          s.baseline = true
          s.baseline_seen = false
          "{}"
        }
        None => error_json(0, "parse 命令不加载分析基线")
      }
    None => error_json(0, "会话未配置")
  }
}

///|
pub fn end_baseline() -> String {
  let current = match session.val {
    Some(s) => s
    None => return error_json(0, "会话未配置")
  }
  if !current.baseline || !current.baseline_seen {
    return error_json(0, "初始 RIB 为空或缺少 peer 表")
  }
  if current.analyzer is Some(analyzer) {
    analyzer.set_baseline()
  }
  current.baseline = false
  "{}"
}

///|
pub fn finish() -> String {
  match session.val {
    Some(s) =>
      match s.analyzer {
        Some(analyzer) => {
          if s.timeline is Some(timeline) {
            let report = timeline.report() catch {
              @mrt.ParseError::Invalid(pos, message) =>
                return error_json(pos, message)
            }
            let enhanced = if s.config.correlation_keys.unwrap_or(false) {
              report.with_correlation_keys() catch {
                @mrt.ParseError::Invalid(pos, message) =>
                  return error_json(pos, message)
              }
            } else {
              report
            }
            return Json::object({
              "summary": analyzer.summary().to_json(),
              "timeline": enhanced.to_json(),
            }).stringify()
          }
          if s.aggregation is Some(aggregation) {
            return Json::object({
              "summary": analyzer.summary().to_json(),
              "aggregation": aggregation
              .report(top=s.config.top.unwrap_or(20))
              .to_json(),
            }).stringify() catch {
              @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
            }
          }
          analyzer.summary().to_json().stringify()
        }
        None => "{}"
      }
    None => error_json(0, "会话不可用")
  }
}

///|
pub fn snapshot_begin(
  before_collector : String,
  after_collector : String,
) -> String {
  let current = match session.val {
    Some(s) => s
    None => return error_json(0, "会话未配置")
  }
  try {
    snapshots.val = Some(
      (
        @mrt.Snapshot::new(before_collector, capacity=current.config.capacity),
        @mrt.Snapshot::new(after_collector, capacity=current.config.capacity),
      ),
    )
    "{}"
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn snapshot_consume(
  data : Bytes,
  after : Bool,
  file : String,
  record : Int64,
  offset : Int64,
) -> String {
  let current = match session.val {
    Some(s) => s
    None => return error_json(0, "会话未配置")
  }
  let pair = match snapshots.val {
    Some(p) => p
    None => return error_json(0, "快照会话未配置")
  }
  try {
    let snapshot = if after { pair.1 } else { pair.0 }
    snapshot.ingest(
      data,
      file,
      record,
      offset,
      query=current.query,
      peer_asn?=current.config.peer_asn,
    )
    "{}"
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}

///|
pub fn snapshot_finish() -> String {
  let pair = match snapshots.val {
    Some(p) => p
    None => return error_json(0, "快照会话未配置")
  }
  pair.0.diff(pair.1).to_json().stringify() catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
  }
}
