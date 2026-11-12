// The ACCEPT step of an in-place upgrade, run beforehand, read-only and NON-elevated (DESIGN §42.3.2, Task 018da927).
//
//   node rollout/precheck.mjs --root C:\ProgramData\CluedIndependentCI\resident --package <dir> --package-sha <hex> --acceptance <uuid>
//        --installed-package <dir>
//
// It decides with the code the node will decide with. Every package carries the upgrader copy it was built with (package
// upgrader/, manifest `upgrader`), and the node's upgrader refuses a package whose copy is not its own frozen one. So:
//   1. the package's copy is hashed file by file, and the copy's manifest hash is computed HERE (this checkout's canonical form),
//      before anything is imported from the package; it must equal the installed one (the install receipt's upgrader.manifestSha256).
//      If it does not, the answer is UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL, with the frozen files that differ from the installed
//      package's copy: the author moves them out of this batch (§42.4).
//   2. otherwise the copy IS the installed upgrader byte for byte, and its readPackageOnce, buildPlan and the live inventory are
//      imported from it and run against the node: current.json, the install receipt, every slot's live hash, the content-addressed
//      directories. The node values the upgrader takes from its admin-only configuration (node, profile, Owner SID) come from the
//      Owner-readable installed policy instead.
// A slot the Owner's session cannot read (admin-only, e.g. helpers\controller-formal-generic-v2.exe) is listed and given a stand-in
// hash so that the rest is still checked: PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS. The upgrader runs as LocalSystem and reads it.
// The Linux half: the frozen upgrade tool, the signer and their manifest (clued-ci-upgrade-linux UPGRADE_FILES) must be the installed
// package's bytes, and the tool the one the node's version facts name; else the Linux stage refuses with the same code after the Grant.
// The node values the upgrader reads from its admin-only upgrader.json are taken from the installed policy, which is written from the
// same node profile (residual: if the two ever diverged, the node could answer differently; plan.mjs policy-node).
// Nothing is written; the result is one JSON line (clued.independent-ci.upgrade-precheck/1).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { canonicalJson } from '../src/canonical.mjs';
import { parseTrainNodes } from '../src/train.mjs';

export const PRECHECK_CONTRACT = 'clued.independent-ci.upgrade-precheck/1';
// Defect 15894c2a: stage 10's §41.6 Source check (train-maintenance.mjs SOURCE_HEARTBEAT_WINDOW_MS): every node heard within 24 hours
// must run the Source the on-duty node runs, or the train stops (TRAIN_SOURCE_MISMATCH). The precheck runs the same comparison
// against the TARGET Source, on the nodes list stage 10 last read from Native (status.json train.nodes; train.mjs#trainNodesView).
export const FLEET_HEARTBEAT_WINDOW_MS = 24 * 3_600_000;
// A list older than this says too little about now (stage 10 on duty reads it every maintenanceEveryMs, 10 minutes by default).
export const FLEET_VIEW_FRESH_MS = 60 * 60_000;
export const OWNER_NODES_URL = 'https://kooyumi.pixelgrav.com/bindings/failover';
// What a LOCAL_ONLY pass leaves to the Owner, by reason (review 15894c2a m4: the first generation's gap is said, not implied).
const CHECK_BY_HAND = '在本机升级前，请到 /bindings/failover 只读核对：24 小时内有心跳的其他节点是否已是目标 Source；不是就先升它们。';
export const UNVERIFIED_ADVICE = Object.freeze({
  NODES_VIEW_ABSENT: `本机 status.json 还没有 train.nodes：要等装上含 15894c2a 修复的一代、且本机当班跑过一次 on 模式第 10 段之后才有（首代空窗，在那之前预检一律只核本机）。${CHECK_BY_HAND}`,
  NODES_VIEW_STALE: `本机的节点表已超过 1 小时（本机多半不再当班）。${CHECK_BY_HAND}`,
  SELF_NOT_IN_NODES_VIEW: `节点表里找不到本机（Native 登记的节点名与本机名不同）。${CHECK_BY_HAND}`,
  NOT_ON_DUTY: `本机现在不当班，节点表不代表第 10 段此刻比对的内容；mismatchedNodes 只是它上次看到的。${CHECK_BY_HAND}`,
  TARGET_TRAIN_MODE_UNREADABLE: `目标包的 train.enabled 读不出。${CHECK_BY_HAND}`,
});
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const STAND_IN = 'f'.repeat(64);
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const sha = b => createHash('sha256').update(b).digest('hex');
const execFileP = promisify(execFile);
const LINUX_TOOL = 'linux/upgrade-v1/bin/clued-ci-upgrade-linux';
const LINUX_FROZEN = Object.freeze([LINUX_TOOL, 'linux/upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs', 'linux/upgrade-v1/manifest.json']);
const OP_MOVING = ['WAITING_GRANT', 'WAITING_DRAIN', 'DEFERRED', 'RUNNING', 'ROLLING_BACK'];

// M5-b relay parents (6c536c8c): on a node whose companion runs as its own account (install\companion-account.json), the two fixed
// ancestors of the relay must carry exactly one self-only metadata ACE for that account. install-resident.ps1 adds it only on a fresh
// install. In an in-place upgrade the target generation's verify-resident.ps1 (run as SYSTEM by the VERIFY step) adds it with the
// installer's own rule (Invoke-CompanionRelayParentsEnsure); a target without that function cannot, its VERIFY fails
// (companion-relay-parents) and the upgrade rolls back. So: missing + a target that ensures it = PASS with a notice; missing + a target
// that does not, or a parent the installer's rule refuses = PRECHECK_REFUSED (build-upgrade.ps1 then prints no request command).
// relayParentAclPresence is install-resident.ps1 Get-RelayParentAclPresence on the SDDL text, never looser: any deny ACE that is not
// inherit-only is refused unless its hex mask provably misses the metadata/generic-read/generic-all rights.
export const COMPANION_ACCOUNT_CONTRACT = 'clued.independent-ci.companion-account/1';
const SID = /^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}$/;
const RELAY_METADATA = 0x120080;
const DENY_RELEVANT = (RELAY_METADATA | 0x80000000 | 0x10000000) >>> 0;
const ACE_FLAGS = new Set(['OI', 'CI', 'NP', 'IO', 'ID', 'SA', 'FA']);
export function relayParentAclPresence(sddl, sid) {
  if (typeof sddl !== 'string' || !SID.test(sid ?? '')) return 'refused';
  const d = /D:([A-Z]*)((?:\([^()]*\))*)(?:S:|$)/.exec(sddl);
  if (!d || !d[1].includes('P')) return 'refused';
  const aces = [...d[2].matchAll(/\(([^()]*)\)/g)].map(m => m[1].split(';'));
  const mask = r => (/^0x[0-9a-fA-F]{1,8}$/.test(r) ? Number.parseInt(r, 16) : null);
  for (const a of aces) {
    if (a.length !== 6 || !['A', 'D'].includes(a[0]) || a[3] !== '' || a[4] !== '') return 'refused';   // object, callback, audit, ...
    const flags = a[1].match(/../g) ?? [];
    if (a[1].length % 2 !== 0 || flags.some(f => !ACE_FLAGS.has(f))) return 'refused';
    if (a[0] === 'D' && !flags.includes('IO')) {
      const m = mask(a[2]);
      if (m === null || (m & DENY_RELEVANT) !== 0) return 'refused';
    }
  }
  const mine = aces.filter(a => a[5] === sid);
  if (mine.length === 0) return 'missing';
  const [only] = mine;
  if (mine.length !== 1 || only[0] !== 'A' || only[1] !== '' || mask(only[2]) !== RELAY_METADATA) return 'refused';
  return 'present';
}
// The two parents, as companion-headless.ps1 Get-CompanionRelayParentPaths names them: the resident root's parent and its formal-spool.
// The function the target generation's verify-resident.ps1 must define for the upgrade to add a missing entry itself.
export const RELAY_PARENTS_ENSURE_FUNCTION = 'function Invoke-CompanionRelayParentsEnsure(';
const TARGET_VERIFY = /^resident\\[0-9a-f]{64}\\windows\\verify-resident\.ps1$/;
export const relayParents = root => { const ci = path.dirname(path.resolve(root)); return [ci, path.join(ci, 'formal-spool')]; };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// The live DACL of one directory, read as the Owner (Get-Acl needs no elevation on these two). The path goes in through the
// environment, never into the command text (-Command joins its arguments into code). Any error, stderr or empty answer throws.
export async function readSddl(dir) {
  const { stdout, stderr } = await execFileP(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:CLUED_RELAY_PARENT).Sddl"],
  { windowsHide: true, timeout: 60_000, env: { ...process.env, CLUED_RELAY_PARENT: dir } });
  const sddl = stdout.trim();
  if (stderr.trim() !== '' || !sddl.startsWith('O:')) throw new Error('RELAY_PARENT_SDDL_UNREADABLE');
  return sddl;
}
// null: not a companion-account node. Otherwise { companionSid, parents: [{ path, presence }], problem }.
async function relayParentsCheck(root, read) {
  let bytes;
  try { bytes = await fs.readFile(path.join(root, 'install', 'companion-account.json')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { companionSid: null, parents: [], problem: 'COMPANION_ACCOUNT_RECORD_UNREADABLE' };
  }
  let record = null;
  try { record = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { record = null; }
  const companionSid = record?.companionSid;
  if (record?.contract !== COMPANION_ACCOUNT_CONTRACT || !SID.test(companionSid ?? '')) return { companionSid: null, parents: [], problem: 'COMPANION_ACCOUNT_RECORD_REFUSED' };
  const parents = [];
  for (const dir of relayParents(root)) {
    let presence;
    try {
      const st = await fs.lstat(dir);
      presence = st.isDirectory() && !st.isSymbolicLink() ? relayParentAclPresence(await read(dir), companionSid) : 'target-refused';
    } catch { presence = 'unreadable'; }
    parents.push({ path: dir, presence });
  }
  const problem = parents.every(p => p.presence === 'present') ? null
    : parents.some(p => p.presence === 'missing') && parents.every(p => ['present', 'missing'].includes(p.presence)) ? 'COMPANION_RELAY_PARENT_ACL_MISSING'
      : 'COMPANION_RELAY_PARENT_ACL_REFUSED';
  return { companionSid, parents, problem };
}

class Refusal extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
const need = (c, code, detail) => { if (!c) throw new Refusal(code, detail); };

async function readJson(file, max = 1024 * 1024) {
  const st = await fs.lstat(file);
  need(st.isFile() && st.size <= max, 'PRECHECK_FILE_SHAPE', file);
  const bytes = await fs.readFile(file);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

// The package's upgrader copy, every file against the manifest's list (files outside the list are not imported).
async function verifyUpgraderCopy(pkgDir, upgrader) {
  need(upgrader && HEX64.test(upgrader.manifestSha256 ?? '') && Array.isArray(upgrader.files) && upgrader.files.length > 0, 'PRECHECK_PACKAGE_HAS_NO_UPGRADER_COPY');
  for (const f of upgrader.files) {
    need(typeof f.path === 'string' && /^(?:src|upgrader\/src|windows)\/[A-Za-z0-9_.-]+$/.test(f.path) && HEX64.test(f.sha256 ?? ''), 'PRECHECK_UPGRADER_COPY_REFUSED', f.path);
    const bytes = await fs.readFile(path.join(pkgDir, 'upgrader', ...f.path.split('/')));
    need(sha(bytes) === f.sha256, 'PRECHECK_UPGRADER_COPY_CHANGED', f.path);
  }
  const manifest = { contract: 'clued.independent-ci.resident-upgrader-manifest/1', root: 'upgrader', files: upgrader.files };
  return manifest;
}

function diffFiles(a, b) {
  const m = new Map(a.map(f => [f.path, f.sha256]));
  const n = new Map(b.map(f => [f.path, f.sha256]));
  return [...new Set([...m.keys(), ...n.keys()])].sort().filter(p => m.get(p) !== n.get(p))
    .map(p => ({ path: p, installed: m.get(p) ?? null, package: n.get(p) ?? null }));
}

// Defect 15894c2a, pure: would the fleet still pass stage 10's Source check once THIS node runs `target`? view: train.mjs#parseTrainNodes
// of this node's status.json (null: none). selfNames: this node's names (its own entry is the one being upgraded, never compared).
//   PASS        every other node heard within 24 hours already runs `target` (or reports no Source: §41.6 "no record");
//   MISMATCH    some do not: after this upgrade the train stops with TRAIN_SOURCE_MISMATCH until they run `target` too, so they go first
//               (upgradeFirst). Rolling order (§42): the standby nodes first, the ci-admission holder last; only the holder runs stage
//               10 on duty, so only it has a fresh list and only it is refused here: the standby's precheck cannot deadlock it;
//   UNVERIFIED  no usable list (none, older than FLEET_VIEW_FRESH_MS, or this node is not in it): the comparison was not made.
//               Also this node not on duty now (onDuty false: its status.json node.mode is not ACTIVE). Right after a hand-over both
//               nodes hold a list younger than FLEET_VIEW_FRESH_MS; only the holder's says what stage 10 compares now, so the other
//               one never refuses (review 15894c2a m2): it reports what its older list showed (mismatchedNodes) as a warning.
// A node not heard within 24 hours is not compared (as stage 10) and is named in staleNodesIgnored.
export function fleetSourceCheck({ view, target, selfNames = [], now, onDuty = false }) {
  const base = { targetCiSourceManifestSha256: target, viewAt: view?.at ?? null };
  const row = n => ({ node: n.node, sourceManifestSha256: n.sourceManifestSha256, lastHeartbeatAt: n.lastHeartbeatAt });
  if (!view) return { ...base, status: 'UNVERIFIED', reason: 'NODES_VIEW_ABSENT' };
  if (!(Math.abs(now - Date.parse(view.at)) <= FLEET_VIEW_FRESH_MS)) return { ...base, status: 'UNVERIFIED', reason: 'NODES_VIEW_STALE' };
  const names = new Set(selfNames.filter(s => typeof s === 'string' && s.length > 0).map(s => s.toLowerCase()));
  const isSelf = n => typeof n.node === 'string' && names.has(n.node.toLowerCase());
  if (!view.nodes.some(isSelf)) return { ...base, status: 'UNVERIFIED', reason: 'SELF_NOT_IN_NODES_VIEW', nodes: view.nodes.map(row) };
  const differ = view.nodes.filter(n => !isSelf(n) && n.sourceManifestSha256 !== null && n.sourceManifestSha256 !== target);
  const heard = n => n.lastHeartbeatAt !== null && now - Date.parse(n.lastHeartbeatAt) <= FLEET_HEARTBEAT_WINDOW_MS;
  const blocking = differ.filter(heard), stale = differ.filter(n => !heard(n));
  const extra = { staleNodesIgnored: stale.map(row), ...(view.dropped > 0 ? { droppedEntries: view.dropped } : {}) };
  if (onDuty !== true) return { ...base, status: 'UNVERIFIED', reason: 'NOT_ON_DUTY', mismatchedNodes: blocking.map(row), ...extra };
  if (blocking.length) return { ...base, status: 'MISMATCH', upgradeFirst: blocking.map(n => n.node), mismatchedNodes: blocking.map(row), ...extra };
  return { ...base, status: 'PASS', ...extra };
}

// readSlot: how one live slot is read (tests stand in an access-denied file; the Owner's session meets real ones).
// allowFleetSourceMismatch (--allow-fleet-source-mismatch, build-upgrade.ps1 -AllowFleetSourceMismatch): the Owner's explicit emergency
// pass for a mismatch, e.g. the other node heard within 24 hours is gone for good. The train still stops with TRAIN_SOURCE_MISMATCH until
// that node's heartbeat is 24 hours old or it runs the target Source; the result says so (FLEET_SOURCE_MISMATCH_ALLOWED).
export async function precheck({ root, pkgDir, pkgSha, acceptance, installedPkgDir, clock = Date.now, readSlot = file => fs.readFile(file),
  allowFleetSourceMismatch = false, readParentSddl = readSddl }) {
  need(HEX64.test(pkgSha ?? '') && UUID.test(acceptance ?? '') && typeof installedPkgDir === 'string', 'USAGE');
  const result = { contract: PRECHECK_CONTRACT, packageManifestSha256: pkgSha, checkedAt: new Date(clock()).toISOString(), warnings: [], unreadableSlots: [] };
  const done = (status, extra = {}) => ({ ...result, status, ...extra });
  // The manifest, read once; its hash is the one the Owner will grant.
  const manifestBytes = await fs.readFile(path.join(pkgDir, 'package-manifest.json'));
  need(sha(manifestBytes) === pkgSha, 'PRECHECK_PACKAGE_CHANGED', 'package-manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const receipt = (await readJson(path.join(root, 'install', 'install-receipt.json'))).value;
  const installedUpgrader = receipt?.upgrader?.manifestSha256 ?? null;
  result.upgrader = { installed: installedUpgrader, package: manifest?.upgrader?.manifestSha256 ?? null };
  if (!HEX64.test(installedUpgrader ?? '')) return done('PRECHECK_REFUSED', { code: 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', detail: 'no-upgrader-installed' });
  // The installed package (build-upgrade.ps1 checked it is the current generation): its upgrader copy and frozen Linux files are the node's.
  const instBytes = await fs.readFile(path.join(installedPkgDir, 'package-manifest.json'));
  const inst = JSON.parse(instBytes.toString('utf8'));
  // the current generation's package (also when run on its own): an older package with the same upgrader may hold older Linux files
  const current = JSON.parse((await fs.readFile(path.join(root, 'upgrade', 'current.json'))).toString('utf8'));
  need(sha(instBytes) === current?.packageManifestSha256, 'PRECHECK_INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION');
  need(inst?.upgrader?.manifestSha256 === installedUpgrader, 'PRECHECK_INSTALLED_PACKAGE_IS_NOT_THE_INSTALLED_UPGRADER');
  if (result.upgrader.package !== installedUpgrader) {
    return done('PRECHECK_REFUSED', { code: 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', detail: 'upgrader',
      changedFrozenFiles: diffFiles(inst.upgrader.files ?? [], manifest?.upgrader?.files ?? []) });
  }
  const linuxOf = m => new Map((m?.linux?.files ?? []).map(f => [f.path, f.sha256]));
  const [instLinux, pkgLinux] = [linuxOf(inst), linuxOf(manifest)];
  const changedLinux = LINUX_FROZEN.filter(p => instLinux.get(p) !== pkgLinux.get(p)).map(p => ({ path: p, installed: instLinux.get(p) ?? null, package: pkgLinux.get(p) ?? null }));
  if (changedLinux.length) return done('PRECHECK_REFUSED', { code: 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', detail: 'linux-upgrade-tool', changedFrozenFiles: changedLinux });
  const copy = await verifyUpgraderCopy(pkgDir, manifest.upgrader);
  // The copy's hash, computed with THIS checkout's canonical form before any of the package's code runs (an import executes it):
  // only a copy whose every byte is the installed upgrader's is imported below.
  need(sha(Buffer.from(canonicalJson(copy) + '\n', 'utf8')) === installedUpgrader, 'PRECHECK_UPGRADER_COPY_CHANGED', 'manifest');
  const at = rel => pathToFileURL(path.join(pkgDir, 'upgrader', ...rel.split('/'))).href;
  const { readPackageOnce } = await import(at('upgrader/src/package.mjs'));
  const { ALL_SLOTS, buildPlan } = await import(at('upgrader/src/plan.mjs'));
  const { Generations } = await import(at('upgrader/src/generations.mjs'));
  const { parseGenerationCurrent, parseVersionFacts } = await import(at('src/upgrade-mailbox.mjs'));

  // The node, as ACCEPT reads it (machine.mjs nodeState), with unreadable slots listed instead of failing.
  const gens = new Generations(root);
  const currentBytes = await fs.readFile(gens.currentFile);
  const generation = parseGenerationCurrent(currentBytes);
  const receiptBytes = await fs.readFile(gens.live('install\\install-receipt.json'));
  const live = {};
  for (const slot of ALL_SLOTS) {
    try {
      const st = await fs.lstat(gens.live(slot));
      live[slot] = st.isFile() ? sha(await readSlot(gens.live(slot))) : null;
    } catch (error) {
      if (error?.code === 'ENOENT') live[slot] = null;
      else { live[slot] = STAND_IN; result.unreadableSlots.push(slot); }
    }
  }
  const dirs = (await gens.inventory([])).dirs;
  const node = { generation, generationSha256: sha(currentBytes), receipt: JSON.parse(receiptBytes.toString('utf8')), receiptSha256: sha(receiptBytes), live, dirs };
  result.current = { generation: generation.generation, packageManifestSha256: generation.packageManifestSha256 };

  const policy = (await readJson(path.join(root, 'config', 'policy.json'))).value;
  const nodeName = policy?.node?.nodeName;
  const config = { node: nodeName, nodeProfileSha256: policy?.nodeProfileSha256, ownerSid: policy?.companion?.userSid, timeouts: { drainMaxMinutes: 120 } };
  const request = { node: nodeName, packageManifestSha256: pkgSha, packageDirectory: path.resolve(pkgDir), acceptanceDecisionRef: acceptance, drainMaxMinutes: 120 };
  let plan, targetPolicy = null, targetEnsuresRelayParents = false;
  try {
    const pkg = await readPackageOnce(path.resolve(pkgDir), pkgSha);
    plan = buildPlan(node, pkg.manifest, { request, packageFiles: pkg.bytesByPath, opId: ZERO_UUID, config, requestSha256: '0'.repeat(64) }).plan;
    // The target's train mode, from the same held, package-hash-verified bytes buildPlan read (the installed mode says nothing about
    // what this upgrade turns on). Unreadable: null, which is never "fleet check not required".
    try {
      const policyFile = pkg.manifest.files.find(f => f.target === 'config\\policy.json');
      targetPolicy = JSON.parse(pkg.bytesByPath.get(policyFile.path).toString('utf8'));
    } catch { targetPolicy = null; }
    // Whether the target's VERIFY adds a missing relay-parent entry (the same held bytes; absent or unreadable: it does not).
    try {
      const verifyFile = pkg.manifest.files.find(f => TARGET_VERIFY.test(f.target ?? ''));
      targetEnsuresRelayParents = pkg.bytesByPath.get(verifyFile.path).toString('utf8').includes(RELAY_PARENTS_ENSURE_FUNCTION);
    } catch { targetEnsuresRelayParents = false; }
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('UPGRADE_')) return done('PRECHECK_REFUSED', { code: error.code, detail: error.detail ?? null });
    throw error;
  }
  result.plan = { fromGeneration: plan.fromGeneration, toGeneration: plan.toGeneration, grantResource: plan.grantResource, node: plan.node,
    target: { residentManifestSha256: plan.target.residentManifestSha256, ciSourceManifestSha256: plan.target.ciSourceManifestSha256, linux: plan.target.linux },
    newDirs: plan.dirs.filter(d => !d.present).map(d => `${d.kind}\\${d.sha256}`) };

  // The Linux half: the frozen tool in the package against the installed one (the stage would refuse the same way).
  const toolBytes = await fs.readFile(path.join(pkgDir, ...LINUX_TOOL.split('/'))).catch(() => null);
  let facts = null;
  try { facts = parseVersionFacts(await fs.readFile(path.join(root, 'upgrade', 'mailbox', 'responses', 'version-facts.json'))); } catch { facts = null; }
  if (toolBytes && facts && sha(toolBytes) !== facts.upgradeToolSha256) {
    return done('PRECHECK_REFUSED', { code: 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', detail: 'linux-upgrade-tool' });
  }
  if (!facts) result.warnings.push('LINUX_VERSION_FACTS_UNREADABLE');
  else {
    if (facts.staged !== null) result.warnings.push('LINUX_HAS_A_STAGED_GENERATION');
    if (facts.pinsOk !== true) result.warnings.push('LINUX_PINS_NOT_OK');
    if (facts.generation !== generation.linux?.generation) result.warnings.push('LINUX_GENERATION_NOT_CURRENT');
  }
  // What will make the upgrader wait or refuse later (they change, so they only warn here).
  try {
    const up = JSON.parse((await fs.readFile(path.join(root, 'upgrade', 'status.json'))).toString('utf8'));
    if (up?.op && OP_MOVING.includes(up.op.state)) result.warnings.push('ANOTHER_UPGRADE_OP_ACTIVE');
  } catch { /* no status yet */ }
  let st = null;
  try {
    st = JSON.parse((await fs.readFile(path.join(root, 'state', 'status.json'))).toString('utf8'));
    if (st?.halt) result.warnings.push('RESIDENT_HALTED');
    if (st?.versions && st.versions.consistent === false) result.warnings.push('VERSIONS_NOT_CONSISTENT');
    if (st?.node?.mode === 'ACTIVE') result.warnings.push('NODE_HOLDS_CI_ADMISSION_HAND_OVER_FIRST');
  } catch { result.warnings.push('RESIDENT_STATUS_UNREADABLE'); }
  // M5-b relay parents: no Owner pass skips a refusal here (the target's VERIFY would roll back anyway). There is no hand repair.
  const relay = await relayParentsCheck(root, readParentSddl);
  if (relay) result.companionRelayParents = { ...relay, targetEnsures: targetEnsuresRelayParents };
  if (relay?.problem === 'COMPANION_RELAY_PARENT_ACL_MISSING' && targetEnsuresRelayParents) {
    result.warnings.push('COMPANION_RELAY_PARENTS_ADDED_BY_THE_UPGRADE_VERIFY');
  } else if (relay?.problem) {
    const missing = relay.problem === 'COMPANION_RELAY_PARENT_ACL_MISSING';
    return done('PRECHECK_REFUSED', { code: missing ? 'COMPANION_RELAY_PARENT_ACL_MISSING_TARGET_DOES_NOT_ADD_IT' : relay.problem,
      detail: { companionSid: relay.companionSid, parents: relay.parents, targetEnsures: targetEnsuresRelayParents },
      advice: missing
        ? '本机 companion 用独立账户，中继的两个父目录缺它的 ACE；这个目标包的 verify-resident 不会补，升级会在 VERIFY 回滚。'
          + '请用含自动补齐（verify-resident 的 Invoke-CompanionRelayParentsEnsure）的提交重新打通用升级包；没有这样的包时，此节点需用通用安装包重装。'
        : '本机中继父目录或 companion 账户记录不是通用安装规定的形状，通用升级不会处理。此节点需用通用安装包重装。' });
  }
  const localChecks = result.unreadableSlots.length ? 'PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS' : 'PRECHECK_PASS';

  // Defect 15894c2a: a target with the train on must leave every node heard within 24 hours on one Source (§41.6), or stage 10 stops.
  const target = plan.target.ciSourceManifestSha256;
  const targetMode = targetPolicy?.train?.enabled;
  const knownMode = ['off', 'shadow', 'on'].includes(targetMode);
  if (knownMode && targetMode !== 'on') {
    result.fleetSourceReadiness = { status: 'NOT_REQUIRED', targetMode, targetCiSourceManifestSha256: target };
    return done(localChecks);
  }
  const fleet = knownMode
    ? fleetSourceCheck({ view: parseTrainNodes(st?.train?.nodes), target, now: clock(), onDuty: st?.node?.mode === 'ACTIVE',
      selfNames: [policy?.node?.nodeName, policy?.node?.hostname, st?.node?.name] })
    : { targetCiSourceManifestSha256: target, viewAt: null, status: 'UNVERIFIED', reason: 'TARGET_TRAIN_MODE_UNREADABLE' };
  result.fleetSourceReadiness = { ...fleet, targetMode: knownMode ? targetMode : null,
    ...(fleet.status === 'PASS' ? {} : { ownerStatusUrl: OWNER_NODES_URL }) };
  if (fleet.staleNodesIgnored?.length) result.warnings.push('FLEET_STALE_NODES_IGNORED');
  if (fleet.status === 'MISMATCH') {
    const names = fleet.upgradeFirst.map(n => n ?? '(unnamed)').join(', ');
    const stops = `本机升级后合并列车以 TRAIN_SOURCE_MISMATCH 停车，直到 ${names} 也装上同一个 Source，或它的最后心跳超过 24 小时。`;
    if (allowFleetSourceMismatch === true) {
      result.warnings.push('FLEET_SOURCE_MISMATCH_ALLOWED');
      result.fleetSourceReadiness.allowed = true;
      return done('PRECHECK_PASS_FLEET_SOURCE_MISMATCH_ALLOWED', { localChecks, advice: `已按 -AllowFleetSourceMismatch 放行：${stops}` });
    }
    return done('PRECHECK_REFUSED', { code: 'FLEET_SOURCE_MISMATCH', detail: { upgradeFirst: fleet.upgradeFirst }, localChecks,
      advice: `先给 ${names} 装目标 Source ${target.slice(0, 12)} 的包（待命节点先升、当班节点最后升），再升本机；否则${stops}`
        + '那台已永久离线时，可用 -AllowFleetSourceMismatch 显式放行（列车照样停到它的心跳满 24 小时）。' });
  }
  if (fleet.status === 'UNVERIFIED') {
    // No list this precheck may trust (a standby has none: only the ci-admission holder's stage 10 reads Native). Never a PASS of the fleet.
    result.warnings.push('FLEET_SOURCE_UNVERIFIED');
    return done('PRECHECK_PASS_LOCAL_ONLY', { localChecks, advice: UNVERIFIED_ADVICE[fleet.reason] ?? UNVERIFIED_ADVICE.NODES_VIEW_ABSENT });
  }
  return done(localChecks);
}

export async function main(argv, { log = s => process.stdout.write(s + '\n') } = {}) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' }, package: { type: 'string' }, 'package-sha': { type: 'string' }, acceptance: { type: 'string' },
    'installed-package': { type: 'string' }, 'allow-fleet-source-mismatch': { type: 'boolean' } } });
  need(values.root && values.package && values['installed-package'], 'USAGE');
  const r = await precheck({ root: values.root, pkgDir: values.package, pkgSha: values['package-sha'], acceptance: values.acceptance, installedPkgDir: values['installed-package'],
    allowFleetSourceMismatch: values['allow-fleet-source-mismatch'] === true });
  log(JSON.stringify(r));
  return r.status.startsWith('PRECHECK_PASS') ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stdout.write(JSON.stringify({ contract: PRECHECK_CONTRACT, status: 'PRECHECK_FAILED', code: error?.code ?? 'PRECHECK_FAILED', detail: error?.detail ?? String(error?.message ?? error).slice(0, 300) }) + '\n');
    process.exitCode = 1;
  });
}
