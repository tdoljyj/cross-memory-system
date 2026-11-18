import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, digest, parseBoundedJson } from '../src/canonical.mjs';
import { Ledger, batchKey, headKey } from '../src/ledger.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { applyArchive, planArchive, protocolLeaves } from '../src/archive.mjs';
import { TRIGGER_CONTRACT_V2, parseTrigger } from '../src/trigger.mjs';
import { archiveReason, classifyFailure } from '../src/classify.mjs';
import { batchBudgetMs, validatePolicy } from '../src/policy.mjs';
import { nodeProfileSha256, pinnedNodeProfile } from '../src/node-profile.mjs';
import { readFileSync } from 'node:fs';
import { BASE, CLEAN_PROOF, HEAD, RELAY_OFF, SOURCE, TEST_NODE, TEST_NODE_SHA, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });

test('canonical JSON is key-order independent and refuses non-plain values', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: NaN }), { code: 'NON_FINITE_NUMBER_REFUSED' });
  assert.throws(() => canonicalJson({ a: new Date() }), { code: 'PLAIN_OBJECT_REQUIRED' });
  assert.throws(() => parseBoundedJson(Buffer.from('[1]'), 64), { code: 'UNTRUSTED_JSON_REFUSED' });
  assert.throws(() => parseBoundedJson(Buffer.from('{"a":1}'), 3), { code: 'UNTRUSTED_JSON_REFUSED' });
  assert.throws(() => parseBoundedJson(Buffer.from([0x7b, 0xff, 0x7d]), 64), { code: 'UNTRUSTED_JSON_REFUSED' });
});

test('batch key binds exact content, Source and attempt; claim is not part of it', () => {
  const k = batchKey(subject());
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.notEqual(k, batchKey(subject({ headSha: '3'.repeat(40) })));
  assert.notEqual(k, batchKey(subject({ baseSha: '3'.repeat(40) })));
  assert.notEqual(k, batchKey(subject({ sourceManifestSha256: 'e'.repeat(64) })));
  assert.notEqual(k, batchKey(subject({ attempt: 2 })));
  assert.throws(() => batchKey(subject({ attempt: 0 })), { code: 'BATCH_KEY_ATTEMPT_INVALID' });
  assert.throws(() => batchKey(subject({ headSha: 'A'.repeat(40) })), { code: 'BATCH_KEY_COMMIT_INVALID' });
});

test('ledger reserves a key once, burns it after start, and never reopens a terminal entry', async t => {
  const root = await tempRoot(t);
  const ledger = await Ledger.open(root, () => Date.parse('2026-10-20T00:00:00Z'));
  const k = batchKey(subject());
  await ledger.reserve(k, subject());
  await assert.rejects(ledger.reserve(k, subject()), { code: 'BATCH_KEY_ALREADY_USED_NO_RETRY' });
  await ledger.markStarted(k, {});
  await assert.rejects(ledger.markStarted(k, {}), { code: 'BATCH_START_REQUIRES_RESERVATION' });
  await assert.rejects(ledger.releaseUnexecuted(k, 'NOT_ADMITTED', {}), { code: 'RELEASE_REQUIRES_UNSTARTED_ENTRY' });
  await ledger.terminal(k, 'FAILED_CLEAN', {});
  await assert.rejects(ledger.terminal(k, 'COMPLETED', {}), { code: 'BATCH_TERMINAL_REQUIRES_OPEN_ENTRY' });
  await assert.rejects(ledger.reserve(k, subject()), { code: 'BATCH_KEY_ALREADY_USED_NO_RETRY' });
  assert.equal((await ledger.state(k)).outcome, 'FAILED_CLEAN');
  // Terminal records are create-only: a second write is refused, the first bytes survive.
  await assert.rejects(fs.writeFile(path.join(root, 'ledger', k, '90-terminal.json'), 'x', { flag: 'wx' }), { code: 'EEXIST' });
});

test('an unexecuted reservation is moved, not deleted, and can be reserved again', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-20T00:00:00Z');
  const ledger = await Ledger.open(root, () => now);
  const k = batchKey(subject());
  await ledger.reserve(k, subject());
  const moved = await ledger.releaseUnexecuted(k, 'NOT_ADMITTED', { failureCode: 'NATIVE_NOT_ADMITTED' });
  assert.equal((await ledger.state(k)).state, 'ABSENT');
  assert.equal(JSON.parse(await fs.readFile(path.join(moved, '90-terminal.json'), 'utf8')).outcome, 'NOT_EXECUTED');
  assert.deepEqual(await ledger.unexecutedSince(k, now - 1), [now]);
  now += 1000;
  await ledger.reserve(k, subject());
  assert.equal(await ledger.evaluationsSince(0), 2);
  assert.equal(await ledger.startedSince(0), 0);
  await assert.rejects(ledger.releaseUnexecuted(k, 'SOMETHING', {}), { code: 'UNEXECUTED_REASON_INVALID' });
});

test('the head key ignores base, PR and claim; markStarted burns the head; an incomplete entry stays open', async t => {
  const root = await tempRoot(t);
  const ledger = await Ledger.open(root, () => Date.parse('2026-10-20T00:00:00Z'));
  assert.equal(headKey(subject()), headKey(subject({ baseSha: '3'.repeat(40), pr: 999 })));
  assert.notEqual(headKey(subject()), headKey(subject({ attempt: 2 })));
  const k1 = batchKey(subject());
  const k2 = batchKey(subject({ baseSha: '3'.repeat(40) }));
  await ledger.reserve(k1, subject());
  await ledger.markStarted(k1, {});
  await ledger.reserve(k2, subject({ baseSha: '3'.repeat(40) }));
  await assert.rejects(ledger.markStarted(k2, {}), { code: 'BATCH_HEAD_ALREADY_EXECUTED_NO_RETRY' });
  assert.equal(await ledger.startedSince(0), 1);
  const k3 = batchKey(subject({ pr: 3, headSha: '6'.repeat(40) }));
  await fs.mkdir(path.join(root, 'ledger', k3));
  assert.equal((await ledger.state(k3)).state, 'INCOMPLETE');
  assert.ok((await ledger.open()).some(e => e.key === k3));
  await ledger.terminal(k3, 'FAILED_UNKNOWN', {});
  assert.equal((await ledger.state(k3)).outcome, 'FAILED_UNKNOWN');
});

test('HALT latches once and clears only by compare-and-swap on the reviewed bytes, keeping the record', async t => {
  const root = await tempRoot(t);
  const ledger = await Ledger.open(root, () => Date.parse('2026-10-20T00:00:00Z'));
  assert.equal(await ledger.halt('FORMAL_BRIDGE_STAGE_DEADLINE', { k: 1 }), true);
  assert.equal(await ledger.halt('OTHER', {}), false);
  const h = await ledger.halted();
  assert.equal(h.value.code, 'FORMAL_BRIDGE_STAGE_DEADLINE');
  await assert.rejects(ledger.clearHalt('0'.repeat(64), {}), { code: 'HALT_CHANGED_SINCE_REVIEW' });
  const archived = await ledger.clearHalt(h.sha256, { by: 'owner-uac' });
  assert.equal(await ledger.halted(), null);
  assert.equal(JSON.parse(await fs.readFile(archived, 'utf8')).code, 'FORMAL_BRIDGE_STAGE_DEADLINE');
  // Re-arm is refused while a batch is open.
  await ledger.halt('X_Y', {});
  const k = batchKey(subject());
  await ledger.reserve(k, subject());
  await assert.rejects(ledger.clearHalt((await ledger.halted()).sha256, {}), { code: 'REARM_REQUIRES_NO_OPEN_BATCH' });
});

test('receipt chain detects edits, gaps and foreign files', async t => {
  const root = await tempRoot(t);
  const dir = path.join(root, 'receipts');
  const chain = await ReceiptChain.open(dir, () => 0);
  await chain.append('batch-reserved', { key: 'k' });
  await chain.append('batch-terminal', { key: 'k', failureCode: 'FORMAL_BRIDGE_STAGE_DEADLINE' });
  await assert.rejects(chain.append('x', { failureCode: 'lower case' }), { code: 'RECEIPT_FAILURE_CODE_INVALID' });
  assert.equal((await chain.verify()).seq, 2);
  const first = path.join(dir, '00000001-batch-reserved.json');
  const original = await fs.readFile(first);
  await fs.writeFile(first, original.toString().replace('"k"', '"z"'));
  await assert.rejects(chain.verify(), { code: 'RECEIPT_CHAIN_BROKEN' });
  await fs.writeFile(first, original);
  assert.equal((await chain.verify()).seq, 2);
  await fs.rename(first, path.join(dir, '00000003-batch-reserved.json'));
  await assert.rejects(chain.verify(), { code: 'RECEIPT_SEQUENCE_GAP' });
  await fs.rename(path.join(dir, '00000003-batch-reserved.json'), first);
  await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
  await assert.rejects(chain.verify(), { code: 'RECEIPT_NAME_UNEXPECTED' });
});

test('protocol archive moves only allow-listed records, keeps bytes and effect journals, deletes nothing', async t => {
  const root = await tempRoot(t);
  const spool = path.join(root, 'formal-spool');
  await fs.mkdir(path.join(spool, 'incoming'), { recursive: true });
  await fs.mkdir(path.join(spool, 'outgoing'), { recursive: true });
  await fs.mkdir(path.join(spool, 'failed-old-history-source-3eb5ae18959b'), { recursive: true });
  await fs.writeFile(path.join(spool, 'incoming', 'result.json'), '{"r":1}');
  await fs.writeFile(path.join(spool, 'incoming', 'result.ready.json'), '{"ready":1}');
  // bridge v4: the Linux worker's clean 'blocked' record is a protocol record too (left behind on 2026-10-21)
  await fs.writeFile(path.join(spool, 'incoming', 'blocked.json'), '{"b":1}');
  await fs.writeFile(path.join(spool, 'incoming', 'blocked.ready.json'), '{"ready":1}');
  await fs.writeFile(path.join(spool, 'outgoing', 'active.lock'), '{"pid":1}');
  const journal = path.join(spool, 'outgoing', `${'9'.repeat(64)}.json`);
  await fs.writeFile(journal, '{"state":"settled"}');
  await fs.writeFile(path.join(spool, 'outgoing', 'observations.jsonl'), '{}\n');
  await fs.writeFile(path.join(spool, 'failed-old-history-source-3eb5ae18959b', 'kept.json'), 'old evidence');
  const leaves = await protocolLeaves(spool);
  assert.deepEqual(leaves.map(l => l.path), ['incoming/result.json', 'incoming/result.ready.json', 'incoming/blocked.json', 'incoming/blocked.ready.json', 'outgoing/active.lock']);
  const key = 'f'.repeat(64);
  assert.throws(() => planArchive({ spoolRoot: spool, batchKey: key, reason: 'x', leaves, quiescence: { proven: false } }), { code: 'ARCHIVE_REQUIRES_QUIESCENCE_PROOF' });
  assert.throws(() => planArchive({ spoolRoot: spool, batchKey: key, reason: '../x', leaves, quiescence: { proven: true, basis: 'b' } }), { code: 'ARCHIVE_REASON_INVALID' });
  const plan = planArchive({ spoolRoot: spool, batchKey: key, reason: 'formal-bridge-stage-deadline', leaves, quiescence: { proven: true, basis: 'units inactive, cgroups unpopulated, containers exited' } });
  assert.ok(plan.directory.startsWith('failed-'));
  const result = await applyArchive(plan);
  assert.deepEqual([result.moved, result.deleted], [5, 0]);
  assert.deepEqual(await protocolLeaves(spool), []);
  assert.equal(await fs.readFile(path.join(spool, plan.directory, 'incoming', 'result.json'), 'utf8'), '{"r":1}');
  assert.equal(await fs.readFile(journal, 'utf8'), '{"state":"settled"}', 'effect journals stay for exactly-once across batches');
  assert.equal(await fs.readFile(path.join(spool, 'failed-old-history-source-3eb5ae18959b', 'kept.json'), 'utf8'), 'old evidence');
  assert.ok(planArchive({ spoolRoot: spool, batchKey: key, reason: 'success-close', leaves: [], quiescence: { proven: true, basis: 'b' } }).directory.startsWith('archive-'));
  assert.ok(planArchive({ spoolRoot: spool, batchKey: key, reason: 'between-roles-archive-unconfirmed', leaves: [], quiescence: { proven: true, basis: 'b' } }).directory.startsWith('failed-'), 'only the exact between-roles-4/6 reasons are not failures');
});

test('planted junctions, hard links and a redirected parent are never followed or moved (review X1)', async t => {
  const root = await tempRoot(t);
  const spool = path.join(root, 'formal-spool');
  const victim = path.join(root, 'state-ledger');
  await fs.mkdir(path.join(spool, 'incoming'), { recursive: true });
  await fs.mkdir(path.join(spool, 'outgoing'), { recursive: true });
  await fs.mkdir(victim);
  await fs.writeFile(path.join(victim, '00-reserved.json'), 'ledger evidence');
  await fs.symlink(victim, path.join(spool, 'incoming', 'd'), 'junction');
  assert.deepEqual(await protocolLeaves(spool), [], 'a junction under incoming/ is not in the allow-list');
  await fs.link(path.join(victim, '00-reserved.json'), path.join(spool, 'incoming', 'result.json'));
  await assert.rejects(protocolLeaves(spool), { code: 'SPOOL_LEAF_MULTI_LINK_REFUSED' });
  await fs.rm(path.join(spool, 'incoming', 'result.json'));
  await fs.rm(path.join(spool, 'outgoing'), { recursive: true });
  await fs.symlink(victim, path.join(spool, 'outgoing'), 'junction');
  await assert.rejects(protocolLeaves(spool), { code: 'SPOOL_PARENT_NOT_A_REAL_DIRECTORY' });
  assert.equal(await fs.readFile(path.join(victim, '00-reserved.json'), 'utf8'), 'ledger evidence');
});

test('archive stops when a leaf changed after inventory', async t => {
  const root = await tempRoot(t);
  const spool = path.join(root, 's');
  await fs.mkdir(path.join(spool, 'incoming'), { recursive: true });
  await fs.writeFile(path.join(spool, 'incoming', 'result.json'), 'a');
  const plan = planArchive({ spoolRoot: spool, batchKey: 'e'.repeat(64), reason: 'x', leaves: await protocolLeaves(spool), quiescence: { proven: true, basis: 'b' } });
  await fs.writeFile(path.join(spool, 'incoming', 'result.json'), 'b');
  await assert.rejects(applyArchive(plan), { code: 'ARCHIVE_LEAF_CHANGED_BEFORE_MOVE' });
  assert.equal(await fs.readFile(path.join(spool, 'incoming', 'result.json'), 'utf8'), 'b');
});

test('trigger accepts only the exact data shape for the policy repository', () => {
  const policy = validatePolicy(rawPolicy());
  assert.deepEqual(parseTrigger(triggerBytes(), policy), { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, prUpdatedAt: null });
  // contract /2 (phase 2): an optional prUpdatedAt, exact ISO time; /1 never carries it
  assert.equal(parseTrigger(triggerBytes({ contract: TRIGGER_CONTRACT_V2, prUpdatedAt: '2026-10-22T13:00:00Z' }), policy).prUpdatedAt, '2026-10-22T13:00:00Z');
  assert.equal(parseTrigger(triggerBytes({ contract: TRIGGER_CONTRACT_V2 }), policy).prUpdatedAt, null);
  assert.throws(() => parseTrigger(triggerBytes({ prUpdatedAt: '2026-10-22T13:00:00Z' }), policy), { code: 'TRIGGER_KEYS_REFUSED' });
  assert.throws(() => parseTrigger(triggerBytes({ contract: TRIGGER_CONTRACT_V2, prUpdatedAt: 'yesterday' }), policy), { code: 'TRIGGER_UPDATED_AT_REFUSED' });
  assert.throws(() => parseTrigger(triggerBytes({ repo: 'evil/repo' }), policy), { code: 'TRIGGER_REPO_NOT_POLICY_REPO' });
  assert.throws(() => parseTrigger(triggerBytes({ command: 'calc.exe' }), policy), { code: 'TRIGGER_KEYS_REFUSED' });
  assert.throws(() => parseTrigger(triggerBytes({ headSha: 'HEAD' }), policy), { code: 'TRIGGER_HEAD_REFUSED' });
  assert.throws(() => parseTrigger(triggerBytes({ pr: -1 }), policy), { code: 'TRIGGER_PR_REFUSED' });
  assert.throws(() => parseTrigger(Buffer.alloc(2048, 32), policy), { code: 'TRIGGER_REFUSED' });
});

test('classification is an allow-list and needs the complete cleanup proof', () => {
  assert.equal(classifyFailure('NATIVE_NOT_ADMITTED', { windowsTreeZero: true, serviceOriginalStopped: true }, 1).klass, 'NOT_ADMITTED');
  assert.equal(classifyFailure('NATIVE_NOT_ADMITTED', { windowsTreeZero: true }, 1).klass, 'UNKNOWN');
  assert.equal(classifyFailure('NATIVE_NOT_ADMITTED', {}, 3).klass, 'UNKNOWN');
  assert.equal(classifyFailure('NATIVE_NOT_ADMITTED', CLEAN_PROOF, 3).klass, 'CLEAN');
  assert.equal(classifyFailure('FORMAL_BRIDGE_STAGE_DEADLINE', CLEAN_PROOF, 2).klass, 'CLEAN');
  assert.equal(classifyFailure('FORMAL_BRIDGE_STAGE_DEADLINE', { ...CLEAN_PROOF, containersZero: false }, 2).klass, 'UNKNOWN');
  assert.equal(classifyFailure('UNKNOWN_WORKER_CLEANUP_LOCKS_RETAINED_NO_RETRY', CLEAN_PROOF, 2).klass, 'UNKNOWN');
  assert.equal(classifyFailure('SOMETHING_NEW', CLEAN_PROOF, 2).klass, 'UNKNOWN');
  assert.equal(classifyFailure('not a code', CLEAN_PROOF, 2).klass, 'UNKNOWN');
  assert.equal(archiveReason('FORMAL_BRIDGE_STAGE_DEADLINE'), 'formal-bridge-stage-deadline');
});

test('policy refuses general retries, concurrency and drifted shapes; attempt 2 and retention are bounded', () => {
  const p = validatePolicy(rawPolicy());
  assert.equal(p.stages.length, 10, 'eight formal stages, the reserved stage 9 (the removed stage R) and stage 10 (train maintenance, never in a batch)');
  assert.equal(batchBudgetMs(p), [900000, 2700000, 900000, 1800000, 900000, 600000, 900000, 2700000].reduce((a, b) => a + b, 0) + 8 * 180000, 'no wait, no stage R');
  assert.equal(batchBudgetMs(validatePolicy(rawPolicy({ relay: { ...RELAY_OFF, enabled: true } }))), batchBudgetMs(p), 'a legacy relay block is never budgeted (DESIGN §76)');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(new URL('../config/policy.example.json', import.meta.url), 'utf8')), 'relay'), false, 'the example has no relay block');
  validatePolicy(JSON.parse(readFileSync(new URL('../config/policy.example.json', import.meta.url), 'utf8')));
  assert.throws(() => validatePolicy(rawPolicy({ stageRunMilliseconds: rawPolicy().stageRunMilliseconds.slice(0, 9) })), { code: 'POLICY_STAGE_TIMES_INVALID' });
  assert.throws(() => validatePolicy(rawPolicy({ automaticRetryAllowed: true })), { code: 'POLICY_KEYS_INVALID' });
  assert.throws(() => validatePolicy(rawPolicy({ automaticAttempt2: { enabled: true, delayMs: 1000 } })), { code: 'POLICY_ATTEMPT2_INVALID' });
  assert.throws(() => validatePolicy(rawPolicy({ automaticAttempt2: { enabled: true, delayMs: 600_000, maxAttempts: 3 } })), { code: 'POLICY_ATTEMPT2_KEYS_INVALID' });
  assert.throws(() => validatePolicy(rawPolicy({ retention: { reminderBytes: 1, checkEveryMs: 3_600_000 } })), { code: 'POLICY_RETENTION_INVALID' });
  assert.throws(() => validatePolicy(rawPolicy({ ciSourceManifestSha256: 'x' })), { code: 'POLICY_SOURCE_PIN_INVALID' });
  assert.throws(() => validatePolicy(rawPolicy({ limits: { ...rawPolicy().limits, maxConcurrent: 2 } })), { code: 'POLICY_SERIAL_EXECUTION_REQUIRED' });
  assert.throws(() => validatePolicy(rawPolicy({ baseBranch: 'dev' })), { code: 'POLICY_BASE_BRANCH_FIXED_MAIN' });
  assert.throws(() => validatePolicy({ ...rawPolicy(), extra: 1 }), { code: 'POLICY_KEYS_INVALID' });
});

test('ledger usage (phase 2): every daily budget from the ledger, per origin and ending', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-22T12:00:00Z');
  const ledger = await Ledger.open(root, () => now);
  const s = (pr, n, o = {}) => subject({ pr, headSha: String(n).repeat(40), ...o });
  // an execution
  await ledger.reserve(batchKey(s(1, 1)), s(1, 1));
  await ledger.markStarted(batchKey(s(1, 1)), { batchId: '0123456789abcdef-0123456789ab' });
  await ledger.terminal(batchKey(s(1, 1)), 'COMPLETED', {});
  // a real refusal (an evaluation), a wait from a waiting retry (its own budget), an environment release while the breaker
  // was open (neither), a supersession (neither), a new-trigger re-evaluation (an evaluation and one re-evaluation)
  const release = async (subj, origin, reason, facts) => { const k = batchKey(subj); await ledger.reserve(k, subj, { origin }); await ledger.releaseUnexecuted(k, reason, facts); };
  await release(s(2, 2), 'queued', 'NOT_ADMITTED', { class: 'not-admitted' });
  await release(s(3, 3), 'waiting-retry', 'NOT_ADMITTED', { class: 'waiting' });
  await release(s(4, 4), 'queued', 'BROKER_NOT_LAUNCHED', { class: 'environment', breakerState: 'open' });
  await release(s(4, 4, { baseSha: '9'.repeat(40) }), 'queued', 'BROKER_NOT_LAUNCHED', { class: 'environment', breakerState: 'closed' });
  await release(s(5, 5), 'queued', 'SUPERSEDED', { class: 'superseded' });
  await release(s(2, 2, { baseSha: '8'.repeat(40) }), 'new-trigger', 'NOT_ADMITTED', { class: 'not-admitted' });
  const u = await ledger.usage(0);
  assert.deepEqual([u.started, u.startedByPr.get(1), u.evaluations, u.waitingRetries], [1, 1, 2, 1]);
  assert.deepEqual([u.reevaluations.get(`2:${'2'.repeat(40)}`), u.releasesByHead.get('2'.repeat(40)), u.releasesByHead.get('3'.repeat(40)), u.releasesByHead.get('4'.repeat(40)), u.releasesByHead.get('5'.repeat(40))],
    [1, undefined, undefined, 1, undefined]);
  // generation 10 (DESIGN 53.3): a network release (facts.network) counts in networkReleasesByHead, whatever the breaker, and only when
  // the caller separates them (a /9 policy); otherwise it counts as before
  await release(s(7, 7), 'queued', 'BUNDLE_UNAVAILABLE', { class: 'environment', breakerState: 'closed', network: true });
  await release(s(7, 7, { baseSha: '6'.repeat(40) }), 'queued', 'BUNDLE_UNAVAILABLE', { class: 'environment', breakerState: 'open', network: true });
  const sep = await ledger.usage(0, { separateNetwork: true }), old = await ledger.usage(0);
  assert.deepEqual([sep.networkReleasesByHead.get('7'.repeat(40)), sep.releasesByHead.get('7'.repeat(40)), sep.releasesByHead.get('4'.repeat(40))], [2, undefined, 1]);
  assert.deepEqual([old.networkReleasesByHead.get('7'.repeat(40)), old.releasesByHead.get('7'.repeat(40))], [undefined, 1], 'without /9: the old rule (open breaker: not counted)');
  assert.equal(sep.evaluations, old.evaluations, 'a network release is no evaluation either way');
  await assert.rejects(ledger.reserve(batchKey(s(6, 6)), s(6, 6), { origin: 'made-up' }), { code: 'RESERVATION_ORIGIN_INVALID' });
  now += 86_400_001;
  assert.equal((await ledger.usage(now - 86_400_000)).evaluations, 0, 'a day later nothing counts');
});

test('PR daily cap: only a terminal verdict counts, including after reopening and across the rolling window', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-22T12:00:00Z');
  const ledger = await Ledger.open(root, () => now);
  const s = subject(), key = batchKey(s);
  await ledger.reserve(key, s);
  await ledger.markStarted(key, { batchId: '0123456789abcdef-0123456789ab' });
  const running = await ledger.usage(0, { budgetTimes: true });
  assert.equal(running.startedByPr.size, 0, 'running or parked is not a PR verdict');
  assert.equal(running.budgetTimes.has(`pr:${s.pr}`), false);
  const startedAt = now;
  now += 1_000;
  await ledger.terminal(key, 'COMPLETED', {});
  const reopened = await Ledger.open(root, () => now);
  const completed = await reopened.usage(0, { budgetTimes: true });
  assert.equal(completed.startedByPr.get(s.pr), 1, 'derived from durable terminal evidence');
  assert.deepEqual(completed.budgetTimes.get(`pr:${s.pr}`), [startedAt], 'the notice expires from the same window as the charge');
  now += 86_400_001;
  assert.equal((await reopened.usage(now - 86_400_000)).startedByPr.size, 0);
  const released = subject({ headSha: '9'.repeat(40) }), rk = batchKey(released);
  await reopened.reserve(rk, released);
  await reopened.releaseUnexecuted(rk, 'NOT_ADMITTED', { failureCode: 'CLAIM_NOT_CURRENT', class: 'not-admitted' });
  assert.equal((await reopened.usage(now - 86_400_000)).startedByPr.size, 0, 'unexecuted history is not a verdict');
  const damaged = subject({ headSha: '8'.repeat(40) }), dk = batchKey(damaged);
  await reopened.reserve(dk, damaged);
  await reopened.markStarted(dk, { batchId: '0123456789abcdef-0123456789ab' });
  await reopened.terminal(dk, 'COMPLETED', {});
  await fs.writeFile(path.join(reopened.dir(dk), '10-started.json'), '{');
  const u = await reopened.usage(now - 86_400_000);
  assert.deepEqual([u.started, u.evaluations, u.startedByPr.size], [1, 0, 0], 'unreadable verdict evidence preserves the existing global budgets');
});

test('G4: reopening the ledger reclassifies old claim releases once, without exempting burned failures', async t => {
  const root = await tempRoot(t);
  const ledger = await Ledger.open(root);
  for (const [i, origin] of ['queued', 'backoff-retry', 'new-trigger', 'waiting-retry'].entries()) {
    const s = subject({ pr: i + 1, headSha: String(i + 1).repeat(40) });
    await ledger.reserve(batchKey(s), s, { origin });
    await ledger.releaseUnexecuted(batchKey(s), 'NOT_ADMITTED', { class: 'not-admitted', failureCode: 'CLAIM_NOT_CURRENT' });
  }
  const s = subject({ pr: 5, headSha: '5'.repeat(40) });
  await ledger.reserve(batchKey(s), s);
  await ledger.burnHead(batchKey(s), { failureCode: 'CLAIM_NOT_CURRENT', quotaTier: 'evaluation' });
  await ledger.terminal(batchKey(s), 'FAILED_CLEAN', { class: 'not-admitted', failureCode: 'CLAIM_NOT_CURRENT' });
  const reopened = await Ledger.open(root);
  const u = await reopened.usage(0);
  assert.deepEqual([u.evaluations, u.waitingRetries, u.lowRiskBurns, u.started, u.releasesByHead.size], [1, 4, 1, 0, 0]);
  assert.equal(u.reevaluations.get(`3:${'3'.repeat(40)}`), 1, 'new-trigger cap is preserved');
  assert.deepEqual(await reopened.usage(0), u, 're-reading usage never double counts');
});

test('policy pins a complete immutable node and cross-binds Owner and WSL without changing quota or train authority', () => {
  const p = validatePolicy(rawPolicy());
  assert.equal(nodeProfileSha256(p.node), p.nodeProfileSha256);
  assert.equal(p.nodeProfileSha256, TEST_NODE_SHA);
  assert.ok(Object.isFrozen(p.node));
  const input = { ...TEST_NODE }; const pinned = pinnedNodeProfile(input, TEST_NODE_SHA);
  input.hostname = 'OTHER'; assert.equal(pinned.hostname, TEST_NODE.hostname);
  assert.throws(() => validatePolicy(rawPolicy({ nodeProfileSha256: '0'.repeat(64) })), { code: 'NODE_PROFILE_PIN_CHANGED' });
  assert.throws(() => validatePolicy(rawPolicy({ node: { ...TEST_NODE, extra: true } })), { code: 'NODE_PROFILE_FIELDS_REQUIRED' });
  assert.throws(() => validatePolicy(rawPolicy({ companion: { ...p.companion, userSid: 'S-1-5-21-4-5-6-1001' } })), { code: 'POLICY_COMPANION_SID_INVALID' });
  assert.throws(() => validatePolicy(rawPolicy({ linux: { ...p.linux, distribution: 'OTHER' } })), { code: 'POLICY_DISTRIBUTION_FIXED' });
  const company = { ...TEST_NODE, nodeName: 'company-01', hostname: 'COMPANY-01', ownerSid: 'S-1-5-21-4-5-6-1001', controllerSid: 'S-1-5-21-4-5-6-1015',
    mutationMutex: 'Global\\CluedControlControllerMutationV1-COMPANY-01-1015', ownerProfileDirectory: 'C:\\Users\\company-owner', wslDistribution: 'Company-Ubuntu' };
  const q = validatePolicy(rawPolicy({ node: company, nodeProfileSha256: nodeProfileSha256(company), companion: { ...p.companion, userSid: company.ownerSid }, linux: { ...p.linux, distribution: company.wslDistribution } }));
  assert.equal(q.node.hostname, 'COMPANY-01');
  assert.deepEqual(q.limits, p.limits); assert.deepEqual(q.train, p.train); assert.deepEqual(q.stageRunMilliseconds, p.stageRunMilliseconds);
});
