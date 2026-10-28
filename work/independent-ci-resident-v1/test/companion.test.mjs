import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Mailbox, REQUEST_CONTRACT, validateRequest } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, argv, parsePull, readPullArgv, validateCompanionConfig } from '../src/companion.mjs';
import { Poller } from '../src/poller.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';

const cfg = validateCompanionConfig({
  contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA,
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
  const state = { issueReady: true, challengesLeft: challenges, responseReady: new Set() };
  const run = async (args) => {
    log.push(args);
    const joined = args.join(' ');
    if (args.includes('-Mode')) {
      const mode = args[args.indexOf('-Mode') + 1];
      const seq = Number(args[args.indexOf('-Sequence') + 1]);
      const ok = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
      const none = { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
      if (mode === 'SendIssue') return failSendIssue ? { code: 1, stdout: '{}' } : ok;
      if (mode === 'ReceiveResult') return state.challengesLeft === 0 ? ok : none;
      if (mode === 'ReceiveChallenge') { if (state.challengesLeft > 0 && seq === challenges - state.challengesLeft + 1) { state.challengesLeft -= 1; state.responseReady.add(seq); return ok; } return none; }
      if (mode === 'SendResponse') return ok;
    }
    // The Linux outgoing listing: the next challenge until all are answered, then the result.
    if (joined.includes('/usr/bin/ls')) {
      const next = challenges - state.challengesLeft + 1;
      const ch = `challenge-${String(next).padStart(2, '0')}`;
      return { code: 0, stdout: state.challengesLeft > 0 ? `active.lock\n${ch}.json\n${ch}.ready.json\n` : 'result.json\nresult.ready.json\n' };
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
  // The listing decides when to call the relay: no empty ReceiveChallenge/ReceiveResult calls in between.
  assert.deepEqual(modes, ['SendIssue:0', 'ReceiveChallenge:1', 'SendResponse:1', 'ReceiveChallenge:2', 'SendResponse:2', 'ReceiveResult:0']);
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
    { number: 884, headRefOid: 'a'.repeat(40), baseRefOid: 'd'.repeat(40), isDraft: false, body: 'x\nClued-Work-Claim: 842cf499-1519-4ba9-b3be-b9ac3f6e8ee4\n', updatedAt: 't1' },
    { number: 885, headRefOid: 'b'.repeat(40), isDraft: true, body: 'Clued-Work-Claim: 842cf499-1519-4ba9-b3be-b9ac3f6e8ee4', updatedAt: 't1' },
    { number: 886, headRefOid: 'c'.repeat(40), isDraft: false, body: 'no trailer', updatedAt: 't1' },
  ];
  // the main tip, the main...head compares (up to date: behind_by 0), the PR list
  const run = async args => args.some(a => a.includes('/compare/')) ? { code: 0, stdout: JSON.stringify({ behind_by: 0, base: 'd'.repeat(40) }) }
    : args.includes('api') ? { code: 0, stdout: `${'d'.repeat(40)}\n` } : { code: 0, stdout: JSON.stringify(pulls) };
  const p = new Poller({ repo: 'tdoljyj/cross-memory-system', ghExe: 'C:\\gh.exe', run, writeTrigger: async v => written.push(v), clock: () => 0 });
  assert.equal(await p.pass(), 1);
  assert.equal(await p.pass(), 0);
  pulls[0].updatedAt = 't2';
  assert.equal(await p.pass(), 1);
  assert.deepEqual(Object.keys(written[0]).sort(), ['baseSha', 'contract', 'headSha', 'pr', 'repo']);
  assert.equal(written[0].baseSha, 'd'.repeat(40));
});

test('pr-head (phase 2): an exact request and answer shape; the companion reads the PR with a fixed gh argv, never anything else', async t => {
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => Date.parse('2026-10-22T12:00:00Z'));
  const req = await box.send('pr-head', { batchId: BATCH, pr: 884 }, 60_000);
  assert.throws(() => validateRequest({ ...req, pr: 'x' }), { code: 'MAILBOX_PR_REFUSED' });
  await assert.rejects(box.respond(req, { ok: true, pull: { number: 885, state: 'open', headSha: 'a'.repeat(40) } }), { code: 'MAILBOX_RESPONSE_PULL_REFUSED' });
  const other = await box.send('linux-quiescence', { batchId: BATCH }, 60_000);
  await assert.rejects(box.respond(other, { ok: true, pull: { number: 884, state: 'open', headSha: 'a'.repeat(40) } }), { code: 'MAILBOX_RESPONSE_PULL_REFUSED' });
  const asked = [];
  const run = async (args) => { asked.push(args); return { code: 0, stdout: JSON.stringify({ number: 884, state: 'closed', merged: true, head: 'a'.repeat(40) }) }; };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async () => false, sleep: async () => {}, clock: () => Date.parse('2026-10-22T12:00:00Z'), readPull: pr => readPullArgv('C:\\gh.exe', 'tdoljyj/cross-memory-system', pr) });
  await c.step();
  assert.deepEqual((await box.poll(req)).pull, { number: 884, state: 'merged', headSha: 'a'.repeat(40) });
  assert.deepEqual(asked.find(a => a.includes('api')), ['C:\\gh.exe', 'api', '--method', 'GET', 'repos/tdoljyj/cross-memory-system/pulls/884', '--jq', '{number: .number, state: .state, merged: .merged, head: .head.sha}']);
  assert.equal(parsePull('{"number":884,"state":"open","merged":false,"head":"not-a-sha"}', 884), null);
  assert.equal(parsePull('{"number":1,"state":"open","merged":false,"head":"' + 'a'.repeat(40) + '"}', 884), null, 'another PR is no answer');
  assert.throws(() => readPullArgv('gh', 'tdoljyj/cross-memory-system', 1), { code: 'COMPANION_PR_HEAD_ARGS_INVALID' });
  // without a read port the companion answers that it cannot, never a guess
  const none = new Companion({ cfg, mailbox: box, run, fileExists: async () => false, sleep: async () => {}, clock: () => Date.parse('2026-10-22T12:00:00Z') });
  const req2 = await box.send('pr-head', { batchId: BATCH, pr: 7 }, 60_000);
  await none.step();
  assert.deepEqual([(await box.poll(req2)).ok, (await box.poll(req2)).code], [false, 'PR_HEAD_UNAVAILABLE']);
});

test('poller (phase 2): trigger /2 with the PR\'s update time; a run queue that started over gets every head proposed again', async t => {
  const written = [];
  const pulls = [{ number: 884, headRefOid: 'a'.repeat(40), baseRefOid: 'd'.repeat(40), isDraft: false, body: 'Clued-Work-Claim: 842cf499-1519-4ba9-b3be-b9ac3f6e8ee4', updatedAt: '2026-10-22T11:59:00Z' }];
  const run = async args => args.some(a => a.includes('/compare/')) ? { code: 0, stdout: JSON.stringify({ behind_by: 0, base: 'd'.repeat(40) }) }
    : args.includes('api') ? { code: 0, stdout: `${'d'.repeat(40)}\n` } : { code: 0, stdout: JSON.stringify(pulls) };
  const p = new Poller({ repo: 'tdoljyj/cross-memory-system', ghExe: 'C:\\gh.exe', run, writeTrigger: async v => written.push(v), clock: () => 0 });
  assert.equal(await p.pass({ generation: 'aaaaaaaaaaaa' }), 1);
  assert.deepEqual([written[0].contract, written[0].prUpdatedAt], ['clued.independent-ci.resident-trigger/2', '2026-10-22T11:59:00.000Z']);
  assert.equal(await p.pass({ generation: 'aaaaaaaaaaaa' }), 0);
  assert.equal(await p.pass({ generation: null }), 0, 'an unreadable status changes nothing');
  assert.equal(await p.pass({ generation: 'bbbbbbbbbbbb' }), 1, 'the queue started over');
});
