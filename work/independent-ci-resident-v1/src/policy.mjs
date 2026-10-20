// Installed resident policy. Written once by the Owner's elevated install (UAC) into an
// admin-only file whose SHA-256 is pinned in the service configuration; the executor refuses to
// run on any other bytes. Everything a batch may do is bounded here; nothing per batch widens it.
import { HEX64, REPO, UUID, check, exactKeys } from './canonical.mjs';

export const POLICY_CONTRACT = 'clued.independent-ci.resident-policy/1';

// The fixed eight stages of the six-check batch (stages.json of the installed Source).
export const FIXED_STAGES = Object.freeze([
  { number: 1, name: 'native-work-admission', jobRole: 'work-admission', linuxWorker: false },
  { number: 2, name: 'gitleaks-execution', jobRole: 'gitleaks', linuxWorker: true },
  { number: 3, name: 'gitleaks-publication', jobRole: 'gitleaks', linuxWorker: false },
  { number: 4, name: 'trivy-execution', jobRole: 'trivy', linuxWorker: true },
  { number: 5, name: 'trivy-publication', jobRole: 'trivy', linuxWorker: false },
  { number: 6, name: 'placement-execution', jobRole: 'contract-placement', linuxWorker: true },
  { number: 7, name: 'placement-publication', jobRole: 'contract-placement', linuxWorker: false },
  { number: 8, name: 'native-control-pair', jobRole: 'control-admission', linuxWorker: false },
]);

const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

export function validatePolicy(p) {
  exactKeys(p, ['contract', 'repo', 'baseBranch', 'sourceManifestSha256', 'residentManifestSha256', 'ownerAcceptance', 'validUntil', 'limits', 'companion', 'stageRunMilliseconds', 'linux', 'automaticRetryAllowed'], 'POLICY_KEYS_INVALID');
  check(p.contract === POLICY_CONTRACT, 'POLICY_CONTRACT_INVALID');
  check(REPO.test(p.repo), 'POLICY_REPO_INVALID');
  check(p.baseBranch === 'main', 'POLICY_BASE_BRANCH_FIXED_MAIN');
  check(HEX64.test(p.sourceManifestSha256) && HEX64.test(p.residentManifestSha256), 'POLICY_SOURCE_PIN_INVALID');
  exactKeys(p.ownerAcceptance, ['decisionRef', 'installReceiptRef'], 'POLICY_ACCEPTANCE_KEYS_INVALID');
  check(UUID.test(p.ownerAcceptance.decisionRef), 'POLICY_ACCEPTANCE_DECISION_INVALID');
  check(p.ownerAcceptance.installReceiptRef === null || UUID.test(p.ownerAcceptance.installReceiptRef), 'POLICY_INSTALL_RECEIPT_INVALID');
  check(p.validUntil === null || (typeof p.validUntil === 'string' && ISO.test(p.validUntil)), 'POLICY_VALID_UNTIL_INVALID');
  exactKeys(p.limits, ['maxBatchesPer24h', 'maxEvaluationsPer24h', 'maxConcurrent', 'inboxMaxFiles', 'unexecutedCooldownMs', 'unexecutedMaxPer24h', 'stageMarginMs'], 'POLICY_LIMIT_KEYS_INVALID');
  check(int(p.limits.maxBatchesPer24h, 1, 48), 'POLICY_RATE_INVALID'); // executions (10-started)
  check(int(p.limits.maxEvaluationsPer24h, 1, 96), 'POLICY_EVALUATION_RATE_INVALID'); // all reservations
  check(p.limits.maxConcurrent === 1, 'POLICY_SERIAL_EXECUTION_REQUIRED');
  check(int(p.limits.inboxMaxFiles, 1, 256), 'POLICY_INBOX_BOUND_INVALID');
  check(int(p.limits.unexecutedCooldownMs, 60_000, 86_400_000), 'POLICY_COOLDOWN_INVALID');
  check(int(p.limits.unexecutedMaxPer24h, 0, 12), 'POLICY_UNEXECUTED_CAP_INVALID');
  check(int(p.limits.stageMarginMs, 60_000, 900_000), 'POLICY_MARGIN_INVALID');
  exactKeys(p.companion, ['userSid', 'heartbeatMaxAgeMs'], 'POLICY_COMPANION_KEYS_INVALID');
  check(SID.test(p.companion.userSid), 'POLICY_COMPANION_SID_INVALID');
  check(int(p.companion.heartbeatMaxAgeMs, 5_000, 600_000), 'POLICY_HEARTBEAT_INVALID');
  check(Array.isArray(p.stageRunMilliseconds) && p.stageRunMilliseconds.length === FIXED_STAGES.length
    && p.stageRunMilliseconds.every(ms => int(ms, 60_000, 5_400_000)), 'POLICY_STAGE_TIMES_INVALID');
  exactKeys(p.linux, ['distribution', 'workerUnit', 'wsprepUnit', 'archiveUnit'], 'POLICY_LINUX_KEYS_INVALID');
  check(p.linux.distribution === 'Ubuntu-24.04', 'POLICY_DISTRIBUTION_FIXED');
  check(p.linux.workerUnit === 'clued-ci-worker@.service' && p.linux.wsprepUnit === 'clued-ci-wsprep@.service'
    && p.linux.archiveUnit === 'clued-ci-archive@.service', 'POLICY_UNIT_NAMES_FIXED');
  check(p.automaticRetryAllowed === false, 'POLICY_AUTOMATIC_RETRY_FORBIDDEN');
  return Object.freeze({ ...p, stages: FIXED_STAGES.map((s, i) => ({ ...s, runMilliseconds: p.stageRunMilliseconds[i] })) });
}

// Worst-case wall time of one batch: every stage at its cap plus the per-stage margin.
export const batchBudgetMs = policy => policy.stages.reduce((sum, s) => sum + s.runMilliseconds + policy.limits.stageMarginMs, 0);
