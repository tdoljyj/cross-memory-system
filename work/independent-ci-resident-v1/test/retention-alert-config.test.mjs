import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RetentionWatch, RETENTION_RULE } from '../src/retention.mjs';
import { NotifyQueue, queueNotify } from '../src/notify-queue.mjs';
import { rawPolicy, tempRoot } from './helpers.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { SETTINGS_CONTRACT, parseRetentionSettings, readRetentionSettings } from '../src/retention-settings.mjs';
import { pruneSpool } from '../src/retention.mjs';
import { pruneArchivedGenerations } from '../src/generation-retention.mjs';
import { RetentionNotifier } from '../src/retention-notify.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { LocalStore } from '../src/pr-status.mjs';
import { main as generationTool } from '../tools/retention-generations.mjs';

const DAY = 86_400_000;
const START = Date.parse('2026-11-08T08:00:00Z');
const missing = () => ({ rule: RETENTION_RULE, refused: 'RETENTION_KEEP_LIST_UNREADABLE', classes: null, protected: null,
  deferred: 0, deleted: [], deletedBytes: 0, stopped: null });

test('unreadable keep lists below the size threshold reach the normal notification queue, once per spool/day', async t => {
  const root = await tempRoot(t), dir = path.join(root, 'notifications');
  let now = START;
  const rows = [], queue = new NotifyQueue({ dir, clock: () => now });
  const watch = new RetentionWatch({ policy: validatePolicy(rawPolicy()), clock: () => now,
    receipts: { append: async (type, body) => { rows.push({ type, body }); } }, notify: queueNotify(queue),
    companionReady: async () => true, idle: async () => ({ ok: true }),
    pruneWindows: async () => missing(), pruneLinux: async () => ({ ok: false, code: 'RETENTION_KEEP_LIST_UNREADABLE' }),
    measureWindows: async () => ({ bytes: 1, directories: 1, complete: true }),
    measureLinux: async () => ({ ok: true, bytes: 1, directories: 1 }),
  });
  assert.equal((await watch.maybeCheck()).reminded, false, 'archive size reminder is not the missing-list alert');
  assert.equal((await fs.readdir(dir)).length, 2, 'both spool refusals must notify the Owner');
  now += 3_600_000;
  await watch.maybeCheck();
  assert.equal((await fs.readdir(dir)).length, 2, 'same problem is bounded to once/day');
  now += DAY;
  await watch.maybeCheck();
  assert.equal((await fs.readdir(dir)).length, 4);
  const notices = await Promise.all((await fs.readdir(dir)).map(n => fs.readFile(path.join(dir, n), 'utf8').then(JSON.parse)));
  assert.ok(notices.every(n => n.body.includes('RETENTION_KEEP_LIST_UNREADABLE')));
  assert.ok(rows.filter(n => n.type === 'archive-retention-alert').every(n => n.body.deletesAnything === false));
});

test('real receipt chain reaches the normal queue through read-only companion and deduplicates after restart', async t => {
  const root = await tempRoot(t), dir = path.join(root, 'queue'), clock = () => START;
  const receipts = await ReceiptChain.open(path.join(root, 'receipts'), clock);
  await receipts.append('archive-retention-alert', { spool: 'windows', code: 'RETENTION_KEEP_LIST_UNREADABLE', deletesAnything: false });
  const storeFile = path.join(root, 'owner', 'notifications.json');
  const ports = { receipts: new ReceiptChain(path.join(root, 'receipts'), clock), clock,
    notify: queueNotify(new NotifyQueue({ dir, clock })) };
  await new RetentionNotifier({ ...ports, store: await LocalStore.open(storeFile, clock) }).step();
  await new RetentionNotifier({ ...ports, store: await LocalStore.open(storeFile, clock) }).step();
  assert.equal((await fs.readdir(dir)).length, 1);
  assert.equal((await receipts.latest(['archive-retention-alert'], 8)).length, 1, 'companion wrote no service receipt');
});

test('settings hold only the contract and the protected generations: numbers come from the standard; empty keep is no extra protection', async t => {
  const root = await tempRoot(t), file = path.join(root, 'settings.json');
  assert.deepEqual(await readRetentionSettings(file), { ok: true, settings: {} });
  const s = { contract: SETTINGS_CONTRACT, generations: { protected: ['g2-1'] } };
  assert.deepEqual(parseRetentionSettings(JSON.stringify(s)), s);
  for (const gone of [{ disk: { drives: ['C:'], thresholdBytes: 1 } }, { linux: { success: { classBudgetBytes: 0, minKeepPerClass: 1 } } }, { windows: {} },
    { emptyKeep: 'refuse' }, { generations: { enabled: true, keepNewest: 3, protected: [] } }, { generations: { protected: ['../x'] } }]) {
    assert.throws(() => parseRetentionSettings(JSON.stringify({ contract: SETTINGS_CONTRACT, ...gone })), /RETENTION_SETTINGS_INVALID/, JSON.stringify(gone));
  }
  await fs.writeFile(file, '{');
  assert.equal((await readRetentionSettings(file)).ok, false);
  const spool = path.join(root, 'spool'); await fs.mkdir(spool);
  const old = new Date(START - 40 * DAY);
  for (const name of ['archive-a', 'archive-b', 'archive-c', 'failed-a', 'failed-b']) {
    await fs.mkdir(path.join(spool, name)); await fs.writeFile(path.join(spool, name, 'data'), 'x'); await fs.utimes(path.join(spool, name), old, old);
  }
  const p = await pruneSpool({ spool, keep: { ok: true, entries: 0, names: new Set() }, rule: { ...RETENTION_RULE, minKeepPerClass: 1 }, now: START });
  assert.deepEqual(p.deleted.map(d => d.name).sort(), ['archive-a', 'archive-b', 'failed-a'], 'past 14/30 days, the newest of each class stays');
});

test('changed authorization stops real deletion before the first archive', async t => {
  const root = await tempRoot(t);
  for (const name of ['archive-a', 'archive-b']) {
    await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, 'x'), 'x');
  }
  const result = await pruneSpool({ spool: root, keep: { ok: true, names: new Set() },
    rule: { classBudgetBytes: 0, minKeepPerClass: 1, maxDeletesPerPass: 16 }, authorizeDelete: async () => false });
  assert.equal(result.stopped.code, 'RETENTION_SETTINGS_CHANGED'); assert.deepEqual(result.deleted, []);
  assert.equal((await fs.readdir(root)).length, 2);
});

test('archived generations retain three distinct newest generations and never touch live, rolled back or protected copies', async t => {
  const root = await tempRoot(t);
  for (const d of ['archive', 'upgrade/ops', 'generations/g1', 'live']) await fs.mkdir(path.join(root, d), { recursive: true });
  await fs.writeFile(path.join(root, 'upgrade/current.json'), JSON.stringify({ generation: 9 }));
  for (const name of ['g1', 'g1-1', 'g2', 'g3', 'g4', 'g4-1', 'g5', 'g1-rolled-back-op']) {
    await fs.mkdir(path.join(root, 'archive', name)); await fs.writeFile(path.join(root, 'archive', name, 'x'), 'x');
    await fs.writeFile(path.join(root, 'archive', name, 'generation.json'), JSON.stringify({ generation: Number(/^g([0-9]+)/.exec(name)[1]),
      packageManifestSha256: 'a'.repeat(64), filesSha256: 'b'.repeat(64), residentBinPath: 'resident', brokerBinPath: 'broker', companionTaskArguments: 'companion' }));
  }
  assert.equal((await pruneArchivedGenerations({ root })).code, 'RETENTION_GENERATIONS_MAINTENANCE_REQUIRED', 'Owner decision: enabled, three newest plus the current');
  const result = await pruneArchivedGenerations({ root, allowDelete: true, settings: { generations: { protected: ['g1-1'] } } });
  assert.deepEqual(result.deleted, ['g1', 'g2']);
  assert.deepEqual((await fs.readdir(path.join(root, 'archive'))).sort(), ['g1-1', 'g1-rolled-back-op', 'g3', 'g4', 'g4-1', 'g5']);
  assert.equal((await fs.stat(path.join(root, 'generations/g1'))).isDirectory(), true);
  await fs.mkdir(path.join(root, 'upgrade/ops/in-flight'));
  assert.equal((await pruneArchivedGenerations({ root })).code, 'RETENTION_GENERATIONS_BOUNDARY_UNCONFIRMED');
});

test('unconfirmed generation record or changed approval deletes no archived generation', async t => {
  const root = await tempRoot(t), settings = { generations: { protected: [] } };
  await fs.mkdir(path.join(root, 'upgrade/ops'), { recursive: true });
  await fs.writeFile(path.join(root, 'upgrade/current.json'), JSON.stringify({ generation: 9 }));
  for (let n = 1; n <= 4; n++) {
    await fs.mkdir(path.join(root, 'archive', `g${n}`), { recursive: true });
    if (n > 1) await fs.writeFile(path.join(root, 'archive', `g${n}`, 'generation.json'), JSON.stringify({ generation: n,
      packageManifestSha256: 'a'.repeat(64), filesSha256: 'b'.repeat(64), residentBinPath: 'r', brokerBinPath: 'b', companionTaskArguments: 'c' }));
  }
  assert.deepEqual((await pruneArchivedGenerations({ root, settings })).deleted, []);
  const file = path.join(root, 'archive/g1/generation.json');
  const record = { generation: 99, packageManifestSha256: 'a'.repeat(64), filesSha256: 'b'.repeat(64), residentBinPath: 'r', brokerBinPath: 'b', companionTaskArguments: 'c' };
  await fs.writeFile(file, JSON.stringify(record));
  assert.equal((await pruneArchivedGenerations({ root, settings })).code, 'RETENTION_GENERATIONS_RECORD_INVALID');
  record.generation = 1; await fs.writeFile(file, JSON.stringify(record));
  assert.equal((await pruneArchivedGenerations({ root, settings })).code, 'RETENTION_GENERATIONS_MAINTENANCE_REQUIRED');
  assert.deepEqual((await pruneArchivedGenerations({ root, settings, allowDelete: true, authorizeDelete: async () => false })).deleted, []);
  assert.equal((await fs.readdir(path.join(root, 'archive'))).length, 4);
  await fs.mkdir(path.join(root, 'owner'));
  const settingsFile = path.join(root, 'owner/retention-settings.json');
  await fs.writeFile(settingsFile, JSON.stringify({ contract: SETTINGS_CONTRACT, ...settings }));
  assert.equal((await generationTool(['--root', root])).code, 'RETENTION_GENERATIONS_MAINTENANCE_REQUIRED');
  assert.equal((await fs.readdir(path.join(root, 'archive'))).length, 4, 'default tool invocation never deletes');
  const applied = await generationTool(['--root', root, '--apply']);
  assert.deepEqual(applied.deleted, ['g1']);
  assert.equal(applied.code, null);
});

test('notifier passes alerts and size reminders and retries a failed queue write; disk receipts are no longer its business', async t => {
  const root = await tempRoot(t), clock = () => START, receipts = await ReceiptChain.open(path.join(root, 'receipts'), clock);
  await receipts.append('disk-space-reminder', { drive: 'D:', freeBytes: 2 * 1024 ** 3 });
  await receipts.append('archive-retention-reminder', { totalBytes: 60 * 1024 ** 3 });
  const store = await LocalStore.open(path.join(root, 'notifications.json'), clock), messages = [];
  let fail = true;
  const notifier = new RetentionNotifier({ receipts, store, clock, notify: async (key, title, body) => {
    if (fail) throw new Error('queue unavailable'); messages.push({ key, body });
  } });
  await assert.rejects(notifier.step()); assert.deepEqual(store.data.notified, {});
  fail = false; await notifier.step();
  assert.deepEqual(messages.map(m => m.key), ['retention:size']);
  assert.ok(messages[0].body.includes('60 GiB'));
});

test('bad settings stop both spool ports', async t => {
  let called = 0;
  const root = await tempRoot(t), receipts = await ReceiptChain.open(path.join(root, 'receipts'), () => START);
  const ports = { policy: validatePolicy(rawPolicy()), receipts, clock: () => START, companionReady: async () => true,
    idle: async () => ({ ok: true }), measureWindows: async () => ({ bytes: 0, directories: 0, complete: true }),
    measureLinux: async () => ({ ok: true, bytes: 0, directories: 0 }),
    pruneWindows: async () => { called++; return missing(); }, pruneLinux: async () => { called++; return { ok: false }; } };
  const invalid = new RetentionWatch({ ...ports, readSettings: async () => ({ ok: false, code: 'RETENTION_SETTINGS_INVALID' }) });
  assert.equal((await invalid.maybeCheck()).prune.skipped, 'RETENTION_SETTINGS_INVALID'); assert.equal(called, 0);
});
