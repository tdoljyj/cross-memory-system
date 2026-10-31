import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ENVIRONMENTS, evaluateSmoke, parseArgs, runSmoke } from '../scripts/release-smoke.mjs';
import { contractVersionOf } from '../scripts/verify-served-agent-contract.mjs';

const contract = (await readFile(new URL(
  '../../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const version = contractVersionOf(contract);
const commit = 'a'.repeat(40);
const bootstrap = { lifecycle: { contract: { version, url: 'https://dev.beamingface.com/clued-agent.md' } },
  agent_contract: { version, sha256: createHash('sha256').update(contract).digest('hex') } };

function healthyObservation(overrides = {}) {
  return {
    health: { status: 200, body: { status: 'ok', source_commit: commit } },
    home: { status: 200, body: '<html></html>' },
    contract: { status: 200, body: `${contract}\n---\nKernel: test\n` },
    bootstrap: { status: 200, body: bootstrap },
    ...overrides,
  };
}

function fakeFetch(observation) {
  const byPath = { '/healthz': 'health', '/': 'home', '/clued-agent.md': 'contract',
    '/v1/continuity/bootstrap': 'bootstrap' };
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    const entry = observation[byPath[new URL(url).pathname]];
    if (!entry || entry.status === null) throw new TypeError('network');
    const text = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
    return { status: entry.status, text: async () => text };
  };
  return { impl, seen };
}

test('arguments name a known environment and a full commit; test needs an explicit origin', () => {
  const production = parseArgs(['--env', 'production', '--commit', commit]);
  assert.equal(production.origin, ENVIRONMENTS.production.origin);
  assert.equal(production.originOverridden, false);
  assert.throws(() => parseArgs(['--env', 'test', '--commit', commit]), /release_smoke_origin_invalid/);
  const testEnv = parseArgs(['--env', 'test', '--commit', commit,
    '--origin', 'https://clued-cloud-test.example.workers.dev/', '--contract-file', 'previous.md']);
  assert.equal(testEnv.origin, 'https://clued-cloud-test.example.workers.dev');
  assert.equal(testEnv.originOverridden, true);
  assert.equal(testEnv.contractFile, 'previous.md');
  assert.throws(() => parseArgs(['--env', 'staging', '--commit', commit]), /release_smoke_env_invalid/);
  assert.throws(() => parseArgs(['--env', 'test', '--commit', 'abc']), /release_smoke_commit_invalid/);
  assert.throws(() => parseArgs(['--env', 'test', '--commit', commit, '--origin', 'http://x']),
    /release_smoke_origin_invalid/);
  assert.throws(() => parseArgs(['--env', 'test', '--commit', commit, '--bogus', '1']),
    /release_smoke_unknown_argument/);
});

test('a healthy environment serving the expected commit and contract passes', () => {
  assert.deepEqual(evaluateSmoke({ commit, contract, observed: healthyObservation() }), []);
});

test('a previous commit, a down home page or a stale contract fails', () => {
  assert.deepEqual(evaluateSmoke({ commit, contract, observed: healthyObservation({
    health: { status: 200, body: { status: 'ok', source_commit: 'b'.repeat(40) } } }) }),
  ['healthz_source_commit_mismatch']);
  assert.deepEqual(evaluateSmoke({ commit, contract, observed: healthyObservation({
    home: { status: 500, body: null } }) }), ['home_http_500']);
  assert.deepEqual(evaluateSmoke({ commit, contract, observed: healthyObservation({
    contract: { status: 200, body: '# old' } }) }), ['served_agent_contract_differs_from_repository']);
  assert.deepEqual(evaluateSmoke({ commit, contract, observed: healthyObservation({
    health: { status: null, body: null }, bootstrap: { status: 404, body: null } }) }),
  ['healthz_http_none', 'agent_contract_unreachable']);
});

test('runSmoke retries until the new version is served, using only GET without redirects', async () => {
  const stale = healthyObservation({ health: { status: 200, body: { status: 'ok', source_commit: 'b'.repeat(40) } } });
  let calls = 0;
  const healthy = fakeFetch(healthyObservation());
  const old = fakeFetch(stale);
  const fetchImpl = async (url, init) => {
    calls += 1;
    return (calls <= 4 ? old.impl : healthy.impl)(url, init);
  };
  const options = parseArgs(['--env', 'test', '--commit', commit, '--origin', 'https://t.example.dev', '--attempts', '3', '--delay-ms', '0']);
  const result = await runSmoke({ options, contract, fetchImpl, sleep: async () => {} });
  assert.equal(result.status, 'passed');
  assert.equal(result.attempts, 2);
  for (const { init } of [...old.seen, ...healthy.seen]) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
  }
});

test('runSmoke reports failure after the last attempt', async () => {
  const { impl } = fakeFetch(healthyObservation({ home: { status: 503, body: null } }));
  const options = parseArgs(['--env', 'production', '--commit', commit, '--attempts', '2', '--delay-ms', '0']);
  const result = await runSmoke({ options, contract, fetchImpl: impl, sleep: async () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.errors, ['home_http_503']);
});
