// The resident's side of the in-place upgrade channel (Task 018da927, spec B4, DESIGN §34): status /7 `versions` and its notices, the
// version-skew intake hold, the service-start generation and the 'resident-upgraded' receipt, the upgrader's resume through owner\ only,
// the engine's version gate before the first Linux stage and its failure-table rows, the companion's upgrade mailbox lane and its
// strict root-tool argv, the notifications and the Owner tool's inspect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from '../src/canonical.mjs';
import { STATUS_CONTRACT, StatusBoard, StatusFile, parseStatus, parseVersions, readStatus, readVersionState, versionNotices, versionsView } from '../src/status.mjs';
import { UPGRADE_RESUME_CONTRACT, UPGRADE_VERSION_SKEW, VERSION_SKEW_HOLDER, VERSION_SKEW_RENEW_BELOW_MS } from '../src/executor.mjs';
import { recordServiceStart } from '../src/service-main.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { WindowsEngine } from '../src/engine-windows.mjs';
import { decideFailure, failureRow } from '../src/classify.mjs';
import { COMPANION_CONFIG_CONTRACT, UPGRADE_REQUEST_EXPIRED, UpgradeLane, VERSION_FACTS_RETRY_MS, argv, upgradeToolArgvOk, validateCompanionConfig } from '../src/companion.mjs';
import { UPGRADE_TOOL_PATH, UpgradeMailbox, VERSION_FACTS_REFRESH_MS, upgradeResumeRequest } from '../src/upgrade-mailbox.mjs';
import { events } from '../src/pr-status.mjs';
import { failureView, inspectUpgrade } from '../tools/rearm-tool.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { BASE, CI_SOURCE, CLEAN_PROOF, HEAD, RESIDENT, TEST_NODE, TEST_NODE_SHA, executorFixture, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';
import { headKey } from '../src/ledger.mjs';

const T0 = Date.parse('2026-10-29T08:00:00Z');
const OP = '0a1b2c3d-0000-4000-8000-0000000000aa';
const PKG = 'c'.repeat(64), LINUX_MANIFEST = 'd'.repeat(64), POLICY_SHA = '7'.repeat(64);
const current = (over = {}) => ({ contract: 'clued.independent-ci.resident-generation/1', generation: 2, packageManifestSha256: PKG, residentManifestSha256: RESIDENT,
  ciSourceManifestSha256: CI_SOURCE, policySha256: POLICY_SHA, installReceiptSha256: '8'.repeat(64), stateCompat: { schema: 1, readableBySchemas: [1] },
  linux: { generation: 2, manifestSha256: LINUX_MANIFEST, ciSourceManifestSha256: CI_SOURCE }, opId: OP, at: new Date(T0 - 3_600_000).toISOString(), ...over });
const facts = (over = {}) => ({ contract: 'clued.independent-ci.linux-version-facts/1', generation: 2, ciSourceManifestSha256: CI_SOURCE, sourceCommit: 'a'.repeat(40),
  manifestSha256: LINUX_MANIFEST, roles: { gitleaks: { policySha256: '1'.repeat(64), qualificationSha256: '2'.repeat(64) } }, pinsOk: true, staged: null,
  upgradeToolSha256: '9'.repeat(64), observedAt: new Date(T0 - 60_000).toISOString(), ...over });
const upgradeStatus = (op, recent = []) => ({ contract: 'clued.independent-ci.resident-upgrade-status/1', writtenAt: new Date(T0).toISOString(), upgraderPid: 1,
  current: { generation: 2, packageManifestSha256: PKG }, op, recent, generations: [] });
const op = (state, over = {}) => ({ opId: OP, node: 'fixture-node', fromGeneration: 2, toGeneration: 3, packageManifestSha256: 'e'.repeat(64), state, phase: 'grant',
  phaseSince: new Date(T0 - 120_000).toISOString(), code: null, grant: { requestId: OP, confirmUrl: `https://kooyomi.example/confirm/${OP}`, status: 'pending', grantId: null },
  drain: null, pausedBy: null, ...over });
const policy = validatePolicy(rawPolicy());
const headKeyOf = () => headKey({ repo: policy.repo, pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: policy.sourceManifestSha256, attempt: 1 });

async function upgradeRoot(t, { cur = current(), fx = facts(), status = null } = {}) {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'upgrade', 'mailbox', 'requests'), { recursive: true });
  await fs.mkdir(path.join(root, 'upgrade', 'mailbox', 'responses'), { recursive: true });
  if (cur) await fs.writeFile(path.join(root, 'upgrade', 'current.json'), canonicalJson(cur) + '\n');
  if (fx) await fs.writeFile(path.join(root, 'upgrade', 'mailbox', 'responses', 'version-facts.json'), canonicalJson(fx) + '\n');
  if (status) await fs.writeFile(path.join(root, 'upgrade', 'status.json'), canonicalJson(status) + '\n');
  return root;
}

// ---------------- status /7 ----------------

test('status /7: versions from the three files; consistent true, false (generation, Source, manifest, pins) or null (stale, none, unreadable)', async t => {
  const root = await upgradeRoot(t, { status: upgradeStatus(op('WAITING_GRANT')) });
  const s = await readVersionState({ root, policy, policySha256: POLICY_SHA, clock: () => T0 });
  assert.deepEqual(s.view, { localInstallGeneration: 2, installedPackage: { packageGeneration: null, version: null, releaseTag: null, commit: null,
    archiveSha256: null, ciSourceManifestSha256: null, status: 'unmarked', display: '未标注', observedAt: null },
    windows: { packageManifestSha256: PKG, residentManifestSha256: RESIDENT, ciSourceManifestSha256: CI_SOURCE, policySha256: POLICY_SHA },
    linux: { observedAt: new Date(T0 - 60_000).toISOString(), localInstallGeneration: 2, ciSourceManifestSha256: CI_SOURCE, manifestSha256: LINUX_MANIFEST, pinsOk: true }, consistent: true, selfcheck: null,
    upgrade: { opId: OP, state: 'WAITING_GRANT', phase: 'grant', since: new Date(T0 - 120_000).toISOString(), code: null, confirmUrl: `https://kooyomi.example/confirm/${OP}` } });
  assert.deepEqual(s.notices.map(n => n.kind), ['upgrade-grant-pending']);
  const view = inputs => versionsView(inputs, { policy, now: T0 }).consistent;
  assert.equal(view({ current: current(), facts: facts({ generation: 1 }), status: null }), false, 'another generation');
  assert.equal(view({ current: current(), facts: facts({ ciSourceManifestSha256: 'f'.repeat(64) }), status: null }), false, 'another Source');
  assert.equal(view({ current: current(), facts: facts({ manifestSha256: 'f'.repeat(64) }), status: null }), false, 'another Linux manifest');
  assert.equal(view({ current: current(), facts: facts({ pinsOk: false }), status: null }), false, 'pins broken');
  assert.equal(view({ current: current(), facts: facts({ observedAt: new Date(T0 - 16 * 60_000).toISOString() }), status: null }), null, 'facts older than 15 minutes');
  assert.equal(view({ current: null, facts: facts(), status: null }), null, 'no current.json');
  assert.equal(view({ current: current(), facts: null, status: null }), null, 'no facts');
  assert.equal(view({ current: current({ linux: null }), facts: facts(), status: null }), null, 'no Linux half recorded');
  // a missing upgrade\ directory, or torn files, are unknown, never an error
  const bare = await tempRoot(t);
  assert.deepEqual((await readVersionState({ root: bare, policy, clock: () => T0 })).view.consistent, null);
  await fs.mkdir(path.join(bare, 'upgrade'));
  await fs.writeFile(path.join(bare, 'upgrade', 'current.json'), '{"contract":');
  const torn = await readVersionState({ root: bare, policy, clock: () => T0 });
  assert.deepEqual([torn.view.localInstallGeneration, torn.view.linux, torn.view.consistent, torn.view.upgrade, torn.notices], [null, null, null, null, []]);
});

test('status /8 is written and read back with versions; /6 and /5 files still read (versions null); the shape is re-checked', async t => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'state'));
  const b = new StatusBoard({ clock: () => T0 });
  const view = versionsView({ current: current(), facts: facts({ generation: 1 }), status: upgradeStatus(op('DEFERRED', { code: 'UPGRADE_DRAIN_TIMEOUT' })) }, { policy, policySha256: POLICY_SHA, now: T0 });
  assert.equal(b.setVersions(view), true);
  assert.equal(b.setVersions(view), false, 'unchanged');
  await new StatusFile(path.join(root, 'state', 'status.json')).write(b.snapshot());
  const s = await readStatus(root);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'state', 'status.json'), 'utf8')).contract, STATUS_CONTRACT);
  assert.deepEqual(s.versions, view);
  assert.deepEqual([s.versions.consistent, s.versions.upgrade.state, s.versions.upgrade.code], [false, 'DEFERRED', 'UPGRADE_DRAIN_TIMEOUT']);
  const { versions, timing, ...v6 } = b.snapshot();
  for (const contract of ['clued.independent-ci.resident-status/6', 'clued.independent-ci.resident-status/5']) assert.equal(parseStatus(Buffer.from(JSON.stringify({ ...v6, contract }))).versions, null, contract);
  assert.throws(() => parseStatus(Buffer.from(JSON.stringify({ ...v6, contract: STATUS_CONTRACT }))), { code: 'STATUS_REFUSED' }, '/8 without versions');
  const v7 = { ...v6, versions, contract: 'clued.independent-ci.resident-status/7' };
  assert.deepEqual(parseStatus(Buffer.from(JSON.stringify(v7))).versions, view, '/7 still reads with versions');
  assert.equal(parseStatus(Buffer.from(JSON.stringify(v7))).timing, null, '/7 has no timing');
  assert.throws(() => parseStatus(Buffer.from(JSON.stringify({ ...v7, timing }))), { code: 'STATUS_REFUSED' }, '/7 with timing');
  assert.throws(() => parseStatus(Buffer.from(JSON.stringify({ ...b.snapshot(), contract: 'clued.independent-ci.resident-status/6' }))), { code: 'STATUS_REFUSED' }, '/6 with versions');
  // what does not fit is shown as nothing, never trusted
  assert.equal(parseVersions({ windows: { residentManifestSha256: 'x' } }), null);
  const odd = parseVersions({ ...view, localInstallGeneration: 0, upgrade: { ...view.upgrade, confirmUrl: 'javascript:alert(1)', phase: 'Not A Phase', code: 'free text' } });
  assert.deepEqual([odd.localInstallGeneration, odd.upgrade.confirmUrl, odd.upgrade.phase, odd.upgrade.code], [null, null, null, null]);
  assert.equal(parseVersions({ ...view, upgrade: { ...view.upgrade, state: 'SOMETHING' } }).upgrade, null);
});

test('status /7 notices: version-skew, grant pending, deferred, rolled back and rollback failed (current op or recent), one key each', () => {
  const v = (cur, fx, st) => versionsView({ current: cur, facts: fx, status: st }, { policy, now: T0 });
  const kinds = (cur, fx, st) => versionNotices(v(cur, fx, st), st).map(n => [n.kind, n.key, n.code]);
  assert.deepEqual(kinds(current(), facts({ generation: 1 }), null), [['version-skew', 'version-skew:w2:l1', UPGRADE_VERSION_SKEW]]);
  assert.deepEqual(kinds(current(), facts(), upgradeStatus(op('WAITING_GRANT'))), [['upgrade-grant-pending', `upgrade-grant-pending:${OP}`, null]]);
  assert.deepEqual(kinds(current(), facts(), upgradeStatus(op('DEFERRED', { code: 'UPGRADE_RESIDENT_HALTED' }))), [['upgrade-deferred', `upgrade-deferred:${OP}:UPGRADE_RESIDENT_HALTED`, 'UPGRADE_RESIDENT_HALTED']]);
  assert.deepEqual(kinds(current(), facts(), upgradeStatus(op('ROLLED_BACK_PAUSED', { code: 'UPGRADE_VERIFY_FAILED' }), [{ opId: OP, outcome: 'ROLLED_BACK_PAUSED', code: 'UPGRADE_VERIFY_FAILED', at: new Date(T0).toISOString() }])),
    [['upgrade-rolled-back', `upgrade-rolled-back:${OP}`, 'UPGRADE_VERIFY_FAILED']], 'the same op once');
  const other = '0a1b2c3d-0000-4000-8000-0000000000bb';
  assert.deepEqual(kinds(current(), facts(), upgradeStatus(null, [{ opId: other, outcome: 'ROLLBACK_FAILED', code: 'UPGRADE_ROLLBACK_FAILED' }, { opId: OP, outcome: 'SUCCEEDED', code: null }])),
    [['upgrade-rollback-failed', `upgrade-rollback-failed:${other}`, 'UPGRADE_ROLLBACK_FAILED']]);
  assert.deepEqual(kinds(current(), facts({ observedAt: new Date(T0 - 20 * 60_000).toISOString() }), null), [], 'unknown is no skew');
  // the companion turns each into a Windows notification
  const status = { writtenAt: T0, halt: null, pending: [], versions: v(current(), facts({ generation: 1 }), upgradeStatus(op('WAITING_GRANT'))),
    notices: versionNotices(v(current(), facts({ generation: 1 }), upgradeStatus(op('WAITING_GRANT'))), null).map(n => ({ ...n, at: null, until: null })) };
  const ev = events({ status, now: T0 });
  assert.deepEqual(ev.map(e => e.key), ['notice:version-skew:w2:l1', `notice:upgrade-grant-pending:${OP}`]);
  assert.match(ev[1].body, /https:\/\/kooyomi\.example\/confirm\//);
  for (const kind of ['upgrade-deferred', 'upgrade-rolled-back', 'upgrade-rollback-failed']) {
    const e = events({ status: { ...status, notices: [{ key: `${kind}:${OP}`, kind, pr: null, headSha: null, code: 'UPGRADE_X', at: null, until: null }] }, now: T0 });
    assert.equal(e.length, 1, kind); assert.match(e[0].body, /UPGRADE_X/);
  }
});

// ---------------- the version-skew hold ----------------

test('version skew: consistent false holds new batches (holder version-skew, renewed below 90 min), null changes nothing, true lifts it', async t => {
  const status = new StatusBoard({ clock: () => T0 });
  const f = await executorFixture(t, { now: T0, status });
  let state = { view: versionsView({ current: current(), facts: facts({ generation: 1 }), status: null }, { policy, now: T0 }), notices: [] };
  f.exec.versions = async () => state;
  await f.drop(triggerBytes());
  const r1 = await f.exec.tick();
  assert.deepEqual([r1.state, r1.reason], ['DEFERRED', 'INTAKE_PAUSED']);
  assert.deepEqual(f.engine.calls, [], 'no batch started');
  const holds = () => f.exec.intakePause.active(f.clock()).map(h => [h.holder, h.until]);
  assert.deepEqual(holds(), [[VERSION_SKEW_HOLDER, new Date(T0 + 120 * 60_000).toISOString()]]);
  assert.equal(status.content.versions.consistent, false);
  assert.equal(status.content.intakePause.holders[0].holder, VERSION_SKEW_HOLDER);
  const paused = (await f.receipts.latest(['intake-paused'], 5)).map(e => e.value.body);
  assert.deepEqual(paused.map(b => [b.holder, b.reason, b.renewed]), [[VERSION_SKEW_HOLDER, UPGRADE_VERSION_SKEW, false]]);
  // no renewal while more than 90 minutes are left; one when less
  f.advance(29 * 60_000); await f.exec.tick();
  assert.equal((await f.receipts.latest(['intake-paused'], 5)).length, 1);
  f.advance(2 * 60_000); await f.exec.tick();
  const renewed = (await f.receipts.latest(['intake-paused'], 5)).map(e => e.value.body);
  assert.deepEqual(renewed.map(b => b.renewed), [false, true]);
  assert.ok(Date.parse(holds()[0][1]) - f.clock() > VERSION_SKEW_RENEW_BELOW_MS);
  // unknown: neither renewed nor lifted
  state = { view: versionsView({ current: current(), facts: null, status: null }, { policy, now: f.clock() }), notices: [] };
  f.advance(60_000); await f.exec.tick();
  assert.equal(holds().length, 1);
  assert.equal((await f.receipts.latest(['intake-resumed'], 5)).length, 0);
  // the versions agree again: lifted, and the batch starts
  state = { view: versionsView({ current: current(), facts: facts({ observedAt: new Date(f.clock()).toISOString() }), status: null }, { policy, now: f.clock() }), notices: [] };
  f.advance(60_000);
  const r2 = await f.exec.tick();
  assert.deepEqual(holds(), []);
  assert.deepEqual((await f.receipts.latest(['intake-resumed'], 5)).map(e => [e.value.body.holder, e.value.body.held, e.value.body.reason]), [[VERSION_SKEW_HOLDER, true, 'VERSIONS_CONSISTENT']]);
  assert.equal(r2.state, 'COMPLETED');
});

test('version skew at the precheck: a global VERSION_SKEW deferral, nothing reserved or burned; once they agree the batch runs', async t => {
  const f = await executorFixture(t, { now: T0 });
  // the tick's own read says they agree (no hold), the precheck's fresh read says they do not: the race the precheck closes
  let reads = 0, skew = true;
  const agree = () => ({ view: versionsView({ current: current(), facts: facts({ observedAt: new Date(f.clock()).toISOString() }), status: null }, { policy, now: f.clock() }), notices: [] });
  const differ = () => ({ view: versionsView({ current: current(), facts: facts({ generation: 1, observedAt: new Date(f.clock()).toISOString() }), status: null }, { policy, now: f.clock() }), notices: [] });
  f.exec.versions = async () => { reads += 1; return reads % 2 === 1 || !skew ? agree() : differ(); };
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.reason], ['DEFERRED', 'VERSION_SKEW']);
  assert.deepEqual(f.engine.calls, [], 'no stage');
  assert.deepEqual(await f.ledger.open(), [], 'no reservation');
  assert.equal((await f.receipts.latest(['batch-reserved'], 5)).length, 0);
  assert.equal(await f.ledger.headBurned(headKeyOf()), false, 'nothing burned');
  assert.deepEqual(f.exec.intakePause.active(f.clock()), [], 'no hold was written in this race');
  // the skew is gone: the same head runs as usual
  skew = false;
  f.advance(60_000);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal((await f.receipts.latest(['batch-reserved'], 5)).length, 1);
});

test('version skew: never acts without the port, and never on null from the start', async t => {
  const f = await executorFixture(t, { now: T0 });
  f.exec.versions = async () => ({ view: versionsView({ current: null, facts: facts(), status: null }, { policy, now: T0 }), notices: [] });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  const g = await executorFixture(t, { now: T0 });
  g.exec.versions = async () => { throw new Error('unreadable'); };
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'COMPLETED', 'a port that fails is unknown');
});

// ---------------- the upgrader's resume ----------------

test('upgrade-resume: owner\\ only, compare-and-swap on PAUSED.json, receipt upgrade-resumed; a stale one is refused; requests\\ never resumes', async t => {
  const f = await executorFixture(t, { now: T0 });
  await f.ledger.pause({ reason: 'upgrade', requestSha256: 'a'.repeat(64) });
  const paused = await f.ledger.paused();
  // from the user-writable requests\: no pause contract, rejected; still paused
  await f.drop(Buffer.from(JSON.stringify(upgradeResumeRequest({ pausedSha256: paused.sha256, opId: OP, generation: 3 }, () => T0))), 'requests');
  await f.exec.tick();
  assert.ok(await f.ledger.paused(), 'a resume from requests\\ does nothing');
  assert.equal((await f.receipts.latest(['upgrade-resumed'], 5)).length, 0);
  // a stale one (other bytes) from owner\: refused, still paused
  await f.drop(Buffer.from(JSON.stringify(upgradeResumeRequest({ pausedSha256: 'b'.repeat(64), opId: OP, generation: 3 }, () => T0))), 'owner');
  await f.exec.tick();
  assert.ok(await f.ledger.paused());
  assert.equal((await f.receipts.latest(['owner-request-refused'], 5)).at(-1).value.body.failureCode, 'PAUSE_CHANGED_SINCE_REVIEW');
  // a malformed one: refused
  await f.drop(Buffer.from(JSON.stringify({ contract: UPGRADE_RESUME_CONTRACT, pausedSha256: paused.sha256, opId: 'x', generation: 3, requestedAt: new Date(T0).toISOString(), nonce: 'ab'.repeat(8) })), 'owner');
  await f.exec.tick();
  assert.ok(await f.ledger.paused());
  assert.equal((await f.receipts.latest(['owner-request-refused'], 5)).at(-1).value.body.failureCode, 'OWNER_REQUEST_REFUSED');
  // the right one: resumed by the upgrader, its own receipt
  const bytes = Buffer.from(JSON.stringify(upgradeResumeRequest({ pausedSha256: paused.sha256, opId: OP, generation: 3 }, () => T0)));
  await f.drop(bytes, 'owner');
  await f.exec.tick();
  assert.equal(await f.ledger.paused(), null);
  const r = (await f.receipts.latest(['upgrade-resumed'], 5)).map(e => e.value.body);
  assert.deepEqual(r, [{ requestSha256: sha256(bytes), pausedSha256: paused.sha256, opId: OP, generation: 3 }]);
  const kept = (await fs.readdir(path.join(f.root, 'state', 'halts'))).filter(n => n.endsWith('.resume.json'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'state', 'halts', kept[0]), 'utf8')).by, 'CluedCIUpgrader');
  // the same bytes again: a duplicate, nothing more
  await f.drop(bytes, 'owner');
  await f.exec.tick();
  assert.equal((await f.receipts.latest(['upgrade-resumed'], 5)).length, 1);
  assert.equal((await f.receipts.latest(['owner-request-duplicate'], 5)).length, 1);
});

// ---------------- service-start and resident-upgraded ----------------

test('service-start carries the generation; a change from the previous start appends resident-upgraded; unknown generations never do', async t => {
  const root = await upgradeRoot(t, { cur: null });
  const receipts = await ReceiptChain.open(path.join(root, 'state', 'receipts'), () => T0);
  const bodies = async () => (await receipts.latest(['service-start', 'resident-upgraded'], 50)).map(e => [e.type, e.value.body]);
  // an install before the channel: no current.json
  assert.deepEqual(await recordServiceStart({ receipts, root, policySha256: POLICY_SHA, pid: 11 }), { generation: null, upgraded: false });
  // generation 1 adopted: no previous generation known, so no upgrade
  await fs.writeFile(path.join(root, 'upgrade', 'current.json'), JSON.stringify(current({ generation: 1, opId: null })));
  assert.deepEqual(await recordServiceStart({ receipts, root, policySha256: POLICY_SHA, pid: 12 }), { generation: 1, upgraded: false });
  assert.deepEqual(await recordServiceStart({ receipts, root, policySha256: POLICY_SHA, pid: 13 }), { generation: 1, upgraded: false });
  // the upgrader made generation 2 current
  await fs.writeFile(path.join(root, 'upgrade', 'current.json'), JSON.stringify(current({ generation: 2 })));
  assert.deepEqual(await recordServiceStart({ receipts, root, policySha256: '6'.repeat(64), pid: 14 }), { generation: 2, upgraded: true });
  // a rollback is a generation change too
  await fs.writeFile(path.join(root, 'upgrade', 'current.json'), JSON.stringify(current({ generation: 1, packageManifestSha256: 'b'.repeat(64), opId: OP })));
  assert.deepEqual(await recordServiceStart({ receipts, root, policySha256: POLICY_SHA, pid: 15 }), { generation: 1, upgraded: true });
  // unreadable now: generation null, nothing claimed
  await fs.writeFile(path.join(root, 'upgrade', 'current.json'), '{');
  assert.deepEqual(await recordServiceStart({ receipts, root, policySha256: POLICY_SHA, pid: 16 }), { generation: null, upgraded: false });
  assert.deepEqual(await bodies(), [
    ['service-start', { policySha256: POLICY_SHA, pid: 11, generation: null }],
    ['service-start', { policySha256: POLICY_SHA, pid: 12, generation: 1 }],
    ['service-start', { policySha256: POLICY_SHA, pid: 13, generation: 1 }],
    ['service-start', { policySha256: '6'.repeat(64), pid: 14, generation: 2 }],
    ['resident-upgraded', { fromGeneration: 1, toGeneration: 2, opId: OP, packageManifestSha256: PKG, policySha256: '6'.repeat(64) }],
    ['service-start', { policySha256: POLICY_SHA, pid: 15, generation: 1 }],
    ['resident-upgraded', { fromGeneration: 2, toGeneration: 1, opId: OP, packageManifestSha256: 'b'.repeat(64), policySha256: POLICY_SHA }],
    ['service-start', { policySha256: POLICY_SHA, pid: 16, generation: null }],
  ]);
  await receipts.verify();
});

// ---------------- the engine's gate and the failure table ----------------

const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
const SC_QC = 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n        START_TYPE         : 3   DEMAND_START\r\n        SERVICE_START_NAME : .\\clued-control\r\n';
const SC_Q = 'STATE              : 1  STOPPED\r\n        PID                : 0\r\n';
async function gateEngine(t, versions) {
  const root = await tempRoot(t);
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  for (const n of ['derive-batch.mjs', 'invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(sourceRoot, ...V2, n), '// fixture');
  const sent = [];
  const run = async a => {
    if (a[0].endsWith('sc.exe')) return { code: 0, stdout: a[1] === 'qc' ? SC_QC : SC_Q };
    return { code: 1, stdout: '' };
  };
  const companionMailbox = { async send(kind) { sent.push(kind); return { kind }; }, async await(req) { return req.kind === 'check-refs' ? { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' } : { ok: true, verified: true, directory: 'x' }; } };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, companionMailbox, clock: () => T0, sleep: async () => {}, versions,
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe',
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe' } });
  const batch = { batchId: '0123456789abcdef-0123456789ab', key: 'a1'.repeat(32), dir: path.join(root, 'work', 'b'),
    stages: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: 'f'.repeat(64) })) };
  return { engine, batch, sent };
}

test('engine: before the first Linux stage, consistent false is UPGRADE_VERSION_SKEW with nothing sent; null, true or no port go on as before', async t => {
  const stages = policy.stages;
  for (const n of [2, 4, 6]) {
    const f = await gateEngine(t, async () => ({ consistent: false }));
    const r = await f.engine.runStage(f.batch, stages[n - 1], { betweenRoles: false, firstLinux: true });
    assert.deepEqual([r.ok, r.code, r.proof.windowsTreeZero, r.proof.serviceOriginalStopped, f.sent], [false, UPGRADE_VERSION_SKEW, true, true, []], String(n));
  }
  for (const versions of [async () => ({ consistent: null }), async () => ({ consistent: true }), async () => { throw new Error('x'); }, undefined]) {
    const f = await gateEngine(t, versions);
    const r = await f.engine.runStage(f.batch, stages[1], { betweenRoles: false, firstLinux: true });
    assert.deepEqual([r.code, f.sent], ['REMOTE_REFS_CHANGED_SINCE_BUNDLE', ['check-refs']], 'the refs gate as before');
  }
  // only the first Linux stage asks
  let asked = 0;
  const f = await gateEngine(t, async () => { asked += 1; return { consistent: false }; });
  await f.engine.runStage(f.batch, stages[3], { betweenRoles: false, firstLinux: false }).catch(() => null);
  assert.equal(asked, 0);
});

test('failure table: version skew at stage 2 uses attempt 2; at stages 4 and 6 it waits for continuation', () => {
  for (const stage of [2, 4, 6]) {
    const row = failureRow({ code: UPGRADE_VERSION_SKEW, stage });
    assert.deepEqual([row.stages, row.class, row.disposition, row.retry, row.breaker],
      [stage === 2 ? [2] : [4, 6], 'environment', 'burn', stage === 2 ? 'attempt2' : 'continuation', 'neutral'], String(stage));
    assert.deepEqual([decideFailure({ code: UPGRADE_VERSION_SKEW, stage, proof: CLEAN_PROOF, started: true }).klass], ['CLEAN']);
    assert.equal(decideFailure({ code: UPGRADE_VERSION_SKEW, stage, proof: { windowsTreeZero: true, serviceOriginalStopped: true }, started: true }).klass, 'UNKNOWN', 'without the Linux half of the proof');
  }
  assert.equal(failureRow({ code: UPGRADE_VERSION_SKEW, stage: 3 }).stages, 'any');
});

// ---------------- the companion's upgrade mailbox lane ----------------

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });

test('companion: the upgrade tool argv is fixed and strictly checked', () => {
  const ok = [['version-facts'], ['stage', '--op', OP, '--package', PKG, '--generation', '3', '--linux-manifest', LINUX_MANIFEST],
    ['switch', '--op', OP, '--from', '2', '--to', '3', '--linux-manifest', LINUX_MANIFEST], ['rollback', '--op', OP, '--from', '3', '--to', '2'], ['verify', '--op', OP, '--generation', '3'],
    ['retain', '--op', OP, '--keep', '3', '--generation', '3'], ['retain', '--op', OP, '--keep', '2', '--generation', '5'], ['retain', '--op', OP, '--keep', '10', '--generation', '5']];
  for (const a of ok) {
    assert.equal(upgradeToolArgvOk(a), true, a.join(' '));
    const full = argv(cfg).upgradeTool(a);
    assert.deepEqual(full.slice(0, 10), ['C:\\Windows\\System32\\wsl.exe', '--distribution', 'Ubuntu-24.04', '--user', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C']);
    assert.deepEqual(full.slice(11), [UPGRADE_TOOL_PATH, ...a]);
  }
  const bad = [[], ['adopt', '--generation', '1'], ['version-facts', '--op', OP], ['stage', '--op', OP, '--package', PKG, '--generation', '3'], ['stage', '--op', OP.toUpperCase(), '--package', PKG, '--generation', '3', '--linux-manifest', LINUX_MANIFEST],
    ['switch', '--op', OP, '--from', '0', '--to', '3', '--linux-manifest', LINUX_MANIFEST], ['rollback', '--op', OP, '--from', '3', '--to', '2', '--force'], ['verify', '--op', OP, '--generation', '3; rm -rf /'],
    ['verify --op x', '--generation', '3'], ['verify', '--op', OP, '--generation', '../3'], ['verify', '--generation', '3', '--op', OP], 'version-facts',
    ['retain', '--op', OP], ['retain', '--op', OP, '--keep', '3'], ['retain', '--op', OP, '--generation', '3'], ['retain', '--op', OP, '--generation', '3', '--keep', '3'],
    ['retain', '--op', OP, '--keep', '1', '--generation', '3'], ['retain', '--op', OP, '--keep', '11', '--generation', '3'], ['retain', '--op', OP, '--keep', '03', '--generation', '3'],
    ['retain', '--op', OP, '--keep', '3', '--generation', '0']];
  for (const a of bad) {
    assert.equal(upgradeToolArgvOk(a), false, JSON.stringify(a));
    assert.throws(() => argv(cfg).upgradeTool(a), { code: 'COMPANION_UPGRADE_TOOL_ARGS_INVALID' }, JSON.stringify(a));
  }
});

async function lane(t, script) {
  const root = await tempRoot(t);
  let now = T0;
  const runs = [];
  const box = await UpgradeMailbox.open(path.join(root, 'upgrade', 'mailbox'), () => now);
  const run = async (a, o) => {
    const args = a.slice(a.indexOf(UPGRADE_TOOL_PATH) + 1);
    runs.push([args[0], o.timeoutMs]);
    return script(args, () => now);
  };
  const l = new UpgradeLane({ cfg, mailbox: box, run, clock: () => now });
  return { box, l, runs, advance: ms => { now += ms; }, clock: () => now };
}
const factsAnswer = clock => ({ code: 0, stdout: JSON.stringify(facts({ observedAt: new Date(clock()).toISOString() })) + '\n' });

test('companion lane: each kind goes to the root tool and its JSON back as is; a refusal carries the tool code; the facts are refreshed', async t => {
  const answers = { stage: { code: 0, stdout: '{"status":"STAGED","generation":3}\n' }, switch: { code: 0, stdout: '{"status":"SWITCHED"}\n' }, rollback: { code: 3, stdout: '{"status":"REFUSED","code":"QUIESCENCE_UNCONFIRMED","upgradeCode":"UPGRADE_LINUX_QUIESCENCE_UNCONFIRMED"}\n' },
    verify: { code: 0, stdout: '{"status":"VERIFIED","generation":3}\n' }, retain: { code: 0, stdout: '{"status":"LINUX_RETAINED","generation":3,"keep":3,"kept":[1,2],"archived":[],"deleted":0}\n' } };
  const f = await lane(t, (args, clock) => (args[0] === 'version-facts' ? factsAnswer(clock) : answers[args[0]]));
  // first pass: nothing asked, the facts are due at once
  assert.deepEqual(await f.l.step(), { answered: [], facts: true });
  assert.equal((await f.box.readVersionFacts()).generation, 2);
  const reqs = [await f.box.send({ kind: 'linux-upgrade-stage', opId: OP, args: { packageManifestSha256: PKG, generation: 3, linuxManifestSha256: LINUX_MANIFEST } }),
    await f.box.send({ kind: 'linux-upgrade-switch', opId: OP, args: { fromGeneration: 2, toGeneration: 3, linuxManifestSha256: LINUX_MANIFEST } }),
    await f.box.send({ kind: 'linux-upgrade-rollback', opId: OP, args: { fromGeneration: 3, toGeneration: 2 } }),
    await f.box.send({ kind: 'linux-upgrade-verify', opId: OP, args: { generation: 3 } }),
    await f.box.send({ kind: 'linux-version-facts' }),
    await f.box.send({ kind: 'linux-upgrade-retain', opId: OP, args: { generation: 3, keep: 3 } })];
  f.runs.length = 0;
  f.advance(1000);
  const step = await f.l.step();
  assert.deepEqual(step.answered.map(a => a[0]).sort(), ['linux-upgrade-retain', 'linux-upgrade-rollback', 'linux-upgrade-stage', 'linux-upgrade-switch', 'linux-upgrade-verify', 'linux-version-facts'].sort());
  const got = Object.fromEntries(await Promise.all(reqs.map(async r => [r.kind, await f.box.poll(r)])));
  assert.deepEqual([got['linux-upgrade-stage'].ok, got['linux-upgrade-stage'].result, got['linux-upgrade-stage'].tool], [true, { status: 'STAGED', generation: 3 }, { exit: 0, status: 'STAGED' }]);
  assert.deepEqual([got['linux-upgrade-switch'].ok, got['linux-upgrade-verify'].ok, got['linux-version-facts'].ok], [true, true, true]);
  assert.deepEqual([got['linux-upgrade-rollback'].ok, got['linux-upgrade-rollback'].code, got['linux-upgrade-rollback'].tool.exit], [false, 'UPGRADE_LINUX_QUIESCENCE_UNCONFIRMED', 3]);
  assert.deepEqual([got['linux-upgrade-retain'].ok, got['linux-upgrade-retain'].result.status], [true, 'LINUX_RETAINED']);
  assert.ok(f.runs.some(r => r[0] === 'retain'));
  // the facts right after the switch and right after the rollback (whatever its answer), besides the asked ones
  const order = f.runs.map(r => r[0]);
  assert.ok(order.indexOf('switch') >= 0 && order[order.indexOf('switch') + 1] === 'version-facts', order.join());
  assert.ok(order[order.indexOf('rollback') + 1] === 'version-facts', order.join());
  // each run's limit is the kind's own (at most its deadline)
  assert.ok(f.runs.find(r => r[0] === 'stage')[1] <= 20 * 60_000 && f.runs.find(r => r[0] === 'stage')[1] > 19 * 60_000);
  // answered once: the next pass runs nothing for them
  f.runs.length = 0;
  f.advance(1000);
  assert.deepEqual((await f.l.step()).answered, []);
  assert.deepEqual(f.runs, []);
  // the periodic refresh after five minutes
  f.advance(VERSION_FACTS_REFRESH_MS);
  assert.equal((await f.l.step()).facts, true);
  assert.deepEqual(f.runs.map(r => r[0]), ['version-facts']);
});

test('companion lane: an expired request is never run; a timed-out or failing tool is no success; failed facts wait before the next try', async t => {
  let factsOk = false;
  const f = await lane(t, (args, clock) => {
    if (args[0] === 'version-facts') return factsOk ? factsAnswer(clock) : { code: 1, stdout: '' };
    if (args[0] === 'verify') return { code: null, timedOut: true, stdout: '' };
    return { code: 0, stdout: 'not json' };
  });
  const expired = await f.box.send({ kind: 'linux-upgrade-switch', opId: OP, args: { fromGeneration: 2, toGeneration: 3, linuxManifestSha256: LINUX_MANIFEST } });
  f.advance(5 * 60_000 + 1);
  const verify = await f.box.send({ kind: 'linux-upgrade-verify', opId: OP, args: { generation: 3 } });
  const stage = await f.box.send({ kind: 'linux-upgrade-stage', opId: OP, args: { packageManifestSha256: PKG, generation: 3, linuxManifestSha256: LINUX_MANIFEST } });
  const step = await f.l.step();
  assert.equal(step.facts, false);
  assert.equal(f.runs.some(r => r[0] === 'switch'), false, 'never run past its deadline');
  assert.deepEqual([(await f.box.poll(expired)).ok, (await f.box.poll(expired)).code, (await f.box.poll(expired)).tool.exit], [false, UPGRADE_REQUEST_EXPIRED, null]);
  const v = await f.box.poll(verify), s = await f.box.poll(stage);
  assert.deepEqual([v.ok, v.code, v.tool.exit], [false, 'UPGRADE_LINUX_TOOL_FAILED', -1]);
  assert.deepEqual([s.ok, s.code], [false, 'UPGRADE_LINUX_TOOL_OUTPUT_REFUSED']);
  assert.equal(await f.box.readVersionFacts(), null);
  // failed facts: not again within the retry interval, then again
  f.runs.length = 0;
  factsOk = true;
  f.advance(VERSION_FACTS_RETRY_MS - 1000);
  assert.equal((await f.l.step()).facts, false);
  f.advance(2000);
  assert.equal((await f.l.step()).facts, true);
  assert.deepEqual(f.runs.map(r => r[0]), ['version-facts']);
  // an unreadable request file is left alone
  await fs.writeFile(path.join(f.box.requests, '0a1b2c3d-0000-4000-8000-0000000000ff.json'), '{"contract":"x"}');
  f.runs.length = 0;
  f.advance(1000);
  assert.deepEqual((await f.l.step()).answered, []);
  assert.deepEqual(f.runs, []);
});

test('companion lane: without the channel directories it waits and does nothing', async t => {
  let opens = 0;
  const l = new UpgradeLane({ cfg, run: async () => { throw new Error('never'); }, clock: () => T0, openMailbox: async () => { opens += 1; throw new Error('absent'); } });
  assert.deepEqual(await l.step(), { answered: [], facts: false });
  assert.deepEqual(await l.step(), { answered: [], facts: false });
  assert.equal(opens, 2);
});

// ---------------- the Owner's inspect ----------------

test('inspect shows the generation, the op (with its confirm page), the Linux facts and whether both sides agree; nothing when absent', async t => {
  const root = await upgradeRoot(t, { status: upgradeStatus(op('WAITING_GRANT'), [{ opId: OP, outcome: 'SUCCEEDED' }]) });
  const u = await inspectUpgrade(root, policy, () => T0);
  assert.deepEqual([u.generation, u.packageManifestSha256, u.consistent, u.op.state, u.op.confirmUrl, u.linux.generation, u.recent.length],
    [2, PKG, true, 'WAITING_GRANT', `https://kooyomi.example/confirm/${OP}`, 2, 1]);
  const none = await inspectUpgrade(await tempRoot(t), null, () => T0);
  assert.deepEqual([none.generation, none.op, none.linux, none.consistent, none.recent], [null, null, null, null, []]);
});

// Task 42fe5ae4: inspect shows where the last Windows step failed and what upgrade-apply.ps1 said, in the fixed shapes only.
test('inspect shows the last failure of the op (step, where, upgrade-apply code and short at); anything outside the fixed shapes is dropped', async t => {
  const lastFailure = { step: 'stage-windows', code: 'WINDOWS_STAGE_REFUSED', where: 'compile', applyCode: 'RUNNER_STABLE_DIGEST_DRIFT', applyAt: 'old-0123456789ab-new-ba9876543210' };
  const root = await upgradeRoot(t, { status: upgradeStatus(op('RUNNING', { lastFailure }), []) });
  const u = await inspectUpgrade(root, policy, () => T0);
  assert.deepEqual(u.op.lastFailure, { step: 'stage-windows', code: 'WINDOWS_STAGE_REFUSED', where: 'compile', applyCode: 'RUNNER_STABLE_DIGEST_DRIFT', applyAt: lastFailure.applyAt });
  const quiet = await inspectUpgrade(await upgradeRoot(t, { status: upgradeStatus(op('RUNNING'), []) }), policy, () => T0);
  assert.equal(quiet.op.lastFailure, null);
  assert.deepEqual(failureView({ step: 'verify', code: 'VERIFY_FAILED', where: 'verify', applyCode: 'free text, C: secret path', applyAt: 'line573.UnauthorizedAccessException' }),
    { step: 'verify', code: 'VERIFY_FAILED', where: 'verify', applyCode: null, applyAt: 'line573.UnauthorizedAccessException' });
  for (const bad of [null, 'x', [], 7, {}, { step: 'A B', code: 'lower', where: 'x'.repeat(99), applyCode: 3, applyAt: 'a b' }]) assert.equal(failureView(bad), null);
});
