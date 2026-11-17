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
// Contract /3 (PR-A, free-minutes design S21) added `relay` (the switch for stage R, the hosted relay) and stage R's run cap as the
// ninth entry of stageRunMilliseconds. The hosted relay is removed (Owner 2026-11-14, DESIGN §76; it was never switched on): a
// `relay` key an installed policy still carries is accepted and dropped unread (LEGACY_POLICY_KEYS), and build-package leaves it out
// of every new package, so the generic upgrade converges each node's policy without a step of its own. Stage 9 stays a reserved
// number with its run cap (the installed policies and the broker's fixed stage table keep ten entries); no batch runs it.
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
//     at B), stage8MaxTries (12), stage8RetriesPer24h (100 per PR, across its parked batches).
// Contract /6 (phase 2, step 3c-1: the merge train in shadow mode, design v0.5 §4.7, §5.5, §6 step 4; Owner decision
// 2eea28a1; DESIGN §22):
//   - train: enabled ('off' or 'shadow'; 'on' comes with step 3c-2), nonFrontRuns (only true, today's way: every
//     pushed head is tested), maintenanceEveryMs (stage 10 at most this often when idle; design: 10 min),
//     maintenanceMaxPerDay (design §4.7: 200);
//   - stageRunMilliseconds has a tenth entry, stage 10 (train maintenance, outside the batch).
// Contract /8 (merge train on, step 3c-2b; DESIGN §41.7): train.enabled adds 'on'; train adds slotHardCapMinutes (60-180, the
// touch's hard_cap_minutes), frontBatchBudgetMs (what a front batch needs left on its slot), sweepFreshMs (default 900000: the
// newest sweep proof stage 8 accepts) and fullSweepMaxMs (a full sweep's longest run); nonFrontRuns may be false. /7 stays
// accepted exactly as it was ('on' refused, POLICY_TRAIN_ON_NOT_SUPPORTED); its train run carries TRAIN_DEFAULTS.
// Contract /9 (generation 10, network tolerance, DESIGN 53.3, 53.4; Task 125a5162 items 3 and 4): /8 plus
// breaker.network = { trialDelayMs, earlyTrialProbes, releasesPerHeadPer24h }:
//   - trialDelayMs: the wait for the trial of a breaker that only network faults opened (classify.mjs#networkFailure), every time (one
//     outage never stacks it); 1 minute up to breaker.backoffMs's first (it may only shorten the wait);
//   - earlyTrialProbes (1-10): that many read-only probes in a row that reached the outside make such a breaker's trial due now;
//   - releasesPerHeadPer24h (1-144): a network release of a head counts towards this cap instead of limits.releasesPerHeadPer24h, and
//     is tried again every 10 minutes; at the cap the row stops (lifted when the breaker closes, the probes see the outside again or
//     the Owner releases the breaker).
// /7 and /8 stay accepted exactly as they were: without breaker.network the breaker and the release cap behave as before (the Owner's
// release request works under any contract). Changing these numbers is a new policy (new hash, the Owner's UAC), never a per-batch input.
// train.sweep (/8 and later, optional; strict-permanent mode, Owner decision 9e2511fe, DESIGN §65): what the full sweep is for in train on:
//   'gate'   the take-over full sweep gates every batch and may cover a green with strict off (DESIGN §41, §60-§62): the way back;
//   'audit'  strict stays on for good: no full sweep gates anything, one full round a day runs as a background audit;
//   'off'    the same without the audit rounds.
// A policy without it is TRAIN_SWEEP_DEFAULT, the Owner's decision ('audit'); the policy digest of such a policy is unchanged. An older
// resident refuses a policy that names it (POLICY_TRAIN_KEYS_INVALID), so it never runs the gate by mistake.
// train.landing and train.batchMax (/8 and later, optional; bors-style landing, ADR 0018): 'github-merge' (default: stage 8 writes the
// merge-slot green and GitHub merges, §65) or 'push' (stage 8 fast-forwards main to the tested S itself); batchMax 1..4 (default 1) PRs
// per batch, more than 1 only with push. push needs strict-permanent mode (sweep audit or off). Neither key written: the policy and its
// digest are unchanged; an older resident refuses a policy that names one (POLICY_TRAIN_KEYS_INVALID).
import { HEX64, REPO, UUID, check, exactKeys } from './canonical.mjs';
import { pinnedNodeProfile } from './node-profile.mjs';

export const POLICY_CONTRACT_V7 = 'clued.independent-ci.resident-policy/7';
export const POLICY_CONTRACT_V8 = 'clued.independent-ci.resident-policy/8';
export const POLICY_CONTRACT_V9 = 'clued.independent-ci.resident-policy/9';
// /10 (generation 13, DESIGN §57.1, Owner Decision 2907d858): /9 and roleProbe.interruptedMax, the role probes (a queue watch is one)
// interrupted in a row (a restart or a power cut in the middle of one) after which the executor HALTs; fewer are recovered by itself.
export const POLICY_CONTRACT_V10 = 'clued.independent-ci.resident-policy/10';
export const POLICY_CONTRACT = POLICY_CONTRACT_V7;
export const POLICY_CONTRACTS = Object.freeze([POLICY_CONTRACT_V7, POLICY_CONTRACT_V8, POLICY_CONTRACT_V9, POLICY_CONTRACT_V10]);
// The contracts that carry breaker.network (/9 and later).
const NETWORK_CONTRACTS = Object.freeze([POLICY_CONTRACT_V9, POLICY_CONTRACT_V10]);
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
  // Stage 9 (stage R, the hosted relay): removed (DESIGN §76); a reserved number that no batch runs.
  { number: 9, name: 'hosted-relay', jobRole: null, linuxWorker: false },
  // Stage 10 (train maintenance): outside every batch; runs only when train.enabled is not 'off'.
  { number: 10, name: 'train-maintenance', jobRole: null, linuxWorker: false },
]);
export const RELAY_STAGE = 9;
export const TRAIN_STAGE = 10;
export const TRAIN_MODES = Object.freeze(['off', 'shadow']);
export const TRAIN_MODES_V8 = Object.freeze(['off', 'shadow', 'on']);
// The /8 train settings a /7 policy's train run carries (it never acts on them: /7 is off or shadow).
// (Source v2 train-run.mjs TRAIN_RUN_SHADOW_DEFAULTS names the same numbers.)
export const TRAIN_DEFAULTS = Object.freeze({ slotHardCapMinutes: 120, frontBatchBudgetMs: 3_600_000, sweepFreshMs: 900_000, fullSweepMaxMs: 21_600_000 });
export const TRAIN_V8_KEYS = Object.freeze(['enabled', 'nonFrontRuns', 'maintenanceEveryMs', 'maintenanceMaxPerDay', ...Object.keys(TRAIN_DEFAULTS)]);
// DESIGN §65 (Source v2 train-run.mjs TRAIN_RUN_SWEEPS names the same values).
export const TRAIN_SWEEPS = Object.freeze(['gate', 'audit', 'off']);
export const TRAIN_SWEEP_DEFAULT = 'audit';
// ADR 0018 (Source v2 train-landing.mjs LANDING_MODES, BATCH_MAX_LIMIT name the same values).
export const TRAIN_LANDINGS = Object.freeze(['github-merge', 'push']);
export const TRAIN_LANDING_DEFAULT = 'github-merge';
export const TRAIN_BATCH_MAX_LIMIT = 4;
// The fleet's train (DESIGN §41.9 step 4, §65; Decisions 0ac620fa, 78a3052f): ONE value for every node. tools/build-package.mjs writes
// it into every package's policy of contract /8 and later (a /7 policy cannot say 'on'), so a node's train changes only with an accepted
// package and all nodes of one Source run one mode. Before, every package carried the node's installed train unchanged (the generic
// upgrade's configInputsFor), so the mode a node was first installed with stayed (2026-11-14: turing shadow, desk-w-591 on). Going back
// (shadow or off) is this value and a new package; the immediate stop is the Owner's PAUSE request, as before.
export const FLEET_TRAIN = Object.freeze({ enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 600_000, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS,
  sweep: TRAIN_SWEEP_DEFAULT });
// Local execution and publication stages of each heavy role (the dynamic part of a batch).
export const ROLE_STAGES = Object.freeze({ gitleaks: Object.freeze([2, 3]), trivy: Object.freeze([4, 5]), 'contract-placement': Object.freeze([6, 7]) });
// The heavy roles of every batch, in their fixed order.
export const HEAVY_ROLES = Object.freeze(Object.keys(ROLE_STAGES));
// Keys an installed policy may still carry from a removed feature: accepted, never read, dropped from the validated policy.
export const LEGACY_POLICY_KEYS = Object.freeze(['relay']);

const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

export function validatePolicy(p) {
  exactKeys(p, ['contract', 'repo', 'baseBranch', 'sourceManifestSha256', 'ciSourceManifestSha256', 'residentManifestSha256', 'ownerAcceptance', 'validUntil', 'limits', 'breaker', 'stage8', 'park', 'train', 'companion', 'stageRunMilliseconds', 'linux', 'automaticAttempt2', 'retention', 'node', 'nodeProfileSha256',
    ...(p?.contract === POLICY_CONTRACT_V10 ? ['roleProbe'] : []), ...LEGACY_POLICY_KEYS.filter(k => Object.hasOwn(p ?? {}, k))], 'POLICY_KEYS_INVALID');
  check(POLICY_CONTRACTS.includes(p.contract), 'POLICY_CONTRACT_INVALID');
  const node = pinnedNodeProfile(p.node, p.nodeProfileSha256);
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
  exactKeys(p.breaker, ['consecutive', 'windowCount', 'windowMs', 'backoffMs', ...(NETWORK_CONTRACTS.includes(p.contract) ? ['network'] : [])], 'POLICY_BREAKER_KEYS_INVALID');
  check(int(p.breaker.consecutive, 1, 10) && int(p.breaker.windowCount, 1, 20) && int(p.breaker.windowMs, 60_000, 86_400_000)
    && delayList(p.breaker.backoffMs), 'POLICY_BREAKER_INVALID');
  if (NETWORK_CONTRACTS.includes(p.contract)) validateBreakerNetwork(p.breaker);
  if (p.contract === POLICY_CONTRACT_V10) validateRoleProbe(p.roleProbe);
  exactKeys(p.stage8, ['mode'], 'POLICY_STAGE8_KEYS_INVALID');
  check(p.stage8.mode === 'park', 'POLICY_STAGE8_MODE_INVALID');
  exactKeys(p.park, ['maxParked', 'maxParkedOutsideTop2', 'maxMs', 'stage8MaxTries', 'stage8RetriesPer24h'], 'POLICY_PARK_KEYS_INVALID');
  check(int(p.park.maxParked, 1, 8) && int(p.park.maxParkedOutsideTop2, 0, 16) && int(p.park.maxMs, 3_600_000, 86_400_000) && int(p.park.stage8MaxTries, 1, 24)
    && int(p.park.stage8RetriesPer24h, 0, 200), 'POLICY_PARK_INVALID');
  if (p.contract === POLICY_CONTRACT_V7) validateTrain(p.train); else validateTrainV8(p.train);
  exactKeys(p.companion, ['userSid', 'heartbeatMaxAgeMs'], 'POLICY_COMPANION_KEYS_INVALID');
  check(SID.test(p.companion.userSid) && p.companion.userSid === node.ownerSid, 'POLICY_COMPANION_SID_INVALID');
  check(int(p.companion.heartbeatMaxAgeMs, 5_000, 600_000), 'POLICY_HEARTBEAT_INVALID');
  check(Array.isArray(p.stageRunMilliseconds) && p.stageRunMilliseconds.length === FIXED_STAGES.length
    && p.stageRunMilliseconds.every(ms => int(ms, 60_000, 5_400_000)), 'POLICY_STAGE_TIMES_INVALID');
  // Stage 10's cap is fixed: the C# boundary and SwapBroker allow exactly 5 minutes (independent review of 3c-1, m2).
  check(p.stageRunMilliseconds[TRAIN_STAGE - 1] === 300_000, 'POLICY_STAGE_TIMES_INVALID');
  exactKeys(p.linux, ['distribution', 'workerUnit', 'wsprepUnit', 'archiveUnit'], 'POLICY_LINUX_KEYS_INVALID');
  check(p.linux.distribution === node.wslDistribution, 'POLICY_DISTRIBUTION_FIXED');
  check(p.linux.workerUnit === 'clued-ci-worker@.service' && p.linux.wsprepUnit === 'clued-ci-wsprep@.service'
    && p.linux.archiveUnit === 'clued-ci-archive@.service', 'POLICY_UNIT_NAMES_FIXED');
  // No general automatic retry: only the one bounded attempt 2 of attempts.mjs exists.
  exactKeys(p.automaticAttempt2, ['enabled', 'delayMs'], 'POLICY_ATTEMPT2_KEYS_INVALID');
  check(typeof p.automaticAttempt2.enabled === 'boolean' && int(p.automaticAttempt2.delayMs, 60_000, 3_600_000), 'POLICY_ATTEMPT2_INVALID');
  exactKeys(p.retention, ['reminderBytes', 'checkEveryMs'], 'POLICY_RETENTION_KEYS_INVALID');
  check(int(p.retention.reminderBytes, 1024 ** 3, 1024 ** 4) && int(p.retention.checkEveryMs, 60_000, 86_400_000), 'POLICY_RETENTION_INVALID');
  const current = Object.fromEntries(Object.entries(p).filter(([k]) => !LEGACY_POLICY_KEYS.includes(k)));
  return Object.freeze({ ...current, node, stages: FIXED_STAGES.map((s, i) => ({ ...s, runMilliseconds: p.stageRunMilliseconds[i] })) });
}

// roleProbe (contract /10): interruptedMax 1 HALTs at the first interrupted probe (the behaviour of /9 and earlier); up to 10.
export function validateRoleProbe(r) {
  exactKeys(r, ['interruptedMax'], 'POLICY_ROLE_PROBE_KEYS_INVALID');
  check(int(r.interruptedMax, 1, 10), 'POLICY_ROLE_PROBE_INVALID');
  return r;
}
const delayList = a => Array.isArray(a) && a.length >= 1 && a.length <= 6 && a.every((ms, i) => int(ms, 60_000, 86_400_000) && (i === 0 || a[i - 1] <= ms));
// breaker.network (contract /9, generation 10): the network breaker's trial delay (never longer than the policy's own first wait), the
// read-only probes that bring its trial forward and the network release cap per head.
export function validateBreakerNetwork(breaker) {
  const n = breaker.network;
  exactKeys(n, ['trialDelayMs', 'earlyTrialProbes', 'releasesPerHeadPer24h'], 'POLICY_BREAKER_NETWORK_KEYS_INVALID');
  check(int(n.trialDelayMs, 60_000, breaker.backoffMs[0]) && int(n.earlyTrialProbes, 1, 10) && int(n.releasesPerHeadPer24h, 1, 144), 'POLICY_BREAKER_NETWORK_INVALID');
  return n;
}

// train (contract /6): stage 10's mode and schedule. 'on' is refused until step 3c-2 brings the code that acts on it.
export function validateTrain(t) {
  exactKeys(t, ['enabled', 'nonFrontRuns', 'maintenanceEveryMs', 'maintenanceMaxPerDay'], 'POLICY_TRAIN_KEYS_INVALID');
  check(t.enabled !== 'on', 'POLICY_TRAIN_ON_NOT_SUPPORTED');
  check(TRAIN_MODES.includes(t.enabled) && t.nonFrontRuns === true && int(t.maintenanceEveryMs, 60_000, 3_600_000) && int(t.maintenanceMaxPerDay, 0, 200), 'POLICY_TRAIN_INVALID');
  return t;
}

// train (contract /8, DESIGN §41.7): 'on' is accepted; the four new settings are bounded like the train-run job /2 bounds
// them (INTERFACES §2), and a front batch's budget must fit inside the slot's hard cap.
export function validateTrainV8(t) {
  exactKeys(t, [...TRAIN_V8_KEYS, ...['sweep', 'landing', 'batchMax'].filter(k => Object.hasOwn(t ?? {}, k))], 'POLICY_TRAIN_KEYS_INVALID');
  check(!Object.hasOwn(t, 'sweep') || TRAIN_SWEEPS.includes(t.sweep), 'POLICY_TRAIN_INVALID');
  check(!Object.hasOwn(t, 'landing') || TRAIN_LANDINGS.includes(t.landing), 'POLICY_TRAIN_INVALID');
  check(!Object.hasOwn(t, 'batchMax') || int(t.batchMax, 1, TRAIN_BATCH_MAX_LIMIT), 'POLICY_TRAIN_INVALID');
  // ADR 0018 §2: push only in strict-permanent mode; a batch of several PRs only with push.
  check(trainLandingMode(t) !== 'push' || trainSweepMode(t) !== 'gate', 'POLICY_TRAIN_INVALID');
  check(trainBatchMax(t) === 1 || trainLandingMode(t) === 'push', 'POLICY_TRAIN_INVALID');
  check(TRAIN_MODES_V8.includes(t.enabled) && typeof t.nonFrontRuns === 'boolean' && int(t.maintenanceEveryMs, 60_000, 3_600_000) && int(t.maintenanceMaxPerDay, 0, 200), 'POLICY_TRAIN_INVALID');
  check(int(t.slotHardCapMinutes, 60, 180) && int(t.frontBatchBudgetMs, 60_000, 10_800_000) && int(t.sweepFreshMs, 60_000, 3_600_000) && int(t.fullSweepMaxMs, 600_000, 86_400_000)
    && t.frontBatchBudgetMs < t.slotHardCapMinutes * 60_000, 'POLICY_TRAIN_INVALID');
  return t;
}

// The train settings of an installed policy (/8 its own, /7 TRAIN_DEFAULTS): the clocks the train-run job carries (and Source v2
// train-strict.mjs#strictSettingsDigest digests; the sweep mode is carried beside them, trainSweepMode).
export function trainSettings(train) {
  const own = k => (Object.hasOwn(train ?? {}, k) ? train[k] : TRAIN_DEFAULTS[k]);
  return Object.freeze({ slotHardCapMinutes: own('slotHardCapMinutes'), frontBatchBudgetMs: own('frontBatchBudgetMs'), sweepFreshMs: own('sweepFreshMs'), fullSweepMaxMs: own('fullSweepMaxMs') });
}
// DESIGN §65: the policy's train.sweep, or the Owner's default (train-run /3 `sweep`). /7 (off or shadow only) carries the default too.
export function trainSweepMode(train) { return Object.hasOwn(train ?? {}, 'sweep') ? train.sweep : TRAIN_SWEEP_DEFAULT; }
// ADR 0018: the policy's train.landing and train.batchMax, or their defaults (github-merge, 1); what stages 8 and 10 get as train-landing.json.
export function trainLandingMode(train) { return Object.hasOwn(train ?? {}, 'landing') ? train.landing : TRAIN_LANDING_DEFAULT; }
export function trainBatchMax(train) { return Object.hasOwn(train ?? {}, 'batchMax') ? train.batchMax : 1; }
export function installedTrainLanding(policy) { return { landing: trainLandingMode(policy?.train), batchMax: trainBatchMax(policy?.train) }; }

// Worst-case wall time of one batch: every formal stage at its cap plus the per-stage margin. Stages 9 and 10 are never part of a batch.
export const batchBudgetMs = policy => policy.stages.filter(s => s.number !== RELAY_STAGE && s.number !== TRAIN_STAGE).reduce((sum, s) => sum + s.runMilliseconds + policy.limits.stageMarginMs, 0);
