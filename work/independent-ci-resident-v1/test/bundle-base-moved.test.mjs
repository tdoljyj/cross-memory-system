// Field defect 2026-11-14 (TURING): main moved (PR #1103 merged at 12:00:14Z) while Dependabot PRs #594 and #942 waited in the run
// queue with the old main as their base. build-bundle.ps1 refused each of them (refs/heads/main in its fresh store was 3572b64d, the
// descriptor's baseSha 01049279: REMOTE_MAIN_BASE_CHANGED), the companion answered BUNDLE_UNAVAILABLE, the executor counted it as an
// environment fault, and three of those opened the breaker: every other PR waited an hour. The refusal is a fact about that one
// subject (GitHub's main is no longer its base; no retry of the same subject can pass), not about the node: the companion says so
// (RESIDENT_BASE_MOVED, the code stage 8 already uses for main moving), the executor stops that row alone without the breaker, and a real environment fault still opens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMPANION_CONFIG_CONTRACT, Companion, validateCompanionConfig } from '../src/companion.mjs';
import { describe } from '../src/pr-status.mjs';
import { TEST_NODE, TEST_NODE_SHA, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const H = n => String(n).repeat(40).slice(0, 40);
const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
// build-bundle.ps1's answer for a refusal (exit 2), as on TURING: the store was fetched, main was not the descriptor's base.
const refusal = reason => ({ code: 2, stdout: JSON.stringify({ status: 'PARTIAL_STATE_PRESERVED_NO_RETRY', stage: 'fetched-store-readback', reason,
  git: { label: 'for-each-ref', exitCode: 0, stderrChars: 0 }, storeAttempts: 1, failedAttempts: [] }), stderr: '' });
const companion = run => new Companion({ cfg, mailbox: null, run, fileExists: async () => true, sleep: async () => {}, clock: () => 0, log: async () => {} });
const bundleRequest = { kind: 'build-bundle', batchId: '0123456789abcdef-0123456789ab' };

test('the companion answers a bundle refused because main is no longer the batch base as RESIDENT_BASE_MOVED; every other refusal as before', async () => {
  const ps = fs.readFileSync(new URL('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');
  assert.ok(ps.includes("throw 'REMOTE_MAIN_BASE_CHANGED'"), 'the script names the refusal');
  assert.deepEqual(await companion(async () => refusal('REMOTE_MAIN_BASE_CHANGED')).handle(bundleRequest), { ok: false, code: 'RESIDENT_BASE_MOVED' });
  for (const [r, code] of [[refusal('HEAD_BASE_SOURCE_COMMIT_MISSING'), 'BUNDLE_UNAVAILABLE'], [refusal('FETCHED_REFS_DIFFER_FROM_LS_REMOTE'), 'BUNDLE_UNAVAILABLE'],
    [{ code: 1, stdout: refusal('REMOTE_MAIN_BASE_CHANGED').stdout }, 'BUNDLE_UNAVAILABLE'], [{ code: null, timedOut: true, stdout: '' }, 'BUNDLE_UNAVAILABLE']])
    assert.deepEqual(await companion(async () => r).handle(bundleRequest), { ok: false, code }, r.stdout?.slice(0, 120));
});

// The executor on its run queue with a companion whose bundle answer depends on the PR.
async function fixture(t, per) {
  const engine = fakeEngine();
  const derive = engine.derive;
  engine.derive = async (s, key) => ({ ...(await derive(s, key)), pr: s.pr });
  const bundles = [];
  const comp = { calls: [], async heartbeat() { return { at: f.clock() }; }, async buildBundle(batch) { bundles.push(batch.pr); return per[batch.pr] ?? { ok: true }; },
    async prepareWorkspaces() { return { ok: true }; }, async linuxQuiescence() { return { linuxUnitsInactive: true, containersZero: true }; },
    async archiveLinux(batch, reason) { return { verified: true, directory: `failed-x-${reason}-111111111111` }; }, async prHead() { return null; } };
  const f = await executorFixture(t, { engine, companion: comp });
  f.bundles = bundles;
  return f;
}

test('main moved under three queued PRs: each stops alone (RESIDENT_BASE_MOVED), the breaker stays closed and the PR behind them runs', async t => {
  const moved = { ok: false, code: 'RESIDENT_BASE_MOVED' };
  const f = await fixture(t, { 1: moved, 2: moved, 3: moved });
  for (const n of [1, 2, 3, 4]) await f.drop(triggerBytes({ pr: n, headSha: H(n) }));
  for (const n of [1, 2, 3]) {
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['NOT_EXECUTED', 'RESIDENT_BASE_MOVED'], `PR ${n}: ${JSON.stringify(r)}`);
    assert.deepEqual([f.queue.row(n).state, f.queue.row(n).reason], ['STOPPED', 'RESIDENT_BASE_MOVED'], `PR ${n} stops: its base can never pass again`);
  }
  assert.equal(f.queue.breaker?.state ?? 'closed', 'closed', 'a stale base is no environment fault');
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'PR 4 runs at once');
  assert.equal((await f.ledger.usage(f.clock() - 24 * 60 * MIN)).releasesByHead.get(H(1)) ?? 0, 0, 'not counted towards the head\'s release cap');
  // the stopped rows are not tried again with the same base: only a new commit (the PR brought up to main) runs that PR again
  f.advance(3 * 60 * MIN);
  await f.exec.tick();
  assert.deepEqual(f.bundles, [1, 2, 3, 4]);
  // the PR status says what to do
  const now = f.clock();
  const said = describe({ pull: { pr: 1, headSha: H(1), eligible: true }, now,
    status: { writtenAt: now, current: null, pending: [], recent: [{ pr: 1, headSha: H(1), outcome: 'NOT_EXECUTED', code: 'RESIDENT_BASE_MOVED' }] } });
  assert.deepEqual(said, { state: 'failure', description: 'main 已移动：请合入最新 main 并推新提交' });
});

test('a real environment fault of the bundle still counts: three of them open the breaker and the PR behind them waits', async t => {
  const env = { ok: false, code: 'BUNDLE_UNAVAILABLE' };
  const f = await fixture(t, { 1: env, 2: env, 3: env });
  for (const n of [1, 2, 3, 4]) await f.drop(triggerBytes({ pr: n, headSha: H(n) }));
  for (const n of [1, 2, 3]) assert.deepEqual((await f.exec.tick()).failureCode, 'BUNDLE_UNAVAILABLE', `PR ${n}`);
  assert.equal(f.queue.breaker.state, 'open');
  assert.equal((await f.exec.tick()).reason, 'BREAKER_OPEN');
});
