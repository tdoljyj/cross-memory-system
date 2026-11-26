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
import { headScansOf, ofJobIds } from '../published-on-github-v2.mjs';

export const TRAIN_MODES = Object.freeze(['off', 'shadow', 'on']);
// resident ADR 0018 §8 item 3 (train-landing.mjs#TRAIN_ONLY_CHECK, inlined: this module stays free of the landing module).
export const TRAIN_ONLY_CHECK = 'kooyumi-train-landed';
export const TRAIN_MODE_DEFAULT = 'off';
export const REQUIRED_CHECK_NAMES = Object.freeze(['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot']);
// R3 lean (FABLE-keep-train-replan-20261122 §1.1; resident DESIGN §82 item 1): the three scans may be required from GitHub Actions
// (integration 15368) instead of this App; the resident then runs no scan of its own for them (executor.mjs#localPlan reads appScans).
export const ACTIONS_INTEGRATION_ID = 15368;
export const RULE_SCAN_NAMES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
// Not ready, with zero side effects and before any journal write: the resident parks the batch and tries again.
export const RULESET_UNREADABLE = 'RULESET_UNREADABLE';
// Task bd07449b: main's rules were not read (readMainRules). RULESET_UNREADABLE is only ever rules read whole that are not this App's six.
export const RULESET_READ_FAILED = 'RULESET_READ_FAILED';
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

// Task bd07449b (PLAN-ruleset-unreadable-park-20261125 §3.1): the one read of main's rules. Every caller of the GitHub port's
// branch-rules read goes through here (train-rules.test.mjs holds that), so two answers that shared one code cannot be mixed up again:
//   - no whole, well-formed reply (the read threw: an error, a timeout, a 5xx, a rate limit, a reply of the wrong shape; or the reply is
//     not complete, or carries no list): RULESET_READ_FAILED. It mends by itself; the resident reads again within minutes.
//   - a whole reply that rulesetFacts refuses (facts() throws RULESET_UNREADABLE): the rules are not this App's six. Reading again gives
//     the same answer until somebody changes the rules; the resident sleeps until they are pinned back.
// -> { rules, facts }: the rules as the port gave them, and facts() = rulesetFacts(rules, appId), computed when asked (stage 10 reads
// appScans from rules that are not the six; the landing route reads the rulesets' ids).
export async function readMainRules(github, appId) {
  let reply;
  try { reply = await github.readBranchRules('main'); } catch { fail(RULESET_READ_FAILED); }
  check(reply?.complete === true && Array.isArray(reply.rules), RULESET_READ_FAILED);
  const rules = reply.rules;
  return { rules, facts: () => rulesetFacts(rules, appId) };
}

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
    // A check pinned to an App is read from that App's check runs (below), whichever App it is: the same name pinned to another App
    // as well (the hosted scaffold ruleset next to #292, task 04f9b91b) is one more requirement, never a doubt about this App's.
    // Two kinds cannot be qualified from a check-run inventory: a check pinned to no App (any App's run or a commit status would
    // do), and one pinned to this App that it does not publish. Park on those instead of assuming green.
    // resident ADR 0018 §8 item 3: kooyumi-train-landed (pinned to this App) is known and never published: absent is not a failure.
    if (required.integration_id === appId && required.context === TRAIN_ONLY_CHECK) continue;
    if (!(required.integration_id > 0) || (required.integration_id === appId && !REQUIRED_CHECK_NAMES.includes(required.context))) uncertain = true;
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

// The one pin rule of the six required checks (R3 open item 2: rulesetFacts, train-landing.mjs#landingRoute's main ruleset; the resident's
// ruleset-backstop.mjs#rulesFacts is another package and is held to the same rule by its own test): a check pinned to this App, or a scan
// pinned to GitHub Actions. A required check without an integration accepts any App: never a pin.
export const pinAllowed = (context, integrationId, appId) => integrationId === appId || (RULE_SCAN_NAMES.includes(context) && integrationId === ACTIONS_INTEGRATION_ID);
// checks: required_status_checks entries ({ context, integration_id }). Every one of the six has an entry pinned as pinAllowed allows,
// and none of their entries is pinned to no App. The same name pinned to another App as well is one more requirement (requiredCheckFailure
// reads that App's runs), not a different pin (task 04f9b91b: the hosted scaffold ruleset next to #292).
export const sixPinned = (checks, appId) => Array.isArray(checks) && REQUIRED_CHECK_NAMES.every(n => {
  const of = checks.filter(c => plain(c) && c.context === n);
  return of.some(c => pinAllowed(n, c.integration_id, appId)) && of.every(c => Number.isSafeInteger(c.integration_id) && c.integration_id > 0);
});

// The rules GitHub applies to main, reduced to the facts stages 8 and 10 need. Anything that is not exactly understood is
// unreadable: no required_status_checks rule (the ruleset disabled), one of the six checks with no entry pinned as pinAllowed allows
// (missing, or moved to another integration: a disaster-recovery switch; a scan may be pinned to this App or to GitHub Actions, R3), an
// entry of one of the six pinned to no App, a malformed rule. Several rulesets aggregate: the same name pinned to another App as well is
// one more requirement, not a different pin (task 04f9b91b; ruleset-backstop.mjs#rulesFacts reads the pin the same way, a test keeps
// the two equal).
// appScans: the scans this App must still publish (pinned to it by at least one rule), in RULE_SCAN_NAMES order.
export function rulesetFacts(rules, appId) {
  check(Array.isArray(rules) && rules.length < 100 && rules.every(r => plain(r) && typeof r.type === 'string' && r.type.length > 0), RULESET_UNREADABLE);
  const required = rules.filter(r => r.type === 'required_status_checks');
  check(required.length > 0 && required.every(r => plain(r.parameters) && Array.isArray(r.parameters.required_status_checks)
    && typeof r.parameters.strict_required_status_checks_policy === 'boolean'), RULESET_UNREADABLE);
  const pins = new Map();
  for (const r of required) for (const c of r.parameters.required_status_checks) {
    check(plain(c) && typeof c.context === 'string', RULESET_UNREADABLE);
    if (!REQUIRED_CHECK_NAMES.includes(c.context)) continue;
    // A required check without an integration accepts any App: never this check's pin, and never read as one.
    check(Number.isSafeInteger(c.integration_id) && c.integration_id > 0, RULESET_UNREADABLE);
    // Pinned to another App: one more requirement on the same name (requiredCheckFailure reads that App's runs), not a pin of the six.
    if (pinAllowed(c.context, c.integration_id, appId)) pins.set(c.context, new Set([...(pins.get(c.context) ?? []), c.integration_id]));
  }
  check(REQUIRED_CHECK_NAMES.every(n => pins.has(n)), RULESET_UNREADABLE);
  const appScans = appScansPinned(rules, appId);
  // Several rulesets aggregate, the strictest wins: strict holds if any rule asks for it; the merge methods allowed are
  // the ones every pull_request rule allows. No pull_request rule, or one whose methods cannot be read, is unknown, so
  // never "merge only"; that only matters to the train, never a reason to refuse the rules (review N6).
  const strict = required.some(r => r.parameters.strict_required_status_checks_policy === true);
  const prRules = rules.filter(r => r.type === 'pull_request');
  const readable = prRules.every(r => plain(r.parameters) && Array.isArray(r.parameters.allowed_merge_methods)
    && r.parameters.allowed_merge_methods.every(m => typeof m === 'string'));
  const methods = prRules.length === 0 || !readable ? null
    : ['merge', 'squash', 'rebase'].filter(m => prRules.every(r => r.parameters.allowed_merge_methods.includes(m)));
  return { requiredPinned: true, strict, mergeOnly: methods !== null && methods.length === 1 && methods[0] === 'merge', appScans };
}

// Task 04f9b91b (admission p90, FABLE-admission-p90-20261122 §3 甲): the scans some rule of main pins to this App, in RULE_SCAN_NAMES
// order, whether or not the six are all pinned. In the scaffold phase main's only rules are the scaffold ruleset (27843120): the six are
// not there (rulesetFacts: unreadable, stage 8 publishes nothing), and no scan is pinned to this App, so the resident runs none
// (executor.mjs#localPlan) instead of 13-15 minutes of scans per batch that nothing can use. A scan pinned to this App by any rule is this
// App's to publish (the same scan pinned to Actions as well does not change that). Rules that are not exactly understood are null, never
// [] (the caller runs every scan): not a list, a malformed rule, no required_status_checks rule, or an entry of a scan pinned to no App
// (any App's run would do: nothing says who publishes it). When rulesetFacts reads the rules, its appScans is this.
export function appScansPinned(rules, appId) {
  if (!Array.isArray(rules) || rules.length >= 100 || !rules.every(r => plain(r) && typeof r.type === 'string' && r.type.length > 0)) return null;
  const required = rules.filter(r => r.type === 'required_status_checks');
  if (required.length === 0 || !required.every(r => plain(r.parameters) && Array.isArray(r.parameters.required_status_checks)
    && typeof r.parameters.strict_required_status_checks_policy === 'boolean')) return null;
  const own = new Set();
  for (const r of required) for (const c of r.parameters.required_status_checks) {
    if (!plain(c) || typeof c.context !== 'string') return null;
    if (!RULE_SCAN_NAMES.includes(c.context)) continue;
    if (!Number.isSafeInteger(c.integration_id) || c.integration_id <= 0) return null;
    if (c.integration_id === appId) own.add(c.context);
  }
  return RULE_SCAN_NAMES.filter(n => own.has(n));
}

// Review of R3, problem A: the scans main's live rules still require from this App (rulesetFacts appScans) must be done for a train front
// subject (H, S) before its stage 8 writes a green or lands S. The resident skips a scan by stage 10's newest read of the rules
// (executor.mjs#localPlan), which may be older than the rules now (the scans pinned back from GitHub Actions to this App), and push checks
// only the other Apps' checks on S (train-landing.mjs#externalChecksDecision): without this, S could land with no scan of this App.
// checks: H's complete check inventory (every App). jobIds: the front subject's job ids (job-v2.mjs#frontJobIdsV2) when S is what lands
// (push): per required scan, the newest of this App's checks of that name on H among the front's own jobs is completed and successful,
// or reuse (the front alone, S has H's tree: rule 41ab823a, resident DESIGN §75) and H carries one the resident reuses
// (published-on-github-v2.mjs#headScansOf). jobIds null when GitHub merges H (github-merge): the newest of this App's checks of that name
// on H, of any job, is completed and successful, which is what GitHub's rule itself asks before it merges.
// appScans not a list (never from rulesetFacts): every scan is required. -> the required scans not done, in RULE_SCAN_NAMES order.
export function appScansNotDone({ appScans, checks, jobIds, headSha, appId, reuse = false }) {
  const required = Array.isArray(appScans) ? RULE_SCAN_NAMES.filter(n => appScans.includes(n)) : [...RULE_SCAN_NAMES];
  if (required.length === 0) return [];
  const list = Array.isArray(checks) ? checks.filter(plain) : [];
  const ids = jobIds instanceof Set ? jobIds : null;
  const reused = reuse && ids ? headScansOf(list, ids, headSha).map(x => x.role) : [];
  return required.filter(n => {
    const newest = list.filter(c => c.name === n && c.app?.id === appId && c.head_sha === headSha && (!ids || ofJobIds(c, ids)))
      .reduce((a, c) => (!a || c.id > a.id ? c : a), null);
    return !(newest?.status === 'completed' && newest.conclusion === 'success') && !reused.includes(n);
  });
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

// GitHub merged the PR at exactly this job's head on this job's base: the PR is merged and closed, its head is H, it targets
// main, and its merge commit is exactly [T, H]. The one statement of "merged at this head" (field defect 2026-11-23, PR #1238 and
// #1239): stage 1 (formal-work-admission-check-v2/publisher.mjs) settles its green on it, and mergedAsTested below adds the tree.
export function mergedAtHead({ pull, mergeCommit, job }) {
  return plain(job) && plain(pull) && pull.number === job.pr && pull.merged === true && pull.state === 'closed'
    && pull.head?.sha === job.headSha && pull.base?.ref === 'main' && SHA.test(pull.merge_commit_sha ?? '')
    && plain(mergeCommit) && mergeCommit.sha === pull.merge_commit_sha && sameParents(mergeCommit, job.baseSha, job.headSha);
}

// Rule 7 of §5.3, after the write: the PR was merged (auto-merge merges within seconds of the green), and the merge
// commit is exactly [T, H] with the tested tree. Then the green did what it was for: success, never revoked.
export function mergedAsTested({ pull, mergeCommit, job, testTree }) {
  return SHA.test(testTree ?? '') && mergedAtHead({ pull, mergeCommit, job }) && mergeCommit.tree === testTree;
}
