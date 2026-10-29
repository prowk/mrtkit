///|
fn decimal(text : StringView, maximum : Int32) -> Int32 raise ParseError {
  if text.is_empty() {
    raise Invalid(0, "缺少十进制数字")
  }
  let mut value = 0
  for ch in text {
    if ch < '0' || ch > '9' {
      raise Invalid(0, "十进制数字无效")
    }
    value = value * 10 + ch.to_int() - 48
    if value > maximum {
      raise Invalid(0, "十进制数字超出范围")
    }
  }
  value
}

///|
fn ipv4_bytes(text : String) -> Bytes raise ParseError {
  let parts = text.split(".").to_array()
  if parts.length() != 4 {
    raise Invalid(0, "IPv4 地址必须包含四段")
  }
  let result = []
  for part in parts {
    if part.length() > 1 && part.has_prefix("0") {
      raise Invalid(0, "IPv4 地址不接受前导零")
    }
    result.push(decimal(part, 255).to_byte())
  }
  Bytes::from_array(result)
}

///|
fn hex_groups(text : StringView) -> Array[Int32] raise ParseError {
  if text.is_empty() {
    return []
  }
  let groups = []
  for part in text.split(":") {
    if part.is_empty() || part.length() > 4 {
      raise Invalid(0, "IPv6 分组无效")
    }
    let mut value = 0
    for ch in part {
      let digit = if ch >= '0' && ch <= '9' {
        ch.to_int() - 48
      } else if ch >= 'a' && ch <= 'f' {
        ch.to_int() - 87
      } else {
        raise Invalid(0, "IPv6 十六进制数字无效")
      }
      value = value * 16 + digit
    }
    groups.push(value)
  }
  groups
}

///|
fn ip_bytes(text : String) -> (Int32, Bytes) raise ParseError {
  if !text.contains(":") {
    return (1, ipv4_bytes(text))
  }
  let mut input = text.to_lower()
  if input.contains(".") {
    let (head, tail) = input.rev_split_once(":").unwrap()
    let bytes = ipv4_bytes(tail.to_owned())
    let a = (bytes[0].to_int() << 8) | bytes[1].to_int()
    let b = (bytes[2].to_int() << 8) | bytes[3].to_int()
    input = head.to_owned() +
      ":" +
      a.to_string(radix=16) +
      ":" +
      b.to_string(radix=16)
  }
  let parts = input.split("::").to_array()
  if parts.length() > 2 {
    raise Invalid(0, "IPv6 只能压缩一次")
  }
  let left = hex_groups(parts[0])
  let right = if parts.length() == 2 { hex_groups(parts[1]) } else { [] }
  let count = left.length() + right.length()
  if (parts.length() == 1 && count != 8) || (parts.length() == 2 && count >= 8) {
    raise Invalid(0, "IPv6 地址长度无效")
  }
  let groups = left + Array::make(8 - count, 0) + right
  let bytes = []
  for group in groups {
    bytes.push((group >> 8).to_byte())
    bytes.push(group.to_byte())
  }
  (2, Bytes::from_array(bytes))
}

///|
/// 库和 CLI 共用的文本解析；没有掩码的地址表示主机前缀。
pub fn parse_prefix_text(text : String) -> Prefix raise ParseError {
  let parts = text.split("/").to_array()
  if parts.length() > 2 || text.is_empty() {
    raise Invalid(0, "前缀文本无效")
  }
  let (afi, address) = ip_bytes(parts[0].to_owned())
  let length = if parts.length() == 2 {
    decimal(parts[1], address.length() * 8)
  } else {
    address.length() * 8
  }
  let bytes = [length.to_byte()]
  for i = 0; i < (length + 7) / 8; i = i + 1 {
    bytes.push(address[i])
  }
  parse_prefix(Bytes::from_array(bytes), afi)
}

///|
pub fn Prefix::contains(self : Prefix, other : Prefix) -> Bool {
  if self.afi != other.afi || self.length > other.length {
    return false
  }
  for i = 0; i < (self.length + 7) / 8; i = i + 1 {
    let remaining = self.length - i * 8
    let mask = if remaining >= 8 { 255 } else { 255 << (8 - remaining) }
    if (self.address[i].to_int() & mask) != (other.address[i].to_int() & mask) {
      return false
    }
  }
  true
}
