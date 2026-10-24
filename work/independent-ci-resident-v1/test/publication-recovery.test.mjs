// Real Source-v2 recovery wrapper + signed result verification + filesystem EffectJournal.
// Only external Native/GitHub/attestation ports and time are scripted. No engine success is substituted.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRecoverableCheckPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/runtime/one-shot-v2.mjs';
import { batchJobsV2, claimGeneration, scanEffectKeyV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal, rolePublicationKey, claimRolePublication } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { validateRecordV2 } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/record.mjs';
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
  const jobs = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(t0 - (options.createdAgeMs ?? 60_000)), attempt: 1 });
  const dir = path.join(await tempDir(t), 'effects');
  const rawJournal = await EffectJournal.open(dir);
  const events = [], checks = [], mutations = [], fetches = [], evaluations = [], ports = [];
  const state = { exhaust: options.exhaust ?? 3, onExhaust: null, sourceLive: true, claim: claimGeneration(claim),
    onCreate: null, onReadChecks: null, fetchDelay: 0, sleepDelay: 0, deny: false, logFailure: null, journalFailure: false,
    createFailure: false, revokeFailure: false, admissionDeny: false, admissionError: null, pullDrift: false };
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  let next = 100;
  const github = { fixture: true,
    async readChangedPaths(j) { ports.push('paths'); return { complete: true, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { ports.push('pull'); return { number: n, state: 'open', head: { sha: state.pullDrift ? 'e'.repeat(40) : HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { ports.push('checks'); await state.onReadChecks?.(); return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) {
      ports.push('create'); mutations.push('create'); if (state.createFailure) fail('github_transport_unconfirmed');
      const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); await state.onCreate?.(c); return structuredClone(c);
    },
    async revokeCheck(id, body) { ports.push('revoke'); mutations.push('revoke'); if (state.revokeFailure) fail('github_transport_unconfirmed'); const c = checks.find(v => v.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); },
  };
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
  const hostedVerifier = { fixture: true, registrySha256: digest('offline-registry'), publisherAppId: 5368905,
    async confirm(e) { ports.push('attestation'); return { confirmed: true, attestationSha256: e.attestationSha256 }; } };
  const publisher = createRecoverableCheckPublisherV2({
    publisherOptions: { nativeAdmission, github, journal, signers,
      configuredChecks: record.config.checks, readChangedPaths: j => github.readChangedPaths(j), batchClaim: claimGeneration(claim), domain: 'fixture', hostedVerifier,
      protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...accepted } },
    authorityOptions: { config: record.config, accepted, fetchImpl, nativeToken: 'offline-fixture-only',
      sleep: async ms => { time.now += ms + state.sleepDelay; }, timeoutSignal: ms => ({ testTimeout: ms }) },
    readCurrentBatchClaim: async () => { ports.push('current-claim'); return structuredClone(state.claim); }, live: () => { if (!state.sourceLive) fail('source_or_helper_no_longer_live'); },
    log: (kind, value) => { if (state.logFailure === kind) fail('observation_log_unconfirmed'); events.push({ kind, ...structuredClone(value) }); },
    clock: () => time.now, monotonic: () => time.now - t0,
  });
  const input = (role, times = {}) => ({ job: jobs[role], envelope: signResult(jobs[role], signer, { finishedAt: t0 - 1000, startedAt: t0 - 5000, ...times, domain: 'fixture' }) });
  const key = role => scanEffectKeyV2(jobs[role], record.config.checks[role]);
  const mutex = role => ({ repo: REPO, headSha: HEAD, role, checkName: record.config.checks[role].name, appId: record.config.checks[role].appId });
  const hosted = role => {
    const evidence = { contract: 'clued.independent-ci.hosted-attestation/1', registrySha256: hostedVerifier.registrySha256, role,
      checkName: record.config.checks[role].name, hostedCheckName: `${role}-hosted`, repository: REPO, repositoryId: 1, pr: 888, headSha: HEAD, baseSha: BASE,
      mergeSha: 'c'.repeat(40), mergeBaseSha: BASE, runId: '101', runAttempt: '1', checkRunId: 202, runUrl: `https://github.com/${REPO}/actions/runs/101`,
      jobUrl: `https://github.com/${REPO}/actions/runs/101/job/202`, workflowPath: `.github/workflows/${role}.yml`, workflowBlob: 'c'.repeat(40),
      closureSha256: digest('closure'), claimsSha256: digest('claims'), tokenSha256: digest('fixture-token'), iat: Math.floor(t0 / 1000) };
    return { subject: { repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, sourceManifestSha256: jobs[role].sourceManifestSha256, ...claimGeneration(claim) },
      attempt: 1, envelope: { ...evidence, attestationSha256: digest(evidence) } };
  };
  return { publisher, state, checks, mutations, fetches, evaluations, events, ports, signers, rawJournal, dir, time, t0, jobs, input, key, mutex, hosted };
}

const attempts = w => w.events.filter(e => e.kind === 'publication_recovery_result').at(-1)?.publisherAttempts;
const intents = w => w.events.filter(e => e.kind === 'publication_recovery_intent');

test('real wrapper: first30s exhaustion resumes only this publisher once and settles one real journaled Check', async t => {
  for (const role of ['gitleaks', 'trivy', 'contract-placement']) {
    const w = await world(t); const r = await w.publisher.publish(w.input(role));
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

test('postwrite observation shares60s: late answer revokes the one Check and persists compensation beyond the deadline', async t => {
  for (const exhaustedBeforeObserve of [false, true]) {
    const w = await world(t);
    w.state.onCreate = () => { if (exhaustedBeforeObserve) w.time.now += 30001; else w.state.fetchDelay = 30001; };
    const r = await w.publisher.publish(w.input('trivy'));
    assert.equal(r.status, 'REVOKED', JSON.stringify(r)); assert.equal(w.checks.length, 1); assert.equal(w.checks[0].conclusion, 'failure');
    assert.equal(w.mutations.filter(x => x === 'create').length, 1); assert.equal(w.mutations.filter(x => x === 'revoke').length, 1);
    assert.equal((await w.rawJournal.read(w.key('trivy'))).state, 'revoked'); assert.equal(intents(w).length, 1); assert.equal(attempts(w), 2);
    assert.ok(w.time.now - w.t0 > 60000); assert.ok(w.fetches.length <= 5);
  }
});

test('a revoke attempt that cannot be confirmed stays UNCERTAIN and never POSTs the role again', async t => {
  const w = await world(t); w.state.onCreate = () => { w.time.now += 30001; }; w.state.revokeFailure = true;
  const r = await w.publisher.publish(w.input('trivy'));
  assert.equal(r.status, 'UNCERTAIN'); assert.equal(w.mutations.filter(x => x === 'create').length, 1);
  assert.equal(w.mutations.filter(x => x === 'revoke').length, 1); assert.equal(w.checks.length, 1); assert.equal(attempts(w), 2);
});

test('hosted current-role recovery preserves an earlier SETTLED prefix and never republishes either role', async t => {
  const w = await world(t, { exhaust: 0 }); const prefix = await w.publisher.publishHosted(w.hosted('gitleaks'));
  assert.equal(prefix.status, 'SETTLED', JSON.stringify(prefix)); const old = structuredClone(w.checks[0]);
  w.state.exhaust = 3;
  const current = await w.publisher.publishHosted(w.hosted('trivy'));
  assert.equal(current.status, 'SETTLED', JSON.stringify(current)); assert.equal(attempts(w), 2);
  assert.equal(w.checks.length, 2); assert.deepEqual(w.checks[0], old); assert.equal((await w.rawJournal.read(prefix.effectKey)).state, 'settled');
  const repeat = await w.publisher.publishHosted(w.hosted('gitleaks'));
  assert.equal(repeat.status, 'UNCERTAIN'); assert.equal(repeat.reason, 'publication_recovery_reentry_refused');
  assert.equal(repeat.sideEffects, 0); assert.equal(w.checks.length, 2); assert.deepEqual(w.checks[0], old);
  assert.equal(w.mutations.filter(x => x === 'create').length, 2);
});

test('hosted SETTLED role reentry performs no ports and cannot exhaust or revoke its settled prefix', async t => {
  const w = await world(t, { exhaust: 0 }); const input = w.hosted('gitleaks'); const prefix = await w.publisher.publishHosted(input);
  assert.equal(prefix.status, 'SETTLED'); w.state.exhaust = 3;
  const beforePorts = [...w.ports], beforeEvents = structuredClone(w.events), beforeCheck = structuredClone(w.checks[0]);
  const result = await w.publisher.publishHosted(input);
  assert.equal(result.status, 'UNCERTAIN'); assert.equal(result.reason, 'publication_recovery_reentry_refused');
  assert.equal(w.checks.length, 1); assert.equal((await w.rawJournal.read(prefix.effectKey)).state, 'settled');
  assert.deepEqual(w.ports, beforePorts); assert.deepEqual(w.events, beforeEvents); assert.deepEqual(w.checks[0], beforeCheck);
  assert.equal(w.mutations.filter(x => x === 'create').length, 1); assert.equal(w.mutations.filter(x => x === 'revoke').length, 0);
});

test('a terminal exhausted role cannot obtain a fresh allowance through another call or the hosted path', async t => {
  const w = await world(t, { exhaust: 6 }); const input = w.input('trivy');
  const first = await w.publisher.publish(input);
  assert.notEqual(first.status, 'SETTLED'); assert.equal(attempts(w), 2); assert.equal(w.checks.length, 0);
  assert.equal(w.fetches.length, 6); assert.equal(w.time.now - w.t0, 60000);
  const beforePorts = [...w.ports], beforeEvents = structuredClone(w.events);
  w.state.exhaust = 0; w.time.now += 60000;
  for (const repeat of [() => w.publisher.publish(input), () => w.publisher.publishHosted(w.hosted('trivy'))]) {
    const result = await repeat();
    assert.equal(result.status, 'UNCERTAIN'); assert.equal(result.reason, 'publication_recovery_reentry_refused'); assert.equal(result.sideEffects, 0);
    assert.deepEqual(w.ports, beforePorts); assert.deepEqual(w.events, beforeEvents); assert.equal(w.checks.length, 0);
  }
});
