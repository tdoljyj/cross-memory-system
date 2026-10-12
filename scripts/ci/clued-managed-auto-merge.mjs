// Shared cleanup runs before slot reporting or executor qualification. It
// removes legacy waiting requests, without opening another request or CI.
import {appJwt,githubJson} from './clued-work-admission.mjs';
export const EXECUTOR_PERMISSIONS=Object.freeze({contents:'write',pull_requests:'write'});
export const optInSha=body=>/^\s*Clued-Auto-Merge:\s*([0-9a-f]{40})\s*$/im.exec(String(body??''))?.[1].toLowerCase()??null;
export function managedAutoMerge(pr) {
  return Boolean(pr?.auto_merge) && (Boolean(optInSha(pr.body)) || pr.auto_merge.enabled_by?.login==='clued-admission[bot]');
}
export async function appRequest(fetchImpl, env, method, route, bearer, body) {
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const response = await fetchImpl(`${base}${route}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${bearer}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "clued-merge-executor",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed,request_id:response.headers.get("x-github-request-id") };
}

// An installation token with the executor's permissions, or the reason there
// is none (the App is not configured, or the installation lacks a permission).
export async function executorToken({ env, fetchImpl, now = () => Date.now() }) {
  const appId = (env.CLUED_ADMISSION_APP_ID ?? "").trim();
  const key = (env.CLUED_ADMISSION_APP_PRIVATE_KEY ?? "").trim();
  if (!appId || !key) return { token: null, reason: "the clued-admission App is not configured (CLUED_ADMISSION_APP_ID / CLUED_ADMISSION_APP_PRIVATE_KEY)" };
  const repository = env.GITHUB_REPOSITORY;
  const jwt = appJwt(appId, key, Math.floor(now() / 1000));
  const installation = await appRequest(fetchImpl, env, "GET", `/repos/${repository}/installation`, jwt);
  if (installation.status !== 200 || !installation.body || !installation.body.id) {
    return { token: null, reason: `GitHub API GET /repos/${repository}/installation returned ${installation.status}` };
  }
  const minted = await appRequest(fetchImpl, env, "POST", `/app/installations/${installation.body.id}/access_tokens`, jwt,
    { repositories: [repository.split("/")[1]], permissions: EXECUTOR_PERMISSIONS });
  if (minted.status === 201 && minted.body && minted.body.token) return { token: minted.body.token, reason: null };
  if (minted.status === 422 || minted.status === 403) {
    return { token: null, reason: "the clued-admission App does not have Contents: write and Pull requests: write on this repository yet; the executor changed nothing (Owner Decision 5aa668e3)" };
  }
  return { token: null, reason: `GitHub API POST /app/installations/…/access_tokens returned ${minted.status}` };
}

// The newest clued-admission-verified check on the head posted for this pull
// request (review MINOR-2): admitted, and its mode.

const DISABLE='mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { number } } }';
export async function cleanupManagedAutoMerge({env,fetchImpl,pulls,now}) {
  const pending=pulls.filter(managedAutoMerge),blocked=new Set(pending.map(pr=>pr.number));
  const actions=[],notices=[],errors=[];
  if(!pending.length)return {blocked,actions,notices,errors};
  const {token,reason}=await executorToken({env,fetchImpl,now});
  if(!token)return {blocked,actions:pending.map(pr=>({pr:pr.number,head_sha:pr.head.sha,action:'skipped',wanted:'disable_auto_merge',reason})),notices:[reason],errors:["managed cleanup has no authorized App token"]};
  for(const pr of pending) {
    try {
      const current=await githubJson(fetchImpl,env,`/repos/${env.GITHUB_REPOSITORY}/pulls/${pr.number}`);
      if(!pr.node_id || current?.number!==pr.number || current.node_id!==pr.node_id || current.state!=='open' ||
        current.base?.repo?.full_name!==env.GITHUB_REPOSITORY)throw Error('managed PR identity changed');
      if(!managedAutoMerge(current)){actions.push({pr:pr.number,head_sha:current.head?.sha,action:'none',reason:'managed request no longer present'});continue;}
      const result=await appRequest(fetchImpl,env,'POST','/graphql',token,{query:DISABLE,variables:{id:current.node_id}});
      const success=result.status===200 && !result.body?.errors?.length && result.body?.data?.disablePullRequestAutoMerge?.pullRequest?.number===pr.number;
      actions.push({pr:pr.number,head_sha:current.head?.sha,action:'disable_auto_merge',status:result.status,
        reason:success?'removed managed waiting request before qualification; this invocation only cleans this PR':'managed waiting request cleanup refused',
        ...(success?{}:{error:'GitHub did not confirm managed auto-merge removal'})});
      if(!success)errors.push(`#${pr.number}: managed cleanup refused`);
      if(!success)notices.push(`#${pr.number}: could not remove managed waiting request; no qualification or execution attempted`);
    } catch {errors.push(`#${pr.number}: managed cleanup unavailable`);actions.push({pr:pr.number,head_sha:pr.head?.sha,action:'none',reason:'managed cleanup unavailable; no qualification or execution attempted'});}
  }
  return {blocked,actions,notices,errors};
}
