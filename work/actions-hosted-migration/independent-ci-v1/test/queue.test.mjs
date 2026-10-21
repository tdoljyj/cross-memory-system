import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PersistentQueue, JOB_CONTRACT, jobId } from '../src/queue.mjs';

const digest = 'd'.repeat(64);
const at = value => new Date(value).toISOString();
const initialTime = Date.parse('2026-10-18T10:00:00Z');
function observation(now, values = {}) {
  return { repo: 'owner/repo', pr: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    claimId: '11111111-1111-1111-1111-111111111111', fence: 1, epoch: 1, sourceManifestSha256: digest,
    observedAt: at(now), claimExpiresAt: at(now + 300_000), admitted: true, open: true, mergeEligible: true, ...values };
}
function job(obs, role = 'unit') {
  const value = { contract: JOB_CONTRACT, id: '', ...Object.fromEntries(['repo', 'pr', 'headSha', 'baseSha', 'claimId', 'fence', 'epoch', 'sourceManifestSha256'].map(key => [key, obs[key]])),
    role, createdAt: obs.observedAt, attempt: 1 };
  value.id = jobId(value); return value;
}
async function fixture(t, limits = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-independent-queue-'));
  let now = initialTime;
  const queue = await PersistentQueue.open({ directory, limits, clock: () => now });
  t.after(async () => { await queue.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const obs = observation(now); await queue.observe(obs);
  return { directory, queue, obs, advance: ms => { now += ms; }, time: () => now };
}
const result = { conclusion: 'success', evidenceSha256: 'e'.repeat(64) };

test('real persistent queue deduplicates delivery, serializes claims and rejects candidate commands', async t => {
  const { queue, obs } = await fixture(t);
  const value = job(obs);
  await Promise.all(Array.from({ length: 8 }, () => queue.enqueue(value)));
  await assert.rejects(async () => queue.enqueue({ ...value, command: 'untrusted command' }), { code: 'invalid_job' });
  const claims = await Promise.all([queue.claim({ workerId: 'worker-a' }), queue.claim({ workerId: 'worker-b' })]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(Object.keys((await queue.snapshot()).jobs).length, 1);
  await assert.rejects(PersistentQueue.open({ directory: queue.directory }), { code: 'queue_locked' });
  await assert.rejects(PersistentQueue.open({ directory: queue.directory, recoverDeadOwner: true }), { code: 'queue_owner_alive' });
});

test('expired worker occupies capacity until stopped; old token cannot complete a retry', async t => {
  const { queue, obs, advance } = await fixture(t);
  await queue.enqueue(job(obs));
  const first = await queue.claim({ workerId: 'worker-a', leaseMs: 100 });
  advance(101); await queue.reconcileExpired();
  assert.equal((await queue.snapshot()).jobs[first.job.id].status, 'uncertain');
  assert.equal(await queue.claim({ workerId: 'worker-b' }), null);
  await assert.rejects(queue.complete({ id: first.job.id, token: first.lease.token, result }), { code: 'worker_lease_stale' });
  await queue.confirmStopped({ id: first.job.id, token: first.lease.token, evidenceSha256: digest });
  const second = await queue.claim({ workerId: 'worker-b' });
  assert.equal(second.job.attempt, 2); assert.notEqual(second.lease.token, first.lease.token);
  await assert.rejects(queue.heartbeat({ id: first.job.id, token: first.lease.token }), { code: 'worker_lease_stale' });
  await queue.complete({ id: second.job.id, token: second.lease.token, result });
});

for (const [field, value] of [['headSha', 'c'.repeat(40)], ['baseSha', 'c'.repeat(40)],
  ['claimId', '22222222-2222-2222-2222-222222222222'], ['fence', 2], ['epoch', 2], ['sourceManifestSha256', 'f'.repeat(64)]]) {
  test(`${field} change invalidates a real stored result and pending merge intent`, async t => {
    const { queue, obs } = await fixture(t);
    await queue.enqueue(job(obs)); const claimed = await queue.claim({ workerId: 'worker' });
    await queue.complete({ id: claimed.job.id, token: claimed.lease.token, result });
    const slot = await queue.acquireMergeSlot({ repo: obs.repo, pr: obs.pr, jobIds: [claimed.job.id] });
    await queue.appendIntent({ kind: 'merge', slotToken: slot.token });
    await queue.observe({ ...obs, [field]: value });
    const state = await queue.snapshot();
    assert.equal(state.jobs[claimed.job.id].status, 'invalidated');
    assert.equal(state.outbox[0].status, 'invalidated'); assert.equal(state.mergeSlot, null);
  });
}

test('heartbeat cannot outlive claim, observation TTL, capacity or attempt ceilings', async t => {
  const { queue, obs, advance, time } = await fixture(t, { maxJobs: 1, maxAttempts: 1 });
  await queue.enqueue(job(obs));
  await assert.rejects(queue.enqueue(job(obs, 'lint')), { code: 'job_limit' });
  const claimed = await queue.claim({ workerId: 'worker', leaseMs: 10 });
  advance(11); await queue.confirmStopped({ id: claimed.job.id, token: claimed.lease.token, evidenceSha256: digest });
  assert.equal((await queue.snapshot()).jobs[claimed.job.id].invalidReason, 'attempt_limit');
  await queue.observe({ ...obs, observedAt: at(time()), claimExpiresAt: at(time() + 10) });
  advance(11); await queue.reconcileExpired();
  assert.equal(await queue.claim({ workerId: 'worker' }), null);
});

test('merge reservation is exclusive across PRs and persisted through graceful restart', async t => {
  const { queue, obs, directory, time } = await fixture(t);
  const ids = [];
  for (const pr of [7, 8]) {
    const current = { ...obs, pr }; await queue.observe(current); await queue.enqueue(job(current));
    const claimed = await queue.claim({ workerId: 'worker' });
    await queue.complete({ id: claimed.job.id, token: claimed.lease.token, result }); ids.push(claimed.job.id);
  }
  const slot = await queue.acquireMergeSlot({ repo: obs.repo, pr: 7, jobIds: [ids[0]] });
  assert.equal(await queue.acquireMergeSlot({ repo: obs.repo, pr: 8, jobIds: [ids[1]] }), null);
  const intent = await queue.appendIntent({ kind: 'merge', slotToken: slot.token });
  await queue.close();
  const reopened = await PersistentQueue.open({ directory, clock: time });
  try {
    const state = await reopened.snapshot(); assert.equal(state.mergeSlot.token, slot.token); assert.equal(state.outbox[0].id, intent.id);
    assert.equal((await reopened.appendIntent({ kind: 'merge', slotToken: slot.token })).id, intent.id);
    assert.equal((await reopened.snapshot()).outbox.length, 1);
  } finally { await reopened.close(); }
});

test('torn final WAL append is discarded, while a corrupted acknowledged record blocks opening', async t => {
  const { queue, directory, time } = await fixture(t);
  await queue.close(); const filename = path.join(directory, 'journal.jsonl');
  await fs.appendFile(filename, '{"state":');
  const reopened = await PersistentQueue.open({ directory, clock: time });
  await reopened.close();
  assert.ok((await fs.readFile(filename, 'utf8')).endsWith('\n'));
  const text = await fs.readFile(filename, 'utf8');
  await fs.writeFile(filename, text.replace('owner/repo', 'other/repo'));
  await assert.rejects(PersistentQueue.open({ directory, clock: time }), { code: 'corrupt_queue_journal' });
});

test('clock regression, observation TTL and a full journal fail closed', async t => {
  const { queue, obs, advance } = await fixture(t);
  await queue.enqueue(job(obs)); advance(30_001);
  assert.equal(await queue.claim({ workerId: 'worker' }), null);
  advance(-30_002);
  await assert.rejects(queue.reconcileExpired(), { code: 'queue_clock_regressed' });
  const limitedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-independent-limit-'));
  const limited = await PersistentQueue.open({ directory: limitedDirectory, clock: () => initialTime, limits: { maxJournalBytes: 100 } });
  try {
    await assert.rejects(limited.observe(obs), { code: 'journal_limit' });
    assert.equal(Object.keys((await limited.snapshot()).observations).length, 0);
  } finally { await limited.close(); await fs.rm(limitedDirectory, { recursive: true, force: true }); }
});

test('killed real coordinator recovers its lock but never re-executes an orphaned lease', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-independent-crash-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/queue.mjs', import.meta.url).href;
  const obs = observation(initialTime), value = job(obs);
  const program = `import {PersistentQueue} from ${JSON.stringify(moduleUrl)};
    const q=await PersistentQueue.open({directory:process.argv[1],clock:()=>${initialTime}});
    await q.observe(${JSON.stringify(obs)});await q.enqueue(${JSON.stringify(value)});
    const lease=await q.claim({workerId:'orphan'});process.stdout.write(JSON.stringify(lease)+'\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, directory], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  for await (const chunk of child.stdout) { output += chunk; if (output.includes('\n')) break; }
  const lease = JSON.parse(output.trim()); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const reopened = await PersistentQueue.open({ directory, clock: () => initialTime + 1, recoverDeadOwner: true });
  try {
    assert.equal((await reopened.snapshot()).jobs[value.id].status, 'uncertain');
    assert.equal(await reopened.claim({ workerId: 'new-worker' }), null);
    await assert.rejects(reopened.complete({ id: value.id, token: lease.lease.token, result }), { code: 'worker_lease_stale' });
    await reopened.confirmStopped({ id: value.id, token: lease.lease.token, evidenceSha256: digest });
    assert.equal((await reopened.claim({ workerId: 'new-worker' })).job.attempt, 2);
  } finally { await reopened.close(); }
});
