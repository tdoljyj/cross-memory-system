import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { until } from '../../../../scripts/ci/test-clock-guard.mjs';
import { serviceLoop } from '../../src/service-main.mjs';
import { LINUX_SCRIPTS, prepareInstall, sourceHashOf } from '../fleet/install.mjs';
import { acceptanceOf, REQUEST_CONTRACT } from '../fleet/publish.mjs';
import { buildUniversal } from '../fleet/universal.mjs';
import { CHECKOUT, RES, fixtureRepo, fleetFacts, git, nodeSite, sha, tempDir } from '../fleet/test/fleet-fixtures.mjs';
import { fetchFleetReleaseAsset } from '../fleet/fetch.mjs';
import { readTar } from '../fleet/tar.mjs';
import { Upgrader } from '../../upgrader/src/upgrader-main.mjs';
import { FakeDoor, FakeLinux, FakeResident, FakeWindows, fakeClock, installGeneration1, testConfig } from '../../upgrader/test/fixtures.mjs';
import { renewalWatch } from '../../src/connection-renewal.mjs';
import { versionNotices } from '../../src/status.mjs';

const repository = 'tdoljyj/cross-memory-system';
const now = Date.parse('2026-11-25T08:00:00Z');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exec = promisify(execFile);

async function release(t, fleet, repo, commit, version) {
  const out = path.join(await tempDir(t, 'dpkg'), 'out');
  const built = await buildUniversal({ repo, commit, version, out });
  const { source } = await read(built.release);
  const request = { contract: REQUEST_CONTRACT, repository, version, commit, archive_sha256: source.archive_sha256,
    firstInstallKitSha256: 'd'.repeat(64), fleetRefs: { ...fleet, ownerAuthorizationRef: randomUUID(),
      publisherQualificationRef: randomUUID(), ownerPackageAcceptanceRef: randomUUID() } };
  const grant = { decision: randomUUID(), receipt: randomUUID(), acceptedAt: '2026-11-01T00:00:00.000Z' };
  request.ciSourceManifestSha256 = (await sourceHashOf({ artifactPath: built.tar, artifactSha256: source.archive_sha256,
    acceptance: acceptanceOf(request, grant) })).ciSourceManifestSha256;
  const requestBytes = json(request);
  const target = { repository, version, archive_sha256: source.archive_sha256, request_sha256: sha(requestBytes),
    grant_id: grant.decision, receipt_id: grant.receipt, accepted_at: grant.acceptedAt };
  const tag = `fleet-node-${version}`;
  const assets = new Map([[`${tag}.tar`, await fs.readFile(built.tar)], [`${tag}.acceptance-request.json`, requestBytes],
    ['SHA256SUMS', Buffer.from(`${target.archive_sha256}  ${tag}.tar\n`)]]);
  const server = http.createServer((req, res) => {
    const prefix = `/${repository}/releases/download/${tag}/`;
    const bytes = req.url?.startsWith(prefix) && assets.get(decodeURIComponent(req.url.slice(prefix.length)));
    if (!bytes || req.headers.authorization) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { target, request, assets, tag, tar: built.tar, url: `http://127.0.0.1:${server.address().port}` };
}

// Import the lanes when present so the same test on the original resident verifies the observed generation.
const lanes = () => import('../../src/fleet-self-pull.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/src/fleet-self-pull.mjs')) return {};
  throw error;
});

async function brokerFixture(t) {
  const out = path.join(await tempDir(t, 'd2broker'), 'broker-fixture.exe');
  const v2 = path.join(CHECKOUT, 'work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2', 'windows');
  const files = ['SwapBroker.cs', 'ResidentServiceHost.cs', 'BrokerPureTests.cs'].map(name => path.join(RES, 'windows', name));
  const sourceV2 = ['ResidentScmV2.cs', 'ScmPidHandshakeV2.cs', 'NodeProfileV2.cs'].map(name => path.join(v2, name));
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await exec(csc, ['/nologo', '/noconfig', '/target:exe', '/main:BrokerPureTests', '/r:System.dll', '/r:System.Core.dll',
    '/r:System.ServiceProcess.dll', '/r:System.Web.Extensions.dll', `/out:${out}`, ...files, ...sourceV2], { windowsHide: true });
  return out;
}

test('T1：Broker 解析层拒绝旧式自拉请求形状', { skip: process.platform !== 'win32' }, async t => {
  const broker = await brokerFixture(t);
  const legacy = { kind: 'fleet-pull', grantId: randomUUID(), requestSha256: '1'.repeat(64),
    sourceSha256: '2'.repeat(64), packageManifestSha256: '3'.repeat(64), fromGeneration: 1,
    packageDirectory: 'unused-fixture-directory' };
  const { stdout } = await exec(broker, ['--fleet-request-shape-fixture', JSON.stringify(legacy)], { windowsHide: true });
  assert.equal(stdout.trim(), 'FLEET_BROKER_REQUEST_REFUSED');
  t.diagnostic(stdout.trim());
});

async function fixtureLanes({ node, release, broker, onDuty = false, peers = [], failVerify = false,
  runBroker = args => exec(broker, args, { windowsHide: true }), upload, clockNow = () => now }) {
  const { companionSelfPull, residentSelfPull } = await lanes();
  if (!residentSelfPull) return null;
  const root = node.root;
  for (const parts of [['state'], ['broker', 'requests'], ['broker', 'responses'], ['upgrade', 'inbox']])
    await fs.mkdir(path.join(root, ...parts), { recursive: true });
  const observed = path.join(root, 'broker', 'renew-ci.json');
  const probe = async (fleetTarget = release.target, { active = onDuty, otherSources = peers } = {}) =>
    fs.writeFile(observed, json({ at: new Date(clockNow()).toISOString(), code: null, onDuty: active,
      fleetTarget: fleetTarget && { ...fleetTarget, other_sources: otherSources } }));
  const clock = fakeClock(clockNow());
  const resident = new FakeResident(clock);
  const windows = new FakeWindows(root, resident, { failVerify: generation => failVerify && generation > 1 });
  const up = await new Upgrader({ root, clock: clock.fn,
    config: testConfig(root, { node: node.profile.nodeName, nodeProfileSha256: node.pkg.manifest.nodeProfileSha256, ownerSid: node.profile.ownerSid }),
    ports: { resident, windows, linux: new FakeLinux(root, clock), door: new FakeDoor(clock, { approveAt: 0 }) } }).open();
  const uploaded = [];
  const download = options => fetchFleetReleaseAsset({ ...options, releaseBase: release.url, now: clockNow });
  const companion = companionSelfPull({ root, repository, clock: clockNow, download,
    upload: upload ?? (async ({ file }) => { const bytes = await fs.readFile(file); uploaded.push(bytes); release.assets.set(path.basename(file), bytes); }) });
  const answers = [];
  const residentLane = residentSelfPull({ root, repository, clock: clockNow });
  const posted = [];
  const submitted = [];
  let step;
  return { probe, companion, uploaded, posted, submitted, up, clock, answers, fakeResident: resident,
    state: () => read(path.join(root, 'state', 'fleet-pull.json')),
    resident: { tick: idle => { step = residentLane.tick(idle); }, stop: () => residentLane.stop() },
    async tick({ downloadAssets = true } = {}) {
      await step;
      if (downloadAssets) await companion();
      for (const file of await fs.readdir(path.join(root, 'broker', 'requests'))) {
        const id = path.basename(file, '.json');
        if (await fs.access(path.join(root, 'broker', 'responses', file)).then(() => true, () => false)) continue;
        submitted.push(id);
        assert.deepEqual(Object.keys(await read(path.join(root, 'broker', 'requests', file))).sort(), ['grantId', 'kind']);
        const { stdout } = await runBroker(['--fleet-pull-fixture', root, id, node.profile.nodeName, process.execPath,
          new Date(clock.now).toISOString()]);
        const answer = JSON.parse(stdout.trim());
        answers.push(answer);
        if (answer.delivered && answer.ok) posted.push(id);
        await fs.writeFile(path.join(root, 'broker', 'responses', file), stdout);
      }
      clock.advance(Math.max(await up.tick(), 1000));
    },
  };
}

test('场景 1：登记目标后，无人发命令，待命节点升到目标 Source，代次加一', { skip: process.platform !== 'win32' }, async t => {
  const fleet = fleetFacts();
  const { repo, commit } = await fixtureRepo(t);
  const node = await nodeSite(t, 'a', fleet, { now });
  const targetRelease = await release(t, fleet, repo, commit, '2026.11.25-d2');
  const current = path.join(node.root, 'upgrade', 'current.json');
  const before = await read(current);
  assert.equal(before.generation, 1);
  assert.notEqual(before.ciSourceManifestSha256, targetRelease.request.ciSourceManifestSha256);

  // The service ticks with an empty queue. The fake gate advertises a target after the service starts.
  let ticks = 0;
  const broker = await brokerFixture(t);
  const automatic = (await lanes()).residentSelfPull ? await fixtureLanes({ node, release: targetRelease, broker }) : null;
  await applyFixtureAcl(t, node.root);
  await serviceLoop({
    exec: { tick: async () => { ticks += 1; return { state: 'IDLE' }; } }, lock: { touch: async () => {} },
    stopRequested: async () => ticks >= 8 || automatic?.up.recent.some(row => row.outcome === 'SUCCEEDED'),
    acknowledgeStop: async () => {}, onLoopException: error => { throw error; },
    betweenBatches: async () => {}, selfPull: automatic?.resident,
    sleep: async () => { if (ticks === 1) await automatic?.probe(); await automatic?.tick(); },
  });
  const after = await read(current);
  assert.deepEqual([after.generation, after.ciSourceManifestSha256, after.linux.ciSourceManifestSha256],
    [before.generation + 1, targetRelease.request.ciSourceManifestSha256, targetRelease.request.ciSourceManifestSha256],
    '目标获批后，节点应自动切换两侧 Source 并增加代次');
  assert.equal(automatic.posted.length, 1);
  assert.deepEqual(automatic.uploaded, [json(acceptanceOf(targetRelease.request,
    { decision: targetRelease.target.grant_id, receipt: targetRelease.target.receipt_id, acceptedAt: '2026-11-01T00:00:00Z' }))]);
  t.diagnostic(`第 ${before.generation} 代 → 第 ${after.generation} 代，两侧 Source ${after.ciSourceManifestSha256}，请求 ${automatic.posted.length} 条`);
  const processed = path.join(node.root, 'upgrade', 'inbox-archive', 'processed');
  const [requestFile] = await fs.readdir(processed);
  const { packageDirectory } = await read(path.join(processed, requestFile));
  const { stdout } = await exec(broker, ['--fleet-package-acl-fixture', node.root, packageDirectory, residentSid, companionSid],
    { windowsHide: true });
  t.diagnostic(`T2：${stdout.trim()}`);
  const archive = readTar(await fs.readFile(targetRelease.tar));
  const brokerEntry = archive.find(entry => entry.path === 'tree/work/independent-ci-resident-v1/windows/SwapBroker.cs');
  const staged = path.join(node.root, 'upgrade', 'staged', after.packageManifestSha256);
  const manifest = await read(path.join(staged, 'package-manifest.json'));
  const brokerSlot = manifest.files.find(file => file.target === 'bin\\SwapBroker.cs');
  const stagedBroker = path.join(staged, brokerSlot.path);
  assert.equal(sha(await fs.readFile(stagedBroker)), sha(brokerEntry.data));
  t.diagnostic('T3：升级暂存包的 Broker 源码哈希与已接受 tar 一致。');

  const duplicate = randomUUID();
  const runParent = path.join(node.root, 'broker', 'fleet-pull');
  const runs = await fs.readdir(runParent);
  await fs.writeFile(path.join(node.root, 'broker', 'requests', duplicate + '.json'),
    json({ kind: 'fleet-pull', grantId: targetRelease.target.grant_id }));
  const repeated = JSON.parse((await exec(broker, ['--fleet-pull-fixture', node.root, duplicate, node.profile.nodeName,
    process.execPath, new Date(now).toISOString()], { windowsHide: true })).stdout);
  assert.equal(repeated.delivered, true);
  assert.equal(repeated.code, 'FLEET_TARGET_ALREADY_REQUESTED');
  assert.deepEqual(await fs.readdir(runParent), runs, '已投递的目标不能再次创建组装目录');
  assert.deepEqual(await fs.readdir(path.join(node.root, 'upgrade', 'inbox')), []);
});

const source = release => release.request.ciSourceManifestSha256;
const accepted = release => acceptanceOf(release.request,
  { decision: release.target.grant_id, receipt: release.target.receipt_id, acceptedAt: '2026-11-01T00:00:00Z' });
const current = node => read(path.join(node.root, 'upgrade', 'current.json'));
const residentSid = 'S-1-5-80-1873410639-838332518-375536672-3951882173-2447812046'; // fixture principal with the Windows service SID shape
const companionSid = 'S-1-5-21-1-2-3-2001';

async function applyFixtureAcl(t, root) {
  const script = path.join(await tempDir(t, 'd2acl'), 'shape.ps1');
  await fs.writeFile(script, String.raw`param($FixtureRoot,$Installer,$Resident)
$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$null,[ref]$null)
$definition=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-AclPlan'},$false)
. ([scriptblock]::Create($definition.Extent.Text))
$OwnerSid='S-1-5-21-1-2-3-2001'
$OperatorSid='S-1-5-21-1-2-3-3001'
$ControllerSid='S-1-5-21-1-2-3-4001'
$mine=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$plan=Get-AclPlan $Resident
foreach ($part in @('work','bundles','broker','broker\requests','upgrade','upgrade\inbox','install')) {
  $dir=Join-Path $FixtureRoot $part
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  $acl=Get-Acl -LiteralPath $dir
  $acl.SetSecurityDescriptorSddlForm($plan[$part]+"(A;OICI;FA;;;$mine)",[Security.AccessControl.AccessControlSections]::Access)
  Set-Acl -LiteralPath $dir -AclObject $acl
}
`);
  const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await exec(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, root,
    path.join(RES, 'windows', 'install-resident.ps1'), residentSid], { windowsHide: true,
    env: { ...process.env, PSModulePath: path.join(path.dirname(ps), 'Modules') } });
}

async function checkFixtureAcl(t, broker) {
  const root = await tempDir(t, 'd2acl-check');
  await applyFixtureAcl(t, root);
  const answer = await exec(broker, ['--fleet-acl-fixture', root, residentSid, companionSid], { windowsHide: true });
  assert.match(answer.stdout, /D2 ACL: 5 AuthzAccessCheck cases/);
  t.diagnostic('Windows AuthzAccessCheck 验证夹具 DACL，companion 无权写 broker 或升级 inbox。');
}

async function drive(lane, ticks = 5) {
  for (let i = 0; i < ticks; i++) { lane.resident.tick({ queueEmpty: true }); await lane.tick(); }
}

async function refreshLinuxFacts(node) {
  const live = await current(node);
  const dir = path.join(node.root, 'upgrade', 'mailbox', 'responses');
  const facts = await read(path.join(dir, 'version-facts.json'));
  const roles = await read(path.join(dir, 'roles-public.json'));
  const at = new Date(now).toISOString();
  await fs.writeFile(path.join(dir, 'version-facts.json'), json({ ...facts, ...live.linux, observedAt: at }));
  await fs.writeFile(path.join(dir, 'roles-public.json'), json({ ...roles, generation: live.linux.generation, factsObservedAt: at, observedAt: at }));
}

// The installer assembles its actual package. The privileged launcher and its Linux operations
// are replaced by filesystem fixture ports, just as SCM and Linux are for the in-place upgrader.
async function reinstallFixture(node, target) {
  const work = path.join(node.dir, 'reinstall');
  const python = (script, args) => {
    const option = key => args[args.indexOf(key) + 1];
    let body;
    switch (path.basename(script)) {
      case 'rehearse.py': body = { status: 'REHEARSAL_PASS', report: path.join(work, 'fixture-rehearsal.json') }; break;
      case 'prep.py': {
        const dir = path.join(work, 'linux');
        mkdirSync(dir, { recursive: true });
        const names = Object.values(LINUX_SCRIPTS);
        const paths = Object.fromEntries(names.map(name => [name, path.join(dir, name)]));
        const content = Buffer.from('# fixture Linux port\n');
        for (const file of Object.values(paths)) writeFileSync(file, content);
        body = { paths, scripts: Object.fromEntries(names.map(name => [name, sha(content)])) };
        break;
      }
      case 'pause-old-resident.py': {
        const cfg = JSON.parse(readFileSync(args[0], 'utf8'));
        const bytes = json({ source: { reason: cfg.launcher.w1PauseReason } });
        writeFileSync(path.join(node.root, 'state', 'PAUSED.json'), bytes);
        body = { status: 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH', pausedSha256: sha(bytes) };
        break;
      }
      case 'generate.py':
        if (!args.includes('--check')) writeFileSync(option('--out'), '# fixture launcher\n');
        body = { status: 'OK' }; break;
      default: throw new Error(`unexpected installer port ${script}`);
    }
    return { status: 0, stdout: JSON.stringify(body), stderr: '' };
  };
  const prepared = await prepareInstall({ artifactPath: target.tar, artifactSha256: target.target.archive_sha256,
    acceptance: accepted(target), root: node.root, workDir: work, now, python,
    scm: () => ({ sddl: 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)' }) });
  assert.equal(prepared.status, 'FLEET_NODE_INSTALL_PREPARED');
  const plan = await read(prepared.installPlan);
  assert.equal(plan.ciSourceManifestSha256, source(target));
  const manifest = await read(path.join(plan.packageDir, 'package-manifest.json'));
  const files = new Map(await Promise.all(manifest.files.map(async f => [f.path, await fs.readFile(path.join(plan.packageDir, ...f.path.split('/')))])));
  const reinstalled = path.join(node.dir, 'reinstalled');
  await installGeneration1(reinstalled, { manifest, files, sha: plan.packageManifestSha256, residentSha: manifest.residentManifestSha256,
    ciSource: manifest.ciSourceManifestSha256, policySha: sha(files.get('config/policy.json')), linuxSha: manifest.linux.manifestSha256 },
  { at: now, upgraderManifest: manifest.upgrader.manifestSha256, nodeProfile: manifest.nodeProfileSha256, nodeIdentity: manifest.nodeIdentitySha256 });
  const installed = await current({ root: reinstalled });
  assert.deepEqual([installed.ciSourceManifestSha256, installed.linux.ciSourceManifestSha256], [source(target), source(target)]);
}

test('节点自拉场景 2–6 与旧内容回切', { skip: process.platform !== 'win32' }, async t => {
  const fleet = fleetFacts();
  const { repo, commit } = await fixtureRepo(t);
  const broker = await brokerFixture(t);
  const olderContent = await release(t, fleet, repo, commit, '2026.11.25-aaa');
  const content = path.join(repo, 'work', 'independent-ci-resident-v1', 'src', 'fleet-self-pull.mjs');
  await fs.appendFile(content, '\n// Alternate fixture commit.\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'advance fixture content');
  const newerCommit = git(repo, 'rev-parse', 'HEAD').toString().trim();
  const target = await release(t, fleet, repo, newerCommit, '2026.11.25-zzz');
  olderContent.target.accepted_at = '2026-11-02T00:00:00.000Z';

  await t.test('T4：组装期间 Broker 中断，重启答未投递，常驻换编号且只投递一次', async t => {
    const node = await nodeSite(t, 'i', fleet, { now });
    const childScript = path.join(await tempDir(t, 'd2interrupted'), 'pause.mjs');
    await fs.writeFile(childScript, `import fs from 'node:fs';
      import path from 'node:path';
      for await (const chunk of process.stdin) {}
      fs.writeFileSync(path.join(process.argv.at(-1), 'fixture-started'), '');
      setInterval(() => {}, 1000);
    `);
    const runParent = path.join(node.root, 'broker', 'fleet-pull');
    let time = now;
    let interruptedRun;
    const lane = await fixtureLanes({ node, release: target, broker, clockNow: () => time, runBroker: async args => {
      if (!interruptedRun) {
        const running = exec(broker, [...args, childScript], { windowsHide: true });
        let exited = false;
        const outcome = running.catch(error => error);
        outcome.then(() => { exited = true; });
        try {
          interruptedRun = await until(async () => {
            assert.equal(exited, false, 'Broker 须保持运行至测试触发中断');
            const runs = await fs.readdir(runParent).catch(() => []);
            for (const run of runs) {
              if (await fs.stat(path.join(runParent, run, 'fixture-started')).then(() => true, () => false)) return run;
            }
            return null;
          }, '组装子进程写入夹具标记');
        } finally { running.child.kill(); }
        assert.ok((await outcome) instanceof Error);
      }
      return exec(broker, args, { windowsHide: true });
    } });
    await lane.probe();
    await drive(lane, 3);
    assert.equal(lane.answers[0].delivered, false);
    assert.equal(lane.answers[0].code, 'BROKER_REQUEST_INTERRUPTED_NOT_REPEATED');
    assert.equal((await lane.state()).phase, 'PREPARE_FAILED');
    assert.deepEqual(await fs.readdir(path.join(node.root, 'upgrade', 'inbox')), []);
    time += 61_000;
    await lane.probe();
    await drive(lane, 6);
    assert.ok(lane.answers[1]?.delivered, JSON.stringify(lane.answers));
    assert.equal(lane.submitted.length, 2);
    assert.notEqual(lane.submitted[0], lane.submitted[1]);
    assert.equal(lane.posted.length, 1);
    assert.equal((await fs.readdir(path.join(node.root, 'upgrade', 'inbox-archive', 'processed'))).length, 1);
    assert.equal((await fs.readdir(runParent)).includes(interruptedRun), false);
    t.diagnostic('Broker 重启答 delivered:false，常驻以新编号重投，升级服务只处理一个请求。');
  });

  await t.test('场景 2：Release 文件不授予升级权，坏哈希在运行包内代码之前被拒', async t => {
    await checkFixtureAcl(t, broker);
    const node = await nodeSite(t, 'b', fleet, { now });
    const lane = await fixtureLanes({ node, release: target, broker });
    target.assets.set(`${target.tag}.acceptance.json`, json(accepted(target)));
    await lane.probe(null);
    await drive(lane, 2);
    assert.equal(lane.posted.length, 0);
    await lane.probe();
    lane.resident.tick({ queueEmpty: true });
    await lane.tick(); // Valid bytes and a ready marker from the companion.
    assert.equal(lane.uploaded.length, 0, 'Release 已有接受文件时不上传');
    const tar = path.join(node.root, 'bundles', 'fleet-pull', target.target.request_sha256, `${target.tag}.tar`);
    await fs.appendFile(tar, Buffer.alloc(512)); // A valid ustar with a different digest.
    lane.resident.tick({ queueEmpty: true });
    await lane.tick({ downloadAssets: false });
    await drive(lane, 1);
    assert.equal(lane.answers[0].status, null, '哈希不符的包未进入组装入口');
    assert.equal((await lane.state()).code, 'FLEET_ARCHIVE_SHA_MISMATCH');
    assert.equal(lane.posted.length, 0);
    assert.deepEqual(await fs.readdir(path.join(node.root, 'upgrade', 'inbox')), []);
    t.diagnostic('哈希不符，包内代码运行 0 次，升级 inbox 为空。');
  });

  await t.test('场景 3：当班等到待命报告目标 Source 才投递，旧内容用新版本号', async t => {
    const a = await nodeSite(t, 'c', fleet, { now });
    const b = await nodeSite(t, 'd', fleet, { now });
    const active = await fixtureLanes({ node: a, release: target, broker, onDuty: true, peers: [b.pkg.ciSource] });
    const standby = await fixtureLanes({ node: b, release: target, broker });
    await active.probe(); await standby.probe();
    await drive(active, 3);
    assert.equal((await active.state()).phase, 'WAITING_FOR_PEERS');
    assert.equal(active.posted.length, 0);
    await drive(standby, 12);
    assert.equal((await current(b)).ciSourceManifestSha256, source(target));
    assert.ok(standby.up.recent.some(row => row.outcome === 'SUCCEEDED'), JSON.stringify(standby.up.recent));
    assert.equal(active.posted.length, 0, '待命已升级，但还有待服务端报告');
    await active.probe(target.target, { active: true, otherSources: [(await current(b)).ciSourceManifestSha256] });
    await drive(active);
    assert.equal(active.posted.length, 1);
    assert.equal((await current(a)).ciSourceManifestSha256, source(target));
    // The later approval has a lexicographically smaller but previously unused version.
    assert.ok(olderContent.target.version < target.target.version);
    assert.notEqual(source(olderContent), source(target));
    let failedUploads = 0;
    const back = await fixtureLanes({ node: b, release: olderContent, broker,
      upload: async () => { failedUploads++; throw new Error('fixture Release upload refused'); } });
    await refreshLinuxFacts(b);
    await back.probe(); await drive(back, 12);
    assert.equal(back.posted.length, 1, JSON.stringify({ state: await back.state(), answers: back.answers,
      upgrade: await read(path.join(b.root, 'upgrade', 'status.json')) }).slice(0, 2000));
    assert.equal(failedUploads, 1);
    assert.deepEqual([(await current(b)).generation, (await current(b)).ciSourceManifestSha256], [3, source(olderContent)]);
  });

  await t.test('场景 4：核验失败回滚并保持暂停，当班继续，重启也不重投', async t => {
    const a = await nodeSite(t, 'e', fleet, { now });
    const b = await nodeSite(t, 'f', fleet, { now });
    const active = await fixtureLanes({ node: a, release: target, broker, onDuty: true, peers: [b.pkg.ciSource] });
    const standby = await fixtureLanes({ node: b, release: target, broker, failVerify: true });
    await active.probe(); await standby.probe();
    await drive(standby, 8); await drive(active);
    assert.equal((await current(b)).ciSourceManifestSha256, b.pkg.ciSource);
    assert.equal((await current(b)).linux.ciSourceManifestSha256, b.pkg.ciSource);
    assert.equal((await standby.fakeResident.status()).executorState, 'PAUSED');
    assert.equal((await active.fakeResident.status()).executorState, 'IDLE');
    assert.equal(active.posted.length, 0);
    const status = await read(path.join(b.root, 'upgrade', 'status.json'));
    const notices = versionNotices({}, status).filter(n => n.kind === 'upgrade-rolled-back');
    assert.equal(notices.length, 1);
    const restart = await fixtureLanes({ node: b, release: target, broker });
    await restart.probe(); await drive(restart, 2);
    assert.equal((await fs.readdir(path.join(b.root, 'upgrade', 'inbox-archive', 'processed'))).length, 1);
    assert.equal(restart.posted.length, 0);
  });

  await t.test('场景 5：冻结通道变化只报一次需重装，现有重装入口准备同一 Source', async t => {
    const node = await nodeSite(t, 'g', fleet, { now });
    await fs.appendFile(path.join(repo, 'work', 'independent-ci-resident-v1', 'upgrader', 'src', 'codes.mjs'), '\n// Frozen channel fixture.\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'change fixture frozen channel');
    const frozen = await release(t, fleet, repo, git(repo, 'rev-parse', 'HEAD').toString().trim(), '2026.11.25-frozen');
    const lane = await fixtureLanes({ node, release: frozen, broker });
    await lane.probe(); await drive(lane);
    const first = await lane.state();
    assert.equal(first.phase, 'NEEDS_REINSTALL');
    assert.equal(first.code, 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL');
    await drive(lane, 2);
    assert.deepEqual(await lane.state(), first);
    assert.equal(versionNotices({ fleetPull: first }).filter(n => n.kind === 'fleet-pull-refused').length, 1);
    assert.equal(lane.posted.length, 0);
    await reinstallFixture(node, frozen);
  });

  await t.test('场景 6：无目标、下载无包、组装子进程失败均不阻断批次和续期', async t => {
    const node = await nodeSite(t, 'h', fleet, { now });
    let time = now;
    const childScript = path.join(await tempDir(t, 'd2failed'), 'failed.mjs');
    await fs.writeFile(childScript, 'for await (const chunk of process.stdin) {}\nprocess.exit(17);\n');
    const lane = await fixtureLanes({ node, release: olderContent, broker, clockNow: () => time,
      runBroker: args => exec(broker, [...args, childScript], { windowsHide: true }) });
    const saved = new Map(olderContent.assets);
    let batches = 0, renewals = 0;
    const renew = renewalWatch({ root: node.root, profile: node.profile, source: node.pkg.ciSource, clock: () => now, uptime: () => 0,
      mode: () => 'STANDBY', drained: async () => true, observe: async () => { renewals++; return null; } });
    try {
      await lane.probe(null);
      await serviceLoop({ exec: { tick: async () => ({ state: ++batches % 2 ? 'RUNNING' : 'IDLE' }) }, lock: { touch: async () => {} },
        stopRequested: async () => batches === 8, acknowledgeStop: async () => {}, onLoopException: error => { throw error; },
        betweenBatches: async () => {}, selfPull: lane.resident,
        sleep: async () => {
          await renew(); await lane.tick();
          // 先等两条通道完成，再为下一拍修改探针或 Release。
          if (batches === 1) {
            assert.equal(await read(path.join(node.root, 'state', 'fleet-target.json')), null);
            olderContent.assets.clear();
            await lane.probe();
          }
          if (batches === 4) {
            // 第 2 拍尝试下载，第 4 拍才是常驻可报告下载失败的下一次空闲拍。
            assert.equal((await lane.state()).code, 'FLEET_REQUEST_MISSING');
            for (const [name, bytes] of saved) olderContent.assets.set(name, bytes);
            time += 60_000;
            await lane.probe();
          }
        } });
      assert.equal(batches, 8);
      assert.equal(renewals, 8);
      assert.equal(lane.answers[0].code, 'FLEET_UPGRADE_CHILD_FAILED');
      assert.equal((await lane.state()).code, 'FLEET_UPGRADE_CHILD_FAILED');
      assert.equal(lane.posted.length, 0);
    } finally { for (const [name, bytes] of saved) olderContent.assets.set(name, bytes); }
  });
});
