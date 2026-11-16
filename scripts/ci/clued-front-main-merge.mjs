#!/usr/bin/env node
// Brings main into the merge train's front (Owner Decisions 9e2511fe item 3 and
// 78a3052f item 2; resident DESIGN §80). strict lets GitHub merge only a head
// that contains main's tip; a front that fell behind used to wait for a person
// to merge main, authorize the merge commit and push it.
//
// Started by workflow_dispatch (.github/workflows/clued-front-main-merge.yml)
// with the PR and the head the train named: by the on-duty node's companion
// when stage 10 says FRONT_NEEDS_MAIN_MERGE (resident front-merge-dispatch.mjs),
// or by a person. It does one thing, as the clued-admission App, and only when
// it is still true: the PR is open, not a draft, into main, from this
// repository, still at that head, behind main and not of the protected layer
// (78a3052f item 2: those stay with their holder); merge admission is not
// frozen. Then:
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

import fs from 'node:fs';
import { ADMISSION_APP_ID, MAIN_MERGE_CHECK, appJwt, changedPathsOfPullRequest, githubJson, mainMergeExternalId } from './clued-work-admission.mjs';
import { appRequest } from './clued-managed-auto-merge.mjs';
import { layerOf, resolveMode } from './merge-admission-policy.mjs';

export const FRONT_MERGE_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write', checks: 'write' });
// update-branch answers 202 and merges asynchronously; the new head is read this often, at most this many times.
export const HEAD_READ_EVERY_MS = 3_000;
export const HEAD_READS = 20;
const SHA = /^[0-9a-f]{40}$/;

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

export async function runFrontMainMerge({ env, fetchImpl, workspace, input, readPolicyFile = fs.readFileSync, now = () => Date.now(),
  sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
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
  // 78a3052f item 2: a protected-layer pull request (by its own changes; an incomplete file list counts as protected) stays with its holder.
  const own = await changedPathsOfPullRequest(fetchImpl, env, repository, number);
  const layer = layerOf(own.paths, mode.policy, { unknown: Number.isInteger(pr.changed_files) && own.file_count < pr.changed_files });
  if (layer === 'protected') return done('none', 'a protected-layer pull request: its holder merges main (Owner Decision 78a3052f item 2)');
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
  return `## clued-front-main-merge\n\n- #${r.pr ?? '?'} \`${String(r.head_sha ?? '').slice(0, 12)}\`: **${r.result}**: ${r.reason}\n`;
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const result = await runFrontMainMerge({ env, fetchImpl, workspace: env.GITHUB_WORKSPACE, input: event.inputs ?? {} });
  console.log(JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
  if (!['merged', 'none'].includes(result.result)) console.error(`::notice title=clued-front-main-merge::${result.result}: ${result.reason}`);
  return result.result === 'error' ? 1 : 0;
}

if (import.meta.main) {
  main().then(code => process.exit(code), error => { console.error(error); process.exit(1); });
}
