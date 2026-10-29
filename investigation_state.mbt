///|
priv struct AnalysisTrace {
  event : RouteEvent
  from_us : UInt64
  state : String
  source : Source?
  left_censored : Bool
}

///|
priv struct MoasTrace {
  from_us : UInt64
  signature : String
  origins : Array[UInt32]
  evidence : Array[Json]
  unknown_paths : Int32
  left_censored : Bool
}

///|
fn gap_scope(gap : InvestigationGap, source : Source?) -> Bool {
  gap.collector is None ||
  source.map(fn(s) { (s.collector, s.view) }) == Some((gap.collector, gap.view))
}

///|
fn analysis_interval(
  trace : AnalysisTrace,
  until : UInt64,
  source : Source?,
  rules : InvestigationRules,
  right_censored : Bool,
) -> InvestigationInterval? {
  let start = if trace.from_us < rules.from_us {
    rules.from_us
  } else {
    trace.from_us
  }
  let end = if until > rules.to_us { rules.to_us } else { until }
  if end <= start {
    return None
  }
  Some({
    key: snapshot_route_key(trace.event),
    prefix: trace.event.prefix,
    peer: scoped_peer_key(
      trace.event.peer_asn,
      trace.event.peer_ip,
      trace.event.outbound,
      trace.event.source,
    ),
    path_id: trace.event.path_id,
    peer_asn: trace.event.peer_asn,
    peer_ip: trace.event.peer_ip,
    outbound: trace.event.outbound,
    collector: trace.event.source.bind(fn(source) { source.collector }),
    view: trace.event.source.bind(fn(source) { source.view }),
    from_us: start,
    to_us: end,
    state: trace.state,
    duration_us: if rules.continuous.unwrap_or(false) &&
      ["active", "withdrawn"].contains(trace.state) {
      Some(end - start)
    } else {
      None
    },
    left_censored: trace.left_censored || trace.from_us < rules.from_us,
    right_censored,
    start_source: trace.source,
    end_source: source,
    origin_as: if trace.state == "active" {
      origin_as(trace.event.attributes.path)
    } else {
      None
    },
    path_length: if trace.state == "active" {
      Some(path_length(trace.event.attributes.path))
    } else {
      None
    },
  })
}

///|
fn moas_now(
  analyzer : Analyzer,
  prefix : String,
  time : UInt64,
  left_censored : Bool,
) -> MoasTrace {
  let origins : Map[UInt32, Unit] = Map([])
  let evidence = []
  let keys = []
  let mut unknown = 0
  for key, route in analyzer.routes {
    if !route.active || route.event.prefix != prefix {
      continue
    }
    match origin_as(route.shared.wire.path) {
      Some(asn) => {
        origins[asn] = ()
        keys.push(key)
        evidence.push(
          (
            key,
            Json::object({
              "origin_as": Json(asn),
              "path_id": analysis_optional(route.event.path_id),
              "peer": Json(
                scoped_peer_key(
                  route.event.peer_asn,
                  route.event.peer_ip,
                  route.event.outbound,
                  route.event.source,
                ),
              ),
              "source": analysis_optional(route.event.source),
            }),
          ),
        )
      }
      None => unknown += 1
    }
  }
  let ordered = origins.keys().to_array()
  ordered.sort()
  keys.sort()
  evidence.sort_by_key(fn(pair) { pair.0 })
  {
    from_us: time,
    signature: Json((ordered, keys, unknown)).stringify(),
    origins: ordered,
    evidence: evidence.map(fn(pair) { pair.1 }),
    unknown_paths: unknown,
    left_censored,
  }
}

///|
fn moas_close(
  prefix : String,
  trace : MoasTrace,
  until : UInt64,
  rules : InvestigationRules,
  right_censored : Bool,
) -> Json? {
  let end = if until > rules.to_us { rules.to_us } else { until }
  if trace.origins.length() < 2 || end <= trace.from_us {
    return None
  }
  Some(
    Json::object({
      "prefix": Json(prefix),
      "from_us": Json(trace.from_us),
      "to_us": Json(end),
      "origins": Json(trace.origins),
      "evidence": Json(trace.evidence),
      "unknown_paths": Json(trace.unknown_paths),
      "duration_us": if rules.continuous.unwrap_or(false) {
        Json(end - trace.from_us)
      } else {
        Json::null()
      },
      "left_censored": Json(trace.left_censored),
      "right_censored": Json(right_censored),
      "interpretation": Json("simultaneous_observed_origins_not_hijack_verdict"),
    }),
  )
}

///|
fn analysis_findings(
  event : InvestigationEvent,
  rules : InvestigationRules,
) -> Array[Json] raise ParseError {
  let result = []
  let after = match event.after {
    Some(s) if s.active => s
    _ => return result
  }
  let target = parse_prefix_text(event.prefix)
  let actual = origin_as(after.attributes.path)
  for focus in rules.focus.unwrap_or([]) {
    let parent = parse_prefix_text(focus.prefix)
    if !parent.contains(target) {
      continue
    }
    let expected = focus.expected_origins.unwrap_or([])
    let more = target.length > parent.length
    let allowed = focus.allowed_more_specifics
      .unwrap_or([])
      .any(text => parse_prefix_text(text) == target)
    let condition = if actual is None {
      "origin_unknown"
    } else if expected.is_empty() {
      "expectation_unconfigured"
    } else if more && allowed {
      "allowed_more_specific"
    } else if actual.map(fn(asn) { expected.contains(asn) }).unwrap_or(false) {
      if more {
        "same_origin_more_specific"
      } else {
        "expected_origin"
      }
    } else {
      "unexpected_origin"
    }
    result.push(
      Json::object({
        "id": Json(event.id + "|" + parent.text() + "|" + condition),
        "event_id": Json(event.id),
        "rule_version": Json(rules.version),
        "condition": Json(condition),
        "parent_prefix": Json(parent.text()),
        "prefix": Json(event.prefix),
        "expected_origins": Json(expected),
        "actual_origin": analysis_optional(actual),
        "more_specific": Json(more),
        "peer": Json(event.peer),
        "source": analysis_optional(event.source),
        "quality": Json(if actual is None { "unknown" } else { "observed" }),
        "interpretation": Json("investigation_clue"),
      }),
    )
  }
  result
}

///|
priv struct IncidentTrace {
  first_us : UInt64
  mut last_us : UInt64
  prefix : String
  peer : String
  path_id : UInt32?
  reminders : Array[String]
  event_ids : Array[String]
  recoveries : Array[String]
}

///|
fn incident_json(trace : IncidentTrace, rules : InvestigationRules) -> Json {
  let end = if rules.to_us - trace.first_us <
    rules.incident_us.unwrap_or(60000000UL) {
    rules.to_us
  } else {
    trace.first_us + rules.incident_us.unwrap_or(60000000UL)
  }
  Json::object({
    "id": Json("incident|" + trace.event_ids[0]),
    "first_us": Json(trace.first_us),
    "last_us": Json(trace.last_us),
    "to_us": Json(end),
    "prefix": Json(trace.prefix),
    "peer": Json(trace.peer),
    "path_id": analysis_optional(trace.path_id),
    "reminder_ids": Json(trace.reminders),
    "event_ids": Json(trace.event_ids),
    "recovery_event_ids": Json(trace.recoveries),
    "rule_version": Json(rules.version),
    "end_condition": Json(
      if end == rules.to_us {
        "window_censored"
      } else {
        "fixed_window_elapsed"
      },
    ),
    "unknown_intervals": Json(rules.gaps.unwrap_or([])),
    "interpretation": Json("grouped_observations"),
  })
}

///|
/// 输入先在有界缓冲中稳定排序，再复用 Analyzer；没有由前端解释路径的第二套规则。
pub fn Investigation::report(self : Investigation) -> Json raise ParseError {
  let rules = self.rules
  let analyzer = Analyzer::new(
    from_time=(rules.from_us / 1000000UL).to_uint(),
    from_micros=(rules.from_us % 1000000UL).to_int(),
    to_time=((rules.to_us - 1UL) / 1000000UL).to_uint(),
    to_micros=((rules.to_us - 1UL) % 1000000UL).to_int(),
    capacity=rules.capacity.unwrap_or(20000),
  )
  let inputs = self.inputs.copy()
  for gap in rules.gaps.unwrap_or([]) {
    inputs.push({
      event: None,
      state: None,
      source: None,
      time: gap.from_us,
      baseline: false,
      gap: Some(gap),
      late: false,
    })
  }
  inputs.sort_by_key(fn(input) {
    (
      if input.baseline {
        0
      } else {
        1
      },
      input.time,
      if input.gap is Some(_) {
        0
      } else {
        1
      },
      source_scope(input.source),
      input.source.map(fn(s) { s.file }).unwrap_or(""),
      input.source.map(fn(s) { s.record }).unwrap_or(0L),
      input.source.map(fn(s) { s.event_index }).unwrap_or(0),
    )
  })
  let events = []
  let findings = []
  let intervals = []
  let moas = []
  let incidents = []
  let open_incidents : Map[String, IncidentTrace] = Map([])
  let traces : Map[String, AnalysisTrace] = Map([])
  let moas_traces : Map[String, MoasTrace] = Map([])
  let baselines : Map[String, Unit] = Map([])
  let scopes : Map[String, Unit] = Map([])
  let initial = []
  let controls = []
  let all = chart_counts()
  let selected = chart_counts()
  let mut started = false
  let mut reordered = 0
  let mut latest = 0UL
  for input in self.inputs {
    if !input.baseline && input.time < latest {
      reordered += 1
    }
    if !input.baseline && input.time > latest {
      latest = input.time
    }
  }
  for input in inputs {
    let time = input.time
    if time >= rules.to_us {
      continue
    }
    if !started && !input.baseline && time >= rules.from_us {
      started = true
      for _, trace in traces {
        initial.push(
          Json::object({
            "key": Json(snapshot_route_key(trace.event)),
            "state": Json(trace.state),
            "event": trace.event.to_json(),
            "path_view": analysis_optional(
              investigation_path_view(
                Some(
                  route_snapshot(
                    trace.event,
                    trace.state == "active",
                    trace.event.attributes,
                  ),
                ),
              ),
            ),
          }),
        )
      }
      let prefixes : Map[String, Unit] = Map([])
      for _, route in analyzer.routes {
        prefixes[route.event.prefix] = ()
      }
      for prefix in prefixes.keys() {
        moas_traces[prefix] = moas_now(analyzer, prefix, rules.from_us, true)
      }
    }
    let affected = []
    if input.gap is Some(gap) {
      controls.push(
        Json::object({
          "kind": Json("gap"),
          "time_us": Json(time),
          "to_us": Json(gap.to_us),
          "collector": analysis_optional(gap.collector),
          "view": analysis_optional(gap.view),
        }),
      )
      let keys = traces.keys().to_array()
      for key in keys {
        let trace = traces.get(key).unwrap()
        if !gap_scope(gap, trace.event.source) {
          continue
        }
        affected.push(trace.event.prefix)
        if analysis_interval(trace, time, None, rules, false) is Some(interval) {
          intervals.push(interval)
        }
        let gap_trace = {
          ..trace,
          from_us: gap.from_us,
          state: "gap",
          source: None,
          left_censored: gap.from_us < rules.from_us,
        }
        if analysis_interval(gap_trace, gap.to_us, None, rules, false)
          is Some(interval) {
          intervals.push(interval)
        }
        traces[key] = {
          ..trace,
          from_us: gap.to_us,
          state: "unknown",
          source: None,
          left_censored: false,
        }
        if analyzer.routes.get(key) is Some(route) {
          analyzer.release_attributes(route.shared)
        }
        analyzer.routes.remove(key)
      }
    } else if input.state is Some(state) {
      if input.late {
        continue
      }
      scopes[source_scope(state.source)] = ()
      analyzer.observe_state(state)
      if state.old_state == 6 && state.new_state != 6 {
        controls.push(
          Json::object({
            "kind": Json("session_reset"),
            "time_us": Json(time),
            "peer_asn": Json(state.peer_asn),
            "peer_ip": Json(state.peer_ip),
            "source": analysis_optional(state.source),
          }),
        )
        for key in traces.keys().to_array() {
          let trace = traces.get(key).unwrap()
          if trace.event.peer_asn != state.peer_asn ||
            trace.event.peer_ip != state.peer_ip ||
            source_scope(trace.event.source) != source_scope(state.source) {
            continue
          }
          affected.push(trace.event.prefix)
          if analysis_interval(trace, time, state.source, rules, false)
            is Some(interval) {
            intervals.push(interval)
          }
          traces[key] = {
            ..trace,
            from_us: time,
            state: "session_reset",
            source: state.source,
            left_censored: false,
          }
        }
      }
    } else if input.event is Some(event) {
      let key = snapshot_route_key(event)
      scopes[source_scope(event.source)] = ()
      if input.baseline {
        baselines[source_scope(event.source)] = ()
      }
      let old = analyzer.routes.get(key)
      let in_gap = rules.gaps
        .unwrap_or([])
        .any(fn(gap) {
          gap_scope(gap, event.source) &&
          gap.from_us <= time &&
          time < gap.to_us
        })
      let accepted = !in_gap && !input.late
      let changes = if !accepted {
        []
      } else if input.baseline {
        analyzer.seed(event)
        []
      } else {
        analyzer.observe(event)
      }
      let after = if !accepted {
        None
      } else {
        analyzer.routes
        .get(key)
        .map(fn(route) {
          route_snapshot(route.event, route.active, route.shared.wire)
        })
      }
      if accepted {
        if traces.get(key) is Some(trace) {
          if analysis_interval(trace, time, event.source, rules, false)
            is Some(interval) {
            intervals.push(interval)
          }
        } else if time > rules.from_us {
          let unknown : AnalysisTrace = {
            event,
            from_us: rules.from_us,
            state: "unknown",
            source: None,
            left_censored: true,
          }
          if analysis_interval(unknown, time, event.source, rules, false)
            is Some(interval) {
            intervals.push(interval)
          }
        }
        traces[key] = {
          event: {
            ..event,
            attributes: after
            .map(fn(s) { s.attributes })
            .unwrap_or(event.attributes),
          },
          from_us: time,
          state: if event.action == "withdraw" {
            "withdrawn"
          } else {
            "active"
          },
          source: event.source,
          left_censored: time < rules.from_us || input.baseline,
        }
        affected.push(event.prefix)
      }
      if !input.baseline && time >= rules.from_us {
        let row : InvestigationEvent = {
          id: investigation_source_id(event.source),
          time_us: time,
          prefix: event.prefix,
          peer: scoped_peer_key(
            event.peer_asn,
            event.peer_ip,
            event.outbound,
            event.source,
          ),
          peer_asn: event.peer_asn,
          peer_ip: event.peer_ip,
          outbound: event.outbound,
          path_id: event.path_id,
          source: event.source,
          kind: if input.late {
            "out_of_order"
          } else if in_gap {
            "gap_observation"
          } else {
            event.action
          },
          accepted,
          changes_state: accepted &&
          (match (old, after) {
            (Some(previous), Some(next)) =>
              previous.active != next.active ||
              (
                next.active &&
                !route_attributes_equal(previous.shared.wire, next.attributes)
              )
            (None, Some(next)) => next.active
            _ => false
          }),
          before: old.map(fn(route) {
            route_snapshot(route.event, route.active, route.shared.wire)
          }),
          after,
          changes,
          selected: false,
          before_path: investigation_path_view(
            old.map(fn(route) {
              route_snapshot(route.event, route.active, route.shared.wire)
            }),
          ),
          after_path: investigation_path_view(after),
        }
        let row = { ..row, selected: analysis_matches(rules.query, row), }
        events.push(row)
        all.observe(row, rules)
        if row.selected {
          selected.observe(row, rules)
        }
        let clues = analysis_findings(row, rules)
        for clue in clues {
          findings.push(clue)
        }
        let reminder_ids = changes.map(fn(change) { row.id + "|" + change.kind })
        for clue in clues {
          match clue {
            { "condition": "unexpected_origin", "id": String(id), .. } =>
              reminder_ids.push(id)
            _ => ()
          }
        }
        if open_incidents.get(key) is Some(trace) &&
          time - trace.first_us >= rules.incident_us.unwrap_or(60000000UL) {
          incidents.push(incident_json(trace, rules))
          open_incidents.remove(key)
        }
        if !reminder_ids.is_empty() {
          let trace = open_incidents.get_or_init(key, fn() {
            {
              first_us: time,
              last_us: time,
              prefix: row.prefix,
              peer: row.peer,
              path_id: row.path_id,
              reminders: [],
              event_ids: [],
              recoveries: [],
            }
          })
          trace.last_us = time
          trace.event_ids.push(row.id)
          for id in reminder_ids {
            trace.reminders.push(id)
          }
        }
        if open_incidents.get(key) is Some(trace) &&
          trace.first_us < time &&
          row.kind == "announce" &&
          clues.any(fn(clue) {
            match clue {
              {
                "condition": "expected_origin"
                | "same_origin_more_specific"
                | "allowed_more_specific",
                ..
              } => true
              _ => false
            }
          }) {
          trace.recoveries.push(row.id)
        }
      }
    }
    if started {
      let unique : Map[String, Unit] = Map([])
      for prefix in affected {
        unique[prefix] = ()
      }
      for prefix in unique.keys() {
        let next = moas_now(
          analyzer,
          prefix,
          if time < rules.from_us {
            rules.from_us
          } else {
            time
          },
          false,
        )
        if moas_traces.get(prefix) is Some(trace) &&
          trace.signature != next.signature {
          if moas_close(prefix, trace, time, rules, false) is Some(row) {
            moas.push(row)
          }
        }
        if moas_traces
          .get(prefix)
          .map(fn(trace) { trace.signature != next.signature })
          .unwrap_or(true) {
          moas_traces[prefix] = next
        }
      }
    }
    if intervals.length() + findings.length() + moas.length() >
      rules.capacity.unwrap_or(20000) * 8 {
      raise Invalid(0, "调查派生结果超过容量预算")
    }
  }
  if !started {
    for _, trace in traces {
      initial.push(
        Json::object({
          "key": Json(snapshot_route_key(trace.event)),
          "state": Json(trace.state),
          "event": trace.event.to_json(),
          "path_view": analysis_optional(
            investigation_path_view(
              Some(
                route_snapshot(
                  trace.event,
                  trace.state == "active",
                  trace.event.attributes,
                ),
              ),
            ),
          ),
        }),
      )
    }
    let prefixes : Map[String, Unit] = Map([])
    for _, route in analyzer.routes {
      prefixes[route.event.prefix] = ()
    }
    for prefix in prefixes.keys() {
      moas_traces[prefix] = moas_now(analyzer, prefix, rules.from_us, true)
    }
  }
  for _, trace in traces {
    if analysis_interval(trace, rules.to_us, None, rules, true)
      is Some(interval) {
      intervals.push(interval)
    }
  }
  for prefix, trace in moas_traces {
    if moas_close(prefix, trace, rules.to_us, rules, true) is Some(row) {
      moas.push(row)
    }
  }
  for _, trace in open_incidents {
    incidents.push(incident_json(trace, rules))
  }
  intervals.sort_by_key(fn(row) { (row.from_us, row.key) })
  initial.sort_by_key(fn(row) { row.stringify() })
  moas.sort_by_key(fn(row) { row.stringify() })
  findings.sort_by_key(fn(row) { row.stringify() })
  incidents.sort_by_key(fn(row) { row.stringify() })
  let missing = scopes
    .keys()
    .to_array()
    .filter(fn(scope) { !baselines.contains(scope) })
  missing.sort()
  let quality = Json::object({
    "baseline": Json(
      if missing.is_empty() && !scopes.is_empty() {
        "explicit_rib"
      } else {
        "missing"
      },
    ),
    "missing_baseline_scopes": Json(missing),
    "continuous": Json(rules.continuous.unwrap_or(false)),
    "gaps": Json(rules.gaps.unwrap_or([])),
    "reordered_inputs": Json(reordered),
    "ordering": Json("baseline_time_scope_file_record_event_index"),
    "input_budget_bytes": Json(self.bytes),
    "limits": Json("observations_only_not_risk_score_or_business_outage"),
  })
  let report = Json::object({
    "schema_version": Json("1.0"),
    "type": Json("investigation_core"),
    "rules": rules.to_json(),
    "quality": quality,
    "events": Json(events),
    "selected": Json(events.filter(fn(row) { row.selected })),
    "initial": Json(initial),
    "controls": Json(controls),
    "intervals": Json(intervals),
    "moas": Json(moas),
    "findings": Json(findings),
    "incidents": Json(incidents),
    "summary": Json::object({
      "all": all.report("all", rules),
      "selected": selected.report("selected", rules),
    }),
    "comparison": investigation_comparison(events, intervals, rules),
  })
  if report.stringify().length() > rules.max_bytes.unwrap_or(67108864) {
    raise Invalid(0, "调查输出超过内存预算")
  }
  report
}
