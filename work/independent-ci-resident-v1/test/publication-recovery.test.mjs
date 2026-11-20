// Real Source-v2 recovery wrapper + signed result verification + filesystem EffectJournal.
// Only external Native/GitHub/attestation ports and time are scripted. No engine success is substituted.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRecoverableCheckPublisherV2, createPublicationRecoveryAuditWriter } from '../../actions-hosted-migration/independent-ci-v1/runtime/one-shot-v2.mjs';
import { batchJobsV2, claimGeneration, scanEffectKeyV2, subjectOfV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal, rolePublicationKey, claimRolePublication } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { validateRecordV2 } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/record.mjs';
import { observationLog } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/entry-runtime.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult, admittedFacts } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function world(t, options = {}) {
  const t0 = Date.now(), time = { now: t0 };
  const { docs, signer } = fixtureRecord();
  const record = validateRecordV2(docs, { now: t0 });
  const accepted = Object.fromEntries(REFS.map(k => [k, record.accepted[k]]));
  const claim = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(t0 + 3_600_000) };
  const jobs = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(t0 - (options.createdAgeMs ?? 60_000)), attempt: 1 });
  const fixtureRoot = await tempDir(t), dir = path.join(fixtureRoot, 'effects'), auditDir = path.join(fixtureRoot, 'audit');
  fs.mkdirSync(auditDir);
  const rawJournal = await EffectJournal.open(dir);
  const events = [], checks = [], mutations = [], fetches = [], evaluations = [], ports = [];
  const state = { exhaust: options.exhaust ?? 3, onExhaust: null, sourceLive: true, claim: claimGeneration(claim),
    onCreate: null, onReadChecks: null, fetchDelay: 0, sleepDelay: 0, deny: false, logFailure: null, journalFailure: false,
    createFailure: false, revokeFailure: false, admissionDeny: false, admissionError: null, pullDrift: false, onAuditSaved: null };
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  let next = 100;
  const github = { fixture: true,
    async readChangedPaths(j) { ports.push('paths'); return { complete: true, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { ports.push('pull'); return { number: n, state: 'open', head: { sha: state.pullDrift ? 'e'.repeat(40) : HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { ports.push('checks'); await state.onReadChecks?.(); return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) {
      ports.push('create'); mutations.push('create'); if (state.createFailure) fail('github_transport_unconfirmed');
      const c = { id: next++, app: { id: 5368905 }, conclusion: null, ...structuredClone(body) }; checks.push(c); await state.onCreate?.(c); return structuredClone(c);
    },
    async revokeCheck(id, body) { ports.push('revoke'); mutations.push('revoke'); if (state.revokeFailure) fail('github_transport_unconfirmed'); const c = checks.find(v => v.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); },
  };
  if (options.verifyFirst) {
    github.readStagedScan = async (_key, id) => checks.find(check => check.id === id)?.status === 'in_progress' ? 'pending' : 'completed';
    github.completeStagedScan = async (key, id, verify) => {
      const record = await rawJournal.read(key);
      assert.equal(record.details.checkRunId, id);
      await rawJournal.transition(key, 'created', 'completing', record.details);
      (await verify())();
      assert.fail('the unavailable observation should refuse completion');
    };
    github.failStagedScan = async (_key, id) => github.revokeCheck(id, { status: 'completed', conclusion: 'failure' });
  }
  const journal = {
    read: key => { ports.push('journal-read'); return rawJournal.read(key); },
    async begin(...args) { ports.push('journal-begin'); mutations.push('begin'); if (state.journalFailure) fail('journal_write_unconfirmed'); return rawJournal.begin(...args); },
    async transition(...args) { ports.push('journal-transition'); mutations.push('transition'); return rawJournal.transition(...args); },
  };
  const nativeAdmission = { fixture: true, async evaluatePr(job, packet, opts) {
    ports.push('evaluate'); evaluations.push(job.role);
    if (state.admissionError) fail(state.admissionError);
    if (state.admissionDeny) return { contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED' };
    return admittedFacts(job, claim, packet, { domain: 'fixture', batchClaim: opts.batchClaim, observedAt: time.now, slotUntil: t0 + 3_600_000 });
  } };
  const verifyBody = () => ({ status: 'ok', verdict: state.deny ? 'REFUSED' : 'ADMITTED', execution_policy: 'staged', current_fence: claim.fence,
    execution_epoch: claim.epoch, paths_outside_write_set: [], verified_at: iso(time.now), claim: { claim_id: claim.claimId, fence: claim.fence,
      execution_epoch: claim.epoch, context_key: record.config.scope, status: 'ACTIVE', lease_key_required: false, execution_handover_pending: false, expires_at: claim.expiresAt } });
  const fetchImpl = async (_url, opts) => {
    ports.push('native-verify'); fetches.push({ at: time.now - t0, timeout: opts.signal.testTimeout });
    if (state.exhaust > 0) {
      state.exhaust--; time.now += opts.signal.testTimeout;
      if (state.exhaust === 0) await state.onExhaust?.();
      throw new DOMException('timeout', 'TimeoutError');
    }
    time.now += state.fetchDelay;
    return { status: 200, async json() { return verifyBody(); } };
  };
  const stage = options.stage ?? 5;
  const recoveryContext = { nonce: randomUUID().replaceAll('-', ''), stage, entryRole: 'check-publisher',
    batchKey: digest('offline-batch'), configSha256: digest(`offline-stage-plan-${stage}`), sourceManifestSha256: jobs.trivy.sourceManifestSha256,
    acceptanceSha256: record.hashes.acceptanceSha256, entrySha256: digest('offline-installed-entry') };
  const actualAuditWriter = createPublicationRecoveryAuditWriter({ context: recoveryContext, domain: 'fixture', fixtureDirectory: auditDir });
  const hashLogDir = path.join(fixtureRoot, 'hash-log');
  const actualHashLog = options.hashOnlyLog ? observationLog(hashLogDir, jobs.trivy.id) : null;
  const publisher = createRecoverableCheckPublisherV2({
    publisherOptions: { nativeAdmission, github, journal, signers,
      configuredChecks: record.config.checks, readChangedPaths: j => github.readChangedPaths(j), batchClaim: claimGeneration(claim), domain: 'fixture',
      protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...accepted } },
    authorityOptions: { config: record.config, accepted, fetchImpl, nativeToken: 'offline-fixture-only',
      sleep: async ms => { time.now += ms + state.sleepDelay; }, timeoutSignal: ms => ({ testTimeout: ms }) },
    readCurrentBatchClaim: async () => { ports.push('current-claim'); return structuredClone(state.claim); }, live: () => { if (!state.sourceLive) fail('source_or_helper_no_longer_live'); },
    log: (kind, value) => { if (state.logFailure === kind) fail('observation_log_unconfirmed'); actualHashLog?.(kind, value); events.push({ kind, ...structuredClone(value) }); },
    recoveryContext: options.omitContext ? undefined : { ...recoveryContext, ...options.factoryContextDelta },
    auditWriter: options.omitWriter ? undefined : options.hashOnlyWriter ? () => undefined : async record => {
      const saved = actualAuditWriter(record); await state.onAuditSaved?.(record); return saved;
    },
    clock: () => time.now, monotonic: () => time.now - t0,
  });
  const input = (role, times = {}) => ({ job: jobs[role], envelope: signResult(jobs[role], signer, { finishedAt: t0 - 1000, startedAt: t0 - 5000, ...times, domain: 'fixture' }) });
  const key = role => scanEffectKeyV2(jobs[role], record.config.checks[role]);
  const mutex = role => ({ repo: REPO, headSha: HEAD, role, checkName: record.config.checks[role].name, appId: record.config.checks[role].appId });
  return { publisher, state, checks, mutations, fetches, evaluations, events, ports, signers, rawJournal, dir, auditDir, hashLogDir, recoveryContext,
    actualAuditWriter, time, t0, jobs, input, key, mutex };
}

const attempts = w => w.events.filter(e => e.kind === 'publication_recovery_result').at(-1)?.publisherAttempts;
const intents = w => w.events.filter(e => e.kind === 'publication_recovery_intent');

// Real writer, actual temporary files and real non-faulted syscalls. Only the one selected
// audit-file operation fails. Restore all process-local methods even if an assertion throws.
async function withAuditIoFault(directory, phase, operation, action) {
  const methods = ['openSync', 'closeSync', 'writeSync', 'writeFileSync', 'fsyncSync', 'readSync', 'readFileSync'];
  const original = Object.fromEntries(methods.map(name => [name, fs[name]]));
  const prefix = path.resolve(directory).toLowerCase() + path.sep, handles = new Set();
  const matches = value => typeof value === 'string' && path.resolve(value).toLowerCase().startsWith(prefix)
    && value.endsWith(`-${phase}.json`);
  let injected = false;
  const fault = (name, fdOrPath) => {
    if (!injected && name === operation && (handles.has(fdOrPath) || matches(fdOrPath))) {
      injected = true; fail('offline_audit_io_failure');
    }
  };
  fs.openSync = function (file, ...args) {
    fault('open', file); const fd = original.openSync.call(this, file, ...args);
    if (matches(file)) handles.add(fd); return fd;
  };
  fs.closeSync = function (fd, ...args) { try { return original.closeSync.call(this, fd, ...args); } finally { handles.delete(fd); } };
  for (const name of ['writeSync', 'writeFileSync', 'fsyncSync', 'readSync', 'readFileSync']) {
    fs[name] = function (fdOrPath, ...args) {
      fault(name === 'fsyncSync' ? 'flush' : name.startsWith('write') ? 'write' : 'readback', fdOrPath);
      return original[name].call(this, fdOrPath, ...args);
    };
  }
  try { return { value: await action(), injected }; }
  finally { for (const name of methods) fs[name] = original[name]; }
}

test('real wrapper: first30s exhaustion resumes only this publisher once and settles one real journaled Check', async t => {
  for (const role of ['gitleaks', 'trivy', 'contract-placement']) {
    const w = await world(t, { stage: { gitleaks: 3, trivy: 5, 'contract-placement': 7 }[role] }); const r = await w.publisher.publish(w.input(role));
    assert.equal(r.status, 'SETTLED', JSON.stringify(r)); assert.equal(r.sideEffects, 1);
    assert.equal(w.checks.length, 1); assert.equal(w.mutations.filter(x => x === 'create').length, 1);
    assert.equal((await w.rawJournal.read(w.key(role))).state, 'settled');
    assert.equal(attempts(w), 2); assert.equal(intents(w).length, 1); assert.equal(w.fetches.length, 5);
    assert.equal(w.fetches[3].at, 30000); assert.deepEqual(w.evaluations, [role, role]);
  }
});

test('actual Native denial and full evaluator denial never enter the recovery path', async t => {
  for (const mode of ['native', 'evaluator']) {
    const w = await world(t, { exhaust: 0 }); w.state.deny = mode === 'native'; w.state.admissionDeny = mode === 'evaluator';
    const r = await w.publisher.publish(w.input('trivy'));
    assert.equal(r.status, 'BLOCKED'); assert.equal(attempts(w), 1); assert.equal(intents(w).length, 0); assert.equal(w.checks.length, 0);
    assert.equal(w.fetches.length, 1); assert.equal(w.evaluations.length, mode === 'native' ? 0 : 1);
  }
});

test('existing own journal, K, remote Check or incomplete remote read prevents any recovery POST', async t => {
  for (const cause of ['journal', 'mutex', 'remote', 'unreadable']) {
    const w = await world(t);
    w.state.onExhaust = async () => {
      if (cause === 'journal') await w.rawJournal.begin(w.key('trivy'), { other: 'writer' });
      if (cause === 'mutex') await claimRolePublication(w.rawJournal, w.mutex('trivy'), { path: 'relay', effectKey: digest('other'), externalId: 'independent-ci:other' });
      if (cause === 'remote') w.checks.push({ id: 9000, app: { id: 5368905 }, name: w.mutex('trivy').checkName, head_sha: HEAD });
      if (cause === 'unreadable') w.state.onReadChecks = () => { throw new Error('remote inventory unavailable'); };
    };
    const r = await w.publisher.publish(w.input('trivy'));
    assert.equal(r.status, 'UNCERTAIN', `${cause}: ${JSON.stringify(r)}`); assert.equal(attempts(w), 1); assert.equal(intents(w).length, 0);
    assert.equal(w.mutations.filter(x => x === 'create').length, 0); assert.equal(w.fetches.length, 3);
  }
});

test('claim fence/epoch, held Source, PR head or result signer drift refuses recovery', async t => {
  for (const cause of ['fence', 'epoch', 'source', 'pull', 'signer']) {
    const w = await world(t); const input = w.input('trivy');
    w.state.onExhaust = () => {
      if (cause === 'fence') w.state.claim.fence++;
      if (cause === 'epoch') w.state.claim.epoch++;
      if (cause === 'source') w.state.sourceLive = false;
      if (cause === 'pull') w.state.pullDrift = true;
      if (cause === 'signer') w.signers.clear();
    };
    const r = await w.publisher.publish(input);
    assert.notEqual(r.status, 'SETTLED'); assert.equal(w.checks.length, 0);
    assert.equal(w.mutations.filter(x => x === 'create').length, 0);
    // PR freshness is checked by the real second publisher boundary, not inferred from its earlier absence proof.
    if (cause !== 'pull') assert.equal(intents(w).length, 0);
  }
});

test('the protected signed result is cloned and reverified for freshness before continuation', async t => {
  const cloned = await world(t); const input = cloned.input('trivy');
  cloned.state.onExhaust = () => { input.envelope.signature = 'changed-caller-buffer'; };
  const good = await cloned.publisher.publish(input);
  assert.equal(good.status, 'SETTLED'); assert.equal(cloned.checks.length, 1);
  const expired = await world(t, { createdAgeMs: 660000 });
  const old = expired.input('trivy', { startedAt: expired.t0 - 595000, finishedAt: expired.t0 - 590000 });
  const result = await expired.publisher.publish(old);
  assert.notEqual(result.status, 'SETTLED'); assert.equal(expired.fetches.length, 3);
  assert.equal(expired.checks.length, 0); assert.equal(intents(expired).length, 0);
});

test('a full evaluator error named like an observation exhaustion is never a trusted retry latch', async t => {
  const w = await world(t, { exhaust: 0 }); w.state.admissionError = 'native_claim_observation_unavailable';
  const r = await w.publisher.publish(w.input('trivy'));
  assert.notEqual(r.status, 'SETTLED'); assert.equal(w.evaluations.length, 1);
  assert.equal(attempts(w), 1); assert.equal(intents(w).length, 0); assert.equal(w.checks.length, 0); assert.equal(w.fetches.length, 1);
});

test('logging failures before retry, at retry intent, and after a settled write are fail closed without a duplicate', async t => {
  for (const kind of ['native_claim_observation_unavailable', 'publication_recovery_intent', 'publication_recovery_result']) {
    const w = await world(t); w.state.logFailure = kind;
    const r = await w.publisher.publish(w.input('trivy'));
    assert.equal(r.status, 'UNCERTAIN'); assert.equal(r.productionAuthorized, false);
    assert.equal(w.checks.length, kind === 'publication_recovery_result' ? 1 : 0);
    assert.ok(w.mutations.filter(x => x === 'create').length <= 1);
  }
});

test('journal.begin or createCheck uncertainty never becomes a third publisher invocation', async t => {
  for (const cause of ['journal', 'create']) {
    const w = await world(t); w.state.journalFailure = cause === 'journal'; w.state.createFailure = cause === 'create';
    const r = await w.publisher.publish(w.input('trivy'));
    assert.notEqual(r.status, 'SETTLED'); assert.equal(attempts(w), 2); assert.equal(intents(w).length, 1);
    assert.ok(w.mutations.filter(x => x === 'create').length <= 1); assert.ok(w.fetches.length <= 4);
  }
});

test('shared60s: slow guard and late second-round response refuse before any Check', async t => {
  for (const cause of ['guard', 'response', 'reserve']) {
    const w = await world(t);
    w.state.onExhaust = () => {
      if (cause === 'guard') w.state.onReadChecks = () => { w.time.now += 30001; w.state.onReadChecks = null; };
      else w.state.fetchDelay = cause === 'response' ? 30001 : 29900;
    };
    const r = await w.publisher.publish(w.input('trivy'));
    assert.notEqual(r.status, 'SETTLED', JSON.stringify(r)); assert.equal(w.checks.length, 0);
    assert.ok(w.fetches.length <= 4); assert.ok(w.time.now - w.t0 <= 60001);
    if (cause === 'reserve') assert.equal(await w.rawJournal.read(rolePublicationKey(w.mutex('trivy'))), null, 'reserve refusal cannot allocate K');
  }
});

test('shared60s: a late wakeup does not start another observe round', async t => {
  const w = await world(t); w.state.sleepDelay = 60001;
  const r = await w.publisher.publish(w.input('trivy'));
  assert.notEqual(r.status, 'SETTLED'); assert.equal(w.fetches.length, 1); assert.equal(intents(w).length, 0); assert.equal(w.checks.length, 0);
});

// Generation 13 (DESIGN §57.2, Owner Decision 36946d8b): the observations after the write have a 60 s window of their own, started by
// the first of them; the pre-write window, its recovery and its audit are unchanged.
test('postwrite observation has its own window: late answer or a confirmation past that window revokes the one Check and persists compensation', async t => {
  for (const late of ['answer', 'window']) {
    const w = await world(t);
    w.state.onCreate = () => {
      if (late === 'answer') { w.state.fetchDelay = 30001; return; }
      // the first observation after the write answers in 25 s; a 31 s read-back ages the admission; its re-evaluation answers 25 s
      // later, past the post-write window (25 + 31 + 25 > 60)
      w.state.fetchDelay = 25000; w.state.onReadChecks = () => { w.time.now += 31000; w.state.onReadChecks = null; };
    };
    const r = await w.publisher.publish(w.input('trivy'));
    assert.equal(r.status, 'REVOKED', JSON.stringify(r)); assert.equal(w.checks.length, 1); assert.equal(w.checks[0].conclusion, 'failure');
    assert.equal(w.mutations.filter(x => x === 'create').length, 1); assert.equal(w.mutations.filter(x => x === 'revoke').length, 1);
    assert.equal((await w.rawJournal.read(w.key('trivy'))).state, 'revoked'); assert.equal(intents(w).length, 1); assert.equal(attempts(w), 2);
    assert.ok(w.time.now - w.t0 > 60000); assert.ok(w.fetches.length <= 6);
  }
});

test('postwrite observation has its own window: time spent between the write and its confirmation, past the pre-write deadline, does not withdraw the green', async t => {
  const w = await world(t);
  w.state.onCreate = () => { w.time.now += 30001; };
  const r = await w.publisher.publish(w.input('trivy'));
  assert.equal(r.status, 'SETTLED', JSON.stringify(r)); assert.equal(w.checks.length, 1); assert.equal(w.checks[0].conclusion, 'success');
  assert.equal(w.mutations.filter(x => x === 'revoke').length, 0); assert.equal(attempts(w), 2);
  assert.ok(w.time.now - w.t0 > 60000, 'the confirmation ran after the pre-write deadline');
  const final = w.events.filter(e => e.kind === 'publication_recovery_result').at(-1);
  assert.deepEqual([final.maxObservationMs, final.maxPostWriteObservationMs], [60000, 60000]);
});

test('legacy publication order: an unconfirmed withdrawal stays UNCERTAIN and never POSTs the role again', async t => {
  const w = await world(t); w.state.onCreate = () => { w.state.fetchDelay = 30001; }; w.state.revokeFailure = true;
  const r = await w.publisher.publish(w.input('trivy'));
  assert.equal(r.status, 'UNCERTAIN'); assert.equal(r.reason, 'revocation_unconfirmed');
  assert.equal(w.mutations.filter(x => x === 'create').length, 1);
  assert.equal(w.mutations.filter(x => x === 'revoke').length, 1); assert.equal(w.checks.length, 1); assert.equal(attempts(w), 2);
});

test('failed staged verification with unavailable cleanup ends cleanly and never publishes green', async t => {
  const w = await world(t, { verifyFirst: true }); w.state.onCreate = () => { w.state.fetchDelay = 30001; }; w.state.revokeFailure = true;
  const r = await w.publisher.publish(w.input('trivy'));
  assert.equal(r.status, 'STAGED_SCAN_FAILED'); assert.equal(w.mutations.filter(x => x === 'create').length, 1);
  assert.equal(w.mutations.filter(x => x === 'revoke').length, 1); assert.equal(w.checks.length, 1); assert.equal(attempts(w), 2);
  assert.deepEqual([w.checks[0].status, w.checks[0].conclusion], ['in_progress', null]);
  assert.equal((await w.rawJournal.read(w.key('trivy'))).state, 'revoked');
});

test('a terminal exhausted role cannot obtain a fresh allowance through another call', async t => {
  const w = await world(t, { exhaust: 6 }); const input = w.input('trivy');
  const first = await w.publisher.publish(input);
  assert.notEqual(first.status, 'SETTLED'); assert.equal(attempts(w), 2); assert.equal(w.checks.length, 0);
  assert.equal(w.fetches.length, 6); assert.equal(w.time.now - w.t0, 60000);
  const beforePorts = [...w.ports], beforeEvents = structuredClone(w.events);
  w.state.exhaust = 0; w.time.now += 60000;
  const result = await w.publisher.publish(input);
  assert.equal(result.status, 'UNCERTAIN'); assert.equal(result.reason, 'publication_recovery_reentry_refused'); assert.equal(result.sideEffects, 0);
  assert.deepEqual(w.ports, beforePorts); assert.deepEqual(w.events, beforeEvents); assert.equal(w.checks.length, 0);
});

test('G10: the actual hash-only production observation log cannot replace durable recovery proof', async t => {
  for (const absent of [{ omitContext: true }, { omitWriter: true }, { hashOnlyWriter: true }]) {
    const w = await world(t, { ...absent, hashOnlyLog: true });
    const result = await w.publisher.publish(w.input('trivy'));
    assert.equal(result.status, 'UNCERTAIN'); assert.equal(result.reason, 'publication_recovery_unconfirmed');
    assert.equal(w.fetches.length, 3); assert.equal(w.evaluations.length, 0); assert.equal(w.checks.length, 0);
    assert.equal(await w.rawJournal.read(w.key('trivy')), null); assert.equal(await w.rawJournal.read(rolePublicationKey(w.mutex('trivy'))), null);
    assert.deepEqual(fs.readdirSync(w.auditDir), []);
    const rows = fs.readFileSync(path.join(w.hashLogDir, 'observations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['contract', 'dataSha256', 'id', 'jobId', 'kind', 'observedAt']);
      assert.equal(row.contract, 'clued.independent-ci.source-observation/1');
      assert.equal(Object.hasOwn(row, 'data'), false); assert.equal(Object.hasOwn(row, 'nonce'), false);
    }
  }
});

test('G10: wrong real invocation binding or stage-role pairing cannot authorize continuation', async t => {
  const changes = [
    { factoryContextDelta: { nonce: '0'.repeat(32) } },
    { factoryContextDelta: { configSha256: digest('wrong-stage-config') } },
    { factoryContextDelta: { sourceManifestSha256: 'e'.repeat(64) } },
    { factoryContextDelta: { acceptanceSha256: digest('wrong-acceptance') } },
    { factoryContextDelta: { entrySha256: digest('wrong-entry') } },
    { stage: 3 },
  ];
  for (const options of changes) {
    const w = await world(t, options); const result = await w.publisher.publish(w.input('trivy'));
    assert.equal(result.status, 'UNCERTAIN'); assert.equal(w.checks.length, 0); assert.equal(w.fetches.length, 3);
    assert.equal(w.evaluations.length, 0); assert.equal(intents(w).length, 0);
    assert.deepEqual(fs.readdirSync(w.auditDir), []);
  }
});

test('G10: real intent CreateNew/write/flush/readback failures preserve files and forbid the second publisher', async t => {
  for (const operation of ['open', 'write', 'flush', 'readback']) {
    const w = await world(t);
    const { value: result, injected } = await withAuditIoFault(w.auditDir, 'intent', operation, () => w.publisher.publish(w.input('trivy')));
    assert.equal(injected, true, `${operation} fault must reach the actual audit writer`);
    assert.equal(result.status, 'UNCERTAIN'); assert.equal(result.reason, 'publication_recovery_unconfirmed');
    assert.equal(w.fetches.length, 3); assert.equal(w.evaluations.length, 0); assert.equal(w.checks.length, 0);
    assert.equal(w.mutations.length, 0); assert.equal(intents(w).length, 0);
    assert.equal(await w.rawJournal.read(w.key('trivy')), null); assert.equal(await w.rawJournal.read(rolePublicationKey(w.mutex('trivy'))), null);
    const evidence = fs.readdirSync(w.auditDir);
    assert.equal(evidence.length, operation === 'open' ? 0 : 1, 'failed CreateNew evidence is retained, never silently deleted or replaced');
    if (evidence.length) assert.ok(evidence[0].endsWith('-intent.json'));
  }
});

test('G10: result persistence failures cannot POST again or prevent known-Check compensation', async t => {
  for (const compensate of [false, true]) {
    const w = await world(t);
    if (compensate) w.state.onCreate = () => { w.state.fetchDelay = 30001; };
    const { value: result, injected } = await withAuditIoFault(w.auditDir, 'result', 'flush', () => w.publisher.publish(w.input('trivy')));
    assert.equal(injected, true); assert.equal(result.status, 'UNCERTAIN'); assert.equal(w.checks.length, 1);
    assert.equal(w.mutations.filter(v => v === 'create').length, 1);
    assert.equal(w.mutations.filter(v => v === 'revoke').length, compensate ? 1 : 0);
    assert.equal((await w.rawJournal.read(w.key('trivy'))).state, compensate ? 'revoked' : 'settled');
    if (compensate) { assert.equal(w.checks[0].conclusion, 'failure'); assert.ok(w.time.now - w.t0 > 60000); }
    assert.equal(attempts(w), 2); assert.ok(w.fetches.length <= 5);
    const evidence = fs.readdirSync(w.auditDir);
    assert.equal(evidence.length, 2); assert.ok(evidence.some(v => v.endsWith('-intent.json'))); assert.ok(evidence.some(v => v.endsWith('-result.json')));
    const before = [...w.ports]; const repeat = await w.publisher.publish(w.input('trivy'));
    assert.equal(repeat.status, 'UNCERTAIN'); assert.deepEqual(w.ports, before);
  }
});

test('G10: real intent and result files bind invocation, full negative proof and the unchanged clock anchor', async t => {
  const w = await world(t), input = w.input('trivy');
  const prefix = { id: 9000, app: { id: 5368905 }, name: w.mutex('gitleaks').checkName, head_sha: HEAD };
  w.state.onExhaust = () => {
    w.checks.push(structuredClone(prefix)); w.state.fetchDelay = 1000;
    w.state.onReadChecks = () => { w.time.now += 5000; w.state.onReadChecks = null; };
  };
  const result = await w.publisher.publish(input);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result)); assert.deepEqual(w.checks[0], prefix);
  const files = fs.readdirSync(w.auditDir).sort();
  assert.deepEqual(files, ['intent', 'result'].map(kind => `publication-recovery-${w.recoveryContext.nonce}-${w.jobs.trivy.id}-${kind}.json`).sort());
  const rawIntent = fs.readFileSync(path.join(w.auditDir, files.find(v => v.endsWith('-intent.json'))));
  const rawResult = fs.readFileSync(path.join(w.auditDir, files.find(v => v.endsWith('-result.json'))));
  const intent = JSON.parse(rawIntent), final = JSON.parse(rawResult), rawSha = b => createHash('sha256').update(b).digest('hex');
  const fields = ['schema', 'domain', 'kind', 'auditOnly', 'grantsExecution', 'context', 'job', 'identity', 'clock', 'counters', 'firstExhaustion', 'negativeProof', 'intentSha256', 'publisherResult'].sort();
  for (const record of [intent, final]) {
    assert.deepEqual(Object.keys(record).sort(), fields); assert.equal(record.schema, 'clued.independent-ci.publication-recovery-audit/1');
    assert.equal(record.domain, 'fixture'); assert.equal(record.auditOnly, true); assert.equal(record.grantsExecution, false);
    assert.deepEqual(record.context, w.recoveryContext); assert.deepEqual(record.job, w.jobs.trivy);
    assert.deepEqual(record.identity, { effectKey: w.key('trivy'), roleMutexKey: rolePublicationKey(w.mutex('trivy')),
      inputSha256: digest(input), evidenceSha256: digest(input.envelope), claim: w.state.claim });
    assert.equal(record.clock.monotonicAnchorMs, 0); assert.equal(record.clock.deadlineMonotonicMs, 60000);
    assert.equal(record.clock.wallAnchorAt, iso(w.t0)); assert.equal(record.clock.budgetMs, 60000);
    assert.deepEqual(record.firstExhaustion, intent.firstExhaustion);
    assert.equal(record.firstExhaustion.subjectSha256, digest(subjectOfV2(w.jobs.trivy)));
    assert.equal(record.firstExhaustion.claimSha256, digest(w.state.claim)); assert.equal(record.firstExhaustion.transient, true);
    assert.equal(record.firstExhaustion.attempt, 3); assert.equal(record.firstExhaustion.exhaustedAtMonotonicMs, 30000);
    assert.equal(record.firstExhaustion.observationDeadlineMonotonicMs, 30000);
    assert.deepEqual(record.negativeProof, { ownEffectKeyNull: true, roleMutexKeyNull: true, remoteComplete: true,
      appId: 5368905, checkName: w.mutex('trivy').checkName, headSha: HEAD, inventorySha256: digest([prefix]), inventoryCount: 1, matchingCount: 0, observedAt: iso(w.t0 + 35000) });
  }
  assert.equal(intent.clock.elapsedMs, 35000); assert.equal(intent.clock.remainingMs, 25000);
  assert.equal(final.clock.elapsedMs, 37000); assert.equal(final.clock.remainingMs, 23000);
  assert.deepEqual(intent.counters, { publisherAttempts: 1, observationCalls: 1, verifyRequests: 3, fullEvaluations: 0, mutationAttempted: false });
  assert.deepEqual(final.counters, { publisherAttempts: 2, observationCalls: 3, verifyRequests: 5, fullEvaluations: 2, mutationAttempted: true });
  assert.equal(intent.intentSha256, null); assert.equal(intent.publisherResult, null); assert.equal(final.intentSha256, rawSha(rawIntent));
  assert.equal(final.publisherResult.status, 'SETTLED'); assert.equal(final.publisherResult.sideEffects, 1);
  for (const [kind, bytes] of [['intent', rawIntent], ['result', rawResult]]) {
    const logged = w.events.find(e => e.kind === `publication_recovery_${kind}_persisted`);
    assert.equal(logged.sha256, rawSha(bytes)); assert.equal(logged.bytes, bytes.length); assert.equal(logged.nonce, w.recoveryContext.nonce);
    assert.equal(logged.configSha256, w.recoveryContext.configSha256);
    const stat = fs.lstatSync(path.join(w.auditDir, logged.fileName)); assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1);
  }
  // Replaying a valid proof must fail CreateNew; the original bytes must stay identical.
  assert.throws(() => w.actualAuditWriter(intent));
  assert.deepEqual(fs.readFileSync(path.join(w.auditDir, files.find(v => v.endsWith('-intent.json')))), rawIntent);
  // Unknown fields must be rejected before any file is opened, not merely collide with the prior filename.
  let opened = 0; const open = fs.openSync;
  fs.openSync = function (...args) { opened++; return open.apply(this, args); };
  try {
    for (const bad of [{ ...intent, extra: 'test-only-canary' }, { ...intent, context: { ...intent.context, extra: 'test-only-canary' } },
      { ...intent, negativeProof: { ...intent.negativeProof, extra: 'test-only-canary' } }]) assert.throws(() => w.actualAuditWriter(bad));
  } finally { fs.openSync = open; }
  assert.equal(opened, 0); assert.equal(fs.readdirSync(w.auditDir).length, 2);
  assert.equal(rawIntent.includes(Buffer.from('test-only-canary')), false); assert.equal(rawResult.includes(Buffer.from('test-only-canary')), false);
});

test('G10: own journal or K appearing after intent persistence is preserved without POST or revocation', async t => {
  for (const cause of ['own', 'mutex']) {
    const w = await world(t); let raced;
    w.state.onAuditSaved = async record => {
      if (record.kind !== 'intent') return;
      if (cause === 'own') {
        await w.rawJournal.begin(w.key('trivy'), { other: 'writer' });
        raced = await w.rawJournal.read(w.key('trivy'));
      } else {
        await claimRolePublication(w.rawJournal, w.mutex('trivy'), { path: 'relay', effectKey: digest('other-after-intent'), externalId: 'independent-ci:other-after-intent' });
        raced = await w.rawJournal.read(rolePublicationKey(w.mutex('trivy')));
      }
    };
    const result = await w.publisher.publish(w.input('trivy'));
    assert.equal(result.status, 'UNCERTAIN'); assert.equal(w.checks.length, 0);
    assert.equal(w.mutations.filter(v => v === 'create').length, 0); assert.equal(w.mutations.filter(v => v === 'revoke').length, 0);
    assert.deepEqual(await w.rawJournal.read(cause === 'own' ? w.key('trivy') : rolePublicationKey(w.mutex('trivy'))), raced);
    assert.equal(fs.readdirSync(w.auditDir).length, 2); assert.equal(intents(w).length, 1);
  }
});
