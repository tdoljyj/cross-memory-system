import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readArchive } from '../fleet/install.mjs';
import * as publish from '../fleet/publish.mjs';
import { writeTar } from '../fleet/tar.mjs';
import { MANIFEST_NAME, UNIVERSAL_CONTRACT } from '../fleet/universal.mjs';
import { parseVersions, readStatus, readVersionState, StatusBoard, StatusFile } from '../../src/status.mjs';
import { GENERATION_CURRENT_CONTRACT, LINUX_VERSION_FACTS_CONTRACT, VERSION_FACTS_FILE } from '../../src/upgrade-mailbox.mjs';
import { acceptanceOf, REQUEST_CONTRACT } from '../../src/fleet-acceptance.mjs';
import { buildStatus } from '../../upgrader/src/status.mjs';
import { Journal } from '../../upgrader/src/journal.mjs';
import { tempRoot } from '../../test/helpers.mjs';
import { BOOTSTRAP, FLEET, PREREQ, prepWorld } from '../fleet/test/publish-fixtures.mjs';
import { runFakeGh } from '../fleet/test/fleet-fixtures.mjs';
import { renderSummary } from '../../../../scripts/ci/clued-fleet-accept.mjs';

const now = Date.parse('2026-11-26T12:00:00Z');
const at = new Date(now).toISOString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = c => c.repeat(64);
const baselineTag = 'fleet-node-2026.11.26-5444c2ac';
const installedPackage = { packageGeneration: 23, version: 'g000023', releaseTag: 'fleet-node-g000023',
  commit: 'a'.repeat(40), archiveSha256: hash('b'), ciSourceManifestSha256: hash('c') };
const source = { version: installedPackage.version, release_tag: installedPackage.releaseTag,
  commit: installedPackage.commit, archive_sha256: installedPackage.archiveSha256 };

function tagStore() {
  const claims = new Map();
  return {
    list: async () => [baselineTag, 'fleet-node-drill-g999999', ...claims.keys()],
    read: async tag => claims.get(tag) ?? null,
    create: async claim => {
      await Promise.resolve();
      if (claims.has(claim.release_tag)) return false;
      claims.set(claim.release_tag, claim);
      return true;
    },
  };
}

test('正式发布从第 22 代接续，两名发布者竞争时只创建一个 tag', async () => {
  const tags = tagStore();
  const candidates = [{ ...source }, { ...source, commit: 'd'.repeat(40) }];
  assert.deepEqual(await Promise.all(candidates.map(() => publish.allocatePackageGeneration(tags))), ['g000023', 'g000023']);
  const results = await Promise.allSettled(candidates.map(s => publish.reservePackageGeneration(tags, s)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'PUBLISH_GENERATION_CONFLICT');
  assert.equal(await publish.allocatePackageGeneration(tags), 'g000024');
});

test('同一提交、同一 tar 可续跑，同号替换任一摘要会被拒绝', async () => {
  const tags = tagStore();
  assert.equal((await publish.reservePackageGeneration(tags, source)).already, false);
  assert.equal((await publish.reservePackageGeneration(tags, source)).already, true);
  for (const changed of [{ commit: 'd'.repeat(40) }, { archive_sha256: hash('e') }]) {
    await assert.rejects(publish.reservePackageGeneration(tags, { ...source, ...changed }), { code: 'PUBLISH_GENERATION_CONFLICT' });
  }
});

test('远端正式 tag 读不全、缺第 22 代迁移基准时拒绝分配', async () => {
  await assert.rejects(publish.allocatePackageGeneration({ list: async () => [baselineTag, 'fleet-node-g000024'] }),
    { code: 'PUBLISH_GENERATION_INVENTORY_REFUSED' });
  await assert.rejects(publish.allocatePackageGeneration({ list: async () => [] }),
    { code: 'PUBLISH_GENERATION_INVENTORY_REFUSED' });
});

test('正式发布入口只接收提交，构建一次，并用已占号的 tag 写发布和接受资产', async t => {
  const w = await prepWorld(t, { released: false, spawnGh: false });
  const tags = tagStore();
  let builds = 0;
  const ghCommand = args => runFakeGh(args, { FAKE_GH_STATE: w.state }, { fs: fsSync, path, createHash });
  const buildUniversal = async ({ commit, version, out }) => {
    builds++;
    assert.equal(version, source.version);
    assert.equal(commit, source.commit);
    const entries = [{ path: `${FLEET}bootstrap.ps1`, data: BOOTSTRAP }, { path: `${FLEET}prereq-manifest.json`, data: PREREQ }];
    const releaseTag = `fleet-node-${version}`;
    const manifest = { contract: UNIVERSAL_CONTRACT, version, releaseTag, commit, files: entries.map(e => ({
      path: e.path, bytes: e.data.length, sha256: sha(e.data),
    })) };
    const tar = writeTar([...entries, { path: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest)) }]);
    const release = { contract: 'clued.independent-ci.fleet-node-release/1',
      source: { version, release_tag: releaseTag, commit, archive_sha256: sha(tar), built_at: '2026-11-26T12:00:00.000Z' },
      archive: { name: `${releaseTag}.tar`, sha256: sha(tar), bytes: tar.length } };
    const metadata = Buffer.from(JSON.stringify(release));
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, release.archive.name), tar);
    await fs.writeFile(path.join(out, `${releaseTag}.release.json`), metadata);
    await fs.writeFile(path.join(out, 'SHA256SUMS'), `${sha(tar)}  ${release.archive.name}\n${sha(metadata)}  ${releaseTag}.release.json\n`);
  };
  const dir = path.join(w.d, 'generated');
  const args = ['prepare', '--commit', source.commit, '--dir', dir, '--out', w.out, '--image', w.image, '--index', w.index];
  const deps = { ...w.deps, generationTags: tags, buildUniversal, release: {
    admit: async () => {}, requirements: async () => [], read: async () => ({ snapshot: { base: true, applied: [], interfaces: {} } }),
  } };
  const entry = { prepareCommit: options => publish.prepareCommit({ ...options, ghCommand, deps }) };
  await assert.rejects(publish.main([...args, '--version', source.version], entry), { code: 'USAGE' });
  const prepared = await publish.main(args, entry);
  assert.equal((await publish.main(args, entry)).requestSha256, prepared.requestSha256);
  assert.equal(builds, 1);
  const release = (await publish.readBuild(dir)).release;
  const created = (await w.calls()).filter(c => c.args[0] === 'release' && c.args[1] === 'create');
  assert.equal(created.length, 1);
  assert.equal(created[0].args[2], source.release_tag);
  assert.ok(created[0].args.includes('--verify-tag'));
  assert.equal(created[0].args[created[0].args.indexOf('--title') + 1], '第 23 代通用节点包 · 2026-11-26-aaaaaaaa');
  const request = JSON.parse(await fs.readFile(prepared.request, 'utf8'));
  const answer = await publish.seal({ request: prepared.request, ghCommand, index: w.index, deps });
  assert.equal(answer.status, 'FLEET_ACCEPTANCE_SEALED');
  const acceptance = JSON.parse(await fs.readFile(path.join(w.out, `${source.release_tag}.acceptance.json`), 'utf8'));
  assert.equal(acceptance.version, release.source.version);
  assert.equal(acceptance.archive_sha256, release.source.archive_sha256);
  assert.equal(acceptance.commit, release.source.commit);
  assert.equal(acceptance.ciSourceManifestSha256, request.ciSourceManifestSha256);
  const resource = `fleet-node:${request.repository}/${request.version}/${request.archive_sha256}/${prepared.requestSha256}`;
  assert.match(renderSummary({ resources: [resource], request_sha256: prepared.requestSha256 }), /确认第 23 代通用节点包/);
});

test('安装入口只从同版本的已验 tar 和接受文件推导包身份', () => {
  const universal = { contract: UNIVERSAL_CONTRACT, version: source.version, releaseTag: source.release_tag, commit: source.commit, files: [] };
  const tar = writeTar([{ path: MANIFEST_NAME, data: Buffer.from(JSON.stringify(universal)) }]);
  const digest = sha(tar);
  const acceptance = { version: source.version, commit: source.commit, archive_sha256: digest,
    ciSourceManifestSha256: installedPackage.ciSourceManifestSha256 };
  assert.throws(() => readArchive(tar, digest, { ...acceptance, version: 'g000024' }), { code: 'FLEET_ARCHIVE_NOT_THE_ACCEPTED' });
  assert.deepEqual(readArchive(tar, digest, acceptance).installedPackage, { ...installedPackage, archiveSha256: digest });
});

async function installed(t, { legacy = false, local = 1, changedWindows = false, oldLinux = false } = {}) {
  const root = await tempRoot(t);
  const policy = { residentManifestSha256: hash('d'), ciSourceManifestSha256: installedPackage.ciSourceManifestSha256 };
  const packageManifestSha256 = hash('e'), policySha256 = hash('f'), installReceiptSha256 = hash('1');
  const stateCompat = { schema: 1, readableBySchemas: [1] };
  const linux = { generation: local, ciSourceManifestSha256: policy.ciSourceManifestSha256, manifestSha256: hash('2') };
  const current = { contract: GENERATION_CURRENT_CONTRACT, generation: local, ...policy, policySha256,
    packageManifestSha256: changedWindows ? hash('3') : packageManifestSha256, installReceiptSha256, stateCompat, linux, opId: null, at };
  const facts = { contract: LINUX_VERSION_FACTS_CONTRACT, ...linux, observedAt: at, sourceCommit: source.commit, roles: {},
    ciSourceManifestSha256: oldLinux ? hash('4') : linux.ciSourceManifestSha256, pinsOk: true, liveMatchesCurrent: true,
    upgradeToolSha256: hash('5'), staged: null };
  const write = async (file, value) => {
    const dest = path.join(root, file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, JSON.stringify(value));
  };
  await write('upgrade/current.json', current);
  await write(`upgrade/mailbox/responses/${VERSION_FACTS_FILE}`, facts);
  if (!legacy) {
    await write('config/installed-package.json', { installedPackage, packageManifestSha256, installReceiptSha256 });
  }
  if (changedWindows || oldLinux) {
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.writeFile(path.join(root, 'state', 'PACKAGE-VERSION.txt'), '第 23 代\r\n');
  }
  const { view } = await readVersionState({ root, policy, policySha256, clock: () => now });
  return { root, view, current, facts, policy, write, label: () => fs.readFile(path.join(root, 'state', 'PACKAGE-VERSION.txt'), 'utf8') };
}

test('旧包重装后的本机计数为 1，状态、自检及文本显示同一个第 23 代', async t => {
  const { root, view, label } = await installed(t);
  assert.equal(view.localInstallGeneration, 1);
  assert.deepEqual(parseVersions(view).installedPackage, { ...installedPackage, status: 'verified', display: '第 23 代', observedAt: at });
  assert.equal(view.selfcheck.installedPackage.status, 'verified');
  const status = new StatusBoard({ clock: () => now });
  status.setVersions(view);
  const file = path.join(root, 'state', 'status.json');
  await new StatusFile(file).write(status.snapshot());
  assert.equal((await readStatus(root)).versions.installedPackage.packageGeneration, 23);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(file, 'utf8')).versions, 'generation'), false);
  assert.deepEqual((await label()).trimEnd().split(/\r?\n/), [
    '第 23 代', `Tag: ${installedPackage.releaseTag}`, `Commit: ${installedPackage.commit}`, `Source: ${installedPackage.ciSourceManifestSha256}`,
  ]);
});

for (const [caseName, options] of [['当前 Windows 安装已换包', { changedWindows: true }], ['Linux 仍运行旧 Source', { oldLinux: true }]]) {
  test(`${caseName}时收回版本展示`, async t => {
    const { view, label } = await installed(t, options);
    assert.equal(view.installedPackage.packageGeneration, null);
    assert.equal(view.selfcheck.installedPackage.status, 'failed');
    assert.equal((await label()).trim(), '版本核验失败');
  });
}

test('旧包的本机计数 23 只显示为本机计数', async t => {
  const { view, label } = await installed(t, { legacy: true, local: 23 });
  assert.equal(view.localInstallGeneration, 23);
  assert.equal(view.installedPackage.packageGeneration, null);
  assert.equal(view.installedPackage.display, '未标注');
  assert.equal((await label()).trim(), '未标注');
});

test('Windows 安装回执与启动器回读使用同一已校验的包身份', { skip: process.platform !== 'win32' }, async t => {
  const root = await tempRoot(t);
  for (const dir of ['install', 'config', 'upgrade']) await fs.mkdir(path.join(root, dir));
  const ps = value => `'${String(value).replaceAll("'", "''")}'`;
  const installer = fileURLToPath(new URL('../../windows/install-resident.ps1', import.meta.url));
  const template = fileURLToPath(new URL('../../reinstall/launcher/template.ps1', import.meta.url));
  const identityB64 = Buffer.from(JSON.stringify(installedPackage)).toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2.0",
    "[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')",
    "$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer; $Strict8 = New-Object Text.UTF8Encoding($false,$true)",
    'function Load-Functions($file, $names) {',
    '  $tokens = $null; $parseErrors = $null',
    '  $a = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors)',
    '  if ($parseErrors.Count) { throw ($parseErrors.Message -join "; ") }',
    '  foreach ($name in $names) {',
    '    $fn = $a.Find({param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $name}, $true)',
    '    if ($null -eq $fn) { throw $name }; $fn.Extent.Text',
    '  }',
    '}',
    `Load-Functions ${ps(installer)} @('Write-New','Sha256File','Read-InstalledPackageIdentity','Write-ResidentInstallReceipt') | ForEach-Object { . ([scriptblock]::Create($_)) }`,
    `Load-Functions ${ps(template)} @('Parse-Json','Get-Key','Sha256Bytes','Read-FleetInstalledPackage') | ForEach-Object { . ([scriptblock]::Create($_)) }`,
    `$ResidentRoot = ${ps(root)}; $PackageManifestSha256 = ${ps(hash('e'))}; $FleetInstalledPackageB64 = ${ps(identityB64)}`,
    `$pkg = @{ ciSourceManifestSha256 = ${ps(installedPackage.ciSourceManifestSha256)}; linux = @{sourceV2 = @{commit = ${ps(source.commit)}}} }`,
    '$identity = Read-InstalledPackageIdentity $FleetInstalledPackageB64 $pkg',
    '$receipt = [ordered]@{ generation = 1; packageManifestSha256 = $PackageManifestSha256 }',
    '$digest = Write-ResidentInstallReceipt $ResidentRoot $receipt $identity $PackageManifestSha256',
    '$current = @{ packageManifestSha256 = $PackageManifestSha256; installReceiptSha256 = $digest; ciSourceManifestSha256 = $pkg.ciSourceManifestSha256 }',
    "[IO.File]::WriteAllText((Join-Path $ResidentRoot 'upgrade/current.json'),(ConvertTo-Json $current -Compress))",
    '$verified = Read-FleetInstalledPackage $digest; $current.packageManifestSha256 = (\'f\' * 64)',
    "[IO.File]::WriteAllText((Join-Path $ResidentRoot 'upgrade/current.json'),(ConvertTo-Json $current -Compress))",
    '@{ identity = $verified; changed = (Read-FleetInstalledPackage $digest) } | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n');
  const run = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { identity: installedPackage, changed: null });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'install', 'install-receipt.json'), 'utf8')).installedPackage, installedPackage);
});

for (const version of ['g000023', 'g000024']) {
  test('通用升级以同一操作、双端与接受证据显示 ' + version, async t => {
    const { root, current, facts, policy, write, label } = await installed(t, { legacy: true, local: 2 });
    const op = '92431111-1111-4111-8111-111111111111';
    const decision = '12341111-1111-4111-8111-111111111111', receipt = '12342222-2222-4222-8222-222222222222';
    const identity = { ...installedPackage, version, packageGeneration: Number(version.slice(1)), releaseTag: 'fleet-node-' + version };
    policy.repo = 'tdoljyj/cross-memory-system';
    policy.ownerAcceptance = { decisionRef: decision, installReceiptRef: receipt };
    const req = { contract: REQUEST_CONTRACT, version, commit: source.commit, repository: policy.repo,
      archive_sha256: source.archive_sha256, ciSourceManifestSha256: policy.ciSourceManifestSha256,
      firstInstallKitSha256: hash('6'), fleetRefs: { sourceAcceptanceRef: receipt, hostQualificationRef: receipt,
        ownerAuthorizationRef: decision, publisherQualificationRef: receipt, ownerPackageAcceptanceRef: receipt, formalRoles: {} } };
    const requestHash = sha(JSON.stringify(req));
    const acceptedAt = '2026-11-26T12:00:00Z';
    const target = { version, repository: policy.repo, archive_sha256: req.archive_sha256, grant_id: decision,
      receipt_id: receipt, request_sha256: requestHash, accepted_at: acceptedAt, other_sources: [] };
    if (version === 'g000023') {
      const dir = 'bundles/fleet-pull/' + requestHash + '/' + identity.releaseTag;
      await write(dir + '.acceptance-request.json', req);
      await write(dir + '.acceptance.json', acceptanceOf(req, { decision, receipt, acceptedAt }));
      await write('broker/renew-ci.json', { at, code: null, onDuty: false, fleetTarget: target });
    } else { policy.ownerAcceptance.installedPackage = identity; }
    current.policySha256 = sha(JSON.stringify(policy));
    const manifest = { contract: 'clued.independent-ci.resident-package/4', ...policy,
      files: [{ path: 'config/policy.json', target: 'config\\policy.json', sha256: current.policySha256 }],
      acceptance: { decisionRef: decision }, linux: { manifestSha256: facts.manifestSha256, sourceV2: { commit: source.commit } } };
    current.packageManifestSha256 = sha(JSON.stringify(manifest));
    const installedReceipt = { ...policy, contract: 'clued.independent-ci.resident-install-receipt/6', generation: 2,
      writtenBy: 'CluedCIUpgrader', upgrade: { opId: op, decisionRef: decision, grantId: receipt },
      policySha256: current.policySha256, packageManifestSha256: current.packageManifestSha256 };
    current.installReceiptSha256 = sha(JSON.stringify(installedReceipt));
    current.opId = op;
    await write('upgrade/current.json', current);
    await write('install/install-receipt.json', installedReceipt);
    await write('upgrade/staged/' + current.packageManifestSha256 + '/package-manifest.json', manifest);
    const plan = { contract: 'clued.independent-ci.resident-upgrade-plan/1', opId: op, fromGeneration: 1, toGeneration: 2,
      acceptanceDecisionRef: decision, packageManifestSha256: current.packageManifestSha256, target: { ...policy,
        policySha256: current.policySha256, linux: { manifestSha256: facts.manifestSha256, sourceCommit: source.commit } } };
    const dir = 'upgrade/ops/' + op;
    await write(dir + '/010-accept.plan.json', plan);
    const journal = Journal.open(path.join(root, 'upgrade', 'ops'), op, { clock: () => now });
    const terminal = await journal.terminal({ outcome: 'SUCCEEDED', generation: 2, grantId: receipt });
    const status = buildStatus({ clock: () => now, pid: 1, current, recent: [{ opId: op, outcome: terminal.outcome, code: null, at }] });
    await write('upgrade/status.json', status);
    const refresh = async (time = now) => (await readVersionState({ root, policy, policySha256: current.policySha256, clock: () => time })).view;
    const view = await refresh(), board = new StatusBoard();
    board.setVersions(view);
    await new StatusFile(path.join(root, 'state', 'status.json')).write(board.snapshot());
    assert.equal((await readStatus(root)).versions.installedPackage.packageGeneration, identity.packageGeneration);
    assert.equal((await label()).split('\r\n')[0], '第 ' + identity.packageGeneration + ' 代');
    await write('config/installed-package.json', { installedPackage, packageManifestSha256: hash('0'), installReceiptSha256: hash('1') });
    assert.equal((await refresh()).installedPackage.packageGeneration, identity.packageGeneration);
    const realOpen = fs.open.bind(fs);
    let reads = 0;
    const open = t.mock.method(fs, 'open', async (file, ...args) => {
      if (file === path.join(root, 'upgrade', 'current.json') && ++reads === 2) {
        await write('upgrade/current.json', { ...current, installReceiptSha256: hash('7') });
      }
      return realOpen(file, ...args);
    });
    try { assert.equal((await refresh()).installedPackage.packageGeneration, null); }
    finally { open.mock.restore(); await write('upgrade/current.json', current); }
    assert.equal(reads, 2);
    assert.equal((await refresh(now + 20 * 60_000)).installedPackage.packageGeneration, null);
    await write('upgrade/status.json', { ...status, op: { opId: op, state: 'WAITING_GRANT' } });
    assert.equal((await refresh()).installedPackage.packageGeneration, null);
    await write('upgrade/status.json', status);
    for (const outcome of ['WAITING_GRANT', 'ROLLED_BACK_PAUSED']) {
      await write(dir + '/900-terminal.json', { ...terminal, outcome });
      assert.equal((await refresh()).installedPackage.packageGeneration, null);
    }
    await write(dir + '/900-terminal.json', terminal);
    await write(dir + '/010-accept.plan.json', { ...plan, packageManifestSha256: hash('0') });
    assert.equal((await refresh()).installedPackage.packageGeneration, null);
  });
}
