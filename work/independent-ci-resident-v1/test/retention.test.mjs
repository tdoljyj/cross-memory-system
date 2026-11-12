// Archive retention (DESIGN §35, Task 4aedda54) and the heartbeat gate of the Linux measurement (Task 018da927 c).
// Temporary directories only: nothing on the host is read, changed or deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DISK_RECEIPT, DISK_REMINDER_BYTES, KEEP_CONTRACT, PRUNE_RECEIPT, REMINDER_RECEIPT, RetentionWatch, archiveClass, parseKeepList, planRetention,
  pruneSpool, readKeepList, removeTree } from '../src/retention.mjs';
import { Mailbox, validatePrune } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, argv, validateCompanionConfig } from '../src/companion.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { serviceLoop } from '../src/service-main.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { TEST_NODE, TEST_NODE_SHA, rawPolicy, tempRoot } from './helpers.mjs';

const CASES = JSON.parse(await fs.readFile(new URL('./fixtures/retention-cases.json', import.meta.url), 'utf8'));
const T0 = Date.parse('2026-10-29T08:00:00Z');
const entry = ([name, mtimeMs, bytes, extra = {}]) => ({ name, mtimeMs, bytes, complete: true, isDir: true, links: 0, ...extra });

test('the plan: every shared case (the Linux tool is held to the same file)', () => {
  assert.equal(CASES.contract, 'clued.independent-ci.retention-cases/1');
  for (const c of CASES.cases) {
    const p = planRetention({ entries: c.entries.map(entry), keep: new Set(c.keep ?? []), rule: c.rule ?? CASES.rule });
    assert.deepEqual(p.deletes.map(d => d.name), c.deletes, c.name);
    assert.deepEqual({ success: p.classes.success.refused, failure: p.classes.failure.refused }, c.refused, c.name);
    assert.equal(p.deferred, c.deferred, c.name);
    assert.equal(p.protected.directories, c.protected, c.name);
  }
  assert.deepEqual(['archive-a', 'completed-a', 'failed-a', 'incoming', 'archive-', 'failed'].map(archiveClass), ['success', 'success', 'failure', null, null, null]);
});

test('the keep list: exact contract, else refused; a missing file refuses too (review M2), an empty keep list allows', async t => {
  const root = await tempRoot(t);
  const owner = path.join(root, 'owner');
  await fs.mkdir(owner);
  const file = path.join(owner, 'retention-keep.json');
  assert.deepEqual(await readKeepList(file, 'windows'), { ok: false, code: 'RETENTION_KEEP_LIST_MISSING' });
  assert.deepEqual(await readKeepList(path.join(root, 'absent', 'retention-keep.json'), 'windows'), { ok: false, code: 'RETENTION_KEEP_LIST_MISSING' });
  await fs.writeFile(file, JSON.stringify({ contract: KEEP_CONTRACT, keep: [] }));
  assert.deepEqual(await readKeepList(file, 'windows'), { ok: true, names: new Set(), entries: 0 });
  await fs.rm(file);
  const good = { contract: KEEP_CONTRACT, keep: [{ name: 'failed-a-1', spool: 'windows', ref: 'Bug 1234abcd' }, { name: 'archive-b-2', spool: 'linux', ref: 'owner' },
    { name: 'failed-c-3', spool: 'any', ref: 'Evidence 9' }] };
  await fs.writeFile(file, JSON.stringify(good));
  assert.deepEqual([...(await readKeepList(file, 'windows')).names].sort(), ['failed-a-1', 'failed-c-3']);
  assert.deepEqual([...(await readKeepList(file, 'linux')).names].sort(), ['archive-b-2', 'failed-c-3']);
  for (const bad of [{ ...good, extra: 1 }, { contract: 'x', keep: [] }, { contract: KEEP_CONTRACT, keep: [{ name: '../x', spool: 'any', ref: 'r' }] },
    { contract: KEEP_CONTRACT, keep: [{ name: 'failed-a', spool: 'mars', ref: 'r' }] }, { contract: KEEP_CONTRACT, keep: [{ name: 'failed-a', spool: 'any', ref: '' }] }]) {
    assert.throws(() => parseKeepList(Buffer.from(JSON.stringify(bad))), { code: 'RETENTION_KEEP_LIST_INVALID' });
  }
  await fs.writeFile(file, '{not json');
  assert.deepEqual(await readKeepList(file, 'windows'), { ok: false, code: 'RETENTION_KEEP_LIST_INVALID' });
});

async function spoolWith(t, dirs) {
  const root = await tempRoot(t);
  const spool = path.join(root, 'formal-spool');
  await fs.mkdir(path.join(spool, 'incoming'), { recursive: true });
  await fs.writeFile(path.join(spool, 'incoming', 'issue.json'), Buffer.alloc(9000));
  let i = 0;
  for (const [name, bytes] of dirs) {
    await fs.mkdir(path.join(spool, name, 'sub'), { recursive: true });
    await fs.writeFile(path.join(spool, name, 'sub', 'f.bin'), Buffer.alloc(bytes));
    const when = new Date(T0 + 60_000 * i++);
    await fs.utimes(path.join(spool, name), when, when);
  }
  return { root, spool, list: async () => (await fs.readdir(spool)).sort() };
}
const RULE = { classBudgetBytes: 1000, minKeepPerClass: 2, maxDeletesPerPass: 16 };

test('a Windows pass deletes the oldest over budget, keeps the protected and the newest, and touches nothing else', async t => {
  const s = await spoolWith(t, [['failed-a-1', 800], ['failed-a-2', 800], ['failed-a-3', 300], ['failed-a-4', 300], ['archive-b-1', 600], ['archive-b-2', 600], ['completed-b-3', 10]]);
  const r = await pruneSpool({ spool: s.spool, keep: { ok: true, names: new Set(['failed-a-1']) }, rule: RULE });
  assert.equal(r.refused, null);
  assert.equal(r.stopped, null);
  assert.deepEqual(r.deleted.map(d => d.name), ['failed-a-2', 'archive-b-1']);
  assert.equal(r.deletedBytes, 1400);
  assert.deepEqual(r.protected, { directories: 1, bytes: 800, complete: true, names: ['failed-a-1'] });
  assert.deepEqual(await s.list(), ['archive-b-2', 'completed-b-3', 'failed-a-1', 'failed-a-3', 'failed-a-4', 'incoming']);
  assert.equal((await fs.stat(path.join(s.spool, 'incoming', 'issue.json'))).size, 9000);
  // The facts fit the mailbox's prune shape once the protected names are left out (the Linux answer).
  assert.doesNotThrow(() => validatePrune({ ...r, protected: { directories: 1, bytes: 800, complete: true } }));
});

test('fail closed: a junction in a class, an unreadable keep list, or a redirected spool deletes nothing', async t => {
  const s = await spoolWith(t, [['failed-a-1', 800], ['failed-a-2', 800], ['failed-a-3', 800], ['archive-b-1', 800], ['archive-b-2', 800], ['archive-b-3', 800]]);
  const outside = path.join(s.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'precious.txt'), 'keep me');
  await fs.symlink(outside, path.join(s.spool, 'failed-a-3', 'sub', 'escape'), 'junction');
  const r = await pruneSpool({ spool: s.spool, keep: { ok: true, names: new Set() }, rule: RULE });
  assert.equal(r.classes.failure.refused, 'RETENTION_LINK_REFUSED');
  assert.deepEqual(r.deleted.map(d => d.name), ['archive-b-1'], 'the other class still follows the rule');
  assert.equal(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
  assert.ok((await s.list()).includes('failed-a-1'));
  const refused = await pruneSpool({ spool: s.spool, keep: { ok: false, code: 'RETENTION_KEEP_LIST_INVALID' }, rule: RULE });
  assert.deepEqual([refused.refused, refused.deleted], ['RETENTION_KEEP_LIST_INVALID', []]);
  const link = path.join(s.root, 'spool-link');
  await fs.symlink(s.spool, link, 'junction');
  assert.equal((await pruneSpool({ spool: link, keep: { ok: true, names: new Set() }, rule: RULE })).refused, 'RETENTION_SPOOL_REDIRECTED');
  await assert.rejects(removeTree(path.join(s.spool, 'failed-a-3')), { code: 'RETENTION_LINK_REFUSED' });
  assert.equal(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
});

function watchWith(receipts, now, ports) {
  return new RetentionWatch({ policy: validatePolicy(rawPolicy()), receipts, clock: () => now.t,
    measureWindows: async () => ({ bytes: 1, directories: 1, complete: true }), ...ports });
}

test('Task 018da927 (c): without a fresh heartbeat neither the Linux measurement nor the Linux prune is asked, and the loop is not held', async t => {
  const root = await tempRoot(t);
  const now = { t: T0 };
  const receipts = await ReceiptChain.open(path.join(root, 'receipts'), () => now.t);
  let asked = 0;
  const hang = () => { asked += 1; return new Promise(() => {}); }; // a companion that never answers (the 3-minute timeout)
  const watch = watchWith(receipts, now, { companionReady: async () => false, measureLinux: hang, pruneLinux: hang, idle: async () => ({ ok: true }) });
  const started = Date.now();
  const r = await watch.maybeCheck();
  assert.ok(Date.now() - started < 2000);
  assert.equal(asked, 0);
  assert.deepEqual(r.linux, { bytes: null, directories: null, complete: false, skipped: 'COMPANION_HEARTBEAT_ABSENT' });
  // The service loop runs its tick and the between-batches step and returns (once) without waiting for any companion.
  let ticks = 0;
  const code = await serviceLoop({ exec: { tick: async () => { ticks += 1; return { state: 'IDLE' }; } }, lock: { touch: async () => {} }, sleep: async () => {}, once: true,
    stopRequested: async () => false, acknowledgeStop: async () => {}, onLoopException: async () => {}, betweenBatches: () => watchWith(receipts, { t: T0 + 10 * 86_400_000 },
      { companionReady: async () => false, measureLinux: hang, pruneLinux: hang, idle: async () => ({ ok: true }) }).maybeCheck() });
  assert.deepEqual([code, ticks, asked], [0, 1, 0]);
  // With a heartbeat the measurement is asked as before.
  const fresh = watchWith(receipts, now, { companionReady: async () => true, measureLinux: async () => { asked += 1; return { ok: true, bytes: 5, directories: 2 }; } });
  assert.equal((await fresh.maybeCheck()).totalBytes, 6);
  assert.equal(asked, 1);
});

test('deletion runs only when idle; a pass with deletions writes its receipt each time, a refusal once a day', async t => {
  const root = await tempRoot(t);
  const now = { t: T0 };
  const receipts = await ReceiptChain.open(path.join(root, 'receipts'), () => now.t);
  let idle = { ok: false, reason: 'BATCH_OPEN' }, windowsPasses = 0;
  const deleted = [{ name: 'failed-a-1', class: 'failure', bytes: 7 }];
  let facts = { rule: {}, refused: null, classes: null, protected: null, deferred: 0, deleted, deletedBytes: 7, stopped: null };
  const watch = watchWith(receipts, now, { companionReady: async () => false, idle: async () => idle, pruneWindows: async () => { windowsPasses += 1; return facts; } });
  assert.equal((await watch.maybeCheck()).prune.skipped, 'BATCH_OPEN');
  assert.equal(windowsPasses, 0, 'an open (running, waiting or parked) batch: nothing is planned or deleted');
  idle = { ok: true };
  now.t += 3_600_000; await watch.maybeCheck();
  now.t += 3_600_000; await watch.maybeCheck();
  facts = { ...facts, deleted: [], deletedBytes: 0, refused: 'RETENTION_KEEP_LIST_INVALID' };
  now.t += 3_600_000; await watch.maybeCheck();
  now.t += 3_600_000; await watch.maybeCheck();
  const bodies = await Promise.all((await fs.readdir(path.join(root, 'receipts'))).sort().map(async n => JSON.parse(await fs.readFile(path.join(root, 'receipts', n), 'utf8'))));
  const prunes = bodies.filter(b => b.type === PRUNE_RECEIPT);
  assert.equal(prunes.length, 3);
  assert.deepEqual(prunes.map(p => [p.body.spool, p.body.deletesAnything, p.body.refused]), [['windows', true, null], ['windows', true, null], ['windows', false, 'RETENTION_KEEP_LIST_INVALID']]);
  assert.deepEqual(prunes[0].body.deleted, deleted);
});

test('the default C: reminder: below 30 GiB once a day; unreadable drive cannot report a free-byte value', async t => {
  const root = await tempRoot(t);
  const now = { t: T0 };
  const receipts = await ReceiptChain.open(path.join(root, 'receipts'), () => now.t);
  let free = DISK_REMINDER_BYTES - 1;
  const watch = watchWith(receipts, now, { companionReady: async () => false, measureLinux: async () => ({ ok: false }), diskFree: async () => (free === null ? { ok: false } : { ok: true, freeBytes: free }) });
  assert.equal((await watch.maybeCheck()).disk.reminded, true);
  now.t += 3_600_000;
  assert.equal((await watch.maybeCheck()).disk.reminded, false, 'once per day');
  now.t += 86_400_000; free = null;
  assert.deepEqual((await watch.maybeCheck()).disk, { ok: false, reminded: false });
  now.t += 86_400_000; free = DISK_REMINDER_BYTES;
  assert.equal((await watch.maybeCheck()).disk.reminded, false);
  const bodies = await Promise.all((await fs.readdir(path.join(root, 'receipts'))).sort().map(async n => JSON.parse(await fs.readFile(path.join(root, 'receipts', n), 'utf8'))));
  const disk = bodies.filter(b => b.type === DISK_RECEIPT);
  assert.equal(disk.length, 1);
  assert.deepEqual(disk[0].body, { drive: 'C:', freeBytes: DISK_REMINDER_BYTES - 1, thresholdBytes: DISK_REMINDER_BYTES, action: 'owner-free-disk-space', blocksAnything: false });
  assert.equal(bodies.filter(b => b.type === REMINDER_RECEIPT).length, 0);
});

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\protected-job-bridge-v4\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });

test('archive-prune: one fixed root command; its facts travel through the mailbox in their exact shape', async t => {
  assert.deepEqual(argv(cfg).archivePrune().slice(-2), [cfg.linuxTool, 'archive-prune']);
  const prune = { rule: { classBudgetBytes: 1, minKeepPerClass: 10, maxDeletesPerPass: 16 }, refused: null,
    classes: { success: { directories: 12, bytes: 9, deleteDirectories: 1, deleteBytes: 4, refused: null }, failure: { directories: 1, bytes: 1, deleteDirectories: 0, deleteBytes: 0, refused: null } },
    protected: { directories: 0, bytes: 0, complete: true }, deferred: 0, deleted: [{ name: 'archive-aaaaaaaaaaaa-success-close-bbbbbbbbbbbb', class: 'success', bytes: 4 }], deletedBytes: 4, stopped: null };
  for (const [stdout, code, expect] of [
    [{ contract: 'clued.independent-ci.linux-archive-prune/1', prune, usage: { bytes: 5, directories: 12 } }, 0, { ok: true, code: null, prune, usage: { bytes: 5, directories: 12 } }],
    [{ contract: 'clued.independent-ci.linux-archive-prune/1', prune: { ...prune, refused: 'RETENTION_KEEP_LIST_UNREADABLE', classes: null, protected: null, deleted: [], deletedBytes: 0 }, usage: { bytes: 5, directories: 12 } }, 0,
      { ok: false, code: 'RETENTION_KEEP_LIST_UNREADABLE' }],
    [{ contract: 'clued.independent-ci.linux-archive-prune/1', prune: { ...prune, deletedBytes: 999 } }, 0, { ok: false, code: 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED', prune: null, usage: null }],
    [{ status: 'REFUSED', code: 'ROOT_REQUIRED' }, 1, { ok: false, code: 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED', prune: null, usage: null }],
  ]) {
    const root = await tempRoot(t);
    let now = T0;
    const mailbox = await Mailbox.open(root, () => now);
    const c = new Companion({ cfg, mailbox, run: async a => (a.includes('archive-prune') ? { code, stdout: JSON.stringify(stdout) } : { code: 0, stdout: '' }), fileExists: async () => true,
      sleep: async ms => { now += ms; }, clock: () => now });
    const port = mailboxCompanion(mailbox, async () => { await c.step(); });
    const r = await port.archivePrune();
    for (const [k, v] of Object.entries(expect)) assert.deepEqual(r[k], v, `${JSON.stringify(stdout).slice(0, 60)}: ${k}`);
  }
  assert.throws(() => validatePrune({ ...prune, deleted: Array.from({ length: 17 }, () => prune.deleted[0]), deletedBytes: 68 }), { code: 'MAILBOX_RESPONSE_PRUNE_REFUSED' });
});

test('service-main wires the heartbeat gate, the idle check, both prunes and the C: reminder', async () => {
  const text = await fs.readFile(new URL('../src/service-main.mjs', import.meta.url), 'utf8');
  for (const s of ['companionReady:', 'clock() - beat.at <= policy.companion.heartbeatMaxAgeMs', "reason: 'BATCH_OPEN'", "reason: 'HALTED'", "reason: 'SCENE_UNARCHIVED'",
    "reason: 'CHILD_RUNNING'", "readKeepList(path.join(root, 'owner', KEEP_FILE), 'windows')", 'pruneLinux: () => companion.archivePrune()', 'diskFreeBytes(drive)']) {
    assert.ok(text.includes(s), s);
  }
});
