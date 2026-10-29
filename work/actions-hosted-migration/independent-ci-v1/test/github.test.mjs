import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { createGitHubChecksPort } from '../src/github.mjs';

const REPO = 'owner/repo', REPO_ID = 41, APP_ID = 77, INSTALLATION_ID = 99;
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// Shapes undici's fetch() produces (checked against a real socket below).
const cause = (code, syscall) => Object.assign(new Error(code), { code, ...(syscall ? { syscall } : {}) });
const reset = () => new TypeError('fetch failed', { cause: cause('ECONNRESET', 'read') });
const refused = () => new TypeError('fetch failed', { cause: cause('ECONNREFUSED', 'connect') });
const redirect = () => new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
const cutBody = (status = 200, code = 'UND_ERR_SOCKET') => ({ ok: true, status,
  json: async () => { throw new TypeError('terminated', { cause: cause(code, 'connect') }); } });

const tokenReply = now => ({ token: 'installation-token', expires_at: new Date(now + 3_600_000).toISOString(),
  permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
const pr = { number: 7, state: 'open', changed_files: 1,
  head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } };

// A fake GitHub. `faults` maps "METHOD path" to a queue consumed one entry per
// call: an Error is thrown, a function runs against the state, a response is
// returned, null passes through to the real answer. Every call is counted.
function github({ faults = {}, checks = [] } = {}) {
  const calls = {}, delays = [], state = { now: Date.parse('2026-10-20T00:00:00Z'), checks: checks.map(check => ({ ...check })), nextId: 500 };
  const queues = Object.fromEntries(Object.entries(faults).map(([key, list]) => [key, [...list]]));
  async function fetchImpl(url, options) {
    const { pathname } = new URL(url), key = `${options.method} ${pathname}`;
    calls[key] = (calls[key] ?? 0) + 1;
    let fault = queues[key]?.shift();
    if (typeof fault === 'function') fault = fault(state);
    if (fault instanceof Error) throw fault;
    if (fault) return fault;
    if (key === 'GET /app') return reply({ id: APP_ID });
    if (key === `POST /app/installations/${INSTALLATION_ID}/access_tokens`) return reply(tokenReply(state.now));
    if (key === 'GET /installation/repositories') return reply({ total_count: 1, repositories: [{ id: REPO_ID, full_name: REPO }] });
    if (key === `GET /repos/${REPO}/pulls/7`) return reply(pr);
    if (key === `GET /repos/${REPO}/pulls/7/files`) return reply([{ filename: 'a.txt', status: 'modified' }]);
    if (key === `GET /repos/${REPO}/commits/${HEAD}/check-runs`) return reply({ total_count: state.checks.length, check_runs: state.checks });
    if (key === `POST /repos/${REPO}/check-runs`) {
      const run = { ...JSON.parse(options.body), id: state.nextId++, app: { id: APP_ID } };
      state.checks.push(run); return reply(run, 201);
    }
    const one = pathname.match(new RegExp(`^/repos/${REPO}/check-runs/(\\d+)$`));
    if (one) {
      const run = state.checks.find(check => check.id === Number(one[1]));
      if (!run) return reply({ message: 'Not Found' }, 404);
      if (options.method === 'PATCH') Object.assign(run, JSON.parse(options.body));
      return reply(run);
    }
    throw new Error(`unexpected ${key}`);
  }
  const port = (extra = {}) => createGitHubChecksPort({ repository: REPO, repositoryId: REPO_ID, appId: APP_ID,
    installationId: INSTALLATION_ID, privateKeyProvider: async () => privateKey, fetchImpl, clock: () => state.now,
    sleep: async ms => { delays.push(ms); state.now += ms; }, ...extra });
  return { port, calls, delays, state };
}
const job = { repo: REPO, pr: 7, headSha: HEAD, baseSha: BASE };
const publication = { name: 'gitleaks', head_sha: HEAD, status: 'completed', conclusion: 'success',
  external_id: 'independent-ci:gitleaks:job:f9:e1:a1', output: { title: 'gitleaks: success', summary: 'fixture' } };
const revocation = { status: 'completed', conclusion: 'failure', output: { title: 'Independent control authorization changed', summary: 'fixture' } };
const ours = (extra = {}) => ({ ...publication, id: 600, app: { id: APP_ID }, ...extra });
const prKey = `GET /repos/${REPO}/pulls/7`, filesKey = `GET /repos/${REPO}/pulls/7/files`;
const postKey = `POST /repos/${REPO}/check-runs`, listKey = `GET /repos/${REPO}/commits/${HEAD}/check-runs`;
const patchKey = `PATCH /repos/${REPO}/check-runs/600`, runKey = `GET /repos/${REPO}/check-runs/600`;
test('revocation reads the complete current PR commit history and refuses truncation or drift',async()=>{
 const historyKey=`GET /repos/${REPO}/pulls/7/commits`,pull={...pr,commits:2};
 const f=github({faults:{[prKey]:[reply(pull),reply(pull)],[historyKey]:[reply([{sha:BASE},{sha:HEAD}])]}});
 assert.deepEqual(await f.port().readPullRequestCommits(7),{complete:true,commits:[{sha:BASE},{sha:HEAD}]});
 const short=github({faults:{[prKey]:[reply(pull)],[historyKey]:[reply([{sha:HEAD}])]}});
 await assert.rejects(()=>short.port().readPullRequestCommits(7),/pr_history_incomplete/);
 const changed=github({faults:{[prKey]:[reply(pull),reply({...pull,head:{...pull.head,sha:'f'.repeat(40)}})],
  [historyKey]:[reply([{sha:BASE},{sha:HEAD}])]}});
 await assert.rejects(()=>changed.port().readPullRequestCommits(7),/pr_history_changed/);
});

test('a read that hits a transport failure is repeated and succeeds', async () => {
  const fake = github({ faults: { [prKey]: [reset] } });
  assert.deepEqual((await fake.port().readChangedPaths(job)).paths, ['a.txt']);
  assert.equal(fake.calls[prKey], 3); // failed + repeated before the files, one after
  assert.deepEqual(fake.delays, [250]);
});

test('faults on the files page and on the closing PR read are repeated too', async () => {
  const fake = github({ faults: { [filesKey]: [reset], [prKey]: [null, reset] } });
  assert.deepEqual((await fake.port().readChangedPaths(job)).paths, ['a.txt']);
  assert.equal(fake.calls[filesKey], 2);
  assert.equal(fake.calls[prKey], 3);
});

test('a read gives up after three attempts with the unchanged failure code', async () => {
  const fake = github({ faults: { [prKey]: [reset, reset, reset] } });
  await assert.rejects(fake.port().readPullRequest(7), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[prKey], 3);
  assert.deepEqual(fake.delays, [250, 750]);
});

test('a body cut off mid-read is a transport failure and the read repeats', async () => {
  const fake = github({ faults: { [prKey]: [cutBody()] } });
  assert.equal((await fake.port().readPullRequest(7)).number, 7);
  assert.equal(fake.calls[prKey], 2);
});

test('HTTP status refusals, redirects, unparsable bodies and codeless failures are never retried', async () => {
  for (const [fault, code] of [[reply({ message: 'bad gateway' }, 502), 'github_http_502'], [redirect, 'github_transport_unconfirmed'],
    [{ ok: true, status: 200, json: async () => JSON.parse('{') }, 'github_response_invalid'],
    [() => new TypeError('fetch failed'), 'github_transport_unconfirmed']]) {
    const fake = github({ faults: { [prKey]: [fault] } });
    await assert.rejects(fake.port().readPullRequest(7), { code });
    assert.equal(fake.calls[prKey], 1, code);
    assert.deepEqual(fake.delays, []);
  }
});

test('a refusal raised by the caller fetchImpl is never retried', async () => {
  for (const fault of [() => Object.assign(new Error('ISSUER_ACCEPTANCE_EXPIRED'), { code: 'ISSUER_ACCEPTANCE_EXPIRED' }),
    () => new DOMException('aborted', 'AbortError'), () => new DOMException('timed out', 'TimeoutError')]) {
    const fake = github({ faults: { [prKey]: [fault] } });
    await assert.rejects(fake.port().readPullRequest(7), { code: 'github_transport_unconfirmed' });
    assert.equal(fake.calls[prKey], 1);
  }
});

test('all retries of a port share one budget per 30 s span', async () => {
  const slow = state => { state.now += 1_500; return reset(); };
  const fake = github({ faults: { [prKey]: [slow, slow, slow, reset, reset, reset] } });
  const port = fake.port();
  await assert.rejects(port.readPullRequest(7), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[prKey], 3); // 250 + 1500 + 750 + 1500 = the whole 4 s
  await assert.rejects(port.readPullRequest(7), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[prKey], 4); // budget spent: no retry inside the same 30 s
  fake.state.now += 30_000;
  assert.equal((await port.readPullRequest(7)).number, 7); // a later span has a fresh budget
  assert.equal(fake.calls[prKey], 7); // two failures, then the real answer
  const off = github({ faults: { [prKey]: [reset] } });
  await assert.rejects(off.port({ retryWindowMs: 0 }).readPullRequest(7), { code: 'github_transport_unconfirmed' });
  assert.equal(off.calls[prKey], 1);
});

test('retry settings are validated', () => {
  const fake = github();
  for (const extra of [{ retryWindowMs: -1 }, { retryWindowMs: 10_001 }, { retryWindowMs: 1.5 }, { sleep: null }, { clock: 'now' }])
    assert.throws(() => fake.port(extra), { code: 'invalid_checks_configuration' });
});

test('the installation token exchange repeats after a transport failure', async () => {
  const mintKey = `POST /app/installations/${INSTALLATION_ID}/access_tokens`;
  const fake = github({ faults: { [mintKey]: [reset] } });
  assert.equal(await fake.port().getInstallationToken(), 'installation-token');
  assert.equal(fake.calls[mintKey], 2);
});

test('a check whose POST reply was lost is read back by external_id and never posted twice', async () => {
  const lost = state => { state.checks.push(ours({ id: 321 })); return reset(); };
  const fake = github({ faults: { [postKey]: [lost] } });
  assert.equal((await fake.port().createCheck(publication)).id, 321);
  assert.equal(fake.calls[postKey], 1);
  assert.equal(fake.state.checks.length, 1);
});

test('an ambiguous POST failure with no copy on GitHub fails closed without a second POST', async () => {
  const fake = github({ faults: { [postKey]: [reset] } });
  await assert.rejects(fake.port().createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[postKey], 1);
  assert.equal(fake.state.checks.length, 0);
});

test('a POST whose 2xx body is cut off is never sent again, even with a connect-looking cause', async () => {
  // GitHub accepted the run; a stale read-back must not lead to a second POST.
  const accepted = state => { state.created = true; return cutBody(201, 'EHOSTUNREACH'); };
  const fake = github({ faults: { [postKey]: [accepted] } });
  await assert.rejects(fake.port().createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[postKey], 1);
  assert.equal(fake.calls[listKey], 1); // read back once, then fail closed without a resend
});

test('a connect-phase POST failure is sent again only after the read-back finds no copy', async () => {
  const fake = github({ faults: { [postKey]: [refused] } });
  assert.equal((await fake.port().createCheck(publication)).external_id, publication.external_id);
  assert.equal(fake.calls[postKey], 2);
  assert.equal(fake.calls[listKey], 1);
  assert.equal(fake.state.checks.length, 1);
});

test('an HTTP refusal or redirect of a write skips the read-back', async () => {
  for (const fault of [reply({ message: 'unprocessable' }, 422), redirect]) {
    const fake = github({ faults: { [postKey]: [fault], [patchKey]: [fault] }, checks: [ours()] });
    await assert.rejects(fake.port().createCheck(publication));
    await assert.rejects(fake.port().revokeCheck(600, revocation));
    assert.equal(fake.calls[postKey], 1);
    assert.equal(fake.calls[patchKey], 1);
    assert.equal(fake.calls[listKey], undefined);
    assert.equal(fake.calls[runKey], undefined);
  }
});

test('a read-back that finds another App, a different result or output, or two copies refuses', async () => {
  const other = github({ checks: [ours({ id: 1, app: { id: 5365273 } })], faults: { [postKey]: [refused] } });
  await other.port().createCheck(publication); // another App's run is not ours: one more POST
  assert.equal(other.calls[postKey], 2);
  for (const checks of [[ours({ conclusion: 'failure' })], [ours({ output: { ...publication.output, summary: 'other observation' } })],
    [ours({ id: 3 }), ours({ id: 4 })]]) {
    const fake = github({ checks, faults: { [postKey]: [refused] } });
    await assert.rejects(fake.port().createCheck(publication), { code: 'github_transport_unconfirmed' });
    assert.equal(fake.calls[postKey], 1);
  }
});

test('a failed read-back keeps the original failure and sends nothing more', async () => {
  const fake = github({ faults: { [postKey]: [refused], [listKey]: [reply({}, 500)] } });
  await assert.rejects(fake.port().createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[postKey], 1);
});

test('a revocation whose PATCH reply was lost is read back and not patched twice', async () => {
  const lost = state => { Object.assign(state.checks[0], revocation); return reset(); };
  const fake = github({ checks: [ours()], faults: { [patchKey]: [lost] } });
  assert.equal((await fake.port().revokeCheck(600, revocation)).conclusion, 'failure');
  assert.equal(fake.calls[patchKey], 1);
  const pending = github({ checks: [ours()], faults: { [patchKey]: [reset] } });
  await assert.rejects(pending.port().revokeCheck(600, revocation), { code: 'github_transport_unconfirmed' });
  assert.equal(pending.calls[patchKey], 1);
  assert.equal(pending.state.checks[0].conclusion, 'success');
});

test('a connect-phase PATCH failure is sent again after the read-back shows it not applied', async () => {
  const fake = github({ checks: [ours()], faults: { [patchKey]: [refused] } });
  assert.equal((await fake.port().revokeCheck(600, revocation)).conclusion, 'failure');
  assert.equal(fake.calls[patchKey], 2);
  assert.equal(fake.calls[runKey], 1);
});

test('a token refresh needed by a write read-back stays inside the retry budget', async () => {
  const mintKey = `POST /app/installations/${INSTALLATION_ID}/access_tokens`;
  const lost = state => { state.now += 6_000; state.checks.push(ours({ id: 321 })); return reset(); };
  const fake = github({ faults: { [postKey]: [lost] } });
  const port = fake.port();
  await port.getInstallationToken();
  fake.state.now += 3_600_000 - 65_000; // 65 s left: still valid for the POST, not for its read-back
  assert.equal((await port.createCheck(publication)).id, 321);
  assert.equal(fake.calls[mintKey], 2);
  assert.equal(fake.calls[postKey], 1);
  const slow = github({ faults: { [postKey]: [lost], [mintKey]: [null, state => { state.now += 5_000; }] } });
  const late = slow.port();
  await late.getInstallationToken();
  slow.state.now += 3_600_000 - 65_000;
  await assert.rejects(late.createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(slow.calls[postKey], 1);
  assert.equal(slow.calls['GET /installation/repositories'], 1); // the late refresh is cut off by the budget
});

// Real undici failures over loopback: api.github.com is mapped to a local server.
async function loopback(t, route) {
  const counts = {}, server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname, key = `${req.method} ${path}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    req.resume(); req.on('end', () => {
      if (route(key, counts[key], req, res, send)) return;
      if (key === 'GET /app') return send({ id: APP_ID });
      if (key === `POST /app/installations/${INSTALLATION_ID}/access_tokens`) return send(tokenReply(Date.now()));
      if (key === 'GET /installation/repositories') return send({ total_count: 1, repositories: [{ id: REPO_ID, full_name: REPO }] });
      if (key === prKey) return send(pr);
      if (key === listKey) return send({ total_count: 0, check_runs: [] });
      send({ message: 'Not Found' }, 404);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, options) => globalThis.fetch(url.replace('https://api.github.com', origin), options);
  const port = createGitHubChecksPort({ repository: REPO, repositoryId: REPO_ID, appId: APP_ID, installationId: INSTALLATION_ID,
    privateKeyProvider: async () => privateKey, fetchImpl, sleep: async () => {} });
  return { counts, port, fetch: fetchImpl };
}

test('real undici: a dropped connection, a cut body and a redirect are classified as designed', async t => {
  const net = await loopback(t, (key, n, req, res) => {
    if (key === prKey && n === 1) { req.socket.destroy(); return true; } // dropped: repeat the read
    if (key === prKey && n === 2) { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999' }); res.write('{"number"'); res.socket.destroy(); return true; }
    if (key === postKey) { req.socket.destroy(); return true; } // dropped write: read back, never resend
    if (key === `GET /repos/${REPO}/pulls/8`) { res.writeHead(302, { location: 'https://example.invalid/' }); res.end(); return true; }
    return false;
  });
  assert.equal((await net.port.readPullRequest(7)).number, 7);
  assert.equal(net.counts[prKey], 3);
  await assert.rejects(net.port.createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(net.counts[postKey], 1);
  assert.ok(net.counts[listKey] >= 1);
  await assert.rejects(net.port.readPullRequest(8), { code: 'github_transport_unconfirmed' });
  assert.equal(net.counts[`GET /repos/${REPO}/pulls/8`], 1);
});

test('real undici: a refused connect lets a write be sent again after an empty read-back', async t => {
  const closed = http.createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const dead = closed.address().port; await new Promise(resolve => closed.close(resolve));
  const net = await loopback(t, () => false);
  let sent = 0;
  const port = createGitHubChecksPort({ repository: REPO, repositoryId: REPO_ID, appId: APP_ID, installationId: INSTALLATION_ID,
    privateKeyProvider: async () => privateKey, sleep: async () => {}, retryWindowMs: 10_000,
    fetchImpl: async (url, options) => {
      if (options.method === 'POST' && url.endsWith('/check-runs')) {
        if (++sent === 1) return globalThis.fetch(`http://127.0.0.1:${dead}/`, options); // refused at connect
        return reply({ ...publication, id: 9, app: { id: APP_ID } }, 201);
      }
      return net.fetch(url, options);
    } });
  assert.equal((await port.createCheck(publication)).id, 9);
  assert.equal(sent, 2);
  assert.equal(net.counts[listKey], 1);
});

// Hosted relay reads (S16/S17): GET only, fixed origin, unchanged token scope.
function relayGithub(routes = {}) {
  const calls = [], minted = [];
  async function fetchImpl(url, options) {
    const parsed = new URL(url), key = `${options.method} ${parsed.pathname}`;
    calls.push({ origin: parsed.origin, method: options.method, key, search: parsed.search });
    if (key === 'GET /app') return reply({ id: APP_ID });
    if (key === `POST /app/installations/${INSTALLATION_ID}/access_tokens`) { minted.push(JSON.parse(options.body)); return reply(tokenReply(Date.parse('2026-10-21T00:00:00Z'))); }
    if (key === 'GET /installation/repositories') return reply({ total_count: 1, repositories: [{ id: REPO_ID, full_name: REPO }] });
    const route = routes[key];
    if (typeof route === 'function') return route(parsed);
    if (route) return reply(route);
    return reply({ message: 'Not Found' }, 404);
  }
  const port = createGitHubChecksPort({ repository: REPO, repositoryId: REPO_ID, appId: APP_ID, installationId: INSTALLATION_ID,
    privateKeyProvider: async () => privateKey, fetchImpl, clock: () => Date.parse('2026-10-21T00:00:00Z'), sleep: async () => {} });
  return { port, calls, minted };
}
const TREE = 'c'.repeat(40), CHILD = 'd'.repeat(40);
const relayRun = (id, name = 'gitleaks-hosted-executor') => ({ id, name, head_sha: HEAD, status: 'completed', conclusion: 'success', app: { id: 15368 } });
const annotation = n => ({ annotation_level: 'notice', title: n === 0 ? 'clued-hosted-relay-v1' : '', message: `m${n}`, path: '.github' });

test('hosted relay reads are normalized GET requests on the fixed origin with the unchanged token scope', async () => {
  const fake = relayGithub({
    [`GET /repos/${REPO}/branches/main`]: { name: 'main', commit: { sha: BASE } },
    [`GET /repos/${REPO}/compare/${BASE}...${HEAD}`]: { status: 'ahead', ahead_by: 2, behind_by: 0, base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, files: [] },
    [`GET /repos/${REPO}/git/commits/${HEAD}`]: { sha: HEAD, tree: { sha: TREE }, parents: [{ sha: BASE }] },
    [`GET /repos/${REPO}/git/trees/${TREE}`]: { sha: TREE, truncated: false, tree: [{ path: '.github', mode: '040000', type: 'tree', sha: CHILD },
      { path: '.gitattributes', mode: '100644', type: 'blob', sha: BASE, size: 3 }] },
    [`GET /repos/${REPO}/commits/${HEAD}/check-runs`]: url => reply({ total_count: 1, check_runs: [relayRun(5, url.searchParams.get('check_name'))] }),
    [`GET /repos/${REPO}/check-runs/5/annotations`]: [annotation(0), annotation(1)],
  });
  const { port } = fake;
  assert.deepEqual(await port.readBranchHead('main'), { name: 'main', sha: BASE });
  assert.deepEqual(await port.readCompare(BASE, HEAD), { baseSha: BASE, headSha: HEAD, status: 'ahead', aheadBy: 2, behindBy: 0, mergeBaseSha: BASE });
  assert.deepEqual(await port.readGitCommit(HEAD), { sha: HEAD, tree: TREE, parents: [BASE] });
  assert.deepEqual(await port.readGitTree(TREE), { sha: TREE, entries: [{ name: '.github', mode: '040000', type: 'tree', sha: CHILD },
    { name: '.gitattributes', mode: '100644', type: 'blob', sha: BASE }] });
  const named = await port.readCheckRunsByName(HEAD, 'gitleaks-hosted-executor');
  assert.deepEqual(named.checks.map(check => check.name), ['gitleaks-hosted-executor']);
  assert.deepEqual(await port.readCheckRunAnnotations(5, 2), { complete: true, checkRunId: 5, annotations: [
    { level: 'notice', title: 'clued-hosted-relay-v1', message: 'm0', path: '.github' }, { level: 'notice', title: '', message: 'm1', path: '.github' }] });
  const reads = fake.calls.filter(call => call.key.startsWith(`GET /repos/${REPO}/`));
  assert.ok(fake.calls.every(call => call.origin === 'https://api.github.com'));
  assert.ok(reads.every(call => call.method === 'GET'));
  assert.equal(reads.find(call => call.key.endsWith('/check-runs')).search, '?check_name=gitleaks-hosted-executor&filter=all&per_page=100&page=1');
  assert.equal(reads.find(call => call.key.includes('/compare/')).search, '?per_page=1');
  assert.deepEqual(fake.minted, [{ repository_ids: [REPO_ID], permissions: { checks: 'write', contents: 'read', pull_requests: 'read' } }]);
});

test('relay reads refuse incomplete, truncated, renamed or mismatched replies', async () => {
  const cases = [
    [`GET /repos/${REPO}/commits/${HEAD}/check-runs`, () => reply({ total_count: 1, check_runs: [relayRun(5, 'gitleaks')] }), port => port.readCheckRunsByName(HEAD, 'gitleaks-hosted-executor'), 'invalid_check_set'],
    [`GET /repos/${REPO}/commits/${HEAD}/check-runs`, () => reply({ total_count: 2, check_runs: [relayRun(5)] }), port => port.readCheckRunsByName(HEAD, 'gitleaks-hosted-executor'), 'incomplete_checks'],
    [`GET /repos/${REPO}/check-runs/5/annotations`, () => reply([annotation(0)]), port => port.readCheckRunAnnotations(5, 2), 'incomplete_annotations'],
    [`GET /repos/${REPO}/check-runs/5/annotations`, () => reply([annotation(0), annotation(1)]), port => port.readCheckRunAnnotations(5, 1), 'annotations_changed'],
    [`GET /repos/${REPO}/check-runs/5/annotations`, () => reply([{ ...annotation(0), annotation_level: 'debug' }]), port => port.readCheckRunAnnotations(5, 1), 'invalid_annotations_reply'],
    [`GET /repos/${REPO}/git/trees/${TREE}`, () => reply({ sha: TREE, truncated: true, tree: [] }), port => port.readGitTree(TREE), 'invalid_tree_reply'],
    [`GET /repos/${REPO}/git/trees/${TREE}`, () => reply({ sha: TREE, truncated: false, tree: [{ path: 'a/b', mode: '100644', type: 'blob', sha: BASE }] }), port => port.readGitTree(TREE), 'invalid_tree_reply'],
    [`GET /repos/${REPO}/git/commits/${HEAD}`, () => reply({ sha: BASE, tree: { sha: TREE }, parents: [] }), port => port.readGitCommit(HEAD), 'invalid_commit_reply'],
    [`GET /repos/${REPO}/compare/${BASE}...${HEAD}`, () => reply({ status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: HEAD }, merge_base_commit: { sha: BASE } }), port => port.readCompare(BASE, HEAD), 'invalid_compare_reply'],
    [`GET /repos/${REPO}/branches/main`, () => reply({ name: 'other', commit: { sha: BASE } }), port => port.readBranchHead('main'), 'invalid_branch_reply'],
  ];
  for (const [key, route, call, code] of cases) {
    const fake = relayGithub({ [key]: route });
    await assert.rejects(call(fake.port), { code }, code);
  }
  // 150 annotations over two pages are read completely.
  const many = Array.from({ length: 150 }, (_, n) => annotation(n + 1));
  const paged = relayGithub({ [`GET /repos/${REPO}/check-runs/9/annotations`]: url => reply(url.searchParams.get('page') === '1' ? many.slice(0, 100) : many.slice(100)) });
  assert.equal((await paged.port.readCheckRunAnnotations(9, 150)).annotations.length, 150);
});

test('relay read arguments are validated before any request', async () => {
  const fake = relayGithub();
  for (const [call, code] of [[port => port.readCompare('main', HEAD), 'invalid_compare'], [port => port.readGitTree('x'), 'invalid_tree'],
    [port => port.readGitCommit(HEAD.toUpperCase()), 'invalid_commit'], [port => port.readCheckRunsByName(HEAD, 'a\nb'), 'invalid_check_name'],
    [port => port.readBranchHead('../main'), 'invalid_branch'], [port => port.readCheckRunAnnotations(0, 1), 'invalid_annotation_request'],
    [port => port.readCheckRunAnnotations(1, -1), 'invalid_annotation_request']]) await assert.rejects(call(fake.port), { code }, code);
  assert.equal(fake.calls.length, 0);
});

// Step 3c-2a (design v0.5 §5.7): the PR's base.sha is compared with T only for a job that tests the head. A train front
// batch (testSha != headSha) takes whatever base.sha GitHub reports, the same on both reads; a v1 job (no testSha) and a
// job whose S is the head stay exact.
test('readChangedPaths: base.sha is a fact for a train front batch only, and both reads must agree', async () => {
  const MOVED = '9'.repeat(40), S = '4'.repeat(40);
  const moved = sha => reply({ ...pr, base: { ...pr.base, sha } });
  const front = { ...job, testSha: S };
  const ok = await github({ faults: { [prKey]: [moved(MOVED), moved(MOVED)] } }).port().readChangedPaths(front);
  assert.deepEqual([ok.baseSha, ok.paths], [BASE, ['a.txt']], 'the packet still names the batch base T');
  await assert.rejects(github({ faults: { [prKey]: [moved(MOVED), moved('8'.repeat(40))] } }).port().readChangedPaths(front), { code: 'pr_subject_changed' });
  await assert.rejects(github({ faults: { [prKey]: [moved('X'.repeat(40))] } }).port().readChangedPaths(front), { code: 'pr_subject_changed' });
  for (const exact of [job, { ...job, testSha: HEAD }, { ...job, testSha: null }]) {
    await assert.rejects(github({ faults: { [prKey]: [moved(MOVED)] } }).port().readChangedPaths(exact), { code: 'pr_subject_changed' });
    assert.deepEqual((await github().port().readChangedPaths(exact)).paths, ['a.txt']);
  }
});
