// Resident-side stage invoker (DESIGN S1, S11, S12). Replaces the elevated per-stage
// invoke-control.ps1 -Mode ActivateOnce + run-batch.ps1 Prepare-StageInputs:
//   1. re-verify the sealed stage package against the work-manifest pin on the command line;
//   2. write this invocation's public inputs into a NEW resident\stage\<nonce>\ directory (plan, jobs and,
//      for a check-publisher stage, the signed scanner result copied from the spool after checking its
//      ready marker and subject) — no Public file is ever replaced, so there are no .bak/.tmp names to
//      collide across batches (lesson: rNN had to archive 8 helpers and 18 backups per batch);
//   3. ask CluedCISwapBroker (SYSTEM) to run the ONE installed generic helper once with
//      (nonce, configSha256); the resident itself has no right on the runner service;
//   4. read the helper's native receipt and the entry's outcome record (bound by hash) and print one
//      stage fact with a stable failure code (stage-fact.mjs).
// Runs as NT SERVICE\CluedCIResident. Never elevated, never reads a secret, never kills anything.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonical } from '../proof.mjs';
import { validateJobV2 } from '../job-v2.mjs';
import { ENVELOPE_CONTRACT_V2 } from '../proof-v2.mjs';
import { hash } from './prepare-record.mjs';
import { readSealedStage, PLAN_CONTRACT_V2 } from './stage-package.mjs';
import { makeRoleProbeRun } from './role-probe-run.mjs';
import { readRecordDocs } from './derive-batch.mjs';
import { validateRecordV2 } from './record.mjs';
import { makeBrokerRequest, validateBrokerResponse } from './broker-protocol.mjs';
import { buildStageFact } from './stage-fact.mjs';
import { HEX64, NONCE32, STATE_V2, WIN_RESIDENT, WIN_RECORD, WIN_SPOOL, WIN_STAGE, ENTRY_V2 } from './layout.mjs';

export const RESULT_WRAPPER_CONTRACT_V2 = 'clued.independent-ci.protected-job-result/2';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

async function readBounded(file, max) {
  let st;
  try { st = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= max, 'PUBLIC_RECORD_BOUNDARY');
  const h = await fs.open(file, 'r');
  try {
    const b = await h.readFile(); const after = await h.stat();
    check(after.ino === st.ino && b.length === st.size, 'PUBLIC_RECORD_CHANGED');
    return b;
  } finally { await h.close(); }
}
async function writeNew(file, bytes) {
  const h = await fs.open(file, 'wx', 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
}
const parse = b => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)); } catch { return null; } };

// The signed scanner result the previous Linux stage left in the spool (relay-public.ps1 publishes the
// data file first and a create-new ready marker last). Untrusted signed input: the publisher entry
// verifies the signature, signer, subject and freshness again (proof-v2.mjs).
export async function readSpoolResult(spoolRoot, job) {
  validateJobV2(job);
  const dir = path.join(spoolRoot, 'incoming');
  const raw = await readBounded(path.join(dir, 'result.json'), 1024 * 1024);
  const readyRaw = await readBounded(path.join(dir, 'result.ready.json'), 4096);
  check(raw && readyRaw, 'STAGE_INPUT_RESULT_MISSING');
  const ready = parse(readyRaw);
  check(plain(ready) && Object.keys(ready).sort().join('|') === 'bytes|contract|sha256' && ready.contract === 'clued.independent-ci.complete-public-file/1'
    && ready.bytes === raw.length && ready.sha256 === hash(raw), 'STAGE_INPUT_RESULT_MISSING');
  const wrapper = parse(raw);
  check(plain(wrapper) && wrapper.contract === RESULT_WRAPPER_CONTRACT_V2 && wrapper.domain === 'production' && plain(wrapper.envelope)
    && wrapper.envelope.contract === ENVELOPE_CONTRACT_V2 && wrapper.envelope.payload?.domain === 'production'
    && wrapper.envelope.payload?.subject?.id === job.id && wrapper.envelope.payload?.subject?.attempt === job.attempt, 'STAGE_INPUT_RESULT_MISSING');
  return Buffer.from(canonical(wrapper.envelope));
}

export async function prepareStageDirectory({ stageRoot, nonce, sealed, resultBytes = null }) {
  check(NONCE32.test(nonce), 'STAGE_NONCE_INVALID');
  const dir = path.join(stageRoot, nonce);
  await fs.mkdir(dir); // never recursive, never an existing directory
  await writeNew(path.join(dir, 'formal-service-entry.json'), sealed.files['formal-service-entry.json']);
  await writeNew(path.join(dir, 'jobs.json'), sealed.files['jobs.json']);
  if (resultBytes) await writeNew(path.join(dir, 'result.json'), resultBytes);
  return dir;
}

export async function askBroker({ brokerRoot, request, clock, sleep, waitUntil }) {
  const requestId = randomUUID();
  await writeNew(path.join(brokerRoot, 'requests', `${requestId}.json`), Buffer.from(canonical(request)));
  const answer = path.join(brokerRoot, 'responses', `${requestId}.json`);
  for (;;) {
    const raw = await readBounded(answer, 8192).catch(() => null);
    if (raw) return { requestId, response: validateBrokerResponse(parse(raw), requestId) };
    if (clock() >= waitUntil) return { requestId, response: null };
    await sleep(1000);
  }
}

export async function invokeStage({ batchDir, stage, workManifestSha256, batchKey, stageRoot = WIN_STAGE, brokerRoot = path.join(WIN_RESIDENT, 'broker'),
  spoolRoot = WIN_SPOOL, receiptsRoot = STATE_V2.receipts, recordDocs = null, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  nonce = randomBytes(16).toString('hex') }) {
  let sealed, controllerSid;
  try {
    check(Number.isSafeInteger(stage) && HEX64.test(batchKey ?? ''), 'STAGE_PACKAGE_REFUSED');
    sealed = await readSealedStage(batchDir, stage, workManifestSha256);
    check(sealed.plan.batchKey === batchKey, 'STAGE_PACKAGE_REFUSED');
    const record = validateRecordV2(recordDocs ?? readRecordDocs(WIN_RECORD), { now: clock() });
    check(sealed.plan.acceptanceSha256 === record.hashes.acceptanceSha256 && sealed.plan.sourceManifestSha256 === record.hashes.sourceManifestSha256
      && sealed.plan.installationSha256 === record.hashes.installationSha256 && sealed.plan.nodeSha256 === record.config.controllerNodeSha256
      && sealed.plan.runtimeConfigPinSha256 === record.hashes.runtimeConfigPinSha256 && sealed.plan.nodeProfileSha256 === hash(record.accepted.node), 'STAGE_PACKAGE_REFUSED');
    controllerSid = record.accepted.node.controllerSid;
  } catch { return buildStageFact({ stage, nonce, workManifestSha256, preflightCode: 'STAGE_PACKAGE_REFUSED' }); }
  let resultBytes = null;
  if (sealed.row.entryRole === 'check-publisher') {
    try { resultBytes = await readSpoolResult(spoolRoot, JSON.parse(sealed.files['jobs.json'].toString('utf8'))[0]); }
    catch { return buildStageFact({ stage, nonce, workManifestSha256, preflightCode: 'STAGE_INPUT_RESULT_MISSING' }); }
  }
  await prepareStageDirectory({ stageRoot, nonce, sealed, resultBytes });
  const request = makeBrokerRequest({ stage, nonce, configSha256: sealed.planSha256, now: clock() });
  // The broker answers after the helper stopped and the original binary was restored; a missing
  // answer after the deadline plus restore time is unknown, never success.
  const { response } = await askBroker({ brokerRoot, request, clock, sleep, waitUntil: Date.parse(request.deadline) + 180_000 });
  const receiptBytes = await readBounded(path.join(receiptsRoot, `windows-formal-entry-${nonce}.json`), 65536).catch(() => null);
  const outcomeBytes = await readBounded(path.join(receiptsRoot, `outcome-${nonce}.json`), 65536).catch(() => null);
  return buildStageFact({ stage, nonce, plan: sealed.plan, planSha256: sealed.planSha256, workManifestSha256, broker: response,
    receipt: receiptBytes ? parse(receiptBytes) : null, receiptBytes, outcome: outcomeBytes ? parse(outcomeBytes) : null, outcomeBytes, controllerSid });
}

// C2 builds only a public stage-11 package, never a batch ledger/workspace. The intent manifest is
// computed independently by the resident from its random key/id and pinned node-profile hash.
export async function invokeRoleProbe({ runKey, runId, nodeProfileSha256, stageRoot = WIN_STAGE, brokerRoot = path.join(WIN_RESIDENT, 'broker'),
  receiptsRoot = STATE_V2.receipts, recordDocs = null, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  nonce = randomBytes(16).toString('hex') }) {
  const intent = { contract: 'clued.independent-ci.role-probe-intent/1', runKey, runId, nodeProfileSha256 };
  const workManifestSha256 = hash(canonical(intent));
  let record, plan, jobsText, planText;
  try {
    check(HEX64.test(runKey ?? '') && /^[0-9a-f]{16}-[0-9a-f]{12}$/.test(runId ?? '') && runId.startsWith(runKey.slice(0, 16)) && HEX64.test(nodeProfileSha256 ?? ''), 'ROLE_PROBE_RUN_REFUSED');
    record = validateRecordV2(recordDocs ?? readRecordDocs(WIN_RECORD), { now: clock(), required: [ENTRY_V2['role-probe']] });
    check(hash(record.accepted.node) === nodeProfileSha256, 'ROLE_PROBE_RUN_REFUSED');
    jobsText = canonical([makeRoleProbeRun({ repo: record.config.repository, runId, sourceManifestSha256: record.config.sourceManifestSha256,
      nodeProfileSha256, createdAt: new Date(clock()).toISOString() })]);
    plan = { contract: PLAN_CONTRACT_V2, enabled: true, stage: 11, entryRole: 'role-probe', batchKey: runKey, batchId: runId,
      ownerPackageAcceptanceRef: record.accepted.ownerPackageAcceptanceRef, nodeSha256: record.config.controllerNodeSha256, nodeProfileSha256,
      entrySha256: record.pins.get(ENTRY_V2['role-probe']), acceptanceSha256: record.hashes.acceptanceSha256, sourceManifestSha256: record.config.sourceManifestSha256,
      installationSha256: record.hashes.installationSha256, runtimeConfigPinSha256: record.hashes.runtimeConfigPinSha256, jobSha256: hash(jobsText) };
    planText = canonical(plan);
  } catch { return buildStageFact({ stage: 11, nonce, workManifestSha256, preflightCode: 'STAGE_PACKAGE_REFUSED' }); }
  await prepareStageDirectory({ stageRoot, nonce, sealed: { files: { 'formal-service-entry.json': Buffer.from(planText), 'jobs.json': Buffer.from(jobsText) } } });
  const planSha256 = hash(planText);
  const request = makeBrokerRequest({ stage: 11, nonce, configSha256: planSha256, now: clock() });
  const { response } = await askBroker({ brokerRoot, request, clock, sleep, waitUntil: Date.parse(request.deadline) + 180_000 });
  const receiptBytes = await readBounded(path.join(receiptsRoot, `windows-formal-entry-${nonce}.json`), 65536).catch(() => null);
  const outcomeBytes = await readBounded(path.join(receiptsRoot, `outcome-${nonce}.json`), 65536).catch(() => null);
  return buildStageFact({ stage: 11, nonce, plan, planSha256, workManifestSha256, broker: response,
    receipt: receiptBytes ? parse(receiptBytes) : null, receiptBytes, outcome: outcomeBytes ? parse(outcomeBytes) : null, outcomeBytes,
    controllerSid: record.accepted.node.controllerSid, expectedJobIds: JSON.parse(jobsText).map(j => j.id) });
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv[0] === '--role-probe') {
    if (argv.length !== 6 || argv[2] !== '--probe-id' || argv[4] !== '--node-profile-sha256') {
      output.write(JSON.stringify({ state: 'REFUSED', failure_code: 'STAGE_PACKAGE_REFUSED' }) + '\n'); return 2;
    }
    const fact = await invokeRoleProbe({ runKey: argv[1], runId: argv[3], nodeProfileSha256: argv[5] });
    output.write(JSON.stringify(fact) + '\n');
    return fact.state === 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION' ? 0 : 41;
  }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--batch-dir', '--stage', '--work-manifest-sha256', '--batch-key'].includes(argv[i]) || typeof argv[i + 1] !== 'string' || Object.hasOwn(args, argv[i])) {
      output.write(JSON.stringify({ state: 'REFUSED', failure_code: 'STAGE_PACKAGE_REFUSED' }) + '\n'); return 2;
    }
    args[argv[i]] = argv[i + 1];
  }
  const fact = await invokeStage({ batchDir: args['--batch-dir'], stage: Number(args['--stage']), workManifestSha256: args['--work-manifest-sha256'], batchKey: args['--batch-key'] });
  output.write(JSON.stringify(fact) + '\n');
  return fact.state === 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION' ? 0 : 41;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
