// Task 04f9b91b (Fable s7-ruleset-facts 11-22): main's rules as GET /repos/{repo}/rules/branches/main lists them in the
// hosted trial's step S7, when #292 is enabled again next to the scaffold ruleset. #292 pins the resident's six checks to
// this App and four project checks to GitHub Actions, strict on; the scaffold pins seven hosted-* checks to GitHub Actions
// and kooyumi-admission-verified to the admission App 5164952. Several rulesets aggregate: the same name pinned to another
// App is one more requirement, never a different pin of this App's check.
// Shared by the Source v2 tests (train-rules, stage 8, stage 10) and the companion's backstop test, so both readers are
// checked against one table.
import { REQUIRED_CHECK_NAMES } from '../src/independent-control-checks-v2/train-rules.mjs';

export const APP = 5368905, ACTIONS = 15368, ADMISSION_APP = 5164952;
export const MAIN_RULESET = 24182890, SCAFFOLD_RULESET = 27600001;
export const SIX = Object.freeze([...REQUIRED_CHECK_NAMES]);
export const FOUR = Object.freeze(['ci-suites', 'ci-suites-windows', 'clued-cloud-tests', 'migration-verify']);
export const HOSTED = Object.freeze(['hosted-gitleaks', 'hosted-trivy', 'hosted-contract-placement', 'hosted-ci-suites', 'hosted-ci-suites-windows',
  'hosted-clued-cloud-tests', 'hosted-migration-verify']);
export const ADMISSION = 'kooyumi-admission-verified';

const pins = (names, integration_id) => names.map(context => ({ context, integration_id }));
const requiredRule = (ruleset_id, strict, checks) => ({ type: 'required_status_checks', ruleset_id,
  parameters: { strict_required_status_checks_policy: strict, required_status_checks: checks } });
const pullRule = ruleset_id => ({ type: 'pull_request', ruleset_id, parameters: { allowed_merge_methods: ['merge', 'squash', 'rebase'], required_approving_review_count: 0 } });

// #292 alone (today). pin: where the six are pinned (another App: a disaster-recovery switch); extra: more entries in its list.
export const mainRules = ({ pin = APP, strict = true, extra = [] } = {}) => [{ type: 'deletion', ruleset_id: MAIN_RULESET }, pullRule(MAIN_RULESET),
  requiredRule(MAIN_RULESET, strict, [...pins(SIX, pin), ...pins(FOUR, ACTIONS), ...extra])];
// The scaffold ruleset alone (S5, S6).
export const scaffoldRules = () => [pullRule(SCAFFOLD_RULESET), requiredRule(SCAFFOLD_RULESET, false, [...pins(HOSTED, ACTIONS), { context: ADMISSION, integration_id: ADMISSION_APP }])];
// Both (S7).
export const s7Rules = () => [...mainRules(), ...scaffoldRules()];

// One table for both readers (train-rules.mjs#rulesetFacts and ruleset-backstop.mjs#rulesFacts): is this App's pin of the six
// checks in force under these rules?
export const PIN_TABLE = Object.freeze([
  ['today (#292 only)', mainRules(), true],
  ['S5/S6 (scaffold only)', scaffoldRules(), false],
  ['S7 (#292 and scaffold)', s7Rules(), true],
  ['disaster recovery (the six pinned to another App)', mainRules({ pin: ADMISSION_APP }), false],
  ['one of the six also listed without an App', mainRules({ extra: [{ context: 'gitleaks' }] }), false],
  ['S7 plus one of the six without an App', [...s7Rules(), requiredRule(SCAFFOLD_RULESET + 1, false, [{ context: 'trivy', integration_id: null }])], false],
  ['one of the six only pinned to another App', mainRules({ pin: APP }).map(r => r.type !== 'required_status_checks' ? r
    : { ...r, parameters: { ...r.parameters, required_status_checks: r.parameters.required_status_checks.map(c => c.context === 'trivy' ? { ...c, integration_id: ADMISSION_APP } : c) } }), false],
]);

// A completed check run on head for the inventory (GET /commits/{sha}/check-runs).
export const checkRun = (id, name, app, headSha, conclusion = 'success') => ({ id, name, head_sha: headSha, app: { id: app }, status: 'completed', conclusion });
// Every required check of s7Rules() green on head.
export const s7Green = headSha => {
  let id = 0;
  return [...SIX.map(n => checkRun(++id, n, APP, headSha)), ...FOUR.map(n => checkRun(++id, n, ACTIONS, headSha)),
    ...HOSTED.map(n => checkRun(++id, n, ACTIONS, headSha)), checkRun(++id, ADMISSION, ADMISSION_APP, headSha)];
};
