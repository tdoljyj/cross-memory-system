// Installed resident policy. Written once by the Owner's elevated install (UAC) into an
// admin-only file whose SHA-256 is pinned in the service configuration; the executor refuses to
// run on any other bytes. Everything a batch may do is bounded here; nothing per batch widens it.
//
// Contract /2 (Source v2, Owner decision 1b5d3687):
//   - ciSourceManifestSha256: the CI Source manifest of the install record (record source-manifest.json),
//     which names the installed Source directory resident\source\<it> that the generic helper loads code
//     from and is the sourceManifestSha256 of every job; sourceManifestSha256 stays the installed-files
//     manifest (integrity, batch key);
//   - automaticAttempt2: the one automatic attempt 2 for an allow-listed clean transient failure before any
//     role was published (attempts.mjs); `enabled` and the delay before it are the only knobs;
//   - retention: the archive size at which a reminder receipt is written (50 GB; archives are rename-only
//     and never deleted by the resident), and how often it is measured;
//   - validUntil null = valid until the Source changes or the resident is uninstalled.
// Contract /3 (PR-A, free-minutes design S21): adds `relay` (the Owner's switch for stage R, the relayable
// roles it may consider and the hosted-wait bounds of §7.2) and stage R's run cap as the ninth entry of
// stageRunMilliseconds. The example and the initial install ship relay.enabled = false (Owner decision:
// the OIDC claim values can only be measured when free minutes return); switching it on is a policy change
// (new policy hash, one UAC), never a per-batch input.
// Contract /4 (resident quota redesign phase 2, step 1: design v0.5 §4.7, Task 6451a55d): the executor's own run queue
// (queue.mjs) and circuit breaker (breaker.mjs) take their bounds from here:
//   - limits.maxBatchesPer24h up to 72 (executions; at the limit the queue waits and the Owner is told, nothing is
//     dropped), limits.maxEvaluationsPer24h up to 96 (reservations that did not execute, without waits, environment
//     releases and supersessions: ledger.mjs#usage);
//   - limits.perPrBatchesPer24h (6), limits.waitingRetriesPer24h (48, the waits' own budget), limits.reevaluationsPerPrHeadPer24h
//     (6 new-trigger re-evaluations per PR commit), limits.releasesPerHeadPer24h (2), limits.queueDepth (100 live rows);
//   - breaker: consecutive (3), windowCount (4) within windowMs (1 hour), and the trial delays backoffMs (30, 60, 120 min).
//   - limits.unexecutedMaxPer24h is gone: the release cap and the waiting budget replace it (classify.mjs
//     #UNEXECUTED_REASON_RULES). The 10-minute cool-down stays.
// The design names the later settings of phase 2 (stage 8 parking, the merge train) in the same /4 table; each later
// step adds its own settings with its own contract number, so an installed policy only ever names what its code does.
// Contract /5 (phase 2, step 2: parking, design v0.5 §4.7, §4.9; Owner decision e1e19e2e item 4):
//   - stage8.mode: 'park' (the Owner's choice; the design's alternative grace15 is not implemented);
//   - park: maxParked (4: batches at A, or at B in the queue's first two places), maxParkedOutsideTop2 (8), maxMs (24 h
//     at B), stage8MaxTries (12), stage8RetriesPer24h (100, every parked batch together).
import { HEX64, REPO, UUID, check, exactKeys } from './canonical.mjs';
import { RELAY_ROLES } from './hosted-wait.mjs';

export const POLICY_CONTRACT = 'clued.independent-ci.resident-policy/5';
export const REMINDER_BYTES_DEFAULT = 50 * 1024 ** 3;

// The fixed eight stages of the six-check batch (stages.json of the installed Source).
export const FIXED_STAGES = Object.freeze([
  { number: 1, name: 'native-work-admission', jobRole: 'work-admission', linuxWorker: false },
  { number: 2, name: 'gitleaks-execution', jobRole: 'gitleaks', linuxWorker: true },
  { number: 3, name: 'gitleaks-publication', jobRole: 'gitleaks', linuxWorker: false },
  { number: 4, name: 'trivy-execution', jobRole: 'trivy', linuxWorker: true },
  { number: 5, name: 'trivy-publication', jobRole: 'trivy', linuxWorker: false },
  { number: 6, name: 'placement-execution', jobRole: 'contract-placement', linuxWorker: true },
  { number: 7, name: 'placement-publication', jobRole: 'contract-placement', linuxWorker: false },
  { number: 8, name: 'native-control-pair', jobRole: 'control-admission', linuxWorker: false },
  // Stage R (hosted relay): runs between stage 1 and the local roles, only for relay candidates.
  { number: 9, name: 'hosted-relay', jobRole: null, linuxWorker: false },
]);
export const RELAY_STAGE = 9;
// Local execution and publication stages of each heavy role (the dynamic part of a batch).
export const ROLE_STAGES = Object.freeze({ gitleaks: Object.freeze([2, 3]), trivy: Object.freeze([4, 5]), 'contract-placement': Object.freeze([6, 7]) });

const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

export function validatePolicy(p) {
  exactKeys(p, ['contract', 'repo', 'baseBranch', 'sourceManifestSha256', 'ciSourceManifestSha256', 'residentManifestSha256', 'ownerAcceptance', 'validUntil', 'limits', 'breaker', 'stage8', 'park', 'companion', 'stageRunMilliseconds', 'linux', 'automaticAttempt2', 'retention', 'relay'], 'POLICY_KEYS_INVALID');
  check(p.contract === POLICY_CONTRACT, 'POLICY_CONTRACT_INVALID');
  check(REPO.test(p.repo), 'POLICY_REPO_INVALID');
  check(p.baseBranch === 'main', 'POLICY_BASE_BRANCH_FIXED_MAIN');
  check(HEX64.test(p.sourceManifestSha256) && HEX64.test(p.ciSourceManifestSha256) && HEX64.test(p.residentManifestSha256), 'POLICY_SOURCE_PIN_INVALID');
  exactKeys(p.ownerAcceptance, ['decisionRef', 'installReceiptRef'], 'POLICY_ACCEPTANCE_KEYS_INVALID');
  check(UUID.test(p.ownerAcceptance.decisionRef), 'POLICY_ACCEPTANCE_DECISION_INVALID');
  check(p.ownerAcceptance.installReceiptRef === null || UUID.test(p.ownerAcceptance.installReceiptRef), 'POLICY_INSTALL_RECEIPT_INVALID');
  check(p.validUntil === null || (typeof p.validUntil === 'string' && ISO.test(p.validUntil)), 'POLICY_VALID_UNTIL_INVALID');
  exactKeys(p.limits, ['maxBatchesPer24h', 'maxEvaluationsPer24h', 'perPrBatchesPer24h', 'waitingRetriesPer24h', 'reevaluationsPerPrHeadPer24h', 'releasesPerHeadPer24h',
    'queueDepth', 'maxConcurrent', 'inboxMaxFiles', 'unexecutedCooldownMs', 'stageMarginMs'], 'POLICY_LIMIT_KEYS_INVALID');
  check(int(p.limits.maxBatchesPer24h, 1, 72), 'POLICY_RATE_INVALID'); // executions (10-started)
  check(int(p.limits.maxEvaluationsPer24h, 1, 96), 'POLICY_EVALUATION_RATE_INVALID'); // ledger.mjs#usage evaluations
  check(int(p.limits.perPrBatchesPer24h, 1, 72), 'POLICY_PR_RATE_INVALID');
  check(int(p.limits.waitingRetriesPer24h, 0, 96), 'POLICY_WAITING_BUDGET_INVALID');
  check(int(p.limits.reevaluationsPerPrHeadPer24h, 0, 12), 'POLICY_REEVALUATION_CAP_INVALID');
  check(int(p.limits.releasesPerHeadPer24h, 0, 6), 'POLICY_RELEASE_CAP_INVALID');
  check(int(p.limits.queueDepth, 1, 100), 'POLICY_QUEUE_DEPTH_INVALID');
  check(p.limits.maxConcurrent === 1, 'POLICY_SERIAL_EXECUTION_REQUIRED');
  check(int(p.limits.inboxMaxFiles, 1, 256), 'POLICY_INBOX_BOUND_INVALID');
  check(int(p.limits.unexecutedCooldownMs, 60_000, 86_400_000), 'POLICY_COOLDOWN_INVALID');
  check(int(p.limits.stageMarginMs, 60_000, 900_000), 'POLICY_MARGIN_INVALID');
  exactKeys(p.breaker, ['consecutive', 'windowCount', 'windowMs', 'backoffMs'], 'POLICY_BREAKER_KEYS_INVALID');
  check(int(p.breaker.consecutive, 1, 10) && int(p.breaker.windowCount, 1, 20) && int(p.breaker.windowMs, 60_000, 86_400_000)
    && Array.isArray(p.breaker.backoffMs) && p.breaker.backoffMs.length >= 1 && p.breaker.backoffMs.length <= 6
    && p.breaker.backoffMs.every((ms, i, a) => int(ms, 60_000, 86_400_000) && (i === 0 || a[i - 1] <= ms)), 'POLICY_BREAKER_INVALID');
  exactKeys(p.stage8, ['mode'], 'POLICY_STAGE8_KEYS_INVALID');
  check(p.stage8.mode === 'park', 'POLICY_STAGE8_MODE_INVALID');
  exactKeys(p.park, ['maxParked', 'maxParkedOutsideTop2', 'maxMs', 'stage8MaxTries', 'stage8RetriesPer24h'], 'POLICY_PARK_KEYS_INVALID');
  check(int(p.park.maxParked, 1, 8) && int(p.park.maxParkedOutsideTop2, 0, 16) && int(p.park.maxMs, 3_600_000, 86_400_000) && int(p.park.stage8MaxTries, 1, 24)
    && int(p.park.stage8RetriesPer24h, 0, 200), 'POLICY_PARK_INVALID');
  exactKeys(p.companion, ['userSid', 'heartbeatMaxAgeMs'], 'POLICY_COMPANION_KEYS_INVALID');
  check(SID.test(p.companion.userSid), 'POLICY_COMPANION_SID_INVALID');
  check(int(p.companion.heartbeatMaxAgeMs, 5_000, 600_000), 'POLICY_HEARTBEAT_INVALID');
  check(Array.isArray(p.stageRunMilliseconds) && p.stageRunMilliseconds.length === FIXED_STAGES.length
    && p.stageRunMilliseconds.every(ms => int(ms, 60_000, 5_400_000)), 'POLICY_STAGE_TIMES_INVALID');
  exactKeys(p.linux, ['distribution', 'workerUnit', 'wsprepUnit', 'archiveUnit'], 'POLICY_LINUX_KEYS_INVALID');
  check(p.linux.distribution === 'Ubuntu-24.04', 'POLICY_DISTRIBUTION_FIXED');
  check(p.linux.workerUnit === 'clued-ci-worker@.service' && p.linux.wsprepUnit === 'clued-ci-wsprep@.service'
    && p.linux.archiveUnit === 'clued-ci-archive@.service', 'POLICY_UNIT_NAMES_FIXED');
  // No general automatic retry: only the one bounded attempt 2 of attempts.mjs exists.
  exactKeys(p.automaticAttempt2, ['enabled', 'delayMs'], 'POLICY_ATTEMPT2_KEYS_INVALID');
  check(typeof p.automaticAttempt2.enabled === 'boolean' && int(p.automaticAttempt2.delayMs, 60_000, 3_600_000), 'POLICY_ATTEMPT2_INVALID');
  exactKeys(p.retention, ['reminderBytes', 'checkEveryMs'], 'POLICY_RETENTION_KEYS_INVALID');
  check(int(p.retention.reminderBytes, 1024 ** 3, 1024 ** 4) && int(p.retention.checkEveryMs, 60_000, 86_400_000), 'POLICY_RETENTION_INVALID');
  validateRelay(p.relay);
  return Object.freeze({ ...p, stages: FIXED_STAGES.map((s, i) => ({ ...s, runMilliseconds: p.stageRunMilliseconds[i] })) });
}

// relay: { enabled, roles (a non-empty ordered subset of the registry's relayable roles), wait (§7.2) }.
export function validateRelay(r) {
  exactKeys(r, ['enabled', 'roles', 'wait'], 'POLICY_RELAY_KEYS_INVALID');
  check(typeof r.enabled === 'boolean', 'POLICY_RELAY_INVALID');
  check(Array.isArray(r.roles) && r.roles.length > 0 && new Set(r.roles).size === r.roles.length && r.roles.every(x => RELAY_ROLES.includes(x))
    && r.roles.every((x, i) => i === 0 || RELAY_ROLES.indexOf(r.roles[i - 1]) < RELAY_ROLES.indexOf(x)), 'POLICY_RELAY_ROLES_INVALID');
  const w = r.wait;
  exactKeys(w, ['signalMs', 'queueMs', 'runSlackMs', 'totalMs', 'pollMs', 'jobTimeoutMs'], 'POLICY_RELAY_WAIT_KEYS_INVALID');
  check(int(w.signalMs, 60_000, 1_800_000) && int(w.queueMs, 60_000, 3_600_000) && int(w.runSlackMs, 60_000, 1_800_000) && int(w.totalMs, 60_000, 7_200_000)
    && int(w.pollMs, 10_000, 300_000) && w.signalMs <= w.totalMs, 'POLICY_RELAY_WAIT_INVALID');
  exactKeys(w.jobTimeoutMs, [...RELAY_ROLES], 'POLICY_RELAY_WAIT_KEYS_INVALID');
  check(RELAY_ROLES.every(x => int(w.jobTimeoutMs[x], 60_000, 21_600_000)), 'POLICY_RELAY_WAIT_INVALID');
  return r;
}

// Worst-case wall time of one batch: every formal stage at its cap plus the per-stage margin, and, when the
// relay is on, the bounded hosted wait plus stage R.
export const batchBudgetMs = policy => policy.stages.filter(s => s.number !== RELAY_STAGE).reduce((sum, s) => sum + s.runMilliseconds + policy.limits.stageMarginMs, 0)
  + (policy.relay?.enabled === true ? policy.relay.wait.totalMs + policy.stages.find(s => s.number === RELAY_STAGE).runMilliseconds + policy.limits.stageMarginMs : 0);
