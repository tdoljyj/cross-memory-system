import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Mailbox, REQUEST_CONTRACT, validateRequest } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, argv, validateCompanionConfig } from '../src/companion.mjs';
import { Poller } from '../src/poller.mjs';
import { tempRoot } from './helpers.mjs';

const cfg = validateCompanionConfig({
  contract: COMPANION_CONFIG_CONTRACT,
  wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\build-bundle.ps1',
  windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04',
  bridgeManifestSha256: '9'.repeat(64),
  linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux',
});
const BATCH = '0123456789abcdef-0123456789ab';
const JOB = 'e'.repeat(64);

test('argv builders are fixed and refuse anything that is not a validated id', () => {
  const a = argv(cfg);
  assert.deepEqual(a.startWait('clued-ci-wsprep', BATCH).slice(-4), ['/usr/bin/systemctl', 'start', '--wait', `clued-ci-wsprep@${BATCH}.service`]);
  assert.equal(a.startNoBlock('clued-ci-worker', JOB).at(-1), `clued-ci-worker@${JOB}.service`);
  assert.throws(() => a.startWait('clued-ci-wsprep', 'x; rm -rf /'), { code: 'COMPANION_UNIT_INSTANCE_INVALID' });
  assert.throws(() => a.linuxTool('sh', BATCH), { code: 'COMPANION_TOOL_ARGS_INVALID' });
  assert.throws(() => a.relay('Anything', 0), { code: 'COMPANION_RELAY_ARGS_INVALID' });
  assert.throws(() => a.relay('SendResponse', 33), { code: 'COMPANION_RELAY_ARGS_INVALID' });
  assert.ok(a.startWait('clued-ci-wsprep', BATCH).every(s => typeof s === 'string'));
  assert.throws(() => validateCompanionConfig({ ...cfg, linuxTool: '/tmp/x' }), { code: 'COMPANION_LINUX_TOOL_FIXED' });
});

test('mailbox requests and responses have exact shapes; no free-form field survives', async t => {
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => Date.parse('2026-10-20T12:00:00Z'));
  const req = await box.send('archive-linux', { batchId: BATCH, reason: 'formal-bridge-stage-deadline' }, 60_000);
  assert.throws(() => validateRequest({ ...req, script: 'whoami' }), { code: 'MAILBOX_REQUEST_KEYS_REFUSED' });
  assert.throws(() => validateRequest({ ...req, reason: '../../etc' }), { code: 'MAILBOX_ARCHIVE_REASON_REFUSED' });
  await assert.rejects(box.send('run-anything', { batchId: BATCH }, 1000), { code: 'MAILBOX_REQUEST_KIND_REFUSED' });
  assert.equal(await box.poll(req), null);
  await box.respond(req, { ok: true, verified: true, directory: 'failed-0123456789ab-formal-bridge-stage-deadline-aaaaaaaaaaaa' });
  assert.equal((await box.poll(req)).verified, true);
  await assert.rejects(box.respond(req, { ok: true }), { code: 'CREATE_ONLY_TARGET_EXISTS' });
  await fs.writeFile(path.join(root, 'responses', 'x.json'), '{}');
  await assert.rejects(box.respond({ ...req, requestId: '11111111-1111-1111-1111-111111111111' }, { ok: true, directory: 'C:\\Windows' }), { code: 'MAILBOX_RESPONSE_DIRECTORY_REFUSED' });
  assert.equal(REQUEST_CONTRACT.endsWith('/1'), true);
});

// A scripted fake of relay-public.ps1 + systemctl + the Linux tool.
function fakeHost({ challenges = 1, workerExit = 'inactive', failSendIssue = false } = {}) {
  const log = [];
  const state = { issueReady: true, challengesLeft: challenges, responseReady: new Set(), resultReady: false };
  const run = async (args) => {
    log.push(args);
    const joined = args.join(' ');
    if (args.includes('-Mode')) {
      const mode = args[args.indexOf('-Mode') + 1];
      const seq = Number(args[args.indexOf('-Sequence') + 1]);
      const ok = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
      const none = { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
      if (mode === 'SendIssue') return failSendIssue ? { code: 1, stdout: '{}' } : ok;
      if (mode === 'ReceiveResult') return state.resultReady ? ok : none;
      if (mode === 'ReceiveChallenge') { if (state.challengesLeft > 0) { state.challengesLeft -= 1; state.responseReady.add(seq); return ok; } state.resultReady = true; return none; }
      if (mode === 'SendResponse') return ok;
    }
    if (joined.includes('show --property=ActiveState')) return { code: 0, stdout: `${workerExit}\n` };
    if (joined.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
    if (joined.includes('start --no-block')) return { code: 0, stdout: '' };
    return { code: 0, stdout: '' };
  };
  const fileExists = async p => (p.endsWith('issue.ready.json') && state.issueReady) || [...state.responseReady].some(s => p.endsWith(`response-${String(s).padStart(2, '0')}.ready.json`));
  return { log, run, fileExists };
}

test('the moved bridge pump follows issue -> worker -> challenge/response -> result and never kills', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-20T12:00:00Z');
  const clock = () => now;
  const host = fakeHost({ challenges: 2 });
  const mailbox = await Mailbox.open(root, clock);
  const c = new Companion({ cfg, mailbox, run: host.run, fileExists: host.fileExists, sleep: async ms => { now += ms; }, clock });
  const req = await mailbox.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 45 * 60_000);
  await c.step();
  const res = await mailbox.poll(req);
  assert.equal(res.ok, true);
  assert.deepEqual(res.proof, { linuxUnitsInactive: true, containersZero: true });
  const modes = host.log.filter(a => a.includes('-Mode')).map(a => `${a[a.indexOf('-Mode') + 1]}:${a[a.indexOf('-Sequence') + 1]}`);
  assert.deepEqual(modes.filter(m => !m.startsWith('ReceiveResult')), ['SendIssue:0', 'ReceiveChallenge:1', 'SendResponse:1', 'ReceiveChallenge:2', 'SendResponse:2', 'ReceiveChallenge:3']);
  assert.equal(host.log.some(a => a.includes('stop') || a.includes('kill')), false);
  const beat = JSON.parse(await fs.readFile(path.join(root, 'responses', 'heartbeat.json'), 'utf8'));
  assert.equal(typeof beat.at, 'number', 'the heartbeat is written where the companion has write access');
  assert.deepEqual(await mailbox.heartbeat(), { at: beat.at });
  // linux-quiescence answers are the root tool's own facts, passed through unchanged.
  const q = await mailbox.send('linux-quiescence', { batchId: BATCH }, 60_000);
  await c.step();
  assert.deepEqual((await mailbox.poll(q)).proof, { linuxUnitsInactive: true, containersZero: true });
});

test('a refused relay or a missing issue is reported, with the observed quiescence, not retried', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-20T12:00:00Z');
  const clock = () => now;
  const host = fakeHost({ failSendIssue: true });
  const mailbox = await Mailbox.open(root, clock);
  const c = new Companion({ cfg, mailbox, run: host.run, fileExists: host.fileExists, sleep: async ms => { now += ms; }, clock });
  const req = await mailbox.send('relay-stage', { batchId: BATCH, stage: 4, jobId: JOB }, 60_000);
  await c.step();
  const res = await mailbox.poll(req);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RELAY_REFUSED_NO_RETRY');
  assert.equal(host.log.filter(a => a.includes('SendIssue')).length, 1);
  // Expired requests are answered as expired without running anything.
  const late = await mailbox.send('build-bundle', { batchId: BATCH }, 1000);
  now += 5000;
  const before = host.log.length;
  await c.step();
  assert.equal((await mailbox.poll(late)).code, 'COMPANION_REQUEST_EXPIRED');
  assert.equal(host.log.length, before);
});

test('poller proposes ready heads once, skips drafts and PRs without a claim trailer', async t => {
  const written = [];
  const pulls = [
    { number: 884, headRefOid: 'a'.repeat(40), isDraft: false, body: 'x\nClued-Work-Claim: 842cf499-1519-4ba9-b3be-b9ac3f6e8ee4\n', updatedAt: 't1' },
    { number: 885, headRefOid: 'b'.repeat(40), isDraft: true, body: 'Clued-Work-Claim: 842cf499-1519-4ba9-b3be-b9ac3f6e8ee4', updatedAt: 't1' },
    { number: 886, headRefOid: 'c'.repeat(40), isDraft: false, body: 'no trailer', updatedAt: 't1' },
  ];
  const run = async args => args.includes('api') ? { code: 0, stdout: `${'d'.repeat(40)}\n` } : { code: 0, stdout: JSON.stringify(pulls) };
  const p = new Poller({ repo: 'tdoljyj/cross-memory-system', ghExe: 'C:\\gh.exe', run, writeTrigger: async v => written.push(v), clock: () => 0 });
  assert.equal(await p.pass(), 1);
  assert.equal(await p.pass(), 0);
  pulls[0].updatedAt = 't2';
  assert.equal(await p.pass(), 1);
  assert.deepEqual(Object.keys(written[0]).sort(), ['baseSha', 'contract', 'headSha', 'pr', 'repo']);
  assert.equal(written[0].baseSha, 'd'.repeat(40));
});
