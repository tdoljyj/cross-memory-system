// Offline drill of the resident lifecycle (no host, no network, no secret; temp directories only).
// v0.7: a second instance with the hosted relay on drives one month of free-minutes scenarios (§7.6 of
// the free-minutes design plus the first head after the minutes return) and checks receipt types and order.
// v0.8: an Owner abort of a batch hanging in stage 2 (DESIGN §6.5).
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
import { applyArchive, planArchive, protocolLeaves } from '../src/archive.mjs';
import { abortRequest, inspect, rearmRequest, resumeRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const SOURCE = '5'.repeat(64);
const RESIDENT = '6'.repeat(64);
const BASE = '0'.repeat(40);
const OWNER = 'S-1-5-21-1-2-3-1001';
const head = n => `a${n.toString(16).padStart(39, '0')}`;
const WINDOWS_CLEAN = { windowsTreeZero: true, serviceOriginalStopped: true };

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-resident-drill-'));
const winSpool = path.join(root, 'windows-formal-spool');
const linSpool = path.join(root, 'linux-formal-spool');
for (const d of [winSpool, linSpool]) for (const s of ['incoming', 'outgoing']) await fs.mkdir(path.join(d, s), { recursive: true });
await fs.writeFile(path.join(winSpool, 'outgoing', `${'e'.repeat(64)}.json`), '{"state":"settled"}'); // an effect journal

let now = Date.parse('2026-10-21T00:00:00Z');
const clock = () => now;
const policyInput = {
  contract: 'clued.independent-ci.resident-policy/3', repo: REPO, baseBranch: 'main', sourceManifestSha256: SOURCE, ciSourceManifestSha256: '9'.repeat(64), residentManifestSha256: RESIDENT,
  ownerAcceptance: { decisionRef: '0d84ddbb-ec1f-49c3-bbd0-953f72d53584', installReceiptRef: null }, validUntil: null,
  limits: { maxBatchesPer24h: 12, maxEvaluationsPer24h: 24, maxConcurrent: 1, inboxMaxFiles: 16, unexecutedCooldownMs: 600_000, unexecutedMaxPer24h: 3, stageMarginMs: 180_000 },
  companion: { userSid: OWNER, heartbeatMaxAgeMs: 60_000 },
  stageRunMilliseconds: [900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000, 900000],
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
  async derive(subject, key) { this.current = { subject, key }; return { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key, packageSha256: '7'.repeat(64) }; },
  async runStage(batch, stage) {
    now += 60_000;
    if ([4, 6].includes(stage.number)) { await archive(winSpool, batch.key, `between-roles-${stage.number}`); await archive(linSpool, batch.key, `between-roles-${stage.number}`, LINUX); }
    if ([2, 4, 6].includes(stage.number)) await exchange();
    const r = script.get(`${this.current.subject.pr}:${this.current.subject.attempt}`)?.[stage.number] ?? script.get(this.current.subject.pr)?.[stage.number];
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
  async requestStop(batch, number) { this.stopRequests = (this.stopRequests ?? 0) + 1; this.stopAsked?.(number); return { pump: true, broker: true, requestId: null }; },
  async closeBatch(batch) { const w = await archive(winSpool, batch.key, 'success-close'); const l = await archive(linSpool, batch.key, 'success-close', LINUX); return { verified: w.verified && l.verified, archived: w.moved + l.moved }; },
  async archiveFailure(batch, reason) { return archive(winSpool, batch.key, reason); },
  async windowsQuiescence() { return WINDOWS_CLEAN; },
};
const companion = {
  async heartbeat() { return { at: now }; },
  async buildBundle() { return { ok: true }; },
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
const exec = new ResidentExecutor({ policy, ledger, receipts, inbox, requests, owner, engine, companion, clock,
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
await step('PR 901 head again with a moved main: never re-run', async () => { await drop(trigger(901, { baseSha: '1'.repeat(40) })); return exec.tick(); }, r => r.reason === 'HEAD_ALREADY_EXECUTED_NO_RETRY');
script.set(902, { 1: { ok: false, code: 'PATHS_OUTSIDE_WRITE_SET', proof: WINDOWS_CLEAN } });
await step('PR 902 not admitted: released, nothing reached Linux', async () => { await drop(trigger(902)); return exec.tick(); }, r => r.state === 'NOT_ADMITTED');
await step('PR 902 re-proposed inside the cool-down waits', async () => { await drop(trigger(902)); return exec.tick(); }, r => r.reason === 'UNEXECUTED_COOLDOWN');
script.delete(902);
await step('after the cool-down (claim widened) PR 902 runs', async () => { now += 600_001; return exec.tick(); }, r => r.state === 'COMPLETED');
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
await step('PR 904 is still never re-run automatically', async () => { await drop(trigger(904)); return exec.tick(); }, r => r.reason === 'HEAD_ALREADY_EXECUTED_NO_RETRY');
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
  r => r.reason === 'HEAD_ALREADY_EXECUTED_NO_RETRY' && r.left === 0);
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
const runToEnd = async () => { waitTicks = 0; let r = await relayExec.tick(); while (r.state === 'WAITING') { waitTicks += 1; now += 60_000; r = await relayExec.tick(); } return r; };
const relayExec = new ResidentExecutor({ policy: relayPolicy, ledger: rLedger, receipts: rReceipts, inbox: rInbox, requests: rRequests, owner: rOwner, engine: relayEngine, companion: relayCompanion, clock,
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

// 1. Mid-month, minutes used up: the hosted admission is refused for billing within seconds.
hints.set(911, { gitleaks: { state: 'BILLING_REFUSED' }, trivy: { state: 'BILLING_REFUSED' } });
const m1 = await step('relay month 1 (PR 911): minutes used up -> billing-refused hint -> 1..8 all local, no stage R, no wait', async () => { await rDrop(trigger(911)); return runToEnd(); },
  r => r.state === 'COMPLETED' && same(stagesSeen, [1, 2, 3, 4, 5, 6, 7, 8]) && waitTicks === 0);
const t1 = await batchReceiptTypes(m1.key);
await step('  receipts: plan intent, billing refusal per relayable role, placement fallback, no relay-attested', async () => ({ state: relayTypes(t1).join(',') }),
  () => same(relayTypes(t1), ['relay-plan-intent', 'relay-billing-refused:gitleaks', 'relay-billing-refused:trivy', 'relay-local-fallback:contract-placement']));

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

// 4. Minutes run out inside one head (or the hosted trivy fails to fetch its DB): mixed relay and local.
hints.set(914, { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'HOSTED_NOT_SUCCESS', reason: 'E5_HOSTED_FAILURE' } });
const m4 = await step('relay month 4 (PR 914): gitleaks relayed, trivy local in the same batch -> 1, R, 4, 5, 6, 7, 8 (between-roles-6 only)', async () => { await rDrop(trigger(914)); return relayExec.tick(); },
  r => r.state === 'COMPLETED' && same(stagesSeen, [1, 9, 4, 5, 6, 7, 8]) && same(relayCalls[relayCalls.length - 1], [914, ['gitleaks']]));
const t4 = await batchReceiptTypes(m4.key);
await step('  receipts: gitleaks attested, trivy and placement fall back with their reasons', async () => ({ state: relayTypes(t4).join(',') }),
  () => same(relayTypes(t4), ['relay-plan-intent', 'relay-attested:gitleaks', 'relay-local-fallback:trivy', 'relay-local-fallback:contract-placement']));
// 4b. Stage R itself sends a role back (the hosted run's token does not verify): it runs locally, never relayed.
hints.set(915, { gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } });
relayRows.set(915, { gitleaks: rowLocal('gitleaks', 'RELAY_NOT_ATTESTED_ATTESTATION_FAILED') });
await step('relay month 4b (PR 915): stage R refuses gitleaks attestation -> gitleaks local (2, 3), trivy relayed', async () => { await rDrop(trigger(915)); return relayExec.tick(); },
  r => r.state === 'COMPLETED' && same(stagesSeen, [1, 9, 2, 3, 6, 7, 8]) && same(r.relayed, ['trivy']));
// 5. The emergency stop during a wait: anyone may pause, the batch stops before stage R; only the Owner resumes.
hints.set(916, at => ({ gitleaks: { state: 'PENDING_QUEUED', queuedAt: at }, trivy: { state: 'SUCCESS' } }));
await step('relay month 5 (PR 916): a pause during the hosted wait takes effect on the next tick, before stage R', async () => {
  await rDrop(trigger(916)); const w = await relayExec.tick();
  seq += 1; await fs.writeFile(path.join(relayRoot, 'requests', `${String(now + seq).padStart(13, '0')}-${String(seq).padStart(12, '0')}.json`), JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'drill emergency stop' }));
  now += 60_000; const p = await relayExec.tick(); now += 3_600_000; const p2 = await relayExec.tick();
  return { state: `${w.state}>${p.state}>${p2.state}`, stages: [...stagesSeen] };
}, r => r.state === 'WAITING>PAUSED>PAUSED' && same(r.stages, [1]));
await step('  only the Owner resume continues it; the stored t0 is past the cap, so it starts at once', async () => {
  await writeOwnerRequest(path.join(relayRoot, 'owner'), resumeRequest({ expectedPausedSha256: (await rLedger.paused()).sha256, by: OWNER }), clock); return relayExec.tick();
}, r => r.state === 'COMPLETED' && same(stagesSeen, [1, 9, 2, 3, 6, 7, 8]) && same(r.relayed, ['trivy']));
await step('every relayed head stays burned (PR 913 again: never re-run)', async () => { await rDrop(trigger(913)); return relayExec.tick(); }, r => r.reason === 'HEAD_ALREADY_EXECUTED_NO_RETRY');
const rHead = await rReceipts.verify();
await step('relay month receipt chain intact', async () => ({ state: `seq ${rHead.seq}` }), () => rHead.seq > 20);

console.table(rows);
const summary = { status: misses === 0 ? 'OFFLINE_DRILL_PASS' : 'OFFLINE_DRILL_FAIL', steps: rows.length, misses, receipts: head1 };
console.log(JSON.stringify(summary));
await fs.rm(root, { recursive: true, force: true }); // drill scratch only
process.exitCode = misses === 0 ? 0 : 1;
