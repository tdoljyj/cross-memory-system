// rollout/fleet/accept.mjs run: one bounded command from the Owner's acceptance to every node on the accepted Source
// (PLAN-accept-auto-seal-20261125.md 2.3, piece C). A fixture node root (upgrade\inbox, status.json, current.json) and a fake door
// behind a fake seal (piece B's seal() answers: FLEET_ACCEPTANCE_WAITING_OWNER with confirmUrl, FLEET_ACCEPTANCE_SEALED,
// FLEET_ACCEPTANCE_REJECTED), a fake Release directory, a fake installed upgrader that moves on the fake clock, and a fake fleet read.
// Nothing here reaches the network, a real node root or a real door.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-accept-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

// One scene: this node (fixture-a, the one the command runs on) at OLD, another node (fixture-b), a request, a door, a Release.
//   onDuty   fixture-a holds ci-admission: upgrade.mjs answers HAND_OVER_FIRST unless --allow-active-upgrade
//   ending   how the installed upgrader ends the operation it is asked for: SUCCEEDED (both sides NEW) or ROLLED_BACK_PAUSED
//   door     pending | accepted | rejected; ownerClicksAt: the sleep (1-based) at which the Owner approves on the page
function scene(name, { onDuty = false, ending = 'SUCCEEDED', door = 'pending', ownerClicksAt = 1, other = { node: 'fixture-b', ciSourceManifestSha256: OLD, paused: false } } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const root = path.join(dir, 'root'), release = path.join(dir, 'release'), work = path.join(dir, 'work');
  const inbox = path.join(root, 'upgrade', 'inbox');
  fs.mkdirSync(inbox, { recursive: true }); fs.mkdirSync(release);
  const current = path.join(root, 'upgrade', 'current.json'), status = path.join(root, 'upgrade', 'status.json');
  writeJson(current, { generation: 1, ciSourceManifestSha256: OLD, packageManifestSha256: 'c'.repeat(64), linux: { generation: 1, ciSourceManifestSha256: OLD } });
  writeJson(status, { op: null, recent: [] });
  const request = path.join(dir, 'accept', `${TAG}.acceptance-request.json`);
  const req = { contract: 'clued.independent-ci.fleet-node-acceptance-request/1', version: VERSION, archive_sha256: 'd'.repeat(64), commit: 'e'.repeat(40),
    repository: 'tdoljyj/cross-memory-system', ciSourceManifestSha256: NEW, firstInstallKitSha256: 'f'.repeat(64),
    fleetRefs: { sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), ownerAuthorizationRef: randomUUID(), publisherQualificationRef: randomUUID(),
      ownerPackageAcceptanceRef: randomUUID(), formalRoles: { 'contract-placement': { keyId: 'k' } } } };
  writeJson(request, req);
  const s = { dir, root, release, work, inbox, request, door, other, clock: Date.parse('2026-11-25T03:00:00Z'), sleeps: [], seals: [], upgrades: [], fleetReads: 0, op: null };
  const grant = { grant_id: randomUUID(), receipt_id: randomUUID(), accepted_at: '2026-11-25T03:00:31Z' };
  const atNew = () => { const c = readJson(current); return c.ciSourceManifestSha256 === NEW && c.linux.ciSourceManifestSha256 === NEW; };
  // the installed upgrader: WAITING_GRANT (auto-approved) -> RUNNING -> its ending, one step per look
  const tick = () => {
    if (!s.op) return;
    const st = readJson(status);
    if (s.op.state === 'WAITING_GRANT') { s.op.state = 'RUNNING'; st.op = { ...s.op }; }
    else if (s.op.state === 'RUNNING') {
      for (const f of fs.readdirSync(inbox)) fs.renameSync(path.join(inbox, f), path.join(dir, `archived-${f}`));   // what the upgrader takes in
      fs.mkdirSync(inbox, { recursive: true });
      const at = new Date(s.clock).toISOString();
      if (ending === 'SUCCEEDED') {
        writeJson(current, { generation: 2, ciSourceManifestSha256: NEW, packageManifestSha256: s.op.packageManifestSha256, linux: { generation: 2, ciSourceManifestSha256: NEW } });
        st.recent = [...st.recent, { opId: s.op.opId, outcome: 'SUCCEEDED', code: null, generation: 2, at }];
      } else {
        st.recent = [...st.recent, { opId: s.op.opId, outcome: 'ROLLED_BACK_PAUSED', code: 'VERIFY_FAILED', generation: 1, at }];
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
    // upgrade.mjs fetch's answers, from the fixture root; a request is one file in upgrade\inbox (the installed request-upgrade.ps1)
    upgrade: async argv => {
      s.upgrades.push(argv);
      const statusFile = status;
      if (s.op) return { status: 'FLEET_NODE_UPGRADE_IN_PROGRESS', statusFile, op: { opId: s.op.opId, state: s.op.state } };
      if (atNew()) return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', statusFile, generation: 2 };
      if (s.refuse) return { status: s.refuse, code: 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', node: 'fixture-a', statusFile };
      if (onDuty && !argv.includes('--allow-active-upgrade')) return { status: 'FLEET_NODE_UPGRADE_HAND_OVER_FIRST', node: 'fixture-a', statusFile };
      const requestId = randomUUID(), pkg = '9'.repeat(64);
      const requestFile = path.join(inbox, `${requestId}.json`);
      fs.writeFileSync(requestFile, JSON.stringify({ requestId, node: 'fixture-a', packageManifestSha256: pkg }), { flag: 'wx' });
      s.op = { opId: randomUUID(), state: 'WAITING_GRANT', packageManifestSha256: pkg };
      writeJson(status, { ...readJson(status), op: { ...s.op } });
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
  s.inboxFiles = () => fs.readdirSync(inbox).length + fs.readdirSync(dir).filter(f => f.startsWith('archived-')).length;
  s.acceptanceOnRelease = () => fs.existsSync(path.join(release, `${TAG}.acceptance.json`));
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
  s.other = { node: 'fixture-b', ciSourceManifestSha256: NEW, paused: false };
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
  s.other = { node: 'fixture-b', ciSourceManifestSha256: NEW, paused: false };
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
  assert.ok(w.sleeps.reduce((a, b) => a + b, 0) <= 5 * 60_000, 'bounded by --wait');
  assert.equal(w.upgrades.length, 0);
  assert.ok(!w.acceptanceOnRelease());
});

test('the same command again after ROLLOUT_DONE changes nothing; a node already at the package is not requested', async () => {
  const s = scene('idempotent', { door: 'accepted', other: { node: 'fixture-b', ciSourceManifestSha256: NEW, paused: false } });
  assert.equal((await s.run()).status, 'ROLLOUT_DONE');
  const n = s.upgrades.length;
  const again = await s.run();
  assert.equal(again.status, 'ROLLOUT_DONE');
  assert.equal(s.upgrades.length, n, 'already requested once: only read');
  assert.equal(s.inboxFiles(), 1);
  // a node already at the package (a reinstall put it there): the command asks, upgrade.mjs answers already, nothing requested
  const at = scene('idempotent-at', { door: 'accepted', other: { node: 'fixture-b', ciSourceManifestSha256: NEW, paused: false } });
  writeJson(path.join(at.root, 'upgrade', 'current.json'), { generation: 2, ciSourceManifestSha256: NEW, linux: { generation: 2, ciSourceManifestSha256: NEW } });
  const r = await at.run();
  assert.equal(r.status, 'ROLLOUT_DONE');
  assert.equal(at.upgrades.length, 1);
  assert.equal(at.inboxFiles(), 0);
});

test('open: one seal call and no wait (what drill-vm.ps1 -Finalize runs): the link while the Owner has not approved', async () => {
  const s = scene('open');
  const r = await main(['open', '--request', s.request, '--drill-receipt', path.join(s.dir, 'receipt.json')], s.deps);
  assert.equal(r.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  assert.equal(r.confirmUrl, CONFIRM);
  assert.equal(exitCodeOf(r), 0);
  assert.equal(s.seals.length, 1);
  assert.equal(s.seals[0].drillReceipt, path.join(s.dir, 'receipt.json'));
  assert.equal(s.sleeps.length, 0);
  assert.equal(s.upgrades.length, 0);
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
