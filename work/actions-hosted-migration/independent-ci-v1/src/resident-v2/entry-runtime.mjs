// Shared production plumbing of the four Source v2 node entries (work admission, scanner issuer, check
// publisher, control pair). Started only by the generic helper as clued-control:
//   node <entry> --run --stage <nonce> --config-sha256 <sha>
// It holds the record and Source by handle (held-record.mjs), re-verifies the stage inputs, reads the two
// controller secrets exactly as v1 did (protected-files.mjs; the resident never reads them, I5), builds
// the GitHub and full-admission v2 ports, and ALWAYS writes the entry outcome record (S11) before exit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { canonical, digest } from '../proof.mjs';
import { serverAnswerCurrent } from '../clock-skew.mjs';
import { createGitHubChecksPort } from '../github.mjs';
import { createFullAdmissionPortV2 } from '../full-admission-v2.mjs';
import { INSTALL_ROOT, APP_KEY_FILE, assertProtectedPaths, readProtected } from '../../runtime/protected-files.mjs';
import { openHeldRecord, takeHeldRecord, assertOwnSourceRoot, sourceRootOfModule } from './held-record.mjs';
import { loadStageInputs, parseEntryArgs, writeOutcome } from './stage-inputs.mjs';
import { STATE_V2 } from './layout.mjs';
import { FIXED_APP } from './record.mjs';
import { cluedRpc } from '../../../../../scripts/ci/clued-work-admission.mjs';
import { createIndependentPublicationPortsForJobs, independentControllerId } from '../../../../../scripts/ci/clued-independent-publication-port.mjs';
import { registerIndependentController } from '../../../../../scripts/ci/clued-independent-revoker.mjs';
import { revocationQualification } from './revocation-run.mjs';
import { ALL_STAGE_CODES } from './stage-fact.mjs';
import { withReadRetry } from '../read-retry.mjs';
import { createIndependentScanStartPort } from '../scan-start-v1/native-port.mjs';
import { HOLDERS_RPC } from '../independent-control-checks-v2/merge-slot-native.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
// Public reasons are a vocabulary, never an arbitrary exception's printable
// code/message. Preserve the lifecycle and transport distinctions the resident
// uses, without invoking accessors, coercion or an exception's prototype.
const PUBLIC_ENTRY_REASONS = new Set([...ALL_STAGE_CODES,
  'ENTRY_OPERATION_UNCONFIRMED', 'FIXED_WINDOWS_ENTRY_REQUIRED', 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED',
  'NATIVE_PUBLICATION_SCOPE_REFUSED', 'NATIVE_PUBLICATION_UNAVAILABLE', 'independent_revoker_qualification_required',
  'OBSERVATION_KIND_REFUSED', 'OBSERVATION_LOG_BOUNDARY', 'OBSERVATION_LOG_UNCONFIRMED', 'HELD_SOURCE_PINS_CHANGED',
  'ACTUAL_HELD_RECORD_LEASE_REQUIRED', 'ACTUAL_WINDOWS_HELD_RECORD_REQUIRED', 'ENTRY_OUTSIDE_HELD_SOURCE_REFUSED',
  'HELD_POLICY_BYTES_CHANGED', 'HELD_RECORD_CONTROLLER_REFUSED', 'HELD_RECORD_DOCUMENTS_REFUSED',
  'HELD_RECORD_DOCUMENT_BOUND', 'HELD_RECORD_EXTRA_OUTPUT_REFUSED', 'HELD_RECORD_JSON_REFUSED', 'HELD_RECORD_LEASE_LOST',
  'HELD_RECORD_OUTPUT_BOUND', 'HELD_RECORD_PINS_REFUSED', 'HELD_RECORD_PROCESS_UNCONFIRMED', 'HELD_RECORD_REFUSED',
  'EXACT_SELECTED_JOB_PLAN_PIN_REQUIRED', 'EXACT_STAGE_JOBS_REQUIRED', 'EXACT_STAGE_PLAN_REQUIRED',
  'FIXED_FORMAL_ENTRY_ROLE_REQUIRED', 'FIXED_V2_ENTRY_ARGUMENTS_REQUIRED', 'INSTALLED_RECORD_BINDING_CHANGED',
  'OUTCOME_NONCE_INVALID', 'STAGE_INPUT_BOUNDARY', 'STAGE_INPUT_CHANGED', 'STAGE_INPUT_DIRECTORY_REQUIRED', 'STAGE_INPUT_RESULT_REQUIRED',
  'EXACT_FORMAL_PLAN_V2_REQUIRED', 'EXACT_REVIEWED_STAGE_MANIFEST_REQUIRED', 'EXACT_STAGE_CLOSURE_REQUIRED',
  'EXACT_STAGE_WORK_PIN_REQUIRED', 'SEALED_STAGE_BINDING_REQUIRED', 'SEALED_STAGE_DIRECTORY_REQUIRED',
  'SEALED_STAGE_FILE_BOUNDARY', 'SEALED_STAGE_FILE_CHANGED', 'SEALED_STAGE_PLAN_CHANGED', 'SEALED_STAGE_SOURCE_CHANGED',
  'ACCEPTED_SOURCE_INCOMPLETE', 'ACCEPTED_SOURCE_MISSING', 'RECORD_ACCEPTANCE_INVALID', 'RECORD_ACCEPTANCE_REQUIRED',
  'RECORD_BINDING_CHANGED', 'RECORD_CANONICAL_BYTES_REQUIRED', 'RECORD_CONTROLLER_CONFIG_REQUIRED', 'RECORD_DOCUMENTS_REQUIRED',
  'RECORD_EVALUATOR_CHANGED', 'RECORD_HOST_IDENTITY_REQUIRED', 'RECORD_INSTALLATION_INVALID', 'RECORD_MANIFEST_INVALID',
  'RECORD_NODE_PROFILE_REQUIRED', 'RECORD_SIGNERS_CHANGED', 'RECORD_SIGNERS_INVALID', 'RECORD_SIGNERS_REQUIRED',
  'RECORD_SOURCE_MANIFEST_REQUIRED', 'SOURCE_PIN_INVALID', 'unsafe_installation_file', 'secret_file_boundary_unconfirmed',
  'installation_file_replaced', 'installation_file_unreadable', 'installation_link_refused', 'installation_acl_unqualified',
  'full_admission_unavailable', 'full_admission_mode_unknown', 'full_admission_observer_unknown', 'full_admission_observation_expired',
  'full_admission_not_configured', 'full_admission_subject_invalid', 'full_admission_source_changed', 'full_admission_clock_invalid',
  'full_admission_principal_unknown', 'full_admission_incomplete', 'full_admission_paths_refused', 'full_admission_github_forbidden',
  'full_admission_rejected', 'full_admission_claim_missing', 'full_admission_native_changed', 'full_admission_claim_changed',
  'full_admission_subject_changed', 'full_admission_native_unsupported', 'native_policy_changed', 'execution_proof_refused',
  'evidence_identity_conflict', 'role_already_published_on_head', 'role_already_on_github', 'BATCH_CLAIM_MISSING',
  'BRIDGE_RESULT_DEADLINE', 'FORMAL_BRIDGE_STAGE_DEADLINE', 'ACTUAL_ISSUE_NOT_PUBLISHED', 'ISSUE_TRANSFER_UNCONFIRMED',
  'ACTUAL_NATIVE_CALLBACK_NOT_PUBLISHED', 'NATIVE_CALLBACK_TRANSFER_UNCONFIRMED', 'BRIDGE_CALLBACK_DEADLINE',
  'native_claim_observation_unavailable', 'github_transport_unconfirmed', 'github_transient_unavailable',
  'COMPLETE_CHECK_INVENTORY_REQUIRED', 'REMOTE_REFS_UNAVAILABLE', 'REMOTE_REFS_REFUSED',
  // A bounded HTTP status vocabulary preserves 429/5xx retry classification;
  // no regexp accepts caller-controlled suffixes or arbitrary secret strings.
  ...Array.from({ length: 500 }, (_, i) => `github_http_${i + 100}`),
]);
export function safeReason(error) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return 'ENTRY_OPERATION_UNCONFIRMED';
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      && PUBLIC_ENTRY_REASONS.has(descriptor.value)) return descriptor.value;
  } catch { /* A Proxy reflection trap's thrown value is never inspected. */ }
  return 'ENTRY_OPERATION_UNCONFIRMED';
}
// With the trailing separator, as before (callers join relative Source paths onto it).
export const sourceRootOf = moduleUrl => sourceRootOfModule(moduleUrl) + path.sep;

// Append-only, fsynced observation log next to the role's own effect journal (never in the spool, S13).
export function observationLog(directory, jobId) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'observations.jsonl');
  return (kind, data) => {
    check(/^[a-z][a-z0-9_]{0,79}$/.test(kind), 'OBSERVATION_KIND_REFUSED');
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
    try {
      const s = fs.fstatSync(fd); check(s.isFile() && s.nlink === 1 && s.size < 64 * 1024 * 1024, 'OBSERVATION_LOG_BOUNDARY');
      const b = Buffer.from(canonical({ contract: 'clued.independent-ci.source-observation/1', id: randomUUID(), kind, jobId: data?.jobId ?? jobId, observedAt: new Date().toISOString(), dataSha256: digest(data) }) + '\n');
      check(fs.writeSync(fd, b) === b.length, 'OBSERVATION_LOG_UNCONFIRMED'); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
}

export async function controllerPrincipal(record) {
  const keyFile = APP_KEY_FILE, nativeFile = path.join(INSTALL_ROOT, 'secrets', 'ci-admission.token');
  await assertProtectedPaths(INSTALL_ROOT, [keyFile, nativeFile]);
  // The secrets' only non-admin reader is this node's controller account, the one its record pins (acceptance `node`).
  const controllerSid = record.accepted.node.controllerSid;
  const appKey = await readProtected(keyFile, { secret: true, secretRoot: path.dirname(keyFile), controllerSid });
  const nativeToken = (await readProtected(nativeFile, { secret: true, secretRoot: path.join(INSTALL_ROOT, 'secrets'), controllerSid })).trim();
  check(/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(nativeToken) && digest('clued.independent-ci.ci-binding-pin/1\0' + nativeToken) === record.accepted.ciTokenPinSha256
    && createHash('sha256').update(createPublicKey(appKey).export({ type: 'spki', format: 'der' })).digest('base64') === record.accepted.appPublicKeySha256Base64, 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED');
  return { appKey, nativeToken };
}

// readRetry: options of read-retry.mjs#withReadRetry (tests inject sleep and a smaller budget). Reads of GitHub (GET) are
// repeated on a 5xx or a network failure with exponential backoff inside the stage's own live() deadline; writes are never repeated.
// Generation 11 (resident DESIGN 55): the Native verify RPC is a read only as the server's own ordinary observation (no action, no
// pr_ref, ci_dispatch absent or false: migration 20261017215600, native.current's claim verification) or with one of
// NATIVE_READ_ACTIONS (lists); it is then repeated like a GitHub read. The admission evaluator's verify carries pr_ref (it binds the
// PR and records an execution admission: a write) and every other action (publication begin/finish/abort/reconcile, scan start, the
// legacy drain) is never repeated. A retried native.current still has to answer within its own 30 s round trip (clock-skew.mjs,
// measured from the first send): a retry that ends later is refused as before, on the safe side.
// The merge-slot holders RPC (holders and the role probe) is a read as well.
export const NATIVE_READ_ACTIONS = Object.freeze(['revocations_list', 'independent_revocation_heads']);
export function nativeReadPost(supabaseUrl) {
  const base = `${String(supabaseUrl).replace(/\/+$/, '')}/rest/v1/rpc/`, rpc = `${base}clued_work_verify_v1`, holders = `${base}${HOLDERS_RPC}`;
  return (url, opts) => {
    if (url === holders) return true;
    if (url !== rpc || typeof opts?.body !== 'string') return false;
    const input = JSON.parse(opts.body)?.p_input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    if (Object.hasOwn(input, 'action')) return NATIVE_READ_ACTIONS.includes(input.action);
    return !Object.hasOwn(input, 'pr_ref') && (!Object.hasOwn(input, 'ci_dispatch') || input.ci_dispatch === false);
  };
}
export function controllerPorts({ record, appKey, nativeToken, policyText, sourceRoot, live, signal, log, monotonic = () => performance.now(), baseFetch = globalThis.fetch, readRetry = {} }) {
  const singleFetch = (url, opts = {}) => { live(); return baseFetch(url, { ...opts, signal: signal ? AbortSignal.any([signal, opts.signal ?? AbortSignal.timeout(30000)]) : (opts.signal ?? AbortSignal.timeout(30000)) }); };
  const fetchImpl = withReadRetry(singleFetch, { live, deadlineAt: () => live.deadlineAt ?? null, resetOn: (url, opts) => String(opts?.method ?? 'GET').toUpperCase() !== 'GET' && /\/check-runs(?:[/?]|$)/.test(String(url)), readPost: nativeReadPost(record.config.supabaseUrl), onRetry: r => { try { log(r.post ? 'native_read_retry' : 'github_read_retry', r); } catch { /* best-effort */ } }, ...readRetry });
  const github = createGitHubChecksPort({ repository: record.config.repository, repositoryId: FIXED_APP.repositoryId, appId: FIXED_APP.appId,
    installationId: FIXED_APP.installationId, includeModeRead: true, privateKeyProvider: async () => appKey, fetchImpl });
  const admission = createFullAdmissionPortV2({ protectedConfig: { ...record.config, domain: 'production', workspace: sourceRoot, policyText }, fetchImpl,
    modeProvider: () => github.readAdmissionMode(),
    tokenProvider: async () => ({ githubToken: await github.getInstallationToken(), ciAdmissionToken: nativeToken, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ciPrincipalQualificationRef: record.config.ciPrincipalQualificationRef }),
    recorderProvider: async () => ({ domain: 'production', kind: 'independent-controller', observedAt: new Date().toISOString(), observationRef: randomUUID(), recorder: { newId: randomUUID, record: log } }) });
  const env = { CLUED_CONTEXT_READ_TOKEN: nativeToken, CLUED_SUPABASE_URL: record.config.supabaseUrl,
    CLUED_SUPABASE_PUBLISHABLE_KEY: record.config.publishableKey };
  const commands = new Set(['publication_begin_independent','publication_finish','publication_abort_independent','publication_reconcile','revocations_list',
    'independent_revocation_heads','independent_legacy_drain_finish','scan_start_independent']);
  const native = Object.freeze({ async command(input) {
    live(); check(commands.has(input?.action) && input.scope === record.config.scope, 'NATIVE_PUBLICATION_SCOPE_REFUSED');
    const reply = await cluedRpc(fetchImpl, env, sourceRoot, 'clued_work_verify_v1', input);
    check(reply.status === 200 && reply.body && typeof reply.body === 'object', 'NATIVE_PUBLICATION_UNAVAILABLE');
    return reply.body;
  }, async current(identity,mode) {
    live();if(mode?.scope!==record.config.scope||identity.job.repo!==record.config.repository
      ||!Array.isArray(mode.paths)||!mode.paths.length)return false;
    const sentMono = monotonic();
    const reply = await cluedRpc(fetchImpl, env, sourceRoot, 'clued_work_verify_v1', { scope: mode.scope, claim_id: identity.claim.claim_id,
      head_sha: identity.job.headSha, base_sha: identity.job.baseSha, changed_paths: mode.paths });
    const b=reply.body,c=b?.claim,failed=[];
    for (const [name, ok] of [['reply',reply.status===200&&b?.status==='ok'],['verdict',b?.verdict==='ADMITTED'],
      ['execution_policy',b?.execution_policy===mode.executionPolicy],['lease_key_required',c?.lease_key_required===mode.guarded],
      ['handover_pending',c?.execution_handover_pending===false],['claim_status',c?.status==='ACTIVE'],
      ['claim_identity',c?.claim_id===identity.claim.claim_id&&c.fence===identity.claim.fence&&c.execution_epoch===identity.claim.execution_epoch],
      ['current_fence',b?.current_fence===c?.fence&&b?.execution_epoch===c?.execution_epoch],['context_key',c?.context_key===mode.scope],
      ['bound_pr',c?.bound_pr===`${identity.job.repo}#${identity.job.pr}`]]) if (!ok) failed.push(name);
    // Decision 1100a0ed: no comparison of KooYomi's clock with this host's (clock-skew.mjs#serverAnswerCurrent).
    failed.push(...serverAnswerCurrent({ verifiedAt: b?.verified_at, expiresAt: c?.expires_at, sentMono, nowMono: monotonic() }));
    // The log keeps only a digest of its data, so each failed check's name is the record kind itself.
    if (failed.length) { try { for (const name of failed) log?.(`native_current_refused_${name}`, { failed }); } catch { /* the refusal stands */ } }
    return failed.length===0;
  }});
  // This URL is part of the computed held Source closure; a caller supplies
  // neither the registry bytes nor their digest. Policy activation stays Native.
  const registryBytes = fs.readFileSync(new URL('../hosted-relay-v1/registry.json', import.meta.url));
  const scanStartRegistrySha256 = createHash('sha256').update(registryBytes).digest('hex');
  const scanStart = createIndependentScanStartPort({ native, github, scope: record.config.scope, live,
    registrySha256: scanStartRegistrySha256 });
  return { github, admission, fetchImpl, native, scanStart, scanStartRegistrySha256 };
}

// Root-held Source/record verification and the existing protected permanent
// role journal remain prerequisites. No extra secret reader or worker token.
export function publicationControllerGithub({ ports, jobs, journal, args, record, plan }) {
  return createIndependentPublicationPortsForJobs({ jobs, journal, github: ports.github, native: ports.native,
    controllerIdFor: job => independentControllerId({ invocationNonce: args.nonce, jobId: job.id, nodeId: record.accepted.node.hostname }),
    registerController: (identity,mode) => {
      if(mode.executionPolicy==='active'&&!revocationQualification(record,{reserveMs:300_000}))fail('independent_revoker_qualification_required');
      return registerIndependentController({ identity, journal, args, record, plan });
    },
    assertCurrent: (identity,mode) => ports.native.current(identity,mode) });
}

// The authority facts every v2 publisher binds (the seven install refs + acceptance window).
export const authorityOf = accepted => ({ acceptanceValidUntil: accepted.validUntil,
  ...Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef'].map(k => [k, accepted[k]])) });

// Runs one entry: body(ctx) returns {status, reason, sideEffects, ...}. The outcome is written in all
// cases that reach the finally block. Exit 0 only for a settled (or, for the issuer, received) result.
export async function runEntry({ argv, entryRole, moduleUrl, body, output = process.stdout, successStatuses = ['SETTLED'] }) {
  let args = null, inputs = null, lease = null, result = { status: 'BLOCKED', reason: 'ENTRY_NOT_STARTED', sideEffects: 0 };
  try {
    args = parseEntryArgs(argv);
    check(process.platform === 'win32', 'FIXED_WINDOWS_ENTRY_REQUIRED');
    lease = takeHeldRecord(await openHeldRecord());
    assertOwnSourceRoot(lease, moduleUrl);
    const held = lease.data;
    inputs = await loadStageInputs({ ...args, entryRole, recordDocs: held.documents, identity: { platform: process.platform, arch: process.arch, hostname: os.hostname(), account: os.userInfo().username } });
    check(inputs.record.pins.size === held.sourceHashes.size && [...inputs.record.pins].every(([p, s]) => held.sourceHashes.get(p) === s), 'HELD_SOURCE_PINS_CHANGED');
    const live = () => { takeHeldRecord(lease); };
    live.deadlineAt = Date.parse(held.expiresAt); // the lease's end: read retries never wait or run past it (read-retry.mjs)
    result = await body({ args, inputs, held, live, sourceRoot: sourceRootOf(moduleUrl) });
  } catch (e) {
    result = { status: result?.sideEffects ? 'UNCERTAIN' : 'BLOCKED', reason: safeReason(e), sideEffects: result?.sideEffects ?? 0 };
  } finally {
    if (args) {
      try { await writeOutcome({ receiptsRoot: STATE_V2.receipts, nonce: args.nonce, plan: inputs?.plan ?? null, jobIds: inputs?.jobs?.map(j => j.id) ?? [],
        relayQualificationJob: inputs?.plan?.stage === 13 ? inputs.jobs[0] : null, result }); } catch { /* outcome missing = UNKNOWN for the resident */ }
    }
    if (lease) await lease.close();
  }
  output.write(JSON.stringify({ status: result.status, reason: result.reason ?? null, sideEffects: result.sideEffects ?? 0 }) + '\n');
  return successStatuses.includes(result.status) ? 0 : 2;
}
