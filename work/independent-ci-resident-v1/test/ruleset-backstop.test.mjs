// The companion's ruleset backstop (quota redesign phase 2, step 3c-1; design v0.5 §6; DESIGN §22.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { APP_ID, BACKSTOP_KINDS, PAUSE_CONTRACT, REQUIRED_CHECK_NAMES, backstopDecision, backstopPass, backstopText, rulesFacts, writePauseRequest } from '../src/ruleset-backstop.mjs';
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
  assert.deepEqual(backstopDecision({ facts: rulesFacts(rules({ strict: false })), trainMode: 'on' }), { pause: false, notify: null });
  for (const r of [rules({ pinned: 5164952 }), rules({ names: REQUIRED_CHECK_NAMES.slice(1) }), [{ type: 'deletion' }]])
    assert.deepEqual(backstopDecision({ facts: rulesFacts(r), trainMode: 'off' }), { pause: false, notify: 'RULESET_NOT_PINNED' });
  for (const bad of [null, {}, 'x', [1]]) assert.deepEqual(backstopDecision({ facts: rulesFacts(bad), trainMode: 'off' }), { pause: false, notify: null });
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
