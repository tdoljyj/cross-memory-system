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
// without inputs) it chooses the pull request itself, from GitHub's records of
// this moment and nothing kept between runs (chooseFront below):
//   the train   = the open, ready pull requests of this repository into main
//                 that have auto-merge on (auto-merge on is the one way aboard);
//   the front   = one of them that contains main's tip and is under way: no
//                 required check failed on its head, and it is not idle;
//   a candidate = one of them behind main, not reported as a conflict, no
//                 required check failed on its head, and its head is not one the
//                 App brought up that the independent CI never admitted.
// With a front it does nothing. Without one it brings the candidate whose
// auto-merge was enabled first (ties: the lower number) exactly as a named run
// does, one per run. A red or idle front, a lost event or a failed run need no
// memory: the next run reads the same records again.

import fs from 'node:fs';
import { ADMISSION_APP_ID, INDEPENDENT_ADMISSION_APP_ID, INDEPENDENT_ADMISSION_CHECK, MAIN_MERGE_CHECK, appJwt, githubJson, githubPaged,
  mainMergeExternalId } from './clued-work-admission.mjs';
import { appRequest } from './clued-managed-auto-merge.mjs';
import { resolveMode } from './merge-admission-policy.mjs';

export const FRONT_MERGE_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write', checks: 'write' });
// update-branch answers 202 and merges asynchronously; the new head is read this often, at most this many times.
export const HEAD_READ_EVERY_MS = 3_000;
export const HEAD_READS = 20;
const SHA = /^[0-9a-f]{40}$/;
// A head that contains main is idle once it is this old with nothing queued, running or pending on it and its required
// checks not all green (the rule of the hooks' wait-pr exit 5): nothing will finish it, so it is not the front.
export const IDLE_AFTER_MS = 15 * 60_000;
// A list (open pull requests, branch rules) is read 100 a page, at most this many pages; one that goes on is not known in full.
const PAGES = 10;
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
const GREEN = new Set(['success', 'skipped', 'neutral']);
// The independent CI withdrew this check (no verdict on the code); its pending status that says it stopped will not finish.
const WITHDRAWN = 'Independent CI check withdrawn', STOPPED = '已停止';
const TRAIN_QUERY = 'query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){defaultBranchRef{name} '
  + 'pullRequests(states:OPEN,first:100,after:$after){pageInfo{hasNextPage endCursor} '
  + 'nodes{number isDraft baseRefName headRefOid mergeable updatedAt autoMergeRequest{enabledAt} headRepository{nameWithOwner}}}}}';

// An installation token of the clued-admission App with exactly these permissions, or the reason there is none.
export async function frontMergeToken({ env, fetchImpl, now = () => Date.now() }) {
  const appId = (env.CLUED_ADMISSION_APP_ID ?? '').trim(), key = (env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? '').trim();
  if (!appId || !key) return { token: null, reason: 'the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY)' };
  const jwt = appJwt(appId, key, Math.floor(now() / 1000));
  const installation = await appRequest(fetchImpl, env, 'GET', `/repos/${env.GITHUB_REPOSITORY}/installation`, jwt);
  if (installation.status !== 200 || !installation.body?.id) return { token: null, reason: `GET installation returned ${installation.status}` };
  const minted = await appRequest(fetchImpl, env, 'POST', `/app/installations/${installation.body.id}/access_tokens`, jwt,
    { repositories: [env.GITHUB_REPOSITORY.split('/')[1]], permissions: FRONT_MERGE_PERMISSIONS });
  if (minted.status === 201 && minted.body?.token) return { token: minted.body.token, reason: null };
  return { token: null, reason: `the clued-admission App token with ${Object.entries(FRONT_MERGE_PERMISSIONS).map(([k, v]) => `${k}: ${v}`).join(', ')} was refused (HTTP ${minted.status})` };
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

// What ran on one head, as the ruleset reads it: the newest check run of each name and the newest status of each context.
async function headRecords({ env, fetchImpl, repository, head, required }) {
  const runs = await githubPaged(fetchImpl, env, `/repos/${repository}/commits/${head}/check-runs`, 'check_runs');
  const statuses = await listedInFull(fetchImpl, env, `/repos/${repository}/commits/${head}/status`, 'statuses', `the statuses of ${head}`);
  const checks = new Map(), contexts = new Map();
  const newer = (a, b) => String(a.started_at ?? '') > String(b.started_at ?? '') || (a.started_at === b.started_at && Number(a.id) > Number(b.id));
  for (const run of runs) if (!checks.has(run.name) || newer(run, checks.get(run.name))) checks.set(run.name, run);
  for (const status of statuses) if (!contexts.has(status.context)) contexts.set(status.context, status);
  const withdrawn = run => String(run.output?.title ?? '').startsWith(WITHDRAWN);
  const failed = required.filter(name => {
    const run = checks.get(name), state = contexts.get(name)?.state;
    return (run && FAILED.has(run.conclusion) && !withdrawn(run)) || state === 'failure' || state === 'error';
  });
  const green = required.every(name => {
    const run = checks.get(name);
    return (run?.status === 'completed' && GREEN.has(run.conclusion) && !withdrawn(run)) || contexts.get(name)?.state === 'success';
  });
  const unfinished = runs.filter(run => run.status !== 'completed').length
    + statuses.filter(status => status.state === 'pending' && !String(status.description ?? '').includes(STOPPED)).length;
  const by = (name, app) => runs.some(run => run.name === name && Number(run.app?.id) === app && run.status === 'completed' && run.conclusion === 'success');
  return { failed, green, unfinished, brought: by(MAIN_MERGE_CHECK, ADMISSION_APP_ID), admitted: by(INDEPENDENT_ADMISSION_CHECK, INDEPENDENT_ADMISSION_APP_ID) };
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
  const rules = [];
  for (let page = 1; ; page++) {
    const chunk = await githubJson(fetchImpl, env, `/repos/${repository}/rules/branches/${encodeURIComponent(main)}?per_page=100&page=${page}`);
    if (!Array.isArray(chunk)) throw new Error(`the rules of ${main} could not be read`);
    rules.push(...chunk);
    if (chunk.length < 100) break;
    if (page === PAGES) throw new Error(`the rules of ${main} fill more than ${PAGES} pages: the required checks are not known in full`);
  }
  const required = [...new Set(rules.filter(rule => rule?.type === 'required_status_checks')
    .flatMap(rule => (rule.parameters?.required_status_checks ?? []).map(check => check?.context)).filter(Boolean))];
  if (!required.length) throw new Error(`the rules of ${main} name no required check`);
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
  for (const member of train.filter(member => member.behind === 0)) {
    const records = await headRecords({ env, fetchImpl, repository, head: member.head, required });
    const running = await listedInFull(fetchImpl, env, `/repos/${repository}/actions/runs?head_sha=${member.head}`, 'workflow_runs', `the workflow runs of ${member.head}`);
    if (records.failed.length) { member.state = `red (${records.failed.join(', ')})`; continue; }
    member.state = 'front';
    if (records.green || records.unfinished + running.filter(run => run.status !== 'completed').length > 0) continue;
    // Quiet and not green. The head appeared with its commit or, for an older commit pushed later, with the push (the PR's last change).
    const committed = Date.parse((await githubJson(fetchImpl, env, `/repos/${repository}/commits/${member.head}`))?.commit?.committer?.date);
    const appeared = Math.max(Number.isFinite(committed) ? committed : 0, Number.isFinite(member.updated) ? member.updated : 0);
    if (!(appeared > 0)) throw new Error(`the age of ${member.head} could not be read`);
    if (now() - appeared >= IDLE_AFTER_MS) member.state = 'idle';
  }
  const candidates = [];
  if (!train.some(member => member.state === 'front')) for (const member of train.filter(member => member.behind > 0)) {
    if (member.mergeable === 'CONFLICTING') { member.state = 'conflict'; continue; }
    const records = await headRecords({ env, fetchImpl, repository, head: member.head, required });
    if (records.failed.length) member.state = `red (${records.failed.join(', ')})`;
    else if (records.brought && !records.admitted) member.state = 'brought up before and not admitted';
    else { member.state = 'candidate'; candidates.push(member); }
  }
  for (const member of train) member.state ??= 'behind';
  return { main, tip, train, candidates };
}

// A run without inputs: with no front, the first candidate that GitHub lets it update.
async function runFrontChoice(ports) {
  const { env, fetchImpl, workspace, readPolicyFile, now } = ports;
  const done = (result, reason, train) => ({ result, reason, pr: null, head_sha: null, ...(train ? { train } : {}) });
  if (resolveMode({ env, workspace, readFile: readPolicyFile }).state === 'frozen') return done('none', 'merge admission is frozen: nothing is changed');
  let chosen;
  try {
    chosen = await chooseFront({ env, fetchImpl, now });
  } catch (error) {
    return done('skipped', `GitHub could not be read (${error instanceof Error ? error.message : String(error)}); nothing is changed, the next run looks again`);
  }
  const train = { main: chosen.tip, members: chosen.train.map(({ pr, head, behind, state }) => ({ pr, head, behind, state })) };
  const front = chosen.train.find(member => member.state === 'front');
  if (front) return done('none', `#${front.pr} contains ${chosen.main} and is under way`, train);
  if (!chosen.candidates.length)
    return done('none', chosen.train.length ? 'no pull request on the train can be brought up now' : 'no open pull request has auto-merge on', train);
  for (const candidate of chosen.candidates) {
    const result = await runFrontMainMerge({ ...ports, input: { pr: String(candidate.pr), head: candidate.head } });
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
  if (!String(input?.pr ?? '').trim() && !String(input?.head ?? '').trim()) return runFrontChoice({ env, fetchImpl, workspace, readPolicyFile, now, sleep });
  const repository = env.GITHUB_REPOSITORY;
  const done = (result, reason, extra = {}) => ({ result, reason, pr: Number(input?.pr) || null, head_sha: input?.head ?? null, ...extra });
  if (!/^[1-9][0-9]{0,9}$/.test(String(input?.pr ?? '')) || !SHA.test(String(input?.head ?? ''))) return done('refused', 'input needs pr (number) and head (full SHA)');
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
  const { token, reason } = await frontMergeToken({ env, fetchImpl, now });
  if (!token) return done('skipped', reason);
  const update = await appRequest(fetchImpl, env, 'PUT', `/repos/${repository}/pulls/${number}/update-branch`, token, { expected_head_sha: head });
  // 422: a conflict (the holder resolves it by hand) or the head moved; 403: e.g. main changed a workflow file and the App has no workflows permission.
  if (update.status !== 202) return done('refused', `update-branch answered HTTP ${update.status}: ${String(update.body?.message ?? '').slice(0, 300)}`);
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
  const named = `## clued-front-main-merge\n\n- #${r.pr ?? '?'} \`${String(r.head_sha ?? '').slice(0, 12)}\`: **${r.result}**: ${r.reason}\n`;
  if (!r.train) return named;
  // A run without inputs: what it did, then everyone on the train and why each was or was not the one.
  return (r.pr === null ? `## clued-front-main-merge\n\n- nobody brought up: **${r.result}**: ${r.reason}\n` : named)
    + `\nThe train (auto-merge on) at main \`${String(r.train.main).slice(0, 12)}\`, in order:\n\n`
    + (r.train.members.map(m => `- #${m.pr} \`${String(m.head).slice(0, 12)}\`: ${m.behind === 0 ? 'contains main' : `behind by ${m.behind}`}, ${m.state}\n`).join('') || '- nobody\n');
}

// clock: { now, sleep } for tests.
export async function main(env = process.env, fetchImpl = globalThis.fetch, clock = {}) {
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const result = await runFrontMainMerge({ env, fetchImpl, workspace: env.GITHUB_WORKSPACE, input: event.inputs ?? {}, ...clock });
  console.log(JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
  if (!['merged', 'none'].includes(result.result)) console.error(`::notice title=clued-front-main-merge::${result.result}: ${result.reason}`);
  return result.result === 'error' ? 1 : 0;
}

if (import.meta.main) {
  main().then(code => process.exit(code), error => { console.error(error); process.exit(1); });
}
