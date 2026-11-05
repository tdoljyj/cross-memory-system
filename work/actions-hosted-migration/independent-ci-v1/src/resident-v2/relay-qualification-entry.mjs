// Fixed Source entry for a short read-only qualification observation. Main has
// no injectable effects: it obtains the held record, installed principal and
// fixed network ports itself. Exported collectors permit memory-only tests;
// their return values are observations, never a production capability.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { canonical, digest } from '../proof.mjs';
import { makeJobV2, batchRefV2 } from '../job-v2.mjs';
import { readBatchClaim } from '../batch-claim-v2.mjs';
import { createGitHubChecksPort } from '../github.mjs';
import { assertProtectedPaths, readProtected } from '../../runtime/protected-files.mjs';
import { runEntry, controllerPrincipal, controllerPorts, observationLog } from './entry-runtime.mjs';
import { ENTRY_V2, STATE_V2, OUTCOME_CONTRACT } from './layout.mjs';
import { FIXED_APP } from './record.mjs';
import { validateRegistry } from '../hosted-relay-v1/registry.mjs';
import { createQualificationObserver } from '../hosted-relay-v1/qualification-observer.mjs';
import { GITHUB_OIDC_JWKS_URL, createJwksPort, parseJwks } from '../hosted-relay-v1/oidc.mjs';
import { makeRelayQualificationRun, validateRelayQualificationRun, relayQualificationWindow,
  relayQualificationSubjectSha256, validateRelayQualificationObservation,
  RELAY_QUALIFICATION_OBSERVATION_CONTRACT, RELAY_QUALIFICATION_RUN_FIELDS } from './relay-qualification-run.mjs';

const HASH = /^[a-f0-9]{64}$/, SHA = /^[a-f0-9]{40}$/, NONCE = /^[a-f0-9]{32}$/;
const READER_METHODS = Object.freeze(['readPullRequest', 'readBranchHead', 'readCompare', 'readChangedPaths',
  'readGitCommit', 'readGitTree', 'readCheckRunsByName', 'readChecks', 'readCheckRunAnnotations']);
const REGISTRY_PATH = 'work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.json';
const RECEIPT_CONTRACT = 'clued.independent-ci.windows-formal-entry-receipt/2';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const hashBytes = value => createHash('sha256').update(value).digest('hex');
const publicCodes = new Set(['RELAY_QUALIFICATION_WINDOW_REQUIRED', 'RELAY_QUALIFICATION_CURRENT_REQUIRED',
  'RELAY_QUALIFICATION_STAGE1_REQUIRED', 'RELAY_QUALIFICATION_PRIOR_REQUIRED', 'RELAY_QUALIFICATION_PATHS_CHANGED',
  'RELAY_QUALIFICATION_OBSERVER_REFUSED', 'RELAY_QUALIFICATION_REF_UNCONFIRMED',
  'RELAY_QUALIFICATION_NETWORK_REFUSED', 'RELAY_QUALIFICATION_PRINCIPAL_REQUIRED']);
function fixedReason(error) {
  try { const d = Object.getOwnPropertyDescriptor(error, 'code');
    return d && Object.hasOwn(d, 'value') && publicCodes.has(d.value) ? d.value : 'RELAY_QUALIFICATION_OBSERVER_REFUSED';
  } catch { return 'RELAY_QUALIFICATION_OBSERVER_REFUSED'; }
}
export function qualificationWorkAdmissionJob(job) {
  const j = validateRelayQualificationRun(job);
  return makeJobV2({ repo: j.repo, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, testSha: j.testSha,
    sourceManifestSha256: j.sourceManifestSha256, role: 'work-admission', attempt: 1, createdAt: j.createdAt });
}
function parsed(bytes, code) {
  check(typeof bytes === 'string' && Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 65536, code);
  let value; try { value = JSON.parse(bytes); } catch { fail(code); }
  check(value && Object.getPrototypeOf(value) === Object.prototype, code); return value;
}

// Both strings must come from fixed, ACL-checked state files in main. This
// pure verifier cannot turn caller JSON into evidence of a protected read.
export function validateQualificationProtectedEnding({ outcomeText, nativeText, nonce, outcomeSha256,
  record, stage, entryRole, expectedJobId }) {
  const code = stage === 1 ? 'RELAY_QUALIFICATION_STAGE1_REQUIRED' : 'RELAY_QUALIFICATION_PRIOR_REQUIRED';
  const outcome = parsed(outcomeText, code), native = parsed(nativeText, code);
  check(NONCE.test(nonce ?? '') && HASH.test(outcomeSha256 ?? '') && HASH.test(expectedJobId ?? '')
    && hashBytes(outcomeText) === outcomeSha256, code);
  check(outcome.contract === OUTCOME_CONTRACT && outcome.nonce === nonce && outcome.stage === stage
    && outcome.entryRole === entryRole && Array.isArray(outcome.jobIds) && outcome.jobIds.length === 1
    && outcome.jobIds[0] === expectedJobId && Number.isSafeInteger(outcome.sideEffects) && outcome.sideEffects >= 0
    && (stage === 1 ? outcome.status === 'SETTLED' && outcome.mayHavePublished === true
      : outcome.status === 'RELAY_QUALIFICATION_OBSERVATION' && outcome.sideEffects === 0 && outcome.mayHavePublished === false), code);
  check(native.contract === RECEIPT_CONTRACT && native.nonce === nonce && native.stage === stage && native.entry_role === entryRole
    && native.outcome_sha256 === outcomeSha256 && native.source_manifest_sha256 === record.config.sourceManifestSha256
    && native.acceptance_sha256 === record.hashes.acceptanceSha256
    && native.entry_sha256 === record.pins.get(ENTRY_V2[entryRole]) && HASH.test(native.config_sha256 ?? '')
    && native.actual_sid === record.accepted.node.controllerSid && native.session_id === 0
    && Number.isSafeInteger(native.service_pid) && native.service_pid > 0 && Number.isSafeInteger(native.node_pid) && native.node_pid > 0
    && native.state === 'FIXED_CHILD_COMPLETED' && native.failure_code === null && native.node_exit_code === 0
    && native.timed_out === false && native.stop_requested === false && native.stdout_captured === false
    && native.private_bytes_read_by_helper === false && native.host_qualification === false && native.ci_principal_qualification === false
    && native.tree_cleanup_confirmed === true && native.root_exit_confirmed === true && native.tree_active_processes === 0
    && native.tree_cleanup_failure_code === null, code);
  return Object.freeze(outcome);
}

export function createQualificationCurrentGate({ record, job, native, live, clock = Date.now }) {
  const j = validateRelayQualificationRun(job), q = relayQualificationWindow(record, { job: j, now: clock(), reserveMs: 300000 });
  check(q && typeof native?.current === 'function' && typeof live === 'function', 'RELAY_QUALIFICATION_WINDOW_REQUIRED');
  const normalJob = qualificationWorkAdmissionJob(j);
  check(normalJob.id === j.stage1JobId, 'RELAY_QUALIFICATION_STAGE1_REQUIRED');
  const identity = Object.freeze({ job: normalJob, claim: Object.freeze({ claim_id: j.claimId, fence: j.fence, execution_epoch: j.executionEpoch }) });
  const mode = Object.freeze({ scope: record.config.scope, paths: q.changedPaths, executionPolicy: q.executionPolicy, guarded: q.guarded });
  let denied = false;
  return async () => {
    if (denied) fail('RELAY_QUALIFICATION_CURRENT_REQUIRED');
    try {
      live(); check(relayQualificationWindow(record, { job: j, now: clock(), reserveMs: 0 }), 'RELAY_QUALIFICATION_WINDOW_REQUIRED');
      check(await native.current(identity, mode) === true, 'RELAY_QUALIFICATION_CURRENT_REQUIRED'); live();
    } catch { denied = true; fail('RELAY_QUALIFICATION_CURRENT_REQUIRED'); }
  };
}

export function qualificationReadOnlyGithub(github, current) {
  check(typeof current === 'function' && READER_METHODS.every(k => typeof github?.[k] === 'function'), 'RELAY_QUALIFICATION_PRINCIPAL_REQUIRED');
  return Object.freeze({ fixture: github.fixture === true,
    ...Object.fromEntries(READER_METHODS.map(name => [name, async (...args) => { await current(); return github[name](...args); }])) });
}

// Main also uses this below the GitHub port, so pagination/retries each get a
// new currentness check. Native.current uses the original fixed Native port,
// never this wrapper (which would recurse).
export function qualificationNetworkFetch(fetchImpl, current) {
  return async (url, init = {}) => {
    const u = new URL(String(url)), method = init.method ?? 'GET';
    check(!u.username && !u.password && !u.hash, 'RELAY_QUALIFICATION_NETWORK_REFUSED');
    const tokenMint = u.origin === 'https://api.github.com' && u.pathname === `/app/installations/${FIXED_APP.installationId}/access_tokens`
      && u.search === '' && method === 'POST';
    check((method === 'GET' && (u.origin === 'https://api.github.com' || u.href === GITHUB_OIDC_JWKS_URL)) || tokenMint,
      'RELAY_QUALIFICATION_NETWORK_REFUSED');
    await current(); return fetchImpl(url, init);
  };
}

function initialJob(job) {
  const input = Object.fromEntries(RELAY_QUALIFICATION_RUN_FIELDS.filter(k => !['contract', 'id'].includes(k)).map(k => [k, job[k]]));
  return makeRelayQualificationRun({ ...input, phase: 'initial', priorObservationNonce: null, priorObservationSha256: null });
}
async function protectedEnding(readReceipt, job, record, prior = false) {
  const nonce = prior ? job.priorObservationNonce : job.stage1OutcomeNonce;
  const pin = prior ? job.priorObservationSha256 : job.stage1OutcomeSha256;
  const expectedJobId = prior ? initialJob(job).id : job.stage1JobId;
  const packet = await readReceipt(nonce);
  return validateQualificationProtectedEnding({ ...packet, nonce, outcomeSha256: pin, record,
    stage: prior ? 13 : 1, entryRole: prior ? 'relay-qualification' : 'work-admission', expectedJobId });
}
function mapInitialObservation(result, reference, job, now) {
  check(result && ['OBSERVATIONS_VERIFIED_NO_QUALIFICATION', 'REGISTRY_REPIN_REQUIRED'].includes(result.status)
    && result.liveQualified === false && result.repository === job.repo && result.pr === job.pr
    && result.headSha === job.headSha && result.baseSha === job.baseSha && result.freshJwksGetCompleted === true
    && reference?.ref === `refs/pull/${job.pr}/merge` && SHA.test(reference.beforeRefSha ?? '')
    && reference.beforeRefSha === reference.afterRefSha && reference.oldMergeSha === reference.beforeRefSha
    && reference.oldMergeReadBySha === true && Array.isArray(result.roles) && result.roles.length === 2
    && result.roles.every(r => r.oldMergeSha === reference.beforeRefSha && r.oldMergeReadBySha === true), 'RELAY_QUALIFICATION_REF_UNCONFIRMED');
  return validateRelayQualificationObservation({ contract: RELAY_QUALIFICATION_OBSERVATION_CONTRACT,
    jobId: job.id, phase: job.phase, subjectSha256: relayQualificationSubjectSha256(job), observedAt: new Date(now).toISOString(), liveQualified: false,
    roles: result.roles.map(r => ({ role: r.role, verdict: 'ATTESTED_SUCCESS', checkRunId: r.checkRunId, workflowRunId: r.runId,
      runAttempt: r.runAttempt, annotationsComplete: r.annotationsComplete, identityAnnotationCount: r.identityAnnotationCount,
      totalAnnotationCount: r.totalAnnotationCount, fullAnnotationsSha256: r.fullAnnotationsSha256,
      tokenPresent: true, tokenSha256: r.tokenSha256, signatureVerified: true, verifiedClaims: r.verifiedClaims,
      claimsSha256: r.claimsSha256, checkRunIdClaimPresent: r.checkRunIdPresent, registryBindsCheckRunId: r.registryBindsCheckRunId,
      keyThumbprintSha256: r.keyThumbprintSha256, attestationSha256: r.attestationSha256 })),
    refObservation: { ref: reference.ref, beforeMergeSha: reference.beforeRefSha, afterMergeSha: reference.afterRefSha, oldMergeReadable: true },
    jwksObservation: { networkFetched: true, sha256: result.jwksSha256 } }, job);
}

// Ports here are injectable for memory fixtures. Only main constructs them in
// production; no parameter or JSON flag can enter main's held/principal chain.
export async function collectRelayQualificationObservation({ job, record, github, native, live, fetchImpl, registry,
  readReceipt, readClaim, clock = Date.now }) {
  const j = validateRelayQualificationRun(job), q = relayQualificationWindow(record, { job: j, now: clock(), reserveMs: 300000 });
  check(q, 'RELAY_QUALIFICATION_WINDOW_REQUIRED');
  const current = createQualificationCurrentGate({ record, job: j, native, live, clock });
  const normalJob = qualificationWorkAdmissionJob(j);
  await protectedEnding(readReceipt, j, record);
  const claim = await readClaim(normalJob);
  check(claim?.claimId === j.claimId && claim.fence === j.fence && claim.epoch === j.executionEpoch, 'RELAY_QUALIFICATION_STAGE1_REQUIRED');
  await current();
  const readGithub = qualificationReadOnlyGithub(github, current), readFetch = qualificationNetworkFetch(fetchImpl, current);
  if (j.phase === 'initial') {
    const paths = await readGithub.readChangedPaths(normalJob);
    check(paths?.complete === true && paths.pr === j.pr && paths.headSha === j.headSha && paths.baseSha === j.baseSha
      && Array.isArray(paths.paths) && canonical(paths.paths) === canonical(q.changedPaths)
      && digest(paths.paths) === q.changedPathsSha256, 'RELAY_QUALIFICATION_PATHS_CHANGED');
    const observer = createQualificationObserver({ github: readGithub, registry, fetchImpl: readFetch, clock });
    const result = await observer.observe({ repo: j.repo, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha,
      roles: ['gitleaks', 'trivy'] });
    // Fail a latched revocation even if an inner observer sanitized the error.
    await current();
    return mapInitialObservation(result, observer.currentMergeObservation({ pr: j.pr, headSha: j.headSha }), j, clock());
  }
  const priorOutcome = await protectedEnding(readReceipt, j, record, true);
  const prior = validateRelayQualificationObservation(priorOutcome.observation, initialJob(j));
  const before = prior.refObservation.beforeMergeSha;
  check(prior.refObservation.afterMergeSha === before && prior.refObservation.oldMergeReadable
    && prior.roles.every(r => r.verdict === 'ATTESTED_SUCCESS' && r.signatureVerified && r.verifiedClaims.sha === before), 'RELAY_QUALIFICATION_PRIOR_REQUIRED');
  // A changed current HEAD is allowed here: the old H is never executed again.
  const pr = await readGithub.readPullRequest(j.pr);
  check(pr?.number === j.pr && pr.state === 'open' && pr.draft === false && pr.head?.repo?.full_name === j.repo
    && pr.base?.repo?.full_name === j.repo && pr.base?.ref === registry.baseRef
    && SHA.test(pr.merge_commit_sha ?? '') && pr.merge_commit_sha !== before, 'RELAY_QUALIFICATION_REF_UNCONFIRMED');
  const old = await readGithub.readGitCommit(before);
  check(old?.sha === before && SHA.test(old.tree ?? '') && Array.isArray(old.parents) && old.parents.length === 2
    && old.parents[1] === j.headSha && SHA.test(old.parents[0] ?? ''), 'RELAY_QUALIFICATION_REF_UNCONFIRMED');
  const jwks = await createJwksPort({ fetchImpl: readFetch }).fetchJwks(); parseJwks(jwks);
  await current();
  return validateRelayQualificationObservation({ ...prior, jobId: j.id, phase: j.phase,
    observedAt: new Date(clock()).toISOString(),
    refObservation: { ref: `refs/pull/${j.pr}/merge`, beforeMergeSha: before, afterMergeSha: pr.merge_commit_sha, oldMergeReadable: true },
    jwksObservation: { networkFetched: true, sha256: digest(jwks) } }, j);
}

async function installedRegistry(held, sourceRoot, live) {
  const file = path.join(sourceRoot, ...REGISTRY_PATH.split('/')); live();
  const text = await readProtected(file); live();
  check(hashBytes(text) === held.sourceHashes.get(REGISTRY_PATH), 'RELAY_QUALIFICATION_PRINCIPAL_REQUIRED');
  return validateRegistry(JSON.parse(text), { domain: 'production' });
}
async function installedReceipt(nonce) {
  check(NONCE.test(nonce ?? ''), 'RELAY_QUALIFICATION_STAGE1_REQUIRED');
  const outcomeFile = path.join(STATE_V2.receipts, `outcome-${nonce}.json`);
  const nativeFile = path.join(STATE_V2.receipts, `windows-formal-entry-${nonce}.json`);
  await assertProtectedPaths(STATE_V2.receipts, [outcomeFile, nativeFile], true);
  return { outcomeText: await readProtected(outcomeFile), nativeText: await readProtected(nativeFile) };
}
export async function main(argv = process.argv.slice(2), output = process.stdout) {
  return runEntry({ argv, entryRole: 'relay-qualification', moduleUrl: import.meta.url, output,
    successStatuses: ['RELAY_QUALIFICATION_OBSERVATION'], body: async ({ inputs, held, live, sourceRoot }) => {
      try {
        const job = validateRelayQualificationRun(inputs.jobs[0]);
        check(relayQualificationWindow(inputs.record, { job, reserveMs: 300000 }), 'RELAY_QUALIFICATION_WINDOW_REQUIRED');
        const registry = await installedRegistry(held, sourceRoot, live);
        const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
        const log = observationLog(STATE_V2.receipts, job.id);
        const ports = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
        const current = createQualificationCurrentGate({ record: inputs.record, job, native: ports.native, live });
        const fetchImpl = qualificationNetworkFetch(ports.fetchImpl, current);
        const github = createGitHubChecksPort({ repository: inputs.record.config.repository, repositoryId: FIXED_APP.repositoryId,
          appId: FIXED_APP.appId, installationId: FIXED_APP.installationId, privateKeyProvider: async () => appKey, fetchImpl });
        const readClaim = async normalJob => {
          const file = path.join(STATE_V2.batchClaims, `${batchRefV2(normalJob)}.json`);
          await assertProtectedPaths(STATE_V2.batchClaims, [file], true);
          return readBatchClaim(STATE_V2.batchClaims, normalJob);
        };
        const observation = await collectRelayQualificationObservation({ job, record: inputs.record, github, native: ports.native,
          live, fetchImpl, registry, readReceipt: installedReceipt, readClaim });
        return { status: 'RELAY_QUALIFICATION_OBSERVATION', reason: null, sideEffects: 0, liveQualified: false, observation };
      } catch (error) { return { status: 'BLOCKED', reason: fixedReason(error), sideEffects: 0, liveQualified: false }; }
    } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
