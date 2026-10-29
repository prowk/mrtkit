///|
priv struct SharedAttributes {
  wire : Attributes
  semantic : Attributes
  mut references : Int32
}

///|
pub struct StorageStats {
  route_keys : Int32
  unique_attribute_sets : Int32
  attribute_references : Int32
} derive(ToJson)

///|
pub extend StorageStats with ToJson::{to_json}

///|
fn Analyzer::retain_attributes(
  self : Analyzer,
  attributes : Attributes,
  semantic : Attributes,
) -> SharedAttributes {
  match self.attribute_pool.get(attributes) {
    Some(shared) => {
      shared.references += 1
      shared
    }
    None => {
      let shared = { wire: attributes, semantic, references: 1, }
      self.attribute_pool[attributes] = shared
      shared
    }
  }
}

///|
fn Analyzer::release_attributes(
  self : Analyzer,
  shared : SharedAttributes,
) -> Unit {
  shared.references -= 1
  if shared.references == 0 {
    self.attribute_pool.remove(shared.wire)
  }
}

///|
/// 共享只按完整原始属性相等判定；哈希碰撞仍通过 Eq 检查，不丢弃来源和编码。
pub fn Analyzer::storage_stats(self : Analyzer) -> StorageStats {
  let mut references = 0
  for _, shared in self.attribute_pool {
    references += shared.references
  }
  {
    route_keys: self.routes.length(),
    unique_attribute_sets: self.attribute_pool.length(),
    attribute_references: references,
  }
}
