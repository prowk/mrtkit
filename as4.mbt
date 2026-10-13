///|
/// 按 RFC 6793 保留旧路径前缀，再拼接 AS4_PATH。
pub fn reconstruct_path(
  path : Array[AsSegment],
  as4 : Array[AsSegment],
) -> Array[AsSegment] {
  if as4.is_empty() || as4.any(fn(s) { s.kind >= 3 }) {
    return path
  }
  let mut keep = path_length(path) - path_length(as4)
  if keep < 0 {
    return path
  }
  let result = []
  for segment in path {
    if segment.kind >= 3 {
      result.push(segment)
    } else if keep == 0 {
      break
    } else if segment.kind == 1 {
      result.push(segment)
      keep -= 1
    } else {
      let count = if keep < segment.asns.length() {
        keep
      } else {
        segment.asns.length()
      }
      result.push({ kind: 2, asns: segment.asns[0:count].to_owned(), })
      keep -= count
      if count != segment.asns.length() {
        break
      }
    }
  }
  for segment in as4 {
    result.push(segment)
  }
  result
}

///|
fn effective_path(
  path : Array[AsSegment],
  as4 : Array[AsSegment],
  other : Array[RawAttribute],
  width : Int,
) -> Array[AsSegment] {
  if width == 4 {
    return path
  }
  for attr in other {
    // 旧 AGGREGATOR 不是 AS_TRANS 时必须忽略 AS4_PATH。
    if attr.code == 7 && attr.value.length() == 6 {
      let asn = (attr.value[0].to_int() << 8) | attr.value[1].to_int()
      if asn != 23456 {
        return path
      }
    }
  }
  reconstruct_path(path, as4)
}
