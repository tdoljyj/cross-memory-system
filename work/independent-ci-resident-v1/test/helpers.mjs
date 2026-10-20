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

export function rawPolicy(overrides = {}) {
  return {
    contract: 'clued.independent-ci.resident-policy/2',
    repo: 'tdoljyj/cross-memory-system',
    baseBranch: 'main',
    sourceManifestSha256: SOURCE,
    ciSourceManifestSha256: CI_SOURCE,
    residentManifestSha256: RESIDENT,
    ownerAcceptance: { decisionRef: '0d84ddbb-ec1f-49c3-bbd0-953f72d53584', installReceiptRef: null },
    validUntil: null,
    limits: { maxBatchesPer24h: 12, maxEvaluationsPer24h: 24, maxConcurrent: 1, inboxMaxFiles: 16, unexecutedCooldownMs: 600_000, unexecutedMaxPer24h: 3, stageMarginMs: 180_000 },
    companion: { userSid: 'S-1-5-21-1-2-3-1001', heartbeatMaxAgeMs: 60_000 },
    stageRunMilliseconds: [900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000],
    linux: { distribution: 'Ubuntu-24.04', workerUnit: 'clued-ci-worker@.service', wsprepUnit: 'clued-ci-wsprep@.service', archiveUnit: 'clued-ci-archive@.service' },
    automaticAttempt2: { enabled: true, delayMs: 600_000 },
    retention: { reminderBytes: 50 * 1024 ** 3, checkEveryMs: 3_600_000 },
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

export const CLEAN_PROOF = Object.freeze({ windowsTreeZero: true, serviceOriginalStopped: true, linuxUnitsInactive: true, containersZero: true });
export const WINDOWS_CLEAN = Object.freeze({ windowsTreeZero: true, serviceOriginalStopped: true });

// Fake engine: stages maps stage number -> result; default ok. windows = fresh Windows quiescence.
export function fakeEngine(script = {}) {
  const calls = [];
  return {
    calls,
    async derive(subject, key) { calls.push(['derive', key]); if (script.deriveThrows) throw new Error('boom'); return { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key, packageSha256: 'c'.repeat(64) }; },
    async runStage(batch, stage) { calls.push(['stage', stage.number]); return script.stages?.[stage.number] ?? { ok: true, factsSha256: 'd'.repeat(64) }; },
    async closeBatch() { calls.push(['close']); return script.close ?? { verified: true, archived: 3 }; },
    async archiveFailure(batch, reason) { calls.push(['archive-windows', reason]); return script.archiveWindows ?? { verified: true, directory: `failed-x-${reason}-000000000000` }; },
    async windowsQuiescence() { return script.windows ?? WINDOWS_CLEAN; },
  };
}

export function fakeCompanion(script = {}, clock = () => Date.now()) {
  const calls = [];
  return {
    calls,
    async heartbeat() { return script.heartbeat === null ? null : { at: script.heartbeat ?? clock() }; },
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
