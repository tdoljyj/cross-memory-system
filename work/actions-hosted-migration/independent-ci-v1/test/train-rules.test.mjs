// Phase 2, step 3a (design v0.5 §5.3 rules 3, 5, 7; §5.4 item 4): the live branch rules, GitHub's test merge, the green
// ledger, and the GitHub port's branch-rules read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rulesetFacts, rulesetDecision, testMergeDecision, mergedAsTested, requiredCheckFailure, REQUIRED_CHECK_NAMES, appScansNotDone, appScansPinned } from '../src/independent-control-checks-v2/train-rules.mjs';
import { batchJobsV2, frontJobIdsV2, scanExternalIdV2 } from '../src/job-v2.mjs';
import { GreenLedger, validateGreenEntry, GREEN_LEDGER_CONTRACT } from '../src/independent-control-checks-v2/green-ledger.mjs';
import { createGitHubChecksPort } from '../src/github.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { tempDir } from './resident-v2-fixtures.mjs';
import { ADMISSION, ADMISSION_APP, PIN_TABLE, S7_OTHER_ADMISSION, checkRun, s7Green, s7Rules, scaffoldRules, mainRules } from './s7-rules-fixture.mjs';

const APP = 5368905, H = 'a'.repeat(40), T = 'b'.repeat(40), TREE = 'c'.repeat(40), M = 'd'.repeat(40);
const required = ({ strict = true, pinned = APP, names = REQUIRED_CHECK_NAMES, extra = [] } = {}) => ({ type: 'required_status_checks',
  parameters: { strict_required_status_checks_policy: strict, required_status_checks: [...names.map(context => ({ context, integration_id: pinned })), ...extra] } });
const pullRule = methods => ({ type: 'pull_request', parameters: { allowed_merge_methods: methods } });
const fails = (fn, code = 'RULESET_UNREADABLE') => assert.throws(fn, e => e.code === code);

test('branch rules: the six checks pinned to 5368905, strict and merge methods; anything else is unreadable', () => {
  assert.deepEqual(rulesetFacts([{ type: 'deletion', parameters: null }, pullRule(['merge', 'squash', 'rebase']), required()], APP), { requiredPinned: true, strict: true, mergeOnly: false, appScans: ['gitleaks', 'trivy', 'contract-placement'] });
  // the ruleset disabled (no required checks), one check missing, one pinned elsewhere or to no integration
  fails(() => rulesetFacts([{ type: 'deletion', parameters: null }], APP));
  fails(() => rulesetFacts([required({ names: REQUIRED_CHECK_NAMES.slice(0, 5) })], APP));
  fails(() => rulesetFacts([required({ pinned: 5164952 })], APP));
  fails(() => rulesetFacts([required({ extra: [{ context: 'gitleaks' }] })], APP));
  // malformed replies
  for (const bad of [null, {}, [null], [{ type: '' }], [{ type: 'required_status_checks', parameters: null }],
    [{ type: 'required_status_checks', parameters: { required_status_checks: [], strict_required_status_checks_policy: 'yes' } }], Array.from({ length: 100 }, () => required())]) fails(() => rulesetFacts(bad, APP));
  // other required checks next to the six do not matter
  assert.equal(rulesetFacts([required({ extra: [{ context: 'other', integration_id: 1 }] })], APP).requiredPinned, true);
  // several rulesets aggregate: strict if any asks; the merge methods every pull_request rule allows
  assert.equal(rulesetFacts([required({ strict: false }), required({ strict: true })], APP).strict, true);
  assert.equal(rulesetFacts([required({ strict: false })], APP).strict, false);
  assert.equal(rulesetFacts([required(), pullRule(['merge'])], APP).mergeOnly, true);
  assert.equal(rulesetFacts([required(), pullRule(['merge', 'squash']), pullRule(['merge', 'rebase'])], APP).mergeOnly, true);
  assert.equal(rulesetFacts([required()], APP).mergeOnly, false, 'no pull_request rule: the methods are unknown');
  // unreadable merge methods are unknown, never "merge only", and never a reason to refuse the rules (review N6)
  for (const parameters of [{ allowed_merge_methods: 'merge' }, {}, null, { allowed_merge_methods: [1] }])
    assert.deepEqual(rulesetFacts([required(), pullRule(['merge']), { type: 'pull_request', parameters }], APP), { requiredPinned: true, strict: true, mergeOnly: false, appScans: ['gitleaks', 'trivy', 'contract-placement'] });
});

// R3 lean (resident DESIGN §82 item 1): a scan may be required from GitHub Actions (15368): this App need not publish it (appScans).
// Admission and the control pair stay pinned to this App; all six are still required, with strict on or off.
test('branch rules R3: scans pinned to Actions are pinned and leave appScans; admission and the control pair stay App-only', () => {
  const SCAN = ['gitleaks', 'trivy', 'contract-placement'], PAIR = ['kooyumi-admission-verified', 'kooyumi-merge-slot'];
  const ACTIONS_INTEGRATION_ID = 15368;
  const rule = ({ strict = true, pins }) => ({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: strict,
    required_status_checks: pins.map(([context, integration_id]) => ({ context, integration_id })) } });
  const own = names => names.map(n => [n, APP]), actions = names => names.map(n => [n, ACTIONS_INTEGRATION_ID]);
  for (const strict of [true, false])
    assert.deepEqual(rulesetFacts([rule({ strict, pins: [...own(['kooyumi-work-admission']), ...actions(SCAN), ...own(PAIR)] }), pullRule(['merge'])], APP),
      { requiredPinned: true, strict, mergeOnly: true, appScans: [] }, `strict ${strict}`);
  assert.equal(rulesetDecision(rulesetFacts([rule({ pins: [...own(['kooyumi-work-admission']), ...actions(SCAN), ...own(PAIR)] })], APP), 'on'), null);
  assert.deepEqual(rulesetFacts([rule({ pins: [...own(['kooyumi-work-admission']), ['gitleaks', ACTIONS_INTEGRATION_ID], ...own(['trivy', 'contract-placement']), ...own(PAIR)] })], APP).appScans,
    ['trivy', 'contract-placement']);
  // a scan two rulesets require, one from Actions and one from this App: this App still publishes it
  assert.deepEqual(rulesetFacts([rule({ pins: [...own(['kooyumi-work-admission']), ...actions(SCAN), ...own(PAIR)] }), rule({ pins: [['trivy', APP]] })], APP).appScans, ['trivy']);
  // refused: admission or one of the pair from Actions, the pair gone (strict on or off), half the pair, a scan missing, a scan from another App
  for (const strict of [true, false]) for (const pins of [[['kooyumi-work-admission', ACTIONS_INTEGRATION_ID], ...actions(SCAN), ...own(PAIR)],
    [...own(['kooyumi-work-admission']), ...actions(SCAN), ['kooyumi-admission-verified', APP], ['kooyumi-merge-slot', ACTIONS_INTEGRATION_ID]],
    [...own(['kooyumi-work-admission']), ...actions(SCAN)], [...own(['kooyumi-work-admission']), ...actions(SCAN), ['kooyumi-merge-slot', APP]],
    [...own(['kooyumi-work-admission']), ...actions(['gitleaks', 'trivy']), ...own(PAIR)], [...own(['kooyumi-work-admission']), ['gitleaks', 5164952], ...actions(['trivy', 'contract-placement']), ...own(PAIR)]])
    fails(() => rulesetFacts([rule({ strict, pins })], APP));
});

// Review of R3, problem A: the scans main's rules still require from this App must be done before stage 8 writes a green or lands S.
test('appScansNotDone: own-job scans for push, any job of this App for a green GitHub merges on, reuse, and an unusable appScans', () => {
  const S = 'e'.repeat(40), SRC = 'f'.repeat(64), ALL = ['gitleaks', 'trivy', 'contract-placement'];
  const jobs = batchJobsV2({ repo: 'tdoljyj/cross-memory-system', pr: 910, headSha: H, baseSha: T, testSha: S, sourceManifestSha256: SRC, createdAt: '2026-11-22T08:00:00.000Z', attempt: 1 });
  const other = batchJobsV2({ repo: 'tdoljyj/cross-memory-system', pr: 910, headSha: H, baseSha: T, testSha: H, sourceManifestSha256: SRC, createdAt: '2026-11-22T07:00:00.000Z', attempt: 1 });
  const ids = frontJobIdsV2(jobs['work-admission']);
  let next = 1;
  const scan = (role, o = {}) => ({ id: next++, app: { id: APP }, name: role, head_sha: H, status: 'completed', conclusion: 'success',
    external_id: scanExternalIdV2((o.of ?? jobs)[role]), output: { title: role, summary: `tested ${o.tested ?? S}` }, ...o.c });
  const own = ALL.map(r => scan(r)), ordinary = ALL.map(r => scan(r, { of: other, tested: H }));
  const not = (appScans, checks, o = {}) => appScansNotDone({ appScans, checks, jobIds: o.any ? null : ids, headSha: H, appId: APP, reuse: o.reuse });
  assert.deepEqual(not(ALL, own), []);
  assert.deepEqual(not([], []), [], 'every scan from Actions: none required from this App');
  assert.deepEqual(not(ALL, []), ALL);
  assert.deepEqual(not(['trivy'], own.filter(c => c.name !== 'trivy')), ['trivy']);
  assert.deepEqual(not(['gitleaks', 'contract-placement'], own.filter(c => c.name !== 'trivy')), []);
  // another job's scans of H do not count for push (S lands), unless reused (S has H's tree); they do for a green GitHub merges H on
  assert.deepEqual(not(ALL, ordinary), ALL);
  assert.deepEqual(not(ALL, ordinary, { reuse: true }), []);
  assert.deepEqual(not(ALL, ordinary, { any: true }), []);
  // the newest of the name decides: a later failure or a still running one is not done; another App's or another commit's never counts
  assert.deepEqual(not(ALL, [...own, scan('trivy', { c: { conclusion: 'failure' } })]), ['trivy']);
  assert.deepEqual(not(ALL, [...own.filter(c => c.name !== 'gitleaks'), scan('gitleaks', { c: { status: 'in_progress', conclusion: null } })]), ['gitleaks']);
  assert.deepEqual(not(ALL, [...own.filter(c => c.name !== 'gitleaks'), scan('gitleaks', { c: { app: { id: 15368 } } }), scan('gitleaks', { c: { head_sha: T } })], { any: true }), ['gitleaks']);
  // appScans not a list (never from rulesetFacts): every scan is required
  for (const bad of [null, undefined, 'gitleaks', {}]) assert.deepEqual(not(bad, []), ALL, String(bad));
  assert.deepEqual(not(['gitleaks', 'nope'], []), ['gitleaks'], 'only scan names count');
});

test('branch rules decide: strict off needs the train; with the train, strict off needs merge-only', () => {
  const facts = (strict, mergeOnly) => ({ requiredPinned: true, strict, mergeOnly });
  for (const mode of ['off', 'shadow']) {
    assert.equal(rulesetDecision(facts(true, false), mode), null);
    assert.equal(rulesetDecision(facts(false, true), mode), 'STRICT_OFF_WITHOUT_TRAIN');
  }
  assert.equal(rulesetDecision(facts(true, false), 'on'), null);
  assert.equal(rulesetDecision(facts(false, true), 'on'), null);
  assert.equal(rulesetDecision(facts(false, false), 'on'), 'MERGE_METHODS_NOT_MERGE_ONLY');
  assert.equal(rulesetDecision(null, 'off'), 'RULESET_UNREADABLE');
  assert.equal(rulesetDecision({ strict: true }, 'off'), 'RULESET_UNREADABLE');
  assert.throws(() => rulesetDecision(facts(true, true), 'maybe'), e => e.code === 'TRAIN_MODE_REFUSED');
  assert.equal(rulesetDecision(facts(true, true)), null, 'the default is the train off');
});

test('test merge: exactly [T, H] with the tested tree; waiting otherwise; another tree is final', () => {
  const job = { pr: 9, headSha: H, baseSha: T };
  const pull = (o = {}) => ({ number: 9, state: 'open', mergeable: true, merge_commit_sha: M, head: { sha: H }, ...o });
  const merge = (o = {}) => ({ sha: M, tree: TREE, parents: [T, H], ...o });
  const decide = (p, m) => testMergeDecision({ pull: p, mergeCommit: m, job, testTree: TREE });
  assert.equal(decide(pull(), merge()), null);
  for (const [p, m] of [[pull({ mergeable: null }), merge()], [pull({ mergeable: false }), merge()], [pull({ merge_commit_sha: null }), null], [pull(), null],
    [pull(), merge({ sha: 'e'.repeat(40) })], [pull(), merge({ parents: [H, T] })], [pull(), merge({ parents: [T] })], [pull(), merge({ parents: ['9'.repeat(40), H] })],
    [pull({ state: 'closed' }), merge()], [pull({ head: { sha: '8'.repeat(40) } }), merge()], [pull({ number: 10 }), merge()]]) assert.equal(decide(p, m), 'TRAIN_TEST_MERGE_NOT_READY');
  assert.equal(decide(pull(), merge({ tree: '7'.repeat(40) })), 'TRAIN_TEST_MERGE_TREE_DIFFERS');
  assert.throws(() => testMergeDecision({ pull: pull(), mergeCommit: merge(), job, testTree: 'x' }), e => e.code === 'TRAIN_TEST_SUBJECT_REQUIRED');
  // merged as tested: the PR closed and merged, the merge commit exactly [T, H] with the tested tree
  const merged = (o = {}) => ({ number: 9, state: 'closed', merged: true, merge_commit_sha: M, head: { sha: H }, base: { ref: 'main' }, ...o });
  assert.equal(mergedAsTested({ pull: merged(), mergeCommit: merge(), job, testTree: TREE }), true);
  for (const [p, m] of [[merged({ merged: false }), merge()], [merged({ state: 'open' }), merge()], [merged(), merge({ tree: '7'.repeat(40) })], [merged(), merge({ parents: ['9'.repeat(40), H] })],
    [merged({ base: { ref: 'other' } }), merge()], [merged({ head: { sha: '8'.repeat(40) } }), merge()], [merged(), merge({ sha: 'e'.repeat(40) })]]) assert.equal(mergedAsTested({ pull: p, mergeCommit: m, job, testTree: TREE }), false);
});

test('green ledger: create-only records, intent before a check id, every complete record listed, anything else refused', async t => {
  const dir = path.join(await tempDir(t), 'green');
  let now = Date.parse('2026-10-23T03:00:00Z');
  const ledger = await GreenLedger.open(dir); ledger.clock = () => now;
  const job = { repo: 'tdoljyj/cross-memory-system', pr: 9, headSha: H, baseSha: T };
  const base = { job, testTree: TREE, effectKey: 'f'.repeat(64), externalId: 'independent-ci:control:control-merge-slot:v2:x' };
  await ledger.append({ ...base, phase: 'intent' });
  now += 1000;
  await ledger.append({ ...base, phase: 'posted', checkRunId: 55 });
  await ledger.append({ ...base, phase: 'merged', checkRunId: 55, testMergeSha: M, detail: M });
  await assert.rejects(ledger.append({ ...base, phase: 'posted' }), e => e.code === 'invalid_green_entry', 'a check id after the intent');
  await assert.rejects(ledger.append({ ...base, phase: 'guessed', checkRunId: 1 }), e => e.code === 'invalid_green_entry');
  await assert.rejects(ledger.append({ ...base, externalId: 'other', phase: 'intent' }), e => e.code === 'invalid_green_entry');
  const { entries, refused } = await ledger.list();
  // oldest first (by time; within one millisecond by effect key, then phase)
  assert.deepEqual(entries.map(e => [e.entry.phase, e.entry.checkRunId]), [['intent', null], ['merged', 55], ['posted', 55]]);
  assert.deepEqual(refused, []);
  assert.equal(entries[0].entry.contract, GREEN_LEDGER_CONTRACT);
  // a torn or foreign file is reported, never skipped; a leftover temporary file is ignored
  await fs.writeFile(path.join(dir, `${'1'.repeat(13)}-${'f'.repeat(16)}-posted-00000000.json`), '{"half":');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
  await fs.writeFile(path.join(dir, `${'2'.repeat(13)}-${'f'.repeat(16)}-intent-00000000.json.tmp`), '{');
  const again = await ledger.list();
  assert.equal(again.entries.length, 3);
  assert.deepEqual(again.refused.sort(), [`${'1'.repeat(13)}-${'f'.repeat(16)}-posted-00000000.json`, 'notes.txt']);
  assert.throws(() => validateGreenEntry({ ...entries[0].entry, extra: 1 }), e => e.code === 'invalid_green_entry');
  // a complete record under a name that says another phase, time or effect is refused (review N2)
  const text = await fs.readFile(path.join(dir, entries[0].name), 'utf8');
  const misnamed = [entries[0].name.replace('-intent-', '-posted-'), entries[0].name.replace(/^\d{13}/, '9'.repeat(13)), entries[0].name.replace(/-[a-f0-9]{16}-/, `-${'0'.repeat(16)}-`)];
  for (const name of misnamed) await fs.writeFile(path.join(dir, name), text);
  const third = await ledger.list();
  assert.equal(third.entries.length, 3);
  assert.deepEqual(third.refused.filter(n => misnamed.includes(n)).sort(), [...misnamed].sort());
});

test('GitHub port: the branch-rules read is one normalized GET of main, a full page refused', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Date.parse('2026-10-23T03:00:00Z'), seen = [];
  let rules = [{ type: 'deletion', ruleset_id: 24182890, ruleset_source_type: 'Repository', parameters: null }, { type: 'required_status_checks', ruleset_id: 24182890, parameters: { strict_required_status_checks_policy: true, required_status_checks: [] } }];
  const reply = body => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, options) => {
    const u = new URL(url); seen.push(`${options.method} ${u.pathname}${u.search}`);
    if (u.pathname === '/app') return reply({ id: 77 });
    if (u.pathname === '/app/installations/99/access_tokens') return reply({ token: 't', expires_at: new Date(now + 3_600_000).toISOString(), permissions: { checks: 'write', contents: 'read', pull_requests: 'read', metadata: 'read' } });
    if (u.pathname === '/installation/repositories') return reply({ total_count: 1, repositories: [{ id: 41, full_name: 'owner/repo' }] });
    if (u.pathname === '/repos/owner/repo/rules/branches/main') return reply(rules);
    throw new Error('unexpected');
  };
  const port = createGitHubChecksPort({ repository: 'owner/repo', repositoryId: 41, appId: 77, installationId: 99, privateKeyProvider: async () => privateKey, fetchImpl, clock: () => now });
  const r = await port.readBranchRules('main');
  assert.deepEqual(r, { complete: true, branch: 'main', rules: [{ type: 'deletion', rulesetId: 24182890, parameters: null },
    { type: 'required_status_checks', rulesetId: 24182890, parameters: { strict_required_status_checks_policy: true, required_status_checks: [] } }] });
  assert.ok(seen.includes('GET /repos/owner/repo/rules/branches/main?per_page=100'));
  await assert.rejects(port.readBranchRules('dev'), e => e.code === 'invalid_branch');
  for (const bad of [{}, [{ type: '' }], [{ type: 'x', parameters: [] }], Array.from({ length: 100 }, () => ({ type: 'deletion', parameters: null }))]) {
    rules = bad;
    await assert.rejects(port.readBranchRules('main'), e => e.code === 'invalid_rules_reply');
  }
});

// Task 04f9b91b (S7: #292 enabled again next to the scaffold ruleset). The same name pinned to another App is one more
// requirement (rulesets aggregate), not a different pin of this App's check: the rules read, and that App's run is read.
test('S7 rules: #292 next to the scaffold ruleset reads; this App pin holds while one entry pins it (must-red 1)', () => {
  assert.deepEqual(rulesetFacts(s7Rules(), APP), { requiredPinned: true, strict: true, mergeOnly: false, appScans: ['gitleaks', 'trivy', 'contract-placement'] });
});

test('S7 rules: every required check green on the head is no failure (must-red 2)', () => {
  assert.deepEqual(requiredCheckFailure(s7Rules(), { complete: true, checks: s7Green(H) }, H, APP), []);
});

test('S7 rules: the admission App own failure is a failed required check, even with this App same-named success (must-red 3)', () => {
  // the scaffold variant whose admission check is pinned to another App (live it is pinned to this App: s7-rules-fixture.mjs)
  const o = S7_OTHER_ADMISSION;
  const checks = s7Green(H, o).map(c => (c.name === ADMISSION && c.app.id === ADMISSION_APP ? { ...c, conclusion: 'failure' } : c));
  assert.ok(checks.some(c => c.name === ADMISSION && c.app.id === APP && c.conclusion === 'success'));
  assert.deepEqual(requiredCheckFailure(s7Rules(o), { complete: true, checks }, H, APP), [ADMISSION]);
  // and absent (not yet run) is no failure: GitHub keeps it required, the gate does not guess
  assert.deepEqual(requiredCheckFailure(s7Rules(o), { complete: true, checks: s7Green(H, o).filter(c => c.app.id !== ADMISSION_APP) }, H, APP), []);
});

test('S7 rules stay strict where they were: scaffold only, a disaster-recovery pin, an unpinned entry, one of the six only pinned elsewhere (stay green)', () => {
  fails(() => rulesetFacts(scaffoldRules(), APP));
  fails(() => rulesetFacts(mainRules({ pin: ADMISSION_APP }), APP));
  fails(() => rulesetFacts(mainRules({ extra: [{ context: 'gitleaks' }] }), APP));
  for (const [name, rules, pinned] of PIN_TABLE) if (!pinned) fails(() => rulesetFacts(rules, APP), 'RULESET_UNREADABLE');
  // the same table, this App's pinned rows
  for (const [name, rules, pinned] of PIN_TABLE) if (pinned && name.startsWith('today')) assert.equal(rulesetFacts(rules, APP).requiredPinned, true, name);
  // an unpinned required check stays unknown to the gate
  const unpinned = [...mainRules(), { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'legacy-ci' }] } }];
  assert.throws(() => requiredCheckFailure(unpinned, { complete: true, checks: [] }, H, APP), e => e.code === 'REQUIRED_CHECKS_UNREADABLE');
  assert.deepEqual(requiredCheckFailure(unpinned, { complete: true, checks: [checkRun(1, 'trivy', APP, H, 'failure')] }, H, APP), ['trivy']);
});

// Task 04f9b91b (admission p90): the scans this App must publish are the ones some rule pins to it, whether or not the six are all there.
// The scaffold ruleset alone (live 27843120) pins none: []. Rules that are not exactly understood: null (every scan runs).
test('appScansPinned: the scaffold pins no scan to this App; #292 pins all three; a part pins a part; not understood is null', () => {
  assert.deepEqual(appScansPinned(scaffoldRules(), APP), []);
  assert.deepEqual(appScansPinned(scaffoldRules(S7_OTHER_ADMISSION), APP), []);
  for (const rules of [s7Rules(), mainRules(), [required()]]) assert.deepEqual(appScansPinned(rules, APP), ['gitleaks', 'trivy', 'contract-placement']);
  const two = [required({ names: ['kooyumi-work-admission', 'contract-placement', 'trivy'] }), required({ pinned: 15368, names: ['gitleaks', 'trivy'] })];
  assert.deepEqual(appScansPinned(two, APP), ['trivy', 'contract-placement']);
  assert.deepEqual(appScansPinned(mainRules({ pin: ADMISSION_APP }), APP), [], 'pinned to another App: not for this App to publish');
  // the same answer as rulesetFacts wherever the rules read
  for (const [name, rules, pinned] of PIN_TABLE) if (pinned) assert.deepEqual(appScansPinned(rules, APP), rulesetFacts(rules, APP).appScans, name);
  for (const bad of [null, 'x', {}, [null], [{ type: '' }], [], [{ type: 'deletion' }], [{ type: 'required_status_checks' }],
    [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }],
    [required({ extra: [null] })], [required({ extra: [{ integration_id: APP }] })],
    mainRules({ extra: [{ context: 'gitleaks' }] }), [...scaffoldRules(), required({ pinned: -1, names: ['trivy'] })],
    Array.from({ length: 100 }, () => ({ type: 'deletion' }))])
    assert.equal(appScansPinned(bad, APP), null, JSON.stringify(bad)?.slice(0, 200));
});
