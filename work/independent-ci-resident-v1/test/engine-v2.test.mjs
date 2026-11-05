// The Windows engine against the Source v2 entry points (fixed argv, descriptor /3, refs gate, stage fact /2).
// The Source entries are faked at the runner boundary; the real ones are tested in their own suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WindowsEngine, DESCRIPTOR_CONTRACT, parseStageFact, parseStageOutcome } from '../src/engine-windows.mjs';
import { canonicalJson, sha256 } from '../src/canonical.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot, rawPolicy, HEAD, BASE, SOURCE } from './helpers.mjs';

const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
const KEY = 'a1'.repeat(32);
const fact = (o = {}) => ({ contract: 'clued.independent-ci.resident-stage-fact/2', stage: 1, nonce: 'n'.repeat(32), manifest_sha256: 'f'.repeat(64),
  state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null, scm_start_call_issued: true, original_binary_restored: true,
  complete_original_readback: true, configuration_conflict_detected: false, tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true,
  native_receipt_sha256: 'e'.repeat(64), outcome: { status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true }, ...o });
const SC_QC = 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n        START_TYPE         : 3   DEMAND_START\r\n        SERVICE_START_NAME : .\\clued-control\r\n';
const SC_Q = 'STATE              : 1  STOPPED\r\n        PID                : 0\r\n';

async function engineFixture(t, { answers = {}, stdout = {}, testSha = null, trainMode = undefined } = {}) {
  const root = await tempRoot(t);
  const sourceRoot = path.join(root, 'source', 'e'.repeat(64));
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  for (const n of ['derive-batch.mjs', 'invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(sourceRoot, ...V2, n), '// fixture');
  const runs = [], sent = [];
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: 'f'.repeat(64), directory: `stage-0${n}`, linuxWorker: [2, 4, 6].includes(n) }));
  const run = async argv => {
    runs.push(argv);
    if (argv[0].endsWith('sc.exe')) return { code: 0, stdout: argv[1] === 'qc' ? SC_QC : SC_Q };
    if (argv[1].endsWith('derive-batch.mjs') && argv.includes('--train-run')) {
      const at = k => argv[argv.indexOf(k) + 1];
      return { code: 0, stdout: JSON.stringify({ status: 'RESIDENT_TRAIN_RUN_DERIVED', runKey: at('--train-key'), runId: at('--train-run'), mode: at('--mode'),
        stage: { number: 10, jobId: '7'.repeat(64), workManifestSha256: 'f'.repeat(64), directory: 'stage-10', runMilliseconds: 300000, linuxWorker: false } }) };
    }
    if (argv[1].endsWith('derive-batch.mjs')) {
      const id = argv[argv.indexOf('--batch-id') + 1];
      return { code: 0, stdout: JSON.stringify({ status: 'RESIDENT_BATCH_DERIVED', batchKey: KEY, batchId: id, packageSha256: 'c'.repeat(64), ciSourceManifestSha256: 'e'.repeat(64),
        sourceCommit: 'd'.repeat(40), gitleaksTomlSha256: '9'.repeat(64), testSha: testSha ?? (s => s.testSha ?? s.headSha)(JSON.parse(argv[argv.indexOf('--subject-json') + 1])), stages: rows }) };
    }
    if (argv[1].endsWith('invoke-stage.mjs')) return { code: 0, stdout: JSON.stringify(stdout[argv[argv.indexOf('--stage') + 1]] ?? fact()) };
    throw new Error('unexpected argv ' + argv.join(' '));
  };
  const companionMailbox = {
    async send(kind, fields) { sent.push([kind, fields]); return { kind, fields }; },
    async await(req) { return Object.hasOwn(answers, req.kind) ? answers[req.kind] : { ok: true, code: null }; },
  };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, companionMailbox, sleep: async () => {}, clock: () => Date.parse('2026-10-21T08:00:00Z'),
    ...(trainMode === undefined ? {} : { trainMode }),
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe',
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe' } });
  return { root, engine, runs, sent };
}
const subject = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 2 };
const stages = validatePolicy(rawPolicy()).stages;

test('issuer diagnostics: resident second filter retains only allowed issuer context and never grants a retry', () => {
  const diagnostic = { verdict: 'REJECTED', nativeVerdict: 'ERROR', ownerReviewKind: 'refused', reasonCodes: ['owner_grant_required'],
    nativeReasonCodes: ['path_outside_write_set'], phase: 'changed_paths', transientAdmission: 'full_admission_unavailable', evaluations: 4,
    workflowGateFindingsPresent: true, modeFresh: false, recorderFresh: true, transport: true, rawBody: 'sensitive-details-must-not-survive' };
  const input = { status: 'UNCERTAIN', reason: 'full_admission_rejected', sideEffects: 1, mayHavePublished: true, safeToRerun: true, diagnostic };
  const r = parseStageOutcome(input);
  for (const key of ['ownerReviewKind', 'phase', 'transientAdmission', 'evaluations', 'workflowGateFindingsPresent', 'modeFresh', 'recorderFresh', 'transport'])
    assert.deepEqual(r.diagnostic[key], diagnostic[key], key);
  assert.equal(Object.hasOwn(r.diagnostic, 'rawBody'), false);
  assert.equal(r.safeToRerun, false);
  for (const evaluations of [0, -1, 5, 1.5, '4', Infinity])
    assert.equal(Object.hasOwn(parseStageOutcome({ ...input, diagnostic: { ...diagnostic, evaluations } }).diagnostic, 'evaluations'), false);
  const forged = parseStageOutcome({ ...input, diagnostic: { transientAdmission: 'full_admission_rejected', evaluations: 4,
    ownerReviewKind: 'private_kind', phase: 'private_phase' } });
  for (const key of ['transientAdmission', 'evaluations', 'ownerReviewKind', 'phase']) assert.equal(Object.hasOwn(forged.diagnostic, key), false);
});

test('derive passes the v2 subject (with createdAt) and writes the public descriptor /3', async t => {
  const f = await engineFixture(t);
  const batch = await f.engine.derive(subject, KEY);
  const argv = f.runs[0];
  assert.equal(argv[0], 'C:\\resident\\runtime\\node.exe');
  const sent = JSON.parse(argv[argv.indexOf('--subject-json') + 1]);
  assert.deepEqual(Object.keys(sent).sort(), ['attempt', 'baseSha', 'createdAt', 'headSha', 'pr', 'repo', 'sourceManifestSha256']);
  const d = JSON.parse(await fs.readFile(path.join(f.root, 'outbox', batch.batchId, 'descriptor.json'), 'utf8'));
  assert.equal(d.contract, DESCRIPTOR_CONTRACT);
  // quota phase 2 step 3b: the descriptor names the tested commit, the head itself for a subject without S
  assert.equal(DESCRIPTOR_CONTRACT, 'clued.independent-ci.resident-batch-descriptor/3');
  assert.deepEqual([d.headSha, d.testSha], [subject.headSha, subject.headSha]);
  assert.deepEqual([d.attempt, d.ciSourceManifestSha256, d.sourceCommit, d.gitleaksTomlSha256, d.linuxJobIds.length], [2, 'e'.repeat(64), 'd'.repeat(40), '9'.repeat(64), 3]);
  assert.equal(d.createdAt, sent.createdAt);
  // the descriptor's S is the derivation's; a derivation that names another S than the subject's is refused
  const other = await engineFixture(t, { testSha: '4'.repeat(40) });
  await assert.rejects(other.engine.derive(subject, KEY), e => e.code === 'RESIDENT_DERIVATION_REFUSED');
});

test('derive (step 3c-2a): a train front batch sends its S with the subject and its descriptor names that S', async t => {
  const S = '4'.repeat(40), front = { ...subject, testSha: S };
  const f = await engineFixture(t);
  const batch = await f.engine.derive(front, KEY);
  const sent = JSON.parse(f.runs[0][f.runs[0].indexOf('--subject-json') + 1]);
  assert.deepEqual(Object.keys(sent).sort(), ['attempt', 'baseSha', 'createdAt', 'headSha', 'pr', 'repo', 'sourceManifestSha256', 'testSha']);
  assert.equal(sent.testSha, S);
  const d = JSON.parse(await fs.readFile(path.join(f.root, 'outbox', batch.batchId, 'descriptor.json'), 'utf8'));
  assert.deepEqual([d.headSha, d.baseSha, d.testSha], [HEAD, BASE, S]);
  // a derivation that reports the head (or any other commit) for a front subject is refused
  for (const testSha of [HEAD, '5'.repeat(40)]) {
    const g = await engineFixture(t, { testSha });
    await assert.rejects(g.engine.derive(front, KEY), e => e.code === 'RESIDENT_DERIVATION_REFUSED');
  }
});

test('stages run through node invoke-stage.mjs with fixed argv; the v2 fact is parsed', async t => {
  const f = await engineFixture(t);
  const batch = await f.engine.derive(subject, KEY);
  const r = await f.engine.runStage(batch, stages[0]);
  assert.equal(r.ok, true);
  const argv = f.runs.find(a => a[1]?.endsWith('invoke-stage.mjs'));
  assert.deepEqual(argv.slice(2), ['--batch-dir', batch.dir, '--stage', '1', '--work-manifest-sha256', 'f'.repeat(64), '--batch-key', KEY]);
  assert.equal(parseStageFact(JSON.stringify(fact({ contract: 'clued.independent-ci.resident-stage-fact/9' })), 'f'.repeat(64)).code, 'STAGE_TERMINAL_UNCONFIRMED');
  const failed = parseStageFact(JSON.stringify(fact({ state: 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED', failure_code: 'BATCH_CLAIM_CHANGED' })), 'f'.repeat(64));
  assert.deepEqual([failed.ok, failed.code], [false, 'BATCH_CLAIM_CHANGED']);
});

test('the train mode channel (DESIGN §41.2): the installed policy reaches stage 8 (and 1) as train-mode.json; off, shadow and none read off, shadow, off', async t => {
  const { installedTrainMode } = await import('../src/engine-windows.mjs');
  const { POLICY_CONTRACT_V8, TRAIN_DEFAULTS } = await import('../src/policy.mjs');
  const { prepareStageDirectory } = await import('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/invoke-stage.mjs');
  const { readStageTrainMode, stageTrainModeText, STAGE_TRAIN_MODE_FILE } = await import('../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-mode.mjs');
  const v8 = enabled => validatePolicy(rawPolicy({ contract: POLICY_CONTRACT_V8, train: { enabled, nonFrontRuns: true, maintenanceEveryMs: 600000, maintenanceMaxPerDay: 200, ...TRAIN_DEFAULTS } }));
  const cases = [[v8('on'), 'on'], [v8('shadow'), 'shadow'], [v8('off'), 'off'], [validatePolicy(rawPolicy()), installedTrainMode(validatePolicy(rawPolicy()))], [null, 'off']];
  for (const [i, [policy, expected]] of cases.entries()) {
    const f = await engineFixture(t, policy ? { trainMode: installedTrainMode(policy) } : {});
    const batch = await f.engine.derive(subject, KEY);
    for (const stage of [stages[0], stages[1], stages[7]]) await f.engine.runStage(batch, stage);
    const invoked = f.runs.filter(a => a[1]?.endsWith('invoke-stage.mjs'));
    const modeOf = a => (a.includes('--train-mode') ? a[a.indexOf('--train-mode') + 1] : null);
    assert.deepEqual(invoked.map(a => a[a.indexOf('--stage') + 1]), ['1', '2', '8']);
    assert.equal(modeOf(invoked[1]), null, 'only stages 1 and 8 carry it');
    // the invoker writes what it was given into the stage directory; the stage reads it there
    for (const [n, argv] of [[1, invoked[0]], [8, invoked[2]]]) {
      const dir = await prepareStageDirectory({ stageRoot: f.root, nonce: `${i}${n}`.padEnd(32, '0'), sealed: { files: { 'formal-service-entry.json': Buffer.from('{}'), 'jobs.json': Buffer.from('[]') } },
        trainMode: modeOf(argv) });
      assert.equal(await readStageTrainMode(dir), expected, `stage ${n}, ${expected}`);
      const files = (await fs.readdir(dir)).sort();
      if (policy) assert.equal(await fs.readFile(path.join(dir, STAGE_TRAIN_MODE_FILE), 'utf8'), stageTrainModeText(expected));
      else assert.deepEqual(files, ['formal-service-entry.json', 'jobs.json'], 'no port: no file, read as off');
    }
  }
  assert.throws(() => new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run: async () => ({}), trainMode: 'ON' }), { code: 'RESIDENT_TRAIN_MODE_INVALID' });
});

test('stage 2 first proves no push since the bundle; a moved ref ends the stage cleanly before anything runs', async t => {
  const f = await engineFixture(t, { answers: { 'check-refs': { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' } } });
  const batch = await f.engine.derive(subject, KEY);
  const r = await f.engine.runStage(batch, stages[1]);
  assert.deepEqual([r.ok, r.code, r.proof.windowsTreeZero, r.proof.serviceOriginalStopped], [false, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', true, true]);
  assert.equal(f.runs.some(a => a[1]?.endsWith('invoke-stage.mjs')), false, 'no stage was invoked');
  assert.equal(f.sent.some(([k]) => k === 'relay-stage'), false, 'no relay was started');
  const g = await engineFixture(t, { answers: { 'check-refs': null } });
  const r2 = await g.engine.runStage(await g.engine.derive(subject, KEY), stages[1]);
  assert.equal(r2.code, 'REFS_GATE_UNCONFIRMED', 'no answer is a final refusal (never success, never an attempt-2 transient)');
  const h = await engineFixture(t);
  const r3 = await h.engine.runStage(await h.engine.derive(subject, KEY), stages[1]);
  assert.equal(r3.ok, true);
  // DESIGN §32: the memory gate reads once right before the stage (a default answer carries no reading: the stage runs as before)
  assert.deepEqual(h.sent.map(([k]) => k), ['check-refs', 'memory-ready', 'relay-stage']);
});

test('stage 10 (quota phase 2 step 3c-1): a train run derived into work\train and run as stage 10; the fact carries the train facts', async t => {
  const train = { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: '2026-10-21T08:00:00.000Z', wouldDo: 'NO_FRONT', front: null };
  const f = await engineFixture(t, { stdout: { 10: fact({ stage: 10, outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: 0, mayHavePublished: false }, train }) } });
  const r = await f.engine.runTrainStage('shadow');
  assert.deepEqual([r.ok, r.train, r.outcome.status], [true, train, 'TRAIN_FACTS']);
  const derive = f.runs.find(a => a.includes('--train-run'));
  const key = derive[derive.indexOf('--train-key') + 1], runId = derive[derive.indexOf('--train-run') + 1];
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(runId.slice(0, 16), key.slice(0, 16));
  assert.equal(r.runId, runId);
  assert.equal(derive[derive.indexOf('--out') + 1], path.join(f.root, 'work', 'train', runId));
  const invoke = f.runs.find(a => a[1].endsWith('invoke-stage.mjs'));
  assert.deepEqual([invoke[invoke.indexOf('--stage') + 1], invoke[invoke.indexOf('--batch-key') + 1]], ['10', key]);
  assert.equal(f.sent.length, 0, 'no companion request: Windows only, no relay pump');
  await assert.rejects(f.engine.runTrainStage('on'), e => e.code === 'RESIDENT_TRAIN_MODE_INVALID');
});

test('stage 10 (step 3c-2b): the train-run /2 params go as --train-params (the job\'s param order); a mode that does not match them is refused', async t => {
  const { trainRunInput } = await import('../src/train.mjs');
  const { TRAIN_DEFAULTS } = await import('../src/policy.mjs');
  const { TRAIN_RUN_PARAMS } = await import('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/train-run.mjs');
  const train = { contract: 'clued.independent-ci.train-facts/2', mode: 'on', at: '2026-10-21T08:00:00.000Z', wouldDo: 'NO_FRONT', front: null };
  const f = await engineFixture(t, { stdout: { 10: fact({ stage: 10, outcome: { status: 'TRAIN_FACTS', reason: null, sideEffects: 2, mayHavePublished: true }, train }) } });
  const input = trainRunInput({ mode: 'on', settings: TRAIN_DEFAULTS, onSince: Date.parse('2026-10-21T07:00:00Z'), revokeHeadRequestId: '0a1b2c3d-0000-4000-8000-0000000000aa' });
  const r = await f.engine.runTrainStage('on', input);
  assert.equal(r.ok, true);
  const derive = f.runs.find(a => a.includes('--train-run'));
  assert.equal(derive[derive.indexOf('--mode') + 1], 'on');
  const params = JSON.parse(derive[derive.indexOf('--train-params') + 1]);
  assert.deepEqual(Object.keys(params), [...TRAIN_RUN_PARAMS]);
  assert.deepEqual([params.onSince, params.revokeHeadRequestId, params.frontPr], ['2026-10-21T07:00:00.000Z', '0a1b2c3d-0000-4000-8000-0000000000aa', null]);
  await assert.rejects(f.engine.runTrainStage('shadow', input), e => e.code === 'RESIDENT_TRAIN_MODE_INVALID');
  await assert.rejects(f.engine.runTrainStage('on', { ...input, onSince: null }), e => e.code === 'RESIDENT_TRAIN_MODE_INVALID');
});

test('WindowsEngine requires the pinned full node before any process port and queries only its runner service', async () => {
  let effects = 0;
  const run = async a => { effects++; assert.equal(a[2], TEST_NODE.runnerService); return { code: 0, stdout: a[1] === 'qc' ? SC_QC : SC_Q }; };
  assert.throws(() => new WindowsEngine({ run }), { code: 'NODE_PROFILE_PIN_CHANGED' });
  assert.throws(() => new WindowsEngine({ run, node: { ...TEST_NODE, hostname: 'OTHER' }, nodeProfileSha256: TEST_NODE_SHA }));
  assert.equal(effects, 0);
  const e = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, paths: { scExe: 'C:\\Windows\\System32\\sc.exe' } });
  assert.equal(await e.scReadback(), true); assert.equal(effects, 2);
});
test('C2 engine refuses busy/live runner before invoking broker and uses no companion', async t => {
  const f = await engineFixture(t); f.engine.busy = () => true;
  assert.equal((await f.engine.runRoleProbe()).deferred, true); assert.equal(f.runs.length, 0); assert.equal(f.sent.length, 0);
  f.engine.busy = () => false; f.engine.scReadback = async () => false;
  assert.equal((await f.engine.runRoleProbe()).deferred, true); assert.equal(f.runs.length, 0);
});
test('C2 engine intent manifest is independently computed; full cleanup/outcome is retained', async t => {
  const f = await engineFixture(t); let invoked = 0;
  f.engine.scReadback = async () => true;
  f.engine.run = async a => {
    invoked++; assert.equal(a[2], '--role-probe');
    const runKey = a[3], runId = a[5], nodeProfileSha256 = a[7];
    const manifest = sha256(Buffer.from(canonicalJson({ contract: 'clued.independent-ci.role-probe-intent/1', runKey, runId, nodeProfileSha256 })));
    return { code: 0, stdout: JSON.stringify(fact({ stage: 11, manifest_sha256: manifest, roleProbe: { result: 'held', code: 'ROLE_PROBE_HELD' },
      outcome: { status: 'BLOCKED', reason: 'ROLE_PROBE_HELD', sideEffects: 0, mayHavePublished: false } })) };
  };
  const r = await f.engine.runRoleProbe(); assert.equal(r.ok, true); assert.equal(r.roleProbe.result, 'held'); assert.equal(invoked, 1); assert.equal(f.sent.length, 0);
});
test('generation 12: the queue watch only with an installed Source that knows role-probe-run/2 (the real file does)', async t => {
  const f = await engineFixture(t);
  assert.equal(await f.engine.queueWatchSupported(), false, 'no role-probe-run.mjs in the fixture Source');
  const copyReal = async (e, names) => {
    await fs.mkdir(path.dirname(e.v2(path.join('windows', 'x'))), { recursive: true });
    for (const n of names) await fs.copyFile(new URL(`../../actions-hosted-migration/independent-ci-v1/src/resident-v2/${n}`, import.meta.url), e.v2(n));
  };
  const half = await engineFixture(t);
  await copyReal(half.engine, ['role-probe-run.mjs']);
  assert.equal(await half.engine.queueWatchSupported(), false, 'the session-0 helper must know /2 too');
  const g = await engineFixture(t);
  await copyReal(g.engine, ['role-probe-run.mjs', path.join('windows', 'FormalPublicBoundaryV2.cs')]);
  assert.equal(await g.engine.queueWatchSupported(), true);
  const old = await engineFixture(t);
  await fs.writeFile(old.engine.v2('role-probe-run.mjs'), "export const ROLE_PROBE_RUN_CONTRACT = 'clued.independent-ci.role-probe-run/1';");
  assert.equal(await old.engine.queueWatchSupported(), false);
});
test('generation 12: a queue watch is intent /2 with --watch-pr; a bad PR number watches nothing (/1)', async t => {
  const f = await engineFixture(t); const seen = [];
  f.engine.scReadback = async () => true;
  f.engine.run = async a => {
    seen.push(a.slice(2));
    const runKey = a[3], runId = a[5], nodeProfileSha256 = a[7], watchPr = a[8] === '--watch-pr' ? Number(a[9]) : null;
    const manifest = sha256(Buffer.from(canonicalJson(watchPr === null ? { contract: 'clued.independent-ci.role-probe-intent/1', runKey, runId, nodeProfileSha256 }
      : { contract: 'clued.independent-ci.role-probe-intent/2', runKey, runId, nodeProfileSha256, watchPr })));
    const code = watchPr === null ? 'ROLE_PROBE_HELD' : 'ROLE_PROBE_HELD_WATCHED_HEAD';
    return { code: 0, stdout: JSON.stringify(fact({ stage: 11, manifest_sha256: manifest, roleProbe: { result: 'held', code },
      outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false } })) };
  };
  const w = await f.engine.runRoleProbe({ watchPr: 884 });
  assert.equal(w.ok, true); assert.equal(w.roleProbe.code, 'ROLE_PROBE_HELD_WATCHED_HEAD');
  assert.deepEqual(seen[0].slice(6), ['--watch-pr', '884']);
  for (const bad of [0, -1, 1.5, '884', 10_000_000_000]) {
    const r = await f.engine.runRoleProbe({ watchPr: bad });
    assert.equal(r.ok, true); assert.equal(seen.at(-1).length, 6, String(bad));
  }
});

// Review round 32, NIT 2: the role-probe intent's manifest is computed on both sides, by the resident (engine-windows.mjs#runRoleProbe:
// canonical.mjs) and by the Source (invoke-stage.mjs#invokeRoleProbe: proof.mjs#canonical, prepare-record.mjs#hash); a fact is accepted
// only when they match. Both, byte for byte, for /1 and for /2 with watchPr at its bounds.
test('review round 32: the resident and the Source hash the role-probe intent /1 and /2 alike', async () => {
  const { canonical } = await import('../../actions-hosted-migration/independent-ci-v1/src/proof.mjs');
  const { hash } = await import('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs');
  const runKey = 'a'.repeat(64), runId = `${'a'.repeat(16)}-${'b'.repeat(12)}`, nodeProfileSha256 = 'c'.repeat(64);
  const intents = [{ contract: 'clued.independent-ci.role-probe-intent/1', runKey, runId, nodeProfileSha256 },
    ...[1, 884, 9_999_999_999].map(watchPr => ({ contract: 'clued.independent-ci.role-probe-intent/2', runKey, runId, nodeProfileSha256, watchPr }))];
  for (const intent of intents) {
    assert.equal(canonical(intent), canonicalJson(intent), JSON.stringify(intent));
    assert.equal(hash(canonical(intent)), sha256(Buffer.from(canonicalJson(intent))), JSON.stringify(intent));
  }
});

test('review round 33: a failed read of the installed Source (not a missing file) is no for now, and read again after a while', async t => {
  const { QUEUE_WATCH_SUPPORT_RETRY_MS } = await import('../src/engine-windows.mjs');
  const g = await engineFixture(t);
  await fs.mkdir(path.dirname(g.engine.v2(path.join('windows', 'x'))), { recursive: true });
  for (const n of ['role-probe-run.mjs', path.join('windows', 'FormalPublicBoundaryV2.cs')]) {
    await fs.copyFile(new URL(`../../actions-hosted-migration/independent-ci-v1/src/resident-v2/${n}`, import.meta.url), g.engine.v2(n));
  }
  let now = Date.parse('2026-11-06T08:00:00Z');
  g.engine.clock = () => now;
  const real = fs.readFile;
  let busy = true;
  fs.readFile = async (...a) => { if (busy) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return real(...a); };
  t.after(() => { fs.readFile = real; });
  assert.equal(await g.engine.queueWatchSupported(), false, 'a held file: no for now');
  busy = false;
  now += QUEUE_WATCH_SUPPORT_RETRY_MS - 1;
  assert.equal(await g.engine.queueWatchSupported(), false, 'not read again before the wait');
  now += 1;
  assert.equal(await g.engine.queueWatchSupported(), true, 'read again, and kept');
  busy = true;
  assert.equal(await g.engine.queueWatchSupported(), true);
});
