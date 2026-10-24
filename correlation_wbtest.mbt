///|
test "关联键忽略路径分段和观测身份，属性规则仍区分 MED 等无简写 diff 的值" {
  let analyzer = Analyzer::new()
  let first = sample_event(100U, "announce", [1U, 2U])
  ignore(analyzer.observe(first))
  let changed = analyzer.observe(sample_event(101U, "announce", [1U, 3U]))[0]
  let split = {
    ..changed,
    before: changed.before.map(fn(before) {
      {
        ..before,
        attributes: {
          ..before.attributes,
          path: [{ kind: 2, asns: [1U], }, { kind: 2, asns: [2U], }],
        },
      }
    }),
  }
  assert_eq(changed.correlation_key(), split.correlation_key())
  let a = {
    ..changed,
    kind: "attribute_change",
    after: {
      ..changed.after,
      attributes: { ..changed.after.attributes, med: Some(1U), },
    },
  }
  let b = {
    ..a,
    after: { ..a.after, attributes: { ..a.after.attributes, med: Some(2U), }, },
  }
  assert_true(a.correlation_key() != b.correlation_key())
  assert_eq(a.with_correlation_key().correlation_key, Some(a.correlation_key()))
  assert_eq(
    correlation_key_from_json(a.to_json().stringify()),
    a.correlation_key(),
  )
  assert_true(
    correlation_semantics_from_json(a.to_json().stringify()) !=
    correlation_semantics_from_json(b.to_json().stringify()),
  )
  assert_true(
    try {
      ignore({ ..a, kind: "unknown", }.correlation_key())
      false
    } catch {
      _ => true
    },
  )
}
