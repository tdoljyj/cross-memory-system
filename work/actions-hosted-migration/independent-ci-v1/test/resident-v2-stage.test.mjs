import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical } from '../src/proof.mjs';
import { hash } from '../src/resident-v2/prepare-record.mjs';
import { deriveBatch, residentBatchKey, writeBatch } from '../src/resident-v2/derive-batch.mjs';
import { invokeStage, invokeRoleProbe, readSpoolResult, RESULT_WRAPPER_CONTRACT_V2 } from '../src/resident-v2/invoke-stage.mjs';
import { loadStageInputs, parseEntryArgs, writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { buildStageFact, outcomeFailureCode, validateOutcome, notAdmittedCode, ALL_STAGE_CODES, NOT_ADMITTED_CODES, TRANSIENT_CODES, NATIVE_RECEIPT_CONTRACT_V2 } from '../src/resident-v2/stage-fact.mjs';
import { BROKER_RESPONSE_CONTRACT, validateBrokerRequest } from '../src/resident-v2/broker-protocol.mjs';
import { OUTCOME_CONTRACT, ENTRY_V2, stageByNumber } from '../src/resident-v2/layout.mjs';
import { sourceRootOfModule } from '../src/resident-v2/held-record.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOW, hex, tempDir, fixtureRecord, subject, signResult } from './resident-v2-fixtures.mjs';

const CONTROLLER = 'S-1-5-21-1-2-3-1015';

test('C2 stage11 real invoker + stage reader + bound Native outcome yields only a role observation', async t => {
  const f = await fixture(t), key = 'a'.repeat(64), runId = `${key.slice(0, 16)}-${'b'.repeat(12)}`;
  let time = NOW;
  const broker = fakeBroker(f, { outcome: { status: 'BLOCKED', reason: 'ROLE_PROBE_HELD', sideEffects: 0 } });
  const fact = await invokeRoleProbe({ runKey: key, runId, nodeProfileSha256: hash(f.rec.inputs.node), ...f.roots, recordDocs: f.rec.docs,
    clock: () => time, sleep: async ms => { time += ms; await broker(); } });
  assert.equal(fact.state, 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION');
  assert.deepEqual(fact.roleProbe, { result: 'held', code: 'ROLE_PROBE_HELD' });
  const inputs = await loadStageInputs({ nonce: fact.nonce, configSha256: JSON.parse(await fs.readFile(path.join(f.root, 'broker', 'requests', (await fs.readdir(path.join(f.root, 'broker', 'requests')))[0]), 'utf8')).configSha256,
    entryRole: 'role-probe', recordDocs: f.rec.docs, stageRoot: f.roots.stageRoot, now: NOW });
  assert.equal(inputs.plan.stage, 11); assert.equal(inputs.jobs.length, 1);
  for (const field of ['pr', 'headSha', 'baseSha', 'attempt', 'claim']) assert.equal(Object.hasOwn(inputs.jobs[0], field), false);
});
test('C2 generic pre-input refusal, wrong job, bad rawSHA and failed cleanup cannot assert held', async t => {
  for (const opts of [
    { outcome: { status: 'BLOCKED', reason: 'ROLE_PROBE_HELD', sideEffects: 0, stage: null, entryRole: null, jobIds: [] } },
    { outcome: { status: 'BLOCKED', reason: 'ROLE_PROBE_HELD', sideEffects: 0, jobIds: ['0'.repeat(64)] } },
    { outcome: { status: 'BLOCKED', reason: 'ROLE_PROBE_HELD', sideEffects: 0 }, receipt: { outcome_sha256: '0'.repeat(64) } },
    { outcome: { status: 'BLOCKED', reason: 'ROLE_PROBE_HELD', sideEffects: 0 }, receipt: { tree_cleanup_confirmed: false } },
  ]) {
    const f = await fixture(t), key = 'a'.repeat(64); let time = NOW;
    const fact = await invokeRoleProbe({ runKey: key, runId: `${key.slice(0, 16)}-${'b'.repeat(12)}`, nodeProfileSha256: hash(f.rec.inputs.node), ...f.roots, recordDocs: f.rec.docs,
      clock: () => time, sleep: async ms => { time += ms; await fakeBroker(f, opts)(); } });
    assert.notEqual(fact.state, 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION'); assert.equal(fact.roleProbe, undefined);
  }
});

async function fixture(t) {
  const root = await tempDir(t);
  const rec = fixtureRecord();
  const s = subject();
  const key = residentBatchKey(s);
  const id = `${key.slice(0, 16)}-${hex(6)}`;
  const d = deriveBatch({ recordDocs: rec.docs, subject: s, batchKey: key, batchId: id, now: NOW });
  const batchDir = path.join(root, 'work', id);
  await fs.mkdir(path.join(root, 'work'));
  writeBatch(batchDir, d.files);
  for (const p of ['stage', 'broker/requests', 'broker/responses', 'spool/incoming', 'receipts']) await fs.mkdir(path.join(root, p), { recursive: true });
  return { root, rec, key, id, d, batchDir, roots: { stageRoot: path.join(root, 'stage'), brokerRoot: path.join(root, 'broker'), spoolRoot: path.join(root, 'spool'), receiptsRoot: path.join(root, 'receipts') } };
}

// A fake SwapBroker + generic helper: answers every request and writes the helper's receipt and the
// entry outcome exactly as FormalSession0V2 / the v2 entry would.
function fakeBroker(f, { response = {}, receipt = {}, outcome = { status: 'SETTLED', reason: null, sideEffects: 1 }, writeReceipt = true, answer = true } = {}) {
  f.handled ??= new Set();
  return async () => {
    const dir = path.join(f.root, 'broker', 'requests');
    const names = await fs.readdir(dir);
    for (const n of names) {
      if (f.handled.has(n)) continue;
      f.handled.add(n);
      const req = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'));
      validateBrokerRequest(req, Date.parse(req.deadline) - stageByNumber(req.stage).runMilliseconds - 135_000);
      const plan = JSON.parse(await fs.readFile(path.join(f.roots.stageRoot, req.nonce, 'formal-service-entry.json'), 'utf8'));
      let outcomeBytes = null;
      if (outcome) {
        const o = { contract: OUTCOME_CONTRACT, nonce: req.nonce, stage: 'stage' in outcome ? outcome.stage : plan.stage, entryRole: 'entryRole' in outcome ? outcome.entryRole : plan.entryRole,
          jobIds: outcome.jobIds ?? (plan.stage === 11 ? JSON.parse(await fs.readFile(path.join(f.roots.stageRoot, req.nonce, 'jobs.json'), 'utf8')).map(j => j.id) : []), status: outcome.status, reason: outcome.reason,
          sideEffects: outcome.sideEffects, mayHavePublished: !(outcome.status === 'BLOCKED' && outcome.sideEffects === 0), diagnostic: outcome.diagnostic ?? null, at: new Date(NOW).toISOString() };
        outcomeBytes = Buffer.from(canonical(o) + '\n');
        await fs.writeFile(path.join(f.roots.receiptsRoot, `outcome-${req.nonce}.json`), outcomeBytes, { flag: 'wx' });
      }
      if (writeReceipt) {
        const r = { contract: NATIVE_RECEIPT_CONTRACT_V2, nonce: req.nonce, state: 'FIXED_CHILD_COMPLETED', failure_code: null, actual_sid: CONTROLLER, service_pid: 4242, session_id: 0, node_pid: 77,
          node_exit_code: 0, timed_out: false, stop_requested: false, tree_cleanup_confirmed: true, tree_cleanup_failure_code: null, tree_active_processes: 0, root_exit_confirmed: true,
          entry_role: plan.entryRole, stage: plan.stage, entry_sha256: plan.entrySha256, config_sha256: req.configSha256, acceptance_sha256: plan.acceptanceSha256,
          source_manifest_sha256: plan.sourceManifestSha256, outcome_sha256: outcomeBytes ? hash(outcomeBytes) : null, stdout_captured: false, private_bytes_read_by_helper: false,
          host_qualification: false, ci_principal_qualification: false, ...receipt };
        await fs.writeFile(path.join(f.roots.receiptsRoot, `windows-formal-entry-${req.nonce}.json`), JSON.stringify(r), { flag: 'wx' });
      }
      if (answer) {
        const id = n.replace(/\.json$/, '');
        const resp = { contract: BROKER_RESPONSE_CONTRACT, requestId: id, ok: true, code: null, started: true, startCallIssued: true, helperPid: 4242, stoppedInTime: true, restored: true,
          accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false, ...response };
        await fs.writeFile(path.join(f.root, 'broker', 'responses', `${id}.json`), JSON.stringify(resp), { flag: 'wx' });
      }
    }
  };
}

const run = (f, stage, broker, extra = {}) => {
  let time = NOW;
  return invokeStage({ batchDir: f.batchDir, stage, workManifestSha256: f.d.result.stages[stage - 1].workManifestSha256, batchKey: f.key, ...f.roots, recordDocs: f.rec.docs,
    clock: () => time, sleep: async ms => { time += ms; await broker(); }, ...extra });
};

test('invoke-stage: sealed package -> fresh stage dir -> broker -> receipt + bound outcome -> success fact', async t => {
  const f = await fixture(t);
  const fact = await run(f, 1, fakeBroker(f));
  assert.equal(fact.state, 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION');
  assert.equal(fact.failure_code, null);
  assert.equal(fact.manifest_sha256, f.d.result.stages[0].workManifestSha256);
  assert.ok(fact.original_binary_restored && fact.complete_original_readback && fact.tree_cleanup_confirmed && fact.tree_active_processes === 0 && fact.scm_start_call_issued);
  assert.match(fact.native_receipt_sha256, /^[0-9a-f]{64}$/);
  const dirs = await fs.readdir(f.roots.stageRoot);
  assert.equal(dirs.length, 1);
  assert.deepEqual((await fs.readdir(path.join(f.roots.stageRoot, dirs[0]))).sort(), ['formal-service-entry.json', 'jobs.json']);
});

test('invoke-stage (DESIGN §41.2): stages 1 and 8 get the installed train mode as train-mode.json, create-only; no other stage, no mode: no file', async t => {
  const { readStageTrainMode, stageTrainModeText, STAGE_TRAIN_MODE_FILE } = await import('../src/independent-control-checks-v2/train-mode.mjs');
  const { main } = await import('../src/resident-v2/invoke-stage.mjs');
  const f = await fixture(t);
  const newest = async before => (await fs.readdir(f.roots.stageRoot)).filter(d => !before.includes(d));
  for (const [stage, trainMode, expected] of [[1, 'on', 'on'], [1, 'shadow', 'shadow'], [1, 'off', 'off'], [1, null, null], [2, 'on', null]]) {
    const before = await fs.readdir(f.roots.stageRoot);
    const fact = await run(f, stage, fakeBroker(f), { trainMode });
    assert.equal(fact.state, 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', `${stage} ${trainMode}`);
    const [dir] = await newest(before);
    const files = (await fs.readdir(path.join(f.roots.stageRoot, dir))).sort();
    if (expected === null) assert.deepEqual(files, ['formal-service-entry.json', 'jobs.json'], `${stage} ${trainMode}`);
    else assert.equal(await fs.readFile(path.join(f.roots.stageRoot, dir, STAGE_TRAIN_MODE_FILE), 'utf8'), stageTrainModeText(expected));
    assert.equal(await readStageTrainMode(path.join(f.roots.stageRoot, dir)), expected ?? 'off');
  }
  assert.equal((await run(f, 1, fakeBroker(f), { trainMode: 'ON' })).failure_code, 'STAGE_PACKAGE_REFUSED');
  const out = { text: '', write(s) { this.text += s; } };
  assert.equal(await main(['--batch-dir', f.batchDir, '--stage', '1', '--train-mode', 'on', '--train-mode', 'off'], out), 2, 'given twice: refused');
});

test('invoke-stage: a changed package, a missing broker answer, a running helper and a broken restore are never success', async t => {
  const f = await fixture(t);
  assert.equal((await invokeStage({ batchDir: f.batchDir, stage: 2, workManifestSha256: 'f'.repeat(64), batchKey: f.key, ...f.roots })).failure_code, 'STAGE_PACKAGE_REFUSED');
  assert.equal((await run(f, 2, fakeBroker(f, { answer: false }))).failure_code, 'BROKER_RESPONSE_UNCONFIRMED');
  assert.equal((await run(f, 2, fakeBroker(f, { response: { ok: false, code: 'BROKER_HELPER_NOT_STOPPED_IN_TIME', stoppedInTime: false, restored: false } }))).failure_code, 'STAGE_HELPER_NOT_STOPPED_IN_TIME');
  assert.equal((await run(f, 2, fakeBroker(f, { response: { ok: false, code: 'BROKER_ORIGINAL_NOT_RESTORED', restored: false } }))).failure_code, 'STAGE_ORIGINAL_NOT_RESTORED');
  // Refused before any start, runner re-read as original: clean, nothing ran.
  const refused = await run(f, 2, fakeBroker(f, { writeReceipt: false, outcome: null, response: { ok: false, code: 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED', started: false, startCallIssued: false, helperPid: null, stoppedInTime: false } }));
  assert.equal(refused.failure_code, 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED');
  assert.ok(refused.tree_cleanup_confirmed && refused.original_binary_restored);
  // Another tool held the mutation mutex: the runner state is unknown to the broker.
  const busy = await run(f, 2, fakeBroker(f, { writeReceipt: false, outcome: null, response: { ok: false, code: 'BROKER_BUSY', started: false, startCallIssued: false, helperPid: null, stoppedInTime: false, restored: false, accountUnchanged: false, stableBefore: false, stableAfter: false } }));
  assert.equal(busy.failure_code, 'BROKER_BUSY');
  assert.equal(busy.original_binary_restored, false);
});

// PR #889 stage 3 (2026-10-21): the check-publisher refused itself before reading its inputs, so its outcome had
// no stage and no role; it was read as a missing outcome (UNKNOWN -> HALT) although nothing had run.
test('invoke-stage: a refusal before the stage inputs (no stage, no role, nothing ran) is that clean refusal, never a missing outcome', async t => {
  const f = await fixture(t);
  const refusedReceipt = { state: 'FIXED_CHILD_REFUSED', failure_code: 'FIXED_NODE_EXIT_NONZERO', node_exit_code: 2 };
  const pre = { status: 'BLOCKED', reason: 'ENTRY_OUTSIDE_HELD_SOURCE_REFUSED', sideEffects: 0, stage: null, entryRole: null };
  assert.equal((await run(f, 1, fakeBroker(f, { receipt: refusedReceipt, outcome: pre }))).failure_code, 'STAGE_CHILD_REFUSED');
  assert.equal(outcomeFailureCode({ ...pre, mayHavePublished: false }, 3), 'PUBLICATION_BLOCKED');
  // the exact bytes runEntry's writeOutcome writes when the plan never loaded are that accepted shape
  const nonce = hex(16), receiptsRoot = await tempDir(t, 'clued-v2-outcome-');
  await writeOutcome({ receiptsRoot, nonce, plan: null, jobIds: [], result: { status: 'BLOCKED', reason: 'ENTRY_OUTSIDE_HELD_SOURCE_REFUSED', sideEffects: 0 } });
  const written = JSON.parse(await fs.readFile(path.join(receiptsRoot, `outcome-${nonce}.json`), 'utf8'));
  assert.ok(validateOutcome(written, { nonce, plan: { stage: 3, entryRole: 'check-publisher' } }), JSON.stringify(written));
  // only in exactly that shape: side effects, a job id, a status other than BLOCKED or a half-filled stage stay UNKNOWN
  for (const bad of [{ ...pre, sideEffects: 1 }, { ...pre, jobIds: ['a'.repeat(64)] }, { ...pre, status: 'UNCERTAIN' }, { ...pre, stage: 1 }])
    assert.equal((await run(f, 1, fakeBroker(f, { receipt: refusedReceipt, outcome: bad }))).failure_code, 'STAGE_OUTCOME_MISSING', JSON.stringify(bad));
});

test('every v2 entry finds the same Source root whatever its depth (the check-publisher is one level shallower)', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
  const root = 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\' + 'a'.repeat(64);
  for (const [role, rel] of Object.entries(ENTRY_V2)) {
    const url = pathToFileURL(path.join(root, ...rel.split('/'))).href;
    assert.equal(sourceRootOfModule(url), root, role);
    // the old fixed five-level rule was right for every entry but the check-publisher (runtime/one-shot-v2.mjs)
    assert.equal(path.resolve(fileURLToPath(new URL('../../../../../', url))) === root, role !== 'check-publisher', role);
  }
  assert.throws(() => sourceRootOfModule(pathToFileURL('C:\\elsewhere\\x.mjs').href), { code: 'ENTRY_OUTSIDE_HELD_SOURCE_REFUSED' });
});

test('invoke-stage: helper preflight refusal, tree unknown, unbound outcome and a not-admitted stage 1', async t => {
  const f = await fixture(t);
  assert.equal((await run(f, 1, fakeBroker(f, { writeReceipt: false, outcome: null }))).failure_code, 'STAGE_HELPER_PREFLIGHT_REFUSED');
  assert.equal((await run(f, 1, fakeBroker(f, { receipt: { tree_cleanup_confirmed: false, tree_active_processes: 1 } }))).failure_code, 'STAGE_CHILD_TREE_UNCONFIRMED');
  assert.equal((await run(f, 1, fakeBroker(f, { receipt: { outcome_sha256: 'f'.repeat(64), state: 'FIXED_CHILD_REFUSED', node_exit_code: 2 } }))).failure_code, 'STAGE_OUTCOME_MISSING');
  const na = await run(f, 1, fakeBroker(f, { receipt: { state: 'FIXED_CHILD_REFUSED', node_exit_code: 2 },
    outcome: { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, diagnostic: { reasonCodes: ['paths_outside_write_set'] } } }));
  assert.equal(na.failure_code, 'PATHS_OUTSIDE_WRITE_SET');
  // The fact carries the sanitized diagnostic up to the resident (quota redesign v0.6 §9 phase 1); no safe-to-re-run
  // flag was written, so none is inferred.
  assert.deepEqual(na.outcome, { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false,
    diagnostic: { verdict: 'UNKNOWN', nativeVerdict: 'UNKNOWN', ownerReviewKind: 'UNKNOWN', reasonCodes: ['paths_outside_write_set'], nativeReasonCodes: [] },
    scheduling: null, safeToRerun: false });
  const transient = await run(f, 1, fakeBroker(f, { receipt: { state: 'FIXED_CHILD_REFUSED', node_exit_code: 2 }, outcome: { status: 'BLOCKED', reason: 'full_admission_unavailable', sideEffects: 0 } }));
  assert.equal(transient.failure_code, 'NATIVE_ADMISSION_UNAVAILABLE');
  const uncertain = await run(f, 1, fakeBroker(f, { receipt: { state: 'FIXED_CHILD_REFUSED', node_exit_code: 2 }, outcome: { status: 'UNCERTAIN', reason: 'NATIVE_CHECK_IDENTITY_UNCONFIRMED', sideEffects: 1 } }));
  assert.equal(uncertain.failure_code, 'PUBLICATION_UNCERTAIN');
});

test('invoke-stage: a publisher stage needs the ready-marked signed result for exactly its job and attempt', async t => {
  const f = await fixture(t);
  assert.equal((await run(f, 3, fakeBroker(f))).failure_code, 'STAGE_INPUT_RESULT_MISSING');
  const job = JSON.parse(f.d.files['stage-03/jobs.json'])[0];
  const envelope = signResult(job, f.rec.signer);
  const wrapper = Buffer.from(canonical({ contract: RESULT_WRAPPER_CONTRACT_V2, domain: 'production', envelope }));
  await fs.writeFile(path.join(f.roots.spoolRoot, 'incoming', 'result.json'), wrapper);
  await fs.writeFile(path.join(f.roots.spoolRoot, 'incoming', 'result.ready.json'), JSON.stringify({ bytes: wrapper.length, contract: 'clued.independent-ci.complete-public-file/1', sha256: hash(wrapper) }));
  assert.equal(canonical(JSON.parse((await readSpoolResult(f.roots.spoolRoot, job)).toString())), canonical(envelope));
  const fact = await run(f, 3, fakeBroker(f));
  assert.equal(fact.state, 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION');
  const other = JSON.parse(f.d.files['stage-05/jobs.json'])[0];
  await assert.rejects(readSpoolResult(f.roots.spoolRoot, other), { code: 'STAGE_INPUT_RESULT_MISSING' });
});

test('stage inputs (entry side): exact args, plan pin, record binding, jobs and outcome record', async t => {
  const f = await fixture(t);
  await run(f, 8, fakeBroker(f));
  const nonce = (await fs.readdir(f.roots.stageRoot))[0];
  const planSha = f.d.result.stages[7].planSha256;
  assert.throws(() => parseEntryArgs(['--run']), { code: 'FIXED_V2_ENTRY_ARGUMENTS_REQUIRED' });
  const args = parseEntryArgs(['--run', '--stage', nonce, '--config-sha256', planSha]);
  const inputs = await loadStageInputs({ ...args, entryRole: 'control-checks', recordDocs: f.rec.docs, stageRoot: f.roots.stageRoot, now: NOW });
  assert.deepEqual(inputs.jobs.map(j => j.role), ['control-admission', 'control-merge-slot']);
  await assert.rejects(loadStageInputs({ ...args, entryRole: 'work-admission', recordDocs: f.rec.docs, stageRoot: f.roots.stageRoot, now: NOW }), { code: 'FIXED_FORMAL_ENTRY_ROLE_REQUIRED' });
  await assert.rejects(loadStageInputs({ nonce, configSha256: 'f'.repeat(64), entryRole: 'control-checks', recordDocs: f.rec.docs, stageRoot: f.roots.stageRoot, now: NOW }), { code: 'EXACT_STAGE_PLAN_REQUIRED' });
  const other = fixtureRecord();
  await assert.rejects(loadStageInputs({ ...args, entryRole: 'control-checks', recordDocs: other.docs, stageRoot: f.roots.stageRoot, now: NOW }), { code: 'INSTALLED_RECORD_BINDING_CHANGED' });
  const n2 = hex(16);
  const o = await writeOutcome({ receiptsRoot: path.join(f.root, 'outcomes'), nonce: n2, plan: inputs.plan, jobIds: inputs.jobs.map(j => j.id), result: { status: 'BLOCKED', reason: 'RESIDENT_QUEUE_HEAD_NOT_REACHED', sideEffects: 0 } });
  assert.equal(o.mayHavePublished, false);
  await assert.rejects(writeOutcome({ receiptsRoot: path.join(f.root, 'outcomes'), nonce: n2, plan: inputs.plan, jobIds: [], result: {} }), { code: 'EEXIST' });
  const junk = await writeOutcome({ receiptsRoot: path.join(f.root, 'outcomes'), nonce: hex(16), plan: inputs.plan, jobIds: [], result: { status: 'weird', sideEffects: -1 } });
  assert.deepEqual([junk.status, junk.sideEffects, junk.mayHavePublished], ['UNCERTAIN', 1, true]);
});

test('stage-fact catalogue: every mapped code is catalogued; transient codes are a strict subset', () => {
  const plan = { stage: 2 };
  const samples = [{ status: 'BLOCKED', reason: 'FORMAL_BRIDGE_STAGE_DEADLINE', sideEffects: 0, mayHavePublished: false },
    { status: 'BLOCKED', reason: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', sideEffects: 0, mayHavePublished: false },
    { status: 'BLOCKED', reason: 'evidence_identity_conflict', sideEffects: 0, mayHavePublished: false },
    { status: 'BLOCKED', reason: 'full_admission_source_changed', sideEffects: 0, mayHavePublished: false },
    { status: 'BLOCKED', reason: 'something_new', sideEffects: 0, mayHavePublished: false }, { status: 'REVOKED', reason: 'x', sideEffects: 1, mayHavePublished: true }, null];
  for (const s of [1, 2, 3, 5, 8]) for (const o of samples) assert.ok(ALL_STAGE_CODES.includes(outcomeFailureCode(o, s)), `${s}:${o?.reason}`);
  assert.equal(outcomeFailureCode(samples[0], 2), 'BRIDGE_TRANSPORT_TIMEOUT');
  assert.equal(outcomeFailureCode(samples[2], 3), 'EVIDENCE_IDENTITY_CONFLICT');
  assert.equal(outcomeFailureCode(samples[3], 1), 'ADMISSION_CONFIGURATION_REFUSED');
  assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason: 'full_admission_claim_changed', sideEffects: 0, mayHavePublished: false }, 5), 'BATCH_CLAIM_CHANGED');
  assert.equal(notAdmittedCode({ reasonCodes: ['owner_review_required', 'paths_outside_write_set'] }), 'OWNER_REVIEW_REQUIRED');
  // not up to date with main dominates: that head can never pass, whatever else Native says
  assert.equal(notAdmittedCode({ reasonCodes: ['owner_review_required', 'protected_change_not_up_to_date'] }), 'PROTECTED_CHANGE_NOT_UP_TO_DATE');
  assert.equal(notAdmittedCode({}), 'NATIVE_NOT_ADMITTED');
  assert.ok(TRANSIENT_CODES.every(c => ALL_STAGE_CODES.includes(c)));
  // Primary/standby C3: "this node holds no ci-admission role" is a not-admitted code, and it dominates every other reason,
  // protected_change_not_up_to_date included: a node that is not on duty decides nothing about the PR.
  assert.ok(NOT_ADMITTED_CODES.includes('NODE_ROLE_NOT_HELD') && ALL_STAGE_CODES.includes('NODE_ROLE_NOT_HELD'));
  assert.equal(notAdmittedCode({ reasonCodes: ['admission_binding_required'] }), 'NODE_ROLE_NOT_HELD');
  assert.equal(notAdmittedCode({ reasonCodes: ['owner_review_required', 'admission_binding_required'] }), 'NODE_ROLE_NOT_HELD');
  assert.equal(notAdmittedCode({ reasonCodes: ['protected_change_not_up_to_date'], nativeReasonCodes: ['admission_binding_required'] }), 'NODE_ROLE_NOT_HELD');
  assert.equal(notAdmittedCode({ reasonCodes: ['binding_not_authorized'] }), 'NATIVE_NOT_ADMITTED', 'only the role reason is the role code');
  const noRole = { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false, diagnostic: { reasonCodes: ['admission_binding_required'], nativeReasonCodes: [] } };
  assert.equal(outcomeFailureCode(noRole, 1), 'NODE_ROLE_NOT_HELD');
  assert.equal(outcomeFailureCode(noRole, 3), 'BATCH_CLAIM_CHANGED', 'after stage 1 the same answer keeps its old code');
  assert.equal(buildStageFact({ stage: 1, nonce: hex(16), workManifestSha256: hex(32), preflightCode: 'STAGE_PACKAGE_REFUSED' }).tree_active_processes, 0);
  void plan; void randomUUID;
});

test('invoker rejects a cross-profile sealed plan before creating stage inputs or a broker request', async t => {
  const f = await fixture(t);
  const other = fixtureRecord({ node: { ...f.rec.inputs.node, nodeName: 'other-node', hostname: 'OTHER-NODE', mutationMutex: 'Global\\CluedControlControllerMutationV1-OTHER-NODE-1015' } });
  const fact = await run(f, 1, fakeBroker(f), { recordDocs: other.docs });
  assert.equal(fact.failure_code, 'STAGE_PACKAGE_REFUSED');
  assert.deepEqual(await fs.readdir(f.roots.stageRoot), []);
  assert.deepEqual(await fs.readdir(path.join(f.roots.brokerRoot, 'requests')), []);
});
