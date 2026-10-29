// Source v2 fixed layout for the resident executor (DESIGN §3, §7, §8.3). Pure constants and pure
// helpers; no I/O. Everything here is a fixed install fact, never derived from a trigger or a PR.
import { createHash } from 'node:crypto';

export const REPO = 'tdoljyj/cross-memory-system';

// ---- Windows ----
export const WIN_ROOT = 'C:\\ProgramData\\CluedIndependentCI';
export const WIN_RESIDENT = `${WIN_ROOT}\\resident`;
// Claim-free install record written ONCE by the elevated Source v2 install (admin-only; read by the
// resident and by clued-control). It replaces the per-batch installation/acceptance rebinds (S5, S6).
export const WIN_RECORD = `${WIN_RESIDENT}\\record`;
export const RECORD_FILES = Object.freeze(['installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json']);
// Per-invocation stage inputs, one fresh directory per broker nonce (resident: modify; controller: read).
export const WIN_STAGE = `${WIN_RESIDENT}\\stage`;
export const WIN_HELPERS = `${WIN_RESIDENT}\\helpers`;
export const GENERIC_HELPER = 'controller-formal-generic-v2.exe';
export const WIN_SPOOL = `${WIN_ROOT}\\formal-spool`;
// Controller (clued-control) state for Source v2. Effect journals live here, never in the spool, so
// no archive can ever move them (S13).
export const WIN_STATE_V2 = `${WIN_ROOT}\\state\\v2`;
// Hosted relay (stage R, free-minutes design S16): the relay entry's GitHub OIDC JWKS cache (clued-control
// modify, created by migrate-acl.ps1; never in the spool, never archived).
export const STATE_RELAY_JWKS = `${WIN_ROOT}\\state\\relay\\jwks`;
export const STATE_V2 = Object.freeze({
  effectsScan: `${WIN_STATE_V2}\\effects-scan`,
  effectsWorkAdmission: `${WIN_STATE_V2}\\effects-work-admission`,
  effectsControl: `${WIN_STATE_V2}\\effects-control`,
  batchClaims: `${WIN_STATE_V2}\\batch-claims`,
  receipts: `${WIN_STATE_V2}\\receipts`,
  temp: `${WIN_STATE_V2}\\temp`,
  // Quota phase 2, step 3a: every kooyumi-merge-slot green stage 8 writes (green-ledger.mjs; clued-control only).
  greenLedger: `${WIN_STATE_V2}\\green-ledger`,
  // Quota phase 2, step 3c-1: one shadow record per stage-10 run (train-shadow-store.mjs; clued-control only).
  trainShadow: `${WIN_STATE_V2}\\train-shadow`,
});
export const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
export const ORIGINAL_BINARY = '"C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"';

// Virtual service account SID: S-1-5-80 + SHA-1 of the upper-case service name (UTF-16LE).
export function serviceSid(name) {
  const h = createHash('sha1').update(Buffer.from(name.toUpperCase(), 'utf16le')).digest();
  return `S-1-5-80-${[0, 1, 2, 3, 4].map(i => h.readUInt32LE(i * 4)).join('-')}`;
}
export const RESIDENT_SERVICE = 'CluedCIResident';
export const BROKER_SERVICE = 'CluedCISwapBroker';
export const RESIDENT_SID = serviceSid(RESIDENT_SERVICE);
export const SYSTEM_SID = 'S-1-5-18';
export const ADMINS_SID = 'S-1-5-32-544';
export const TRUSTED_INSTALLER_SID = serviceSid('TrustedInstaller');

// ---- Linux (WSL Ubuntu-24.04, root) ----
export const LINUX_STATE = '/var/lib/clued-independent-ci';
export const LINUX_SPOOL = `${LINUX_STATE}/formal-spool`;
// Source v2 trusted checkout and the qualified toolchain node (S10: the worker unit, the relay
// record tool and the qualification all name this one node; v1's run-batch.ps1:87 named another).
export const LINUX_SOURCE_V2 = '/opt/clued-independent-ci/source-v2';
export const LINUX_NODE = `${LINUX_STATE}/toolchain-build-legacy-v1/node`;
export const LINUX_POLICY_DIR = '/etc/clued-independent-ci/roles-v3';
export const LINUX_DESCRIPTORS = '/mnt/c/ProgramData/CluedIndependentCI/resident/outbox';
export const LINUX_WSPREP = id => `${LINUX_STATE}/ws-prep-${id}`;

// ---- the fixed eight stages, stage R and stage 10 (stages.json semantics; S11 gives each a stable failure catalogue) ----
const P = 'work/actions-hosted-migration/independent-ci-v1/';
export const ENTRY_V2 = Object.freeze({
  'work-admission': `${P}src/formal-work-admission-check-v2/startup.mjs`,
  'scanner-issuer': `${P}worker/protected-job-bridge-v4/windows-issuer.mjs`,
  'check-publisher': `${P}runtime/one-shot-v2.mjs`,
  'control-checks': `${P}src/independent-control-checks-v2/startup.mjs`,
  // Stage R (hosted relay, free-minutes design S17/S19): verify GitHub-hosted runs and relay them to App 5368905.
  'relay-publisher': `${P}src/hosted-relay-v1/relay-entry-v2.mjs`,
  // Stage 10 (quota phase 2, step 3c-1): train maintenance, read-only in shadow mode.
  'train-maintenance': `${P}src/independent-control-checks-v2/train-maintenance.mjs`,
  'role-probe': `${P}src/resident-v2/role-probe-entry.mjs`,
  'revocation-maintenance': `${P}src/resident-v2/revocation-entry.mjs`,
});
// Kind 'formal': the fixed eight stages, all derived with the batch. Kind 'hosted-relay': stage R, number 9,
// derived only after the hosted wait (derive-batch.mjs --relay-roles) for the relay candidates the resident
// wrote into 20-plan-intent; its job list is a non-empty ordered subset of its jobRoles (variableJobRoles).
const ROWS = [
  { number: 1, kind: 'formal', name: 'native-work-admission', entryRole: 'work-admission', jobRoles: ['work-admission'], runMilliseconds: 900_000, linuxWorker: false },
  { number: 2, kind: 'formal', name: 'gitleaks-execution', entryRole: 'scanner-issuer', jobRoles: ['gitleaks'], runMilliseconds: 2_700_000, linuxWorker: true },
  { number: 3, kind: 'formal', name: 'gitleaks-publication', entryRole: 'check-publisher', jobRoles: ['gitleaks'], runMilliseconds: 900_000, linuxWorker: false },
  { number: 4, kind: 'formal', name: 'trivy-execution', entryRole: 'scanner-issuer', jobRoles: ['trivy'], runMilliseconds: 1_800_000, linuxWorker: true },
  { number: 5, kind: 'formal', name: 'trivy-publication', entryRole: 'check-publisher', jobRoles: ['trivy'], runMilliseconds: 900_000, linuxWorker: false },
  { number: 6, kind: 'formal', name: 'placement-execution', entryRole: 'scanner-issuer', jobRoles: ['contract-placement'], runMilliseconds: 600_000, linuxWorker: true },
  { number: 7, kind: 'formal', name: 'placement-publication', entryRole: 'check-publisher', jobRoles: ['contract-placement'], runMilliseconds: 900_000, linuxWorker: false },
  // Stage 8 waits inside the control helper for the Native merge-queue head (S8), so it gets the
  // longest window: min(merge slot 45 min, claim, acceptance) bounded by this cap.
  { number: 8, kind: 'formal', name: 'native-control-pair', entryRole: 'control-checks', jobRoles: ['control-admission', 'control-merge-slot'], runMilliseconds: 2_700_000, linuxWorker: false },
  // Stage R: only the relayable roles of the installed relay registry (contract-placement is never relayed).
  { number: 9, kind: 'hosted-relay', name: 'hosted-relay', entryRole: 'relay-publisher', jobRoles: ['gitleaks', 'trivy'], variableJobRoles: true, runMilliseconds: 900_000, linuxWorker: false },
  // Stage 10 (quota phase 2, step 3c-1; DESIGN §21.1): train maintenance, outside any batch. Its one job is a train run
  // (train-run.mjs), not a job of contract /3; derive-batch.mjs --train-run derives it.
  { number: 10, kind: 'train', name: 'train-maintenance', entryRole: 'train-maintenance', jobRoles: ['train-run'], runMilliseconds: 300_000, linuxWorker: false },
  // C2 is outside PR batches and quotas. Existing stages 1–10 retain their exact caps.
  { number: 11, kind: 'role-probe', name: 'role-probe', entryRole: 'role-probe', jobRoles: ['role-probe-run'], runMilliseconds: 60_000, linuxWorker: false },
  // Independent negative-effect maintenance, outside PR batches and scanner quotas.
  { number: 12, kind: 'revocation-maintenance', name: 'revocation-maintenance', entryRole: 'revocation-maintenance', jobRoles: ['revocation-maintenance-run'], runMilliseconds: 300_000, linuxWorker: false },
];
export const STAGES_V2 = Object.freeze(ROWS.map(s => Object.freeze({ variableJobRoles: false, ...s, jobRoles: Object.freeze([...s.jobRoles]) })));
export const FORMAL_STAGES_V2 = Object.freeze(STAGES_V2.filter(s => s.kind === 'formal'));
export const RELAY_STAGE_NUMBER = 9;
export const RELAY_STAGE_V2 = STAGES_V2.find(s => s.number === RELAY_STAGE_NUMBER);
export const TRAIN_STAGE_NUMBER = 10;
export const TRAIN_STAGE_V2 = STAGES_V2.find(s => s.number === TRAIN_STAGE_NUMBER);
export const ROLE_PROBE_STAGE_NUMBER = 11;
export const REVOCATION_STAGE_NUMBER = 12;
// The job roles of one stage package: exactly the row's roles, or (stage R) a non-empty subset in row order.
export function stageJobRolesValid(row, roles) {
  if (!row || !Array.isArray(roles)) return false;
  if (!row.variableJobRoles) return roles.length === row.jobRoles.length && roles.every((r, i) => r === row.jobRoles[i]);
  return roles.length > 0 && new Set(roles).size === roles.length && roles.every(r => row.jobRoles.includes(r))
    && roles.every((r, i) => i === 0 || row.jobRoles.indexOf(roles[i - 1]) < row.jobRoles.indexOf(r));
}
export const STAGE_MARGIN_MS = 180_000;
export const stageByNumber = n => STAGES_V2.find(s => s.number === n) ?? null;
// Outcome records written by the v2 node entries (one per broker nonce, create-only), read by the
// resident's stage invoker to turn a stage ending into a stable failure code (S11).
export const OUTCOME_CONTRACT = 'clued.independent-ci.entry-outcome/2';
export const outcomeFile = nonce => `${STATE_V2.receipts}\\outcome-${nonce}.json`;
export const nativeReceiptFile = nonce => `${STATE_V2.receipts}\\windows-formal-entry-${nonce}.json`;

export const HEX64 = /^[0-9a-f]{64}$/;
export const NONCE32 = /^[0-9a-f]{32}$/;
export const BATCH_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
