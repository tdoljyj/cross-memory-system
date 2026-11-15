// Task 1b: the evidence rules that call a failed required-tests job an environment failure. The resident keeps a byte-identical copy of
// scripts/ci/ci-env-failure.mjs (the gate's classifier); this test keeps them one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { MAX_LOG_CHARS, diedInSetup, jobFailureKind } from '../src/env-failure.mjs';

const step = (name, conclusion) => ({ name, status: 'completed', conclusion });
const job = (conclusion, steps, extra = {}) => ({ id: 1, name: 'ci-suites', status: 'completed', conclusion, ...(steps ? { steps } : {}), ...extra });
const SETUP = [step('Set up job', 'failure'), step('Run tests', 'skipped')];
const RUN = [step('Set up job', 'success'), step('Run tests', 'failure')];

test('the resident copy is byte-identical to the gate classifier', async () => {
  const gate = await fs.readFile(new URL('../../../scripts/ci/ci-env-failure.mjs', import.meta.url), 'utf8');
  const copy = await fs.readFile(new URL('../src/env-failure.mjs', import.meta.url), 'utf8');
  assert.equal(copy.replace(/\r\n/g, '\n'), gate.replace(/\r\n/g, '\n'));
});

test('a job that died in the runner\'s setup is an environment failure with no log; any other failed step needs the log', () => {
  assert.deepEqual(jobFailureKind(job('failure', SETUP)).kind, 'setup');
  assert.equal(diedInSetup(job('failure', SETUP)), true);
  assert.equal(diedInSetup(job('failure', [step('Set up job', 'failure'), step('Run tests', 'failure')])), false);
  assert.equal(jobFailureKind(job('failure', RUN)).environment, false); // no log read
  assert.equal(jobFailureKind(job('failure')).environment, false); // no step record
  assert.equal(jobFailureKind(job('failure', [])).environment, false);
});

test('the log: a network failure with no failed test is environment; a failed test, assertion or "N failed" summary never is', () => {
  const net = 'npm error code ECONNRESET\nnpm error network aborted';
  assert.deepEqual([jobFailureKind(job('failure', RUN), net).environment, jobFailureKind(job('failure', RUN), net).kind], [true, 'network']);
  for (const signature of ['socket hang up', 'getaddrinfo EAI_AGAIN registry.npmjs.org', 'curl: (6) Could not resolve host: github.com', '429 Too Many Requests',
    'fatal: unable to access x: RPC failed; curl 56 OpenSSL SSL_read', 'request to https://registry.npmjs.org/x failed, reason: connect ETIMEDOUT']) {
    assert.equal(jobFailureKind(job('failure', RUN), `before\n${signature}\nafter`).environment, true, signature);
  }
  for (const failed of ['not ok 12 - something', '# fail 2', 'AssertionError [ERR_ASSERTION]: x', '✖ a test (1ms)', 'Tests  3 failed | 40 passed', ' FAIL  src/a.test.ts']) {
    const kind = jobFailureKind(job('failure', RUN), `${net}\n${failed}`);
    assert.deepEqual([failed, kind.environment, kind.kind], [failed, false, 'test']);
  }
  assert.equal(jobFailureKind(job('failure', RUN), '# fail 0\nECONNRESET').environment, true); // a passing summary is not a failed test
  assert.equal(jobFailureKind(job('failure', RUN), '##[error]lint failed').environment, false);
  assert.equal(jobFailureKind(job('failure', RUN), '').environment, false);
  assert.equal(jobFailureKind(job('failure', RUN), `${net}${'x'.repeat(MAX_LOG_CHARS)}`).environment, false);
});

test('only a failure is classified: cancelled, timed out, passed and unfinished jobs are never environment', () => {
  for (const conclusion of ['cancelled', 'timed_out', 'success', 'skipped', 'neutral', null]) {
    assert.equal(jobFailureKind(job(conclusion, SETUP), 'ECONNRESET').environment, false, String(conclusion));
  }
  assert.equal(jobFailureKind(job('failure', SETUP, { status: 'in_progress' })).environment, false);
});
