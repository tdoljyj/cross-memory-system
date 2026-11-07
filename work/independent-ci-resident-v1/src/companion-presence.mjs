// When the companion first beat after the service started, and whether it is absent (DESIGN §65.4.5, M5). A view for the Owner:
// status.json carries executor.companion.firstBeatAfterServiceStartMs, and a `companion-absent` notice once the service has run
// COMPANION_ABSENT_AFTER_MS without a heartbeat (the notifier shows it at the next log-on; remotely the node heartbeat goes stale,
// DESIGN §41.6a). Nothing the executor decides reads it: it defers on the heartbeat's age as before.
export const COMPANION_ABSENT_AFTER_MS = 10 * 60_000;
export const PRESENCE_EVERY_MS = 15_000;

export class CompanionPresence {
  constructor({ startedAt }) { this.startedAt = startedAt; this.firstBeatMs = null; }
  // beat: the mailbox heartbeat ({ at } | null). Only a beat written after the service started counts.
  observe(beat) {
    if (this.firstBeatMs === null && beat && Number.isSafeInteger(beat.at) && beat.at >= this.startedAt) this.firstBeatMs = beat.at - this.startedAt;
    return this.firstBeatMs;
  }
  view() { return { firstBeatAfterServiceStartMs: this.firstBeatMs }; }
  notices(now) {
    return this.firstBeatMs === null && now - this.startedAt >= COMPANION_ABSENT_AFTER_MS
      ? [{ key: `companion-absent:${this.startedAt}`, kind: 'companion-absent', code: 'COMPANION_ABSENT', at: now }] : [];
  }
}
