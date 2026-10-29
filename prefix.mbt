///|
pub struct Prefix {
  afi : Int32
  length : Int32
  address : Bytes
} derive(Eq, ToJson)

///|
pub extend Prefix with Eq::{equal, not_equal}

///|
pub extend Prefix with ToJson::{to_json}

///|
fn address_size(afi : Int32) -> Int32 raise ParseError {
  match afi {
    1 => 4
    2 => 16
    _ => raise Invalid(0, "不支持的地址族")
  }
}

///|
fn read_prefix(c : Cursor, afi : Int32) -> Prefix raise ParseError {
  let size = address_size(afi)
  let length = c.u8()
  if length > size * 8 {
    raise Invalid(c.pos - 1, "前缀长度超出地址族范围")
  }
  let raw = c.bytes((length + 7) / 8)
  let address = Array::make(size, b'\x00')
  for i = 0; i < raw.length(); i = i + 1 {
    address[i] = raw[i]
  }
  if length % 8 != 0 {
    let last = raw.length() - 1
    address[last] = (address[last].to_int() & (255 << (8 - length % 8))).to_byte()
  }
  { afi, length, address: Bytes::from_array(address), }
}

///|
pub fn parse_prefix(data : Bytes, afi : Int32) -> Prefix raise ParseError {
  let c = Cursor::new(data)
  let prefix = read_prefix(c, afi)
  c.finish()
  prefix
}

///|
fn ip_text(address : Bytes) -> String {
  if address.length() == 4 {
    return "\{address[0].to_int()}.\{address[1].to_int()}.\{address[2].to_int()}.\{address[3].to_int()}"
  }
  let groups = Array::makei(8, fn(i) {
    (address[i * 2].to_int() << 8) | address[i * 2 + 1].to_int()
  })
  let mut best_start = -1
  let mut best_len = 1
  let mut i = 0
  while i < 8 {
    if groups[i] == 0 {
      let start = i
      while i < 8 && groups[i] == 0 {
        i += 1
      }
      if i - start > best_len {
        best_start = start
        best_len = i - start
      }
    } else {
      i += 1
    }
  }
  let out = StringBuilder()
  i = 0
  while i < 8 {
    if i == best_start {
      out.write_string("::")
      i += best_len
    } else {
      if i > 0 && i != best_start + best_len {
        out.write_string(":")
      }
      out.write_string(groups[i].to_string(radix=16))
      i += 1
    }
  }
  out.to_string()
}

///|
pub fn Prefix::text(self : Prefix) -> String {
  "\{ip_text(self.address)}/\{self.length}"
}
