// Units of push mode (resident ADR 0018): the stage file, the shape of S, the other-App checks on S, main's rules, composing and
// bisecting, the one write to main, the landing port's token and refs, the landing records, and the never-published check.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tempDir } from './resident-v2-fixtures.mjs';
import * as L from '../src/independent-control-checks-v2/train-landing.mjs';
import { createLandingPort, LANDING_PERMISSIONS } from '../src/independent-control-checks-v2/train-landing-port.mjs';
import { TrainSweepStore } from '../src/independent-control-checks-v2/train-sweep-store.mjs';
import { requiredCheckFailure, TRAIN_ONLY_CHECK as RULES_TRAIN_ONLY, REQUIRED_CHECK_NAMES } from '../src/independent-control-checks-v2/train-rules.mjs';
import { createGitHubChecksPort } from '../src/github.mjs';
import { parseLandingArg, prepareStageDirectory } from '../src/resident-v2/invoke-stage.mjs';

const sha = n => n.toString(16).padStart(40, '0');
const T = sha(1), H1 = sha(2), H2 = sha(3), H3 = sha(4), S1 = sha(5), S2 = sha(6), S3 = sha(7);
const APP = 5368905, REPO = 'tdoljyj/cross-memory-system';

test('stage file: exact bytes, defaults, refusals; only push may carry a batch; one PR per batch unless the stage file says the chain is installed', async t => {
  assert.equal(L.stageTrainLandingText({ landing: 'push', batchMax: 3 }), '{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":3}');
  assert.throws(() => L.stageTrainLandingText({ landing: 'github-merge', batchMax: 2 }), /TRAIN_LANDING_REFUSED/);
  assert.throws(() => L.stageTrainLandingText({ landing: 'push', batchMax: 5 }), /TRAIN_LANDING_REFUSED/);
  assert.deepEqual(L.parseStageTrainLanding(null), { landing: 'github-merge', batchMax: 1, batchChain: false, unreadable: false });
  assert.deepEqual(L.parseStageTrainLanding(Buffer.from(L.stageTrainLandingText({ landing: 'push', batchMax: 4 }))), { landing: 'push', batchMax: 4, batchChain: false, unreadable: false });
  for (const bad of ['{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":4}\n', '{"landing":"push"}', 'x', '{"contract":"clued.independent-ci.stage-train-landing/1","batchMax":4,"landing":"push"}'])
    assert.deepEqual(L.parseStageTrainLanding(Buffer.from(bad)), { landing: 'github-merge', batchMax: 1, batchChain: false, unreadable: true }, bad);
  const dir = await tempDir(t);
  assert.deepEqual(await L.readStageTrainLandingFact(dir), { landing: 'github-merge', batchMax: 1, batchChain: false, unreadable: false });
  await fs.writeFile(path.join(dir, L.STAGE_TRAIN_LANDING_FILE), 'broken');
  assert.equal((await L.readStageTrainLandingFact(dir)).unreadable, true);
  assert.equal(L.effectiveBatchMax({ landing: 'push', batchMax: 4 }), 1, 'one PR per batch unless the stage file says the chain is installed');
  assert.equal(L.effectiveBatchMax({ landing: 'push', batchMax: 4, batchChain: false }), 1);
  assert.equal(L.effectiveBatchMax({ landing: 'push', batchMax: 4, batchChain: true }), 4);
  assert.equal(L.effectiveBatchMax({ landing: 'push', batchMax: 4, batchChain: true, unreadable: true }), 1);
  assert.equal(L.effectiveBatchMax({ landing: 'github-merge', batchMax: 1, batchChain: true }), 1);
  // the invoker: --train-landing <landing>:<n>, written for stages 8 and 10 only
  assert.deepEqual(parseLandingArg('push:4'), { landing: 'push', batchMax: 4, batchChain: false });
  assert.equal(parseLandingArg(undefined), null);
  assert.throws(() => L.landingSettings(parseLandingArg('push:0')), /TRAIN_LANDING_REFUSED/);
  const root = await tempDir(t), sealed = { files: { 'formal-service-entry.json': Buffer.from('{}'), 'jobs.json': Buffer.from('[]') } };
  const stageDir = await prepareStageDirectory({ stageRoot: root, nonce: 'a'.repeat(32), sealed, trainLanding: { landing: 'push', batchMax: 2 } });
  assert.deepEqual(await L.readStageTrainLandingFact(stageDir), { landing: 'push', batchMax: 2, batchChain: false, unreadable: false });
});

test('ADR 0019 stage file: batchChain (the resident found /4 installed) is written only when true, only in push mode, and is what lets stage 10 batch', async t => {
  const chain = L.stageTrainLandingText({ landing: 'push', batchMax: 3, batchChain: true });
  assert.equal(chain, '{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":3,"batchChain":true}');
  assert.equal(L.stageTrainLandingText({ landing: 'push', batchMax: 3, batchChain: false }), L.stageTrainLandingText({ landing: 'push', batchMax: 3 }), 'no chain: the bytes of before ADR 0019');
  assert.deepEqual(L.parseStageTrainLanding(Buffer.from(chain)), { landing: 'push', batchMax: 3, batchChain: true, unreadable: false });
  assert.equal(L.effectiveBatchMax(L.parseStageTrainLanding(Buffer.from(chain))), 3);
  for (const bad of [{ landing: 'github-merge', batchMax: 1, batchChain: true }, { landing: 'push', batchMax: 3, batchChain: 'yes' }, { landing: 'push', batchMax: 3, batchChain: 1 }])
    assert.throws(() => L.stageTrainLandingText(bad), /TRAIN_LANDING_REFUSED/, JSON.stringify(bad));
  for (const bad of ['{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchMax":3,"batchChain":false}',
    '{"contract":"clued.independent-ci.stage-train-landing/1","landing":"github-merge","batchMax":1,"batchChain":true}',
    '{"contract":"clued.independent-ci.stage-train-landing/1","landing":"push","batchChain":true,"batchMax":3}']) {
    const r = L.parseStageTrainLanding(Buffer.from(bad));
    assert.deepEqual(r, { landing: 'github-merge', batchMax: 1, batchChain: false, unreadable: true }, bad);
    assert.equal(L.effectiveBatchMax(r), 1, 'a file that cannot be read: one PR per batch');
  }
  // the invoker's argument: ':chain' only after push:<n>; github-merge with it is refused before anything is written
  assert.deepEqual(parseLandingArg('push:3:chain'), { landing: 'push', batchMax: 3, batchChain: true });
  for (const bad of ['push:3:chain:chain', 'push:3:Chain', 'push:3chain', 'push::chain']) assert.throws(() => L.landingSettings(parseLandingArg(bad)), /TRAIN_LANDING_REFUSED/, bad);
  assert.throws(() => L.landingSettings(parseLandingArg('github-merge:1:chain')), /TRAIN_LANDING_REFUSED/);
  const root = await tempDir(t), sealed = { files: { 'formal-service-entry.json': Buffer.from('{}'), 'jobs.json': Buffer.from('[]') } };
  const stageDir = await prepareStageDirectory({ stageRoot: root, nonce: 'b'.repeat(32), sealed, trainLanding: parseLandingArg('push:3:chain') });
  assert.equal(await fs.readFile(path.join(stageDir, L.STAGE_TRAIN_LANDING_FILE), 'utf8'), chain);
  assert.deepEqual(await L.readStageTrainLandingFact(stageDir), { landing: 'push', batchMax: 3, batchChain: true, unreadable: false });
  // the literals the resident looks for before it ever sends ':chain' (engine-windows.mjs BATCH_CHAIN_SOURCE_MARKERS)
  const v2 = name => new URL(`../src/resident-v2/${name}`, import.meta.url);
  assert.ok((await fs.readFile(v2('build-bundle.ps1'), 'utf8')).includes("$ChainContract='clued.independent-ci.resident-batch-descriptor/4'"));
  assert.ok((await fs.readFile(v2('prepare-workspaces.py'), 'utf8')).includes("DESCRIPTOR_CHAIN_CONTRACT = 'clued.independent-ci.resident-batch-descriptor/4'"));
  assert.ok((await fs.readFile(v2('invoke-stage.mjs'), 'utf8')).includes("export const TRAIN_LANDING_CHAIN_ARG = 'chain';"));
});

test('batchChainOk: one member is exactly [T, H]; several walk first parents back to T with each head as a second parent, in order', () => {
  const one = new Map([[S1, { sha: S1, tree: sha(9), parents: [T, H1] }]]);
  assert.equal(L.batchChainOk({ commits: one, baseSha: T, heads: [H1], testSha: S1 }), true);
  assert.equal(L.batchChainOk({ commits: one, baseSha: sha(8), heads: [H1], testSha: S1 }), false);
  const chain = new Map([[S1, { sha: S1, parents: [T, H1] }], [S2, { sha: S2, parents: [S1, H2] }], [S3, { sha: S3, parents: [S2, H3] }]]);
  assert.equal(L.batchChainOk({ commits: chain, baseSha: T, heads: [H1, H2, H3], testSha: S3 }), true);
  assert.equal(L.batchChainOk({ commits: chain, baseSha: T, heads: [H1, H3, H2], testSha: S3 }), false, 'order matters');
  assert.equal(L.batchChainOk({ commits: chain, baseSha: T, heads: [H2, H3], testSha: S3 }), false, 'a member left out');
  chain.set(S2, { sha: S2, parents: [S1, H2, sha(10)] });
  assert.equal(L.batchChainOk({ commits: chain, baseSha: T, heads: [H1, H2, H3], testSha: S3 }), false, 'an octopus is not a chain step');
});

test('ADR 0019 review 3: readBatchChain with the train\'s own merge results: each step must be exactly the commit that merge returned', async () => {
  const commits = new Map([[S1, { sha: S1, tree: sha(11), parents: [T, H1] }], [S2, { sha: S2, tree: sha(12), parents: [S1, H2] }], [S3, { sha: S3, tree: sha(13), parents: [S2, H3] }]]);
  const read = async s => { const c = commits.get(s); if (!c) throw new Error('404'); return structuredClone(c); };
  const heads = [H1, H2, H3];
  assert.deepEqual(await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3 }), { ok: true, tree: sha(13) });
  assert.deepEqual(await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3, steps: [S1, S2, S3] }), { ok: true, tree: sha(13) });
  // someone moved staging.tmp between two merges: step 1 is another commit of the same shape ([T, H1]) than the one the merge returned
  const E = sha(20);
  commits.set(E, { sha: E, tree: sha(21), parents: [T, H1] });
  commits.set(S2, { sha: S2, tree: sha(12), parents: [E, H2] });
  assert.equal((await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3 })).ok, true, 'the shape alone cannot tell');
  assert.deepEqual(await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3, steps: [S1, S2, S3] }), { ok: false, tree: null });
  assert.equal((await L.readBatchChain({ readGitCommit: read, baseSha: T, heads, testSha: S3, steps: [E, S2] })).ok, false, 'one step per member');
});

test('externalChecksDecision: the newest run by id of each other-App required check on the commit decides; the train-own checks are not looked at', () => {
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'gitleaks', integration_id: APP }, { context: 'ci-suites', integration_id: 15368 },
    { context: 'migration-verify', integration_id: 15368 }] } }];
  const run = (id, name, conclusion, o = {}) => ({ id, name, head_sha: S1, app: { id: 15368 }, status: 'completed', conclusion, ...o });
  const d = checks => L.externalChecksDecision({ rules, inventory: { complete: true, checks }, commitSha: S1, appId: APP });
  assert.equal(d([run(1, 'ci-suites', 'success'), run(2, 'migration-verify', 'success')]), null);
  assert.equal(d([run(1, 'ci-suites', 'success')]), L.TRAIN_LANDING_CHECKS_PENDING, 'missing');
  assert.equal(d([run(1, 'ci-suites', 'success'), run(2, 'migration-verify', null, { status: 'in_progress' })]), L.TRAIN_LANDING_CHECKS_PENDING);
  assert.equal(d([run(1, 'ci-suites', 'success'), run(2, 'migration-verify', 'failure')]), L.TRAIN_LANDING_CHECK_FAILED);
  assert.equal(d([run(3, 'ci-suites', 'failure'), run(4, 'ci-suites', 'success'), run(2, 'migration-verify', 'success')]), null, 'a newer rerun wins');
  assert.equal(d([run(5, 'ci-suites', 'failure'), run(4, 'ci-suites', 'success'), run(2, 'migration-verify', 'success')]), L.TRAIN_LANDING_CHECK_FAILED, 'the newest decides');
  assert.equal(d([run(1, 'ci-suites', 'success', { app: { id: 999 } }), run(2, 'migration-verify', 'success')]), L.TRAIN_LANDING_CHECKS_PENDING, 'another App cannot stand in');
  assert.equal(d([run(1, 'ci-suites', 'success', { head_sha: H1 }), run(2, 'migration-verify', 'success')]), L.TRAIN_LANDING_CHECKS_PENDING, 'another commit cannot stand in');
  assert.equal(L.externalChecksDecision({ rules, inventory: { complete: false, checks: [] }, commitSha: S1, appId: APP }), L.TRAIN_LANDING_CHECKS_PENDING);
});

test('landingRulesDecision and the never-published train-only check', async () => {
  const req = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: L.TRAIN_ONLY_CHECK, integration_id: APP }] } };
  assert.equal(L.landingRulesDecision([{ type: 'non_fast_forward' }, { type: 'deletion' }, req], APP), null);
  assert.equal(L.landingRulesDecision([{ type: 'deletion' }, req], APP), L.TRAIN_LANDING_RULES_MISSING);
  assert.equal(L.landingRulesDecision([{ type: 'non_fast_forward' }, req], APP), L.TRAIN_LANDING_RULES_MISSING);
  assert.equal(L.landingRulesDecision([{ type: 'non_fast_forward' }, { type: 'deletion' },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: L.TRAIN_ONLY_CHECK, integration_id: 1 }] } }], APP), L.TRAIN_LANDING_RULES_MISSING, 'pinned to this App only');
  assert.equal(RULES_TRAIN_ONLY, L.TRAIN_ONLY_CHECK);
  assert.ok(!REQUIRED_CHECK_NAMES.includes(L.TRAIN_ONLY_CHECK), 'not one of the six the train publishes');
  // stage 8's queue check: a required kooyumi-train-landed that never reports is neither a failure nor an unknown provider
  const rules = [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [...REQUIRED_CHECK_NAMES, L.TRAIN_ONLY_CHECK].map(context => ({ context, integration_id: APP })) } }];
  assert.deepEqual(requiredCheckFailure(rules, { complete: true, checks: [] }, H1, APP), []);
  // the checks port refuses to publish it, before anything is sent
  let sent = 0;
  const port = createGitHubChecksPort({ repository: REPO, repositoryId: 1, appId: APP, installationId: 2, privateKeyProvider: async () => 'k', fetchImpl: async () => { sent++; throw Error('x'); } });
  await assert.rejects(port.createCheck({ name: L.TRAIN_ONLY_CHECK, head_sha: H1, status: 'completed', conclusion: 'success', external_id: 'independent-ci:x' }), /invalid_check_publication/);
  assert.equal(sent, 0);
});

test('pickMembers and bisectAfter: the first failing prefix, the front always first, riders kept out only after the evidence', () => {
  const m = (pr, headSha = sha(100 + pr)) => ({ pr, headSha, claimId: `0000000${pr % 10}-2222-4333-8444-555555555555` });
  const F = m(1), A = m(2), B = m(3), C = m(4);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [C, A, B], max: 4 }).members.map(x => x.pr), [1, 2, 3, 4]);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [C, A, B], max: 2 }).members.map(x => x.pr), [1, 2]);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [A, B], bad: [{ pr: 2, headSha: A.headSha }], max: 4 }).members.map(x => x.pr), [1, 3]);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [A, B], bad: [{ pr: 2, headSha: sha(999) }], max: 4 }).members.map(x => x.pr), [1, 2, 3], 'a new head is not bad');
  // [F A B C] failed -> suspect it, next the first half
  let s = L.bisectAfter({ members: [F, A, B, C], landed: false });
  assert.deepEqual(s.suspect.map(x => x.pr), [1, 2, 3, 4]);
  assert.deepEqual(L.pickMembers({ front: F, candidates: [A, B, C], suspect: s.suspect, max: 4 }).members.map(x => x.pr), [1, 2]);
  // [F A] landed -> the rest [B C] is suspect, next [B] (when B is the front)
  s = L.bisectAfter({ suspect: s.suspect, members: [F, A], landed: true });
  assert.deepEqual(s.suspect.map(x => x.pr), [3, 4]);
  assert.deepEqual(L.pickMembers({ front: B, candidates: [C], suspect: s.suspect, max: 4 }).members.map(x => x.pr), [3]);
  // [B] landed -> C alone remains: kept out of riding (it is still tested alone when it is the front)
  s = L.bisectAfter({ suspect: s.suspect, members: [B], landed: true });
  assert.deepEqual([s.suspect, s.bad.map(x => x.pr)], [null, [4]]);
  // a suspect whose prefix no longer matches (a new head, another front) is dropped: normal composition again
  const drop = L.pickMembers({ front: F, candidates: [m(2, sha(555)), B], suspect: [F, A, B].map(({ pr, headSha }) => ({ pr, headSha })), max: 4 });
  assert.deepEqual([drop.suspect, drop.members.map(x => x.pr)], [null, [1, 2, 3]]);
  // a single member that failed: no suspect (the caller reports the front failed)
  assert.deepEqual(L.bisectAfter({ members: [F], landed: false }), { suspect: null, bad: [] });
});

test('landMain: landed, already landed, moved, refused, uncertain; never a second write', async () => {
  const at = { now: 0 };
  const run = async (answer, mains) => {
    let writes = 0, i = 0;
    const r = await L.landMain({ port: { async fastForwardMain() { writes++; if (answer instanceof Error) throw answer; return answer; } },
      readMain: async () => mains[Math.min(i++, mains.length - 1)], baseSha: T, testSha: S1, clock: () => at.now, sleep: async ms => { at.now += ms; } });
    return { ...r, writes };
  };
  assert.deepEqual(await run({ status: 200, sha: S1 }, [S1]), { state: 'landed', mainSha: S1, sent: true, writes: 1 });
  assert.equal((await run({ status: 422 }, [S1])).state, 'landed', 'someone pushed the same S');
  assert.equal((await run({ status: 422 }, [sha(77)])).state, 'moved');
  assert.equal((await run({ status: 422 }, [T])).state, 'refused');
  assert.equal((await run({ status: 403 }, [T])).state, 'refused');
  assert.equal((await run({ status: 502 }, [T, T, S1])).state, 'landed', 'a lost answer whose write landed');
  const lost = await run({ status: 502 }, [T]);
  assert.deepEqual([lost.state, lost.writes], ['uncertain', 1]);
  assert.equal((await run(new Error('cut'), [sha(77)])).state, 'uncertain');
  assert.equal((await run({ status: null, notSent: true }, [T])).state, 'refused', 'never left this host');
  await assert.rejects(L.landMain({ port: {}, readMain: async () => T, baseSha: T, testSha: S1 }), /TRAIN_LANDING_INPUT_REFUSED/);
});

test('landing port: a contents-write token of exactly this repository; main only fast-forward; only the train refs; merges into staging.tmp only', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const calls = [];
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  let minted = { token: 't', expires_at: new Date(Date.now() + 3_000_000).toISOString(), permissions: { ...LANDING_PERMISSIONS, metadata: 'read' }, repositories: [{ id: 11, full_name: REPO }] };
  const fetchImpl = async (url, o) => {
    calls.push([o.method, url.replace('https://api.github.com', ''), o.body ? JSON.parse(o.body) : null]);
    if (url.endsWith('/app')) return reply(200, { id: APP });
    if (url.includes('/access_tokens')) return reply(201, minted);
    if (url.endsWith('/merges')) return reply(201, { sha: S2 });
    return reply(200, { object: { sha: JSON.parse(o.body).sha } });
  };
  const port = createLandingPort({ repository: REPO, repositoryId: 11, appId: APP, installationId: 22, privateKeyProvider: async () => pem, fetchImpl });
  assert.deepEqual(await port.fastForwardMain(S1), { status: 200, sha: S1, notSent: false });
  const mint = calls.find(c => c[1].includes('/access_tokens'));
  assert.deepEqual(mint[2], { repository_ids: [11], permissions: { contents: 'write', workflows: 'write' } });
  assert.deepEqual(calls.at(-1), ['PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: S1, force: false }]);
  await port.pointRef(L.STAGING_REF, S2);
  assert.deepEqual(calls.at(-1), ['PATCH', `/repos/${REPO}/git/refs/heads/clued-train/staging`, { sha: S2, force: true }]);
  await port.mergeIntoTmp(H1, 'm');
  assert.deepEqual(calls.at(-1), ['POST', `/repos/${REPO}/merges`, { base: 'clued-train/staging.tmp', head: H1, commit_message: 'm' }]);
  const n = calls.length;
  for (const ref of ['heads/main', 'heads/other', 'tags/v1', 'heads/clued-train/x']) await assert.rejects(port.pointRef(ref, S1), /LANDING_REF_REFUSED/);
  await assert.rejects(port.fastForwardMain('nope'), /LANDING_REF_REFUSED/);
  assert.equal(calls.length, n, 'refused before anything was sent');
  // a token with more (or other) permissions, or another repository, is never used
  for (const wrong of [{ permissions: { ...LANDING_PERMISSIONS, metadata: 'read', checks: 'write' } }, { permissions: { contents: 'write', metadata: 'read' } },
    { repositories: [{ id: 12, full_name: REPO }] }, { repositories: [{ id: 11, full_name: REPO }, { id: 12, full_name: 'x/y' }] }]) {
    minted = { ...minted, ...wrong, permissions: wrong.permissions ?? { ...LANDING_PERMISSIONS, metadata: 'read' }, repositories: wrong.repositories ?? [{ id: 11, full_name: REPO }] };
    const p = createLandingPort({ repository: REPO, repositoryId: 11, appId: APP, installationId: 22, privateKeyProvider: async () => pem, fetchImpl });
    await assert.rejects(p.fastForwardMain(S1), /unexpected_installation_token_scope/);
  }
  for (const appId of [5164952, 5365273]) assert.throws(() => createLandingPort({ repository: REPO, repositoryId: 11, appId, installationId: 22, privateKeyProvider: async () => pem, fetchImpl }), /invalid_landing_configuration/);
});

test('landing records: exact batch records (the front first), the landing state (newest; a newer torn one is unreadable)', async t => {
  const store = await TrainSweepStore.open(path.join(await tempDir(t), 'sweep'));
  const runId = '0123456789abcdef-0123456789ab', claimId = '11111111-2222-4333-8444-555555555555';
  const batch = { writtenAt: '2026-11-07T00:00:00.000Z', runId, frontPr: 910, frontHeadSha: H1, baseSha: T, testSha: S2, testTree: sha(9), attempt: 1,
    members: [{ pr: 910, headSha: H1, claimId }, { pr: 911, headSha: H2, claimId }] };
  await store.appendLandingBatch(batch);
  assert.deepEqual((await store.landingBatchByTest(S2)).members.map(m => m.pr), [910, 911]);
  assert.equal(await store.landingBatchByTest(S3), null);
  await assert.rejects(store.appendLandingBatch({ ...batch, members: [batch.members[1], batch.members[0]] }), /invalid_train_landing_batch/);
  await assert.rejects(store.appendLandingBatch({ ...batch, members: [...batch.members, ...batch.members, batch.members[0]] }), /invalid_train_landing_batch/);
  assert.deepEqual(await store.readLandingState(), { bad: [], suspect: null, adopted: [], handled: [] });
  await store.writeLandingState({ writtenAt: '2026-11-07T00:00:01.000Z', runId, bad: [{ pr: 911, headSha: H2 }], suspect: null, adopted: [S2], handled: [] });
  assert.deepEqual(await store.readLandingState(), { bad: [{ pr: 911, headSha: H2 }], suspect: null, adopted: [S2], handled: [] });
  await fs.writeFile(path.join(store.directory, `landing-state-${Date.parse('2026-11-07T00:00:02.000Z')}-${runId}-00000000.json`), 'torn');
  const fresh = await TrainSweepStore.open(store.directory);
  await assert.rejects(fresh.readLandingState(), /TRAIN_LANDING_STATE_UNREADABLE/);
});
