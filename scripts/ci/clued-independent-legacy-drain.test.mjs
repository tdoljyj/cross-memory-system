import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drainLegacyIndependentChecks } from './clued-independent-legacy-drain.mjs';
import { makeIndependentPublicationIdentity } from './clued-independent-publication-identity.mjs';
import { makeJobV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { canonical, digest } from '../../work/actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { OUTCOME_CONTRACT } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/layout.mjs';
import { PLAN_CONTRACT_V2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-package.mjs';
import { NATIVE_RECEIPT_CONTRACT_V2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { BROKER_REQUEST_CONTRACT, BROKER_RESPONSE_CONTRACT } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/broker-protocol.mjs';

const repo = 'tdoljyj/cross-memory-system', scope = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const bytes = value => Buffer.from(canonical(value));
function physicalExecution(claimId, headSha = A) {
  const nonce = 'a'.repeat(32), sid = 'S-1-5-21-1-2-3-1015';
  const job = makeJobV2({ repo, pr: 937, headSha, baseSha: B, role: 'gitleaks', sourceManifestSha256: 'e'.repeat(64),
    createdAt: '2026-10-29T05:00:00Z', attempt: 1 });
  const identity = makeIndependentPublicationIdentity({ job, claim: { claim_id: claimId, fence: 4, execution_epoch: 2 }, controller_id: randomUUID() });
  const plan = { contract: PLAN_CONTRACT_V2, enabled: true, stage: 3, entryRole: 'check-publisher',
    batchKey: 'b'.repeat(64), batchId: 'b'.repeat(16) + '-' + 'c'.repeat(12), ownerPackageAcceptanceRef: randomUUID(),
    nodeSha256: '1'.repeat(64), nodeProfileSha256: '2'.repeat(64), entrySha256: '3'.repeat(64), acceptanceSha256: '4'.repeat(64),
    sourceManifestSha256: job.sourceManifestSha256, installationSha256: '5'.repeat(64), runtimeConfigPinSha256: '6'.repeat(64), jobSha256: digest([job]) };
  const witness = { contract: 'clued.independent-ci.controller-supervision/1', identity, nonce, plan,
    configSha256: digest(plan), controllerSid: sid };
  const requestId = randomUUID(), outcome = { contract: OUTCOME_CONTRACT, nonce, stage: 3, entryRole: plan.entryRole,
    status: 'BLOCKED', reason: 'authorization_changed', sideEffects: 0, mayHavePublished: false, jobIds: [job.id] };
  const bundle = { requestId, planBytes: bytes(plan), jobsBytes: bytes([job]),
    requestBytes: bytes({ contract: BROKER_REQUEST_CONTRACT, stage: 3, nonce, configSha256: witness.configSha256, deadline: '2026-10-29T05:15:00Z' }),
    responseBytes: bytes({ contract: BROKER_RESPONSE_CONTRACT, requestId, ok: true, code: null, started: true, startCallIssued: true, helperPid: 31337,
      stoppedInTime: true, restored: true, accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false }),
    outcomeBytes: bytes(outcome), receiptBytes: bytes({ contract: NATIVE_RECEIPT_CONTRACT_V2, nonce, state: 'FIXED_CHILD_REFUSED', failure_code: 'FIXED_NODE_EXIT_NONZERO',
      actual_sid: sid, service_pid: 31337, session_id: 0, node_pid: 31338, node_exit_code: 2, timed_out: false, stop_requested: true,
      tree_cleanup_confirmed: true, tree_cleanup_failure_code: null, tree_active_processes: 0, root_exit_confirmed: true,
      entry_role: plan.entryRole, stage: 3, entry_sha256: plan.entrySha256, config_sha256: witness.configSha256,
      acceptance_sha256: plan.acceptanceSha256, source_manifest_sha256: plan.sourceManifestSha256, outcome_sha256: digest(outcome),
      stdout_captured: false, private_bytes_read_by_helper: false, host_qualification: false, ci_principal_qualification: false }) };
  return { identity, witness, bundle };
}

function fixture() {
  const revocation = { outbox_id: randomUUID(), claim_id: randomUUID(), execution_epoch: 3, repository: repo, head_sha: A, pr_ref: `${repo}#937` };
  const executions = [A, B, C, D].map(head => physicalExecution(revocation.claim_id, head)), execution = executions[0];
  const marker = `Native publication independent-ci:native:v1:${execution.identity.job.id}:p${randomUUID()}; begin Receipt ${randomUUID()}.`;
  const checks = [A, B, C, D].map((head, index) => ({ id: 100 + index, app: { id: 5368905 }, name: 'gitleaks', head_sha: head,
    status: 'completed', conclusion: 'success', external_id: `independent-ci:legacy:${index}`, output: { title: 'green', summary: index === 0 ? `proof\n\n${marker}` : 'proof' } }));
  checks.push({ ...structuredClone(checks[0]), id: 201, app: { id: 5164952 } }, { ...structuredClone(checks[0]), id: 202, name: 'unrelated-check' });
  const state = { autoMerge: null, head: C, commits: 2, historyComplete: true, admittedComplete: true, admittedHead: B, controllerComplete: true,
    current: true, runningChild: false, forgedStopped: false, suppressPatch: false, changeAfterWrite: false, appendAfterWrite: false, authorityCalls: 0 };
  const patchIds = [], inventories = [];
  const github = {
    async readPullRequest(number) { return { number, head: { sha: state.changeAfterWrite && patchIds.length ? D : state.head },
      base: { repo: { full_name: repo } }, commits: state.commits, auto_merge: state.autoMerge }; },
    async readPullRequestCommits() { return { complete: state.historyComplete, commits: [{ sha: D }, { sha: C }] }; },
    async readChecks(head) { inventories.push(head); return { complete: true, checks: structuredClone(checks.filter(c => c.head_sha === head)) }; },
    async revokeCheck(id, body) {
      patchIds.push(id); const check = checks.find(c => c.id === id), response = { ...structuredClone(check), ...structuredClone(body) };
      if (!state.suppressPatch) Object.assign(check, structuredClone(body));
      if (state.appendAfterWrite && patchIds.length === 1) checks.push({ ...structuredClone(check), id: 999, status: 'completed', conclusion: 'success' });
      return response;
    },
  };
  const nativeHeads = { async read(item) { assert.deepEqual(item, revocation); return { complete: state.admittedComplete,
    repository: repo, claimId: revocation.claim_id, executionEpoch: 3, heads: [state.admittedHead] }; } };
  const supervisor = { async withLegacyDrainWindow(subject, callback) {
    assert.deepEqual(subject.heads, [A, B, C, D]);
    if (state.forgedStopped) return callback({ stopped: true, state: 'IDLE' });
    const actual = structuredClone(executions);
    if (state.runningChild) { const receipt = JSON.parse(Buffer.from(actual[0].bundle.receiptBytes)); receipt.tree_active_processes = 1; actual[0].bundle.receiptBytes = bytes(receipt); }
    await callback({ async assertCurrent() { state.authorityCalls++; return state.current; },
      async readControllerStopBundles() { return { complete: state.controllerComplete, executions: actual }; } });
  } };
  return { state, checks, marker, patchIds, inventories, github, nativeHeads, supervisor, revocation, execution,
    run: () => drainLegacyIndependentChecks({ scope, revocation, github, nativeHeads, supervisor }) };
}

test('legacy drain includes outbox, admitted, live PR and complete historical heads; preserves Native marker and isolates App536 names', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, 'DRAINED', JSON.stringify(result)); assert.equal(result.acknowledgmentAllowed, false);
  assert.deepEqual(result.heads, [A, B, C, D]); assert.deepEqual(result.revokedCheckIds, [100, 101, 102, 103]);
  assert.equal(result.stopProofRefs.length, 4); assert.match(result.stopProofRefs[0], /^sha256:[a-f0-9]{64}$/);
  assert.match(f.checks[0].output.summary, /Native publication independent-ci:native:v1:/); assert.ok(f.checks[0].output.summary.includes(f.marker));
  assert.equal(f.checks.find(c => c.id === 201).conclusion, 'success'); assert.equal(f.checks.find(c => c.id === 202).conclusion, 'success');
  assert.ok(f.state.authorityCalls >= 7); assert.deepEqual([...new Set(f.inventories)].sort(), [A, B, C, D]);
});

test('truncated PR history or incomplete durable heads refuse before any PATCH', async () => {
  for (const key of ['historyComplete', 'admittedComplete']) {
    const f = fixture(); f.state[key] = false; const result = await f.run();
    assert.equal(result.status, 'PENDING'); assert.equal(f.patchIds.length, 0); assert.equal(result.acknowledgmentAllowed, false);
  }
});

test('a copied stopped flag, IDLE string, cancellation request or running descendant is not a physical stop observation', async () => {
  for (const key of ['forgedStopped', 'runningChild']) {
    const f = fixture(); f.state[key] = true; const result = await f.run();
    assert.equal(result.status, 'PENDING'); assert.equal(f.patchIds.length, 0);
  }
});

test('incomplete controller inventory or lost no-new-starts window refuses all writes', async () => {
  for (const key of ['controllerComplete', 'current']) {
    const f = fixture(); f.state[key] = false; const result = await f.run();
    assert.equal(result.status, 'PENDING'); assert.equal(f.patchIds.length, 0);
  }
});

test('automatic merge must already be disabled by its own qualified controller', async () => {
  const f = fixture(); f.state.autoMerge = { enabled: true }; const result = await f.run();
  assert.equal(result.status, 'PENDING'); assert.equal(result.pending[0].reason, 'independent_legacy_auto_merge_enabled'); assert.equal(f.patchIds.length, 0);
});

test('an unconfirmed PATCH never becomes a completed drain, while the known write remains recorded', async () => {
  const f = fixture(); f.state.suppressPatch = true; const result = await f.run();
  assert.equal(result.status, 'PENDING'); assert.equal(result.pending[0].reason, 'independent_legacy_revocation_unconfirmed');
  assert.deepEqual(result.revokedCheckIds, [100]); assert.equal(result.acknowledgmentAllowed, false);
});

test('a check that appears after the snapshot blocks completion instead of being silently ignored', async () => {
  const f = fixture(); f.state.appendAfterWrite = true; const result = await f.run();
  assert.equal(result.status, 'PENDING'); assert.equal(result.pending[0].reason, 'independent_legacy_checks_changed');
});

test('a changed live PR after all PATCHes leaves the drain pending without erasing the completed writes', async () => {
  const f = fixture(); f.state.changeAfterWrite = true; const result = await f.run();
  assert.equal(result.status, 'PENDING'); assert.equal(result.pending[0].reason, 'independent_legacy_pr_subject_changed');
  assert.deepEqual(result.revokedCheckIds, [100, 101, 102, 103]);
});

test('a check from another App or name cannot be patched by this drain, and a lost barrier after first PATCH remains pending', async () => {
  const f = fixture(), original = f.github.revokeCheck;
  f.github.revokeCheck = async (...args) => { const result = await original(...args); f.state.current = false; return result; };
  const result = await f.run(); assert.equal(result.status, 'PENDING'); assert.deepEqual(f.patchIds, [100]);
});

test('Native head inventory must identify this exact repository, claim and cutoff epoch', async () => {
  for (const field of ['repository', 'claimId', 'executionEpoch']) {
    const f = fixture(), original = f.nativeHeads.read;
    f.nativeHeads.read = async item => ({ ...await original(item), [field]: field === 'executionEpoch' ? 2 : 'other' });
    const result = await f.run(); assert.equal(result.status, 'PENDING'); assert.equal(f.patchIds.length, 0);
  }
});

test('a complete but empty controller list cannot replace the physical stop proof of a published check', async () => {
  const f = fixture(); f.supervisor.withLegacyDrainWindow = async (subject, callback) => callback({
    async assertCurrent() { return true; }, async readControllerStopBundles() { return { complete: true, executions: [] }; } });
  const result = await f.run(); assert.equal(result.status, 'PENDING');
  assert.equal(result.pending[0].reason, 'independent_legacy_stop_proof_missing'); assert.equal(f.patchIds.length, 0);
});
