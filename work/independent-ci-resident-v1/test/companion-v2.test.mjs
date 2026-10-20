// Source v2 companion and retention: the refs gate, the clean 'blocked' end of a bridge stage, the Linux
// archive usage, and the 50 GB reminder receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Mailbox } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, argv, validateCompanionConfig } from '../src/companion.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { RetentionWatch, measureWindows, REMINDER_RECEIPT } from '../src/retention.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { tempRoot, rawPolicy } from './helpers.mjs';

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\protected-job-bridge-v4\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const BATCH = '0123456789abcdef-0123456789ab';
const JOB = 'e'.repeat(64);
const T0 = Date.parse('2026-10-21T08:00:00Z');

function host(script) {
  const log = [];
  const run = async args => { log.push(args); return script(args) ?? { code: 0, stdout: '' }; };
  return { log, run };
}
async function companionWith(t, script, fileExists = async () => true) {
  const root = await tempRoot(t);
  let now = T0;
  const clock = () => now;
  const mailbox = await Mailbox.open(root, clock);
  const h = host(script);
  const c = new Companion({ cfg, mailbox, run: h.run, fileExists, sleep: async ms => { now += ms; }, clock });
  return { c, mailbox, h, advance: ms => { now += ms; } };
}
const transferred = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
const absent = { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
const mode = a => a.includes('-Mode') ? a[a.indexOf('-Mode') + 1] : null;

test('argv: the refs gate and archive usage are fixed commands; ReceiveBlocked is a fixed relay mode', () => {
  const a = argv(cfg);
  assert.deepEqual(a.checkRefs(BATCH).slice(-5), ['-File', cfg.bundleScript, '-BatchId', BATCH, '-CheckRefs']);
  assert.throws(() => a.checkRefs('x'), { code: 'COMPANION_BUNDLE_ARGS_INVALID' });
  assert.deepEqual(a.archiveUsage().slice(-2), [cfg.linuxTool, 'archive-usage']);
  assert.equal(a.relay('ReceiveBlocked', 0).includes('ReceiveBlocked'), true);
});

test('check-refs answers exactly the bundle script verdict; anything else is unavailable, never unchanged', async t => {
  for (const [status, ok, code] of [['REMOTE_REFS_UNCHANGED', true, null], ['REMOTE_REFS_CHANGED_SINCE_BUNDLE', false, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'], ['REFUSED_BEFORE_WRITE', false, 'REMOTE_REFS_UNAVAILABLE']]) {
    const f = await companionWith(t, a => (a.includes('-CheckRefs') ? { code: status === 'REMOTE_REFS_UNCHANGED' ? 0 : 2, stdout: JSON.stringify({ status }) } : null));
    const req = await f.mailbox.send('check-refs', { batchId: BATCH }, 60_000);
    await f.c.step();
    const r = await f.mailbox.poll(req);
    assert.deepEqual([r.ok, r.code], [ok, code], status);
  }
});

test('a clean Linux refusal (bridge v4 blocked record) ends the pump without waiting for a result', async t => {
  const f = await companionWith(t, a => {
    const m = mode(a);
    if (m === 'SendIssue') return transferred;
    if (m === 'ReceiveChallenge' || m === 'ReceiveResult') return absent;
    if (m === 'ReceiveBlocked') return transferred;
    if (a.join(' ').includes('show --property=ActiveState')) return { code: 0, stdout: 'inactive\n' };
    if (a.join(' ').includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
    return null;
  });
  const req = await f.mailbox.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 45 * 60_000);
  await f.c.step();
  const r = await f.mailbox.poll(req);
  assert.equal(r.ok, true);
  assert.deepEqual(f.h.log.map(mode).filter(Boolean), ['SendIssue', 'ReceiveChallenge', 'ReceiveResult', 'ReceiveBlocked']);
});

test('archive-usage carries the root tool numbers through the mailbox to the service port', async t => {
  const f = await companionWith(t, a => (a.includes('archive-usage') ? { code: 0, stdout: JSON.stringify({ contract: 'clued.independent-ci.linux-archive-usage/1', bytes: 123, directories: 4 }) } : null));
  const port = mailboxCompanion(f.mailbox, async () => { await f.c.step(); });
  assert.deepEqual(await port.archiveUsage(), { ok: true, bytes: 123, directories: 4 });
  const g = await companionWith(t, () => ({ code: 0, stdout: '{"bytes":-1}' }));
  const port2 = mailboxCompanion(g.mailbox, async () => { await g.c.step(); });
  assert.deepEqual(await port2.archiveUsage(), { ok: false });
});

test('retention: one reminder receipt per day above the threshold, never a deletion; Windows archives are measured', async t => {
  const root = await tempRoot(t);
  const spool = path.join(root, 'formal-spool');
  await fs.mkdir(path.join(spool, 'archive-0123456789ab-success-close-aaaaaaaaaaaa'), { recursive: true });
  await fs.writeFile(path.join(spool, 'archive-0123456789ab-success-close-aaaaaaaaaaaa', 'r.json'), Buffer.alloc(1000));
  await fs.mkdir(path.join(spool, 'incoming'));
  await fs.writeFile(path.join(spool, 'incoming', 'issue.json'), Buffer.alloc(5000)); // live records are not archives
  await fs.mkdir(path.join(root, 'work', 'b1'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'b1', 'batch.json'), Buffer.alloc(10));
  const w = await measureWindows({ spool, work: path.join(root, 'work'), bundles: path.join(root, 'bundles') });
  assert.deepEqual(w, { bytes: 1010, directories: 1, complete: true });
  let now = T0;
  const receipts = await ReceiptChain.open(path.join(root, 'receipts'), () => now);
  const policy = validatePolicy(rawPolicy());
  let linuxBytes = 50 * 1024 ** 3;
  const watch = new RetentionWatch({ policy, receipts, clock: () => now, measureWindows: async () => w, measureLinux: async () => ({ ok: true, bytes: linuxBytes, directories: 9 }) });
  const first = await watch.maybeCheck();
  assert.equal(first.reminded, true);
  assert.equal(first.totalBytes, 50 * 1024 ** 3 + 1010);
  assert.equal(await watch.maybeCheck(), null, 'measured at most once per checkEveryMs');
  now += 3_600_000;
  assert.equal((await watch.maybeCheck()).reminded, false, 'once per day');
  now += 86_400_000;
  linuxBytes = 1;
  assert.equal((await watch.maybeCheck()).reminded, false, 'below the threshold');
  const files = (await fs.readdir(path.join(root, 'receipts'))).sort();
  const bodies = await Promise.all(files.map(async n => JSON.parse(await fs.readFile(path.join(root, 'receipts', n), 'utf8'))));
  const reminders = bodies.filter(b => b.type === REMINDER_RECEIPT);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].body.deletesAnything, false);
});
