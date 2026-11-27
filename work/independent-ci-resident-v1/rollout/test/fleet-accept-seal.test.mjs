// Real seal and accept commands through the existing resident-node suite. GitHub and the acceptance door are controlled fixtures.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { planFiles } from '../../../../scripts/ci/ci-required-selection.mjs';
import * as publishModule from '../fleet/publish.mjs';
import { transportAssetNames } from '../fleet/fetch.mjs';
import { requirementsDigest } from '../fleet/release-migrations.mjs';
import { GRANT, GRANT_RECEIPT, REPO, TAG, fakeTime, prepWorld, resourceOf, sealedNothing, sha, timed, uploadsOf, world } from '../fleet/test/publish-fixtures.mjs';

const legacyNode = (id, name, mode, observedAt) => ({ id, name, state: 'active', mode,
  registrationVersion: 4, bindingGeneration: 2, identityFingerprint: 'c'.repeat(64), bindingLive: true, rebindPending: false,
  reportedSourceSha256: 'd'.repeat(64), heartbeatAt: observedAt, heartbeatSequence: 81,
  reportedState: 'NORMAL', serviceRunning: true, onDuty: mode === 'ACTIVE', evidence: null });

test('prepare 发布可复验的运输资产，续跑保持正式 tar、清单和请求字节', async t => {
  const old = await world(t, 'g000024');
  const w = await prepWorld(t, { version: 'g000025', released: false, spawnGh: false });
  const oldTag = old.source.release_tag;
  const name = `${oldTag}.acceptance.json`;
  const accepted = Buffer.from(JSON.stringify({ contract: publishModule.ACCEPTANCE_CONTRACT, repository: REPO,
    version: old.source.version, commit: old.source.commit, archive_sha256: old.source.archive_sha256 }));
  await fs.writeFile(w.state, JSON.stringify({ calls: [], assets: [], other: {
    [oldTag]: [{ name, size: accepted.length, b64: accepted.toString('base64') }]
  } }));
  const tags = w.deps.generationTags;
  const deps = { ...w.deps, generationTags: { ...tags, read: tag => tag === oldTag ? {
    contract: 'clued.independent-ci.fleet-package-generation/1', version: old.source.version, release_tag: oldTag,
    commit: old.source.commit, archive_sha256: old.source.archive_sha256
  } : tags.read(tag) } };
  const transportBase = path.join(old.build, `${oldTag}.tar`);
  const bad = Buffer.from(old.tar);
  bad[0] ^= 1;
  await fs.writeFile(transportBase, bad);
  await assert.rejects(w.prep({ deps, transportBase }), { code: 'PUBLISH_TRANSPORT_BASE_SHA_MISMATCH' });
  assert.deepEqual(await w.assets(), []);
  await fs.writeFile(transportBase, old.tar);
  await w.prep({ deps, transportBase });
  const assets = new Map((await w.assets()).map(asset => [asset.name, Buffer.from(asset.b64, 'base64')]));
  const version = w.source.version, tarName = `${w.source.release_tag}.tar`;
  assert.deepEqual(assets.get(tarName), w.tar);
  assert.match(assets.get('SHA256SUMS').toString(), new RegExp(`${w.source.archive_sha256}  ${tarName}\\n`));
  assert.doesNotMatch(assets.get('SHA256SUMS').toString(), /transport-|\.delta\.gz|\.tar\.gz/);
  for (const kind of ['gzip', 'delta']) {
    const { meta, payload } = transportAssetNames(version, kind);
    const descriptor = JSON.parse(assets.get(meta));
    assert.deepEqual([descriptor.version, descriptor.repository, descriptor.archive_sha256, descriptor.archive_bytes, descriptor.sha256],
      [version, REPO, w.source.archive_sha256, w.tar.length, sha(assets.get(payload))]);
    if (kind === 'gzip') assert.deepEqual(gunzipSync(assets.get(payload)), w.tar);
    else assert.deepEqual(descriptor.base, { version: old.source.version, bytes: old.tar.length, sha256: old.source.archive_sha256 });
  }
  const request = await fs.readFile(w.requestFile);
  assert.equal(JSON.parse(request).archive_sha256, w.source.archive_sha256);
  const uploads = await uploadsOf(w);
  await w.prep({ deps, transportBase });
  assert.deepEqual(await uploadsOf(w), uploads);
  assert.deepEqual(await fs.readFile(w.requestFile), request);
});

const fixtureKit = () => ({ record: { repository: 'tdoljyj/cross-memory-system', scope: 'project:11111111-1111-4111-8111-111111111111' } });
const prepareFixtures = { readKit: fixtureKit, verifyDeliveryTree: () => {}, admitRelease: async subject => ({ ...subject, status: 'PASS' }) };

function gen27Tags(w) {
  return { ...w.deps.generationTags, list: async () => ['fleet-node-g000025', 'fleet-node-g000026', ...await w.deps.generationTags.list()] };
}

function fleetProjection(candidate, at, fault) {
  const nodes = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'].map((id, i) => {
    const row = legacyNode(id, i === 0 ? 'DESK' : 'TURING', i === 0 ? 'ACTIVE' : 'STANDBY', at);
    return { ...row, state: 'pending', generation: 26, bindingLive: fault !== 'revoked' || i === 0, evidence: i === 1 ? null : {
      schemaVersion: 1, nodeId: row.id, registrationVersion: row.registrationVersion, bindingGeneration: row.bindingGeneration,
      currentHeartbeat: true, packageGeneration: 26, installGeneration: 5, brokerObservedAt: at, linuxObservedAt: at, observedAt: at,
      brokerEvidenceSha256: '1'.repeat(64), linuxFactsSha256: '2'.repeat(64), installReceiptSha256: '3'.repeat(64),
      evidenceSha256: '4'.repeat(64), windowsSourceSha256: row.reportedSourceSha256, linuxSourceSha256: row.reportedSourceSha256,
      linuxReady: true, linuxConsistent: true, operations: true, connectionCarry: true, acl: true, processClearance: true,
    } };
  });
  nodes.push({ id: '33333333-3333-4333-8333-333333333333', name: 'LEFT', state: 'retired' });
  return { candidate, repository: candidate.repository, scope: candidate.scope, observedAt: at, complete: true,
    snapshotToken: 'e'.repeat(64), nodes };
}

async function stagedProjection(operation, candidate, details, time, fault) {
  const { buildInput, qualifyDelivery } = await import('../../../../scripts/ci/clued-fleet-accept.mjs');
  const { deliveryWorkflowClient, deliveryWorkflowPacket } = await import('../fleet/delivery-workflow.mjs');
  assert.equal(operation, 'preflight');
  const deps = { fetchImpl: async () => assert.fail('暂存预检不得读 Release'), isAncestor: commit => commit === candidate.commit,
    isPinned: () => assert.fail('暂存预检不得读取正式 tag') };
  let env, packet;
  const calls = [];
  const read = deliveryWorkflowClient({
    runGh: args => {
      if (args[0] === 'workflow') {
        env = { GITHUB_SHA: candidate.commit, GITHUB_REPOSITORY: candidate.repository };
        for (const [i, arg] of args.entries()) {
          if (arg !== '-f' || !args[i + 1].startsWith('fleet_')) continue;
          const [key, value] = args[i + 1].split('=');
          env[key.toUpperCase()] = value;
        }
        assert.equal(env.FLEET_OPERATION, 'project');
        return { status: 0, stdout: `https://github.com/${candidate.repository}/actions/runs/81\n` };
      }
      return { status: 0, stdout: args.includes('--log') ? packet + '\n' : JSON.stringify({ status: packet ? 'completed' : 'in_progress',
        conclusion: packet ? 'success' : null, attempt: 1, event: 'workflow_dispatch', headBranch: 'main', headSha: candidate.commit }) };
    },
    sleep: async () => {
      await assert.rejects(buildInput({ ...env, GITHUB_SHA: 'f'.repeat(40) }, deps), /FLEET_DELIVERY_SUBJECT_CHANGED/);
      await assert.rejects(buildInput({ ...env, FLEET_REQUEST_SHA256: '0'.repeat(64) }, deps), /FLEET_ACCEPT_REQUEST_SHA256_MISMATCH/);
      const input = await buildInput(env, deps);
      assert.deepEqual(input.delivery.candidate, candidate);
      const now = new Date(time.now).toISOString();
      const projection = fleetProjection(candidate, fault === 'stale' ? '2026-11-27T00:00:00Z' : now, fault);
      const result = await qualifyDelivery(input, async (kind, subject) => {
        calls.push(kind);
        assert.equal(kind, 'project');
        assert.deepEqual(subject, candidate);
        return projection;
      }, time.clock);
      packet = deliveryWorkflowPacket({ operation, candidate, result }, input.delivery.transportKey, candidate.requestSha256);
    },
  });
  const result = await read(operation, candidate, details, { signal: new AbortController().signal });
  assert.deepEqual(calls, fault === 'stale' ? ['project'] : ['project', 'project']);
  assert.equal(Object.hasOwn(result, 'nodes'), false);
  return result;
}

async function publishWorld(t, overrides = {}) {
  const w = await prepWorld(t, { version: 'g000027', released: false, spawnGh: false });
  const time = fakeTime('2026-11-27T01:00:00Z');
  const phases = [], confirms = [], links = [];
  let mainStatus = 'identical';
  const approve = () => Object.assign(w.door, { status: 'accepted', grant: GRANT, receipt: GRANT_RECEIPT,
    acceptedAt: new Date(time.now).toISOString() });
  const deps = { ...w.deps, ...prepareFixtures, clock: time.clock, sleep: time.sleep,
    ghCommand: args => args[1]?.includes('/compare/main...') ? { status: 0, stdout: JSON.stringify({ status: mainStatus }) } : w.gh(args),
    generationTags: gen27Tags(w), onPending: link => links.push(link),
    fleetWorkflow: async (operation, candidate, details) => {
      phases.push(operation);
      if (operation === 'preflight') return stagedProjection(operation, candidate, details, time);
      if (operation === 'project') {
        const view = fleetProjection(candidate, new Date(time.now).toISOString());
        return { first: view, last: view };
      }
      assert.equal(operation, 'confirm');
      confirms.push(details);
      w.door.sealedDigest = details.acceptanceSha256;
      return { status: 'sealed', ...details };
    }, ...overrides };
  w.door.status = 'none';
  const run = (extra = {}, command = 'publish', directory = w.build) => publishModule.main([
    command, '--commit', w.source.commit, '--dir', directory, '--out', w.out, '--image', w.image, '--index', w.index,
    ...(command === 'publish' ? ['--wait', '1'] : []),
  ], { ...deps, ...extra });
  return { w, time, phases, confirms, links, approve, deps, run, advanceMain: () => { mainStatus = 'behind'; } };
}

test('发布机没有已装节点时，从已封存 Release 复用精确 kit 和 Source 引用', async t => {
  const prior = await prepWorld(t, { version: 'g000025', released: false, spawnGh: false });
  await prior.prep();
  const time = fakeTime('2026-11-27T01:00:00Z');
  Object.assign(prior.door, { status: 'accepted', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: new Date(time.now).toISOString() });
  const fleetWorkflow = async (operation, candidate, details) => {
    if (operation === 'project') {
      const view = { ...fleetProjection(candidate, new Date(time.now).toISOString()), nodes: [] };
      return { first: view, last: view };
    }
    assert.equal(operation, 'confirm');
    prior.door.sealedDigest = details.acceptanceSha256;
    return { status: 'sealed', ...details };
  };
  const old = await timed(prior, time, { deps: { ...prior.deps, clock: time.clock, sleep: time.sleep, fleetWorkflow } });
  assert.equal(old.status, 'FLEET_ACCEPTANCE_SEALED');
  const { w, deps } = await publishWorld(t);
  const priorIndex = (await fs.readFile(prior.index, 'utf8')).split(/\r?\n/).find(line => line.startsWith('| g000025 |'));
  assert.ok(priorIndex);
  await fs.appendFile(w.index, priorIndex + '\n');
  const { kitOf, fleetMaterial, ...candidateDeps } = deps;
  const ghCommand = args => args[0] === 'release' && args[2] === prior.source.release_tag ? prior.gh(args) : deps.ghCommand(args);
  const run = () => w.prep({ root: path.join(w.d, 'no-resident'), ghCommand, now: time.now,
    deps: { ...candidateDeps, readStatus: prior.deps.readStatus } });
  prior.door.sealedDigest = '0'.repeat(64);
  await assert.rejects(run(), { code: 'PREPARE_SEALED_TEMPLATE_REFUSED' });
  assert.deepEqual(await w.assets(), []);
  prior.door.sealedDigest = old.acceptanceSha256;
  const result = await run();
  const request = JSON.parse(await fs.readFile(result.request, 'utf8'));
  const priorRequest = JSON.parse(await fs.readFile(prior.requestFile, 'utf8'));
  assert.equal(result.templateVersion, 'g000025');
  assert.equal(request.firstInstallKitSha256, priorRequest.firstInstallKitSha256);
  assert.deepEqual(request.fleetRefs, priorRequest.fleetRefs);
});

test('正式 publish 和旧 prepare 在新建目录、候选通过本地校验后才接入一次迁移对账', async t => {
  for (const command of ['publish', 'prepare']) await t.test(command, async t => {
    const { w, run, phases, approve } = await publishWorld(t);
    const dir = path.join(w.d, 'new', 'build');
    await assert.rejects(fs.access(dir), { code: 'ENOENT' });
    const migration = { file: '20261127120100_fleet_pending_delivery_v1.sql', version: '20261127120100',
      name: 'fleet_pending_delivery_v1', digest: 'a'.repeat(64), requires: [], probe: 'pendingDelivery' };
    const plan = [migration];
    const complete = { base: true, applied: [{ version: migration.version, name: migration.name, digest: migration.digest }],
      interfaces: { pendingDelivery: true } };
    const release = {
      admit: async () => {},
      requirements: async () => plan,
      read: async requirements => {
        phases.push('reconcile');
        assert.deepEqual(requirements, plan);
        assert.ok((await fs.readdir(dir)).includes(`${w.source.release_tag}.tar`));
        assert.equal(w.s.sourceDrafts.length, 1, '本地候选应已验证');
        assert.deepEqual(await w.assets(), []);
        return { runId: '401', snapshot: command === 'publish' ? { base: true, applied: [], interfaces: { pendingDelivery: false } } : complete };
      },
      migrate: async (missing, requirements) => {
        assert.equal(command, 'publish');
        assert.deepEqual(missing, [migration.file]);
        assert.deepEqual(requirements, plan);
        return { runId: '402', snapshot: complete };
      },
    };
    const result = await run({ admitRelease: undefined, release, onPending: approve,
      buildUniversal: ({ out }) => fs.cp(w.build, out, { recursive: true }) }, command, dir);
    assert.equal(result.status, command === 'publish' ? 'FLEET_ACCEPTANCE_SEALED' : 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
    assert.deepEqual(phases.slice(0, 2), ['reconcile', 'preflight']);
    assert.equal(phases.filter(phase => phase === 'reconcile').length, 1);
    assert.deepEqual(result.migrationAdmission, { status: 'PASS', repository: fixtureKit().record.repository, commit: w.source.commit,
      requirementsSha256: requirementsDigest(plan), readRunId: '401', migrationRunId: command === 'publish' ? '402' : null,
      dispatched: command === 'publish' ? [migration.file] : [] });
  });
});

test('开单后 main 前进，重启沿原 Grant、Receipt 和请求摘要续封', async t => {
  const { w, run, approve, confirms, advanceMain } = await publishWorld(t);
  let admissions = 0, mainMoved = false;
  const admitRelease = async subject => {
    admissions++;
    if (mainMoved) throw Object.assign(new Error('FLEET_RELEASE_MAIN_CHANGED'), { code: 'FLEET_RELEASE_MAIN_CHANGED' });
    return { ...subject, status: 'PASS' };
  };
  const opened = await run({ admitRelease });
  assert.equal(opened.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  const before = (await w.calls()).length;
  mainMoved = true;
  advanceMain();
  approve();
  const sealed = await run({ admitRelease });
  assert.deepEqual([sealed.status, sealed.grantId, sealed.receiptId, sealed.requestSha256],
    ['FLEET_ACCEPTANCE_SEALED', GRANT, GRANT_RECEIPT, opened.requestSha256]);
  assert.equal(admissions, 1);
  assert.equal(sealed.acceptanceSha256, confirms[0].acceptanceSha256);
  assert.equal(sha(await fs.readFile(sealed.acceptance)), sealed.acceptanceSha256);
  assert.equal((await w.opens()).length, 1);
  assert.deepEqual((await w.calls()).slice(before).filter(c => c.args.slice(0, 2).join(' ') === 'release create'), []);
});

test('上一封存包接口在候选数据库上失败时拒绝封存', async t => {
  const { w, run, approve, confirms } = await publishWorld(t);
  const opened = await run();
  assert.equal(opened.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  approve();
  const index = await fs.readFile(w.index);
  const uploads = (await uploadsOf(w)).length;
  await assert.rejects(run({ previousInterfaces: async subject => {
    assert.equal(subject.commit, w.source.commit);
    return { status: 'FAIL', commit: subject.commit };
  } }), { code: 'FLEET_PREVIOUS_INTERFACES_REFUSED' });
  assert.deepEqual(confirms, []);
  await sealedNothing(w, index, uploads);
});

test('已受理的开单运行终局失败且门为 none，才按准确运行编号重试', async t => {
  const { w, run } = await publishWorld(t);
  w.door.openTo = 'none';
  const repository = fixtureKit().record.repository;
  const runReads = [];
  let conclusion = null;
  const ghCommand = args => {
    if (args[1]?.includes('/compare/main...')) return { status: 0, stdout: JSON.stringify({ status: 'identical' }) };
    const result = w.gh(args);
    if (args[0] === 'workflow') {
      if (args.includes('fleet_request_sha256=' + w.door.reads[0]?.split('/').at(-1))) {
        if (conclusion === 'failure') w.door.openTo = 'pending';
        return { ...result, stdout: `https://github.com/${repository}/actions/runs/${conclusion === 'failure' ? 802 : 801}\n` };
      }
    }
    if (args[0] === 'api' && args[1].includes('/actions/runs/')) {
      const id = Number(args[1].split('/').at(-1));
      runReads.push(id);
      return { status: 0, stdout: JSON.stringify({ id, path: '.github/workflows/clued-cloud-production-release.yml',
        repository: { full_name: repository }, head_repository: { full_name: repository }, head_branch: 'main',
        event: 'workflow_dispatch', run_attempt: 1, status: conclusion ? 'completed' : 'in_progress', conclusion }) };
    }
    return result;
  };
  assert.equal((await run({ ghCommand })).status, 'FLEET_ACCEPTANCE_NOT_OPENED');
  assert.equal((await run({ ghCommand })).status, 'FLEET_ACCEPTANCE_NOT_OPENED');
  assert.equal((await w.opens()).length, 1);
  conclusion = 'failure';
  assert.equal((await run({ ghCommand })).status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  assert.equal((await w.opens()).length, 2);
  assert.ok(runReads.length > 0 && runReads.every(id => id === 801));
});

test('展示确认链接后的镜像、节点入口漂移在发布端和受信确认入口均阻止封存', async t => {
  for (const boundary of ['publisher', 'confirm']) await t.test(boundary, async t => {
    const { w, time, run, approve, confirms, links, deps } = await publishWorld(t);
    const changed = boundary === 'publisher' ? path.basename(w.image) : `${w.source.release_tag}.bootstrap.ps1`;
    const replace = () => w.setState(state => {
      const asset = state.assets.find(asset => asset.name === changed);
      const bytes = Buffer.from(asset.b64, 'base64');
      bytes[0] ^= 1;
      Object.assign(asset, { b64: bytes.toString('base64'), sha256: sha(bytes) });
    });
    if (boundary === 'confirm') {
      const opened = await run();
      assert.equal(opened.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
      approve();
    }
    let workflowRefusal;
    const fleetWorkflow = async (operation, candidate, details) => {
      if (operation !== 'confirm') return deps.fleetWorkflow(operation, candidate, details);
      await replace();
      const { main } = await import('../../../../scripts/ci/clued-fleet-accept.mjs');
      const { generateKeyPairSync } = await import('node:crypto');
      const { publicKey } = generateKeyPairSync('x25519');
      const exit = await main(['input'], { GITHUB_REPOSITORY: candidate.repository, FLEET_VERSION: candidate.version,
        FLEET_REQUEST_SHA256: candidate.requestSha256, FLEET_OPERATION: 'confirm', FLEET_ACCEPTANCE_SHA256: details.acceptanceSha256,
        FLEET_DELIVERY_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') },
      { write: () => assert.fail('漂移资产不得进入封存 SQL'), error: message => { workflowRefusal = message; } },
      { isAncestor: () => true, isPinned: () => true, fetchImpl: async url => {
        const asset = (await w.assets()).find(asset => asset.name === url.split('/').at(-1));
        return asset ? new Response(Buffer.from(asset.b64, 'base64')) : new Response(null, { status: 404 });
      } });
      assert.equal(exit, 1);
      throw Object.assign(new Error('FLEET_DELIVERY_WORKFLOW_REFUSED'), { workflowCompleted: true });
    };
    const sleep = async ms => {
      await time.sleep(ms);
      if (boundary === 'publisher' && links.length && w.door.status === 'pending') {
        await replace();
        approve();
      }
    };
    await assert.rejects(run({ fleetWorkflow, sleep }), { code: boundary === 'publisher' ? 'FLEET_DELIVERY_RELEASE_ASSET_CHANGED' : 'FLEET_DELIVERY_SEAL_NOT_CONFIRMED' });
    assert.equal(links.length, 1);
    if (boundary === 'confirm') assert.match(workflowRefusal, /FLEET_DELIVERY_RELEASE_ASSET_CHANGED/);
    else assert.ok(!(await w.assets()).some(a => a.name.endsWith('.acceptance.json')));
    assert.deepEqual(confirms, []);
    assert.equal(w.door.sealedDigest, undefined);
    assert.ok(!(await fs.readFile(w.index, 'utf8')).includes(GRANT));
    const { observationOf } = await import('../../src/fleet-self-pull.mjs');
    const repository = fixtureKit().record.repository;
    assert.equal(observationOf({ at: new Date(time.now).toISOString(), code: null, onDuty: false,
      fleetTarget: { repository, version: 'g000027', archive_sha256: w.source.archive_sha256, request_sha256: sha(await fs.readFile(w.requestFile)),
        grant_id: GRANT, receipt_id: GRANT_RECEIPT, accepted_at: w.door.acceptedAt, other_sources: [] } }, repository, time.now), null);
  });
});

test('出包前拒绝过期登记、无效收件绑定及被替换的暂存资产，零正式写入', async t => {
  for (const fault of ['stale', 'revoked', 'changed']) await t.test(fault, async t => {
    const w = await prepWorld(t, { version: 'g000027', released: false, spawnGh: false });
    const time = fakeTime('2026-11-27T01:00:00Z');
    const before = await fs.readFile(w.index);
    let tags = 0;
    const generationTags = { ...gen27Tags(w),
      create: async c => {
      tags++;
      return w.deps.generationTags.create(c);
    } };
    const fleetWorkflow = async (operation, candidate, details) => {
      assert.equal(candidate.commit, w.source.commit);
      return stagedProjection(operation, candidate, details, time, fault);
    };
    const sourceHash = async args => {
      if (fault === 'changed') {
        const bytes = await fs.readFile(args.artifactPath);
        bytes[0] ^= 1;
        await fs.writeFile(args.artifactPath, bytes);
      }
      return w.deps.sourceHash(args);
    };
    const result = await w.prep({ now: time.now, deps: { ...w.deps, ...prepareFixtures, clock: time.clock, generationTags, fleetWorkflow, sourceHash } })
      .catch(error => error);
    assert.deepEqual({ tags, releases: (await w.calls()).filter(c => c.args[0] === 'release' && c.args[1] === 'create').length,
      opens: (await w.opens()).length }, { tags: 0, releases: 0, opens: 0 });
    assert.deepEqual(await fs.readFile(w.index), before);
    assert.deepEqual(await w.assets(), []);
    await assert.rejects(fs.access(w.requestFile), { code: 'ENOENT' });
    assert.equal(result.code, fault === 'changed' ? 'PREPARE_STAGED_ASSET_CHANGED' : 'FLEET_DELIVERY_PREFLIGHT_REFUSED');
    if (fault !== 'changed') assert.equal(result.detail.reason, fault === 'stale' ? 'FLEET_REGISTRY_INCOMPLETE' : 'FLEET_RECIPIENT_BINDING_UNCONFIRMED');
  });
});

test('一次发布自动开单和续封，响应丢失沿用原 Grant 和接受摘要，批准后漂移阻断目标', async t => {
  for (const scenario of ['reply', 'restart', 'open-unknown', 'drift']) await t.test(scenario, async t => {
    const w = await prepWorld(t, { version: 'g000027', released: false, spawnGh: false });
    await fs.writeFile(w.state, JSON.stringify({ calls: [], assets: [], compare: 'identical', workflowLostReply: true }));
    const time = fakeTime('2026-11-27T01:00:00Z');
    w.door.status = 'none';
    if (scenario === 'open-unknown') w.door.openTo = 'none';
    let drift = scenario === 'drift';
    const phases = [], links = [], confirms = [];
    const fleetWorkflow = async (operation, candidate, details) => {
      phases.push(operation);
      if (operation === 'preflight') {
        assert.deepEqual(await w.assets(), []);
        return stagedProjection(operation, candidate, details, time);
      }
      const at = new Date(time.now).toISOString();
      if (operation === 'project') {
        const view = fleetProjection(candidate, at, drift && w.door.status === 'accepted' ? 'revoked' : null);
        return { first: view, last: view };
      }
      assert.equal(operation, 'confirm');
      assert.deepEqual([details.grantId, details.receiptId], [GRANT, GRANT_RECEIPT]);
      const asset = (await w.assets()).find(a => a.name.endsWith('.acceptance.json'));
      assert.equal(asset.sha256, details.acceptanceSha256);
      assert.ok(!(await fs.readFile(w.index, 'utf8')).includes(GRANT));
      confirms.push(details);
      w.door.sealedDigest = details.acceptanceSha256;
      if (scenario === 'restart') w.door.fail = 1;
      throw new Error('fixture lost the confirmation response');
    };
    const opts = { ...w.deps, ...prepareFixtures, clock: time.clock, sleep: time.sleep, ghCommand: w.gh,
      generationTags: gen27Tags(w), fleetWorkflow,
      admitRelease: async subject => { phases.push('admit'); return { ...subject, status: 'PASS' }; },
      onPending: link => {
        links.push(link);
        Object.assign(w.door, { status: 'accepted', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: '2026-11-27T01:00:00Z' });
      } };
    const args = ['publish', '--commit', w.source.commit, '--dir', w.build, '--out', w.out, '--image', w.image, '--index', w.index, '--wait', '5'];
    await assert.rejects(publishModule.main(args, { ...opts, admitRelease: async subject => ({ ...subject, commit: 'c'.repeat(40), status: 'PASS' }) }),
      { code: 'FLEET_RELEASE_ADMISSION_REFUSED' });
    assert.deepEqual(await w.assets(), []);
    assert.equal((await w.opens()).length, 0);
    const run = () => publishModule.main(args, opts);
    if (scenario === 'open-unknown') {
      assert.equal((await run()).status, 'FLEET_ACCEPTANCE_NOT_OPENED');
      assert.equal((await run()).status, 'FLEET_ACCEPTANCE_NOT_OPENED');
      assert.equal((await w.opens()).length, 1);
      w.door.status = 'pending';
    }
    if (scenario === 'restart') {
      await assert.rejects(run(), { code: 'FLEET_DELIVERY_SEAL_NOT_CONFIRMED' });
      assert.ok(!(await fs.readFile(w.index, 'utf8')).includes(GRANT));
    }
    if (drift) {
      await assert.rejects(run(), { code: 'FLEET_DELIVERY_PREFLIGHT_REFUSED' });
      assert.equal(confirms.length, 0);
      assert.ok(!(await w.assets()).some(a => a.name.endsWith('.acceptance.json')));
      const { observationOf } = await import('../../src/fleet-self-pull.mjs');
      assert.equal(observationOf({ at: new Date(time.now).toISOString(), code: null, onDuty: false,
        fleetTarget: { repository: fixtureKit().record.repository, version: 'g000027', archive_sha256: w.source.archive_sha256,
          request_sha256: sha(await fs.readFile(w.requestFile)), grant_id: GRANT, receipt_id: GRANT_RECEIPT,
          accepted_at: w.door.acceptedAt, other_sources: [] } }, fixtureKit().record.repository, time.now), null);
      drift = false;
    }
    const sealed = await run();
    assert.equal(sealed.status, 'FLEET_ACCEPTANCE_SEALED');
    assert.equal(sealed.grantId, GRANT);
    assert.equal(sealed.receiptId, GRANT_RECEIPT);
    assert.equal(sealed.acceptanceSha256, confirms[0].acceptanceSha256);
    assert.equal(sha(await fs.readFile(sealed.acceptance)), sealed.acceptanceSha256);
    assert.equal(links[0].resource, `fleet-node:${fixtureKit().record.repository}/g000027/${w.source.archive_sha256}/${sealed.requestSha256}`);
    assert.deepEqual(links.map(link => link.confirmUrl), [w.door.confirmUrl]);
    assert.equal((await w.opens()).length, 1);
    assert.equal(phases[0], 'admit');
    assert.deepEqual(phases.filter(phase => phase !== 'admit').slice(0, 3), ['preflight', 'project', 'project']);
    assert.equal(phases.filter(phase => phase === 'preflight').length, 1);
    assert.equal(confirms.length, 1);
    assert.ok((await fs.readFile(w.index, 'utf8')).includes(GRANT));
    assert.equal((await w.calls()).filter(c => c.args[0] === 'release' && c.args[1] === 'create').length, 1);
  });
});

test('第 27 代部分上传后沿用同一暂存请求、kit 和镜像', async t => {
  const w = await prepWorld(t, { version: 'g000027', released: false, spawnGh: false });
  const time = fakeTime('2026-11-27T01:00:00Z');
  const requests = [];
  let interrupt = true;
  const ghCommand = args => {
    if (interrupt && args[0] === 'release' && args[1] === 'upload' && path.basename(args[3]).startsWith('role-image-')) {
      interrupt = false;
      return { status: 1, stderr: 'fixture interrupted the image upload' };
    }
    return w.gh(args);
  };
  const prepare = () => w.prep({ ghCommand, now: time.now, deps: { ...w.deps, ...prepareFixtures, clock: time.clock,
    generationTags: gen27Tags(w), fleetWorkflow: async (phase, candidate, details) => {
      requests.push(candidate.requestSha256);
      return stagedProjection(phase, candidate, details, time);
    } } });
  await assert.rejects(prepare(), { code: 'PUBLISH_GH_RELEASE_UPLOAD_FAILED' });
  await assert.rejects(fs.access(w.requestFile), { code: 'ENOENT' });
  assert.equal((await w.opens()).length, 0);
  w.s.kitBroken = true;
  await fs.writeFile(w.image, 'different image at the original path');
  const result = await prepare();
  assert.deepEqual(requests, [result.requestSha256, result.requestSha256]);
  assert.equal(sha(await fs.readFile(w.requestFile)), result.requestSha256);
  assert.equal(w.s.kitReads, 1);
  assert.equal((await w.calls()).filter(c => c.args[0] === 'release' && c.args[1] === 'create').length, 1);
});

test('第 27 代统一发布的运输附件经回读验证，部分上传后续跑沿用原字节', async t => {
  const old = await world(t, 'g000026');
  const w = await prepWorld(t, { version: 'g000027', released: false, spawnGh: false });
  const { version, release_tag: tag, commit } = w.source;
  const oldTag = old.source.release_tag;
  const transportBase = path.join(old.build, `${oldTag}.tar`);
  const accepted = Buffer.from(JSON.stringify({ contract: publishModule.ACCEPTANCE_CONTRACT, repository: REPO,
    version: old.source.version, commit: old.source.commit, archive_sha256: old.source.archive_sha256 }));
  await fs.writeFile(w.state, JSON.stringify({ calls: [], assets: [], other: {
    [oldTag]: [{ name: `${oldTag}.acceptance.json`, size: accepted.length, b64: accepted.toString('base64') }]
  } }));
  const tags = w.deps.generationTags;
  const generationTags = { ...tags, list: async () => ['fleet-node-g000025', oldTag, ...await tags.list()],
    read: name => name === oldTag ? { contract: 'clued.independent-ci.fleet-package-generation/1', version: old.source.version,
      release_tag: oldTag, commit: old.source.commit, archive_sha256: old.source.archive_sha256 } : tags.read(name) };
  const time = fakeTime('2026-11-27T01:00:00Z');
  const freshAttachment = transportAssetNames(version, 'gzip').payload;
  const interruptedUpload = transportAssetNames(version, 'delta').meta;
  const candidateDir = path.join(w.out, `.${tag}.candidate`);
  let interrupted = false, corruptReadback = false;
  const readbacks = [];
  const ghCommand = args => {
    if (args[1]?.includes('/compare/main...')) return { status: 0, stdout: JSON.stringify({ status: 'identical' }) };
    if (!interrupted && args[0] === 'release' && args[1] === 'create') {
      interrupted = true;
      assert.ok(args.some(arg => path.basename(arg) === interruptedUpload));
      const created = w.gh(args.filter(arg => path.basename(arg) !== interruptedUpload));
      assert.equal(created.status, 0, created.stderr);
      return { status: 1, stderr: 'fixture interrupted the transport upload' };
    }
    const result = w.gh(args);
    if (args[0] === 'release' && args[1] === 'download' && result.status === 0) {
      const name = args[args.indexOf('--pattern') + 1];
      const directory = args[args.indexOf('--dir') + 1];
      if (name === freshAttachment && path.basename(path.dirname(directory)) === 'verify-transport') {
        readbacks.push(name);
        if (corruptReadback) {
          const file = path.join(directory, name);
          const bytes = readFileSync(file);
          bytes[0] ^= 1;
          writeFileSync(file, bytes);
        }
      }
    }
    return result;
  };
  const reconciliation = [];
  const release = {
    admit: async () => { reconciliation.push('admit'); },
    requirements: async () => [],
    read: async () => {
      reconciliation.push('read');
      return { runId: '81', snapshot: { base: true, applied: [], interfaces: {} } };
    },
  };
  const projections = [];
  w.door.status = 'none';
  const args = ['--commit', commit, '--dir', w.build, '--out', w.out, '--image', w.image, '--index', w.index, '--transport-base', transportBase];
  const run = (argv = ['publish', ...args, '--wait', '5']) => publishModule.main(argv, {
    ...w.deps, clock: time.clock, sleep: time.sleep, ghCommand, generationTags,
    release, readKit: () => fixtureKit(), verifyDeliveryTree: () => {},
    fleetWorkflow: async (phase, candidate, details) => {
      if (phase === 'preflight') {
        projections.push(candidate.requestSha256);
        return stagedProjection(phase, candidate, details, time);
      }
      if (phase === 'project') {
        const view = fleetProjection(candidate, new Date(time.now).toISOString());
        return { first: view, last: view };
      }
      assert.equal(phase, 'confirm');
      w.door.sealedDigest = details.acceptanceSha256;
      return { status: 'sealed', ...details };
    },
    onPending: () => Object.assign(w.door, { status: 'accepted', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: '2026-11-27T01:00:00Z' }),
  });
  await assert.rejects(run(), { code: 'PUBLISH_GH_RELEASE_CREATE_FAILED' });
  assert.deepEqual(reconciliation, ['admit', 'read', 'admit']);
  assert.equal((await w.opens()).length, 0);
  await assert.rejects(fs.access(w.requestFile), { code: 'ENOENT' });
  const heldRequest = await fs.readFile(path.join(candidateDir, `${tag}.acceptance-request.json`));
  const heldTransport = await fs.readFile(path.join(candidateDir, freshAttachment));
  const heldReceipt = await fs.readFile(path.join(candidateDir, 'candidate.SHA256SUMS'), 'utf8');
  const publishedSums = Buffer.from((await w.assets()).find(asset => asset.name === 'SHA256SUMS').b64, 'base64');
  assert.ok(heldReceipt.includes(`${sha(heldTransport)}  ${freshAttachment}\n`));
  await fs.unlink(transportBase);
  corruptReadback = true;
  await assert.rejects(run(['prepare', ...args]), { code: 'PUBLISH_RELEASE_ASSET_CHANGED', detail: freshAttachment });
  assert.equal((await w.opens()).length, 0);
  await assert.rejects(fs.access(w.requestFile), { code: 'ENOENT' });
  corruptReadback = false;
  const result = await run();
  assert.equal(result.status, 'FLEET_ACCEPTANCE_SEALED');
  assert.equal(result.requestSha256, sha(heldRequest));
  assert.deepEqual(reconciliation, Array.from({ length: 3 }, () => ['admit', 'read', 'admit']).flat());
  assert.deepEqual([result.migrationAdmission.commit, result.migrationAdmission.readRunId, result.migrationAdmission.dispatched], [commit, '81', []]);
  assert.deepEqual(projections, Array(3).fill(result.requestSha256));
  assert.deepEqual(readbacks, [freshAttachment, freshAttachment]);
  const assets = new Map((await w.assets()).map(asset => [asset.name, Buffer.from(asset.b64, 'base64')]));
  assert.deepEqual(assets.get(`${tag}.tar`), w.tar);
  assert.deepEqual(assets.get(`${tag}.acceptance-request.json`), heldRequest);
  assert.deepEqual(await fs.readFile(w.requestFile), heldRequest);
  assert.equal(JSON.parse(assets.get(`${tag}.acceptance.json`)).archive_sha256, w.source.archive_sha256);
  assert.deepEqual(assets.get('SHA256SUMS'), publishedSums);
  assert.doesNotMatch(assets.get('SHA256SUMS').toString(), /transport-|\.delta\.gz|\.tar\.gz/);
  const manifest = assets.get(`${tag}.candidate.SHA256SUMS`);
  assert.equal(sha(manifest), JSON.parse(heldRequest).deliveryAssetsSha256);
  assert.doesNotMatch(manifest.toString(), /transport-|\.delta\.gz/);
  for (const kind of ['gzip', 'delta']) {
    const { meta, payload } = transportAssetNames(version, kind);
    assert.equal(JSON.parse(assets.get(meta)).sha256, sha(assets.get(payload)));
  }
  assert.deepEqual(assets.get(freshAttachment), heldTransport);
  assert.equal((await uploadsOf(w)).filter(call => path.basename(call.args[3]) === interruptedUpload).length, 1);
  assert.equal((await w.opens()).length, 1);
});

test('两台待定节点在心跳中断、代次混合时使用同一 Grant 封存', async t => {
  const w = await prepWorld(t, { version: 'g000026', released: false, spawnGh: false });
  const listTags = w.deps.generationTags.list;
  w.deps.generationTags.list = async () => [...await listTags(), 'fleet-node-g000025'];
  await w.prep();
  const time = fakeTime('2026-11-25T01:00:01Z');
  const at = '2026-11-25T01:00:00Z';
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const first = { ...legacyNode('89855b40-1111-4111-8111-111111111111', 'desk-w-591', 'ACTIVE', at), state: 'pending' };
  const second = { ...legacyNode('b24be772-2222-4222-8222-222222222222', 'TURING', 'STANDBY', at), state: 'pending' };
  const spawnSync = childProcess.spawnSync;
  const mock = t.mock.method(childProcess, 'spawnSync', (command, args, options) => command === 'gh'
    ? w.gh(args) : spawnSync(command, args, options));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  let readCount = 0;
  const confirmations = [];
  const fleetWorkflow = async (operation, candidate, seal) => {
    if (operation === 'confirm') {
      assert.equal(seal.grantId, GRANT);
      assert.equal(seal.receiptId, GRANT_RECEIPT);
      assert.ok((await w.assets()).some(a => a.name.endsWith('.acceptance.json')));
      confirmations.push(seal);
      w.door.sealedDigest = seal.acceptanceSha256;
      return { status: 'sealed', ...seal };
    }
    assert.equal(operation, 'project');
    assert.deepEqual([candidate.version, candidate.commit, candidate.archiveSha256, candidate.sourceSha256, candidate.requestSha256, candidate.kitSha256],
      [request.version, request.commit, request.archive_sha256, request.ciSourceManifestSha256, sha(await fs.readFile(w.requestFile)), request.firstInstallKitSha256]);
    const nodes = [{ ...first, generation: ++readCount === 1 ? null : 26 }, { ...second, serviceRunning: false }];
    const projection = { candidate, repository: candidate.repository, scope: candidate.scope, complete: true, observedAt: at, nodes };
    return { first: projection, last: { ...projection, nodes: nodes.map(n => ({ ...n, heartbeatSequence: n.heartbeatSequence + 1 })) } };
  };
  const deps = { ...w.deps, fleetWorkflow, clock: time.clock, sleep: time.sleep };
  const { main } = await import('../fleet/accept.mjs');
  const upgrades = [];
  const accept = (command, ...extra) => main([command, '--request', w.requestFile, ...extra], {
    sealOptions: { index: w.index, deps }, root: path.join(w.d, 'node'), now: time.clock, sleep: time.sleep, readStatus: w.deps.readStatus,
    upgrade: async argv => { upgrades.push(argv); return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', node: first.name }; },
  });
  Object.assign(w.door, { status: 'none', openTo: 'pending' });
  const opened = await accept('open');
  assert.equal(opened.status, 'FLEET_ACCEPTANCE_WAITING_OWNER', JSON.stringify(opened));
  assert.equal((await w.opens()).length, 1);
  Object.assign(w.door, { status: 'accepted', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: at,
    nodes: [first, second].map(n => ({ name: n.name, source_sha256: request.ciSourceManifestSha256, paused: false })) });
  const uploaded = (await uploadsOf(w)).length;
  const work = path.join(w.d, 'work');
  assert.equal((await accept('run', '--work', work)).status, 'ROLLOUT_DONE');
  assert.equal((await w.opens()).length, 1);
  assert.equal((await uploadsOf(w)).length, uploaded + 1);
  assert.equal(confirmations.length, 1);
  assert.equal(readCount, 2);

});

// PLAN-accept-align-open-20261125 1.2 (red before: a rejected request was opened again, one gh workflow run, and answered WAITING_OWNER)
// the Owner's "reject" is final (the door replays rejected and never opens it again): seal reading rejected, at the start or after waiting,
// with or without --wait, answers REJECTED at once; no workflow run, no sleep, nothing written, the command exits non-zero
test('seal on a rejected request: FLEET_ACCEPTANCE_REJECTED at once, at the start and with --wait; never a gh workflow run, nothing written, exit non-zero', async t => {
  for (const wait of [0, 30]) {
    const w = await prepWorld(t);
    await w.prep();
    w.door.status = 'rejected';
    const time = fakeTime('2026-11-25T01:00:00Z');
    const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
    const r = await timed(w, time, { wait });
    assert.deepEqual([r.status, r.answer, (await w.opens()).length], ['FLEET_ACCEPTANCE_REJECTED', 'rejected', 0], `wait ${wait}: rejected is final, never opened again`);
    assert.deepEqual(time.slept, [], `wait ${wait}: answered at once`);
    assert.equal(w.door.reads.length, 1, `wait ${wait}: one read`);
    assert.match(r.next, /new version/, `wait ${wait}: next names a new version, not the same seal again`);
    await sealedNothing(w, before, n);
    assert.notEqual(publishModule.exitCodeOf(r), 0);
  }
});


// Task 87d330d0 step 3: the two cases of the test above that its red run never reached, each on its own.
// (red before: --wait 60 waited the whole hour for the link and answered WAITING_OWNER opened:false)
test('seal --wait 60 on a request the workflow does not open: NOT_OPENED 15 minutes after its one run, not after the wait', async t => {
  const w = await prepWorld(t);
  await w.prep();
  Object.assign(w.door, { status: 'none', openTo: 'none' });
  const time = fakeTime('2026-11-25T01:00:00Z');
  const start = time.now, before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  const r = await timed(w, time, { wait: 60 });
  assert.equal(r.status, 'FLEET_ACCEPTANCE_NOT_OPENED', JSON.stringify({ status: r.status, opened: r.opened ?? null, confirmUrl: r.confirmUrl ?? null, minutes: (time.now - start) / 60_000 }));
  assert.equal(time.now - start, 15 * 60_000, 'the wait is for the Owner, the run is given 15 minutes');
  assert.equal((await w.opens()).length, 1, 'one workflow run');
  await sealedNothing(w, before, n);
  assert.notEqual(publishModule.exitCodeOf(r), 0);
});

// (red before: the read that failed after the run threw ACCEPT_DOOR_UNAVAILABLE, and the caller ran seal again: a second run)
test('seal: a door that cannot be read after its one run answers NOT_OPENED at 15 minutes, never a throw', async t => {
  const w = await prepWorld(t);
  await w.prep();
  Object.assign(w.door, { status: 'none', openTo: 'none' });
  const time = fakeTime('2026-11-25T01:00:00Z', () => { w.door.fail = 1e9; });
  const start = time.now, before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  let r;
  try { r = await timed(w, time, { wait: 0 }); } catch (e) { assert.fail(`seal threw ${e?.code ?? e} after ${(time.now - start) / 60_000} minutes`); }
  assert.equal(r.status, 'FLEET_ACCEPTANCE_NOT_OPENED', JSON.stringify(r));
  assert.equal(time.now - start, 15 * 60_000);
  assert.equal((await w.opens()).length, 1, 'one workflow run');
  assert.ok(w.door.reads.length >= 3, 'read again while there was time');
  await sealedNothing(w, before, n);
  assert.notEqual(publishModule.exitCodeOf(r), 0);
});


// Task 87d330d0 alignment: accept.mjs (part C) on part B's real seal and readFleet, reached through accept.mjs's own defaults (open gives
// seal wait 0, run one seal the whole --wait; deps.sealOptions and deps.readStatus give them this world's index, gh and door; nothing
// else is faked on B's side).
const acceptWorld = async (t, onSleep) => {
  const w = await prepWorld(t);
  await w.prep();
  const time = fakeTime('2026-11-25T01:00:00Z', onSleep);
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const upgrades = [];
  const deps = { sealOptions: { index: w.index, ghCommand: [process.execPath, w.fake], deps: { ...w.deps, clock: time.clock, sleep: time.sleep } },
    readStatus: w.deps.readStatus, now: time.clock, sleep: time.sleep, root: path.join(w.d, 'root'),
    upgrade: async argv => { upgrades.push(argv); return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', node: 'DESK' }; } };
  const { main: acceptMain, exitCodeOf: acceptExit } = await import('../fleet/accept.mjs');
  const run = (...extra) => acceptMain(['run', '--request', w.requestFile, '--work', path.join(w.d, 'work'), ...extra], deps);
  const open = () => acceptMain(['open', '--request', w.requestFile], deps);
  return { w, time, request, upgrades, run, open, acceptExit };
};

test('accept.mjs on the real seal and readFleet: open opens the request once and gives the link; approved, run seals and reads the fleet off the door', async t => {
  const { w, request, upgrades, run, open, acceptExit } = await acceptWorld(t);
  w.door.status = 'none';
  const opened = await open();
  assert.equal(opened.status, 'FLEET_ACCEPTANCE_WAITING_OWNER', JSON.stringify(opened));
  assert.equal(opened.confirmUrl, w.door.confirmUrl);
  assert.equal(acceptExit(opened), 0);
  assert.equal((await w.opens()).length, 1, 'one workflow run');
  // the Owner approves on the page; the in-service nodes report the accepted Source. Part A's answer as its migration writes it
  // (5b8aa67c2, PLAN-accept-align-open-20261125 3.2): the nodes in state active or draining, by name, so a registered node never approved
  // (state pending) is not in it and cannot hold the fleet back; a draining one is
  const at = request.ciSourceManifestSha256;
  Object.assign(w.door, { status: 'accepted', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: '2026-11-25T01:02:03.456789+00:00',
    nodes: [{ name: 'DESK', source_sha256: at, paused: false }, { name: 'LEAVING', source_sha256: at, paused: false }, { name: 'TURING', source_sha256: at, paused: false }] });
  const done = await run();
  assert.equal(done.status, 'ROLLOUT_DONE', JSON.stringify(done));
  assert.deepEqual(done.nodes, ['DESK', 'LEAVING', 'TURING']);
  assert.equal(upgrades.length, 1);
  assert.ok((await w.assets()).some(a => a.name === `${TAG}.acceptance.json`), 'sealed on the Release');
  assert.equal((await w.opens()).length, 1, 'still one workflow run');
  // TURING not there yet: the door says so, and run names it
  w.door.nodes = [{ name: 'DESK', source_sha256: at, paused: false }, { name: 'LEAVING', source_sha256: at, paused: false }, { name: 'TURING', source_sha256: 'a'.repeat(64), paused: false }];
  const waiting = await run();
  assert.equal(waiting.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(waiting));
  assert.deepEqual(waiting.pending.map(n => n.node), ['TURING']);
  const acceptModule = await import('../fleet/accept.mjs');
  assert.equal(acceptModule.SEAL_INPUT_ERRORS, publishModule.SEAL_INPUT_ERRORS, 'accept.mjs stops on seal\'s own list');
});

// PLAN-accept-align-open-20261125 1.2 and 1.4 (red before, a todo: run asked seal (wait 0) again, and seal opened a new request on the
// rejected it read at its start): the Owner's no is final; the one seal run gives answers REJECTED and no request is ever opened
test('accept.mjs run on the real seal: the Owner rejects the request it waits on -> ROLLOUT_STOPPED, no new request', async t => {
  let wr = null;
  const { w, run, acceptExit } = await acceptWorld(t, tt => { if (tt.slept.length === 1) wr.door.status = 'rejected'; });
  wr = w;
  w.door.status = 'pending';
  const r = await run('--wait', '10');
  assert.equal(r.status, 'ROLLOUT_STOPPED', JSON.stringify(r));
  assert.deepEqual([r.stage, r.code, r.answer], ['accept', 'FLEET_ACCEPTANCE_REJECTED', 'rejected']);
  assert.match(r.next, /new version/);
  assert.equal(acceptExit(r), 1);
  assert.deepEqual(await w.opens(), [], 'no request opened after the Owner said no');
  // the same command again (a lost process restarted, a rerun): still no request
  const again = await run();
  assert.equal(again.status, 'ROLLOUT_STOPPED', JSON.stringify(again));
  assert.deepEqual(await w.opens(), [], 'never opened again');
});

// PLAN-accept-align-open-20261125 2.4 (red before: run asked seal (wait 0) again every 30-120 s and each look that found no request
// dispatched once more, for the whole wait; it ended ROLLOUT_WAITING_OWNER FLEET_ACCEPTANCE_OPEN_QUEUED)
test('accept.mjs run on the real seal: a request the workflow never opens is ROLLOUT_STOPPED FLEET_ACCEPTANCE_NOT_OPENED 15 minutes after its one run', async t => {
  const { w, time, run, acceptExit } = await acceptWorld(t);
  Object.assign(w.door, { status: 'none', openTo: 'none' });
  const start = time.now;
  const r = await run('--wait', '60');
  assert.deepEqual([r.status, r.code, (await w.opens()).length], ['ROLLOUT_STOPPED', 'FLEET_ACCEPTANCE_NOT_OPENED', 1], JSON.stringify({ ...r, runs: (await w.opens()).length }));
  assert.equal(r.stage, 'accept');
  assert.equal(time.now - start, 15 * 60_000, 'stopped 15 minutes after the run, not at the end of the wait');
  assert.match(r.next, /fleet-accept/);
  assert.equal(acceptExit(r), 1);
});

// PLAN-accept-align-open-20261125 2.1 item 3 and 2.4 (red before: each look of run was a whole seal, which downloaded the Release's tar
// again): the Owner not answering for the whole wait is one seal, one download, no workflow run; then the default wait (a day) likewise
test('accept.mjs run on the real seal: the Owner does not answer for the whole wait: one download of the tar, no workflow run, ROLLOUT_WAITING_OWNER with the link', async t => {
  const { w, time, run, acceptExit } = await acceptWorld(t);
  w.door.status = 'pending';
  const tarsOf = calls => calls.filter(c => c.args[0] === 'release' && c.args[1] === 'download' && c.args[c.args.indexOf('--pattern') + 1] === `${TAG}.tar`).length;
  for (const [extra, minutes] of [[['--wait', '60'], 60], [[], 24 * 60]]) {
    const before = (await w.calls()).length, start = time.now;
    const r = await run(...extra);
    const calls = (await w.calls()).slice(before);
    assert.deepEqual([r.status, tarsOf(calls), calls.filter(c => c.args[0] === 'workflow').length], ['ROLLOUT_WAITING_OWNER', 1, 0],
      `${minutes} minutes: ${JSON.stringify({ status: r.status, code: r.code ?? null, tars: tarsOf(calls) })}`);
    assert.equal(r.confirmUrl, w.door.confirmUrl);
    assert.equal(time.now - start, minutes * 60_000, `${minutes} minutes waited`);
    assert.equal(acceptExit(r), 2);
  }
});

test('返修 7：真实 seal 场景由 resident-node 定向入口收录', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const file = path.relative(root, fileURLToPath(import.meta.url));
  const plan = planFiles('resident-node', { root, files: [file] });
  assert.equal(plan.steps.length, 1);
});

test('返修 2b：open 前置校验超过预算时不派发', async t => {
  const { w, time } = await acceptWorld(t);
  Object.assign(w.door, { status: 'none', openTo: 'none' });
  const start = time.now;
  const { main } = await import('../fleet/accept.mjs');
  const result = await main(['open', '--request', w.requestFile], {
    now: time.clock,
    sealOptions: { index: w.index, ghCommand: [process.execPath, w.fake], deps: {
      ...w.deps, clock: time.clock, sleep: time.sleep,
      sourceHash: async args => {
        await time.sleep(6 * 60_000);
        return w.deps.sourceHash(args);
      },
    } },
  });
  assert.deepEqual([(await w.opens()).length, result.code, time.now - start], [0, 'FLEET_ACCEPTANCE_DEADLINE', 6 * 60_000], JSON.stringify(result));
});

test('返修 2c：GitHub 校验子进程受绝对终点约束', async t => {
  const w = await prepWorld(t);
  await w.prep();
  w.door.status = 'none';
  const time = fakeTime('2026-11-25T01:00:00Z');
  const deadline = time.now + 500;
  const spawnSync = childProcess.spawnSync;
  // Simulate a compare that takes 8 seconds using the timeout supplied to the child process.
  const spawn = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (command === process.execPath && args[0] === w.fake && args[1] === 'api' && args[2]?.includes('/compare/')) {
      if (options?.timeout > 0 && options.timeout < 8_000) {
        time.now += options.timeout;
        return { status: null, error: Object.assign(new Error('模拟 GitHub 校验超时'), { code: 'ETIMEDOUT' }) };
      }
      time.now += 8_000;
    }
    return spawnSync(command, args, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(timed(w, time, { wait: 1, deadline }), { code: 'FLEET_ACCEPTANCE_DEADLINE' });
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(w.door.reads, [], 'GitHub 校验超时后不得读门');
  assert.deepEqual(await w.opens(), [], 'GitHub 校验超时后不得派发工作流');
});

test('返修 6a：run 派发后在结束前告知首个有效确认链接', async t => {
  const { w, time } = await acceptWorld(t);
  for (const start of ['none', 'expired']) {
    Object.assign(w.door, { status: start });
    const events = [];
    const { main } = await import('../fleet/accept.mjs');
    const result = await main(['run', '--request', w.requestFile, '--work', path.join(w.d, 'work'), '--wait', '1'], {
      now: time.clock, sleep: time.sleep, root: path.join(w.d, 'root'),
      sealOptions: { index: w.index, ghCommand: [process.execPath, w.fake], deps: { ...w.deps, clock: time.clock, sleep: time.sleep } },
      onPending: event => events.push({ ...event, at: time.now }),
    });
    assert.equal(result.status, 'ROLLOUT_WAITING_OWNER', start);
    assert.equal(events.length, 1, start);
    assert.equal(events[0].confirmUrl, w.door.confirmUrl);
    assert.ok(events[0].at < time.now);
  }
});

test('返修 1：过期时读超时', async t => {
  const start = '2026-11-25T01:00:00Z';
  const time = fakeTime(start);
  const w = await prepWorld(t);
  await w.prep();
  Object.assign(w.door, { status: 'pending', expiresAt: '2026-11-25T01:00:30Z' });
  const timeouts = [];
  const readStatus = async (resource, { timeoutMs = 30_000 } = {}) => {
    if (w.door.reads.length === 0) return w.deps.readStatus(resource);
    timeouts.push(timeoutMs);
    await time.sleep(timeoutMs);
    throw Object.assign(new Error('timed out'), { code: 'ACCEPT_DOOR_UNAVAILABLE' });
  };
  const r = await timed(w, time, { wait: 60, deps: { ...w.deps, readStatus, clock: time.clock, sleep: time.sleep } });
  assert.ok(r.status === 'FLEET_ACCEPTANCE_UNREADABLE' && !r.confirmUrl && time.now <= Date.parse(w.door.expiresAt), JSON.stringify({ status: r.status, expiresAt: r.expiresAt, waitedMs: time.now - Date.parse(start) }));
  assert.deepEqual(timeouts, [1000], 'the last read uses the time remaining until expiry');
  assert.deepEqual(await w.opens(), []);
  Object.assign(w.door, { status: 'expired', expiresAt: '2026-11-26T01:00:30Z' });
  const again = await timed(w, time);
  assert.equal(again.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  assert.equal((await w.opens()).length, 1);
});
test('返修 3：连续非暂态读错', async t => {
  const { w, run } = await acceptWorld(t);
  let reads = 0;
  w.door.answer = (_resource, base) => {
    if (++reads <= 8 && reads % 2 === 0) throw Object.assign(new Error('403 refused'), { code: 'ACCEPT_DOOR_REFUSED' });
    return { ...base, status: 'none' };
  };
  const before = (await w.calls()).length;
  const r = await run('--wait', '60');
  const calls = (await w.calls()).slice(before);
  const workflows = calls.filter(c => c.args[0] === 'workflow').length;
  const tars = calls.filter(c => c.args[1] === 'download' && c.args[c.args.indexOf('--pattern') + 1] === TAG + '.tar').length;
  assert.deepEqual([workflows, tars, r.code], [1, 1, 'ACCEPT_DOOR_REFUSED'], JSON.stringify({ workflows, tars, status: r.status, code: r.code }));
});

test('返修 3b：派发响应丢失后只读门，沿用本次已校验的包', async t => {
  const { w, run } = await acceptWorld(t);
  w.door.status = 'none';
  await w.setState(st => { st.workflowLostReply = true; });
  const before = (await w.calls()).length;
  const result = await run('--wait', '1');
  const calls = (await w.calls()).slice(before);
  assert.deepEqual([result.status, result.confirmUrl, (await w.opens()).length], ['ROLLOUT_WAITING_OWNER', w.door.confirmUrl, 1]);
  assert.equal(calls.filter(c => c.args[0] === 'api').length, 1, 'only one preflight');
});
test('返修 5：open 保留拒绝终局和文案', async t => {
  const { w, open } = await acceptWorld(t);
  w.door.status = 'rejected';
  const r = await open();
  assert.ok(r.answer === 'rejected' && /new version/.test(r.next ?? ''), JSON.stringify(r));
});
test('返修 2a：起跑满 24 小时不再投节点请求', async t => {
  const { w } = await acceptWorld(t);
  let clock = 0, upgrades = 0;
  const { main } = await import('../fleet/accept.mjs');
  const r = await main(['run', '--request', w.requestFile, '--work', path.join(w.d, 'work')], {
    root: path.join(w.d, 'root'), now: () => clock,
    seal: async () => { clock += 24 * 3600_000 + 1; return { status: 'FLEET_ACCEPTANCE_SEALED' }; },
    upgrade: async () => { upgrades++; return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', node: 'fixture' }; },
    readFleet: async () => [],
  });
  assert.equal(upgrades, 0, JSON.stringify({ upgrades, clock, status: r.status }));
});

test('返修 4：冷目录封存后本机升级只下载一次 tar', async t => {
  const { w, time, request } = await acceptWorld(t);
  const { createServer } = await import('node:http');
  const { fetchPackage } = await import('../fleet/fetch.mjs');
  const { main } = await import('../fleet/accept.mjs');
  const names = [TAG + '.acceptance.json', 'SHA256SUMS', TAG + '.tar'];
  const bodies = [
    () => fs.readFile(path.join(w.out, TAG + '.acceptance.json')),
    () => fs.readFile(path.join(w.build, 'SHA256SUMS')),
    () => w.tar,
  ];
  let upgradeTar = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.url.endsWith('/releases/tags/' + TAG)) {
        const assets = await Promise.all(names.map(async (name, id) => ({ name, id, size: (await bodies[id]()).length })));
        return res.end(JSON.stringify({ assets }));
      }
      if (req.url.includes('/releases/assets/')) {
        res.writeHead(302, { location: '/blob/' + req.url.split('/').at(-1) });
        return res.end();
      }
      const i = Number(req.url.split('/').at(-1));
      if (i === 2) upgradeTar++;
      return res.end(await bodies[i]());
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const before = (await w.calls()).length;
  const r = await main(['run', '--request', w.requestFile, '--work', path.join(w.d, 'clean')], {
    sealOptions: { index: w.index, ghCommand: [process.execPath, w.fake], deps: { ...w.deps, clock: time.clock, sleep: time.sleep } },
    now: time.clock, root: path.join(w.d, 'root'),
    upgrade: async argv => {
      const after = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
      await fetchPackage({ version: after('--version'), repo: after('--repo'), dir: path.join(after('--work'), 'dl'),
        from: after('--from'), apiBase: 'http://127.0.0.1:' + server.address().port, getToken: () => 'fake',
        deadlineMs: 1000 });
      return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', node: 'DESK' };
    },
    readFleet: async () => [{ node: 'DESK', ciSourceManifestSha256: request.ciSourceManifestSha256, paused: false }],
  });
  assert.equal(r.status, 'ROLLOUT_DONE', JSON.stringify(r));
  const sealTar = (await w.calls()).slice(before).filter(c => c.args[1] === 'download' && c.args[c.args.indexOf('--pattern') + 1] === TAG + '.tar').length;
  assert.equal(sealTar + upgradeTar, 1, JSON.stringify({ sealTar, upgradeTar }));
});
test('登记缺口在开接受门之前阻断，零派发', async t => {
  const w = await prepWorld(t);
  await w.prep();
  w.door.status = 'none';
  const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  const time = fakeTime('2026-11-25T01:00:00Z');
  await assert.rejects(timed(w, time, { deps: { ...w.deps, readFleetRegistry: async () => ({ complete: false, nodes: [] }), clock: time.clock, sleep: time.sleep } }),
    { code: 'FLEET_DELIVERY_PREFLIGHT_REFUSED' });
  assert.equal((await w.opens()).length, 0);
  await sealedNothing(w, before, n);
});

test('批准后登记快照不完整时阻断挂接受文件', async t => {
  const w = await prepWorld(t);
  await w.prep();
  Object.assign(w.door, { status: 'accepted', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: '2026-11-25T01:00:00Z' });
  const time = fakeTime('2026-11-25T01:00:01Z');
  const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  let reads = 0;
  const row = legacyNode('22222222-2222-4222-8222-222222222222', 'TURING', 'STANDBY', new Date(time.now).toISOString());
  const readFleetRegistry = async candidate => ({ complete: ++reads < 3, repository: candidate.repository,
    scope: candidate.scope, observedAt: new Date(time.now).toISOString(), nodes: [row] });
  await assert.rejects(timed(w, time, { deps: { ...w.deps, readFleetRegistry, clock: time.clock, sleep: time.sleep } }),
    { code: 'FLEET_DELIVERY_PREFLIGHT_REFUSED' });
  assert.equal(reads, 3);
  await sealedNothing(w, before, n);
});
test('完整的空登记集可以封存，退役和撤销节点不收件', async () => {
  const { fleetDeliveryPreflight } = await import('../fleet/delivery-preflight.mjs');
  const observedAt = '2026-11-25T01:00:00Z';
  const candidate = { repository: 'fixture/repo', scope: 'global', version: 'g000025' };
  const check = nodes => fleetDeliveryPreflight({ candidate, clock: () => Date.parse(observedAt),
    readFleetRegistry: async () => ({ ...candidate, complete: true, observedAt, nodes }) });
  for (const nodes of [[], [{ id: '22222222-2222-4222-8222-222222222222', name: 'LEFT', state: 'retired' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'REVOKED', state: 'revoked' }]]) {
    const result = await check(nodes);
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.nodes, []);
  }
});

test('登记范围、收件绑定、重复身份和登记并发改变继续阻断发布', async () => {
  const { fleetDeliveryPreflight } = await import('../fleet/delivery-preflight.mjs');
  const at = '2026-11-25T01:00:00Z';
  const candidate = { repository: 'fixture/repo', scope: 'global', version: 'g000026' };
  const row = legacyNode('22222222-2222-4222-8222-222222222222', 'TURING', 'ACTIVE', at);
  const check = async (nodes, end = nodes, repository = candidate.repository) => {
    let reads = 0;
    return fleetDeliveryPreflight({ candidate, clock: () => Date.parse(at),
      readFleetRegistry: async () => ({ ...candidate, repository, complete: true, observedAt: at, nodes: reads++ === 0 ? nodes : end }) });
  };
  for (const change of [{ bindingLive: false }, { bindingGeneration: null }, { rebindPending: true }]) {
    assert.equal((await check([{ ...row, ...change }])).reason, 'FLEET_RECIPIENT_BINDING_UNCONFIRMED');
  }
  assert.equal((await check([row, { ...row, bindingGeneration: 3 }])).reason, 'FLEET_REGISTRY_INCOMPLETE');
  assert.equal((await check([row], [{ ...row, bindingGeneration: 3 }])).reason, 'FLEET_REGISTRY_CHANGED');
  assert.equal((await check([row], [row], 'another/repo')).reason, 'FLEET_REGISTRY_INCOMPLETE');
});

test('发布收件资格与节点的已装代次和运行证据无关', async () => {
  const { fleetDeliveryPreflight } = await import('../fleet/delivery-preflight.mjs');
  const { deliveryProjectionReaders } = await import('../fleet/delivery-reader.mjs');
  const at = '2026-11-27T11:12:00Z';
  const clock = () => Date.parse(at);
  const candidate = { repository: 'fixture/repo', scope: 'global', version: 'g000026' };
  const requirements = { standardReinstall: true };
  const first = legacyNode('11111111-1111-4111-8111-111111111111', 'DESK', 'ACTIVE', at);
  const second = legacyNode('22222222-2222-4222-8222-222222222222', 'TURING', 'STANDBY', at);
  const withEvidence = row => ({ ...row, evidence: { schemaVersion: 1, nodeId: row.id, packageGeneration: 25, installGeneration: 7,
    bindingGeneration: row.bindingGeneration, registrationVersion: row.registrationVersion, currentHeartbeat: true,
    observedAt: at, brokerObservedAt: at, linuxObservedAt: at,
    windowsSourceSha256: row.reportedSourceSha256, linuxSourceSha256: row.reportedSourceSha256,
    installReceiptSha256: 'a'.repeat(64), brokerEvidenceSha256: 'b'.repeat(64), linuxFactsSha256: 'c'.repeat(64), evidenceSha256: 'e'.repeat(64),
    linuxReady: true, linuxConsistent: true, acl: true, connectionCarry: true, operations: true, processClearance: true } });
  const check = async nodes => {
    const view = { ...candidate, candidate, complete: true, observedAt: at, nodes };
    const readers = deliveryProjectionReaders({ read: async () => ({ first: view, last: view }), requirements, clock });
    return fleetDeliveryPreflight({ candidate, requirements, clock, ...readers });
  };
  const mixed = await check([withEvidence(first), second]);
  assert.equal(mixed.status, 'PASS');
  assert.deepEqual(mixed.nodes.map(node => node.id), [first.id, second.id]);
  const ready = await check([withEvidence(first), withEvidence(second)]);
  assert.equal(ready.status, 'PASS');
  assert.equal(ready.registrySha256, mixed.registrySha256);
});

test('直派发布工作流使用同一预检，登记读取通过后才进入开单 SQL', async () => {
  const { qualifyDelivery } = await import('../../../../scripts/ci/clued-fleet-accept.mjs');
  const candidate = { repository: 'fixture/repo', scope: 'global', version: 'g000027' };
  const at = '2026-11-25T01:00:00Z';
  const nodes = [legacyNode('11111111-1111-4111-8111-111111111111', 'DESK', 'ACTIVE', at),
    legacyNode('22222222-2222-4222-8222-222222222222', 'TURING', 'STANDBY', at)];
  const snapshotToken = 'a'.repeat(64);
  const input = { action: 'fleet.accept', delivery: { operation: 'open', candidate, requirements: { standardReinstall: true } } };
  const calls = [];
  let bindingLive = false;
  const database = async (operation, subject) => {
    calls.push(operation);
    if (operation === 'open') {
      assert.deepEqual(subject.delivery, { candidate, snapshotToken });
      return { status: 'pending' };
    }
    const registered = [nodes[0], { ...nodes[1], bindingLive, reportedState: 'HALTED' }];
    return { candidate, repository: candidate.repository, scope: candidate.scope, observedAt: at, complete: true, snapshotToken, nodes: registered };
  };
  await assert.rejects(qualifyDelivery(input, database, () => Date.parse(at)), /FLEET_DELIVERY_PREFLIGHT_REFUSED/);
  assert.deepEqual(calls, ['project', 'project']);
  bindingLive = true;
  assert.deepEqual(await qualifyDelivery(input, database, () => Date.parse(at)), { status: 'pending' });
  assert.deepEqual(calls.slice(2), ['project', 'project', 'open']);
});

test('发布工作流只接收本次主线调度的加密登记回包', async () => {
  const { deliveryWorkflowClient, deliveryWorkflowPacket } = await import('../fleet/delivery-workflow.mjs');
  const candidate = { repository: 'fixture/repo', version: 'g000025', requestSha256: 'a'.repeat(64) };
  const result = { first: { complete: true, nodes: [{ name: 'private fixture' }] }, last: { complete: true } };
  let packet, tamper = false;
  const runGh = args => {
    if (args[0] === 'workflow') {
      const key = args.find(a => a.startsWith('fleet_delivery_key=')).split('=')[1];
      packet = deliveryWorkflowPacket({ operation: 'project', candidate,
        result }, key, tamper ? 'b'.repeat(64) : candidate.requestSha256);
      assert.ok(!packet.includes('private fixture'));
      return { status: 0, stdout: 'https://github.com/fixture/repo/actions/runs/81\n' };
    }
    assert.deepEqual(args.slice(0, 7), ['run', 'view', '81', '--repo', candidate.repository, '--attempt', '1']);
    return { status: 0, stdout: args.includes('--log') ? 'release\tcheck\t' + packet + '\n' :
      JSON.stringify({ status: 'completed', conclusion: 'success', attempt: 1, event: 'workflow_dispatch', headBranch: 'main' }) };
  };
  const read = deliveryWorkflowClient({ runGh, sleep: async () => assert.fail('workflow should already be completed') });
  const options = { signal: new AbortController().signal };
  assert.deepEqual(await read('project', candidate, null, options), result);
  tamper = true;
  await assert.rejects(read('project', candidate, null, options));
});
