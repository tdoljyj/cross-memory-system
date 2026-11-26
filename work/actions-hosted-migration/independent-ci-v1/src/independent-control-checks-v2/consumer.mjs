// Protected installed consumer of the Source v2 control pair (PR-A integration; DESIGN v0.7 gap list).
// scripts/ci/clued-work-admission.mjs reads it for CLUED_EXECUTION_PROVIDER=independent-control-checks-v2,
// exactly as it reads independent-control-checks-v1/consumer.mjs for v1. App, name and external_id are
// correlation only, never authority: the authority is the settled controller journal entry of the exact v2
// job and batch claim generation (state\v2\effects-control, state\v2\batch-claims), re-proved by a fresh
// complete Native admission before and after the GitHub read-back (publisher.mjs#consume).
//
// v2 has no installed per-batch job file: the batch is found from the batch-claim records stage 1 wrote
// (create-only, controller-owned), and the control jobs are re-derived from their content (job ids, contract
// /3, exclude createdAt and the claim). The tested commit S comes from the record itself (batch-claim-v2.mjs: /1 is
// S = H, /2 names a train front batch's S). Only clued-control on Windows ever reaches the installed path; any
// other caller is refused before a single file is opened.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batchJobsV2, CONTROL_ROLES_V2, makeJobV2 } from '../job-v2.mjs';
import { recordTestShaV2, validateBatchClaimRecord } from '../batch-claim-v2.mjs';
import { CONTROL_CHECKS_V2, REPO, createProductionControlPublisherV2, takeActualControlConsumptionV2 } from './publisher.mjs';

export const CONSUMER_PROVIDER_V2 = 'independent-control-checks-v2';
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const MAX_BATCH_CLAIMS = 4096;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const roleForName = name => Object.entries(CONTROL_CHECKS_V2).find(([, d]) => d.name === name)?.[0] ?? null;

// Batch-claim records -> the control job for `name` of every batch that matches the selector (head, and pr
// and base when given). Pure over the parsed records; a record that does not validate is skipped. A train front
// batch (S != H) is never matched on the selector's base: the protected gate passes the PR's base.sha, which GitHub
// moves only on a push, while the record names the batch base T (design v0.5 §5.7, DESIGN §21.3).
export function controlJobsFor(records, { repository, pr = null, headSha, baseSha = null, name }, ciSourceManifestSha256) {
  const role = roleForName(name);
  check(repository === REPO && SHA.test(headSha ?? '') && role && HASH.test(ciSourceManifestSha256 ?? '')
    && (pr === null || (Number.isSafeInteger(pr) && pr > 0)) && (baseSha === null || SHA.test(baseSha)), 'CONTROL_CONSUMER_SUBJECT_REQUIRED');
  const out = [];
  for (const r of records) {
    const testSha = recordTestShaV2(r), front = typeof testSha === 'string' && testSha !== r?.headSha;
    if (r?.repo !== repository || r.headSha !== headSha || (pr !== null && r.pr !== pr) || (baseSha !== null && !front && r.baseSha !== baseSha) || r.sourceManifestSha256 !== ciSourceManifestSha256) continue;
    let admission;
    try {
      admission = makeJobV2({ repo: r.repo, pr: r.pr, headSha: r.headSha, baseSha: r.baseSha, testSha, role: 'work-admission', sourceManifestSha256: r.sourceManifestSha256, createdAt: r.createdAt, attempt: r.attempt });
      validateBatchClaimRecord(r, admission);
    } catch { continue; }
    const jobs = batchJobsV2({ repo: r.repo, pr: r.pr, headSha: r.headSha, baseSha: r.baseSha, testSha, sourceManifestSha256: r.sourceManifestSha256, createdAt: r.createdAt, attempt: r.attempt });
    out.push({ job: jobs[role], claim: Object.freeze({ ...r.claim }), selector: { repository, pr: r.pr, headSha, baseSha: r.baseSha, name } });
  }
  // Newest attempt first: attempt 2 only exists after attempt 1 failed before stage 8 (attempts.mjs).
  return out.sort((a, b) => b.job.attempt - a.job.attempt);
}

// Consume exactly one batch's control check. More than one settled candidate for different subjects (the
// same head in two PRs or bases) is ambiguous and fails closed; none settled is no green check.
export async function consumeControlV2({ candidates, consumerFor }) {
  check(Array.isArray(candidates) && candidates.length > 0, 'CONTROL_HEAD_NOT_CURRENT');
  const proofs = [], refusals = [];
  for (const c of candidates) {
    try { proofs.push({ c, proof: await consumerFor(c.claim).consume(c.job, c.selector) }); }
    catch (error) { refusals.push(error?.code ?? 'CONTROL_CONSUMPTION_UNCONFIRMED'); }
  }
  const usable = proofs.filter(p => p.proof?.contract === 'clued.independent-ci.control-consumption/2');
  if (usable.length === 0) fail(refusals.includes('TRUSTED_SETTLED_CONTROL_JOURNAL_REQUIRED') || refusals.length === 0 ? 'TRUSTED_SETTLED_CONTROL_JOURNAL_REQUIRED' : refusals[0]);
  // Step 3c-2: the tested commit is part of the subject; a head batch and a front batch of one head never merge into one.
  const subjects = new Set(usable.map(p => `${p.c.selector.pr}:${p.c.selector.baseSha}:${p.c.job.testSha}`));
  check(subjects.size === 1, 'CONTROL_HEAD_AMBIGUOUS');
  return usable[0];
}

async function readBatchClaims(directory) {
  const names = (await fs.readdir(directory)).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort();
  check(names.length <= MAX_BATCH_CLAIMS, 'BATCH_CLAIM_INVENTORY_BOUND');
  const out = [];
  for (const n of names) {
    try {
      const st = await fs.lstat(path.join(directory, n));
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 65536) continue;
      out.push(JSON.parse(await fs.readFile(path.join(directory, n), 'utf8')));
    } catch { /* unreadable: never a candidate */ }
  }
  return out;
}

// Only the protected controller principal may run the installed consumer (it reads the two controller
// secrets through entry-runtime.mjs); anything else is refused before any file is opened.
export function assertControllerPrincipal(identity = { platform: process.platform, username: os.userInfo().username }) {
  check(identity.platform === 'win32' && String(identity.username).toLowerCase() === 'clued-control', 'CONTROL_CONSUMER_V2_PRINCIPAL_REQUIRED');
}

async function withInstalledControlV2(selector, operation) {
  assertControllerPrincipal();
  const [{ openHeldRecord, takeHeldRecord, assertOwnSourceRoot }, { validateRecordV2 }, { controllerPrincipal, controllerPorts, observationLog, authorityOf }, { STATE_V2 }, { EffectJournal }] = await Promise.all([
    import('../resident-v2/held-record.mjs'), import('../resident-v2/record.mjs'), import('../resident-v2/entry-runtime.mjs'), import('../resident-v2/layout.mjs'), import('../effect-journal.mjs')]);
  const lease = takeHeldRecord(await openHeldRecord());
  try {
    assertOwnSourceRoot(lease, import.meta.url);
    const held = lease.data, live = () => { takeHeldRecord(lease); };
    const record = validateRecordV2(held.documents, { identity: { platform: process.platform, arch: process.arch, hostname: os.hostname(), account: os.userInfo().username } });
    const candidates = controlJobsFor(await readBatchClaims(STATE_V2.batchClaims), selector, record.config.sourceManifestSha256);
    const { appKey, nativeToken, bindingId } = await controllerPrincipal(record);
    const log = observationLog(STATE_V2.effectsControl, candidates[0]?.job.id ?? '0'.repeat(64));
    const sourceRoot = held.sourceRoot;
    const { github, admission } = controllerPorts({ record, appKey, nativeToken, bindingId, policyText: held.policyText, sourceRoot, live, log });
    const journal = await EffectJournal.open(STATE_V2.effectsControl);
    const consumerFor = batchClaim => createProductionControlPublisherV2({ github, journal, admission, assertLive: live, record: log, authority: authorityOf(record.accepted), batchClaim });
    return await operation({ candidates, consumerFor });
  } finally { await lease.close(); }
}

export async function readIndependentControlChecksOnHeadV2({ repository, headSha, name }) {
  check(repository === REPO && SHA.test(headSha ?? '') && roleForName(name), 'CONTROL_HEAD_SELECTOR_REQUIRED');
  const { c, proof } = await withInstalledControlV2({ repository, headSha, name }, consumeControlV2);
  return [takeActualControlConsumptionV2(proof, c.selector).check];
}

export async function consumeIndependentGateV2({ repository, pr, headSha, baseSha }) {
  check(repository === REPO, 'FIXED_CONTROL_REPOSITORY_REQUIRED');
  const selector = { repository, pr, headSha, baseSha, name: CONTROL_CHECKS_V2['control-admission'].name };
  check(exact(selector, ['repository', 'pr', 'headSha', 'baseSha', 'name']) && Number.isSafeInteger(pr) && pr > 0 && SHA.test(headSha ?? '') && SHA.test(baseSha ?? ''), 'CONTROL_CONSUMER_SUBJECT_REQUIRED');
  const { c, proof } = await withInstalledControlV2(selector, consumeControlV2);
  takeActualControlConsumptionV2(proof, c.selector);
  return Object.freeze({ event: 'independent-control', admitted: true, verdict: 'ADMITTED', reasons: [], head_sha: headSha, base_sha: baseSha, pr_ref: `${repository}#${pr}`,
    execution_provider: CONSUMER_PROVIDER_V2, source_observation: { contract: proof.contract, check_run_id: proof.check.id, job_id: proof.subject.id, attempt: proof.subject.attempt,
      claim_id: proof.claim.claimId, fence: proof.claim.fence, epoch: proof.claim.epoch, source_manifest_sha256: proof.subject.sourceManifestSha256, effect_key: proof.effectKey,
      binding_sha256: proof.bindingSha256, native_observation_sha256: proof.nativeObservationAfterSha256 }, qualification_issued: false, native_ticket_issued: false });
}

export { CONTROL_ROLES_V2 };
