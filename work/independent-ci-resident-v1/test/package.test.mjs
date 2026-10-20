import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../tools/build-package.mjs';
import { installedIntegrity } from '../src/service-ports.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { sha256 } from '../src/canonical.mjs';
import { tempRoot } from './helpers.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('the install package is assembled create-only, pins every file and binds policy to both manifests', async t => {
  const root = await tempRoot(t);
  const node = path.join(root, 'node.exe');
  await fs.writeFile(node, 'not really node');
  const src = path.join(root, 'v2');
  await fs.mkdir(path.join(src, 'a'), { recursive: true });
  await fs.writeFile(path.join(src, 'a', 'derive-batch.mjs'), 'export {};\n');
  const out = path.join(root, 'pkg');
  const helpers = path.join(root, 'helpers');
  await fs.mkdir(helpers);
  await fs.writeFile(path.join(helpers, 'controller-formal-stage-01-v2.exe'), 'MZ helper');
  const pins = [{ installedPath: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node', sha256: 'c'.repeat(64) }];
  const r = await buildPackage({ out, policyFile: path.join(HERE, 'config', 'policy.example.json'), companionFile: path.join(HERE, 'config', 'companion.example.json'), nodeExe: node, sourceRoot: src, sourceFiles: ['a/derive-batch.mjs'], helpersDir: helpers, linuxExternalPins: pins });
  const allow = JSON.parse(await fs.readFile(path.join(out, 'config', 'helpers-allow-list.json'), 'utf8'));
  assert.equal(allow.helpers[0].sha256, sha256(Buffer.from('MZ helper')));
  const linux = JSON.parse(await fs.readFile(path.join(out, 'linux', 'manifest.json'), 'utf8'));
  assert.ok(linux.files.every(f => f.installedPath.startsWith('/')), 'Linux pins name installed paths');
  assert.ok(linux.files.some(f => f.installedPath === '/etc/systemd/system/clued-ci-worker@.service'));
  assert.ok(linux.files.some(f => f.installedPath.endsWith('/node')), 'external entry points are pinned too');
  assert.equal(r.packageManifestSha256, sha256(await fs.readFile(path.join(out, 'package-manifest.json'))));
  const pkg = JSON.parse(await fs.readFile(path.join(out, 'package-manifest.json'), 'utf8'));
  const shape = /^(?:(?:resident|source)\\[0-9a-f]{64}(?:\\[A-Za-z0-9_.@-]+)+|(?:config|runtime|bin|helpers)\\[A-Za-z0-9_.@-]+)$/;
  for (const f of pkg.files) {
    assert.equal(sha256(await fs.readFile(path.join(out, f.path))), f.sha256, f.path);
    assert.match(f.target, shape, 'every target fits the install script allow-list');
  }
  assert.ok(pkg.files.some(f => f.target.endsWith('\\windows\\rearm-resident.ps1')), 'elevated scripts are installed into the admin-only copy');
  assert.ok(pkg.files.some(f => f.target === ['resident', r.residentManifestSha256, 'src', 'executor.mjs'].join('\\')));
  const policy = validatePolicy(JSON.parse(await fs.readFile(path.join(out, 'config', 'policy.json'), 'utf8')));
  assert.equal(policy.residentManifestSha256, r.residentManifestSha256);
  assert.equal(policy.sourceManifestSha256, r.sourceManifestSha256);
  const companion = JSON.parse(await fs.readFile(path.join(out, 'config', 'companion.json'), 'utf8'));
  assert.ok(companion.companion.relayScript.includes(r.sourceManifestSha256));
  // The service's own integrity check accepts exactly this layout.
  const integrity = await installedIntegrity({
    sourceRoot: path.join(out, 'source'), sourceManifest: path.join(out, 'config', 'source-installed-manifest.json'),
    residentRoot: path.join(out, 'resident'), residentManifest: path.join(out, 'config', 'resident-installed-manifest.json'),
  })();
  assert.deepEqual(integrity, { ok: true, sourceManifestSha256: r.sourceManifestSha256, residentManifestSha256: r.residentManifestSha256 });
  await assert.rejects(buildPackage({ out, policyFile: 'x', companionFile: 'y', nodeExe: node }), { code: 'EEXIST' });
});
