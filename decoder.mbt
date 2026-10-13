///|
pub struct Batch {
  header : Header
  events : Array[RouteEvent]
  states : Array[StateChange]
  skipped : Bool
  ignored_families : Int
  message_type : Int?
} derive(ToJson)

///|
pub extend Batch with ToJson::{to_json}

///|
pub struct Decoder {
  priv mut peers : Array[Peer]
  priv mut has_peers : Bool
}

///|
pub fn Decoder::new() -> Decoder {
  { peers: [], has_peers: false, }
}

///|
/// 新文件必须清除 peer 表，防止沿用前一文件的索引。
pub fn Decoder::reset(self : Decoder) -> Unit {
  self.peers = []
  self.has_peers = false
}

///|
pub fn Decoder::decode(self : Decoder, data : Bytes) -> Batch raise ParseError {
  let frame = read_frame(data)
  let header = frame.header
  let empty : Batch = {
    header,
    events: [],
    states: [],
    skipped: false,
    ignored_families: 0,
    message_type: None,
  }
  if header.kind == 13 {
    if header.subtype == 1 {
      let table = parse_peers(frame.payload)
      self.peers = table.peers
      self.has_peers = true
      return empty
    }
    if header.subtype == 2 || header.subtype == 4 {
      if !self.has_peers {
        raise Invalid(12, "RIB 之前缺少 PEER_INDEX_TABLE")
      }
      return { ..empty, events: parse_rib(frame, self.peers), }
    }
  }
  if (header.kind == 16 || header.kind == 17) &&
    (
      header.subtype == 0 ||
      header.subtype == 1 ||
      header.subtype == 4 ||
      header.subtype == 5 ||
      header.subtype == 6 ||
      header.subtype == 7
    ) {
    let parsed = parse_bgp4mp(frame)
    return {
      ..empty,
      events: parsed.events,
      states: parsed.states,
      ignored_families: parsed.ignored_families,
      message_type: Some(parsed.message_type),
    }
  }
  { ..empty, skipped: true, }
}

///|
pub struct StreamDecoder {
  priv decoder : Decoder
  priv mut pending : Bytes
  priv mut failed : Bool
}

///|
pub fn StreamDecoder::new() -> StreamDecoder {
  { decoder: Decoder::new(), pending: b"", failed: false, }
}

///|
/// 输入分块上限 1 MiB，失败后需新建解码器。
pub fn StreamDecoder::feed(
  self : StreamDecoder,
  chunk : Bytes,
) -> Array[Batch] raise ParseError {
  if self.failed {
    raise Invalid(0, "解码器已失败，请新建会话")
  }
  errdefer {
    self.failed = true
  }
  if chunk.length() > 1048576 {
    raise Invalid(0, "输入分块超过 1 MiB")
  }
  let data = self.pending + chunk
  let batches = []
  let mut offset = 0
  while data.length() - offset >= 12 {
    let c : Cursor = { data, pos: offset + 8, end: data.length(), }
    let length = c.u32()
    if length > 16777216U {
      raise Invalid(offset + 8, "MRT 记录超过 16 MiB 上限")
    }
    let size = length.reinterpret_as_int() + 12
    if data.length() - offset < size {
      break
    }
    batches.push(self.decoder.decode(data[offset:offset + size].to_owned()))
    offset += size
  }
  self.pending = data[offset:].to_owned()
  batches
}

///|
pub fn StreamDecoder::finish(self : StreamDecoder) -> Unit raise ParseError {
  if self.failed {
    raise Invalid(0, "解码器已失败")
  }
  if self.pending.length() != 0 {
    self.failed = true
    raise Invalid(0, "文件结束时存在截断记录")
  }
}
