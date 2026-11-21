// Stage 8 of Source v2: the Native control pair kooyumi-admission-verified + kooyumi-merge-slot.
// Port of independent-control-checks-v1/publisher.mjs with these changes only (DESIGN S6, S8, S13):
//   - job contract /2; the batch claim recorded by stage 1 must be observed again (A-strict stickiness);
//   - effect key / external_id carry the batch claim generation (a renewal is the same generation);
//   - S8: no 5-minute "native-queue-ready.json" marker written by a human/agent any more. The helper
//     itself polls the Native merge queue READ-ONLY (the same complete admission door) every 30 s until
//     the batch claim is the queue head, the merge slot is held for this base and still valid — only then
//     does it publish both checks. If the window min(45 min merge slot, claim lease, install validUntil,
//     stage cap) ends first, it stops cleanly with RESIDENT_QUEUE_HEAD_NOT_REACHED and publishes nothing.
//     The observations are read-only. Renewing the claim / merge slot (clued_work_renew) stays the claim holder's job
//     (agent contract A.6). Generation 12 (resident DESIGN 56.4): the only writes besides the pair are two CI-door actions
//     (claim-assist-native.mjs), each after an observation that passed: joining the claim to the merge queue and extending
//     its lease; a join is followed by one more observation, which may come after the window, and a ready head then
//     publishes as usual; a not-ready answer after a ready head (a transient failure before or while publishing) still
//     carries the lease end Native answered, without the queue place (review round 20, MINOR 2), except GREEN_LEDGER_UNAVAILABLE,
//     which keeps the whole facts with the place (review round 28);
//   - journal and observation log in state\v2\effects-control (S13);
//   - PR-A integration: the durable producer identity sourceBindingSha256 (v1's rule: everything but the
//     renewable lease and slot timestamps) is journaled, and consume() is the v2 control consumer the merge
//     gate reads through (consumer.mjs; scripts/ci/clued-work-admission.mjs provider independent-control-checks-v2).
//   - Resident quota redesign phase 2, step 2 (parking, design v0.5 §4.9; Owner decision e1e19e2e item 4): the resident
//     no longer waits inside the stage. It parks the batch after stage 7 and runs stage 8 again on its own back-off,
//     so one stage-8 run only checks (STAGE8_CHECK_MS: the first observation and the polls inside it) and says why it is
//     not ready yet, before any journal write and with zero side effects:
//       RESIDENT_BASE_MOVED              main's tip is no longer this batch's base (with strict this head never merges);
//       RESIDENT_MERGE_QUEUE_NOT_JOINED  the batch claim is not in the merge queue at all (the scheduling fact);
//       RESIDENT_QUEUE_HEAD_NOT_REACHED  it is in the queue, not at its head yet.
//   - Phase 2, step 3a (design v0.5 §5.3 rules 3, 5 and 7, §5.4 item 4; Owner decision 0bb98194; train-rules.mjs): once
//     the claim is the queue head, and before any journal write, stage 8 reads main's branch rules and GitHub's test
//     merge of the PR live. It writes no green while the six required checks are not all pinned to App 5368905, while
//     `strict` is off and the node does not run the train, or while the test merge is not exactly [T, H] with the tested
//     tree; each is a not-ready answer with zero side effects (TRAIN_TEST_MERGE_TREE_DIFFERS is final). The merge-slot
//     green is recorded in the green ledger (green-ledger.mjs) before it is written; a ledger that cannot take the
//     intent writes nothing (GREEN_LEDGER_UNAVAILABLE). After the write, a PR that GitHub has already merged with
//     exactly [T, H] and the tested tree is success (SETTLED_MERGED), never revoked; before 3a the closed PR read as
//     "authorization changed" and the green was revoked.
//   - Resident primary/standby design v0.4 §6.2 (C4, Task c2af8d17): a control check this journal knows nothing of (no
//     effect key under the batch claim) is read back on GitHub before its first publication (published-on-github-v2.mjs).
//     This App's check of the same name there, published by another node or install, ends the publication cleanly with
//     ROLE_ALREADY_ON_GITHUB: nothing posted, nothing revoked. publishPair reads both checks back before either is
//     published (and before the green-ledger intent), so this node never leaves the pair half published because the
//     other half is already on GitHub; a half with an unsettled journal entry skips that and keeps its reconciliation.
//   - Merge train (DESIGN §41.2, §41.4; train-rules.mjs, train-mode.mjs). trainMode is the installed policy's train.enabled.
//     Not on: a train front job (S != H) is refused at once (TRAIN_FRONT_JOB_WITHOUT_TRAIN), everything else is as before.
//     On: the merge-slot green also needs trainHeadDecision (the sweep proof of stage 10, the holders, the green ledger and
//     the PRs updated since the proof, read in this run; TRAIN_SINGLE_GREEN_NOT_PROVEN otherwise, not waited out); a front
//     S GitHub no longer has, or that is not the test merge of [T, H], ends the batch (TRAIN_TEST_COMMIT_GONE); the summary
//     names the front, T and S; after the pair settled, one touch green (the proof's slotHardCapMinutes) is only logged.
//   - Every publication's binding (Decision b30b1b79 item 3, §41.8): the merge slot is bound by state, ref, tip and queue
//     head only, like sourceBinding; neither its `until` nor the claim lease is, so a renewal, keepalive or touch in the
//     middle of a batch no longer voids it. Freshness still needs the lease unexpired (fresh()).
//   - bors-style landing (resident ADR 0018; train-landing.mjs): with the installed train.landing 'push' (stage file
//     train-landing.json), a front job's stage 8 writes nothing to GitHub's checks. After the queue head, the rules, the test
//     merge (one member) or the batch chain (several), the single-green/strict-front route, every member's live admission
//     and the required checks other Apps produce on S itself have passed, it fast-forwards main to S (landing port,
//     force false) and reads main back. Not ready answers park with zero side effects; a member that changed or a required
//     check that failed on S ends the batch (stage 10 composes again or bisects); a batch record with riders never gets a
//     merge-slot green in 'github-merge'.
//   - Three ways (ADR 0018 §2 L2 item 7, Fable 2026-11-20): 'push' installed means "can push". Which way a front job lands is read from
//     main's live rules and each ruleset's bypass after the queue head (train-landing.mjs#landingRoute): push lands as above; exactly
//     the state before the Owner's two steps (no kooyumi-train-landed, an empty main bypass) takes the current path (the control pair,
//     GitHub merges; never a batch with riders), and after the pair settled S, what push lacks and this App's own bypass state of both
//     rulesets are recorded as the rehearsal of push (the outcome's rehearsal, resident-v2/stage-inputs.mjs; S's checks are read by the
//     precheck before the Owner saves C, never here: Fable 11-21 应修 2);
//     anything else parks with TRAIN_LANDING_RULES_MISSING and the missing items (the outcome's landingMissing).
import { prepareNativePublication, nativePublicationNoPostProof } from '../../../../../scripts/ci/clued-independent-publication-port.mjs';
import { STAGE8_LEASE_MINUTES, extendLeaseIfShort, leaseAfter } from './claim-assist-native.mjs';
import { digest } from '../proof.mjs';
import { freshStamp } from '../clock-skew.mjs';
import { LANDING_NOT_READY_REASONS, LANDING_FINAL_REASONS, TRAIN_BATCH_CHANGED, TRAIN_BATCH_WITHOUT_PUSH, TRAIN_LANDING_REFUSED, TRAIN_LANDING_UNCONFIRMED,
  TRAIN_LANDING_RULES_MISSING, readLandingRoute, rehearsalOf, externalChecksDecision, readBatchChain, landMain } from './train-landing.mjs';
import { makeJobV2, validateJobV2, subjectOfV2, admissionEffectKeyV2, admissionExternalIdV2, claimGeneration, CONTROL_ROLES_V2, MAX_ATTEMPT_V2, sameBatchV2, isTrainFrontJobV2, frontJobIdsV2 } from '../job-v2.mjs';
import { admittedFactsMatchJobV2, fullAdmissionFailureV2 } from '../full-admission-v2.mjs';
import { TRAIN_MODES, TRAIN_MODE_DEFAULT, RULESET_UNREADABLE, STRICT_OFF_WITHOUT_TRAIN, MERGE_METHODS_NOT_MERGE_ONLY, TRAIN_TEST_MERGE_NOT_READY,
  TRAIN_TEST_MERGE_TREE_DIFFERS, TRAIN_FRONT_JOB_WITHOUT_TRAIN, TRAIN_SINGLE_GREEN_NOT_PROVEN, TRAIN_TEST_COMMIT_GONE, TRAIN_MODE_UNREADABLE, trainFrontRefused, trainFrontRefusal,
  trainHeadDecision, strictFrontHeadDecision, rulesetFacts, rulesetDecision, testMergeDecision, mergedAsTested,
  requiredCheckFailure, REQUIRED_CHECK_FAILED, REQUIRED_CHECKS_UNREADABLE, REQUIRED_CHECK_NAMES, projectedHolderForJob } from './train-rules.mjs';
import { GREEN_LEDGER_UNAVAILABLE } from './green-ledger.mjs';
import { ROLE_ALREADY_ON_GITHUB, publishedNames, ofJobIds } from '../published-on-github-v2.mjs';
import { withdrawalTitle, withdrawalNote } from '../withdrawal-text.mjs';
import { strictFrontSourceHealthy, recordFollows } from './train-strict.mjs';

export const APP_ID = 5368905, REPO = 'tdoljyj/cross-memory-system';
export const CONTROL_CHECKS_V2 = Object.freeze({
  'control-admission': Object.freeze({ name: 'kooyumi-admission-verified', appId: APP_ID }),
  'control-merge-slot': Object.freeze({ name: 'kooyumi-merge-slot', appId: APP_ID }),
});
export const QUEUE_POLL_MS = 30_000;
export const MERGE_SLOT_WINDOW_MS = 45 * 60_000;
// One stage-8 run (phase 2, step 2): the resident retries a parked batch, so a run only checks for this long.
export const STAGE8_CHECK_MS = 90_000;
// The time two publications need (queueWindow's reserve before the stage cap). The queue head is ready only while the merge slot
// still holds for this long, so the slot cannot lapse between the two halves of the pair (resident DESIGN §28.6).
export const PAIR_PUBLICATION_RESERVE_MS = 7 * 60_000;
// Why a stage-8 run was not ready (all BLOCKED, zero side effects, before any journal write).
export const STAGE8_NOT_READY_REASONS = Object.freeze(['RESIDENT_BASE_MOVED', 'RESIDENT_MERGE_QUEUE_NOT_JOINED', 'RESIDENT_QUEUE_HEAD_NOT_REACHED',
  REQUIRED_CHECK_FAILED, REQUIRED_CHECKS_UNREADABLE,
  // Phase 2, step 3a: the live branch rules and test merge, and the green ledger (all before any journal write).
  RULESET_UNREADABLE, STRICT_OFF_WITHOUT_TRAIN, MERGE_METHODS_NOT_MERGE_ONLY, TRAIN_TEST_MERGE_NOT_READY, GREEN_LEDGER_UNAVAILABLE,
  // Merge train (§41.2): the batch waits for the next stage 10; a front job whose stage directory's train mode could not be
  // read parks (review R1 m4).
  TRAIN_SINGLE_GREEN_NOT_PROVEN, TRAIN_MODE_UNREADABLE,
  // bors-style landing (ADR 0018): S's other-App checks still running, main's rules not yet what push relies on, the write refused.
  ...LANDING_NOT_READY_REASONS]);
// Final for this head (step 3a): GitHub's merge of exactly [T, H] is not the tree that was tested. Zero side effects.
// Merge train: a front job without the train; a front S GitHub dropped (§41.4: stage 10 reads S again for a new batch).
export const STAGE8_FINAL_REASONS = Object.freeze([TRAIN_TEST_MERGE_TREE_DIFFERS, TRAIN_FRONT_JOB_WITHOUT_TRAIN, TRAIN_TEST_COMMIT_GONE, ...LANDING_FINAL_REASONS]);
// Inside one run these are waited out (polled until the window ends); every other not-ready answer returns at once.
const TRAIN_WAITED = Object.freeze([RULESET_UNREADABLE, TRAIN_TEST_MERGE_NOT_READY]);
const SHA = /^[a-f0-9]{40}$/;
// Admission answers no wait can change: the run ends at once with the answer (stage-fact.mjs maps each one to its final
// code). The claim changed or missing; Native rejected; the PR closed or its head or base moved; Native's policy
// unsupported. Phase 2, step 2 (independent review M3): before, the last two were swallowed and came out as the retryable
// RESIDENT_QUEUE_HEAD_NOT_REACHED after the check window. full_admission_native_changed (the claim inactive, its lease
// lapsed, a verification older than 30 s) stays waited out: a renewal keeps the claim generation, so it can pass again,
// and a final ending would burn a head whose stages 3, 5 and 7 are published (re-review m17).
export const QUEUE_WAIT_FINAL_REASONS = Object.freeze(['full_admission_claim_changed', 'full_admission_rejected', 'full_admission_claim_missing',
  'full_admission_subject_changed', 'full_admission_native_unsupported']);
const ACTION = 'independent-control-check/2';
const HASH = /^[a-f0-9]{64}$/, fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
// An uncoded exception is never a transport fact (PR-A review MINOR 5).
const safe = e => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'CONTROL_CHECK_OPERATION_UNCONFIRMED';
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const definitionFor = job => CONTROL_CHECKS_V2[job.role];
const actualConsumptions = new WeakMap();
const exact = (v, keys) => plain(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const fixedJob = job => { validateJobV2(job); check(job.repo === REPO && CONTROL_ROLES_V2.includes(job.role) && job.attempt >= 1 && job.attempt <= MAX_ATTEMPT_V2, 'FIXED_INDEPENDENT_CONTROL_JOB_REQUIRED'); return freeze(structuredClone(job)); };
const prefixFor = job => `independent-ci:control:${job.role}`;
function identity(c, job, externalId) { return Number.isSafeInteger(c?.id) && c.id > 0 && c.app?.id === APP_ID && c.name === definitionFor(job).name && c.head_sha === job.headSha && c.external_id === externalId; }
const fresh = (f, now) => freshStamp(Date.parse(f.observedAt), now) && Date.parse(f.claimExpiresAt) > now;

// The merge-queue facts that make the merge-slot check true (S8). Pure.
export function queueHeadReady(job, facts, now) {
  return plain(facts?.mergeSlot) && facts.mergeSlot.state === 'held' && facts.mergeSlot.ref === `merge:${job.repo}:main` && facts.mergeSlot.tip === job.baseSha
    && Date.parse(facts.mergeSlot.until) > now && facts.mergeQueueHead === true;
}

export function factsValid(job, packet, facts, domain, now, batchClaim, { requireQueueHead = job.role === 'control-merge-slot' } = {}) {
  check(packet?.complete === true && packet.pr === job.pr && packet.headSha === job.headSha && packet.baseSha === job.baseSha && Array.isArray(packet.paths)
    && packet.paths.length > 0 && packet.paths.length <= 3000 && new Set(packet.paths).size === packet.paths.length, 'COMPLETE_CURRENT_PATHS_REQUIRED');
  const rejection = fullAdmissionFailureV2(facts);
  if (rejection) fail(rejection.reason);
  check(facts?.domain === domain && admittedFactsMatchJobV2(facts, job, now, { batchClaim }) && facts.packetSha256 === digest(packet), 'ACTUAL_COMPLETE_NATIVE_ADMISSION_REQUIRED');
  check(plain(facts.mode) && ['normal', 'efficiency', 'frozen'].includes(facts.mode.state) && ['docs', 'code', 'protected'].includes(facts.mode.layer) && plain(facts.mergeSlot)
    && (facts.ownerReview === null || plain(facts.ownerReview)) && Array.isArray(facts.workflowGateFindings) && facts.workflowGateFindings.length === 0, 'COMPLETE_NATIVE_GATES_REQUIRED');
  check(typeof facts.modeProofRef === 'string' && facts.modeProofRef.length > 0 && HASH.test(facts.evaluationSha256 ?? ''), 'FRESH_NATIVE_OBSERVATION_REQUIRED');
  if (requireQueueHead) check(queueHeadReady(job, facts, now), 'LIVE_ACTUAL_MERGE_SLOT_REQUIRED');
  return facts;
}
// §41.8: the slot by state, ref and tip (with mergeQueueHead beside it), never its until or the claim lease.
function binding(job, packet, facts, authority) {
  return digest({ subject: subjectOfV2(job), claim: claimGeneration(facts.observedClaim), pathsSha256: digest(packet.paths), scope: facts.scope, executionPolicy: facts.executionPolicy,
    ...(facts.publicationRequired ? { guarded: facts.guarded, publicationRequired: true, headAuthorizationId: facts.headAuthorizationId } : {}),
    mode: facts.mode, mergeSlot: { state: facts.mergeSlot.state, ref: facts.mergeSlot.ref, tip: facts.mergeSlot.tip }, mergeQueueHead: facts.mergeQueueHead,
    executionHandoverPending: facts.executionHandoverPending, ownerReview: facts.ownerReview, workflowGateFindings: facts.workflowGateFindings, authority, definition: definitionFor(job) });
}

// The durable producer identity excludes the renewable lease and slot timestamps (v1 sourceBinding); since §41.8 the
// live before/after binding above excludes them too.
function sourceBinding(job, packet, facts, authority) {
  return digest({ subject: subjectOfV2(job), claim: claimGeneration(facts.observedClaim), pathsSha256: digest(packet.paths), scope: facts.scope, executionPolicy: facts.executionPolicy,
    ...(facts.publicationRequired ? { publicationRequired: true, headAuthorizationId: facts.headAuthorizationId } : {}),
    guarded: facts.guarded, mode: facts.mode, ownerReview: facts.ownerReview, workflowGateFindings: facts.workflowGateFindings, authority, definition: definitionFor(job),
    slot: job.role === 'control-merge-slot' ? { state: facts.mergeSlot.state, ref: facts.mergeSlot.ref, tip: facts.mergeSlot.tip, queueHead: facts.mergeQueueHead } : null });
}

// Merge train only (trainMode 'on'): slotNative (merge-slot-native.mjs: holders, touch), sweepStore (train-sweep-store.mjs:
// latestProof, frontBatches, refused) and pullsUpdatedSince(cursorIso) -> {complete, pulls: [{number, updatedAt}]}
// (github.mjs readPullsUpdatedSince). Any of them missing is "not proven", never a green.
function engine({ github, journal, admission, assertLive, record, authority, batchClaim, greenLedger = null, trainMode = TRAIN_MODE_DEFAULT, trainModeUnreadable = false,
  slotNative = null, sweepStore = null, pullsUpdatedSince = null, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), claimAssist = null,
  trainLanding = null, landing = null }, production) {
  const domain = production ? 'production' : 'fixture';
  // The green ledger is required where a green is written (publishPair), not here: the merge-gate consumer only reads (review M1).
  check(TRAIN_MODES.includes(trainMode) && (greenLedger === null || typeof greenLedger?.append === 'function'), 'CONTROL_PUBLISHER_CONFIGURATION_REFUSED');
  const trainOn = trainMode === 'on';
  // ADR 0018: push lands main itself; the stage file read is trainLanding ({landing, batchMax, unreadable}); push needs the landing port.
  const push = trainOn && trainLanding?.landing === 'push' && trainLanding.unreadable !== true && typeof landing?.fastForwardMain === 'function';
  const landingUnreadable = trainOn && trainLanding?.unreadable === true;
  const frontRefused = () => ({ status: 'BLOCKED', reason: trainFrontRefusal(trainModeUnreadable), sideEffects: 0, productionAuthorized: false });
  // Phase 2, step 3a: the live branch rules of main and GitHub's test merge of the PR (train-rules.mjs). The tested tree is
  // the tree of the job's tested commit S: the head's own when S = H, GitHub's test merge of [T, H] for a train front
  // batch (step 3c-2, DESIGN §21.3). Any read that fails is a not-ready answer, never a stage failure: these facts change
  // by themselves and the resident tries again.
  async function trainFacts(job) {
    let rules;
    try { const reply = await github.readBranchRules('main'); check(reply?.complete === true, RULESET_UNREADABLE); rules = rulesetFacts(reply.rules, APP_ID); }
    catch { return { reason: RULESET_UNREADABLE }; }
    const ruleset = rulesetDecision(rules, trainMode);
    if (ruleset) return { reason: ruleset, ruleset: rules };
    let pull, tested, mergeCommit = null;
    // §41.4 (n7): with the train on, a front batch's S that GitHub answers 404 for is gone (a regenerated test merge): the
    // batch ends cleanly and stage 10 reads S again. Any other failing read is still not ready.
    const front = trainOn && isTrainFrontJobV2(job);
    try {
      pull = await github.readPullRequest(job.pr);
      try { tested = await github.readGitCommit(job.testSha); }
      catch (e) { if (front && e?.code === 'github_http_404') return { reason: TRAIN_TEST_COMMIT_GONE, ruleset: rules }; throw e; }
      if (SHA.test(pull?.merge_commit_sha ?? '')) mergeCommit = await github.readGitCommit(pull.merge_commit_sha);
    } catch { return { reason: TRAIN_TEST_MERGE_NOT_READY, ruleset: rules }; }
    if (!SHA.test(tested?.tree ?? '') || tested.sha !== job.testSha) return { reason: TRAIN_TEST_MERGE_NOT_READY, ruleset: rules };
    // ADR 0018 §3: this node's batch record of S. Several members: only push lands it, and S must be their chain on T (no GitHub test
    // merge is involved). A record that cannot be read is not ready.
    let batch = null;
    if (front && typeof sweepStore?.landingBatchByTest === 'function') {
      try { batch = await sweepStore.landingBatchByTest(job.testSha); } catch { return { reason: TRAIN_TEST_MERGE_NOT_READY, ruleset: rules }; }
      if (batch && (batch.frontPr !== job.pr || batch.frontHeadSha !== job.headSha || batch.baseSha !== job.baseSha || batch.testTree !== tested.tree)) return { reason: TRAIN_BATCH_CHANGED, ruleset: rules };
    }
    if (batch && batch.members.length > 1) {
      if (!push) return { reason: TRAIN_BATCH_WITHOUT_PUSH, ruleset: rules };
      const chain = await readBatchChain({ readGitCommit: s => github.readGitCommit(s), baseSha: job.baseSha, heads: batch.members.map(m => m.headSha), testSha: job.testSha });
      if (!chain.ok || chain.tree !== tested.tree) return { reason: TRAIN_BATCH_CHANGED, ruleset: rules };
      return { reason: null, ruleset: rules, testTree: tested.tree, testMergeSha: null, batch };
    }
    // S itself is the test merge of exactly [T, H], or it is not this batch's S at all.
    if (front && !(Array.isArray(tested.parents) && tested.parents.length === 2 && tested.parents[0] === job.baseSha && tested.parents[1] === job.headSha))
      return { reason: TRAIN_TEST_COMMIT_GONE, ruleset: rules };
    const reason = testMergeDecision({ pull, mergeCommit, job, testTree: tested.tree });
    return { reason, ruleset: rules, testTree: tested.tree, testMergeSha: reason ? null : pull.merge_commit_sha, batch };
  }
  // After the write: GitHub's own answer for the PR now. 'merged' when it merged exactly [T, H] with the tested tree;
  // 'mismatch' when it merged any other way (squash, rebase, other parents or tree: review M3), or when the PR is open and
  // the test merge is definitely other parents or another tree; otherwise 'open' (also when it cannot be read: the Native
  // boundary decides then, as before 3a).
  async function afterWrite(job, train) {
    try {
      const pull = await github.readPullRequest(job.pr);
      const mergeCommit = SHA.test(pull?.merge_commit_sha ?? '') ? await github.readGitCommit(pull.merge_commit_sha) : null;
      if (mergedAsTested({ pull, mergeCommit, job, testTree: train.testTree })) return { state: 'merged', mergeSha: pull.merge_commit_sha };
      if (pull?.merged === true) return { state: 'mismatch' };
      if (pull?.state === 'open' && pull.head?.sha === job.headSha && pull.mergeable === true && mergeCommit
        && testMergeDecision({ pull, mergeCommit, job, testTree: train.testTree }) !== null) return { state: 'mismatch' };
    } catch { /* unreadable: no new fact */ }
    return { state: 'open' };
  }
  async function ledger(phase, job, train, key, externalId, checkRunId = null, detail = null, { required = false } = {}) {
    if (!greenLedger || job.role !== 'control-merge-slot') return;
    try { await greenLedger.append({ phase, job, testTree: train.testTree, testMergeSha: train.testMergeSha ?? null, effectKey: key, externalId, checkRunId, detail }); }
    catch (e) { if (required) throw e; }
  }
  // §41.2 trainHeadReady (train on, merge-slot job): read in this run, after the queue head and the test merge held. A
  // read that fails proves nothing (null), so it is TRAIN_SINGLE_GREEN_NOT_PROVEN like every unmet condition.
  async function trainHead(job, train, observedClaim, nativeMode) {
    const read = async f => { try { return await f(); } catch { return null; } };
    const holders = await read(() => slotNative?.holders()), proof = await read(() => sweepStore?.latestProof());
    const strictProof = train?.ruleset?.strict === true && proof?.fullSweepSinceOn !== true ? await read(() => sweepStore?.latestStrictProof?.()) : null;
    const front = (await read(() => sweepStore?.frontBatches({ pr: job.pr, headSha: job.headSha })))?.[0] ?? null;
    const storeRefused = Number.isSafeInteger(sweepStore?.refused) ? sweepStore.refused : 1;
    const strictStoreRefused = Number.isSafeInteger(sweepStore?.strictRefused) ? sweepStore.strictRefused : 1;
    const list = await read(() => greenLedger?.list?.());
    let fastLegacy = null, fullState = null, round = null, integrityReadable = false;
    const unproven = () => ({ reason: TRAIN_SINGLE_GREEN_NOT_PROVEN, proof, strictProof });
    // Integrity failures are not a missing optional fast certificate. Never
    // fall back through an older v1/coverage record over known unreadable or
    // pending state. Healthy complete-full records keep their frozen semantics.
    if (typeof sweepStore?.latestProofStrict === 'function' && typeof sweepStore?.readFullSweepStrict === 'function'
      && typeof sweepStore?.readStrictRound === 'function') {
      try {
        fastLegacy = await sweepStore.latestProofStrict();
        fullState = await sweepStore.readFullSweepStrict('on');
        round = await sweepStore.readStrictRound();
        await sweepStore.latestStrictProof();
        const pending = await sweepStore.readPendingRevocations();
        if (pending && (pending.repo !== job.repo || pending.targets.length !== 0 || pending.legacyUnconfirmed !== 0)) return unproven();
        integrityReadable = true;
      } catch { return unproven(); }
      if (!recordFollows(fastLegacy, fullState) || (fastLegacy !== null && fastLegacy.unconfirmed !== 0) || round?.pending?.length
        || fullState?.allPending === 'TRAIN_MAIN_REWRITTEN' || fullState?.full?.reason === 'TRAIN_MAIN_REWRITTEN') return unproven();
    }
    if (train?.ruleset?.strict === true && proof?.fullSweepSinceOn !== true) {
      let frontProof = null;
      if (typeof sweepStore?.latestStrictFrontProof === 'function') {
        try { frontProof = await sweepStore.latestStrictFrontProof(); }
        catch { return unproven(); }
      }
      try {
        const status = await slotNative.nodesStatus(), main = await github.readBranchHead('main');
        const reason = strictFrontHeadDecision({ job, holders, frontProof, proof: fastLegacy, fullState, front, ledger: list, now: clock(),
          liveRules: train.ruleset, liveMainSha: main?.sha, observedClaim, batchClaim, testTree: train.testTree, nativeMode,
          sourceHealthy: strictFrontSourceHealthy(status, job.sourceManifestSha256, clock()),
          storeHealthy: integrityReadable && sweepStore.refused === 0 && !(round?.pending?.length) });
        if (reason === null) return { reason: null, proof: frontProof, strictProof: null, frontOnly: true };
      } catch { /* Unknown/torn pending state cannot authorize this route. */ }
    }
    const cursor = strictProof?.prUpdatedCursor ?? proof?.prUpdatedCursor;
    const pulls = cursor && typeof pullsUpdatedSince === 'function' ? await read(() => pullsUpdatedSince(cursor)) : null;
    return { reason: trainHeadDecision({ job, claimId: batchClaim?.claimId, holders, proof, storeRefused, front, ledger: list, pulls, now: clock(),
      strictProof, strictStoreRefused, liveRules: train?.ruleset, observedClaim, batchClaim, testTree: train?.testTree }), proof, strictProof };
  }
  async function revalidateStrictException(job, train, facts) {
    if (!train?.strictException && !train?.strictFrontException) return;
    const liveTrain = await trainFacts(job);
    check(!liveTrain.reason && liveTrain.ruleset?.strict === true, TRAIN_SINGLE_GREEN_NOT_PROVEN);
    const current = await trainHead(job, liveTrain, facts.observedClaim, facts.mode?.state);
    check(!current.reason, TRAIN_SINGLE_GREEN_NOT_PROVEN);
    check(!train.strictFrontException || current.frontOnly === true, TRAIN_SINGLE_GREEN_NOT_PROVEN);
    record(train.strictFrontException ? 'native_strict_front_bound' : 'native_strict_exception_bound', { jobId: job.id, claim: claimGeneration(facts.observedClaim),
      sourceManifestSha256: job.sourceManifestSha256, baseSha: job.baseSha, headSha: job.headSha, testSha: job.testSha, testTree: liveTrain.testTree,
      coverageSha256: digest(current.strictProof ?? current.proof) });
  }
  // §41.2 touch green: once, after the pair settled, and only while this claim is still the one front holder of this PR.
  // It never changes the ending or revokes anything; what happened is logged (observation log) and returned.
  async function touchGreen(job, proof) {
    let out;
    try {
      // The same projection as the green (train-rules.mjs): a Task with several bound PRs has no scalar pr (field 2026-11-13).
      const h = await slotNative.holders(), one = h?.onDuty === true && h.holders.length === 1 ? projectedHolderForJob(h.holders[0], job, batchClaim?.claimId) : null;
      out = one
        ? await slotNative.touch({ pr: job.pr, headSha: job.headSha, ciState: 'green', hardCapMinutes: proof.slotHardCapMinutes }) : { onDuty: h?.onDuty ?? null, touched: false, code: 'TRAIN_TOUCH_NOT_FRONT' };
    } catch (e) { out = { onDuty: null, touched: false, code: safe(e) }; }
    const result = { ciState: 'green', onDuty: out.onDuty, touched: out.touched === true, code: out.code ?? (out.onDuty === false ? 'NODE_ROLE_NOT_HELD' : null) };
    try { record('native_train_touch', { jobId: job.id, ...result }); } catch { /* best-effort */ }
    return result;
  }
  // scheduling (optional): told the scheduling facts of each evaluation (full-admission-v2 option; never authority).
  async function observe(job, scheduling = null) { assertLive(); const packet = await github.readChangedPaths(job), facts = await admission.evaluatePr(job, packet, { batchClaim, ...(scheduling ? { scheduling } : {}) }); assertLive(); return { packet, facts }; }
  async function boundary(job) {
    const { packet, facts } = await observe(job); factsValid(job, packet, facts, domain, clock(), batchClaim);
    record('native_check_boundary', { jobId: job.id, nativeObservationSha256: facts.observationSha256, packetSha256: digest(packet) });
    return { facts, packet, bindingSha256: binding(job, packet, facts, authority), sourceBindingSha256: sourceBinding(job, packet, facts, authority) };
  }
  async function inventory(job, externalId) {
    const list = await github.readChecks(job.headSha);
    check(list?.complete === true && Array.isArray(list.checks) && list.checks.length <= 10000 && new Set(list.checks.map(c => c?.id)).size === list.checks.length
      && list.checks.every(c => Number.isSafeInteger(c?.id) && c.id > 0 && c.head_sha === job.headSha), 'COMPLETE_CHECK_INVENTORY_REQUIRED');
    const matches = list.checks.filter(c => identity(c, job, externalId));
    if (matches.length === 1) check(!list.checks.some(c => c.app?.id === APP_ID && c.name === definitionFor(job).name && c.id > matches[0].id), 'NEWER_CONTROL_JUDGEMENT_PRESENT');
    return matches;
  }
  async function readback(job, externalId, id, conclusion) { const m = await inventory(job, externalId); check(m.length === 1 && m[0].id === id && m[0].status === 'completed' && m[0].conclusion === conclusion, 'NATIVE_CHECK_READBACK_UNCONFIRMED'); return m[0]; }
  async function transition(key, phase, next, details) { try { return await journal.transition(key, phase, next, details); } catch { return null; } }
  async function revoke({ job, key, externalId, known, phase, cause, sideEffects, train = null }) {
    const r = await revokeOnce({ job, key, externalId, known, phase, cause, sideEffects });
    if (r.status === 'REVOKED' && train) await ledger('revoked', job, train, key, externalId, known.id, cause);
    return r;
  }
  async function revokeOnce({ job, key, externalId, known, phase, cause, sideEffects }) {
    const revKey = digest({ action: 'independent-control-revoke/2', effectKey: key, checkRunId: known.id }); let revPhase = 'intent', logged = false;
    try { const m = await inventory(job, externalId); check(m.length === 1 && m[0].id === known.id, 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED'); }
    catch { return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED', effectKey: key, sideEffects, productionAuthorized: false }; }
    try {
      const intent = await journal.begin(revKey, { checkRunId: known.id, appId: APP_ID, name: definitionFor(job).name, headSha: job.headSha, externalId });
      if (intent.existing) return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_RECONCILIATION_REQUIRED', effectKey: key, sideEffects, productionAuthorized: false };
      await journal.transition(revKey, 'intent', 'authorized'); revPhase = 'authorized'; await journal.transition(revKey, 'authorized', 'sent'); revPhase = 'sent'; logged = true;
    } catch { if (phase !== 'sent') return { status: 'UNCERTAIN', reason: 'NEGATIVE_COMPENSATION_JOURNAL_UNCONFIRMED', effectKey: key, sideEffects, productionAuthorized: false }; }
    try {
      assertLive(); sideEffects++;
      const patched = await github.revokeCheck(known.id, { status: 'completed', conclusion: 'failure', output: { title: withdrawalTitle('Independent control', cause), summary: `Reconcile Native admission check ${key}; ${cause}.${withdrawalNote(cause)} No Native ticket or Receipt is asserted.` } });
      check(identity(patched, job, externalId) && patched.status === 'completed' && patched.conclusion === 'failure', 'NEGATIVE_COMPENSATION_UNCONFIRMED'); await readback(job, externalId, known.id, 'failure');
      if (logged) await journal.transition(revKey, 'sent', 'settled', { checkRunId: known.id, conclusion: 'failure' });
      const current = await journal.read(key); check(['sent', 'uncertain', 'settled'].includes(current?.state), 'NEGATIVE_COMPENSATION_STATE_UNCONFIRMED');
      await journal.transition(key, current.state, 'revoked', { checkRunId: known.id, externalId, reason: cause });
      record('native_check_revoked', { jobId: job.id, effectKey: key, checkRunId: known.id, cause });
      return { status: 'REVOKED', effectKey: key, checkRunId: known.id, reason: cause, sideEffects, productionAuthorized: false };
    } catch {
      if (revPhase === 'sent') await transition(revKey, 'sent', 'uncertain', { checkRunId: known.id, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' });
      if (phase === 'sent') await transition(key, 'sent', 'uncertain', { checkRunId: known.id, externalId, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' });
      return { status: 'UNCERTAIN', effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: false, reason: 'NEGATIVE_COMPENSATION_UNCONFIRMED' };
    }
  }
  // C4: this App's check of the job's name is on GitHub although this journal has no entry for it under the batch claim.
  // It looks at this job's own entry only: a direct publishOne of one half does not see the other half's unsettled entry;
  // publishPair, the stage-8 path, checks both halves' entries before it calls this. A train front job counts only the checks
  // of its own front subject's jobs (§41.4: the non-front run H normally has first is another identity).
  async function onGithubOnly(job) {
    if (await journal.read(admissionEffectKeyV2(ACTION, job, batchClaim, definitionFor(job)))) return false;
    assertLive();
    return (await publishedNames(github, job.headSha, [definitionFor(job).name], APP_ID, frontJobIdsV2(job))).length > 0;
  }
  // train: the facts trainFacts() read before the pair (publishPair); the merge-slot green is ledgered and checked
  // against GitHub's test merge after the write. Without them (a direct call) the check is written as before 3a.
  async function publishOne(input, { train = null } = {}) {
    let job, key, externalId, previous, before;
    try {
      job = fixedJob(input);
      if (trainFrontRefused(job, trainMode)) return frontRefused();
      key = admissionEffectKeyV2(ACTION, job, batchClaim, definitionFor(job)); externalId = admissionExternalIdV2(prefixFor(job), job, batchClaim);
      previous = await journal.read(key);
      if (previous && previous.state !== 'settled') return { status: previous.state === 'revoked' ? 'REVOKED' : 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false };
      before = await boundary(job);
      await revalidateStrictException(job, train, before.facts);
      if (previous) { await readback(job, externalId, previous.details.checkRunId, 'success'); return { status: 'SETTLED', effectKey: key, checkRunId: previous.details.checkRunId, sideEffects: 0, productionAuthorized: production }; }
      if (await onGithubOnly(job)) return { status: 'BLOCKED', effectKey: key, reason: ROLE_ALREADY_ON_GITHUB, sideEffects: 0, productionAuthorized: false };
    } catch (e) {
      if (previous?.state === 'settled' && Number.isSafeInteger(previous.details?.checkRunId) && previous.details.checkRunId > 0) return revoke({ job, key, externalId, known: { id: previous.details.checkRunId }, phase: 'settled', cause: safe(e), sideEffects: 0 });
      return { status: 'BLOCKED', reason: safe(e), sideEffects: 0, productionAuthorized: false };
    }
    let phase = 'intent', sent = false, known = null, sideEffects = 0;
    try {
      const intent = await journal.begin(key, { subject: subjectOfV2(job), claim: batchClaim, definition: definitionFor(job), externalId, observationKind: 'actual-native-admission-control', nativeObservationSha256: before.facts.observationSha256, bindingSha256: before.bindingSha256, sourceBindingSha256: before.sourceBindingSha256, compensation: 'known-success-one-bounded-negative-patch' });
      if (intent.existing) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects, productionAuthorized: false };
      await journal.transition(key, 'intent', 'authorized', { nativeObservationSha256: before.facts.observationSha256 }); phase = 'authorized';
      assertLive(); check(fresh(before.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_BEFORE_WRITE');
      // §41.2 (design §5.3 rule 6): with the train on, the merge-slot green names the front, T and S for stage 10, review and the Owner.
      const front = trainOn && job.role === 'control-merge-slot' && SHA.test(train?.testTree ?? '')
        ? `front PR #${job.pr}, head ${job.headSha}, main@${job.baseSha}, tested ${job.testSha === job.headSha ? 'head' : job.testSha} (tree ${train.testTree}). ` : '';
      const payload = { name: definitionFor(job).name, head_sha: job.headSha, status: 'completed', conclusion: 'success', external_id: externalId,
        output: { title: 'Complete Native control and exact subject verified', summary: `${front}Independent Native control check for ${REPO}#${job.pr} (attempt ${job.attempt}); observation sha256 ${before.facts.observationSha256}. ${before.facts.publicationRequired ? 'This observation is not scanner execution or qualification. The protected publisher attaches its Native Receipt.' : 'This is not a scanner execution, Native publication ticket, Receipt or qualification.'}` } };
      const nativeHandle = await prepareNativePublication(github, { facts: before.facts, packet: before.packet, payload });
      await journal.transition(key, 'authorized', 'sent', { externalId, nativeObservationSha256: before.facts.observationSha256 }); phase = 'sent'; sent = true; sideEffects++;
      const posted = await github.createCheck(payload, nativeHandle);
      check(identity(posted, job, externalId) && posted.status === 'completed' && posted.conclusion === 'success', 'NATIVE_CHECK_IDENTITY_UNCONFIRMED'); known = posted;
      if (train) await ledger('posted', job, train, key, externalId, known.id);
      const after = await boundary(job); check(after.bindingSha256 === before.bindingSha256, 'NATIVE_AUTHORIZATION_BINDING_CHANGED');
      await revalidateStrictException(job, train, after.facts);
      await readback(job, externalId, known.id, 'success'); assertLive(); check(fresh(after.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE');
      // Step 3a, rule 3 after the write: an open PR whose test merge is now definitely something else loses the green.
      const written = train && job.role === 'control-merge-slot' ? await afterWrite(job, train) : null;
      check(written?.state !== 'mismatch', 'TRAIN_TEST_MERGE_CHANGED_AFTER_WRITE');
      await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: 'success', nativeObservationBeforeSha256: before.facts.observationSha256, nativeObservationAfterSha256: after.facts.observationSha256, bindingSha256: after.bindingSha256, sourceBindingSha256: after.sourceBindingSha256,
        ...(written?.state === 'merged' ? { settledMerged: written.mergeSha } : {}) });
      record('native_check_settled', { jobId: job.id, effectKey: key, checkRunId: known.id, beforeSha256: before.facts.observationSha256, afterSha256: after.facts.observationSha256 });
      if (train) await ledger(written?.state === 'merged' ? 'merged' : 'settled', job, train, key, externalId, known.id, written?.state === 'merged' ? written.mergeSha : null);
      return { status: 'SETTLED', effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: production, ...(written?.state === 'merged' ? { settledMerged: true } : {}) };
    } catch (e) {
      if (sent && !known && sideEffects === 1 && nativePublicationNoPostProof(e)?.notSent === true) {
        await transition(key, phase, 'revoked', { reason: 'native_publication_not_sent', notSent: true, externalId });
        return { status: 'BLOCKED', effectKey: key, reason: 'native_publication_not_sent', sideEffects: 0, productionAuthorized: false };
      }
      if (sent && !known) { try { const m = await inventory(job, externalId); if (m.length === 1) known = m[0]; } catch { /* read-only discovery cannot prove a missing POST */ } }
      // Step 3a, rule 7: the after-write boundary refuses a PR that is no longer open. When GitHub merged it with exactly
      // [T, H] and the tested tree, the green did what it was for: SETTLED_MERGED, never revoked.
      if (sent && known && train && job.role === 'control-merge-slot') {
        const written = await afterWrite(job, train);
        let settled = false;
        if (written.state === 'merged') {
          try {
            await readback(job, externalId, known.id, 'success');
            await journal.transition(key, 'sent', 'settled', { checkRunId: known.id, externalId, conclusion: 'success', settledMerged: written.mergeSha,
              nativeObservationBeforeSha256: before.facts.observationSha256, bindingSha256: before.bindingSha256, sourceBindingSha256: before.sourceBindingSha256 });
            settled = true;
          } catch { /* not confirmed: compensate as before */ }
        }
        // Settled is settled: the log and the ledger after it are best-effort and can never turn it into a revoke (review N3).
        if (settled) {
          try { record('native_check_settled_merged', { jobId: job.id, effectKey: key, checkRunId: known.id, mergeSha: written.mergeSha, cause: safe(e) }); } catch { /* best-effort */ }
          await ledger('merged', job, train, key, externalId, known.id, written.mergeSha);
          return { status: 'SETTLED', effectKey: key, checkRunId: known.id, sideEffects, productionAuthorized: production, settledMerged: true };
        }
      }
      if (sent && known) return revoke({ job, key, externalId, known, phase, cause: safe(e), sideEffects, train: job.role === 'control-merge-slot' ? train : null });
      await transition(key, phase, sent ? 'uncertain' : 'not_sent', { reason: safe(e), externalId });
      return { status: sent ? 'UNCERTAIN' : 'BLOCKED', effectKey: key, reason: safe(e), sideEffects, productionAuthorized: false };
    }
  }
  // S8: read-only wait for the queue head, then publish the pair in the fixed order. The latest scheduling facts
  // (is the claim in the merge queue at all) travel with a not-ready answer (resident quota redesign v0.6 §9), and
  // the answer names why (phase 2, step 2): main moved (at once: waiting cannot help), not in the queue, not its head.
  // Generation 12 (resident DESIGN 56.4): with claimAssist (claim-assist-native.mjs), a claim Native observed outside the merge queue is
  // put in it once per run (the back of the queue; the wait goes on and may reach the head within this run), and a lease shorter than
  // STAGE8_LEASE_MINUTES is extended once; both only after the checks that end the run at once (main moved), so a batch that cannot
  // merge never takes a place in the queue. A claim already at the head is not put in the queue again, but its lease is still extended,
  // once, after the head checks and before the run answers ready. Neither is a publication or a side effect of this stage; a failure is only recorded, and
  // the lease end this run reports is the one Native answered to the extension.
  async function waitForQueueHead(slotJob, waitUntil) {
    let scheduling = null, last = null, lastTrain = null, joinAsked = false, extendAsked = false, reobserve = false;
    const tell = facts => { scheduling = facts; };
    // Once per run, also on a try that is ready at once (review round 19, MINOR 2): the lease is extended before the run ends either way.
    const extendOnce = async () => {
      if (!claimAssist || extendAsked || !scheduling?.claimExpiresAt) return;
      extendAsked = true;
      const x = await extendLeaseIfShort({ claimAssist, job: slotJob, claimExpiresAt: scheduling.claimExpiresAt, minutes: STAGE8_LEASE_MINUTES, now: clock(), record });
      if (x) scheduling = { ...scheduling, claimExpiresAt: leaseAfter(scheduling.claimExpiresAt, x) };
    };
    for (let polls = 1; ; polls++) {
      let observed = null, answered = null;
      try { const { packet, facts } = await observe(slotJob, tell); answered = facts; factsValid(slotJob, packet, facts, domain, clock(), batchClaim, { requireQueueHead: false }); observed = facts; last = facts; }
      catch (e) {
        if (QUEUE_WAIT_FINAL_REASONS.includes(e.code)) {
          // A protected change Native rejects as no longer up to date is main moving under the batch (review m6).
          const d = e.code === 'full_admission_rejected' ? fullAdmissionFailureV2(answered)?.admissionDiagnostic : null;
          const behind = [...(d?.reasonCodes ?? []), ...(d?.nativeReasonCodes ?? [])].includes('protected_change_not_up_to_date');
          return { ready: false, reason: behind ? 'RESIDENT_BASE_MOVED' : e.code, polls, scheduling };
        }
      }
      lastTrain = null;
      if (observed) {
        // Before joining, extending or publishing, inspect the current head's
        // required checks. Failed work must give the next claim its turn.
        let failures;
        try {
          let rules;
          try { rules = await github.readBranchRules('main'); } catch { throw Object.assign(new Error(RULESET_UNREADABLE), { code: RULESET_UNREADABLE }); }
          check(rules?.complete === true, RULESET_UNREADABLE);
          const inventory = await github.readChecks(slotJob.headSha);
          // A train front (H,S) has its own Native six-check identity. Project
          // CI checks still apply to H regardless of their publishing App.
          const ids = frontJobIdsV2(slotJob);
          if (ids && Array.isArray(inventory?.checks)) inventory.checks = inventory.checks.filter(c => c?.app?.id !== APP_ID
            || !REQUIRED_CHECK_NAMES.includes(c.name) || ofJobIds(c, ids));
          failures = requiredCheckFailure(rules.rules, inventory, slotJob.headSha, APP_ID);
        } catch (e) { return { ready: false, reason: e.code === RULESET_UNREADABLE ? RULESET_UNREADABLE : REQUIRED_CHECKS_UNREADABLE, polls, scheduling }; }
        if (failures.length) {
          let returned = null;
          if (scheduling?.mergeQueue?.entered === true && slotNative?.returnSlot) {
            try {
              const pull = await github.readPullRequest(slotJob.pr);
              check(pull?.state === 'open' && pull.head?.sha === slotJob.headSha, REQUIRED_CHECKS_UNREADABLE);
              returned = await slotNative.returnSlot({ pr: slotJob.pr });
            } catch { returned = { ok: false }; }
            if (returned?.onDuty === true && returned.returned === true) scheduling = { ...scheduling, mergeQueue: { entered: false, state: null, position: null } };
          }
          try { record('native_required_check_failed', { jobId: slotJob.id, failures, returned }); } catch { /* best-effort */ }
          return { ready: false, reason: REQUIRED_CHECK_FAILED, polls, scheduling };
        }
      }
      // §28.6: ready only with the slot still held after the time the pair needs; a shorter slot is not ready yet. The claim lease that
      // bounds the slot is extended below (extendOnce) and observed again; a slot nothing extends lapses and the claim joins again.
      if (observed && queueHeadReady(slotJob, observed, clock() + PAIR_PUBLICATION_RESERVE_MS)) {
        // Step 3a: the queue head may write only under live rules that still hold main, on a test merge of exactly [T, H].
        const train = await trainFacts(slotJob);
        // §41.2: with the train on, only a green the single-green proof covers; not waited out (the next stage 10 decides).
        if (!train.reason && trainOn) {
          const proven = await trainHead(slotJob, train, observed.observedClaim, observed.mode?.state);
          // A queue head the train or the rules hold is still a claim whose admission passed: its lease is extended once before the run
          // ends (review round 29, MINOR 1).
          if (proven.reason) { record('native_train_not_ready', { jobId: slotJob.id, reason: proven.reason }); await extendOnce(); return { ready: false, reason: proven.reason, polls, scheduling }; }
          train.proof = proven.proof;
          train.strictException = proven.proof?.fullSweepSinceOn !== true && proven.strictProof !== null && proven.frontOnly !== true;
          train.strictFrontException = proven.frontOnly === true;
        }
        if (!train.reason) { await extendOnce(); return { ready: true, polls, scheduling, train }; }
        record('native_train_not_ready', { jobId: slotJob.id, reason: train.reason });
        if (!TRAIN_WAITED.includes(train.reason)) { await extendOnce(); return { ready: false, reason: train.reason, polls, scheduling }; }
        lastTrain = train.reason;
      }
      if (observed && typeof observed.mergeSlot?.tip === 'string' && observed.mergeSlot.tip !== slotJob.baseSha) return { ready: false, reason: 'RESIDENT_BASE_MOVED', polls, scheduling };
      if (observed && claimAssist) {
        await extendOnce();
        if (!joinAsked && scheduling?.mergeQueue?.entered === false) {
          joinAsked = true;
          let j;
          try { j = await claimAssist.joinQueue({ pr: slotJob.pr, headSha: slotJob.headSha }); } catch { j = { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' }; }
          try { record('native_queue_join', { jobId: slotJob.id, ok: j.ok === true, joined: j.joined === true, code: j.code ?? j.reason ?? null }); } catch { /* a log only */ }
          // A join changes the claim's trigger_refs and so the digest of its execution admission: one more observation (a verify of
          // this head) right away records the admission again, also when this run's window is over (review round 11, MINOR 1). If
          // that observation fails (a passing GitHub or Native fault), the next try records it again. The stage's own deadline still
          // bounds it.
          reobserve = j.ok === true && j.joined === true;
          // Until an observation says more, the claim is in the queue at an unknown place: a failed observation after the join never
          // reports it as not joined (review round 24, NIT 4).
          if (reobserve) scheduling = { ...scheduling, mergeQueue: { entered: true, state: 'waiting', position: null } };
        }
      }
      if (reobserve) { reobserve = false; continue; }
      if (clock() + QUEUE_POLL_MS > waitUntil) {
        if (lastTrain) return { ready: false, reason: lastTrain, polls, scheduling };
        const notJoined = last !== null && scheduling?.mergeQueue?.entered === false;
        return { ready: false, reason: notJoined ? 'RESIDENT_MERGE_QUEUE_NOT_JOINED' : 'RESIDENT_QUEUE_HEAD_NOT_REACHED', polls, scheduling };
      }
      await sleep(QUEUE_POLL_MS);
    }
  }
  // Fable 2026-11-20: the rehearsal of push on the current path, after the pair settled; it never changes the ending. 11-21 应修 2: nothing
  // is read for it (S's checks have not finished now; the precheck reads them from GitHub before the Owner saves C).
  function rehearse(job, route) {
    // route: the read this run chose by (the same GET /rulesets/{id} answers)
    const r = rehearsalOf({ testSha: job.testSha, route });
    try { record('native_train_landing_rehearsal', { jobId: job.id, ...r }); } catch { /* a log only */ }
    return r;
  }
  // ADR 0018 §5: the one write to main. The effect key names the subject, the batch claim generation and the members; an earlier key of
  // the same landing that ended without effect (not_sent, revoked: refused or main moved) is followed by the next one, any other
  // unfinished one needs reconciliation. Every check below runs live in this run; any that fails writes nothing.
  async function landingKey(job, members) {
    const base = { action: 'train-land-main/1', subject: subjectOfV2(job), claim: claimGeneration(batchClaim), members: members.map(m => [m.pr, m.headSha]) };
    for (let k = 0; k < 32; k++) {
      const key = digest({ ...base, retry: k }), entry = await journal.read(key);
      if (!entry) return { key };
      if (['not_sent', 'revoked'].includes(entry.state)) continue;
      return { key, entry };
    }
    fail('TRAIN_LANDING_RETRIES_EXHAUSTED');
  }
  async function landOne(input, headTrain, lease) {
    const blocked = (reason, extra = {}) => ({ status: 'BLOCKED', reason, sideEffects: 0, productionAuthorized: false, ...lease, ...extra });
    let job, members, key;
    try {
      job = fixedJob(input);
      check(job.role === 'control-merge-slot' && isTrainFrontJobV2(job), 'TRAIN_LANDING_SUBJECT_REQUIRED');
      members = headTrain?.batch?.members ?? [{ pr: job.pr, headSha: job.headSha, claimId: batchClaim?.claimId ?? null }];
      const k = await landingKey(job, members);
      key = k.key;
      if (k.entry?.state === 'settled') return { status: 'SETTLED', effectKey: key, sideEffects: 0, productionAuthorized: production, landed: k.entry.details?.landed ?? null };
      if (k.entry) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false, ...lease };
    } catch (e) { return blocked(safe(e)); }
    let before, mainNow;
    try {
      // the front: complete Native admission with the queue head, never frozen; the train facts and the single-green route again
      before = await boundary(job);
      check(['normal', 'efficiency'].includes(before.facts.mode?.state), 'NATIVE_FROZEN_NO_LANDING');
      const liveTrain = await trainFacts(job);
      if (liveTrain.reason) return blocked(liveTrain.reason);
      check(liveTrain.testTree === headTrain.testTree && (liveTrain.batch?.testSha ?? null) === (headTrain.batch?.testSha ?? null), TRAIN_BATCH_CHANGED);
      const current = await trainHead(job, liveTrain, before.facts.observedClaim, before.facts.mode?.state);
      if (current.reason) return blocked(current.reason);
      // main's rules hold what push relies on: the route read again in this run (ADR 0018 §2 L2 item 7; never pushed on rules not complete)
      const reply = await github.readBranchRules('main');
      check(reply?.complete === true, RULESET_UNREADABLE);
      const route = await readLandingRoute({ github, appId: APP_ID, rules: reply.rules });
      if (route.route !== 'push') return blocked(TRAIN_LANDING_RULES_MISSING, { missing: route.missing });
      // every member: open, its head, into main; every rider: its own complete admission (never frozen, never a guarded publication),
      // the claim the batch recorded, in the merge queue
      for (const [i, m] of members.entries()) {
        const pull = await github.readPullRequest(m.pr);
        if (!(pull?.state === 'open' && pull.head?.sha === m.headSha && pull.base?.ref === 'main')) return blocked(TRAIN_BATCH_CHANGED);
        if (i === 0) continue;
        const rider = makeJobV2({ repo: job.repo, pr: m.pr, headSha: m.headSha, baseSha: job.baseSha, testSha: job.testSha, role: 'control-admission',
          sourceManifestSha256: job.sourceManifestSha256, createdAt: job.createdAt, attempt: job.attempt });
        let queue = null;
        try {
          assertLive();
          const packet = await github.readChangedPaths(rider);
          const facts = await admission.evaluatePr(rider, packet, { batchClaim: null, scheduling: f => { queue = f?.mergeQueue ?? null; } });
          factsValid(rider, packet, facts, domain, clock(), null, { requireQueueHead: false });
          check(['normal', 'efficiency'].includes(facts.mode?.state) && facts.observedClaim?.claimId === m.claimId && facts.publicationRequired !== true
            && queue?.entered === true && fresh(facts, clock()), TRAIN_BATCH_CHANGED);
        } catch { return blocked(TRAIN_BATCH_CHANGED); }
      }
      // Push lands S: its required checks must pass on S itself, even when H has the same tree.
      const outside = externalChecksDecision({ rules: reply.rules, inventory: await github.readChecks(job.testSha),
        commitSha: job.testSha, appId: APP_ID, now: clock() });
      if (outside) return blocked(outside);
      mainNow = (await github.readBranchHead('main'))?.sha;
      if (mainNow !== job.baseSha && mainNow !== job.testSha) return blocked('RESIDENT_BASE_MOVED');
    } catch (e) { return blocked(safe(e)); }
    let phase = 'intent';
    try {
      const intent = await journal.begin(key, { action: 'train-land-main/1', subject: subjectOfV2(job), claim: batchClaim, members, baseSha: job.baseSha, testSha: job.testSha,
        nativeObservationSha256: before.facts.observationSha256 });
      if (intent.existing) return { status: 'RECONCILIATION_REQUIRED', effectKey: key, sideEffects: 0, productionAuthorized: false, ...lease };
      await journal.transition(key, 'intent', 'authorized'); phase = 'authorized';
      assertLive(); check(fresh(before.facts, clock()), 'NATIVE_OBSERVATION_EXPIRED_BEFORE_WRITE');
      await journal.transition(key, 'authorized', 'sent'); phase = 'sent';
    } catch (e) {
      if (phase !== 'sent') await transition(key, phase, 'not_sent', { reason: safe(e) });
      return blocked(safe(e));
    }
    const r = mainNow === job.testSha ? { state: 'landed', mainSha: mainNow, sent: false }
      : await landMain({ port: landing, readMain: async () => (await github.readBranchHead('main'))?.sha, baseSha: job.baseSha, testSha: job.testSha, clock, sleep });
    const landed = { mainSha: job.testSha, baseSha: job.baseSha, members: members.map(m => ({ pr: m.pr, headSha: m.headSha })) };
    try { record('native_train_landing', { jobId: job.id, effectKey: key, state: r.state, mainSha: r.mainSha ?? null, members: landed.members }); } catch { /* best-effort */ }
    if (r.state === 'landed') {
      await transition(key, 'sent', 'settled', { landed });
      return { status: 'SETTLED', effectKey: key, sideEffects: r.sent ? 1 : 0, productionAuthorized: production, landed, qualificationIssued: false, nativeTicketIssued: false };
    }
    if (r.state === 'moved' || r.state === 'refused') {
      await transition(key, 'sent', 'revoked', { reason: r.state === 'moved' ? 'RESIDENT_BASE_MOVED' : TRAIN_LANDING_REFUSED, mainSha: r.mainSha, notApplied: true });
      return blocked(r.state === 'moved' ? 'RESIDENT_BASE_MOVED' : TRAIN_LANDING_REFUSED);
    }
    await transition(key, 'sent', 'uncertain', { reason: TRAIN_LANDING_UNCONFIRMED, mainSha: r.mainSha ?? null });
    return { status: 'UNCERTAIN', effectKey: key, reason: TRAIN_LANDING_UNCONFIRMED, sideEffects: 1, productionAuthorized: false, ...lease };
  }
  // The v2 consumer (merge gate): a settled journal entry of exactly this job and batch claim generation,
  // a fresh complete admission before and after the GitHub read-back, the same durable producer identity.
  // A settled check whose authority changed is compensated once (revoked), never re-posted.
  async function consume(input, selector) {
    const job = fixedJob(input);
    check(exact(selector, ['repository', 'pr', 'headSha', 'baseSha', 'name']) && selector.repository === job.repo && selector.pr === job.pr && selector.headSha === job.headSha
      && selector.baseSha === job.baseSha && selector.name === definitionFor(job).name, 'CONTROL_CONSUMER_SUBJECT_REQUIRED');
    const key = admissionEffectKeyV2(ACTION, job, batchClaim, definitionFor(job)), externalId = admissionExternalIdV2(prefixFor(job), job, batchClaim);
    const stored = await journal.read(key);
    let journalIdentity = false;
    try {
      check(stored?.state === 'settled' && digest(stored.subject?.subject) === digest(subjectOfV2(job)) && digest(stored.subject.claim) === digest(claimGeneration(batchClaim))
        && digest(stored.subject.definition) === digest(definitionFor(job)) && stored.subject.externalId === externalId && Number.isSafeInteger(stored.details?.checkRunId), 'TRUSTED_SETTLED_CONTROL_JOURNAL_REQUIRED');
      journalIdentity = true;
      const before = await boundary(job);
      check(stored.details.sourceBindingSha256 === before.sourceBindingSha256, 'CONTROL_JOURNAL_AUTHORITY_CHANGED');
      const observed = await readback(job, externalId, stored.details.checkRunId, 'success');
      const after = await boundary(job);
      check(after.bindingSha256 === before.bindingSha256, 'CONTROL_CONSUMER_AUTHORITY_CHANGED'); assertLive(); check(fresh(after.facts, clock()), 'CONTROL_CONSUMPTION_EXPIRED');
      const proof = freeze({ contract: 'clued.independent-ci.control-consumption/2', domain, producer: 'independent-control-checks-v2', subject: subjectOfV2(job), claim: claimGeneration(batchClaim),
        definition: definitionFor(job), check: structuredClone(observed), effectKey: key, journalRevision: stored.revision, bindingSha256: after.bindingSha256, sourceBindingSha256: after.sourceBindingSha256,
        nativeObservationBeforeSha256: before.facts.observationSha256, nativeObservationAfterSha256: after.facts.observationSha256, observedAt: after.facts.observedAt, claimExpiresAt: after.facts.claimExpiresAt,
        mergeSlot: structuredClone(after.facts.mergeSlot), mergeQueueHead: after.facts.mergeQueueHead, productionAuthorized: production, qualificationIssued: false, nativeTicketIssued: false });
      if (production) actualConsumptions.set(proof, { selector: structuredClone(selector), expiresAt: Math.min(Date.parse(proof.observedAt) + 30000, Date.parse(proof.claimExpiresAt),
        job.role === 'control-merge-slot' ? Date.parse(proof.mergeSlot.until) : Infinity, authority?.acceptanceValidUntil ? Date.parse(authority.acceptanceValidUntil) : Infinity) });
      return proof;
    } catch (error) {
      if (journalIdentity && Number.isSafeInteger(stored.details?.checkRunId) && stored.details.checkRunId > 0) return revoke({ job, key, externalId, known: { id: stored.details.checkRunId }, phase: 'settled', cause: safe(error), sideEffects: 0 });
      throw error;
    }
  }
  return Object.freeze({ fixture: !production, waitForQueueHead, publishOne, consume, async publishPair(jobs, { waitUntil }) {
    try {
      check(Array.isArray(jobs) && jobs.length === 2 && jobs.map(j => j.role).join('|') === CONTROL_ROLES_V2.join('|') && sameBatchV2(jobs[0], jobs[1]), 'TWO_FIXED_CONTROL_JOBS_REQUIRED');
      jobs.forEach(fixedJob);
      check(Number.isSafeInteger(waitUntil) && waitUntil > clock(), 'QUEUE_WINDOW_REQUIRED');
    } catch (e) { return { status: 'BLOCKED', reason: safe(e), sideEffects: 0, productionAuthorized: false }; }
    // §41.2 (§38.8 m3): S != H only with the train on; nothing read, nothing written.
    if (trainFrontRefused(jobs[1], trainMode)) return frontRefused();
    // ADR 0018: a front job whose stage file train-landing.json exists but cannot be used parks (the landing mode is unknown, not github-merge).
    if (landingUnreadable && isTrainFrontJobV2(jobs[1])) return { status: 'BLOCKED', reason: TRAIN_MODE_UNREADABLE, sideEffects: 0, productionAuthorized: false };
    const head = await waitForQueueHead(jobs[1], waitUntil);
    record('native_queue_wait', { jobId: jobs[1].id, ready: head.ready, polls: head.polls });
    if (!head.ready) return { status: 'BLOCKED', reason: head.reason, sideEffects: 0, productionAuthorized: false, polls: head.polls, scheduling: head.scheduling };
    // After a ready head, every answer that is not SETTLED carries the lease end (also the one the extension answered), so the resident
    // does not keep the end from before the extension; not the queue place: a transient park after it is counted as before (DESIGN §28).
    // The green ledger's answer below is the exception: not a §28 code, it keeps the whole facts.
    const lease = head.scheduling ? { scheduling: { ciRetryAfter: null, mergeQueue: null, claimExpiresAt: head.scheduling.claimExpiresAt ?? null } } : {};
    // ADR 0018 §2 item 6: push writes no check at all (no merge-slot green, no admission-verified): the landing is the one effect.
    // Item 7 (three ways): which way is read from main's rules now. The current path only for exactly the state before the Owner's steps.
    let route = null;
    if (push && isTrainFrontJobV2(jobs[1])) {
      route = await readLandingRoute({ github, appId: APP_ID });
      try { record('native_train_landing_route', { jobId: jobs[1].id, route: route.route, missing: route.missing }); } catch { /* a log only */ }
      if (route.route === 'push') return landOne(jobs[1], head.train, lease);
      if (route.route !== 'github-merge') return { status: 'BLOCKED', reason: TRAIN_LANDING_RULES_MISSING, missing: route.missing, sideEffects: 0, productionAuthorized: false, ...lease };
      // a merge-slot green on H would name a tree H was not tested as
      if ((head.train?.batch?.members?.length ?? 1) > 1) return { status: 'BLOCKED', reason: TRAIN_BATCH_WITHOUT_PUSH, sideEffects: 0, productionAuthorized: false, ...lease };
    }
    // C4: both halves are read back before either is published (nothing written yet: a refusal is a clean BLOCKED). A half
    // with an unsettled journal entry (a write that may have happened) skips this and keeps its path (reconciliation).
    let unsettled;
    try { unsettled = (await Promise.all(jobs.map(job => journal.read(admissionEffectKeyV2(ACTION, job, batchClaim, definitionFor(job)))))).some(e => e && e.state !== 'settled'); }
    catch (e) { return { status: 'BLOCKED', reason: safe(e), sideEffects: 0, productionAuthorized: false, ...lease }; }
    if (!unsettled) for (const job of jobs) {
      let on;
      try { on = await onGithubOnly(job); } catch (e) { return { status: 'BLOCKED', reason: safe(e), sideEffects: 0, productionAuthorized: false, ...lease }; }
      if (on) return { status: 'BLOCKED', reason: ROLE_ALREADY_ON_GITHUB, role: job.role, sideEffects: 0, productionAuthorized: false, ...lease };
    }
    // Step 3a (§5.4 item 4): the merge-slot green is in the ledger before anything of the pair is written. Production
    // without a ledger (it could not be opened: review M2) writes nothing and parks.
    if (greenLedger || production) {
      const slot = fixedJob(jobs[1]);
      try { check(greenLedger, GREEN_LEDGER_UNAVAILABLE); await ledger('intent', slot, head.train, admissionEffectKeyV2(ACTION, slot, batchClaim, definitionFor(slot)), admissionExternalIdV2(prefixFor(slot), slot, batchClaim), null, null, { required: true }); }
      // Not a transient park (§28) but a not-ready answer the resident schedules by the queue place: the whole facts, which already carry
      // the lease end the extension answered (extendOnce ran before ready), so a queue head keeps its 60-second retries (review round 28).
      catch { return { status: 'BLOCKED', reason: GREEN_LEDGER_UNAVAILABLE, sideEffects: 0, productionAuthorized: false, polls: head.polls, scheduling: head.scheduling }; }
    }
    const results = []; let sideEffects = 0;
    for (const job of jobs) {
      const r = await publishOne(job, { train: head.train }); sideEffects += r.sideEffects ?? 0; results.push({ role: job.role, ...r });
      if (r.status === 'SETTLED') continue;
      // §28.6: every half before r is SETTLED (journaled and read back; publishOne reads a settled entry back again and never writes it twice). A half
      // refused before its write (BLOCKED, zero effects) so leaves nothing unknown: a clean BLOCKED with zero unsettled effects, never
      // UNCERTAIN. A slot that lapsed before the write is the queue head not reached: stage 8's own not-ready answer, tried again.
      if (r.status === 'BLOCKED' && r.sideEffects === 0) return { status: 'BLOCKED', reason: r.reason === 'LIVE_ACTUAL_MERGE_SLOT_REQUIRED' ? 'RESIDENT_QUEUE_HEAD_NOT_REACHED' : r.reason,
        results, sideEffects: 0, productionAuthorized: false, ...lease };
      return { status: r.status === 'BLOCKED' ? 'UNCERTAIN' : r.status, reason: r.reason ?? 'CONTROL_PAIR_INCOMPLETE', results, sideEffects, productionAuthorized: false, ...lease };
    }
    const touched = trainOn && head.train?.proof ? { trainTouch: await touchGreen(jobs[1], head.train.proof) } : {};
    const rehearsal = route ? { rehearsal: rehearse(jobs[1], route) } : {};
    return { status: 'SETTLED', results, sideEffects, productionAuthorized: production, qualificationIssued: false, nativeTicketIssued: false, ...touched, ...rehearsal };
  } });
}
export function createFixtureControlPublisherV2(dependencies) { return engine(dependencies, false); }
// A production consumption proof is usable only for exactly its selector and only within its expiry.
export function takeActualControlConsumptionV2(value, selector) {
  const actual = actualConsumptions.get(value);
  check(actual && digest(actual.selector) === digest(selector) && Date.now() < actual.expiresAt && value.productionAuthorized === true && value.domain === 'production', 'ACTUAL_CURRENT_CONTROL_CONSUMPTION_REQUIRED');
  return value;
}
export function createProductionControlPublisherV2(dependencies) { return engine(dependencies, true); }
// Window of the S8 wait: merge slot 45 min, the batch claim's lease, the install's validUntil and the
// stage cap minus the time two publications need.
// Phase 2, step 2: checkMs (STAGE8_CHECK_MS) bounds one run; the resident parks and runs stage 8 again.
export function queueWindow({ startedAt, claimExpiresAt, validUntil, stageDeadline, publicationReserveMs = PAIR_PUBLICATION_RESERVE_MS, checkMs = Infinity }) {
  return Math.min(startedAt + MERGE_SLOT_WINDOW_MS, startedAt + checkMs, Date.parse(claimExpiresAt), validUntil === null ? Infinity : Date.parse(validUntil), stageDeadline - publicationReserveMs);
}
