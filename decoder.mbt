///|
pub struct Batch {
  header : Header
  microseconds : Int32?
  events : Array[RouteEvent]
  states : Array[StateChange]
  skipped : Bool
  ignored_families : Int32
  message_type : Int32?
  diagnostics : Array[Diagnostic]
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
    microseconds: frame.microseconds,
    events: [],
    states: [],
    skipped: false,
    ignored_families: 0,
    message_type: None,
    diagnostics: [],
  }
  if header.kind == 13 {
    if header.subtype == 1 {
      let table = parse_peers(frame.payload)
      self.peers = table.peers
      self.has_peers = true
      return empty
    }
    if header.subtype == 2 ||
      header.subtype == 4 ||
      header.subtype == 8 ||
      header.subtype == 10 {
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
      header.subtype == 7 ||
      (header.subtype >= 8 && header.subtype <= 11)
    ) {
    let parsed = parse_bgp4mp(frame)
    return {
      ..empty,
      events: parsed.events,
      states: parsed.states,
      ignored_families: parsed.ignored_families,
      message_type: Some(parsed.message_type),
      diagnostics: parsed.ignored.map(fn(pair) {
        diagnostic(header, Some(pair.0), Some(pair.1))
      }),
    }
  }
  { ..empty, skipped: true, diagnostics: [diagnostic(header, None, None)], }
}

///|
pub struct StreamDecoder {
  priv decoder : Decoder
  priv mut pending : @buffer.Buffer
  priv mut expected : Int32
  priv mut header_ready : Bool
  priv mut failed : Bool
}

///|
pub fn StreamDecoder::new() -> StreamDecoder {
  {
    decoder: Decoder::new(),
    pending: @buffer.Buffer(size_hint=12),
    expected: 12,
    header_ready: false,
    failed: false,
  }
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
  let batches = []
  let mut offset = 0
  while offset < chunk.length() {
    let wanted = self.expected - self.pending.length()
    let available = chunk.length() - offset
    let take = if wanted < available { wanted } else { available }
    self.pending.write_bytes(chunk[offset:offset + take])
    offset += take
    if !self.header_ready && self.pending.length() == 12 {
      let header = self.pending.to_bytes()
      let c : Cursor = { data: header, pos: 8, end: 12, }
      let length = c.u32()
      if length > 16777216U {
        raise Invalid(8, "MRT 记录超过 16 MiB 上限")
      }
      self.expected = length.reinterpret_as_int() + 12
      self.header_ready = true
      // 验证长度后一次分配记录容量，碎片输入只复制新增字节。
      self.pending = @buffer.Buffer(size_hint=self.expected)
      self.pending.write_bytes(header[:])
    }
    if self.header_ready && self.pending.length() == self.expected {
      batches.push(self.decoder.decode(self.pending.to_bytes()))
      self.pending = @buffer.Buffer(size_hint=12)
      self.header_ready = false
      self.expected = 12
    }
  }
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
