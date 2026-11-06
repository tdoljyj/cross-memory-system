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
  layerOfPaths = () => 'protected' }, fx) {
  validateTrainRun(job);
  const started = clock(), at = isoOf(started), acting = job.mode !== 'shadow';
  const { github, counter } = countedGithub(plainGithub);
  const actions = { ...NO_ACTIONS, revokeHead: job.revokeHeadRequestId ? { requestId: job.revokeHeadRequestId, done: false } : null };
  const until = { write: started + REVOKE_WRITE_BEFORE_MS, read: started + STAGE_WORK_BEFORE_MS };
  const duty = await native.holders();
  let nodes = null, nodesDropped = 0;
  const facts = o => ({ facts: trainFacts({ mode: job.mode, at, nodes, nodesDropped, actions, ...o }), sideEffects: fx.n });

  if (!duty.onDuty) {
    if (!acting) return facts({ onDuty: false, holders: [], mainSha: null, rules: null, front: null, revoke: [], ledger: null });
    // §41.6: this node's own greens need no role (a revocation only makes things stricter); nobody else's are touched.
    const own = await revokeOwnOnly({ github, ledger, appId, clock, sleep, started, until, fx });
    return facts({ onDuty: false, holders: [], mainSha: own.mainSha, rules: null, front: null, revoke: own.targets, ledger: own.summary, decision: 'NOT_ON_DUTY',
      sweep: sweepFacts({ kind: 'incremental', complete: false, revoked: own.revoked, unconfirmed: own.unconfirmed, would: own.targets.length, counter, started, clock }) });
  }
  // §41.6 Source check (on only), from ci_nodes_status (step 2b; never from holders: review R1 MAJOR-1). Every node heard
  // within 24 hours runs this Source, or on mode does not run. No record (a server before 2b, a node never heard, a
  // connection with no node) is not compared. An answer that cannot be read defers (TRAIN_SOURCE_UNREADABLE, nothing
  // written): with 2b deployed a failed read is not "no record", and the check is the only guard against a mixed fleet.
  if (job.mode === 'on') {
    let status = null;
    try { status = await native.nodesStatus(); } catch { status = null; }
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
  // A record from before generation 15 reads as: no main tip recorded, not rewritten, a round of scope 'all' (it enumerated everything).
  const stored = state ?? { mode, incrementalCursor: null, full: freshFull(), inMain: [] };
  const before = { mainSha: null, mainRewritten: false, ...stored, full: { scope: 'all', scopeReason: null, ...stored.full } };
  const cursor = before.incrementalCursor;
  let full = { ...before.full };
  // Generation 15 (DESIGN 60, option c1): was main rewritten since this node last saw it (the main tip the last run of this mode
  // recorded)? Then heads of merged pulls may have left main: the cross-run "in main" cache is dropped now, a running round is
  // restarted, and every round until one of scope 'all' completes enumerates everything (mainRewritten). No tip recorded (the first
  // run of this mode, or a record from before generation 15): the next round enumerates everything too. Not readable: this run's
  // sweep is incomplete and nothing is recorded, so the next run asks again.
  let history = 'same';
  if (!before.mainSha) history = 'none';
  else if (before.mainSha !== mainSha) {
    try {
      const c = await github.readCompare(before.mainSha, mainSha);
      history = c?.behindBy === 0 && ['ahead', 'identical'].includes(c.status) ? 'forward' : 'rewritten';
    } catch (e) { history = e?.code === 'github_http_404' ? 'rewritten' : 'unknown'; }
  }
  if (history === 'unknown') stateReason ??= 'TRAIN_MAIN_HISTORY_UNREADABLE';
  const mainRewritten = before.mainRewritten || history === 'rewritten';
  const onSinceMs = job.onSince ? Date.parse(job.onSince) : null;
  // Only a full sweep of this node counts (via 'sweep'). §41.6's watermark take-over is not used (review R2 B1): the stream
  // (revocations_list) lists open publications only, so another node's published greens are invisible to an incremental
  // sweep from a watermark. Until a read-only channel lists them, every take-over is a full on-mode sweep; the watermark
  // is still reported (harmless) and the stream stays an extra source.
  const sinceOn = f => f.state === 'complete' && f.via === 'sweep' && onSinceMs !== null && Date.parse(f.startedAt) >= onSinceMs;
  const start = () => ({ ...freshFull(), state: 'running', via: 'sweep', startedAt: at, onSince: job.onSince, mainSha,
    ...(mainRewritten ? { scope: 'all', scopeReason: 'TRAIN_MAIN_REWRITTEN' } : history === 'none' ? { scope: 'all', scopeReason: 'TRAIN_NO_MAIN_RECORD' } : { scope: 'current' }) });
  const abandon = reason => ({ ...full, state: 'abandoned', reason });
  if (history === 'rewritten' && full.state === 'running') full = abandon('TRAIN_MAIN_REWRITTEN');
  if (job.mode === 'on' && !sinceOn(full)) {
    if (full.state === 'running' && (Date.parse(full.startedAt) < onSinceMs || started - Date.parse(full.startedAt) > job.fullSweepMaxMs))
      full = abandon(Date.parse(full.startedAt) < onSinceMs ? 'TRAIN_FULL_SWEEP_BEFORE_ON' : 'TRAIN_FULL_SWEEP_EXPIRED');
    if (full.state !== 'running' && !(full.state === 'abandoned' && full.reason === 'TRAIN_PULL_OVER_250_COMMITS' && full.onSince === job.onSince)) full = start();
  } else if (job.mode === 'shadow') {
    if (full.state === 'running' && started - Date.parse(full.startedAt) > job.fullSweepMaxMs) full = abandon('TRAIN_FULL_SWEEP_EXPIRED');
    // one shadow round per fullSweepMaxMs is enough to measure it (§41.9 item 2)
    if (full.state === 'none' || (full.state === 'abandoned' && full.reason !== 'TRAIN_PULL_OVER_250_COMMITS')
      || (full.state === 'complete' && started - Date.parse(full.completedAt) > job.fullSweepMaxMs)) full = start();
  }
  const sweeper = createSweeper({ github, appId, mainSha, inMain: ['rewritten', 'unknown'].includes(history) ? [] : before.inMain, clock, until: started + SWEEP_BUDGET_MS });
  let stream = null;
  try { stream = publications ? await publications.heads() : null; } catch { stream = null; }
  // A running full sweep gets its own share of the time: the incremental part never starves it (review R2 M2).
  const wantSegment = full.state === 'running' && job.mode !== 'revoke-only' && !stateReason;
  let incremental = await incrementalSweep({ sweeper, github, entries, stream, cursor, front: frontHead, own, revokeHead: !!job.revokeHeadRequestId, clock,
    until: started + (wantSegment ? SWEEP_BUDGET_MS / 2 : SWEEP_BUDGET_MS) });
  if (incremental.complete && (stateReason || (acting && ledgerReason))) incremental = { ...incremental, complete: false, reason: stateReason ?? ledgerReason };
  const segment = wantSegment ? await fullSweepSegment({ sweeper, github, nextPage: full.nextPage, nextIndex: full.nextIndex, front: frontHead, own, scope: full.scope }) : null;
  const byId = new Map();
  for (const t of [...incremental.targets, ...(segment?.targets ?? [])]) byId.set(t.checkRunId, t);
  let targets = [...byId.values()].sort((a, b) => a.checkRunId - b.checkRunId);

  let revoked = [], unconfirmed = [], leftover = 0, othersRefused = false;
  if (acting && targets.length) {
    // §41.6: greens this node did not ledger (another node's) are revoked only after a fresh holders read with the role
    if (targets.some(t => !t.own)) {
      let again = null;
      try { again = await native.holders(); } catch { again = null; }
      if (!again?.onDuty) { othersRefused = true; targets = targets.filter(t => t.own); }
    }
    const batch = targets.slice(0, MAX_REVOKES_PER_RUN);
    leftover = targets.length - batch.length;
    const r = await revokeGreens({ github, targets: batch, appId, mainSha, ledger, own, clock, sleep, writeUntil: until.write, readUntil: until.read });
    revoked = r.revoked; unconfirmed = r.unconfirmed; fx.n += r.sideEffects;
  }
  const confirmed = unconfirmed.length === 0 && leftover === 0 && !othersRefused;
  const incrementalOk = incremental.complete && (!acting || confirmed);
  const segmentOk = !segment || segment.ok;
  const sweepComplete = incremental.complete && segmentOk && leftover === 0;
  if (frontHead && revoked.some(r => r.headSha === frontHead.headSha)) front = { ...front, green: false };
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
  // The cursor: the newest pull seen when the pass completed; otherwise as far as every pull was judged (progress), so a
  // backlog advances run by run. Acting, only when this run's revocations are all confirmed.
  const advance = !acting || confirmed;
  // mainRewritten ends with the first round of scope 'all' completed after it (rounds running when it began were restarted).
  const after = { mode, incrementalCursor: !advance ? before.incrementalCursor : incrementalOk ? (incremental.newest ?? cursor)
    : (incremental.progress ?? before.incrementalCursor), full, inMain: sweeper.inMain(), mainSha, mainRewritten: mainRewritten && !(completedNow && full.scope === 'all') };
  if (sweepStore && !stateReason && JSON.stringify(after) !== JSON.stringify({ mode, incrementalCursor: before.incrementalCursor, full: before.full, inMain: before.inMain,
    mainSha: before.mainSha, mainRewritten: before.mainRewritten })) {
    try { await sweepStore.writeFullSweep({ writtenAt: isoOf(clock()), runId: job.runId, ...after }); } catch { /* the next run starts from the older cursor */ }
  }
  const fullSweepSinceOn = acting && sinceOn(full);
  const takeoverPending = job.mode === 'on' && !fullSweepSinceOn;

  // ---- the proof (on, revoke-only): stage 8's single-green evidence for this front, clean or not ----
  let proofWritten = false;
  if (acting && sweepStore) {
    const since = holder ? normal(holder.since ?? holder.takenAt) : null;
    const bound = frontHead && holder.pr && (since || job.mode === 'revoke-only');
    try {
      await sweepStore.appendProof({ writtenAt: isoOf(clock()), runId: job.runId, mode: job.mode, pr: bound ? holder.pr : null, headSha: bound ? frontHead.headSha : null,
        claimId: bound ? holder.claimId : null, since: bound ? since : null, mainSha, clean: sweepComplete && confirmed && incrementalOk, unconfirmed: unconfirmed.length + leftover,
        fullSweepSinceOn, slotHardCapMinutes: job.slotHardCapMinutes, sweepFreshMs: job.sweepFreshMs, prUpdatedCursor: after.incrementalCursor ?? EPOCH });
      proofWritten = true;
    } catch { proofWritten = false; }
  }

  // ---- on only: watermark, keepalive, adopt / return / touch failed, the front batch ----
  let lostDuty = false, requestPause = null, openFrontBatch = null, decision = null, keptAlive = [];
  if (job.mode === 'on') {
    if (completedNow && full.via === 'sweep' && after.incrementalCursor) {
      try {
        const w = await native.reportSweepWatermark({ completedAt: full.completedAt, updatedCursor: after.incrementalCursor, mainSha });
        if (w.recorded) { actions.watermarkReported = true; fx.n++; }
      } catch { /* not deployed, refused or unreadable: informational only (no take-over uses it) */ }
    }
    try {
      const open = (await github.readPullsPage({ state: 'open', sort: 'updated', direction: 'desc', page: 1, perPage: KEEPALIVE_MAX_PRS })).pulls.map(p => p.number);
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
  }
  const wouldDo = decideShadow({ onDuty: true, holders: duty.holders, holder: duty.holders[0] ?? null, front, rules, mainSha });
  if (!acting) decision = wouldDo;
  else if (requestPause) decision = requestPause;
  else if (lostDuty) decision = 'NOT_ON_DUTY';
  else if (unconfirmed.length) decision = 'TRAIN_REVOKE_UNCONFIRMED';
  else if (!sweepComplete || !proofWritten) decision = 'TRAIN_SWEEP_INCOMPLETE';
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
  return facts({ onDuty: true, holders: duty.holders, mainSha, rules, rulesReason, front, revoke: targets.map(t => ({ headSha: t.headSha, checkRunId: t.checkRunId, reason: t.reason, own: t.own })),
    ledger: summary, decision, openFrontBatch, requestPause,
    sweep: sweepFacts({ kind: segment ? 'full-segment' : 'incremental', complete: sweepComplete, revoked: revoked.length, unconfirmed: unconfirmed.length + leftover,
      would: targets.length, full, sinceOn: fullSweepSinceOn, proofWritten, counter, started, clock, mainRewritten: after.mainRewritten }) });
}

// mainRewritten (generation 15): main was rewritten and no round of scope 'all' has completed since (the next round enumerates everything).
const sweepFacts = ({ kind, complete, revoked, unconfirmed, would, full = null, sinceOn = false, proofWritten = false, counter, started, clock, mainRewritten = false }) => ({
  kind, complete, revoked, unconfirmed, wouldRevokeCount: would,
  fullSweep: { state: full?.state ?? 'none', startedAt: full?.startedAt ?? null, completedAt: full?.completedAt ?? null, sinceOn, reason: full?.reason ?? null,
    scope: full && full.state !== 'none' ? full.scope : null, scopeReason: full && full.state !== 'none' ? full.scopeReason : null, mainRewritten },
  proofWritten, calls: counter.calls, ms: Math.max(0, clock() - started) });

// No role (review R2 M3): the front is unknown here (holders answered admission_binding_required), so a green that may be the
// front's legitimate one stays for the role holder's sweep (§41.6a "由 Y 的接班清扫撤掉"). Revoked: this node's own ledgered
// greens not in main that cannot be the front's green, either because their T (the ledger's baseSha) is not main's tip, or
// because the green's head is not the current head of its PR, open (read now; a PR that cannot be read keeps its green).
async function revokeOwnOnly({ github, ledger, appId, clock, sleep, started, until, fx }) {
  const out = { mainSha: null, targets: [], revoked: 0, unconfirmed: 0, summary: null };
  try {
    const { entries, refused } = await ledger.list();
    out.summary = { records: entries.length, refused: refused.length };
    const own = ledgerGreens(entries);
    if (!own.size) return out;
    out.mainSha = (await github.readBranchHead('main')).sha;
    const sweeper = createSweeper({ github, appId, mainSha: out.mainSha, clock, until: started + SWEEP_BUDGET_MS });
    const candidates = (await sweeper.judge([...new Set([...own.values()].map(e => e.headSha))], { front: null, own })).filter(t => t.own);
    const heads = new Map();
    for (const t of candidates) {
      const entry = own.get(t.checkRunId);
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
      writeUntil: until.write, readUntil: until.read });
    out.revoked = r.revoked.length; out.unconfirmed = r.unconfirmed.length + Math.max(0, out.targets.length - MAX_REVOKES_PER_RUN); fx.n += r.sideEffects;
  } catch { /* nothing more without a readable ledger and main */ }
  return out;
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
  const last = previous[0] ?? null;
  const finished = last && job.frontPr === last.pr && job.frontHeadSha === last.headSha && job.frontTestSha === last.testSha && job.frontAttempt === last.attempt;
  if (last && !finished && last.claimId === holder.claimId && last.baseSha === mainSha && (last.testSha === front.testMerge.sha || last.testTree === front.testMerge.tree)
    && holder.ciState === 'running' && holder.ciHeadSha === front.headSha && Date.parse(holder.mergeSlotUntil) > clock()) return no('TRAIN_FRONT_BATCH_RUNNING');
  if (previous.length >= MAX_FRONT_BATCHES_PER_HEAD) return no('TRAIN_FRONT_ATTEMPTS_USED');
  // Without the claim's kept-alive lease (keepalive failed or did not name it; review R2 minor 3) the lease bound is the
  // read-back after touch running below: a merge-slot clock never runs past the claim lease (§41.4 "现状").
  const since = normal(holder.since ?? holder.takenAt), expires = normal(keptAlive.find(k => k.claimId === holder.claimId)?.expiresAt);
  const need = job.frontBatchBudgetMs + STAGE8_ATTEMPT_MS + STAGE_MARGIN_MS;
  const left = now => Math.min(now + RUNNING_CLOCK_MS, Date.parse(since) + job.slotHardCapMinutes * 60_000, expires ? Date.parse(expires) : Infinity) - now;
  if (!since || !(left(clock()) >= need)) return no('TRAIN_FRONT_BUDGET_SHORT');
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
      run: () => runTrain({ job, github: ports.github, native, ledger, sweepStore, publications, layerOfPaths }),
      live,
      append: async facts => (await TrainShadowStore.open(STATE_V2.trainShadow)).append(job.runId, facts),
      // DESIGN §41.7: the state areas' retention and the outcome month segments, at most once a day, after the facts are
      // written and inside the stage window; it never fails the run (its pass record and the observation log say what it did).
      retain: () => stateRetention({ runId: job.runId, log, notAfter: started + TRAIN_STAGE_V2.runMilliseconds - 30_000 }) });
  } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
