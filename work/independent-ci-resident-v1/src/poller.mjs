// Trigger producer (runs inside the companion, Owner session, not elevated). It is one of possibly
// many producers and has no authority: it only proposes (pr, head, base) for open PRs into main.
// Reads use the Owner's own gh CLI login, the same credential Agents already use on this machine.
//
// Up to date with main (resident quota redesign v0.6 + §9, phase 1, item 6): a head is proposed only when the PR's
// own base.sha IS the main tip and GitHub's compare of main...head says behind_by 0. Stage 1 refuses anything else
// (the PR base must be the batch base), and before this filter such heads were burned there (2026-10-22: nine
// stale-base heads, STAGE_CHILD_REFUSED). A PR that is not up to date is reported (lastPass) with the hint the PR page
// shows: "merge-main" (the head does not contain main) or "push-any-commit" (it does, but GitHub's base.sha is older:
// any push makes GitHub move it).
//
// Phase 2, step 1 (design v0.5 §4.2): triggers are contract /2 and carry the PR's update time (prUpdatedAt), so the
// executor's run queue can tell a new trigger (the PR was edited) from the same proposal again (a companion restart).
// When the run queue starts over (its generation in the status changes: the queue file was unreadable), every open,
// up-to-date PR head is proposed again, which is how the queue is rebuilt from the poller.
import { HEX40, check } from './canonical.mjs';
import { TRIGGER_CONTRACT_V2 } from './trigger.mjs';

const json = text => { try { return JSON.parse(text); } catch { return null; } };
const TRAILER = /^Clued-Work-Claim:\s*[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s*$/m;
export const UP_TO_DATE_HINTS = Object.freeze(['merge-main', 'push-any-commit', 'compare-unavailable']);
const COMPARE_CACHE_MAX = 512;
// A compare is one short call, and at most MAX_COMPARES_PER_PASS uncached ones run per pass (independent review of
// phase 1, M1): a PR not compared this pass is "compare-unavailable" (never proposed) until the next pass. A compare
// that timed out (its child still running, the Runner busy) ends this pass's compares without using the budget, and
// that one compare is not asked again for SLOW_COMPARE_SKIP_MS, so the PRs behind it are compared in the next passes
// (independent re-review, MINOR-B).
export const COMPARE_TIMEOUT_MS = 15_000;
export const MAX_COMPARES_PER_PASS = 10;
export const SLOW_COMPARE_SKIP_MS = 15 * 60_000;
const stalledCall = r => r?.timedOut === true || r?.refused === 'RUNNER_BUSY_WITH_UNFINISHED_CHILD';

// Hint mode (free-minutes design S20): a proposed head is also observed for its GitHub-hosted runs, read-only,
// for this long after it was first proposed (the executor waits at most policy.relay.wait.totalMs after it
// reserved the head); the observation goes to `hints` (hosted-hints.mjs#HostedHints), data only.
export const HINT_WINDOW_MS = 2 * 3_600_000;

// Pure: is this PR head up to date with main, and if not, what should its author do?
export function upToDate({ mainSha, baseSha, behindBy }) {
  if (baseSha === mainSha && behindBy === 0) return { eligible: true, hint: null };
  if (!Number.isSafeInteger(behindBy)) return { eligible: false, hint: 'compare-unavailable' };
  return { eligible: false, hint: behindBy === 0 ? 'push-any-commit' : 'merge-main' };
}

export class Poller {
  // ports: { repo, ghExe, run(argv,{timeoutMs}), writeTrigger(object), clock, hints? }
  constructor(ports) {
    Object.assign(this, ports);
    this.sent = new Map(); this.firstSeen = new Map(); this.compares = new Map(); this.slow = new Map(); this.lastPass = null;
    this.compareBudget = MAX_COMPARES_PER_PASS; this.stalled = false;
  }

  async mainTip() {
    const r = await this.run([this.ghExe, 'api', `repos/${this.repo}/git/ref/heads/main`, '--jq', '.object.sha'], { timeoutMs: 30_000 });
    const sha = r.code === 0 ? r.stdout.trim() : '';
    check(HEX40.test(sha), 'POLLER_MAIN_TIP_UNAVAILABLE');
    return sha;
  }

  async openPulls() {
    const r = await this.run([this.ghExe, 'pr', 'list', '--repo', this.repo, '--base', 'main', '--state', 'open', '--limit', '50', '--json', 'number,headRefOid,baseRefOid,isDraft,body,updatedAt'], { timeoutMs: 60_000 });
    const v = r.code === 0 ? json(r.stdout) : null;
    check(Array.isArray(v), 'POLLER_PULLS_UNAVAILABLE');
    return v;
  }

  // behind_by of main...head (commits of main the head does not contain), or null when GitHub did not answer. Two
  // fixed commits always compare the same way, so an answer is cached per (main, head).
  async behindBy(mainSha, headSha) {
    const id = `${mainSha}...${headSha}`;
    if (this.compares.has(id)) return this.compares.get(id);
    if (this.compareBudget <= 0 || this.stalled || (this.slow.get(id) ?? 0) > this.clock()) return null;
    const r = await this.run([this.ghExe, 'api', '--method', 'GET', `repos/${this.repo}/compare/${mainSha}...${headSha}?per_page=1`, '--jq', '{behind_by: .behind_by, base: .base_commit.sha}'], { timeoutMs: COMPARE_TIMEOUT_MS });
    if (stalledCall(r)) {
      this.stalled = true;
      if (r.timedOut) { this.slow.set(id, this.clock() + SLOW_COMPARE_SKIP_MS); if (this.slow.size > COMPARE_CACHE_MAX) this.slow.delete(this.slow.keys().next().value); }
      return null;
    }
    this.compareBudget -= 1;
    const v = r.code === 0 ? json(r.stdout) : null;
    if (!v || v.base !== mainSha || !Number.isSafeInteger(v.behind_by) || v.behind_by < 0) return null;
    this.compares.set(id, v.behind_by);
    if (this.compares.size > COMPARE_CACHE_MAX) this.compares.delete(this.compares.keys().next().value);
    return v.behind_by;
  }

  // Propose each ready, up-to-date PR head once per (head, base, PR edit time). An edit of the PR body is the
  // same signal GitHub-hosted admission used for "re-run me"; the executor still applies its own
  // once-only ledger, cool-down and daily cap, so proposing again can never force a re-execution.
  // generation: the run queue's generation from the executor's status (null when unknown).
  async pass({ generation = null } = {}) {
    this.compareBudget = MAX_COMPARES_PER_PASS; this.stalled = false;
    if (typeof generation === 'string' && generation !== this.generation) {
      if (this.generation !== undefined && this.generation !== null) this.sent.clear();
      this.generation = generation;
    }
    const base = await this.mainTip();
    let proposed = 0;
    const pulls = [];
    for (const p of await this.openPulls()) {
      if (p.isDraft || !Number.isSafeInteger(p.number) || !HEX40.test(p.headRefOid ?? '') || !TRAILER.test(p.body ?? '')) continue;
      const prBase = HEX40.test(p.baseRefOid ?? '') ? p.baseRefOid : null;
      const behind = await this.behindBy(base, p.headRefOid);
      const verdict = upToDate({ mainSha: base, baseSha: prBase, behindBy: behind });
      pulls.push({ pr: p.number, headSha: p.headRefOid, baseSha: prBase, mainSha: base, behindBy: behind, ...verdict });
      if (!verdict.eligible) continue;
      const id = `${p.number}:${p.headRefOid}:${base}`;
      if (!this.firstSeen.has(id)) this.firstSeen.set(id, this.clock());
      if (this.hints && this.clock() - this.firstSeen.get(id) <= HINT_WINDOW_MS) {
        try { await this.hints.observe({ pr: p.number, headSha: p.headRefOid, baseSha: base }); } catch { /* a hint is advisory */ }
      }
      if (this.sent.get(id) === p.updatedAt) continue;
      const prUpdatedAt = typeof p.updatedAt === 'string' && Number.isFinite(Date.parse(p.updatedAt)) ? new Date(Date.parse(p.updatedAt)).toISOString() : null;
      await this.writeTrigger({ contract: TRIGGER_CONTRACT_V2, repo: this.repo, pr: p.number, headSha: p.headRefOid, baseSha: base, ...(prUpdatedAt ? { prUpdatedAt } : {}) });
      this.sent.set(id, p.updatedAt);
      proposed += 1;
    }
    if (this.firstSeen.size > 512) for (const k of [...this.firstSeen.keys()].slice(0, this.firstSeen.size - 512)) this.firstSeen.delete(k);
    // What the PR page status shows for the PRs this pass looked at (pr-status.mjs).
    this.lastPass = { at: this.clock(), mainSha: base, pulls };
    return proposed;
  }
}
