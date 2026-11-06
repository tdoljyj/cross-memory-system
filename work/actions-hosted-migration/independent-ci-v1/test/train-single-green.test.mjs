// Merge train step 3c-2b, stages 1 and 8 (DESIGN §41.2, §41.4, §41.8): the train mode channel, trainHeadReady (the sweep
// proof of stage 10 and the live facts), the summary, touch green and touch running, the refusal of a train front job
// without the train, TRAIN_TEST_COMMIT_GONE, the binding without the renewable timestamps, the merge-slot port's writes and
// the new codes. With the train off or in shadow nothing here changes the existing behaviour (resident-v2-publishers.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { admissionExternalIdV2, batchJobsV2, claimGeneration, frontJobIdsV2, scanExternalIdV2 } from '../src/job-v2.mjs';
import { EffectJournal, ROLE_PUBLICATION_CONTRACT, rolePublicationKey } from '../src/effect-journal.mjs';
import { ofJobIds, publishedNames } from '../src/published-on-github-v2.mjs';
import { recordBatchClaim, readBatchClaim } from '../src/batch-claim-v2.mjs';
import { createFixtureControlPublisherV2, STAGE8_CHECK_MS, STAGE8_NOT_READY_REASONS, STAGE8_FINAL_REASONS } from '../src/independent-control-checks-v2/publisher.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { trainHeadDecision, TRAIN_SINGLE_GREEN_NOT_PROVEN } from '../src/independent-control-checks-v2/train-rules.mjs';
import { parseStageTrainMode, readStageTrainMode, stageTrainModeText, trainPortsV2, STAGE_TRAIN_MODE_FILE } from '../src/independent-control-checks-v2/train-mode.mjs';
import { createMergeSlotNative, parseHolders, parseRoleProbe } from '../src/independent-control-checks-v2/merge-slot-native.mjs';
import { outcomeFailureCode, CLEAN_FINAL_CODES, TRAIN_CODES, ALL_STAGE_CODES } from '../src/resident-v2/stage-fact.mjs';
import { HEAD, BASE, tempDir, admittedFacts } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system', PR = 888;
const S = 'd'.repeat(40), S_TREE = '5'.repeat(40), OTHER = '9'.repeat(40);
const SIX = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const iso = ms => new Date(ms).toISOString();
const jobsFor = (testSha = S) => batchJobsV2({ repo: REPO, pr: PR, headSha: HEAD, baseSha: BASE, testSha, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1 });
// main's rules once the Owner turned strict off and allowed merge commits only (§41.9 step 6)
const trainRules = ({ strict = false, methods = ['merge'] } = {}) => [{ type: 'pull_request', parameters: { allowed_merge_methods: methods } },
  { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: strict, required_status_checks: SIX.map(context => ({ context, integration_id: 5368905 })) } }];

// GitHub for a front batch: the PR's test merge is S = [T, H] with S's tree; GitHub's base.sha for the PR is a fact.
function fakeGithub(o = {}) {
  const checks = []; let next = 100;
  const state = { rules: trainRules(), pull: { state: 'open', merged: false, mergeable: true, merge_commit_sha: S }, commitError: null,
    commits: { [HEAD]: { sha: HEAD, tree: 'c'.repeat(40), parents: [BASE] }, [S]: { sha: S, tree: S_TREE, parents: [BASE, HEAD] } }, ...o };
  return { checks, state,
    async readStatuses(headSha) { return { complete: true, headSha, statuses: [] }; },
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, ...structuredClone(state.pull), head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: OTHER, ref: 'main', repo: { full_name: REPO } } }; },
    async readBranchRules(branch) { return { complete: true, branch, rules: structuredClone(state.rules) }; },
    async readGitCommit(sha) {
      if (state.commitError?.[sha]) throw Object.assign(new Error(state.commitError[sha]), { code: state.commitError[sha] });
      if (!state.commits[sha]) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' });
      return structuredClone(state.commits[sha]);
    },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); state.onCreate?.(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}
// The same for a batch that tests the head: H contains T, so the test merge has H's own tree.
const headGithub = (o = {}) => { const g = fakeGithub({ rules: trainRules({ strict: true }), ...o }); g.state.commits[S] = { sha: S, tree: 'c'.repeat(40), parents: [BASE, HEAD] }; return g; };
function fakeAdmission(answer) { let calls = 0; return { get calls() { return calls; }, async evaluatePr(job, packet, options) { calls++; return answer(job, packet, options ?? {}, calls); } }; }
// A green ledger that lists what it recorded (green-ledger.mjs shape: { entries: [{ name, entry }], refused }).
const listLedger = (earlier = []) => ({ records: [...earlier], refused: [], async append(r) { this.records.push({ phase: r.phase, pr: r.job.pr, headSha: r.job.headSha, baseSha: r.job.baseSha, at: iso(Date.now()), checkRunId: r.checkRunId }); },
  async list() { return { entries: this.records.map((entry, i) => ({ name: `r${i}`, entry })), refused: [...this.refused] }; } });

// Everything trainHeadReady needs, all holding at `now`: one holder (this claim, this PR, front for 20 minutes), the newest
// proof of this front tenure a minute old, stage 10's front batch record of S, and no other PR updated since the proof.
function proven(now, claimId) {
  const since = iso(now - 20 * 60_000);
  return {
    holders: { onDuty: true, holders: [{ claimId, boundPr: `${REPO}#${PR}`, pr: PR, mergeSlotUntil: iso(now + 600_000), takenAt: since, ciState: 'running', ciHeadSha: HEAD, hardCapUntil: iso(now + 3600_000) }] },
    proof: { contract: 'clued.independent-ci.train-sweep-proof/1', writtenAt: iso(now - 60_000), runId: '0123456789abcdef-0123456789ab', mode: 'on', pr: PR, headSha: HEAD, claimId, since,
      mainSha: BASE, clean: true, unconfirmed: 0, fullSweepSinceOn: true, slotHardCapMinutes: 120, sweepFreshMs: 900_000, prUpdatedCursor: iso(now - 61_000) },
    front: { contract: 'clued.independent-ci.train-front-batch/1', writtenAt: iso(now - 60_000), runId: '0123456789abcdef-0123456789ab', pr: PR, headSha: HEAD, baseSha: BASE, testSha: S, testTree: S_TREE,
      claimId, since, attempt: 1 },
    pulls: { complete: true, pulls: [{ number: PR, updatedAt: iso(now - 10_000) }, { number: 700, updatedAt: iso(now - 120_000) }], newest: iso(now - 10_000) },
  };
}
const ports = (w, { touch = null } = {}) => {
  const touches = [];
  return { touches,
    slotNative: { async holders() { return structuredClone(w.holders); },
      async touch(x) { touches.push(x); if (touch) return touch(x); return { onDuty: true, touched: true, until: iso(Date.now() + 5400_000), claims: [w.holders.holders[0]?.claimId], returned: null }; } },
    sweepStore: { refused: 0, async latestProof() { return structuredClone(w.proof); }, async frontBatches({ pr, headSha }) { return w.front && w.front.pr === pr && w.front.headSha === headSha ? [structuredClone(w.front)] : []; } } };
};

// One stage-8 run of the pair. trainMode on by default with every fact proven; `edit(w)` changes the world before the run.
async function stage8(t, { trainMode = 'on', trainModeUnreadable = false, testSha = S, github = fakeGithub(), edit = () => {}, ledger = null, touch = null, answer = null } = {}) {
  const jobs = jobsFor(testSha), c = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) };
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now();
  const w = proven(time, c.claimId); edit(w);
  const p = ports(w, { touch }), greenLedger = ledger ?? listLedger(), logs = [], pullReads = [];
  const admission = fakeAdmission(answer ? (job, packet, opts, n) => answer({ job, packet, opts, n, c, time }) : (job, packet, opts) => admittedFacts(job, c, packet,
    { domain: 'fixture', mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 }));
  const pub = createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record: (k, d) => logs.push([k, d]), authority: {}, batchClaim: claimGeneration(c), greenLedger, trainMode, trainModeUnreadable,
    slotNative: p.slotNative, sweepStore: p.sweepStore, pullsUpdatedSince: async cursor => { pullReads.push(cursor); return structuredClone(w.pulls); },
    clock: () => time, sleep: async ms => { time += ms; } });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + STAGE8_CHECK_MS });
  return { r, github, greenLedger, touches: p.touches, logs, pullReads, admission, jobs, w };
}
const code8 = r => outcomeFailureCode({ status: r.status, reason: r.reason, sideEffects: r.sideEffects, mayHavePublished: false }, 8);

test('train mode channel: the resident writes one exact record into the stage directory; anything else is off', async t => {
  assert.equal(stageTrainModeText('on'), '{"contract":"clued.independent-ci.stage-train-mode/1","trainMode":"on"}');
  for (const mode of ['off', 'shadow', 'on']) assert.equal(parseStageTrainMode(Buffer.from(stageTrainModeText(mode))), mode);
  for (const bytes of [null, Buffer.from(''), Buffer.from('{"trainMode":"on"}'), Buffer.from(stageTrainModeText('on') + '\n'), Buffer.from('{"contract":"clued.independent-ci.stage-train-mode/1","trainMode":"ON"}'),
    Buffer.from(' ' + stageTrainModeText('on'))]) assert.equal(parseStageTrainMode(bytes), 'off');
  assert.throws(() => stageTrainModeText('maybe'), { code: 'TRAIN_MODE_REFUSED' });
  const dir = await tempDir(t);
  assert.equal(await readStageTrainMode(dir), 'off', 'no file: off');
  await fs.writeFile(path.join(dir, STAGE_TRAIN_MODE_FILE), stageTrainModeText('on'));
  assert.equal(await readStageTrainMode(dir), 'on');
  // review R1 m4: no file is the contract's off; a file that is there but unusable is off and unreadable
  const fact = await import('../src/independent-control-checks-v2/train-mode.mjs');
  assert.deepEqual(await fact.readStageTrainModeFact(dir), { trainMode: 'on', unreadable: false });
  assert.deepEqual(await fact.readStageTrainModeFact(await tempDir(t)), { trainMode: 'off', unreadable: false });
  for (const bytes of [stageTrainModeText('off'), '{"torn":', stageTrainModeText('on') + '\n', 'x'.repeat(300)]) {
    const d = await tempDir(t);
    await fs.writeFile(path.join(d, STAGE_TRAIN_MODE_FILE), bytes);
    assert.deepEqual(await fact.readStageTrainModeFact(d), { trainMode: 'off', unreadable: bytes !== stageTrainModeText('off') }, bytes.slice(0, 20));
  }
  const asDir = await tempDir(t);
  await fs.mkdir(path.join(asDir, STAGE_TRAIN_MODE_FILE));
  assert.deepEqual(await fact.readStageTrainModeFact(asDir), { trainMode: 'off', unreadable: true });
  // off and shadow build no train port and load nothing
  for (const trainMode of ['off', 'shadow']) assert.deepEqual(await trainPortsV2({ trainMode, record: null, fetchImpl: null, nativeToken: null, github: null }), {});
  const record = { config: { supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk', scope: 'project:p', repository: REPO } };
  for (const trainMode of ['off', 'shadow']) {
    const requests = [], returnedClaim = randomUUID();
    const port = await trainPortsV2({ trainMode, record, nativeToken: 'clued_bnd_fixture', queueReturn: true,
      openStore: async () => { throw new Error('off-mode must not load sweep state'); },
      fetchImpl: async (url, options) => { requests.push({ url, input: JSON.parse(options.body).p_input });
        return Response.json({ status: 'ok', pr_ref: `${REPO}#888`, returned: true, merge_slot_returned: [returnedClaim] }); } });
    assert.equal(requests.length, 0, 'constructing a queue return port performs no I/O');
    assert.deepEqual(await port.slotNative.returnSlot({ pr: 888 }), { onDuty: true, returned: true, claims: [returnedClaim] });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/clued_work_merge_slot_return_v1$/);
    assert.deepEqual(requests[0].input, { scope: 'project:p', pr_ref: `${REPO}#888` });
    assert.deepEqual(Object.keys(port), ['slotNative'], 'ordinary mode does not enable train sweeping');
  }
  const on = await trainPortsV2({ trainMode: 'on', record, fetchImpl: async () => { throw new Error('no network'); }, nativeToken: 'clued_bnd_x', github: { readPullsUpdatedSince: async () => 'pulls' },
    openStore: async () => { throw new Error('EACCES'); } });
  assert.deepEqual([typeof on.slotNative.holders, typeof on.slotNative.touch, on.sweepStore, await on.pullsUpdatedSince('2026-10-31T00:00:00.000Z')], ['function', 'function', null, 'pulls']);
});

test('trainHeadReady (§41.2): every condition, one at a time; each unmet one is TRAIN_SINGLE_GREEN_NOT_PROVEN', () => {
  const now = Date.now(), claimId = randomUUID(), job = jobsFor()['control-merge-slot'];
  const decide = (edit = () => {}, { ledger = { entries: [], refused: [] }, storeRefused = 0, j = job } = {}) => {
    const w = proven(now, claimId); edit(w);
    return trainHeadDecision({ job: j, claimId, holders: w.holders, proof: w.proof, storeRefused, front: w.front, ledger, pulls: w.pulls, now });
  };
  assert.equal(decide(), null);
  const no = TRAIN_SINGLE_GREEN_NOT_PROVEN, other = randomUUID();
  const cases = {
    'a batch that tests the head': [() => {}, { j: jobsFor(HEAD)['control-merge-slot'] }],
    'not on duty': [w => { w.holders = { onDuty: false, holders: [] }; }],
    'two holders': [w => { w.holders.holders.push({ ...w.holders.holders[0], claimId: other, pr: 889, boundPr: `${REPO}#889` }); }],
    'no holder': [w => { w.holders.holders = []; }],
    'another claim holds the slot': [w => { w.holders.holders[0].claimId = other; }],
    'the holder is bound to another PR': [w => { w.holders.holders[0].pr = 889; w.holders.holders[0].boundPr = `${REPO}#889`; }],
    'no proof': [w => { w.proof = null; }],
    'a proof of another PR': [w => { w.proof.pr = 889; }],
    'a proof of another H': [w => { w.proof.headSha = OTHER; }],
    'a proof of another T': [w => { w.proof.mainSha = OTHER; }],
    'a proof of the previous front': [w => { w.proof.claimId = other; }],
    'a proof of an earlier front tenure': [w => { w.proof.since = iso(now - 50 * 60_000); }],
    'a proof written before the claim became front': [w => { w.proof.writtenAt = iso(now - 21 * 60_000); }],
    'an expired proof': [w => { w.proof.writtenAt = iso(now - 16 * 60_000); w.holders.holders[0].takenAt = w.proof.since = iso(now - 30 * 60_000); w.front.since = w.proof.since; }],
    'a proof from the future': [w => { w.proof.writtenAt = iso(now + 60_000); }],
    'a shadow proof': [w => { w.proof.mode = 'shadow'; }],
    'a revoke-only proof': [w => { w.proof.mode = 'revoke-only'; }],
    'not clean': [w => { w.proof.clean = false; }],
    'an unconfirmed revocation': [w => { w.proof.unconfirmed = 1; }],
    'no full on-mode sweep since on (only shadow ones)': [w => { w.proof.fullSweepSinceOn = false; }],
    'a torn file in the proof store': [() => {}, { storeRefused: 1 }],
    'no front batch record': [w => { w.front = null; }],
    'stage 10 fixed another S': [w => { w.front.testSha = OTHER; }],
    'stage 10 fixed another T': [w => { w.front.baseSha = OTHER; }],
    'another PR updated after the proof': [w => { w.pulls.pulls.push({ number: 777, updatedAt: iso(now - 30_000) }); }],
    'the PR read incomplete': [w => { w.pulls.complete = false; }],
    'no PR read': [w => { w.pulls = null; }],
    'a refused ledger file': [() => {}, { ledger: { entries: [], refused: ['x.json'] } }],
    'another head green after the proof': [() => {}, { ledger: { entries: [{ entry: { phase: 'settled', pr: 777, headSha: OTHER, baseSha: BASE, at: iso(now - 30_000) } }], refused: [] } }],
    'no ledger': [() => {}, { ledger: null }],
  };
  for (const [name, [edit, o]] of Object.entries(cases)) assert.equal(decide(edit, o), no, name);
  // what does not count: the front PR's own update, an older green, a revoked one, this head's own records, a PR updated before
  assert.equal(decide(w => { w.pulls.pulls.push({ number: 700, updatedAt: iso(now - 62_000) }); }, { ledger: { entries: [
    { entry: { phase: 'settled', pr: 777, headSha: OTHER, baseSha: BASE, at: iso(now - 70_000) } }, { entry: { phase: 'revoked', pr: 777, headSha: OTHER, baseSha: BASE, at: iso(now - 30_000) } },
    { entry: { phase: 'intent', pr: PR, headSha: HEAD, baseSha: BASE, at: iso(now - 20_000) } }], refused: [] } }), null);
});

test('stage 8, train on: one green on S, the summary names front, T and S, then one touch green with the policy cap', async t => {
  const x = await stage8(t);
  assert.equal(x.r.status, 'SETTLED', JSON.stringify(x.r));
  assert.deepEqual(x.github.checks.map(c => [c.name, c.conclusion]), [['kooyumi-admission-verified', 'success'], ['kooyumi-merge-slot', 'success']]);
  const slot = x.github.checks[1], admissionCheck = x.github.checks[0];
  assert.ok(slot.output.summary.startsWith(`front PR #${PR}, head ${HEAD}, main@${BASE}, tested ${S} (tree ${S_TREE}). Independent Native control check for ${REPO}#${PR} (attempt 1);`), slot.output.summary);
  assert.ok(admissionCheck.output.summary.startsWith('Independent Native control check'), 'only the merge-slot green names the train');
  assert.deepEqual(x.touches, [{ pr: PR, headSha: HEAD, ciState: 'green', hardCapMinutes: 120 }]);
  assert.deepEqual(x.r.trainTouch, { ciState: 'green', onDuty: true, touched: true, code: null });
  assert.deepEqual(x.pullReads, [x.w.proof.prUpdatedCursor]);
  assert.ok(x.logs.some(([k, d]) => k === 'native_train_touch' && d.touched === true));
  assert.deepEqual(x.greenLedger.records.map(r => r.phase), ['intent', 'posted', 'settled']);
  // strict on with the train on is a green too (before the Owner turns strict off: §41.9 step 5)
  assert.equal((await stage8(t, { github: fakeGithub({ rules: trainRules({ strict: true, methods: ['merge', 'squash'] }) }) })).r.status, 'SETTLED');
  // with the train on, strict off still needs merge commits only
  const squash = await stage8(t, { github: fakeGithub({ rules: trainRules({ methods: ['merge', 'squash'] }) }) });
  assert.deepEqual([squash.r.reason, squash.github.checks.length, squash.touches.length], ['MERGE_METHODS_NOT_MERGE_ONLY', 0, 0]);
});

test('stage 8, train on: touch green failing or not finding the front changes nothing and is only logged', async t => {
  const failing = await stage8(t, { touch: () => { throw Object.assign(new Error('MERGE_TRAIN_NATIVE_UNREADABLE'), { code: 'MERGE_TRAIN_NATIVE_UNREADABLE' }); } });
  assert.deepEqual([failing.r.status, failing.touches.length, failing.r.trainTouch.code], ['SETTLED', 1, 'MERGE_TRAIN_NATIVE_UNREADABLE']);
  assert.ok(failing.github.checks.every(c => c.conclusion === 'success'), 'never revoked');
  const notDuty = await stage8(t, { touch: () => ({ onDuty: false, touched: false, until: null, claims: [], returned: null }) });
  assert.deepEqual([notDuty.r.status, notDuty.r.trainTouch.code], ['SETTLED', 'NODE_ROLE_NOT_HELD']);
  // the holder changed between the proof and the touch: no touch at all
  const moved = await stage8(t, { edit: w => { let reads = 0; const h = w.holders; Object.defineProperty(w, 'holders', { get: () => (++reads > 1 ? { onDuty: true, holders: [] } : h) }); } });
  assert.deepEqual([moved.r.status, moved.touches.length, moved.r.trainTouch.code], ['SETTLED', 0, 'TRAIN_TOUCH_NOT_FRONT']);
});

test('stage 8, train on: no green the proof does not cover, at once and with zero side effects', async t => {
  const now = () => Date.now();
  const unproven = {
    'two holders': w => { w.holders.holders.push({ ...w.holders.holders[0], claimId: randomUUID(), pr: 889, boundPr: `${REPO}#889` }); },
    'a proof of another PR': w => { w.proof.pr = 889; },
    'a proof of another H': w => { w.proof.headSha = OTHER; },
    'a proof of another T': w => { w.proof.mainSha = OTHER; },
    'a proof of the previous front': w => { w.proof.claimId = randomUUID(); },
    'a proof older than the front tenure': w => { w.proof.writtenAt = iso(now() - 25 * 60_000); },
    'an expired proof': w => { w.proof.sweepFreshMs = 60_000; w.proof.writtenAt = iso(now() - 2 * 60_000); },
    'another PR updated after the proof': w => { w.pulls.pulls.push({ number: 777, updatedAt: iso(now() - 5_000) }); },
    'only shadow sweeps since on': w => { w.proof.fullSweepSinceOn = false; },
    'an unconfirmed revocation': w => { w.proof.clean = false; w.proof.unconfirmed = 2; },
  };
  for (const [name, edit] of Object.entries(unproven)) {
    const x = await stage8(t, { edit });
    assert.deepEqual([x.r.status, x.r.reason, x.r.sideEffects, x.r.polls, x.github.checks.length, x.greenLedger.records.length, x.touches.length],
      ['BLOCKED', TRAIN_SINGLE_GREEN_NOT_PROVEN, 0, 1, 0, 0, 0], name);
    assert.equal(code8(x.r), TRAIN_SINGLE_GREEN_NOT_PROVEN, name);
  }
  // a green of another head ledgered after the proof (this node wrote one it should not have): not proven
  const ledger = listLedger([{ phase: 'posted', pr: 777, headSha: OTHER, baseSha: BASE, at: iso(Date.now()), checkRunId: 5 }]);
  const l = await stage8(t, { ledger });
  assert.deepEqual([l.r.reason, l.github.checks.length], [TRAIN_SINGLE_GREEN_NOT_PROVEN, 0]);
  // with the train on, a batch that tests the head is never the front batch
  const head = await stage8(t, { testSha: HEAD, github: headGithub({ rules: trainRules() }) });
  assert.deepEqual([head.r.reason, head.github.checks.length], [TRAIN_SINGLE_GREEN_NOT_PROVEN, 0]);
  assert.ok(STAGE8_NOT_READY_REASONS.includes(TRAIN_SINGLE_GREEN_NOT_PROVEN), 'the batch parks and waits for the next stage 10');
});

test('stage 8: S != H only with the train on; strict off without the train is still refused (off and shadow)', async t => {
  for (const trainMode of ['off', 'shadow']) {
    const x = await stage8(t, { trainMode });
    assert.deepEqual([x.r.status, x.r.reason, x.r.sideEffects, x.admission.calls, x.github.checks.length, x.touches.length, x.pullReads.length], ['BLOCKED', 'TRAIN_FRONT_JOB_WITHOUT_TRAIN', 0, 0, 0, 0, 0], trainMode);
    assert.equal(code8(x.r), 'TRAIN_FRONT_JOB_WITHOUT_TRAIN');
    const head = await stage8(t, { trainMode, testSha: HEAD });
    assert.deepEqual([head.r.reason, head.github.checks.length, head.touches.length], ['STRICT_OFF_WITHOUT_TRAIN', 0, 0], trainMode);
  }
  assert.ok(STAGE8_FINAL_REASONS.includes('TRAIN_FRONT_JOB_WITHOUT_TRAIN'));
  // review R1 m4: an unreadable train mode parks the front job (not final); an S = H job is as before
  const u = await stage8(t, { trainMode: 'off', trainModeUnreadable: true });
  assert.deepEqual([u.r.status, u.r.reason, u.r.sideEffects, u.github.checks.length, code8(u.r)], ['BLOCKED', 'TRAIN_MODE_UNREADABLE', 0, 0, 'TRAIN_MODE_UNREADABLE']);
  assert.ok(STAGE8_NOT_READY_REASONS.includes('TRAIN_MODE_UNREADABLE') && !STAGE8_FINAL_REASONS.includes('TRAIN_MODE_UNREADABLE'));
  const uh = await stage8(t, { trainMode: 'off', trainModeUnreadable: true, testSha: HEAD });
  assert.equal(uh.r.reason, 'STRICT_OFF_WITHOUT_TRAIN');
  const u1 = await stage1(t, { trainMode: 'off', trainModeUnreadable: true });
  assert.deepEqual([u1.r.reason, u1.admission.calls, outcomeFailureCode({ status: 'BLOCKED', reason: u1.r.reason, sideEffects: 0, mayHavePublished: false }, 1)],
    ['TRAIN_MODE_UNREADABLE', 0, 'TRAIN_MODE_UNREADABLE']);
});

test('stage 8, train on: S GitHub no longer has, or that is not the test merge of [T, H], ends the batch (§41.4)', async t => {
  const gone = fakeGithub(); delete gone.state.commits[S];
  const g = await stage8(t, { github: gone });
  assert.deepEqual([g.r.status, g.r.reason, g.r.sideEffects, g.r.polls, g.github.checks.length], ['BLOCKED', 'TRAIN_TEST_COMMIT_GONE', 0, 1, 0]);
  assert.equal(code8(g.r), 'TRAIN_TEST_COMMIT_GONE');
  assert.ok(STAGE8_FINAL_REASONS.includes('TRAIN_TEST_COMMIT_GONE'));
  const swapped = fakeGithub(); swapped.state.commits[S] = { sha: S, tree: S_TREE, parents: [HEAD, BASE] };
  assert.equal((await stage8(t, { github: swapped })).r.reason, 'TRAIN_TEST_COMMIT_GONE');
  // a read that fails for any other reason is still not ready (waited out)
  const flaky = fakeGithub({ commitError: { [S]: 'github_http_502' } });
  const f = await stage8(t, { github: flaky });
  assert.deepEqual([f.r.reason, f.r.polls > 1, f.github.checks.length], ['TRAIN_TEST_MERGE_NOT_READY', true, 0]);
});

test('binding (§41.8): a renewal, keepalive or touch between the two observations no longer voids; tip or queue head still does', async t => {
  // every observation sees a later lease and a later slot deadline (the holder renewed, stage 10 kept the claim alive or touched it)
  const renewing = ({ job, packet, opts, n, c, time }) => admittedFacts(job, { ...c, expiresAt: iso(time + 3600_000 + n * 60_000) }, packet,
    { domain: 'fixture', mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 + n * 60_000 });
  for (const trainMode of ['off', 'on']) {
    const r = await stage8(t, { trainMode, testSha: trainMode === 'on' ? S : HEAD, answer: renewing, github: trainMode === 'on' ? fakeGithub() : headGithub() });
    assert.equal(r.r.status, 'SETTLED', `${trainMode}: ${JSON.stringify(r.r)}`);
    assert.ok(r.admission.calls >= 4);
  }
  // the queue head or main's tip seen by the admission check's after-write observation: the binding changed, revoked
  for (const change of [f => ({ ...f, mergeQueueHead: false }), f => ({ ...f, mergeSlot: { ...f.mergeSlot, tip: OTHER } })]) {
    let created = false;
    const github = headGithub(); github.state.onCreate = () => { created = true; };
    const answer = ({ job, packet, opts, c, time }) => {
      const { observationSha256, ...f } = admittedFacts(job, c, packet, { domain: 'fixture', mergeQueueHead: true, batchClaim: opts.batchClaim, observedAt: time, slotUntil: time + 600_000 });
      return created ? (g => ({ ...g, observationSha256: digest(g) }))(change(f)) : { ...f, observationSha256 };
    };
    const r = await stage8(t, { trainMode: 'off', testSha: HEAD, github, answer });
    assert.equal(r.r.status, 'REVOKED', JSON.stringify(r.r));
    assert.equal(r.github.checks[0].conclusion, 'failure');
  }
});

// ---- stage 1 ----
// seed: check runs already on H (another batch, node or install).
async function stage1(t, { trainMode = 'on', trainModeUnreadable = false, testSha = S, edit = () => {}, touch = null, answer = null, seed = [] } = {}) {
  const job = jobsFor(testSha)['work-admission'], c = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) }, github = fakeGithub();
  github.checks.push(...structuredClone(seed));
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects')), dir = await tempDir(t);
  const batchClaims = { read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } }, record: (j, cl, at) => recordBatchClaim(dir, j, cl, at) };
  const w = proven(Date.now(), c.claimId); edit(w);
  const p = ports(w, { touch }), logs = [];
  const admission = fakeAdmission((j, packet, opts, n) => answer ? answer({ job: j, packet, opts, n, c }) : admittedFacts(j, c, packet, { domain: 'fixture', batchClaim: opts.batchClaim }));
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record: (k, d) => logs.push([k, d]), authority: {}, batchClaims, trainMode, trainModeUnreadable,
    slotNative: p.slotNative, sweepStore: p.sweepStore });
  return { r: await pub.publish(job), github, touches: p.touches, admission, logs };
}

test('stage 1: S != H only with the train on, refused before anything is read', async t => {
  for (const trainMode of ['off', 'shadow']) {
    const x = await stage1(t, { trainMode });
    assert.deepEqual([x.r.status, x.r.reason, x.r.sideEffects, x.r.safeToRerun, x.admission.calls, x.github.checks.length, x.touches.length], ['BLOCKED', 'TRAIN_FRONT_JOB_WITHOUT_TRAIN', 0, false, 0, 0, 0], trainMode);
    assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason: x.r.reason, sideEffects: 0, mayHavePublished: false }, 1), 'TRAIN_FRONT_JOB_WITHOUT_TRAIN');
    const head = await stage1(t, { trainMode, testSha: HEAD });
    assert.deepEqual([head.r.status, head.touches.length, 'trainTouch' in head.r], ['SETTLED', 0, false], trainMode);
  }
});

test('stage 1, train on: the front batch reports running again after its check settled, only as the front holder of this PR', async t => {
  const x = await stage1(t);
  assert.equal(x.r.status, 'SETTLED');
  assert.deepEqual(x.touches, [{ pr: PR, headSha: HEAD, ciState: 'running', hardCapMinutes: 120 }]);
  assert.equal(x.r.trainTouch.touched, true);
  assert.ok(x.logs.some(([k, d]) => k === 'native_train_touch' && d.ciState === 'running'));
  for (const [name, edit] of Object.entries({
    'another PR holds the slot': w => { w.holders.holders[0].pr = 889; w.holders.holders[0].boundPr = `${REPO}#889`; },
    'another claim holds the slot': w => { w.holders.holders[0].claimId = randomUUID(); },
    'not on duty': w => { w.holders = { onDuty: false, holders: [] }; },
    'no proof of this head (no cap)': w => { w.proof = null; } })) {
    const y = await stage1(t, { edit });
    assert.deepEqual([y.r.status, y.touches.length, y.r.trainTouch.touched], ['SETTLED', 0, false], name);
  }
  // a failing touch never changes the ending
  const f = await stage1(t, { touch: () => { throw Object.assign(new Error('MERGE_TRAIN_NATIVE_UNREADABLE'), { code: 'MERGE_TRAIN_NATIVE_UNREADABLE' }); } });
  assert.deepEqual([f.r.status, f.r.trainTouch.code, f.github.checks[0].conclusion], ['SETTLED', 'MERGE_TRAIN_NATIVE_UNREADABLE', 'success']);
  // a batch that tests the head never touches
  assert.equal((await stage1(t, { testSha: HEAD })).touches.length, 0);
});

test('stage 1 binding (§41.8): a renewal between the observations no longer voids; main tip moving still does', async t => {
  const renewed = await stage1(t, { trainMode: 'off', testSha: HEAD, answer: ({ job, packet, opts, n, c }) => admittedFacts(job, { ...c, expiresAt: iso(Date.now() + 3600_000 + n * 60_000) }, packet,
    { domain: 'fixture', batchClaim: opts.batchClaim, slotUntil: Date.now() + 600_000 + n * 60_000 }) });
  assert.equal(renewed.r.status, 'SETTLED', JSON.stringify(renewed.r));
  const moved = await stage1(t, { trainMode: 'off', testSha: HEAD, answer: ({ job, packet, opts, n, c }) => {
    const { observationSha256, ...f } = admittedFacts(job, c, packet, { domain: 'fixture', batchClaim: opts.batchClaim });
    if (n === 1) return { ...f, observationSha256 };
    const g = { ...f, mergeSlot: { ...f.mergeSlot, tip: OTHER } };
    return { ...g, observationSha256: digest(g) };
  } });
  assert.equal(moved.r.status, 'REVOKED');
});

test('merge-slot port: holders and the role probe ignore anything optional (review R1 MAJOR-1); the writes and nodesStatus are Source A\'s port', async () => {
  const row = { claim_id: '11111111-2222-4333-8444-555555555555', bound_pr: `${REPO}#910`, merge_slot_until: '2026-10-31T06:00:00Z', merge_slot_ci: { taken_at: '2026-10-31T05:00:00Z' } };
  assert.deepEqual(Object.keys(parseHolders(200, { status: 'ok', repository: REPO, holders: [row] }, REPO)).sort(), ['holders', 'onDuty']);
  // a node never heard (nulls), a malformed node, a stray watermark: neither holders nor the probe changes
  for (const extra of [{ nodes: [{ node: null, source_manifest_sha256: null, state: null, last_heartbeat_at: null }] }, { nodes: [{ node: 'x y' }] }, { nodes: {} },
    { sweep_watermark: { completed_at: 'x', updated_cursor: 'y', main_sha: BASE } }]) {
    assert.deepEqual(Object.keys(parseHolders(200, { status: 'ok', repository: REPO, holders: [row], ...extra }, REPO)).sort(), ['holders', 'onDuty'], JSON.stringify(extra));
    assert.equal(parseRoleProbe(200, { status: 'ok', repository: REPO, holders: [row], ...extra }, REPO).result, 'held', JSON.stringify(extra));
    assert.equal(parseRoleProbe(200, { status: 'ok', repository: REPO, holders: [], ...extra }, REPO).result, 'held');
  }
  const seen = [];
  const port = createMergeSlotNative({ config: { supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk', scope: 'project:p', repository: REPO }, nativeToken: 'clued_bnd_secret',
    fetchImpl: async (url, init) => { seen.push({ rpc: url.split('/rpc/')[1], input: JSON.parse(init.body).p_input }); return new Response(JSON.stringify({ status: 'ok', touched: false, reason: 'admission_binding_required' }), { status: 200 }); } });
  assert.deepEqual(await port.touch({ pr: 910, headSha: HEAD, ciState: 'green', hardCapMinutes: 90 }), { onDuty: false, touched: false, until: null, claims: [], returned: null });
  assert.deepEqual(seen, [{ rpc: 'clued_work_merge_slot_touch_v1', input: { scope: 'project:p', pr_ref: `${REPO}#910`, head_sha: HEAD, ci_state: 'green', hard_cap_minutes: 90 } }]);
  assert.deepEqual(['touch', 'adopt', 'returnSlot', 'keepalive', 'reportSweepWatermark', 'nodesStatus', 'holders', 'roleProbe'].map(k => typeof port[k]), Array(8).fill('function'));
  const bad = createMergeSlotNative({ config: { supabaseUrl: 'http://x', publishableKey: 'pk', scope: 's', repository: REPO }, nativeToken: 't', fetchImpl: async () => { throw new Error('unused'); } });
  await assert.rejects(bad.touch({ pr: 1, headSha: HEAD, ciState: 'failed' }), { code: 'MERGE_TRAIN_NATIVE_INPUT_REFUSED' });
});

test('codes (§41.2–41.4): every train code is a clean final code of the stage-fact table', () => {
  assert.deepEqual([...TRAIN_CODES].sort(), ['RELAY_TRAIN_FRONT_LOCAL', 'TRAIN_FRONT_ATTEMPTS_USED', 'TRAIN_FRONT_BUDGET_SHORT', 'TRAIN_FRONT_JOB_WITHOUT_TRAIN', 'TRAIN_LANDED_TREE_MISMATCH',
    'TRAIN_MODE_UNREADABLE', 'TRAIN_REVOKE_UNCONFIRMED', 'TRAIN_SINGLE_GREEN_NOT_PROVEN', 'TRAIN_SOURCE_MISMATCH', 'TRAIN_SWEEP_INCOMPLETE', 'TRAIN_TAKEOVER_SWEEP_PENDING', 'TRAIN_TEST_COMMIT_GONE']);
  assert.ok(TRAIN_CODES.every(c => CLEAN_FINAL_CODES.includes(c) && ALL_STAGE_CODES.includes(c)));
  for (const reason of ['TRAIN_SINGLE_GREEN_NOT_PROVEN', 'TRAIN_TEST_COMMIT_GONE', 'TRAIN_FRONT_JOB_WITHOUT_TRAIN'])
    assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false }, 8), reason);
  // stage 3's publisher is not the train's: there the code is an ordinary refusal
  assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason: 'TRAIN_FRONT_JOB_WITHOUT_TRAIN', sideEffects: 0, mayHavePublished: false }, 3), 'PUBLICATION_BLOCKED');
});

// ---- §41.3 / INTERFACES §4: an unconfirmed revocation is recorded only in the sweep proof ----
test('trainHeadReady: an unconfirmed revocation stops the green through the proof (the ledger keeps the green as it was); a readable ledger is still required', async t => {
  const { TrainSweepStore } = await import('../src/independent-control-checks-v2/train-sweep-store.mjs');
  const now = Date.now(), claimId = randomUUID(), job = jobsFor()['control-merge-slot'], w = proven(now, claimId);
  const store = await TrainSweepStore.open(path.join(await tempDir(t), 'train-sweep'));
  const { contract, ...p } = w.proof; void contract;
  // stage 10 could not confirm one revocation: the green stays settled in the ledger (only a confirmed one is ledgered revoked)
  const ledger = { entries: [{ entry: { phase: 'settled', pr: 777, headSha: OTHER, baseSha: BASE, at: iso(now - 30 * 60_000) } }], refused: [] };
  await store.appendProof({ ...p, writtenAt: iso(now - 90_000), clean: false, unconfirmed: 1 });
  const decide = async (l = ledger) => trainHeadDecision({ job, claimId, holders: w.holders, proof: await store.latestProof(), storeRefused: store.refused, front: w.front, ledger: l, pulls: w.pulls, now });
  assert.equal(await decide(), TRAIN_SINGLE_GREEN_NOT_PROVEN, 'unconfirmed in the proof');
  // the next run confirmed it: a clean proof, the ledger as before (no revoked record needed)
  await store.appendProof({ ...p, writtenAt: iso(now - 60_000) });
  assert.equal(await decide(), null);
  assert.equal(await decide({ entries: [], refused: ['torn.json'] }), TRAIN_SINGLE_GREEN_NOT_PROVEN, 'the ledger must still be readable');
  assert.equal(await decide(null), TRAIN_SINGLE_GREEN_NOT_PROVEN);
});

// ---- §41.4: the front batch (H, S) is its own identity, apart from the non-front run of H ----
const checkRun = (id, name, externalId, o = {}) => ({ id, name, head_sha: HEAD, status: 'completed', conclusion: 'success', app: { id: 5368905 }, external_id: externalId, ...o });
const otherClaim = { claimId: randomUUID(), fence: 2, epoch: 1 };
// What a non-front batch of H (S = H) published there: its three role checks and the control pair.
const nonFrontChecks = () => {
  const j = jobsFor(HEAD);
  return [checkRun(1, 'gitleaks', scanExternalIdV2(j.gitleaks)), checkRun(2, 'trivy', scanExternalIdV2(j.trivy)), checkRun(3, 'contract-placement', scanExternalIdV2(j['contract-placement'])),
    checkRun(4, 'kooyumi-admission-verified', admissionExternalIdV2('independent-ci:control:control-admission', j['control-admission'], otherClaim)),
    checkRun(5, 'kooyumi-merge-slot', admissionExternalIdV2('independent-ci:control:control-merge-slot', j['control-merge-slot'], otherClaim), { conclusion: 'failure' })];
};

test('front identity: the front subject\'s job ids, the external ids that name them, its own K(head, S, role); S = H keeps every key', () => {
  const front = jobsFor(), head = jobsFor(HEAD);
  assert.equal(frontJobIdsV2(head.gitleaks), null, 'a batch that tests the head counts everything on H, as before');
  const ids = frontJobIdsV2(front.gitleaks);
  assert.equal(ids.size, 12, 'six roles, two attempts');
  assert.deepEqual(frontJobIdsV2(front['control-merge-slot']), ids, 'one set per front subject');
  assert.ok(ids.has(front.trivy.id) && !ids.has(head.trivy.id));
  const second = batchJobsV2({ repo: REPO, pr: PR, headSha: HEAD, baseSha: BASE, testSha: S, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now()), attempt: 2 });
  assert.ok(ids.has(second.gitleaks.id), 'attempt 2 of the same front subject is the same identity');
  assert.ok(!frontJobIdsV2(jobsFor('e'.repeat(40)).gitleaks).has(front.gitleaks.id), 'another S is another front batch');
  for (const [ext, own] of [[scanExternalIdV2(front.gitleaks), true], [admissionExternalIdV2('independent-ci:native-work-admission', front['work-admission'], otherClaim), true],
    [admissionExternalIdV2('independent-ci:control:control-merge-slot', front['control-merge-slot'], otherClaim), true], [scanExternalIdV2(head.gitleaks), false],
    [`independent-ci:relay:gitleaks:${HEAD.slice(0, 12)}:run1:a1`, false], [`independent-ci:staged:v2:${front.gitleaks.id}`, false], [null, false]])
    assert.equal(ofJobIds({ external_id: ext }, ids), own, String(ext));
  const k = { repo: REPO, headSha: HEAD, role: 'gitleaks', checkName: 'gitleaks', appId: 5368905 };
  assert.equal(rolePublicationKey(k), digest({ contract: ROLE_PUBLICATION_CONTRACT, ...k }), 'K without S is byte-identical');
  assert.notEqual(rolePublicationKey({ ...k, testSha: S }), rolePublicationKey(k));
  for (const testSha of [HEAD, 'x', null]) assert.throws(() => rolePublicationKey({ ...k, testSha }), { code: 'invalid_role_publication_subject' });
});

test('front identity: ROLE_ALREADY_ON_GITHUB of the scanner and control publishers counts only the front batch\'s own checks', async () => {
  const front = jobsFor(), port = checks => ({ async readAppChecks() { return { complete: true, checks: structuredClone(checks) }; } });
  const names = ['gitleaks', 'kooyumi-merge-slot'];
  assert.deepEqual(await publishedNames(port(nonFrontChecks()), HEAD, names), names, 'without job ids: everything on H, as before');
  assert.deepEqual(await publishedNames(port(nonFrontChecks()), HEAD, names, 5368905, frontJobIdsV2(front.gitleaks)), []);
  const own = [...nonFrontChecks(), checkRun(9, 'gitleaks', scanExternalIdV2(front.gitleaks))];
  assert.deepEqual(await publishedNames(port(own), HEAD, names, 5368905, frontJobIdsV2(front.gitleaks)), ['gitleaks']);
});

test('front identity, stage 1: the non-front run of H does not refuse the front batch; its own checks (another node) do; S = H as before', async t => {
  const x = await stage1(t, { seed: nonFrontChecks() });
  assert.deepEqual([x.r.status, x.r.reason ?? null], ['SETTLED', null], JSON.stringify(x.r));
  const front = jobsFor();
  const own = await stage1(t, { seed: [...nonFrontChecks(), checkRun(9, 'trivy', scanExternalIdV2(front.trivy))] });
  assert.deepEqual([own.r.status, own.r.reason, own.r.publishedChecks, own.admission.calls], ['BLOCKED', 'HEAD_PUBLISHED_ON_GITHUB', ['trivy'], 0]);
  // a batch that tests the head: every role check of this App on H counts, the front batch's too
  const head = await stage1(t, { trainMode: 'off', testSha: HEAD, seed: [checkRun(9, 'trivy', scanExternalIdV2(front.trivy))] });
  assert.deepEqual([head.r.status, head.r.reason, head.r.publishedChecks], ['BLOCKED', 'HEAD_PUBLISHED_ON_GITHUB', ['trivy']]);
});

test('front identity, stage 8: the non-front control pair on H does not stop the front pair; the front\'s own merge-slot check from another node does', async t => {
  const g = fakeGithub(); g.checks.push(...nonFrontChecks());
  const x = await stage8(t, { github: g });
  assert.equal(x.r.status, 'SETTLED', JSON.stringify(x.r));
  assert.equal(x.github.checks.filter(c => c.name === 'kooyumi-merge-slot' && c.conclusion === 'success').length, 1);
  const o = fakeGithub(); o.checks.push(...nonFrontChecks(), checkRun(9, 'kooyumi-merge-slot', admissionExternalIdV2('independent-ci:control:control-merge-slot', jobsFor()['control-merge-slot'], otherClaim)));
  const y = await stage8(t, { github: o });
  assert.deepEqual([y.r.status, y.r.reason, y.r.sideEffects, y.github.checks.length], ['BLOCKED', 'ROLE_ALREADY_ON_GITHUB', 0, 6]);
});
