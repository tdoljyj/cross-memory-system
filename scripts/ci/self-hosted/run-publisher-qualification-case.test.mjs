import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gateFindings } from '../clued-work-admission.mjs';
import {
  CASE_SCHEMA, PURPOSE, CLASSIFICATION, PUBLIC_CANARY_ID, EXPECTED_VM_ID,
  parseArguments, validateCase, readBoundedJson, validatePullRequestContext,
  buildHostInvocation, validateHostResult, validateGuestLaunch, guestCaseOutcome,
} from './run-publisher-qualification-case.mjs';

// These are finite observations and fixtures. Importing the runner never calls
// its CLI, a Host probe, WSL, Task Scheduler, Hyper-V, or the real Guest path.
const selected = JSON.parse(fs.readFileSync(new URL('./publisher-qualification-case.json', import.meta.url), 'utf8'));
const copy = value => structuredClone(value);
test('both actual new workflow bytes satisfy the unchanged canonical G4 gate parser', () => {
  for (const kind of ['host', 'guest']) {
    const text = fs.readFileSync(new URL(`../../../.github/workflows/clued-production-publisher-${kind}-qualification.yml`, import.meta.url), 'utf8');
    assert.deepEqual(gateFindings(text, null), [], kind);
  }
});
function fixture(kind = 'host') {
  const repository = { id: 123456, full_name: 'tdoljyj/cross-memory-system', owner: { login: 'tdoljyj' }, fork: false };
  const event = { action: 'synchronize', number: 42, repository: copy(repository), sender: { login: 'tdoljyj' },
    pull_request: { number: 42, user: { login: 'tdoljyj' }, merge_commit_sha: 'a'.repeat(40),
      head: { repo: copy(repository), ref: 'qualification-fixture', sha: 'b'.repeat(40) },
      base: { repo: copy(repository), ref: 'main', sha: 'c'.repeat(40) } } };
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: repository.full_name,
    GITHUB_REPOSITORY_OWNER: 'tdoljyj', GITHUB_ACTOR: 'tdoljyj', GITHUB_TRIGGERING_ACTOR: 'tdoljyj',
    GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'qualification-fixture', GITHUB_REF: 'refs/pull/42/merge',
    GITHUB_WORKFLOW_REF: `${repository.full_name}/.github/workflows/clued-production-publisher-${kind}-qualification.yml@refs/pull/42/merge`,
    GITHUB_JOB: kind === 'host' ? 'host-principal-probe' : 'qualify', RUNNER_ARCH: 'X64',
    RUNNER_OS: kind === 'host' ? 'Windows' : 'Linux', RUNNER_NAME: kind === 'host' ? 'clued-ci-company-win-01' : 'clued-publisher-fixture' };
  return { env, event };
}

test('committed case has one strict, public, credential-free schema and separate qualification UUID', () => {
  assert.equal(validateCase(selected), selected);
  assert.equal(selected.schema, CASE_SCHEMA);
  assert.equal(selected.purpose, PURPOSE);
  assert.equal(selected.classification, CLASSIFICATION);
  assert.equal(selected.host.isolation_canary_id, PUBLIC_CANARY_ID);
  assert.equal(selected.host.expected_qualification_vm, EXPECTED_VM_ID);
  assert.notEqual(selected.qualification_id, PUBLIC_CANARY_ID);
  assert.notEqual(selected.qualification_id, EXPECTED_VM_ID);
  for (const mode of ['Inventory', 'S4UCanary']) {
    for (const guestCase of ['success', 'failure', 'cancel']) {
      const value = copy(selected); value.host.mode = mode; value.guest.case = guestCase;
      assert.equal(validateCase(value), value);
    }
  }
});

test('case rejects unknown executable/path knobs, changed public targets, malformed UUIDs and ambiguous scope', () => {
  const mutations = [
    value => { value.command = 'arbitrary-command'; },
    value => { value.host.script = 'C:/another.ps1'; },
    value => { value.guest.output_path = '/arbitrary'; },
    value => { value.host.mode = 'Inventory -InternalPhase Callback'; },
    value => { value.guest.case = 'success; anything'; },
    value => { value.qualification_id = '../escape'; },
    value => { value.qualification_id = '00000000-0000-0000-0000-000000000000'; },
    value => { value.qualification_id = EXPECTED_VM_ID; },
    value => { value.qualification_id = PUBLIC_CANARY_ID; },
    value => { value.host.isolation_canary_id = '510acfb6-1698-4227-893b-0cc3fbd84099'; },
    value => { value.host.expected_qualification_vm = PUBLIC_CANARY_ID; },
    value => { value.schema = 'other/1'; },
    value => { value.purpose = 'release.production'; },
    value => { value.classification = 'required_success'; },
    value => { value.host = []; },
    value => { delete value.guest; },
  ];
  for (const mutate of mutations) { const value = copy(selected); mutate(value); assert.throws(() => validateCase(value)); }
  assert.throws(() => validateCase(null));
  assert.throws(() => validateCase([]));
});

test('CLI accepts only a fixed kind and Host builds a fixed shell-free system PowerShell argument vector', () => {
  assert.equal(parseArguments(['--kind', 'host']), 'host');
  assert.equal(parseArguments(['--kind', 'guest']), 'guest');
  for (const args of [[], ['--kind'], ['--kind', 'other'], ['--kind', 'host', '--path', 'x'], ['--command', 'x'], ['--kind=host']]) {
    assert.throws(() => parseArguments(args), /FIXED_KIND_ARGUMENT_REQUIRED/u);
  }
  const call = buildHostInvocation(selected);
  assert.equal(call.executable, 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.deepEqual(call.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./qualify-publisher-host-principal.ps1', import.meta.url)), '-Mode', selected.host.mode,
    '-QualificationId', selected.qualification_id, '-IsolationCanaryId', PUBLIC_CANARY_ID, '-ExpectedQualificationVm', EXPECTED_VM_ID]);
});

test('actual Owner PR context keeps execution merge, candidate head, base and run attempt separate', () => {
  for (const kind of ['host', 'guest']) {
    const { env, event } = fixture(kind);
    const context = validatePullRequestContext(env, event, kind);
    assert.equal(context.sha, 'a'.repeat(40));
    assert.equal(context.pull_request_head_sha, 'b'.repeat(40));
    assert.equal(context.pull_request_base_sha, 'c'.repeat(40));
    assert.equal(context.run_attempt, '1');
    assert.equal(context.ref, 'refs/pull/42/merge');
  }
});

test('wrong event, actor, fork, PR number, ref, attempt, merge or checkout-source claims are refused', () => {
  const { env, event } = fixture();
  for (const key of Object.keys(env)) {
    assert.throws(() => validatePullRequestContext({ ...env, [key]: 'wrong' }, event, 'host'), undefined, key);
  }
  const mutations = [
    value => { value.action = 'closed'; }, value => { value.number = 43; },
    value => { value.pull_request.number = '42'; }, value => { value.pull_request.user.login = 'fork-author'; },
    value => { value.sender.login = 'other'; }, value => { value.repository.fork = true; },
    value => { value.pull_request.head.repo.fork = true; }, value => { value.pull_request.head.repo.fork = 'false'; },
    value => { value.pull_request.head.repo.full_name = 'other/repo'; },
    value => { value.pull_request.base.repo.id = 123457; }, value => { value.pull_request.base.ref = 'other'; },
    value => { value.pull_request.head.ref = 'other'; }, value => { value.pull_request.head.sha = 'bad'; },
    value => { value.pull_request.merge_commit_sha = 'b'.repeat(40); }, value => { delete value.pull_request; },
  ];
  for (const mutate of mutations) { const value = copy(event); mutate(value); assert.throws(() => validatePullRequestContext(env, value, 'host')); }
  assert.throws(() => validatePullRequestContext({ ...env, GITHUB_RUN_ATTEMPT: '0' }, event, 'host'));
  assert.throws(() => validatePullRequestContext({ ...env, GITHUB_SHA: event.pull_request.head.sha }, event, 'host'), /MERGE_BINDING/u);
});

test('bounded JSON reader refuses oversized, malformed, directory and a file grown during its read', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-publisher-case-fixture-'));
  const file = path.join(directory, 'fixture.json');
  const originalRead = fs.readSync;
  try {
    fs.writeFileSync(file, '{"a":1}');
    const result = readBoundedJson(file, 16);
    assert.deepEqual(result.value, { a: 1 });
    assert.equal(result.bytes.length, 7);
    assert.throws(() => readBoundedJson(directory, 16));
    fs.writeFileSync(file, 'x'.repeat(17)); assert.throws(() => readBoundedJson(file, 16), /BOUNDED_REGULAR/u);
    fs.writeFileSync(file, 'bad'); assert.throws(() => readBoundedJson(file, 16));
    fs.writeFileSync(file, '{"a":1}');
    let changed = false;
    fs.readSync = (...args) => {
      if (!changed) { changed = true; fs.appendFileSync(file, ' '.repeat(100)); }
      return originalRead(...args);
    };
    assert.throws(() => readBoundedJson(file, 16), /JSON_SIZE_OR_IDENTITY_CHANGED/u);
    assert.equal(changed, true);
  } finally {
    fs.readSync = originalRead;
    fs.unlinkSync(file); fs.rmdirSync(directory);
  }
});

test('Guest launch must be root-owned and exact for run, attempt, PR source, case and explicit nonproduction scope', () => {
  const { env, event } = fixture('guest');
  const context = validatePullRequestContext(env, event, 'guest');
  const boundKeys = ['repository', 'run_id', 'run_attempt', 'job_name', 'sha', 'ref', 'workflow_ref', 'runner_name',
    'pull_request_number', 'pull_request_head_sha', 'pull_request_base_sha'];
  const launch = { schema: 'clued.production-vm-launch/1', purpose: 'qualification',
    qualification_id: selected.qualification_id, qualification_case: selected.guest.case, production_qualified: false,
    ...Object.fromEntries(boundKeys.map(key => [key, context[key]])) };
  const metadata = { regular: true, symlink: false, uid: 0, gid: 1001, mode: 0o640 };
  assert.equal(validateGuestLaunch(launch, metadata, selected, context, 1001), launch);
  for (const key of boundKeys) {
    const value = { ...launch, [key]: 'wrong' };
    assert.throws(() => validateGuestLaunch(value, metadata, selected, context, 1001), /BINDING_MISMATCH/u, key);
  }
  for (const [key, value] of Object.entries({ schema: 'other', purpose: 'production', qualification_id: EXPECTED_VM_ID,
    qualification_case: 'failure', production_qualified: 'false' })) {
    assert.throws(() => validateGuestLaunch({ ...launch, [key]: value }, metadata, selected, context, 1001), /SCOPE_MISMATCH/u, key);
  }
  for (const [key, value] of Object.entries({ regular: false, symlink: true, uid: 1001, gid: 0, mode: 0o660 })) {
    assert.throws(() => validateGuestLaunch(launch, { ...metadata, [key]: value }, selected, context, 1001), /METADATA_REQUIRED/u, key);
  }
  assert.throws(() => validateGuestLaunch({ ...launch, run_attempt: '2' }, metadata, selected, context, 1001));
  assert.throws(() => validateGuestLaunch({ ...launch, sha: context.pull_request_head_sha }, metadata, selected, context, 1001));
});

test('Host zero-exit aggregation still requires actual SID/session, real PR binding and an explicit observed result', () => {
  const { env, event } = fixture();
  const context = validatePullRequestContext(env, event, 'host');
  const github = Object.fromEntries(Object.entries(context).map(([key, value]) => [key === 'job_name' ? 'job_key' : key, value]));
  const report = { schema: 'clued.publisher-host-principal.inventory/1', result: 'INVENTORY_OBSERVED',
    qualification_id: selected.qualification_id, production_qualified: false, github,
    identity: { host: 'DESK-W-591', sid: 'S-1-5-21-858977881-4031698862-3006450925-1005',
      session_id: 0, administrator_token_member: false, hyper_v_token_member: false } };
  assert.equal(validateHostResult(report, selected, context), report);
  for (const change of [value => { value.result = 'UNKNOWN'; }, value => { value.production_qualified = 'false'; },
    value => { value.qualification_id = EXPECTED_VM_ID; }, value => { value.identity.sid = 'S-1-5-18'; },
    value => { value.identity.session_id = 1; }, value => { value.identity.hyper_v_token_member = true; },
    value => { value.github.pull_request_head_sha = context.sha; }, value => { value.github.run_attempt = '2'; }]) {
    const value = copy(report); change(value); assert.throws(() => validateHostResult(value, selected, context));
  }
  assert.throws(() => validateHostResult(null, selected, context));
});

test('synthetic failure remains nonzero and cancellation timeout can never be mistaken for a successful cancellation proof', () => {
  assert.deepEqual(guestCaseOutcome('success'), { exit_code: 0, wait_milliseconds: 0, expected: 'success' });
  assert.deepEqual(guestCaseOutcome('failure'), { exit_code: 23, wait_milliseconds: 0, expected: 'failure' });
  assert.equal(guestCaseOutcome('cancel').wait_milliseconds, 600_000);
  assert.equal(guestCaseOutcome('cancel').exit_code, 24);
  assert.match(guestCaseOutcome('cancel').expected, /failed cancellation test/u);
  assert.throws(() => guestCaseOutcome('other'));
});
