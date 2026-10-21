///|
/// 按 RFC 6793 保留旧路径前缀，再拼接 AS4_PATH。
pub fn reconstruct_path(
  path : Array[AsSegment],
  as4 : Array[AsSegment],
) -> Array[AsSegment] {
  // RFC 6793 §6 只剔除 AS4_PATH 中的联盟段，其余有效分段继续参与还原。
  let compatible = as4.filter(fn(s) { s.kind < 3 })
  if compatible.is_empty() {
    return path
  }
  let mut keep = path_length(path) - path_length(compatible)
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
  for segment in compatible {
    result.push(segment)
  }
  result
}

///|
fn effective_path(
  path : Array[AsSegment],
  as4 : Array[AsSegment],
  aggregator : Aggregator?,
  as4_aggregator : Aggregator?,
  width : Int,
) -> Array[AsSegment] {
  if width == 4 {
    return path
  }
  if aggregator is Some(old) && as4_aggregator is Some(_) && old.asn != 23456U {
    return path
  }
  reconstruct_path(path, as4)
}
