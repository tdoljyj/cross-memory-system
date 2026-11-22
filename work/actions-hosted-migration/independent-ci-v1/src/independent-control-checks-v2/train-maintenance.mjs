// Stage 10 entry of Source v2, "train maintenance" (resident quota redesign phase 2, step 3c-1; design v0.5 §5.5;
// DESIGN §21, §41; Owner decisions 2eea28a1, 263f9701). Run by the generic helper as clued-control, outside any batch:
//   node train-maintenance.mjs --run --stage <nonce> --config-sha256 <sha>
// It reads KooYomi's merge-slot holder (which doubles as the on-duty probe), main, main's rules, the front PR and its
// test merge, and the green ledger; computes what the train WOULD do (train-facts.mjs); writes one record per run
// (train-shadow-store.mjs) and returns the facts to the resident. The train-run job's mode decides what else it does:
//   shadow       reads only (sideEffects 0). It also computes the incremental and the segmented full sweep
//                (train-sweep.mjs) and records what they would revoke, with calls and time; it writes nothing to GitHub
//                or KooYomi, only its own cursor (state\v2\train-sweep, full-shadow records: never counted for on).
//   on           (ACTIVE only; DESIGN §41.2-41.6) Source check over ci_nodes_status; the take-over sweep (always a full
//                sweep since onSince: no watermark short cut, review R2 B1); the incremental sweep and a full-sweep
//                segment, with revocations confirmed twice; the sweep proof; keepalive once; adopt, return or touch
//                failed; the protected-layer check (H contains T); and for OPEN_FRONT_BATCH the hard-cap budget, touch
//                running and its read-back, then the front batch (the executor's one source of S), unless this node's
//                batch of the same S is still running. Last, inside the round's budget, the PR lifecycle reconcile
//                (reconcileLifecycle). The watermark (informational) after a confirmed full sweep. Generation 28
//                (resident ADR 0017): a bound front that waits for its front batch, or whose front batch runs or is parked, gets
//                one touch running when its merge slot has less than 20 minutes left (renewFrontSlot; one slot write a round).
//   revoke-only  (under PAUSE; §41.3) the three kinds of revocation, the incremental sweep and the proof; no batch, no
//                touch, adopt, return or keepalive.
// The job's sweep (train-run /3; Owner decision 9e2511fe; resident DESIGN §65) says what the full sweep is for in mode on:
//   gate         as before: the take-over full sweep gates every batch (TRAIN_TAKEOVER_SWEEP_PENDING until it completes since
//                onSince), and a completed one lets a proof cover a green whatever strict says (fullSweepSinceOn).
//   audit, off   strict-permanent mode: strict is on for good, so GitHub merges a head H only when it contains main's tip T and
//                merge(T, H) has H's tree: what was tested is what lands. No full sweep gates anything and no proof ever says
//                fullSweepSinceOn (stage 8 can then only green through the live-strict current-front route); the front batch opens
//                on the strict current-front observation alone; strict read off is TRAIN_STRICT_OFF with a PAUSE request. audit runs
//                one full round as a background audit at most once AUDIT_EVERY_MS (no expiry, segments only where §62.8 lets a round
//                count one); off starts none of its own. A rewritten main still holds new batches until a round of scope all
//                completes (§60.2): both start that round at once.
// Push mode (resident ADR 0018; the stage file train-landing.json, train-landing.mjs): with train.landing 'push' and the landing
// port, mode on also (a) adopts every member of each batch of this node whose S main now contains (riders first, the front last;
// a member whose PR moved to another head is not adopted), (b) turns the executor's frontOutcome of a batch of several members into
// bisection instead of touch failed, and (c) opens the front batch on the batch it composes: the front, then riders (open PRs into
// main with this install's Native Task binding and App 5368905's kooyumi-work-admission success on their head, by PR number, up to the
// effective batch size), S = GitHub's test merge for one member or the cumulative merge on clued-train/staging.tmp for several,
// clued-train/staging pointed at S (the CI trigger) and a landing-batch record. A strict head that does not contain main's tip is no
// longer FRONT_NEEDS_MAIN_MERGE there (the train lands merge(T, H) itself); a protected-layer one still is.
// Three ways (ADR 0018 §2 L2 item 7, Fable 2026-11-20): 'push' installed means "can push". Each run reads main's rules and each ruleset's
// bypass (train-landing.mjs#landingRoute); only route push takes (c)'s push behaviour (a head behind main, several members). Otherwise
// the front batch opens as the current path needs it (the head contains main, one PR a batch), and is still composed here: S on
// clued-train/staging, so the four Actions checks run on S (the rehearsal stage 8 records). (a) and (b) stay with push installed. The
// route and what push still misses are in the facts (landing.route, landing.missing).
// A read that fails before anything was written ends the run BLOCKED with zero side effects; after the first write every
// failure becomes a decision (TRAIN_REVOKE_UNCONFIRMED, TRAIN_SWEEP_INCOMPLETE, ...) or, if it still throws, UNCERTAIN with
// the true count (settleTrain).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEntry, controllerPrincipal, controllerPorts, observationLog } from '../resident-v2/entry-runtime.mjs';
import { STAGE_MARGIN_MS, STATE_V2, TRAIN_STAGE_V2 } from '../resident-v2/layout.mjs';
import { stateRetention } from '../resident-v2/state-retention.mjs';
import { validateTrainRun } from '../resident-v2/train-run.mjs';
import { GreenLedger } from './green-ledger.mjs';
import { closeGreenLedgerGroups } from './green-ledger-closed.mjs';
import { APP_ID } from './publisher.mjs';
import { createMergeSlotNative } from './merge-slot-native.mjs';
import { RULESET_UNREADABLE, REQUIRED_CHECKS_UNREADABLE, appScansPinned, rulesetFacts, requiredCheckFailure } from './train-rules.mjs';
import { decideShadow, frontPullFacts, requiredFailureExcused, requiredYieldReason, trainFacts, validateTrainFacts, NO_ACTIONS } from './train-facts.mjs';
import { TrainShadowStore } from './train-shadow-store.mjs';
import { TrainSweepStore } from './train-sweep-store.mjs';
import { runStrictLane, strictIdentity, strictSettingsDigest, strictReadiness, strictFrontReadiness, strictFrontSourceHealthy, sweepProgress, recordFollows } from './train-strict.mjs';
import { ScanProgress } from './train-scan-progress.mjs';
import { layerOf, loadPolicy } from '../../../../../scripts/ci/merge-admission-policy.mjs';
import { resolvePRTaskBinding } from '../../../../../scripts/ci/clued-pr-task-binding.mjs';
import { STAGING_REF, STAGING_TMP_REF, effectiveBatchMax, pickMembers, bisectAfter, readBatchChain, readStageTrainLandingFact, readLandingRoute } from './train-landing.mjs';
import { createLandingPort } from './train-landing-port.mjs';
import { FIXED_APP } from '../resident-v2/record.mjs';
import { MAX_REVOKES_PER_RUN, SLOT_CHECK, SWEEP_BUDGET_MS, countedGithub, createSweeper, fullSweepSegment, incrementalSweep, ledgerGreens,
  publicationHeads, revokeGreens } from './train-sweep.mjs';

export const TRAIN_FACTS_STATUS = 'TRAIN_FACTS';
// §41.4 hard cap: the running clock runs 90 minutes; a front batch needs its budget, one stage-8 attempt (90 s) and the
// helper margin before the slot would lapse. At most two front batches per head, counted from this node's own records
// (review R2 minor 1, residual): no shared channel lists another node's front batches (the stream lists open publications
// only, GitHub shows a batch only once it published), so after a take-over a head may get up to two more.
export const RUNNING_CLOCK_MS = 90 * 60_000;
export const STAGE8_ATTEMPT_MS = 90_000;
export const MAX_FRONT_BATCHES_PER_HEAD = 2;
// Generation 28 (resident ADR 0017): a bound front's merge slot with less than this left is renewed (renewFrontSlot).
export const SLOT_RENEW_BELOW_MS = 20 * 60_000;
// Generation 23 (DESIGN §62.8): an open or a batch's first refresh skips the take-over full-sweep segment only when at most this many
// rounds came after the newest round that counted one, so at most MAX_SKIPS_BEFORE_SKIP + 1 rounds in a row skip it.
export const MAX_SKIPS_BEFORE_SKIP = 2;
// Nodes whose heartbeat is older than this are not compared (§41.6).
export const SOURCE_HEARTBEAT_WINDOW_MS = 24 * 3_600_000;
export const KEEPALIVE_MAX_PRS = 50;
// Ledger cleanup only while this much of the 5-minute stage is still ahead.
const CLEANUP_BEFORE_MS = 240_000;
// No revocation is started after this, and no second read-back or cleanup step after the next (review R2 minor 5).
export const REVOKE_WRITE_BEFORE_MS = 200_000;
export const STAGE_WORK_BEFORE_MS = 250_000;
const SHA = /^[0-9a-f]{40}$/;
const EPOCH = '1970-01-01T00:00:00.000Z';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const isoOf = ms => new Date(ms).toISOString();
const normal = v => (Number.isFinite(Date.parse(v ?? '')) ? isoOf(Date.parse(v)) : null);
const TESTED = /\bmain@([0-9a-f]{40}), tested ([0-9a-f]{40}) \(tree ([0-9a-f]{40})\)/;
// Strict-permanent audit: a new full round at most this long after the last one completed (or the abandoned one started).
export const AUDIT_EVERY_MS = 24 * 3_600_000;
// Abandoned rounds that restart at once in audit and off mode (and the scope reasons whose rounds count segments in off): until a round of scope all completes they hold new batches (§60.2) or keep a
// legacy unconfirmed count.
const AUDIT_RESTART_NOW = Object.freeze(['TRAIN_MAIN_REWRITTEN', 'TRAIN_LEGACY_REVOKE_PENDING']);
const freshFull = () => ({ state: 'none', via: null, startedAt: null, completedAt: null, onSince: null, mainSha: null, nextPage: 1, nextIndex: 0, prs: 0, commits: 0,
  heads: 0, revoked: 0, unconfirmed: 0, wouldRevoke: 0, calls: 0, ms: 0, reason: null, scope: 'all', scopeReason: null });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// While the take-over sweep runs, discover the unique open PR whose Native Task projection
// names the queue's current claim. Only mode on may auto-bind a uniquely authorized head.
// At most this many of the most recently updated open PRs into main are read per run.
export const FRONT_BIND_MAX_READS = 10;

// Shadow wrapper kept for the 3c-1 callers: the facts only.
export async function readTrainFacts(ports) { return (await runTrain(ports)).facts; }

// Pure over its ports (tested with fakes). ledger, sweepStore, publications may be null (could not be opened): the
// sweep is then incomplete (on, revoke-only) or not computed (shadow). layerOfPaths: the PR's changed paths -> its
// merge-admission layer (main: merge-admission-policy.mjs over the held policy; default and any failure: 'protected').
// -> { facts, sideEffects }. A throw after a write carries the count (e.sideEffects; settleTrain, review R2 M5).
export async function runTrain(ports) {
  const fx = { n: 0 };
  const startedAt = (ports.clock ?? Date.now)();
  try {
    const result = await runTrainCounted({ ...ports, startedAt }, fx);
    const claimBindings = ports.observeBindings === true ? await observePRClaimBindings(ports, startedAt) : null;
    return claimBindings === null ? result : { ...result, facts: validateTrainFacts({ ...result.facts, claimBindings }) };
  }
  catch (e) { if (fx.n > 0) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sideEffects: fx.n }); throw e; }
}

// This bounded observation is data for rechecking waiting rows, never admission.
// It also works off duty, since read_only forbids the CI lookup from auto-binding.
async function observePRClaimBindings({ github, native, job, claimScope, clock = Date.now }, startedAt) {
  if (typeof claimScope !== 'string' || typeof native?.resolvePRBinding !== 'function') return [];
  const out = [], until = Math.min(startedAt + STAGE_WORK_BEFORE_MS, clock() + 30_000);
  if (clock() >= until) return out;
  let rows;
  try { rows = (await github.readPullsPage({ state: 'open', sort: 'updated', direction: 'desc', page: 1, perPage: 50, until })).pulls; }
  catch { return out; }
  if (!Array.isArray(rows)) return out;
  for (const row of rows.slice(0, 50)) {
    if (clock() >= until) break;
    try {
      const pull = await github.readPullRequest(row.number, { until });
      if (clock() >= until) break;
      if (pull?.number !== row.number || !eligibleBindingPull(pull, job.repo)) continue;
      const binding = await native.resolvePRBinding({ scope: claimScope, repository: job.repo, prNumber: pull.number,
        headSha: pull.head.sha, baseSha: pull.base.sha, targetBranch: pull.base.ref, readOnly: true },
      { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, until - clock()))) });
      if (binding.auto_bound || clock() >= until) continue;
      out.push({ repository: job.repo, scope: claimScope, pr: pull.number, headSha: pull.head.sha, baseSha: pull.base.sha,
        targetBranch: pull.base.ref, bindingStatus: binding.binding_status, taskId: binding.task_id,
        claimId: binding.claim?.claim_id ?? null, fence: binding.claim?.fence ?? null, epoch: binding.claim?.execution_epoch ?? null,
        headAuthorizationId: binding.head_authorization_id, observedAt: isoOf(clock()), sourceManifestSha256: job.sourceManifestSha256 });
    } catch { /* no confirmed exact observation: preserve the existing back-off */ }
  }
  return out;
}

async function runTrainCounted({ job, github: plainGithub, native, ledger, sweepStore = null, publications = null, appId = APP_ID, clock = Date.now, sleep = wait,
  layerOfPaths = () => 'protected', claimScope = null, landing = null, trainLanding = null, startedAt = clock() }, fx) {
  validateTrainRun(job);
  const started = startedAt, at = isoOf(started), acting = job.mode !== 'shadow';
  // Resident DESIGN §65: only 'gate' makes the full sweep a condition of anything.
  const gating = job.sweep === 'gate', permanent = !gating;
  // ADR 0018: push lands main itself (strict-permanent mode only; the landing port present; a stage file that could not be read is no push).
  const push = job.mode === 'on' && permanent && trainLanding?.landing === 'push' && trainLanding.unreadable !== true && typeof landing?.fastForwardMain === 'function';
  const { github, counter } = countedGithub(plainGithub);
  const actions = { ...NO_ACTIONS, revokeHead: job.revokeHeadRequestId ? { requestId: job.revokeHeadRequestId, done: false } : null };
  const until = { write: started + REVOKE_WRITE_BEFORE_MS, read: started + STAGE_WORK_BEFORE_MS };
  let budgetReadFailed = false;
  let duty = await native.holders();
  let frontSourceHealthy = false;
  let nodes = null, nodesDropped = 0;
  const facts = o => ({ facts: trainFacts({ mode: job.mode, at, nodes, nodesDropped, actions, ...o }), sideEffects: fx.n });

  if (!duty.onDuty) {
    if (!acting) return facts({ onDuty: false, holders: [], mainSha: null, rules: null, front: null, revoke: [], ledger: null });
    // §41.6: this node's own greens need no role (a revocation only makes things stricter); nobody else's are touched.
    const own = await revokeOwnOnly({ github, ledger, appId, clock, sleep, started, until, fx, sweepStore, job });
    return facts({ onDuty: false, holders: [], mainSha: own.mainSha, rules: null, front: null, revoke: own.targets, ledger: own.summary, decision: 'NOT_ON_DUTY',
      sweep: sweepFacts({ kind: 'incremental', complete: false, revoked: own.revoked, unconfirmed: own.unconfirmed, would: own.targets.length, counter, started, clock }) });
  }
  // The off-duty path keeps its existing zero-GitHub fast exit. Quota is an observation, never publication authority.
  try { await github.readRateBudget?.({ until: until.read }); } catch { budgetReadFailed = true; }
  // §41.6 Source check (on only), from ci_nodes_status (step 2b; never from holders: review R1 MAJOR-1). Every node heard
  // within 24 hours runs this Source, or on mode does not run. No record (a server before 2b, a node never heard, a
  // connection with no node) is not compared. An answer that cannot be read defers (TRAIN_SOURCE_UNREADABLE, nothing
  // written): with 2b deployed a failed read is not "no record", and the check is the only guard against a mixed fleet.
  if (job.mode === 'on') {
    let status = null;
    try { status = await native.nodesStatus(); } catch { status = null; }
    frontSourceHealthy = strictFrontSourceHealthy(status, job.sourceManifestSha256, clock());
    const stop = decision => facts({ onDuty: true, holders: duty.holders, mainSha: null, rules: null, front: null, revoke: [], ledger: null, decision });
    if (!status || ![true, false, null].includes(status.onDuty)) return stop('TRAIN_SOURCE_UNREADABLE');
    if (status.onDuty === false) return stop('NOT_ON_DUTY');
    if (status.deployed !== false) {
      if (!Array.isArray(status.nodes)) return stop('TRAIN_SOURCE_UNREADABLE');
      nodes = status.nodes.map(e => ({ node: e.node?.name ?? e.agentName ?? null, sourceManifestSha256: e.node?.sourceManifestSha256 ?? null, state: e.node?.state ?? null,
        lastHeartbeatAt: e.node?.lastHeartbeatAt ?? null }));
      nodesDropped = Number.isSafeInteger(status.dropped) ? status.dropped : 0;
      if (nodes.some(n => n.sourceManifestSha256 !== null && n.sourceManifestSha256 !== job.sourceManifestSha256 && n.lastHeartbeatAt !== null
        && started - Date.parse(n.lastHeartbeatAt) <= SOURCE_HEARTBEAT_WINDOW_MS)) return stop('TRAIN_SOURCE_MISMATCH');
    }
  }

  const mainSha = (await github.readBranchHead('main')).sha;
  // appScans (task 04f9b91b, admission p90): the scans the rules pin to this App, read even when the rules are not the six (the scaffold
  // ruleset alone: []). Not read (a failed read, a reply not given whole, rules not understood): null, every scan runs.
  let rules = null, rulesReason = null, appScans = null;
  const landability = { rules: null, appId, onFallback: reason => { rulesReason ??= reason; } };
  try {
    const reply = await github.readBranchRules('main');
    if (reply?.complete !== true) fail(RULESET_UNREADABLE);
    appScans = appScansPinned(reply.rules, appId);
    rules = rulesetFacts(reply.rules, appId);
    landability.rules = reply.rules;
  } catch { rulesReason = RULESET_UNREADABLE; }
  // ADR 0018 §2 L2 item 7: push behaviour only while main's rules read back as push (the same function as stage 8). Fable 11-21 open
  // points §5: every round reads this App's bypass state of each ruleset too (one GET /rulesets/{id} each), and the facts carry it
  // (landing.bypass -> state\status.json), so the landing precheck's P3 reads it there without elevation.
  const route = !push ? null : rulesReason ? { route: 'park', missing: ['rules_unreadable'], bypass: { main: 'not_read', independent: 'not_read' } }
    : await readLandingRoute({ github, appId, rules: landability.rules });
  const pushRoute = route?.route === 'push';
  let holder = duty.holders.length === 1 ? duty.holders[0] : null;
  if (holder?.boundPrs?.length > 1) {
    const selected = await selectProjectedHolder({ github, native, fx, job, holder, claimScope, until: until.read, clock, landability });
    holder = selected ?? { ...holder, pr: null, boundPr: null };
    duty = { ...duty, holders: [holder] };
  }
  let front = null, pull = null, mergeCommit = null, frontChecks = [], frontCompare = null;
  if (holder?.pr) {
    pull = await github.readPullRequest(holder.pr);
    const headSha = SHA.test(pull?.head?.sha ?? '') ? pull.head.sha : null;
    const compare = headSha ? await github.readCompare(mainSha, headSha) : null;
    frontCompare = compare;
    mergeCommit = SHA.test(pull?.merge_commit_sha ?? '') ? await github.readGitCommit(pull.merge_commit_sha) : null;
    // Review 2 medium 1: an unreadable check inventory (a failed read, or one GitHub did not give whole) no longer ends the round here:
    // the front is not green, opens nothing, and its wait is bounded by its front time (train-facts.mjs#requiredYieldReason).
    let listed = null;
    try { listed = headSha ? await github.readChecks(headSha) : { complete: true, checks: [] }; } catch { listed = null; }
    const checksReadable = listed?.complete === true && Array.isArray(listed.checks);
    frontChecks = checksReadable ? listed.checks : [];
    // Fable 11-20 (#1192): green is every check main's live rules require on the head (this run's rules read; null when unreadable).
    // Fable 11-21 应修 1: and only on the current path (no push in the package, or route github-merge; ADR 0018 §2 L2 item 7), which GitHub
    // merges. On route push or park a merge-slot green on H is a leftover of the current path: not green, so the front batch opens.
    front = frontPullFacts({ pull, mergeCommit, compare, checks: frontChecks, mainSha, appId, rules: landability.rules, route: route?.route ?? 'github-merge' });
    if (!checksReadable) front = { ...front, green: false, checksUnreadable: true, ...(front.required !== undefined ? { required: null } : {}) };
    // Review 4 medium 2: when this node first saw the head at the front, recorded once: the 60 minutes' start when no merge-slot time is known.
    if (job.mode === 'on' && headSha && typeof sweepStore?.readFrontSeen === 'function') {
      try {
        let seen = await sweepStore.readFrontSeen({ pr: holder.pr, headSha });
        if (!seen) {
          seen = { seenAt: isoOf(clock()) };
          await sweepStore.writeFrontSeen({ writtenAt: seen.seenAt, runId: job.runId, pr: holder.pr, headSha, seenAt: seen.seenAt });
        }
        front = { ...front, frontSeenAt: Date.parse(seen.seenAt) };
      } catch { /* an unwritable record: no start yet; the next round tries again */ }
    }
    // Review 3 medium 1: the merge slot's green, recorded when seen, stays the start of the 60-minute wait when the checks cannot be read.
    if (job.mode === 'on' && headSha && typeof sweepStore?.readSlotGreen === 'function') {
      try {
        const known = await sweepStore.readSlotGreen({ pr: holder.pr, headSha });
        if (checksReadable && front.green && Number.isFinite(front.slotGreenAt) && known?.slotGreenAt !== isoOf(front.slotGreenAt))
          await sweepStore.writeSlotGreen({ writtenAt: isoOf(clock()), runId: job.runId, pr: holder.pr, headSha, slotGreenAt: isoOf(front.slotGreenAt) });
        if (!checksReadable && known) front = { ...front, slotGreenAt: Date.parse(known.slotGreenAt) };
      } catch { /* an unreadable record proves no start: the 60 minutes wait for a round that reads the checks */ }
    }
    // §41.4 (MergeAdmission v0.2 §2.4), on only: a protected-layer front whose H does not contain T needs main merged in
    // first. The layer is read only when H does not contain T; paths that cannot be read count as protected.
    if (job.mode === 'on' && front.state === 'open' && headSha && front.headContainsMain !== true) {
      front = { ...front, protectedLayer: await protectedPull({ github, job, layerOfPaths, pr: holder.pr, headSha, baseSha: pull.base.sha }) };
    }
  }
  let entries = [], summary = null, ledgerReason = null;
  if (ledger) {
    try {
      const { entries: e, refused } = await ledger.list();
      entries = e; summary = { records: e.length, refused: refused.length };
      // step 3a's promise: a ledger file that is not exactly a record fails the sweep closed
      if (refused.length) ledgerReason = 'GREEN_LEDGER_REFUSED_RECORDS';
    } catch { ledgerReason = 'GREEN_LEDGER_UNAVAILABLE'; }
  } else ledgerReason = 'GREEN_LEDGER_UNAVAILABLE';
  const own = ledgerGreens(entries);
  // The front's current head (one holder, its PR open): kept green unless main moved or a revoke-head request says so.
  const frontHead = holder && front?.state === 'open' && front.headSha ? { headSha: front.headSha } : null;

  // ---- sweeps ----
  const mode = acting ? 'on' : 'shadow';
  let state = null, stateReason = null;
  if (sweepStore) { try { state = await sweepStore.readFullSweep(mode); } catch { stateReason = 'TRAIN_SWEEP_STATE_UNREADABLE'; } } else stateReason = 'TRAIN_SWEEP_STATE_UNREADABLE';
  // A record from before generation 15 reads as: no main tip recorded, nothing pending, a round of scope 'all' (it enumerated everything).
  const stored = state ?? { mode, incrementalCursor: null, full: freshFull(), inMain: [] };
  const before = { mainSha: null, allPending: null, ...stored, full: { scope: 'all', scopeReason: null, ...stored.full } };
  let fastStoreHealthy = false, oldFastProof = null, pendingRevocations = [], pendingReadable = false, pendingRecord = null,
    legacyStrictPending = [], legacyUnconfirmed = 0, legacySince = null, lastProof = null, lastFull = null;
  if (acting && typeof sweepStore?.readPendingRevocations === 'function') {
    try {
      const pending = await sweepStore.readPendingRevocations();
      pendingRecord = pending;
      if (pending && pending.repo !== job.repo) throw Error('pending_repo_mismatch');
      pendingRevocations = pending?.targets ?? []; pendingReadable = true;
      legacyUnconfirmed = pending?.legacyUnconfirmed ?? 0; legacySince = pending?.legacySince ?? null;
    } catch { stateReason ??= 'TRAIN_PENDING_REVOCATIONS_UNREADABLE'; }
  }
  if (acting && typeof sweepStore?.readFullSweepStrict === 'function') {
    try {
      const anchor = lastFull = await sweepStore.readFullSweepStrict(mode);
      const legacy = lastProof = await sweepStore.latestProofStrict(), round = await sweepStore.readStrictRound();
      legacyStrictPending = round?.pending ?? [];
      // IDs from another run do not identify which old effects contributed to
      // this count. An unrelated B cannot discharge an unknown legacy A.
      if (legacy && pendingRecord?.runId !== legacy.runId && legacy.unconfirmed > legacyUnconfirmed) {
        legacyUnconfirmed = legacy.unconfirmed; legacySince ??= isoOf(clock());
        if (!pendingReadable) throw Error('pending_unreadable');
        await sweepStore.writePendingRevocations({ repo: job.repo, writtenAt: isoOf(clock()), runId: job.runId,
          targets: pendingRevocations, legacyUnconfirmed, legacySince });
      }
      await sweepStore.latestStrictProof();
      oldFastProof = await sweepStore.latestStrictFrontProof();
      fastStoreHealthy = recordFollows(legacy, anchor) && pendingReadable && pendingRevocations.length === 0 && legacyUnconfirmed === 0
        && (legacy === null || legacy.unconfirmed === 0) && !(round?.pending?.length)
        && sweepStore.refused === 0;
    } catch {
      // Do not append a fresh empty/partial record over unreadable pending or
      // rewrite state: that would turn the next invocation into a false cold start.
      stateReason ??= 'TRAIN_SWEEP_STATE_UNREADABLE';
    }
  }
  const cursor = before.incrementalCursor;
  let full = { ...before.full };
  // Generation 15 (DESIGN 60, option c1): was main rewritten since this node last saw it (the main tip the last run of this mode
  // recorded)? Then heads of merged pulls may have left main: the cross-run "in main" cache is dropped now, the round in progress
  // and the completed one are void (on mode: a new round and no green until it completes), and every round until one of scope
  // 'all' completes enumerates everything (allPending TRAIN_MAIN_REWRITTEN). No tip
  // recorded (the first run of this mode, or a record from before generation 15): the history is unknown, so the cache is dropped
  // too and rounds enumerate everything until one of scope 'all' completes (allPending TRAIN_NO_MAIN_RECORD). Not readable: this
  // run's sweep is incomplete, no round starts and nothing is recorded, so the next run asks again.
  let history = 'same';
  if (!before.mainSha) history = 'none';
  else if (before.mainSha !== mainSha) {
    try {
      const c = await github.readCompare(before.mainSha, mainSha);
      history = c?.behindBy === 0 && ['ahead', 'identical'].includes(c.status) ? 'forward' : 'rewritten';
    } catch (e) { history = e?.code === 'github_http_404' ? 'rewritten' : 'unknown'; }
  }
  if (history === 'unknown') stateReason ??= 'TRAIN_MAIN_HISTORY_UNREADABLE';
  const allPending = history === 'rewritten' ? 'TRAIN_MAIN_REWRITTEN' : before.allPending ?? (legacyUnconfirmed > 0 ? 'TRAIN_LEGACY_REVOKE_PENDING'
    : history === 'none' ? 'TRAIN_NO_MAIN_RECORD' : null);
  const onSinceMs = job.onSince ? Date.parse(job.onSince) : null;
  // Only a full sweep of this node counts (via 'sweep'). §41.6's watermark take-over is not used (review R2 B1): the stream
  // (revocations_list) lists open publications only, so another node's published greens are invisible to an incremental
  // sweep from a watermark. Until a read-only channel lists them, every take-over is a full on-mode sweep; the watermark
  // is still reported (harmless) and the stream stays an extra source.
  const sinceOn = f => gating && f.state === 'complete' && f.via === 'sweep' && onSinceMs !== null && Date.parse(f.startedAt) >= onSinceMs;
  const start = () => ({ ...freshFull(), state: 'running', via: 'sweep', startedAt: at, onSince: job.onSince, mainSha,
    ...(allPending ? { scope: 'all', scopeReason: allPending } : { scope: 'current' }) });
  const abandon = reason => ({ ...full, state: 'abandoned', reason, completedAt: null });
  if (legacyUnconfirmed > 0 && (full.scope !== 'all' || !full.startedAt || Date.parse(full.startedAt) < Date.parse(legacySince)))
    full = abandon('TRAIN_LEGACY_REVOKE_PENDING');
  // A rewrite voids the round in progress and the one completed (DESIGN 60.2): on mode then starts a round of scope 'all' at once and
  // is TRAIN_TAKEOVER_SWEEP_PENDING (no green) until it completes; revoke-only leaves that to the next on run; shadow restarts too.
  if (history === 'rewritten' && ['running', 'complete'].includes(full.state)) full = abandon('TRAIN_MAIN_REWRITTEN');
  if (history === 'unknown') { /* no round starts or ends on a history that could not be read */ } else if (job.mode === 'on' && permanent) {
    // §65: a running round goes on however long it takes (it gates nothing); audit starts the next one per AUDIT_EVERY_MS. Both audit and
    // off start one at once when it is what holds the train: main rewritten (§60.2) or a legacy unconfirmed count (§62.2).
    const since = Date.parse((full.state === 'complete' ? full.completedAt : full.startedAt) ?? '');
    const needed = allPending === 'TRAIN_MAIN_REWRITTEN' || (full.state === 'abandoned' && AUDIT_RESTART_NOW.includes(full.reason));
    if (full.state !== 'running' && (needed || (job.sweep === 'audit' && (full.state === 'none' || !(started - since < AUDIT_EVERY_MS))))) full = start();
    // Stage 8's current-front route reads the full-sweep record of this duty (strictFrontHeadDecision: full.onSince); a round that
    // gates nothing is re-anchored to the duty it is read in.
    if (full.onSince !== job.onSince) full = { ...full, onSince: job.onSince };
  } else if (job.mode === 'on' && !sinceOn(full)) {
    if (full.state === 'running' && (Date.parse(full.startedAt) < onSinceMs || started - Date.parse(full.startedAt) > job.fullSweepMaxMs))
      full = abandon(Date.parse(full.startedAt) < onSinceMs ? 'TRAIN_FULL_SWEEP_BEFORE_ON' : 'TRAIN_FULL_SWEEP_EXPIRED');
    if (full.state !== 'running' && !(full.state === 'abandoned' && full.reason === 'TRAIN_PULL_OVER_250_COMMITS' && full.onSince === job.onSince
      && typeof github.readPullHistoryPage !== 'function')) full = start();
  } else if (job.mode === 'shadow') {
    if (full.state === 'running' && started - Date.parse(full.startedAt) > job.fullSweepMaxMs) full = abandon('TRAIN_FULL_SWEEP_EXPIRED');
    // one shadow round per fullSweepMaxMs is enough to measure it (§41.9 item 2)
    if (full.state === 'none' || (full.state === 'abandoned' && (full.reason !== 'TRAIN_PULL_OVER_250_COMMITS' || typeof github.readPullHistoryPage === 'function'))
      || (full.state === 'complete' && started - Date.parse(full.completedAt) > job.fullSweepMaxMs)) full = start();
  }
  const sweeper = createSweeper({ github, appId, mainSha, inMain: history === 'same' || history === 'forward' ? before.inMain : [], clock, until: started + SWEEP_BUDGET_MS });
  let scan = null, scanWritten = false;
  if (typeof sweepStore?.readScanProgress === 'function') try {
    scan = await ScanProgress.open({ store: sweepStore, lane: mode, clock, identity: { repo: job.repo, mode, mainSha,
      sourceManifestSha256: job.sourceManifestSha256, settingsDigest: strictSettingsDigest(job), onSince: job.onSince,
      startedAt: full.startedAt, scope: full.scope, front: frontHead, claimId: holder?.claimId ?? null, since: holder?.takenAt ?? null,
      revokeHead: !!job.revokeHeadRequestId } });
  } catch { stateReason ??= 'TRAIN_SCAN_STATE_UNREADABLE'; }
  const frontFastEligible = job.mode === 'on' && !sinceOn(full) && job.revokeHeadRequestId === null && rules?.strict === true && frontSourceHealthy && fastStoreHealthy
    // ADR 0018: push lands the tested merge(T, H) itself, so a head behind main is no reason against the observation there (strict merges
    // only a head that contains T: that is github-merge's reason). A protected-layer head behind main is still FRONT_NEEDS_MAIN_MERGE.
    && (pushRoute || front?.headContainsMain === true) && front?.state === 'open' && front.draft === false && front.mergeable === true
    && front.testMerge?.parentsOk === true && holder?.takenAt && !stateReason && !ledgerReason
    && history !== 'rewritten' && history !== 'unknown' && allPending !== 'TRAIN_MAIN_REWRITTEN';
  const frontIdentity = frontFastEligible ? strictIdentity({ job, holder, headSha: front.headSha, mainSha, scope: full.scope }) : null;
  const priorDutyFast = oldFastProof && oldFastProof.sourceManifestSha256 === job.sourceManifestSha256
    && oldFastProof.onSince === job.onSince && oldFastProof.settingsDigest === frontIdentity?.settingsDigest;
  // The immediate bootstrap is granted once per duty/settings, never renewed by
  // certificate expiry, front changes or a monotonically advancing main.
  // The durable round anchor also consumes that one scheduling exemption:
  // failure to append the independent certificate must not starve full work.
  const dutyAlreadyAnchored = before.mainSha !== null && before.full.onSince === job.onSince;
  const frontFastOnly = frontFastEligible && !priorDutyFast && !dutyAlreadyAnchored;
  // Task e30b5a36 (generation 22 cold start): a round that will open the front batch, or that will only name the binding of an unbound
  // head claim, skips the full-sweep segment, so neither waits for it (about 2.6 minutes each in the field) on the critical path. The
  // segment goes on in the next rounds (the front batch's running rounds and after). Every condition stays as it is: only work this
  // round's outcome does not need is left out.
  //   open: the same live strict-front conditions as above (frontFastEligible: strict, Source, store, history), no pending revocation,
  //     the front would be OPEN_FRONT_BATCH and openFront's checks before its writes pass (no running batch of this head, attempts
  //     left, the budget). Its history is deferred as for the bootstrap above (the strict-front observation needs none). Starvation
  //     bound: not when the last round already judged this very front (claim, head, main) and no batch of it was counted since; a
  //     running batch's rounds never skip, and a head gets at most MAX_FRONT_BATCHES_PER_HEAD batches.
  //   refresh: the same, but this head's front batch is counted and still running (TRAIN_FRONT_BATCH_RUNNING: the round only renews the
  //     strict-front observation, e.g. the resident's refresh before stage 8). Starvation bound: only when this round's full-sweep state
  //     stays as recorded (same main, same round), so it writes none, and either the last round counted a full-sweep segment (below) or
  //     (generation 23, PR #1032, DESIGN §62.8) the last round is the one that opened this very batch and at most two rounds came after
  //     the newest round that counted a segment (the binding and the open of this front). So only a batch's first refresh may follow
  //     skipped rounds; later refresh rounds skip at most every other round as before.
  //   Since generation 23 an open skips too only when at most two rounds came after the newest round that counted a segment: no more
  //     than three rounds in a row skip the segment (bind, open, first refresh), and the round after them counts one.
  //   binding: frontBindEligible's conditions known before the sweeps, and the one PR naming the claim found now. The incremental sweep
  //     still runs (the binding needs a complete, confirmed one: TRAIN_SWEEP_INCOMPLETE otherwise), with the share it has beside a
  //     segment. Starvation bound: only when the last round counted a full-sweep segment (or no round wrote a proof yet); such a round
  //     writes no full-sweep state, so the next round sweeps (at most every other round skips).
  // "The last round counted a segment": the newest proof and the newest full-sweep record are of one run, and that record's calls grew
  // over the record before it in the same round (only a counted segment adds calls; a round start resets them to 0).
  let previousBatches = null, bindRows = null, bindFound = null;
  if (frontFastEligible && !frontFastOnly && pendingRevocations.length === 0 && full.state === 'running') {
    try { previousBatches = await sweepStore.frontBatches({ pr: holder.pr, headSha: front.headSha }); } catch { previousBatches = null; }
  }
  const lastBatchMs = previousBatches?.[0] ? Date.parse(previousBatches[0].writtenAt) : -Infinity;
  const judgedBefore = lastProof?.mode === 'on' && lastProof.pr === holder?.pr && lastProof.headSha === front?.headSha && lastProof.claimId === holder?.claimId
    && lastProof.mainSha === mainSha && Date.parse(lastProof.writtenAt) > lastBatchMs;
  const frontPlan = Array.isArray(previousBatches) && !(job.frontFailed === true && job.frontPr !== null && job.frontPr === holder.pr && front.headSha === job.frontHeadSha)
    && decideShadow({ onDuty: true, holders: duty.holders, holder, front, rules, mainSha }) === 'OPEN_FRONT_BATCH'
    ? frontBatchPlan({ job, holder, front, mainSha, previous: previousBatches, keptAlive: [], clock }).refusal : 'NONE';
  const skippedSince = async () => roundsSinceSegment({ sweepStore, mode, lastFull });
  const frontOpenSkip = frontPlan === null && !judgedBefore && await skippedSince() <= MAX_SKIPS_BEFORE_SKIP;
  const firstRefresh = previousBatches?.[0]?.runId === lastProof?.runId && lastProof?.mode === 'on';
  const frontRefreshSkip = frontPlan === 'TRAIN_FRONT_BATCH_RUNNING' && history === 'same' && allPending === before.allPending
    && JSON.stringify(full) === JSON.stringify(before.full)
    && (await lastRoundSwept({ sweepStore, mode, lastProof, lastFull }) || (firstRefresh && await skippedSince() <= MAX_SKIPS_BEFORE_SKIP));
  const bindCandidate = gating && job.mode === 'on' && !sinceOn(full) && full.state === 'running' && holder !== null && holder.boundPr === null && !!holder.takenAt
    && job.revokeHeadRequestId === null && rules?.strict === true && frontSourceHealthy && fastStoreHealthy && !stateReason && !ledgerReason
    && history !== 'rewritten' && history !== 'unknown' && allPending !== 'TRAIN_MAIN_REWRITTEN' && pendingRevocations.length === 0
    && (lastProof === null || await lastRoundSwept({ sweepStore, mode, lastProof, lastFull }));
  if (bindCandidate) {
    try { bindRows = (await github.readPullsPage({ state: 'open', sort: 'updated', direction: 'desc', page: 1, perPage: KEEPALIVE_MAX_PRS })).pulls; } catch { bindRows = null; }
    if (Array.isArray(bindRows)) bindFound = await findFrontBind({ github, native, fx, job, holder, rows: bindRows, claimScope, until: until.read, clock });
  }
  const frontBindSkip = bindFound !== null;
  const historyDeferred = frontFastOnly || frontOpenSkip || frontRefreshSkip;
  let stream = null;
  if (!historyDeferred) try { stream = publications ? await publications.heads() : null; } catch { stream = null; }
  const strictOwnsPending = pendingRevocations.every(t => legacyStrictPending.some(p => p.checkRunId === t.checkRunId && p.headSha === t.headSha));
  const strictEnabled = gating && legacyUnconfirmed === 0 && strictOwnsPending && !frontFastEligible && job.mode === 'on' && rules?.strict === true && frontHead && holder?.takenAt && !sinceOn(full)
    && history !== 'rewritten' && history !== 'unknown' && allPending !== 'TRAIN_MAIN_REWRITTEN' && !stateReason && !ledgerReason
    && typeof sweepStore?.readStrictRound === 'function' && typeof sweepStore?.writeStrictRound === 'function' && typeof sweepStore?.appendStrictProof === 'function';
  const strict = strictEnabled ? await runStrictLane({ identity: strictIdentity({ job, holder, headSha: frontHead.headSha, mainSha,
    scope: allPending ? 'all' : 'current' }), job, sweepStore, github, native, entries, stream, own, appId, clock, sleep, started, until, ledger,
    revokeHead: !!job.revokeHeadRequestId, fx }) : null;
  if (strict) try { pendingRevocations = (await sweepStore.readPendingRevocations())?.targets ?? []; }
  catch { stateReason ??= 'TRAIN_PENDING_REVOCATIONS_UNREADABLE'; }
  // A running full sweep gets its own share of the time: the incremental part never starves it (review R2 M2).
  // §65: in mode on with sweep off only a round that holds the train (main rewritten, a legacy count) counts segments.
  const wantSegment = !historyDeferred && !frontBindSkip && full.state === 'running' && job.mode !== 'revoke-only' && !stateReason
    && !(job.mode === 'on' && job.sweep === 'off' && !AUDIT_RESTART_NOW.includes(full.scopeReason));
  let incremental = historyDeferred ? { complete: false, reason: 'TRAIN_HISTORY_DEFERRED', targets: [], progress: null, newest: null }
    : await incrementalSweep({ sweeper, github, entries, stream, cursor, front: frontHead, own, revokeHead: !!job.revokeHeadRequestId, clock, scan,
      until: strict ? clock() + Math.max(0, started + SWEEP_BUDGET_MS - clock()) / 2
        : started + (wantSegment || frontBindSkip ? SWEEP_BUDGET_MS / 2 : SWEEP_BUDGET_MS) });
  if (incremental.complete && (stateReason || (acting && ledgerReason))) incremental = { ...incremental, complete: false, reason: stateReason ?? ledgerReason };
  const segment = wantSegment && !sweeper.late() ? await fullSweepSegment({ sweeper, github, nextPage: full.nextPage, nextIndex: full.nextIndex, front: frontHead, own, scope: full.scope, scan }) : null;
  const byId = new Map();
  for (const t of [...incremental.targets, ...(segment?.targets ?? [])]) byId.set(t.checkRunId, t);
  let targets = [...pendingRevocations, ...[...byId.values()].sort((a, b) => a.checkRunId - b.checkRunId)
    .filter(t => !pendingRevocations.some(p => p.checkRunId === t.checkRunId))];

  let revoked = [], unconfirmed = [], leftover = 0, othersRefused = false;
  if (acting && targets.length) {
    // §41.6: greens this node did not ledger (another node's) are revoked only after a fresh holders read with the role
    if (targets.some(t => !t.own)) {
      let again = null;
      try { again = await native.holders(); } catch { again = null; }
      if (!again?.onDuty) { othersRefused = true; targets = targets.filter(t => t.own); }
    }
    const batch = targets.slice(0, Math.max(0, MAX_REVOKES_PER_RUN - (strict?.attempted ?? 0)));
    leftover = targets.length - batch.length;
    const r = !pendingReadable ? { revoked: [], unconfirmed: batch.map(t => ({ checkRunId: t.checkRunId,
      code: 'TRAIN_PENDING_REVOCATIONS_UNREADABLE' })), sideEffects: 0, pendingStateFailed: true }
      : await revokeGreens({ github, targets: batch, appId, mainSha, ledger, own, clock, sleep, writeUntil: until.write, readUntil: until.read,
        pendingStore: sweepStore, pendingJob: job });
    revoked = r.revoked; unconfirmed = r.unconfirmed; fx.n += r.sideEffects;
    if (r.pendingStateFailed) stateReason ??= 'TRAIN_PENDING_REVOCATIONS_UNWRITTEN';
    try { pendingRevocations = (await sweepStore.readPendingRevocations())?.targets ?? []; }
    catch { stateReason ??= 'TRAIN_PENDING_REVOCATIONS_UNREADABLE'; }
  }
  const confirmed = unconfirmed.length === 0 && pendingRevocations.length === 0 && leftover === 0 && !othersRefused && (strict?.unconfirmed ?? 0) === 0;
  const incrementalOk = incremental.complete && (!acting || confirmed);
  const segmentOk = !segment || segment.ok;
  const sweepComplete = incremental.complete && segmentOk && leftover === 0;
  if (frontHead && [...revoked, ...(strict?.revoked ?? [])].some(r => r.headSha === frontHead.headSha)) front = { ...front, green: false };
  if (actions.revokeHead) actions.revokeHead = { ...actions.revokeHead, done: incrementalOk };

  // ---- the cursor and the full sweep after this run ----
  let completedNow = false;
  if (segment) {
    const counted = { ...full, prs: full.prs + sweeper.stats.prs, commits: full.commits + sweeper.stats.commits, heads: full.heads + sweeper.stats.heads,
      revoked: full.revoked + revoked.length, unconfirmed: full.unconfirmed + unconfirmed.length, wouldRevoke: full.wouldRevoke + (segment.targets?.length ?? 0),
      calls: full.calls + counter.calls, ms: full.ms + (clock() - started) };
    if (!segment.ok) full = { ...counted, state: 'abandoned', reason: segment.reason };
    else if (!acting || confirmed) {
      full = { ...counted, nextPage: segment.nextPage, nextIndex: segment.nextIndex };
      if (segment.reachedEnd && incrementalOk) { full = { ...full, state: 'complete', completedAt: isoOf(clock()) }; completedNow = true; }
    } else full = counted;
  }
  if (legacyUnconfirmed > 0 && completedNow && full.scope === 'all' && confirmed && !stateReason) {
    try {
      const last = await sweepStore.readPendingRevocations();
      if (last && Date.parse(last.writtenAt) > clock()) throw Error('future_pending');
      if (last && Date.parse(last.writtenAt) === clock()) await sleep(1);
      await sweepStore.writePendingRevocations({ repo: job.repo, writtenAt: isoOf(clock()), runId: job.runId,
        targets: pendingRevocations, legacyUnconfirmed: 0, legacySince: null });
      legacyUnconfirmed = 0; legacySince = null;
    } catch { stateReason ??= 'TRAIN_PENDING_REVOCATIONS_UNWRITTEN'; }
  }
  // The cursor: the newest pull seen when the pass completed; otherwise as far as every pull was judged (progress), so a
  // backlog advances run by run. Acting, only when this run's revocations are all confirmed.
  const advance = !acting || confirmed;
  if (scan && advance && !stateReason) try { scanWritten = await scan.save(job.runId, sleep); }
  catch { stateReason ??= 'TRAIN_SCAN_STATE_UNWRITTEN'; }
  // allPending ends with the first round of scope 'all' completed after it began (a round running when main was rewritten was
  // restarted; with no tip recorded, a round of scope 'all' from before generation 15 is the enumeration of before).
  const after = { mode, incrementalCursor: !advance ? before.incrementalCursor : incrementalOk ? (incremental.newest ?? cursor)
    : (incremental.progress ?? before.incrementalCursor), full, inMain: sweeper.inMain(), mainSha, allPending: completedNow && full.scope === 'all' ? null : allPending };
  let fullStateWritten = false;
  const fullStateNeedsWrite = JSON.stringify(after) !== JSON.stringify({ mode, incrementalCursor: before.incrementalCursor, full: before.full, inMain: before.inMain,
    mainSha: before.mainSha, allPending: before.allPending });
  // A binding or refresh round that skipped the segment writes none (their starvation bound above); the next round recomputes it.
  if (sweepStore && !stateReason && fullStateNeedsWrite && !frontBindSkip && !frontRefreshSkip) {
    try { await sweepStore.writeFullSweep({ writtenAt: isoOf(clock()), runId: job.runId, ...after }); fullStateWritten = true; } catch { /* the next run starts from the older cursor */ }
  }
  const fullSweepSinceOn = acting && sinceOn(full);
  // The independent lane proves only eligible non-front greens; background deferred work and its real full state stay intact.
  const strictClean = strict?.ready === true && unconfirmed.length === 0 && !othersRefused && (strict?.unconfirmed ?? 0) === 0;
  let strictReady = false, strictSummary = strictReadiness({ backgroundAllPending: after.allPending });
  let strictFrontReady = false, frontSummary = strictFrontReadiness({ backgroundAllPending: after.allPending });

  // ---- the proof (on, revoke-only): stage 8's single-green evidence for this front, clean or not ----
  let proofWritten = false;
  if (acting && sweepStore && !stateReason) {
    const since = holder ? normal(holder.since ?? holder.takenAt) : null;
    const bound = frontHead && holder.pr && (since || job.mode === 'revoke-only');
    try {
      await sweepStore.appendProof({ writtenAt: isoOf(clock()), runId: job.runId, mode: job.mode, pr: bound ? holder.pr : null, headSha: bound ? frontHead.headSha : null,
        claimId: bound ? holder.claimId : null, since: bound ? since : null, mainSha, clean: strictClean || (sweepComplete && confirmed && incrementalOk),
        unconfirmed: strictClean ? 0 : unconfirmed.length + leftover + (strict?.unconfirmed ?? 0),
        fullSweepSinceOn, slotHardCapMinutes: job.slotHardCapMinutes, sweepFreshMs: job.sweepFreshMs, prUpdatedCursor: after.incrementalCursor ?? EPOCH });
      proofWritten = true;
    } catch { proofWritten = false; }
  }
  if (strict) {
    strictSummary = strictReadiness({ identity: strict.identity, state: 'running', backgroundAllPending: after.allPending, reason: strict.reason });
    if (strictClean && proofWritten && strict.round?.incrementalCursor) {
      const writtenAt = isoOf(clock());
      try {
        const proofRef = await sweepStore.appendStrictProof({ ...strict.identity, writtenAt, runId: job.runId, clean: true, enumerationComplete: true,
          eligibleRevocationsConfirmed: true, unconfirmed: 0, prUpdatedCursor: strict.round.incrementalCursor, sweepFreshMs: job.sweepFreshMs,
          slotHardCapMinutes: job.slotHardCapMinutes, coverage: strict.round.coverage });
        strictSummary = strictReadiness({ identity: strict.identity, state: 'ready', proofRef, writtenAt, sweepFreshMs: job.sweepFreshMs, backgroundAllPending: after.allPending });
        strictReady = true;
      } catch { /* missing durable limited proof never opens a batch */ }
    }
  }
  if (frontFastEligible && pendingRevocations.length === 0 && !stateReason && (fullStateWritten || (!fullStateNeedsWrite && before.mainSha === mainSha))
    && unconfirmed.length === 0 && leftover === 0 && !othersRefused && proofWritten) {
    const writtenAt = isoOf(clock());
    try {
      const proofRef = await sweepStore.appendStrictFrontProof({ ...frontIdentity, writtenAt, runId: job.runId,
        historyCoverage: false, knownUnconfirmed: 0, sweepFreshMs: job.sweepFreshMs, slotHardCapMinutes: job.slotHardCapMinutes });
      frontSummary = strictFrontReadiness({ identity: frontIdentity, state: 'ready', proofRef, writtenAt,
        sweepFreshMs: job.sweepFreshMs, backgroundAllPending: after.allPending });
      strictFrontReady = true;
    } catch { /* The independently durable front proof is mandatory. */ }
  }
  // §65: in strict-permanent mode only a rewritten main (until a round of scope all completes) is still a take-over that holds the train.
  const takeoverPending = job.mode === 'on' && !strictReady && !strictFrontReady && (gating ? !fullSweepSinceOn : after.allPending === 'TRAIN_MAIN_REWRITTEN');

  // ---- on only: watermark, keepalive, adopt / return / touch failed, the front batch ----
  let lostDuty = false, requestPause = null, openFrontBatch = null, decision = null, keptAlive = [], openRows = null, frontBind = null, landingState = null;
  let landingFacts = route ? { route: route.route, missing: route.missing, bypass: { main: route.bypass.main, independent: route.bypass.independent } } : null;
  let missingYield = false, treeUnchecked = null;
  if (job.mode === 'on') {
    // ADR 0018 §9: the take-over watermark report (§41.6) is gone. It was informational only: since review R2 B1 no take-over uses a
    // watermark (every take-over sweeps from onSince), so nothing reads it. actions.watermarkReported stays in the facts, always false.
    try {
      openRows = bindRows ?? (await github.readPullsPage({ state: 'open', sort: 'updated', direction: 'desc', page: 1, perPage: KEEPALIVE_MAX_PRS })).pulls;
      const open = openRows.map(p => p.number);
      if (holder?.pr && front?.state === 'open' && !open.includes(holder.pr)) open.splice(KEEPALIVE_MAX_PRS - 1, 1, holder.pr);
      if (open.length) {
        fx.n++;
        const k = await native.keepalive({ prs: open.slice(0, KEEPALIVE_MAX_PRS) });
        if (!k.onDuty) { lostDuty = true; fx.n--; } else { keptAlive = k.keptAlive; actions.keptAlive = keptAlive.length; }
      }
    } catch { /* keepalive is best effort: the lease clocks still run */ }
    let frontLanded = false, landedNow = new Set();
    if (push && !takeoverPending && !lostDuty) {
      const l = await adoptLanded({ github, native, sweepStore, mainSha, job, clock, fx });
      landingFacts = { ...(landingFacts ?? {}), ...(l.facts ?? {}) };
      if (l.lostDuty) lostDuty = true;
      if (l.adopted.length) actions.adopted = true;
      landedNow = new Set(l.adopted);
      frontLanded = holder?.pr != null && l.adopted.includes(holder.pr);
      landingState = l.state;
    }
    if (!takeoverPending && !lostDuty && holder?.pr && front && !frontLanded) {
      try {
        const batchOfOutcome = push && job.frontFailed === true && job.frontPr !== null && job.frontPr === holder.pr && front.headSha === job.frontHeadSha
          ? await sweepStore.landingBatchByTest(job.frontTestSha) : null;
        if (batchOfOutcome && batchOfOutcome.members.length > 1 && !landingState) {
          // the landing state could not be read: neither bisect nor touch failed (the front is not alone to blame); the next run tries again
        } else if (batchOfOutcome && batchOfOutcome.members.length > 1) {
          // ADR 0018 §3: a batch of several members failed for a PR's own reason: bisect (the next batch takes the first half), no touch failed.
          if (!landingState.handled.includes(job.frontTestSha)) {
            const next = bisectAfter({ suspect: landingState.suspect, members: batchOfOutcome.members, landed: false });
            landingState = { ...landingState, suspect: next.suspect, bad: [...landingState.bad, ...next.bad], handled: [...landingState.handled, job.frontTestSha] };
            await sweepStore.writeLandingState({ writtenAt: isoOf(clock()), runId: job.runId, ...landingState });
          }
          actions.failedReported = true;
          landingFacts = { ...(landingFacts ?? {}), bisect: { failed: batchOfOutcome.members.map(m => m.pr), suspect: landingState.suspect?.map(m => m.pr) ?? null } };
        } else if (front.merged) {
          // §41.4 adopt: merged as [T, H] with S's tree, T and S from this node's front batch or the green's own summary
          const record = (await sweepStore?.frontBatches({ pr: holder.pr, headSha: front.headSha }))?.[0] ?? null;
          const green = frontChecks.filter(c => c?.app?.id === appId && c.name === SLOT_CHECK && c.head_sha === front.headSha && c.conclusion === 'success').sort((a, b) => b.id - a.id)[0];
          const said = TESTED.exec(green?.output?.summary ?? '');
          const tested = record ? { baseSha: record.baseSha, testTree: record.testTree } : said ? { baseSha: said[1], testTree: said[3] } : null;
          // Review 3 high 3: with the checks unreadable and no record of this node, what was tested is unknown, never a wrong tree: nothing is
          // latched, the next round reads again.
          // Review 4 medium 1: nor is it reported merged in this round's lifecycle reconcile (that could end its claim before its tree is checked).
          if (!tested && front.checksUnreadable) treeUnchecked = holder.pr;
          else if (tested && mergeCommit && mergeCommit.parents.length === 2 && mergeCommit.parents[0] === tested.baseSha && mergeCommit.parents[1] === front.headSha
            && mergeCommit.tree === tested.testTree) {
            fx.n++;
            const a = await native.adopt({ pr: holder.pr, mergeSha: mergeCommit.sha });
            if (!a.onDuty) { lostDuty = true; fx.n--; } else actions.adopted = a.adopted === true;
          } else requestPause = 'TRAIN_LANDED_TREE_MISMATCH';
        } else if (front.state === 'closed') {
          // Two calls, each its own: GitHub's closure ends the binding, and the merge slot is given back (giving it back ends nothing).
          await reportLifecycle(native, fx, [{ pr: holder.pr, state: 'closed', mergeSha: null }]);
          fx.n++;
          const r = await native.returnSlot({ pr: holder.pr });
          if (!r.onDuty) { lostDuty = true; fx.n--; } else actions.returned = r.returned === true;
        } else if (job.frontFailed === true && job.frontPr !== null && job.frontPr === holder.pr && front.headSha === job.frontHeadSha) {
          // §41.4 touch failed: only from the executor's frontOutcome of a failure of the PR itself (frontFailed, R3 batch 2), while this
          // claim is the front and the head is still H. A frontOutcome with frontFailed false only says the batch ended (frontBatchPlan's `finished`).
          fx.n++; fx.slotTouched = true;
          const t = await native.touch({ pr: holder.pr, headSha: job.frontHeadSha, ciState: 'failed', reason: job.frontCode });
          if (!t.onDuty) { lostDuty = true; fx.n--; } else actions.failedReported = t.touched === true || t.returned === true;
        } else if (front.state === 'open' && typeof native.yieldSlot === 'function' && SHA.test(pull?.head?.sha ?? '')
          && (pull.draft === true || !(await landable(github, pull, { complete: front.checksUnreadable !== true, checks: frontChecks },
            { ...landability, excuse: context => requiredFailureExcused(front, context, clock(), holder.takenAt ?? null) }))
            || (missingYield = requiredYieldReason(front, clock(), holder.takenAt ?? null)))) {
          // A front that cannot land as it stands (draft, auto-merge off, a required check failed) never
          // holds the slot while another claim waits: its claim goes to the back of the queue (Native writes nothing when none waits).
          // Fable 11-20 (#1192) and its independent review: nor does a merge-slot-green front that is not green once a missing check's re-run
          // budget is used up, or at the longest wait (train-facts.mjs#requiredYieldReason): FRONT_CHECKS_MISSING_YIELDED, with the reason.
          // Reviews 2 and 3 (medium 3): Native matches the front by claim and PR (the head it is given is recorded, not compared), so every yield
          // here is made only while the PR's head is still the head whose checks were read; a head that moved keeps the slot (its own checks are
          // read next round). After the call the head is read again: a yield cannot be taken back, so a head that moved meanwhile is recorded
          // (yieldHeadMoved). What stays open is the moment between that read and Native's own write.
          let moved = false;
          try { moved = (await github.readPullRequest(holder.pr))?.head?.sha !== pull.head.sha; } catch { moved = true; }
          if (moved) { front = { ...front, requiredYieldHeld: 'FRONT_HEAD_MOVED' }; missingYield = null; }
          else {
            fx.n++;
            const y = await native.yieldSlot({ pr: holder.pr, headSha: pull.head.sha });
            if (y.onDuty === false) { lostDuty = true; fx.n--; } else if (y.onDuty === null || y.yielded !== true) fx.n--; else actions.returned = true;
            if (missingYield && actions.returned) front = { ...front, requiredYieldReason: missingYield };
            if (actions.returned) {
              let after = false;
              try { after = (await github.readPullRequest(holder.pr))?.head?.sha !== pull.head.sha; } catch { after = false; }
              if (after) front = { ...front, yieldHeadMoved: true };
            }
          }
        }
      } catch { /* unreadable reply: the write may have happened; counted, and the next run sees the outcome */ }
    }
    // DESIGN §62.4: the same live conditions as the strict current-front observation (strict confirmed now, every node on this
    // Source, a healthy store, no pending or unconfirmed revocation, main's history known and not rewritten), for exactly one
    // holder that has no front PR yet. Native may bind the unique authorized PR head; that lookup is counted if it wrote.
    // The resident still runs its complete stage 1 before opening the front batch.
    const frontBindEligible = takeoverPending && !lostDuty && holder !== null && holder.boundPr === null && !!holder.takenAt && job.revokeHeadRequestId === null
      && rules?.strict === true && frontSourceHealthy && fastStoreHealthy && !stateReason && !ledgerReason && history !== 'rewritten' && history !== 'unknown'
      && allPending !== 'TRAIN_MAIN_REWRITTEN' && pendingRevocations.length === 0 && unconfirmed.length === 0 && leftover === 0 && !othersRefused && proofWritten;
    if (frontBindEligible && Array.isArray(openRows)) frontBind = Array.isArray(bindRows) ? bindFound
      : await findFrontBind({ github, native, fx, job, holder, rows: openRows, claimScope, until: until.read, clock });
    // §65 (the guard of strict-permanent mode): strict read off is never a state to work in. No front batch opens, and the resident
    // latches PAUSE and tells the Owner; stage 8 writes no green either (no proof says fullSweepSinceOn, its strict route needs strict).
    if (permanent && rules !== null && rules.strict !== true && !requestPause) requestPause = 'TRAIN_STRICT_OFF';
  }
  const wouldDo = decideShadow({ onDuty: true, holders: duty.holders, holder: duty.holders[0] ?? null, front, rules: pushRoute && rules ? { ...rules, strict: false } : rules, mainSha });
  if (!acting) decision = wouldDo;
  else if (requestPause) decision = requestPause;
  else if (lostDuty) decision = 'NOT_ON_DUTY';
  else if (unconfirmed.length || (strict?.unconfirmed ?? 0)) decision = 'TRAIN_REVOKE_UNCONFIRMED';
  else if ((!sweepComplete && !strictReady && !strictFrontReady) || !proofWritten) decision = 'TRAIN_SWEEP_INCOMPLETE';
  else if (othersRefused) decision = 'NOT_ON_DUTY';
  else if (job.mode === 'revoke-only') decision = 'REVOKE_ONLY_DONE';
  else if (takeoverPending) decision = 'TRAIN_TAKEOVER_SWEEP_PENDING';
  else if (actions.adopted) decision = 'FRONT_ADOPTED';
  else if (actions.returned) decision = missingYield ? 'FRONT_CHECKS_MISSING_YIELDED' : 'FRONT_RETURNED';
  else if (actions.failedReported) decision = 'FRONT_FAILED_REPORTED';
  else if (wouldDo === 'OPEN_FRONT_BATCH' && permanent && !strictFrontReady && !strictReady) decision = 'TRAIN_FRONT_NOT_PROVEN';
  else if (wouldDo === 'OPEN_FRONT_BATCH') {
    const o = await openFront({ job, github, native, claimScope, until: until.read, sweepStore, holder, front, mainSha, keptAlive, clock, actions, fx, compare: frontCompare,
      pushing: push ? { github, native, landing, max: pushRoute ? effectiveBatchMax(trainLanding) : 1, rehearsalOnly: !pushRoute, rows: openRows ?? [], claimScope, state: landingState,
        layerOfPaths, frontBaseSha: pull?.base?.sha ?? null } : null });
    decision = o.decision; openFrontBatch = o.openFrontBatch;
    // turn_short (Fable 2026-11-19; field 2026-11-19, #1169 -> #1173): the hard cap leaves this turn less than the front batch needs,
    // and a new turn would fit it. Nothing else ends such a turn (renewFrontSlot stops renewing it, it lapses idle before the cap,
    // and the cannot_land yield writes nothing while nobody waits), so before this a person released the claim, claimed again,
    // authorized the head again and edited the PR body. Native ends the turn instead: the same claim joins again, behind any waiting
    // claim, or alone head again at once with a whole turn; the next round opens the batch. Only when no slot write happened this
    // round. A server without turn_short writes nothing: the round stays TRAIN_FRONT_BUDGET_SHORT, as before.
    if (o.turnShort === true && !fx.slotTouched && typeof native.yieldSlot === 'function') {
      fx.n++;
      let y = null;
      try { y = await native.yieldSlot({ pr: holder.pr, headSha: front.headSha, reason: 'turn_short' }); } catch { y = null; /* unreadable: counted */ }
      if (y?.onDuty === false) { lostDuty = true; fx.n--; decision = 'NOT_ON_DUTY'; }
      else if (y && (y.onDuty === null || y.yielded !== true)) fx.n--;
      else if (y) { actions.returned = true; decision = 'FRONT_RETURNED'; }
    }
  } else decision = wouldDo;
  // Generation 28 (resident ADR 0017): the merge slot of a bound front that waits for its front batch, or whose front batch is still
  // running or parked, is renewed with touch running when less than SLOT_RENEW_BELOW_MS of it is left; at most one slot write a round.
  // Not after an adoption or a return in this round (push mode adopts a landed front before GitHub marks its PR merged).
  if (job.mode === 'on' && !lostDuty && !requestPause && !fx.slotTouched && !actions.adopted && !actions.returned) {
    const r = await renewFrontSlot({ job, native, sweepStore, holder, front, wouldDo, clock, fx });
    if (r === 'NOT_ON_DUTY') { lostDuty = true; decision = 'NOT_ON_DUTY'; } else if (r === 'TOUCHED') actions.touchedRunning = true;
  }

  if (job.mode === 'on' && ledger && !lostDuty && clock() - started < CLEANUP_BEFORE_MS) {
    try { summary = { ...(summary ?? { records: 0, refused: 0 }), closed: (await closeGreenLedgerGroups({ ledger, inMain: sweeper.inMainOf, now: clock(), deadline: until.read, clock })).closed }; }
    catch { /* cleanup is best effort; the ledger stays as it is */ }
  }
  // FABLE 11-19 L2: a PR binding ends on GitHub's facts only. The reconcile runs last in mode on, after the front's adopt, return or
  // touch, the front bind and the front batch, and only inside the round's budget (like the cleanup above; review B1): it never
  // delays anything on the train's path. It replaces ending the holder's bound PRs during the round.
  if (job.mode === 'on' && !lostDuty && clock() - started < CLEANUP_BEFORE_MS) {
    await reconcileLifecycle({ github, native, fx, openRows, deadline: until.read, clock, skip: treeUnchecked });
  }
  let progress = null;
  if (strict?.round && ['all', 'current'].includes(strict.round.scope) && strict.round.state === 'running') progress = sweepProgress({ identity: strict.identity, startedAt: strict.round.startedAt,
    nextPage: strict.round.nextPage, nextIndex: strict.round.nextIndex, revoked: strict.round.coverage.revoked, continuation: strict.continuation,
    advanced: strict.advanced, at: isoOf(clock()) });
  else if (['all', 'current'].includes(full.scope) && full.state === 'running' && !sinceOn(full)) progress = sweepProgress({ identity: { repo: job.repo, mainSha: full.mainSha,
    sourceManifestSha256: job.sourceManifestSha256, onSince: job.onSince }, scope: full.scope, startedAt: full.startedAt, nextPage: full.nextPage, nextIndex: full.nextIndex,
    revoked: full.revoked, continuation: scan?.token() ?? null, advanced: fullStateWritten && (scanWritten || full.nextPage !== before.full.nextPage || full.nextIndex !== before.full.nextIndex || full.revoked > before.full.revoked), at: isoOf(clock()) });
  // A long segment can outlive the GraphQL observation's 60-second freshness. Refresh only to authorize continuation
  // after real required all/current progress, with the same protected deadline (including credential acquisition/retries).
  if (progress?.advanced === true && typeof github.readRateBudget === 'function' && clock() < until.read - 1000) {
    try { await github.readRateBudget({ until: until.read }); budgetReadFailed = false; } catch { budgetReadFailed = true; }
  }
  const providerBudget = typeof github.rateBudget === 'function' ? github.rateBudget() : null;
  return facts({ onDuty: true, holders: duty.holders, mainSha, rules, rulesReason, appScans, front, revoke: targets.map(t => ({ headSha: t.headSha, checkRunId: t.checkRunId, reason: t.reason, own: t.own })),
    ledger: summary, decision, openFrontBatch, requestPause, frontBind: decision === 'TRAIN_TAKEOVER_SWEEP_PENDING' ? frontBind : null, landing: landingFacts,
    sweep: { ...sweepFacts({ kind: segment ? 'full-segment' : 'incremental', complete: strictReady || sweepComplete, revoked: revoked.length + (strict?.revoked.length ?? 0),
      unconfirmed: strictReady ? 0 : unconfirmed.length + leftover + (strict?.unconfirmed ?? 0),
      would: targets.length, full, sinceOn: fullSweepSinceOn, proofWritten, counter, started, clock, allPending: after.allPending }), strictCoverage: strictSummary,
      strictFrontReadiness: frontSummary,
      ...(providerBudget ? { providerBudget: budgetReadFailed ? { ...providerBudget, state: 'unknown', extraSlicesAllowed: false } : providerBudget } : {}),
      ...(progress ? { progress } : {}) } });
}

// allPending (generation 15): why rounds enumerate everything until one of scope 'all' completes (main rewritten, no main tip recorded), or null.
const sweepFacts = ({ kind, complete, revoked, unconfirmed, would, full = null, sinceOn = false, proofWritten = false, counter, started, clock, allPending = null }) => ({
  kind, complete, revoked, unconfirmed, wouldRevokeCount: would,
  fullSweep: { state: full?.state ?? 'none', startedAt: full?.startedAt ?? null, completedAt: full?.completedAt ?? null, sinceOn, reason: full?.reason ?? null,
    scope: full && full.state !== 'none' ? full.scope : null, scopeReason: full && full.state !== 'none' ? full.scopeReason : null, allPending },
  proofWritten, calls: counter.calls, ms: Math.max(0, clock() - started) });

// Choose the lowest-numbered eligible PR of the holder's uniquely projected
// Task/current generation. Several PRs of that Task are normal scheduling choices;
// contradictory Task/generation projections, unreadable data and deadline fail closed.
async function findFrontBind({ github, native, fx, job, holder, rows, claimScope, until, clock, readOnly = false,
  preferredHead = null, maxReads = FRONT_BIND_MAX_READS, preferLandable = false, landability }) {
  const matches = [], observed = [];
  for (const row of rows.filter(r => r?.state === 'open' && r.baseRef === 'main').slice(0, maxReads)) {
    if (clock() >= until) return null;
    let pull;
    try { pull = await github.readPullRequest(row.number, { until }); } catch { return null; }
    if (!eligibleBindingPull(pull, job.repo)) continue;
    let binding;
    try { binding = await projectPull({ native, fx, pull, job, claimScope, readOnly, until, clock }); } catch { return null; }
    if (clock() >= until) return null;
    if (binding.binding_status === 'conflict') return null;
    observed.push(binding);
    if (binding.binding_status === 'bound' && binding.claim.claim_id === holder.claimId) matches.push({ pull, binding });
  }
  const generations = new Set(matches.map(({ binding: b }) => JSON.stringify([b.task_id,b.claim.claim_id,b.claim.fence,b.claim.execution_epoch])));
  if (generations.size !== 1 || (holder.taskId && matches.some(({ binding: b }) => b.task_id !== holder.taskId))) return null;
  const first = matches[0].binding;
  if (observed.some(b => b.task_id === first.task_id && (!b.claim || b.binding_status === 'handover_pending'
    || b.claim.claim_id !== first.claim.claim_id || b.claim.fence !== first.claim.fence || b.claim.execution_epoch !== first.claim.execution_epoch))) return null;
  // The PR at the holder's CI head; none there (field 2026-11-13, #1087: its author pushed) -> the lowest PR, as with no CI head.
  const atHead = preferredHead === null ? [] : matches.filter(m => m.pull.head.sha === preferredHead);
  if (atHead.length > 1) return null;
  const ordered = [...atHead, ...matches.filter(m => !atHead.includes(m)).sort((a,b) => a.pull.number - b.pull.number)];
  let p = ordered[0]?.pull ?? null;
  // Field 2026-11-15 (#1121): of the holder's PRs, the first one GitHub can merge as it stands is the front (landable); only when none
  // can is the choice as before. The front never holds the slot for a PR that cannot land while another PR of the claim waits green.
  if (preferLandable) for (const m of ordered) {
    if (clock() >= until) break;
    if (await landable(github, m.pull, null, landability)) { p = m.pull; break; }
  }
  if (!p || !Number.isSafeInteger(p.number) || p.state !== 'open' || p.draft !== false || p.base?.ref !== 'main' || p.head?.repo?.full_name !== job.repo
    || !SHA.test(p.head?.sha ?? '')) return null;
  return { pr: p.number, headSha: p.head.sha, claimId: holder.claimId };
}

// Use the main rules already read this round and the shared required-check evaluator (names, App pins, latest rerun).
// Optional failures cannot rotate two waiting claims forever (#1142/#1143). If the required list cannot be qualified,
// keep the old all-Actions-failures predicate and record why in rulesReason; never relax that fallback.
// As before, an unreadable check inventory does not change the scheduling choice. This is never merge authorization.
const ACTIONS_APP_ID = 15368;
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
// excuse (A3, Fable 11-20): a failed required check the train does not call real yet (train-facts.mjs#requiredFailureExcused).
async function landable(github, pull, listed = null, { rules = null, appId = APP_ID, onFallback = () => {}, excuse = () => false } = {}) {
  if (pull.auto_merge == null) return false;
  if (listed === null) try { listed = await github.readChecks(pull.head.sha); } catch { return true; }
  if (listed?.complete !== true || !Array.isArray(listed.checks)) return true;
  if (rules !== null) {
    try { return requiredCheckFailure(rules, listed, pull.head.sha, appId).filter(context => !excuse(context)).length === 0; }
    catch (e) { onFallback(e?.code === RULESET_UNREADABLE ? RULESET_UNREADABLE : REQUIRED_CHECKS_UNREADABLE); }
  } else onFallback(RULESET_UNREADABLE);
  const latest = new Map();
  for (const c of listed.checks) if (c?.app?.id === ACTIONS_APP_ID && c.head_sha === pull.head.sha && Number.isSafeInteger(c.id)
    && !(latest.get(c.name)?.id > c.id)) latest.set(c.name, c);
  return ![...latest.values()].some(c => c.status === 'completed' && FAILED_CONCLUSIONS.has(c.conclusion));
}

// FABLE 11-19 L2: the PR's real lifecycle on GitHub is the only source of a binding's end. Native says which of this repository's PR
// bindings it still holds open (tracked); every PR GitHub lists open now is left out (the round's own open list when it is shorter
// than a page, so complete; otherwise every page), at most LIFECYCLE_MAX_READS of the rest are read (highest number first) and what
// GitHub says goes back in one report: merged with its merge commit, or closed (merged false and no merged_at; anything else is no
// fact this round). An open PR is never reported. Steady state: one RPC and no extra GitHub read. Bounded (review B1): every read
// carries the round's deadline and the clock is checked before each; at the deadline it stops and reports what it already has.
// Auxiliary: a port without the report, an RPC that is not deployed, a failed read or an unreadable reply only means less or no
// reconcile this round; it never pauses the train, touches admission or decides duty.
export const LIFECYCLE_MAX_READS = 25;
const OPEN_PAGE = 100, OPEN_MAX_PAGES = 30;
// skip: a PR this round must not report (review 4 medium 1: the front merged whose tree check waits for readable checks).
async function reconcileLifecycle({ github, native, fx, openRows = null, deadline, clock, skip = null }) {
  if (typeof native?.lifecycleReport !== 'function') return;
  const time = () => clock() < deadline - 1000;
  let tracked;
  try {
    const asked = await native.lifecycleReport({ prs: [] });
    if (asked?.onDuty !== true || !Array.isArray(asked.tracked) || !asked.tracked.every(n => Number.isSafeInteger(n) && n > 0)) return;
    tracked = asked.tracked;
  } catch { return; }
  if (!tracked.length) return;
  const open = new Set();
  if (Array.isArray(openRows) && openRows.length < KEEPALIVE_MAX_PRS) for (const p of openRows) open.add(p?.number);
  else {
    try {
      for (let page = 1; page <= OPEN_MAX_PAGES; page++) {
        if (!time()) return;
        const pulls = (await github.readPullsPage({ state: 'open', sort: 'created', direction: 'desc', page, perPage: OPEN_PAGE, until: deadline }))?.pulls;
        if (!Array.isArray(pulls)) return;
        for (const p of pulls) open.add(p?.number);
        if (pulls.length < OPEN_PAGE) break;
      }
    } catch { return; }
  }
  const facts = [];
  for (const n of [...new Set(tracked)].filter(n => !open.has(n) && n !== skip).sort((a, b) => b - a).slice(0, LIFECYCLE_MAX_READS)) {
    if (!time()) break;
    let pull;
    try { pull = await github.readPullRequest(n, { until: deadline }); } catch { continue; }
    if (pull?.number !== n || pull.state !== 'closed') continue;
    if (pull.merged === true) { if (SHA.test(pull.merge_commit_sha ?? '')) facts.push({ pr: n, state: 'merged', mergeSha: pull.merge_commit_sha }); }
    else if (pull.merged === false && pull.merged_at == null) facts.push({ pr: n, state: 'closed', mergeSha: null });
  }
  if (facts.length) await reportLifecycle(native, fx, facts);
}
// One lifecycle report write -> whether Native took it. A lost reply may follow a commit: counted, and the next round asks again.
async function reportLifecycle(native, fx, prs) {
  if (typeof native?.lifecycleReport !== 'function') return false;
  fx.n++;
  try {
    const r = await native.lifecycleReport({ prs });
    if (r?.onDuty !== true) { fx.n--; return false; }
    return true;
  } catch { return false; }
}

async function selectProjectedHolder({ holder, ...ports }) {
  if (!Array.isArray(holder.prs) || !holder.prs.length || typeof holder.taskId !== 'string') return null;
  const activeHead = ['running','green'].includes(holder.ciState) && SHA.test(holder.ciHeadSha ?? '') ? holder.ciHeadSha : null;
  const selected = await findFrontBind({ ...ports, holder, rows: holder.prs.map(number => ({ number, state: 'open', baseRef: 'main' })),
    readOnly: true, preferredHead: activeHead, maxReads: 50, preferLandable: true });
  return selected ? { ...holder, pr: selected.pr, boundPr: `${ports.job.repo}#${selected.pr}` } : null;
}

function eligibleBindingPull(pull, repository) {
  return Number.isSafeInteger(pull?.number) && pull.number > 0 && pull.state === 'open' && pull.draft === false
    && pull.base?.ref === 'main' && pull.head?.repo?.full_name === repository
    && SHA.test(pull.head?.sha ?? '') && SHA.test(pull.base?.sha ?? '');
}

async function projectPull({ native, fx, pull, job, claimScope, readOnly = false, until = null, clock = Date.now }) {
  if (typeof claimScope !== 'string' || typeof native?.resolvePRBinding !== 'function') fail('TRAIN_PR_BINDING_UNAVAILABLE');
  // Like the other Native writes: a lost reply may follow an atomic commit.
  // Only a validated response explicitly saying no write can clear the count.
  if (!readOnly) fx.n++;
  const binding = await native.resolvePRBinding({ scope: claimScope, repository: job.repo, prNumber: pull.number,
    headSha: pull.head.sha, baseSha: pull.base.sha, targetBranch: pull.base.ref, ...(readOnly ? { readOnly: true } : {}) },
  until === null ? undefined : { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, until-clock()))) });
  if (!readOnly && binding.auto_bound === false) fx.n--;
  return binding;
}

// No role (review R2 M3): the front is unknown here (holders answered admission_binding_required), so a green that may be the
// front's legitimate one stays for the role holder's sweep (§41.6a "由 Y 的接班清扫撤掉"). Revoked: this node's own ledgered
// greens not in main that cannot be the front's green, either because their T (the ledger's baseSha) is not main's tip, or
// because the green's head is not the current head of its PR, open (read now; a PR that cannot be read keeps its green).
async function revokeOwnOnly({ github, ledger, appId, clock, sleep, started, until, fx, sweepStore, job }) {
  const out = { mainSha: null, targets: [], revoked: 0, unconfirmed: 0, summary: null };
  try {
    const { entries, refused } = await ledger.list();
    out.summary = { records: entries.length, refused: refused.length };
    const own = ledgerGreens(entries);
    const prior = await sweepStore.readPendingRevocations();
    if (prior && prior.repo !== job.repo) return out;
    out.targets = (prior?.targets ?? []).filter(t => t.own);
    if (!own.size && !out.targets.length) return out;
    out.mainSha = (await github.readBranchHead('main')).sha;
    const sweeper = createSweeper({ github, appId, mainSha: out.mainSha, clock, until: started + SWEEP_BUDGET_MS });
    const candidates = (await sweeper.judge([...new Set([...own.values()].map(e => e.headSha))], { front: null, own })).filter(t => t.own);
    const heads = new Map();
    for (const t of candidates) {
      const entry = own.get(t.checkRunId);
      if (out.targets.some(p => p.checkRunId === t.checkRunId)) continue;
      if (entry?.baseSha !== out.mainSha) { out.targets.push(t); continue; }
      if (!heads.has(entry.pr)) {
        let current = null;
        try { const p = await github.readPullRequest(entry.pr); current = p?.state === 'open' && SHA.test(p.head?.sha ?? '') ? p.head.sha : 'closed'; } catch { current = null; }
        heads.set(entry.pr, current);
      }
      const current = heads.get(entry.pr);
      if (current !== null && current !== t.headSha) out.targets.push(t);
    }
    const r = await revokeGreens({ github, targets: out.targets.slice(0, MAX_REVOKES_PER_RUN), appId, mainSha: out.mainSha, ledger, own, clock, sleep,
      writeUntil: until.write, readUntil: until.read, pendingStore: sweepStore, pendingJob: job });
    out.revoked = r.revoked.length; out.unconfirmed = r.unconfirmed.length + (r.pendingStateFailed ? 1 : 0) + Math.max(0, out.targets.length - MAX_REVOKES_PER_RUN); fx.n += r.sideEffects;
  } catch { /* nothing more without a readable ledger and main */ }
  return out;
}

// Task e30b5a36: did the last stage-10 round count a full-sweep segment? Its proof (the newest) and the newest full-sweep record are
// of one run, and that record's calls grew over the record before it of the same round. Anything unreadable: no.
async function lastRoundSwept({ sweepStore, mode, lastProof, lastFull }) {
  if (!lastProof || !lastFull || lastProof.runId !== lastFull.runId || typeof sweepStore?.read !== 'function') return false;
  try {
    const [newest, older = null] = await sweepStore.read(`full-${mode}`, 2);
    if (newest?.runId !== lastFull.runId || newest.writtenAt !== lastFull.writtenAt) return false;
    return newest.full.calls > (older && older.full.startedAt === newest.full.startedAt ? older.full.calls : 0);
  } catch { return false; }
}

// Generation 23 (PR #1032, DESIGN §62.8): how many stage-10 rounds (their proofs, newest first) came after the newest round that counted a
// full-sweep segment: 0 when the last round counted one. That round is the newest full-sweep record's run (this run's starting record),
// when its calls grew over the record before it in the same round. Not found among the newest proofs, nothing counted, a torn record or
// anything unreadable: Infinity (no skip).
async function roundsSinceSegment({ sweepStore, mode, lastFull }) {
  if (!lastFull || typeof sweepStore?.read !== 'function') return Infinity;
  try {
    const [newest, older = null] = await sweepStore.read(`full-${mode}`, 2);
    if (newest?.runId !== lastFull.runId || newest.writtenAt !== lastFull.writtenAt
      || !(newest.full.calls > (older && older.full.startedAt === newest.full.startedAt ? older.full.calls : 0))) return Infinity;
    const proofs = await sweepStore.read('proof', MAX_SKIPS_BEFORE_SKIP + 1);
    const i = proofs.findIndex(p => p.runId === newest.runId);
    return i < 0 || sweepStore.refused !== 0 ? Infinity : i;
  } catch { return Infinity; }
}

// openFront's checks before any write (pure; also stage 10's forecast before the sweeps, task e30b5a36): the refusal, or null.
function frontBatchPlan({ job, holder, front, mainSha, previous, keptAlive, clock, used = previous.length }) {
  const last = previous[0] ?? null;
  const finished = last && job.frontPr === last.pr && job.frontHeadSha === last.headSha && job.frontTestSha === last.testSha && job.frontAttempt === last.attempt;
  if (last && !finished && last.claimId === holder.claimId && last.baseSha === mainSha && (last.testSha === front.testMerge.sha || last.testTree === front.testMerge.tree)
    && holder.ciState === 'running' && holder.ciHeadSha === front.headSha && Date.parse(holder.mergeSlotUntil) > clock()) return { refusal: 'TRAIN_FRONT_BATCH_RUNNING', running: last };
  if (used >= MAX_FRONT_BATCHES_PER_HEAD) return { refusal: 'TRAIN_FRONT_ATTEMPTS_USED' };
  // Without the claim's kept-alive lease (keepalive failed or did not name it; review R2 minor 3) the lease bound is the
  // read-back after touch running (openFront): a merge-slot clock never runs past the claim lease (§41.4 "现状").
  const since = normal(holder.since ?? holder.takenAt), expires = normal(keptAlive.find(k => k.claimId === holder.claimId)?.expiresAt);
  const need = job.frontBatchBudgetMs + STAGE8_ATTEMPT_MS + STAGE_MARGIN_MS;
  const left = now => Math.min(now + RUNNING_CLOCK_MS, Date.parse(since) + job.slotHardCapMinutes * 60_000, expires ? Date.parse(expires) : Infinity) - now;
  if (!since || !(left(clock()) >= need)) {
    // turnShort (Fable 2026-11-19): the hard cap is why (not the claim lease, not an unreadable since), and a new turn fits the batch
    // (the cap and Native's running clock each leave it its need). Stage 10 then ends the turn (merge_queue_yield turn_short).
    const capLeft = since ? Date.parse(since) + job.slotHardCapMinutes * 60_000 - clock() : NaN;
    const turnShort = capLeft < need && job.slotHardCapMinutes * 60_000 >= need && RUNNING_CLOCK_MS >= need;
    return { refusal: 'TRAIN_FRONT_BUDGET_SHORT', ...(turnShort ? { turnShort: true } : {}) };
  }
  return { refusal: null, since, need };
}

// §41.4 hard cap: open the front batch only with time for it, after touch running and a read-back of the moved clock.
// The batch this node already opened for (claim, T, S) that is still running (the holder's CI clock runs on H; its attempt
// not reported finished by the executor's frontOutcome) is not opened again (review R2 M1): this run refreshed the proof for
// its stage 8, no attempt is counted and no second openFrontBatch reaches the executor. A regenerated test merge with the
// same parents and tree is the same S for this purpose. Since R3 batch 2 the executor reports every final end of an attempt
// that has no automatic attempt 2 (frontFailed says whether the PR itself failed). Residual: an end it never got to report
// counts as running until the holder's running clock or slot ends.
async function openFront({ job, github, native, claimScope, until, sweepStore, holder, front, mainSha, keptAlive, clock, actions, fx, pushing = null, compare = null }) {
  const no = decision => ({ decision, openFrontBatch: null });
  let previous, used;
  try {
    previous = await sweepStore.frontBatches({ pr: holder.pr, headSha: front.headSha });
    // ADR 0018 §3: in push mode a batch of several members that failed does not use up one of the front's own attempts (bisection would
    // otherwise end the front before its own test alone).
    used = previous.length;
    if (pushing) { used = 0; for (const r of previous) { const b = await sweepStore.landingBatchByTest(r.testSha); if (!b || b.members.length === 1) used++; } }
  } catch { return no('TRAIN_SWEEP_INCOMPLETE'); }
  const { refusal, need, running, turnShort = false } = frontBatchPlan({ job, holder, front, mainSha, previous, keptAlive, clock, used });
  if (running && normal(running.since) !== normal(holder.takenAt)) {
    // #1144: Native may reset takenAt after the certificate was written. The current round has freshly
    // proved this holder; reanchor the original tested S, never substitute a regenerated S with the same tree.
    // Re-read after all keepalive/touch side effects. A racing tenure is retried next round, never guessed.
    try {
      const again = await native.holders();
      let h = again.onDuty && again.holders.length === 1 ? again.holders[0] : null;
      if (h?.boundPrs?.length > 1) h = await selectProjectedHolder({ github, native, fx, job, holder: h, claimScope, until, clock });
      const currentSince = normal(holder.takenAt);
      if (!currentSince || !h || h.claimId !== running.claimId || h.pr !== running.pr || normal(h.takenAt) !== currentSince
        || h.ciState !== 'running' || h.ciHeadSha !== running.headSha || !(Date.parse(h.mergeSlotUntil) > clock())
        || Date.parse(currentSince) > clock()) return no('TRAIN_FRONT_BUDGET_SHORT');
      await sweepStore.appendFrontBatch({ ...running, writtenAt: isoOf(clock()), runId: job.runId, since: currentSince });
    } catch { return no('TRAIN_FRONT_BUDGET_SHORT'); }
  }
  // Fable 11-21 open points §1 (one invariant): on route push the running front batch's S is on clued-train/staging with a landing-batch
  // record. A batch opened while the composition was only a rehearsal (the current path or park: a failed composition is swallowed, the
  // batch runs on GitHub's test merge) has neither, and once main's rules route push stage 8 would wait for Actions checks S never gets.
  // Stage 10 attaches it this round: clued-train/staging pointed at S, then a landing-batch record of the front alone (T, S and S's tree
  // of the running batch; the record present means attached). A failure leaves the round TRAIN_FRONT_BATCH_RUNNING and the next round
  // tries again: no new batch, no attempt counted, no suite run again. The current path and park attach nothing.
  if (refusal === 'TRAIN_FRONT_BATCH_RUNNING' && pushing && !pushing.rehearsalOnly && running) {
    try {
      if (!(await sweepStore.landingBatchByTest(running.testSha))) {
        fx.n++; await pushing.landing.pointRef(STAGING_REF, running.testSha);
        await sweepStore.appendLandingBatch({ writtenAt: isoOf(clock()), runId: job.runId, frontPr: running.pr, frontHeadSha: running.headSha,
          baseSha: running.baseSha, testSha: running.testSha, testTree: running.testTree, attempt: running.attempt,
          members: [{ pr: running.pr, headSha: running.headSha, claimId: running.claimId }] });
      }
    } catch { /* not attached this round: the next round tries again */ }
  }
  if (refusal) return { ...no(refusal), turnShort };
  let composed = null;
  if (pushing) {
    composed = await composeBatch({ ...pushing, job, holder, front, mainSha, fx });
    // Off push (the current path), S on clued-train/staging is the rehearsal only: a composition that fails never holds the front batch
    // back (an auxiliary step is never on the path to merging); the batch opens on GitHub's test merge as without push.
    if (composed.refusal && pushing.rehearsalOnly) composed = null;
    else if (composed.refusal) return no(composed.refusal);
  }
  let touched;
  try { fx.n++; fx.slotTouched = true; touched = await native.touch({ pr: holder.pr, headSha: front.headSha, ciState: 'running', hardCapMinutes: job.slotHardCapMinutes }); }
  catch { return no('TRAIN_FRONT_BUDGET_SHORT'); }
  if (!touched.onDuty) { fx.n--; return no('NOT_ON_DUTY'); }
  if (touched.touched !== true) return no('TRAIN_FRONT_BUDGET_SHORT');
  actions.touchedRunning = true;
  let again;
  try { again = await native.holders(); } catch { return no('TRAIN_FRONT_BUDGET_SHORT'); }
  let h = again.onDuty && again.holders.length === 1 ? again.holders[0] : null;
  if (h?.boundPrs?.length > 1) h = await selectProjectedHolder({ github, native, fx, job, holder: h, claimScope, until, clock });
  if (!h || h.claimId !== holder.claimId || h.pr !== holder.pr || !(Date.parse(h.mergeSlotUntil) > Date.parse(holder.mergeSlotUntil))
    || !(Date.parse(h.mergeSlotUntil) - clock() >= need)) return no('TRAIN_FRONT_BUDGET_SHORT');
  const currentSince = normal(h.takenAt);
  if (!currentSince || Date.parse(currentSince) > clock()
    || Date.parse(currentSince) + job.slotHardCapMinutes * 60_000 - clock() < need) return no('TRAIN_FRONT_BUDGET_SHORT');
  const batch = { pr: holder.pr, headSha: front.headSha, baseSha: mainSha, testSha: composed?.testSha ?? front.testMerge.sha, testTree: composed?.testTree ?? front.testMerge.tree,
    claimId: holder.claimId, since: currentSince, attempt: Math.min(used, MAX_FRONT_BATCHES_PER_HEAD - 1) + 1 };
  if (composed) {
    try {
      await sweepStore.appendLandingBatch({ writtenAt: isoOf(clock()), runId: job.runId, frontPr: batch.pr, frontHeadSha: batch.headSha, baseSha: batch.baseSha,
        testSha: batch.testSha, testTree: batch.testTree, attempt: batch.attempt, members: composed.members });
      if (composed.suspect !== composed.stateSuspect) await sweepStore.writeLandingState({ writtenAt: isoOf(clock()), runId: job.runId, ...composed.state, suspect: composed.suspect });
    } catch { return no('TRAIN_FRONT_BUDGET_SHORT'); }
  }
  // the attempt is counted before the executor sees the batch; a record that cannot be written opens nothing
  try { await sweepStore.appendFrontBatch({ writtenAt: isoOf(clock()), runId: job.runId, ...batch }); } catch { return no('TRAIN_FRONT_BUDGET_SHORT'); }
  // ADR 0019: a batch of several members names them, in merge order (the front first), so the resident can write the descriptor /4 the
  // bundle and the workspace preparation check the chain against. One member: the batch exactly as before (descriptor /3).
  const members = composed && composed.members.length > 1 ? composed.members.map(m => ({ pr: m.pr, headSha: m.headSha })) : null;
  // Rule 41ab823a (resident DESIGN §75): a front of one member also names H's own tree, read here from GitHub. When it equals S's tree the
  // scans would read exactly what an ordinary batch of (H, T) already scanned, and the resident reuses that batch's results instead of
  // scanning again. A read that fails or does not fit names nothing (the front batch scans as before); it is never a refusal.
  let headTree = null;
  if (!members) try { const c = await github.readGitCommit(front.headSha); if (c?.sha === front.headSha && SHA.test(c.tree ?? '')) headTree = c.tree; } catch { headTree = null; }
  // The review ruling (B2): that T is in H is this run's own compare of exactly (T, H) (read above for frontPullFacts), for a front of one
  // member; stage 1 then reads nothing for the reuse. A compare of other ends, or one that says H lacks part of T, names nothing.
  const baseInHead = !members && compare?.baseSha === batch.baseSha && compare?.headSha === batch.headSha && compare.behindBy === 0
    && ['ahead', 'identical'].includes(compare.status);
  return { decision: 'OPEN_FRONT_BATCH', openFrontBatch: { ...batch, ...(members ? { members } : {}), ...(headTree ? { headTree } : {}), ...(baseInHead ? { baseInHead: true } : {}) } };
}

// The PR's merge-admission layer is protected: its changed paths by the held policy (layerOfPaths), and a read that fails counts as protected.
async function protectedPull({ github, job, layerOfPaths, pr, headSha, baseSha }) {
  try { return layerOfPaths((await github.readChangedPaths({ repo: job.repo, pr, headSha, baseSha })).paths) === 'protected'; } catch { return true; }
}

// ADR 0018 §3 riders: open PRs into main (not the front), not drafts, from this repository, with GitHub auto-merge on (the author's will to
// merge; D6 2026-11-19 §1 item 7), whose Native binding names a current claim of this install and whose current head carries App 5368905's
// newest kooyumi-work-admission success (stage 1 admitted it, Native bound the claim), and whose changes are not protected-layer (D6 §1
// item 8: a protected change lands only alone, under its own Grant for its exact head); in PR-number order, at most `want`. A read that
// fails ends the search (fewer riders, never a guess); a layer that cannot be read only leaves that PR out.
export const RIDER_MAX_READS = 10;
async function findRiders({ github, native, fx, job, rows, claimScope, holder, want, layerOfPaths }) {
  const out = [];
  if (want <= 0) return out;
  const open = rows.filter(r => r?.state === 'open' && r.baseRef === 'main' && r.number !== holder.pr).sort((a, b) => a.number - b.number).slice(0, RIDER_MAX_READS);
  for (const row of open) {
    if (out.length >= want) break;
    try {
      const pull = await github.readPullRequest(row.number);
      if (!eligibleBindingPull(pull, job.repo) || pull.auto_merge == null) continue;
      const binding = await projectPull({ native, fx, pull, job, claimScope });
      if (binding.binding_status === 'conflict') fail('TRAIN_PR_BINDING_CONFLICT');
      if (binding.binding_status !== 'bound' || binding.claim.claim_id === holder.claimId) continue;
      const listed = await github.readChecks(pull.head.sha);
      const admitted = (listed?.checks ?? []).filter(c => c?.app?.id === APP_ID && c.name === 'kooyumi-work-admission' && c.head_sha === pull.head.sha)
        .sort((a, b) => b.id - a.id)[0];
      if (admitted?.status !== 'completed' || admitted.conclusion !== 'success') continue;
      if (await protectedPull({ github, job, layerOfPaths, pr: pull.number, headSha: pull.head.sha, baseSha: pull.base.sha })) continue;
      out.push({ pr: pull.number, headSha: pull.head.sha, claimId: binding.claim.claim_id });
    } catch (error) { if (error?.code === 'TRAIN_PR_BINDING_CONFLICT') throw error; break; }
  }
  return out;
}

// ADR 0018 §3: the members, S and S's tree of the batch push opens, with the landing port's writes (counted). One member: GitHub's test merge.
// Several: clued-train/staging.tmp forced to T, each member merged in (a conflict or a head already in T leaves that member out), the
// chain read back. Either way clued-train/staging is forced to S (the CI trigger for the required checks other Apps produce on S).
async function composeBatch({ github, native, landing, max, rows, claimScope, state, job, holder, front, mainSha, fx, layerOfPaths, frontBaseSha }) {
  // D6 §8.4 (b): the landing state could not be read while this node has landing batches (adoptLanded): its own decision, not a sweep's.
  if (!state) return { refusal: 'TRAIN_LANDING_STATE_UNREADABLE' };
  const frontMember = { pr: holder.pr, headSha: front.headSha, claimId: holder.claimId };
  // D6 §1 item 8: a protected-layer front (or one whose layer cannot be read) takes no riders.
  const alone = max <= 1 || front.protectedLayer === true
    || await protectedPull({ github, job, layerOfPaths, pr: holder.pr, headSha: front.headSha, baseSha: frontBaseSha });
  const candidates = alone ? [] : await findRiders({ github, native, fx, job, rows, claimScope, holder, want: max - 1, layerOfPaths });
  const picked = pickMembers({ front: frontMember, candidates, bad: state.bad, suspect: state.suspect, max });
  let members = picked.members, testSha = front.testMerge?.sha ?? null, testTree = front.testMerge?.tree ?? null;
  try {
    if (members.length > 1) {
      fx.n++; await landing.pointRef(STAGING_TMP_REF, mainSha);
      const kept = [], steps = [];
      for (const m of members) {
        fx.n++;
        const r = await landing.mergeIntoTmp(m.headSha, `Merge train batch: #${m.pr} (${m.headSha.slice(0, 12)})`);
        if (r.status === 201) { kept.push(m); steps.push(r.sha); testSha = r.sha; } else if (m === members[0]) return { refusal: 'FRONT_NEEDS_MAIN_MERGE' };
      }
      members = kept;
      if (members.length === 1) { testSha = front.testMerge?.sha ?? null; testTree = front.testMerge?.tree ?? null; }
      else {
        // ADR 0019 (review 3): every step of the chain must be the commit this run's own merge returned (S1 on T, S2 on S1, ...).
        const chain = await readBatchChain({ readGitCommit: s => github.readGitCommit(s), baseSha: mainSha, heads: members.map(m => m.headSha), testSha, steps });
        if (!chain.ok) return { refusal: 'FRONT_TEST_MERGE_NOT_READY' };
        testTree = chain.tree;
      }
    }
    if (!SHA.test(testSha ?? '') || !SHA.test(testTree ?? '')) return { refusal: 'FRONT_TEST_MERGE_NOT_READY' };
    fx.n++; await landing.pointRef(STAGING_REF, testSha);
  } catch { return { refusal: 'FRONT_TEST_MERGE_NOT_READY' }; }
  return { members, testSha, testTree, suspect: picked.suspect, stateSuspect: state.suspect, state };
}

// ADR 0018 §6: every batch of this node whose S main now contains, oldest first, not yet recorded as adopted: each member whose PR is still at
// the batch's head (merged, or open while GitHub has not marked it yet) is adopted with S, riders first and the front last. A batch is
// recorded as adopted once each member was answered (adopted, or moved on to another head); the bisection learns from it once.
async function adoptLanded({ github, native, sweepStore, mainSha, job, clock, fx }) {
  const out = { facts: null, adopted: [], lostDuty: false, state: null };
  let state, batches;
  try { state = await sweepStore.readLandingState(); batches = await sweepStore.landingBatches(20); }
  catch (error) {
    // D6 §8.4: the landing state only schedules (riders kept out, the bisection suspect, batches adopted or handled); main's safety is S's
    // checks and each member's own admission. (a) A state that cannot be read while this node has no landing batch at all loses nothing:
    // it is read as empty and a valid one is written this round, read back before anything uses it (the validator stays strict).
    // (b) Otherwise the refusal stays: TRAIN_LANDING_STATE_UNREADABLE in the facts and, at the front batch, as the decision.
    state = error?.code === 'TRAIN_LANDING_STATE_UNREADABLE' ? await resetLandingState({ sweepStore, job, clock }) : null;
    if (!state) { out.facts = { error: 'TRAIN_LANDING_STATE_UNREADABLE' }; return out; }
    batches = [];
  }
  const notMarkedMerged = [], landed = [];
  let changed = false;
  for (const b of [...batches].reverse()) {
    if (state.adopted.includes(b.testSha)) continue;
    let cmp;
    try { cmp = await github.readCompare(b.testSha, mainSha); } catch { continue; }
    if (!(cmp?.status === 'identical' || (cmp?.status === 'ahead' && cmp.behindBy === 0))) continue;
    let answered = true;
    for (const m of [...b.members.slice(1), b.members[0]]) {
      let pull;
      try { pull = await github.readPullRequest(m.pr); } catch { answered = false; continue; }
      if (pull?.head?.sha !== m.headSha || (pull.state !== 'open' && pull.merged !== true)) continue;
      if (pull.merged !== true) notMarkedMerged.push(m.pr);
      try {
        fx.n++;
        const a = await native.adopt({ pr: m.pr, mergeSha: b.testSha });
        if (!a.onDuty) { fx.n--; out.lostDuty = true; answered = false; break; }
        if (a.adopted) out.adopted.push(m.pr);
      } catch { answered = false; }
    }
    if (out.lostDuty) break;
    if (answered) {
      const next = bisectAfter({ suspect: state.suspect, members: b.members, landed: true });
      state = { ...state, suspect: next.suspect, bad: [...state.bad, ...next.bad], adopted: [...state.adopted, b.testSha] };
      landed.push({ testSha: b.testSha, members: b.members.map(m => m.pr) });
      changed = true;
    }
  }
  if (changed) {
    try { await sweepStore.writeLandingState({ writtenAt: isoOf(clock()), runId: job.runId, ...state }); } catch { out.facts = { error: 'TRAIN_LANDING_STATE_UNWRITTEN' }; }
  }
  out.state = state;
  out.facts = { ...(out.facts ?? {}), mainSha, landed, adopted: out.adopted, notMarkedMerged };
  return out;
}

// D6 §8.4 (a): no landing batch of this node (readable or not) -> an empty landing state written and read back, or null (refuse).
async function resetLandingState({ sweepStore, job, clock }) {
  try {
    if (await sweepStore.anyLandingBatch()) return null;
    await sweepStore.writeLandingState({ writtenAt: isoOf(clock()), runId: job.runId, bad: [], suspect: null, adopted: [], handled: [] });
    const again = await sweepStore.readLandingState();
    return again.bad.length === 0 && again.suspect === null && again.adopted.length === 0 && again.handled.length === 0 ? again : null;
  } catch { return null; }
}

// Generation 28 (resident ADR 0017, the 45-minute gap of ADR 0016): from the moment a claim becomes the queue head until stage 10's
// OPEN_FRONT_BATCH touch, nothing moved the merge slot, so a front that stage 10 could not open for a while (other batches held the
// executor, or rounds ended TRAIN_TAKEOVER_SWEEP_PENDING, TRAIN_FRONT_NOT_PROVEN, TRAIN_SWEEP_INCOMPLETE, ...) lost its slot when the
// 45 minutes ran out. One touch running ("CI is reporting on its PR", Native's 90-minute clock, still bounded by the hard cap counted
// from the slot's taking and by the claim lease) when all of these hold:
//   - exactly one holder, bound to a PR of this repository (Native's touch matches bound_pr; an unbound head is §62.4's binding);
//   - the PR is open and not merged, its head known, and no green on it (stage 8's 30-minute green clock is for the merge and a touch
//     running would replace it): front.green false, and Native's CI state is not green on this head;
//   - this node's newest front batch of this head and claim is not reported finished while Native's CI clock runs on this head (a
//     front batch running or parked at stage 8), or the front waits for its front batch (wouldDo OPEN_FRONT_BATCH) and the hard cap
//     still leaves that batch its budget (frontBatchPlan's need);
//   - less than SLOT_RENEW_BELOW_MS of the slot is left (and it is still live: a report never revives a lapsed slot), and the hard
//     cap leaves room past the current end (otherwise the touch could not move it);
//   - no other merge-slot write this round (openFront's touch running, touch failed): at most one touch a round.
// A front that is idle (draft, closed, conflicting, not containing main, green) is never renewed: it gives way when its time is up.
// -> 'TOUCHED', 'NOT_TOUCHED', 'NOT_ON_DUTY' or null (not applicable). A reply that cannot be read counts as a write (the next
// round reads the outcome).
async function renewFrontSlot({ job, native, sweepStore, holder, front, wouldDo, clock, fx }) {
  if (!holder?.pr || !front || front.state !== 'open' || front.merged || !front.headSha || front.green) return null;
  if (holder.ciState === 'green' && holder.ciHeadSha === front.headSha) return null;
  const now = clock(), until = Date.parse(holder.mergeSlotUntil ?? '');
  if (!(until > now) || !(until - now < SLOT_RENEW_BELOW_MS)) return null;
  const since = Date.parse(normal(holder.since ?? holder.takenAt) ?? '');
  const capUntil = Number.isFinite(since) ? since + job.slotHardCapMinutes * 60_000 : Infinity;
  if (!(capUntil > until)) return null;
  // A front batch of this head and claim that is not reported finished while Native's CI clock runs on this head: running or parked.
  let batchLive = false;
  if (holder.ciState === 'running' && holder.ciHeadSha === front.headSha) {
    let last = null;
    try { last = (await sweepStore?.frontBatches({ pr: holder.pr, headSha: front.headSha }))?.[0] ?? null; } catch { last = null; }
    const finished = last && job.frontPr === last.pr && job.frontHeadSha === last.headSha && job.frontTestSha === last.testSha && job.frontAttempt === last.attempt;
    batchLive = !!last && !finished && last.claimId === holder.claimId;
  }
  // Waiting for the front batch counts only while the hard cap still leaves the batch its budget (frontBatchPlan's need): a front that
  // can no longer be opened under the cap (TRAIN_FRONT_BUDGET_SHORT for good) gives way instead of holding the slot to the cap.
  const waiting = wouldDo === 'OPEN_FRONT_BATCH' && capUntil - now >= job.frontBatchBudgetMs + STAGE8_ATTEMPT_MS + STAGE_MARGIN_MS;
  if (!batchLive && !waiting) return null;
  let t;
  try { fx.n++; fx.slotTouched = true; t = await native.touch({ pr: holder.pr, headSha: front.headSha, ciState: 'running', hardCapMinutes: job.slotHardCapMinutes }); }
  catch { return 'NOT_TOUCHED'; }
  if (!t.onDuty) { fx.n--; return 'NOT_ON_DUTY'; }
  return t.touched === true ? 'TOUCHED' : 'NOT_TOUCHED';
}

// After runTrain (review R2 M5): once a write happened, a later failure (the held record's lease, the shadow-store write) ends
// UNCERTAIN with the true count, which writeOutcome turns into mayHavePublished true; never a clean BLOCKED with zero. With
// no write a failure is thrown as before (runEntry: BLOCKED). Retention never fails the run.
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
export async function settleTrain({ run, live, append, retain = async () => {} }) {
  const reasonOf = (e, fallback) => (SAFE_CODE.test(e?.code ?? '') ? e.code : fallback);
  let out;
  try { out = await run(); } catch (e) {
    if (Number.isSafeInteger(e?.sideEffects) && e.sideEffects > 0) return { status: 'UNCERTAIN', reason: reasonOf(e, 'TRAIN_FAILED_AFTER_WRITE'), sideEffects: e.sideEffects };
    throw e;
  }
  try { live(); await append(out.facts); } catch (e) {
    if (out.sideEffects > 0) return { status: 'UNCERTAIN', reason: reasonOf(e, 'TRAIN_FAILED_AFTER_WRITE'), sideEffects: out.sideEffects, train: out.facts };
    throw e;
  }
  try { await retain(); } catch { /* its own record and the observation log say what happened */ }
  return { status: TRAIN_FACTS_STATUS, sideEffects: out.sideEffects, train: out.facts };
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  return runEntry({ argv, entryRole: 'train-maintenance', moduleUrl: import.meta.url, output, successStatuses: [TRAIN_FACTS_STATUS], body: async ({ inputs, held, live, sourceRoot }) => {
    const started = Date.now();
    const job = validateTrainRun(inputs.jobs[0]);
    const { appKey, nativeToken, bindingId } = await controllerPrincipal(inputs.record);
    const log = observationLog(STATE_V2.trainShadow, job.id);
    const ports = controllerPorts({ record: inputs.record, appKey, nativeToken, bindingId, policyText: held.policyText, sourceRoot, live, log });
    const slotNative = createMergeSlotNative({ config: inputs.record.config, fetchImpl: ports.fetchImpl, nativeToken });
    const native = Object.freeze({ ...slotNative, resolvePRBinding: (expected, options) => resolvePRTaskBinding({ ...expected,
      scope: inputs.record.config.scope, repository: inputs.record.config.repository, command: input => ports.native.command(input, options) }) });
    let ledger = null, sweepStore = null;
    try { ledger = await GreenLedger.open(STATE_V2.greenLedger); } catch { /* listed as nothing; the facts say so */ }
    try { sweepStore = await TrainSweepStore.open(STATE_V2.trainSweep); } catch { /* no sweep state: the sweep is incomplete */ }
    const publications = publicationHeads({ command: input => ports.native.command(input), scope: inputs.record.config.scope, repository: inputs.record.config.repository });
    // §41.4: the front's layer by the held merge-admission policy; a policy that does not load judges every path protected.
    const loaded = loadPolicy(held.policyText);
    const layerOfPaths = loaded.policy ? paths => layerOf(paths, loaded.policy) : () => 'protected';
    // ADR 0018: the stage file (stages 8 and 10) and, in push mode only, the landing port (the same App key, a contents-write token).
    const trainLanding = await readStageTrainLandingFact(inputs.dir);
    const landing = trainLanding.landing === 'push' && !trainLanding.unreadable ? createLandingPort({ repository: inputs.record.config.repository,
      repositoryId: FIXED_APP.repositoryId, appId: FIXED_APP.appId, installationId: FIXED_APP.installationId, privateKeyProvider: async () => appKey, fetchImpl: ports.fetchImpl }) : null;
    return settleTrain({
      run: () => runTrain({ job, github: ports.github, native, ledger, sweepStore, publications, layerOfPaths, claimScope: inputs.record.config.scope,
        observeBindings: true, landing, trainLanding }),
      live,
      append: async facts => (await TrainShadowStore.open(STATE_V2.trainShadow)).append(job.runId, facts),
      // DESIGN §41.7: the state areas' retention and the outcome month segments, at most once a day, after the facts are
      // written and inside the stage window; it never fails the run (its pass record and the observation log say what it did).
      retain: () => stateRetention({ runId: job.runId, log, notAfter: started + TRAIN_STAGE_V2.runMilliseconds - 30_000 }) });
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
