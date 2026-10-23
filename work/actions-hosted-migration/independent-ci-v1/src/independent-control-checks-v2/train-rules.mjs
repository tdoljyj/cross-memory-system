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
// The step 3a code always runs with the train off (TRAIN_MODE_DEFAULT); step 3c brings the policy setting. Pure.
export const TRAIN_MODES = Object.freeze(['off', 'shadow', 'on']);
export const TRAIN_MODE_DEFAULT = 'off';
export const REQUIRED_CHECK_NAMES = Object.freeze(['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot']);
// Not ready, with zero side effects and before any journal write: the resident parks the batch and tries again.
export const RULESET_UNREADABLE = 'RULESET_UNREADABLE';
export const STRICT_OFF_WITHOUT_TRAIN = 'STRICT_OFF_WITHOUT_TRAIN';
export const MERGE_METHODS_NOT_MERGE_ONLY = 'MERGE_METHODS_NOT_MERGE_ONLY';
export const TRAIN_TEST_MERGE_NOT_READY = 'TRAIN_TEST_MERGE_NOT_READY';
// Final for this head: GitHub's merge of exactly [T, H] is not the tree that was tested.
export const TRAIN_TEST_MERGE_TREE_DIFFERS = 'TRAIN_TEST_MERGE_TREE_DIFFERS';

const SHA = /^[a-f0-9]{40}$/;
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };

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

// Rule 7 of §5.3, after the write: the PR was merged (auto-merge merges within seconds of the green), and the merge
// commit is exactly [T, H] with the tested tree. Then the green did what it was for: success, never revoked.
export function mergedAsTested({ pull, mergeCommit, job, testTree }) {
  return plain(job) && SHA.test(testTree ?? '') && plain(pull) && pull.number === job.pr && pull.merged === true && pull.state === 'closed'
    && pull.head?.sha === job.headSha && pull.base?.ref === 'main' && SHA.test(pull.merge_commit_sha ?? '')
    && plain(mergeCommit) && mergeCommit.sha === pull.merge_commit_sha && sameParents(mergeCommit, job.baseSha, job.headSha) && mergeCommit.tree === testTree;
}
