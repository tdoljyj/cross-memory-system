import { createHash, createSign } from 'node:crypto';
import { collectPRPaths } from '../../../../scripts/ci/clued-pr-write-set.mjs';
// Shared with the optional modern controller's retry wrapper without adding a
// module dependency to the legacy v1 Source's frozen closure.
const READ_REQUEST_DEADLINE = Symbol.for('clued-read-request-deadline');
const READ_REQUEST_GUARD = Symbol.for('clued-read-request-guard');
const READ_REQUEST_NO_RETRY = Symbol.for('clued-read-request-no-retry');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const TRAIN_WORKFLOWS = new Set(['.github/workflows/clued-required-tests.yml', '.github/workflows/clued-required-tests-windows.yml',
  '.github/workflows/hosted-required.yml']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = /^[a-f0-9]{40}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const stagedScanNames = ['gitleaks', 'trivy', 'contract-placement'];
const stagedScanExternalId = /^independent-ci:staged:v2:[a-f0-9]{64}:a[12]$/;
const STAGED_SCAN_REQUEST_MS = 2_000;
// Bounded transport retry. A transport failure is a fetch() rejection or a body
// cut off mid-read whose cause carries one of the network codes below. An HTTP
// status, a redirect (refused by redirect:'error'), an unparsable body and any
// refusal raised by the caller's fetchImpl (context, acceptance, abort, timeout)
// are never retried and keep their codes; a body cut off mid-read now reports
// github_transport_unconfirmed instead of github_response_invalid. Generation 11
// (resident DESIGN 55): one exception, a 500/502/503/504 answer to a request
// that is not a GET. For a write with a read-back (check create, revocation) it
// is read back at every remaining delay of the window, never sent again; for
// the two POSTs that are reads (repeatable: the installation-token mint and the
// GraphQL force-push read) it is sent again like a cut connection.
// Budget: within any RETRY_SPAN_MS (30 s, the cross-machine challenge deadline)
// all retries of one port together - their delays, repeated attempts and write
// read-backs - take at most retryWindowMs (default 4 s); each repeated attempt's
// own timeout is cut to what is left. First attempts are unchanged. So an issuer
// evaluate() lasts at most its no-retry time plus 4 s, and the 30 s deadline
// (unchanged) still refuses any late response.
const RETRY_DELAYS_MS = Object.freeze([250, 750]);
const RETRY_SPAN_MS = 30_000, MIN_ATTEMPT_MS = 1_000;
const NETWORK_CODES = Object.freeze(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const transportFailure = error => error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message)
  && NETWORK_CODES.includes(error.cause?.code);
// Connect phase only (DNS lookup or TCP connect, never a reused socket): no
// request byte left this host. Only such a fetch() rejection lets a write be
// sent a second time, and only after a read-back finds no copy on GitHub.
const connectPhase = cause => ['connect', 'getaddrinfo'].includes(cause?.syscall) || cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
  || (cause instanceof AggregateError && cause.errors.length > 0 && cause.errors.every(error => error?.syscall === 'connect'));
const transport = (error, sent) => Object.assign(new Error('github_transport_unconfirmed'), { code: 'github_transport_unconfirmed',
  retryable: transportFailure(error), unsent: !sent && transportFailure(error) && connectPhase(error.cause) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Generation 11 (resident DESIGN 55): a 500/502/503/504 answer to a write says nothing about whether GitHub applied it (a gateway can
// answer after the write landed). It is read back like a reply cut off after sending: the copy GitHub holds is returned, and the
// write is never sent again (unsent false). A read (GET) keeps its own retry (read-retry.mjs); any other status stays final.
const WRITE_AMBIGUOUS_STATUS = Object.freeze([500, 502, 503, 504]);
const ambiguousWrite = status => Object.assign(new Error(`github_http_${status}`), { code: `github_http_${status}`, retryable: true, unsent: false, ambiguous: true });

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
  forbiddenAppIds = [5365273, 5164952], includeModeRead = false, includeActionsRead = false, retryWindowMs = 4_000, sleep = wait, budgetObserver = null, budgetObservedAtFetch = false,
  stagedScanJournal = null, batchRoute = null } = {}) {
  if (!repoPattern.test(repository ?? '') || ![repositoryId, appId, installationId].every(positive)
    || [5365273, 5164952].includes(appId) || !Array.isArray(forbiddenAppIds)
    || forbiddenAppIds.includes(appId) || typeof privateKeyProvider !== 'function'
    || typeof fetchImpl !== 'function' || !positive(maxPages) || maxPages > 100
    || typeof includeModeRead !== 'boolean' || typeof includeActionsRead !== 'boolean' || typeof clock !== 'function' || typeof sleep !== 'function'
    || !Number.isSafeInteger(retryWindowMs) || retryWindowMs < 0 || retryWindowMs > 10_000 || typeof budgetObservedAtFetch !== 'boolean'
    || (budgetObservedAtFetch && budgetObserver === null)
    || (budgetObserver !== null && !['begin', 'observe', 'observeBody', 'seed', 'snapshot'].every(k => typeof budgetObserver?.[k] === 'function'))) fail('invalid_checks_configuration');
  const root = `https://api.github.com/repos/${repository}`;
  // Optional telemetry is injected by the modern controller. A legacy consumer
  // has no observer/capability and keeps its original request behavior.
  let budgetBroken = false, fallbackRequests = 0, fallbackGraphql = 0;
  const unknownBudget = () => ({ contract: 'clued.independent-ci.train-provider-budget/1', state: 'unknown', requests: fallbackRequests,
    restRequests: fallbackRequests - fallbackGraphql, graphqlRequests: fallbackGraphql, rest: null, graphql: null,
    retryAt: null, observedAt: null, extraSlicesAllowed: false });
  const budgetCall = (method, ...args) => {
    if (budgetBroken || !budgetObserver) return undefined;
    try { return budgetObserver[method](...args); } catch { budgetBroken = true; return undefined; }
  };
  const budget = {
    begin(url) { fallbackRequests++; if (new URL(url).pathname === '/graphql') fallbackGraphql++; budgetCall('begin', url); },
    observe(...args) { budgetCall('observe', ...args); },
    observeBody(...args) { budgetCall('observeBody', ...args); },
    seed(...args) { budgetCall('seed', ...args); },
    snapshot() { return budgetCall('snapshot') ?? unknownBudget(); }
  };
  let maintenanceRateControl = false;
  const respectProviderHold = () => {
    if (maintenanceRateControl && Date.parse(budget.snapshot().retryAt ?? '') > clock()) fail('github_rate_limited');
  };
  let token = null;
  // Retry spending of this port: one entry per retried request, its upper bound
  // reserved while it runs and replaced by the actual time when it ends.
  const spent = [];
  function available(now) {
    for (let i = spent.length - 1; i >= 0; i--) if (spent[i].at + spent[i].ms <= now - RETRY_SPAN_MS) spent.splice(i, 1);
    return retryWindowMs - spent.reduce((sum, entry) => sum + entry.ms, 0);
  }
  async function send(url, method, bearer, body, timeoutMs, requestDeadline = null, beforeSend = null, noRetry = false) {
    if (!(timeoutMs >= 1)) fail('github_transport_unconfirmed');
    // Only the maintenance consumer opts in. Once the provider has told it to
    // wait, another read/write in this invocation must not ignore that deadline.
    respectProviderHold();
    const options = { method, redirect: 'error', signal: AbortSignal.timeout(Math.min(30_000, timeoutMs)),
        ...(Number.isFinite(requestDeadline) ? { [READ_REQUEST_DEADLINE]: requestDeadline } : {}),
        ...(maintenanceRateControl ? { [READ_REQUEST_GUARD]: respectProviderHold } : {}),
        ...(noRetry ? { [READ_REQUEST_NO_RETRY]: true } : {}),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${bearer}`,
          'x-github-api-version': '2022-11-28', 'user-agent': 'clued-independent-ci',
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) };
    if (!budgetObservedAtFetch) budget.begin(url);
    beforeSend?.();
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) { if (error?.code === 'github_rate_limited') throw error; throw transport(error, false); }
    if (!budgetObservedAtFetch) budget.observe(url, response);
    if (!response.ok) {
      if (method !== 'GET' && WRITE_AMBIGUOUS_STATUS.includes(response.status)) throw ambiguousWrite(response.status);
      fail(`github_http_${response.status}`);
    }
    // A reply arrived: the request was sent and, for a write, accepted.
    try { const body = await response.json(); budget.observeBody(url, body); return body; } catch (error) {
      if (transportFailure(error)) throw transport(error, true);
      fail('github_response_invalid');
    }
  }
  // A read is repeated. A write is never repeated blind: after a transport
  // failure it is read back first and the copy GitHub already holds is returned;
  // it is sent again only when the failure was a connect-phase fetch() rejection
  // and the read-back shows no copy. A failed read-back keeps the original
  // failure. `until` bounds a read-back's own requests by the retry it serves.
  async function request(url, method, bearer, body, { repeatable = method === 'GET', readBack = null, until = null, beforeSend = null, noRetry = false } = {}) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.github.com' || parsed.username || parsed.password) fail('invalid_github_origin');
    let failure;
    try { return await send(url, method, bearer, body, until === null ? 30_000 : until - clock(), until, beforeSend, noRetry); } catch (error) { failure = error; }
    if (noRetry || !failure?.retryable || (!repeatable && !readBack)) throw failure;
    const opened = clock(), left = Math.min(available(opened), until === null ? Infinity : until - opened);
    if (!(left >= RETRY_DELAYS_MS[0] + MIN_ATTEMPT_MS)) throw failure;
    const reservation = { at: opened, ms: left }, retryUntil = opened + left;
    spent.push(reservation);
    try {
      for (const delay of RETRY_DELAYS_MS) {
        if (!(retryUntil - clock() >= delay + MIN_ATTEMPT_MS)) break;
        await sleep(delay);
        if (!repeatable) {
          let existing;
          try { existing = await readBack(retryUntil); } catch { break; }
          if (existing) return existing;
          // A 5xx write (ambiguous): GitHub may store the run a moment after it answered; read back again at the next delay.
          if (failure.ambiguous) continue;
          if (!failure.unsent || !(retryUntil - clock() >= MIN_ATTEMPT_MS)) break;
        }
        try { return await send(url, method, bearer, body, retryUntil - clock(), retryUntil); } catch (error) {
          if (!error?.retryable) throw error;
          failure = error;
        }
      }
      throw failure;
    } finally { reservation.ms = Math.max(0, clock() - opened); }
  }
  // `until` (a write read-back) also bounds a token refresh it needs.
  // bf57ff10 P2 E1 (2026-11-07): reads now run side by side, so callers without `until` that need a new token share the
  // one exchange in flight instead of each minting their own; its checks and failure are the same for all of them.
  let minting = null;
  async function credential(until = null) {
    if (token && Date.parse(token.expires_at) > clock() + 60_000) return token.token;
    if (until !== null) return mint(until);
    if (!minting) minting = mint(null).finally(() => { minting = null; });
    return minting;
  }
  async function mint(until) {
    let appJwt;
    try { appJwt = jwt(appId, await privateKeyProvider(), clock()); }
    catch { fail('github_credential_unavailable'); }
    const app = await request('https://api.github.com/app', 'GET', appJwt, undefined, { until });
    if (app.id !== appId) fail('unexpected_app_identity');
    const requested = { checks: 'write', contents: 'read', pull_requests: 'read',
      ...(includeActionsRead ? { actions: 'read' } : {}),
      ...(includeModeRead ? { actions_variables: 'read', environments: 'read' } : {}) };
    // Minting changes no repository state; a token whose reply was lost is never
    // seen or used and expires by itself, so this exchange repeats like a read.
    const minted = await request(`https://api.github.com/app/installations/${installationId}/access_tokens`, 'POST', appJwt,
      { repository_ids: [repositoryId], permissions: requested }, { repeatable: true, until });
    const permissions = minted.permissions;
    const allowed = { ...requested, metadata: 'read' };
    if (!minted.token || !Number.isFinite(Date.parse(minted.expires_at))
      || Date.parse(minted.expires_at) <= clock() || Date.parse(minted.expires_at) > clock() + 3_660_000
      || !permissions || Object.entries(permissions).some(([name, value]) => allowed[name] !== value)
      || !Object.keys(requested).every(name => permissions[name] === allowed[name])) fail('unexpected_installation_token_scope');
    const repos = await request('https://api.github.com/installation/repositories?per_page=100', 'GET', minted.token, undefined, { until });
    if (repos.total_count !== 1 || repos.repositories?.length !== 1 || repos.repositories[0].id !== repositoryId
      || repos.repositories[0].full_name !== repository) fail('unexpected_repository_scope');
    token = minted;
    return token.token;
  }
  async function scoped(route, method = 'GET', body, options) {
    if (!route.startsWith('/') || route.includes('..')) fail('invalid_github_route');
    return request(`${root}${route}`, method, await credential(options?.until ?? null), body, options);
  }
  const nonPendingScans = new Set();
  async function stagedScanRecord(key, id) {
    const record = await stagedScanJournal.read(key);
    const { subject, details } = record ?? {};
    if (!['created', 'completing'].includes(record?.state) || !positive(id) || details?.checkRunId !== id
      || subject?.stagedScan !== true || subject.subject?.repo !== repository || subject.definition?.appId !== appId
      || !stagedScanNames.includes(subject.definition.name) || subject.definition.name !== subject.subject.role || !sha.test(subject.subject.headSha)
      || !stagedScanExternalId.test(subject.externalId) || !['success', 'failure'].includes(details.conclusion)
      || typeof details.output?.summary !== 'string' || details.output.title !== `${subject.definition.name}: in progress`)
      fail('staged_scan_journal_conflict');
    return record;
  }
  function scanBody(record, conclusion = record.details.conclusion) {
    return { status: 'completed', conclusion, output: { title: `${record.subject.definition.name}: ${conclusion}`,
      summary: record.details.output.summary } };
  }
  async function readStagedScan(key, id) {
    const record = await stagedScanRecord(key, id);
    const actual = await scoped(`/check-runs/${id}`, 'GET', undefined, { until: clock() + STAGED_SCAN_REQUEST_MS, noRetry: true });
    nonPendingScans.add(key);
    const { subject, details } = record;
    if (actual?.id !== id || actual.app?.id !== appId || actual.head_sha !== subject.subject.headSha
      || actual.name !== subject.definition.name || actual.external_id !== subject.externalId
      || actual.output?.summary !== details.output.summary) fail('staged_scan_readback_unconfirmed');
    if (actual.status === 'in_progress' && actual.conclusion === null && actual.output.title === details.output.title) {
      nonPendingScans.delete(key);
      return 'pending';
    }
    const expected = scanBody(record);
    if (actual.status === expected.status && actual.conclusion === expected.conclusion && actual.output.title === expected.output.title) return 'completed';
    fail('staged_scan_readback_unconfirmed');
  }
  // base.sha: the batch base T for every job that tests the head (v1 jobs have no testSha); a v2 train front batch
  // (S != H) accepts what GitHub reads (job-v2.mjs#prBaseAcceptedV2, inlined: the v1 one-shot closure never loads
  // job-v2.mjs), and both reads of one call must agree. bc982192: a port built with the batch route push (stages 1 and 8 of a
  // batch stamped push, batch-route.mjs) also accepts what GitHub reads for an S = H job of the v2 contract: that batch runs on the
  // merge base of its head and main, which stage 1 proves (full-admission-v2.mjs#baseOnMain). No route: exactly as on origin/main.
  const routePush = batchRoute === 'push';
  function exactPr(pr, job) {
    const front = typeof job.testSha === 'string' && /^[0-9a-f]{40}$/.test(job.testSha) && job.testSha !== job.headSha;
    const onMergeBase = routePush && typeof job.testSha === 'string' && /^[0-9a-f]{40}$/.test(job.testSha) && job.testSha === job.headSha;
    return pr?.number === job.pr && pr.state === 'open' && pr.head?.sha === job.headSha
      && /^[0-9a-f]{40}$/.test(pr.base?.sha ?? '') && (front || onMergeBase || pr.base.sha === job.baseSha) && pr.base?.ref === 'main'
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
  // ownOnly: this App's runs only (app_id); every run must then be this App's.
  async function inventory(headSha, until = null, checkName = null, ownOnly = false) {
    if (!sha.test(headSha)) fail('invalid_head');
    const named = checkName === null ? '' : `check_name=${encodeURIComponent(checkName)}&`;
    const own = ownOnly ? `app_id=${appId}&` : '';
    const checks = []; let expected = null;
    for (let page = 1; page <= maxPages; page++) {
      const reply = await scoped(`/commits/${headSha}/check-runs?${own}${named}filter=all&per_page=100&page=${page}`, 'GET', undefined, { until });
      if (!Number.isSafeInteger(reply.total_count) || reply.total_count < 0 || !Array.isArray(reply.check_runs)
        || reply.check_runs.length > 100 || (expected !== null && expected !== reply.total_count)) fail('checks_pagination_changed');
      expected = reply.total_count; checks.push(...reply.check_runs);
      if (checks.length === expected) {
        if (new Set(checks.map(check => check.id)).size !== checks.length
          || checks.some(check => !positive(check.id) || check.head_sha !== headSha
            || (checkName !== null && check.name !== checkName) || (ownOnly && check.app?.id !== appId))) fail('invalid_check_set');
        return { complete: true, checks };
      }
      if (checks.length > expected || reply.check_runs.length < 100) fail('incomplete_checks');
    }
    fail('checks_page_limit');
  }
  // One page of pulls (state open|closed|all, sort created|updated, direction asc|desc), normalized; `last` when the page
  // is not full (merge-train sweeps, DESIGN §41.3).
  async function pullsPage({ state = 'all', sort = 'updated', direction = 'desc', page = 1, perPage = 100, until = null } = {}) {
    if (!['open', 'closed', 'all'].includes(state) || !['created', 'updated'].includes(sort) || !['asc', 'desc'].includes(direction)
      || !positive(page) || page > 1000 || !positive(perPage) || perPage > 100
      || (until !== null && (!Number.isSafeInteger(until) || until <= clock()))) fail('invalid_pulls_request');
    const rows = await scoped(`/pulls?state=${state}&sort=${sort}&direction=${direction}&per_page=${perPage}&page=${page}`, 'GET', undefined, { until });
    if (!Array.isArray(rows) || rows.length > perPage) fail('invalid_pulls_reply');
    const seen = new Set();
    const pulls = rows.map(p => {
      if (!positive(p?.number) || seen.has(p.number) || !['open', 'closed'].includes(p.state) || !Number.isFinite(Date.parse(p.updated_at ?? ''))
        || !sha.test(p.head?.sha ?? '') || typeof p.base?.ref !== 'string' || !(p.merged_at === null || Number.isFinite(Date.parse(p.merged_at ?? '')))) fail('invalid_pulls_reply');
      seen.add(p.number);
      return { number: p.number, state: p.state, updatedAt: new Date(Date.parse(p.updated_at)).toISOString(), headSha: p.head.sha, baseRef: p.base.ref, merged: p.merged_at !== null };
    });
    return { complete: true, page, pulls, last: rows.length < perPage };
  }
  async function pullHistorySnapshot(number) {
    if (!positive(number)) fail('invalid_pr');
    const p = await scoped(`/pulls/${number}`);
    if (p?.number !== number || !Number.isSafeInteger(p.commits) || p.commits < 0 || !sha.test(p.head?.sha ?? '')
      || typeof p.updated_at !== 'string' || !Number.isFinite(Date.parse(p.updated_at))) fail('pr_history_unconfirmed');
    return { headSha: p.head.sha, count: p.commits, updatedAt: new Date(Date.parse(p.updated_at)).toISOString() };
  }
  async function pullHistoryPage(number, phase, after = null) {
    if (!positive(number) || !['commits', 'pushes'].includes(phase) || !(after === null || typeof after === 'string' && after.length > 0 && after.length <= 1024)) fail('invalid_pr_history_page');
    const [owner, name] = repository.split('/');
    const field = phase === 'commits' ? 'commits(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{commit{oid}}}'
      : 'timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],first:100,after:$after){filteredCount pageInfo{hasNextPage endCursor} nodes{... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid}}}}';
    const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid updatedAt ${field}}}}`;
    const body = await request('https://api.github.com/graphql', 'POST', await credential(), { query, variables: { owner, name, number, after } }, { repeatable: true });
    const p = body?.data?.repository?.pullRequest, items = phase === 'commits' ? p?.commits : p?.timelineItems;
    const count = phase === 'commits' ? items?.totalCount : items?.filteredCount;
    if (body?.errors !== undefined || !sha.test(p?.headRefOid ?? '') || typeof p?.updatedAt !== 'string' || !Number.isFinite(Date.parse(p.updatedAt))
      || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(items?.nodes) || items.nodes.length > 100
      || typeof items.pageInfo?.hasNextPage !== 'boolean') fail('pr_history_unconfirmed');
    const next = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
    if (next !== null && (typeof next !== 'string' || !next || next.length > 1024 || next === after || items.nodes.length === 0)) fail('pr_history_unconfirmed');
    const oid = c => c === null ? null : sha.test(c?.oid ?? '') ? c.oid : fail('pr_history_unconfirmed');
    const rows = phase === 'commits' ? items.nodes.map(n => { const h = oid(n?.commit); if (!h) fail('pr_history_unconfirmed'); return h; })
      : items.nodes.map(n => ({ before: oid(n?.beforeCommit), after: oid(n?.afterCommit) }));
    return { headSha: p.headRefOid, updatedAt: new Date(Date.parse(p.updatedAt)).toISOString(), count, rows, next };
  }
  return Object.freeze({
    ...(stagedScanJournal ? { readStagedScan,
      async completeStagedScan(key, id, verify) {
        const record = await stagedScanRecord(key, id);
        if (record.state !== 'created' || typeof verify !== 'function') fail('staged_scan_completion_refused');
        await stagedScanJournal.transition(key, 'created', 'completing', record.details);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (await readStagedScan(key, id) !== 'pending') fail('staged_scan_completion_refused');
            const beforeSend = await verify();
            if (typeof beforeSend !== 'function') fail('staged_scan_completion_refused');
            if (await readStagedScan(key, id) !== 'pending') fail('staged_scan_completion_refused');
            return await scoped(`/check-runs/${id}`, 'PATCH', scanBody(record), {
              noRetry: true, until: clock() + STAGED_SCAN_REQUEST_MS,
              beforeSend() {
                beforeSend();
                // The pre-send pending observation is spent. Only a later
                // positive observation of the pending state permits cleanup.
                nonPendingScans.add(key);
              },
            });
          } catch (error) {
            // Only a local freshness refusal can repeat. No request has been sent on that path.
            if (error?.code !== 'staged_scan_verification_aged' || attempt === 1) throw error;
          }
        }
      },
      async failStagedScan(key, id) {
        const record = await stagedScanRecord(key, id);
        // Creation can prove pending until we attempt the completion write.
        if (nonPendingScans.has(key)) fail('staged_scan_cleanup_refused');
        nonPendingScans.add(key);
        return scoped(`/check-runs/${id}`, 'PATCH', scanBody(record, 'failure'), { noRetry: true, until: clock() + STAGED_SCAN_REQUEST_MS });
      },
    } : {}),
    rateBudget() { return budget.snapshot(); },
    async readRateBudget({ until = null } = {}) {
      if (until !== null && (!Number.isSafeInteger(until) || until <= clock())) fail('invalid_rate_budget_deadline');
      maintenanceRateControl = true;
      const body = await request('https://api.github.com/rate_limit', 'GET', await credential(until), undefined, { until });
      if (until !== null && clock() >= until) fail('invalid_rate_budget_deadline');
      budget.seed(body);
      return budget.snapshot();
    },
    // Protected controller use only: never hand this token to a job/worker/logger.
    async getInstallationToken() { return credential(); },
    async readAdmissionMode() {
      if (!includeModeRead) fail('mode_read_not_configured');
      // bf57ff10 P2 E1 (2026-11-07): the two scopes are read side by side (they were one after the other); the result is
      // built only after both are complete, and a failure is reported in the old order (the repository scope's first).
      const [repoRead, environmentRead] = await Promise.allSettled([modeScope('/actions/variables'), modeScope('/environments/clued-admission/variables')]);
      if (repoRead.status === 'rejected') throw repoRead.reason;
      if (environmentRead.status === 'rejected') throw environmentRead.reason;
      const repoMode = repoRead.value, environmentMode = environmentRead.value;
      const effective = environmentMode.exists ? environmentMode : repoMode;
      const observations = { repository: repoMode, environment: environmentMode };
      const observedAt = new Date(clock()).toISOString();
      const proof = { repository, variable: 'CLUED_MERGE_ADMISSION_STATE', observations, observedAt };
      return { complete: true, repository, variable: proof.variable, exists: effective.exists,
        ...(effective.exists ? { value: effective.value } : {}), observedAt,
        source: 'github-repository-variables', scopeObservations: observations,
        proofRef: `independent-observation:sha256:${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}` };
    },
    async readPullRequest(number, { until = null } = {}) {
      if (!positive(number) || (until !== null && (!Number.isSafeInteger(until) || until <= clock()))) fail('invalid_pr');
      return scoped(`/pulls/${number}`, 'GET', undefined, { until });
    },
    async readPullRequestCommits(number) {
      if(!positive(number))fail('invalid_pr');
      const before=await scoped(`/pulls/${number}`),commits=[],seen=new Set();
      if(before?.number!==number||!positive(before.commits)||before.commits>5000||!sha.test(before.head?.sha??''))fail('pr_history_unconfirmed');
      for(let page=1;page<=maxPages;page++){
        const rows=await scoped(`/pulls/${number}/commits?per_page=100&page=${page}`);
        if(!Array.isArray(rows)||rows.length>100)fail('pr_history_unconfirmed');
        for(const row of rows){if(!sha.test(row?.sha??'')||seen.has(row.sha))fail('pr_history_unconfirmed');seen.add(row.sha);commits.push({sha:row.sha});}
        if(commits.length>before.commits)fail('pr_history_changed');
        if(commits.length===before.commits){
          const after=await scoped(`/pulls/${number}`);
          if(after?.number!==number||after.head?.sha!==before.head.sha||after.commits!==before.commits)fail('pr_history_changed');
          return {complete:true,commits};
        }
        if(rows.length<100)fail('pr_history_incomplete');
      }
      fail('pr_history_page_limit');
    },
    async readChangedPaths(job) {
      if (job?.repo !== repository || !positive(job.pr) || !sha.test(job.headSha) || !sha.test(job.baseSha)) fail('invalid_pr_subject');
      const packet = await collectPRPaths({ repository, prNumber: job.pr, maxPages: Math.min(maxPages, 30),
        readPR: () => scoped(`/pulls/${job.pr}`),
        readPage: page => scoped(`/pulls/${job.pr}/files?per_page=100&page=${page}`),
        subjectCheck: pr => exactPr(pr, job) });
      return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: [...packet.paths] };
    },
    async readChecks(headSha) { return inventory(headSha); },
    async readTrainStagingRun({ testSha, workflow }) {
      if (!sha.test(testSha) || !TRAIN_WORKFLOWS.has(workflow)) fail('invalid_train_run');
      const query = new URLSearchParams({ head_sha: testSha, event: 'push', branch: 'clued-train/staging', per_page: '2' });
      const list = await scoped('/actions/workflows/' + workflow.split('/').at(-1) + '/runs?' + query);
      if (list?.total_count !== 1 || list.workflow_runs?.length !== 1) fail('train_run_unconfirmed');
      const run = list.workflow_runs[0];
      if (run.head_sha !== testSha || run.path !== workflow || !positive(run.id) || run.run_attempt !== 1
        || run.event !== 'push' || run.head_branch !== 'clued-train/staging') fail('train_run_unconfirmed');
      return run.id;
    },
    async readTrainRun({ runId, attempt, testSha, workflow }) {
      if (!positive(runId) || !positive(attempt) || !sha.test(testSha) || !TRAIN_WORKFLOWS.has(workflow))
        fail('invalid_train_run');
      const route = '/actions/runs/' + runId;
      const current = await scoped(route);
      if (current?.id !== runId || current.run_attempt !== attempt || current.head_sha !== testSha
        || current.event !== 'push' || current.head_branch !== 'clued-train/staging' || current.path !== workflow
        || current.actor?.login !== 'clued-ci-checks-turing-20261018[bot]') fail('train_run_unconfirmed');
      const body = await scoped(route + '/attempts/' + attempt + '/jobs?per_page=100');
      if (!Array.isArray(body?.jobs) || body.total_count !== body.jobs.length || body.jobs.length >= 100)
        fail('train_jobs_unconfirmed');
      const checkPrefix = root + '/check-runs/';
      const jobs = body.jobs.map(job => {
        const url = job?.check_run_url;
        const checkRunId = typeof url === 'string' && url.startsWith(checkPrefix) ? Number(url.slice(checkPrefix.length)) : null;
        if (!positive(checkRunId) || url !== checkPrefix + checkRunId || job.run_id !== runId
          || (job.run_attempt !== undefined && job.run_attempt !== attempt) || job.head_sha !== testSha || typeof job.name !== 'string') fail('train_job_unconfirmed');
        return { checkRunId, name: job.name, status: job.status, conclusion: job.conclusion, steps: Array.isArray(job.steps) ? job.steps : [] };
      });
      if (new Set(jobs.map(job => job.checkRunId)).size !== jobs.length) fail('train_jobs_unconfirmed');
      const latest = await scoped(route);
      if (latest?.run_attempt !== attempt || latest.id !== runId || latest.head_sha !== testSha
        || latest.actor?.id !== current.actor?.id || latest.triggering_actor?.id !== current.triggering_actor?.id)
        fail('train_run_unconfirmed');
      return { jobs, actorId: current.actor?.id, triggeringActorId: current.triggering_actor?.id };
    },
    async sameTrainWorkflow({ workflow, baseSha, testSha }) {
      if (!TRAIN_WORKFLOWS.has(workflow) || !sha.test(baseSha) || !sha.test(testSha)) fail('invalid_train_workflow');
      const read = at => scoped('/contents/' + workflow + '?ref=' + at);
      const [base, test] = await Promise.all([read(baseSha), read(testSha)]);
      return base?.path === workflow && test?.path === workflow && base.type === 'file' && test.type === 'file'
        && sha.test(base.sha ?? '') && test.sha === base.sha;
    },
    async readCheckAnnotations(checkRunId) {
      if (!positive(checkRunId)) fail('invalid_check_run');
      const annotations = [];
      for (let page = 1; page <= maxPages; page++) {
        const list = await scoped(`/check-runs/${checkRunId}/annotations?per_page=100&page=${page}`);
        if (!Array.isArray(list) || list.length > 100) fail('invalid_check_annotations');
        annotations.push(...list);
        if (list.length < 100) return annotations;
      }
      fail('check_annotations_page_limit');
    },
    // This App's runs on the head, every run of every name (filter=all, app_id): the cross-node "already published"
    // read-back (resident primary/standby design v0.4 §6.2; published-on-github-v2.mjs). Complete, or refused.
    async readAppChecks(headSha) { return inventory(headSha, null, null, true); },
    // Merge-train reads (stage 8 and 10): GET only, same fixed origin, same
    // installation token and permission set. Replies are normalized and checked.
    async readBranchHead(name) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name)) fail('invalid_branch');
      const body = await scoped(`/branches/${name}`);
      if (body?.name !== name || !sha.test(body.commit?.sha ?? '')) fail('invalid_branch_reply');
      return { name, sha: body.commit.sha };
    },
    async readCompare(baseSha, headSha) {
      if (!sha.test(baseSha) || !sha.test(headSha)) fail('invalid_compare');
      // The three-dot form is the API's own syntax; both ends are exact SHAs.
      const body = await request(`${root}/compare/${baseSha}...${headSha}?per_page=1`, 'GET', await credential());
      if (!['ahead', 'behind', 'diverged', 'identical'].includes(body?.status) || !Number.isSafeInteger(body.ahead_by) || body.ahead_by < 0
        || !Number.isSafeInteger(body.behind_by) || body.behind_by < 0 || body.base_commit?.sha !== baseSha
        || !sha.test(body.merge_base_commit?.sha ?? '')) fail('invalid_compare_reply');
      return { baseSha, headSha, status: body.status, aheadBy: body.ahead_by, behindBy: body.behind_by, mergeBaseSha: body.merge_base_commit.sha };
    },
    async readGitCommit(commitSha) {
      if (!sha.test(commitSha)) fail('invalid_commit');
      const body = await scoped(`/git/commits/${commitSha}`);
      if (body?.sha !== commitSha || !sha.test(body.tree?.sha ?? '') || !Array.isArray(body.parents) || body.parents.length > 16
        || body.parents.some(parent => !sha.test(parent?.sha ?? ''))) fail('invalid_commit_reply');
      return { sha: commitSha, tree: body.tree.sha, parents: body.parents.map(parent => parent.sha) };
    },
    // The rules GitHub applies to one branch (quota phase 2, step 3a: stage 8 reads main's live before writing a
    // green). Metadata read, which every installation token of this port carries. One page; a full page is refused,
    // never guessed.
    async readBranchRules(branch) {
      if (branch !== 'main') fail('invalid_branch');
      const body = await scoped(`/rules/branches/${branch}?per_page=100`);
      if (!Array.isArray(body) || body.length >= 100 || body.some(rule => typeof rule?.type !== 'string' || !rule.type
        || !(rule.parameters === null || rule.parameters === undefined || (typeof rule.parameters === 'object' && !Array.isArray(rule.parameters))))) fail('invalid_rules_reply');
      return { complete: true, branch, rules: body.map(rule => ({ type: rule.type, rulesetId: Number.isSafeInteger(rule.ruleset_id) ? rule.ruleset_id : null,
        parameters: rule.parameters ? structuredClone(rule.parameters) : null })) };
    },
    // This App's own bypass of one ruleset (resident ADR 0018 §2 L2 item 7, Fable 2026-11-20: which way a batch lands). Metadata read.
    // current_user_can_bypass is the caller's own state (GitHub returns it only from this repository-level endpoint; read 2026-11-20 with
    // the Owner's identity: present, 'never' for 24182890); absent is null and landingRoute parks. The bypass list is not read: GitHub
    // shows it only to a caller who may edit the ruleset, and who else is on it is checked with an administrator's identity, not here.
    // includes_parents: a ruleset of the organization that applies to main is read the same way.
    async readRuleset(id) {
      if (!positive(id)) fail('invalid_ruleset');
      const body = await scoped(`/rulesets/${id}?includes_parents=true`);
      const can = body?.current_user_can_bypass;
      if (body?.id !== id || !(can === undefined || can === null || typeof can === 'string')) fail('invalid_ruleset_reply');
      return { id, currentUserCanBypass: typeof can === 'string' ? can : null };
    },
    async readRuleBypass(id) {
      if (!positive(id)) fail('invalid_ruleset');
      const body = await scoped(`/rulesets/${id}?includes_parents=true`);
      if (body?.id !== id || !Array.isArray(body.bypass_actors) || body.bypass_actors.length > 100) fail('invalid_ruleset_reply');
      return body.bypass_actors;
    },
    // Merge-train sweep reads (DESIGN §41.3; stage 10). Bounded, complete or refused. GET only, except the GraphQL
    // query: a read sent as POST, repeated like a read.
    // This App's runs of one name on a commit (app_id and check_name filtered by GitHub, every run checked again).
    async readOwnChecksByName(headSha, name) {
      if (typeof name !== 'string' || !name || name.length > 100 || /[\x00-\x1f]/.test(name)) fail('invalid_check_name');
      return inventory(headSha, null, name, true);
    },
    // One check run by id, reduced to what a revocation verifies.
    async readCheckRun(id) {
      if (!positive(id)) fail('invalid_check_run');
      const c = await scoped(`/check-runs/${id}`);
      if (c?.id !== id || !positive(c.app?.id) || typeof c.name !== 'string' || !sha.test(c.head_sha ?? '') || typeof c.status !== 'string'
        || !(c.conclusion === null || typeof c.conclusion === 'string')) fail('invalid_check_run_reply');
      return { id, appId: c.app.id, name: c.name, headSha: c.head_sha, status: c.status, conclusion: c.conclusion,
        title: typeof c.output?.title === 'string' ? c.output.title : null, summary: typeof c.output?.summary === 'string' ? c.output.summary : null };
    },
    async readPullsPage(options) { return pullsPage(options); },
    // Every pull updated at or after `since` (ISO), newest first, paging until an older one or the last page. The pull
    // bound reached first is incomplete, never guessed.
    async readPullsUpdatedSince(since, { maxPulls = 1000 } = {}) {
      if (!Number.isFinite(Date.parse(since ?? '')) || !positive(maxPulls) || maxPulls > 10_000) fail('invalid_pulls_request');
      const out = [], seen = new Set(), floor = Date.parse(since);
      const done = complete => ({ complete, pulls: out, newest: out[0]?.updatedAt ?? null });
      for (let page = 1; page <= Math.ceil(maxPulls / 100); page++) {
        const reply = await pullsPage({ state: 'all', sort: 'updated', direction: 'desc', page });
        for (const p of reply.pulls) {
          if (Date.parse(p.updatedAt) < floor) return done(true);
          // Paging under updates can repeat a pull: the first (newest) copy counts.
          if (!seen.has(p.number)) { seen.add(p.number); out.push(p); }
        }
        if (reply.last) return done(true);
      }
      return done(false);
    },
    readPullHistorySnapshot: pullHistorySnapshot,
    readPullHistoryPage: pullHistoryPage,
    // GraphQL's connection covers long PRs beyond REST's 250-commit truncation. The snapshot is checked on both sides;
    // changed counts, duplicate commits, broken cursors or the explicit page bound never produce a complete inventory.
    async readPullCommitsBounded(number) {
      const snapshot = await pullHistorySnapshot(number), commits = [], seen = new Set(), cursors = new Set();
      let after = null;
      for (let page = 1; page <= maxPages; page++) {
        const p = await pullHistoryPage(number, 'commits', after);
        if (p.headSha !== snapshot.headSha || p.updatedAt !== snapshot.updatedAt || p.count !== snapshot.count) fail('pr_history_unconfirmed');
        for (const h of p.rows) { if (seen.has(h)) fail('pr_history_unconfirmed'); seen.add(h); commits.push(h); }
        if (commits.length > snapshot.count) fail('pr_history_unconfirmed');
        if (p.next === null) {
          const final = await pullHistorySnapshot(number);
          if (JSON.stringify(final) !== JSON.stringify(snapshot)) fail('pr_history_unconfirmed');
          return { complete: commits.length === snapshot.count && seen.has(snapshot.headSha), tooMany: false, ...snapshot, commits };
        }
        if (cursors.has(p.next)) fail('pr_history_unconfirmed');
        cursors.add(p.next); after = p.next;
      }
      return { complete: false, tooMany: false, ...snapshot, commits: [] };
    },
    // The before/after commits of every force push of a pull's head (GraphQL HeadRefForcePushedEvent; REST has no
    // equivalent). A commit GitHub no longer resolves is null. Errors, a changed matching count or the page bound: refused.
    async readForcePushes(number) {
      if (!positive(number)) fail('invalid_pr');
      const [owner, name] = repository.split('/'), events = [];
      const query = 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){'
        + 'timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],first:100,after:$after){filteredCount pageInfo{hasNextPage endCursor}'
        + 'nodes{... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid}}}}}}}';
      const oid = c => (c === null || c === undefined ? null : sha.test(c.oid ?? '') ? c.oid : fail('force_push_events_unconfirmed'));
      let after = null, total = null;
      for (let page = 1; page <= maxPages; page++) {
        const body = await request('https://api.github.com/graphql', 'POST', await credential(), { query, variables: { owner, name, number, after } }, { repeatable: true });
        const items = body?.data?.repository?.pullRequest?.timelineItems;
        // filteredCount counts matching items remaining after this cursor; totalCount includes unrelated timeline items.
        if (body?.errors !== undefined || !items || !Number.isSafeInteger(items.filteredCount) || items.filteredCount < 0 || !Array.isArray(items.nodes) || items.nodes.length > 100
          || (total !== null && total !== events.length + items.filteredCount) || typeof items.pageInfo?.hasNextPage !== 'boolean') fail('force_push_events_unconfirmed');
        total ??= items.filteredCount;
        for (const n of items.nodes) events.push({ before: oid(n?.beforeCommit), after: oid(n?.afterCommit) });
        if (!items.pageInfo.hasNextPage) {
          if (events.length !== total) fail('force_push_events_unconfirmed');
          return { complete: true, events };
        }
        if (typeof items.pageInfo.endCursor !== 'string' || !items.pageInfo.endCursor) fail('force_push_events_unconfirmed');
        after = items.pageInfo.endCursor;
      }
      fail('force_push_events_page_limit');
    },
    async createCheck(body) {
      const pending = stagedScanJournal && body?.status === 'in_progress' && !Object.hasOwn(body, 'conclusion')
        && stagedScanNames.includes(body.name) && stagedScanExternalId.test(body.external_id ?? '');
      if (!body || !sha.test(body.head_sha) || (!pending && (body.status !== 'completed' || !['success', 'failure'].includes(body.conclusion)))
        || typeof body.name !== 'string'
        || !body.external_id?.startsWith('independent-ci:')
        // resident ADR 0018 §8 item 3: the never-published required check that keeps PR-page merges out in push mode
        || body.name === 'kooyumi-train-landed') fail('invalid_check_publication');
      if (pending) return scoped('/check-runs', 'POST', body, { noRetry: true });
      // Dedupe by external_id: one complete inventory of the head decides whether
      // this App already holds the run. Two copies, or a copy with a different
      // result or output, refuse.
      const readBack = async until => {
        const matches = (await inventory(body.head_sha, until)).checks.filter(check => check.app?.id === appId
          && check.name === body.name && check.head_sha === body.head_sha && check.external_id === body.external_id);
        if (matches.length > 1 || matches.some(check => check.status !== 'completed' || check.conclusion !== body.conclusion
          || check.output?.title !== body.output?.title || check.output?.summary !== body.output?.summary)) fail('github_transport_unconfirmed');
        return matches[0] ?? null;
      };
      return scoped('/check-runs', 'POST', body, { readBack });
    },
    async revokeCheck(id, body) {
      if (!positive(id) || body?.status !== 'completed' || body.conclusion !== 'failure') fail('invalid_check_revocation');
      const readBack = async until => {
        const current = await scoped(`/check-runs/${id}`, 'GET', undefined, { until });
        if (current?.id !== id || current.app?.id !== appId) fail('github_transport_unconfirmed');
        return current.status === 'completed' && current.conclusion === 'failure'
          && current.output?.title === body.output?.title && current.output?.summary === body.output?.summary ? current : null;
      };
      return scoped(`/check-runs/${id}`, 'PATCH', body, { readBack });
    }
  });
}
