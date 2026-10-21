// Shared fixtures for the resident unit tests: a temporary state root, a valid policy, triggers,
// and fake engine/companion ports whose behaviour each test scripts.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePolicy } from '../src/policy.mjs';
import { Ledger } from '../src/ledger.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { Inbox, OwnerInbox } from '../src/inbox.mjs';
import { TRIGGER_CONTRACT } from '../src/trigger.mjs';
import { ResidentExecutor } from '../src/executor.mjs';

export const SOURCE = 'a'.repeat(64);
export const RESIDENT = 'b'.repeat(64);
export const CI_SOURCE = 'e'.repeat(64);
export const HEAD = '1'.repeat(40);
export const BASE = '2'.repeat(40);

export const RELAY_WAIT = Object.freeze({ signalMs: 600_000, queueMs: 900_000, runSlackMs: 600_000, totalMs: 3_600_000, pollMs: 60_000, jobTimeoutMs: Object.freeze({ gitleaks: 1_500_000, trivy: 1_500_000 }) });
export const RELAY_OFF = Object.freeze({ enabled: false, roles: Object.freeze(['gitleaks', 'trivy']), wait: RELAY_WAIT });
export const RELAY_ON = Object.freeze({ ...RELAY_OFF, enabled: true });

export function rawPolicy(overrides = {}) {
  return {
    contract: 'clued.independent-ci.resident-policy/3',
    repo: 'tdoljyj/cross-memory-system',
    baseBranch: 'main',
    sourceManifestSha256: SOURCE,
    ciSourceManifestSha256: CI_SOURCE,
    residentManifestSha256: RESIDENT,
    ownerAcceptance: { decisionRef: '0d84ddbb-ec1f-49c3-bbd0-953f72d53584', installReceiptRef: null },
    validUntil: null,
    limits: { maxBatchesPer24h: 12, maxEvaluationsPer24h: 24, maxConcurrent: 1, inboxMaxFiles: 16, unexecutedCooldownMs: 600_000, unexecutedMaxPer24h: 3, stageMarginMs: 180_000 },
    companion: { userSid: 'S-1-5-21-1-2-3-1001', heartbeatMaxAgeMs: 60_000 },
    stageRunMilliseconds: [900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000, 900000],
    linux: { distribution: 'Ubuntu-24.04', workerUnit: 'clued-ci-worker@.service', wsprepUnit: 'clued-ci-wsprep@.service', archiveUnit: 'clued-ci-archive@.service' },
    automaticAttempt2: { enabled: true, delayMs: 600_000 },
    retention: { reminderBytes: 50 * 1024 ** 3, checkEveryMs: 3_600_000 },
    relay: RELAY_OFF,
    ...overrides,
  };
}

export async function tempRoot(t, prefix = 'clued-resident-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

export const triggerBytes = (overrides = {}) => Buffer.from(JSON.stringify({
  contract: TRIGGER_CONTRACT, repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, ...overrides,
}));

// Stage R plan rows as the Source writes them (hosted-relay-v1/relay-plan.mjs).
export const relayedRow = (role, head = HEAD) => ({ role, outcome: 'RELAYED', reason: null, receipt: 'relay-attested', checkRunId: role === 'gitleaks' ? 9001 : 9002,
  externalId: `independent-ci:relay:${role}:${head.slice(0, 12)}:run39000000001:a1`, attestationSha256: 'f'.repeat(64), detail: null });
export const localRow = (role, reason = 'RELAY_NOT_ATTESTED_PENDING') => ({ role, outcome: 'LOCAL_REQUIRED', reason,
  receipt: reason === 'RELAY_NOT_ATTESTED_BILLING_REFUSED' ? 'relay-billing-refused' : 'relay-local-fallback', checkRunId: null, externalId: null, attestationSha256: null, detail: 'E5_HOSTED_IN_PROGRESS' });
export const hintFor = (roles, { pr = 884, head = HEAD, at = Date.parse('2026-10-20T12:00:00Z') } = {}) =>
  ({ contract: 'clued.independent-ci.hosted-hint/1', repo: 'tdoljyj/cross-memory-system', pr, headSha: head, observedAt: at, roles });

export const CLEAN_PROOF = Object.freeze({ windowsTreeZero: true, serviceOriginalStopped: true, linuxUnitsInactive: true, containersZero: true });
export const WINDOWS_CLEAN = Object.freeze({ windowsTreeZero: true, serviceOriginalStopped: true });

// Fake engine: stages maps stage number -> result; default ok. windows = fresh Windows quiescence.
export function fakeEngine(script = {}) {
  const calls = [], opts = [];
  const engine = {
    calls,
    async derive(subject, key) { calls.push(['derive', key]); if (script.deriveThrows) throw new Error('boom'); return { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key, packageSha256: 'c'.repeat(64) }; },
    opts,
    async runStage(batch, stage, o) { calls.push(['stage', stage.number]); opts.push([stage.number, o ?? null]); return script.stages?.[stage.number] ?? { ok: true, factsSha256: 'd'.repeat(64) }; },
    // Stage R: script.relay(roles) -> fact-like result; by default every candidate is relayed.
    async runRelayStage(batch, roles) { calls.push(['stage', 9]); engine.relayRoles = [...roles]; return script.relay ? script.relay(roles) : { ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => relayedRow(r)) }; },
    async closeBatch(batch, opts) { calls.push(['close', opts?.linux ?? null]); return script.close ?? { verified: true, archived: 3 }; },
    async archiveFailure(batch, reason) { calls.push(['archive-windows', reason]); return script.archiveWindows ?? { verified: true, directory: `failed-x-${reason}-000000000000` }; },
    async windowsQuiescence() { return script.windows ?? WINDOWS_CLEAN; },
  };
  return engine;
}

export function fakeCompanion(script = {}, clock = () => Date.now()) {
  const calls = [];
  return {
    calls,
    async heartbeat() { return script.heartbeat === null ? null : { at: script.heartbeat ?? clock() }; },
    // Hosted hint bytes for the head (script.hint(subject, now) -> object | bytes | null).
    async hostedHint(subject) { const h = script.hint ? script.hint(subject, clock()) : null; return h === null || h === undefined ? null : (Buffer.isBuffer(h) ? h : Buffer.from(JSON.stringify(h))); },
    async buildBundle() { calls.push(['bundle']); return script.bundle ?? { ok: true }; },
    async prepareWorkspaces() { calls.push(['wsprep']); return script.wsprep ?? { ok: true }; },
    async linuxQuiescence() { calls.push(['quiescence']); return script.linux ?? { linuxUnitsInactive: true, containersZero: true }; },
    async archiveLinux(batch, reason) { calls.push(['archive-linux', reason]); return script.archiveLinux ?? { verified: true, directory: `failed-x-${reason}-111111111111` }; },
  };
}

export async function executorFixture(t, { engine = fakeEngine(), companion, policy = rawPolicy(), integrity, now = Date.parse('2026-10-20T12:00:00Z') } = {}) {
  const root = await tempRoot(t);
  let time = now;
  const clock = () => time;
  const ledger = await Ledger.open(path.join(root, 'state'), clock);
  const receipts = await ReceiptChain.open(path.join(root, 'state', 'receipts'), clock);
  const inbox = await Inbox.open(path.join(root, 'inbox'), path.join(root, 'state', 'inbox-archive'));
  const requests = await Inbox.open(path.join(root, 'requests'), path.join(root, 'state', 'requests-archive'));
  const owner = await OwnerInbox.open(path.join(root, 'owner'), path.join(root, 'state', 'owner-seen'));
  const comp = companion ?? fakeCompanion({}, clock);
  const ports = {
    policy: validatePolicy(policy), ledger, receipts, inbox, requests, owner, engine, companion: comp, clock,
    sourceIntegrity: async () => integrity ?? { ok: true, sourceManifestSha256: SOURCE, residentManifestSha256: RESIDENT },
  };
  const exec = new ResidentExecutor(ports);
  let seq = 0;
  const drop = async (bytes, dir = 'inbox') => {
    seq += 1;
    const name = `${String(time + seq).padStart(13, '0')}-${String(seq).padStart(12, '0')}.json`;
    await fs.writeFile(path.join(root, dir, name), bytes);
    return name;
  };
  return { root, ports, exec, ledger, receipts, inbox, engine, companion: comp, drop, advance: ms => { time += ms; }, clock };
}
