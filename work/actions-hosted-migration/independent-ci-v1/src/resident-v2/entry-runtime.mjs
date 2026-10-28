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
import { createGitHubChecksPort } from '../github.mjs';
import { createFullAdmissionPortV2 } from '../full-admission-v2.mjs';
import { INSTALL_ROOT, APP_KEY_FILE, assertProtectedPaths, readProtected } from '../../runtime/protected-files.mjs';
import { openHeldRecord, takeHeldRecord, assertOwnSourceRoot, sourceRootOfModule } from './held-record.mjs';
import { loadStageInputs, parseEntryArgs, writeOutcome } from './stage-inputs.mjs';
import { STATE_V2 } from './layout.mjs';
import { FIXED_APP } from './record.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
export const safeReason = e => (/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'ENTRY_OPERATION_UNCONFIRMED');
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

export function controllerPorts({ record, appKey, nativeToken, policyText, sourceRoot, live, signal, log }) {
  const fetchImpl = (url, opts = {}) => { live(); return globalThis.fetch(url, { ...opts, signal: signal ? AbortSignal.any([signal, opts.signal ?? AbortSignal.timeout(30000)]) : (opts.signal ?? AbortSignal.timeout(30000)) }); };
  const github = createGitHubChecksPort({ repository: record.config.repository, repositoryId: FIXED_APP.repositoryId, appId: FIXED_APP.appId,
    installationId: FIXED_APP.installationId, includeModeRead: true, privateKeyProvider: async () => appKey, fetchImpl });
  const admission = createFullAdmissionPortV2({ protectedConfig: { ...record.config, domain: 'production', workspace: sourceRoot, policyText }, fetchImpl,
    modeProvider: () => github.readAdmissionMode(),
    tokenProvider: async () => ({ githubToken: await github.getInstallationToken(), ciAdmissionToken: nativeToken, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ciPrincipalQualificationRef: record.config.ciPrincipalQualificationRef }),
    recorderProvider: async () => ({ domain: 'production', kind: 'independent-controller', observedAt: new Date().toISOString(), observationRef: randomUUID(), recorder: { newId: randomUUID, record: log } }) });
  return { github, admission, fetchImpl };
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
    result = await body({ args, inputs, held, live, sourceRoot: sourceRootOf(moduleUrl) });
  } catch (e) {
    result = { status: result?.sideEffects ? 'UNCERTAIN' : 'BLOCKED', reason: safeReason(e), sideEffects: result?.sideEffects ?? 0 };
  } finally {
    if (args) {
      try { await writeOutcome({ receiptsRoot: STATE_V2.receipts, nonce: args.nonce, plan: inputs?.plan ?? null, jobIds: inputs?.jobs?.map(j => j.id) ?? [], result }); } catch { /* outcome missing = UNKNOWN for the resident */ }
    }
    if (lease) await lease.close();
  }
  output.write(JSON.stringify({ status: result.status, reason: result.reason ?? null, sideEffects: result.sideEffects ?? 0 }) + '\n');
  return successStatuses.includes(result.status) ? 0 : 2;
}
