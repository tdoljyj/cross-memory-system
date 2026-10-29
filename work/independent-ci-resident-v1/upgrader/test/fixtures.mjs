// Test fixtures for the upgrader: /4 packages, an installed generation-1 layout in a temporary root, and fake ports that
// keep their own state (so that a "crash" of the upgrader, a new Machine on the same root, finds the world as it was).
// Nothing here touches a real host directory, the network or a secret.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, sha256 } from '../../src/canonical.mjs';
import { GENERATION_CURRENT_CONTRACT, LINUX_VERSION_FACTS_CONTRACT, derivedRequestId } from '../../src/upgrade-mailbox.mjs';
import { PACKAGE_CONTRACT, WINDOWS_LAYOUT } from '../src/package.mjs';
import { GENERATED_SLOTS, RECEIPT_SLOT } from '../src/plan.mjs';
import { UPGRADE_REQUEST_CONTRACT } from '../src/request.mjs';
import { U } from '../src/codes.mjs';

export const NODE = 'fixture-node';
export const OWNER_SID = 'S-1-5-21-1-2-3-1001';
export const NODE_PROFILE = 'a1'.repeat(32);
export const NODE_IDENTITY = 'b2'.repeat(32);
export const DECISION = '0d84ddbb-ec1f-49c3-bbd0-953f72d53584';
export const UPGRADER_MANIFEST = 'c3'.repeat(32);
export const T0 = Date.parse('2026-10-29T08:00:00.000Z');
const MIN = 60_000;

export const json = v => Buffer.from(canonicalJson(v) + '\n', 'utf8');

export async function tempDir(t, prefix = 'clued-upgrader-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

export function testConfig(root, over = {}) {
  return { contract: 'clued.independent-ci.resident-upgrader-config/1', node: NODE, nodeProfileSha256: NODE_PROFILE, ownerSid: OWNER_SID, root,
    supabaseUrl: 'https://fixture-project.supabase.co', publishableKey: 'sb_publishable_FIXTUREONLY', confirmOrigin: 'https://kooyumi.pixelgrav.com',
    tokenFile: path.join(root, 'secrets', 'resident-upgrade.token'),
    timeouts: { drainMaxMinutes: 120, drainRetryMinutes: 60, deferMaxHours: 24, pauseConfirmMs: 600_000, verifyMaxMs: 2_700_000, grantPollMs: [30_000, 120_000] },
    keepGenerations: 3, ...over };
}

export const fakeCompiled = (slot, residentSha) => Buffer.from(`compiled ${slot} from ${residentSha}\n`, 'utf8');

// A /4 package with every white-listed slot. `mutate(manifest, files)` may change it before it is written (refusal tests).
export async function buildTestPackage(out, { tag, stateCompat = { schema: 1, readableBySchemas: [1] }, decisionRef = DECISION, upgrader = null, mutate = null,
  ownerSid = OWNER_SID, nodeProfileSha256 = NODE_PROFILE, nodeIdentitySha256 = NODE_IDENTITY, windowsLayout = WINDOWS_LAYOUT, sourceTag = tag } = {}) {
  const f = new Map();
  const put = (p, text) => f.set(p, Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'));
  for (const name of ['service-main.mjs', 'companion-main.mjs', 'executor.mjs']) put(`resident/src/${name}`, `// ${name} ${tag}\n`);
  for (const name of ['CompanionJobHost.cs', 'ResidentServiceHost.cs', 'SwapBroker.cs']) put(`resident/windows/${name}`, `// ${name} ${tag}\n`);
  put('source/work/ci/derive.mjs', `// source ${sourceTag}\n`);
  for (const name of ['installation.json', 'acceptance.json', 'signers.json']) put(`record/${name}`, `{"record":"${name}","tag":"${sourceTag}"}\n`);
  put('record/source-manifest.json', `{"source":"${sourceTag}"}\n`);
  const ciSource = sha256(f.get('record/source-manifest.json'));
  put('record/record-manifest.json', `{"sourceManifestSha256":"${ciSource}"}\n`);
  const residentFiles = [...f.keys()].filter(p => p.startsWith('resident/')).map(p => ({ path: p.slice(9), sha256: sha256(f.get(p)) }));
  put('config/resident-installed-manifest.json', json({ contract: 'x', root: 'resident', files: residentFiles }));
  const residentSha = sha256(f.get('config/resident-installed-manifest.json'));
  put('config/source-installed-manifest.json', json({ contract: 'x', root: 'source', files: [{ path: 'work/ci/derive.mjs', sha256: sha256(f.get('source/work/ci/derive.mjs')) }] }));
  const sourceSha = sha256(f.get('config/source-installed-manifest.json'));
  put('config/policy.json', json({ tag, residentManifestSha256: residentSha, ciSourceManifestSha256: ciSource, sourceManifestSha256: sourceSha,
    ownerAcceptance: { decisionRef, installReceiptRef: null }, nodeProfileSha256, companion: { userSid: ownerSid } }));
  put('config/companion.json', json({ tag, companion: { node: NODE } }));
  put('runtime/node.exe', `node runtime ${tag === 'n3' ? 'v2' : 'v1'}\n`);
  put('linux/bin/clued-ci-resident-linux', `#!/usr/bin/python3 ${sourceTag}\n`);
  put('linux/manifest.json', json({ contract: 'clued.independent-ci.resident-linux-manifest/2', files: [{ installedPath: '/opt/x', sha256: sha256(f.get('linux/bin/clued-ci-resident-linux')) }] }));
  const files = [];
  for (const p of [...f.keys()].sort()) {
    if (p.startsWith('resident/')) files.push({ path: p, target: `resident\\${residentSha}\\${p.slice(9).replace(/\//g, '\\')}`, sha256: sha256(f.get(p)) });
    else if (p.startsWith('source/')) files.push({ path: p, target: `source\\${ciSource}\\${p.slice(7).replace(/\//g, '\\')}`, sha256: sha256(f.get(p)) });
    else if (p.startsWith('record/') || p.startsWith('config/')) files.push({ path: p, target: p.replace('/', '\\'), sha256: sha256(f.get(p)) });
    else if (p === 'runtime/node.exe') files.push({ path: p, target: 'runtime\\node.exe', sha256: sha256(f.get(p)) });
  }
  for (const name of ['ResidentServiceHost.cs', 'SwapBroker.cs']) files.push({ path: `resident/windows/${name}`, target: `bin\\${name}`, sha256: sha256(f.get(`resident/windows/${name}`)) });
  const manifest = { contract: PACKAGE_CONTRACT, sourceManifestSha256: sourceSha, ciSourceManifestSha256: ciSource, residentManifestSha256: residentSha, bridgeManifestSha256: null,
    nodeIdentitySha256, nodeProfileSha256, windowsLayout, stateCompat, acceptance: { decisionRef },
    files, linux: { manifestSha256: sha256(f.get('linux/manifest.json')), sourceV2: null, files: [{ path: 'linux/bin/clued-ci-resident-linux', sha256: sha256(f.get('linux/bin/clued-ci-resident-linux')), bytes: f.get('linux/bin/clued-ci-resident-linux').length }] },
    upgrader };
  if (mutate) mutate(manifest, f, put);
  await fs.mkdir(out, { recursive: true });
  for (const [p, bytes] of f) { await fs.mkdir(path.dirname(path.join(out, p)), { recursive: true }); await fs.writeFile(path.join(out, p), bytes); }
  const mBytes = json(manifest);
  await fs.writeFile(path.join(out, 'package-manifest.json'), mBytes);
  return { dir: out, sha: sha256(mBytes), manifest, files: f, residentSha, ciSource, policySha: sha256(f.get('config/policy.json')), linuxSha: manifest.linux.manifestSha256 };
}

const live = (root, target) => path.join(root, ...target.split('\\'));
async function put(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }

// The layout install-resident.ps1 leaves for generation 1 (spec A6), from one package.
export async function installGeneration1(root, pkg, { at = T0, upgraderManifest = UPGRADER_MANIFEST, nodeProfile = NODE_PROFILE, nodeIdentity = NODE_IDENTITY } = {}) {
  for (const e of pkg.manifest.files) await put(live(root, e.target), pkg.files.get(e.path));
  for (const slot of GENERATED_SLOTS) await put(live(root, slot), fakeCompiled(slot, pkg.residentSha));
  const receipt = { contract: 'clued.independent-ci.resident-install-receipt/6', generation: 1, packageManifestSha256: pkg.sha, windowsLayout: WINDOWS_LAYOUT,
    stateCompat: pkg.manifest.stateCompat, nodeProfileSha256: nodeProfile, nodeIdentitySha256: nodeIdentity, policySha256: pkg.policySha,
    upgrader: { service: 'CluedCIUpgrader', manifestSha256: upgraderManifest }, writtenBy: 'install-resident.ps1', inheritedFrom: null, upgrade: null,
    linux: { generation: 1, manifestSha256: pkg.linuxSha, ciSourceManifestSha256: pkg.ciSource, qualificationsSha256: {} } };
  const receiptBytes = json(receipt);
  await put(live(root, RECEIPT_SLOT), receiptBytes);
  const current = { contract: GENERATION_CURRENT_CONTRACT, generation: 1, packageManifestSha256: pkg.sha, residentManifestSha256: pkg.residentSha, ciSourceManifestSha256: pkg.ciSource,
    policySha256: pkg.policySha, installReceiptSha256: sha256(receiptBytes), stateCompat: pkg.manifest.stateCompat,
    linux: { generation: 1, manifestSha256: pkg.linuxSha, ciSourceManifestSha256: pkg.ciSource }, opId: null, at: new Date(at).toISOString() };
  await put(path.join(root, 'upgrade', 'current.json'), json(current));
  await put(path.join(root, 'generations', 'g1', 'generation.json'), json({ generation: 1, packageManifestSha256: pkg.sha, residentBinPath: 'g1-resident', brokerBinPath: 'g1-broker',
    companionTaskArguments: 'g1-companion', filesSha256: '0'.repeat(64) }));
  await fs.mkdir(path.join(root, 'upgrade', 'ops'), { recursive: true });
  await put(path.join(root, 'secrets', 'resident-upgrade.token'), Buffer.from('fixture-token-not-a-secret-000000\n'));
  await put(path.join(root, 'fake-scm.json'), json({ resident: { state: 'running', binPath: 'g1-resident' }, broker: { state: 'running', binPath: 'g1-broker' },
    runner: { state: 'stopped', originalBinary: true }, companionTask: { path: 'C:\\Windows\\System32\\conhost.exe', arguments: 'g1-companion' } }));
  await put(path.join(root, 'fake-linux.json'), json({ generation: 1, history: { 1: { manifestSha256: pkg.linuxSha, ciSourceManifestSha256: pkg.ciSource } }, staged: null, at: at }));
  return { current, receipt };
}

export function upgradeRequestBytes(pkg, { requestId, node = NODE, drainMaxMinutes, note, acceptanceDecisionRef = DECISION, at = T0 }) {
  const v = { contract: UPGRADE_REQUEST_CONTRACT, requestId, node, packageManifestSha256: pkg.sha, packageDirectory: pkg.dir, acceptanceDecisionRef,
    requestedAt: new Date(at).toISOString(), nonce: 'ab'.repeat(8) };
  if (drainMaxMinutes !== undefined) v.drainMaxMinutes = drainMaxMinutes;
  if (note !== undefined) v.note = note;
  return Buffer.from(JSON.stringify(v), 'utf8');
}

export function fakeClock(start = T0) {
  const c = { now: start, advance(ms) { c.now += ms; } };
  c.fn = () => c.now;
  return c;
}

// ---- fake ports ----

export class FakeDoor {
  constructor(clock, { approveAt = T0, reject = false, expire = false, revoked = false, unavailableUntil = 0, notAuthorized = false } = {}) {
    Object.assign(this, { clock, approveAt, reject, expire, revoked, unavailableUntil, notAuthorized });
    this.consumed = new Map();
    this.calls = 0;
  }
  async consume({ opId, resource }) {
    this.calls += 1;
    const now = this.clock.fn();
    if (now < this.unavailableUntil) return { kind: 'unavailable', code: U.GRANT_DOOR_UNAVAILABLE };
    if (this.notAuthorized) return { kind: 'refused', code: U.GRANT_BINDING_NOT_AUTHORIZED };
    const requestId = derivedRequestId('owner-request', opId);
    if (this.consumed.has(opId)) return { kind: 'consumed', grant: { ...this.consumed.get(opId), replayed: true } };
    if (this.reject) return { kind: 'refused', code: U.GRANT_REJECTED, requestId };
    if (this.expire) return { kind: 'refused', code: U.GRANT_EXPIRED, requestId };
    if (this.revoked) return { kind: 'refused', code: U.GRANT_REVOKED, requestId };
    if (this.approveAt === null || now < this.approveAt) return { kind: 'pending', requestId, status: 'pending', confirmUrl: `https://kooyumi.pixelgrav.com/confirm/${requestId}`, expiresAt: null };
    const grant = { grantId: derivedRequestId('grant', opId), receiptId: derivedRequestId('receipt', opId), use: 1, maxUses: 1, expiresAt: new Date(now + 86_400_000).toISOString(), replayed: false, resource };
    this.consumed.set(opId, grant);
    return { kind: 'consumed', grant };
  }
}

// The resident as the upgrader sees it, in memory (its state survives an upgrader "crash").
export class FakeResident {
  constructor(clock, { openBatches = () => 0, halted = false, pauseDelayMs = 30_000, processes = true } = {}) {
    Object.assign(this, { clock, openBatchesAt: openBatches, isHalted: halted, pauseDelayMs, processes });
    this.holds = new Set();
    this.holdRequests = 0;
    this.paused = null;
    this.pending = new Map();
    this.running = true;
    this.lastWritten = clock.fn();
    this.receipts = [];
    this.companionAlive = true;
    this.trainOpenFlag = false;
    this.owner = [];
  }
  now() { return this.clock.fn(); }
  // The resident's own tick: pause requests that waited long enough are taken.
  tick() {
    if (!this.running || !this.processes) return;
    for (const [name, r] of this.pending) {
      if (this.now() < r.at + this.pauseDelayMs) continue;
      this.pending.delete(name);
      if (!this.paused) this.paused = { sha256: sha256(`PAUSED ${r.sha}`), requestSha256: r.sha };
    }
  }
  async hold(opId) { this.holds.add(opId); this.holdRequests += 1; return true; }
  async liftHold(opId) { this.holds.delete(opId); return true; }
  async requestPause(name, bytes) { if (this.pending.has(name)) return false; this.pending.set(name, { sha: sha256(bytes), at: this.now(), bytes }); return true; }
  async pauseRequestPending(name) { this.tick(); return this.pending.has(name); }
  async withdrawPause(name, toFile) {
    this.tick();
    const r = this.pending.get(name);
    if (!r) return false;
    this.pending.delete(name);
    await fs.writeFile(toFile, r.bytes, { flag: 'wx' });
    return true;
  }
  async pauseState() { this.tick(); return this.paused ? { ...this.paused } : null; }
  async halted() { return this.isHalted; }
  async openBatches() { return this.openBatchesAt(this.now()); }
  async status() {
    this.tick();
    const at = this.running ? this.now() : this.lastWritten;
    return { writtenAt: at, executorState: this.isHalted ? 'HALTED' : (this.paused ? 'PAUSED' : 'IDLE'), current: false, probeAt: at };
  }
  async receiptHead() { return this.receipts.length; }
  async receiptsSince(seq) { return this.receipts.filter(r => r.seq > seq); }
  async trainOpen() { return this.trainOpenFlag; }
  async brokerPending() { return 0; }
  async companionHeartbeat() { return this.companionAlive ? this.now() : null; }
  async requestUpgradeResume({ pausedSha256, opId, generation }) {
    this.owner.push({ pausedSha256, opId, generation });
    if (this.paused && this.paused.sha256 === pausedSha256) this.paused = null;
    return true;
  }
  stop() { if (this.running) { this.running = false; this.lastWritten = this.now(); } }
  start(policySha256, generation) {
    if (this.running) return;
    this.running = true;
    this.receipts.push({ seq: this.receipts.length + 1, type: 'service-start', body: { policySha256, pid: 1, generation } });
  }
  snapshot() { return { holds: [...this.holds].sort(), paused: this.paused, pending: [...this.pending.keys()].sort(), running: this.running, receipts: this.receipts }; }
}

const shaOf = async file => { try { return sha256(await fs.readFile(file)); } catch { return null; } };

// upgrade-apply.ps1 as a JSON "SCM" file in the temporary root.
export class FakeWindows {
  constructor(root, resident, { failVerify = () => false, failCompile = false, failStart = () => false, failSwitch = () => false, companionDown = () => false } = {}) {
    Object.assign(this, { root, resident, failVerify, failCompile, failStart, failSwitch, companionDown });
    this.file = path.join(root, 'fake-scm.json');
    this.calls = [];
  }
  async state() { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
  async save(s) { await fs.writeFile(this.file, json(s)); }
  async plan(opId) { return JSON.parse(await fs.readFile(path.join(this.root, 'upgrade', 'ops', opId, '010-accept.plan.json'), 'utf8')); }
  async readScm() { this.calls.push('ReadScm'); return { ok: true, code: null, ...(await this.state()) }; }
  async compile({ opId }) {
    this.calls.push('Compile');
    if (this.failCompile) return { ok: false, code: 'COMPILE_FAILED' };
    const plan = await this.plan(opId);
    for (const slot of GENERATED_SLOTS) {
      const file = path.join(this.root, 'upgrade', 'staged', plan.packageManifestSha256, 'compiled', ...slot.split('\\'));
      const bytes = fakeCompiled(slot, plan.target.residentManifestSha256);
      if (await shaOf(file) === sha256(bytes)) continue;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes, { flag: 'wx' });
    }
    return { ok: true, code: null };
  }
  async stopServices() {
    this.calls.push('StopServices');
    const s = await this.state();
    s.resident.state = 'stopped'; s.broker.state = 'stopped';
    await this.save(s);
    this.resident.stop();
    return { ok: true, code: null };
  }
  async record(generation) { try { return JSON.parse(await fs.readFile(path.join(this.root, 'generations', `g${generation}`, 'generation.json'), 'utf8')); } catch { return null; } }
  async switchScm({ generation }) {
    this.calls.push(`SwitchScm:${generation}`);
    if (this.failSwitch(generation)) return { ok: false, code: 'SCM_SWITCH_FAILED' };
    const s = await this.state();
    const rec = await this.record(generation);
    s.resident.binPath = rec?.residentBinPath ?? `gen ${generation} policy ${await shaOf(path.join(this.root, 'config', 'policy.json'))}`;
    s.broker.binPath = rec?.brokerBinPath ?? `gen ${generation} broker ${await shaOf(path.join(this.root, 'config', 'broker.json'))}`;
    await this.save(s);
    return { ok: true, code: null };
  }
  async registerCompanionTask({ generation }) {
    this.calls.push(`RegisterCompanionTask:${generation}`);
    const s = await this.state();
    const rec = await this.record(generation);
    s.companionTask.arguments = rec?.companionTaskArguments ?? `gen ${generation} companion ${await shaOf(path.join(this.root, 'config', 'companion.json'))}`;
    await this.save(s);
    return { ok: true, code: null };
  }
  async restartCompanion() {
    this.calls.push('RestartCompanion');
    if (this.companionDown()) { this.resident.companionAlive = false; return { ok: false, code: 'COMPANION_TASK_NOT_RUNNING' }; }
    this.resident.companionAlive = true;
    return { ok: true, code: null };
  }
  async startServices() {
    this.calls.push('StartServices');
    const cur = JSON.parse(await fs.readFile(path.join(this.root, 'upgrade', 'current.json'), 'utf8'));
    if (this.failStart(cur.generation)) return { ok: false, code: 'START_FAILED' };
    const s = await this.state();
    s.resident.state = 'running'; s.broker.state = 'running';
    await this.save(s);
    await this.resident.start(await shaOf(path.join(this.root, 'config', 'policy.json')), cur.generation);
    return { ok: true, code: null };
  }
  async verify({ generation }) {
    this.calls.push(`Verify:${generation}`);
    return this.failVerify(generation) ? { ok: false, code: 'VERIFY_CHECK_FAILED' } : { ok: true, code: null };
  }
}

// The Linux half (B3's tool behind the companion), as a JSON file in the temporary root. The companion refreshes the
// facts every 5 minutes and right after a switch or rollback.
export class FakeLinux {
  constructor(root, clock, { failStage = null, failSwitch = null, failRollback = false, failVerify = () => false, unavailable = () => false } = {}) {
    Object.assign(this, { root, clock, failStage, failSwitch, failRollback, failVerify, unavailable });
    this.retained = [];
    this.file = path.join(root, 'fake-linux.json');
  }
  async state() { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
  async save(s) { await fs.writeFile(this.file, json(s)); }
  async stage({ packageManifestSha256, generation }) {
    if (this.unavailable('stage')) return { ok: false, code: U.COMPANION_UNAVAILABLE };
    if (this.failStage) return { ok: false, code: this.failStage };
    const pkg = JSON.parse(await fs.readFile(path.join(this.root, 'upgrade', 'staged', packageManifestSha256, 'package-manifest.json'), 'utf8'));
    const s = await this.state();
    s.history[generation] = { manifestSha256: pkg.linux.manifestSha256, ciSourceManifestSha256: pkg.ciSourceManifestSha256 };
    s.staged = generation;
    await this.save(s);
    return { ok: true, code: null, result: { status: 'LINUX_STAGED', roles: Object.fromEntries(['gitleaks', 'trivy', 'contract-placement'].map((r, i) => [r,
      { policySha256: sha256(`policy ${r} ${packageManifestSha256}`), qualificationSha256: sha256(`qualification ${r} ${i} ${packageManifestSha256}`) }])) } };
  }
  async switch({ toGeneration }) {
    if (this.unavailable('switch')) return { ok: false, code: U.COMPANION_UNAVAILABLE };
    if (this.failSwitch) return { ok: false, code: this.failSwitch };
    const s = await this.state();
    if (s.generation !== toGeneration) { s.generation = toGeneration; s.staged = null; s.at = this.clock.fn(); await this.save(s); }
    return { ok: true, code: null, result: { status: 'switched' } };
  }
  async rollback({ toGeneration }) {
    if (this.unavailable('rollback')) return { ok: false, code: U.COMPANION_UNAVAILABLE };
    if (this.failRollback) return { ok: false, code: 'UPGRADE_ROLLBACK_FAILED' };
    const s = await this.state();
    if (s.generation !== toGeneration) { s.generation = toGeneration; s.at = this.clock.fn(); await this.save(s); }
    return { ok: true, code: null, result: { status: 'rolled-back' } };
  }
  async retain({ generation }) {
    if (this.unavailable('retain')) return { ok: false, code: U.COMPANION_UNAVAILABLE };
    this.retained.push(generation);
    return { ok: true, code: null, result: { status: 'LINUX_RETAINED', generation } };
  }
  async verify({ generation }) {
    const s = await this.state();
    return s.generation === generation && !this.failVerify(generation) ? { ok: true, code: null } : { ok: false, code: 'UPGRADE_LINUX_VERIFY_REFUSED' };
  }
  async readFacts() {
    if (this.unavailable('facts')) return null;
    const s = await this.state();
    const now = this.clock.fn();
    const at = Math.max(s.at, Math.floor(now / (5 * MIN)) * 5 * MIN);
    const h = s.history[s.generation];
    return { contract: LINUX_VERSION_FACTS_CONTRACT, generation: s.generation, ciSourceManifestSha256: h.ciSourceManifestSha256, sourceCommit: null, manifestSha256: h.manifestSha256,
      roles: {}, pinsOk: true, staged: null, upgradeToolSha256: 'd4'.repeat(32), observedAt: new Date(at).toISOString() };
  }
}

// Every file under root as relative path -> sha256, minus what may differ between an interrupted and an uninterrupted run:
// the journal's own intent/result records and markers (they say "replayed"), the status view and leftover temporaries.
export async function treeDigest(root, { exclude = () => false } = {}) {
  const out = {};
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (exclude(rel)) continue;
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; await walk(abs); } else out[rel] = sha256(await fs.readFile(abs));
    }
  }
  await walk(root);
  return out;
}

export const journalOnly = rel => /^upgrade\/ops\/[^/]+\/(?!000-request\.json$|010-accept\.plan\.json$|900-terminal\.json$|staged-withdrawn)/.test(rel) || rel === 'upgrade/status.json';
