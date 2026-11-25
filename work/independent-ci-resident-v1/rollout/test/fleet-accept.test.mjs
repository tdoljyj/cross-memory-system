// rollout/fleet/accept.mjs run: one bounded command from the Owner's acceptance to every node on the accepted Source
// (PLAN-accept-auto-seal-20261125.md 2.3, piece C). A fixture node root (upgrade\inbox, inbox-archive, status.json, current.json, the
// record's node profile) and a fake door behind a fake seal (piece B's seal() answers: FLEET_ACCEPTANCE_WAITING_OWNER with confirmUrl,
// FLEET_ACCEPTANCE_SEALED, FLEET_ACCEPTANCE_REJECTED), a fake Release directory, a fake installed upgrader that moves on the fake clock,
// and a fake fleet read. Nothing here reaches the network, a real node root or a real door.
//
// Lives in rollout/test (the resident-node suite runs it); rollout/fleet/test is in no required suite (ci-uncovered-tests.json).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptanceOf } from '../fleet/publish.mjs';
import { ROLLOUT_CONTRACT, exitCodeOf, main } from '../fleet/accept.mjs';

const VERSION = '2026.11.25-1';
const TAG = `fleet-node-${VERSION}`;
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const CONFIRM = 'https://clued.example/confirm/0b6f5d1e';
const MOVING = ['WAITING_GRANT', 'WAITING_DRAIN', 'DEFERRED', 'RUNNING', 'ROLLING_BACK'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-accept-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const B_AT_NEW = { node: 'fixture-b', ciSourceManifestSha256: NEW, paused: false };

// One scene: this node (fixture-a, the one the command runs on) at OLD, another node (fixture-b), a request, a door, a Release.
//   onDuty   fixture-a holds ci-admission: upgrade.mjs answers HAND_OVER_FIRST unless --allow-active-upgrade
//   ending   how the installed upgrader ends the operation it is asked for: SUCCEEDED (both sides NEW), ROLLED_BACK_PAUSED, or STUCK
//            (RUNNING for ever, status.json still rewritten on every pass)
//   door     pending | accepted | rejected; ownerClicksAt: the sleep (1-based) at which the Owner approves on the page
//   intake   what the upgrader does with a request in upgrade\inbox (s.intake, may change between runs): take (archived processed, an
//            operation opens), ignored | rejected (archived so, no operation: src/inbox.mjs dispose), stopped (CluedCIUpgrader not
//            running: nothing taken, status.json not rewritten)
//   startOp  an operation already under way (RUNNING) when the command starts: 'ours' (it ends as `ending` says) or 'foreign' (another
//            package's: it ends SUCCEEDED and this node stays at OLD)
function scene(name, { onDuty = false, ending = 'SUCCEEDED', door = 'pending', ownerClicksAt = 1, intake = 'take', startOp = null,
  other = { node: 'fixture-b', ciSourceManifestSha256: OLD, paused: false } } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const root = path.join(dir, 'root'), release = path.join(dir, 'release'), work = path.join(dir, 'work');
  const inbox = path.join(root, 'upgrade', 'inbox'), archive = path.join(root, 'upgrade', 'inbox-archive');
  fs.mkdirSync(inbox, { recursive: true }); fs.mkdirSync(release);
  for (const d of ['processed', 'rejected', 'ignored']) fs.mkdirSync(path.join(archive, d), { recursive: true });
  // the installed record's node profile (install.mjs readNode: record\acceptance.json node; upgrade.mjs answers its nodeName)
  writeJson(path.join(root, 'record', 'acceptance.json'), { node: { nodeName: 'fixture-a' } });
  const current = path.join(root, 'upgrade', 'current.json'), status = path.join(root, 'upgrade', 'status.json');
  writeJson(current, { generation: 1, ciSourceManifestSha256: OLD, packageManifestSha256: 'c'.repeat(64), linux: { generation: 1, ciSourceManifestSha256: OLD } });
  const request = path.join(dir, 'accept', `${TAG}.acceptance-request.json`);
  const req = { contract: 'clued.independent-ci.fleet-node-acceptance-request/1', version: VERSION, archive_sha256: 'd'.repeat(64), commit: 'e'.repeat(40),
    repository: 'tdoljyj/cross-memory-system', ciSourceManifestSha256: NEW, firstInstallKitSha256: 'f'.repeat(64),
    fleetRefs: { sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), ownerAuthorizationRef: randomUUID(), publisherQualificationRef: randomUUID(),
      ownerPackageAcceptanceRef: randomUUID(), formalRoles: { 'contract-placement': { keyId: 'k' } } } };
  writeJson(request, req);
  const s = { dir, root, release, work, inbox, request, door, other, intake, clock: Date.parse('2026-11-25T03:00:00Z'), sleeps: [], seals: [], upgrades: [],
    fleetReads: 0, op: null, queued: null };
  const iso = () => new Date(s.clock).toISOString();
  writeJson(status, { writtenAt: iso(), op: null, recent: [] });
  if (startOp) {
    s.op = { opId: randomUUID(), state: 'RUNNING', packageManifestSha256: '8'.repeat(64), foreign: startOp === 'foreign' };
    writeJson(status, { writtenAt: iso(), op: { opId: s.op.opId, state: s.op.state }, recent: [] });
  }
  const grant = { grant_id: randomUUID(), receipt_id: randomUUID(), accepted_at: '2026-11-25T03:00:31Z' };
  const atNew = () => { const c = readJson(current); return c.ciSourceManifestSha256 === NEW && c.linux.ciSourceManifestSha256 === NEW; };
  // the installed upgrader, one pass per look: takes the inbox, then WAITING_GRANT (auto-approved) -> RUNNING -> its ending
  const tick = () => {
    if (s.intake === 'stopped') return;
    const st = readJson(status);
    st.writtenAt = iso();
    if (s.queued) {
      const q = s.queued; s.queued = null;
      const disposition = s.intake === 'take' ? 'processed' : s.intake;
      fs.renameSync(q.file, path.join(archive, disposition, `${s.clock}-0123456789ab-${path.basename(q.file)}`));
      if (disposition === 'processed') { s.op = { opId: q.requestId, state: 'WAITING_GRANT', packageManifestSha256: q.pkg }; st.op = { opId: s.op.opId, state: s.op.state }; }
    } else if (s.op?.state === 'WAITING_GRANT') { s.op.state = 'RUNNING'; st.op = { opId: s.op.opId, state: s.op.state }; }
    else if (s.op?.state === 'RUNNING' && (ending !== 'STUCK' || s.op.foreign)) {
      if (s.op.foreign) {
        st.recent = [...st.recent, { opId: s.op.opId, outcome: 'SUCCEEDED', code: null, generation: 2, at: iso() }];
      } else if (ending === 'SUCCEEDED') {
        writeJson(current, { generation: 2, ciSourceManifestSha256: NEW, packageManifestSha256: s.op.packageManifestSha256, linux: { generation: 2, ciSourceManifestSha256: NEW } });
        st.recent = [...st.recent, { opId: s.op.opId, outcome: 'SUCCEEDED', code: null, generation: 2, at: iso() }];
      } else {
        st.recent = [...st.recent, { opId: s.op.opId, outcome: 'ROLLED_BACK_PAUSED', code: 'VERIFY_FAILED', generation: 1, at: iso() }];
      }
      st.op = null; s.op = null;
    }
    writeJson(status, st);
  };
  s.deps = {
    root,
    now: () => s.clock,
    sleep: async ms => {
      s.sleeps.push(ms); s.clock += ms;
      if (s.door === 'pending' && s.sleeps.length >= ownerClicksAt) s.door = 'accepted';   // the Owner clicks once on the confirm page
      tick();
    },
    // piece B's seal(): the door's answer, and on accepted the acceptance file on the Release (the three values from the door)
    seal: async args => {
      s.seals.push(args);
      if (s.door === 'pending') return { status: 'FLEET_ACCEPTANCE_WAITING_OWNER', confirmUrl: CONFIRM, expiresAt: new Date(s.clock + 24 * 3600_000).toISOString() };
      if (s.door === 'rejected') return { status: 'FLEET_ACCEPTANCE_REJECTED', code: 'FLEET_ACCEPTANCE_REJECTED' };
      const file = path.join(release, `${TAG}.acceptance.json`);
      const already = fs.existsSync(file);
      if (!already) fs.writeFileSync(file, JSON.stringify(acceptanceOf(req, { decision: grant.grant_id, receipt: grant.receipt_id, acceptedAt: grant.accepted_at }), null, 2) + '\n');
      return { status: 'FLEET_ACCEPTANCE_SEALED', already, acceptance: file, cluedDecision: grant.grant_id };
    },
    // upgrade.mjs fetch's answers, read as it reads them (status.json op, current.json); a request is one new file in upgrade\inbox (the
    // installed request-upgrade.ps1: <13-digit ms>-<12 hex>.json), which the upgrader takes on its next pass
    upgrade: async argv => {
      s.upgrades.push(argv);
      const statusFile = status;
      const op = readJson(status).op;
      if (op && MOVING.includes(op.state)) return { status: 'FLEET_NODE_UPGRADE_IN_PROGRESS', statusFile, op: { opId: op.opId, state: op.state } };
      if (atNew()) return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', statusFile, generation: 2 };
      if (s.refuse) return { status: s.refuse, code: 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', node: 'fixture-a', statusFile };
      if (onDuty && !argv.includes('--allow-active-upgrade')) return { status: 'FLEET_NODE_UPGRADE_HAND_OVER_FIRST', node: 'fixture-a', statusFile };
      const requestId = randomUUID(), pkg = '9'.repeat(64);
      const requestFile = path.join(inbox, `${String(s.clock).padStart(13, '0')}-${randomUUID().replaceAll('-', '').slice(0, 12)}.json`);
      fs.writeFileSync(requestFile, JSON.stringify({ requestId, node: 'fixture-a', packageManifestSha256: pkg }), { flag: 'wx' });
      s.queued = { file: requestFile, requestId, pkg };
      return { status: 'FLEET_NODE_UPGRADE_REQUESTED', node: 'fixture-a', statusFile, packageManifestSha256: pkg, request: { requestId, requestFile } };
    },
    // the last Source each registered node reported, and whether it stands paused
    readFleet: async () => {
      s.fleetReads++;
      const c = readJson(current);
      return [{ node: 'fixture-a', ciSourceManifestSha256: c.ciSourceManifestSha256 === c.linux.ciSourceManifestSha256 ? c.ciSourceManifestSha256 : null, paused: false }, { ...s.other }];
    },
  };
  s.run = (extra = []) => main(['run', '--request', request, '--work', work, ...extra], s.deps);
  // every request ever put in the inbox: still there, or archived by the upgrader
  s.inboxFiles = () => fs.readdirSync(inbox).length + ['processed', 'rejected', 'ignored'].reduce((n, d) => n + fs.readdirSync(path.join(archive, d)).length, 0);
  s.acceptanceOnRelease = () => fs.existsSync(path.join(release, `${TAG}.acceptance.json`));
  s.slept = () => s.sleeps.reduce((a, b) => a + b, 0);
  return s;
}

test('one command: the Owner approves once on the page, then with no further command the Release holds the acceptance, the inbox exactly one request, and the answer names the node still to go', async () => {
  const s = scene('standby');
  const r = await s.run();
  // the Owner's click is the only outside act: one main() call from "waiting for the Owner" to "this node upgraded"
  assert.equal(r.contract, ROLLOUT_CONTRACT);
  assert.equal(r.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(r));
  assert.deepEqual(r.pending.map(n => n.node), ['fixture-b']);
  assert.equal(r.version, VERSION);
  assert.equal(r.ciSourceManifestSha256, NEW);
  assert.match(r.next, /fixture-b/);
  assert.equal(exitCodeOf(r), 2);
  assert.ok(s.acceptanceOnRelease(), 'the acceptance is on the Release');
  assert.equal(s.inboxFiles(), 1, 'exactly one request was put in the inbox');
  assert.ok(s.seals.length >= 2 && s.seals.every(a => a.request === s.request), 'seal asked again until the door answered');
  // no --allow-active-upgrade on a standby; the version is the request's
  assert.equal(s.upgrades.length, 1);
  assert.ok(!s.upgrades[0].includes('--allow-active-upgrade'));
  assert.equal(s.upgrades[0][s.upgrades[0].indexOf('--version') + 1], VERSION);
  assert.equal(s.upgrades[0][s.upgrades[0].indexOf('--repo') + 1], 'tdoljyj/cross-memory-system');
  assert.ok(s.sleeps.every(ms => ms >= 30_000 && ms <= 120_000), `every wait 30-120 s: ${s.sleeps}`);
  // the other node reports the accepted Source: the same command again ends ROLLOUT_DONE, nothing requested again
  s.other = { ...B_AT_NEW };
  const again = await s.run();
  assert.equal(again.status, 'ROLLOUT_DONE', JSON.stringify(again));
  assert.equal(exitCodeOf(again), 0);
  assert.equal(s.inboxFiles(), 1, 'run again: no second request');
});

test('this node on duty: no request and ROLLOUT_WAITING_OTHER_NODES until every other node reports the accepted Source and is not paused; only then --allow-active-upgrade', async () => {
  const s = scene('on-duty', { onDuty: true, door: 'accepted' });
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(r));
  assert.deepEqual(r.pending.map(n => n.node), ['fixture-b']);
  assert.equal(r.node, 'fixture-a');
  assert.equal(s.inboxFiles(), 0, 'the node on duty is not requested');
  assert.ok(s.upgrades.every(a => !a.includes('--allow-active-upgrade')));
  // the other node at the accepted Source but paused (an upgrade there ended paused): still not
  s.other = { node: 'fixture-b', ciSourceManifestSha256: NEW, paused: true };
  const paused = await s.run();
  assert.equal(paused.status, 'ROLLOUT_WAITING_OTHER_NODES');
  assert.equal(s.inboxFiles(), 0, 'never both drained: the other one is paused');
  // the other node done: this one goes, with --allow-active-upgrade, to ROLLOUT_DONE
  s.other = { ...B_AT_NEW };
  const n = s.upgrades.length;
  const done = await s.run();
  assert.equal(done.status, 'ROLLOUT_DONE', JSON.stringify(done));
  assert.deepEqual(s.upgrades.slice(n).map(a => a.includes('--allow-active-upgrade')), [false, true]);
  assert.equal(s.inboxFiles(), 1);
});

test('this node on duty and the fleet unreadable: nothing is requested', async () => {
  const s = scene('on-duty-blind', { onDuty: true, door: 'accepted' });
  s.deps.readFleet = async () => { throw Object.assign(new Error('no door'), { code: 'DOOR_UNREACHABLE' }); };
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_WAITING_OTHER_NODES');
  assert.equal(r.code, 'ROLLOUT_FLEET_UNREADABLE');
  assert.equal(r.pending, null);
  assert.equal(s.inboxFiles(), 0);
});

// review change 1: [] passes `every`; a list without this node, or with a node twice, says nothing about "every other node"
test('a fleet read that is empty, lacks this node, names a node twice or cannot be read is unreadable: the node on duty is not requested and step 3 never answers ROLLOUT_DONE', async () => {
  const A_NEW = { node: 'fixture-a', ciSourceManifestSha256: NEW, paused: false };
  for (const [label, fleet] of [['empty', []], ['no-self', [B_AT_NEW]], ['twice', [A_NEW, B_AT_NEW, B_AT_NEW]], ['throws', null]]) {
    const read = async () => { if (fleet === null) throw Object.assign(new Error('no door'), { code: 'DOOR_UNREACHABLE' }); return fleet.map(n => ({ ...n })); };
    const duty = scene(`fleet-${label}-duty`, { onDuty: true, door: 'accepted' });
    duty.deps.readFleet = read;
    const d = await duty.run();
    assert.equal(d.status, 'ROLLOUT_WAITING_OTHER_NODES', `${label}: ${JSON.stringify(d)}`);
    assert.equal(d.code, 'ROLLOUT_FLEET_UNREADABLE', label);
    assert.equal(duty.inboxFiles(), 0, `${label}: the node on duty is not requested`);
    assert.ok(duty.upgrades.every(a => !a.includes('--allow-active-upgrade')), label);
    const standby = scene(`fleet-${label}-standby`, { door: 'accepted' });
    standby.deps.readFleet = read;
    const r = await standby.run();
    assert.equal(r.status, 'ROLLOUT_WAITING_OTHER_NODES', `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.code, 'ROLLOUT_FLEET_UNREADABLE', label);
    assert.equal(r.pending, null, label);
    assert.equal(exitCodeOf(r), 2, label);
  }
});

test('status.json ends in a rollback: ROLLOUT_STOPPED with the node and code, exit non-zero; the same command again requests nothing', async () => {
  const s = scene('rollback', { ending: 'ROLLED_BACK_PAUSED', door: 'accepted' });
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_STOPPED', JSON.stringify(r));
  assert.equal(r.stage, 'node');
  assert.equal(r.node, 'fixture-a');
  assert.equal(r.code, 'VERIFY_FAILED');
  assert.equal(r.outcome, 'ROLLED_BACK_PAUSED');
  assert.equal(exitCodeOf(r), 1);
  assert.equal(s.inboxFiles(), 1);
  const n = s.upgrades.length;
  const again = await s.run();
  assert.equal(again.status, 'ROLLOUT_STOPPED');
  assert.equal(again.code, 'VERIFY_FAILED');
  assert.equal(s.upgrades.length, n, 'not asked again');
  assert.equal(s.inboxFiles(), 1, 'no second request');
  assert.equal(s.fleetReads, 0, 'no other node is touched or looked at');
});

// review change 2: an operation the command found under way (upgrade.mjs answered IN_PROGRESS) is noted like its own request
test('an operation already under way when the command starts ends in a rollback: ROLLOUT_STOPPED; the same command again requests nothing', async () => {
  const s = scene('adopted-rollback', { ending: 'ROLLED_BACK_PAUSED', door: 'accepted', startOp: 'ours' });
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_STOPPED', JSON.stringify(r));
  assert.equal(r.stage, 'node');
  assert.equal(r.code, 'VERIFY_FAILED');
  assert.equal(s.inboxFiles(), 0);
  const n = s.upgrades.length;
  const again = await s.run();
  assert.equal(again.status, 'ROLLOUT_STOPPED', JSON.stringify(again));
  assert.equal(again.code, 'VERIFY_FAILED');
  assert.equal(s.upgrades.length, n, 'not asked again');
  assert.equal(s.inboxFiles(), 0, 'no request after the rollback');
});

test('an operation under way that was another package\'s and ends well: this node is then requested once, and goes on', async () => {
  const s = scene('adopted-foreign', { door: 'accepted', startOp: 'foreign' });
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(r));
  assert.deepEqual(r.pending.map(n => n.node), ['fixture-b']);
  assert.equal(s.inboxFiles(), 1, 'one request, after the other operation ended');
  assert.equal(s.upgrades.length, 2);
});

// review change 3: the upgrader archives a request it does not take (src/inbox.mjs dispose; upgrader-main.mjs intake)
test('the upgrader sets the request aside (ignored or rejected): ROLLOUT_STOPPED ROLLOUT_REQUEST_NOT_TAKEN at once, not ROLLOUT_IN_PROGRESS; nothing became an operation, so the same command again asks again', async () => {
  for (const disposition of ['ignored', 'rejected']) {
    const s = scene(`not-taken-${disposition}`, { door: 'accepted', intake: disposition });
    const r = await s.run();
    assert.equal(r.status, 'ROLLOUT_STOPPED', `${disposition}: ${JSON.stringify(r)}`);
    assert.equal(r.stage, 'node');
    assert.equal(r.code, 'ROLLOUT_REQUEST_NOT_TAKEN');
    assert.equal(r.disposition, disposition);
    assert.equal(exitCodeOf(r), 1);
    assert.ok(s.slept() <= 10 * 60_000, `stopped within minutes, not after the node wait: ${s.slept()}`);
    s.intake = 'take';
    const again = await s.run();
    assert.equal(again.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(again));
    assert.equal(s.upgrades.length, 2);
    assert.equal(s.inboxFiles(), 2);
  }
});

test('the upgrader is not running (the request still in the inbox, status.json not rewritten): ROLLOUT_STOPPED ROLLOUT_UPGRADER_NOT_RUNNING within minutes; the same command again puts no second request', async () => {
  const s = scene('upgrader-stopped', { door: 'accepted', intake: 'stopped' });
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_STOPPED', JSON.stringify(r));
  assert.equal(r.code, 'ROLLOUT_UPGRADER_NOT_RUNNING');
  assert.ok(s.slept() <= 20 * 60_000, `stopped within minutes: ${s.slept()}`);
  const again = await s.run();
  assert.equal(again.code, 'ROLLOUT_UPGRADER_NOT_RUNNING');
  assert.equal(s.upgrades.length, 1, 'not asked again: the request waits in the inbox');
  assert.equal(s.inboxFiles(), 1);
  // the upgrader starts again (its first pass rewrites status.json): the same command follows the request it put, to the end
  s.intake = 'take';
  const statusFile = path.join(s.root, 'upgrade', 'status.json');
  writeJson(statusFile, { ...readJson(statusFile), writtenAt: new Date(s.clock).toISOString() });
  const later = await s.run();
  assert.equal(later.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(later));
  assert.equal(s.upgrades.length, 1);
  assert.equal(s.inboxFiles(), 1);
});

// suggestion 5: the request is put, then the process is lost before its note is written
test('the process is lost between the request and its note: the same command again finds the request at the upgrader and puts no second one', async () => {
  const s = scene('lost-after-request', { door: 'accepted' });
  const upgrade = s.deps.upgrade;
  s.deps.upgrade = async argv => { await upgrade(argv); throw new Error('the process is lost here'); };
  assert.equal((await s.run()).status, 'ROLLOUT_REFUSED');
  s.deps.upgrade = upgrade;
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(r));
  assert.equal(s.inboxFiles(), 1, 'one request');
  assert.equal(s.upgrades.length, 1, 'upgrade.mjs not asked again');
});

test('the process is lost before anything was requested: the same command again asks once, within minutes', async () => {
  const s = scene('lost-before', { door: 'accepted' });
  const upgrade = s.deps.upgrade;
  s.deps.upgrade = async () => { throw new Error('the process is lost here'); };
  assert.equal((await s.run()).status, 'ROLLOUT_REFUSED');
  s.deps.upgrade = upgrade;
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(r));
  assert.equal(s.inboxFiles(), 1);
  assert.ok(s.slept() <= 15 * 60_000, `${s.slept()}`);
});

test('a node the package cannot upgrade in place: ROLLOUT_STOPPED with its code', async () => {
  const s = scene('reinstall', { door: 'accepted' });
  s.refuse = 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL';
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_STOPPED');
  assert.equal(r.stage, 'node');
  assert.equal(r.code, 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL');
  assert.equal(r.nodeAnswer, 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL');
  assert.equal(exitCodeOf(r), 1);
  assert.equal(s.inboxFiles(), 0);
});

test('the Owner rejects: ROLLOUT_STOPPED at the acceptance, no node touched; still waiting at --wait: ROLLOUT_WAITING_OWNER with the link', async () => {
  const s = scene('rejected', { door: 'rejected' });
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_STOPPED');
  assert.equal(r.stage, 'accept');
  assert.equal(r.code, 'FLEET_ACCEPTANCE_REJECTED');
  assert.equal(exitCodeOf(r), 1);
  assert.equal(s.upgrades.length, 0);
  assert.ok(!s.acceptanceOnRelease());
  const w = scene('waiting', { ownerClicksAt: 1e9 });
  const waited = await w.run(['--wait', '5']);
  assert.equal(waited.status, 'ROLLOUT_WAITING_OWNER', JSON.stringify(waited));
  assert.equal(waited.confirmUrl, CONFIRM);
  assert.equal(exitCodeOf(waited), 2);
  assert.ok(w.slept() <= 5 * 60_000, 'bounded by --wait');
  assert.equal(w.upgrades.length, 0);
  assert.ok(!w.acceptanceOnRelease());
});

// review change 4: the network flaps (memory: assume a flaky network); seal is idempotent at the door (interface assumption B5)
test('seal throws for a while (the door unreachable): asked again on the same intervals and the answer after it goes on; an input error stops at once; errors that last stop, bounded, with the last code', async () => {
  const s = scene('door-flaky', { door: 'accepted', other: { ...B_AT_NEW } });
  const seal = s.deps.seal;
  let n = 0;
  s.deps.seal = async a => { if (++n <= 2) throw Object.assign(new Error('fetch failed'), { code: 'DOOR_UNREACHABLE' }); return seal(a); };
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_DONE', JSON.stringify(r));
  assert.equal(n, 3);
  assert.ok(s.sleeps.slice(0, 2).every(ms => ms >= 30_000 && ms <= 120_000), `${s.sleeps}`);
  const bad = scene('door-input', { door: 'accepted' });
  bad.deps.seal = async () => { throw Object.assign(new Error('name'), { code: 'REQUEST_FILE_NAME_REFUSED', detail: 'x.json' }); };
  const b = await bad.run();
  assert.equal(b.status, 'ROLLOUT_STOPPED');
  assert.equal(b.stage, 'accept');
  assert.equal(b.code, 'REQUEST_FILE_NAME_REFUSED');
  assert.equal(bad.sleeps.length, 0, 'an input error is not asked again');
  const down = scene('door-down', { door: 'accepted' });
  down.deps.seal = async () => { throw Object.assign(new Error('fetch failed'), { code: 'DOOR_UNREACHABLE' }); };
  const d = await down.run();
  assert.equal(d.status, 'ROLLOUT_STOPPED', JSON.stringify(d));
  assert.equal(d.stage, 'accept');
  assert.equal(d.code, 'DOOR_UNREACHABLE');
  assert.ok(down.sleeps.length > 0 && down.slept() <= 30 * 60_000, `retried, bounded: ${down.slept()}`);
  assert.equal(down.upgrades.length, 0);
});

// suggestion 6: plan 2.3 "its life is no longer than one request's validity"
test('the command lives no longer than the request: an Owner who approves late leaves the node wait only what is left of it', async () => {
  const s = scene('late-owner', { ending: 'STUCK', ownerClicksAt: 700 });
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_IN_PROGRESS', JSON.stringify(r));
  assert.ok(s.slept() <= 24 * 3600_000, `life ${s.slept() / 3600_000} h`);
  assert.equal(exitCodeOf(r), 2);
});

// suggestion 9: the door's copy of this node's Source may lag its current.json for a moment
test('right after this node upgrades the fleet read may still show its old Source: read again, bounded, and ROLLOUT_DONE once it shows the new one', async () => {
  const s = scene('fleet-lag', { door: 'accepted', other: { ...B_AT_NEW } });
  let reads = 0;
  s.deps.readFleet = async () => [{ node: 'fixture-a', ciSourceManifestSha256: ++reads <= 2 ? OLD : NEW, paused: false }, { ...B_AT_NEW }];
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_DONE', JSON.stringify(r));
  assert.equal(reads, 3);
  // a fleet read that never catches up: WAITING, bounded
  const t = scene('fleet-lag-for-ever', { door: 'accepted', other: { ...B_AT_NEW } });
  t.deps.readFleet = async () => [{ node: 'fixture-a', ciSourceManifestSha256: OLD, paused: false }, { ...B_AT_NEW }];
  const w = await t.run();
  assert.equal(w.status, 'ROLLOUT_WAITING_OTHER_NODES');
  assert.deepEqual(w.pending.map(n => n.node), ['fixture-a']);
  assert.ok(t.slept() <= 20 * 60_000, `${t.slept()}`);
});

test('the same command again after ROLLOUT_DONE changes nothing; a node already at the package is not requested', async () => {
  const s = scene('idempotent', { door: 'accepted', other: { ...B_AT_NEW } });
  assert.equal((await s.run()).status, 'ROLLOUT_DONE');
  const n = s.upgrades.length;
  const again = await s.run();
  assert.equal(again.status, 'ROLLOUT_DONE');
  assert.equal(s.upgrades.length, n, 'already requested once: only read');
  assert.equal(s.inboxFiles(), 1);
  // a node already at the package (a reinstall put it there): the command asks, upgrade.mjs answers already, nothing requested
  const at = scene('idempotent-at', { door: 'accepted', other: { ...B_AT_NEW } });
  writeJson(path.join(at.root, 'upgrade', 'current.json'), { generation: 2, ciSourceManifestSha256: NEW, linux: { generation: 2, ciSourceManifestSha256: NEW } });
  const r = await at.run();
  assert.equal(r.status, 'ROLLOUT_DONE');
  assert.equal(at.upgrades.length, 1);
  assert.equal(at.inboxFiles(), 0);
});

test('open: one seal call and no wait (what drill-vm.ps1 -Finalize runs): the link while the Owner has not approved; exit 0 on each of seal\'s three answers', async () => {
  const s = scene('open');
  const r = await main(['open', '--request', s.request, '--drill-receipt', path.join(s.dir, 'receipt.json')], s.deps);
  assert.equal(r.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  assert.equal(r.confirmUrl, CONFIRM);
  assert.equal(exitCodeOf(r), 0);
  assert.equal(s.seals.length, 1);
  assert.equal(s.seals[0].drillReceipt, path.join(s.dir, 'receipt.json'));
  assert.equal(s.sleeps.length, 0);
  assert.equal(s.upgrades.length, 0);
  for (const door of ['accepted', 'rejected']) {
    const o = scene(`open-${door}`, { door });
    const a = await main(['open', '--request', o.request], o.deps);
    assert.equal(a.status, door === 'accepted' ? 'FLEET_ACCEPTANCE_SEALED' : 'FLEET_ACCEPTANCE_REJECTED');
    assert.equal(exitCodeOf(a), 0, door);
  }
});

// PLAN-accept-binding-20261125.md section 3 piece C: seal dispatches the release workflow's fleet-accept mode, so the door's pending
// request (and its link) appears only once that run reaches the door; open waits for the link, bounded
test('open waits, bounded, for the link while the request is queued; no link in 5 minutes: NOT_OPENED with FLEET_ACCEPTANCE_OPEN_QUEUED, exit non-zero', async () => {
  const s = scene('open-queued', { ownerClicksAt: 1e9 });
  const seal = s.deps.seal;
  let n = 0;
  s.deps.seal = async a => (++n <= 2 ? { status: 'FLEET_ACCEPTANCE_WAITING_OWNER', confirmUrl: null } : seal(a));
  const r = await main(['open', '--request', s.request], s.deps);
  assert.equal(r.status, 'FLEET_ACCEPTANCE_WAITING_OWNER', JSON.stringify(r));
  assert.equal(r.confirmUrl, CONFIRM);
  assert.equal(n, 3);
  assert.ok(s.slept() <= 5 * 60_000);
  assert.equal(exitCodeOf(r), 0);
  const q = scene('open-never');
  q.deps.seal = async () => ({ status: 'FLEET_ACCEPTANCE_WAITING_OWNER', confirmUrl: null });
  const t = await main(['open', '--request', q.request], q.deps);
  assert.equal(t.status, 'NOT_OPENED', JSON.stringify(t));
  assert.equal(t.code, 'FLEET_ACCEPTANCE_OPEN_QUEUED');
  assert.equal(t.confirmUrl, null);
  assert.ok(q.sleeps.length > 0 && q.slept() <= 5 * 60_000, `${q.slept()}`);
  assert.notEqual(exitCodeOf(t), 0);
  assert.equal(q.upgrades.length, 0);
});

test('run: a queued answer (no link yet) is waited on like the Owner, not a stop; the fleet is read through piece B with this request\'s repository and version', async () => {
  const s = scene('run-queued', { door: 'accepted', other: { ...B_AT_NEW } });
  const seal = s.deps.seal, read = s.deps.readFleet, reads = [];
  let n = 0;
  s.deps.seal = async a => (++n === 1 ? { status: 'FLEET_ACCEPTANCE_OPEN_QUEUED' } : n === 2 ? { status: 'FLEET_ACCEPTANCE_WAITING_OWNER', confirmUrl: null } : seal(a));
  s.deps.readFleet = async a => { reads.push(a); return read(a); };
  const r = await s.run();
  assert.equal(r.status, 'ROLLOUT_DONE', JSON.stringify(r));
  assert.ok(reads.length > 0 && reads.every(a => a.repo === 'tdoljyj/cross-memory-system' && a.version === VERSION && a.request === s.request), JSON.stringify(reads));
});

test('no hand-written Decision has a way in: --decision-record, a missing --work or --request is USAGE and nothing is asked', async () => {
  const s = scene('usage');
  for (const argv of [['run', '--request', s.request, '--work', s.work, '--decision-record', path.join(s.dir, 'd.json')], ['run', '--request', s.request],
    ['run', '--work', s.work], ['open', '--request', s.request, '--work', s.work], ['seal', '--request', s.request], ['run', '--request', s.request, '--work', s.work, '--wait', 'x']]) {
    const r = await main(argv, s.deps);
    assert.equal(r.code, 'USAGE', JSON.stringify(argv));
    assert.equal(exitCodeOf(r), 1);
  }
  assert.equal(s.seals.length, 0);
  assert.equal(s.upgrades.length, 0);
});
