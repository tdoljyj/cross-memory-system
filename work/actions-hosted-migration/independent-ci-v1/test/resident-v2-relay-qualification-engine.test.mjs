// Offline engine lane: the process/SCM boundary is a fixture. No live broker,
// hosted request, admission token, scanner or installed service is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsEngine } from '../../../independent-ci-resident-v1/src/engine-windows.mjs';
import { TEST_NODE, TEST_NODE_SHA } from '../../../independent-ci-resident-v1/test/helpers.mjs';
import { canonical, digest } from '../src/proof.mjs';
import { hash } from '../src/resident-v2/prepare-record.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';
import { makeRelayQualificationRun, relayQualificationSubjectSha256, validateRelayQualificationObservation,
  RELAY_QUALIFICATION_OBSERVATION_CONTRACT, RELAY_QUALIFICATION_WINDOW_CONTRACT,
  RELAY_QUALIFICATION_AUTHORITY_ID, RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS } from '../src/resident-v2/relay-qualification-run.mjs';
import { NOW, tempDir } from './resident-v2-fixtures.mjs';

const h = c => c.repeat(64), s = c => c.repeat(40), n = c => c.repeat(32);
const OWNER = '11111111-2222-3333-4444-555555555555';
const SOURCE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SC_QC = 'BINARY_PATH_NAME : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\nSTART_TYPE : 3 DEMAND_START\r\nSERVICE_START_NAME : .\\clued-control\r\n';
const SC_Q = 'STATE : 1 STOPPED\r\nPID : 0\r\n';

function observation(job) {
  const roles = ['gitleaks', 'trivy'].map((role, i) => {
    const verifiedClaims = { iss: 'https://token.actions.githubusercontent.com', aud: 'clued-independent-ci',
      repository: job.repo, run_id: String(42 + i), run_attempt: '1', sha: s('6'), workflow_sha: s('6'), iat: NOW / 1000 };
    return { role, verdict: 'ATTESTED_SUCCESS', checkRunId: 42 + i, workflowRunId: String(42 + i), runAttempt: '1',
      annotationsComplete: true, identityAnnotationCount: 1, totalAnnotationCount: 1, fullAnnotationsSha256: h('1'),
      tokenPresent: true, tokenSha256: h('2'), signatureVerified: true, verifiedClaims, claimsSha256: hash(canonical(verifiedClaims)),
      checkRunIdClaimPresent: false, registryBindsCheckRunId: false, keyThumbprintSha256: h('3'), attestationSha256: h('4') };
  });
  return validateRelayQualificationObservation({ contract: RELAY_QUALIFICATION_OBSERVATION_CONTRACT,
    jobId: job.id, phase: job.phase, subjectSha256: relayQualificationSubjectSha256(job), observedAt: new Date(NOW).toISOString(),
    liveQualified: false, roles, refObservation: { ref: `refs/pull/${job.pr}/merge`, beforeMergeSha: s('6'),
      afterMergeSha: job.phase === 'initial' ? s('6') : s('7'), oldMergeReadable: true },
    jwksObservation: { networkFetched: true, sha256: h('5') } }, job);
}
async function fixture(t, options = {}) {
  const root = await tempDir(t, 'clued-relay-engine-');
  const base = { repo: 'tdoljyj/cross-memory-system', pr: 987, headSha: s('a'), baseSha: s('b'), testSha: s('a'),
    sourceManifestSha256: h('c'), createdAt: new Date(NOW).toISOString() };
  const stage1 = makeJobV2({ ...base, role: 'work-admission', attempt: 1 });
  const full = makeRelayQualificationRun({ ...base, runId: 'aaaaaaaaaaaaaaaa-bbbbbbbbbbbb', nodeProfileSha256: TEST_NODE_SHA,
    claimId: OWNER, fence: 7, executionEpoch: 2, stage1JobId: stage1.id, stage1OutcomeNonce: n('d'), stage1OutcomeSha256: h('e'),
    phase: 'initial', priorObservationNonce: null, priorObservationSha256: null });
  const q = { contract: RELAY_QUALIFICATION_WINDOW_CONTRACT, qualificationRef: 'receipt:' + OWNER,
    sourceManifestSha256: full.sourceManifestSha256, ownerReceiptRef: OWNER, authorityDecisionId: RELAY_QUALIFICATION_AUTHORITY_ID,
    authorityDecisionSha256: h('8'), authorityReadReceiptRef: OWNER,
    subject: Object.fromEntries(RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS.map(k => [k, full[k]])),
    validUntil: new Date(NOW + 3_600_000).toISOString(), allowedPhases: ['initial', 'after-ref-move'], executionPolicy: 'staged', guarded: false,
    changedPaths: ['src/fixture.mjs'], changedPathsSha256: digest(['src/fixture.mjs']) };
  const stage1Locator = { nonce: full.stage1OutcomeNonce, outcomeSha256: full.stage1OutcomeSha256,
    nativeReceiptSha256: h('f'), jobId: stage1.id };
  const calls = [], invocations = [];
  const run = async (argv, limits) => {
    calls.push({ argv, limits });
    if (argv[0] === 'sc.exe') return { code: 0, stdout: argv[1] === 'qc' ? SC_QC
      : options.runnerLive || options.runnerLiveAfter && invocations.length > 0 ? 'STATE : 4 RUNNING\r\nPID : 123\r\n' : SC_Q };
    assert.ok(argv[1].endsWith('invoke-stage.mjs'));
    if (argv[2] === '--relay-qualification-window') {
      await options.onWindow?.();
      return { code: 0, stdout: JSON.stringify({ authority: 'RESTRICTIVE_HOLD_ONLY',
        sourceManifestSha256: q.sourceManifestSha256, nodeProfileSha256: TEST_NODE_SHA, window: q }) };
    }
    assert.equal(argv.length, 9);
    assert.equal(argv[2], '--relay-qualification'); assert.equal(argv[3], '--run-key');
    assert.equal(argv[5], '--subject-file'); assert.equal(argv[7], '--subject-sha256');
    const runKey = argv[4], file = argv[6], subjectText = await fs.readFile(file, 'utf8'), job = JSON.parse(subjectText);
    assert.equal(subjectText, canonical(job)); assert.ok(!subjectText.endsWith('\n'));
    assert.equal(hash(subjectText), argv[8]); assert.match(runKey, /^[a-f0-9]{64}$/);
    assert.ok(runKey.startsWith(q.subject.runId.slice(0, 16)));
    const intentText = await fs.readFile(path.join(root, 'relay-qualification', `intent-${job.id}.json`), 'utf8');
    const intent = JSON.parse(intentText);
    assert.equal(intent.jobId, job.id); assert.equal(intent.subjectSha256, argv[8]);
    assert.ok(!intentText.includes(runKey), 'durable public intent never stores the run key');
    const manifest = hash(canonical({ contract: 'clued.independent-ci.relay-qualification-intent/1', runKey, job }));
    assert.equal(intent.workManifestSha256, manifest, 'durable intent precedes the process boundary');
    invocations.push({ job, file, intent, runKey });
    if (options.timedOut) return { code: null, timedOut: true, stdout: '' };
    const fact = { contract: 'clued.independent-ci.resident-stage-fact/2', stage: 13, nonce: n('e'), manifest_sha256: manifest,
      state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null, scm_start_call_issued: true,
      original_binary_restored: true, complete_original_readback: true, configuration_conflict_detected: false,
      tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true, native_receipt_sha256: h('5'),
      outcome: { status: 'RELAY_QUALIFICATION_OBSERVATION', reason: null, sideEffects: 0, mayHavePublished: false },
      observation: JSON.parse(JSON.stringify(observation(job))), observationLocator: { nonce: n('e'), outcomeSha256: h('6'), nativeReceiptSha256: h('5'), jobId: job.id } };
    options.mutate?.(fact);
    return { code: 0, stdout: JSON.stringify(fact) };
  };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run,
    busy: () => options.busy ?? false, clock: () => NOW,
    paths: { sourceRoot: SOURCE_ROOT, workRoot: root, nodeExe: 'node.exe', scExe: 'sc.exe' } });
  return { engine, q, stage1Locator, calls, invocations, root };
}

test('busy/inflight engine never starts any process and a live original runner is never stopped', async t => {
  const busy = await fixture(t, { busy: true });
  assert.equal((await busy.engine.runRelayQualification({ stage1Locator: busy.stage1Locator })).deferred, true);
  assert.equal(busy.calls.length, 0);
  const inflight = await fixture(t); inflight.engine.inflight = { stage: 2 };
  assert.equal((await inflight.engine.runRelayQualification({ stage1Locator: inflight.stage1Locator })).deferred, true);
  assert.equal(inflight.calls.length, 0);
  const live = await fixture(t, { runnerLive: true });
  assert.equal((await live.engine.runRelayQualification({ stage1Locator: live.stage1Locator })).code, 'RELAY_QUALIFICATION_BUSY');
  assert.equal(live.invocations.length, 0);
  assert.ok(live.calls.every(c => !['stop', 'start', 'config'].includes(c.argv[1])));
});
test('expired installed window or wrong Stage1 subject cannot reach the Stage13 process', async t => {
  const expired = await fixture(t); expired.q.validUntil = new Date(NOW).toISOString();
  assert.equal((await expired.engine.runRelayQualification({ stage1Locator: expired.stage1Locator })).ok, false);
  assert.equal(expired.invocations.length, 0);
  const wrong = await fixture(t);
  assert.equal((await wrong.engine.runRelayQualification({ stage1Locator: { ...wrong.stage1Locator, jobId: h('0') } })).ok, false);
  assert.equal(wrong.invocations.length, 0);
});
test('a concurrent qualification defers without another metadata or Stage13 process', async t => {
  let release, reached;
  const wait = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
  const x = await fixture(t, { onWindow: async () => { reached(); await wait; } });
  const first = x.engine.runRelayQualification({ stage1Locator: x.stage1Locator });
  await ready;
  const second = await x.engine.runRelayQualification({ stage1Locator: x.stage1Locator });
  assert.equal(second.deferred, true); assert.equal(x.calls.length, 1);
  release(); assert.equal((await first).ok, true); assert.equal(x.invocations.length, 1);
});
test('fixed argv, fsynced exact job and durable intent produce only a typed observation/locator', async t => {
  const x = await fixture(t), result = await x.engine.runRelayQualification({ stage1Locator: x.stage1Locator });
  assert.equal(result.ok, true); assert.equal(result.liveQualified, false);
  assert.equal(result.state, 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION');
  assert.equal(result.observation.jobId, x.invocations[0].job.id);
  assert.deepEqual(Object.keys(result.observationLocator).sort(), ['jobId', 'nativeReceiptSha256', 'nonce', 'outcomeSha256']);
  assert.ok(!JSON.stringify(result).includes(x.invocations[0].runKey));
  assert.equal(x.calls.filter(c => c.argv[0] === 'sc.exe').length, 4);
  const after = await x.engine.runRelayQualification({ stage1Locator: x.stage1Locator, phase: 'after-ref-move', priorObservation: result });
  assert.equal(after.ok, true); assert.equal(after.observation.phase, 'after-ref-move'); assert.equal(after.liveQualified, false);
  assert.notEqual(after.observationLocator.jobId, result.observationLocator.jobId);
});
for (const [name, mutate] of [
  ['missing locator', f => delete f.observationLocator], ['wrong locator job', f => f.observationLocator.jobId = h('0')],
  ['wrong native receipt hash', f => f.observationLocator.nativeReceiptSha256 = h('0')],
  ['wrong observation subject', f => f.observation.subjectSha256 = h('0')], ['qualification flag', f => f.observation.liveQualified = true],
  ['nonzero effects', f => f.outcome.sideEffects = 1], ['wrong stage', f => f.stage = 12],
  ['unclean tree', f => f.tree_active_processes = 1],
]) test(`malformed ${name} never passes the installed engine read lane`, async t => {
  const x = await fixture(t, { mutate }), result = await x.engine.runRelayQualification({ stage1Locator: x.stage1Locator });
  assert.equal(result.ok, false); assert.equal(result.liveQualified, false); assert.equal(result.observation, null);
  assert.equal(x.invocations.length, 1);
});
test('timeout is durable and cannot repost the same job or fall back to any scan', async t => {
  const x = await fixture(t, { timedOut: true });
  assert.equal((await x.engine.runRelayQualification({ stage1Locator: x.stage1Locator })).ok, false);
  assert.equal((await x.engine.runRelayQualification({ stage1Locator: x.stage1Locator })).ok, false);
  assert.equal(x.invocations.length, 1);
  assert.ok(x.calls.every(c => c.argv[0] === 'sc.exe' || c.argv[1].endsWith('invoke-stage.mjs')));
});
test('unconfirmed facts consume the durable attempt and a changed independent SCM cannot pass', async t => {
  const unknown = await fixture(t, { mutate: fact => delete fact.observation });
  assert.equal((await unknown.engine.runRelayQualification({ stage1Locator: unknown.stage1Locator })).ok, false);
  assert.equal((await unknown.engine.runRelayQualification({ stage1Locator: unknown.stage1Locator })).ok, false);
  assert.equal(unknown.invocations.length, 1);
  const scm = await fixture(t, { runnerLiveAfter: true });
  assert.equal((await scm.engine.runRelayQualification({ stage1Locator: scm.stage1Locator })).ok, false);
});
test('untrusted qualification flags or prior locators cannot confer live authority', async t => {
  const flags = await fixture(t, { mutate: fact => { fact.liveQualified = true; fact.host_qualification = true; } });
  const first = await flags.engine.runRelayQualification({ stage1Locator: flags.stage1Locator });
  assert.equal(first.ok, true); assert.equal(first.liveQualified, false);
  assert.equal(Object.hasOwn(first, 'host_qualification'), false);
  const bad = { ...first, observationLocator: { ...first.observationLocator, jobId: h('0') } };
  assert.equal((await flags.engine.runRelayQualification({ stage1Locator: flags.stage1Locator,
    phase: 'after-ref-move', priorObservation: bad })).ok, false);
  assert.equal(flags.invocations.length, 1);
  const fake = await fixture(t);
  assert.equal((await fake.engine.runRelayQualification({ stage1Locator: { ...fake.stage1Locator, liveQualified: true } })).ok, false);
  assert.equal(fake.invocations.length, 0);
});
