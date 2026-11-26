// Owner companion only. The installation token can rerun Actions in one
// repository. The installed runner hook never receives this App's key.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { appJwt } from '../../../scripts/runner/clued-runner-job-started.mjs';

const SHA = /^[a-f0-9]{40}$/;
const STAGING = 'clued-train/staging';
const TRAIN_ACTOR = 'clued-ci-checks-turing-20261018[bot]';
const WORKFLOWS = new Set(['.github/workflows/clued-required-tests.yml', '.github/workflows/clued-required-tests-windows.yml']);
const STATE = 'CLUED_MERGE_ADMISSION_STATE';
const ACTOR = 'CLUED_TRAIN_REPAIR_ACTOR_ID';
const positive = value => Number.isSafeInteger(value) && value > 0;
const unsent = why => ({ outcome: 'unsent', why });

export function createTrainRecoveryPort({ repository, appId, keyFile, fetchImpl = globalThis.fetch, readKey = readFile, now = Date.now }) {
  const id = Number(appId);
  const configured = /^[\w.-]+\/[\w.-]+$/.test(repository ?? '') && positive(id)
    && ![5368905, 5164952, 5365273].includes(id) && typeof keyFile === 'string' && path.isAbsolute(keyFile);
  const repoPath = '/repos/' + repository;
  function request(route, token, body, method = 'GET') {
    return fetchImpl('https://api.github.com' + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function json(route, token, body) {
    const reply = await request(route, token, body, body ? 'POST' : 'GET');
    if (reply.status !== (body ? 201 : 200)) throw new Error('recovery App read refused');
    return reply.json();
  }

  return async ({ runId, testSha, attempt, read }) => {
    if (!configured || !positive(runId) || !SHA.test(testSha ?? '') || ![1, 2].includes(attempt))
      return unsent('列车 v2 恢复 App 或运行标识未就绪');
    const route = '/actions/runs/' + runId;
    let token;
    try {
      const jwt = appJwt(id, await readKey(keyFile, 'utf8'), Math.floor(now() / 1000));
      const app = await json('/app', jwt);
      if (app.id !== id || !/^[a-z0-9-]+$/.test(app.slug ?? '') || app.slug + '[bot]' === TRAIN_ACTOR)
        return unsent('列车 v2 恢复 App 身份不符');
      const install = await json(repoPath + '/installation', jwt);
      if (!positive(install.id) || install.app_id !== id)
        return unsent('列车 v2 恢复 App 安装或帐号不符');
      const minted = await json('/app/installations/' + install.id + '/access_tokens', jwt, {
        repositories: [repository.split('/')[1]], permissions: { actions: 'write' },
      });
      if (typeof minted.token !== 'string' || !minted.token || minted.permissions?.actions !== 'write'
        || Object.entries(minted.permissions).some(([name, value]) => name !== 'actions' && !(name === 'metadata' && value === 'read')))
        return unsent('列车 v2 恢复 App 令牌权限不符');
      token = minted.token;
      const [actor, run, ref, pin, repoMode, envMode] = await Promise.all([
        json('/users/' + encodeURIComponent(app.slug + '[bot]'), token),
        read(route), read('/git/ref/heads/' + STAGING), read('/actions/variables/' + ACTOR),
        read('/actions/variables/' + STATE, { missingOk: true }),
        read('/environments/clued-admission/variables/' + STATE, { missingOk: true }),
      ]);
      const mode = (envMode?.value ?? repoMode?.value ?? '').trim() || 'normal';
      if (!positive(actor.id) || actor.type !== 'Bot' || actor.login !== app.slug + '[bot]'
        || pin?.name !== ACTOR || pin.value !== String(actor.id) || !['normal', 'efficiency'].includes(mode)
        || (envMode !== null && envMode?.name !== STATE) || (repoMode !== null && repoMode?.name !== STATE)
        || run?.id !== runId || run.head_sha !== testSha || run.run_attempt !== attempt || run.event !== 'push'
        || run.head_branch !== STAGING || run.actor?.login !== TRAIN_ACTOR || !WORKFLOWS.has(run.path)
        || run.status !== 'completed' || ref?.ref !== 'refs/heads/' + STAGING || ref.object?.sha !== testSha)
        return unsent('列车 v2 恢复身份、模式或原运行已变化');
    } catch {
      return unsent('列车 v2 恢复身份或原运行无法核对');
    }

    // A lost reply is ambiguous. The caller's preceding durable intent
    // prevents another POST for the same run and target attempt.
    try {
      const reply = await request(repoPath + route + '/rerun', token, undefined, 'POST');
      if (reply.status === 201) return { outcome: 'sent' };
      if (reply.status >= 400 && reply.status < 500)
        return { outcome: 'refused', http: reply.status, why: 'GitHub 拒绝列车恢复请求' };
    } catch { /* a request may already have reached GitHub */ }
    return { outcome: 'unknown', why: '列车 v2 恢复请求回执未确认' };
  };
}
