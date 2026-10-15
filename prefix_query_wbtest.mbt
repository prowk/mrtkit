///|
test "文本前缀解析覆盖两种地址族与非整字节掩码" {
  for
    (text, expected) in [
      ("192.0.2.255/25", "192.0.2.128/25"),
      ("0.0.0.0/0", "0.0.0.0/0"),
      ("2001:0DB8::abcd/33", "2001:db8::/33"),
      ("::/0", "::/0"),
      ("::ffff:192.0.2.1", "::ffff:c000:201/128"),
      ("192.0.2.1", "192.0.2.1/32"),
    ] {
    assert_eq(parse_prefix_text(text).text(), expected)
  }
  for
    text in [
      "1.2.3.4/33", "2001::1/129", ":::", "1::2::3", "010.0.0.1", "1.2.3", "fe80::1%zone",
      "1:2:3:4:5:6:7", "1.2.3.4/", "1.2.3.4/-1",
    ] {
    assert_true(
      try {
        ignore(parse_prefix_text(text))
        false
      } catch {
        _ => true
      },
    )
  }
}

///|
test "精确、更具体和覆盖查询在库中采用相同规范化" {
  let event = sample_event(100U, "announce", [1U])
  assert_true(Query::new(prefix="192.0.2.255/24").matches(event))
  assert_true(
    !Query::new(prefix="192.0.2.0/24", prefix_mode="more-specific").matches(
      event,
    ),
  )
  assert_true(
    Query::new(prefix="192.0.2.0/23", prefix_mode="more-specific").matches(
      event,
    ),
  )
  assert_true(
    Query::new(prefix="192.0.2.200", prefix_mode="covering").matches(event),
  )
  assert_true(
    !Query::new(prefix="192.0.3.200", prefix_mode="covering").matches(event),
  )
  assert_true(
    Query::new(prefix="::/0", prefix_mode="more-specific").matches({
      ..event,
      prefix: "2001:db8::/32",
    }),
  )
  assert_true(
    Query::new(prefix="2001:db8::1", prefix_mode="covering").matches({
      ..event,
      prefix: "::/0",
    }),
  )
  assert_true(!Query::new(prefix="::/0", prefix_mode="covering").matches(event))
}
