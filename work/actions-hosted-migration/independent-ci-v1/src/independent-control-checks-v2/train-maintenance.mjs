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
//                batch of the same S is still running. The watermark (informational) after a confirmed full sweep.
//   revoke-only  (under PAUSE; §41.3) the three kinds of revocation, the incremental sweep and the proof; no batch, no
//                touch, adopt, return or keepalive.
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
import { RULESET_UNREADABLE, rulesetFacts } from './train-rules.mjs';
import { decideShadow, frontPullFacts, trainFacts, NO_ACTIONS } from './train-facts.mjs';
import { TrainShadowStore } from './train-shadow-store.mjs';
import { TrainSweepStore } from './train-sweep-store.mjs';
import { runStrictLane, strictIdentity, strictReadiness, strictFrontReadiness, strictFrontSourceHealthy, sweepProgress, recordFollows } from './train-strict.mjs';
import { layerOf, loadPolicy } from '../../../../../scripts/ci/merge-admission-policy.mjs';
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
const freshFull = () => ({ state: 'none', via: null, startedAt: null, completedAt: null, onSince: null, mainSha: null, nextPage: 1, nextIndex: 0, prs: 0, commits: 0,
  heads: 0, revoked: 0, unconfirmed: 0, wouldRevoke: 0, calls: 0, ms: 0, reason: null, scope: 'all', scopeReason: null });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Generation 19 field defect (DESIGN §62.4): while the take-over sweep runs, the merge queue's head claim may be bound to no PR yet
// (only an admission stage 1 binds it, and the take-over gate holds every batch). Stage 10 then names the one open PR whose body
// trailer names that claim (the merge executor reads the claim from the body only, too) so the resident may run that PR's stage 1
// and nothing more. At most this many of the most recently updated open PRs into main are read per run.
export const FRONT_BIND_MAX_READS = 10;
// The trailers exactly as scripts/ci/clued-work-admission.mjs#parseClaimReference reads them (not imported: stage 10 does not load
// the Windows evaluator; a test keeps the two equal).
const CLAIM_TRAILER = /^Clued-Work-Claim:[ \t]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*$/m;
const SCOPE_TRAILER = /^Clued-Work-Scope:[ \t]*(global|project:[0-9a-fA-F-]{36})[ \t]*$/m;
export function claimReferenceOf(text) {
  if (typeof text !== 'string') return null;
  const claim = CLAIM_TRAILER.exec(text);
  if (!claim) return null;
  const scope = SCOPE_TRAILER.exec(text);
  return { claimId: claim[1].toLowerCase(), scope: scope ? scope[1] : 'global' };
}

// Shadow wrapper kept for the 3c-1 callers: the facts only.
export async function readTrainFacts(ports) { return (await runTrain(ports)).facts; }

// Pure over its ports (tested with fakes). ledger, sweepStore, publications may be null (could not be opened): the
// sweep is then incomplete (on, revoke-only) or not computed (shadow). layerOfPaths: the PR's changed paths -> its
// merge-admission layer (main: merge-admission-policy.mjs over the held policy; default and any failure: 'protected').
// -> { facts, sideEffects }. A throw after a write carries the count (e.sideEffects; settleTrain, review R2 M5).
export async function runTrain(ports) {
  const fx = { n: 0 };
  try { return await runTrainCounted(ports, fx); }
  catch (e) { if (fx.n > 0) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sideEffects: fx.n }); throw e; }
}

async function runTrainCounted({ job, github: plainGithub, native, ledger, sweepStore = null, publications = null, appId = APP_ID, clock = Date.now, sleep = wait,
  layerOfPaths = () => 'protected', claimScope = null }, fx) {
  validateTrainRun(job);
  const started = clock(), at = isoOf(started), acting = job.mode !== 'shadow';
  const { github, counter } = countedGithub(plainGithub);
  const actions = { ...NO_ACTIONS, revokeHead: job.revokeHeadRequestId ? { requestId: job.revokeHeadRequestId, done: false } : null };
  const until = { write: started + REVOKE_WRITE_BEFORE_MS, read: started + STAGE_WORK_BEFORE_MS };
  let budgetReadFailed = false;
  const duty = await native.holders();
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
  let rules = null, rulesReason = null;
  try {
    const reply = await github.readBranchRules('main');
    if (reply?.complete !== true) fail(RULESET_UNREADABLE);
    rules = rulesetFacts(reply.rules, appId);
  } catch { rulesReason = RULESET_UNREADABLE; }
  const holder = duty.holders.length === 1 ? duty.holders[0] : null;
  let front = null, pull = null, mergeCommit = null, frontChecks = [];
  if (holder?.pr) {
    pull = await github.readPullRequest(holder.pr);
    const headSha = SHA.test(pull?.head?.sha ?? '') ? pull.head.sha : null;
    const compare = headSha ? await github.readCompare(mainSha, headSha) : null;
    mergeCommit = SHA.test(pull?.merge_commit_sha ?? '') ? await github.readGitCommit(pull.merge_commit_sha) : null;
    const listed = headSha ? await github.readChecks(headSha) : { complete: true, checks: [] };
    if (listed?.complete !== true || !Array.isArray(listed.checks)) fail('TRAIN_FRONT_CHECKS_UNREADABLE');
    frontChecks = listed.checks;
    front = frontPullFacts({ pull, mergeCommit, compare, checks: listed.checks, mainSha, appId });
    // §41.4 (MergeAdmission v0.2 §2.4), on only: a protected-layer front whose H does not contain T needs main merged in
    // first. The layer is read only when H does not contain T; paths that cannot be read count as protected.
    if (job.mode === 'on' && front.state === 'open' && headSha && front.headContainsMain !== true) {
      let layer = 'protected';
      try { layer = layerOfPaths((await github.readChangedPaths({ repo: job.repo, pr: holder.pr, headSha, baseSha: pull.base.sha })).paths); } catch { layer = 'protected'; }
      front = { ...front, protectedLayer: layer === 'protected' };
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
  const sinceOn = f => f.state === 'complete' && f.via === 'sweep' && onSinceMs !== null && Date.parse(f.startedAt) >= onSinceMs;
  const start = () => ({ ...freshFull(), state: 'running', via: 'sweep', startedAt: at, onSince: job.onSince, mainSha,
    ...(allPending ? { scope: 'all', scopeReason: allPending } : { scope: 'current' }) });
  const abandon = reason => ({ ...full, state: 'abandoned', reason, completedAt: null });
  if (legacyUnconfirmed > 0 && (full.scope !== 'all' || !full.startedAt || Date.parse(full.startedAt) < Date.parse(legacySince)))
    full = abandon('TRAIN_LEGACY_REVOKE_PENDING');
  // A rewrite voids the round in progress and the one completed (DESIGN 60.2): on mode then starts a round of scope 'all' at once and
  // is TRAIN_TAKEOVER_SWEEP_PENDING (no green) until it completes; revoke-only leaves that to the next on run; shadow restarts too.
  if (history === 'rewritten' && ['running', 'complete'].includes(full.state)) full = abandon('TRAIN_MAIN_REWRITTEN');
  if (history === 'unknown') { /* no round starts or ends on a history that could not be read */ } else if (job.mode === 'on' && !sinceOn(full)) {
    if (full.state === 'running' && (Date.parse(full.startedAt) < onSinceMs || started - Date.parse(full.startedAt) > job.fullSweepMaxMs))
      full = abandon(Date.parse(full.startedAt) < onSinceMs ? 'TRAIN_FULL_SWEEP_BEFORE_ON' : 'TRAIN_FULL_SWEEP_EXPIRED');
    if (full.state !== 'running' && !(full.state === 'abandoned' && full.reason === 'TRAIN_PULL_OVER_250_COMMITS' && full.onSince === job.onSince)) full = start();
  } else if (job.mode === 'shadow') {
    if (full.state === 'running' && started - Date.parse(full.startedAt) > job.fullSweepMaxMs) full = abandon('TRAIN_FULL_SWEEP_EXPIRED');
    // one shadow round per fullSweepMaxMs is enough to measure it (§41.9 item 2)
    if (full.state === 'none' || (full.state === 'abandoned' && full.reason !== 'TRAIN_PULL_OVER_250_COMMITS')
      || (full.state === 'complete' && started - Date.parse(full.completedAt) > job.fullSweepMaxMs)) full = start();
  }
  const sweeper = createSweeper({ github, appId, mainSha, inMain: history === 'same' || history === 'forward' ? before.inMain : [], clock, until: started + SWEEP_BUDGET_MS });
  const frontFastEligible = job.mode === 'on' && !sinceOn(full) && job.revokeHeadRequestId === null && rules?.strict === true && frontSourceHealthy && fastStoreHealthy
    && front?.headContainsMain === true && front?.state === 'open' && front.draft === false && front.mergeable === true
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
  //     strict-front observation, e.g. the resident's refresh before stage 8). Starvation bound: only when the last round counted a
  //     full-sweep segment (below) and this round's full-sweep state stays as recorded (same main, same round), so it writes none and
  //     the next round sweeps (at most every other refresh round skips).
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
  const frontPlan = Array.isArray(previousBatches) && !(job.frontPr !== null && job.frontPr === holder.pr && front.headSha === job.frontHeadSha)
    && decideShadow({ onDuty: true, holders: duty.holders, holder, front, rules, mainSha }) === 'OPEN_FRONT_BATCH'
    ? frontBatchPlan({ job, holder, front, mainSha, previous: previousBatches, keptAlive: [], clock }).refusal : 'NONE';
  const frontOpenSkip = frontPlan === null && !judgedBefore;
  const frontRefreshSkip = frontPlan === 'TRAIN_FRONT_BATCH_RUNNING' && history === 'same' && allPending === before.allPending
    && JSON.stringify(full) === JSON.stringify(before.full) && await lastRoundSwept({ sweepStore, mode, lastProof, lastFull });
  const bindCandidate = job.mode === 'on' && !sinceOn(full) && full.state === 'running' && holder !== null && holder.boundPr === null && !!holder.takenAt
    && job.revokeHeadRequestId === null && rules?.strict === true && frontSourceHealthy && fastStoreHealthy && !stateReason && !ledgerReason
    && history !== 'rewritten' && history !== 'unknown' && allPending !== 'TRAIN_MAIN_REWRITTEN' && pendingRevocations.length === 0
    && (lastProof === null || await lastRoundSwept({ sweepStore, mode, lastProof, lastFull }));
  if (bindCandidate) {
    try { bindRows = (await github.readPullsPage({ state: 'open', sort: 'updated', direction: 'desc', page: 1, perPage: KEEPALIVE_MAX_PRS })).pulls; } catch { bindRows = null; }
    if (Array.isArray(bindRows)) bindFound = await findFrontBind({ github, job, holder, rows: bindRows, claimScope, until: until.read, clock });
  }
  const frontBindSkip = bindFound !== null;
  const historyDeferred = frontFastOnly || frontOpenSkip || frontRefreshSkip;
  let stream = null;
  if (!historyDeferred) try { stream = publications ? await publications.heads() : null; } catch { stream = null; }
  const strictOwnsPending = pendingRevocations.every(t => legacyStrictPending.some(p => p.checkRunId === t.checkRunId && p.headSha === t.headSha));
  const strictEnabled = legacyUnconfirmed === 0 && strictOwnsPending && !frontFastEligible && job.mode === 'on' && rules?.strict === true && frontHead && holder?.takenAt && !sinceOn(full)
    && history !== 'rewritten' && history !== 'unknown' && allPending !== 'TRAIN_MAIN_REWRITTEN' && !stateReason && !ledgerReason
    && typeof sweepStore?.readStrictRound === 'function' && typeof sweepStore?.writeStrictRound === 'function' && typeof sweepStore?.appendStrictProof === 'function';
  const strict = strictEnabled ? await runStrictLane({ identity: strictIdentity({ job, holder, headSha: frontHead.headSha, mainSha,
    scope: allPending ? 'all' : 'current' }), job, sweepStore, github, native, entries, stream, own, appId, clock, sleep, started, until, ledger,
    revokeHead: !!job.revokeHeadRequestId, fx }) : null;
  if (strict) try { pendingRevocations = (await sweepStore.readPendingRevocations())?.targets ?? []; }
  catch { stateReason ??= 'TRAIN_PENDING_REVOCATIONS_UNREADABLE'; }
  // A running full sweep gets its own share of the time: the incremental part never starves it (review R2 M2).
  const wantSegment = !historyDeferred && !frontBindSkip && full.state === 'running' && job.mode !== 'revoke-only' && !stateReason;
  let incremental = historyDeferred ? { complete: false, reason: 'TRAIN_HISTORY_DEFERRED', targets: [], progress: null, newest: null }
    : await incrementalSweep({ sweeper, github, entries, stream, cursor, front: frontHead, own, revokeHead: !!job.revokeHeadRequestId, clock,
      until: strict ? clock() + Math.max(0, started + SWEEP_BUDGET_MS - clock()) / 2
        : started + (wantSegment || frontBindSkip ? SWEEP_BUDGET_MS / 2 : SWEEP_BUDGET_MS) });
  if (incremental.complete && (stateReason || (acting && ledgerReason))) incremental = { ...incremental, complete: false, reason: stateReason ?? ledgerReason };
  const segment = wantSegment && !sweeper.late() ? await fullSweepSegment({ sweeper, github, nextPage: full.nextPage, nextIndex: full.nextIndex, front: frontHead, own, scope: full.scope }) : null;
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
  const takeoverPending = job.mode === 'on' && !fullSweepSinceOn && !strictReady && !strictFrontReady;

  // ---- on only: watermark, keepalive, adopt / return / touch failed, the front batch ----
  let lostDuty = false, requestPause = null, openFrontBatch = null, decision = null, keptAlive = [], openRows = null, frontBind = null;
  if (job.mode === 'on') {
    if (completedNow && full.via === 'sweep' && after.incrementalCursor) {
      try {
        const w = await native.reportSweepWatermark({ completedAt: full.completedAt, updatedCursor: after.incrementalCursor, mainSha });
        if (w.recorded) { actions.watermarkReported = true; fx.n++; }
      } catch { /* not deployed, refused or unreadable: informational only (no take-over uses it) */ }
    }
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
    if (!takeoverPending && !lostDuty && holder?.pr && front) {
      try {
        if (front.merged) {
          // §41.4 adopt: merged as [T, H] with S's tree, T and S from this node's front batch or the green's own summary
          const record = (await sweepStore?.frontBatches({ pr: holder.pr, headSha: front.headSha }))?.[0] ?? null;
          const green = frontChecks.filter(c => c?.app?.id === appId && c.name === SLOT_CHECK && c.head_sha === front.headSha && c.conclusion === 'success').sort((a, b) => b.id - a.id)[0];
          const said = TESTED.exec(green?.output?.summary ?? '');
          const tested = record ? { baseSha: record.baseSha, testTree: record.testTree } : said ? { baseSha: said[1], testTree: said[3] } : null;
          if (tested && mergeCommit && mergeCommit.parents.length === 2 && mergeCommit.parents[0] === tested.baseSha && mergeCommit.parents[1] === front.headSha
            && mergeCommit.tree === tested.testTree) {
            fx.n++;
            const a = await native.adopt({ pr: holder.pr, mergeSha: mergeCommit.sha });
            if (!a.onDuty) { lostDuty = true; fx.n--; } else actions.adopted = a.adopted === true;
          } else requestPause = 'TRAIN_LANDED_TREE_MISMATCH';
        } else if (front.state === 'closed') {
          fx.n++;
          const r = await native.returnSlot({ pr: holder.pr });
          if (!r.onDuty) { lostDuty = true; fx.n--; } else actions.returned = r.returned === true;
        } else if (job.frontPr !== null && job.frontPr === holder.pr && front.headSha === job.frontHeadSha) {
          // §41.4 touch failed: only from the executor's frontOutcome, while this claim is the front and the head is still H
          fx.n++;
          const t = await native.touch({ pr: holder.pr, headSha: job.frontHeadSha, ciState: 'failed', reason: job.frontCode });
          if (!t.onDuty) { lostDuty = true; fx.n--; } else actions.failedReported = t.touched === true || t.returned === true;
        }
      } catch { /* unreadable reply: the write may have happened; counted, and the next run sees the outcome */ }
    }
    // DESIGN §62.4: the same live conditions as the strict current-front observation (strict confirmed now, every node on this
    // Source, a healthy store, no pending or unconfirmed revocation, main's history known and not rewritten), for exactly one
    // holder that Native has bound to no PR yet. Only a read: the resident runs that PR's stage 1, which binds the claim through
    // Native's own verify; the next stage 10 then decides the front exactly as before.
    const frontBindEligible = takeoverPending && !lostDuty && holder !== null && holder.boundPr === null && !!holder.takenAt && job.revokeHeadRequestId === null
      && rules?.strict === true && frontSourceHealthy && fastStoreHealthy && !stateReason && !ledgerReason && history !== 'rewritten' && history !== 'unknown'
      && allPending !== 'TRAIN_MAIN_REWRITTEN' && pendingRevocations.length === 0 && unconfirmed.length === 0 && leftover === 0 && !othersRefused && proofWritten;
    if (frontBindEligible && Array.isArray(openRows)) frontBind = Array.isArray(bindRows) ? bindFound
      : await findFrontBind({ github, job, holder, rows: openRows, claimScope, until: until.read, clock });
  }
  const wouldDo = decideShadow({ onDuty: true, holders: duty.holders, holder: duty.holders[0] ?? null, front, rules, mainSha });
  if (!acting) decision = wouldDo;
  else if (requestPause) decision = requestPause;
  else if (lostDuty) decision = 'NOT_ON_DUTY';
  else if (unconfirmed.length || (strict?.unconfirmed ?? 0)) decision = 'TRAIN_REVOKE_UNCONFIRMED';
  else if ((!sweepComplete && !strictReady && !strictFrontReady) || !proofWritten) decision = 'TRAIN_SWEEP_INCOMPLETE';
  else if (othersRefused) decision = 'NOT_ON_DUTY';
  else if (job.mode === 'revoke-only') decision = 'REVOKE_ONLY_DONE';
  else if (takeoverPending) decision = 'TRAIN_TAKEOVER_SWEEP_PENDING';
  else if (actions.adopted) decision = 'FRONT_ADOPTED';
  else if (actions.returned) decision = 'FRONT_RETURNED';
  else if (actions.failedReported) decision = 'FRONT_FAILED_REPORTED';
  else if (wouldDo === 'OPEN_FRONT_BATCH') {
    const o = await openFront({ job, native, sweepStore, holder, front, mainSha, keptAlive, clock, actions, fx });
    decision = o.decision; openFrontBatch = o.openFrontBatch;
  } else decision = wouldDo;

  if (job.mode === 'on' && ledger && !lostDuty && clock() - started < CLEANUP_BEFORE_MS) {
    try { summary = { ...(summary ?? { records: 0, refused: 0 }), closed: (await closeGreenLedgerGroups({ ledger, inMain: sweeper.inMainOf, now: clock(), deadline: until.read, clock })).closed }; }
    catch { /* cleanup is best effort; the ledger stays as it is */ }
  }
  let progress = null;
  if (strict?.round && ['all', 'current'].includes(strict.round.scope) && strict.round.state === 'running') progress = sweepProgress({ identity: strict.identity, startedAt: strict.round.startedAt,
    nextPage: strict.round.nextPage, nextIndex: strict.round.nextIndex, revoked: strict.round.coverage.revoked, advanced: strict.advanced, at: isoOf(clock()) });
  else if (['all', 'current'].includes(full.scope) && full.state === 'running' && !sinceOn(full)) progress = sweepProgress({ identity: { repo: job.repo, mainSha: full.mainSha,
    sourceManifestSha256: job.sourceManifestSha256, onSince: job.onSince }, scope: full.scope, startedAt: full.startedAt, nextPage: full.nextPage, nextIndex: full.nextIndex,
    revoked: full.revoked, advanced: fullStateWritten && (full.nextPage !== before.full.nextPage || full.nextIndex !== before.full.nextIndex || full.revoked > before.full.revoked), at: isoOf(clock()) });
  // A long segment can outlive the GraphQL observation's 60-second freshness. Refresh only to authorize continuation
  // after real required all/current progress, with the same protected deadline (including credential acquisition/retries).
  if (progress?.advanced === true && typeof github.readRateBudget === 'function' && clock() < until.read - 1000) {
    try { await github.readRateBudget({ until: until.read }); budgetReadFailed = false; } catch { budgetReadFailed = true; }
  }
  const providerBudget = typeof github.rateBudget === 'function' ? github.rateBudget() : null;
  return facts({ onDuty: true, holders: duty.holders, mainSha, rules, rulesReason, front, revoke: targets.map(t => ({ headSha: t.headSha, checkRunId: t.checkRunId, reason: t.reason, own: t.own })),
    ledger: summary, decision, openFrontBatch, requestPause, frontBind: decision === 'TRAIN_TAKEOVER_SWEEP_PENDING' ? frontBind : null,
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

// DESIGN §62.4: the one open PR into main, from this repository and not a draft, whose body names the holder's claim (and this
// install's scope), among the FRONT_BIND_MAX_READS most recently updated open PRs into main. None, two or more, a read that fails
// or the stage's read deadline: null (nothing is proven unique, nothing runs).
async function findFrontBind({ github, job, holder, rows, claimScope, until, clock }) {
  const matches = [];
  for (const row of rows.filter(r => r?.state === 'open' && r.baseRef === 'main').slice(0, FRONT_BIND_MAX_READS)) {
    if (clock() >= until) return null;
    let pull;
    try { pull = await github.readPullRequest(row.number); } catch { return null; }
    const ref = claimReferenceOf(pull?.body);
    if (ref?.claimId === holder.claimId && (claimScope === null || ref.scope === claimScope)) matches.push(pull);
  }
  const p = matches.length === 1 ? matches[0] : null;
  if (!p || !Number.isSafeInteger(p.number) || p.state !== 'open' || p.draft !== false || p.base?.ref !== 'main' || p.head?.repo?.full_name !== job.repo
    || !SHA.test(p.head?.sha ?? '')) return null;
  return { pr: p.number, headSha: p.head.sha, claimId: holder.claimId };
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

// openFront's checks before any write (pure; also stage 10's forecast before the sweeps, task e30b5a36): the refusal, or null.
function frontBatchPlan({ job, holder, front, mainSha, previous, keptAlive, clock }) {
  const last = previous[0] ?? null;
  const finished = last && job.frontPr === last.pr && job.frontHeadSha === last.headSha && job.frontTestSha === last.testSha && job.frontAttempt === last.attempt;
  if (last && !finished && last.claimId === holder.claimId && last.baseSha === mainSha && (last.testSha === front.testMerge.sha || last.testTree === front.testMerge.tree)
    && holder.ciState === 'running' && holder.ciHeadSha === front.headSha && Date.parse(holder.mergeSlotUntil) > clock()) return { refusal: 'TRAIN_FRONT_BATCH_RUNNING' };
  if (previous.length >= MAX_FRONT_BATCHES_PER_HEAD) return { refusal: 'TRAIN_FRONT_ATTEMPTS_USED' };
  // Without the claim's kept-alive lease (keepalive failed or did not name it; review R2 minor 3) the lease bound is the
  // read-back after touch running (openFront): a merge-slot clock never runs past the claim lease (§41.4 "现状").
  const since = normal(holder.since ?? holder.takenAt), expires = normal(keptAlive.find(k => k.claimId === holder.claimId)?.expiresAt);
  const need = job.frontBatchBudgetMs + STAGE8_ATTEMPT_MS + STAGE_MARGIN_MS;
  const left = now => Math.min(now + RUNNING_CLOCK_MS, Date.parse(since) + job.slotHardCapMinutes * 60_000, expires ? Date.parse(expires) : Infinity) - now;
  if (!since || !(left(clock()) >= need)) return { refusal: 'TRAIN_FRONT_BUDGET_SHORT' };
  return { refusal: null, since, need };
}

// §41.4 hard cap: open the front batch only with time for it, after touch running and a read-back of the moved clock.
// The batch this node already opened for (claim, T, S) that is still running (the holder's CI clock runs on H; its attempt
// not reported finished by the executor's frontOutcome) is not opened again (review R2 M1): this run refreshed the proof for
// its stage 8, no attempt is counted and no second openFrontBatch reaches the executor. A regenerated test merge with the
// same parents and tree is the same S for this purpose. Residual: an attempt that ended without a frontOutcome (an
// infrastructure failure) counts as running until the holder's running clock or slot ends.
async function openFront({ job, native, sweepStore, holder, front, mainSha, keptAlive, clock, actions, fx }) {
  const no = decision => ({ decision, openFrontBatch: null });
  let previous;
  try { previous = await sweepStore.frontBatches({ pr: holder.pr, headSha: front.headSha }); } catch { return no('TRAIN_SWEEP_INCOMPLETE'); }
  const { refusal, since, need } = frontBatchPlan({ job, holder, front, mainSha, previous, keptAlive, clock });
  if (refusal) return no(refusal);
  let touched;
  try { fx.n++; touched = await native.touch({ pr: holder.pr, headSha: front.headSha, ciState: 'running', hardCapMinutes: job.slotHardCapMinutes }); }
  catch { return no('TRAIN_FRONT_BUDGET_SHORT'); }
  if (!touched.onDuty) { fx.n--; return no('NOT_ON_DUTY'); }
  if (touched.touched !== true) return no('TRAIN_FRONT_BUDGET_SHORT');
  actions.touchedRunning = true;
  let again;
  try { again = await native.holders(); } catch { return no('TRAIN_FRONT_BUDGET_SHORT'); }
  const h = again.onDuty && again.holders.length === 1 ? again.holders[0] : null;
  if (!h || h.claimId !== holder.claimId || h.pr !== holder.pr || !(Date.parse(h.mergeSlotUntil) > Date.parse(holder.mergeSlotUntil))
    || !(Date.parse(h.mergeSlotUntil) - clock() >= need)) return no('TRAIN_FRONT_BUDGET_SHORT');
  const batch = { pr: holder.pr, headSha: front.headSha, baseSha: mainSha, testSha: front.testMerge.sha, testTree: front.testMerge.tree, claimId: holder.claimId, since,
    attempt: previous.length + 1 };
  // the attempt is counted before the executor sees the batch; a record that cannot be written opens nothing
  try { await sweepStore.appendFrontBatch({ writtenAt: isoOf(clock()), runId: job.runId, ...batch }); } catch { return no('TRAIN_FRONT_BUDGET_SHORT'); }
  return { decision: 'OPEN_FRONT_BATCH', openFrontBatch: batch };
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
    const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
    const log = observationLog(STATE_V2.trainShadow, job.id);
    const ports = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
    const native = createMergeSlotNative({ config: inputs.record.config, fetchImpl: ports.fetchImpl, nativeToken });
    let ledger = null, sweepStore = null;
    try { ledger = await GreenLedger.open(STATE_V2.greenLedger); } catch { /* listed as nothing; the facts say so */ }
    try { sweepStore = await TrainSweepStore.open(STATE_V2.trainSweep); } catch { /* no sweep state: the sweep is incomplete */ }
    const publications = publicationHeads({ command: input => ports.native.command(input), scope: inputs.record.config.scope, repository: inputs.record.config.repository });
    // §41.4: the front's layer by the held merge-admission policy; a policy that does not load judges every path protected.
    const loaded = loadPolicy(held.policyText);
    const layerOfPaths = loaded.policy ? paths => layerOf(paths, loaded.policy) : () => 'protected';
    return settleTrain({
      run: () => runTrain({ job, github: ports.github, native, ledger, sweepStore, publications, layerOfPaths, claimScope: inputs.record.config.scope }),
      live,
      append: async facts => (await TrainShadowStore.open(STATE_V2.trainShadow)).append(job.runId, facts),
      // DESIGN §41.7: the state areas' retention and the outcome month segments, at most once a day, after the facts are
      // written and inside the stage window; it never fails the run (its pass record and the observation log say what it did).
      retain: () => stateRetention({ runId: job.runId, log, notAfter: started + TRAIN_STAGE_V2.runMilliseconds - 30_000 }) });
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
