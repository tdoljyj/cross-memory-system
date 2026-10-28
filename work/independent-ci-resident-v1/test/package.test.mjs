import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../tools/build-package.mjs';
import { installedIntegrity } from '../src/service-ports.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { sha256 } from '../src/canonical.mjs';
import { nodeProfileSha256 } from '../src/node-profile.mjs';
import { tempRoot } from './helpers.mjs';
// Test-only use of the Source v2 record assembler and bridge manifest (the resident never imports them).
import { fixtureRecord } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { writeRecord } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs';
import { bridgeManifest } from '../../actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/bridge-manifest.mjs';

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
