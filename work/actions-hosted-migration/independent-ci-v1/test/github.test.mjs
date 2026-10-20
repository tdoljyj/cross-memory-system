import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createGitHubChecksPort } from '../src/github.mjs';

const REPO = 'owner/repo', REPO_ID = 41, APP_ID = 77, INSTALLATION_ID = 99;
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// Shapes that undici's fetch() really produces for network failures.
const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const cutBody = () => ({ ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } });

// A fake GitHub. `faults` maps "METHOD path" to a queue of failures injected
// before the real answer; every call is counted per key.
function github({ faults = {}, checks = [] } = {}) {
  const calls = {}, delays = [], state = { now: Date.parse('2026-10-20T00:00:00Z'), checks: [...checks], nextId: 500 };
  const queues = Object.fromEntries(Object.entries(faults).map(([key, list]) => [key, [...list]]));
  async function fetchImpl(url, options) {
    const { pathname, search } = new URL(url), key = `${options.method} ${pathname}`;
    calls[key] = (calls[key] ?? 0) + 1;
    const fault = queues[key]?.shift();
    if (fault) {
      if (typeof fault === 'function') { const value = fault(state); if (value instanceof Error) throw value; return value; }
      return fault;
    }
    if (key === 'GET /app') return reply({ id: APP_ID });
    if (key === `POST /app/installations/${INSTALLATION_ID}/access_tokens`) return reply({ token: 'installation-token',
      expires_at: new Date(state.now + 3_600_000).toISOString(), permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    if (key === 'GET /installation/repositories') return reply({ total_count: 1, repositories: [{ id: REPO_ID, full_name: REPO }] });
    if (key === `GET /repos/${REPO}/pulls/7`) return reply({ number: 7, state: 'open', changed_files: 1,
      head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } });
    if (key === `GET /repos/${REPO}/pulls/7/files`) return reply([{ filename: 'a.txt', status: 'modified' }]);
    if (key === `GET /repos/${REPO}/commits/${HEAD}/check-runs`) {
      assert.match(search, /filter=all/);
      return reply({ total_count: state.checks.length, check_runs: state.checks });
    }
    if (key === `POST /repos/${REPO}/check-runs`) {
      const run = { ...JSON.parse(options.body), id: state.nextId++, app: { id: APP_ID } };
      state.checks.push(run); return reply(run, 201);
    }
    const patch = pathname.match(new RegExp(`^/repos/${REPO}/check-runs/(\\d+)$`));
    if (patch) {
      const run = state.checks.find(check => check.id === Number(patch[1]));
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
const prKey = `GET /repos/${REPO}/pulls/7`, postKey = `POST /repos/${REPO}/check-runs`;

test('a read that hits a transport failure is repeated and succeeds', async () => {
  const fake = github({ faults: { [prKey]: [reset] } });
  const result = await fake.port().readChangedPaths(job);
  assert.deepEqual(result.paths, ['a.txt']);
  assert.equal(fake.calls[prKey], 3); // one failed + one repeated before files, one after files
  assert.deepEqual(fake.delays, [250]);
});

test('a read gives up after three attempts with the unchanged failure code', async () => {
  const fake = github({ faults: { [prKey]: [reset, reset, reset] } });
  await assert.rejects(fake.port().readPullRequest(7), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[prKey], 3);
  assert.deepEqual(fake.delays, [250, 750]);
});

test('a body cut off mid-read is a transport failure and the read repeats', async () => {
  const fake = github({ faults: { [prKey]: [cutBody] } });
  assert.equal((await fake.port().readPullRequest(7)).number, 7);
  assert.equal(fake.calls[prKey], 2);
});

test('an HTTP status refusal is never retried', async () => {
  const fake = github({ faults: { [prKey]: [reply({ message: 'bad gateway' }, 502)] } });
  await assert.rejects(fake.port().readPullRequest(7), { code: 'github_http_502' });
  assert.equal(fake.calls[prKey], 1);
  assert.deepEqual(fake.delays, []);
});

test('an unparsable body is never retried', async () => {
  const fake = github({ faults: { [prKey]: [{ ok: true, status: 200, json: async () => JSON.parse('{') }] } });
  await assert.rejects(fake.port().readPullRequest(7), { code: 'github_response_invalid' });
  assert.equal(fake.calls[prKey], 1);
});

test('a refusal raised by the caller fetchImpl is never retried', async () => {
  const expired = () => Object.assign(new Error('ISSUER_ACCEPTANCE_EXPIRED'), { code: 'ISSUER_ACCEPTANCE_EXPIRED' });
  const fake = github({ faults: { [prKey]: [expired] } });
  await assert.rejects(fake.port().readPullRequest(7), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[prKey], 1);
  const aborted = github({ faults: { [prKey]: [() => new DOMException('aborted', 'AbortError')] } });
  await assert.rejects(aborted.port().readPullRequest(7), { code: 'github_transport_unconfirmed' });
  assert.equal(aborted.calls[prKey], 1);
});

test('no retry starts once the retry window would be exceeded', async () => {
  const slow = state => { state.now += 3_900; return reset(); };
  const fake = github({ faults: { [prKey]: [slow] } });
  await assert.rejects(fake.port().readPullRequest(7), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[prKey], 1);
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
  const lost = state => { state.checks.push({ ...publication, id: 321, app: { id: APP_ID } }); return reset(); };
  const fake = github({ faults: { [postKey]: [lost] } });
  const created = await fake.port().createCheck(publication);
  assert.equal(created.id, 321);
  assert.equal(fake.calls[postKey], 1);
  assert.equal(fake.state.checks.length, 1);
});

test('an ambiguous POST failure with no copy on GitHub fails closed without a second POST', async () => {
  const fake = github({ faults: { [postKey]: [reset] } });
  await assert.rejects(fake.port().createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[postKey], 1);
  assert.equal(fake.state.checks.length, 0);
});

test('a connect-phase POST failure is sent again only after the read-back finds no copy', async () => {
  const fake = github({ faults: { [postKey]: [refused] } });
  const created = await fake.port().createCheck(publication);
  assert.equal(created.external_id, publication.external_id);
  assert.equal(fake.calls[postKey], 2);
  assert.equal(fake.state.checks.length, 1);
});

test('a read-back that finds another App, a different result or two copies refuses', async () => {
  const foreign = { ...publication, id: 1, app: { id: 5365273 } };
  const other = github({ checks: [foreign], faults: { [postKey]: [refused] } });
  await other.port().createCheck(publication); // another App's run is not ours: one more POST
  assert.equal(other.calls[postKey], 2);
  const differs = github({ checks: [{ ...publication, id: 2, conclusion: 'failure', app: { id: APP_ID } }], faults: { [postKey]: [refused] } });
  await assert.rejects(differs.port().createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(differs.calls[postKey], 1);
  const twice = github({ checks: [3, 4].map(id => ({ ...publication, id, app: { id: APP_ID } })), faults: { [postKey]: [refused] } });
  await assert.rejects(twice.port().createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(twice.calls[postKey], 1);
});

test('a failed read-back keeps the original failure and sends nothing more', async () => {
  const listKey = `GET /repos/${REPO}/commits/${HEAD}/check-runs`;
  const fake = github({ faults: { [postKey]: [refused], [listKey]: [reply({}, 500)] } });
  await assert.rejects(fake.port().createCheck(publication), { code: 'github_transport_unconfirmed' });
  assert.equal(fake.calls[postKey], 1);
});

test('a revocation whose PATCH reply was lost is read back and not patched twice', async () => {
  const run = () => ({ ...publication, id: 600, app: { id: APP_ID } });
  const patchKey = `PATCH /repos/${REPO}/check-runs/600`;
  const revocation = { status: 'completed', conclusion: 'failure', output: { title: 'Independent control authorization changed', summary: 'fixture' } };
  const lost = state => { Object.assign(state.checks[0], revocation); return reset(); };
  const fake = github({ checks: [run()], faults: { [patchKey]: [lost] } });
  assert.equal((await fake.port().revokeCheck(600, revocation)).conclusion, 'failure');
  assert.equal(fake.calls[patchKey], 1);
  const pending = github({ checks: [run()], faults: { [patchKey]: [reset] } });
  await assert.rejects(pending.port().revokeCheck(600, revocation), { code: 'github_transport_unconfirmed' });
  assert.equal(pending.calls[patchKey], 1);
  assert.equal(pending.state.checks[0].conclusion, 'success');
});
