import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildInput } from '../../../../../scripts/ci/clued-fleet-accept.mjs';
import { firstInstallKitOf, installedFleetMaterial } from '../install.mjs';
import { DEFAULT_REPO, prepare } from '../publish.mjs';
import { writeTar } from '../tar.mjs';
import { buildUniversal } from '../universal.mjs';
import { fixtureRepo, fleetFacts, git, nodeSite, runFakeGh, sha, tempDir } from './fleet-fixtures.mjs';
export const fixtureId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = `project:${fixtureId(2)}`;
export async function releaseAssets(t, now, version = 'g000025', sourceFixture = null) {
  const repo = DEFAULT_REPO, tag = `fleet-node-${version}`;
  const acceptanceName = `${tag}.acceptance.json`, kitName = `${tag}.first-install-kit.json`;
  const d = await tempDir(t, 'fleet-release-');
  // 用候选工作树的通用包输入创建小型 Git 仓库，保留真实对象和附注标签。
  const sourceRepo = sourceFixture ?? await fixtureRepo(t);
  const { repo: source, commit } = sourceRepo;
  const build = await buildUniversal({ repo: source, commit, version, out: path.join(d, 'build') });
  const images = [], roleImages = {};
  for (const role of ['gitleaks', 'trivy', 'contract-placement']) {
    const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] },
      config: { Labels: { 'fixture.role': role } } }));
    const digest = sha(config), configName = `${digest}.json`;
    roleImages[role] = digest;
    const file = path.join(d, `role-image-${digest}.tar.gz`);
    await fs.writeFile(file, gzipSync(writeTar([
      { path: configName, data: config },
      { path: 'manifest.json', data: Buffer.from(JSON.stringify([{ Config: configName, RepoTags: [], Layers: [] }])) },
    ])));
    images.push(file);
  }
  const fleet = fleetFacts();
  const template = await nodeSite(t, 'a', fleet, { now, roleImages,
    recordOverrides: { scope, appId: 101, installationId: 102, repositoryId: 103, appKeyId: 104,
      ciPrincipalBindingId: fixtureId(11), ciPrincipalRoleRef: fixtureId(14) } });
  const index = path.join(d, 'index.md'), out = path.join(d, 'release'), state = path.join(d, 'github.json');
  await fs.writeFile(index, '| 版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练 |\n|---|---|---|---|---|---|---|\n');
  const timeline = [];
  let openQueued = false;
  const ghCommand = args => {
    if (args[0] === 'workflow') {
      assert.deepEqual(args.slice(-4), ['-f', `fleet_version=${version}`, '-f', `fleet_request_sha256=${prepared.requestSha256}`]);
      timeline.push('dispatch:open');
      assert.equal(openQueued, false);
      openQueued = true;
    }
    if (args[0] === 'release' && args[1] === 'upload' && path.basename(args[3]) === acceptanceName) timeline.push('upload:acceptance');
    return runFakeGh(args, { FAKE_GH_STATE: state }, { fs: fsSync, path, createHash });
  };
  const generationTags = {
    list: async () => ['fleet-node-2026.11.26-5444c2ac', 'fleet-node-g000023', 'fleet-node-g000024',
      ...git(source, 'tag', '--list').toString().trim().split('\n').filter(Boolean)],
    read: async name => JSON.parse(git(source, 'cat-file', 'tag', name).toString().split('\n\n').at(-1)),
    create: async claim => {
      git(source, '-c', 'tag.gpgSign=false', 'tag', '-a', claim.release_tag, commit, '-m', JSON.stringify(claim));
      return true;
    },
  };
  const kit = await firstInstallKitOf({ root: template.root, now });
  assert.equal(kit.record.scope, scope);
  const prepared = await prepare({ version, dir: path.dirname(build.tar), out, images, index, root: template.root, ghCommand, now,
    deps: { generationTags, kitOf: options => firstInstallKitOf({ ...options, now }), fleetMaterial: installedFleetMaterial } });
  assert.equal(prepared.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  const assets = () => JSON.parse(fsSync.readFileSync(state, 'utf8')).assets;
  const asset = name => {
    const match = assets().find(entry => entry.name === name);
    assert.ok(match, `Release asset: ${name}`);
    return Buffer.from(match.b64, 'base64');
  };
  assert.equal(sha(asset(`${tag}.tar`)), build.source.archive_sha256);
  assert.equal(sha(asset(kitName)), prepared.firstInstallKitSha256);
  const kitSums = asset(`${tag}.first-install.SHA256SUMS`).toString().split('\n');
  for (const file of images) {
    const name = path.basename(file), bytes = asset(name);
    assert.deepEqual(bytes, await fs.readFile(file));
    assert.ok(kitSums.includes(`${sha(bytes)}  ${name}`));
  }
  assert.match(asset('SHA256SUMS').toString(), new RegExp(`^${sha(asset(`${tag}.bootstrap.ps1`))}  ${tag}\\.bootstrap\\.ps1$`, 'm'));
  const publicKey = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const input = async (operation, { acceptanceSha256, requestSha256 = prepared.requestSha256, overrides = {} } = {}) => {
    const cwd = process.cwd();
    try {
      process.chdir(source);
      return await buildInput({
        GITHUB_REPOSITORY: repo, FLEET_VERSION: version, FLEET_REQUEST_SHA256: requestSha256,
        FLEET_OPERATION: operation, FLEET_DELIVERY_KEY: operation === 'open' ? undefined : publicKey,
        FLEET_ACCEPTANCE_SHA256: acceptanceSha256,
      }, { fetchImpl: async url => {
        const u = new URL(url);
        assert.equal(u.origin, 'https://github.com');
        assert.equal(path.posix.dirname(u.pathname), `/${repo}/releases/download/${tag}`);
        const name = decodeURIComponent(path.posix.basename(u.pathname));
        if (name === acceptanceName) timeline.push('read:acceptance');
        return new Response(overrides[name] ?? asset(name));
      } });
    } finally { process.chdir(cwd); }
  };
  return { version, tag, acceptanceName, sourceRepo, build, prepared, out, assets, asset, input, timeline, generationTags, ghCommand, index, template, fleet,
    takeOpen: () => { const queued = openQueued; openQueued = false; return queued; } };
}
