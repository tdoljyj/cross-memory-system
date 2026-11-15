// Task 4a: the node proves for itself that its Linux side is used once and thrown away (DESIGN §70.7): the companion's lane runs the root
// tool's `selfcheck` between batches, keeps the answer whole in upgrade\mailbox\responses\selfcheck.json, and the resident shows it in
// status /8 `versions.selfcheck` (a failure is also a notice). End to end over the real mailbox directory, the real lane and the real
// status reader; the only fake is `wsl --user root --exec <linux tool> selfcheck`, which answers what the real tool prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../src/canonical.mjs';
import { COMPANION_CONFIG_CONTRACT, UpgradeLane, argv, validateCompanionConfig } from '../src/companion.mjs';
import { STATUS_CONTRACT, StatusBoard, parseStatus, readVersionState } from '../src/status.mjs';
import { events } from '../src/pr-status.mjs';
import { LINUX_SELFCHECK_CONTRACT, SELFCHECK_BUSY_RETRY_MS, SELFCHECK_FILE, SELFCHECK_FRESH_MS, SELFCHECK_REFRESH_MS, readSelfcheck } from '../src/selfcheck.mjs';
import { UpgradeMailbox } from '../src/upgrade-mailbox.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { TEST_NODE, TEST_NODE_SHA, rawPolicy, tempRoot } from './helpers.mjs';

const T0 = Date.parse('2026-11-15T08:00:00Z');
const policy = validatePolicy(rawPolicy());
const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });

// What the real tool prints for the two states it can answer with (linux/bin/clued-ci-resident-linux#selfcheck).
const done = (view = {}, containers = {}) => ({ contract: LINUX_SELFCHECK_CONTRACT, at: new Date(T0).toISOString(), state: 'DONE',
  view: { ok: true, code: null, failures: [], ...view }, containers: { count: 0, code: null, ...containers } });
const busy = { contract: LINUX_SELFCHECK_CONTRACT, at: new Date(T0).toISOString(), state: 'BUSY' };

async function node(t) {
  const root = await tempRoot(t);
  let now = T0;
  const box = await UpgradeMailbox.open(path.join(root, 'upgrade', 'mailbox'), () => now);
  const linux = { answer: done(), exit: 0, calls: [] };
  const run = async (a, o) => {
    const linuxArgv = a.slice(11);
    linux.calls.push({ argv: linuxArgv, timeoutMs: o?.timeoutMs });
    if (linuxArgv[0] !== cfg.linuxTool || linuxArgv[1] !== 'selfcheck') return { code: 1, stdout: '' };
    return { code: linux.exit, stdout: typeof linux.answer === 'string' ? linux.answer : JSON.stringify(linux.answer) + '\n' };
  };
  const lane = new UpgradeLane({ cfg, mailbox: box, run, clock: () => now });
  return { root, box, lane, linux, advance: ms => { now += ms; }, now: () => now,
    state: () => readVersionState({ root, policy, clock: () => now }) };
}

test('selfcheck: the fixed root argv is the tool\'s selfcheck and nothing else', () => {
  assert.deepEqual(argv(cfg).selfcheck(), [cfg.wslExe, '--distribution', cfg.distribution, '--user', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C',
    'LC_ALL=C', cfg.linuxTool, 'selfcheck']);
});

test('selfcheck: before the first run there is no file and no view; the first pass writes a PASS the status shows', async t => {
  const h = await node(t);
  assert.equal((await h.state()).view.selfcheck, null);
  assert.equal(await h.lane.selfcheckStep(), true);
  assert.deepEqual(h.linux.calls.map(c => c.argv.slice(1)), [['selfcheck']]);
  assert.ok(h.linux.calls[0].timeoutMs <= 150_000);
  const s = await h.state();
  assert.deepEqual(s.view.selfcheck, { observedAt: new Date(T0).toISOString(), result: 'PASS', viewOk: true, viewCode: null, failures: [], containers: 0, containerCode: null });
  assert.deepEqual(s.notices, []);
  // due again only after SELFCHECK_REFRESH_MS
  h.advance(SELFCHECK_REFRESH_MS - 1);
  assert.equal(await h.lane.selfcheckStep(), false);
  assert.equal(h.linux.calls.length, 1);
  h.advance(1);
  assert.equal(await h.lane.selfcheckStep(), true);
  assert.equal(h.linux.calls.length, 2);
});

test('selfcheck: a failing view probe is reported with the check\'s own codes, as FAIL and as a notice', async t => {
  const h = await node(t);
  h.linux.answer = done({ ok: false, code: 'WORKER_VIEW_CHECK_FAILED', failures: ['EARLIER_ARCHIVES_VISIBLE', 'WINDOWS_PATHS_VISIBLE'] });
  assert.equal(await h.lane.selfcheckStep(), true);
  const s = await h.state();
  assert.equal(s.view.selfcheck.result, 'FAIL');
  assert.equal(s.view.selfcheck.viewOk, false);
  assert.equal(s.view.selfcheck.viewCode, 'WORKER_VIEW_CHECK_FAILED');
  assert.deepEqual(s.view.selfcheck.failures, ['EARLIER_ARCHIVES_VISIBLE', 'WINDOWS_PATHS_VISIBLE']);
  assert.deepEqual(s.notices.map(n => [n.kind, n.code]), [['selfcheck-failed', 'WORKER_VIEW_CHECK_FAILED']]);
  // the notice reaches the PR page status text with the code (never silent)
  const shown = events({ status: parseStatus(await statusBytes(s)), now: T0 }).filter(e => /自检/.test(e.title));
  assert.equal(shown.length, 1);
  assert.match(shown[0].body, /WORKER_VIEW_CHECK_FAILED/);
});

test('selfcheck: a leftover labelled container between batches is reported as it is (the count), and an unreadable list is a failure, never zero', async t => {
  const h = await node(t);
  h.linux.answer = done({}, { count: 2 });
  await h.lane.selfcheckStep();
  let s = await h.state();
  assert.deepEqual([s.view.selfcheck.result, s.view.selfcheck.containers, s.view.selfcheck.viewOk], ['FAIL', 2, true]);
  assert.deepEqual(s.notices.map(n => [n.kind, n.code]), [['selfcheck-failed', 'EARLIER_CONTAINER_PRESENT']]);
  h.advance(SELFCHECK_REFRESH_MS);
  h.linux.answer = done({}, { count: null, code: 'DOCKER_READ_UNCONFIRMED' });
  await h.lane.selfcheckStep();
  s = await h.state();
  assert.deepEqual([s.view.selfcheck.result, s.view.selfcheck.containers, s.view.selfcheck.containerCode], ['FAIL', null, 'DOCKER_READ_UNCONFIRMED']);
  // the next clean answer clears both
  h.advance(SELFCHECK_REFRESH_MS);
  h.linux.answer = done();
  await h.lane.selfcheckStep();
  s = await h.state();
  assert.deepEqual([s.view.selfcheck.result, s.notices], ['PASS', []]);
});

test('selfcheck: BUSY, a refusal, a timeout and torn output write nothing (the old result stays, its age tells) and are tried again after a minute', async t => {
  const h = await node(t);
  await h.lane.selfcheckStep();
  const first = await fs.readFile(path.join(h.box.responses, SELFCHECK_FILE), 'utf8');
  for (const bad of [{ answer: busy }, { answer: { status: 'REFUSED', code: 'SYSTEMCTL_LIST_UNCONFIRMED' }, exit: 1 }, { answer: '{"contract":' }, { answer: done({ ok: 'yes' }) },
    { answer: { ...done(), contract: 'other/1' } }]) {
    h.advance(SELFCHECK_REFRESH_MS);
    Object.assign(h.linux, { exit: 0, ...bad });
    const calls = h.linux.calls.length;
    assert.equal(await h.lane.selfcheckStep(), false);
    assert.equal(h.linux.calls.length, calls + 1);
    assert.equal(await fs.readFile(path.join(h.box.responses, SELFCHECK_FILE), 'utf8'), first);
    assert.equal(await h.lane.selfcheckStep(), false, 'not again within the retry time');
    assert.equal(h.linux.calls.length, calls + 1);
    h.advance(SELFCHECK_BUSY_RETRY_MS - 1);
    assert.equal(await h.lane.selfcheckStep(), false);
    assert.equal(h.linux.calls.length, calls + 1);
    h.advance(1);
  }
  // after the last bad answer the next due run (a minute on) succeeds
  Object.assign(h.linux, { exit: 0, answer: done() });
  assert.equal(await h.lane.selfcheckStep(), true);
});

test('selfcheck: a result nobody renewed is STALE (never the old verdict) and raises no notice', async t => {
  const h = await node(t);
  h.linux.answer = done({ ok: false, code: 'WORKER_VIEW_CHECK_FAILED', failures: [] });
  await h.lane.selfcheckStep();
  assert.equal((await h.state()).view.selfcheck.result, 'FAIL');
  h.advance(SELFCHECK_FRESH_MS + 1);
  const s = await h.state();
  assert.equal(s.view.selfcheck.result, 'STALE');
  assert.deepEqual(s.notices, []);
});

test('selfcheck: a node without the upgrade mailbox, a failing helper or a bad file never throws and never stops anything', async t => {
  const root = await tempRoot(t);
  const lane = new UpgradeLane({ cfg, run: async () => { throw new Error('wsl gone'); }, clock: () => T0, openMailbox: async () => { throw new Error('absent'); } });
  assert.equal(await lane.selfcheckStep(), false);
  const h = await node(t);
  h.lane.run = async () => { throw new Error('wsl gone'); };
  assert.equal(await h.lane.selfcheckStep(), false);
  await fs.writeFile(path.join(h.box.responses, SELFCHECK_FILE), '{"torn":');
  assert.equal(await readSelfcheck(h.box.responses), null);
  const s = await readVersionState({ root: h.root, policy, clock: () => T0 });
  assert.equal(s.view.selfcheck, null);
  assert.deepEqual(s.notices, []);
  assert.ok(root);
});

test('selfcheck: status /8 carries it through the board and the reader; a status without it (an older executor) reads as null', async () => {
  const board = new StatusBoard({ clock: () => T0 });
  const view = { generation: 2, windows: { packageManifestSha256: 'c'.repeat(64), residentManifestSha256: 'a'.repeat(64), ciSourceManifestSha256: 'b'.repeat(64), policySha256: null },
    linux: null, consistent: null, upgrade: null,
    selfcheck: { observedAt: new Date(T0).toISOString(), result: 'FAIL', viewOk: false, viewCode: 'WORKER_VIEW_CHECK_FAILED', failures: ['EARLIER_ARCHIVES_VISIBLE', 'not a code'], containers: 0, containerCode: null } };
  board.setVersions(view);
  const parsed = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  assert.equal(parsed.versions.selfcheck.result, 'FAIL');
  assert.deepEqual(parsed.versions.selfcheck.failures, ['EARLIER_ARCHIVES_VISIBLE']);
  board.setVersions({ ...view, selfcheck: { result: 'PASS' } });
  assert.equal(parseStatus(Buffer.from(JSON.stringify(board.snapshot()))).versions.selfcheck, null);
  assert.equal(STATUS_CONTRACT, 'clued.independent-ci.resident-status/8');
});

async function statusBytes(state) {
  const board = new StatusBoard({ clock: () => T0 });
  board.setVersions(state.view);
  board.update({ notices: state.notices });
  return Buffer.from(JSON.stringify(board.snapshot()));
}

test('selfcheck: the file is the canonical document the lane wrote, nothing else in it', async t => {
  const h = await node(t);
  await h.lane.selfcheckStep();
  const doc = JSON.parse(await fs.readFile(path.join(h.box.responses, SELFCHECK_FILE), 'utf8'));
  assert.equal(await fs.readFile(path.join(h.box.responses, SELFCHECK_FILE), 'utf8'), canonicalJson(doc) + '\n');
  assert.deepEqual(Object.keys(doc).sort(), ['at', 'containers', 'contract', 'observedAt', 'view']);
});
