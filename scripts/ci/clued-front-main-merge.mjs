#!/usr/bin/env node
// Brings main into the merge train's front (Owner Decision 9e2511fe item 3 (and, until
// 11-22, 78a3052f item 2); resident DESIGN §80). strict lets GitHub merge only a head
// that contains main's tip; a front that fell behind used to wait for a person
// to merge main, authorize the merge commit and push it.
//
// Started by workflow_dispatch (.github/workflows/clued-front-main-merge.yml)
// with the PR and the head the train named: by the on-duty node's companion
// when stage 10 says FRONT_NEEDS_MAIN_MERGE (resident front-merge-dispatch.mjs),
// or by a person. It does one thing, as the clued-admission App, and only when
// it is still true: the PR is open, not a draft, into main, from this
// repository, still at that head, behind main, of any layer (Owner 11-22:
// the protected layer too, replacing 78a3052f item 2; its Owner Grant carries over only while main left the protected
// files the PR changes alone, see carriedApprovalSource, Decision a0d93cd0); merge admission is not frozen. Then:
//   1. PUT update-branch with expected_head_sha = that head (GitHub merges main
//      in itself and refuses a conflict or a moved head);
//   2. reads the new head: a GitHub-made (web-flow, verified) merge commit whose
//      parents are exactly [that head, main];
//   3. posts the clued-admission App's check kooyumi-main-merge on it, naming
//      the PR, that head and main (clued-work-admission.mjs#mainMergeSource).
// The admission (on the node on duty) then carries the holder's authorization
// of that head to the merge commit (migration 20261116090000): no person and no
// lease key take part. Anything else it leaves as it is and says why.
// No retries here: the dispatcher asks again while stage 10 still says so.
//
// Without pr and head (Task ea22e734: a push to main, the schedule, or a dispatch
// without inputs; the hosted copy also when hosted-required completes on any head,
// PLAN-train-held-deadlock-20261125 §3.3) it chooses the pull request itself, from
// GitHub's records of this moment and nothing kept between runs (chooseFront below):
//   the train   = the open, ready pull requests of this repository into main
//                 that have auto-merge on (auto-merge on is the one way aboard);
//   the front   = one of them that contains main's tip and is under way: no
//                 required check failed on its head, and it is not idle;
//   a candidate = one of them behind main, not reported as a conflict, and no
//                 admission failed on its head: main does not change that. A red
//                 head the App did not bring up is a candidate too, once (FABLE-
//                 defect-remediation-plan-20261124 §3.1, #1258): its red may be the
//                 pipeline's (an old base's gitleaks) and main may carry the fix;
//                 the head made from it runs everything. A head the App brought up
//                 that has not passed (red, or not admitted) is a candidate again
//                 (第二轮规划 A, #1298; PLAN-train-held-deadlock-20261125 §2.1), after
//                 every other candidate, while fewer than BROUGHT_IN_A_ROW_MAX heads
//                 in a row (it and its first parents) are ones the App brought: main
//                 may have fixed that red since, and the resident never proposes a
//                 head behind main, so without this nothing would move it again.
// Every run without inputs also names, once per head, a pull request on the train
// whose required checks are not all there with nothing queued or running for
// STALLED_AFTER_MS (§3.11 item 3; nameStalled below). The resident's own page status that
// it does not propose a head (heldPartOf: "落后 main N 个提交：轮到时机器人合入 main…")
// is neither under way nor activity there (PLAN-unadmitted-silent-20261125 §2.2).
// Normally a front under way holds the train. In scaffold, an earlier candidate whose hosted
// checks passed can go first, including when the separate admission check is still missing
// after two updates. With no front, bring the earliest eligible candidate (ties: the lower
// number), one per run, as in a named run. There is no hold (PLAN-train-held-deadlock-20261125 §2.1: the hold
// of FABLE-scaffold-s5-pre §2 counted heads with no way out, and two of them stopped
// the train until someone stepped in): a run brings nobody only with a front under way,
// frozen, GitHub unread, or update-branch refusing every candidate; each of those ends by
// itself or moves to the next. A red or idle front, a lost event or a failed run need no
// memory: the next run reads the same records again.
// A required check pinned to an App is read only from that App (open-qs 改法 4): with the legacy admission workflow enabled again,
// App 5164952 and App 5368905 both post kooyumi-admission-verified and kooyumi-merge-slot on one head.
//
// The hosted copy (.github/workflows/clued-front-main-merge-hosted.yml; framework v1 §2.3, hosted scaffold report §1.4) runs this
// same entry with CLUED_FRONT_MERGE_PHASE=scaffold. It acts only while the hosted scaffold ruleset is the one in force on main
// (scaffoldInForce below: main requires hosted- checks pinned to GitHub Actions and the independent CI App 5368905's main ruleset
// is not there by train-rules.mjs#sixPinned (修订 6: the scaffold's admission is pinned to 5368905 as well), so #292 is disabled and
// the train does not land). Before that, and from the trial switch on (#292 enabled again), it changes nothing.
// The two copies are exclusive on that one fact (FABLE-scaffold-s5-pre §1): the self-hosted workflow (no phase) changes nothing
// while the scaffold ruleset is in force, named or not, so exactly one of them brings fronts up in each state of the rules.
// Until migration 6b809301 is on the nodes (Decision 85effa31) the admission does not carry the authorization to the merge
// commit: the copy says "新 head <sha>，待补授权" on the run summary and on the pull request, and DESK authorizes that head.
// It takes no authorization step itself; it holds no Clued credential.

import fs from 'node:fs';
import { ADMISSION_APP_ID, APP_CHECK_NAME, INDEPENDENT_ADMISSION_APP_ID, INDEPENDENT_ADMISSION_CHECK, MAIN_MERGE_CHECK, RESIDENT_STATUS_CONTEXT_PREFIX,
  appJwt, githubJson, githubPaged, heldPartOf, mainMergeExternalId } from './clued-work-admission.mjs';
import { appRequest } from './clued-managed-auto-merge.mjs';
import { resolveMode } from './merge-admission-policy.mjs';
import { sixPinned } from '../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-rules.mjs';

export const FRONT_MERGE_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write', checks: 'write' });
// update-branch with a main that changed a workflow file needs workflows: write (FABLE-scaffold-s5-pre §3). It is asked for only
// when the installation holds it, read from the installation on every run: granted or withdrawn by the Owner, the token follows.
export const WORKFLOWS_PERMISSION = Object.freeze({ workflows: 'write' });
export const WORKFLOWS_REFUSED = 'main 改了工作流文件且 App 无 workflows 权限';
// update-branch answers 202 and merges asynchronously; the new head is read this often, at most this many times.
export const HEAD_READ_EVERY_MS = 3_000;
export const HEAD_READS = 20;
const SHA = /^[0-9a-f]{40}$/;
// The hosted copy's phase: who publishes main's required checks decides which ruleset is in force.
export const SCAFFOLD_PHASE = 'scaffold';
export const GITHUB_ACTIONS_APP_ID = 15368;
export const HOSTED_CHECK_PREFIX = 'hosted-';
export const pendingAuthorizationLine = merged => `新 head ${merged}，待补授权`;
// A head that contains main is idle once it is this old with nothing queued, running or pending on it and its required
// checks not all green (the rule of the hooks' wait-pr exit 5): nothing will finish it, so it is not the front.
export const IDLE_AFTER_MS = 15 * 60_000;
// The admission verdict each admitter publishes, by name and App (open-qs 改法 3, gate-leak 改法 1): the independent CI's
// kooyumi-work-admission (App 5368905, pinned by #292) and the clued-admission App's kooyumi-admission-verified (App 5164952,
// pinned by the hosted scaffold ruleset; it never posts a check named kooyumi-work-admission: that is the job name of its
// workflow, a GitHub Actions check). The admission that counts is every row the rules in force require, the pair exactly
// (#292's own kooyumi-admission-verified of App 5368905 is its merge-slot control, not an admission); with none, the first row.
export const ADMISSIONS = Object.freeze([Object.freeze({ context: INDEPENDENT_ADMISSION_CHECK, integration_id: INDEPENDENT_ADMISSION_APP_ID }),
  Object.freeze({ context: APP_CHECK_NAME, integration_id: ADMISSION_APP_ID })]);
// A list (open pull requests, branch rules) is read 100 a page, at most this many pages; one that goes on is not known in full.
const PAGES = 10;
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
const GREEN = new Set(['success', 'skipped', 'neutral']);
// The independent CI withdrew this check (no verdict on the code); its pending status that says it stopped will not finish.
const WITHDRAWN = 'Independent CI check withdrawn', STOPPED = '已停止';
// The resident saying it does not propose this head (poller.mjs hints merge-main and push-any-commit; pr-status.mjs#describe writes
// the sentence, heldPartOf reads it, the same bytes as the PR gate's). Pending while the head is behind, and rewritten each time main
// moves: read as under way or as activity, a head behind main that the train will not bring was never named (PLAN-unadmitted-silent
// -20261125 §1.2 缺陷乙). Any other text, of the resident or anyone, is under way as before: unknown, it waits.
const residentHeld = status => String(status?.context ?? '').startsWith(RESIDENT_STATUS_CONTEXT_PREFIX) && heldPartOf(status?.description) !== null;
const residentInfo = status => /^resident-queue\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])? \(info only\)$/.test(status?.context ?? '');
const REFUSED_STATE = '准入拒绝待修（PATHS_OUTSIDE_WRITE_SET）';
// pr-status.mjs writes the retry text under a duty prefix and the exhausted result without it (node-duty.mjs).
function residentRefused(status) {
  if (!residentInfo(status)) return false;
  if (status.state === 'pending') {
    return /^当班：(?:未准入或未执行|等待中)（PATHS_OUTSIDE_WRITE_SET）：(?:约 \d{2}:\d{2}Z? |当前批次结束后|即将)自动重试(?:（第 \d+ 次）|[，；])/u.test(status.description);
  }
  return status.state === 'failure'
    && /^24 小时内已多次未准入或未执行（PATHS_OUTSIDE_WRITE_SET）：请修正后推新提交/u.test(status.description);
}
const TRAIN_QUERY = 'query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){defaultBranchRef{name} '
  + 'pullRequests(states:OPEN,first:100,after:$after){pageInfo{hasNextPage endCursor} '
  + 'nodes{number isDraft baseRefName headRefOid mergeable updatedAt autoMergeRequest{enabledAt} headRepository{nameWithOwner}}}}}';

// An installation token of the clued-admission App with exactly these permissions (and workflows: write when the installation
// holds it), or the reason there is none. With only, exactly those and nothing more (a comment needs pull_requests: write alone).
export async function frontMergeToken({ env, fetchImpl, now = () => Date.now(), only = null }) {
  const appId = (env.CLUED_ADMISSION_APP_ID ?? '').trim(), key = (env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? '').trim();
  if (!appId || !key) return { token: null, reason: 'the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY)' };
  const jwt = appJwt(appId, key, Math.floor(now() / 1000));
  const installation = await appRequest(fetchImpl, env, 'GET', `/repos/${env.GITHUB_REPOSITORY}/installation`, jwt);
  if (installation.status !== 200 || !installation.body?.id) return { token: null, reason: `GET installation returned ${installation.status}` };
  const workflows = !only && installation.body.permissions?.workflows === 'write';
  const permissions = only ?? (workflows ? { ...FRONT_MERGE_PERMISSIONS, ...WORKFLOWS_PERMISSION } : FRONT_MERGE_PERMISSIONS);
  const minted = await appRequest(fetchImpl, env, 'POST', `/app/installations/${installation.body.id}/access_tokens`, jwt,
    { repositories: [env.GITHUB_REPOSITORY.split('/')[1]], permissions });
  if (minted.status === 201 && minted.body?.token) return { token: minted.body.token, reason: null, workflows };
  return { token: null, reason: `the clued-admission App token with ${Object.entries(permissions).map(([k, v]) => `${k}: ${v}`).join(', ')} was refused (HTTP ${minted.status})` };
}

// One list of a head (body[key], 100 a page) read to the end: GitHub says how many there are (total_count). A list that
// goes on past PAGES pages, or stops short of its count, is not known in full: what is still under way may be in the rest.
async function listedInFull(fetchImpl, env, route, key, what) {
  const items = [];
  for (let page = 1; ; page++) {
    const body = await githubJson(fetchImpl, env, `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(body?.[key])) throw new Error(`${what} could not be read`);
    items.push(...body[key]);
    if (!(Number(body.total_count) > items.length)) return items;
    if (body[key].length === 0 || page === PAGES) throw new Error(`${what}: ${items.length} of ${body.total_count} read, not known in full`);
  }
}

// What ran on one head, as the ruleset reads it: for each required check (context, integration_id) the newest check run of that
// name from the App it is pinned to (any App when unpinned), and for an unpinned one also the newest status of its context. A
// pinned one never reads a status: the status API does not say who posted it (gate-leak 改法 2).
async function headRecords({ env, fetchImpl, repository, head, required, admitters }) {
  const runs = await githubPaged(fetchImpl, env, `/repos/${repository}/commits/${head}/check-runs`, 'check_runs');
  const statuses = await listedInFull(fetchImpl, env, `/repos/${repository}/commits/${head}/status`, 'statuses', `the statuses of ${head}`);
  const contexts = new Map();
  const newer = (a, b) => String(a.started_at ?? '') > String(b.started_at ?? '') || (a.started_at === b.started_at && Number(a.id) > Number(b.id));
  const newest = ({ context, integration_id, contains = false }) => runs.filter(run => (contains ? String(run.name ?? '').includes(context) : run.name === context)
    && (integration_id === null || Number(run.app?.id) === integration_id)).reduce((best, run) => (!best || newer(run, best) ? run : best), null);
  for (const status of statuses) if (!contexts.has(status.context)) contexts.set(status.context, status);
  const withdrawn = run => String(run.output?.title ?? '').startsWith(WITHDRAWN);
  const stateOf = check => (check.integration_id === null ? contexts.get(check.context)?.state : undefined);
  const failed = [...new Set(required.filter(check => {
    const run = newest(check), state = stateOf(check);
    return (run && FAILED.has(run.conclusion) && !withdrawn(run)) || state === 'failure' || state === 'error';
  }).map(check => check.context))];
  const isGreen = check => {
    const run = newest(check);
    return (run?.status === 'completed' && GREEN.has(run.conclusion) && !withdrawn(run)) || stateOf(check) === 'success';
  };
  const green = required.every(isGreen);
  const hosted = required.filter(({ context, integration_id }) => context.startsWith(HOSTED_CHECK_PREFIX) && integration_id === GITHUB_ACTIONS_APP_ID);
  const scaffoldReady = env.CLUED_FRONT_MERGE_PHASE === SCAFFOLD_PHASE && hosted.length > 0 && hosted.every(isGreen) && failed.length === 0;
  // GitHub lists newest statuses first. A newer resident report can supersede a refusal even across a handover.
  const latest = [...contexts.values()];
  const activity = latest.filter(status => !residentHeld(status) && !residentRefused(status));
  const unfinished = runs.filter(run => run.status !== 'completed').length
    + activity.filter(status => status.state === 'pending' && !String(status.description ?? '').includes(STOPPED)).length;
  const refused = !green && !unfinished && !admitters.some(isGreen) && residentRefused(latest.find(residentInfo));
  const by = (name, app) => succeeded(runs, name, app);
  // What each required check that is not green last did, as wait-pr's exit 5 lists it: a job GitHub skipped keeps its unexpanded
  // name ("... && 'ci-suites' || 'ci-suites-skipped'"), so the required name never appears: that is "job-skipped".
  const missing = required.filter(check => !isGreen(check)).map(check => {
    const run = newest(check), state = stateOf(check);
    const job = run ? null : newest({ context: `'${check.context}' ||`, integration_id: check.integration_id, contains: true });
    const last = run ? (run.status !== 'completed' ? run.status : withdrawn(run) ? 'withdrawn' : String(run.conclusion ?? 'none'))
      : state ? `status ${state}` : job ? `job-${job.conclusion ?? job.status}` : 'missing';
    return { context: check.context, last };
  });
  const times = [...runs.map(run => run.completed_at ?? run.started_at), ...activity.map(status => status.updated_at ?? status.created_at)]
    .map(t => Date.parse(t ?? '')).filter(Number.isFinite);
  return { failed, green, scaffoldReady, unfinished, refused, missing, lastActivity: times.length ? Math.max(...times) : 0, brought: by(MAIN_MERGE_CHECK, ADMISSION_APP_ID),
    admitted: admitters.every(({ context, integration_id }) => by(context, integration_id)) };
}

const headWorkflows = ({ env, fetchImpl, repository, head }) =>
  listedInFull(fetchImpl, env, `/repos/${repository}/actions/runs?head_sha=${head}`, 'workflow_runs', `the workflow runs of ${head}`);
const workflowsActive = runs => runs.some(run => run.status !== 'completed');

// The rules in force on a branch (every enabled ruleset), 100 a page, read to the end or not at all.
async function branchRules({ env, fetchImpl, repository, branch }) {
  const rules = [];
  for (let page = 1; ; page++) {
    const chunk = await githubJson(fetchImpl, env, `/repos/${repository}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`);
    if (!Array.isArray(chunk)) throw new Error(`the rules of ${branch} could not be read`);
    rules.push(...chunk);
    if (chunk.length < 100) return rules;
    if (page === PAGES) throw new Error(`the rules of ${branch} fill more than ${PAGES} pages: the required checks are not known in full`);
  }
}

// Every required check of those rules with the App it is pinned to (integration_id null: any source).
const requiredChecks = rules => rules.filter(rule => rule?.type === 'required_status_checks')
  .flatMap(rule => rule.parameters?.required_status_checks ?? []).filter(check => check?.context)
  .map(check => ({ context: String(check.context), integration_id: Number.isSafeInteger(check.integration_id) ? check.integration_id : null }));

// Whether the hosted scaffold ruleset is the one in force on the default branch (hosted scaffold report §1.1): main requires
// hosted- checks of GitHub Actions and nothing of the independent CI App (#292 disabled). Both in force is the trial switch,
// where the train lands and brings its own front up; neither is the time before the scaffold. Throws when it cannot be read.
export async function scaffoldInForce({ env, fetchImpl }) {
  const repository = env.GITHUB_REPOSITORY;
  const main = (await githubJson(fetchImpl, env, `/repos/${repository}`))?.default_branch;
  if (!main) throw new Error('the default branch could not be read');
  const checks = requiredChecks(await branchRules({ env, fetchImpl, repository, branch: main }));
  const hosted = checks.filter(check => check.context.startsWith(HOSTED_CHECK_PREFIX) && check.integration_id === GITHUB_ACTIONS_APP_ID);
  if (!hosted.length) return { inForce: false, reason: `${main} requires no hosted- check of GitHub Actions: the hosted scaffold ruleset is not in force` };
  // 修订 6 (Decision c8c4d565): the scaffold ruleset pins its admission to App 5368905 too, so "some check of that App" is no sign
  // of #292. #292 is in force when the main ruleset is, by the one rule that names it (train-rules.mjs#sixPinned, stages 8 and 10).
  if (sixPinned(checks, INDEPENDENT_ADMISSION_APP_ID)) return { inForce: false, reason: `${main} has the independent CI App ${INDEPENDENT_ADMISSION_APP_ID}'s main ruleset (#292 in force, train-rules.mjs#sixPinned): the train brings its front up` };
  return { inForce: true, reason: `${main} requires ${hosted.length} hosted- check(s) of GitHub Actions and none of the independent CI: the hosted scaffold ruleset is in force` };
}

// Which copy acts, read again at the start of every run: null to go on, or what it changes (nothing) and why. The hosted copy
// (phase scaffold) acts only while the scaffold ruleset is in force; the self-hosted workflow (no phase) only while it is not.
async function phaseGate(env, fetchImpl) {
  const phase = env.CLUED_FRONT_MERGE_PHASE ?? '';
  if (phase !== '' && phase !== SCAFFOLD_PHASE) return { result: 'refused', reason: `unknown CLUED_FRONT_MERGE_PHASE ${JSON.stringify(phase).slice(0, 40)}: nothing is changed` };
  let inForce, reason;
  try {
    ({ inForce, reason } = await scaffoldInForce({ env, fetchImpl }));
  } catch (error) {
    return { result: 'skipped', reason: `the rules in force could not be read (${error instanceof Error ? error.message : String(error)}); nothing is changed, the next run looks again` };
  }
  if (phase === SCAFFOLD_PHASE) return inForce ? null : { result: 'none', reason };
  return inForce ? { result: 'none', reason: `脚手架规则集在用，由托管副本带车头 (${reason})` } : null;
}

// 第二轮规划 A (任务 2fb32dc7): #1298's head, which the App brought up, went red on a test of main that read the real base; main fixed
// that test 38 minutes later and the head stayed red, behind and passed over until a person merged main. 任务 3576b29c (PLAN-train-
// held-deadlock-20261125 §2.1): #1325's head, which the App brought up and the admission never answered, fell behind main and had no
// way out at all. A head the App brought that has not passed (red on something else than the admission, or not admitted) is brought
// again while fewer than this many heads in a row (it and its first parents) are ones the App brought; the count is read from
// GitHub each run (the App's kooyumi-main-merge success on each), nothing kept. A true red or a head never admitted costs one more
// round at most; then it is named (nameStalled) and stays until its holder pushes.
export const BROUGHT_IN_A_ROW_MAX = 2;
const succeeded = (runs, name, app) => runs.some(run => run.name === name && Number(run.app?.id) === app && run.status === 'completed' && run.conclusion === 'success');
const admissionRed = (records, admitters) => records.failed.some(context => admitters.some(row => row.context === context));
// A head the App brought that has not passed, the admission not failed on it: red on a required check, or not admitted (no answer
// yet, or never). Main may have changed the red; the admission of the head made from it may come. A head the App brought that is
// admitted and not red is a candidate as any other.
// In scaffold the hosted checks are independent of the admission verdict. A tested head
// can be refreshed again while admission is missing, since that verdict is for an exact head.
const broughtNotPassed = (records, admitters) => records.brought && !records.scaffoldReady
  && !admissionRed(records, admitters) && (records.failed.length > 0 || !records.admitted);

// How many heads in a row, this one first, the App brought up (this one is): its first parents read while each carries the App's
// kooyumi-main-merge success, at most BROUGHT_IN_A_ROW_MAX deep. The parent is read from the git commit object (parents only, no diff
// against a merge of all of main). Throws when GitHub cannot be read: then that head is not brought again, the rest goes on.
async function broughtInARow({ env, fetchImpl, repository, head }) {
  let count = 1;
  for (let at = head; count < BROUGHT_IN_A_ROW_MAX;) {
    const parent = (await githubJson(fetchImpl, env, `/repos/${repository}/git/commits/${at}`))?.parents?.[0]?.sha;
    if (!SHA.test(parent ?? '')) throw new Error(`the first parent of ${at} could not be read`);
    if (!succeeded(await githubPaged(fetchImpl, env, `/repos/${repository}/commits/${parent}/check-runs`, 'check_runs'), MAIN_MERGE_CHECK, ADMISSION_APP_ID)) break;
    count++; at = parent;
  }
  return count;
}

// What the train does with a head behind main, one rule for choosing the front and for naming the stalled: a candidate is brought
// up to main once there is no front; anything else stays where it is. §3.1: a failed admission is not something main changes. A
// head the App brought that has not passed (broughtNotPassed) is brought again (last) while records.inARow (read for such a head
// only, by chooseFront and nameStalled) is below BROUGHT_IN_A_ROW_MAX; at it, it stays and says so; unread, it is not brought this run.
function behindVerdict(member, records, admitters) {
  const red = `red (${records.failed.join(', ')})`;
  if (member.mergeable === 'CONFLICTING') return { state: 'conflict', candidate: false };
  if (admissionRed(records, admitters)) return { state: red, candidate: false };
  if (records.refused) return { state: REFUSED_STATE, candidate: false };
  if (broughtNotPassed(records, admitters)) {
    const why = `${[...(records.failed.length ? [red] : []), ...(records.admitted ? [] : ['not admitted'])].join(', ')} on a head the App brought`;
    if (records.inARow === undefined) return { state: why, candidate: false };
    if (records.inARow >= BROUGHT_IN_A_ROW_MAX) return { state: `${why}: 连带 ${BROUGHT_IN_A_ROW_MAX} 次仍未通过，不再带`, candidate: false };
    return { state: `candidate, ${why}: main is merged in again, after the others`, candidate: true, last: true };
  }
  return { state: records.failed.length ? `candidate, ${red}: main is merged in once` : 'candidate', candidate: true };
}

// The train of this moment (see the head of this file): every pull request on it with what it is, and the candidates in
// order. Reads only; throws when GitHub cannot be read (then nothing is decided).
export async function chooseFront({ env, fetchImpl, now = () => Date.now() }) {
  const repository = env.GITHUB_REPOSITORY, [owner, name] = repository.split('/');
  const open = [];
  let main = 'main';
  for (let after = null, page = 0; page < PAGES; page++) {
    const answer = await appRequest(fetchImpl, env, 'POST', '/graphql', env.GITHUB_TOKEN, { query: TRAIN_QUERY, variables: { owner, name, after } });
    const repo = answer.body?.data?.repository, list = repo?.pullRequests;
    if (answer.status !== 200 || answer.body?.errors?.length || !Array.isArray(list?.nodes)) throw new Error(`the open pull requests could not be read (HTTP ${answer.status})`);
    main = repo.defaultBranchRef?.name ?? main;
    open.push(...list.nodes);
    if (!list.pageInfo?.hasNextPage) break;
    if (page === PAGES - 1) throw new Error(`more than ${PAGES * 100} open pull requests: the train is not known in full`);
    after = list.pageInfo.endCursor;
  }
  const tip = (await githubJson(fetchImpl, env, `/repos/${repository}/branches/${encodeURIComponent(main)}`))?.commit?.sha;
  if (!SHA.test(tip ?? '')) throw new Error(`the tip of ${main} could not be read`);
  // Which checks are required decides who is red, green or idle. Read without them (none named, a page not read) every
  // optional failure would make the front red and one more pull request would be brought up each run: then nothing is decided.
  const pinned = requiredChecks(await branchRules({ env, fetchImpl, repository, branch: main }));
  const required = [...new Map(pinned.map(check => [`${check.context}@${check.integration_id}`, check])).values()];
  if (!required.length) throw new Error(`the rules of ${main} name no required check`);
  // The admissions that count are those the rules in force require, by name and App (#292: kooyumi-work-admission of App 5368905;
  // the hosted scaffold: kooyumi-admission-verified of App 5164952; the trial switch: both), see ADMISSIONS.
  const inForce = ADMISSIONS.filter(row => required.some(check => check.context === row.context && check.integration_id === row.integration_id));
  const admitters = inForce.length ? inForce : [ADMISSIONS[0]];
  const train = open.filter(pr => pr?.autoMergeRequest && pr.isDraft === false && pr.baseRefName === main
    && pr.headRepository?.nameWithOwner === repository && SHA.test(pr.headRefOid ?? ''))
    .map(pr => ({ pr: pr.number, head: pr.headRefOid, enabled: String(pr.autoMergeRequest.enabledAt ?? ''), mergeable: pr.mergeable,
      updated: Date.parse(pr.updatedAt), behind: null, state: null }))
    .sort((a, b) => (a.enabled < b.enabled ? -1 : a.enabled > b.enabled ? 1 : a.pr - b.pr));
  for (const member of train) {
    const compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${tip}...${member.head}`);
    if (!Number.isSafeInteger(compare?.behind_by)) throw new Error(`#${member.pr} could not be compared with ${main}`);
    member.behind = compare.behind_by;
  }
  let front = null;
  for (const member of train.filter(member => member.behind === 0)) {
    const records = member.records = await headRecords({ env, fetchImpl, repository, head: member.head, required, admitters });
    const running = workflowsActive(await headWorkflows({ env, fetchImpl, repository, head: member.head }));
    if (records.failed.length) { member.state = `red (${records.failed.join(', ')})`; continue; }
    if (records.refused && !running) { member.state = REFUSED_STATE; continue; }
    const active = records.green || records.unfinished > 0 || running;
    const idle = !active && now() - await appearedAt({ env, fetchImpl, repository, member }) >= IDLE_AFTER_MS;
    member.state = idle ? 'idle' : 'front';
    if (!idle) front ??= member;
  }
  const candidates = [], last = [];
  // In scaffold, consider earlier heads even when a later head contains main and has CI under way.
  const eligible = !front ? train : env.CLUED_FRONT_MERGE_PHASE === SCAFFOLD_PHASE ? train.slice(0, train.indexOf(front)) : [];
  for (const member of eligible.filter(member => member.behind > 0)) {
    const records = member.records = await headRecords({ env, fetchImpl, repository, head: member.head, required, admitters });
    if (records.refused && workflowsActive(await headWorkflows({ env, fetchImpl, repository, head: member.head }))) records.refused = false;
    const unread = await readInARow({ env, fetchImpl, repository, member, records, admitters });
    const verdict = behindVerdict(member, records, admitters);
    member.state = unread ? `${verdict.state}; 连带次数未读到 (${unread}): not brought again this run` : verdict.state;
    if (!verdict.candidate) continue;
    if (front && !records.scaffoldReady) {
      member.state += '; waiting for hosted checks or the current front';
      continue;
    }
    (verdict.last ? last : candidates).push(member);
  }
  candidates.push(...last);
  for (const member of train) member.state ??= 'behind';
  return { main, tip, train, front, candidates, required, admitters };
}

// records.inARow of a head behind main the App brought that has not passed (nothing for any other head); the reason when GitHub
// cannot be read (records.inARow left unset: that head is not brought this run, the rest goes on), else null.
async function readInARow({ env, fetchImpl, repository, member, records, admitters }) {
  if (member.mergeable === 'CONFLICTING' || records.refused || records.inARow !== undefined || !broughtNotPassed(records, admitters)) return null;
  try {
    records.inARow = await broughtInARow({ env, fetchImpl, repository, head: member.head });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// When a head appeared: with its commit or, for an older commit pushed later, with the push (the PR's last change).
async function appearedAt({ env, fetchImpl, repository, member }) {
  const committed = Date.parse((await githubJson(fetchImpl, env, `/repos/${repository}/commits/${member.head}`))?.commit?.committer?.date);
  const appeared = Math.max(Number.isFinite(committed) ? committed : 0, Number.isFinite(member.updated) ? member.updated : 0);
  if (!(appeared > 0)) throw new Error(`the age of ${member.head} could not be read`);
  return appeared;
}

// FABLE-defect-remediation-plan-20261124 §3.11 item 3: a pull request on the train that nothing will move. Its head has no required
// check failed (a red one is seen on the PR and by wait-pr) and not all of them green, is not reported as a conflict, and nothing has
// been queued, running or pending on it for STALLED_AFTER_MS: the rule of wait-pr's exit 5, the length a parameter. A head behind
// main is one of these only when the train will not bring it up (behindVerdict: the App brought it BROUGHT_IN_A_ROW_MAX times in a
// row and it has not passed); a candidate waits for the front and is brought up, naming it would send someone to merge main by
// hand. The resident's pending
// "落后 main N 个提交" on such a head is not under way and not activity (headRecords, residentHeld). Such a head is
// named on its pull request, once: which required checks are missing and how each last ended. Nothing is kept between runs: the
// comment carries the head, and a comment that already names it (stalledMark) means it was named. A helper: whatever it cannot read
// or post it only reports, per pull request; it never changes what the run decided.
export const COMMENT_PERMISSIONS = Object.freeze({ pull_requests: 'write' });
export const STALLED_AFTER_MS = 30 * 60_000;
export const STALLED_MARK = 'clued-front-main-merge: stalled';
export const stalledMark = head => `<!-- ${STALLED_MARK} ${head} -->`;
export const stalledComment = (head, missing, refused = false) => `${stalledMark(head)}\n`
  + `head \`${head}\` 的必需检查没齐，且 ${STALLED_AFTER_MS / 60_000} 分钟没有排队或在跑的运行：没有东西会让它合入。\n\n`
  + missing.map(({ context, last }) => `- ${context}: ${last}\n`).join('')
  + (refused ? `\n${REFUSED_STATE}。请修正认领写集，并按常驻状态提示复验。` : '\n要一个新 head；原因在流水线就登记一条缺陷。')
  + '车头机器人每个 head 只点名一次。';

// Whether a comment on the pull request already names this head; read to the end, 100 a page.
async function commentsName({ env, fetchImpl, repository, pr, head }) {
  for (let page = 1; page <= PAGES; page++) {
    const list = await githubJson(fetchImpl, env, `/repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(list)) throw new Error(`the comments of #${pr} could not be read`);
    if (list.some(comment => String(comment?.body ?? '').includes(stalledMark(head)))) return true;
    if (list.length < 100) return false;
  }
  throw new Error(`the comments of #${pr} fill more than ${PAGES} pages`);
}

export async function nameStalled({ env, fetchImpl, chosen, skip = new Set(), now = () => Date.now() }) {
  const repository = env.GITHUB_REPOSITORY, named = [];
  let token = null, refused = null;
  for (const member of chosen.train) {
    if (skip.has(member.pr) || member.mergeable === 'CONFLICTING') continue;
    let missing = null;
    try {
      const records = member.records ??= await headRecords({ env, fetchImpl, repository, head: member.head, required: chosen.required, admitters: chosen.admitters });
      if (records.failed.length || records.green || records.unfinished > 0) continue;
      // Behind main and a candidate: the train brings it up once there is no front, so something will move it (review 2fb32dc7 §5).
      // With a front chooseFront did not read how many in a row the App brought it: read here. Unread, a quiet head is not named
      // this run (whether the train brings it again is not known) and the run says so.
      const unread = member.behind > 0 ? await readInARow({ env, fetchImpl, repository, member, records, admitters: chosen.admitters }) : null;
      if (member.behind > 0 && behindVerdict(member, records, chosen.admitters).candidate) continue;
      const runs = await headWorkflows({ env, fetchImpl, repository, head: member.head });
      if (workflowsActive(runs)) continue;
      const ran = runs.map(run => Date.parse(run.updated_at ?? '')).filter(Number.isFinite);
      const quiet = Math.max(await appearedAt({ env, fetchImpl, repository, member }), records.lastActivity, ...ran);
      if (now() - quiet < STALLED_AFTER_MS) continue;
      if (unread) throw new Error(`连带次数未读到 (${unread})`);
      missing = records.missing;
      if (await commentsName({ env, fetchImpl, repository, pr: member.pr, head: member.head })) continue;
      if (!token && !refused) ({ token, reason: refused } = await frontMergeToken({ env, fetchImpl, now, only: COMMENT_PERMISSIONS }));
      if (!token) { named.push({ pr: member.pr, head: member.head, missing, comment: `not posted (${refused})` }); continue; }
      const posted = await appRequest(fetchImpl, env, 'POST', `/repos/${repository}/issues/${member.pr}/comments`, token,
        { body: stalledComment(member.head, missing, records.refused) });
      named.push({ pr: member.pr, head: member.head, missing, comment: posted.status === 201 ? 'posted' : `not posted (HTTP ${posted.status})` });
    } catch (error) {
      named.push({ pr: member.pr, head: member.head, missing, comment: `not named (${error instanceof Error ? error.message : String(error)})` });
    }
  }
  return named;
}

const unreadable = error => `GitHub could not be read (${error instanceof Error ? error.message : String(error)}); nothing is changed, the next run looks again`;
const trainOf = chosen => ({ main: chosen.tip, members: chosen.train.map(({ pr, head, behind, state }) => ({ pr, head, behind, state })) });

// A run without inputs: with no front, the first candidate that GitHub lets it update.
async function runFrontChoice(ports) {
  const { env, fetchImpl, workspace, readPolicyFile, now } = ports;
  const done = (result, reason, train) => ({ result, reason, pr: null, head_sha: null, ...(train ? { train } : {}) });
  if (resolveMode({ env, workspace, readFile: readPolicyFile }).state === 'frozen') return done('none', 'merge admission is frozen: nothing is changed');
  let chosen;
  try {
    chosen = await chooseFront({ env, fetchImpl, now });
  } catch (error) {
    return done('skipped', unreadable(error));
  }
  const train = trainOf(chosen);
  // What was decided, then the stalled heads named (a head brought up this run is no longer the pull request's head).
  const decided = await decide(ports, chosen, train, done);
  const named = await nameStalled({ env, fetchImpl, chosen, now, skip: new Set(train.members.filter(m => m.state === 'chosen').map(m => m.pr)) });
  for (const { pr, comment } of named) { const member = train.members.find(m => m.pr === pr); member.state += `; stalled: ${comment}`; }
  return named.length ? { ...decided, named } : decided;
}

async function decide(ports, chosen, train, done) {
  const { front } = chosen;
  if (front && !chosen.candidates.length) return done('none', `#${front.pr} contains ${chosen.main} and is under way`, train);
  if (!chosen.candidates.length)
    return done('none', chosen.train.length ? 'no pull request on the train can be brought up now' : 'no open pull request has auto-merge on', train);
  for (const candidate of chosen.candidates) {
    const result = await bringUp({ ...ports, input: { pr: String(candidate.pr), head: candidate.head } });
    const member = train.members.find(m => m.pr === candidate.pr);
    // update-branch refused (a conflict GitHub had not reported yet, or main changed a workflow file): the next one, so that one cannot hold all.
    if (result.result === 'refused') { member.state = `refused: ${result.reason}`; continue; }
    member.state = 'chosen';
    return { ...result, train };
  }
  return done('refused', 'update-branch refused every candidate', train);
}

export async function runFrontMainMerge({ env, fetchImpl, workspace, input, readPolicyFile = fs.readFileSync, now = () => Date.now(),
  sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  // Half an input and frozen are read from the event and the checkout, before anything of GitHub: then nothing is read either.
  const named = { pr: Number(input?.pr) || null, head_sha: String(input?.head ?? '').trim() || null };
  if (!WITHOUT_INPUT(input) && !NAMED_INPUT(input)) return { result: 'refused', reason: BAD_INPUT, pr: named.pr, head_sha: input?.head ?? null };
  if (resolveMode({ env, workspace, readFile: readPolicyFile }).state === 'frozen') return { result: 'none', reason: 'merge admission is frozen: nothing is changed', ...named };
  const off = await phaseGate(env, fetchImpl);
  if (off) return { ...off, ...named };
  // A named run (the companion's dispatch or a person) brings up the pull request it names, as before the hold of FABLE-scaffold-
  // open-qs 问题 2 (gone with the hold, PLAN-train-held-deadlock-20261125 §2.1): it does not read the train.
  const result = await bringUp({ env, fetchImpl, workspace, input, readPolicyFile, now, sleep });
  return env.CLUED_FRONT_MERGE_PHASE === SCAFFOLD_PHASE ? notePendingAuthorization({ env, fetchImpl, result, now }) : result;
}

// Until 6b809301 is on the nodes (Decision 85effa31) a head the hosted copy made waits for DESK's authorize_head: one line on the
// pull request says so. A comment that cannot be posted (refused, or the network failed) is only reported; the merge
// stands either way and the run is not failed by this helper.
async function notePendingAuthorization({ env, fetchImpl, result, now }) {
  if (!SHA.test(result.merged_head_sha ?? '') || !result.pr) return result;
  let comment;
  try {
    const { token, reason } = await frontMergeToken({ env, fetchImpl, now });
    if (!token) comment = `not posted (${reason})`;
    else {
      const posted = await appRequest(fetchImpl, env, 'POST', `/repos/${env.GITHUB_REPOSITORY}/issues/${result.pr}/comments`, token,
        { body: `${pendingAuthorizationLine(result.merged_head_sha)}\n\nclued-front-main-merge-hosted: main merged into ${String(result.head_sha).slice(0, 12)}.` });
      comment = posted.status === 201 ? 'posted' : `not posted (HTTP ${posted.status})`;
    }
  } catch (error) {
    comment = `not posted (${error?.message ?? String(error)})`;
  }
  return { ...result, pending_authorization: true, comment };
}

const WITHOUT_INPUT = input => !String(input?.pr ?? '').trim() && !String(input?.head ?? '').trim();
const NAMED_INPUT = input => /^[1-9][0-9]{0,9}$/.test(String(input?.pr ?? '')) && SHA.test(String(input?.head ?? ''));
const BAD_INPUT = 'input needs pr (number) and head (full SHA)';

async function bringUp({ env, fetchImpl, workspace, input, readPolicyFile, now, sleep }) {
  if (WITHOUT_INPUT(input)) return runFrontChoice({ env, fetchImpl, workspace, readPolicyFile, now, sleep });
  const repository = env.GITHUB_REPOSITORY;
  const done = (result, reason, extra = {}) => ({ result, reason, pr: Number(input?.pr) || null, head_sha: input?.head ?? null, ...extra });
  if (!NAMED_INPUT(input)) return done('refused', BAD_INPUT);
  const number = Number(input.pr), head = input.head;
  const mode = resolveMode({ env, workspace, readFile: readPolicyFile });
  if (mode.state === 'frozen') return done('none', 'merge admission is frozen: nothing is changed');
  const pr = await githubJson(fetchImpl, env, `/repos/${repository}/pulls/${number}`);
  const main = pr?.base?.repo?.default_branch;
  if (pr?.state !== 'open' || pr.draft !== false || pr.base?.ref !== main || pr.base?.repo?.full_name !== repository || pr.head?.repo?.full_name !== repository)
    return done('none', 'the pull request is not an open, ready pull request of this repository into its default branch');
  if (pr.head.sha !== head) return done('none', `the pull request moved to ${String(pr.head.sha).slice(0, 12)}; the train names its new head itself`);
  const tip = (await githubJson(fetchImpl, env, `/repos/${repository}/branches/${encodeURIComponent(main)}`))?.commit?.sha;
  if (!SHA.test(tip ?? '')) return done('error', `the tip of ${main} could not be read`);
  const compare = await githubJson(fetchImpl, env, `/repos/${repository}/compare/${tip}...${head}`);
  if (!(Number(compare?.behind_by) > 0)) return done('none', `the head already contains ${main}`);
  const { token, reason, workflows } = await frontMergeToken({ env, fetchImpl, now });
  if (!token) return done('skipped', reason);
  const update = await appRequest(fetchImpl, env, 'PUT', `/repos/${repository}/pulls/${number}/update-branch`, token, { expected_head_sha: head });
  // 422: a conflict (the holder resolves it by hand) or the head moved; 403 with a token without workflows: write: main changed a
  // workflow file and the App's installation has no workflows permission (the Owner grants it once, §3; the token follows).
  if (update.status !== 202) return done('refused', `update-branch answered HTTP ${update.status}: ${String(update.body?.message ?? '').slice(0, 300)}`
    + (update.status === 403 && !workflows ? `（可能是${WORKFLOWS_REFUSED}）` : ''));
  let merged = null;
  for (let read = 0; read < HEAD_READS && !merged; read++) {
    await sleep(HEAD_READ_EVERY_MS);
    const current = await githubJson(fetchImpl, env, `/repos/${repository}/pulls/${number}`);
    if (current?.head?.sha && current.head.sha !== head) merged = current.head.sha;
  }
  if (!SHA.test(merged ?? '')) return done('unconfirmed', 'update-branch was accepted but the new head did not appear; the next dispatch looks again');
  const commit = await githubJson(fetchImpl, env, `/repos/${repository}/commits/${merged}`);
  const parents = Array.isArray(commit?.parents) ? commit.parents.map(p => p?.sha) : [];
  const mainNow = (await githubJson(fetchImpl, env, `/repos/${repository}/branches/${encodeURIComponent(main)}`))?.commit?.sha;
  const ours = commit?.sha === merged && parents.length === 2 && parents[0] === head && [tip, mainNow].includes(parents[1])
    && commit.committer?.login === 'web-flow' && commit.commit?.verification?.verified === true;
  if (!ours) return done('unattested', `the new head ${merged.slice(0, 12)} is not GitHub's merge of main into ${head.slice(0, 12)}; it keeps needing the holder's authorization`, { merged_head_sha: merged });
  const check = await appRequest(fetchImpl, env, 'POST', `/repos/${repository}/check-runs`, token, {
    name: MAIN_MERGE_CHECK, head_sha: merged, status: 'completed', conclusion: 'success',
    external_id: mainMergeExternalId({ pr: number, from: head, main: parents[1] }),
    output: { title: `main ${parents[1].slice(0, 12)} merged into ${head.slice(0, 12)}`,
      summary: `The merge train's front was behind ${main}. The clued-admission App brought ${main} in (update-branch, GitHub's own merge); `
        + `nothing else changed. The admission carries the holder's authorization of ${head} to this commit.` } });
  if (check.status !== 201 || Number(check.body?.app?.id ?? ADMISSION_APP_ID) !== ADMISSION_APP_ID)
    return done('unattested', `the attestation check could not be posted (HTTP ${check.status}); the head keeps needing the holder's authorization`, { merged_head_sha: merged });
  return done('merged', `main ${parents[1].slice(0, 12)} merged into ${head.slice(0, 12)} -> ${merged.slice(0, 12)}`, { merged_head_sha: merged, main_sha: parents[1] });
}

export function renderSummary(r) {
  const named = `## clued-front-main-merge\n\n- #${r.pr ?? '?'} \`${String(r.head_sha ?? '').slice(0, 12)}\`: **${r.result}**: ${r.reason}\n`
    + (r.pending_authorization ? `- #${r.pr} ${pendingAuthorizationLine(r.merged_head_sha)}（PR 评论 ${r.comment}）\n` : '');
  if (!r.train) return named;
  // A run without inputs: what it did, then everyone on the train and why each was or was not the one.
  return (r.pr === null ? `## clued-front-main-merge\n\n- nobody brought up: **${r.result}**: ${r.reason}\n` : named)
    + `\nThe train (auto-merge on) at main \`${String(r.train.main).slice(0, 12)}\`, in order:\n\n`
    + (r.train.members.map(m => `- #${m.pr} \`${String(m.head).slice(0, 12)}\`: ${m.behind === 0 ? 'contains main' : `behind by ${m.behind}`}, ${m.state}\n`).join('') || '- nobody\n')
    + (r.named?.length ? `\nStalled (§3.11: required checks not all there, nothing queued or running for ${STALLED_AFTER_MS / 60_000} minutes):\n\n`
      + r.named.map(n => `- #${n.pr} \`${String(n.head).slice(0, 12)}\`: ${(n.missing ?? []).map(m => `${m.context} ${m.last}`).join(', ') || '?'}; ${n.comment}\n`).join('') : '');
}

function announceNoMerge(result) {
  if (result.result === 'merged') return;
  const members = result.train?.members ?? [];
  const details = members.slice(0, 10).map(({ pr, behind, state }) => `#${pr} (behind ${behind}): ${state}`);
  if (members.length > details.length) details.push('see train members in the run summary');
  const message = [result.reason, ...details].join(' | ').replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::notice title=clued-front-main-merge::${result.result}: ${message}`);
}

// clock: { now, sleep } for tests.
export async function main(env = process.env, fetchImpl = globalThis.fetch, clock = {}, argv = process.argv.slice(2)) {
  if (argv[0] === '--phase') return phaseMain(env, fetchImpl);
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const result = await runFrontMainMerge({ env, fetchImpl, workspace: env.GITHUB_WORKSPACE, input: event.inputs ?? {}, ...clock });
  console.log(JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
  announceNoMerge(result);
  return result.result === 'error' ? 1 : 0;
}

// The hosted copy's first job, without the App key: in_force=true|false on GITHUB_OUTPUT, reading only; exit 0 either way.
async function phaseMain(env, fetchImpl) {
  const off = await phaseGate({ ...env, CLUED_FRONT_MERGE_PHASE: SCAFFOLD_PHASE }, fetchImpl);
  const line = `in_force=${off ? 'false' : 'true'}`;
  console.log(off ? `${line} (${off.result}: ${off.reason})` : line);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
  if (env.GITHUB_STEP_SUMMARY && off) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## clued-front-main-merge-hosted\n\n- not in force, **${off.result}**: ${off.reason}\n`);
  if (off) announceNoMerge(off);
  return 0;
}

if (import.meta.main) {
  main().then(code => process.exit(code), error => { console.error(error); process.exit(1); });
}
