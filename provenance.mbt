///|
pub struct Source {
  file : String
  record : Int64
  offset : Int64
  event_index : Int
} derive(Eq, ToJson)

///|
pub extend Source with Eq::{equal, not_equal}

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
    { ..event, source: Some({ file, record, offset, event_index: i, }), }
  })
  let states = batch.states.mapi(fn(i, event) {
    { ..event, source: Some({ file, record, offset, event_index: i, }), }
  })
  { ..batch, events, states, }
}
