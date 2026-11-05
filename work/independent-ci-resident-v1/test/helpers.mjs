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
import { ExecutedHeads, BACKFILL_MANIFEST_CONTRACT } from '../src/executed-heads.mjs';
import { RunQueue } from '../src/queue.mjs';
import { nodeProfileSha256 } from '../src/node-profile.mjs';

export const TEST_NODE = Object.freeze({ contract: 'clued.independent-ci.node-profile/1', nodeName: 'fixture-node', hostname: 'TURING',
  ownerSid: 'S-1-5-21-1-2-3-1001', ownerProfileDirectory: 'C:\\Users\\fixture-owner', controllerSid: 'S-1-5-21-1-2-3-1015',
  runnerService: 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02', mutationMutex: 'Global\\CluedControlControllerMutationV1-TURING-1015', wslDistribution: 'Ubuntu-24.04' });
export const TEST_NODE_SHA = nodeProfileSha256(TEST_NODE);
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
    contract: 'clued.independent-ci.resident-policy/7',
    node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA,
    repo: 'tdoljyj/cross-memory-system',
    baseBranch: 'main',
    sourceManifestSha256: SOURCE,
    ciSourceManifestSha256: CI_SOURCE,
    residentManifestSha256: RESIDENT,
    ownerAcceptance: { decisionRef: '0d84ddbb-ec1f-49c3-bbd0-953f72d53584', installReceiptRef: null },
    validUntil: null,
    limits: { maxBatchesPer24h: 12, maxEvaluationsPer24h: 24, perPrBatchesPer24h: 6, waitingRetriesPer24h: 48, reevaluationsPerPrHeadPer24h: 6, releasesPerHeadPer24h: 2,
      queueDepth: 100, maxConcurrent: 1, inboxMaxFiles: 16, unexecutedCooldownMs: 600_000, stageMarginMs: 180_000 },
    breaker: { consecutive: 3, windowCount: 4, windowMs: 3_600_000, backoffMs: [1_800_000, 3_600_000, 7_200_000] },
    stage8: { mode: 'park' },
    park: { maxParked: 4, maxParkedOutsideTop2: 8, maxMs: 86_400_000, stage8MaxTries: 12, stage8RetriesPer24h: 100 },
    companion: { userSid: 'S-1-5-21-1-2-3-1001', heartbeatMaxAgeMs: 60_000 },
    stageRunMilliseconds: [900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000, 900000, 300000],
    linux: { distribution: 'Ubuntu-24.04', workerUnit: 'clued-ci-worker@.service', wsprepUnit: 'clued-ci-wsprep@.service', archiveUnit: 'clued-ci-archive@.service' },
    automaticAttempt2: { enabled: true, delayMs: 600_000 },
    retention: { reminderBytes: 50 * 1024 ** 3, checkEveryMs: 3_600_000 },
    relay: RELAY_OFF,
    train: { enabled: 'off', nonFrontRuns: true, maintenanceEveryMs: 600_000, maintenanceMaxPerDay: 200 },
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
// A stage-1 refusal as the Source reports it inside the first admission's boundary (resident quota redesign phase 1):
// the bound outcome says safeToRerun, which is what lets the executor release it (classify.mjs#decideFailure), and
// Native named its reason (a workflow gate finding): a refusal with no named reason is unmapped and burned.
export const SAFE_REFUSAL = Object.freeze({ status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false,
  diagnostic: Object.freeze({ verdict: 'REJECTED', nativeVerdict: 'REJECTED', ownerReviewKind: 'UNKNOWN', reasonCodes: Object.freeze(['workflow_gate']), nativeReasonCodes: Object.freeze([]) }),
  scheduling: null, safeToRerun: true });
export const notAdmitted = (code = 'NATIVE_NOT_ADMITTED', outcome = SAFE_REFUSAL) => ({ ok: false, code, proof: WINDOWS_CLEAN, outcome, brokerNoLaunch: false });

// Fake engine: stages maps stage number -> result; default ok. windows = fresh Windows quiescence.
export function fakeEngine(script = {}) {
  const calls = [], opts = [];
  const engine = {
    calls,
    async relayQualificationWindow() { return null; }, // explicit verified-absence fixture
    async derive(subject, key) { calls.push(['derive', key]); if (script.deriveThrows) throw new Error('boom'); return { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key, packageSha256: 'c'.repeat(64) }; },
    opts,
    async runStage(batch, stage, o) { calls.push(['stage', stage.number]); opts.push([stage.number, o ?? null]); return script.stages?.[stage.number] ?? { ok: true, factsSha256: 'd'.repeat(64) }; },
    // Stage R: script.relay(roles) -> fact-like result; by default every candidate is relayed.
    async runRelayStage(batch, roles) { calls.push(['stage', 9]); engine.relayRoles = [...roles]; return script.relay ? script.relay(roles) : { ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(r => relayedRow(r)) }; },
    // Stage 10 (quota phase 2 step 3c-1): script.train(mode) -> fact-like result; by default shadow facts with no front.
    async runTrainStage(mode) { calls.push(['stage', 10, mode]); return script.train ? script.train(mode) : { ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
      train: { contract: 'clued.independent-ci.train-facts/1', mode, at: '2026-10-23T05:00:00.000Z', onDuty: true, mainSha: null, rules: null, front: null, wouldDo: 'NO_FRONT', wouldRevoke: [], wouldRevokeCount: 0 } }; },
    async closeBatch(batch, opts) { calls.push(['close', opts?.linux ?? null]); return script.close ?? { verified: true, archived: 3 }; },
    async archiveFailure(batch, reason) { calls.push(['archive-windows', reason]); return script.archiveWindows ?? { verified: true, directory: `failed-x-${reason}-000000000000` }; },
    async windowsQuiescence() { return script.windows ?? WINDOWS_CLEAN; },
    // Owner abort (DESIGN §6.5): the stop request of a running scanner-issuer stage.
    async requestStop(batch, number) { calls.push(['request-stop', number]); script.onStop?.(number); return script.stop ?? { broker: true, requestId: '0a1b2c3d-0000-4000-8000-000000000001', stopCode: 'STOP_SENT', pump: true, done: true }; },
    async stopOutcome() { return script.stopCode === undefined ? 'STOP_SENT' : script.stopCode; },
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
    // Phase 2: the live PR read (script.pull(pr) -> { number, state, headSha } | null); none unless scripted.
    async prHead(pr) { calls.push(['pr-head', pr]); return script.pull ? script.pull(pr) : null; },
  };
}

// sleep: the executor's wait between abort polls and quiescence re-checks; a turn of the event loop in tests.
export const fastSleep = () => new Promise(resolve => setImmediate(resolve));

// backfillManifest: the install's carried-state manifest (install\backfill-manifest.json); null = none carried (an empty
// list of sources), false = no manifest at all. status: a status board (status.mjs), or none.
export async function executorFixture(t, { engine = fakeEngine(), companion, policy = rawPolicy(), integrity, now = Date.parse('2026-10-20T12:00:00Z'), sleep = fastSleep,
  backfillManifest = null, status = undefined, root: givenRoot = null, statusFlush = undefined } = {}) {
  const root = givenRoot ?? await tempRoot(t);
  let time = now;
  const clock = () => time;
  const ledger = await Ledger.open(path.join(root, 'state'), clock);
  await fs.mkdir(path.join(root, 'install'), { recursive: true });
  const manifestFile = path.join(root, 'install', 'backfill-manifest.json');
  if (backfillManifest !== false) await fs.writeFile(manifestFile, JSON.stringify(backfillManifest ?? { contract: BACKFILL_MANIFEST_CONTRACT, sources: [] }), { flag: 'w' });
  const executedHeads = await ExecutedHeads.open(path.join(root, 'state'), clock, { manifestFile, carriedRoot: path.join(root, 'state', 'backfill') });
  const receipts = await ReceiptChain.open(path.join(root, 'state', 'receipts'), clock);
  const inbox = await Inbox.open(path.join(root, 'inbox'), path.join(root, 'state', 'inbox-archive'));
  const requests = await Inbox.open(path.join(root, 'requests'), path.join(root, 'state', 'requests-archive'));
  const owner = await OwnerInbox.open(path.join(root, 'owner'), path.join(root, 'state', 'owner-seen'));
  const comp = companion ?? fakeCompanion({}, clock);
  const queue = await RunQueue.open(path.join(root, 'state', 'queue'), clock);
  const ports = {
    policy: validatePolicy(policy), ledger, receipts, inbox, requests, owner, engine, companion: comp, clock, sleep, executedHeads, status, queue, statusFlush,
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
  return { root, ports, exec, ledger, receipts, inbox, engine, companion: comp, drop, advance: ms => { time += ms; }, clock, executedHeads, queue };
}
