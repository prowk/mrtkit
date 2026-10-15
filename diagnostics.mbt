///|
pub struct Diagnostic {
  kind : String
  mrt_type : Int
  subtype : Int
  afi : Int?
  safi : Int?
  source : Source?
} derive(ToJson)

///|
pub extend Diagnostic with ToJson::{to_json}

///|
fn diagnostic(header : Header, afi : Int?, safi : Int?) -> Diagnostic {
  {
    kind: if afi is Some(_) {
      "mp"
    } else {
      "mrt"
    },
    mrt_type: header.kind,
    subtype: header.subtype,
    afi,
    safi,
    source: None,
  }
}
