// 每个 peer 子进程串行运行；退出后不能再与后续独占阶段的父进程峰值相加。
export class ReplayRss {
  constructor(){this.peerPhaseUpper=0;this.childPeak=0;this.jobs=0;}
  completePeer(parentHistoricalPeak,childLifetimePeak){
    if(!Number.isSafeInteger(parentHistoricalPeak)||parentHistoricalPeak<0||!Number.isSafeInteger(childLifetimePeak)||childLifetimePeak<0)throw new Error('RSS 峰值无效');
    this.jobs++;this.childPeak=Math.max(this.childPeak,childLifetimePeak);this.peerPhaseUpper=Math.max(this.peerPhaseUpper,parentHistoricalPeak+childLifetimePeak);return this.peerPhaseUpper;
  }
  result(parentAllPhasesPeak){if(!Number.isSafeInteger(parentAllPhasesPeak)||parentAllPhasesPeak<0)throw new Error('父进程 RSS 峰值无效');return {parent_peak_rss_bytes:parentAllPhasesPeak,peer_peak_rss_bytes:this.childPeak,peer_phase_rss_upper_bound_bytes:this.peerPhaseUpper,peak_rss_upper_bound_bytes:Math.max(parentAllPhasesPeak,this.peerPhaseUpper),rss_accounting:'max(parent_all_phases_peak, max_serial_peer_jobs(parent_historical_peak_at_child_exit + child_lifetime_peak))'};}
}
