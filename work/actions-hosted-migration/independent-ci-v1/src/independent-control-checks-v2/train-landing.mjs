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
//   - landingRulesDecision: main's live rules carry what push mode relies on (ADR 0018 §8);
//   - pickMembers and the bisection state (a Mergify-style search for the first failing prefix);
//   - landMain: the one write to main, with its read-backs.
import fs from 'node:fs/promises';
import path from 'node:path';

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

// ---- main's live rules (ADR 0018 §8) ----
// push lands only while main's rules hold what it relies on: a non_fast_forward and a deletion rule (the ruleset with an empty
// bypass list makes the bypass App unable to rewrite or delete main) and the never-published required check TRAIN_ONLY_CHECK
// pinned to App 5368905 (no PR-page merge). The endpoint lists the rules that apply, not who may bypass them; the bypass lists
// are the Owner's launch step and are not visible here.
export function landingRulesDecision(rules, appId) {
  if (!Array.isArray(rules)) return TRAIN_LANDING_RULES_MISSING;
  const has = type => rules.some(r => plain(r) && r.type === type);
  const trainOnly = rules.some(r => plain(r) && r.type === 'required_status_checks' && Array.isArray(r.parameters?.required_status_checks)
    && r.parameters.required_status_checks.some(c => plain(c) && c.context === TRAIN_ONLY_CHECK && c.integration_id === appId));
  return has('non_fast_forward') && has('deletion') && trainOnly ? null : TRAIN_LANDING_RULES_MISSING;
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
