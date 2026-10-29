// Offline drill of the whole channel (spec B1): packages built by tools/build-package.mjs (/4), a generation-1 layout in a
// temporary root, and stand-ins that speak the real contracts:
//   - a resident that takes requests\ (pause, intake hold/lift) and owner\ (upgrade-resume, resume) with the resident's own
//     validators, keeps state\PAUSED.json, state\status.json and a real receipt chain; the upgrader reads it through the real
//     file-based ResidentPort;
//   - the SCM and upgrade-apply.ps1 as one JSON file (fixtures.mjs FakeWindows);
//   - the companion's upgrade-mailbox lane with a JS stand-in of clued-ci-upgrade-linux behind it, through the real
//     UpgradeMailbox / LinuxPort / responseFromTool (B3's Python tool needs a whole fake Linux host with a signer and a Source v2
//     bundle; its own tests, test/test_upgrade_linux.py, cover it);
//   - the Grant door, approved or rejected on "the page".
// Scenario: N -> N+1 succeeds; N+2 is rejected on the page; N+2 again fails its verify and is rolled back to N+1, kept paused;
// the Owner resumes; three more generations; three are kept, the older ones only moved to archive\. Then every step boundary
// of an upgrade is crashed (intent written, result not) and resumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, exactKeys, parseBoundedJson, sha256 } from '../../src/canonical.mjs';
import { Inbox, OwnerInbox } from '../../src/inbox.mjs';
import { ReceiptChain } from '../../src/receipts.mjs';
import { INTAKE_PAUSE_CONTRACT, INTAKE_RESUME_CONTRACT, validateIntakeRequest } from '../../src/intake-pause.mjs';
import { LINUX_VERSION_FACTS_CONTRACT, UPGRADE_RESUME_CONTRACT, UpgradeMailbox, responseFromTool, upgradeToolArgs, validateUpgradeResume } from '../../src/upgrade-mailbox.mjs';
import { nodeProfileSha256 } from '../../src/node-profile.mjs';
import { buildPackage } from '../../tools/build-package.mjs';
import { fixtureRecord } from '../../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { writeRecord } from '../../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs';
import { Machine } from '../src/machine.mjs';
import { Generations, fsOps } from '../src/generations.mjs';
import { ResidentPort, PAUSE_CONTRACT } from '../src/resident-ports.mjs';
import { LinuxPort } from '../src/linux-port.mjs';
import { readPackageOnce } from '../src/package.mjs';
import { Journal } from '../src/journal.mjs';
import { FakeDoor, FakeWindows, T0, fakeClock, installGeneration1, tempDir, testConfig, treeDigest, upgradeRequestBytes } from './fixtures.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESUME_CONTRACT = 'clued.independent-ci.resident-owner-resume/1';
const MIN = 60_000;

// ---- packages ----

async function buildPackages(t, count) {
  const root = await tempDir(t, 'clued-drill-pkg-');
  const node = path.join(root, 'node.exe');
  await fs.writeFile(node, 'not really node');
  const record = path.join(root, 'record');
  const fx = fixtureRecord();
  writeRecord(record, { files: fx.files, recordManifest: fx.recordManifest });
  const profile = JSON.parse(fx.files['acceptance.json']).node;
  const companionInput = JSON.parse(await fs.readFile(path.join(HERE, 'config', 'companion.example.json'), 'utf8'));
  Object.assign(companionInput.companion, { node: profile, nodeProfileSha256: nodeProfileSha256(profile), distribution: profile.wslDistribution });
  const companionFile = path.join(root, 'companion.json');
  await fs.writeFile(companionFile, JSON.stringify(companionInput));
  const pkgs = [];
  for (let i = 0; i < count; i += 1) {
    const policyInput = JSON.parse(await fs.readFile(path.join(HERE, 'config', 'policy.example.json'), 'utf8'));
    policyInput.node = profile; policyInput.nodeProfileSha256 = nodeProfileSha256(profile);
    policyInput.companion.userSid = profile.ownerSid; policyInput.linux.distribution = profile.wslDistribution;
    policyInput.retention.checkEveryMs = 3_600_000 + i * 1000; // one generation differs from the next by its policy
    const policyFile = path.join(root, `policy-${i}.json`);
    await fs.writeFile(policyFile, JSON.stringify(policyInput));
    const out = path.join(root, `pkg-${i}`);
    const r = await buildPackage({ out, policyFile, companionFile, nodeExe: node, recordDir: record });
    const read = await readPackageOnce(out, r.packageManifestSha256);
    const m = read.manifest;
    pkgs.push({ dir: out, sha: r.packageManifestSha256, manifest: m, files: read.bytesByPath, residentSha: m.residentManifestSha256, ciSource: m.ciSourceManifestSha256,
      policySha: m.files.find(f => f.target === 'config\\policy.json').sha256, linuxSha: m.linux.manifestSha256 });
  }
  return { pkgs, profile };
}

// ---- the resident, on files ----

class FileResident {
  constructor(root, clock) { Object.assign(this, { root, clock, running: true, holds: new Map() }); this.state = path.join(root, 'state'); }
  async open() {
    for (const d of ['requests', 'owner', 'state/ledger', 'mailbox/responses', 'broker/requests', 'broker/responses']) await fs.mkdir(path.join(this.root, d), { recursive: true });
    this.receipts = await ReceiptChain.open(path.join(this.state, 'receipts'), this.clock.fn);
    this.requests = await Inbox.open(path.join(this.root, 'requests'), path.join(this.state, 'requests-archive'), this.clock.fn);
    this.owner = await OwnerInbox.open(path.join(this.root, 'owner'), path.join(this.state, 'owner-seen'));
    await fs.mkdir(path.join(this.state, 'halts'), { recursive: true });
    await this.writeStatus();
    return this;
  }
  pausedFile() { return path.join(this.state, 'PAUSED.json'); }
  async pausedBytes() { try { return await fs.readFile(this.pausedFile()); } catch { return null; } }
  async writeStatus() {
    const paused = await this.pausedBytes();
    const v = { contract: 'clued.independent-ci.resident-status/7', writtenAt: new Date(this.clock.now).toISOString(), executor: { state: paused ? 'PAUSED' : 'IDLE' }, current: null,
      node: { probe: { at: new Date(this.clock.now).toISOString() } } };
    await fs.writeFile(path.join(this.state, 'status.json'), JSON.stringify(v));
  }
  // One executor tick: requests\ (pause, intake), owner\ (upgrade-resume, resume), the status.
  async tick() {
    if (!this.running) return;
    for (const e of await this.requests.read(16, 1024)) {
      let disposition = 'rejected';
      try {
        const v = parseBoundedJson(e.bytes, 1024, 'X');
        if ([INTAKE_PAUSE_CONTRACT, INTAKE_RESUME_CONTRACT].includes(v.contract)) {
          const r = validateIntakeRequest(v);
          if (r.contract === INTAKE_PAUSE_CONTRACT) this.holds.set(r.holder, this.clock.now + r.minutes * MIN); else this.holds.delete(r.holder);
          disposition = 'processed';
        } else {
          exactKeys(v, ['contract', 'reason'], 'X');
          if (v.contract === PAUSE_CONTRACT) {
            if (!(await this.pausedBytes())) {
              await fs.writeFile(this.pausedFile(), canonicalJson({ source: { reason: v.reason, requestSha256: sha256(e.bytes) }, at: new Date(this.clock.now).toISOString() }) + '\n', { flag: 'wx' });
              await this.receipts.append('paused', { reason: v.reason, requestSha256: sha256(e.bytes) });
            }
            disposition = 'processed';
          }
        }
      } catch { disposition = 'rejected'; }
      await this.requests.dispose(e.name, disposition);
    }
    for (const e of await this.owner.read(8, 2048)) {
      const requestSha256 = sha256(e.bytes);
      try {
        const v = JSON.parse(e.bytes.toString('utf8'));
        const want = v.contract === UPGRADE_RESUME_CONTRACT ? validateUpgradeResume(v).pausedSha256 : (v.contract === RESUME_CONTRACT ? v.pausedSha256 : null);
        const paused = await this.pausedBytes();
        if (want && paused && sha256(paused) === want) {
          await fs.rename(this.pausedFile(), path.join(this.state, 'halts', `resumed-${this.clock.now}-${requestSha256.slice(0, 8)}.json`));
          await this.receipts.append(v.contract === UPGRADE_RESUME_CONTRACT ? 'upgrade-resumed' : 'resumed', { requestSha256 });
        }
      } catch { /* refused */ }
      await this.owner.remember(e.name, requestSha256);
    }
    await this.writeStatus();
  }
  stop() { this.running = false; }
  async start(policySha256, generation) {
    if (this.running) return;
    this.running = true;
    await this.receipts.append('service-start', { policySha256, pid: 1, generation });
    await this.tick();
  }
}

// ---- the companion's upgrade lane and a JS stand-in of the root tool (A7 contract: argv in, one JSON line out) ----

class LinuxToolStandIn {
  constructor(root, clock, { failVerify = () => false } = {}) { Object.assign(this, { root, clock, failVerify }); this.file = path.join(root, 'fake-linux.json'); this.changed = false; }
  async state() { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
  async save(s) { await fs.writeFile(this.file, canonicalJson(s) + '\n'); }
  out(exit, v) { return { exit, stdout: `${JSON.stringify(v)}\n` }; }
  async run(argv) {
    const [sub, ...rest] = argv;
    const flag = name => rest[rest.indexOf(`--${name}`) + 1];
    const s = await this.state();
    switch (sub) {
      case 'version-facts': return this.out(0, await this.facts());
      case 'stage': {
        // The package from the fixed staged prefix (upgrade\staged\<pkgSha>\ on the Windows side).
        let m;
        try { m = JSON.parse(await fs.readFile(path.join(this.root, 'upgrade', 'staged', flag('package'), 'package-manifest.json'), 'utf8')); } catch { return this.out(2, { status: 'refused', code: 'UPGRADE_LINUX_STAGE_REFUSED' }); }
        if (sha256(await fs.readFile(path.join(this.root, 'upgrade', 'staged', flag('package'), 'linux', 'manifest.json'))) !== flag('linux-manifest')) return this.out(2, { status: 'refused', code: 'UPGRADE_LINUX_STAGE_REFUSED' });
        s.history[flag('generation')] = { manifestSha256: m.linux.manifestSha256, ciSourceManifestSha256: m.ciSourceManifestSha256 };
        await this.save(s);
        return this.out(0, { status: 'staged', generation: Number(flag('generation')) });
      }
      case 'switch': case 'rollback': {
        const to = Number(flag('to'));
        if (!s.history[to]) return this.out(3, { status: 'refused', code: 'UPGRADE_LINUX_SWITCH_REFUSED' });
        if (s.generation !== to) { s.generation = to; s.at = this.clock.now; await this.save(s); this.changed = true; }
        return this.out(0, { status: sub === 'switch' ? 'switched' : 'rolled-back', generation: to });
      }
      case 'verify': {
        const g = Number(flag('generation'));
        return s.generation === g && !this.failVerify(g) ? this.out(0, { status: 'verified', generation: g }) : this.out(4, { status: 'refused', code: 'UPGRADE_LINUX_VERIFY_REFUSED' });
      }
      default: return this.out(64, { status: 'refused', code: 'UPGRADE_LINUX_USAGE' });
    }
  }
  async facts() {
    const s = await this.state();
    const h = s.history[s.generation];
    return { contract: LINUX_VERSION_FACTS_CONTRACT, generation: s.generation, ciSourceManifestSha256: h.ciSourceManifestSha256, sourceCommit: null, manifestSha256: h.manifestSha256,
      roles: {}, pinsOk: true, staged: null, upgradeToolSha256: 'd4'.repeat(32), observedAt: new Date(this.clock.now).toISOString() };
  }
}

class DrillCompanion {
  constructor(root, clock, tool) { Object.assign(this, { root, clock, tool }); this.box = new UpgradeMailbox(path.join(root, 'upgrade', 'mailbox'), clock.fn); this.factsAt = -Infinity; }
  async pass() {
    await fs.writeFile(path.join(this.root, 'mailbox', 'responses', 'heartbeat.json'), JSON.stringify({ contract: 'clued.independent-ci.resident-companion-heartbeat/1', at: this.clock.now }));
    for (const r of await this.box.pending()) {
      if (r.refused) continue;
      const resp = responseFromTool(r, await this.tool.run(upgradeToolArgs(r)), this.clock.fn);
      await this.box.respond(r, { ok: resp.ok, code: resp.code, tool: resp.tool, result: resp.result });
    }
    if (this.tool.changed || this.clock.now - this.factsAt >= 5 * MIN) {
      this.tool.changed = false;
      this.factsAt = this.clock.now;
      await this.box.writeVersionFacts(await this.tool.facts());
    }
  }
}

// ---- one node ----

async function makeNode(t, shared, { failVerify = () => false } = {}) {
  const root = await tempDir(t, 'clued-drill-root-');
  const clock = fakeClock(T0);
  const [base] = shared.pkgs;
  await installGeneration1(root, base, { upgraderManifest: base.manifest.upgrader.manifestSha256, nodeProfile: base.manifest.nodeProfileSha256, nodeIdentity: base.manifest.nodeIdentitySha256 });
  const resident = await new FileResident(root, clock).open();
  const tool = new LinuxToolStandIn(root, clock);
  const companion = new DrillCompanion(root, clock, tool);
  await companion.box.sweep('responses');
  const linux = await LinuxPort.open(path.join(root, 'upgrade', 'mailbox'), { clock: clock.fn, sleep: async ms => { await companion.pass(); clock.advance(ms); }, pollMs: 2_000 });
  const node = { root, clock, resident, tool, companion,
    door: new FakeDoor(clock, { approveAt: null }),
    windows: new FakeWindows(root, resident, { failVerify }),
    config: testConfig(root, { node: shared.profile.nodeName, nodeProfileSha256: base.manifest.nodeProfileSha256, ownerSid: shared.profile.ownerSid }) };
  node.ports = { door: node.door, resident: new ResidentPort(root, { clock: clock.fn }), windows: node.windows, linux };
  return node;
}

let opCounter = 0;
async function upgrade(node, pkg, { approveAfterMs = 20 * MIN, reject = false, crashAt = 0 } = {}) {
  const opId = `d0000000-0000-4000-8000-${String(++opCounter).padStart(12, '0')}`;
  await Journal.create(path.join(node.root, 'upgrade', 'ops'), opId, upgradeRequestBytes(pkg, { requestId: opId, node: node.config.node, at: node.clock.now,
    acceptanceDecisionRef: pkg.manifest.acceptance.decisionRef }), { clock: node.clock.fn });
  node.door.reject = reject;
  node.door.approveAt = reject ? null : node.clock.now + approveAfterMs; // the Owner clicks on the page
  let writes = 0, crashes = 0;
  const tick = () => { writes += 1; if (crashAt && writes === crashAt) { crashes += 1; throw Object.assign(new Error('crash'), { injected: true }); } };
  const make = () => {
    const gens = new Generations(node.root, { ops: fsOps });
    const m = new Machine({ root: node.root, opId, config: node.config, clock: node.clock.fn, pid: 9, ports: node.ports, generations: gens });
    // Crash points: each step's intent written, its result not.
    const real = m.journal.intent.bind(m.journal);
    m.journal.intent = async (...a) => { const r = await real(...a); tick(); return r; };
    return m;
  };
  let m = make();
  for (let i = 0; i < 3000; i += 1) {
    await node.resident.tick();
    await node.companion.pass();
    let r;
    try { r = await m.step(); } catch (error) { if (!error.injected) throw error; m = make(); continue; }
    if (r.done) return { opId, terminal: r.terminal, intents: writes, crashes };
    if (r.wait > 0) node.clock.advance(Math.min(r.wait, 2 * MIN));
  }
  throw new Error('drill operation did not end');
}

const managed = node => treeDigest(node.root, { exclude: rel => /^(?:requests|owner|state|mailbox|broker)(?:\/|$)/.test(rel) || rel.startsWith('upgrade/ops/') || rel.startsWith('upgrade/mailbox/')
  || rel === 'upgrade/status.json' || rel.startsWith('upgrade/inbox') });
const readJson = async f => JSON.parse(await fs.readFile(f, 'utf8'));

test('drill: N -> N+1, a rejected Grant, a failed verify rolled back and kept paused, the Owner resumes, five generations with three kept', async t => {
  const shared = await buildPackages(t, 6);
  const [, n1, n2, n3, n4, n5] = shared.pkgs;
  const node = await makeNode(t, shared, { failVerify: g => g === 3 && node.failNext });
  node.failNext = false;

  const a = await upgrade(node, n1);
  assert.equal(a.terminal.outcome, 'SUCCEEDED');
  assert.equal((await readJson(path.join(node.root, 'upgrade', 'current.json'))).generation, 2);
  assert.equal(await node.resident.pausedBytes(), null, 'resumed by upgrade-resume');
  assert.deepEqual([...node.resident.holds.keys()], [], 'the intake hold is lifted');
  const starts = (await node.resident.receipts.latest(['service-start'], 5)).map(r => r.value.body);
  assert.deepEqual(starts.map(b => [b.policySha256, b.generation]), [[n1.policySha, 2]]);
  assert.ok((await node.resident.receipts.latest(['upgrade-resumed'], 1)).length === 1);

  const before = await managed(node);
  const b = await upgrade(node, n2, { reject: true });
  assert.deepEqual([b.terminal.outcome, b.terminal.code], ['GRANT_REJECTED', 'UPGRADE_GRANT_REJECTED']);
  assert.deepEqual(await managed(node), before, 'a rejected Grant changes nothing');

  node.failNext = true;
  const c = await upgrade(node, n2);
  assert.deepEqual([c.terminal.outcome, c.terminal.code], ['ROLLED_BACK_PAUSED', 'UPGRADE_VERIFY_FAILED']);
  const afterRollback = await managed(node);
  for (const k of Object.keys(before).filter(k => !k.startsWith('fake-') && !k.startsWith('upgrade/staged') && !k.startsWith('resident/') && !k.startsWith('source/'))) {
    assert.equal(afterRollback[k], before[k], `back to generation 2: ${k}`);
  }
  assert.equal((await readJson(path.join(node.root, 'fake-linux.json'))).generation, 2);
  const paused = await node.resident.pausedBytes();
  assert.ok(paused, 'kept paused');
  const status = await readJson(path.join(node.root, 'upgrade', 'status.json')).catch(() => null);
  void status;
  // The Owner looks, then resumes (elevated, owner\).
  await fs.writeFile(path.join(node.root, 'owner', Inbox.fileName(node.clock.now)), JSON.stringify({ contract: RESUME_CONTRACT, pausedSha256: sha256(paused), by: 'S-1-5-21-1-2-3-1001',
    requestedAt: new Date(node.clock.now).toISOString(), nonce: 'ef'.repeat(8) }));
  await node.resident.tick();
  assert.equal(await node.resident.pausedBytes(), null);
  node.failNext = false;

  for (const [pkg, g] of [[n3, 3], [n4, 4], [n5, 5]]) {
    const r = await upgrade(node, pkg);
    assert.equal(r.terminal.outcome, 'SUCCEEDED', `generation ${g}`);
    assert.equal(r.terminal.generation, g);
  }
  assert.deepEqual((await fs.readdir(path.join(node.root, 'generations'))).sort(), ['g3', 'g4', 'g5']);
  const archived = (await fs.readdir(path.join(node.root, 'archive'))).sort();
  assert.deepEqual(archived.filter(n => /^g\d$/.test(n)), ['g1', 'g2']);
  assert.ok(archived.some(n => n.startsWith('g3-rolled-back-')), 'the rolled-back generation 3 is kept in archive\\');
  // Nothing deleted: every generation's policy is still on disk.
  assert.deepEqual(await fs.readFile(path.join(node.root, 'archive', 'g1', 'config', 'policy.json')), shared.pkgs[0].files.get('config/policy.json'));
  assert.deepEqual(await fs.readFile(path.join(node.root, 'archive', 'g2', 'config', 'policy.json')), n1.files.get('config/policy.json'));
  assert.deepEqual(await fs.readFile(path.join(node.root, 'config', 'policy.json')), n5.files.get('config/policy.json'));
  const current = await readJson(path.join(node.root, 'upgrade', 'current.json'));
  assert.equal(current.packageManifestSha256, n5.sha);
  const facts = await node.companion.box.readVersionFacts();
  assert.equal(facts.generation, 5);
});

test('drill: every step boundary of an upgrade (intent written, result not) crashed and resumed ends where the uninterrupted one does', async t => {
  const shared = await buildPackages(t, 2);
  const ref = await makeNode(t, shared);
  opCounter = 100;
  const r0 = await upgrade(ref, shared.pkgs[1]);
  assert.equal(r0.terminal.outcome, 'SUCCEEDED');
  const want = await managed(ref);
  const failures = [];
  for (let at = 1; at <= r0.intents; at += 1) {
    const node = await makeNode(t, shared);
    opCounter = 100;
    const r = await upgrade(node, shared.pkgs[1], { crashAt: at });
    assert.equal(r.crashes, 1);
    try {
      assert.equal(r.terminal.outcome, 'SUCCEEDED');
      assert.deepEqual(await managed(node), want);
    } catch (error) { failures.push({ at, message: error.message.slice(0, 400) }); }
    await fs.rm(node.root, { recursive: true, force: true });
  }
  assert.deepEqual(failures, []);
  t.diagnostic(`step boundaries crashed: ${r0.intents}`);
});
