import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_CONTRACT, UPGRADER_CONFIG_CONTRACT, buildPackage, importClosure, upgraderCopy } from '../tools/build-package.mjs';
import { installedIntegrity } from '../src/service-ports.mjs';
import { installedTrainLanding, validatePolicy } from '../src/policy.mjs';
import { canonicalJson, sha256 } from '../src/canonical.mjs';
import { nodeProfileSha256 } from '../src/node-profile.mjs';
import { tempRoot } from './helpers.mjs';
// Test-only use of the Source v2 record assembler and bridge manifest (the resident never imports them).
import { fixtureRecord } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { writeRecord } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs';
import { bridgeManifest } from '../../actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/bridge-manifest.mjs';
// Test-only use of the upgrader's package reader (B1): a package this tool builds must be one the upgrader reads.
import { validatePackageManifest } from '../upgrader/src/package.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CI = path.resolve(HERE, '..', 'actions-hosted-migration', 'independent-ci-v1');
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BRIDGE = 'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4';
const BRIDGE_FILES = ['boundary.mjs', 'formal-spool-acl.ps1', 'issue-job.mjs', 'linux-worker.mjs', 'mailbox.mjs', 'protocol.mjs', 'relay-public.ps1', 'relay-record.mjs', 'signed-result.mjs', 'windows-issuer.mjs'];

test('the install package is assembled create-only, pins every file and binds policy to both manifests and the record', async t => {
  const root = await tempRoot(t);
  const node = path.join(root, 'node.exe');
  await fs.writeFile(node, 'not really node');
  const record = path.join(root, 'record');
  const fx = fixtureRecord();
  writeRecord(record, { files: fx.files, recordManifest: fx.recordManifest });
  const out = path.join(root, 'pkg');
  const profile = JSON.parse(fx.files['acceptance.json']).node;
  const policyInput = JSON.parse(await fs.readFile(path.join(HERE, 'config', 'policy.example.json'), 'utf8'));
  policyInput.node = profile; policyInput.nodeProfileSha256 = nodeProfileSha256(profile);
  policyInput.companion.userSid = profile.ownerSid; policyInput.linux.distribution = profile.wslDistribution;
  const companionInput = JSON.parse(await fs.readFile(path.join(HERE, 'config', 'companion.example.json'), 'utf8'));
  Object.assign(companionInput.companion, { node: profile, nodeProfileSha256: nodeProfileSha256(profile), distribution: profile.wslDistribution });
  const policyFile = path.join(root, 'policy.json'), companionFile = path.join(root, 'companion.json');
  await fs.writeFile(policyFile, JSON.stringify(policyInput)); await fs.writeFile(companionFile, JSON.stringify(companionInput));
  const pins = [{ installedPath: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node', sha256: 'c'.repeat(64) }];
  const sourceFiles = ['work/actions-hosted-migration/independent-ci-v1/src/resident-v2/derive-batch.mjs', ...BRIDGE_FILES.map(n => `${BRIDGE}/${n}`)];
  const r = await buildPackage({ out, policyFile, companionFile, nodeExe: node,
    recordDir: record, sourceRoot: REPO_ROOT, sourceFiles, linuxExternalPins: pins });
  assert.equal(r.ciSourceManifestSha256, fx.recordManifest.sourceManifestSha256);
  const linux = JSON.parse(await fs.readFile(path.join(out, 'linux', 'manifest.json'), 'utf8'));
  assert.ok(linux.files.every(f => f.installedPath.startsWith('/')), 'Linux pins name installed paths');
  assert.ok(linux.files.some(f => f.installedPath === '/etc/systemd/system/clued-ci-worker@.service'));
  assert.ok(linux.files.some(f => f.installedPath.endsWith('/node')), 'external entry points are pinned too');
  assert.ok(!linux.files.some(f => f.installedPath.endsWith('clued-ci-install-source-v2')), 'the one-time Source v2 installer is not a unit-guard pin');
  assert.match(r.linuxSourceV2InstallerSha256, /^[0-9a-f]{64}$/);
  assert.equal(r.linuxSourceV2InstallerSha256, sha256(await fs.readFile(path.join(out, 'linux', 'bin', 'clued-ci-install-source-v2'))));
  assert.equal(r.packageManifestSha256, sha256(await fs.readFile(path.join(out, 'package-manifest.json'))));
  const pkg = JSON.parse(await fs.readFile(path.join(out, 'package-manifest.json'), 'utf8'));
  const shape = /^(?:(?:resident|source)\\[0-9a-f]{64}(?:\\[A-Za-z0-9_.@-]+)+|(?:config|runtime|bin|helpers|record)\\[A-Za-z0-9_.@-]+)$/;
  for (const f of pkg.files) {
    assert.equal(sha256(await fs.readFile(path.join(out, f.path))), f.sha256, f.path);
    assert.match(f.target, shape, 'every target fits the install script allow-list');
  }
  assert.ok(pkg.files.some(f => f.target.endsWith('\\windows\\rearm-resident.ps1')), 'elevated scripts are installed into the admin-only copy');
  assert.ok(pkg.files.some(f => f.target === ['resident', r.residentManifestSha256, 'src', 'executor.mjs'].join('\\')));
  for (const parts of [['src', 'wsl-client.mjs'], ['windows', 'wsl-client.ps1']]) {
    assert.ok(pkg.files.some(f => f.target === ['resident', r.residentManifestSha256, ...parts].join('\\')), 'the runtime and its WSL trust validator belong to the same pinned generation');
  }
  // S5/S12: the Source sits under the record's CI Source manifest hash; the record is admin-only in record\
  assert.ok(pkg.files.some(f => f.target === ['source', r.ciSourceManifestSha256, ...sourceFiles[0].split('/')].join('\\')));
  for (const n of ['installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json', 'record-manifest.json']) assert.ok(pkg.files.some(f => f.target === `record\\${n}`), n);
  assert.equal(pkg.files.some(f => f.target.startsWith('helpers\\')), false, 'no prebuilt helper: the generic helper is compiled at install');
  const policy = validatePolicy(JSON.parse(await fs.readFile(path.join(out, 'config', 'policy.json'), 'utf8')));
  assert.equal(policy.residentManifestSha256, r.residentManifestSha256);
  assert.equal(policy.sourceManifestSha256, r.sourceManifestSha256);
  assert.equal(policy.ciSourceManifestSha256, r.ciSourceManifestSha256);
  const companion = JSON.parse(await fs.readFile(path.join(out, 'config', 'companion.json'), 'utf8'));
  assert.equal(companion.status.node, profile.nodeName, 'the PR-page node name is bound to the same installed profile');
  assert.equal(companion.companion.nodeProfileSha256, fx.recordManifest.nodeProfileSha256);
  assert.ok(companion.companion.relayScript.includes(r.ciSourceManifestSha256));
  // the generated bridge manifest is the one bridge-manifest.mjs computes over the same bytes
  assert.equal(companion.companion.bridgeManifestSha256, bridgeManifest(path.join(REPO_ROOT, ...BRIDGE.split('/'))).sha256);
  assert.equal(r.bridgeManifestSha256, companion.companion.bridgeManifestSha256);
  // The service's own integrity check accepts exactly this layout.
  const integrity = await installedIntegrity({
    sourceRoot: path.join(out, 'source'), sourceManifest: path.join(out, 'config', 'source-installed-manifest.json'),
    residentRoot: path.join(out, 'resident'), residentManifest: path.join(out, 'config', 'resident-installed-manifest.json'),
  })();
  assert.deepEqual(integrity, { ok: true, sourceManifestSha256: r.sourceManifestSha256, residentManifestSha256: r.residentManifestSha256 });
  await assert.rejects(buildPackage({ out, policyFile: 'x', companionFile: 'y', nodeExe: node, recordDir: record }), { code: 'EEXIST' });
  void CI;
});

// ---- package /4 (in-place upgrade channel, Task 018da927, DESIGN §34) ----

async function inputs(t) {
  const root = await tempRoot(t);
  const node = path.join(root, 'node.exe');
  await fs.writeFile(node, 'not really node');
  const record = path.join(root, 'record');
  const fx = fixtureRecord();
  writeRecord(record, { files: fx.files, recordManifest: fx.recordManifest });
  const profile = JSON.parse(fx.files['acceptance.json']).node;
  const policyInput = JSON.parse(await fs.readFile(path.join(HERE, 'config', 'policy.example.json'), 'utf8'));
  policyInput.node = profile; policyInput.nodeProfileSha256 = nodeProfileSha256(profile);
  policyInput.companion.userSid = profile.ownerSid; policyInput.linux.distribution = profile.wslDistribution;
  const companionInput = JSON.parse(await fs.readFile(path.join(HERE, 'config', 'companion.example.json'), 'utf8'));
  Object.assign(companionInput.companion, { node: profile, nodeProfileSha256: nodeProfileSha256(profile), distribution: profile.wslDistribution });
  const policyFile = path.join(root, 'policy.json'), companionFile = path.join(root, 'companion.json');
  await fs.writeFile(policyFile, JSON.stringify(policyInput)); await fs.writeFile(companionFile, JSON.stringify(companionInput));
  const upgraderConfigFile = path.join(root, 'upgrader.json');
  await fs.writeFile(upgraderConfigFile, JSON.stringify({ contract: UPGRADER_CONFIG_CONTRACT, node: profile.nodeName, nodeProfileSha256: nodeProfileSha256(profile), ownerSid: profile.ownerSid,
    root: 'C:\\ProgramData\\CluedIndependentCI\\resident', supabaseUrl: 'https://example.invalid', publishableKey: 'sb_publishable_test', confirmOrigin: 'https://example.invalid',
    tokenFile: 'C:\\ProgramData\\CluedIndependentCI\\resident\\secrets\\resident-upgrade.token', timeouts: {}, keepGenerations: 3 }));
  const bundle = path.join(root, 'source.bundle');
  await fs.writeFile(bundle, 'a git bundle stand-in');
  return { root, node, record, profile, policyInput, policyFile, companionFile, upgraderConfigFile, bundle };
}

// DESIGN §41.9 step 4: the train mode is one fleet value. The generic upgrade hands each node's installed policy back to build-package
// unchanged (rollout/fleet/install.mjs#configInputsFor), so the mode a node was first installed with stayed for good (2026-11-14:
// turing ACTIVE on shadow, desk-w-591 STANDBY on on, one Source). Every /8+ package carries the fleet's train instead.
test('package: every /8+ policy gets the fleet train (on, nonFrontRuns, audit, push, batchMax 1), whatever the installed node carried; /7 is left alone', async t => {
  const i = await inputs(t);
  const v10 = JSON.parse(await fs.readFile(path.join(HERE, 'config', 'policy.v10.example.json'), 'utf8'));
  Object.assign(v10, { node: i.policyInput.node, nodeProfileSha256: i.policyInput.nodeProfileSha256 });
  v10.companion.userSid = i.policyInput.companion.userSid; v10.linux.distribution = i.policyInput.linux.distribution;
  const built = [];
  for (const [name, train] of [['shadow', { ...v10.train, enabled: 'shadow' }], ['on-other-tuning', { ...v10.train, enabled: 'on', nonFrontRuns: false, maintenanceEveryMs: 1_200_000 }],
    ['off', { ...v10.train, enabled: 'off', sweep: 'gate' }], ['push-batch', { ...v10.train, sweep: 'audit', landing: 'push', batchMax: 3 }]]) {
    const policyFile = path.join(i.root, `policy-${name}.json`), out = path.join(i.root, `pkg-${name}`);
    await fs.writeFile(policyFile, JSON.stringify({ ...v10, train }));
    await buildPackage({ out, policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record });
    built.push(JSON.parse(await fs.readFile(path.join(out, 'config', 'policy.json'), 'utf8')).train);
  }
  assert.deepEqual(built[0], { enabled: 'on', nonFrontRuns: true, maintenanceEveryMs: 600_000, maintenanceMaxPerDay: 200, slotHardCapMinutes: 120,
    frontBatchBudgetMs: 3_600_000, sweepFreshMs: 900_000, fullSweepMaxMs: 21_600_000, sweep: 'audit', landing: 'push' });
  for (const train of built) {
    assert.deepEqual(train, built[0]);
    assert.deepEqual(installedTrainLanding({ train }), { landing: 'push', batchMax: 1 });
  }
  // a /7 policy cannot carry 'on' (POLICY_TRAIN_ON_NOT_SUPPORTED): its train goes through as it was
  const out7 = path.join(i.root, 'pkg-v7');
  await buildPackage({ out: out7, policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out7, 'config', 'policy.json'), 'utf8')).train, i.policyInput.train);
});

// DESIGN §76: every installed node's policy still carries `relay` and its companion.json `hints` (the removed hosted relay); the generic
// upgrade hands both back to build-package unchanged (rollout/fleet/install.mjs#configInputsFor), and the package leaves them out.
test('package: the legacy relay block of an installed policy and companion hints are left out, so the upgrade converges every node', async t => {
  const i = await inputs(t);
  const relay = { enabled: false, roles: ['gitleaks', 'trivy'], wait: { signalMs: 600000, queueMs: 900000, runSlackMs: 600000, totalMs: 3600000, pollMs: 60000,
    jobTimeoutMs: { gitleaks: 1500000, trivy: 1500000 } } };
  await fs.writeFile(i.policyFile, JSON.stringify({ ...i.policyInput, relay }), { flag: 'w' });
  const companionInput = JSON.parse(await fs.readFile(i.companionFile, 'utf8'));
  await fs.writeFile(i.companionFile, JSON.stringify({ ...companionInput, hints: { enabled: false, ciSourceManifestSha256: 'd'.repeat(64) } }), { flag: 'w' });
  const out = path.join(i.root, 'pkg-legacy');
  await buildPackage({ out, policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record });
  const policy = JSON.parse(await fs.readFile(path.join(out, 'config', 'policy.json'), 'utf8'));
  const companion = JSON.parse(await fs.readFile(path.join(out, 'config', 'companion.json'), 'utf8'));
  assert.equal(Object.hasOwn(policy, 'relay'), false);
  assert.equal(Object.hasOwn(companion, 'hints'), false);
  assert.equal(validatePolicy(policy).ciSourceManifestSha256, policy.ciSourceManifestSha256);
});

test('package /4: layout, state compatibility, acceptance, the Linux section with the upgrade tool, and the upgrader section without its install targets', async t => {
  const i = await inputs(t);
  const out = path.join(i.root, 'pkg');
  const roles = { gitleaks: '1'.repeat(64), trivy: '2'.repeat(64), 'contract-placement': '3'.repeat(64) };
  const r = await buildPackage({ out, policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record,
    stateCompat: { schema: 2, readableBySchemas: [1, 2] }, sourceV2: { commit: 'f'.repeat(40), bundle: i.bundle, rolesDerivedSha256: roles } });
  const bytes = await fs.readFile(path.join(out, 'package-manifest.json'));
  assert.equal(bytes.toString('utf8'), canonicalJson(JSON.parse(bytes.toString('utf8'))) + '\n', 'canonical JSON plus a newline (A1)');
  const pkg = JSON.parse(bytes.toString('utf8'));
  assert.equal(pkg.contract, PACKAGE_CONTRACT);
  assert.equal(PACKAGE_CONTRACT, 'clued.independent-ci.resident-package/4');
  assert.deepEqual(Object.keys(pkg).sort(), ['acceptance', 'bridgeManifestSha256', 'ciSourceManifestSha256', 'contract', 'files', 'linux', 'nodeIdentitySha256', 'nodeProfileSha256',
    'residentManifestSha256', 'sourceManifestSha256', 'stateCompat', 'upgrader', 'windowsLayout']);
  assert.equal(pkg.windowsLayout, 'clued.independent-ci.resident-layout/1');
  assert.deepEqual(pkg.stateCompat, { schema: 2, readableBySchemas: [1, 2] });
  assert.deepEqual(pkg.acceptance, { decisionRef: i.policyInput.ownerAcceptance.decisionRef });
  assert.equal(pkg.nodeProfileSha256, nodeProfileSha256(i.profile));
  assert.equal(r.packageManifestSha256, sha256(bytes));
  // no install target under upgrader\ in an upgrade package; every target fits the /3 allow-list
  assert.equal(pkg.files.some(f => f.target.startsWith('upgrader\\')), false);
  // the Linux section: the resident manifest's hash, the bundle named apart, every listed file with its size
  assert.equal(pkg.linux.manifestSha256, sha256(await fs.readFile(path.join(out, 'linux', 'manifest.json'))));
  assert.deepEqual(pkg.linux.sourceV2, { commit: 'f'.repeat(40), bundlePath: 'linux/source-v2/source.bundle', bundleSha256: sha256(await fs.readFile(i.bundle)), rolesDerivedSha256: roles });
  const listed = pkg.linux.files.map(f => f.path).sort();
  assert.deepEqual(listed, ['linux/bin/clued-ci-install-source-v2', 'linux/bin/clued-ci-resident-linux', 'linux/manifest.json', 'linux/systemd/clued-ci-archive@.service',
    'linux/systemd/clued-ci-worker@.service', 'linux/systemd/clued-ci-wsprep@.service', 'linux/upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs',
    'linux/upgrade-v1/bin/clued-ci-upgrade-linux', 'linux/upgrade-v1/manifest.json']);
  for (const f of pkg.linux.files) {
    const b = await fs.readFile(path.join(out, ...f.path.split('/')));
    assert.deepEqual([sha256(b), b.length], [f.sha256, f.bytes], f.path);
  }
  // the frozen Linux upgrade tool and the signer: the repository's bytes, pinned at their installed paths
  const tool = JSON.parse(await fs.readFile(path.join(out, 'linux', 'upgrade-v1', 'manifest.json'), 'utf8'));
  assert.equal(tool.contract, 'clued.independent-ci.linux-upgrade-tool-manifest/1');
  assert.deepEqual(tool.files.map(f => f.installedPath).sort(), ['/opt/clued-independent-ci/upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs', '/opt/clued-independent-ci/upgrade-v1/bin/clued-ci-upgrade-linux']);
  assert.equal(r.linuxSignerSha256, sha256(await fs.readFile(path.join(HERE, 'linux', 'bin', 'clued-ci-sign-qualification-v2.mjs'))));
  assert.equal(r.linuxUpgradeToolSha256, sha256(await fs.readFile(path.join(HERE, 'linux', 'bin', 'clued-ci-upgrade-linux'))));
  // the upgrader section: its manifest over the copy, the same as computed from this tree, its own code and the resident modules it imports only
  const copy = await upgraderCopy(HERE);
  assert.equal(pkg.upgrader.manifestSha256, copy.manifestSha256);
  assert.deepEqual(pkg.upgrader.files, copy.manifest.files);
  const paths = pkg.upgrader.files.map(f => f.path);
  assert.ok(paths.includes('windows/upgrade-apply.ps1') && paths.includes('src/canonical.mjs') && paths.includes('src/upgrade-mailbox.mjs'));
  assert.ok(paths.every(p => /^(?:upgrader\/src|src)\/[A-Za-z0-9_.-]+$/.test(p) || p === 'windows/upgrade-apply.ps1'), 'nothing but the copy');
  assert.equal(paths.includes('src/executor.mjs'), false, 'a resident module the upgrader does not import is not frozen with it');
  for (const f of pkg.upgrader.files) assert.equal(sha256(await fs.readFile(path.join(out, 'upgrader', ...f.path.split('/')))), f.sha256, f.path);
  // a second build of the same tree names the same upgrader (an in-place upgrade compares exactly this hash)
  const again = await buildPackage({ out: path.join(i.root, 'pkg2'), policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record });
  assert.equal(again.upgraderManifestSha256, r.upgraderManifestSha256);
  const pkg2 = JSON.parse(await fs.readFile(path.join(i.root, 'pkg2', 'package-manifest.json'), 'utf8'));
  assert.equal(pkg2.linux.sourceV2, null);
  // the upgrader's own manifest check (B1, upgrader/src/package.mjs; test-only import) takes both manifests as they are
  assert.equal(validatePackageManifest(structuredClone(pkg)).contract, PACKAGE_CONTRACT);
  assert.equal(validatePackageManifest(structuredClone(pkg2)).upgrader.manifestSha256, r.upgraderManifestSha256);
  assert.deepEqual(pkg2.stateCompat, { schema: 1, readableBySchemas: [1] }, 'the default');
});

test('package /4 for a fresh install: the upgrader copy, host source, node and config get their upgrader\\ targets; bad inputs are refused', async t => {
  const i = await inputs(t);
  const out = path.join(i.root, 'pkg');
  const r = await buildPackage({ out, policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record, freshInstall: true, upgraderConfigFile: i.upgraderConfigFile });
  const pkg = JSON.parse(await fs.readFile(path.join(out, 'package-manifest.json'), 'utf8'));
  const m = r.upgraderManifestSha256;
  const up = pkg.files.filter(f => f.target.startsWith('upgrader\\'));
  assert.equal(up.length, pkg.upgrader.files.length + 3);
  for (const f of pkg.upgrader.files) assert.ok(up.some(x => x.target === `upgrader\\${m}\\${f.path.replace(/\//g, '\\')}` && x.sha256 === f.sha256), f.path);
  for (const target of ['upgrader\\bin\\UpgraderServiceHost.cs', 'upgrader\\runtime\\node.exe', 'upgrader\\config\\upgrader.json']) assert.ok(up.some(x => x.target === target), target);
  assert.equal(up.find(x => x.target === 'upgrader\\config\\upgrader.json').sha256, sha256(await fs.readFile(i.upgraderConfigFile)));
  // B2's install allow-list (install-resident.ps1 $TargetShape) takes every target
  const shape = /^(?:(?:resident|source|upgrader)\\[0-9a-f]{64}(?:\\[A-Za-z0-9_.@-]+)+|(?:config|runtime|bin|helpers|record)\\[A-Za-z0-9_.@-]+|upgrader\\(?:config|runtime|bin)\\[A-Za-z0-9_.@-]+)$/;
  for (const f of pkg.files) {
    assert.match(f.target, shape, f.target);
    assert.equal(sha256(await fs.readFile(path.join(out, ...f.path.split('/')))), f.sha256, f.path);
  }
  assert.equal(new Set(pkg.files.map(f => f.target.toLowerCase())).size, pkg.files.length, 'no target twice');
  // refusals
  await assert.rejects(buildPackage({ out: path.join(i.root, 'x1'), policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record, freshInstall: true }), { code: 'PACKAGE_UPGRADER_CONFIG_REQUIRED' });
  await assert.rejects(buildPackage({ out: path.join(i.root, 'x2'), policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record, stateCompat: { schema: 0, readableBySchemas: [] } }), { code: 'PACKAGE_STATE_COMPAT_REFUSED' });
  await assert.rejects(buildPackage({ out: path.join(i.root, 'x3'), policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record,
    sourceV2: { commit: 'f'.repeat(40), bundle: i.bundle, rolesDerivedSha256: { gitleaks: '1'.repeat(64) } } }), { code: 'PACKAGE_SOURCE_V2_INPUT_REFUSED' });
  const badCfg = path.join(i.root, 'bad-upgrader.json');
  await fs.writeFile(badCfg, JSON.stringify({ contract: UPGRADER_CONFIG_CONTRACT, nodeProfileSha256: 'd'.repeat(64) }));
  await assert.rejects(buildPackage({ out: path.join(i.root, 'x4'), policyFile: i.policyFile, companionFile: i.companionFile, nodeExe: i.node, recordDir: i.record, freshInstall: true, upgraderConfigFile: badCfg }), { code: 'PACKAGE_UPGRADER_CONFIG_REFUSED' });
});

test('the upgrader copy follows relative imports only inside src/ and upgrader/src/', async t => {
  const base = await tempRoot(t);
  await fs.mkdir(path.join(base, 'upgrader', 'src'), { recursive: true }); await fs.mkdir(path.join(base, 'src')); await fs.mkdir(path.join(base, 'windows'));
  await fs.writeFile(path.join(base, 'upgrader', 'src', 'a.mjs'), "import { b } from '../../src/b.mjs';\nimport x from './c.mjs';\n");
  await fs.writeFile(path.join(base, 'upgrader', 'src', 'c.mjs'), 'export default 1;\n');
  await fs.writeFile(path.join(base, 'src', 'b.mjs'), "export { d as b } from './d.mjs';\nconst t = new URL('./t.json', import.meta.url);\n");
  await fs.writeFile(path.join(base, 'src', 'd.mjs'), "import fs from 'node:fs';\nexport const d = 1;\n");
  await fs.writeFile(path.join(base, 'src', 't.json'), '{}');
  await fs.writeFile(path.join(base, 'src', 'unused.mjs'), 'export const u = 1;\n');
  await fs.writeFile(path.join(base, 'windows', 'upgrade-apply.ps1'), '# apply\n');
  const c = await upgraderCopy(base);
  assert.deepEqual(c.manifest.files.map(f => f.path), ['src/b.mjs', 'src/d.mjs', 'src/t.json', 'upgrader/src/a.mjs', 'upgrader/src/c.mjs', 'windows/upgrade-apply.ps1']);
  await fs.writeFile(path.join(base, 'upgrader', 'src', 'c.mjs'), "import '../../tools/x.mjs';\n");
  await assert.rejects(upgraderCopy(base), { code: 'PACKAGE_UPGRADER_IMPORT_REFUSED' });
  assert.deepEqual(await importClosure(base, ['src/d.mjs']), ['src/d.mjs']);
});

test('package: the panel trigger is on unless switched off, and only for the panel\'s own repository (a configuration that names another repository is refused)', async t => {
  const i = await inputs(t);
  const roles = { gitleaks: '1'.repeat(64), trivy: '2'.repeat(64), 'contract-placement': '3'.repeat(64) };
  const build = async (name, change) => {
    const companion = JSON.parse(await fs.readFile(i.companionFile, 'utf8'));
    change(companion);
    const file = path.join(i.root, `companion-${name}.json`);
    await fs.writeFile(file, JSON.stringify(companion));
    return buildPackage({ out: path.join(i.root, `pkg-${name}`), policyFile: i.policyFile, companionFile: file, nodeExe: i.node, recordDir: i.record,
      stateCompat: { schema: 2, readableBySchemas: [1, 2] }, sourceV2: { commit: 'f'.repeat(40), bundle: i.bundle, rolesDerivedSha256: roles } });
  };
  await build('default', () => {});
  await assert.rejects(build('other-repo', c => { c.repo = 'tdoljyj/other-repo'; }), { code: 'PACKAGE_PANEL_DISPATCH_REPO_MISMATCH' });
  await assert.rejects(build('bad-key', c => { c.panelDispatch = { workflow: 'x.yml' }; }), { code: 'COMPANION_PANEL_DISPATCH_CONFIG_INVALID' });
  await build('off-other-repo', c => { c.repo = 'tdoljyj/other-repo'; c.panelDispatch = { enabled: false }; });
  const kept = JSON.parse(await fs.readFile(path.join(i.root, 'pkg-off-other-repo', 'config', 'companion.json'), 'utf8'));
  assert.deepEqual(kept.panelDispatch, { enabled: false });
});
