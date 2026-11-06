import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createGitHubBudgetObserver, guardedGitHubBudgetObserver } from '../src/github-budget.mjs';
import { createGitHubChecksPort } from '../src/github.mjs';
import { READ_REQUEST_DEADLINE, withReadRetry } from '../src/read-retry.mjs';

const NOW = Date.parse('2026-11-06T13:00:00Z');
const resources = (now, remaining = 4999) => ({ resources: Object.fromEntries(['core', 'graphql'].map(k => [k,
  { limit: 5000, remaining, reset: Math.floor((now + 3600_000) / 1000) }])) });
const response = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status,
  headers: new Headers(headers), json: async () => body });

test('extra maintenance needs both current provider windows; normal work is not authorized by a hint', () => {
  let now = NOW;
  const b = createGitHubBudgetObserver({ clock: () => now });
  assert.equal(b.snapshot().state, 'unknown');
  b.seed(resources(now));
  assert.equal(b.snapshot().extraSlicesAllowed, true);
  now += 60_000;
  assert.equal(b.snapshot().extraSlicesAllowed, true);
  now++;
  assert.equal(b.snapshot().extraSlicesAllowed, false);
  now = NOW - 1;
  assert.equal(b.snapshot().state, 'unknown', 'clock rollback does not refresh a budget');
  now = NOW;
  b.seed(resources(now, 2500));
  assert.equal(b.snapshot().state, 'low', 'reserve boundary is exclusive');
  b.seed({ resources: { core: resources(now).resources.core } });
  assert.equal(b.snapshot().state, 'unknown', 'missing GraphQL is not unlimited');
  b.seed(resources(now));
  b.observe('https://api.github.com/graphql', response({}, 200, { 'x-ratelimit-resource': 'graphql',
    'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '2499', 'x-ratelimit-reset': String((now + 3600_000) / 1000) }));
  assert.equal(b.snapshot().graphql.remaining, 2499);
  assert.equal(b.snapshot().extraSlicesAllowed, false);
});

test('Retry-After, exhausted reset and unknown/malformed quota stay conservative', () => {
  let now = NOW;
  const b = createGitHubBudgetObserver({ clock: () => now });
  b.seed(resources(now));
  b.observe('https://api.github.com/repos/o/r', response({}, 429, { 'retry-after': '120' }));
  assert.equal(b.snapshot().retryAt, new Date(now + 120_000).toISOString());
  b.observe('https://api.github.com/repos/o/r', response({}, 403));
  assert.equal(b.snapshot().retryAt, new Date(now + 120_000).toISOString(), 'shorter fallback does not shorten a hold');
  now += 120_000;
  assert.equal(b.snapshot().extraSlicesAllowed, false, 'expiration still needs fresh provider observations');
  b.seed(resources(now));
  assert.equal(b.snapshot().extraSlicesAllowed, true);
  b.observe('https://api.github.com/graphql', response({}, 200, { 'x-ratelimit-resource': 'graphql',
    'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 3600_000) / 1000) }));
  assert.equal(b.snapshot().retryAt, new Date(now + 3600_000).toISOString());
  b.seed({ resources: { core: { limit: 5000, remaining: 5001, reset: 9999999999999999 } } });
  assert.equal(b.snapshot().state, 'unknown');
  b.begin('https://other.invalid/private');
  b.begin('not-a-url');
  assert.equal(b.snapshot().requests, 0, 'Native and non-GitHub requests are not mislabeled REST');
  const g = createGitHubBudgetObserver({ clock: () => now });
  g.seed(resources(now));
  g.observeBody('https://api.github.com/graphql', { errors: [{ type: 'RATE_LIMITED' }] });
  assert.equal(g.snapshot().retryAt, new Date(now + 60_000).toISOString(), 'GraphQL HTTP 200 errors still stop acceleration');
  const oversized = createGitHubBudgetObserver({ clock: () => now });
  oversized.seed(resources(now));
  oversized.observe('https://api.github.com/graphql', response({}, 429, { 'retry-after': '9007199254740991' }));
  assert.equal(oversized.snapshot().extraSlicesAllowed, false, 'unrepresentable provider time is a bounded conservative hold');
  for (const value of ['-1', '1.5', 'yesterday', '0', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
    const bad = createGitHubBudgetObserver({ clock: () => now }); bad.seed(resources(now));
    bad.observe('https://api.github.com/graphql', response({}, 429, { 'retry-after': value }));
    assert.equal(bad.snapshot().retryAt, new Date(now + 60_000).toISOString(), value);
  }
  now++;
  const rolled = createGitHubBudgetObserver({ clock: () => now }); rolled.seed(resources(now));
  now--;
  rolled.observe('https://api.github.com/repos/o/r', response({}, 200, { 'x-ratelimit-resource': 'core',
    'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String((now + 3600_000) / 1000) }));
  assert.equal(rolled.snapshot().extraSlicesAllowed, false, 'each resource observation must be in the past');
});

test('optional telemetry faults do not break transport and cannot retain a ready hint', () => {
  const raw = createGitHubBudgetObserver({ clock: () => NOW });
  raw.seed(resources(NOW));
  const b = guardedGitHubBudgetObserver({ ...raw, observe() { throw new Error('observation failed'); } }, { clock: () => NOW });
  assert.equal(b.snapshot().extraSlicesAllowed, true);
  b.begin('https://api.github.com/graphql');
  assert.doesNotThrow(() => b.observe('https://api.github.com/graphql', response({})));
  assert.equal(b.snapshot().state, 'unknown');
  assert.equal(b.snapshot().requests, 1);
});

test('actual fetch attempts, including read retries and token mint, are counted once; no secrets retained', async () => {
  let now = NOW, reads = 0;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const budgetObserver = createGitHubBudgetObserver({ clock: () => now });
  const single = async (url, opts) => {
    budgetObserver.begin(url);
    let r;
    if (String(url).endsWith('/app')) r = response({ id: 77 });
    else if (String(url).includes('/installation/repositories')) r = response({ total_count: 1, repositories: [{ id: 1, full_name: 'o/r' }] });
    else if (String(url).endsWith('/access_tokens')) r = response({ token: 'fixture-secret', expires_at: new Date(now + 3600_000).toISOString(),
      permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    else if (String(url).endsWith('/rate_limit')) r = response(resources(now));
    else { reads++; r = response({ name: 'main', commit: { sha: 'a'.repeat(40) } }, reads === 1 ? 502 : 200); }
    budgetObserver.observe(url, r); return r;
  };
  const fetchImpl = withReadRetry(single, { delaysMs: [10], budgetMs: 10, sleep: async ms => { now += ms; }, now: () => now });
  const github = createGitHubChecksPort({ repository: 'o/r', repositoryId: 1, appId: 77, installationId: 99,
    privateKeyProvider: async () => privateKey, fetchImpl, clock: () => now, budgetObserver, budgetObservedAtFetch: true });
  await github.readRateBudget();
  await github.readBranchHead('main');
  const summary = github.rateBudget();
  assert.equal(summary.requests, 6, 'app + mint + repository scope + rate-limit + failed GET + retried GET');
  assert.equal(summary.restRequests, 6);
  assert.equal(summary.graphqlRequests, 0);
  assert.equal(summary.extraSlicesAllowed, true);
  assert.equal(JSON.stringify(summary).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(summary).includes('/access_tokens'), false);
});

test('rate refresh keeps its short deadline through credentials and the lower read-retry layer', async () => {
  let now = NOW, rateReads = 0;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const until = NOW + 1000, deadlines = [], delays = [];
  const single = async (url, opts) => {
    deadlines.push(opts[READ_REQUEST_DEADLINE]);
    if (String(url).endsWith('/app')) return response({ id: 77 });
    if (String(url).includes('/installation/repositories')) return response({ total_count: 1, repositories: [{ id: 1, full_name: 'o/r' }] });
    if (String(url).endsWith('/access_tokens')) return response({ token: 'fixture-secret', expires_at: iso(now + 3600_000),
      permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    rateReads++; now += 950; return response({}, 503);
  };
  const fetchImpl = withReadRetry(single, { delaysMs: [250], budgetMs: 1000, deadlineAt: () => NOW + 300_000,
    sleep: async ms => { delays.push(ms); now += ms; }, now: () => now });
  const g = createGitHubChecksPort({ repository: 'o/r', repositoryId: 1, appId: 77, installationId: 99,
    privateKeyProvider: async () => privateKey, fetchImpl, clock: () => now });
  await assert.rejects(g.readRateBudget({ until }), { code: 'github_http_503' });
  assert.deepEqual(deadlines, [until, until, until, until]);
  assert.deepEqual(delays, []);
  assert.equal(rateReads, 1, 'no retry using only the longer stage deadline');
  await assert.rejects(g.readRateBudget({ until: now }), { code: 'invalid_rate_budget_deadline' });
});

const iso = n => new Date(n).toISOString();

test('late wake-up cannot start a retry past the refresh request deadline', async () => {
  let now = 0;
  const attempts = [], first = response({}, 502);
  const fetch = withReadRetry(async () => { attempts.push(now); return first; }, { delaysMs: [10], budgetMs: 100,
    now: () => now, deadlineAt: () => 300, sleep: async () => { now = 101; } });
  assert.equal(await fetch('https://api.github.com/rate_limit', { [READ_REQUEST_DEADLINE]: 100 }), first);
  assert.deepEqual(attempts, [0]);
});

test('maintenance stops sending after provider Retry-After; unrelated publisher use keeps its original path', async () => {
  let now = NOW;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/app')) return response({ id: 77 });
    if (String(url).includes('/installation/repositories')) return response({ total_count: 1, repositories: [{ id: 1, full_name: 'o/r' }] });
    if (String(url).endsWith('/access_tokens')) return response({ token: 'fixture-secret', expires_at: iso(now + 3600_000),
      permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    if (String(url).endsWith('/rate_limit')) return response(resources(now));
    return response({}, 429, { 'retry-after': '120' });
  };
  const make = () => createGitHubChecksPort({ repository: 'o/r', repositoryId: 1, appId: 77, installationId: 99,
    privateKeyProvider: async () => privateKey, fetchImpl, clock: () => now, budgetObserver: createGitHubBudgetObserver({ clock: () => now }) });
  const maintenance = make(); await maintenance.readRateBudget();
  await assert.rejects(maintenance.readBranchHead('main'), { code: 'github_http_429' });
  const before = calls.length;
  await assert.rejects(maintenance.readBranchHead('main'), { code: 'github_rate_limited' });
  await assert.rejects(maintenance.readRateBudget(), { code: 'github_rate_limited' });
  assert.equal(calls.length, before, 'no extra HTTP while the provider hold is live');
  now += 120_000;
  await assert.rejects(maintenance.readBranchHead('main'), { code: 'github_http_429' });
  assert.equal(calls.length, before + 1);
  const publisher = make();
  await assert.rejects(publisher.readBranchHead('main'), { code: 'github_http_429' });
  const publisherBefore = calls.length;
  await assert.rejects(publisher.readBranchHead('main'), { code: 'github_http_429' });
  assert.equal(calls.length, publisherBefore + 1, 'no opt-in: existing consumer behavior is preserved');
});

test('the actual lower read retry observes a primary hold returned with a 5xx', async () => {
  let now = NOW, branchFetches = 0;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b = createGitHubBudgetObserver({ clock: () => now });
  const single = async (url, opts) => {
    b.begin(url); let r;
    if (String(url).endsWith('/app')) r = response({ id: 77 });
    else if (String(url).includes('/installation/repositories')) r = response({ total_count: 1, repositories: [{ id: 1, full_name: 'o/r' }] });
    else if (String(url).endsWith('/access_tokens')) r = response({ token: 'fixture-secret', expires_at: iso(now + 3600_000),
      permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    else if (String(url).endsWith('/rate_limit')) r = response(resources(now));
    else { branchFetches++; r = response({}, 502, { 'x-ratelimit-resource': 'core', 'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 120_000) / 1000) }); }
    b.observe(url, r); return r;
  };
  const fetchImpl = withReadRetry(single, { delaysMs: [1000], budgetMs: 1000,
    now: () => now, sleep: async ms => { now += ms; } });
  const g = createGitHubChecksPort({ repository: 'o/r', repositoryId: 1, appId: 77, installationId: 99,
    privateKeyProvider: async () => privateKey, fetchImpl, clock: () => now, budgetObserver: b, budgetObservedAtFetch: true });
  await g.readRateBudget();
  await assert.rejects(g.readBranchHead('main'), { code: 'github_rate_limited' });
  assert.equal(branchFetches, 1, 'the lower retry must not send after observing exhaustion');
  assert.equal(g.rateBudget().retryAt, iso(NOW + 120_000));
});

test('optional raw observer failures cannot break successful GitHub responses; absent capability stays unknown', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fetchImpl = async url => {
    if (String(url).endsWith('/app')) return response({ id: 77 });
    if (String(url).includes('/installation/repositories')) return response({ total_count: 1, repositories: [{ id: 1, full_name: 'o/r' }] });
    if (String(url).endsWith('/access_tokens')) return response({ token: 'fixture-secret', expires_at: iso(NOW + 3600_000),
      permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    if (String(url).endsWith('/rate_limit')) return response(resources(NOW));
    return response({ name: 'main', commit: { sha: 'a'.repeat(40) } });
  };
  const options = { repository: 'o/r', repositoryId: 1, appId: 77, installationId: 99,
    privateKeyProvider: async () => privateKey, fetchImpl, clock: () => NOW };
  const legacy = createGitHubChecksPort(options);
  assert.equal((await legacy.readBranchHead('main')).sha, 'a'.repeat(40));
  assert.equal(legacy.rateBudget().extraSlicesAllowed, false);
  for (const method of ['begin', 'observe', 'observeBody', 'seed', 'snapshot']) {
    const observer = { ...createGitHubBudgetObserver({ clock: () => NOW }), [method]() { throw new Error('telemetry failed'); } };
    const port = createGitHubChecksPort({ ...options, budgetObserver: observer });
    await port.readRateBudget();
    assert.equal((await port.readBranchHead('main')).sha, 'a'.repeat(40), method);
    assert.equal(port.rateBudget().state, 'unknown', method);
  }
  assert.throws(() => createGitHubChecksPort({ ...options, budgetObservedAtFetch: true }), { code: 'invalid_checks_configuration' });
});
