// bors-style landing of the merge train (resident ADR 0018; Owner pre-authorization, Task 7d86cf41). With the installed policy's
// train.landing 'push' the train itself fast-forwards main to the commit S its front batch tested (PATCH refs/heads/main
// {sha: S, force: false}) after every live admission passed in the same stage-8 run, instead of writing kooyumi-merge-slot and
// waiting for someone to merge on the PR page. 'github-merge' (the default, also with no file at all) is resident DESIGN §65
// unchanged.
//
// This module is pure except for landMain (which takes the landing port, train-landing-port.mjs) and the stage-directory file
// read (readStageTrainLandingFact). It holds:
//   - the stage file train-landing.json (contract stage-train-landing/1), written create-only by the resident's invoker for
//     stages 8 and 10 only, next to train-mode.json (the C# boundary reads only the files it names, never lists the directory);
//   - batchChainOk: S is the cumulative merge of the batch members on T (one member: exactly [T, H]);
//   - externalChecksDecision: the required checks App 5368905 does not produce (GitHub Actions) on S itself;
//   - landingRoute / readLandingRoute: which way a batch lands, read from main's live rules and this App's own bypass of each ruleset (push, the
//     current github-merge path, or park; ADR 0018 §2 L2 item 7, Fable 2026-11-20); rehearsalOf / validRehearsal: S, what push lacks and this App's bypass state, recorded;
//   - pickMembers and the bisection state (a Mergify-style search for the first failing prefix);
//   - landMain: the one write to main, with its read-backs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sixPinned, readMainRules, rulesetFacts } from './train-rules.mjs';
import { TRAIN_REQUIRED_RUN_FIELDS, TRAIN_BATCH_MEMBER_FIELDS, TRAIN_FAILURE, TRAIN_LANDING_INTENT_FIELDS } from '../merge-train-v2-contract.mjs';

export const LANDING_MODES = Object.freeze(['github-merge', 'push']);
export const LANDING_DEFAULT = 'github-merge';
export const BATCH_MAX_LIMIT = 4;
// ADR 0018 §3 / ADR 0019: a batch of several PRs is tested as the cumulative merge T -> S1 = merge(T, H1) -> S2 = merge(S1, H2) -> ... -> S. The
// bundle (build-bundle.ps1) and the workspace preparation (prepare-workspaces.py) take such an S only from a descriptor /4 that names
// the members, and the resident writes /4 only with an installed Source and a Linux side that take it. Whether they do is not known
// here: the resident says so in the stage file (batchChain, resident engine-windows.mjs#batchChainSupported: the installed Source's
// build-bundle.ps1, prepare-workspaces.py and invoke-stage.mjs carry /4, and both sides run the same generation). No batchChain, or a
// stage file that cannot be read: one PR per batch whatever batchMax says (fail closed).
export const STAGE_TRAIN_LANDING_CONTRACT = 'clued.independent-ci.stage-train-landing/1';
export const STAGE_TRAIN_LANDING_FILE = 'train-landing.json';
export const TRAIN_LANDING_STAGES = Object.freeze([8, 10]);
// The train's own refs (ADR 0018 §2 L1): main only ever fast-forward; these two may be moved by force (CI trigger, cumulative merge).
export const MAIN_REF = 'heads/main';
export const STAGING_REF = 'heads/clued-train/staging';
export const STAGING_TMP_REF = 'heads/clued-train/staging.tmp';
export const STAGING_TMP_BRANCH = 'clued-train/staging.tmp';
export const GENERATION_REF = 'heads/clued-train/generation';
export const ABSENT_OID = '0'.repeat(40);
// ADR 0018 §8 item 3: a required check pinned to App 5368905 that no code ever publishes, so nobody without the ruleset bypass can merge
// on the PR page. requiredCheckFailure knows it (absent is neither a failure nor an unknown provider).
export const TRAIN_ONLY_CHECK = 'kooyumi-train-landed';
export const ACTIONS_APP_ID = 15368;
// Stage-8 answers of push mode. Not ready (zero side effects, the batch parks and stage 8 runs again):
export const TRAIN_LANDING_CHECKS_PENDING = 'TRAIN_LANDING_CHECKS_PENDING';
export const TRAIN_LANDING_RULES_MISSING = 'TRAIN_LANDING_RULES_MISSING';
export const TRAIN_LANDING_REFUSED = 'TRAIN_LANDING_REFUSED';
// Final for this batch, zero side effects: a required check failed on S (the PR's own failure: stage 10 bisects); a member changed
// (head, state, admission, queue) or the chain is not what was recorded (stage 10 composes again); a batch record with riders
// reached a stage 8 that does not push (never a green for a tree a single head was not tested as).
export const TRAIN_LANDING_CHECK_FAILED = 'TRAIN_LANDING_CHECK_FAILED';
export const TRAIN_BATCH_CHANGED = 'TRAIN_BATCH_CHANGED';
export const TRAIN_BATCH_WITHOUT_PUSH = 'TRAIN_BATCH_WITHOUT_PUSH';
// UNCERTAIN: a write whose effect could not be read back.
export const TRAIN_LANDING_UNCONFIRMED = 'TRAIN_LANDING_UNCONFIRMED';
export const LANDING_NOT_READY_REASONS = Object.freeze([TRAIN_LANDING_CHECKS_PENDING, TRAIN_LANDING_RULES_MISSING, TRAIN_LANDING_REFUSED]);
export const LANDING_FINAL_REASONS = Object.freeze([TRAIN_LANDING_CHECK_FAILED, TRAIN_BATCH_CHANGED, TRAIN_BATCH_WITHOUT_PUSH]);
// Bounds of the landing records (train-sweep-store.mjs).
export const MAX_BAD = 200;
export const MAX_ADOPTED = 100;

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const isOid = value => typeof value === 'string' && SHA.test(value) && value !== ABSENT_OID;
const isKey = value => typeof value === 'string' && HASH.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- the stage file ----
// batchChain (ADR 0019): true only in push mode, and only when the resident found that the installed components take a member chain. It is
// written only when true, so every stage file of before ADR 0019 keeps its exact bytes.
export const landingSettings = ({ landing = LANDING_DEFAULT, batchMax = 1, batchChain = false } = {}) => {
  if (!LANDING_MODES.includes(landing) || !Number.isSafeInteger(batchMax) || batchMax < 1 || batchMax > BATCH_MAX_LIMIT || (batchMax > 1 && landing !== 'push')
    || typeof batchChain !== 'boolean' || (batchChain && landing !== 'push')) fail('TRAIN_LANDING_REFUSED');
  return Object.freeze({ landing, batchMax, batchChain });
};
export function stageTrainLandingText(settings) {
  const s = landingSettings(settings);
  return JSON.stringify({ contract: STAGE_TRAIN_LANDING_CONTRACT, landing: s.landing, batchMax: s.batchMax, ...(s.batchChain ? { batchChain: true } : {}) });
}
// Pure: the bytes (or null) -> { landing, batchMax, batchChain, unreadable }. No file is the default (github-merge, 1, no chain); anything
// that is not exactly the record is the default with unreadable true: stage 8 parks a front job, stage 10 does not push.
export function parseStageTrainLanding(bytes) {
  const none = { landing: LANDING_DEFAULT, batchMax: 1, batchChain: false, unreadable: false }, broken = { ...none, unreadable: true };
  if (bytes === null) return none;
  if (!Buffer.isBuffer(bytes) || bytes.length > 256) return broken;
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plain(v) || bytes.toString('utf8') !== stageTrainLandingText(v)) return broken;
    return { landing: v.landing, batchMax: v.batchMax, batchChain: v.batchChain === true, unreadable: false };
  } catch { return broken; }
}
export async function readStageTrainLandingFact(stageDir) {
  const file = path.join(stageDir, STAGE_TRAIN_LANDING_FILE);
  let st;
  try { st = await fs.lstat(file); } catch (e) { return parseStageTrainLanding(e?.code === 'ENOENT' ? null : Buffer.alloc(300)); }
  try {
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 256) return parseStageTrainLanding(Buffer.alloc(300));
    const h = await fs.open(file, 'r');
    try {
      const b = await h.readFile();
      if ((await h.stat()).ino !== st.ino) return parseStageTrainLanding(Buffer.alloc(300));
      return parseStageTrainLanding(b);
    } finally { await h.close(); }
  } catch { return parseStageTrainLanding(Buffer.alloc(300)); }
}
// The batch size stage 10 may compose: 1 unless the stage file says the installed components take a member chain (ADR 0019).
export const effectiveBatchMax = settings => (settings?.landing === 'push' && settings.batchChain === true && settings.unreadable !== true ? settings.batchMax : 1);

// ---- the shape of S ----
// commits: sha -> {sha, tree, parents}. One member: S's parents are exactly [T, H]. N members: S walks back along first parents
// exactly N steps to T, and the k-th step's second parent is member k's head (in batch order).
export function batchChainOk({ commits, baseSha, heads, testSha }) {
  if (!(commits instanceof Map) || !SHA.test(baseSha ?? '') || !SHA.test(testSha ?? '') || !Array.isArray(heads) || heads.length < 1 || heads.length > BATCH_MAX_LIMIT
    || !heads.every(h => SHA.test(h ?? '')) || new Set(heads).size !== heads.length) return false;
  let at = testSha;
  for (let k = heads.length - 1; k >= 0; k--) {
    const c = commits.get(at);
    if (!plain(c) || c.sha !== at || !Array.isArray(c.parents) || c.parents.length !== 2 || c.parents[1] !== heads[k] || !SHA.test(c.parents[0] ?? '')) return false;
    at = c.parents[0];
  }
  return at === baseSha;
}
// Reads the chain's commits through readGitCommit (any port) and checks it; a read that fails proves nothing (false).
// steps (ADR 0019, review 3; optional): the commits the train's own merges returned, in merge order (S1..SN). With it, step k of the chain
// must be exactly that commit, so a staging.tmp moved by anyone else between two merges (a step with the right parents shape but
// other content) never becomes part of S.
export async function readBatchChain({ readGitCommit, baseSha, heads, testSha, steps = null }) {
  const commits = new Map(), walked = [];
  let at = testSha;
  try {
    for (let k = 0; k < heads.length && SHA.test(at ?? ''); k++) {
      const c = await readGitCommit(at);
      if (!plain(c) || c.sha !== at) return { ok: false, tree: null };
      commits.set(at, c);
      walked.unshift(at);
      at = Array.isArray(c.parents) ? c.parents[0] : null;
    }
  } catch { return { ok: false, tree: null }; }
  const stepsOk = steps === null || (Array.isArray(steps) && steps.length === heads.length && steps.every((s, i) => s === walked[i]));
  const ok = stepsOk && batchChainOk({ commits, baseSha, heads, testSha });
  return { ok, tree: ok ? commits.get(testSha).tree : null };
}

// ---- which way a batch lands: main's live rules and this App's own bypass of each ruleset (ADR 0018 §2 L2 item 7; Fable 2026-11-20
// 三态选路, 补：bypass 名单读不到, 补：可绕过字段读不到时) ----
// A package with landing 'push' can push; whether it does is read from main's live rules each time (stage 8 before it writes, stage 10
// when it opens a front batch), by this one function:
//   github-merge  the rules read back completely and kooyumi-train-landed is nowhere in them. The bypass state is NOT looked at: the
//                 current path only writes the control pair and GitHub merges; the publisher never writes main there.
//   push          kooyumi-train-landed pinned to this App in the main ruleset, and: a guard ruleset (its rules on main exactly
//                 non_fast_forward and deletion) applies to main and this App cannot bypass it (never); this App can always bypass the
//                 main ruleset; and this App can always bypass every other ruleset on main (task 04f9b91b, Fable s7-landing-gaps 11-22:
//                 a push must pass every ruleset on main; a fast-forward passes a guard ruleset, any other one only by its bypass, e.g.
//                 the hosted trial's scaffold ruleset with its pull request rule).
//   park          the rules unreadable or read in part; or kooyumi-train-landed read with any of the push conditions not true or not
//                 readable: TRAIN_LANDING_RULES_MISSING, nothing written. Once kooyumi-train-landed is read, never a current-path green.
// The bypass state only matters after kooyumi-train-landed: on the current path it is still read (stage 8) and recorded in the rehearsal
// (bypass.main / bypass.independent), never used to choose. That record is the live, App-token proof that the field is readable, a
// prerequisite of the Owner saving C (ADR 0018 §8 item 7).
// Who else is on a bypass list is not read here: an administrator checks it when the Owner saves the rules.
// missing names what push still lacks (or what could not be read), in a fixed order: independent ruleset, kooyumi-train-landed, main, every
// other ruleset by id (ruleset_can_bypass_unreadable:<id> or ruleset_app_cannot_bypass:<id>).
// The main ruleset is the one ruleset whose required checks hold the six (train-rules.mjs#REQUIRED_CHECK_NAMES), each pinned as
// train-rules.mjs#sixPinned allows: to this App, a scan also to GitHub Actions (then S must carry its Actions run, externalChecksDecision).
// rulesets: id -> { currentUserCanBypass } (github.mjs#readRuleset: current_user_can_bypass, this caller's own bypass of that ruleset:
// always, pull_requests_only, never or exempt; anything else is unreadable), or null when they were not read (stage 10 reads them only
// when kooyumi-train-landed is there: not_read).
export const LANDING_ROUTES = Object.freeze(['push', 'github-merge', 'park']);
const MAX_RULESETS = 10;
const CAN_BYPASS = Object.freeze(['always', 'pull_requests_only', 'never', 'exempt']);
// The bypass states a record may carry: GitHub's four, unreadable (the field not there or not one of the four, or the read failed),
// not_read, and for the independent ruleset absent (there is none).
export const BYPASS_STATES = Object.freeze([...CAN_BYPASS, 'unreadable', 'not_read']);
const MISSING = /^[a-z][a-z_]{1,59}(?::[A-Za-z0-9_.-]{1,40})?$/;
// A list of missing items as landingRoute writes them (the stage-8 outcome, the stage-10 facts): bounded, each a known shape.
export const validLandingMissing = (m, { empty = true } = {}) => Array.isArray(m) && m.length <= 16 && (empty || m.length > 0)
  && m.every(x => typeof x === 'string' && MISSING.test(x)) && new Set(m).size === m.length;
const rulesUnreadable = { route: 'park', missing: ['rules_unreadable'], bypass: { main: 'not_read', independent: 'not_read' } };
// A guard ruleset: its rule types (any order, repeats allowed) are exactly deletion and non_fast_forward ("main 只许快进"). The landing
// precheck's P4 (rollout/landing-precheck.mjs) recognises the independent ruleset by this same function.
const GUARD_TYPES = Object.freeze(['deletion', 'non_fast_forward']);
export const guardRuleset = types => Array.isArray(types) && types.every(t => GUARD_TYPES.includes(t)) && GUARD_TYPES.every(t => types.includes(t));
export function landingRoute({ rules, rulesets, appId }) {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length >= 100 || !rules.every(r => plain(r) && typeof r.type === 'string' && r.type.length > 0
    && Number.isSafeInteger(r.rulesetId) && r.rulesetId > 0)) return rulesUnreadable;
  const checksOf = list => list.filter(r => r.type === 'required_status_checks').flatMap(r => (Array.isArray(r.parameters?.required_status_checks) ? r.parameters.required_status_checks : [null]));
  if (checksOf(rules).some(c => !plain(c) || typeof c.context !== 'string')) return rulesUnreadable;
  const byId = new Map();
  for (const r of rules) byId.set(r.rulesetId, [...(byId.get(r.rulesetId) ?? []), r]);
  if (byId.size > MAX_RULESETS) return rulesUnreadable;
  const pinned = (list, context, app) => checksOf(list).some(c => c.context === context && c.integration_id === app);
  // The main ruleset: the one whose six required checks are pinned by the same rule stages 8 and 10 read (train-rules.mjs#sixPinned; R3 open
  // item 2: the scans may be pinned to GitHub Actions, and push then waits for them on S as external checks, externalRequiredChecks).
  const mains = [...byId].filter(([, list]) => sixPinned(checksOf(list), appId));
  if (mains.length !== 1) return { ...rulesUnreadable, missing: ['main_ruleset_unidentified'] };
  const [mainId, mainRules] = mains[0];
  const canOf = id => {
    if (rulesets === null) return 'not_read';
    const info = rulesets instanceof Map ? rulesets.get(id) : null;
    return plain(info) && CAN_BYPASS.includes(info.currentUserCanBypass) ? info.currentUserCanBypass : 'unreadable';
  };
  const guard = list => guardRuleset(list.map(r => r.type));
  const fastForwardOnly = [...byId.entries()].filter(([id, list]) => id !== mainId && guard(list)).map(([id]) => [id, canOf(id)]);
  const others = [...byId.entries()].filter(([id, list]) => id !== mainId && !guard(list)).map(([id]) => id).sort((a, b) => a - b);
  const states = fastForwardOnly.map(([, s]) => s);
  const independent = states.length === 0 ? 'absent' : states.includes('never') ? 'never'
    : states.find(s => s === 'unreadable' || s === 'not_read') ?? states[0];
  const bypass = { main: canOf(mainId), independent };
  const trainLanded = checksOf(rules).some(c => c.context === TRAIN_ONLY_CHECK);
  const missing = [], unread = s => s === 'unreadable' || s === 'not_read';
  if (independent === 'absent') missing.push('independent_ruleset_missing');
  else if (unread(independent)) for (const [id, s] of fastForwardOnly) { if (unread(s)) missing.push(`ruleset_can_bypass_unreadable:${id}`); }
  else if (independent !== 'never') missing.push('independent_ruleset_app_can_bypass');
  if (!pinned(mainRules, TRAIN_ONLY_CHECK, appId)) missing.push('train_landed_check_missing');
  if (unread(bypass.main)) missing.push(`ruleset_can_bypass_unreadable:${mainId}`);
  else if (bypass.main === 'never') missing.push('main_app_cannot_bypass');
  else if (bypass.main !== 'always') missing.push('main_app_bypass_not_always');
  for (const id of others) {
    const s = canOf(id);
    if (unread(s)) missing.push(`ruleset_can_bypass_unreadable:${id}`);
    else if (s !== 'always') missing.push(`ruleset_app_cannot_bypass:${id}`);
  }
  const route = !trainLanded ? 'github-merge' : missing.length === 0 ? 'push' : 'park';
  return { route, missing: route === 'github-merge' && rulesets === null ? missing.filter(m => !m.startsWith('ruleset_can_bypass_unreadable:')) : missing,
    bypass };
}
// The live read for landingRoute: main's rules (or the ones this run already read), then this App's bypass state of each of their
// rulesets, one GET /rulesets/{id} each (GitHub has no read that returns both). Never throws; a read that fails is that ruleset
// unreadable. Stage 8 records them in the rehearsal; stage 10 (Fable 11-21 open points §5) every round, into its facts' landing.bypass.
export async function readLandingRoute({ github, appId, rules = undefined }) {
  let list = rules;
  if (list === undefined) list = await readMainRules(github, appId).then(read => read.rules, () => null);
  const ids = Array.isArray(list) ? [...new Set(list.map(r => r?.rulesetId))].filter(id => Number.isSafeInteger(id) && id > 0) : [];
  const rulesets = new Map();
  if (ids.length <= MAX_RULESETS && typeof github?.readRuleset === 'function') for (const id of ids) {
    try { const r = await github.readRuleset(id); if (r?.id === id) rulesets.set(id, r); } catch { /* unreadable */ }
  }
  return landingRoute({ rules: list, rulesets, appId });
}
// The rehearsal of push on the current path (Fable 2026-11-20; 11-21 应修 2): what this stage 8 knows when its pair settled, nothing it does
// not: S (testSha), what push still lacks (missing) and this App's own bypass state of the main and the independent ruleset, as read for
// this route (bypass; recorded, never used to choose). S's checks are not in it: they have not finished when stage 8 settles, so a copy here
// is almost always pending; whether every required check can succeed on S is read from GitHub before the Owner saves C (ADR 0018 §8 item 7,
// rollout/landing-precheck.mjs). Recorded only; it never decides anything.
export function rehearsalOf({ testSha, route }) {
  return { testSha, missing: Array.isArray(route?.missing) ? [...route.missing] : [],
    bypass: { main: route?.bypass?.main ?? 'not_read', independent: route?.bypass?.independent ?? 'not_read' } };
}
// The rehearsal record as the stage-8 outcome carries it (resident-v2/stage-inputs.mjs#writeOutcome): exactly the shape above, from this
// publisher's own reads; anything else is left out (null).
export function validRehearsal(r) {
  if (!plain(r) || Object.keys(r).sort().join('|') !== 'bypass|missing|testSha' || !SHA.test(r.testSha ?? '')
    || !plain(r.bypass) || Object.keys(r.bypass).sort().join('|') !== 'independent|main' || !BYPASS_STATES.includes(r.bypass.main)
    || !(BYPASS_STATES.includes(r.bypass.independent) || r.bypass.independent === 'absent') || !validLandingMissing(r.missing)) return null;
  return { testSha: r.testSha, missing: [...r.missing], bypass: { main: r.bypass.main, independent: r.bypass.independent } };
}

// ---- required checks App 5368905 does not produce, on S (ADR 0018 §2 L2 item 5) ----
const INCONCLUSIVE_CHECKS = new Set(['cancelled', 'timed_out', 'stale', 'startup_failure']);
const CHECK_FAILURE_GRACE_MS = 5 * 60_000;

// rules: main's live rules; inventory: { complete, checks } of S itself, even when H has the same tree.
// Every required context pinned to another App (or to none) must have, as its newest check
// run by id of the pinned App, a completed success. N9: unusable verdicts park; a fresh failure gives the repair lane time to act.
// Contexts pinned to appId are the train's own (on H) and are not looked at here.
// The required checks push waits for on S (also the landing precheck's P1 list, review A/B 11-21): every required context of the live
// rules not pinned to appId, each { context, pin } (pin: the App whose runs count, null = any App's), in rule order.
export function externalRequiredChecks({ rules, appId }) {
  const required = [];
  if (Array.isArray(rules)) for (const r of rules) if (plain(r) && r.type === 'required_status_checks' && Array.isArray(r.parameters?.required_status_checks))
    for (const c of r.parameters.required_status_checks) if (plain(c) && typeof c.context === 'string' && c.integration_id !== appId)
      required.push({ context: c.context, pin: Number.isSafeInteger(c.integration_id) && c.integration_id > 0 ? c.integration_id : null });
  return required;
}
// The runs of one such check on commitSha: its name, that commit, and the pinned App's (any App's when not pinned).
export const runsOfRequired = (checks, { context, pin }, commitSha) =>
  checks.filter(k => plain(k) && k.name === context && k.head_sha === commitSha && (pin === null || k.app?.id === pin));
export function externalChecksDecision({ rules, inventory, commitSha, appId, now = Date.now() }) {
  if (!Array.isArray(rules) || inventory?.complete !== true || !Array.isArray(inventory.checks)) return TRAIN_LANDING_CHECKS_PENDING;
  let pending = false;
  for (const c of externalRequiredChecks({ rules, appId })) {
    const runs = runsOfRequired(inventory.checks, c, commitSha);
    const newest = runs.reduce((a, k) => (!a || k.id > a.id ? k : a), null);
    if (!newest || newest.status !== 'completed') { pending = true; continue; }
    if (INCONCLUSIVE_CHECKS.has(newest.conclusion)
      || (newest.conclusion === 'failure' && now - Date.parse(newest.completed_at) < CHECK_FAILURE_GRACE_MS)) {
      pending = true;
      continue;
    }
    if (newest.conclusion !== 'success') return TRAIN_LANDING_CHECK_FAILED;
  }
  return pending ? TRAIN_LANDING_CHECKS_PENDING : null;
}

// A completed Actions check must belong to the shared attempt of this
// batch. Only the registered, provider-observed job can attest a test red.
const TRAIN_STAGING_WORKFLOWS = {
  linux: '.github/workflows/clued-required-tests.yml',
  windows: '.github/workflows/clued-required-tests-windows.yml',
};
const workflowForRun = run => run.checkName.startsWith('hosted-')
  ? '.github/workflows/hosted-required.yml' : TRAIN_STAGING_WORKFLOWS[run.platform];
const TRAIN_TERMINAL_STEP = 'Confirm merge train test failure';

export async function exactTrainChecksDecision({ rules, inventory, batch, github, now = Date.now() }) {
  const wait = { reason: TRAIN_LANDING_CHECKS_PENDING };
  const lists = Array.isArray(rules) ? rules.filter(r => r.type === 'required_status_checks') : [];
  if (!lists.length || lists.some(r => !Array.isArray(r.parameters?.required_status_checks)
    || r.parameters.required_status_checks.some(c => typeof c?.context !== 'string' || !c.context || !positive(c.integration_id))))
    return { reason: TRAIN_LANDING_RULES_MISSING };
  const required = lists.flatMap(r => r.parameters.required_status_checks)
    .filter(c => c.context !== TRAIN_ONLY_CHECK).map(c => ({ context: c.context, pin: c.integration_id }));
  if (!required.length || !SHA.test(batch?.testSha ?? '') || inventory?.complete !== true || !Array.isArray(inventory.checks)
    || inventory.checks.some(c => !positive(c?.id)) || new Set(inventory.checks.map(c => c.id)).size !== inventory.checks.length)
    return wait;

  const registered = new Map();
  if (required.some(c => c.pin === ACTIONS_APP_ID)) {
    if (!Array.isArray(batch.requiredRuns)) return wait;
    for (const run of batch.requiredRuns) {
      if (!plain(run) || TRAIN_REQUIRED_RUN_FIELDS.some(key => !Object.hasOwn(run, key)) || run.testSha !== batch.testSha
        || run.policyVersion !== batch.policyVersion || !Object.hasOwn(TRAIN_STAGING_WORKFLOWS, run.platform)
        || typeof run.checkName !== 'string' || !run.checkName || !positive(run.runId) || !positive(run.attempt)
        || registered.has(run.checkName)) return wait;
      registered.set(run.checkName, { ...Object.fromEntries(TRAIN_REQUIRED_RUN_FIELDS.map(field => [field, run[field]])),
        runId: run.runId, attempt: run.attempt });
    }
    if (required.some(c => c.pin === ACTIONS_APP_ID && !registered.has(c.context))) return wait;
  }

  const observations = new Map();
  let pending = false;
  for (const c of required) {
    const latest = runsOfRequired(inventory.checks, c, batch.testSha).reduce((a, check) => (!a || check.id > a.id ? check : a), null);
    if (latest?.status !== 'completed') { pending = true; continue; }
    if (c.pin !== ACTIONS_APP_ID) {
      pending ||= latest.conclusion !== 'success';
      continue;
    }
    const binding = registered.get(c.context);
    const workflow = workflowForRun(binding);
    const key = workflow + ':' + binding.runId + ':' + binding.attempt;
    if (!observations.has(key)) {
      const observed = await Promise.resolve().then(() => github.readTrainRun({ ...binding, workflow })).catch(() => null);
      observations.set(key, observed);
    }
    const native = observations.get(key);
    const jobs = Array.isArray(native?.jobs) ? native.jobs : [];
    const matches = jobs.filter(job => job.checkRunId === latest.id && job.name === c.context
      && job.status === 'completed' && job.conclusion === latest.conclusion);
    if (matches.length !== 1) { pending = true; continue; }
    if (latest.conclusion === 'success') continue;

    pending = true;
    const steps = Array.isArray(matches[0].steps) ? matches[0].steps.filter(step => step?.name === TRAIN_TERMINAL_STEP) : [];
    if (latest.conclusion !== 'failure' || !(now - Date.parse(latest.completed_at) >= CHECK_FAILURE_GRACE_MS)
      || steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') continue;
    try {
      if (await github.sameTrainWorkflow({ workflow, baseSha: batch.baseSha, testSha: batch.testSha }) !== true) continue;
      const notes = await github.readCheckAnnotations(latest.id);
      const marker = new RegExp('^[a-z0-9-]+ ' + batch.testSha + '$');
      if (Array.isArray(notes) && notes.some(note => note?.annotation_level === 'failure'
        && note.title === 'Merge train test failure' && marker.test(note.message ?? ''))) {
        return { reason: TRAIN_LANDING_CHECK_FAILED, evidence: { ...binding, appId: c.pin, checkRunId: latest.id } };
      }
    } catch { /* a provider read cannot prove a terminal failure */ }
  }
  return pending ? wait : { reason: null, runs: [...registered.values()] };
}

export async function trainV2RulesValid({ rules, appId, readBypass }) {
  if (rulesetFacts(rules, appId).strict !== true) return false;
  const seals = rules.filter(r => r.type === 'required_status_checks')
    .flatMap(r => r.parameters.required_status_checks).filter(c => c.context === TRAIN_ONLY_CHECK);
  if (!seals.length || seals.some(c => c.integration_id !== appId)) return false;
  const byId = new Map();
  for (const rule of rules) {
    if (!positive(rule.rulesetId)) return false;
    const group = byId.get(rule.rulesetId) ?? [];
    group.push(rule.type);
    byId.set(rule.rulesetId, group);
  }
  let hasGuard = false;
  for (const [id, types] of byId) {
    const actors = await readBypass(id);
    const guard = types.length === 2 && types.includes('deletion') && types.includes('non_fast_forward');
    if (!Array.isArray(actors)) return false;
    if (guard) {
      if (actors.length !== 0) return false;
      hasGuard = true;
    } else if (actors.length !== 1 || actors[0]?.actor_id !== appId || actors[0]?.actor_type !== 'Integration' || actors[0]?.bypass_mode !== 'always') return false;
  }
  return hasGuard;
}

function requiredCheckDecisions({ rules, inventory, commitSha, appId }) {
  if (!SHA.test(commitSha ?? '') || !Array.isArray(rules) || inventory?.complete !== true || !Array.isArray(inventory.checks)) return null;
  return externalRequiredChecks({ rules, appId }).map(required => {
    const runs = runsOfRequired(inventory.checks, required, commitSha);
    const latest = runs.reduce((a, k) => (!a || k.id > a.id ? k : a), null);
    return { ...required, latest };
  });
}

// ---- composing a batch (ADR 0018 §3) ----
// front: {pr, headSha, claimId}; candidates: the riders stage 10 found eligible, each {pr, headSha, claimId}, in PR-number order;
// bad: [{pr, headSha}] kept out of riding; suspect: the bisection state (members of the last failed batch not yet cleared) or null;
// max: the effective batch size. -> { members, suspect } (the suspect is null again when its prefix no longer matches).
export function pickMembers({ front, candidates = [], bad = [], suspect = null, max = 1 }) {
  const isBad = m => bad.some(b => b.pr === m.pr && b.headSha === m.headSha);
  const riders = candidates.filter(c => c.pr !== front.pr && !isBad(c)).sort((a, b) => a.pr - b.pr);
  const available = [front, ...riders];
  if (Array.isArray(suspect) && suspect.length > 0) {
    const size = Math.max(1, Math.ceil(suspect.length / 2));
    const prefix = suspect.slice(0, Math.min(size, max));
    if (prefix.every((m, i) => available[i]?.pr === m.pr && available[i].headSha === m.headSha)) return { members: available.slice(0, prefix.length), suspect };
    return { members: available.slice(0, max), suspect: null };
  }
  return { members: available.slice(0, max), suspect: null };
}
// After a batch of members ended. landed: the batch landed (cleared); failed: it finally failed for the PR itself.
// -> { suspect, bad } where bad lists riders now kept out (never the front: a front alone that fails is touch failed).
export function bisectAfter({ suspect = null, members, landed }) {
  const same = (a, b) => a.pr === b.pr && a.headSha === b.headSha;
  if (landed) {
    if (!Array.isArray(suspect) || suspect.length === 0) return { suspect: null, bad: [] };
    const rest = suspect.filter(s => !members.some(m => same(m, s)));
    // [all] failed, the members passed: by the batch's own evidence the failure is in the rest. A single rest member is kept out of
    // riding (it is still tested alone when it becomes the front; only a front alone that fails is final).
    if (rest.length === 1) return { suspect: null, bad: [rest[0]] };
    return { suspect: rest.length ? rest : null, bad: [] };
  }
  if (members.length > 1) return { suspect: members.map(m => ({ pr: m.pr, headSha: m.headSha })), bad: [] };
  return { suspect: null, bad: [] };
}

// ---- the one write to main (ADR 0018 §5) ----
// port: train-landing-port.mjs (fastForwardMain) and readMain(): the current tip of main (any port's branch read). -> one of
//   { state: 'landed', mainSha }           main is S (written now, or already S)
//   { state: 'moved', mainSha }            not a fast-forward and main is neither T nor S: someone moved main (RESIDENT_BASE_MOVED)
//   { state: 'refused', mainSha }          refused while main is still T (rules, bypass, permissions): TRAIN_LANDING_REFUSED
//   { state: 'uncertain', mainSha|null }   the answer was lost and the read-backs did not show S: TRAIN_LANDING_UNCONFIRMED
// sent: whether the PATCH left this host (false only for a refusal before sending).
export async function landMain({ port, readMain, baseSha, testSha, clock = Date.now, sleep = wait, readBackMs = 4_000, readBackEveryMs = 1_000 }) {
  if (!SHA.test(baseSha ?? '') || !SHA.test(testSha ?? '') || typeof port?.fastForwardMain !== 'function' || typeof readMain !== 'function') fail('TRAIN_LANDING_INPUT_REFUSED');
  let answer;
  try { answer = await port.fastForwardMain(testSha); } catch (e) { answer = { status: null, error: e }; }
  const read = async () => { try { const s = await readMain(); return SHA.test(s ?? '') ? s : null; } catch { return null; } };
  if (answer?.status === 200 && answer.sha === testSha) {
    const now = await read();
    if (now === testSha) return { state: 'landed', mainSha: now, sent: true };
  }
  if (answer?.status === 422 || answer?.status === 403 || answer?.status === 409 || answer?.status === 404) {
    const now = await read();
    if (now === testSha) return { state: 'landed', mainSha: now, sent: true };
    if (now === baseSha) return { state: 'refused', mainSha: now, sent: answer?.notSent !== true, status: answer.status };
    if (now !== null) return { state: 'moved', mainSha: now, sent: true, status: answer.status };
    return { state: 'uncertain', mainSha: null, sent: true, status: answer.status };
  }
  // 200 whose read-back did not show S yet, 5xx, a cut connection: read main again within a bounded window. S: landed. Anything else
  // stays uncertain (a gateway may answer before the write lands; the journal keeps it uncertain, never not_sent).
  const until = clock() + readBackMs;
  let last = null;
  for (;;) {
    last = await read();
    if (last === testSha) return { state: 'landed', mainSha: last, sent: true };
    if (clock() + readBackEveryMs > until) break;
    await sleep(readBackEveryMs);
  }
  if (answer?.notSent === true && last === baseSha) return { state: 'refused', mainSha: last, sent: false, status: answer.status ?? null };
  return { state: 'uncertain', mainSha: last, sent: true, status: answer?.status ?? null };
}

export const validTrainMembers = members => Array.isArray(members) && members.length >= 1 && members.length <= BATCH_MAX_LIMIT
  && new Set(members.map(m => m?.pr)).size === members.length
  && members.every(m => plain(m) && TRAIN_BATCH_MEMBER_FIELDS.every(field => Object.hasOwn(m, field))
    && positive(m.pr) && isOid(m.headSha) && typeof m.claimId === 'string' && m.claimId.length > 0 && positive(m.fence) && positive(m.epoch));

function validTrainIntent(intent) {
  return plain(intent) && TRAIN_LANDING_INTENT_FIELDS.every(field => Object.hasOwn(intent, field))
    && [intent.batchId, intent.effectId, intent.slotId].every(isKey) && positive(intent.generation)
    && [intent.baseSha, intent.testSha, intent.generationRefOid].every(isOid) && intent.baseSha !== intent.testSha
    && validTrainMembers(intent.members) && typeof intent.expiresAt === 'string' && Number.isFinite(Date.parse(intent.expiresAt));
}

const validLandingIntent = intent => validTrainIntent(intent) && isOid(intent.landedRefOid) && intent.landedRefOid !== intent.generationRefOid;
const unknown = (refs = null, cause = TRAIN_FAILURE.EFFECT_UNKNOWN) => ({ state: 'unknown', reason: cause.resident, refs });

async function readTrainRefs(readRefs) {
  try {
    const refs = await readRefs();
    return isOid(refs?.mainSha) && isOid(refs?.generationRefOid) ? refs : null;
  } catch { return null; }
}

export async function trainMainContains(github, testSha, mainSha) {
  if (mainSha === testSha) return true;
  const result = await github.readCompare(testSha, mainSha);
  return result?.baseSha === testSha && result?.headSha === mainSha && result?.status === 'ahead'
    && result.behindBy === 0 && result.mergeBaseSha === testSha;
}

// The generation marker remains pinned until Native has recorded the outcome. A response, an old T,
// or main containing S without its completion marker cannot settle an in-flight intent.
export async function reconcileTrainIntent({ intent, readRefs, contains, receipt = null }) {
  if (!validLandingIntent(intent)) fail(TRAIN_FAILURE.LEASE_STALE.resident);
  const refs = await readTrainRefs(readRefs);
  if (!refs) return unknown();
  const wasLanded = receipt?.receiptId && receipt.intent?.effectId === intent.effectId
    && receipt.intent.testSha === intent.testSha && receipt.generationRefOid === intent.landedRefOid;
  if (refs.generationRefOid === intent.landedRefOid || wasLanded) {
    try {
      if (refs.mainSha === intent.testSha || await contains(intent.testSha, refs.mainSha) === true)
        return { state: 'landed', ...refs, generationRefOid: intent.landedRefOid };
    } catch { /* retain the intent for read-back */ }
    return unknown(refs);
  }
  if (isOid(intent.invalidatedRefOid) && ![intent.generationRefOid, intent.landedRefOid].includes(intent.invalidatedRefOid)
    && refs.generationRefOid === intent.invalidatedRefOid) return { state: 'revoked', ...refs };
  return unknown(refs, refs.generationRefOid === intent.generationRefOid ? TRAIN_FAILURE.EFFECT_UNKNOWN : TRAIN_FAILURE.LANDING_REF_MISMATCH);
}

export async function landTrainIntent({ intent, port, readRefs, contains, clock = Date.now }) {
  if (!validLandingIntent(intent)) fail(TRAIN_FAILURE.LEASE_STALE.resident);
  const first = await reconcileTrainIntent({ intent, readRefs, contains });
  if (first.state !== 'unknown' || first.refs?.mainSha !== intent.baseSha || first.refs?.generationRefOid !== intent.generationRefOid)
    return first;
  if (Date.parse(intent.expiresAt) <= clock()) return unknown(first.refs, TRAIN_FAILURE.LEASE_STALE);
  try { await port.landIntent(intent); } catch { /* GitHub may already have applied both updates */ }
  return reconcileTrainIntent({ intent, readRefs, contains });
}

export async function invalidateTrainIntent({ intent, port, readRefs, contains }) {
  if (!validLandingIntent(intent) || !isOid(intent.invalidatedRefOid)
    || [intent.generationRefOid, intent.landedRefOid].includes(intent.invalidatedRefOid)) fail(TRAIN_FAILURE.LEASE_STALE.resident);
  const first = await reconcileTrainIntent({ intent, readRefs, contains });
  if (first.state !== 'unknown' || first.refs?.generationRefOid !== intent.generationRefOid) return first;
  try { await port.invalidateGeneration({ beforeOid: intent.generationRefOid, afterOid: intent.invalidatedRefOid, effectId: intent.effectId }); }
  catch { /* a competing landing or invalidation may have won */ }
  return reconcileTrainIntent({ intent, readRefs, contains });
}

export async function publishTrainStaging({ intent, port, readRefs, send = false, clock = Date.now }) {
  if (!validTrainIntent(intent) || !isOid(intent.stagedRefOid) || intent.stagedRefOid === intent.generationRefOid
    || !(intent.stagingBeforeOid === ABSENT_OID || isOid(intent.stagingBeforeOid))) fail(TRAIN_FAILURE.LEASE_STALE.resident);
  const first = await readTrainRefs(readRefs);
  if (!first) return unknown();
  if (first.generationRefOid === intent.stagedRefOid && first.stagingSha === intent.testSha) return { state: 'staged', ...first };
  if (![intent.generationRefOid, intent.stagedRefOid].includes(first.generationRefOid) || first.mainSha !== intent.baseSha)
    return { ...unknown(first, TRAIN_FAILURE.LANDING_REF_MISMATCH), state: 'mismatch' };
  // S on the fixed ref has already triggered the workflows. Read the existing runs after handover.
  if (first.stagingSha === intent.testSha) return { state: 'staged', ...first };
  if (!send || first.stagingSha !== intent.stagingBeforeOid || first.generationRefOid !== intent.generationRefOid) return unknown(first);
  if (Date.parse(intent.expiresAt) <= clock()) return unknown(first, TRAIN_FAILURE.LEASE_STALE);
  try { await port.stageIntent(intent); } catch { /* read both refs even on a lost response */ }
  const refs = await readTrainRefs(readRefs);
  return refs?.stagingSha === intent.testSha && refs.generationRefOid === intent.stagedRefOid
    ? { state: 'staged', ...refs } : unknown(refs);
}
