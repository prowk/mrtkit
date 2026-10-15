// 每种类型仅保留一条代表性记录，空间与诊断类别数量有关。
export class DiagnosticCollector {
  constructor() { this.groups = new Map(); }
  add(items) {
    for (const item of items) {
      const key = [item.kind, item.mrt_type, item.subtype, item.afi, item.safi].join('/');
      const existing = this.groups.get(key);
      if (existing) existing.count++;
      else this.groups.set(key, { kind: item.kind, mrt_type: item.mrt_type, subtype: item.subtype,
        ...(item.afi === undefined ? {} : { afi: item.afi, safi: item.safi }), count: 1,
        sample: item.source ? { file: item.source.file, record: item.source.record, offset: item.source.offset } : null });
    }
  }
  report() {
    const groups = [...this.groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.mrt_type - b.mrt_type || a.subtype - b.subtype || (a.afi ?? -1) - (b.afi ?? -1) || (a.safi ?? -1) - (b.safi ?? -1));
    return { schema_version: '2.0', type: 'diagnostics', skipped_records: groups.filter(g => g.kind === 'mrt').reduce((sum, g) => sum + g.count, 0), ignored_families: groups.filter(g => g.kind === 'mp').reduce((sum, g) => sum + g.count, 0), groups };
  }
}
