// Task 1b: the evidence rules that call a failed required-tests job an environment failure. The gate's classifier lives inside the pinned
// scripts/ci/clued-work-admission.mjs; the resident keeps a copy of it, and the first test keeps the two identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { MAX_LOG_CHARS, diedInSetup, jobFailureKind } from '../src/env-failure.mjs';
import { jobFailureKind as gateFailureKind } from '../../../scripts/ci/clued-work-admission.mjs';

const step = (name, conclusion) => ({ name, status: 'completed', conclusion });
const job = (conclusion, steps, extra = {}) => ({ id: 1, name: 'ci-suites', status: 'completed', conclusion, ...(steps ? { steps } : {}), ...extra });
const SETUP = [step('Set up job', 'failure'), step('Run tests', 'skipped')];
const RUN = [step('Set up job', 'success'), step('Run tests', 'failure')];

test('the resident failure classifier agrees with the pinned gate and, after T1, byte-matches the gate and runner hook', async () => {
  const classifier = text => text.replaceAll('\r\n', '\n').match(/^export const SETUP_STEPS[\s\S]*?^export function jobFailureKind[\s\S]*?^}/m)?.[0];
  const [gate, copy, hook] = await Promise.all(['../../../scripts/ci/clued-work-admission.mjs', '../src/env-failure.mjs',
    '../../../scripts/runner/clued-runner-job-started.mjs'].map(async file => classifier(await fs.readFile(new URL(file, import.meta.url), 'utf8'))));
  assert.ok(gate.includes('export function jobFailureKind') && gate.length > 1500);
  if (hook || gate.includes('annotations = null')) {
    assert.equal(copy, gate);
    assert.equal(hook, gate);
  } else {
    // T2 is developed against the pre-T1 base. Keep the shared setup/network
    // evidence byte-identical there and require full equality once T1 lands.
    const common = body => body.slice(0, body.indexOf('\n//', body.indexOf('export function diedInSetup')));
    assert.equal(common(copy), common(gate));
    for (const steps of [SETUP, RUN, []]) {
      for (const log of ['ECONNRESET', 'ECONNRESET\nnot ok 1', 'ordinary log', null]) {
        assert.deepEqual(jobFailureKind(job('failure', steps), log), gateFailureKind(job('failure', steps), log));
      }
    }
  }
});

test('a job that died in the runner\'s setup is an environment failure with no log; any other failed step needs the log', () => {
  assert.deepEqual(jobFailureKind(job('failure', SETUP)).kind, 'setup');
  assert.equal(diedInSetup(job('failure', SETUP)), true);
  assert.equal(diedInSetup(job('failure', [step('Set up job', 'failure'), step('Run tests', 'failure')])), false);
  // Defect B: the runner's job-started hook ("Set up runner", right after "Set up job") refused the job: it ran nothing.
  const hook = [step('Set up job', 'success'), step('Set up runner', 'failure'), step('Run tests', 'skipped'), step('Complete job', 'success')];
  assert.equal(diedInSetup(job('failure', hook)), true);
  assert.equal(jobFailureKind(job('failure', hook)).kind, 'setup');
  // A workflow step of that name sits later in the job: not the runner's setup.
  assert.equal(diedInSetup(job('failure', [step('Set up job', 'success'), step('Run tests', 'success'), step('Set up runner', 'failure')])), false);
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

test('unsupported conclusions and cancellations without positive evidence never count as environment', () => {
  for (const conclusion of ['cancelled', 'timed_out', 'success', 'skipped', 'neutral', null]) {
    assert.equal(jobFailureKind(job(conclusion, SETUP), 'ECONNRESET').environment, false, String(conclusion));
  }
  assert.equal(jobFailureKind(job('failure', SETUP, { status: 'in_progress' })).environment, false);
});

test('a cancelled job requires a complete step record, the timeout annotation, and a readable log with no failed test', () => {
  const cancelled = job('cancelled', [step('Set up job', 'success'), step('Run migrations', 'cancelled')]);
  const notes = [{ message: 'The job has exceeded the maximum execution time of 30m0s' }];
  const log = 'Running migrations\nThe operation was canceled.';
  assert.equal(jobFailureKind(cancelled, log, notes).kind, 'timeout');
  for (const missing of [null, [], [{ message: 'The operation was canceled.' }], [{ message: `User text: ${notes[0].message}` }]]) {
    assert.equal(jobFailureKind(cancelled, log, missing).environment, false);
  }
  for (const steps of [undefined, [], [step('Run migrations', 'failure')], [{ name: 'Run migrations' }]]) {
    assert.equal(jobFailureKind({ ...cancelled, steps }, log, notes).environment, false);
  }
  for (const rejected of [null, '', '# fail 1', 'x'.repeat(MAX_LOG_CHARS + 1)]) {
    assert.equal(jobFailureKind(cancelled, rejected, notes).environment, false);
  }
});
