// 独立状态模型仅接受业务事件，不调用解析库或复用分析器实现。
export class ReferenceModel {
  constructor({ lower = 500, upper = 900, threshold = 3, window = 60_000_000 } = {}) {
    Object.assign(this, { lower, upper, threshold, window });
    this.routes = new Map();
    this.watermark = -1;
    this.latest = -1;
    this.changes = [];
    this.counts = Object.fromEntries(['announcements', 'withdrawals', 'path_changes', 'origin_changes', 'attribute_changes', 'duplicate_announcements', 'session_resets', 'out_of_order', 'churn_alerts'].map(k => [k, 0]));
  }
  apply(event) {
    const { time, id, kind, ordinal } = event;
    if (time > this.upper) return;
    const measured = time >= this.lower;
    if (kind === 'reset') {
      if (time < this.latest) { if (measured) this.counts.out_of_order++; return; }
      this.routes.clear(); this.watermark = time; this.latest = time;
      if (measured) this.counts.session_resets++;
      return;
    }
    if (measured) this.counts[kind === 'withdraw' ? 'withdrawals' : 'announcements']++;
    const old = this.routes.get(id);
    if (time < this.watermark || (old && time < old.time)) { if (measured) this.counts.out_of_order++; return; }
    this.latest = Math.max(this.latest, time);
    const active = kind !== 'withdraw';
    const path = active ? event.path : old?.path ?? [];
    const attributes = active ? event.attributes : old?.attributes ?? [];
    const samePath = old && JSON.stringify(old.path) === JSON.stringify(path);
    const sameAttributes = old && JSON.stringify(old.attributes) === JSON.stringify(attributes);
    const output = kind => { if (measured) this.changes.push({ kind, id, ordinal }); };
    let changed = active;
    if (active && old?.active) {
      changed = !samePath || !sameAttributes;
      if (!samePath) { if (measured) this.counts.path_changes++; output('path_change'); }
      if (old.path.at(-1) !== path.at(-1)) { if (measured) this.counts.origin_changes++; output('origin_change'); }
      if (!sameAttributes) { if (measured) this.counts.attribute_changes++; output('attribute_change'); }
      if (!changed && measured) this.counts.duplicate_announcements++;
    }
    if (!active) changed = old?.active ?? false;
    let start = !measured ? this.lower : time;
    let count = 0;
    if (measured && old && time >= old.start && time - old.start < this.window) { start = old.start; count = old.count; }
    if (measured && changed) count++;
    if (count === this.threshold && changed && measured) { this.counts.churn_alerts++; output('churn'); }
    this.routes.set(id, { time, active, path, attributes, start, count });
  }
  seed(id, path, attributes) {
    this.routes.set(id, { time: 0, active: true, path, attributes, start: this.lower, count: 0 });
    this.latest = Math.max(this.latest, 0);
  }
  state() {
    return [...this.routes].map(([id, route]) => ({ id, active: route.active, path: route.path, time: route.time, attributes: route.attributes }))
      .sort((a, b) => a.id - b.id);
  }
}
