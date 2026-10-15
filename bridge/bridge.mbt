///|
priv struct Config {
  prefix : String?
  asn : UInt?
  peer_asn : UInt?
  from_time : UInt
  to_time : UInt
  from_micros : Int?
  to_micros : Int?
  window_seconds : Int
  threshold : Int
  capacity : Int
  mode : String
  format : String
} derive(@json.FromJson)

///|
priv struct Session {
  decoder : @mrt.Decoder
  query : @mrt.Query
  analyzer : @mrt.Analyzer?
  config : Config
  mut baseline : Bool
}

///|
let session : Ref[Session?] = Ref(None)

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
  try {
    let config : Config = @json.from_json(@json.parse(text))
    if config.mode != "parse" &&
      config.mode != "stats" &&
      config.mode != "changes" {
      return error_json(0, "命令必须为 parse、stats 或 changes")
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
      asn?=config.asn,
      from_time?=if config.mode == "parse" {
        Some(config.from_time)
      } else {
        None
      },
      to_time?=if config.mode == "parse" { Some(config.to_time) } else { None },
    )
    let analyzer = if config.mode == "parse" {
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
    session.val = Some({
      decoder: @mrt.Decoder::new(),
      query,
      analyzer,
      config,
      baseline: false,
    })
    "{}"
  } catch {
    @mrt.ParseError::Invalid(pos, message) => error_json(pos, message)
    _ => error_json(0, "配置 JSON 无效")
  }
}

///|
pub fn consume(data : Bytes) -> String {
  let current = match session.val {
    Some(s) => s
    None => return error_json(0, "会话未配置")
  }
  try {
    let batch = current.decoder.decode(data)
    if current.baseline && batch.header.kind != 13 {
      return error_json(0, "初始 RIB 文件只能包含 TABLE_DUMP_V2")
    }
    if !current.baseline && current.analyzer is Some(analyzer) {
      analyzer.record_batch(batch)
    }
    let lines = []
    for event in batch.events {
      if !current.query.matches(event) {
        continue
      }
      if current.config.peer_asn is Some(asn) && event.peer_asn != asn {
        continue
      }
      match current.analyzer {
        Some(analyzer) => {
          if current.baseline {
            analyzer.seed(event)
            continue
          }
          let changes = analyzer.observe(event)
          if current.config.mode == "changes" {
            for item in changes {
              lines.push(item.to_json().stringify())
            }
          }
        }
        None =>
          lines.push(
            if current.config.format == "csv" {
              @mrt.event_csv(event)
            } else {
              @mrt.event_json(event)
            },
          )
      }
    }
    Json::object({
      "lines": lines.to_json(),
      "skipped": batch.skipped.to_json(),
      "ignored_families": batch.ignored_families.to_json(),
    }).stringify()
  } catch {
    @mrt.ParseError::Invalid(pos, message) => {
      session.val = None
      error_json(pos, message)
    }
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
        Some(analyzer) => {
          s.baseline = true
          analyzer.set_baseline()
          "{}"
        }
        None => error_json(0, "parse 命令不加载分析基线")
      }
    None => error_json(0, "会话未配置")
  }
}

///|
pub fn finish() -> String {
  match session.val {
    Some(s) =>
      match s.analyzer {
        Some(analyzer) => analyzer.summary().to_json().stringify()
        None => "{}"
      }
    None => error_json(0, "会话不可用")
  }
}
