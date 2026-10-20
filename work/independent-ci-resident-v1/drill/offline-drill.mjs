// Offline drill of the resident lifecycle (no host, no network, no secret; temp directories only).
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
import { inspect, rearmRequest, resumeRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';

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
const policy = validatePolicy({
  contract: 'clued.independent-ci.resident-policy/2', repo: REPO, baseBranch: 'main', sourceManifestSha256: SOURCE, ciSourceManifestSha256: '9'.repeat(64), residentManifestSha256: RESIDENT,
  ownerAcceptance: { decisionRef: '0d84ddbb-ec1f-49c3-bbd0-953f72d53584', installReceiptRef: null }, validUntil: null,
  limits: { maxBatchesPer24h: 12, maxEvaluationsPer24h: 24, maxConcurrent: 1, inboxMaxFiles: 16, unexecutedCooldownMs: 600_000, unexecutedMaxPer24h: 3, stageMarginMs: 180_000 },
  companion: { userSid: OWNER, heartbeatMaxAgeMs: 60_000 },
  stageRunMilliseconds: [900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000],
  linux: { distribution: 'Ubuntu-24.04', workerUnit: 'clued-ci-worker@.service', wsprepUnit: 'clued-ci-wsprep@.service', archiveUnit: 'clued-ci-archive@.service' },
  automaticAttempt2: { enabled: true, delayMs: 600_000 }, retention: { reminderBytes: 50 * 1024 ** 3, checkEveryMs: 3_600_000 },
});

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
    return r ?? { ok: true, factsSha256: '8'.repeat(64) };
  },
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

console.table(rows);
const summary = { status: misses === 0 ? 'OFFLINE_DRILL_PASS' : 'OFFLINE_DRILL_FAIL', steps: rows.length, misses, receipts: head1 };
console.log(JSON.stringify(summary));
await fs.rm(root, { recursive: true, force: true }); // drill scratch only
process.exitCode = misses === 0 ? 0 : 1;
