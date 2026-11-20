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
//     current github-merge path, or park; ADR 0018 §2 L2 item 7, Fable 2026-11-20); rehearsalOf: the four Actions checks on S;
//   - pickMembers and the bisection state (a Mergify-style search for the first failing prefix);
//   - landMain: the one write to main, with its read-backs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_CHECK_NAMES } from './train-rules.mjs';

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
// 三态选路, 补：bypass 名单读不到) ----
// A package with landing 'push' can push; whether it does is read from main's live rules each time (stage 8 before it writes, stage 10
// when it opens a front batch), by this one function. The publisher reads only what its own identity can know:
//   push          all three read back true: (1) a ruleset other than the main ruleset applies to main with non_fast_forward and deletion,
//                 and this App cannot bypass it; (2) the main ruleset requires kooyumi-train-landed pinned to this App; (3) this App can
//                 always bypass the main ruleset.
//   github-merge  the rules read back completely, no kooyumi-train-landed anywhere and this App cannot bypass the main ruleset: exactly
//                 the state before the Owner's two steps. Stage 8 writes the control pair and GitHub merges, as with 'github-merge'.
//   park          anything else (unreadable, read in part, this App's bypass state not readable, kooyumi-train-landed with the rest not
//                 complete, a bypass of main without kooyumi-train-landed): TRAIN_LANDING_RULES_MISSING, nothing written. Once
//                 kooyumi-train-landed is read, never a current-path green.
// Who else is on a bypass list is not a condition here: it is checked with an administrator's identity when the Owner saves the rules
// (ADR 0018 §8 item 7); this App's token cannot read the lists and the publisher does not pretend to.
// missing names what push still lacks (or what could not be read), in a fixed order: the receipt and the stage-10 facts carry it.
// The main ruleset is the one ruleset whose required checks hold the six this App publishes (train-rules.mjs#REQUIRED_CHECK_NAMES).
// rulesets: id -> { currentUserCanBypass } (github.mjs#readRuleset, GET /rulesets/{id}: current_user_can_bypass, this caller's own
// bypass of that ruleset: always, pull_requests_only, never or exempt). Absent or anything else: unreadable.
export const LANDING_ROUTES = Object.freeze(['push', 'github-merge', 'park']);
// The main ruleset's GitHub Actions checks (resident ADR 0032 added the Windows one): the rehearsal on S.
export const MAIN_ACTIONS_CHECKS = Object.freeze(['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows']);
const MAX_RULESETS = 10;
const CAN_BYPASS = Object.freeze(['always', 'pull_requests_only', 'never', 'exempt']);
export function landingRoute({ rules, rulesets, appId }) {
  const park = missing => ({ route: 'park', missing });
  if (!Array.isArray(rules) || rules.length === 0 || rules.length >= 100 || !rules.every(r => plain(r) && typeof r.type === 'string' && r.type.length > 0
    && Number.isSafeInteger(r.rulesetId) && r.rulesetId > 0)) return park(['rules_unreadable']);
  const checksOf = list => list.filter(r => r.type === 'required_status_checks').flatMap(r => (Array.isArray(r.parameters?.required_status_checks) ? r.parameters.required_status_checks : [null]));
  if (checksOf(rules).some(c => !plain(c) || typeof c.context !== 'string')) return park(['rules_unreadable']);
  const byId = new Map();
  for (const r of rules) byId.set(r.rulesetId, [...(byId.get(r.rulesetId) ?? []), r]);
  if (byId.size > MAX_RULESETS) return park(['rules_unreadable']);
  const pinned = (list, context, app) => checksOf(list).some(c => c.context === context && c.integration_id === app);
  const mains = [...byId].filter(([, list]) => REQUIRED_CHECK_NAMES.every(n => pinned(list, n, appId)));
  if (mains.length !== 1) return park(['main_ruleset_unidentified']);
  const [mainId, mainRules] = mains[0];
  const can = new Map(), unreadable = [];
  for (const id of byId.keys()) {
    const info = rulesets instanceof Map ? rulesets.get(id) : null;
    if (plain(info) && CAN_BYPASS.includes(info.currentUserCanBypass)) can.set(id, info.currentUserCanBypass);
    else unreadable.push(`ruleset_can_bypass_unreadable:${id}`);
  }
  if (unreadable.length) return park(unreadable);
  const has = (list, type) => list.some(r => r.type === type);
  const fastForwardOnly = [...byId].filter(([id, list]) => id !== mainId && has(list, 'non_fast_forward') && has(list, 'deletion'));
  const trainLanded = checksOf(rules).some(c => c.context === TRAIN_ONLY_CHECK);
  const main = can.get(mainId), missing = [];
  if (fastForwardOnly.length === 0) missing.push('independent_ruleset_missing');
  else if (!fastForwardOnly.some(([id]) => can.get(id) === 'never')) missing.push('independent_ruleset_app_can_bypass');
  if (!pinned(mainRules, TRAIN_ONLY_CHECK, appId)) missing.push('train_landed_check_missing');
  if (main === 'never') missing.push('main_app_cannot_bypass');
  else if (main !== 'always') missing.push('main_app_bypass_not_always');
  if (missing.length === 0) return { route: 'push', missing };
  if (!trainLanded && main === 'never') return { route: 'github-merge', missing };
  return park(!trainLanded && main !== 'never' ? [...missing, 'main_app_can_bypass'] : missing);
}
// The live read for landingRoute: main's rules (or the ones this run already read), then each of their rulesets. Never throws; a read
// that fails is that ruleset unreadable (park).
export async function readLandingRoute({ github, appId, rules = undefined }) {
  let list = rules;
  if (list === undefined) {
    try { const reply = await github.readBranchRules('main'); list = reply?.complete === true ? reply.rules : null; } catch { list = null; }
  }
  const ids = Array.isArray(list) ? [...new Set(list.map(r => r?.rulesetId))].filter(id => Number.isSafeInteger(id) && id > 0) : [];
  const rulesets = new Map();
  if (ids.length <= MAX_RULESETS && typeof github?.readRuleset === 'function') for (const id of ids) {
    try { const r = await github.readRuleset(id); if (r?.id === id) rulesets.set(id, r); } catch { /* unreadable: landingRoute parks */ }
  }
  return landingRoute({ rules: list, rulesets, appId });
}
// The rehearsal of push on the current path (Fable 2026-11-20): the four Actions checks on S itself, each the newest run by id of its own
// name from GitHub Actions: success, failure (or another conclusion), pending, missing; unreadable when the inventory is not complete.
// allFour: S could have been pushed had the rules been complete. Recorded only; it never decides anything.
export function rehearsalOf({ inventory, testSha }) {
  const readable = inventory?.complete === true && Array.isArray(inventory.checks);
  const checks = {};
  for (const name of MAIN_ACTIONS_CHECKS) {
    if (!readable) { checks[name] = 'unreadable'; continue; }
    const newest = inventory.checks.filter(k => plain(k) && k.name === name && k.head_sha === testSha && k.app?.id === ACTIONS_APP_ID && Number.isSafeInteger(k.id))
      .reduce((a, k) => (!a || k.id > a.id ? k : a), null);
    checks[name] = !newest ? 'missing' : newest.status !== 'completed' ? 'pending' : typeof newest.conclusion === 'string' ? newest.conclusion : 'unreadable';
  }
  return { testSha, checks, allFour: MAIN_ACTIONS_CHECKS.every(n => checks[n] === 'success') };
}

// ---- required checks App 5368905 does not produce, on S (ADR 0018 §2 L2 item 5) ----
const INCONCLUSIVE_CHECKS = new Set(['cancelled', 'timed_out', 'stale', 'startup_failure']);
const CHECK_FAILURE_GRACE_MS = 5 * 60_000;

// rules: main's live rules; inventory: { complete, checks } of S itself, even when H has the same tree.
// Every required context pinned to another App (or to none) must have, as its newest check
// run by id of the pinned App, a completed success. N9: unusable verdicts park; a fresh failure gives the repair lane time to act.
// Contexts pinned to appId are the train's own (on H) and are not looked at here.
export function externalChecksDecision({ rules, inventory, commitSha, appId, now = Date.now() }) {
  if (!Array.isArray(rules) || inventory?.complete !== true || !Array.isArray(inventory.checks)) return TRAIN_LANDING_CHECKS_PENDING;
  const required = [];
  for (const r of rules) if (plain(r) && r.type === 'required_status_checks' && Array.isArray(r.parameters?.required_status_checks))
    for (const c of r.parameters.required_status_checks) if (plain(c) && typeof c.context === 'string' && c.integration_id !== appId) required.push(c);
  let pending = false;
  for (const c of required) {
    const pin = Number.isSafeInteger(c.integration_id) && c.integration_id > 0 ? c.integration_id : null;
    const runs = inventory.checks.filter(k => plain(k) && k.name === c.context && k.head_sha === commitSha && (pin === null || k.app?.id === pin));
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
