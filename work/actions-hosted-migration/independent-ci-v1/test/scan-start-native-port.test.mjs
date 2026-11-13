import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeJobV2 } from '../src/job-v2.mjs';
import { digest } from '../src/proof.mjs';
import { createIndependentScanStartPort } from '../src/scan-start-v1/native-port.mjs';
import { admittedFacts, HEAD, BASE } from './resident-v2-fixtures.mjs';
import { scanStartSubjectLine, SCAN_START_SUBJECT_MARKER } from '../src/scan-start-v1/subject.mjs';

function fixture(options = {}) {
  const now = Date.now(), calls = [], executionId = randomUUID();
  const job = makeJobV2({ repo: 'tdoljyj/cross-memory-system', pr: 888, headSha: HEAD, baseSha: BASE,
    sourceManifestSha256: 'e'.repeat(64), testSha: options.testSha ?? HEAD, role: 'gitleaks', attempt: options.attempt ?? 1, createdAt: new Date(now - 1000).toISOString() });
  const claim = { claimId: randomUUID(), fence: 9, epoch: 2, expiresAt: new Date(now + 3600000).toISOString() };
  const packet = { complete: true, pr: job.pr, headSha: HEAD, baseSha: BASE, paths: ['src/b.mjs', 'src/a.mjs'] };
  const facts = admittedFacts(job, claim, packet, { batchClaim: claim, observedAt: now });
  const answer = { status: 'committed', contract: 'clued.ci-scan-start-grant/2', launch_allowed: true,
    execution_id: executionId, receipt_id: randomUUID(), repository_id: 1334673495, head_sha: HEAD,
    role: job.role, provider: 'independent-controller', start_requested_at: new Date(now).toISOString(),
    test_sha: job.testSha, attempt: job.attempt };
  const native = {
    async current(identity, mode) { calls.push(['current', identity, mode]); return options.current?.(calls) ?? true; },
    async command(input) { calls.push(['begin', input]); if (options.throwBegin) throw Error('fixture lost reply'); return options.answer ?? answer; },
  };
  const github = { async readChangedPaths() { calls.push(['paths']); return options.packet ?? packet; } };
  const port = createIndependentScanStartPort({ native, github, registrySha256: 'f'.repeat(64), scope: facts.scope,
    live: options.live ?? (() => {}), clock: () => now });
  return { port, calls, job, facts, executionId, answer, input: { job, facts, executionId } };
}

test('actual controller port rechecks complete facts and current claim around one fixed Native burn', async () => {
  const f = fixture(); assert.deepEqual(await f.port(f.input), f.answer);
  assert.deepEqual(f.calls.map(c => c[0]), ['paths', 'current', 'begin', 'current']);
  const request = f.calls.find(c => c[0] === 'begin')[1];
  assert.equal(request.action, 'scan_start_independent'); assert.equal(request.repository_id, 1334673495);
  assert.equal(request.execution_id, f.executionId); assert.equal(request.claim_id, f.facts.claimId);
  assert.deepEqual(request.changed_paths, ['src/a.mjs', 'src/b.mjs']);
  assert.equal(request.head_sha, HEAD); assert.equal(request.test_sha, HEAD); assert.equal(request.attempt, 1);
  assert.ok(!JSON.stringify(request).includes('token'));
  await assert.rejects(f.port(f.input), { code: 'SCAN_START_ALREADY_ATTEMPTED' });
  assert.equal(f.calls.filter(c => c[0] === 'begin').length, 1);
});

// Task dcc53013: Native's K is the batch (H, S, attempt), so the request names all three. Naming only H made a
// train front batch (S != H) and an attempt 2 find an earlier batch's burn once Native scan-start is required.
test('a train front batch and an attempt 2 ask Native for their own batch identity, not only the head', async () => {
  const S = 'c'.repeat(40);
  for (const [testSha, attempt] of [[S, 1], [S, 2], [HEAD, 2]]) {
    const f = fixture({ testSha, attempt }); assert.deepEqual(await f.port(f.input), f.answer);
    const request = f.calls.find(c => c[0] === 'begin')[1];
    assert.equal(request.head_sha, HEAD); assert.equal(request.base_sha, BASE);
    assert.equal(request.test_sha, testSha); assert.equal(request.attempt, attempt);
  }
});

test('lost Native reply, consumed permission and malformed success cannot mint another launch', async () => {
  for (const options of [{ throwBegin: true }, { answer: { status: 'consumed', launch_allowed: false } },
    { answer: { status: 'committed', launch_allowed: true } }]) {
    const f = fixture(options); await assert.rejects(f.port(f.input));
    await assert.rejects(f.port(f.input), { code: 'SCAN_START_ALREADY_ATTEMPTED' });
    assert.equal(f.calls.filter(c => c[0] === 'begin').length, 1);
  }
});

test('partial paths, subject movement, malformed paths and current-fence loss refuse before the burn', async () => {
  const base = fixture();
  for (const packet of [{ ...base.calls, complete: false }, { complete: true, pr: 888, headSha: BASE, baseSha: BASE, paths: ['a'] },
    { complete: true, pr: 888, headSha: HEAD, baseSha: BASE, paths: ['../escape'] },
    { complete: true, pr: 888, headSha: HEAD, baseSha: BASE, paths: ['a', 'a'] }]) {
    const f = fixture({ packet }); await assert.rejects(f.port(f.input));
    assert.equal(f.calls.filter(c => c[0] === 'begin').length, 0);
  }
  const f = fixture({ current: () => false }); await assert.rejects(f.port(f.input));
  assert.equal(f.calls.filter(c => c[0] === 'begin').length, 0);
});

test('post-burn revocation stops launch while preserving the single consumed attempt', async () => {
  const f = fixture({ current: calls => calls.filter(c => c[0] === 'current').length === 1 });
  await assert.rejects(f.port(f.input)); await assert.rejects(f.port(f.input));
  assert.equal(f.calls.filter(c => c[0] === 'begin').length, 1);
});

test('wrong claim binding or a fake grant with an extra raw field is refused', async () => {
  const f = fixture(); await assert.rejects(f.port({ ...f.input, facts: { ...f.facts, claimId: randomUUID() } }));
  assert.equal(f.calls.length, 0);
  const g = fixture(); const h = fixture({ answer: { ...g.answer, private_data: 'fixture-secret' } });
  await assert.rejects(h.port(h.input));
});

test('public metadata accepts the real first Stage1 production facts with no prior batch generation, without rewriting it', () => {
  const f = fixture(), original = admittedFacts(f.job, f.facts.observedClaim, { complete: true, paths: ['src/a.mjs'] });
  assert.equal(original.batchClaimBound, null);
  const before = JSON.stringify(original), line = scanStartSubjectLine(f.job, original, '9'.repeat(64));
  const data = JSON.parse(line.slice(SCAN_START_SUBJECT_MARKER.length));
  assert.deepEqual(data, { claim_id: original.claimId, fence: original.fence, epoch: original.epoch,
    source_manifest_sha256: f.job.sourceManifestSha256, registry_sha256: '9'.repeat(64) });
  assert.equal(JSON.stringify(original), before);
  assert.throws(() => scanStartSubjectLine(f.job, { ...original, domain: 'fixture' }, '9'.repeat(64)));
  assert.throws(() => scanStartSubjectLine(f.job, original, 'invalid'));
});

// Terminal admission is removed: complete facts have only their fixed fields, so facts that still carry a
// terminalAdmission are not complete facts and never get a scan-start subject.
test('terminal admission removed: facts carrying terminalAdmission get no scan-start subject', () => {
  const f = fixture(), { observationSha256, ...body } = admittedFacts(f.job, f.facts.observedClaim, { complete: true, paths: ['src/a.mjs'] });
  const facts = { ...body, terminalAdmission: { receipt_id: randomUUID(), claim_id: body.claimId, fence: body.fence,
    execution_epoch: body.epoch, lease_version: 5, head_authorization_id: randomUUID() } };
  assert.throws(() => scanStartSubjectLine(f.job, { ...facts, observationSha256: digest(facts) }, '9'.repeat(64)),
    /SCAN_START_SUBJECT_ADMISSION_REQUIRED/);
  assert.ok(scanStartSubjectLine(f.job, { ...body, observationSha256 }, '9'.repeat(64)).startsWith(SCAN_START_SUBJECT_MARKER));
});
