import { createHash, createSign } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = /^[a-f0-9]{40}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function jwt(appId, key, now) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540, iss: String(appId) })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}

// This port cannot merge, write contents, change rules or dispatch a workflow.
// The private-key provider belongs to the protected control-service principal;
// it is never passed to worker processes, manifests, PRs or loggers.
export function createGitHubChecksPort({ repository, repositoryId, appId, installationId,
  privateKeyProvider, fetchImpl = globalThis.fetch, clock = Date.now, maxPages = 10,
  forbiddenAppIds = [5365273, 5164952], includeModeRead = false } = {}) {
  if (!repoPattern.test(repository ?? '') || ![repositoryId, appId, installationId].every(positive)
    || [5365273, 5164952].includes(appId) || !Array.isArray(forbiddenAppIds)
    || forbiddenAppIds.includes(appId) || typeof privateKeyProvider !== 'function'
    || typeof fetchImpl !== 'function' || !positive(maxPages) || maxPages > 100
    || typeof includeModeRead !== 'boolean') fail('invalid_checks_configuration');
  const root = `https://api.github.com/repos/${repository}`;
  let token = null;
  async function request(url, method, bearer, body) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.github.com' || parsed.username || parsed.password) fail('invalid_github_origin');
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${bearer}`,
          'x-github-api-version': '2022-11-28', 'user-agent': 'clued-independent-ci',
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { fail('github_transport_unconfirmed'); }
    if (!response.ok) fail(`github_http_${response.status}`);
    try { return await response.json(); } catch { fail('github_response_invalid'); }
  }
  async function credential() {
    if (token && Date.parse(token.expires_at) > clock() + 60_000) return token.token;
    let appJwt;
    try { appJwt = jwt(appId, await privateKeyProvider(), clock()); }
    catch { fail('github_credential_unavailable'); }
    const app = await request('https://api.github.com/app', 'GET', appJwt);
    if (app.id !== appId) fail('unexpected_app_identity');
    const requested = { checks: 'write', contents: 'read', pull_requests: 'read',
      ...(includeModeRead ? { actions_variables: 'read', environments: 'read' } : {}) };
    const minted = await request(`https://api.github.com/app/installations/${installationId}/access_tokens`, 'POST', appJwt,
      { repository_ids: [repositoryId], permissions: requested });
    const permissions = minted.permissions;
    const allowed = { ...requested, metadata: 'read' };
    if (!minted.token || !Number.isFinite(Date.parse(minted.expires_at))
      || Date.parse(minted.expires_at) <= clock() || Date.parse(minted.expires_at) > clock() + 3_660_000
      || !permissions || Object.entries(permissions).some(([name, value]) => allowed[name] !== value)
      || !Object.keys(requested).every(name => permissions[name] === allowed[name])) fail('unexpected_installation_token_scope');
    const repos = await request('https://api.github.com/installation/repositories?per_page=100', 'GET', minted.token);
    if (repos.total_count !== 1 || repos.repositories?.length !== 1 || repos.repositories[0].id !== repositoryId
      || repos.repositories[0].full_name !== repository) fail('unexpected_repository_scope');
    token = minted;
    return token.token;
  }
  async function scoped(route, method = 'GET', body) {
    if (!route.startsWith('/') || route.includes('..')) fail('invalid_github_route');
    return request(`${root}${route}`, method, await credential(), body);
  }
  function exactPr(pr, job) {
    return pr?.number === job.pr && pr.state === 'open' && pr.head?.sha === job.headSha
      && pr.base?.sha === job.baseSha && pr.base?.ref === 'main'
      && pr.head?.repo?.full_name === repository && pr.base?.repo?.full_name === repository
      && Number.isSafeInteger(pr.changed_files) && pr.changed_files > 0 && pr.changed_files <= 3000;
  }
  const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\x00-\x1f\\]/.test(value) && !value.startsWith('/')
    && !value.split('/').some(part => part === '' || part === '.' || part === '..');
  async function modeScope(route) {
    const seen = new Set(); let expected = null, found = null;
    for (let page = 1; page <= maxPages; page++) {
      const body = await scoped(`${route}?per_page=100&page=${page}`);
      if (!Number.isSafeInteger(body?.total_count) || body.total_count < 0 || !Array.isArray(body.variables)
        || body.variables.length > 100 || (expected !== null && expected !== body.total_count)) fail('mode_inventory_unconfirmed');
      expected = body.total_count;
      for (const variable of body.variables) {
        if (typeof variable?.name !== 'string' || seen.has(variable.name)) fail('mode_inventory_unconfirmed');
        seen.add(variable.name);
        if (variable.name === 'CLUED_MERGE_ADMISSION_STATE') {
          if (typeof variable.value !== 'string') fail('mode_value_unconfirmed');
          found = { value: variable.value, updatedAt: variable.updated_at ?? null };
        }
      }
      if (seen.size === expected) return { exists: found !== null, ...(found ?? {}), totalCount: expected };
      if (seen.size > expected || body.variables.length < 100) fail('mode_inventory_incomplete');
    }
    fail('mode_inventory_page_limit');
  }
  return Object.freeze({
    // Protected controller use only: never hand this token to a job/worker/logger.
    async getInstallationToken() { return credential(); },
    async readAdmissionMode() {
      if (!includeModeRead) fail('mode_read_not_configured');
      const repoMode = await modeScope('/actions/variables');
      const environmentMode = await modeScope('/environments/clued-admission/variables');
      const effective = environmentMode.exists ? environmentMode : repoMode;
      const observations = { repository: repoMode, environment: environmentMode };
      const observedAt = new Date(clock()).toISOString();
      const proof = { repository, variable: 'CLUED_MERGE_ADMISSION_STATE', observations, observedAt };
      return { complete: true, repository, variable: proof.variable, exists: effective.exists,
        ...(effective.exists ? { value: effective.value } : {}), observedAt,
        source: 'github-repository-variables', scopeObservations: observations,
        proofRef: `independent-observation:sha256:${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}` };
    },
    async readPullRequest(number) { if (!positive(number)) fail('invalid_pr'); return scoped(`/pulls/${number}`); },
    async readChangedPaths(job) {
      if (job?.repo !== repository || !positive(job.pr) || !sha.test(job.headSha) || !sha.test(job.baseSha)) fail('invalid_pr_subject');
      const before = await scoped(`/pulls/${job.pr}`);
      if (!exactPr(before, job)) fail('pr_subject_changed');
      const filenames = new Set(), paths = new Set();
      let complete = false;
      for (let page = 1; page <= maxPages; page++) {
        const files = await scoped(`/pulls/${job.pr}/files?per_page=100&page=${page}`);
        if (!Array.isArray(files) || files.length > 100) fail('invalid_pr_files');
        for (const file of files) {
          if (!safePath(file?.filename) || filenames.has(file.filename)
            || !['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status)
            || (file.status === 'renamed' && !safePath(file.previous_filename))) fail('invalid_pr_files');
          filenames.add(file.filename); paths.add(file.filename);
          if (file.status === 'renamed') paths.add(file.previous_filename);
        }
        if (filenames.size > before.changed_files) fail('pr_files_changed');
        if (filenames.size === before.changed_files) { complete = true; break; }
        if (files.length < 100) fail('incomplete_pr_files');
      }
      if (!complete) fail('pr_files_page_limit');
      const after = await scoped(`/pulls/${job.pr}`);
      if (!exactPr(after, job) || after.changed_files !== before.changed_files) fail('pr_subject_changed');
      return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: [...paths].sort() };
    },
    async readChecks(headSha) {
      if (!sha.test(headSha)) fail('invalid_head');
      const checks = []; let expected = null;
      for (let page = 1; page <= maxPages; page++) {
        const reply = await scoped(`/commits/${headSha}/check-runs?filter=all&per_page=100&page=${page}`);
        if (!Number.isSafeInteger(reply.total_count) || reply.total_count < 0 || !Array.isArray(reply.check_runs)
          || reply.check_runs.length > 100 || (expected !== null && expected !== reply.total_count)) fail('checks_pagination_changed');
        expected = reply.total_count; checks.push(...reply.check_runs);
        if (checks.length === expected) {
          if (new Set(checks.map(check => check.id)).size !== checks.length
            || checks.some(check => !positive(check.id) || check.head_sha !== headSha)) fail('invalid_check_set');
          return { complete: true, checks };
        }
        if (checks.length > expected || reply.check_runs.length < 100) fail('incomplete_checks');
      }
      fail('checks_page_limit');
    },
    async createCheck(body) {
      if (!body || !sha.test(body.head_sha) || body.status !== 'completed'
        || !['success', 'failure'].includes(body.conclusion) || typeof body.name !== 'string'
        || !body.external_id?.startsWith('independent-ci:')) fail('invalid_check_publication');
      return scoped('/check-runs', 'POST', body);
    },
    async revokeCheck(id, body) {
      if (!positive(id) || body?.status !== 'completed' || body.conclusion !== 'failure') fail('invalid_check_revocation');
      return scoped(`/check-runs/${id}`, 'PATCH', body);
    }
  });
}
