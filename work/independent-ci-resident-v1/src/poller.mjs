// Trigger producer (runs inside the companion, Owner session, not elevated). It is one of possibly
// many producers and has no authority: it only proposes (pr, head, base) for open PRs into main.
// Reads use the Owner's own gh CLI login, the same credential Agents already use on this machine.
import { HEX40, check } from './canonical.mjs';
import { TRIGGER_CONTRACT } from './trigger.mjs';

const json = text => { try { return JSON.parse(text); } catch { return null; } };
const TRAILER = /^Clued-Work-Claim:\s*[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s*$/m;

// Hint mode (free-minutes design S20): a proposed head is also observed for its GitHub-hosted runs, read-only,
// for this long after it was first proposed (the executor waits at most policy.relay.wait.totalMs after it
// reserved the head); the observation goes to `hints` (hosted-hints.mjs#HostedHints), data only.
export const HINT_WINDOW_MS = 2 * 3_600_000;

export class Poller {
  // ports: { repo, ghExe, run(argv,{timeoutMs}), writeTrigger(object), clock, hints? }
  constructor(ports) { Object.assign(this, ports); this.sent = new Map(); this.firstSeen = new Map(); }

  async mainTip() {
    const r = await this.run([this.ghExe, 'api', `repos/${this.repo}/git/ref/heads/main`, '--jq', '.object.sha'], { timeoutMs: 30_000 });
    const sha = r.code === 0 ? r.stdout.trim() : '';
    check(HEX40.test(sha), 'POLLER_MAIN_TIP_UNAVAILABLE');
    return sha;
  }

  async openPulls() {
    const r = await this.run([this.ghExe, 'pr', 'list', '--repo', this.repo, '--base', 'main', '--state', 'open', '--limit', '50', '--json', 'number,headRefOid,isDraft,body,updatedAt'], { timeoutMs: 60_000 });
    const v = r.code === 0 ? json(r.stdout) : null;
    check(Array.isArray(v), 'POLLER_PULLS_UNAVAILABLE');
    return v;
  }

  // Propose each ready PR head once per (head, base, PR edit time). An edit of the PR body is the
  // same signal GitHub-hosted admission used for "re-run me"; the executor still applies its own
  // once-only ledger, cool-down and daily cap, so proposing again can never force a re-execution.
  async pass() {
    const base = await this.mainTip();
    let proposed = 0;
    for (const p of await this.openPulls()) {
      if (p.isDraft || !Number.isSafeInteger(p.number) || !HEX40.test(p.headRefOid ?? '') || !TRAILER.test(p.body ?? '')) continue;
      const id = `${p.number}:${p.headRefOid}:${base}`;
      if (!this.firstSeen.has(id)) this.firstSeen.set(id, this.clock());
      if (this.hints && this.clock() - this.firstSeen.get(id) <= HINT_WINDOW_MS) {
        try { await this.hints.observe({ pr: p.number, headSha: p.headRefOid, baseSha: base }); } catch { /* a hint is advisory */ }
      }
      if (this.sent.get(id) === p.updatedAt) continue;
      await this.writeTrigger({ contract: TRIGGER_CONTRACT, repo: this.repo, pr: p.number, headSha: p.headRefOid, baseSha: base });
      this.sent.set(id, p.updatedAt);
      proposed += 1;
    }
    if (this.firstSeen.size > 512) for (const k of [...this.firstSeen.keys()].slice(0, this.firstSeen.size - 512)) this.firstSeen.delete(k);
    return proposed;
  }
}
