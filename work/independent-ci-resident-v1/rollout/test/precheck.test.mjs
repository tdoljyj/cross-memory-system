// precheck.mjs (DESIGN §42.3.2): the installed upgrader's ACCEPT against a node root, read-only. The packages carry the REAL upgrader
// copy of this tree (tools/build-package.mjs upgraderCopy), as every built package does, so the code that decides is the code under test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../../src/canonical.mjs';
import { upgraderCopy } from '../../tools/build-package.mjs';
import { DECISION, NODE, buildTestPackage, installGeneration1, tempDir } from '../../upgrader/test/fixtures.mjs';
import { precheck, readSddl, relayParentAclPresence, relayParents as relayParentsOf } from '../precheck.mjs';
import { trainNodesView } from '../../src/train.mjs';
import { trainFacts } from '../../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const RESIDENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = Date.parse('2026-11-01T08:00:00.000Z');
const TOOL = 'linux/upgrade-v1/bin/clued-ci-upgrade-linux';
const SIGNER = 'linux/upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs';
const TOOL_MANIFEST = 'linux/upgrade-v1/manifest.json';
const FROZEN_LINUX = { [TOOL]: '#!/usr/bin/python3.12 -I\n# tool\n', [SIGNER]: '// signer\n', [TOOL_MANIFEST]: '{"files":[]}\n' };

// A package whose `upgrader` is this tree's copy (one copy file changed with `change`, or every copy file AND the manifest list
// rewritten with `forge`), carrying the three frozen Linux upgrade files (`linux` overrides some of them). trainMode: the policy's
// train.enabled (null: no train key at all).
async function pkgWithCopy(dir, tag, { change = null, forge = null, linux = {}, trainMode = 'off', ...options } = {}) {
  const copy = await upgraderCopy(RESIDENT);
  let { manifest, manifestSha256 } = copy;
  const bytes = new Map();
  for (const f of manifest.files) bytes.set(f.path, await fs.readFile(path.join(RESIDENT, ...f.path.split('/'))));
  for (const p of [change, forge].filter(Boolean)) {
    // a forged file would run on import: it marks that it did
    bytes.set(p, Buffer.concat([bytes.get(p), Buffer.from(p === forge ? '\nglobalThis.__cluedForgedImport = true;\n' : '\n// changed\n')]));
    manifest = { ...manifest, files: manifest.files.map(f => (f.path === p ? { ...f, sha256: sha256(bytes.get(p)), bytes: bytes.get(p).length } : f)) };
    // `change` is an honest new copy (its own hash); `forge` keeps claiming the installed hash
    if (p === change) manifestSha256 = sha256(Buffer.from(canonicalJson(manifest) + '\n'));
  }
  const frozen = { ...FROZEN_LINUX, ...linux };
  const pkg = await buildTestPackage(dir, { tag, upgrader: { manifestSha256, files: manifest.files }, ...options, mutate: (m, files, put) => {
    const policyFile = m.files.find(f => f.target === 'config\\policy.json');
    const policy = JSON.parse(files.get(policyFile.path).toString('utf8'));
    if (trainMode !== null) policy.train = { enabled: trainMode };
    put(policyFile.path, canonicalJson(policy) + '\n');
    policyFile.sha256 = sha256(files.get(policyFile.path));
    for (const [p, text] of Object.entries(frozen)) {
      put(p, text);
      m.linux.files.push({ path: p, sha256: sha256(files.get(p)), bytes: files.get(p).length });
    }
    options.mutate?.(m, files, put);
  } });
  for (const [p, b] of bytes) { await fs.mkdir(path.dirname(path.join(dir, 'upgrader', p)), { recursive: true }); await fs.writeFile(path.join(dir, 'upgrader', p), b); }
  return pkg;
}

// A node root at generation 1 of `base`, whose installed upgrader is this tree's copy, and whose policy names the node.
async function node(t, base) {
  const root = await tempDir(t, 'clued-precheck-root-');
  await installGeneration1(root, base, { upgraderManifest: base.manifest.upgrader.manifestSha256 });
  const policy = JSON.parse(await fs.readFile(path.join(root, 'config', 'policy.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'config', 'policy.json'), JSON.stringify({ ...policy, node: { nodeName: NODE } }));
  return root;
}

async function world(t, nextOptions = {}) {
  const dir = await tempDir(t, 'clued-precheck-');
  const base = await pkgWithCopy(path.join(dir, 'n1'), 'n1');
  const next = await pkgWithCopy(path.join(dir, 'n2'), 'n2', nextOptions);
  const root = await node(t, base);
  const run = (over = {}) => precheck({ root, pkgDir: next.dir, pkgSha: next.sha, acceptance: DECISION, installedPkgDir: base.dir, clock: () => T, ...over });
  return { dir, base, next, root, run };
}

async function writeFacts(root, over) {
  const facts = { contract: 'clued.independent-ci.linux-version-facts/1', generation: 1, ciSourceManifestSha256: 'a'.repeat(64), sourceCommit: null, manifestSha256: 'b'.repeat(64),
    roles: {}, pinsOk: true, staged: null, upgradeToolSha256: sha256(Buffer.from(FROZEN_LINUX[TOOL])), observedAt: new Date(T).toISOString(), ...over };
  await fs.mkdir(path.join(root, 'upgrade', 'mailbox', 'responses'), { recursive: true });
  await fs.writeFile(path.join(root, 'upgrade', 'mailbox', 'responses', 'version-facts.json'), JSON.stringify(facts));
}

test('precheck: PASS with the installed upgrader; the plan it reports is the one ACCEPT would make; nothing is written', async t => {
  const { next, root, run } = await world(t);
  const before = await listing(root);
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.deepEqual([r.plan.fromGeneration, r.plan.toGeneration, r.plan.grantResource], [1, 2, `ci-resident:${NODE}/${next.sha}`]);
  assert.equal(r.plan.target.ciSourceManifestSha256, next.ciSource);
  assert.ok(r.plan.newDirs.some(d => d === `resident\\${next.residentSha}`));
  assert.ok(r.warnings.includes('LINUX_VERSION_FACTS_UNREADABLE'));
  assert.deepEqual(await listing(root), before);
  // without the installed package (ADR 0030: a universal reinstall leaves the node no copy of it) the same decision and the same plan
  const alone = await run({ installedPkgDir: null });
  assert.deepEqual([alone.status, alone.plan, alone.upgrader], [r.status, r.plan, r.upgrader]);
  assert.deepEqual(await listing(root), before);
});

test('precheck without the installed package: a changed upgrader is decided by the receipt, a changed Linux tool by the version facts', async t => {
  const a = await world(t, { change: 'src/store.mjs' });
  const r = await a.run({ installedPkgDir: null });
  assert.deepEqual([r.status, r.code, r.detail, r.changedFrozenFiles], ['PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'upgrader', undefined]);
  assert.notEqual(r.upgrader.installed, r.upgrader.package);
  const b = await world(t);
  await writeFacts(b.root, { upgradeToolSha256: 'e'.repeat(64) });
  const s = await b.run({ installedPkgDir: null });
  assert.deepEqual([s.status, s.code, s.detail], ['PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'linux-upgrade-tool']);
  await writeFacts(b.root, {});
  assert.equal((await b.run({ installedPkgDir: null })).status, 'PRECHECK_PASS');
});

test('precheck: an admin-only slot is a stand-in, the rest is still decided', async t => {
  const { root, run } = await world(t);
  const denied = path.join(root, 'helpers', 'controller-formal-generic-v2.exe');
  const readSlot = file => (file === denied ? Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })) : fs.readFile(file));
  const r = await run({ readSlot });
  assert.equal(r.status, 'PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS');
  assert.deepEqual(r.unreadableSlots, ['helpers\\controller-formal-generic-v2.exe']);
});

// Task 0b1516c0 (was defect 15894c2a): the precheck compares no Source across nodes. A fresh nodes list on the node on duty that shows the
// other node on another Source (behind, or really older: the same input) is no refusal; the order is upgrade.mjs step 8's, one Source
// across the fleet stage 10's TRAIN_SOURCE_MISMATCH at run time. The status snapshot's train.nodes is written exactly as the executor
// writes it: stage 10's facts (train-facts.mjs, as train-maintenance.mjs fills them) through train.mjs#trainNodesView.
const MIN = 60_000;
const peer = (node, source, heardAgo) => ({ node, sourceManifestSha256: source, state: 'NORMAL', lastHeartbeatAt: heardAgo === null ? null : new Date(T - heardAgo).toISOString() });
async function writeNodes(root, { own, nodes, at = T, mode = 'ACTIVE' }) {
  const facts = trainFacts({ mode: 'on', at: new Date(at).toISOString(), onDuty: true, holders: [], mainSha: null, rules: null, front: null, revoke: [], ledger: null,
    decision: 'NO_FRONT', nodes, nodesDropped: 0 });
  const view = trainNodesView(facts, own);
  assert.ok(view, 'stage 10 facts give a nodes view');
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'state', 'status.json'), JSON.stringify({ node: { name: NODE, mode }, train: { enabled: 'on', last: null, nodes: view } }));
}

test('task 0b1516c0: target on, the node on duty, a fresh list with the other node on an older Source: the precheck passes on its own checks', async t => {
  const { base, next, root, run } = await world(t, { trainMode: 'on' });
  await writeNodes(root, { own: base.ciSource, at: T - 5 * MIN, nodes: [peer(NODE, base.ciSource, MIN), peer('node-b', base.ciSource, MIN), peer('node-c', 'c'.repeat(64), 5 * MIN)] });
  const before = await listing(root);
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.equal(r.plan.target.ciSourceManifestSha256, next.ciSource);
  assert.ok(r.warnings.includes('NODE_HOLDS_CI_ADMISSION_HAND_OVER_FIRST'), 'the hand-over gate (upgrade.mjs step 8) still reads this');
  for (const k of ['fleetSourceReadiness', 'localChecks', 'code', 'advice']) assert.equal(k in r, false, k);
  assert.ok(!r.warnings.some(w => w.startsWith('FLEET_')), JSON.stringify(r.warnings));
  assert.deepEqual(await listing(root), before, 'nothing is written');
});

test('task 0b1516c0: --allow-fleet-source-mismatch is an unknown option now; the command line answers PRECHECK_FAILED with exit code 1', async t => {
  const { next, root, base } = await world(t, { trainMode: 'on' });
  const args = ['--root', root, '--package', next.dir, '--package-sha', next.sha, '--acceptance', DECISION, '--installed-package', base.dir];
  const cli = path.join(RESIDENT, 'rollout', 'precheck.mjs');
  const ok = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const r = spawnSync(process.execPath, [cli, ...args, '--allow-fleet-source-mismatch'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual([out.status, out.code], ['PRECHECK_FAILED', 'ERR_PARSE_ARGS_UNKNOWN_OPTION']);
});

test('precheck: a changed frozen module is a channel change, and the changed files are named', async t => {
  const { run } = await world(t, { change: 'src/store.mjs' });
  const r = await run();
  assert.deepEqual([r.status, r.code, r.detail], ['PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'upgrader']);
  assert.deepEqual(r.changedFrozenFiles.map(f => f.path), ['src/store.mjs']);
  assert.notEqual(r.upgrader.installed, r.upgrader.package);
});

test('precheck: a copy that claims the installed hash but is not its bytes is refused before anything of it runs', async t => {
  // a tampered file whose listed sha is not its bytes
  const a = await world(t);
  await fs.appendFile(path.join(a.next.dir, 'upgrader', 'upgrader', 'src', 'plan.mjs'), '\n// swapped\n');
  await assert.rejects(a.run(), { code: 'PRECHECK_UPGRADER_COPY_CHANGED' });
  // a consistently forged canonical.mjs AND its listed sha, still claiming the installed manifest hash: the hash computed here differs
  const b = await world(t, { forge: 'src/canonical.mjs' });
  await assert.rejects(b.run(), { code: 'PRECHECK_UPGRADER_COPY_CHANGED' });
  assert.equal(globalThis.__cluedForgedImport, undefined);
});

test('precheck: identity, compatibility, acceptance and the same package are the upgrader\'s own refusals', async t => {
  const { dir, base, root } = await world(t);
  const cases = [
    ['identity', { nodeIdentitySha256: 'e'.repeat(64) }, DECISION, 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL'],
    ['compat', { stateCompat: { schema: 2, readableBySchemas: [2] } }, DECISION, 'UPGRADE_STATE_COMPAT_REFUSED'],
    ['accept', {}, '1d84ddbb-ec1f-49c3-bbd0-953f72d53584', 'UPGRADE_REQUEST_REFUSED'],
  ];
  for (const [tag, options, acceptance, code] of cases) {
    const p = await pkgWithCopy(path.join(dir, tag), 'n2', options);
    const r = await precheck({ root, pkgDir: p.dir, pkgSha: p.sha, acceptance, installedPkgDir: base.dir, clock: () => T });
    assert.deepEqual([tag, r.status, r.code], [tag, 'PRECHECK_REFUSED', code], JSON.stringify(r));
  }
  const same = await precheck({ root, pkgDir: base.dir, pkgSha: base.sha, acceptance: DECISION, installedPkgDir: base.dir, clock: () => T });
  assert.deepEqual([same.status, same.code], ['PRECHECK_REFUSED', 'UPGRADE_SAME_AS_CURRENT']);
  await assert.rejects(precheck({ root, pkgDir: base.dir, pkgSha: 'a'.repeat(64), acceptance: DECISION, installedPkgDir: base.dir, clock: () => T }), { code: 'PRECHECK_PACKAGE_CHANGED' });
});

test('precheck: Linux facts that say the live tree is not the current generation are refused before the Grant (reinstall)', async t => {
  const { run, root } = await world(t);
  await writeFacts(root, { liveMatchesCurrent: false });
  const r = await run();
  assert.deepEqual([r.status, r.code], ['PRECHECK_REFUSED', 'LINUX_LIVE_NOT_THE_CURRENT_GENERATION'], JSON.stringify(r));
  assert.ok(r.advice.includes('此节点需用通用安装包重装'));
  for (const ok of [true, null]) {
    await writeFacts(root, { liveMatchesCurrent: ok });
    assert.notEqual((await run()).code, 'LINUX_LIVE_NOT_THE_CURRENT_GENERATION');
  }
  // not at rest (a staged generation): the upgrader's to finish or roll back, never "reinstall"
  await writeFacts(root, { liveMatchesCurrent: false, staged: { opId: '33333333-3333-4333-8333-333333333333', generation: 2 } });
  assert.notEqual((await run()).code, 'LINUX_LIVE_NOT_THE_CURRENT_GENERATION');
});

test('precheck: the frozen Linux upgrade tool, signer and tool manifest must be the installed package\'s and the node\'s', async t => {
  for (const changed of [TOOL, SIGNER, TOOL_MANIFEST]) {
    const { run } = await world(t, { linux: { [changed]: FROZEN_LINUX[changed] + '# changed\n' } });
    const r = await run();
    assert.deepEqual([changed, r.status, r.code, r.detail, r.changedFrozenFiles.map(f => f.path)],
      [changed, 'PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'linux-upgrade-tool', [changed]]);
  }
  const { root, run } = await world(t);
  await writeFacts(root, { upgradeToolSha256: 'a'.repeat(64) });
  const r = await run();
  assert.deepEqual([r.status, r.code, r.detail], ['PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'linux-upgrade-tool']);
  await writeFacts(root, { staged: { opId: '11111111-1111-4111-8111-111111111111', generation: 2 } });
  const s = await run();
  assert.equal(s.status, 'PRECHECK_PASS');
  assert.ok(s.warnings.includes('LINUX_HAS_A_STAGED_GENERATION'));
});

test('precheck: an installed package that is not the installed upgrader\'s is refused', async t => {
  const { next, run } = await world(t);
  await assert.rejects(run({ installedPkgDir: path.join(next.dir, 'nowhere') }), { code: 'ENOENT' });
  const other = await pkgWithCopy(path.join(path.dirname(next.dir), 'other'), 'n9', { change: 'src/inbox.mjs' });
  await assert.rejects(run({ installedPkgDir: other.dir }), { code: 'PRECHECK_INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION' });
  // an older package with the same upgrader (and so the same copy) is not the current generation either
  const older = await pkgWithCopy(path.join(path.dirname(next.dir), 'older'), 'n0');
  await assert.rejects(run({ installedPkgDir: older.dir }), { code: 'PRECHECK_INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION' });
});

async function listing(root) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else out.push([path.relative(root, p), sha256(await fs.readFile(p))]);
    }
  }
  await walk(root);
  return out.sort();
}

// ---- M5-b relay parents: a companion-account node whose relay parents miss the account's ACE is refused before any request ----
const COMPANION = 'S-1-5-21-10-11-12-1008';
const BASE_SDDL = 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x120080;;;S-1-5-21-10-11-12-1000)(A;OICI;0x1200a9;;;S-1-5-21-10-11-12-1007)';
const RESIDENT_SID = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629';
const OWN = `(A;;0x120080;;;${COMPANION})`;
const WITH = `${BASE_SDDL}${OWN}(A;;0x120080;;;${RESIDENT_SID})`;
const WITHOUT = `${BASE_SDDL}(A;;0x120080;;;${RESIDENT_SID})`;

test('M5-b relay parents: the SDDL rule is install-resident.ps1 Get-RelayParentAclPresence, never looser', () => {
  assert.equal(relayParentAclPresence(WITH, COMPANION), 'present');
  assert.equal(relayParentAclPresence(WITHOUT, COMPANION), 'missing');
  assert.equal(relayParentAclPresence(`${WITH}S:AI`, COMPANION), 'present');
  assert.equal(relayParentAclPresence(`D:P${OWN}`, COMPANION), 'present');
  const cases = [
    [WITH.replace('D:PAI', 'D:AI'), 'DACL not protected'],
    [`${WITH}${OWN}`, 'two entries for the account'],
    [WITH.replace(OWN, `(A;OICI;0x120080;;;${COMPANION})`), 'inheritable entry'],
    [WITH.replace(OWN, `(A;ID;0x120080;;;${COMPANION})`), 'inherited entry'],
    [WITH.replace(OWN, `(A;;0x1200a9;;;${COMPANION})`), 'more than metadata'],
    [WITH.replace(OWN, `(A;;FR;;;${COMPANION})`), 'mnemonic rights'],
    [WITH.replace(OWN, `(D;;0x120080;;;${COMPANION})`), 'deny for the account'],
    [`D:P(D;;RC;;;BU)${OWN}`, 'metadata deny (mnemonic)'],
    [`D:P(D;;0x80000000;;;WD)${OWN}`, 'generic read deny'],
    [`D:P(D;;0x10000000;;;AU)${OWN}`, 'generic all deny'],
    [`D:P(OA;;RC;;bf967aba-0de6-11d0-a285-00aa003049e2;;${COMPANION})`, 'object ACE'],
    [`D:P(XA;;0x120080;;;${COMPANION};(x==1))`, 'callback ACE'],
    [`D:P(A;XY;0x120080;;;${COMPANION})`, 'unknown ACE flag'],
    ['not an sddl', 'no DACL'],
  ];
  for (const [sddl, why] of cases) assert.equal(relayParentAclPresence(sddl, COMPANION), 'refused', why);
  // a deny that cannot touch the relay: inherit-only, or a hex mask outside metadata / generic read / generic all
  assert.equal(relayParentAclPresence(`D:P(D;OICIIO;FA;;;BU)${OWN}`, COMPANION), 'present');
  assert.equal(relayParentAclPresence(`D:P(D;;0x2;;;BU)${OWN}`, COMPANION), 'present');
  assert.equal(relayParentAclPresence(WITH, 'S-1-5-18'), 'refused');
  assert.equal(relayParentAclPresence(null, COMPANION), 'refused');
});

// A node whose resident root is <tmp>\ci\resident, so its relay parents are <tmp>\ci and <tmp>\ci\formal-spool (never the OS temp dir).
const RECORD = { contract: 'clued.independent-ci.companion-account/1', companionSid: COMPANION, operatorSid: 'S-1-5-21-10-11-12-1000' };
// ensures: the target package's verify-resident.ps1 defines Invoke-CompanionRelayParentsEnsure (true), only something else (false),
// or the package has no verify-resident.ps1 at all (null).
async function relayWorld(t, { record = RECORD, spool = true, ensures = false } = {}) {
  const dir = await tempDir(t, 'clued-precheck-relay-');
  const base = await pkgWithCopy(path.join(dir, 'n1'), 'n1');
  const verifyText = ensures ? '# verify\nfunction Invoke-CompanionRelayParentsEnsure([string]$root) { }\n' : '# verify\nfunction Something-Else { }\n';
  const next = await pkgWithCopy(path.join(dir, 'n2'), 'n2', ensures === null ? {} : { mutate: (m, files, put) => {
    put('resident/windows/verify-resident.ps1', verifyText);
    m.files.push({ path: 'resident/windows/verify-resident.ps1', target: `resident\\${m.residentManifestSha256}\\windows\\verify-resident.ps1`,
      sha256: sha256(files.get('resident/windows/verify-resident.ps1')) });
  } });
  const ci = path.join(dir, 'ci');
  const root = path.join(ci, 'resident');
  await fs.mkdir(root, { recursive: true });
  await installGeneration1(root, base, { upgraderManifest: base.manifest.upgrader.manifestSha256 });
  const policy = JSON.parse(await fs.readFile(path.join(root, 'config', 'policy.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'config', 'policy.json'), JSON.stringify({ ...policy, node: { nodeName: NODE } }));
  if (spool) await fs.mkdir(path.join(ci, 'formal-spool'));
  if (record !== null) {
    await fs.mkdir(path.join(root, 'install'), { recursive: true });
    await fs.writeFile(path.join(root, 'install', 'companion-account.json'), typeof record === 'string' ? record : JSON.stringify(record));
  }
  const reads = [];
  const sddlOf = new Map([[ci, WITH], [path.join(ci, 'formal-spool'), WITH]]);
  const run = (over = {}) => precheck({ root, pkgDir: next.dir, pkgSha: next.sha, acceptance: DECISION, installedPkgDir: base.dir, clock: () => T,
    readParentSddl: async d => { reads.push(d); return sddlOf.get(d); }, ...over });
  return { ci, root, run, reads, sddlOf };
}

test('M5-b relay parents: both parents carry the account\'s entry: PASS, and the result says what was checked', async t => {
  const { ci, run, reads } = await relayWorld(t);
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.deepEqual(reads, [ci, path.join(ci, 'formal-spool')]);
  assert.deepEqual(r.companionRelayParents, { companionSid: COMPANION, parents: reads.map(p => ({ path: p, presence: 'present' })), problem: null, targetEnsures: false });
});

test('M5-b relay parents: an entry missing and a target whose VERIFY does not add it is refused; no hand repair is offered', async t => {
  for (const ensures of [false, null]) {
    const { ci, run, sddlOf } = await relayWorld(t, { ensures });
    sddlOf.set(path.join(ci, 'formal-spool'), WITHOUT);
    const r = await run();
    assert.equal(r.status, 'PRECHECK_REFUSED', JSON.stringify(r));
    assert.equal(r.code, 'COMPANION_RELAY_PARENT_ACL_MISSING_TARGET_DOES_NOT_ADD_IT');
    assert.deepEqual([r.detail.parents.map(p => p.presence), r.detail.targetEnsures], [['present', 'missing'], false]);
    assert.ok(r.advice.includes('Invoke-CompanionRelayParentsEnsure') && r.advice.includes('此节点需用通用安装包重装'));
    assert.equal('fix' in r, false);
    assert.doesNotMatch(r.advice, /powershell|ensure-companion/i);
  }
});

test('M5-b relay parents: an entry missing and a target whose VERIFY adds it passes, with a notice (the generic upgrade fixes it)', async t => {
  const { ci, run, sddlOf } = await relayWorld(t, { ensures: true });
  sddlOf.set(ci, WITHOUT);
  sddlOf.set(path.join(ci, 'formal-spool'), WITHOUT);
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.ok(r.warnings.includes('COMPANION_RELAY_PARENTS_ADDED_BY_THE_UPGRADE_VERIFY'));
  assert.deepEqual([r.companionRelayParents.problem, r.companionRelayParents.targetEnsures], ['COMPANION_RELAY_PARENT_ACL_MISSING', true]);
});

test('M5-b relay parents: an unreadable, absent or odd parent, or a bad account record, is refused (never a pass by error)', async t => {
  // a shape the installer's rule refuses is refused even when the target's VERIFY adds a missing entry: only a reinstall
  const odd = await relayWorld(t, { ensures: true });
  odd.sddlOf.set(odd.ci, WITH.replace('D:PAI', 'D:AI'));
  const r0 = await odd.run();
  assert.deepEqual([r0.status, r0.code], ['PRECHECK_REFUSED', 'COMPANION_RELAY_PARENT_ACL_REFUSED']);
  assert.ok(r0.advice.includes('此节点需用通用安装包重装'));
  const throws = await relayWorld(t);
  const r1 = await throws.run({ readParentSddl: async () => { throw new Error('access denied'); } });
  assert.deepEqual([r1.status, r1.code, r1.detail.parents.map(p => p.presence)], ['PRECHECK_REFUSED', 'COMPANION_RELAY_PARENT_ACL_REFUSED', ['unreadable', 'unreadable']]);
  const noSpool = await relayWorld(t, { spool: false });
  const r2 = await noSpool.run();
  assert.deepEqual([r2.code, r2.detail.parents.map(p => p.presence)], ['COMPANION_RELAY_PARENT_ACL_REFUSED', ['present', 'unreadable']]);
  const records = ['{not json', { contract: 'other/1', companionSid: COMPANION }, { contract: RECORD.contract, companionSid: 'S-1-5-18' }];
  for (const record of records) {
    const w = await relayWorld(t, { record });
    const r = await w.run();
    assert.deepEqual([r.status, r.code, w.reads.length], ['PRECHECK_REFUSED', 'COMPANION_ACCOUNT_RECORD_REFUSED', 0], JSON.stringify(record));
  }
});

test('M5-b relay parents: a node without its own companion account is not asked about the parents', async t => {
  const { run, reads } = await relayWorld(t, { record: null });
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.equal(reads.length, 0);
  assert.equal('companionRelayParents' in r, false);
});

test('M5-b relay parents: the default reader returns the live SDDL of a real directory (read-only, not elevated) [needs:non-elevated]', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t, 'clued-precheck-sddl-');
  assert.match(await readSddl(dir), /^O:.*D:/);
  // Refused by PowerShell itself (Get-Acl: the path does not exist, exit 1), not by readSddl's 60 s limit killing it.
  await assert.rejects(readSddl(path.join(dir, 'absent')), (error) => {
    assert.notEqual(error.killed, true, `killed: ${error.signal}`);
    assert.equal(error.code, 1, String(error.code));
    return true;
  });
  assert.equal(relayParentsOf(path.join(dir, 'resident'))[0], dir);
});
