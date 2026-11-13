import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePRTaskBinding, resolvePRTaskBinding, claimReferenceFromBinding } from './clued-pr-task-binding.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subject = { scope: `project:${id(1)}`, repository: 'tdoljyj/cross-memory-system', prNumber: 42,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), targetBranch: 'main' };
const binding = () => ({ status: 'ok', binding_status: 'bound', reason: null,
  repository: subject.repository, pr_number: subject.prNumber, pr_ref: `${subject.repository}#42`,
  head_sha: subject.headSha, base_sha: subject.baseSha, target_branch: 'main', scope: subject.scope,
  task_id: id(2), claim: { claim_id: id(3), task_id: id(2), context_key: subject.scope, fence: 2,
    execution_epoch: 3, lease_version: 1, expires_at: '2099-01-01T00:00:00.000Z', status: 'ACTIVE', execution_handover_pending: false },
  head_authorization_id: id(4), auto_bound: false, receipt_id: null });

test('Native identity resolves without reading a body or invoking a second head authorization', async () => {
  const calls = [];
  const result = await resolvePRTaskBinding({ ...subject, command: async input => { calls.push(input); return binding(); } });
  assert.deepEqual(calls, [{ action: 'resolve_pr_claim', scope: subject.scope, pr_ref: `${subject.repository}#42`,
    head_sha: subject.headSha, base_sha: subject.baseSha, target_branch: 'main' }]);
  assert.equal(result.admitted, undefined);
  assert.equal(claimReferenceFromBinding(result).claim_id, id(3));
});

test('missing scope and every changed exact target fail closed', () => {
  assert.throws(() => normalizePRTaskBinding(binding(), { ...subject, scope: undefined }), /scope_required/);
  for (const [field, value] of Object.entries({ repository: 'other/repo', pr_number: 43, pr_ref: 'other/repo#42',
    head_sha: 'c'.repeat(40), base_sha: 'c'.repeat(40), target_branch: 'dev', scope: 'global' })) {
    assert.throws(() => normalizePRTaskBinding({ ...binding(), [field]: value }, subject), /subject_changed/);
  }
});

test('a claim substitution or mismatched task, scope, fence or handover cannot become a reference', () => {
  for (const change of [{ task_id: id(8) }, { context_key: 'global' }, { fence: 0 }, { execution_epoch: 0 },
    { execution_handover_pending: true }, { status: 'RELEASED' }, { expires_at: 'unknown' }]) {
    const reply = binding(); Object.assign(reply.claim, change);
    assert.throws(() => normalizePRTaskBinding(reply, subject), /claim_invalid/);
  }
});

test('waiting, conflict and unauthorized head are explicit and never admitted', () => {
  for (const state of ['unbound', 'conflict', 'no_live_claim', 'handover_pending', 'head_not_authorized']) {
    const reply = binding(); reply.binding_status = state;
    if (['unbound', 'conflict'].includes(state)) reply.task_id = null;
    if (['unbound', 'conflict', 'no_live_claim'].includes(state)) reply.claim = null;
    if (state === 'handover_pending') reply.claim.execution_handover_pending = true;
    const result = normalizePRTaskBinding(reply, subject);
    assert.throws(() => claimReferenceFromBinding(result), new RegExp(`pr_binding_${state}`));
  }
});

test('a legitimate task reclaim follows the current projection, not stale explanatory text', () => {
  const old = normalizePRTaskBinding(binding(), subject);
  const next = binding(); next.claim.claim_id = id(9); next.claim.fence++; next.claim.execution_epoch++;
  const fresh = normalizePRTaskBinding(next, subject);
  assert.equal(fresh.task_id, old.task_id);
  assert.notEqual(claimReferenceFromBinding(fresh).claim_id, claimReferenceFromBinding(old).claim_id);
});

test('malformed or rejected transport answers do not fall back to a local guess', async () => {
  for (const reply of [null, [], { status: 'rejected' }, { ...binding(), auto_bound: true, binding_status: 'conflict', task_id: null, claim: null }]) {
    await assert.rejects(resolvePRTaskBinding({ ...subject, command: async () => reply }), /pr_binding_/);
  }
});

test('an explicitly read-only observation cannot silently auto-bind even under a CI transport', async () => {
  let request;
  await resolvePRTaskBinding({ ...subject, readOnly: true, command: async input => { request = input; return binding(); } });
  assert.equal(request.read_only, true);
  assert.equal(Object.hasOwn(request, 'auto_bind'), false);
  const changed = binding(); changed.auto_bound = true; changed.receipt_id = id(5);
  await assert.rejects(resolvePRTaskBinding({ ...subject, readOnly: true, command: async () => changed }), /read_only_violated/);
});

test('the exported reference converter rejects malformed bound input too', () => {
  assert.throws(() => claimReferenceFromBinding({ ...binding(), claim: {} }), /claim_invalid/);
  assert.throws(() => claimReferenceFromBinding(null), /pr_binding_unknown/);
});

test('generic CI learns scope only from Native while installed consumers keep their exact scope', async () => {
  const { scope, ...generic } = subject;
  let request;
  const result = await resolvePRTaskBinding({ ...generic, command: async input => { request = input; return binding(); } });
  assert.equal(Object.hasOwn(request, 'scope'), false);
  assert.equal(result.scope, scope);
  const elsewhere = binding(); elsewhere.scope = 'global'; elsewhere.claim.context_key = 'global';
  await assert.rejects(resolvePRTaskBinding({ ...subject, command: async () => elsewhere }), /subject_changed/);
  const unknown = { ...binding(), binding_status: 'unbound', scope: null, task_id: null, claim: null };
  const waiting = await resolvePRTaskBinding({ ...generic, command: async () => unknown });
  assert.equal(waiting.scope, null);
  assert.throws(() => claimReferenceFromBinding(waiting), /pr_binding_unbound/);
  const installedWaiting = await resolvePRTaskBinding({ ...subject, command: async () => unknown });
  assert.equal(installedWaiting.binding_status, 'unbound');
  assert.throws(() => claimReferenceFromBinding(installedWaiting), /pr_binding_unbound/);
});
