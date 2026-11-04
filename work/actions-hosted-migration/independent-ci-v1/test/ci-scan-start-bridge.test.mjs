import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchJobsV2 } from '../src/job-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { validateScanStartGrant, requireFreshScanStartGrant, NATIVE_SCAN_START_REQUIRED, localScanStart, scanStartPermission } from '../src/scan-start-v1/grant.mjs';
import { REQUIRED_SOURCE_PATHS, createWindowsContext, validateSourcePins } from '../worker/protected-job-bridge-v4/boundary.mjs';
import { runIssuer } from '../worker/protected-job-bridge-v4/windows-issuer.mjs';
import { makeIssue, makeChallenge, makeResponse, validateResponse, encode, decode, RESPONSE_CONTRACT } from '../worker/protected-job-bridge-v4/protocol.mjs';
import { callbackValue } from '../worker/protected-job-bridge-v4/linux-worker.mjs';
import { createFormalGitleaksAdapter } from '../worker/formal-gitleaks-v4/adapter.mjs';
import { createFormalTrivyAdapter } from '../worker/formal-trivy-v4/adapter.mjs';
import { createFormalContractPlacementAdapter } from '../worker/formal-contract-placement-v2/adapter.mjs';
import { fixtureRecord, admittedFacts, HEAD, BASE } from './resident-v2-fixtures.mjs';

const clone = v => JSON.parse(JSON.stringify(v));
test('accepted bridge pins must include both the Native gate implementation and its registry boundary', () => {
  const prefix = 'work/actions-hosted-migration/independent-ci-v1/';
  const pins = REQUIRED_SOURCE_PATHS.map(path => ({ path, sha256: 'c'.repeat(64) }));
  for (const name of ['src/scan-start-v1/grant.mjs', 'src/scan-start-v1/native-port.mjs', 'src/hosted-relay-v1/registry.mjs', 'src/hosted-relay-v1/registry.json']) {
    assert.ok(REQUIRED_SOURCE_PATHS.includes(prefix + name));
    assert.throws(() => validateSourcePins(pins.filter(p => p.path !== prefix + name)), { code: 'BRIDGE_ACCEPTED_SOURCE_INCOMPLETE' });
  }
});
const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const grant = (job, executionId) => ({ status: 'committed', contract: 'clued.ci-scan-start-grant/1', launch_allowed: true,
  execution_id: executionId, receipt_id: randomUUID(), repository_id: 1334673495, head_sha: job.headSha, role: job.role,
  provider: 'independent-controller', start_requested_at: new Date().toISOString() });
function setup(role = 'trivy') {
  const fx = fixtureRecord({}, { paths: REQUIRED_SOURCE_PATHS }), record = validateRecordV2(fx.docs, { now: Date.now() });
  const job = batchJobsV2({ repo: 'tdoljyj/cross-memory-system', pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD,
    sourceManifestSha256: record.config.sourceManifestSha256, createdAt: new Date(Date.now() - 60000).toISOString(), attempt: 1 })[role];
  const c = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const facts = (at = Date.now()) => admittedFacts(job, c, { complete: true, paths: ['a.txt'] }, { batchClaim: c, observedAt: at });
  const context = createWindowsContext({ inputs: { jobs: [job], record }, policyText: '{}', sourceRoot: 'C:\\fixture', live() {} });
  const issue = () => makeIssue(job, facts(), null, { sourceAcceptanceRef: record.accepted.sourceAcceptanceRef,
    hostQualificationRef: record.accepted.hostQualificationRef, expiresAt: new Date(Date.now() + 600000).toISOString() });
  return { job, facts, context, issue };
}
test('closed grant binds fixed repo/head/role/provider/execution and rejects replay/consumed/extra/accessors', () => {
  const f = setup(), id = randomUUID(), good = grant(f.job, id);
  assert.equal(validateScanStartGrant(good, { job: f.job, executionId: id }).execution_id, id);
  for (const patch of [{ status: 'consumed', launch_allowed: false }, { status: 'rejected', launch_allowed: false },
    { execution_id: randomUUID() }, { head_sha: 'f'.repeat(40) }, { role: 'gitleaks' }, { provider: 'github-actions' },
    { repository_id: 1 }, { launch_allowed: 'true' }, { receipt_id: 'invalid' }, { token: 'SECRET' },
    { start_requested_at: '2026-11-02T00:00:00.000123+00:00' }]) {
    assert.throws(() => validateScanStartGrant({ ...good, ...patch }, { job: f.job, executionId: id }), { code: 'SCAN_START_GRANT_REFUSED' });
  }
  let reads = 0; const bad = { ...good }; Object.defineProperty(bad, 'execution_id', { enumerable: true, get() { reads++; return id; } });
  assert.throws(() => validateScanStartGrant(bad, { job: f.job, executionId: id })); assert.equal(reads, 0);
});
test('response successor /3 ordinary rounds cannot carry a grant, scan-start must bind issue UUID and current same-claim admission', () => {
  const f = setup(), issue = f.issue(), ch = makeChallenge(issue, 'scan-start', 1), g = grant(f.job, issue.issueId);
  const response = makeResponse(issue, ch, f.facts(), null, { scanStart: g });
  assert.equal(response.contract, RESPONSE_CONTRACT); assert.equal(RESPONSE_CONTRACT.endsWith('/3'), true);
  assert.equal(validateResponse(issue, ch, decode(encode(response))).scanStart.execution_id, issue.issueId);
  const value = callbackValue('scan-start', response);
  assert.equal(requireFreshScanStartGrant(f.job, value).receipt_id, g.receipt_id);
  assert.throws(() => requireFreshScanStartGrant(f.job, value, Date.parse(response.expiresAt)), { code: 'SCAN_START_GRANT_REFUSED' });
  assert.throws(() => requireFreshScanStartGrant(f.job, clone(value)), { code: 'SCAN_START_GRANT_REFUSED' });
  const legacy = { ...clone(response), contract: 'clued.independent-ci.protected-job-response/2' };
  assert.throws(() => decode(Buffer.from(JSON.stringify(legacy))));
  assert.throws(() => makeResponse(issue, ch, f.facts(), null));
  const ordinary = makeChallenge(issue, 'admission', 1);
  assert.equal(makeResponse(issue, ordinary, f.facts(), null).scanStart, null);
  assert.throws(() => makeResponse(issue, ordinary, f.facts(), null, { scanStart: g }));
  assert.throws(() => makeResponse(issue, ch, f.facts(), null, { scanStart: { ...g, execution_id: randomUUID() } }));
  assert.equal(JSON.stringify(value).includes('token'), false);
});
async function drive({ native, lostResponse = false, firstAction = 'scan-start', mutateFacts = null, nativeScanStartRequired = true } = {}) {
  const f = setup(); let issue, callbacks = 0, nativeCalls = 0, now = Date.now(); const responses = [];
  const box = { async lock() {}, async write(name, bytes) {
    if (name === 'issue') issue = decode(bytes);
    if (name.startsWith('response-')) { responses.push(decode(bytes)); if (lostResponse) throw Object.assign(new Error('lost'), { code: 'EIO' }); }
  }, async read(name) {
    if (name === 'challenge-01') return encode(makeChallenge(issue, firstAction, 1, { now }));
    if (name === 'challenge-02' && responses.length) return encode(makeChallenge(issue, 'scan-start', 2, { now }));
    return missing();
  } };
  const result = await runIssuer({ nativeScanStartRequired, context: f.context, box, clock: () => now, sleep: async ms => { now += ms; }, stageDeadline: now + 600000,
    collect: async () => null, evaluate: async () => { callbacks++; return mutateFacts ? mutateFacts(f, callbacks) : f.facts(now); },
    scanStart: async args => { nativeCalls++; assert.equal(args.executionId, issue.issueId); assert.equal(args.facts.claimId, issue.admission.claimId);
      return native ? native(args, () => { now += 120001; }) : grant(f.job, args.executionId); } });
  return { result, responses, nativeCalls, callbacks, issue };
}
test('one fixed issue UUID consumes once; repeated scan-start challenge never reinvokes Native', async () => {
  const x = await drive(); assert.equal(x.nativeCalls, 1); assert.equal(x.responses.length, 1);
  assert.equal(x.responses[0].scanStart.execution_id, x.issue.issueId);
  assert.equal(x.result.status, 'UNCERTAIN'); assert.equal(x.result.reason, 'SCAN_START_PORT_OR_ONCE_REQUIRED');
});
test('ordinary admission does not consume; actual scan-start is a separate one-time round', async () => {
  const x = await drive({ firstAction: 'admission', lostResponse: true });
  assert.equal(x.nativeCalls, 0); assert.equal(x.responses[0].scanStart, null);
});
test('lost Native reply, lost response, denied/replay grant and deadline overrun cannot launch or retry begin', async () => {
  for (const options of [
    { native() { throw { code: 'SECRET_NATIVE_TOKEN' }; } }, { lostResponse: true },
    { native: args => ({ status: 'consumed', launch_allowed: false, execution_id: args.executionId, receipt_id: null, reason: 'scan_start_already_consumed' }) },
    { native: (args, expire) => { expire(); return grant(args.job, args.executionId); } },
  ]) { const x = await drive(options); assert.equal(x.nativeCalls, 1); assert.equal(x.result.status, 'UNCERTAIN');
    assert.ok(!JSON.stringify(x.result).includes('SECRET')); if (!options.lostResponse) assert.equal(x.responses.length, 0); }
});
test('a changed admission generation refuses before Native begin', async () => {
  const x = await drive({ mutateFacts: (f, n) => n === 1 ? f.facts() : { ...f.facts(), claimId: randomUUID() } });
  assert.equal(x.nativeCalls, 0); assert.equal(x.responses.length, 0); assert.equal(x.result.status, 'UNCERTAIN');
});
test('all production adapters require the separate start port; a caller fixture flag cannot bypass it', async () => {
  for (const [role, factory] of [['gitleaks', createFormalGitleaksAdapter], ['trivy', createFormalTrivyAdapter], ['contract-placement', createFormalContractPlacementAdapter]]) {
    const f = setup(role), adapter = factory({ admissionPort: async () => f.facts(), remoteRefsPort: async () => null, fixture: true });
    const result = await adapter.execute(f.job, { fixture: true });
    assert.equal(result.status, 'BLOCKED'); assert.match(result.reason, /PORT/); assert.equal(result.observation, undefined);
  }
});

// Task 169fd456: until production activates the Native scan-start policy, this
// Source starts scanners without a Native permission (grant.mjs).
test('this Source does not require Native: an issuer refuses a scan-start challenge and never calls Native', async () => {
  assert.equal(NATIVE_SCAN_START_REQUIRED, false);
  const x = await drive({ nativeScanStartRequired: NATIVE_SCAN_START_REQUIRED });
  assert.equal(x.nativeCalls, 0); assert.equal(x.responses.length, 0);
  assert.equal(x.result.status, 'UNCERTAIN'); assert.equal(x.result.reason, 'SCAN_START_NOT_REQUIRED_BY_SOURCE');
});
test('local start binds the exact job and issue id; Native and local permissions never substitute for each other', () => {
  for (const role of ['gitleaks', 'trivy', 'contract-placement']) {
    const f = setup(role), id = randomUUID(), local = localScanStart(f.job, id);
    assert.ok(Object.isFrozen(local));
    assert.deepEqual({ ...local }, { contract: 'clued.ci-scan-start-not-required/1', native: false, execution_id: id, head_sha: f.job.headSha, role });
    assert.equal(scanStartPermission(f.job, local, false), local);
    assert.equal(scanStartPermission(f.job, local).execution_id, id, 'the Source default is local');
    assert.throws(() => scanStartPermission(f.job, local, true), { code: 'SCAN_START_GRANT_REFUSED' }, 'a local start never passes as Native');
    assert.throws(() => scanStartPermission(f.job, grant(f.job, id), false), { code: 'SCAN_START_GRANT_REFUSED' }, 'a Native grant is not a local start');
    assert.throws(() => scanStartPermission(f.job, { ...local }, false), { code: 'SCAN_START_GRANT_REFUSED' }, 'a plain copy is refused; only frozen values pass');
    for (const mode of ['false', 0, null, undefined, 'true', 1]) if (mode !== undefined)
      assert.throws(() => scanStartPermission(f.job, local, mode), { code: 'SCAN_START_GRANT_REFUSED' }, 'the mode is a boolean or nothing');
    for (const patch of [{ head_sha: 'f'.repeat(40) }, { role: role === 'trivy' ? 'gitleaks' : 'trivy' }, { native: true }, { execution_id: 'not-a-uuid' }, { extra: 1 }]) {
      assert.throws(() => scanStartPermission(f.job, Object.freeze({ ...local, ...patch }), false), { code: 'SCAN_START_GRANT_REFUSED' });
    }
    assert.throws(() => localScanStart(f.job, 'not-a-uuid'), { code: 'SCAN_START_GRANT_REFUSED' });
    assert.throws(() => localScanStart({ ...f.job, role: 'other' }, id), { code: 'SCAN_START_GRANT_REFUSED' });
  }
});
