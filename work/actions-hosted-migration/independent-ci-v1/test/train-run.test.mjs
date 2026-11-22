// Stage 10's job and stage row (resident quota redesign phase 2, step 3c-1; DESIGN §21.1; train-run /2: §41.4, §41.7).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { TRAIN_RUN_CONTRACT, TRAIN_RUN_FIELDS, TRAIN_RUN_MODES, TRAIN_RUN_SHADOW_DEFAULTS, makeTrainRun, trainRunJobId, trainRunKey, validateTrainRun } from '../src/resident-v2/train-run.mjs';
import { ENTRY_V2, FORMAL_STAGES_V2, STAGES_V2, TRAIN_STAGE_NUMBER, TRAIN_STAGE_V2, STATE_V2, stageByNumber } from '../src/resident-v2/layout.mjs';
import { trainRunCases } from './train-run-cases.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const seed = 'a'.repeat(64);
const key = trainRunKey({ repo: REPO, seed });
const run = (o = {}) => makeTrainRun({ repo: REPO, runId: `${key.slice(0, 16)}-0123456789ab`, mode: 'shadow', sourceManifestSha256: 'e'.repeat(64), createdAt: '2026-10-23T05:00:00.000Z',
  ...TRAIN_RUN_SHADOW_DEFAULTS, ...o });
const ON = { mode: 'on', onSince: '2026-10-23T04:00:00.000Z' };

test('train run /4: contract, fields in order, id over every field but contract, id and createdAt', () => {
  const job = run();
  assert.equal(job.contract, 'clued.independent-ci.train-run/4');
  assert.deepEqual(Object.keys(job), [...TRAIN_RUN_FIELDS]);
  assert.deepEqual(TRAIN_RUN_FIELDS, ['contract', 'id', 'repo', 'runId', 'mode', 'sourceManifestSha256', 'createdAt', 'slotHardCapMinutes', 'frontBatchBudgetMs', 'sweepFreshMs',
    'fullSweepMaxMs', 'onSince', 'frontPr', 'frontHeadSha', 'frontTestSha', 'frontAttempt', 'frontCode', 'frontFailed', 'revokeHeadRequestId', 'sweep']);
  assert.equal(job.id, createHash('sha256').update(JSON.stringify([TRAIN_RUN_CONTRACT, REPO, job.runId, 'shadow', 'e'.repeat(64), 120, 3600000, 900000, 21600000,
    null, null, null, null, null, null, null, null, 'gate'])).digest('hex'));
  assert.equal(trainRunJobId(job), job.id);
  assert.deepEqual(TRAIN_RUN_MODES, ['shadow', 'on', 'revoke-only']);
  // createdAt is not part of the id; every identity field is
  assert.equal(run({ createdAt: '2026-10-23T06:00:00.000Z' }).id, job.id);
  for (const o of [{ runId: `${key.slice(0, 16)}-ffffffffffff` }, { slotHardCapMinutes: 121 }, { sweepFreshMs: 900001 }, { ...ON }, { mode: 'revoke-only' }, { sweep: 'audit' }, { sweep: 'off' }])
    assert.notEqual(run(o).id, job.id, JSON.stringify(o));
  for (const bad of [{ ...job, mode: 'off' }, { ...job, id: '0'.repeat(64) }, { ...job, runId: 'x' }, { ...job, extra: 1 }, { ...job, repo: 'a' }, { ...job, contract: 'clued.independent-ci.train-run/1' },
    { ...job, contract: 'clued.independent-ci.train-run/2' }, { ...job, sweep: 'full' }])
    assert.throws(() => validateTrainRun(bad), e => e.code === 'invalid_train_run');
  assert.throws(() => run({ mode: 'on' }), e => e.code === 'invalid_train_run', 'on names onSince');
  // makeTrainRun takes every param and nothing else
  const { revokeHeadRequestId, ...partial } = TRAIN_RUN_SHADOW_DEFAULTS;
  assert.throws(() => makeTrainRun({ repo: REPO, runId: job.runId, mode: 'shadow', sourceManifestSha256: 'e'.repeat(64), createdAt: job.createdAt, ...partial }), e => e.code === 'invalid_train_run');
  assert.throws(() => run({ extra: 1 }), e => e.code === 'invalid_train_run');
});

test('train run /4: the shared table (test/fixtures/train-run-cases.json) as the C# boundary runs it', () => {
  const rows = trainRunCases();
  assert.ok(rows.filter(r => r.accepted).length >= 9 && rows.filter(r => !r.accepted).length >= 25);
  for (const r of rows) {
    if (r.accepted) assert.equal(validateTrainRun(r.job).id, trainRunJobId(r.job), r.name);
    else assert.throws(() => validateTrainRun(r.job), e => e.code === 'invalid_train_run', r.name);
  }
  // PureTestsV2.cs runs the same rows through FormalPublicBoundaryV2.ValidateTrainRun (test-pure-v2.ps1 writes them)
  const ps = (name) => new URL(`../src/resident-v2/windows/${name}`, import.meta.url);
  return import('node:fs').then(({ default: fs }) => {
    assert.match(fs.readFileSync(ps('test-pure-v2.ps1'), 'utf8'), /trainRunCases:trainRunCases\(\)/);
    const cs = fs.readFileSync(ps('PureTestsV2.cs'), 'utf8');
    assert.match(cs, /fixture\["trainRunCases"\]/);
    assert.match(fs.readFileSync(ps('FormalPublicBoundaryV2.cs'), 'utf8'), /"clued\.independent-ci\.train-run\/4"/);
  });
});

test('train run: the key comes from a fresh seed, never from content', () => {
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(trainRunKey({ repo: REPO, seed: randomBytes(32).toString('hex') }), key);
  assert.throws(() => trainRunKey({ repo: REPO, seed: 'short' }), e => e.code === 'TRAIN_RUN_KEY_REFUSED');
});

test('stage 10: a train row outside the batch, with its own entry and state directory', async () => {
  assert.equal(TRAIN_STAGE_NUMBER, 10);
  assert.deepEqual([TRAIN_STAGE_V2.kind, TRAIN_STAGE_V2.entryRole, TRAIN_STAGE_V2.jobRoles, TRAIN_STAGE_V2.runMilliseconds, TRAIN_STAGE_V2.linuxWorker],
    ['train', 'train-maintenance', ['train-run'], 300_000, false]);
  // Stage 9 is a reserved number (the hosted relay, removed; resident DESIGN §76): no row, no entry; stages 10-12 keep their
  // numbers and every stage its exact cap; stage 13 (the relay qualification) is gone.
  assert.deepEqual(STAGES_V2.map(s => s.number), [1,2,3,4,5,6,7,8,10,11,12]);
  assert.deepEqual(STAGES_V2.map(s => s.runMilliseconds), [900000,2700000,900000,1800000,900000,600000,900000,2700000,300000,60000,300000], 'every stage retains its exact cap');
  assert.deepEqual(STAGES_V2.filter(s => s.linuxWorker).map(s => s.number), [2,4,6]);
  for (const n of [9, 13]) assert.equal(stageByNumber(n), null, `stage ${n}`);
  assert.deepEqual(Object.keys(ENTRY_V2).sort(), ['check-publisher','control-checks','revocation-maintenance','role-probe','scanner-issuer','train-maintenance','work-admission']);
  const fs = (await import('node:fs')).default;
  const broker = fs.readFileSync(new URL('../../../independent-ci-resident-v1/windows/SwapBroker.cs',import.meta.url),'utf8');
  const abortable = /AbortableStages\s*=\s*\{\s*([\d,\s]+)\}/.exec(broker);
  assert.ok(abortable, 'the fixed broker abort table is present');
  assert.deepEqual(abortable[1].split(',').map(v=>Number(v.trim())),[2,4,6], 'only the scanner stages may be aborted');
  assert.ok(!FORMAL_STAGES_V2.some(s => s.number === 10), 'stage 10 is never one of the batch stages');
  assert.equal(ENTRY_V2['train-maintenance'], 'work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-maintenance.mjs');
  assert.match(STATE_V2.trainShadow, /\\state\\v2\\train-shadow$/);
  assert.match(STATE_V2.trainSweep, /\\state\\v2\\train-sweep$/);
});

test('state\\v2\\train-sweep: created by migrate-acl.ps1 for clued-control only, like train-shadow', async () => {
  const fs = (await import('node:fs')).default;
  const model = JSON.parse(fs.readFileSync(new URL('../src/resident-v2/acl-model.json', import.meta.url), 'utf8'));
  const row = p => model.create.find(c => c.path === `C:\\ProgramData\\CluedIndependentCI\\state\\v2\\${p}`);
  assert.equal(STATE_V2.trainSweep, `C:\\ProgramData\\CluedIndependentCI\\state\\v2\\train-sweep`);
  assert.ok(row('train-sweep'));
  assert.equal(row('train-sweep').sddl, row('train-shadow').sddl);
  assert.doesNotMatch(row('train-sweep').sddl, /\{RES\}/, 'the resident never reads the sweep records');
});

test('derive-batch --train-run: one sealed stage-10 package the stage reader accepts, from the installed record', async t => {
  const { fixtureRecord, tempDir, NOW } = await import('./resident-v2-fixtures.mjs');
  const { deriveTrainRun, writeBatch } = await import('../src/resident-v2/derive-batch.mjs');
  const { readSealedStage } = await import('../src/resident-v2/stage-package.mjs');
  const rec = fixtureRecord();
  const runKey = trainRunKey({ repo: REPO, seed: 'c'.repeat(64) }), runId = `${runKey.slice(0, 16)}-0123456789ab`;
  const a = deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode: 'shadow', now: NOW });
  assert.deepEqual(a.files, deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode: 'shadow', now: NOW }).files, 'deterministic');
  assert.deepEqual([a.result.status, a.result.stage.number, a.result.stage.entryRole, a.result.stage.jobIds.length], ['RESIDENT_TRAIN_RUN_DERIVED', 10, 'train-maintenance', 1]);
  const dir = path.join(await tempDir(t), 'train-run');
  writeBatch(dir, a.files);
  const sealed = await readSealedStage(dir, 10, a.result.stage.workManifestSha256);
  const job = JSON.parse(sealed.files['jobs.json'].toString('utf8'))[0];
  assert.deepEqual([sealed.plan.batchKey, sealed.plan.batchId, sealed.stage.jobRoles, job.runId, job.mode, validateTrainRun(job).id], [runKey, runId, ['train-run'], runId, 'shadow', a.result.stage.jobId]);
  for (const bad of [{ runKey: 'x' }, { runId: 'f'.repeat(16) + '-0123456789ab' }, { mode: 'on' }, { params: { ...TRAIN_RUN_SHADOW_DEFAULTS, ...ON, slotHardCapMinutes: 59 }, mode: 'on' },
    { params: 'x' }])
    assert.throws(() => deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode: 'shadow', now: NOW, ...bad }), { code: 'RESIDENT_TRAIN_RUN_REFUSED' });
  // on and revoke-only always carry the params (the CLI requires --train-params in every mode)
  const on = deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode: 'on', params: { ...TRAIN_RUN_SHADOW_DEFAULTS, ...ON, frontBatchBudgetMs: 1_800_000 }, now: NOW });
  const onJob = JSON.parse(on.files['stage-10/jobs.json'])[0];
  assert.deepEqual([onJob.mode, onJob.onSince, onJob.frontBatchBudgetMs, validateTrainRun(onJob).id], ['on', ON.onSince, 1_800_000, on.result.stage.jobId]);
  const { main } = await import('../src/resident-v2/derive-batch.mjs');
  assert.throws(() => main(['--train-run', runId, '--train-key', runKey, '--mode', 'shadow', '--out', path.join(dir, 'x')]), { code: 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED' });
  assert.throws(() => main(['--train-run', runId, '--train-key', runKey, '--mode', 'shadow', '--train-params', '{', '--out', path.join(dir, 'x')]), { code: 'RESIDENT_TRAIN_RUN_REFUSED' });
});

// invoke-stage for stage 10 end to end (DESIGN §22.1), with a fake broker and helper that write the outcome as
// writeOutcome would: TRAIN_FACTS with zero side effects and valid facts is the one success; the facts travel.
test('invoke-stage stage 10: train facts are a success fact carrying the facts; anything else is STAGE_OUTCOME_MISSING', async t => {
  const fsp = (await import('node:fs/promises')).default;
  const { fixtureRecord, tempDir, NOW } = await import('./resident-v2-fixtures.mjs');
  const { deriveTrainRun, writeBatch } = await import('../src/resident-v2/derive-batch.mjs');
  const { invokeStage } = await import('../src/resident-v2/invoke-stage.mjs');
  const { writeOutcome } = await import('../src/resident-v2/stage-inputs.mjs');
  const { NATIVE_RECEIPT_CONTRACT_V2 } = await import('../src/resident-v2/stage-fact.mjs');
  const { BROKER_RESPONSE_CONTRACT } = await import('../src/resident-v2/broker-protocol.mjs');
  const { hash } = await import('../src/resident-v2/prepare-record.mjs');
  const { trainFacts } = await import('../src/independent-control-checks-v2/train-facts.mjs');
  const CONTROLLER = 'S-1-5-21-1-2-3-1015';
  const facts = trainFacts({ mode: 'shadow', at: '2026-10-23T05:01:00.000Z', onDuty: true, holders: [], mainSha: '1'.repeat(40), rules: { strict: true, mergeOnly: false }, front: null, revoke: [], ledger: { records: 0, refused: 0 } });
  // the sealed job's mode (review R1 m8 / R2 minor 6): the facts' own mode must be it
  const run = async (result, mode = result.train?.mode ?? 'shadow') => {
    const root = await tempDir(t);
    const rec = fixtureRecord();
    const runKey = trainRunKey({ repo: REPO, seed: randomBytes(32).toString('hex') }), runId = `${runKey.slice(0, 16)}-0123456789ab`;
    const d = mode === 'shadow' ? deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode: 'shadow', now: NOW })
      : deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode, params: { ...TRAIN_RUN_SHADOW_DEFAULTS, onSince: ON.onSince }, now: NOW });
    await fsp.mkdir(path.join(root, 'work'));
    writeBatch(path.join(root, 'work', runId), d.files);
    for (const p of ['stage', 'broker/requests', 'broker/responses', 'receipts']) await fsp.mkdir(path.join(root, p), { recursive: true });
    const handled = new Set();
    const broker = async () => {
      for (const n of await fsp.readdir(path.join(root, 'broker', 'requests'))) {
        if (handled.has(n)) continue;
        handled.add(n);
        const req = JSON.parse(await fsp.readFile(path.join(root, 'broker', 'requests', n), 'utf8'));
        const plan = JSON.parse(await fsp.readFile(path.join(root, 'stage', req.nonce, 'formal-service-entry.json'), 'utf8'));
        await writeOutcome({ receiptsRoot: path.join(root, 'receipts'), nonce: req.nonce, plan, jobIds: [d.result.stage.jobId], result, clock: () => NOW });
        const outcomeBytes = await fsp.readFile(path.join(root, 'receipts', `outcome-${req.nonce}.json`));
        const receipt = { contract: NATIVE_RECEIPT_CONTRACT_V2, nonce: req.nonce, state: 'FIXED_CHILD_COMPLETED', failure_code: null, actual_sid: CONTROLLER,
          service_pid: 4242, session_id: 0, node_pid: 77, node_exit_code: 0, timed_out: false, stop_requested: false, tree_cleanup_confirmed: true, tree_cleanup_failure_code: null,
          tree_active_processes: 0, root_exit_confirmed: true, entry_role: plan.entryRole, stage: plan.stage, entry_sha256: plan.entrySha256, config_sha256: req.configSha256,
          acceptance_sha256: plan.acceptanceSha256, source_manifest_sha256: plan.sourceManifestSha256, outcome_sha256: hash(outcomeBytes), stdout_captured: false,
          private_bytes_read_by_helper: false, host_qualification: false, ci_principal_qualification: false };
        await fsp.writeFile(path.join(root, 'receipts', `windows-formal-entry-${req.nonce}.json`), JSON.stringify(receipt), { flag: 'wx' });
        const id = n.replace(/\.json$/, '');
        await fsp.writeFile(path.join(root, 'broker', 'responses', `${id}.json`), JSON.stringify({ contract: BROKER_RESPONSE_CONTRACT, requestId: id, ok: true, code: null, started: true,
          startCallIssued: true, helperPid: 4242, stoppedInTime: true, restored: true, accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false }), { flag: 'wx' });
      }
    };
    let time = NOW;
    return invokeStage({ batchDir: path.join(root, 'work', runId), stage: 10, workManifestSha256: d.result.stage.workManifestSha256, batchKey: runKey, stageRoot: path.join(root, 'stage'),
      // #926: the invoker checks the sealed plan against the record's node profile and takes the controller SID from it
      brokerRoot: path.join(root, 'broker'), receiptsRoot: path.join(root, 'receipts'), spoolRoot: path.join(root, 'spool'), recordDocs: rec.docs,
      clock: () => time, sleep: async ms => { time += ms; await broker(); } });
  };
  const ok = await run({ status: 'TRAIN_FACTS', reason: null, sideEffects: 0, train: facts });
  assert.deepEqual([ok.state, ok.failure_code, ok.train?.wouldDo], ['FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', null, facts.wouldDo]);
  assert.deepEqual([ok.outcome.status, ok.outcome.sideEffects, ok.outcome.mayHavePublished], ['TRAIN_FACTS', 0, false]);
  // facts that do not validate are written as null by the entry's writeOutcome: never a success
  const bad = await run({ status: 'TRAIN_FACTS', reason: null, sideEffects: 0, train: { ...facts, wouldDo: 'REVOKE_EVERYTHING' } });
  assert.deepEqual([bad.failure_code, bad.train], ['STAGE_OUTCOME_MISSING', null]);
  const effects = await run({ status: 'TRAIN_FACTS', reason: null, sideEffects: 1, train: facts });
  assert.equal(effects.failure_code, 'STAGE_OUTCOME_MISSING', 'a shadow run with a side effect is no success');
  // §41.3, §41.4: in on and revoke-only mode side effects are a normal ending, and the outcome may have published exactly then
  // (stage-inputs.mjs#writeOutcome and stage-fact.mjs agree); without any it is the same clean ending as shadow
  const revokeOnly = { ...facts, mode: 'revoke-only', decision: 'REVOKE_ONLY_DONE', sweep: { ...facts.sweep, revoked: 3 } };
  const acted = await run({ status: 'TRAIN_FACTS', reason: null, sideEffects: 3, train: revokeOnly });
  assert.deepEqual([acted.state, acted.failure_code, acted.outcome.sideEffects, acted.outcome.mayHavePublished, acted.train?.mode],
    [ok.state, null, 3, true, 'revoke-only']);
  const onPause = { ...facts, mode: 'on', decision: 'TRAIN_LANDED_TREE_MISMATCH', requestPause: 'TRAIN_LANDED_TREE_MISMATCH' };
  const quiet = await run({ status: 'TRAIN_FACTS', reason: null, sideEffects: 0, train: onPause });
  assert.deepEqual([quiet.state, quiet.failure_code, quiet.outcome.mayHavePublished, quiet.train?.requestPause], [ok.state, null, false, 'TRAIN_LANDED_TREE_MISMATCH']);
  const onActed = await run({ status: 'TRAIN_FACTS', reason: null, sideEffects: 2, train: onPause });
  assert.deepEqual([onActed.failure_code, onActed.outcome.mayHavePublished], [null, true]);
  const uncertain = await run({ status: 'UNCERTAIN', reason: null, sideEffects: 2, train: revokeOnly });
  assert.notEqual(uncertain.failure_code, null, 'only TRAIN_FACTS is the stage-10 success');
  // facts whose mode is not the sealed job's: never a success (a shadow job reporting on-mode effects, and the reverse)
  const forged = await run({ status: 'TRAIN_FACTS', reason: null, sideEffects: 2, train: onPause }, 'shadow');
  assert.deepEqual([forged.failure_code, forged.state === ok.state], ['STAGE_OUTCOME_MISSING', false]);
  const quietForged = await run({ status: 'TRAIN_FACTS', reason: null, sideEffects: 0, train: facts }, 'on');
  assert.equal(quietForged.failure_code, 'STAGE_OUTCOME_MISSING');
});
