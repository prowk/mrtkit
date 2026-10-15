///|
pub struct RouteSnapshot {
  timestamp : UInt
  microseconds : Int?
  active : Bool
  attributes : Attributes
  source : Source?
} derive(ToJson)

///|
pub extend RouteSnapshot with ToJson::{to_json}

///|
pub struct PathDiff {
  before : Array[AsSegment]
  after : Array[AsSegment]
} derive(ToJson)

///|
pub extend PathDiff with ToJson::{to_json}

///|
pub struct OriginDiff {
  before : UInt?
  after : UInt?
}

///|
pub impl ToJson for OriginDiff with fn to_json(self) {
  Json::object({
    "before": self.before.map(fn(n) { n.to_json() }).unwrap_or(Json::null()),
    "after": self.after.map(fn(n) { n.to_json() }).unwrap_or(Json::null()),
  })
}

///|
pub extend OriginDiff with ToJson::{to_json}

///|
pub struct HopDiff {
  before : String?
  after : String?
}

///|
pub impl ToJson for HopDiff with fn to_json(self) {
  Json::object({
    "before": self.before.map(fn(n) { n.to_json() }).unwrap_or(Json::null()),
    "after": self.after.map(fn(n) { n.to_json() }).unwrap_or(Json::null()),
  })
}

///|
pub extend HopDiff with ToJson::{to_json}

///|
pub struct CommunityDiff {
  before : Array[UInt]
  after : Array[UInt]
  added : Array[UInt]
  removed : Array[UInt]
} derive(ToJson)

///|
pub extend CommunityDiff with ToJson::{to_json}

///|
pub struct RouteDiff {
  path : PathDiff?
  origin_as : OriginDiff?
  next_hop : HopDiff?
  communities : CommunityDiff?
} derive(ToJson)

///|
pub extend RouteDiff with ToJson::{to_json}

///|
fn unique_communities(values : Array[UInt]) -> Array[UInt] {
  let sorted = values.copy()
  sorted.sort()
  let result = []
  for value in sorted {
    if result.last() != Some(value) {
      result.push(value)
    }
  }
  result
}

///|
fn route_diff(a : Attributes, b : Attributes) -> RouteDiff {
  let ac = unique_communities(a.communities)
  let bc = unique_communities(b.communities)
  {
    path: if same_path(a.path, b.path) {
      None
    } else {
      Some({ before: a.path, after: b.path, })
    },
    origin_as: if origin_as(a.path) == origin_as(b.path) {
      None
    } else {
      Some({ before: origin_as(a.path), after: origin_as(b.path), })
    },
    next_hop: if a.next_hop == b.next_hop {
      None
    } else {
      Some({ before: a.next_hop, after: b.next_hop, })
    },
    communities: if ac == bc {
      None
    } else {
      Some({
        before: ac,
        after: bc,
        added: bc.filter(fn(n) { !ac.contains(n) }),
        removed: ac.filter(fn(n) { !bc.contains(n) }),
      })
    },
  }
}

///|
fn route_snapshot(
  event : RouteEvent,
  active : Bool,
  attributes : Attributes,
) -> RouteSnapshot {
  {
    timestamp: event.timestamp,
    microseconds: event.microseconds,
    active,
    attributes,
    source: event.source,
  }
}
