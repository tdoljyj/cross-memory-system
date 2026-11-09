import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ACTIVATION_CONTRACT, ACTIVATION_FILE, automaticExecutorGate, isDurableFetch, markDurableFetch,
  readReconcileActivation } from './clued-merge-reconcile-gate.mjs';
import { runExecutor } from './clued-merge-executor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'tdoljyj/cross-memory-system';
const CLAIM = '11111111-2222-4333-8444-555555555555';
const TASK = '66666666-2222-4333-8444-555555555555';
const AUTH = '77777777-2222-4333-8444-555555555555';
const scope = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const activation = enabled => Buffer.from(JSON.stringify({ contract: ACTIVATION_CONTRACT, enabled }));

// Intercept only the fixed local activation read; tests never modify that
// accepted source file or touch live GitHub/Clued/Host state.
function withActivation(t, value) {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file instanceof URL && file.href === ACTIVATION_FILE.href) {
      if (value instanceof Error) throw value;
      return value;
    }
    return original.call(this, file, ...args);
  });
}
const env = () => ({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'fixture', CLUED_CONTEXT_READ_TOKEN: 'fixture',
  CLUED_SUPABASE_URL: 'https://example.supabase.co', CLUED_SUPABASE_PUBLISHABLE_KEY: 'fixture', CLUED_MERGE_ADMISSION_STATE: 'normal' });

test('candidate activation is source-bound off, retaining the legacy entry behavior', () => {
  assert.deepEqual(readReconcileActivation(), { contract: ACTIVATION_CONTRACT, enabled: false });
  assert.equal(automaticExecutorGate(async () => {}), null);
});

test('WeakSet marks only the exact durable function object and confers no callable authority', () => {
  const first = async () => {}, second = async () => {};
  assert.equal(isDurableFetch(first), false); assert.equal(markDurableFetch(first), first);
  assert.equal(isDurableFetch(first), true); assert.equal(isDurableFetch(second), false);
  assert.equal(isDurableFetch({}), false); assert.equal(isDurableFetch(null), false);
  for (const value of [null, {}, true, 'fetch']) assert.throws(() => markDurableFetch(value), /DURABLE_FETCH_REQUIRED/);
});

test('on: every ordinary automatic executor delegates before reads, cleanup, qualifier or recorder', async t => {
  withActivation(t, activation(true));
  let fetches = 0, qualifiers = 0, observations = 0;
  const fetchImpl = async () => { fetches++; throw Error('must not read'); };
  const result = await runExecutor({ env: env(), fetchImpl, workspace: ROOT,
    qualifyExecution: async () => { qualifiers++; throw Error('must not qualify'); },
    observation_recorder: { record() { observations++; }, finish() { observations++; } } });
  assert.equal(result.state, 'DELEGATED');
  assert.deepEqual(result.heads, []); assert.deepEqual(result.actions, []); assert.deepEqual(result.errors, []);
  assert.deepEqual([fetches, qualifiers, observations], [0, 0, 0]);
});

test('on: frozen/env/body/caller labels cannot make an ordinary fetch enter the core', async t => {
  withActivation(t, activation(true)); let calls = 0;
  for (const extra of [{ GITHUB_EVENT_NAME: 'workflow_run' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', RECONCILE_ENABLED: 'true', CLUED_MERGE_ADMISSION_STATE: 'frozen' }]) {
    const fetchImpl = async () => { calls++; throw Error('must not read'); };
    fetchImpl.durable = true; // mutable labels are not the wrapper's identity
    assert.equal((await runExecutor({ env: { ...env(), ...extra }, workspace: ROOT, fetchImpl })).state, 'DELEGATED');
  }
  assert.equal(calls, 0);
});

test('on: the marked wrapper enters the original live Native role gate, which can still refuse it', async t => {
  withActivation(t, activation(true)); const calls = [];
  const fetchImpl = markDurableFetch(async (url, options = {}) => {
    const input = options.body ? JSON.parse(options.body).p_input : null;
    calls.push({ url: String(url), method: options.method ?? 'GET', input });
    if (String(url).startsWith(`https://api.github.com/repos/${REPO}/pulls?`)) return new Response(JSON.stringify([{ number: 5,
      node_id: 'fixture', state: 'open', draft: false, auto_merge: null,
      body: 'Clued-Work-Claim: forged\nClued-Work-Scope: global', head: { sha: 'a'.repeat(40), repo: { full_name: REPO } },
      base: { sha: 'b'.repeat(40), ref: 'main', repo: { default_branch: 'main', full_name: REPO } } }]), { status: 200 });
    if (String(url).includes('/rest/v1/rpc/clued_work_verify_v1') && input?.action === 'resolve_pr_claim') {
      assert.equal(input.read_only, true);
      return new Response(JSON.stringify({ status: 'ok', binding_status: 'bound', reason: null,
        repository: REPO, pr_number: 5, pr_ref: `${REPO}#5`, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
        target_branch: 'main', scope, task_id: TASK, auto_bound: false, receipt_id: null, head_authorization_id: AUTH,
        claim: { claim_id: CLAIM, task_id: TASK, context_key: scope, fence: 1, execution_epoch: 1, lease_version: 1,
          expires_at: '2099-01-01T00:00:00Z', status: 'ACTIVE', execution_handover_pending: false } }), { status: 200 });
    }
    if (String(url).includes('/rest/v1/rpc/clued_work_merge_slot_holders_v1')) return new Response(JSON.stringify({ status: 'ok',
      holders: [], reason: 'admission_binding_required' }), { status: 200 });
    throw Error('unexpected route');
  });
  const result = await runExecutor({ env: env(), workspace: ROOT, fetchImpl,
    observation_recorder: { record() {}, finish() {} } });
  assert.notEqual(result.state, 'DELEGATED'); assert.ok(result.errors.some(v => v.includes('admission_binding_required')));
  assert.equal(calls.filter(v => v.url.startsWith('https://api.github.com')).length, 1);
  assert.equal(calls.filter(v => v.url.includes('/rest/v1/rpc/')).length, 2);
  assert.deepEqual(calls.find(v => v.url.includes('/clued_work_merge_slot_holders_v1')).input, { scope, repository: REPO },
    'Native supplies the real project scope despite forged global PR prose');
  assert.deepEqual(result.actions, [], 'the actual Native role refusal still prevents every mutation');
  assert.ok(calls.every(v => v.method === 'GET' || v.url.includes('/rest/v1/rpc/')));
});

test('off: unmarked fetch still enters the existing automatic core', async t => {
  withActivation(t, activation(false)); let reads = 0;
  const result = await runExecutor({ env: env(), workspace: ROOT, fetchImpl: async () => { reads++; return new Response('[]', { status: 200 }); },
    observation_recorder: { record() {}, finish() {} } });
  assert.notEqual(result.state, 'DELEGATED'); assert.equal(reads, 1); assert.deepEqual(result.actions, []);
});

test('missing/corrupt/unknown activation fails closed, including for a marked wrapper', async t => {
  const values = [Object.assign(Error('missing'), { code: 'ENOENT' }), Buffer.from('{'),
    Buffer.from(JSON.stringify({ contract: 'future', enabled: true })),
    Buffer.from(JSON.stringify({ contract: ACTIVATION_CONTRACT, enabled: 'true' })),
    Buffer.from(JSON.stringify({ contract: ACTIVATION_CONTRACT, enabled: true, fallback: true })), Buffer.alloc(1025)];
  for (const [i, value] of values.entries()) await t.test(String(i), async child => {
    withActivation(child, value); let calls = 0;
    const fetchImpl = markDurableFetch(async () => { calls++; throw Error('no network'); });
    await assert.rejects(() => runExecutor({ env: env(), workspace: ROOT, fetchImpl }), /MERGE_RECONCILE_ACTIVATION_INVALID/);
    assert.equal(calls, 0);
  });
});
