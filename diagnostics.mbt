///|
pub struct Diagnostic {
  kind : String
  mrt_type : Int32
  subtype : Int32
  afi : Int32?
  safi : Int32?
  source : Source?
} derive(ToJson)

///|
pub extend Diagnostic with ToJson::{to_json}

///|
fn diagnostic(header : Header, afi : Int32?, safi : Int32?) -> Diagnostic {
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
