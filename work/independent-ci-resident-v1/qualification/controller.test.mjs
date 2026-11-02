import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfflineJournal, createOfflineController, offlineFixturePorts, subjectHash } from './controller.mjs';

const subject = (overrides = {}) => ({ repository: 'fixture/repository', pr: 1, headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40), sourceManifestSha256: 'c'.repeat(64), claimId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  fence: 9, executionEpoch: 1, runId: 'fixture-run', ...overrides });

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-controller-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); // only this new owned disposable fixture
  const journal = new OfflineJournal(root), calls = [], original = subject();
  const bound = (s, extra) => ({ subjectHash: subjectHash(s), ...extra });
  const admission = s => bound(s, { principal: 'installed-qualified-resident', sourceAccepted: true,
    authorityReadResolved: true, batchIdle: true, upgradeIdle: true, ordinaryResume: false, freshHead: true, previouslyExecuted: false });
  const cleanup = s => bound(s, { windowsTreeZero: true, linuxTreeZero: true, originalRunnerStopped: true,
    sessionEnded: true, hostedRunsTerminal: true, unknownDispatchReconciled: true });
  const defaults = {
    observeAdmission: async s => admission(s),
    observeFreeQuota: async s => bound(s, { knownFree: true, remainingMinutes: 100, estimatedMinutes: 5, paidAllowed: false }),
    runStage1: async s => {
      const dir = journal.headDirectory(s);
      assert.ok(await fs.stat(path.join(dir, '10-stage1-intent.json')));
      return bound(s, { manifestSha256: 'd'.repeat(64), oldMergeSha: 'e'.repeat(40), terminal: true });
    },
    dispatchHosted: async (s, role) => {
      const number = role === 'gitleaks' ? 20 : 30;
      assert.ok(await fs.stat(path.join(journal.headDirectory(s), `${number}-dispatch-${role}-intent.json`)));
      return bound(s, { role, runId: number, dispatchConfirmed: true });
    },
    verifyProtectedArtifacts: async (s, role, dispatch) => bound(s, { role, runId: dispatch.runId,
      oidcVerified: true, annotationsComplete: true, annotationSha256: 'f'.repeat(64), checkRunIdPresent: true, registryBindsCheckRunId: true }),
    moveRefAndReadOldMerge: async s => bound(s, { ref: `refs/pull/${s.pr}/merge`, beforeRefSha: 'e'.repeat(40), afterRefSha: '2'.repeat(40),
      oldMergeSha: 'e'.repeat(40), oldMergeReadable: true, movementObserved: true }),
    freshJwks: async s => bound(s, { actualPrincipal: 'clued-control', freshNetwork: true, cacheHit: false, jwksSha256: '3'.repeat(64) }),
    terminalAndCleanup: async s => cleanup(s),
    independentAttestation: async (s, evidenceHash) => bound(s, { evidenceHash, independent: true, attestationSha256: '4'.repeat(64) }),
  };
  const ports = {};
  for (const [name, fn] of Object.entries({ ...defaults, ...overrides })) {
    ports[name] = async (...args) => { calls.push([name, args[1]]); return fn(...args); };
  }
  const controller = createOfflineController({ journal, ports: offlineFixturePorts(ports) });
  return { root, journal, controller, calls, original, bound, admission, cleanup };
}

test('complete offline session writes each intent first and never becomes live-qualified', async t => {
  const f = await fixture(t);
  const result = await f.controller.run(f.original);
  assert.equal(result.status, 'OFFLINE_COMPLETE_NO_QUALIFICATION');
  assert.equal(result.liveQualified, false);
  assert.equal(f.calls.filter(([name]) => name === 'runStage1').length, 1);
  assert.deepEqual(f.calls.filter(([name]) => name === 'dispatchHosted').map(([, role]) => role), ['gitleaks', 'trivy']);
  assert.equal(f.calls.filter(([name]) => name === 'terminalAndCleanup').length, 1);
});

test('plain JSON capabilities and malformed exact bindings cannot create a session', async t => {
  const f = await fixture(t);
  assert.throws(() => createOfflineController({ journal: f.journal, ports: { liveQualified: true } }), /OFFLINE_CAPABILITY_REQUIRED/);
  const result = await f.controller.run({ ...f.original, rawJwt: 'never-copy-fixture-secret' });
  assert.equal(result.status, 'REFUSED_BEFORE_EFFECTS');
  assert.equal(f.calls.length, 0);
});

test('busy batch, upgrade, ordinary Resume, used head, Source and missing authority stop before effects', async t => {
  for (const fields of [{ batchIdle: false }, { upgradeIdle: false }, { ordinaryResume: true },
    { previouslyExecuted: true }, { sourceAccepted: false }, { authorityReadResolved: false },
    { subjectHash: '0'.repeat(64) }, { principal: 'agent' }]) {
    let f;
    f = await fixture(t, { observeAdmission: async s => ({ ...f.admission(s), ...fields }) });
    const result = await f.controller.run(f.original);
    assert.equal(result.status, 'REFUSED_BEFORE_EFFECTS');
    assert.equal(f.calls.some(([name]) => name === 'runStage1' || name === 'dispatchHosted'), false);
  }
});

test('head reservation survives clean completion across PR/base/claim/Source changes', async t => {
  const f = await fixture(t);
  assert.equal((await f.controller.run(f.original)).liveQualified, false);
  f.calls.length = 0;
  const changed = subject({ pr: 3, baseSha: 'f'.repeat(40), sourceManifestSha256: '5'.repeat(64),
    claimId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', runId: 'another-run' });
  assert.equal((await f.controller.run(changed)).code, 'HEAD_RESERVED_OR_BURNED');
  assert.equal(f.calls.some(([name]) => name === 'runStage1'), false);
});

test('unknown free quota or paid routing refuses all dispatch', async t => {
  const f = await fixture(t, { observeFreeQuota: async s => ({ subjectHash: subjectHash(s), knownFree: false,
    remainingMinutes: 10000, estimatedMinutes: 1, paidAllowed: false }) });
  assert.equal((await f.controller.run(f.original)).code, 'FREE_QUOTA_UNKNOWN_OR_INSUFFICIENT');
  assert.equal(f.calls.some(([name]) => name === 'dispatchHosted'), false);
});

test('uncertain dispatch is not retried or locally replaced; restart only observes original journal', async t => {
  const f = await fixture(t, { dispatchHosted: async () => { throw new Error('raw-private-fixture-error'); },
    terminalAndCleanup: async s => ({ subjectHash: subjectHash(s), windowsTreeZero: true, linuxTreeZero: true,
      originalRunnerStopped: true, sessionEnded: true, hostedRunsTerminal: false, unknownDispatchReconciled: false }) });
  const result = await f.controller.run(f.original);
  assert.equal(result.status, 'HOLD_UNCERTAIN');
  assert.equal(f.calls.filter(([name]) => name === 'dispatchHosted').length, 1);
  f.calls.length = 0;
  const recovery = await f.controller.recover(f.original);
  assert.equal(recovery.status, 'HOLD_RECONCILE_ORIGINAL_JOURNAL');
  assert.equal(f.calls.length, 0);
  const rejected = await f.controller.run(f.original);
  assert.equal(rejected.code, 'EXCLUSIVE_SESSION_BUSY_OR_UNCERTAIN');
  const records = await fs.readdir(f.journal.headDirectory(f.original));
  for (const file of records) assert.ok(!(await fs.readFile(path.join(f.journal.headDirectory(f.original), file), 'utf8')).includes('raw-private-fixture-error'));
});

test('partial OIDC/annotations, unexpected secret output and check-run presence without binding cannot pass', async t => {
  for (const patch of [{ oidcVerified: false }, { annotationsComplete: false }, { rawJwt: 'fixture-jwt-never-persist' },
    { checkRunIdPresent: true, registryBindsCheckRunId: false },
    { checkRunIdPresent: false, registryBindsCheckRunId: true },
    { checkRunIdPresent: false, registryBindsCheckRunId: false }, { runId: 999 }]) {
    const f = await fixture(t, { verifyProtectedArtifacts: async (s, role, dispatch) => ({ subjectHash: subjectHash(s),
      role, runId: dispatch.runId, oidcVerified: true, annotationsComplete: true, annotationSha256: 'a'.repeat(64),
      checkRunIdPresent: true, registryBindsCheckRunId: true, ...patch }) });
    const result = await f.controller.run(f.original);
    assert.equal(result.status, 'FAILED_CLEAN_BURNED');
    assert.equal(result.liveQualified, false);
    assert.equal(f.calls.some(([name]) => name === 'independentAttestation'), false);
  }
});

test('a cached old SHA without real ref movement and cached JWKS are refused', async t => {
  const f = await fixture(t, { moveRefAndReadOldMerge: async s => ({ subjectHash: subjectHash(s),
    ref: `refs/pull/${s.pr}/merge`, beforeRefSha: 'e'.repeat(40), afterRefSha: 'e'.repeat(40), oldMergeSha: 'e'.repeat(40),
    oldMergeReadable: true, movementObserved: false }) });
  assert.equal((await f.controller.run(f.original)).code, 'REAL_REF_MOVE_AND_OLD_MERGE_REQUIRED');
  const g = await fixture(t, { freshJwks: async s => ({ subjectHash: subjectHash(s), actualPrincipal: 'clued-control',
    freshNetwork: false, cacheHit: true, jwksSha256: 'a'.repeat(64) }) });
  assert.equal((await g.controller.run(g.original)).code, 'FRESH_PRINCIPAL_JWKS_REQUIRED');
});

test('missing terminal or independent attestation never qualifies or retries cleanup', async t => {
  const f = await fixture(t, { terminalAndCleanup: async () => { throw new Error('unknown'); } });
  assert.equal((await f.controller.run(f.original)).status, 'HOLD_UNCERTAIN');
  assert.equal(f.calls.filter(([name]) => name === 'terminalAndCleanup').length, 1);
  const g = await fixture(t, { independentAttestation: async s => ({ subjectHash: subjectHash(s), evidenceHash: 'a'.repeat(64),
    independent: false, attestationSha256: 'b'.repeat(64) }) });
  assert.equal((await g.controller.run(g.original)).code, 'INDEPENDENT_ATTESTATION_REQUIRED');
});

test('mid-session fence/epoch change refuses the next effect', async t => {
  let reads = 0, f;
  f = await fixture(t, { observeAdmission: async s => ({ ...f.admission(s),
    subjectHash: ++reads <= 3 ? subjectHash(s) : '0'.repeat(64) }) });
  assert.equal((await f.controller.run(f.original)).code, 'EFFECT_BINDING_CHANGED');
  assert.equal(f.calls.filter(([name]) => name === 'runStage1').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'dispatchHosted').length, 0);
  assert.equal(f.calls.filter(([name]) => name === 'terminalAndCleanup').length, 0);
  assert.ok(await fs.stat(path.join(f.root, 'session-lock.json')));
});

test('getter and coercible object values cannot reach persisted evidence', async t => {
  for (const getter of [true, false]) {
    const f = await fixture(t, { verifyProtectedArtifacts: async (s, role, dispatch) => {
      const row = { subjectHash: subjectHash(s), role, runId: dispatch.runId, oidcVerified: true,
        annotationsComplete: true, checkRunIdPresent: false, registryBindsCheckRunId: false };
      if (getter) Object.defineProperty(row, 'annotationSha256', { enumerable: true,
        get() { return 'fixture-sensitive-getter-value'; } });
      else row.annotationSha256 = { toString: () => 'a'.repeat(64), secret: 'fixture-sensitive-coercion-value' };
      return row;
    } });
    const result = await f.controller.run(f.original);
    assert.equal(result.status, 'FAILED_CLEAN_BURNED');
    for (const file of await fs.readdir(f.journal.headDirectory(f.original))) {
      assert.ok(!(await fs.readFile(path.join(f.journal.headDirectory(f.original), file), 'utf8')).includes('fixture-sensitive'));
    }
  }
});

test('unrelated ref movement or an unrelated old value cannot satisfy L3', async t => {
  for (const patch of [{ ref: 'refs/heads/unrelated' }, { beforeRefSha: '1'.repeat(40) }]) {
    const f = await fixture(t, { moveRefAndReadOldMerge: async s => ({ subjectHash: subjectHash(s),
      ref: `refs/pull/${s.pr}/merge`, beforeRefSha: 'e'.repeat(40), afterRefSha: '2'.repeat(40),
      oldMergeSha: 'e'.repeat(40), oldMergeReadable: true, movementObserved: true, ...patch }) });
    assert.equal((await f.controller.run(f.original)).code, 'REAL_REF_MOVE_AND_OLD_MERGE_REQUIRED');
  }
});

test('another controller cannot enter the same journal while the first effect is live', async t => {
  let started, unblock;
  const ready = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  const f = await fixture(t, { runStage1: async s => {
    started(); await blocked;
    return { subjectHash: subjectHash(s), manifestSha256: 'a'.repeat(64), oldMergeSha: 'e'.repeat(40), terminal: true };
  } });
  const first = f.controller.run(f.original);
  await ready;
  const second = await f.controller.run(subject({ headSha: '9'.repeat(40), runId: 'other-run' }));
  assert.equal(second.code, 'EXCLUSIVE_SESSION_BUSY_OR_UNCERTAIN');
  unblock();
  assert.equal((await first).status, 'OFFLINE_COMPLETE_NO_QUALIFICATION');
  assert.equal(f.calls.filter(([name]) => name === 'runStage1').length, 1);
});
