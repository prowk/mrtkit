///|
fn investigation_fixture(
  time : UInt32,
  peer : UInt32,
  path : Array[UInt32],
  action~ : String = "announce",
  path_id? : UInt32,
) -> RouteEvent {
  let event = sample_event(time, action, path)
  {
    ..event,
    peer_asn: peer,
    path_id,
    source: Some({
      file: "sample.mrt",
      record: time.to_int64(),
      offset: time.to_int64(),
      event_index: peer.reinterpret_as_int(),
      collector: Some("test"),
      view: Some("v"),
    }),
  }
}

///|
fn investigation_array(report : Json, key : String) -> Array[Json] {
  match report {
    Object(fields) =>
      match fields.get(key) {
        Some(Array(rows)) => rows
        _ => []
      }
    _ => []
  }
}

///|
test "调查按来源计事件和提醒，撤回查询保留前值与半开端点" {
  let engine = Investigation::new(
    "{\"schema_version\":\"1.0\",\"version\":\"test\",\"from_us\":\"100000000\",\"to_us\":\"110000000\",\"bucket_us\":\"5000000\",\"continuous\":true,\"query\":{\"origin_asns\":[2],\"side\":\"before\"}}",
  )
  engine.observe(investigation_fixture(100U, 1U, [1U]))
  engine.observe(investigation_fixture(101U, 1U, [2U]))
  engine.observe(investigation_fixture(102U, 1U, [], action="withdraw"))
  engine.observe(investigation_fixture(110U, 1U, [3U]))
  let report = engine.report()
  assert_eq(investigation_array(report, "events").length(), 3)
  assert_eq(investigation_array(report, "selected").length(), 1)
  assert_true(
    investigation_array(report, "selected")[0]
    is {
      "kind": "withdraw",
      "before": { "active": true, .. },
      "after": { "active": false, .. },
      ..
    },
  )
  assert_true(
    report
    is {
      "summary": {
        "all": { "events": 3, "notices": 2, .. },
        "selected": { "events": 1, "notices": 0, .. },
        ..
      },
      ..
    },
  )
}

///|
test "正常 MOAS 同时性、ADD-PATH 单路径撤回与 AS_SET 未知" {
  let engine = Investigation::new(
    "{\"schema_version\":\"1.0\",\"version\":\"test\",\"from_us\":\"100000000\",\"to_us\":\"110000000\",\"continuous\":true}",
  )
  engine.observe(investigation_fixture(100U, 1U, [1U], path_id=0U))
  engine.observe(investigation_fixture(101U, 1U, [2U], path_id=1U))
  engine.observe(
    investigation_fixture(102U, 1U, [], action="withdraw", path_id=1U),
  )
  let set = investigation_fixture(103U, 2U, [3U])
  engine.observe({
    ..set,
    attributes: { ..set.attributes, path: [{ kind: 1, asns: [3U, 4U], }], },
  })
  let report = engine.report()
  let moas = investigation_array(report, "moas")
  assert_eq(moas.length(), 1)
  assert_true(
    moas[0]
    is {
      "from_us": "101000000",
      "to_us": "102000000",
      "origins": [1, 2],
      "duration_us": "1000000",
      "evidence": [
        { "observed_at_us": "100000000", "time_precision": "second", .. },
        { "observed_at_us": "101000000", "time_precision": "second", .. },
      ],
      ..
    },
  )
  let intervals = investigation_array(report, "intervals")
  assert_true(
    intervals.any(fn(row) {
      row is { "path_id": 0, "state": "active", "to_us": "110000000", .. }
    }),
  )
}

///|
test "起源先后变更不产生 MOAS，乱序沿用拒绝语义" {
  let engine = Investigation::new(
    "{\"schema_version\":\"1.0\",\"version\":\"test\",\"from_us\":\"100000000\",\"to_us\":\"110000000\"}",
  )
  engine.observe(investigation_fixture(100U, 1U, [1U]))
  engine.observe(investigation_fixture(103U, 1U, [2U]))
  engine.observe(investigation_fixture(102U, 1U, [3U]))
  let report = engine.report()
  assert_eq(investigation_array(report, "moas").length(), 0)
  assert_true(
    investigation_array(report, "events")[1]
    is { "kind": "out_of_order", "accepted": false, .. },
  )
  assert_true(
    report
    is {
      "comparison": { "status": "not_configured", .. },
      "quality": { "baseline": "missing", .. },
      ..
    },
  )
}

///|
test "缺档清除连续性，会话重置不延续 MOAS" {
  let engine = Investigation::new(
    "{\"schema_version\":\"1.0\",\"version\":\"test\",\"from_us\":\"100000000\",\"to_us\":\"110000000\",\"gaps\":[{\"from_us\":\"103000000\",\"to_us\":\"104000000\"}]}",
  )
  engine.observe(investigation_fixture(100U, 1U, [1U]))
  engine.observe(investigation_fixture(101U, 2U, [2U]))
  engine.observe(investigation_fixture(105U, 2U, [2U]))
  engine.observe_state({
    timestamp: 106U,
    microseconds: None,
    peer_asn: 2U,
    peer_ip: "192.0.2.1",
    old_state: 6,
    new_state: 1,
    source: Some({
      file: "state.mrt",
      record: 1L,
      offset: 0L,
      event_index: 0,
      collector: Some("test"),
      view: Some("v"),
    }),
  })
  let report = engine.report()
  let moas = investigation_array(report, "moas")
  assert_eq(moas.length(), 1)
  assert_true(moas[0] is { "to_us": "103000000", "duration_us": Null, .. })
  assert_true(
    investigation_array(report, "intervals").any(fn(row) {
      row
      is { "state": "gap", "from_us": "103000000", "to_us": "104000000", .. }
    }),
  )
  assert_eq(investigation_array(report, "controls").length(), 2)
}

///|
test "IPv6 更具体规则区分未配置、允许与预期外，调查窗口不链式延长" {
  let engine = Investigation::new(
    "{\"schema_version\":\"1.0\",\"version\":\"test\",\"from_us\":\"100000000\",\"to_us\":\"120000000\",\"incident_us\":\"2000000\",\"focus\":[{\"prefix\":\"::/0\"},{\"prefix\":\"2001:db8::/32\",\"expected_origins\":[1],\"allowed_more_specifics\":[\"2001:db8:1::/48\"]}]}",
  )
  for time in [100U, 101U, 102U] {
    engine.observe({
      ..investigation_fixture(time, 1U, [2U]),
      prefix: "2001:db8:2::/48",
    })
  }
  engine.observe({
    ..investigation_fixture(103U, 2U, [2U]),
    prefix: "2001:db8:1::/48",
  })
  let report = engine.report()
  let findings = investigation_array(report, "findings")
  assert_eq(findings.length(), 8)
  assert_true(
    findings.any(fn(row) {
      row is { "condition": "expectation_unconfigured", .. }
    }),
  )
  assert_true(
    findings.any(fn(row) { row is { "condition": "allowed_more_specific", .. } }),
  )
  assert_eq(investigation_array(report, "incidents").length(), 2)
}

///|
test "基线与对比按共同 peer 有效时长计算，社区顺序与重复宣告不产生提醒" {
  let engine = Investigation::new(
    "{\"schema_version\":\"1.0\",\"version\":\"test\",\"from_us\":\"100000000\",\"to_us\":\"110000000\",\"continuous\":true,\"sequence_prefix\":\"192.0.2.0/24\",\"comparison\":[{\"from_us\":\"100000000\",\"to_us\":\"105000000\"},{\"from_us\":\"105000000\",\"to_us\":\"110000000\"}],\"query\":{\"path_asns\":[1],\"communities\":[2]}}",
  )
  let event = investigation_fixture(99U, 1U, [1U])
  engine.observe(
    {
      ..event,
      action: "rib",
      attributes: { ..event.attributes, communities: [1U, 2U], },
    },
    baseline=true,
  )
  for time in [101U, 106U] {
    let event = investigation_fixture(time, 1U, [1U])
    engine.observe({
      ..event,
      attributes: { ..event.attributes, communities: [2U, 1U], },
    })
  }
  let report = engine.report()
  assert_eq(investigation_array(report, "initial").length(), 1)
  assert_true(
    report
    is {
      "quality": { "baseline": "explicit_rib", .. },
      "summary": { "all": { "events": 2, "notices": 0, .. }, .. },
      "comparison": {
        "status": "comparable_observations",
        "windows": [
          { "confirmed_peer_us": "5000000", "origins": [1], .. },
          { "confirmed_peer_us": "5000000", .. },
        ],
        ..
      },
      ..
    },
  )
}

///|
test "空输入与容量界限显式输出未知或失败" {
  let engine = Investigation::new(
    "{\"schema_version\":\"1.0\",\"version\":\"test\",\"from_us\":\"100000000\",\"to_us\":\"110000000\",\"capacity\":1}",
  )
  assert_true(
    engine.report()
    is {
      "summary": {
        "all": { "events": 0, "buckets": [{ "events": Null, .. }], .. },
        ..
      },
      ..
    },
  )
  engine.set_baseline_scope("test", "v")
  assert_true(
    engine.report() is { "quality": { "baseline": "explicit_rib", .. }, .. },
  )
  engine.observe(investigation_fixture(100U, 1U, [1U]))
  assert_true(
    try {
      engine.observe(investigation_fixture(101U, 1U, [1U]))
      false
    } catch {
      _ => true
    },
  )
}

///|
test "仅基线存在的更具体路由仍输出活动证据和路径时长分布" {
  let engine = Investigation::new(
    "{\"schema_version\":\"1.0\",\"version\":\"baseline-test\",\"from_us\":\"100000000\",\"to_us\":\"110000000\",\"continuous\":true,\"sequence_prefix\":\"192.0.2.0/24\",\"focus\":[{\"prefix\":\"0.0.0.0/0\",\"expected_origins\":[1]}],\"comparison\":[{\"from_us\":\"100000000\",\"to_us\":\"105000000\"},{\"from_us\":\"105000000\",\"to_us\":\"110000000\"}]}",
  )
  engine.observe(
    investigation_fixture(99U, 1U, [1U], action="rib"),
    baseline=true,
  )
  let report = engine.report()
  assert_eq(investigation_array(report, "events").length(), 0)
  assert_eq(investigation_array(report, "more_specifics").length(), 1)
  assert_true(
    investigation_array(report, "more_specifics")[0]
    is {
      "condition": "same_origin_more_specific",
      "from_us": "100000000",
      "to_us": "110000000",
      ..
    },
  )
  assert_true(
    report
    is {
      "comparison": {
        "windows": [
          { "path_length_observed_path_us": [[1, "5000000"]], .. },
          { "path_length_observed_path_us": [[1, "5000000"]], .. },
        ],
        ..
      },
      ..
    },
  )
}
