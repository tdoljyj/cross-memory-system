// Hosted hints, companion side (free-minutes design S20, §7.1). The companion (Owner session, not
// elevated, not trusted) observes the GitHub-hosted runs of each candidate PR head READ-ONLY with the Owner's
// own gh login, runs the installed Source's pure attestation in hint mode (hosted-relay-v1/stage.mjs
// hostedHint: no signature check) and writes the result as a hint record, data only:
//   { contract: 'clued.independent-ci.hosted-hint/1', repo, pr, headSha, observedAt, roles: { gitleaks, trivy } }
// The executor uses it to wait (bounded) or to fall back at once; it can never make anything publish: only
// stage R's own verification inside clued-control decides a relay.
import { CODE, HEX40, check } from './canonical.mjs';
import { HINT_CONTRACT, HINT_MAX_BYTES, RELAY_ROLES } from './hosted-wait.mjs';
import { canonicalJson } from './canonical.mjs';

const time = iso => { const ms = Date.parse(iso ?? ''); return Number.isSafeInteger(ms) && ms > 0 ? ms : null; };
const reasonOf = r => (typeof r === 'string' && CODE.test(r) ? r : null);

// The newest GitHub Actions run of the role's hosted job in the observed facts (attest.mjs E5 selection).
function newestRun(facts, role) {
  const checks = facts?.hostedRuns?.[role]?.checks;
  if (!Array.isArray(checks)) return null;
  return checks.filter(c => c?.appId === 15368 && Number.isSafeInteger(c.id)).reduce((a, b) => (!a || b.id > a.id ? b : a), null);
}

// One attestHead() verdict (hint mode) -> one hint role entry (hosted-wait.mjs#parseHint shape).
export function hintRole(verdict, run, observedAt) {
  switch (verdict?.verdict) {
    case 'ATTESTED_SUCCESS': return { state: 'SUCCESS' };
    case 'BILLING_REFUSED': return { state: 'BILLING_REFUSED' };
    case 'ABSENT': return { state: 'ABSENT' };
    case 'PENDING': {
      const at = time(run?.startedAt) ?? observedAt;
      return verdict.reason === 'E5_HOSTED_IN_PROGRESS' ? { state: 'PENDING_RUNNING', startedAt: at } : { state: 'PENDING_QUEUED', queuedAt: at };
    }
    case 'HOSTED_NOT_SUCCESS': return { state: 'HOSTED_NOT_SUCCESS', ...(reasonOf(verdict.reason) ? { reason: reasonOf(verdict.reason) } : {}) };
    // NOT_ELIGIBLE, ATTESTATION_FAILED (hint mode cannot verify a signature), or anything unexpected: local.
    default: return { state: 'NOT_ELIGIBLE', ...(reasonOf(verdict?.reason) ? { reason: reasonOf(verdict.reason) } : { reason: 'HINT_UNCLASSIFIED' }) };
  }
}

export function hintRecord({ repo, pr, headSha, observedAt, head, facts }) {
  check(typeof repo === 'string' && Number.isSafeInteger(pr) && pr > 0 && HEX40.test(headSha ?? '') && Number.isSafeInteger(observedAt) && observedAt > 0, 'HOSTED_HINT_SUBJECT_INVALID');
  const roles = Object.fromEntries(RELAY_ROLES.map(role => [role, hintRole(head?.roles?.[role], newestRun(facts, role), observedAt)]));
  const record = { contract: HINT_CONTRACT, repo, pr, headSha, observedAt, roles };
  check(Buffer.byteLength(canonicalJson(record) + '\n') <= HINT_MAX_BYTES, 'HOSTED_HINT_TOO_LARGE');
  return record;
}

// Writes a hint only when the observed role states changed for this head (no file per poll otherwise).
export class HostedHints {
  // ports: { repo, observeHead({ pr, headSha, baseSha }) -> { head, facts }, mailbox (writeHint), clock }
  constructor(ports) { Object.assign(this, ports); this.last = new Map(); }

  async observe({ pr, headSha, baseSha }) {
    let observed;
    try { observed = await this.observeHead({ pr, headSha, baseSha }); }
    catch { observed = null; }
    // An observation that failed says nothing: no hint (the executor then waits for the signal window).
    if (!observed) return null;
    const record = hintRecord({ repo: this.repo, pr, headSha, observedAt: this.clock(), head: observed.head, facts: observed.facts });
    const id = `${pr}:${headSha}`, states = canonicalJson(record.roles);
    if (this.last.get(id) === states) return null;
    await this.mailbox.writeHint(record);
    this.last.set(id, states);
    if (this.last.size > 256) this.last.delete(this.last.keys().next().value);
    return record;
  }
}

// The installed-Source observer for hint mode: the Source's own observer and pure hint attestation over a
// read-only GitHub port (gh-read-port.mjs), with the installed production registry. Pure wiring.
export function sourceHintObserver({ registry, createObserver, hostedHint, github, repo }) {
  check(typeof createObserver === 'function' && typeof hostedHint === 'function', 'HOSTED_HINT_SOURCE_UNAVAILABLE');
  const observer = createObserver({ github, registry });
  const roles = RELAY_ROLES.filter(r => Object.hasOwn(registry.roles, r));
  return async ({ pr, headSha, baseSha }) => {
    const facts = await observer.observe({ repo, pr, headSha, baseSha, roles });
    return { facts, head: hostedHint({ registry, facts }) };
  };
}
