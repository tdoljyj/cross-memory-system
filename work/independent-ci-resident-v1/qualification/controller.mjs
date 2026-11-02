// Task169: executable OFFLINE controller core. Not imported by the resident.
// There is deliberately no live factory/CLI, scanner fallback or ordinary Resume.
// Production adapter, Source acceptance and actual L1-L4 remain gates.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../src/canonical.mjs';
import { writeNew, readJson, exists } from '../src/store.mjs';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SUBJECT = ['repository', 'pr', 'headSha', 'baseSha', 'sourceManifestSha256', 'claimId', 'fence', 'executionEpoch', 'runId'];
const ROLES = ['gitleaks', 'trivy'];
const hash = value => sha256(Buffer.from(canonicalJson(value)));
class Refused extends Error { constructor(code) { super(code); this.code = code; } }
const need = (value, code) => { if (!value) throw new Refused(code); };
const exact = (row, keys, code) => {
  need(row && Object.getPrototypeOf(row) === Object.prototype &&
    Reflect.ownKeys(row).every(key => typeof key === 'string') &&
    Reflect.ownKeys(row).sort().join('|') === [...keys].sort().join('|'), code);
  need(Object.values(Object.getOwnPropertyDescriptors(row)).every(d => 'value' in d && d.enumerable), 'ACCESSOR_OUTPUT_REFUSED');
};
function primitives(row) {
  need(row && Object.getPrototypeOf(row) === Object.prototype, 'PROOF_OBJECT_REQUIRED');
  const descriptors = Object.getOwnPropertyDescriptors(row), copy = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    need(typeof key === 'string', 'PROOF_SYMBOL_REFUSED');
    const descriptor = descriptors[key];
    need('value' in descriptor && descriptor.enumerable, 'ACCESSOR_OUTPUT_REFUSED');
    need(['string', 'number', 'boolean'].includes(typeof descriptor.value), 'NON_PRIMITIVE_OUTPUT_REFUSED');
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
  }
  return Object.freeze(copy);
}
const positive = n => Number.isSafeInteger(n) && n > 0;

export function subjectHash(subject) {
  subject = primitives(subject);
  exact(subject, SUBJECT, 'SUBJECT_FIELDS');
  need(typeof subject.repository === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(subject.repository), 'REPOSITORY');
  need(positive(subject.pr) && positive(subject.fence) && positive(subject.executionEpoch), 'SUBJECT_COUNTER');
  need(HEX40.test(subject.headSha) && HEX40.test(subject.baseSha) && HEX64.test(subject.sourceManifestSha256), 'SUBJECT_SHA');
  need(UUID.test(subject.claimId) && /^[a-zA-Z0-9_-]{1,96}$/.test(subject.runId), 'SUBJECT_ID');
  return hash(subject);
}

const fixturePorts = new WeakSet();
// Explicitly named fixture capability: a JSON flag cannot create a live session.
export function offlineFixturePorts(ports) {
  const methods = ['observeAdmission', 'observeFreeQuota', 'runStage1', 'dispatchHosted', 'verifyProtectedArtifacts',
    'moveRefAndReadOldMerge', 'freshJwks', 'terminalAndCleanup', 'independentAttestation'];
  exact(ports, methods, 'FIXTURE_PORTS');
  need(methods.every(name => typeof ports[name] === 'function'), 'FIXTURE_PORT_FUNCTION');
  const copy = Object.freeze({ ...ports });
  fixturePorts.add(copy);
  return copy;
}

// Reuses the resident's create-only+fsync record primitive. This is a fixture
// journal, not a qualified principal's production ledger or an installation path.
export class OfflineJournal {
  constructor(root) { this.root = path.resolve(root); }
  async initialize() {
    need(path.basename(this.root).startsWith('relay-controller-fixture-'), 'OFFLINE_FIXTURE_ROOT');
    const info = await fs.lstat(this.root);
    need(info.isDirectory() && !info.isSymbolicLink(), 'OFFLINE_FIXTURE_ROOT');
    await fs.mkdir(path.join(this.root, 'heads'), { recursive: true, mode: 0o700 });
  }
  async acquire(subject) {
    const cookie = randomUUID();
    const value = { contract: 'clued.relay-offline-lock/1', subjectHash: subjectHash(subject), cookie };
    try { await writeNew(path.join(this.root, 'session-lock.json'), value); }
    catch { throw new Refused('EXCLUSIVE_SESSION_BUSY_OR_UNCERTAIN'); }
    return async () => {
      const lock = await readJson(path.join(this.root, 'session-lock.json'), 4096);
      need(lock.value.cookie === cookie, 'LOCK_CHANGED');
      await fs.unlink(path.join(this.root, 'session-lock.json'));
    };
  }
  headDirectory(subject) { return path.join(this.root, 'heads', hash({ repository: subject.repository, headSha: subject.headSha })); }
  async reserve(subject) {
    const dir = this.headDirectory(subject);
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch { throw new Refused('HEAD_RESERVED_OR_BURNED'); }
    await writeNew(path.join(dir, '00-reservation.json'), { contract: 'clued.relay-offline-reservation/1', subject });
    return dir;
  }
  async record(dir, name, value) {
    need(/^\d{2}-[a-z0-9-]+\.json$/.test(name), 'RECORD_NAME');
    return writeNew(path.join(dir, name), value);
  }
  async recovery(subject) {
    subjectHash(subject);
    const dir = this.headDirectory(subject);
    if (!(await exists(dir))) return { status: 'NOT_RESERVED', liveQualified: false };
    // No callback, dispatch, stage or cleanup is executed during recovery.
    return { status: 'HOLD_RECONCILE_ORIGINAL_JOURNAL', liveQualified: false, subjectHash: subjectHash(subject) };
  }
}

function bound(result, keys, binding) {
  result = primitives(result);
  exact(result, ['subjectHash', ...keys], 'UNALLOWLISTED_PROTECTED_OUTPUT');
  need(result.subjectHash === binding, 'EFFECT_BINDING_CHANGED');
  return result;
}

function admission(result, binding) {
  result = bound(result, ['principal', 'sourceAccepted', 'authorityReadResolved', 'batchIdle', 'upgradeIdle',
    'ordinaryResume', 'freshHead', 'previouslyExecuted'], binding);
  need(result.principal === 'installed-qualified-resident' && result.sourceAccepted === true, 'PRINCIPAL_OR_SOURCE');
  need(result.authorityReadResolved === true, 'AUTHORITY_FULL_TEXT_UNRESOLVED');
  need(result.batchIdle === true && result.upgradeIdle === true && result.ordinaryResume === false, 'EXCLUSIVE_ADMISSION_REFUSED');
  need(result.freshHead === true && result.previouslyExecuted === false, 'HEAD_ALREADY_EXECUTED');
}

function quota(result, binding) {
  result = bound(result, ['knownFree', 'remainingMinutes', 'estimatedMinutes', 'paidAllowed'], binding);
  need(result.knownFree === true && result.paidAllowed === false &&
    Number.isSafeInteger(result.remainingMinutes) && result.remainingMinutes >= 0 &&
    positive(result.estimatedMinutes) && result.remainingMinutes >= result.estimatedMinutes, 'FREE_QUOTA_UNKNOWN_OR_INSUFFICIENT');
}

function cleanupProof(result, binding) {
  const fields = ['windowsTreeZero', 'linuxTreeZero', 'originalRunnerStopped', 'sessionEnded',
    'hostedRunsTerminal', 'unknownDispatchReconciled'];
  result = bound(result, fields, binding);
  need(fields.every(k => result[k] === true), 'TERMINAL_OR_CLEANUP_UNCONFIRMED');
}

export function createOfflineController({ journal, ports }) {
  need(journal instanceof OfflineJournal && fixturePorts.has(ports), 'OFFLINE_CAPABILITY_REQUIRED');
  return Object.freeze({
    mode: 'OFFLINE_ONLY_NO_PRODUCTION_ADAPTER',
    recover: subject => journal.recovery(subject),
    async run(subject) {
      let release = null, dir = null, cleanupConfirmed = false, cleanupStarted = false;
      let binding;
      const proofHashes = [];
      try {
        binding = subjectHash(subject);
        subject = primitives(subject);
        await journal.initialize();
        admission(await ports.observeAdmission(subject), binding);
        quota(await ports.observeFreeQuota(subject, null), binding);
        release = await journal.acquire(subject);
        // Reobserve after exclusivity: the earlier observation was only preflight.
        admission(await ports.observeAdmission(subject), binding);
        dir = await journal.reserve(subject);
        async function effect(number, name, call, validate) {
          // Every effect rechecks Source/claim/fence/epoch and foreign work.
          admission(await ports.observeAdmission(subject), binding);
          await journal.record(dir, `${number}-` + name + '-intent.json', { subjectHash: binding, phase: name });
          // Any throw after the intent burns this phase. It is never automatically retried.
          const result = primitives(await call());
          validate(result);
          const resultHash = hash(result);
          await journal.record(dir, `${Number(number) + 1}-` + name + '-result.json', { subjectHash: binding, phase: name, proof: result, resultHash });
          proofHashes.push(resultHash);
          return result;
        }
        const stage = await effect('10', 'stage1', () => ports.runStage1(subject), result => {
          bound(result, ['manifestSha256', 'oldMergeSha', 'terminal'], binding);
          need(HEX64.test(result.manifestSha256) && HEX40.test(result.oldMergeSha) && result.terminal === true, 'STAGE1_INCOMPLETE');
        });
        const dispatched = new Map();
        for (const [index, role] of ROLES.entries()) {
          quota(await ports.observeFreeQuota(subject, role), binding);
          const result = await effect(String(20 + index * 10), 'dispatch-' + role,
            () => ports.dispatchHosted(subject, role, stage), result => {
              bound(result, ['role', 'runId', 'dispatchConfirmed'], binding);
              need(result.role === role && positive(result.runId) && result.dispatchConfirmed === true, 'DISPATCH_UNCONFIRMED');
            });
          need(![...dispatched.values()].some(row => row.runId === result.runId), 'HOSTED_RUN_REUSED');
          dispatched.set(role, result);
        }
        for (const [index, role] of ROLES.entries()) {
          await effect(String(40 + index * 10), 'verify-' + role,
            () => ports.verifyProtectedArtifacts(subject, role, dispatched.get(role)), result => {
              bound(result, ['role', 'runId', 'oidcVerified', 'annotationsComplete', 'annotationSha256',
                'checkRunIdPresent', 'registryBindsCheckRunId'], binding);
              need(result.role === role && result.runId === dispatched.get(role).runId && result.oidcVerified === true &&
                result.annotationsComplete === true && HEX64.test(result.annotationSha256), 'OIDC_OR_ANNOTATIONS_INCOMPLETE');
              need(typeof result.checkRunIdPresent === 'boolean' && typeof result.registryBindsCheckRunId === 'boolean', 'CHECK_RUN_BINDING_UNKNOWN');
              // c326@1 requires a true registry binding after L1. Missing
              // check_run_id cannot downgrade the rule to conditional binding.
              need(result.checkRunIdPresent && result.registryBindsCheckRunId, 'NEW_REGISTRY_AND_SOURCE_REQUIRED');
            });
        }
        await effect('60', 'ref-move', () => ports.moveRefAndReadOldMerge(subject, stage), result => {
          bound(result, ['ref', 'beforeRefSha', 'afterRefSha', 'oldMergeSha', 'oldMergeReadable', 'movementObserved'], binding);
          need(result.ref === `refs/pull/${subject.pr}/merge` && result.beforeRefSha === stage.oldMergeSha &&
            HEX40.test(result.beforeRefSha) && HEX40.test(result.afterRefSha) && result.beforeRefSha !== result.afterRefSha &&
            result.oldMergeSha === stage.oldMergeSha && result.oldMergeReadable === true && result.movementObserved === true, 'REAL_REF_MOVE_AND_OLD_MERGE_REQUIRED');
        });
        await effect('70', 'fresh-jwks', () => ports.freshJwks(subject), result => {
          bound(result, ['actualPrincipal', 'freshNetwork', 'cacheHit', 'jwksSha256'], binding);
          need(result.actualPrincipal === 'clued-control' && result.freshNetwork === true && result.cacheHit === false &&
            HEX64.test(result.jwksSha256), 'FRESH_PRINCIPAL_JWKS_REQUIRED');
        });
        cleanupStarted = true;
        await effect('80', 'terminal-cleanup', () => ports.terminalAndCleanup(subject), result => cleanupProof(result, binding));
        cleanupConfirmed = true;
        const evidenceHash = hash({ subjectHash: binding, proofHashes });
        await effect('90', 'independent-attestation', () => ports.independentAttestation(subject, evidenceHash), result => {
          bound(result, ['evidenceHash', 'independent', 'attestationSha256'], binding);
          need(result.evidenceHash === evidenceHash && result.independent === true && HEX64.test(result.attestationSha256), 'INDEPENDENT_ATTESTATION_REQUIRED');
        });
        const receipt = { status: 'OFFLINE_COMPLETE_NO_QUALIFICATION', liveQualified: false, subjectHash: binding, evidenceHash };
        await journal.record(dir, '99-offline-terminal.json', receipt);
        return receipt;
      } catch (error) {
        const code = error instanceof Refused ? error.code : 'EFFECT_OR_JOURNAL_UNCERTAIN';
        if (dir && !cleanupStarted) {
          cleanupStarted = true;
          try {
            // No cleanup-only production capability exists yet. If ordinary
            // admission was revoked, retain the lock rather than infer permission.
            admission(await ports.observeAdmission(subject), binding);
            await journal.record(dir, '80-terminal-cleanup-intent.json', { subjectHash: binding, phase: 'terminal-cleanup' });
            const result = primitives(await ports.terminalAndCleanup(subject));
            cleanupProof(result, binding);
            await journal.record(dir, '81-terminal-cleanup-result.json', { subjectHash: binding, proof: result });
            cleanupConfirmed = true;
          } catch { /* Retain the exclusive lock and all original evidence. */ }
        }
        const result = { status: dir ? cleanupConfirmed ? 'FAILED_CLEAN_BURNED' : 'HOLD_UNCERTAIN' : 'REFUSED_BEFORE_EFFECTS',
          liveQualified: false, code, ...(binding ? { subjectHash: binding } : {}) };
        if (dir) await journal.record(dir, '98-offline-failure.json', result).catch(() => {});
        return result;
      } finally {
        // Before a head reservation there are no side effects to settle. A crash
        // or uncertain cleanup never grants another exclusive session automatically.
        if (release && (!dir || cleanupConfirmed)) {
          try { await release(); } catch { throw new Refused('LOCK_RELEASE_UNCONFIRMED'); }
        }
      }
    },
  });
}
