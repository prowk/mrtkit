///|
/// AS_SET 无序，连续 AS_SEQUENCE 的分段边界不影响路径含义。
fn canonical_path(path : Array[AsSegment]) -> Array[AsSegment] {
  let result : Array[AsSegment] = []
  for segment in path {
    if segment.kind == 1 || segment.kind == 4 {
      let sorted = segment.asns.copy()
      sorted.sort()
      let unique = []
      for asn in sorted {
        if unique.last() != Some(asn) {
          unique.push(asn)
        }
      }
      result.push({ kind: segment.kind, asns: unique, })
    } else {
      match result.last() {
        Some(previous) if previous.kind == segment.kind =>
          result[result.length() - 1] = {
            kind: segment.kind,
            asns: previous.asns + segment.asns,
          }
        _ => result.push(segment)
      }
    }
  }
  result
}

///|
fn same_path(a : Array[AsSegment], b : Array[AsSegment]) -> Bool {
  canonical_path(a) == canonical_path(b)
}

///|
fn route_attributes_equal(a : Attributes, b : Attributes) -> Bool {
  if !same_path(a.path, b.path) ||
    a.origin != b.origin ||
    a.next_hop != b.next_hop ||
    a.med != b.med ||
    a.local_pref != b.local_pref {
    return false
  }
  let ac = unique_communities(a.communities)
  let bc = unique_communities(b.communities)
  if ac != bc {
    return false
  }
  if unique_large_communities(a.large_communities) !=
    unique_large_communities(b.large_communities) {
    return false
  }
  // 同一 UPDATE 携带的其他前缀及 ASN 兼容编码不构成该路由的变化。
  let ao = a.other.filter(fn(attr) {
    attr.code != 14 && attr.code != 15 && attr.code != 32
  })
  let bo = b.other.filter(fn(attr) {
    attr.code != 14 && attr.code != 15 && attr.code != 32
  })
  ao.sort_by_key(fn(attr) { attr.code })
  bo.sort_by_key(fn(attr) { attr.code })
  ao == bo
}
