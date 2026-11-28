import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { until } from '../../../../scripts/ci/test-clock-guard.mjs';
import { acceptanceBytes } from '../../src/fleet-acceptance.mjs';
import { serviceLoop } from '../../src/service-main.mjs';
import { LINUX_SCRIPTS, prepareInstall, sourceHashOf } from '../fleet/install.mjs';
import { acceptanceOf, REQUEST_CONTRACT } from '../fleet/publish.mjs';
import { buildUniversal } from '../fleet/universal.mjs';
import { CHECKOUT, RES, fixtureRepo, fleetFacts, git, nodeSite, sha, tempDir } from '../fleet/test/fleet-fixtures.mjs';
import { fetchFleetReleaseAsset, sha256File, transportAssetNames } from '../fleet/fetch.mjs';
import { stageTransport } from '../fleet/transport-assets.mjs';
import { readTar } from '../fleet/tar.mjs';
import { Upgrader } from '../../upgrader/src/upgrader-main.mjs';
import { FakeDoor, FakeLinux, FakeResident, FakeWindows, fakeClock, installGeneration1, testConfig } from '../../upgrader/test/fixtures.mjs';
import { renewalWatch } from '../../src/connection-renewal.mjs';
import { parseVersions, readVersionState, versionNotices } from '../../src/status.mjs';

const repository = 'tdoljyj/cross-memory-system';
const now = Date.parse('2026-11-25T08:00:00Z');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exec = promisify(execFile);

test('第 25 代已批准待封存时，companion 不下载或补传接受文件', async t => {
  const { companionSelfPull } = await lanes();
  const root = await tempDir(t, 'fleet-pending-seal');
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const at = new Date(now).toISOString();
  const target = { repository, version: 'g000025', archive_sha256: 'a'.repeat(64), request_sha256: 'b'.repeat(64),
    grant_id: randomUUID(), receipt_id: randomUUID(), accepted_at: at, other_sources: [] };
  await fs.writeFile(path.join(root, 'state', 'fleet-target.json'), json({ at, code: null, onDuty: false, fleetTarget: target }));
  const calls = [];
  await companionSelfPull({ root, repository, clock: () => now,
    download: async arg => { calls.push(arg.name); return false; }, upload: async arg => { calls.push(arg.tag); } })();
  assert.deepEqual(calls, []);
});

test('自拉重启后用已验上一代走增量，坏运输资产和坏完整 tar 不触发组装', async t => {
  const { companionSelfPull, residentSelfPull, byTarget, names } = await lanes();
  const root = await tempDir(t, 'fleet-transport-lanes');
  await fs.mkdir(path.join(root, 'state'));
  await fs.mkdir(path.join(root, 'broker'));
  const releases = new Map();
  const downloaded = [];
  const server = http.createServer((req, res) => {
    const prefix = `/${repository}/releases/download/`;
    const [tag, name] = req.url.startsWith(prefix) ? req.url.slice(prefix.length).split('/') : [];
    const bytes = releases.get(tag)?.get(name);
    if (!bytes || req.headers.authorization) return res.writeHead(404).end();
    downloaded.push(name);
    res.writeHead(200, { 'content-length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const releaseBase = `http://127.0.0.1:${server.address().port}`;
  const companion = () => companionSelfPull({ root, repository, clock: () => now,
    download: options => fetchFleetReleaseAsset({ ...options, releaseBase, now: () => now }) });

  const makeTarget = async (version, tar, base) => {
    const archive_sha256 = sha(tar);
    const request = { contract: REQUEST_CONTRACT, repository, version, commit: '1'.repeat(40), archive_sha256,
      firstInstallKitSha256: '2'.repeat(64), ciSourceManifestSha256: '3'.repeat(64),
      fleetRefs: { ...fleetFacts(), ownerAuthorizationRef: randomUUID(), publisherQualificationRef: randomUUID(), ownerPackageAcceptanceRef: randomUUID() } };
    const grant = { decision: randomUUID(), receipt: randomUUID(), acceptedAt: new Date(now).toISOString().replace('.000Z', 'Z') };
    const sealed = acceptanceBytes(acceptanceOf(request, grant));
    const requestBytes = json(request);
    const target = { repository, version, archive_sha256, request_sha256: sha(requestBytes), acceptance_sha256: sha(sealed),
      grant_id: grant.decision, receipt_id: grant.receipt, accepted_at: grant.acceptedAt, other_sources: [] };
    const files = names(target);
    const assets = new Map([[files.tar, tar], [files.request, requestBytes], [files.acceptance, sealed],
      ['SHA256SUMS', Buffer.from(`${archive_sha256}  ${files.tar}\n`)]]);
    if (base) {
      const stage = await tempDir(t, 'fleet-transport-assets');
      const previous = { version: base.target.version, sha256: base.target.archive_sha256, bytes: base.tar };
      for (const { name, file } of await stageTransport({ repository, version, archiveSha256: archive_sha256, archive: tar, stage, previous }))
        assets.set(name, await fs.readFile(file));
    }
    releases.set(files.tag, assets);
    return { target, files, tar, assets, dir: byTarget(root, target) };
  };
  const observe = async ({ target }) => {
    const probe = json({ at: new Date(now).toISOString(), onDuty: false, code: null, fleetTarget: target });
    await fs.writeFile(path.join(root, 'state', 'fleet-target.json'), probe);
    await fs.writeFile(path.join(root, 'broker', 'renew-ci.json'), probe);
  };
  const old = await makeTarget('g000024', Buffer.alloc(512_000, 4));
  const next = await makeTarget('g000025', Buffer.concat([old.tar, Buffer.from('second package')]), old);
  await observe(old);
  await companion()();
  assert.equal(await sha256File(path.join(old.dir, old.files.tar)), old.target.archive_sha256);
  // An old companion already put the tar in its request-SHA directory.
  const pointer = path.join(path.dirname(old.dir), 'transport-base.json');
  await fs.rm(pointer);
  await observe(next);
  await companion()();
  assert.equal((await read(path.join(next.dir, 'ready.json'))).grantId, next.target.grant_id);
  assert.equal((await read(pointer)).request_sha256, next.target.request_sha256);
  assert.equal(await sha256File(path.join(next.dir, next.files.tar)), next.target.archive_sha256);
  assert.ok(downloaded.includes(transportAssetNames(next.target.version, 'delta').payload));
  assert.ok(!downloaded.includes(next.files.tar));

  const bad = await makeTarget('g000026', Buffer.concat([next.tar, Buffer.from('third package')]), next);
  for (const name of [bad.files.tar, ...['delta', 'gzip'].map(kind => transportAssetNames(bad.target.version, kind).payload)]) {
    bad.assets.set(name, Buffer.from('corrupted'));
  }
  await observe(bad);
  await companion()();
  assert.ok(downloaded.includes(bad.files.tar));
  assert.equal((await read(path.join(bad.dir, 'download.json'))).code, 'FLEET_ARCHIVE_SHA_MISMATCH');
  await assert.rejects(fs.access(path.join(bad.dir, 'ready.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(bad.dir, bad.files.tar)), { code: 'ENOENT' });
  const requests = [];
  const resident = residentSelfPull({ root, repository, clock: () => now, submit: (...args) => requests.push(args) });
  await resident.tick({ queueEmpty: true });
  assert.deepEqual(requests, []);
  assert.equal((await read(path.join(root, 'state', 'fleet-pull.json'))).phase, 'DOWNLOADING');
});

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

function sealReinstallAssets(release) {
  const { tag, assets, target, request } = release;
  const archive = readTar(assets.get(`${tag}.tar`));
  const entries = ['bootstrap.ps1', 'prereq-manifest.json'].map(suffix => [
    `${tag}.${suffix}`,
    archive.find(e => e.path === `tree/work/independent-ci-resident-v1/rollout/fleet/${suffix}`).data,
  ]);
  const image = '11'.repeat(32);
  const imageName = `role-image-${image}.tar.gz`;
  const kitName = `${tag}.first-install-kit.json`;
  const fixtureKit = json({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1',
    images: { local: [{ id: image, asset: imageName }] } });
  const sums = pairs => Buffer.from(pairs.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([name, bytes]) => `${sha(bytes)}  ${name}\n`).join(''));
  const kitFiles = [[kitName, fixtureKit], [imageName, Buffer.from('role image fixture')]];
  const delivery = [[`${tag}.tar`, assets.get(`${tag}.tar`)], ...entries,
    [`${tag}.release.json`, json({ version: target.version })], ...kitFiles,
    ['SHA256SUMS', sums([[`${tag}.tar`, assets.get(`${tag}.tar`)], ...entries])],
    [`${tag}.first-install.SHA256SUMS`, sums(kitFiles)]];
  const manifest = sums(delivery);
  for (const [name, bytes] of delivery) assets.set(name, bytes);
  assets.set(`${tag}.candidate.SHA256SUMS`, manifest);
  request.deliveryAssetsSha256 = sha(manifest);
  request.firstInstallKitSha256 = sha(fixtureKit);
  const requestBytes = json(request);
  assets.set(`${tag}.acceptance-request.json`, requestBytes);
  target.request_sha256 = sha(requestBytes);
  return uploadAcceptance(release);
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

test('组装入口接受带 UTF-8 BOM 的 Broker 握手，拒绝其他内容', async () => {
  const script = path.join(RES, 'src', 'fleet-assemble-main.mjs');
  for (const [input, expected] of [
    ['assemble\n', '{"code":"FLEET_BROKER_PATH_REFUSED"}'],
    ['\uFEFFassemble\n', '{"code":"FLEET_BROKER_PATH_REFUSED"}'],
    ['\uFEFFassemble\r\n', ''],
  ]) {
    // Relative paths make an accepted handshake reach the path guard without touching the filesystem.
    const child = exec(process.execPath, [script, '--root', 'fixture-root', '--run', 'fixture-run'], { windowsHide: true });
    child.child.stdin.end(input);
    assert.equal((await child).stdout.trim(), expected, JSON.stringify(input));
  }
});

async function fixtureLanes({ node, release, broker, onDuty = false, peers = [], failVerify = false,
  runBroker = args => exec(broker, args, { windowsHide: true }), upload, clockNow = () => now, deliveryRoot = null }) {
  const { companionSelfPull, residentSelfPull } = await lanes();
  if (!residentSelfPull) return null;
  const root = node.root;
  for (const parts of [['state'], ['broker', 'requests'], ['broker', 'responses'], ['upgrade', 'inbox']])
    await fs.mkdir(path.join(root, ...parts), { recursive: true });
  const observed = path.join(root, 'broker', 'renew-ci.json');
  const probe = async (fleetTarget = release.target, { active = onDuty, otherSources = peers, recheck = false } = {}) =>
    fs.writeFile(recheck ? path.join(root, 'broker', 'renew-ci-recheck.fixture.json') : observed,
      json({ at: new Date(clockNow()).toISOString(), code: null, onDuty: active,
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
  const residentLane = residentSelfPull({ root, repository, clock: clockNow, deliveryRoot });
  const posted = [];
  const submitted = [];
  let step, canStart;
  return { probe, companion, uploaded, posted, submitted, up, clock, answers, fakeResident: resident,
    state: () => read(path.join(root, 'state', 'fleet-pull.json')),
    resident: { ...residentLane, tick: idle => { canStart = idle; step = residentLane.tick(idle); } },
    async tick({ downloadAssets = true } = {}) {
      await step;
      await residentLane.holdingIdle();
      if (downloadAssets) await companion();
      for (const file of await fs.readdir(path.join(root, 'broker', 'requests'))) {
        const id = path.basename(file, '.json');
        if (await fs.access(path.join(root, 'broker', 'responses', file)).then(() => true, () => false)) continue;
        submitted.push(id);
        const payload = await read(path.join(root, 'broker', 'requests', file));
        assert.deepEqual(Object.keys(payload).sort(), payload.kind === 'fleet-reinstall' ? ['grantId', 'kind', 'refusalId'] : ['grantId', 'kind']);
        let complete = false;
        const running = runBroker(['--fleet-pull-fixture', root, id, node.profile.nodeName, process.execPath,
          new Date(clockNow()).toISOString()]);
        running.then(() => { complete = true; }, () => { complete = true; });
        await until(async () => {
          if (complete) return true;
          if (!(await fs.stat(path.join(root, 'broker', 'responses', `${id}.idle`)).catch(() => null))) return false;
          await residentLane.confirmIdle(canStart);
          if (canStart?.queueEmpty) assert.equal(await residentLane.holdingIdle(), true, '确认发出后常驻须保留空闲');
          return true;
        }, 'Broker 完成或请求空闲确认');
        const { stdout } = await running;
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

function uploadAcceptance(release) {
  const bytes = acceptanceBytes(accepted(release));
  release.assets.set(`${release.tag}.acceptance.json`, bytes);
  return { ...release.target, acceptance_sha256: sha(bytes) };
}

test('正式第 27 代从封存经自拉到位，逐次复核目标、同伴和队列', { skip: process.platform !== 'win32' }, async t => {
  const fleet = fleetFacts();
  const { repo, commit } = await fixtureRepo(t);
  const candidate = await release(t, fleet, repo, commit, 'g000027');
  const standbyNode = await nodeSite(t, 'j', fleet, { now });
  const dutyNode = await nodeSite(t, 'k', fleet, { now });
  const broker = await brokerFixture(t);
  let time = now;
  const standby = await fixtureLanes({ node: standbyNode, release: candidate, broker, clockNow: () => time });
  const duty = await fixtureLanes({ node: dutyNode, release: candidate, broker, onDuty: true, peers: [null], clockNow: () => time });
  const pending = { ...candidate.target };
  const sealed = uploadAcceptance(candidate);

  await standby.probe(pending);
  await duty.probe({ status: 'pending_seal' });
  await drive(standby, 2);
  await drive(duty, 2);
  assert.deepEqual(standby.submitted, []);
  assert.deepEqual(duty.submitted, []);

  await standby.probe(sealed);
  await duty.probe(sealed);
  // The first signed probe is sealed. The Broker's after-assembly probe reports a different seal.
  await standby.probe({ ...sealed, acceptance_sha256: 'f'.repeat(64) }, { recheck: true });
  await drive(standby, 3);
  assert.equal(standby.answers[0]?.code, 'FLEET_TARGET_CHANGED');
  assert.equal(standby.answers[0]?.delivered, false);
  assert.deepEqual(standby.posted, []);
  assert.deepEqual(await fs.readdir(path.join(standbyNode.root, 'upgrade', 'inbox')), []);

  await drive(duty, 3);
  assert.equal((await duty.state()).phase, 'WAITING_FOR_PEERS');
  assert.deepEqual(duty.submitted, []);
  await duty.probe(sealed, { otherSources: [standbyNode.pkg.ciSource] });
  await drive(duty, 2);
  assert.equal((await duty.state()).phase, 'WAITING_FOR_PEERS');
  assert.deepEqual(duty.submitted, []);

  time += 61_000;
  await standby.probe(sealed);
  await standby.probe(sealed, { recheck: true });
  await drive(standby, 12);
  const ready = await current(standbyNode);
  assert.equal(ready.ciSourceManifestSha256, source(candidate));
  assert.equal(ready.linux.ciSourceManifestSha256, source(candidate));
  assert.equal(standby.posted.length, 1);
  assert.equal((await standby.state()).reinstall, undefined);

  await duty.probe(sealed, { otherSources: [ready.ciSourceManifestSha256] });
  let ticks = 0;
  await serviceLoop({
    exec: { tick: async () => { ticks += 1; return { state: 'IDLE' }; } }, lock: { touch: async () => {} },
    stopRequested: async () => ticks >= 12 || (await duty.state()).phase === 'CURRENT',
    acknowledgeStop: async () => {}, onLoopException: error => { throw error; },
    betweenBatches: async () => {}, selfPull: duty.resident,
    upgradeIdle: async () => ({ queueEmpty: ticks > 3 }),
    sleep: async () => {
      await duty.tick();
      if (ticks <= 3) assert.deepEqual(duty.submitted, [], '当班队列未空时不能投递');
    },
  });
  assert.equal(duty.posted.length, 1);
  assert.equal((await duty.state()).phase, 'CURRENT');
  assert.equal((await duty.state()).reinstall, undefined);
  const upgraded = await current(dutyNode);
  assert.equal(upgraded.ciSourceManifestSha256, source(candidate));
  assert.equal(upgraded.linux.ciSourceManifestSha256, source(candidate));
  assert.deepEqual([...standby.uploaded, ...duty.uploaded], []);
});
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
      case 'rehearse.py': {
        const current = JSON.parse(readFileSync(path.join(node.root, 'upgrade', 'current.json'), 'utf8'));
        const verify = readFileSync(path.join(node.root, 'resident', current.residentManifestSha256, 'windows', 'verify-resident.ps1'));
        body = { status: 'REHEARSAL_PASS', report: path.join(work, 'fixture-rehearsal.json') };
        writeFileSync(body.report, json({ status: body.status, checks: { verify: { sha256: sha(verify) } } }));
        break;
      }
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

  await t.test('当班队列在组装期间转忙，升级 inbox 和投递标记保持为空', async t => {
    const node = await nodeSite(t, 'l', fleet, { now });
    const childScript = path.join(await tempDir(t, 'fleet-queue-race'), 'assemble.mjs');
    const started = path.join(path.dirname(childScript), 'started');
    const proceed = path.join(path.dirname(childScript), 'proceed');
    const guard = pathToFileURL(path.join(CHECKOUT, 'scripts', 'ci', 'test-clock-guard.mjs')).href;
    await fs.writeFile(childScript, `import fs from 'node:fs/promises';
      import path from 'node:path';
      import { createHash } from 'node:crypto';
      import { until } from ${JSON.stringify(guard)};
      for await (const chunk of process.stdin) {}
      await fs.writeFile(${JSON.stringify(started)}, '');
      await until(() => fs.stat(${JSON.stringify(proceed)}).catch(() => null), '夹具允许完成组装');
      const packageDir = path.join(process.argv.at(-1), 'package');
      await fs.mkdir(packageDir);
      await fs.writeFile(path.join(packageDir, 'package-manifest.json'), '{}');
      console.log(JSON.stringify({ status: 'FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED', packageDir,
        fromGeneration: 1, packageManifestSha256: createHash('sha256').update('{}').digest('hex') }));
    `);
    const lane = await fixtureLanes({ node, release: target, broker, onDuty: true, peers: [source(target)],
      runBroker: async args => {
        const running = exec(broker, [...args, childScript], { windowsHide: true });
        await until(() => fs.stat(started).catch(() => null), 'Broker 组装已开始');
        lane.resident.tick({ queueEmpty: false });
        await fs.writeFile(proceed, '');
        return running;
      } });
    await lane.probe();
    lane.resident.tick({ queueEmpty: true }); await lane.tick();
    lane.resident.tick({ queueEmpty: true }); await lane.tick();
    assert.equal(lane.submitted.length, 1);
    assert.equal(lane.answers[0].delivered, false);
    assert.equal(lane.answers[0].code, 'FLEET_WAITING_FOR_IDLE');
    assert.deepEqual(await fs.readdir(path.join(node.root, 'upgrade', 'inbox')), []);
    assert.equal((await fs.readdir(path.join(node.root, 'broker', 'responses'))).includes(`fleet-${target.target.grant_id}.taken`), false);
  });

  await t.test('无需投递的结果也复核目标与本机安装身份', async t => {
    for (const [status, expected] of [
      ['FLEET_NODE_ALREADY_AT_THIS_PACKAGE', 'FLEET_TARGET_CHANGED'],
      ['FLEET_NODE_UPGRADE_NEEDS_REINSTALL', 'FLEET_GENERATION_CHANGED'],
    ]) {
      await t.test(status, async t => {
        const node = await nodeSite(t, 'm', fleet, { now });
        const childScript = path.join(await tempDir(t, 'fleet-final-check'), 'assemble.mjs');
        const currentFile = path.join(node.root, 'upgrade', 'current.json');
        await fs.writeFile(childScript, `import fs from 'node:fs/promises';
          for await (const chunk of process.stdin) {}
          ${expected === 'FLEET_GENERATION_CHANGED' ? `const file = ${JSON.stringify(currentFile)};
            const current = JSON.parse(await fs.readFile(file, 'utf8'));
            await fs.writeFile(file, JSON.stringify({ ...current, generation: current.generation + 1 }));` : ''}
          console.log(JSON.stringify({ status: ${JSON.stringify(status)} }));
        `);
        const lane = await fixtureLanes({ node, release: target, broker,
          runBroker: args => exec(broker, [...args, childScript], { windowsHide: true }) });
        await lane.probe();
        if (expected === 'FLEET_TARGET_CHANGED') await lane.probe(null, { recheck: true });
        await drive(lane, 3);
        assert.equal(lane.answers[0].code, expected);
        assert.equal(lane.answers[0].delivered, false);
        assert.equal((await lane.state()).phase, 'PREPARE_FAILED');
      });
    }
  });

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
    const frozen = await release(t, fleet, repo, git(repo, 'rev-parse', 'HEAD').toString().trim(), 'g000028');
    const sealed = uploadAcceptance(frozen);
    let time = now;
    const lane = await fixtureLanes({ node, release: frozen, broker, clockNow: () => time });
    await lane.probe(sealed); await drive(lane);
    const first = await lane.state();
    assert.equal(first.phase, 'NEEDS_REINSTALL');
    assert.equal(first.code, 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL');
    const windows = { residentManifestSha256: node.pkg.residentSha, ciSourceManifestSha256: node.pkg.ciSource };
    assert.deepEqual(parseVersions({ windows, fleetPull: first }).fleetPull.reinstall, {
      repository, bootstrapAsset: `${frozen.tag}.bootstrap.ps1`, archiveSha256: sealed.archive_sha256,
      requestSha256: sealed.request_sha256, acceptanceSha256: sealed.acceptance_sha256,
    });
    assert.equal(parseVersions({ windows, fleetPull: { ...first, phase: 'REFUSED' } }).fleetPull.reinstall, undefined);
    assert.equal(lane.submitted.length, 1);
    time += 61_000; // The installed self-pull would already retry a PREPARE_FAILED answer.
    await lane.probe(sealed); await drive(lane, 2);
    assert.deepEqual(await lane.state(), first);
    assert.equal(lane.submitted.length, 1);
    assert.equal(versionNotices({ fleetPull: first }).filter(n => n.kind === 'fleet-pull-refused').length, 1);
    assert.equal(lane.posted.length, 0);
    await lane.probe({ status: 'pending_seal' });
    const versionState = () => readVersionState({ root: node.root, policy: { repo: repository, ...windows }, clock: () => time });
    const beforeTick = (await versionState()).view.fleetPull;
    assert.equal(beforeTick.reinstall, undefined);
    assert.equal(beforeTick.code, first.code);
    assert.deepEqual(lane.answers[0].targetFingerprint, sealed);
    await drive(lane, 2);
    assert.equal((await lane.state()).reinstall, undefined);
    assert.equal((await lane.state()).code, first.code);
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

test('封存轮换时旧当班等待、后备不投递，Broker 得到服务端摘牌回执后只升一次', { skip: process.platform !== 'win32' }, async t => {
  const fleet = fleetFacts();
  const { repo, commit } = await fixtureRepo(t);
  const release27 = await release(t, fleet, repo, commit, 'g000027');
  const target = uploadAcceptance(release27);
  const node = await nodeSite(t, 'q', fleet, { now });
  const broker = await brokerFixture(t);
  const lane = await fixtureLanes({ node, release: release27, broker });
  const sealed = maintenance => ({ ...target, holder_package: { classification:'previous', maintenance },
    has_other_healthy:true, install_ready:maintenance === 'delisted', operation_id:randomUUID() });
  await lane.probe(sealed('available'),{active:true,otherSources:[null]});
  await drive(lane,3);
  assert.equal((await lane.state()).phase,'WAITING_FOR_HANDOVER');
  await lane.probe(sealed('reserve'));
  await drive(lane,2);
  assert.equal((await lane.state()).phase,'RESERVE');
  assert.equal(lane.submitted.length,0);
  const receipt = sealed('delisted');
  await fs.writeFile(path.join(node.root,'broker','delist.fixture.json'),json(receipt));
  await lane.probe(receipt);
  await drive(lane,8);
  assert.equal(lane.posted.length,1,JSON.stringify(lane.answers));
  assert.equal((await current(node)).generation,2);
});

test('冻结通道不变，supervisor 必须换代时自动补齐封存重装资产', { skip: process.platform !== 'win32' }, async t => {
  const fleet = fleetFacts();
  const { repo, commit } = await fixtureRepo(t);
  const broker = await brokerFixture(t);
  const candidate = await release(t, fleet, repo, commit, 'g000028');
  const target = sealReinstallAssets(candidate);
  async function start(letter) {
    const node = await nodeSite(t, letter, fleet, { now });
    const file = path.join(node.root, 'install', 'install-receipt.json');
    const receipt = await read(file);
    receipt.companionSupervisorSourceSha256 = '1'.repeat(64);
    const bytes = json(receipt);
    await fs.writeFile(file, bytes);
    const currentFile = path.join(node.root, 'upgrade', 'current.json');
    await fs.writeFile(currentFile, json({ ...await read(currentFile), installReceiptSha256: sha(bytes) }));
    const deliveryRoot = path.join(node.root, 'fleet-delivery');
    await fs.mkdir(deliveryRoot);
    await fs.writeFile(path.join(deliveryRoot, 'interactive.ps1'), '# fixture');
    await fs.writeFile(path.join(node.root, 'install', 'companion-account.json'), json({
      companionSid: 'S-1-5-21-1-2-3-2001', operatorSid: 'S-1-5-21-1-2-3-3001',
    }));
    const lane = await fixtureLanes({ node, release: candidate, broker, deliveryRoot });
    await lane.probe({ ...target, holder_package: { classification: 'previous', maintenance: 'available' },
      has_other_healthy: true });
    await drive(lane, 8);
    return { node, deliveryRoot, lane, currentFile };
  }
  const { node, deliveryRoot, lane, currentFile } = await start('s');
  assert.equal(lane.answers[0]?.code, 'COMPANION_SUPERVISOR_NEEDS_REINSTALL');
  assert.deepEqual(await fs.readdir(path.join(node.root, 'upgrade', 'inbox')), []);
  const { byTarget } = await lanes();
  const bundle = byTarget(node.root, target);
  assert.ok(await fs.stat(path.join(bundle, 'reinstall', `${candidate.tag}.bootstrap.ps1`)).catch(() => null),
    '同一封存目标判定需重装后应自动补拉 bootstrap');
  assert.equal(lane.answers[1]?.status, 'FLEET_REINSTALL_PUBLISHED', JSON.stringify(lane.answers));
  const pending = await read(path.join(deliveryRoot, 'pending.json'));
  const installedAssets = path.join(deliveryRoot, pending.requestSha256, pending.operationId, 'assets');
  assert.equal(pending.operatorSid, 'S-1-5-21-1-2-3-3001');
  assert.deepEqual(await fs.readFile(path.join(installedAssets, `${candidate.tag}.bootstrap.ps1`)), candidate.assets.get(`${candidate.tag}.bootstrap.ps1`));
  assert.deepEqual((await fs.readdir(installedAssets)).sort(), [...candidate.assets.keys()]
    .filter(name => !/\.(?:acceptance-request\.json|candidate\.SHA256SUMS)$/.test(name)).sort());
  assert.equal((await lane.state()).reinstall.phase, 'WAITING_FOR_OWNER_SESSION');
  await drive(lane, 3);
  assert.equal(lane.answers.length, 2);

  // A protected lifecycle terminal still needs this generation's two-sided facts.
  const { operationId, grantId, requestSha256, sourceSha256, nodeId, bindingGeneration } = pending;
  const observedAt = new Date(now).toISOString();
  const receiptSha256 = '9'.repeat(64);
  const next = { ...await read(currentFile), ciSourceManifestSha256: sourceSha256, installReceiptSha256: receiptSha256 };
  await fs.writeFile(currentFile, json(next));
  await fs.writeFile(path.join(path.dirname(installedAssets), 'result.json'), json({
    contract: 'clued.independent-ci.fleet-reinstall-result/1', operationId, grantId, requestSha256, sourceSha256,
    nodeId, bindingGeneration, phase: 'COMPLETE', receiptSha256, at: observedAt,
  }));
  const probeFile = path.join(node.root, 'broker', 'renew-ci.json');
  await fs.writeFile(probeFile, json({ ...await read(probeFile), delivery: {
    nodeId, bindingGeneration, installReceiptSha256: receiptSha256, installGeneration: next.generation,
    windowsSourceSha256: sourceSha256, observedAt,
  } }));
  await drive(lane, 1);
  assert.equal((await lane.state()).reinstall.phase, 'VERIFYING');
  await fs.writeFile(path.join(node.root, 'upgrade', 'mailbox', 'responses', 'version-facts.json'), json({
    contract: 'clued.independent-ci.linux-version-facts/1', ciSourceManifestSha256: sourceSha256, generation: next.linux.generation,
    staged: null, pinsOk: true, liveMatchesCurrent: true, observedAt,
  }));
  await drive(lane, 1);
  assert.equal((await lane.state()).phase, 'CURRENT');

  const image = [...candidate.assets.keys()].find(name => name.startsWith('role-image-'));
  candidate.assets.set(image, Buffer.from('tampered'));
  const changed = await start('t');
  assert.equal((await changed.lane.state()).reinstall.code, 'FLEET_DELIVERY_RELEASE_ASSET_CHANGED');
  assert.equal(changed.lane.answers.length, 1);
  assert.deepEqual(await fs.readdir(changed.deliveryRoot), ['interactive.ps1']);
});
