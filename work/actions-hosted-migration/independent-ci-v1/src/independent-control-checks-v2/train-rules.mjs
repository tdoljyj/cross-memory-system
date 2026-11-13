// Resident quota redesign phase 2, step 3a (design v0.5 §5.3 rules 3, 5 and 7; Owner decision 0bb98194): the stage-8
// facts that do not come from Native, read live from GitHub right before the control pair is written:
//   - the branch rules of main (GET /repos/{repo}/rules/branches/main): the six required checks must all still be pinned
//     to App 5368905, and `strict` must be on unless the node runs the merge train (with the train on, merges must be
//     merge commits only);
//   - GitHub's test merge of the PR (pull.merge_commit_sha): exactly the two parents [T, H] (T = main's tip the batch was
//     tested on, H = the PR head) and the tree that was tested. Outside the train the tested tree is H's own (H contains
//     T, so the test merge changes nothing); step 3b brings the train's own test commit S.
// A commit is compared by its parents and tree, never by the test merge's SHA: GitHub may regenerate refs/pull/<n>/merge
// with a new SHA for the same parents and tree (design review n-m5).
// The installed policy's train.enabled reaches stages 1 and 8 through train-mode.mjs (default off).
// Merge train (DESIGN §41.2): with the train on, a green also needs the single-green proof of stage 10 (trainHeadDecision).
// Pure.
import { isTrainFrontJobV2, sameClaimGeneration, validateClaimGeneration } from '../job-v2.mjs';
import { validateStrictProof, validateStrictFrontProof, recordFollows } from './train-strict.mjs';

export const TRAIN_MODES = Object.freeze(['off', 'shadow', 'on']);
// resident ADR 0018 §8 item 3 (train-landing.mjs#TRAIN_ONLY_CHECK, inlined: this module stays free of the landing module).
export const TRAIN_ONLY_CHECK = 'kooyumi-train-landed';
export const TRAIN_MODE_DEFAULT = 'off';
export const REQUIRED_CHECK_NAMES = Object.freeze(['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot']);
// Not ready, with zero side effects and before any journal write: the resident parks the batch and tries again.
export const RULESET_UNREADABLE = 'RULESET_UNREADABLE';
export const REQUIRED_CHECK_FAILED = 'REQUIRED_CHECK_FAILED';
export const REQUIRED_CHECKS_UNREADABLE = 'REQUIRED_CHECKS_UNREADABLE';
export const STRICT_OFF_WITHOUT_TRAIN = 'STRICT_OFF_WITHOUT_TRAIN';
export const MERGE_METHODS_NOT_MERGE_ONLY = 'MERGE_METHODS_NOT_MERGE_ONLY';
export const TRAIN_TEST_MERGE_NOT_READY = 'TRAIN_TEST_MERGE_NOT_READY';
// Final for this head: GitHub's merge of exactly [T, H] is not the tree that was tested.
export const TRAIN_TEST_MERGE_TREE_DIFFERS = 'TRAIN_TEST_MERGE_TREE_DIFFERS';
// Merge train (§41.2, §41.4), all with zero side effects: a train front job (S != H) while the train is not on (stages 1
// and 8); a green the sweep proof and the live facts do not cover (the batch waits for the next stage 10); and the front
// batch's S that GitHub no longer has (404) or that is not the test merge of [T, H] (final: stage 10 opens a new batch).
export const TRAIN_FRONT_JOB_WITHOUT_TRAIN = 'TRAIN_FRONT_JOB_WITHOUT_TRAIN';
export const TRAIN_SINGLE_GREEN_NOT_PROVEN = 'TRAIN_SINGLE_GREEN_NOT_PROVEN';
export const TRAIN_TEST_COMMIT_GONE = 'TRAIN_TEST_COMMIT_GONE';
export const trainFrontRefused = (job, trainMode) => trainMode !== 'on' && isTrainFrontJobV2(job);
// The same refusal when the stage directory's train-mode.json exists but cannot be read or is not exactly the record
// (review R1 m4): the mode is unknown rather than off, so the front batch parks instead of using up one of its attempts.
export const TRAIN_MODE_UNREADABLE = 'TRAIN_MODE_UNREADABLE';
export const trainFrontRefusal = trainModeUnreadable => (trainModeUnreadable === true ? TRAIN_MODE_UNREADABLE : TRAIN_FRONT_JOB_WITHOUT_TRAIN);

const SHA = /^[a-f0-9]{40}$/;
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const TASK_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function projectedHolderForJob(h, job, claimId) {
  if (!plain(h) || h.claimId !== claimId || !TASK_UUID.test(h.taskId ?? '') || !Array.isArray(h.boundPrs)
    || h.boundPrs.length > 50 || new Set(h.boundPrs).size !== h.boundPrs.length
    || h.boundPrs.some(ref => typeof ref !== 'string' || !ref.startsWith(`${job.repo}#`)
      || !/^[1-9][0-9]{0,9}$/.test(ref.slice(job.repo.length+1))) || !h.boundPrs.includes(`${job.repo}#${job.pr}`)) return null;
  // Several PRs share the Task's slot. The signed front/batch records below
  // choose this exact PR; the live CI head must still be its tested head.
  if (h.boundPrs.length > 1 && (!['running','green'].includes(h.ciState) || h.ciHeadSha !== job.headSha)) return null;
  return { ...h, pr: job.pr, boundPr: `${job.repo}#${job.pr}` };
}
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };

// Only a confirmed terminal failure blocks queue participation. A newer rerun
// supersedes an old failure; unrelated checks and another App's checks do not.
export function requiredCheckFailure(rules, inventory, headSha, appId) {
  rulesetFacts(rules, appId);
  check(inventory?.complete === true && Array.isArray(inventory.checks), REQUIRED_CHECKS_UNREADABLE);
  const seen = new Set();
  for (const c of inventory.checks) {
    check(plain(c) && Number.isSafeInteger(c.id) && c.id > 0 && !seen.has(c.id)
      && c.head_sha === headSha && typeof c.name === 'string' && Number.isSafeInteger(c.app?.id)
      && ['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(c.status)
      && (c.status !== 'completed' || ['success', 'neutral', 'skipped', 'failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(c.conclusion)), REQUIRED_CHECKS_UNREADABLE);
    seen.add(c.id);
  }
  const failed = []; let uncertain = false;
  for (const r of rules.filter(r => r.type === 'required_status_checks')) for (const required of r.parameters.required_status_checks) {
    check(typeof required.context === 'string' && (required.integration_id == null || required.integration_id === -1
      || (Number.isSafeInteger(required.integration_id) && required.integration_id > 0)), RULESET_UNREADABLE);
    // This repository's supported producers are the resident's six Native
    // check-runs and GitHub Actions. Legacy/unpinned/unknown providers cannot
    // be qualified from a check-run inventory; park instead of assuming green.
    // resident ADR 0018 §8 item 3: kooyumi-train-landed (pinned to this App) is known and never published: absent is not a failure.
    if (required.integration_id === appId && required.context === TRAIN_ONLY_CHECK) continue;
    if (!(required.integration_id === 15368 || (required.integration_id === appId && REQUIRED_CHECK_NAMES.includes(required.context)))) uncertain = true;
    const matches = inventory.checks.filter(c => c.name === required.context
      && (!(required.integration_id > 0) || c.app.id === required.integration_id));
    const latest = matches.reduce((a, c) => !a || c.id > a.id ? c : a, null);
    if (latest?.status === 'completed' && !['success', 'neutral', 'skipped'].includes(latest.conclusion)) failed.push(required.context);
  }
  // A proven failed required check remains failed even if another provider
  // is unsupported. An unknown-only configuration never joins or extends.
  check(failed.length > 0 || !uncertain, REQUIRED_CHECKS_UNREADABLE);
  return [...new Set(failed)].sort();
}

// The rules GitHub applies to main, reduced to the three facts stage 8 needs. Anything that is not exactly understood is
// unreadable: no required_status_checks rule (the ruleset disabled), one of the six checks missing or pinned to another
// integration (a disaster-recovery switch), a malformed rule.
export function rulesetFacts(rules, appId) {
  check(Array.isArray(rules) && rules.length < 100 && rules.every(r => plain(r) && typeof r.type === 'string' && r.type.length > 0), RULESET_UNREADABLE);
  const required = rules.filter(r => r.type === 'required_status_checks');
  check(required.length > 0 && required.every(r => plain(r.parameters) && Array.isArray(r.parameters.required_status_checks)
    && typeof r.parameters.strict_required_status_checks_policy === 'boolean'), RULESET_UNREADABLE);
  const pinned = new Map();
  for (const r of required) for (const c of r.parameters.required_status_checks) {
    check(plain(c) && typeof c.context === 'string', RULESET_UNREADABLE);
    if (!REQUIRED_CHECK_NAMES.includes(c.context)) continue;
    // A required check without an integration accepts any App: never this check's pin.
    check(c.integration_id === appId, RULESET_UNREADABLE);
    pinned.set(c.context, true);
  }
  check(REQUIRED_CHECK_NAMES.every(n => pinned.get(n) === true), RULESET_UNREADABLE);
  // Several rulesets aggregate, the strictest wins: strict holds if any rule asks for it; the merge methods allowed are
  // the ones every pull_request rule allows. No pull_request rule, or one whose methods cannot be read, is unknown, so
  // never "merge only"; that only matters to the train, never a reason to refuse the rules (review N6).
  const strict = required.some(r => r.parameters.strict_required_status_checks_policy === true);
  const prRules = rules.filter(r => r.type === 'pull_request');
  const readable = prRules.every(r => plain(r.parameters) && Array.isArray(r.parameters.allowed_merge_methods)
    && r.parameters.allowed_merge_methods.every(m => typeof m === 'string'));
  const methods = prRules.length === 0 || !readable ? null
    : ['merge', 'squash', 'rebase'].filter(m => prRules.every(r => r.parameters.allowed_merge_methods.includes(m)));
  return { requiredPinned: true, strict, mergeOnly: methods !== null && methods.length === 1 && methods[0] === 'merge' };
}

// Rule 5 of §5.3: may stage 8 write a green at all under these rules? null when it may.
export function rulesetDecision(facts, trainMode = TRAIN_MODE_DEFAULT) {
  check(TRAIN_MODES.includes(trainMode), 'TRAIN_MODE_REFUSED');
  if (!plain(facts) || facts.requiredPinned !== true || typeof facts.strict !== 'boolean') return RULESET_UNREADABLE;
  if (trainMode !== 'on') return facts.strict ? null : STRICT_OFF_WITHOUT_TRAIN;
  return facts.strict || facts.mergeOnly === true ? null : MERGE_METHODS_NOT_MERGE_ONLY;
}

const sameParents = (commit, t, h) => plain(commit) && Array.isArray(commit.parents) && commit.parents.length === 2 && commit.parents[0] === t && commit.parents[1] === h;

// Rule 3 of §5.3, before the write: GitHub's test merge of the PR is exactly [T, H] with the tested tree. null when it is.
// pull: GET /pulls/<n> as GitHub gives it; mergeCommit: the commit pull.merge_commit_sha names ({sha, tree, parents}).
export function testMergeDecision({ pull, mergeCommit, job, testTree }) {
  check(plain(job) && SHA.test(job.headSha ?? '') && SHA.test(job.baseSha ?? '') && SHA.test(testTree ?? ''), 'TRAIN_TEST_SUBJECT_REQUIRED');
  if (!plain(pull) || pull.number !== job.pr || pull.state !== 'open' || pull.head?.sha !== job.headSha) return TRAIN_TEST_MERGE_NOT_READY;
  // Still being computed (mergeable null), not mergeable, or no test merge yet: wait (GitHub recomputes after a push or
  // after main moves; the main-tip check already holds main at T).
  if (pull.mergeable !== true || !SHA.test(pull.merge_commit_sha ?? '')) return TRAIN_TEST_MERGE_NOT_READY;
  if (!plain(mergeCommit) || mergeCommit.sha !== pull.merge_commit_sha || !SHA.test(mergeCommit.tree ?? '')) return TRAIN_TEST_MERGE_NOT_READY;
  // A test merge on other parents is GitHub not yet recomputed (main or the head moved a moment ago): wait.
  if (!sameParents(mergeCommit, job.baseSha, job.headSha)) return TRAIN_TEST_MERGE_NOT_READY;
  return mergeCommit.tree === testTree ? null : TRAIN_TEST_MERGE_TREE_DIFFERS;
}

// §41.2 trainHeadReady, read in the same run right before the green (null when it holds):
//   job       the merge-slot job: a train front batch (S != H);
//   claimId   the batch claim (its claim id);
//   holders   merge-slot-native holders(): exactly one, on duty, this claim, bound to this PR, with its front time `takenAt`;
//   proof     the newest sweep proof (train-sweep-store latestProof()): mode on, this PR, H, claim and T (= the job's base),
//             written in this front tenure (its `since` is the holder's) and within proof.sweepFreshMs, clean, nothing
//             unconfirmed, a full on-mode sweep since the train went on (or this node took over);
//             The store read no torn or foreign file (a newer proof that cannot be read is never replaced by an older one);
//             §41.2 "台账里没有未确认的撤销" is read here: stage 10 records an unconfirmed revocation only in its proof (clean
//             false, unconfirmed > 0) and ledgers `revoked` only once both read-backs confirmed it, so the ledger cannot show one;
//   front     the newest front batch stage 10 opened for this head (train-sweep-store frontBatches()): this claim, T and S;
//   ledger    the green ledger's list(): complete (no refused file), and no green of any other subject recorded after the proof;
//   pulls     the repository's PRs read now by updated time (github.mjs readPullsUpdatedSince: {complete, pulls: [{number,
//             updatedAt}]}, back to the proof's cursor): no PR but the front updated after proof.prUpdatedCursor (a push, a
//             reopen, a base change).
export function trainHeadDecision({ job, claimId, holders, proof, storeRefused = 0, front, ledger, pulls, now,
  strictProof = null, strictStoreRefused = 0, liveRules = null, observedClaim = null, batchClaim = null, testTree = null }) {
  const no = TRAIN_SINGLE_GREEN_NOT_PROVEN, at = v => (typeof v === 'string' ? Date.parse(v) : NaN);
  if (!plain(job) || !isTrainFrontJobV2(job) || typeof claimId !== 'string' || !Number.isSafeInteger(now)) return no;
  if (!plain(holders) || holders.onDuty !== true || !Array.isArray(holders.holders) || holders.holders.length !== 1) return no;
  const h = projectedHolderForJob(holders.holders[0], job, claimId), since = at(h?.takenAt);
  if (!plain(h) || h.claimId !== claimId || h.pr !== job.pr || h.boundPr !== `${job.repo}#${job.pr}` || !Number.isFinite(since)) return no;
  if (!plain(proof) || proof.mode !== 'on' || proof.pr !== job.pr || proof.headSha !== job.headSha || proof.claimId !== claimId || proof.mainSha !== job.baseSha) return no;
  let limited = false;
  if (proof.fullSweepSinceOn !== true && liveRules?.strict === true && strictStoreRefused === 0) {
    try {
      validateStrictProof(strictProof);
      validateClaimGeneration(observedClaim); validateClaimGeneration(batchClaim);
      // This is the runtime exception binding, not an epoch stamped by Stage 10. Old batches with a changed claim
      // generation fail here as well as the unchanged Native publisher boundary. New batches revalidate the exception.
      limited = sameClaimGeneration(observedClaim, batchClaim) && observedClaim.claimId === claimId
        && strictProof.repo === job.repo && strictProof.sourceManifestSha256 === job.sourceManifestSha256 && strictProof.mainSha === job.baseSha
        && strictProof.front.pr === job.pr && strictProof.front.headSha === job.headSha && strictProof.front.claimId === claimId
        && at(strictProof.front.since) === since && at(strictProof.onSince) <= at(strictProof.writtenAt)
        && at(strictProof.writtenAt) >= at(proof.writtenAt) && at(strictProof.writtenAt) >= since && at(strictProof.writtenAt) <= now
        && at(strictProof.writtenAt) >= now - strictProof.sweepFreshMs && strictProof.sweepFreshMs === proof.sweepFreshMs
        && strictProof.slotHardCapMinutes === proof.slotHardCapMinutes;
    } catch { limited = false; }
  }
  if (limited) proof = { ...proof, writtenAt: strictProof.writtenAt, prUpdatedCursor: strictProof.prUpdatedCursor };
  const written = at(proof.writtenAt), cursor = at(proof.prUpdatedCursor);
  if (at(proof.since) !== since || !(written >= since) || !(written <= now) || !Number.isSafeInteger(proof.sweepFreshMs) || !(written >= now - proof.sweepFreshMs)
    || proof.clean !== true || proof.unconfirmed !== 0 || (proof.fullSweepSinceOn !== true && !limited) || !Number.isFinite(cursor) || storeRefused !== 0) return no;
  if (!plain(front) || front.pr !== job.pr || front.headSha !== job.headSha || front.baseSha !== job.baseSha || front.testSha !== job.testSha || front.claimId !== claimId
    || (limited && (at(front.since) !== since || !SHA.test(testTree ?? '') || front.testTree !== testTree))) return no;
  if (!plain(ledger) || !Array.isArray(ledger.entries) || !Array.isArray(ledger.refused) || ledger.refused.length !== 0
    || ledger.entries.some(r => !plain(r?.entry) || !Number.isFinite(at(r.entry.at)) || (at(r.entry.at) > written && r.entry.phase !== 'revoked'
      && !(r.entry.pr === job.pr && r.entry.headSha === job.headSha && r.entry.baseSha === job.baseSha)))) return no;
  if (!plain(pulls) || pulls.complete !== true || !Array.isArray(pulls.pulls)
    || pulls.pulls.some(p => !plain(p) || !Number.isSafeInteger(p.number) || !Number.isFinite(at(p.updatedAt)) || (p.number !== job.pr && at(p.updatedAt) > cursor))) return no;
  return null;
}

// This proves the present subject only. It does not assert that any other head
// lost its old checks, and cannot replace the full/frozen rewrite procedure.
export function strictFrontHeadDecision({ job, holders, frontProof, proof, fullState, front, ledger, now,
  liveRules, liveMainSha, observedClaim, batchClaim, testTree, nativeMode, sourceHealthy = false, storeHealthy = false }) {
  const no = TRAIN_SINGLE_GREEN_NOT_PROVEN;
  try {
    if (!plain(job) || !isTrainFrontJobV2(job) || !Number.isSafeInteger(now) || !['normal', 'efficiency'].includes(nativeMode)
      || liveRules?.strict !== true || liveRules.requiredPinned !== true || liveMainSha !== job.baseSha || !sourceHealthy || !storeHealthy) return no;
    validateStrictFrontProof(frontProof);
    validateClaimGeneration(observedClaim); validateClaimGeneration(batchClaim);
    if (!sameClaimGeneration(observedClaim, batchClaim) || frontProof.front.claimId !== observedClaim.claimId
      || frontProof.repo !== job.repo || frontProof.sourceManifestSha256 !== job.sourceManifestSha256 || frontProof.mainSha !== job.baseSha) return no;
    if (!plain(holders) || holders.onDuty !== true || !Array.isArray(holders.holders) || holders.holders.length !== 1) return no;
    const h = projectedHolderForJob(holders.holders[0], job, observedClaim.claimId), since = Date.parse(h?.takenAt ?? ''), written = Date.parse(frontProof.writtenAt);
    if (h?.claimId !== observedClaim.claimId || h.pr !== job.pr || h.boundPr !== `${job.repo}#${job.pr}`
      || !Number.isFinite(since) || Date.parse(frontProof.front.since) !== since || frontProof.front.pr !== job.pr
      || frontProof.front.headSha !== job.headSha || written < since || written > now || now - written >= frontProof.sweepFreshMs) return no;
    // A durable anchor is required after Stage10. An empty store with a proof
    // is state loss, not a fresh cold bootstrap. A stale/different tip must be
    // reconciled by Stage10 before another current-front certificate is used.
    if (!plain(fullState) || fullState.mode !== 'on' || fullState.mainSha !== job.baseSha
      || fullState.allPending === 'TRAIN_MAIN_REWRITTEN' || fullState.full?.reason === 'TRAIN_MAIN_REWRITTEN'
      || fullState.full?.onSince !== frontProof.onSince) return no;
    // clean=false with zero unconfirmed is ordinary incomplete history. It is
    // not changed to true and is not confused with a pending negative effect.
    if (proof !== null && (!plain(proof) || proof.unconfirmed !== 0)) return no;
    if (!recordFollows(proof, fullState) || !recordFollows(frontProof, fullState) || !recordFollows(frontProof, proof)) return no;
    if (!plain(front) || front.pr !== job.pr || front.headSha !== job.headSha || front.baseSha !== job.baseSha
      || front.testSha !== job.testSha || !SHA.test(testTree ?? '') || front.testTree !== testTree
      || front.claimId !== observedClaim.claimId || Date.parse(front.since) !== since) return no;
    if (!plain(ledger) || !Array.isArray(ledger.entries) || !Array.isArray(ledger.refused) || ledger.refused.length !== 0) return no;
    return null;
  } catch { return no; }
}

// Rule 7 of §5.3, after the write: the PR was merged (auto-merge merges within seconds of the green), and the merge
// commit is exactly [T, H] with the tested tree. Then the green did what it was for: success, never revoked.
export function mergedAsTested({ pull, mergeCommit, job, testTree }) {
  return plain(job) && SHA.test(testTree ?? '') && plain(pull) && pull.number === job.pr && pull.merged === true && pull.state === 'closed'
    && pull.head?.sha === job.headSha && pull.base?.ref === 'main' && SHA.test(pull.merge_commit_sha ?? '')
    && plain(mergeCommit) && mergeCommit.sha === pull.merge_commit_sha && sameParents(mergeCommit, job.baseSha, job.headSha) && mergeCommit.tree === testTree;
}
