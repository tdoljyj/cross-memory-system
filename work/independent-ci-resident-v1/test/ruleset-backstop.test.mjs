// The companion's ruleset backstop (quota redesign phase 2, step 3c-1; design v0.5 §6; DESIGN §22.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { APP_ID, BACKSTOP_KINDS, PAUSE_CONTRACT, REQUIRED_CHECK_NAMES, SWEEP_GRACE_MS, backstopDecision, backstopPass, backstopText, dutyOf, rulesFacts, writePauseRequest } from '../src/ruleset-backstop.mjs';
import { PAUSE_CONTRACT as EXECUTOR_PAUSE } from '../src/executor.mjs';
import { Inbox } from '../src/inbox.mjs';
import { REQUIRED_CHECK_NAMES as SOURCE_CHECKS } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-rules.mjs';
import { APP_ID as SOURCE_APP } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/publisher.mjs';

const rules = ({ strict = true, pinned = APP_ID, names = REQUIRED_CHECK_NAMES } = {}) => [{ type: 'deletion' },
  { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: strict, required_status_checks: names.map(context => ({ context, integration_id: pinned })) } }];

test('the backstop names the same checks, App and pause contract as Source v2 and the executor', () => {
  assert.deepEqual([...REQUIRED_CHECK_NAMES], [...SOURCE_CHECKS]);
  assert.equal(APP_ID, SOURCE_APP);
  assert.equal(PAUSE_CONTRACT, EXECUTOR_PAUSE);
  assert.ok(BACKSTOP_KINDS.every(k => typeof backstopText(k) === 'string'));
});

test('strict off without the train pauses and notifies; an unpinned or disabled ruleset only notifies; unreadable does nothing', () => {
  assert.deepEqual(backstopDecision({ facts: rulesFacts(rules()), trainMode: 'shadow' }), { pause: false, notify: null });
  for (const mode of ['off', 'shadow', null]) assert.deepEqual(backstopDecision({ facts: rulesFacts(rules({ strict: false })), trainMode: mode }), { pause: true, notify: 'STRICT_OFF_WITHOUT_TRAIN' }, String(mode));
  // step 3c-2b (DESIGN §41.7): on is enough only with a full sweep completed since this node became eligible
  assert.deepEqual(backstopDecision({ facts: rulesFacts(rules({ strict: false })), trainMode: 'on', sweep: { fullSinceOn: true } }), { pause: false, notify: null });
  const now = Date.parse('2026-11-02T00:00:00Z'), old = { onDuty: true, onSince: now - SWEEP_GRACE_MS };
  for (const sweep of [undefined, null, { fullSinceOn: false }])
    assert.deepEqual(backstopDecision({ facts: rulesFacts(rules({ strict: false })), trainMode: 'on', sweep, duty: old, now }), { pause: true, notify: 'STRICT_OFF_SWEEP_INCOMPLETE' }, JSON.stringify(sweep));
  assert.match(backstopText('STRICT_OFF_SWEEP_INCOMPLETE'), /清扫没完成/);
  // review R3 M1: a node not on duty (STANDBY never sweeps; UNCERTAIN after a start) is never paused nor told; a new or unknown
  // eligibility (a take-over, a restart) only notifies
  for (const status of [{ node: { mode: 'STANDBY' }, train: {} }, { node: { mode: 'UNCERTAIN' }, train: {} }, { node: { mode: 'ACTIVE' }, train: { notOnDuty: true } }])
    assert.deepEqual(backstopDecision({ facts: rulesFacts(rules({ strict: false })), trainMode: 'on', sweep: null, duty: dutyOf(status), now }), { pause: false, notify: null }, JSON.stringify(status));
  for (const duty of [{ onDuty: true, onSince: now - SWEEP_GRACE_MS + 1 }, { onDuty: true, onSince: null }, dutyOf({ node: null, train: { onSince: now - 60_000 } })])
    assert.deepEqual(backstopDecision({ facts: rulesFacts(rules({ strict: false })), trainMode: 'on', sweep: null, duty, now }), { pause: false, notify: 'STRICT_OFF_SWEEP_PENDING' }, JSON.stringify(duty));
  assert.deepEqual(dutyOf({ node: { mode: 'ACTIVE' }, train: { onSince: 5 } }), { onDuty: true, onSince: 5 });
  assert.deepEqual(backstopDecision({ facts: rulesFacts(rules({ strict: false })), trainMode: 'on', sweep: { fullSinceOn: true }, duty: old, now }), { pause: false, notify: null });
  assert.deepEqual(backstopDecision({ facts: rulesFacts(rules()), trainMode: 'on', sweep: null }), { pause: false, notify: null }, 'strict on: nothing');
  for (const r of [rules({ pinned: 5164952 }), rules({ names: REQUIRED_CHECK_NAMES.slice(1) }), [{ type: 'deletion' }]])
    assert.deepEqual(backstopDecision({ facts: rulesFacts(r), trainMode: 'off' }), { pause: false, notify: 'RULESET_NOT_PINNED' });
  for (const bad of [null, {}, 'x', [1]]) assert.deepEqual(backstopDecision({ facts: rulesFacts(bad), trainMode: 'off' }), { pause: false, notify: null });
});

// DESIGN §65 (strict-permanent mode, Owner decision 9e2511fe): strict off is never a state to work in. With the policy's train.sweep 'audit'
// or 'off' (status train.sweepMode) the pause and the urgent notice come at once, whatever the sweep, the duty or how new the eligibility.
test('strict-permanent mode: strict off pauses and notifies at once, no grace, on every node; gate and an older status keep the old rules', async () => {
  const off = rulesFacts(rules({ strict: false }));
  const now = Date.parse('2026-11-07T00:00:00Z');
  for (const sweepMode of ['audit', 'off'])
    for (const [sweep, duty] of [[null, { onDuty: true, onSince: now - 60_000 }], [{ fullSinceOn: true }, { onDuty: true, onSince: now - 2 * SWEEP_GRACE_MS }],
      [null, dutyOf({ node: { mode: 'STANDBY' }, train: {} })], [null, { onDuty: true, onSince: null }]])
      assert.deepEqual(backstopDecision({ facts: off, trainMode: 'on', sweep, duty, now, sweepMode }), { pause: true, notify: 'STRICT_OFF_STRICT_PERMANENT' }, `${sweepMode} ${JSON.stringify([sweep, duty])}`);
  assert.deepEqual(backstopDecision({ facts: rulesFacts(rules()), trainMode: 'on', sweepMode: 'audit', now }), { pause: false, notify: null }, 'strict on: nothing');
  assert.deepEqual(backstopDecision({ facts: off, trainMode: 'shadow', sweepMode: 'audit', now }), { pause: true, notify: 'STRICT_OFF_WITHOUT_TRAIN' });
  for (const sweepMode of ['gate', null, undefined, 'bogus'])
    assert.deepEqual(backstopDecision({ facts: off, trainMode: 'on', sweep: null, duty: { onDuty: true, onSince: now - 60_000 }, now, sweepMode }), { pause: false, notify: 'STRICT_OFF_SWEEP_PENDING' }, String(sweepMode));
  assert.match(backstopText('STRICT_OFF_STRICT_PERMANENT'), /strict 永久开/);
  // One pass: the status's sweepMode reaches the decision; the pause request is written on the first pass.
  const paused = [], notes = [], mem = new Map();
  const r = await backstopPass({ readRules: async () => rules({ strict: false }), trainMode: async () => 'on', trainSweep: async () => ({ fullSinceOn: true }),
    trainDuty: async () => ({ onDuty: true, onSince: now - 60_000 }), trainSweepMode: async () => 'audit', writePause: async x => paused.push(x), notify: async k => notes.push(k),
    memory: { get: async k => mem.get(k), set: async (k, v) => mem.set(k, v) }, clock: () => now });
  assert.deepEqual([r.acted, paused, notes], [true, ['ruleset-backstop: STRICT_OFF_STRICT_PERMANENT'], ['STRICT_OFF_STRICT_PERMANENT']]);
});

test('one pass acts once a day per kind; a failing read never acts', async () => {
  const mem = new Map(), paused = [], notes = [];
  const ports = (reply, clock) => ({ readRules: async () => reply, trainMode: async () => 'shadow', writePause: async r => paused.push(r), notify: async k => notes.push(k),
    memory: { get: async k => mem.get(k), set: async (k, v) => mem.set(k, v) }, clock: () => clock });
  const t0 = Date.parse('2026-10-23T05:00:00Z');
  assert.equal((await backstopPass(ports(rules({ strict: false }), t0))).acted, true);
  assert.equal((await backstopPass(ports(rules({ strict: false }), t0 + 3600_000))).acted, false, 'not again the same day');
  assert.equal((await backstopPass(ports(rules({ strict: false }), t0 + 25 * 3600_000))).acted, true);
  assert.deepEqual([paused.length, notes], [2, ['STRICT_OFF_WITHOUT_TRAIN', 'STRICT_OFF_WITHOUT_TRAIN']]);
  const broken = { ...ports(null, t0), readRules: async () => { throw new Error('gh failed'); } };
  assert.deepEqual(await backstopPass(broken), { pause: false, notify: null, acted: false });
});

test('the pause request is one the executor accepts (inbox name shape, exact keys, contract)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backstop-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const name = await writePauseRequest(dir, 'ruleset-backstop: STRICT_OFF_WITHOUT_TRAIN', () => Date.parse('2026-10-23T05:00:00Z'));
  assert.match(name, /^[0-9]{13}-[0-9a-f]{12}\.json$/);
  const inbox = await Inbox.open(dir, path.join(dir, 'archive'));
  const [entry] = await inbox.read(10, 1024);
  assert.deepEqual(JSON.parse(entry.bytes.toString('utf8')), { contract: PAUSE_CONTRACT, reason: 'ruleset-backstop: STRICT_OFF_WITHOUT_TRAIN' });
});

test('companion wiring: gh reads main\'s rules, the pause goes into the requests folder, the toast runs once a day, memory in the companion store', async t => {
  const { companionBackstop } = await import('../src/ruleset-backstop.mjs');
  const { LocalStore } = await import('../src/pr-status.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-backstop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'requests'));
  const store = await LocalStore.open(path.join(root, 'companion-store.json'), () => now);
  const calls = [];
  let reply = { code: 0, stdout: JSON.stringify(rules({ strict: false })) };
  const run = async (argv, opts) => { calls.push(argv); return argv[0].endsWith('gh.exe') ? reply : { code: 0, stdout: '' }; };
  let now = Date.parse('2026-10-23T12:00:00Z');
  const pass = () => companionBackstop({ root, ghExe: 'C:\\gh\\gh.exe', repo: 'tdoljyj/cross-memory-system', powershellExe: 'C:\\Windows\\powershell.exe', run, store, clock: () => now });
  // no status snapshot: the train mode is unknown, so strict off without the train pauses
  assert.deepEqual(await pass(), { pause: true, notify: 'STRICT_OFF_WITHOUT_TRAIN', acted: true });
  assert.deepEqual(calls[0].slice(1, 3), ['api', '--method']);
  assert.ok(calls[0].includes('repos/tdoljyj/cross-memory-system/rules/branches/main?per_page=100'));
  assert.equal(calls[1][0], 'C:\\Windows\\powershell.exe', 'the toast');
  const pauses = await fs.readdir(path.join(root, 'requests'));
  assert.equal(pauses.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'requests', pauses[0]), 'utf8')).contract, PAUSE_CONTRACT);
  assert.ok(JSON.parse(await fs.readFile(path.join(root, 'companion-store.json'), 'utf8')).notified['backstop:STRICT_OFF_WITHOUT_TRAIN']);
  // the same day: nothing more; an unreadable reply: nothing at all
  now += 3600_000;
  assert.equal((await pass()).acted, false);
  reply = { code: 1, stdout: '' };
  now += 2 * 86_400_000;
  assert.deepEqual(await pass(), { pause: false, notify: null, acted: false });
  assert.equal((await fs.readdir(path.join(root, 'requests'))).length, 1);
});
