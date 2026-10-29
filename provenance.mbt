///|
pub struct Source {
  file : String
  record : Int64
  offset : Int64
  event_index : Int32
  collector : String?
  view : String?
} derive(Eq, Hash, ToJson)

///|
pub extend Source with Eq::{equal, not_equal}

///|
pub extend Source with Hash::{hash, hash_combine}

///|
pub extend Source with ToJson::{to_json}

///|
/// 偏移指解压后的 MRT 记录起点，索引为记录内零起始事件序号。
pub fn Decoder::decode_at(
  self : Decoder,
  data : Bytes,
  file : String,
  record : Int64,
  offset : Int64,
) -> Batch raise ParseError {
  if record < 1L || offset < 0L {
    raise Invalid(0, "来源记录号或偏移无效")
  }
  let batch = self.decode(data)
  let events = batch.events.mapi(fn(i, event) {
    {
      ..event,
      source: Some({
        file,
        record,
        offset,
        event_index: i,
        collector: None,
        view: None,
      }),
    }
  })
  let states = batch.states.mapi(fn(i, event) {
    {
      ..event,
      source: Some({
        file,
        record,
        offset,
        event_index: i,
        collector: None,
        view: None,
      }),
    }
  })
  let diagnostics = batch.diagnostics.map(fn(item) {
    {
      ..item,
      source: Some({
        file,
        record,
        offset,
        event_index: 0,
        collector: None,
        view: None,
      }),
    }
  })
  { ..batch, events, states, diagnostics, }
}

///|
/// 一个采集器与视图使用一个独立 Decoder；本接口为事件、会话和诊断附加显式身份。
pub fn Decoder::decode_scoped(
  self : Decoder,
  data : Bytes,
  file : String,
  record : Int64,
  offset : Int64,
  collector : String,
  view : String,
) -> Batch raise ParseError {
  if collector == "" || view == "" {
    raise Invalid(0, "采集器和视图身份不能为空")
  }
  let batch = self.decode_at(data, file, record, offset)
  let scope = fn(source : Source?) {
    source.map(fn(s) { { ..s, collector: Some(collector), view: Some(view), } })
  }
  {
    ..batch,
    events: batch.events.map(fn(event) {
      { ..event, source: scope(event.source), }
    }),
    states: batch.states.map(fn(state) {
      { ..state, source: scope(state.source), }
    }),
    diagnostics: batch.diagnostics.map(fn(item) {
      { ..item, source: scope(item.source), }
    }),
  }
}

///|
fn source_scope(source : Source?) -> String {
  match source {
    Some(s) if s.collector is Some(_) || s.view is Some(_) =>
      Json([s.collector, s.view]).stringify() + "|"
    _ => ""
  }
}

///|
fn scoped_peer_key(
  asn : UInt32,
  ip : String,
  outbound : Bool,
  source : Source?,
) -> String {
  source_scope(source) + peer_key(asn, ip, outbound)
}
