// Offline drill of the resident lifecycle (no host, no network, no secret; temp directories only).
// v0.7: a second instance with the hosted relay on drives one month of free-minutes scenarios (§7.6 of
// the free-minutes design plus the first head after the minutes return) and checks receipt types and order.
// v0.8: an Owner abort of a batch hanging in stage 2 (DESIGN §6.5).
// v1.0 (phase 2, step 1, DESIGN §17): the run queue (a seen head is never reserved again, a release and a wait are
// retried on their own back-off), a supersession before stage 1, and the breaker opening and closing on a trial.
// v1.1 (phase 2, step 2, DESIGN §18): parking at B (the close archive before stage 8, stage 8 as tries on their own
// back-off while other PRs run), main moving ending a parked batch, and the Owner drain before a reinstall.
// Policy /7 (C1b, node profiles): the policy names the accepted node profile and its hash; the drill's node is a fixture.
// Design r3 (DESIGN §25-§28): relay-flap-under-load; incident-20261028-replay and its two variants (the real companion pump,
// mailbox, Windows engine and executor on a virtual clock); the #930 replay (a transient stage-8 ending parks a minute).
//   node drill/offline-drill.mjs            prints a step table and a JSON summary; exit 1 on any miss
//
// It drives the real executor, ledger, receipts, inboxes, protocol archive and Owner-request code
// against a scripted engine and companion that leave real bridge records in a fake Windows spool and a
// fake Linux spool, so the allow-list archives (including between roles), the head burn, the HALT
// latch and the service-side re-arm run for real.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResidentExecutor, PAUSE_CONTRACT } from '../src/executor.mjs';
import { Ledger } from '../src/ledger.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { Inbox, OwnerInbox } from '../src/inbox.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { TRIGGER_CONTRACT } from '../src/trigger.mjs';
import { RunQueue } from '../src/queue.mjs';
import { applyArchive, planArchive, protocolLeaves } from '../src/archive.mjs';
import { abortRequest, drainRequest, inspect, rearmRequest, resumeRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { ExecutedHeads, BACKFILL_MANIFEST_CONTRACT, CARRIED_FILE } from '../src/executed-heads.mjs';
import { sha256 } from '../src/canonical.mjs';
import { Companion } from '../src/companion.mjs';
import { nodeProfileSha256 } from '../src/node-profile.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { WindowsEngine } from '../src/engine-windows.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { startHeartbeat } from '../src/companion-main.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const SOURCE = '5'.repeat(64);
const RESIDENT = '6'.repeat(64);
const BASE = '0'.repeat(40);
const OWNER = 'S-1-5-21-1-2-3-1001';
const head = n => `a${n.toString(16).padStart(39, '0')}`;
const WINDOWS_CLEAN = { windowsTreeZero: true, serviceOriginalStopped: true };
// The accepted node profile (policy /7) of a fixture node: its owner is the companion's user, its distribution the Linux one.
const NODE = Object.freeze({ contract: 'clued.independent-ci.node-profile/1', nodeName: 'drill-node', hostname: 'TURING', ownerSid: OWNER,
  ownerProfileDirectory: 'C:\\Users\\drill-owner', controllerSid: 'S-1-5-21-1-2-3-1015', runnerService: 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02',
  mutationMutex: 'Global\\CluedControlControllerMutationV1-TURING-1015', wslDistribution: 'Ubuntu-24.04' });

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-resident-drill-'));
const winSpool = path.join(root, 'windows-formal-spool');
const linSpool = path.join(root, 'linux-formal-spool');
for (const d of [winSpool, linSpool]) for (const s of ['incoming', 'outgoing']) await fs.mkdir(path.join(d, s), { recursive: true });
await fs.writeFile(path.join(winSpool, 'outgoing', `${'e'.repeat(64)}.json`), '{"state":"settled"}'); // an effect journal

let now = Date.parse('2026-10-21T00:00:00Z');
const clock = () => now;
const policyInput = {
  contract: 'clued.independent-ci.resident-policy/7', node: NODE, nodeProfileSha256: nodeProfileSha256(NODE), repo: REPO, baseBranch: 'main', sourceManifestSha256: SOURCE, ciSourceManifestSha256: '9'.repeat(64), residentManifestSha256: RESIDENT,
  ownerAcceptance: { decisionRef: '0d84ddbb-ec1f-49c3-bbd0-953f72d53584', installReceiptRef: null }, validUntil: null,
  limits: { maxBatchesPer24h: 72, maxEvaluationsPer24h: 96, perPrBatchesPer24h: 6, waitingRetriesPer24h: 48, reevaluationsPerPrHeadPer24h: 6, releasesPerHeadPer24h: 2, queueDepth: 100,
    maxConcurrent: 1, inboxMaxFiles: 16, unexecutedCooldownMs: 600_000, stageMarginMs: 180_000 },
  breaker: { consecutive: 3, windowCount: 4, windowMs: 3_600_000, backoffMs: [1_800_000, 3_600_000, 7_200_000] },
  stage8: { mode: 'park' },
  park: { maxParked: 4, maxParkedOutsideTop2: 8, maxMs: 86_400_000, stage8MaxTries: 12, stage8RetriesPer24h: 100 },
  companion: { userSid: OWNER, heartbeatMaxAgeMs: 60_000 },
  stageRunMilliseconds: [900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000, 900000, 300000],
  train: { enabled: 'off', nonFrontRuns: true, maintenanceEveryMs: 600_000, maintenanceMaxPerDay: 200 },
  linux: { distribution: 'Ubuntu-24.04', workerUnit: 'clued-ci-worker@.service', wsprepUnit: 'clued-ci-wsprep@.service', archiveUnit: 'clued-ci-archive@.service' },
  automaticAttempt2: { enabled: true, delayMs: 600_000 }, retention: { reminderBytes: 50 * 1024 ** 3, checkEveryMs: 3_600_000 },
  // The shipped default: the relay is off (Owner decision); the relay month below runs a second instance with it on.
  relay: { enabled: false, roles: ['gitleaks', 'trivy'], wait: { signalMs: 600_000, queueMs: 900_000, runSlackMs: 600_000, totalMs: 3_600_000, pollMs: 60_000, jobTimeoutMs: { gitleaks: 1_500_000, trivy: 1_500_000 } } },
};
const policy = validatePolicy(policyInput);

// Script: PR number -> { stage number -> result }. Each Linux stage leaves one issue/result exchange.
const script = new Map();
let linuxBusy = false;
const exchange = async () => {
  for (const [spool, out, inc] of [[winSpool, 'issue', 'result'], [linSpool, 'result', 'issue']]) {
    await fs.writeFile(path.join(spool, 'outgoing', `${out}.json`), '{}');
    await fs.writeFile(path.join(spool, 'outgoing', `${out}.ready.json`), '{}');
    await fs.writeFile(path.join(spool, 'incoming', `${inc}.json`), '{}');
    await fs.writeFile(path.join(spool, 'incoming', `${inc}.ready.json`), '{}');
  }
  await fs.writeFile(path.join(winSpool, 'outgoing', 'active.lock'), '{}');
};
const LINUX = { incoming: ['issue.json', 'issue.ready.json'], outgoing: ['result.json', 'result.ready.json'] };
const archive = async (spool, key, reason, layout) => {
  const plan = planArchive({ spoolRoot: spool, batchKey: key, reason, leaves: await protocolLeaves(spool, layout), quiescence: { proven: true, basis: 'drill: scripted quiescence' } });
  return { ...(await applyArchive(plan, clock)), directory: plan.directory };
};
const engine = {
  current: null,
  async relayQualificationWindow() { return null; }, // verified absence of a hosted qualification window, as test/helpers.mjs fakeEngine
  // A parked batch's later stage-8 tries run without a derive: each batch finds its own script by its key.
  subjects: new Map(),
  async derive(subject, key) { this.current = { subject, key }; this.subjects.set(key, subject); return { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key, packageSha256: '7'.repeat(64) }; },
  async runStage(batch, stage) {
    now += 60_000;
    if ([4, 6].includes(stage.number)) { await archive(winSpool, batch.key, `between-roles-${stage.number}`); await archive(linSpool, batch.key, `between-roles-${stage.number}`, LINUX); }
    if ([2, 4, 6].includes(stage.number)) await exchange();
    const subject = this.subjects.get(batch.key) ?? this.current.subject;
    let r = script.get(`${subject.pr}:${subject.attempt}`)?.[stage.number] ?? script.get(subject.pr)?.[stage.number];
    if (Array.isArray(r)) r = r.shift(); // one answer per run of the stage (stage 8 as tries), then success
    if (r?.leaveLinuxBusy) linuxBusy = true;
    // The stage hangs (the 2026-10-21 refused relay) until it is asked to stop; the Owner looks and aborts meanwhile.
    if (r?.hangUntilStop) {
      const stopped = new Promise(resolve => { this.stopAsked = resolve; });
      const latest = await ledger.latestRecord(batch.key);
      await writeOwnerRequest(path.join(root, 'owner'), abortRequest({ batchKey: batch.key, expectedLedgerEntrySha256: latest.sha256, reason: 'stage 2 hangs', by: OWNER }), clock);
      await stopped;
      // The helper drained its own job before the entry wrote its outcome; the broker restored the original.
      return { ok: false, code: 'STAGE_OUTCOME_MISSING', proof: WINDOWS_CLEAN };
    }
    return r ?? { ok: true, factsSha256: '8'.repeat(64) };
  },
  // Owner abort: the stop request of a running scanner-issuer stage (the real engine writes the broker stop and the pump cancel).
  async requestStop(batch, number) { this.stopRequests = (this.stopRequests ?? 0) + 1; this.stopAsked?.(number); return { broker: true, requestId: '0d0d0d0d-0000-4000-8000-000000000909', stopCode: 'STOP_SENT', pump: true, done: true }; },
  async stopOutcome() { return 'STOP_SENT'; }, // the broker's receipt: the one SERVICE_CONTROL_STOP was sent
  async closeBatch(batch) { const w = await archive(winSpool, batch.key, 'success-close'); const l = await archive(linSpool, batch.key, 'success-close', LINUX); return { verified: w.verified && l.verified, archived: w.moved + l.moved }; },
  async archiveFailure(batch, reason) { return archive(winSpool, batch.key, reason); },
  async windowsQuiescence() { return WINDOWS_CLEAN; },
};
let duringBundle = null; // a push while the bundle is built (phase 2 supersession)
const companion = {
  async heartbeat() { return { at: now }; },
  async buildBundle() { if (duringBundle) { const f = duringBundle; duringBundle = null; await f(); } return { ok: true }; },
  async prepareWorkspaces() { return { ok: true }; },
  async linuxQuiescence() { return { linuxUnitsInactive: !linuxBusy, containersZero: true }; },
  async archiveLinux(batch, reason) { return archive(linSpool, batch.key, reason, LINUX); },
};

const state = path.join(root, 'state');
const ledger = await Ledger.open(state, clock);
const receipts = await ReceiptChain.open(path.join(state, 'receipts'), clock);
const inbox = await Inbox.open(path.join(root, 'inbox'), path.join(state, 'inbox-archive'));
const requests = await Inbox.open(path.join(root, 'requests'), path.join(state, 'requests-archive'));
const owner = await OwnerInbox.open(path.join(root, 'owner'), path.join(state, 'owner-seen'));
// A fresh install with nothing carried forward: install\backfill-manifest.json lists no earlier state.
const emptyManifest = async dir => { await fs.mkdir(dir, { recursive: true }); const f = path.join(dir, 'backfill-manifest.json'); await fs.writeFile(f, JSON.stringify({ contract: BACKFILL_MANIFEST_CONTRACT, sources: [] })); return f; };
const executedHeads = await ExecutedHeads.open(state, clock, { manifestFile: await emptyManifest(path.join(root, 'install')), carriedRoot: path.join(state, 'backfill') });
const queue = await RunQueue.open(path.join(state, 'queue'), clock);
const exec = new ResidentExecutor({ policy, ledger, receipts, inbox, requests, owner, engine, companion, clock, executedHeads, queue,
  sleep: () => new Promise(resolve => setImmediate(resolve)),
  sourceIntegrity: async () => ({ ok: true, sourceManifestSha256: SOURCE, residentManifestSha256: RESIDENT }) });

let seq = 0;
const drop = async (value, dir = 'inbox') => {
  seq += 1;
  await fs.writeFile(path.join(root, dir, `${String(now + seq).padStart(13, '0')}-${String(seq).padStart(12, '0')}.json`), typeof value === 'string' ? value : JSON.stringify(value));
};
const trigger = (pr, extra = {}) => ({ contract: TRIGGER_CONTRACT, repo: REPO, pr, headSha: head(pr), baseSha: BASE, ...extra });

const rows = [];
let misses = 0;
async function step(label, action, expect) {
  const r = await action();
  const ok = expect(r);
  if (!ok) misses += 1;
  rows.push({ step: rows.length + 1, label, state: r?.state ?? r?.status ?? '-', detail: r?.reason ?? r?.failureCode ?? '', ok });
  return r;
}
const archiveDirs = async () => (await fs.readdir(winSpool)).filter(n => /^(failed|archive)-/.test(n)).length + (await fs.readdir(linSpool)).filter(n => /^(failed|archive)-/.test(n)).length;

await step('normal PR 901: eight stages, between-role archives, close', async () => { await drop(trigger(901)); return exec.tick(); }, r => r.state === 'COMPLETED');
await step('forged repo, bad JSON and a script file are rejected', async () => {
  await drop(trigger(950, { repo: 'evil/repo' })); await drop('{not json'); await fs.writeFile(path.join(root, 'inbox', 'run.ps1'), 'Remove-Item C:\\ -Recurse'); return exec.tick();
}, r => r.state === 'IDLE');
await step('PR 901 head again with a moved main: the queue has seen it, nothing is reserved', async () => { await drop(trigger(901, { baseSha: '1'.repeat(40) })); return exec.tick(); }, r => r.state === 'IDLE');
await step('  the same head in another PR: the ledger never runs it', async () => { await drop({ ...trigger(901), pr: 951 }); return exec.tick(); }, r => r.reason === 'HEAD_ALREADY_EXECUTED_NO_RETRY');
// The Source's own stage-1 outcome says safe to re-run (a refusal inside the first admission's boundary): released.
script.set(902, { 1: { ok: false, code: 'PATHS_OUTSIDE_WRITE_SET', proof: WINDOWS_CLEAN, outcome: { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: true } } });
await step('PR 902 not admitted: released, nothing reached Linux', async () => { await drop(trigger(902)); return exec.tick(); }, r => r.state === 'NOT_ADMITTED');
await step('PR 902 re-proposed inside its back-off waits', async () => { await drop(trigger(902)); return exec.tick(); }, r => r.state === 'IDLE' && queue.row(902).state === 'BACKOFF');
script.delete(902);
await step('after its 10-minute back-off (claim widened) PR 902 is retried on its own and runs', async () => { now += 600_001; return exec.tick(); }, r => r.state === 'COMPLETED');
script.set(903, { 4: { ok: false, code: 'FORMAL_BRIDGE_STAGE_DEADLINE', proof: WINDOWS_CLEAN } });
await step('PR 903 fails cleanly at stage 4: archived, executor continues', async () => { await drop(trigger(903)); return exec.tick(); }, r => r.state === 'FAILED_CLEAN');
script.set(904, { 6: { ok: false, code: 'FORMAL_BRIDGE_STAGE_DEADLINE', proof: WINDOWS_CLEAN, leaveLinuxBusy: true } });
await step('PR 904 fails while a Linux unit is still active: HALT, scene untouched', async () => { await drop(trigger(904)); return exec.tick(); }, r => r.state === 'HALTED');
await step('PR 905 waits while halted', async () => { await drop(trigger(905)); return exec.tick(); }, r => r.state === 'HALTED');
const left = (await protocolLeaves(winSpool)).length + (await protocolLeaves(linSpool, LINUX)).length;
await step('the halted scene is still on disk', async () => ({ state: `${left} records` }), () => left === 9);
const view = await inspect({ ledger, receipts });
await step('re-arm while Linux is still busy is refused by the service', async () => {
  await writeOwnerRequest(path.join(root, 'owner'), rearmRequest({ expectedHaltSha256: view.haltSha256, reason: 'too early', by: OWNER }), clock); return exec.tick();
}, r => r.state === 'HALTED');
linuxBusy = false; now += 1;
await step('Owner re-arm request: the service archives, clears HALT and runs the waiting PR 905', async () => {
  await writeOwnerRequest(path.join(root, 'owner'), rearmRequest({ expectedHaltSha256: view.haltSha256, reason: 'worker confirmed exited', by: OWNER }), clock); return exec.tick();
}, r => r.state === 'COMPLETED');
await step('PR 904 is still never re-run automatically', async () => { await drop(trigger(904)); return exec.tick(); }, r => r.state === 'IDLE' && queue.row(904).state === 'STOPPED');
await step('anyone may pause', async () => { await drop({ contract: PAUSE_CONTRACT, reason: 'drill pause' }, 'requests'); await drop(trigger(906)); return exec.tick(); }, r => r.state === 'PAUSED');
await step('a resume dropped in the user-writable requests dir is ignored', async () => { await drop(resumeRequest({ expectedPausedSha256: (await ledger.paused()).sha256, by: OWNER }), 'requests'); return exec.tick(); }, r => r.state === 'PAUSED');
await step('only the Owner resume request continues', async () => { await writeOwnerRequest(path.join(root, 'owner'), resumeRequest({ expectedPausedSha256: (await ledger.paused()).sha256, by: OWNER }), clock); return exec.tick(); }, r => r.state === 'COMPLETED');
// Owner decision 1b5d3687: one automatic attempt 2 for a clean transient failure before any role published.
script.set('907:1', { 2: { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN } });
await step('PR 907: a push between bundle and scan fails stage 2 cleanly and schedules attempt 2', async () => { await drop(trigger(907)); return exec.tick(); }, r => r.state === 'FAILED_CLEAN' && /^[0-9a-f]{64}$/.test(r.attempt2 ?? ''));
await step('attempt 2 waits for its delay, then runs all eight stages once', async () => { const early = await exec.tick(); now += 600_000; const r = await exec.tick(); return { ...r, early: early.state }; }, r => r.early === 'IDLE' && r.state === 'COMPLETED');
script.set(908, { 3: { ok: false, code: 'GITHUB_TRANSIENT_UNAVAILABLE', proof: WINDOWS_CLEAN } });
await step('PR 908: the same transient after a role published (stage 3) is final, no attempt 2', async () => { await drop(trigger(908)); const r = await exec.tick(); now += 600_000; const again = await exec.tick(); return { ...r, again: again.state }; }, r => r.state === 'FAILED_CLEAN' && !r.attempt2 && r.again === 'IDLE');
// Owner abort (DESIGN §6.5): PR 909 hangs in stage 2; the Owner's abort stops it through the stop path.
script.set(909, { 2: { hangUntilStop: true } });
await step('PR 909 hangs in stage 2: the Owner aborts it mid-stage, it is stopped, archived and FAILED_CLEAN OWNER_ABORTED', async () => { await drop(trigger(909)); return exec.tick(); },
  r => r.state === 'FAILED_CLEAN' && r.failureCode === 'OWNER_ABORTED' && r.safePoint === 'in-stage-2' && engine.stopRequests === 1);
const leftAfterAbort = (await protocolLeaves(winSpool)).length + (await protocolLeaves(linSpool, LINUX)).length;
await step('  nothing after stage 2 ran, the scene is archived on both hosts, and PR 909 never runs again', async () => { await drop(trigger(909)); const r = await exec.tick(); return { ...r, left: leftAfterAbort }; },
  r => r.state === 'IDLE' && queue.row(909).state === 'STOPPED' && r.left === 0);
// ---- phase 2, step 1: the run queue's waits, a supersession before stage 1, the breaker ----
const WAIT = { ok: false, code: 'NATIVE_NOT_ADMITTED', proof: WINDOWS_CLEAN, outcome: { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false,
  diagnostic: { verdict: 'REJECTED', nativeVerdict: 'REJECTED', reasonCodes: ['merge_slot_required'], nativeReasonCodes: [] }, scheduling: null, safeToRerun: true } };
script.set(920, { 1: WAIT });
await step('PR 920 waits for its merge slot: released as a wait, nothing burned', async () => { await drop(trigger(920)); return exec.tick(); }, r => r.state === 'NOT_ADMITTED' && queue.row(920).state === 'WAITING');
script.delete(920);
await step('  ten minutes later it is retried on its own (no new trigger) and runs', async () => { now += 600_001; return exec.tick(); }, r => r.state === 'COMPLETED');
await step('PR 921 gets a newer commit while its bundle is built: released before stage 1, the newer commit runs next', async () => {
  duringBundle = () => drop({ ...trigger(921), headSha: head(9210) });
  await drop(trigger(921)); const first = await exec.tick(); const second = await exec.tick(); return { ...second, first: first.failureCode };
}, r => r.first === 'BATCH_SUPERSEDED' && r.state === 'COMPLETED' && queue.row(921).current.headSha === head(9210));
for (const pr of [922, 923, 924]) script.set(pr, { 3: { ok: false, code: 'STAGE_PACKAGE_REFUSED', proof: WINDOWS_CLEAN } });
await step('three environment failures in a row (PRs 922-924) open the breaker; nothing starts until the trial', async () => {
  for (const pr of [922, 923, 924, 925]) await drop(trigger(pr));
  for (let i = 0; i < 3; i++) await exec.tick();
  return exec.tick();
}, r => r.state === 'DEFERRED' && r.reason === 'BREAKER_OPEN' && queue.breaker.state === 'open');
await step('  thirty minutes later PR 925 is the trial (not a row that failed); it completes and closes the breaker', async () => { now += 1_800_000; return exec.tick(); },
  r => r.state === 'COMPLETED' && queue.breaker.state === 'closed');
// ---- phase 2, step 2: parking at B (stage 8 as tries), main moving, the Owner drain before a reinstall ----
const notReady = (code, mergeQueue = { entered: false, state: null, position: null }) => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue }, safeToRerun: false } });
script.set(930, { 8: [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_QUEUE_HEAD_NOT_REACHED', { entered: true, state: 'waiting', position: 1 })] });
await step('PR 930 has not joined the merge queue: closed on both hosts, it parks before stage 8 while PR 931 runs', async () => {
  await drop(trigger(930)); const p = await exec.tick(); const left = (await protocolLeaves(winSpool)).length + (await protocolLeaves(linSpool, LINUX)).length;
  await drop(trigger(931)); const r = await exec.tick(); return { ...r, parked: p.state, tries: p.tries, left };
}, r => r.parked === 'PARKED' && r.tries === 1 && r.left === 0 && r.state === 'COMPLETED' && queue.row(930).state === 'PARKED');
await step('  ten minutes later it is first in the merge queue: tried again a minute later, it completes on try 3', async () => {
  now += 600_000; const second = await exec.tick(); now += 60_000; const third = await exec.tick(); return { ...third, second: second.state, position: second.position };
}, r => r.second === 'PARKED' && r.position === 1 && r.state === 'COMPLETED' && r.tries === 3 && queue.row(930).state === 'DONE');
script.set(932, { 8: [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED'), notReady('RESIDENT_BASE_MOVED')] });
await step('PR 932 parks, then main moves: the batch ends at once, FAILED_CLEAN RESIDENT_BASE_MOVED, never an attempt 2', async () => {
  await drop(trigger(932)); const p = await exec.tick(); now += 600_000; const r = await exec.tick(); return { ...r, parked: p.state };
}, r => r.parked === 'PARKED' && r.state === 'FAILED_CLEAN' && r.failureCode === 'RESIDENT_BASE_MOVED' && !r.attempt2);
script.set(934, { 8: [notReady('STRICT_OFF_WITHOUT_TRAIN')] });
await step('step 3a: PR 934 finds strict off on main without the train: it parks, the Owner is told; strict back on, it completes', async () => {
  await drop(trigger(934)); const p = await exec.tick(); const told = queue.notices.some(n => n.kind === 'stage8-rules' && n.code === 'STRICT_OFF_WITHOUT_TRAIN');
  now += 600_000; const r = await exec.tick(); return { ...r, parked: p.state, reason: p.reason, told };
}, r => r.parked === 'PARKED' && r.reason === 'STRICT_OFF_WITHOUT_TRAIN' && r.told && r.state === 'COMPLETED' && queue.row(934).state === 'DONE');
// Design r3 4a (DESIGN §28): the PR #930 replay. Attempt 1 fails cleanly at stage 2 (a push after the bundle) and gets its attempt
// 2; attempt 2 passes stages 1-7 and its first stage-8 try ends BLOCKED full_admission_unavailable with zero side effects and no
// merge-queue facts. Before: burned, a new commit and stages 1-7 again. Now: parked a minute, then the same batch completes.
const unavailable = { ok: false, code: 'NATIVE_ADMISSION_UNAVAILABLE', proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: 'full_admission_unavailable', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false } };
script.set('936:1', { 2: { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN } });
script.set('936:2', { 8: [unavailable] });
await step('#930 replay (PR 936, attempt 2): stage 8 unavailable once with zero effects -> parked 1 minute, then COMPLETED on the same batch', async () => {
  await drop(trigger(936)); const a1 = await exec.tick(); now += 600_000; const parked = await exec.tick(); const gap = parked.until - now; now += 60_000; const r = await exec.tick();
  return { ...r, a1: a1.attempt2 ? 'attempt2' : a1.state, parked: parked.state, reason: parked.reason, gap };
}, r => r.a1 === 'attempt2' && r.parked === 'PARKED' && r.reason === 'NATIVE_ADMISSION_UNAVAILABLE' && r.gap === 60_000 && r.state === 'COMPLETED' && r.tries === 2);
script.set(933, { 8: [notReady('RESIDENT_MERGE_QUEUE_NOT_JOINED')] });
await step('PR 933 parks; the Owner drain before a reinstall ends it OWNER_ABORTED and leaves nothing open', async () => {
  await drop(trigger(933)); const p = await exec.tick(); now += 1;
  await writeOwnerRequest(path.join(root, 'owner'), drainRequest({ reason: 'drill reinstall', by: OWNER }, clock), clock);
  await exec.tick();
  const open = (await ledger.open()).length;
  const ended = (await Promise.all((await fs.readdir(path.join(state, 'ledger'))).map(k => ledger.state(k)))).filter(e => e.reserved?.subject?.pr === 933);
  return { state: ended[0]?.terminal?.facts?.failureCode ?? '-', safePoint: ended[0]?.terminal?.facts?.safePoint, parked: p.state, open };
}, r => r.parked === 'PARKED' && r.state === 'OWNER_ABORTED' && r.safePoint === 'parked' && r.open === 0);
const head1 = await receipts.verify();
await step('receipt chain intact', async () => ({ state: `seq ${head1.seq}` }), () => head1.seq > 30);
const files = (await fs.readdir(path.join(state, 'receipts'))).sort();
const victim = path.join(state, 'receipts', files[3]);
const original = await fs.readFile(victim);
await fs.writeFile(victim, original.toString().replace('"seq":4', '"seq":4,"x":1'));
const tampered = await receipts.verify().then(() => 'NOT_DETECTED', e => e.code);
await fs.writeFile(victim, original);
await step('an edited receipt is detected', async () => ({ state: tampered }), r => r.state === 'RECEIPT_CHAIN_BROKEN' || r.state === 'RECEIPT_SHAPE_CHANGED');
const journalKept = await fs.readFile(path.join(winSpool, 'outgoing', `${'e'.repeat(64)}.json`), 'utf8');
await step('the effect journal survived every archive', async () => ({ state: journalKept }), r => r.state === '{"state":"settled"}');
const dirs = await archiveDirs();
await step('every archive is a kept directory, nothing deleted', async () => ({ state: `${dirs} archive dirs` }), () => dirs >= 20);

// ---- one month with the hosted relay on (free-minutes design §7.6 plus "first head after minutes return") ----
// A second resident instance (own state, own spools) with policy relay.enabled = true. The companion's hints
// are scripted per PR head, stage R's per-role rows are scripted per PR; everything else (wait, 20-plan-intent,
// 25-plan, dynamic stage list, between-roles archives, receipts) is the real executor.
const relayRoot = path.join(root, 'relay-month');
const rWin = path.join(relayRoot, 'windows-formal-spool'), rLin = path.join(relayRoot, 'linux-formal-spool');
for (const d of [rWin, rLin]) for (const s of ['incoming', 'outgoing']) await fs.mkdir(path.join(d, s), { recursive: true });
const relayPolicy = validatePolicy({ ...policyInput, relay: { enabled: true, roles: ['gitleaks', 'trivy'],
  wait: { signalMs: 600_000, queueMs: 900_000, runSlackMs: 600_000, totalMs: 3_600_000, pollMs: 60_000, jobTimeoutMs: { gitleaks: 1_500_000, trivy: 1_500_000 } } } });
const hints = new Map(), relayRows = new Map(), relayCalls = [];
const rowRelayed = (role, h) => ({ role, outcome: 'RELAYED', reason: null, receipt: 'relay-attested', checkRunId: 7000 + relayCalls.length, externalId: `independent-ci:relay:${role}:${h.slice(0, 12)}:run39000000001:a1`,
  attestationSha256: 'f'.repeat(64), detail: null });
const rowLocal = (role, reason) => ({ role, outcome: 'LOCAL_REQUIRED', reason, receipt: reason === 'RELAY_NOT_ATTESTED_BILLING_REFUSED' ? 'relay-billing-refused' : 'relay-local-fallback',
  checkRunId: null, externalId: null, attestationSha256: null, detail: null });
const rArchive = async (spool, key, reason, layout) => {
  const plan = planArchive({ spoolRoot: spool, batchKey: key, reason, leaves: await protocolLeaves(spool, layout), quiescence: { proven: true, basis: 'drill: scripted quiescence' } });
  return { ...(await applyArchive(plan, clock)), directory: plan.directory };
};
const rExchange = async () => {
  for (const [spool, out, inc] of [[rWin, 'issue', 'result'], [rLin, 'result', 'issue']]) {
    for (const [dir, n] of [['outgoing', out], ['incoming', inc]]) { await fs.writeFile(path.join(spool, dir, `${n}.json`), '{}'); await fs.writeFile(path.join(spool, dir, `${n}.ready.json`), '{}'); }
  }
  await fs.writeFile(path.join(rWin, 'outgoing', 'active.lock'), '{}');
};
const stagesSeen = [];
const relayEngine = {
  current: null,
  async relayQualificationWindow() { return null; }, // verified absence of a hosted qualification window, as test/helpers.mjs fakeEngine
  async derive(subject, key) { this.current = subject; stagesSeen.length = 0; return { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key, packageSha256: '7'.repeat(64) }; },
  async runStage(batch, stage, opts) {
    now += 60_000; stagesSeen.push(stage.number);
    if (opts?.betweenRoles) { await rArchive(rWin, batch.key, `between-roles-${stage.number}`); await rArchive(rLin, batch.key, `between-roles-${stage.number}`, LINUX); }
    if ([2, 4, 6].includes(stage.number)) await rExchange();
    return { ok: true, factsSha256: '8'.repeat(64) };
  },
  async runRelayStage(batch, roles) {
    now += 60_000; stagesSeen.push(9); relayCalls.push([this.current.pr, [...roles]]);
    const script = relayRows.get(this.current.pr) ?? {};
    return { ok: true, factsSha256: '8'.repeat(64), relay: roles.map(r => script[r] ?? rowRelayed(r, this.current.headSha)) };
  },
  async closeBatch(batch, opts) { const w = await rArchive(rWin, batch.key, 'success-close'); const l = opts?.linux === false ? { verified: true, moved: 0 } : await rArchive(rLin, batch.key, 'success-close', LINUX); return { verified: w.verified && l.verified, archived: w.moved + l.moved }; },
  async archiveFailure(batch, reason) { return rArchive(rWin, batch.key, reason); },
  async windowsQuiescence() { return WINDOWS_CLEAN; },
};
const relayCompanion = {
  async heartbeat() { return { at: now }; },
  async buildBundle() { return { ok: true }; },
  async prepareWorkspaces() { return { ok: true }; },
  async linuxQuiescence() { return { linuxUnitsInactive: true, containersZero: true }; },
  async archiveLinux(batch, reason) { return rArchive(rLin, batch.key, reason, LINUX); },
  async hostedHint(s) { const h = hints.get(s.pr); const v = typeof h === 'function' ? h(now) : h; return v ? Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.hosted-hint/1', repo: REPO, pr: s.pr, headSha: s.headSha, observedAt: now, roles: v })) : null; },
};
const rState = path.join(relayRoot, 'state');
const rLedger = await Ledger.open(rState, clock);
const rReceipts = await ReceiptChain.open(path.join(rState, 'receipts'), clock);
const rInbox = await Inbox.open(path.join(relayRoot, 'inbox'), path.join(rState, 'inbox-archive'));
const rRequests = await Inbox.open(path.join(relayRoot, 'requests'), path.join(rState, 'requests-archive'));
const rOwner = await OwnerInbox.open(path.join(relayRoot, 'owner'), path.join(rState, 'owner-seen'));
// The hosted wait is non-blocking: a waiting tick returns WAITING and the service loop ticks again later.
// runToEnd ticks (one minute apart, like the loop's resting pause rounded up) until the batch is not waiting.
let waitTicks = 0;
const runToEnd = async () => { waitTicks = 0; let r = await relayExec.tick(); while (r.state === 'WAITING') { if (waitTicks >= 400) throw new Error('runToEnd: still WAITING after 400 ticks (' + r.reason + ')'); waitTicks += 1; now += 60_000; r = await relayExec.tick(); } return r; };
const rExecutedHeads = await ExecutedHeads.open(rState, clock, { manifestFile: await emptyManifest(path.join(relayRoot, 'install')), carriedRoot: path.join(rState, 'backfill') });
const relayExec = new ResidentExecutor({ policy: relayPolicy, ledger: rLedger, receipts: rReceipts, inbox: rInbox, requests: rRequests, owner: rOwner, engine: relayEngine, companion: relayCompanion, clock,
  executedHeads: rExecutedHeads, queue: await RunQueue.open(path.join(rState, 'queue'), clock),
  sourceIntegrity: async () => ({ ok: true, sourceManifestSha256: SOURCE, residentManifestSha256: RESIDENT }) });
const rDrop = async value => { seq += 1; await fs.writeFile(path.join(relayRoot, 'inbox', `${String(now + seq).padStart(13, '0')}-${String(seq).padStart(12, '0')}.json`), JSON.stringify(value)); };
// Receipt types of one batch, in chain order, from its batch-reserved receipt to its batch-terminal receipt.
async function batchReceiptTypes(key) {
  const out = []; let on = false;
  for (const e of await rReceipts.entries()) {
    const b = JSON.parse(await fs.readFile(path.join(rReceipts.dir, e.name), 'utf8')).body;
    if (e.type === 'batch-reserved' && b.key === key) on = true;
    if (on && (b?.key === key)) out.push(e.type === 'relay-attested' || e.type === 'relay-local-fallback' || e.type === 'relay-billing-refused' || e.type === 'relay-late-ignored' ? `${e.type}:${b.role}` : e.type);
    if (on && e.type === 'batch-terminal' && b.key === key) break;
  }
  return out.filter(t => !['stage-terminal', 'batch-derived'].includes(t));
}
const relayTypes = types => types.filter(t => t.startsWith('relay-'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. Mid-month, minutes used up (Owner once-per-head rule 41ab823a): a billing-refused hint establishes no right to scan
// elsewhere. The batch stops after stage 1 and waits for a provider transfer that does not exist; no later tick, however
// late, turns it into a local scan, a plan intent or a billing-refusal fallback.
hints.set(911, { gitleaks: { state: 'BILLING_REFUSED' }, trivy: { state: 'BILLING_REFUSED' } });
const m1 = await step('relay month 1 (PR 911): minutes used up -> billing-refused hint -> WAITING RELAY_PROVIDER_TRANSFER_REQUIRED after stage 1, nothing local', async () => { await rDrop(trigger(911)); const w = await relayExec.tick(); return { ...w, stages: [...stagesSeen] }; },
  r => r.state === 'WAITING' && r.reason === 'RELAY_PROVIDER_TRANSFER_REQUIRED' && same(r.stages, [1]));
now += relayPolicy.relay.wait.totalMs + 60_000;
await step('  past the total wait cap the same head is still WAITING: the total cap cannot make it local', async () => { const w = await relayExec.tick(); return { ...w, stages: [...stagesSeen] }; },
  r => r.state === 'WAITING' && r.reason === 'RELAY_PROVIDER_TRANSFER_REQUIRED' && same(r.stages, [1]));
const t1 = await batchReceiptTypes(m1.key);
await step('  receipts: no plan intent, no billing refusal, no local fallback, no relay-attested', async () => ({ state: relayTypes(t1).join(',') }),
  () => relayTypes(t1).every(t => t === 'relay-waiting'));
await step('  the ledger holds no plan intent and no plan for the head', async () => { const st = await rLedger.state(m1.key); return { state: st.planIntent === null && st.plan === null ? 'none' : 'PRESENT' }; }, r => r.state === 'none');
now += 60_000;
// The hosted jobs never succeeded for this head, so release it from the relay month (the later scenarios need a free executor)
hints.set(911, { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } });
await step('  once both hosted jobs have succeeded the same head goes through stage R only: R, 6, 7, 8 (stage 1 is already done)', async () => { stagesSeen.length = 0; return runToEnd(); },
  r => r.state === 'COMPLETED' && same(stagesSeen, [9, 6, 7, 8]) && same(r.relayed, ['gitleaks', 'trivy']));

// 2. The first head after minutes return: the hosted jobs queue, run, then succeed while the executor waits.
let polls912 = 0;
hints.set(912, at => (++polls912 <= 3 ? { gitleaks: { state: 'PENDING_QUEUED', queuedAt: at - 60_000 }, trivy: { state: 'PENDING_RUNNING', startedAt: at - 120_000 } } : { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }));
const m2 = await step('relay month 2 (PR 912): first head after minutes return -> bounded wait -> R relays gitleaks+trivy -> 6,7 -> 8', async () => { await rDrop(trigger(912)); return runToEnd(); },
  r => r.state === 'COMPLETED' && same(stagesSeen, [1, 9, 6, 7, 8]) && waitTicks > 0 && waitTicks <= 60 && same(r.relayed, ['gitleaks', 'trivy']));
const t2 = await batchReceiptTypes(m2.key);
await step('  receipts: waiting, then intent, attested, the placement fallback, all before the terminal', async () => ({ state: t2.filter(t => t.startsWith('relay-') || t === 'batch-terminal').join(',') }),
  () => same(t2.filter(t => t.startsWith('relay-') || t === 'batch-terminal'), ['relay-waiting', 'relay-plan-intent', 'relay-attested:gitleaks', 'relay-attested:trivy', 'relay-local-fallback:contract-placement', 'batch-terminal']));

// 3. Month start, minutes available: hosted success is already there when the executor looks.
hints.set(913, { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } });
await step('relay month 3 (PR 913): minutes available -> 1, R, 6, 7, 8 with no wait; gitleaks and trivy never run on Linux', async () => { await rDrop(trigger(913)); return runToEnd(); },
  r => r.state === 'COMPLETED' && same(stagesSeen, [1, 9, 6, 7, 8]) && waitTicks === 0);

// 4. Minutes run out inside one head (or the hosted trivy fails to fetch its DB): rule 41ab823a, no mixed relay and local.
hints.set(914, { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'HOSTED_NOT_SUCCESS', reason: 'E5_HOSTED_FAILURE' } });
const calls914 = relayCalls.length;
const m4 = await step('relay month 4 (PR 914): trivy hosted failure -> WAITING RELAY_PROVIDER_TRANSFER_REQUIRED, no stage R, no Linux scan', async () => { await rDrop(trigger(914)); const w = await relayExec.tick(); now += relayPolicy.relay.wait.totalMs + 60_000; const w2 = await relayExec.tick(); return { ...w2, first: w.reason, stages: [...stagesSeen] }; },
  r => r.state === 'WAITING' && r.reason === 'RELAY_PROVIDER_TRANSFER_REQUIRED' && r.first === 'RELAY_PROVIDER_TRANSFER_REQUIRED' && same(r.stages, [1]) && relayCalls.length === calls914);
const t4 = await batchReceiptTypes(m4.key);
await step('  receipts: nothing attested, nothing falls back locally', async () => ({ state: relayTypes(t4).join(',') }),
  () => relayTypes(t4).every(t => t === 'relay-waiting'));
// Release PR 914 for the scenarios below: its hosted trivy has now succeeded, the head goes through stage R.
hints.set(914, { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } });
await step('  after the hosted trivy succeeded, PR 914 goes through stage R only: R, 6, 7, 8 (stage 1 is already done)', async () => { stagesSeen.length = 0; return runToEnd(); },
  r => r.state === 'COMPLETED' && same(stagesSeen, [9, 6, 7, 8]) && same(r.relayed, ['gitleaks', 'trivy']));
// 4b. Stage R itself sends a role back (the hosted run's token does not verify): no local fallback, the batch HALTs with
// the plan intent kept and no plan; the Owner re-arms it.
hints.set(915, { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } });
relayRows.set(915, { gitleaks: rowLocal('gitleaks', 'RELAY_NOT_ATTESTED_ATTESTATION_FAILED') });
const m4b = await step('relay month 4b (PR 915): stage R refuses gitleaks attestation -> HALTED RELAY_PLAN_UNCONFIRMED after 1, R; gitleaks never runs locally', async () => { await rDrop(trigger(915)); const h = await relayExec.tick(); return { ...h, stages: [...stagesSeen] }; },
  r => r.state === 'HALTED' && r.failureCode === 'RELAY_PLAN_UNCONFIRMED' && same(r.stages, [1, 9]));
await step('  the intent is kept, there is no plan, and no attempt 2 is scheduled', async () => { const st = await rLedger.state(m4b.key); return { state: st.planIntent ? 'intent' : 'no-intent', plan: st.plan, attempts2: (await rLedger.pendingAttempts2()).length }; },
  r => r.state === 'intent' && r.plan === null && r.attempts2 === 0);
const rView = await inspect({ ledger: rLedger, receipts: rReceipts });
await step('  Owner re-arm request: the service archives and clears the HALT', async () => {
  await writeOwnerRequest(path.join(relayRoot, 'owner'), rearmRequest({ expectedHaltSha256: rView.haltSha256, reason: 'drill: attestation refusal reviewed', by: OWNER }), clock); now += 1; return relayExec.tick();
}, r => r.state !== 'HALTED');
// 5. The emergency stop during a wait: anyone may pause, the batch stops before stage R; only the Owner resumes.
hints.set(916, at => ({ gitleaks: { state: 'PENDING_QUEUED', queuedAt: at }, trivy: { state: 'SUCCESS' } }));
await step('relay month 5 (PR 916): a pause during the hosted wait takes effect on the next tick, before stage R', async () => {
  await rDrop(trigger(916)); const w = await relayExec.tick();
  seq += 1; await fs.writeFile(path.join(relayRoot, 'requests', `${String(now + seq).padStart(13, '0')}-${String(seq).padStart(12, '0')}.json`), JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'drill emergency stop' }));
  now += 60_000; const p = await relayExec.tick(); now += 3_600_000; const p2 = await relayExec.tick();
  return { state: `${w.state}>${p.state}>${p2.state}`, stages: [...stagesSeen] };
}, r => r.state === 'WAITING>PAUSED>PAUSED' && same(r.stages, [1]));
await step('  only the Owner resume continues it; the stored t0 is past the cap, which still cannot make a hosted role local', async () => {
  await writeOwnerRequest(path.join(relayRoot, 'owner'), resumeRequest({ expectedPausedSha256: (await rLedger.paused()).sha256, by: OWNER }), clock); const w = await relayExec.tick(); return { ...w, stages: [...stagesSeen] };
}, r => r.state === 'WAITING' && r.reason === 'RELAY_PROVIDER_TRANSFER_REQUIRED' && same(r.stages, [1]));
hints.set(916, { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } });
await step('  when both hosted jobs have succeeded, PR 916 goes through stage R only: R, 6, 7, 8 (stage 1 is already done)', async () => { now += 60_000; stagesSeen.length = 0; return runToEnd(); },
  r => r.state === 'COMPLETED' && same(stagesSeen, [9, 6, 7, 8]) && same(r.relayed, ['gitleaks', 'trivy']));
await step('every relayed head stays burned (PR 913 again: never re-run)', async () => { await rDrop({ ...trigger(913), pr: 9130 }); return relayExec.tick(); }, r => r.reason === 'HEAD_ALREADY_EXECUTED_NO_RETRY');
const rHead = await rReceipts.verify();
await step('relay month receipt chain intact', async () => ({ state: `seq ${rHead.seq}` }), () => rHead.seq > 20);

// ---- a reinstall (resident quota redesign phase 1, v0.6 §9 item 7): new Source, fresh state, the old ledger carried ----
// What install-resident.ps1 does: copy the old state's ledger-heads and ledger records into state\backfill\<name>\ and list
// each with its SHA-256 in install\backfill-manifest.json. The first start backfills before any batch (2026-10-22: after
// the r2 reinstall #896 head 21d6d7e3 was admitted again and HALTed at ROLE_ALREADY_PUBLISHED_ON_HEAD, Note 1550fef8).
const SOURCE2 = '4'.repeat(64);
const iRoot = path.join(root, 'reinstall'), iState = path.join(iRoot, 'state');
const carriedName = 'resident-uninstalled-20261022T000000Z-drill01';
const carriedFiles = [];
const walk = async (base, rel = '') => {
  for (const name of (await fs.readdir(path.join(base, rel)).catch(() => [])).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if ((await fs.stat(path.join(base, r))).isDirectory()) { if (/^(ledger-heads|ledger|ledger\/[0-9a-f]{64})$/.test(r)) await walk(base, r); continue; }
    if (!CARRIED_FILE.test(r)) continue;
    const bytes = await fs.readFile(path.join(base, r));
    await fs.mkdir(path.dirname(path.join(iState, 'backfill', '1', r)), { recursive: true });
    await fs.writeFile(path.join(iState, 'backfill', '1', r), bytes);
    carriedFiles.push({ path: r, sha256: sha256(bytes), bytes: bytes.length });
  }
};
await walk(state);
await fs.mkdir(path.join(iRoot, 'install'), { recursive: true });
await fs.writeFile(path.join(iRoot, 'install', 'backfill-manifest.json'), JSON.stringify({ contract: BACKFILL_MANIFEST_CONTRACT, sources: [{ name: carriedName, dir: '1', files: carriedFiles }] }));
const iLedger = await Ledger.open(iState, clock);
let iDerived = 0;
const iEngine = { ...engine, current: null, async derive(subject, key) { iDerived += 1; return engine.derive.call(this, subject, key); } };
const iExec = new ResidentExecutor({ policy: validatePolicy({ ...policyInput, sourceManifestSha256: SOURCE2 }), ledger: iLedger, receipts: await ReceiptChain.open(path.join(iState, 'receipts'), clock),
  inbox: await Inbox.open(path.join(iRoot, 'inbox'), path.join(iState, 'inbox-archive')), requests: await Inbox.open(path.join(iRoot, 'requests'), path.join(iState, 'requests-archive')),
  owner: await OwnerInbox.open(path.join(iRoot, 'owner'), path.join(iState, 'owner-seen')), engine: iEngine, companion, clock, sleep: () => new Promise(resolve => setImmediate(resolve)),
  queue: await RunQueue.open(path.join(iState, 'queue'), clock),
  executedHeads: await ExecutedHeads.open(iState, clock, { manifestFile: path.join(iRoot, 'install', 'backfill-manifest.json'), carriedRoot: path.join(iState, 'backfill') }),
  sourceIntegrity: async () => ({ ok: true, sourceManifestSha256: SOURCE2, residentManifestSha256: RESIDENT }) });
const iDrop = async value => { seq += 1; await fs.writeFile(path.join(iRoot, 'inbox', `${String(now + seq).padStart(13, '0')}-${String(seq).padStart(12, '0')}.json`), JSON.stringify(value)); };
await step('reinstall (new Source, fresh state): the first tick backfills the carried ledger, then PR 901 (completed before) is never admitted', async () => { await iDrop(trigger(901)); const r = await iExec.tick(); return { ...r, derived: iDerived }; },
  r => r.state === 'IGNORED' && r.reason === 'HEAD_ALREADY_PUBLISHED_NO_RETRY' && r.derived === 0);
await step('  PR 904 (halted at stage 6 before the reinstall) is never admitted either', async () => { await iDrop(trigger(904)); return iExec.tick(); }, r => r.reason === 'HEAD_ALREADY_PUBLISHED_NO_RETRY');
script.delete(909); // its stage 2 no longer hangs
await step('  PR 909 (aborted inside stage 2, nothing published) runs under the new Source', async () => { await iDrop(trigger(909)); return iExec.tick(); }, r => r.state === 'COMPLETED');

// ---- step 3c-1: the merge train in shadow mode (stage 10, DESIGN §22.3), on a fresh install with train.enabled shadow ----
const tRoot = path.join(root, 'train-shadow'), tState = path.join(tRoot, 'state');
for (const d of ['inbox', 'requests', 'owner']) await fs.mkdir(path.join(tRoot, d), { recursive: true });
let trainAnswer = null; // the next stage-10 answer; null = shadow facts with no merge-queue front
const tEngine = { ...engine, current: null, subjects: new Map(), trainRuns: 0,
  async runTrainStage(mode) {
    this.trainRuns += 1;
    now += 30_000;
    const a = trainAnswer;
    trainAnswer = null;
    return a ?? { ok: true, runId: `${'7'.repeat(16)}-${String(this.trainRuns).padStart(12, '0')}`, proof: WINDOWS_CLEAN, train: { contract: 'clued.independent-ci.train-facts/1', mode,
      at: new Date(now).toISOString(), onDuty: true, mainSha: BASE, rules: { strict: true, mergeOnly: true }, front: null, wouldDo: 'NO_FRONT', wouldRevoke: [], wouldRevokeCount: 0 } };
  } };
const tLedger = await Ledger.open(tState, clock);
const tReceipts = await ReceiptChain.open(path.join(tState, 'receipts'), clock);
const tExec = new ResidentExecutor({ policy: validatePolicy({ ...policyInput, train: { ...policyInput.train, enabled: 'shadow' } }), ledger: tLedger, receipts: tReceipts,
  inbox: await Inbox.open(path.join(tRoot, 'inbox'), path.join(tState, 'inbox-archive')), requests: await Inbox.open(path.join(tRoot, 'requests'), path.join(tState, 'requests-archive')),
  owner: await OwnerInbox.open(path.join(tRoot, 'owner'), path.join(tState, 'owner-seen')), engine: tEngine, companion, clock, sleep: () => new Promise(resolve => setImmediate(resolve)),
  queue: await RunQueue.open(path.join(tState, 'queue'), clock),
  executedHeads: await ExecutedHeads.open(tState, clock, { manifestFile: await emptyManifest(path.join(tRoot, 'install')), carriedRoot: path.join(tState, 'backfill') }),
  sourceIntegrity: async () => ({ ok: true, sourceManifestSha256: SOURCE, residentManifestSha256: RESIDENT }) });
const tDrop = async value => { seq += 1; await fs.writeFile(path.join(tRoot, 'inbox', `${String(now + seq).padStart(13, '0')}-${String(seq).padStart(12, '0')}.json`), JSON.stringify(value)); };
const trainTypes = async () => (await tReceipts.entries()).map(e => e.type).filter(t => t.startsWith('train-')).join(',');
await step('train shadow (step 3c-1): an idle tick runs stage 10 once, leaving only its two receipts', async () => { const r = await tExec.tick(); return { ...r, runs: tEngine.trainRuns, types: await trainTypes() }; },
  r => r.state === 'IDLE' && r.runs === 1 && r.types === 'train-run-intent,train-run');
await step('  a PR batch comes first: that tick runs no stage 10, the next idle tick ten minutes later does', async () => {
  await tDrop(trigger(940));
  const a = await tExec.tick();
  const between = tEngine.trainRuns;
  now += 600_000;
  const c = await tExec.tick();
  return { state: a.state, between, after: tEngine.trainRuns, idle: c.state };
}, r => r.state === 'COMPLETED' && r.between === 1 && r.after === 2 && r.idle === 'IDLE');
await step('  a stage 10 whose cleanup is not proven HALTs like any stage', async () => {
  now += 600_000;
  trainAnswer = { ok: false, code: 'STAGE_CHILD_TREE_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: true } };
  return tExec.tick();
}, r => r.state === 'HALTED' && r.failureCode === 'TRAIN_STAGE_CLEANUP_UNCONFIRMED');

// ---- relay-flap-under-load (design r3 part one, DESIGN §25) ----
// The real companion pump over a scripted host. Under load, the first ReceiveChallenge of round 3 fails within 2 s (wsl.exe
// exits non-zero with an empty stderr); the bounded retry moves it on the second try, and the stage ends with its result:
// the pump answers ok, so the stage succeeds and nothing HALTs.
{
  const flapCfg = { wslExe: 'C:\\Windows\\System32\\wsl.exe', distribution: 'Ubuntu-24.04', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\drill\\relay-public.ps1', bundleScript: 'C:\\drill\\build-bundle.ps1', windowsSpool: 'C:\\drill\\formal-spool', bridgeManifestSha256: '9'.repeat(64),
    nodeProfileSha256: '8'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' };
  const relayReceipt = fields => JSON.stringify({ contract: 'clued.independent-ci.formal-public-relay-receipt/2', status: 'BLOCKED', processId: 1, exitCode: 1, terminalConfirmed: true, failureCode: null, childError: null, ...fields });
  const calls = [];
  let responses = 0, flapped = false;
  const run = async a => {
    if (a.includes('-Mode')) {
      const mode = a[a.indexOf('-Mode') + 1], seq = Number(a[a.indexOf('-Sequence') + 1]);
      calls.push(`${mode}${seq || ''}`);
      if (mode === 'ReceiveChallenge' && seq === 3 && !flapped) { flapped = true; now += 2000; return { code: 2, stdout: relayReceipt({ failureCode: 'PUBLIC_CHILD_EXIT_REFUSED_NO_RETRY' }), stderr: '' }; }
      if (mode === 'SendResponse') responses = seq;
      now += 5000;
      return { code: 0, stdout: relayReceipt({ status: 'PUBLIC_RECORD_TRANSFERRED', exitCode: 0 }) };
    }
    if (a.includes('/var/lib/clued-independent-ci/formal-spool/outgoing')) return { code: 0, stdout: responses >= 3 ? 'result.ready.json\n' : `challenge-0${responses + 1}.ready.json\n` };
    if (a.some(x => x.startsWith('--property=ActiveState'))) return { code: 0, stdout: 'ActiveState=inactive\nInvocationID=\nExecMainStartTimestampMonotonic=0\n' };
    if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
    return { code: 0, stdout: '' };
  };
  const pump = new Companion({ cfg: flapCfg, mailbox: { cancelled: async () => false, claimPump: async () => true }, run, fileExists: async p => p.includes('\\outgoing\\'), sleep: async ms => { now += ms; }, clock });
  await step('relay-flap-under-load: round 3 fails fast once, the bounded retry moves it, the stage gets its result and nothing HALTs', async () => {
    const r = await pump.pump({ deadline: new Date(now + 45 * 60_000).toISOString(), jobId: 'e'.repeat(64), batchId: '0123456789abcdef-0123456789ab' });
    return { state: r.ok ? 'PUMP_OK' : r.code, calls: calls.join(',') };
  }, r => r.state === 'PUMP_OK' && r.calls === 'SendIssue,ReceiveChallenge1,SendResponse1,ReceiveChallenge2,SendResponse2,ReceiveChallenge3,ReceiveChallenge3,SendResponse3,ReceiveResult');
}


// ---- incident-20261028-replay (design r3 parts two and three, DESIGN §26, §27) ----
// PR #929 stage 2 on 2026-10-28: rounds 1 and 2 go through; the ReceiveChallenge of round 3 hangs 90 s (wsl.exe under load) at
// 10:39:42 and fails AMBIGUOUS past its round's budget, so the pump hands nothing over and answers RELAY_REFUSED_NO_RETRY; the
// worker gives up 120 s after its challenge and exits with no record. Before: the issuer waited out its 45 minutes, then
// PUBLICATION_UNCERTAIN and a HALT at 11:19. Now: the real companion pump, the real mailbox, the real Windows engine (its pump
// observer and the bridge stop through the broker's stop path) and the real executor (the scanner abandonment), on a virtual
// clock. Variants: the worker stays active (quiescence never proven: HALT within the 5-minute bound), and the companion dies
// at the failure (its heartbeat stops: the stage is stopped and the batch HALTs at once, no abandonment).
// The driver moves virtual time only when every task waits on it: no file request in flight (process.getActiveResourcesInfo)
// and a few event-loop rounds with no new virtual timer.
const fileIoInFlight = () => process.getActiveResourcesInfo().some(r => /^(FSReq|CloseReq|FileHandle)/.test(r));
function virtualClock(start) {
  const vt = { now: start, timers: [], seq: 0 };
  vt.sleep = ms => new Promise(resolve => { vt.timers.push({ at: vt.now + Math.max(1, ms), seq: vt.seq++, resolve }); });
  vt.run = async (promise, maxVirtualMs) => {
    let done = false, value, error;
    promise.then(v => { done = true; value = v; }, e => { done = true; error = e; });
    const end = vt.now + maxVirtualMs;
    while (!done) {
      let quiet = 0, seen = vt.seq, spins = 0;
      while (quiet < 4 && !done) {
        await new Promise(r => setImmediate(r));
        if (fileIoInFlight()) { quiet = 0; if (++spins % 2000 === 0) await new Promise(r => setTimeout(r, 1)); continue; }
        if (vt.seq === seen) quiet += 1; else { quiet = 0; seen = vt.seq; }
      }
      if (done) break;
      if (vt.timers.length === 0) throw new Error('VIRTUAL_DEADLOCK');
      vt.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = vt.timers.shift();
      if (t.at > end) throw new Error('VIRTUAL_TIME_LIMIT');
      vt.now = Math.max(vt.now, t.at);
      t.resolve();
    }
    if (error) throw error;
    return value;
  };
  return vt;
}

async function incidentReplay(variant) {
  const vt = virtualClock(Date.parse('2026-10-28T10:30:00Z'));
  const clock = () => vt.now;
  const iRoot = path.join(root, `incident-${variant}`);
  const at = () => new Date(vt.now).toISOString().slice(11, 19);
  // failures, ends: each stage-2 run's relay failure and stage end (DESIGN 59: it may run again in the batch)
  const log = { failedAt: null, answeredAt: null, stopAt: null, stageEndedAt: null, diedAt: null, quiescenceAsks: 0, archiveReasons: [], memoryReads: 0, gateStartedAt: null, gateEndedAt: null,
    failures: [], ends: [] };
  // ---- the companion's hosts: relay-public.ps1, systemctl, the Linux root tool, the bundle script, all scripted ----
  const SPOOL = 'C:\\drill\\incident\\formal-spool';
  const ccfg = { wslExe: 'C:\\Windows\\System32\\wsl.exe', distribution: 'Ubuntu-24.04', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\drill\\relay-public.ps1', bundleScript: 'C:\\drill\\build-bundle.ps1', windowsSpool: SPOOL, bridgeManifestSha256: '9'.repeat(64),
    nodeProfileSha256: '8'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' };
  const receipt2 = fields => JSON.stringify({ contract: 'clued.independent-ci.formal-public-relay-receipt/2', status: 'BLOCKED', processId: 1, exitCode: 1, terminalConfirmed: true, failureCode: null, childError: null, ...fields });
  // runs: the starts of the worker unit (generation 14, DESIGN 59: stage 2 may run again in the batch; each start is a new invocation)
  const w = { issued: false, startedAt: null, ready: new Map(), received: new Map(), exitedAt: null, alive: true, runs: 0 };
  const workerActive = () => w.startedAt !== null && vt.now >= w.startedAt + 3000 && (variant === 'worker-active' || w.exitedAt === null || vt.now < w.exitedAt);
  const never = () => new Promise(() => {});
  const crun = async a => {
    const s = a.join(' ');
    if (a.includes('-Mode')) {
      const mode = a[a.indexOf('-Mode') + 1], seq = Number(a[a.indexOf('-Sequence') + 1]);
      if (mode === 'ReceiveChallenge' && seq === 3) {
        if (variant === 'companion-dead') { log.diedAt = vt.now; w.alive = false; return never(); }
        await vt.sleep(90_000);
        log.failedAt = vt.now; log.failures.push(vt.now);
        return { code: 2, stdout: receipt2({ failureCode: 'PUBLIC_TERMINAL_UNCONFIRMED_LOCKS_RETAINED' }), stderr: '' };
      }
      await vt.sleep(5000);
      if (mode === 'ReceiveChallenge') {
        if (!w.ready.has(seq)) return { code: 2, stdout: receipt2({ failureCode: 'PUBLIC_CHILD_REFUSED_NO_RETRY', childError: { reason: 'ENOENT', stage: 'RECORD' } }) };
        w.received.set(seq, vt.now);
      }
      if (mode === 'SendResponse') w.ready.set(seq + 1, vt.now + 20_000);
      return { code: 0, stdout: receipt2({ status: 'PUBLIC_RECORD_TRANSFERRED', exitCode: 0 }) };
    }
    if (s.includes('start --no-block')) {
      Object.assign(w, { startedAt: vt.now, ready: new Map([[1, vt.now + 10_000]]), received: new Map(), exitedAt: null, runs: w.runs + 1 });
      return { code: 0, stdout: '' };
    }
    if (a.some(x => x.startsWith('--property=ActiveState'))) {
      if (w.startedAt === null || vt.now < w.startedAt + 3000) return { code: 0, stdout: 'ActiveState=inactive\nInvocationID=\nExecMainStartTimestampMonotonic=0\n' };
      return { code: 0, stdout: `ActiveState=${workerActive() ? 'active' : 'failed'}\nInvocationID=${String(w.runs % 10).repeat(32)}\nExecMainStartTimestampMonotonic=${4242 + w.runs}\n` };
    }
    if (a.includes('/var/lib/clued-independent-ci/formal-spool/outgoing')) {
      // the worker's challenge records (they stay after it exits); round 3's challenge is never answered: it exits 120 s later
      const names = [...w.ready].filter(([, t]) => vt.now >= t).map(([n]) => `challenge-0${n}.ready.json`);
      if (w.ready.has(3) && vt.now >= w.ready.get(3) && w.exitedAt === null) w.exitedAt = w.ready.get(3) + 120_000;
      return { code: 0, stdout: names.join('\n') };
    }
    if (a.includes('/var/lib/clued-independent-ci/formal-spool/incoming')) return { code: 0, stdout: '' };
    if (s.includes('/usr/bin/pgrep')) return { code: 1, stdout: '' };
    // DESIGN §32: the memory gate's read (rmem_default, wmem_default, /proc/buddyinfo); 'memory-low' keeps the VM without one free
    // order-7 block (the 2026-10-22 13:22Z picture), every other run has plenty
    if (a.includes('/proc/buddyinfo')) {
      log.memoryReads += 1; log.gateStartedAt ??= vt.now; log.gateEndedAt = vt.now;
      const zone = n => `Node 0, zone   Normal   1037    597    194     44     21     21      5 ${String(n).padStart(6)}      0      0      0
`;
      return { code: 0, stdout: `212992
212992
${zone(variant === 'memory-low' ? 0 : 900)}` };
    }
    if (a.includes('quiescence')) { log.quiescenceAsks += 1; return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: !workerActive(), containersZero: true }) }; }
    if (a.includes('archive-status')) { const inst = a[a.indexOf('--instance') + 1]; log.archiveReasons.push(inst.split('_')[1]); return { code: 0, stdout: JSON.stringify({ verified: true, directory: `failed-${inst.slice(0, 16)}-${inst.split('_')[1]}-000000000000` }) }; }
    if (a.includes('-CheckRefs')) return { code: 0, stdout: JSON.stringify({ status: 'REMOTE_REFS_UNCHANGED' }) };
    if (a.includes('-BatchId')) return { code: 0, stdout: JSON.stringify({ status: 'BUNDLE_WRITTEN' }) };
    return { code: 0, stdout: '' }; // systemctl start --wait (workspaces, archive)
  };
  const cExists = async p => {
    if (p === `${SPOOL}\\outgoing\\issue.ready.json`) return w.issued;
    const resp = /\\outgoing\\response-0(\d)\.ready\.json$/.exec(p);
    if (resp) return w.received.has(Number(resp[1])) && vt.now >= w.received.get(Number(resp[1])) + 3000; // the issuer answers in 3 s
    const inc = /\\incoming\\challenge-0(\d)(\.ready)?\.json$/.exec(p);
    if (inc) return w.received.has(Number(inc[1]));
    return false;
  };
  const mailbox = await Mailbox.open(path.join(iRoot, 'mailbox'), clock);
  const companionProcess = new Companion({ cfg: ccfg, mailbox, run: crun, fileExists: cExists, sleep: vt.sleep, clock });
  const alive = () => w.alive;
  startHeartbeat(mailbox, { schedule: (fn, ms) => { (async () => { while (alive()) { await vt.sleep(ms); if (alive()) await fn(); } })(); } });
  (async () => { while (alive()) { await companionProcess.step(); await vt.sleep(2000); } })();
  // ---- the Windows engine (real) over a scripted runner: sc.exe and the stage-2 invoker; the broker answers its stop ----
  const sourceRoot = path.join(iRoot, 'source');
  await fs.mkdir(path.join(sourceRoot, 'work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'), { recursive: true });
  for (const n of ['derive-batch.mjs', 'invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(sourceRoot, 'work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2', n), '// drill');
  const brokerRoot = path.join(iRoot, 'broker');
  for (const d of ['requests', 'responses']) await fs.mkdir(path.join(brokerRoot, d), { recursive: true });
  // invoke-stage.mjs takes a new random request id for every invocation; here the n-th invocation of stage 2 gets ...92n
  let swaps = 0;
  const SC = { qc: 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n        START_TYPE         : 3   DEMAND_START\r\n        SERVICE_START_NAME : .\\clued-control\r\n',
    queryex: 'STATE              : 1  STOPPED\r\n        PID                : 0\r\n' };
  const exists = async p => fs.access(p).then(() => true, () => false);
  const wrun = async a => {
    if (a[0].endsWith('sc.exe')) return { code: 0, stdout: SC[a[1]] };
    const manifest = a[a.indexOf('--work-manifest-sha256') + 1];
    const SWAP_ID = `0d0d0d0d-0000-4000-8000-00000000092${++swaps}`;
    // the issuer takes its swap and issues; then it waits for a result or a blocked record that never comes
    await fs.writeFile(path.join(brokerRoot, 'requests', `${SWAP_ID}.json`), JSON.stringify({ contract: 'clued.independent-ci.swap-broker-request/2', stage: 2, nonce: 'a'.repeat(32), deadline: '2026-10-28T12:00:00Z', configSha256: 'c'.repeat(64) }));
    await fs.writeFile(path.join(brokerRoot, 'responses', `${SWAP_ID}.taken`), Buffer.from([1]));
    w.issued = true;
    const deadline = vt.now + 45 * 60_000;
    const fact = o => JSON.stringify({ contract: 'clued.independent-ci.resident-stage-fact/2', stage: 2, nonce: 'n'.repeat(32), manifest_sha256: manifest, state: 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED',
      scm_start_call_issued: true, original_binary_restored: true, complete_original_readback: true, configuration_conflict_detected: false, tree_cleanup_confirmed: true, tree_active_processes: 0,
      root_exit_confirmed: true, native_receipt_sha256: 'e'.repeat(64), ...o });
    while (vt.now < deadline) {
      if (await exists(path.join(brokerRoot, 'requests', `${SWAP_ID}.stop`))) {
        // SwapBroker: one SERVICE_CONTROL_STOP; the helper drains its own job; the entry wrote no outcome
        log.stopAt = vt.now;
        await fs.writeFile(path.join(brokerRoot, 'responses', `${SWAP_ID}.stop.json`), JSON.stringify({ contract: 'clued.independent-ci.swap-broker-stop-receipt/1', requestId: SWAP_ID, code: 'STOP_SENT', at: new Date(vt.now).toISOString() }));
        await fs.writeFile(path.join(brokerRoot, 'responses', `${SWAP_ID}.json`), '{}');
        log.stageEndedAt = vt.now; log.ends.push(vt.now);
        return { code: 41, stdout: fact({ failure_code: 'STAGE_OUTCOME_MISSING', outcome: null }) };
      }
      await vt.sleep(1000);
    }
    log.stageEndedAt = vt.now; log.ends.push(vt.now);
    return { code: 41, stdout: fact({ failure_code: 'PUBLICATION_UNCERTAIN', outcome: { status: 'UNCERTAIN', reason: 'BRIDGE_RESULT_DEADLINE', sideEffects: 1, mayHavePublished: true } }) };
  };
  const wengine = new WindowsEngine({ node: NODE, nodeProfileSha256: nodeProfileSha256(NODE), run: wrun, busy: () => false, companionMailbox: mailbox, sleep: vt.sleep, clock,
    paths: { sourceRoot, workRoot: path.join(iRoot, 'work'), outboxRoot: path.join(iRoot, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe',
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe', brokerRoot } });
  const wm = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.resident-stage-work/2', effectsAuthorized: false, files: {}, planSha256: 'c'.repeat(64) }));
  const iEngine = {
    async relayQualificationWindow() { return null; }, // verified absence of a hosted qualification window, as test/helpers.mjs fakeEngine
    async derive(subject, key) {
      const dir = path.join(iRoot, 'work', key.slice(0, 16));
      await fs.mkdir(path.join(dir, 'stage-02'), { recursive: true });
      await fs.writeFile(path.join(dir, 'stage-02', 'work-manifest.json'), wm);
      const stages = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: `${n}`.repeat(64), workManifestSha256: n === 2 ? sha256(wm) : '7'.repeat(64) }));
      return { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key, dir, packageSha256: '7'.repeat(64), stages };
    },
    async runStage(batch, stage, opts) { return stage.number === 2 ? wengine.runStage(batch, stage, opts) : { ok: true, factsSha256: '8'.repeat(64) }; },
    requestStop: (b, n) => wengine.requestStop(b, n), stopOutcome: id => wengine.stopOutcome(id), bridgeState: (b, n) => wengine.bridgeState(b, n),
    async closeBatch() { return { verified: true, archived: 0 }; },
    // the Windows retry-stage archive moves the bridge protocol records, issue.ready.json among them (DESIGN 54.4); the worker's
    // reset on its next start stands in for the Linux one
    async archiveFailure(batch, reason) { log.archiveReasons.push(`windows:${reason}`); if (reason.startsWith('retry-stage-')) w.issued = false; return { verified: true, directory: `failed-${batch.key.slice(0, 16)}-${reason}-000000000000` }; },
    async windowsQuiescence() { return WINDOWS_CLEAN; },
  };
  // ---- the executor (real), its companion port over the real mailbox ----
  const iState = path.join(iRoot, 'state');
  const iLedger = await Ledger.open(iState, clock);
  const iReceipts = await ReceiptChain.open(path.join(iState, 'receipts'), clock);
  const iExec = new ResidentExecutor({ policy, ledger: iLedger, receipts: iReceipts, inbox: await Inbox.open(path.join(iRoot, 'inbox'), path.join(iState, 'inbox-archive')),
    requests: await Inbox.open(path.join(iRoot, 'requests'), path.join(iState, 'requests-archive')), owner: await OwnerInbox.open(path.join(iRoot, 'owner'), path.join(iState, 'owner-seen')),
    engine: iEngine, companion: mailboxCompanion(mailbox, vt.sleep), clock, sleep: vt.sleep, queue: await RunQueue.open(path.join(iState, 'queue'), clock),
    executedHeads: await ExecutedHeads.open(iState, clock, { manifestFile: await emptyManifest(path.join(iRoot, 'install')), carriedRoot: path.join(iState, 'backfill') }),
    sourceIntegrity: async () => ({ ok: true, sourceManifestSha256: SOURCE, residentManifestSha256: RESIDENT }) });
  await fs.writeFile(path.join(iRoot, 'inbox', `${String(vt.now).padStart(13, '0')}-000000000929.json`), JSON.stringify(trigger(929)));
  await vt.run(vt.sleep(1000), 60_000); // the companion's first heartbeat
  const r = await vt.run(iExec.tick(), 2 * 60 * 60_000);
  w.alive = false;
  const key = (await iLedger.open()).length === 0 ? (await fs.readdir(path.join(iState, 'ledger')))[0] : null;
  const s = key ? await iLedger.state(key) : null;
  const types = (await iReceipts.entries()).map(e => e.type);
  const cancels = (await fs.readdir(path.join(iRoot, 'mailbox', 'requests'))).filter(n => n.endsWith('.cancel.json'));
  const cancelReasons = await Promise.all(cancels.map(async n => JSON.parse(await fs.readFile(path.join(iRoot, 'mailbox', 'requests', n), 'utf8')).reason));
  return { r, s, log, types, cancelReasons, halted: await iLedger.halted(), stopFiles: (await fs.readdir(path.join(brokerRoot, 'requests'))).filter(n => n.endsWith('.stop')).length,
    pending: await iLedger.pendingAttempts2(), at: at(), issued: w.issued, endedAt: vt.now };
}

{
  const inc = await incidentReplay('replay');
  await step('incident-20261028-replay: relay fails at round 3, the pump answers, the stage is stopped; it runs again twice in the batch (DESIGN 59), each time the same: FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED, no HALT', async () => ({ state: inc.r.state, failureCode: inc.r.failureCode }),
    r => r.state === 'FAILED_CLEAN' && r.failureCode === 'BRIDGE_ABANDONED_UNPUBLISHED' && inc.halted === null && inc.s?.terminal?.facts?.stage === 2
      && inc.s.terminal.facts.originalCode === 'BRIDGE_STAGE_STOPPED_PUMP_LOST' && inc.s.terminal.facts.pumpCode === 'RELAY_REFUSED_NO_RETRY' && inc.s.terminal.facts.stopCode === 'STOP_SENT');
  await step('  in each of the three runs, from the relay failure to the end of the stage within 5 minutes (one stop file per run; 60 s grace after the pump answered)', async () => ({ state: `${inc.log.ends.map((e, i) => Math.round((e - inc.log.failures[i]) / 1000)).join(', ')} s; ${inc.stopFiles} stop files` }),
    () => inc.log.failures.length === 3 && inc.log.ends.length === 3 && inc.log.ends.every((e, i) => e - inc.log.failures[i] >= 0 && e - inc.log.failures[i] <= 5 * 60_000) && inc.stopFiles === 3);
  await step('  receipts: per run bridge-pump-lost and bridge-stop-requested, two execution-retry (retry-stage-2-1, -2 on both hosts), then the scene archived scanner-abandoned on both hosts, one attempt 2 (stage 2)', async () => ({ state: inc.types.filter(x => x.startsWith('bridge-') || x === 'execution-retry' || x === 'attempt2-scheduled').join(',') }),
    () => inc.types.filter(x => x === 'bridge-pump-lost').length === 3 && inc.types.filter(x => x === 'bridge-stop-requested').length === 3
      && inc.types.filter(x => x === 'execution-retry').length === 2 && !inc.types.includes('execution-retry-refused') && inc.types.includes('attempt2-scheduled')
      && ['retry-stage-2-1', 'retry-stage-2-2'].every(x => inc.log.archiveReasons.includes(x) && inc.log.archiveReasons.includes(`windows:${x}`))
      && inc.log.archiveReasons.includes('windows:scanner-abandoned') && inc.log.archiveReasons.includes('scanner-abandoned') && inc.pending.length === 1);
  const active = await incidentReplay('worker-active');
  await step('incident variant: the worker stays active, quiescence is never proven: no run again (refused at quiescence), then HALT within the two 5-minute bounds, original code kept', async () => ({ state: active.r.state, failureCode: active.r.failureCode, reason: `HALT ${Math.round((active.endedAt - active.log.stageEndedAt) / 1000)} s after the stage ended` }),
    r => r.state === 'HALTED' && r.failureCode === 'BRIDGE_STAGE_STOPPED_PUMP_LOST' && active.s?.terminal?.facts?.basis === 'scanner-abandon-quiescence-unproven'
      && active.types.includes('execution-retry-refused') && !active.types.includes('execution-retry') && active.endedAt - active.log.stageEndedAt <= 2 * 5 * 60_000 + 60_000
      && active.halted?.value?.code === 'BRIDGE_STAGE_STOPPED_PUMP_LOST' && !active.log.archiveReasons.some(x => x.includes('scanner-abandoned')) && active.pending.length === 0);
  const dead = await incidentReplay('companion-dead');
  await step('incident variant: the companion dies at the failure: heartbeat lost, its pump cancelled, the stage stopped, a fast HALT (no abandonment)', async () => ({ state: dead.r.state, failureCode: dead.r.failureCode, reasons: dead.cancelReasons.join(',') }),
    r => r.state === 'HALTED' && r.failureCode === 'BRIDGE_STAGE_STOPPED_PUMP_LOST' && dead.cancelReasons.includes('heartbeat-lost') && dead.stopFiles === 1
      && dead.log.stopAt - dead.log.diedAt <= 3 * 60_000 + 30_000 && dead.log.stageEndedAt - dead.log.diedAt < 10 * 60_000
      && !dead.log.archiveReasons.some(x => x.includes('scanner-abandoned')) && dead.halted?.value?.code === 'BRIDGE_STAGE_STOPPED_PUMP_LOST');
  await step('  the memory gate read the VM once before each invocation of stage 2 above (plenty free: no wait): three in the replay (two runs again), one in each variant', async () => ({ state: [inc, active, dead].map(x => x.log.memoryReads).join(',') }),
    () => inc.log.memoryReads === 3 && active.log.memoryReads === 1 && dead.log.memoryReads === 1);
  const low = await incidentReplay('memory-low');
  await step('memory gate (DESIGN §32): no free order-7 block for 6 minutes -> stage 2 never invoked, FAILED_CLEAN LINUX_MEMORY_NOT_READY, no HALT, one attempt 2', async () => ({ state: low.r.state, failureCode: low.r.failureCode, reason: `${low.r.failureCode} after ${low.log.memoryReads} reads in ${Math.round((low.log.gateEndedAt - low.log.gateStartedAt) / 1000)} s` }),
    r => r.state === 'FAILED_CLEAN' && r.failureCode === 'LINUX_MEMORY_NOT_READY' && low.halted === null && low.issued === false && low.log.memoryReads === 7
      && low.log.gateEndedAt - low.log.gateStartedAt <= 6 * 60_000 + 30_000 && low.s?.terminal?.facts?.stage === 2 && low.pending.length === 1
      && low.log.archiveReasons.includes('windows:linux-memory-not-ready') && low.log.archiveReasons.includes('linux-memory-not-ready'));
}

console.table(rows);
const summary = { status: misses === 0 ? 'OFFLINE_DRILL_PASS' : 'OFFLINE_DRILL_FAIL', steps: rows.length, misses, receipts: head1 };
console.log(JSON.stringify(summary));
await fs.rm(root, { recursive: true, force: true }); // drill scratch only
process.exitCode = misses === 0 ? 0 : 1;
