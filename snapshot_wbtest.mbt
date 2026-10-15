///|
test "快照比较区分 peer 缺失并使用路由属性的语义比较" {
  let before = Snapshot::new("collector")
  let after = Snapshot::new("collector")
  let peer : Peer = { bgp_id: 1U, address: "192.0.2.1", asn: 64512U, }
  let table : PeerTable = { collector_id: 1U, view_name: b"", peers: [peer], }
  before.table = Some(table)
  after.table = Some(table)
  before.first_time = Some(100U)
  after.first_time = Some(200U)
  let key = peer_key(peer.asn, peer.address, false)
  before.peers[key] = peer
  after.peers[key] = peer
  let event = {
    ..sample_event(100U, "rib", [64512U, 1U]),
    peer_ip: peer.address,
  }
  let route_key = snapshot_route_key(event)
  before.routes[route_key] = event
  after.routes[route_key] = {
    ..event,
    timestamp: 200U,
    attributes: {
      ..event.attributes,
      path: [{ kind: 2, asns: [64512U, 2U], }],
    },
  }
  assert_eq(before.diff(after).changes.map(fn(c) { c.kind }), [
    "path_change", "origin_change",
  ])
  after.routes.remove(route_key)
  assert_eq(before.diff(after).changes[0].kind, "route_missing")
  after.peers.remove(key)
  assert_eq(before.diff(after).changes.length(), 1)
  assert_eq(before.diff(after).changes[0].kind, "peer_missing")
}
