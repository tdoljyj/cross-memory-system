import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { buildInput, qualifyDelivery } from '../../../scripts/ci/clued-fleet-accept.mjs';
import { firstInstallCheck, firstInstallKitOf, LINUX_SCRIPTS, PLAN_CONTRACT, prepareInstall } from '../../../work/independent-ci-resident-v1/rollout/fleet/install.mjs';
import { prepare, seal } from '../../../work/independent-ci-resident-v1/rollout/fleet/publish.mjs';
import { writeTar } from '../../../work/independent-ci-resident-v1/rollout/fleet/tar.mjs';
import { buildUniversal } from '../../../work/independent-ci-resident-v1/rollout/fleet/universal.mjs';
import { fixtureRepo, fleetFacts, git, nodeSite, runFakeGh, sha, tempDir } from '../../../work/independent-ci-resident-v1/rollout/fleet/test/fleet-fixtures.mjs';
import { acceptanceFromTarget, observationOf } from '../../../work/independent-ci-resident-v1/src/fleet-self-pull.mjs';
import { EPHEMERAL_INITDB_FLAGS, EPHEMERAL_POSTGRES_FLAGS, startCluster, stopCluster } from './cluster-cleanup.mjs';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

const repo = 'tdoljyj/cross-memory-system';
const version = 'g000025';
const tag = `fleet-node-${version}`;
const sealMigration = '20261127120000_fleet_delivery_seal_v1.sql';
const migrations = new URL('../supabase/migrations/', import.meta.url);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1), project = id(2), primary = id(3), standby = id(4), retired = id(5);
const scope = `project:${project}`;
const installedSource = sha('installed fleet Source');
const acceptanceName = `${tag}.acceptance.json`;
const kitName = `${tag}.first-install-kit.json`;
const dbValue = async (client, sql, params) => (await client.query(sql, params)).rows[0].v;

async function seedPreviousSchema(t) {
  const directory = await tempDir(t, 'fleet-db-');
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: randomBytes(32).toString('hex'), persistent: false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError: message => process.stderr.write(`${message}\n`),
  });
  const clients = [];
  // 在测试清理目录前，先关闭客户端和本轮启动的数据库。
  async function close() {
    await Promise.allSettled(clients.map(c => c.end()));
    await stopCluster(server);
  }
  try {
    await startCluster(server);
    const connect = async (role) => {
      const client = server.getPgClient();
      clients.push(client);
      await client.connect();
      if (role) await client.query(`set role ${role}`);
      return client;
    };
    const admin = await connect();
    await admin.query(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
    `);
    const migrate = async name => {
      try { await admin.query(await fs.readFile(new URL(name, migrations), 'utf8')); }
      catch (error) { throw new Error(`迁移 ${name} 失败：${error.message}`, { cause: error }); }
    };
    const names = (await fs.readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
    for (const name of names.filter(name => name < sealMigration)) await migrate(name);
    await allowRawTestBindings(admin);
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'fleet@example.invalid',now())", [owner]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key)
      values($1,$2,'Fleet','fleet',$3)`, [project, owner, scope]);
    const bind = async (binding, name) => admin.query(`insert into public.clued_agent_bindings
      (id,user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,$2,'synthetic',$3,$4,array['context:read','context:write'],array['*'])`, [binding, owner, name, sha(name)]);
    const role = async (binding, name) => {
      const receipt = await dbValue(admin, `insert into public.clued_audit_receipts
        (user_id,context_key,operation,object_type,object_id,version,metadata)
        values($1,'global','binding_role_set','binding_role',$2,1,'{}') returning id v`, [owner, name]);
      await admin.query(`insert into clued_private.binding_roles_v1
        (user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,$3,now(),$4)`, [owner, binding, name, receipt]);
    };
    await bind(id(10), 'fixture-release');
    await role(id(10), 'release-door');
    await admin.query('select clued_private.release_door_install_v1($1)', [repo]);
    for (const [node, binding, name, state] of [
      [primary, id(11), 'fixture-primary', 'pending'],
      [standby, id(12), 'fixture-standby', 'pending'],
      [retired, id(13), 'fixture-retired', 'retired'],
    ]) {
      await bind(binding, name);
      await admin.query(`insert into clued_private.ci_nodes_v1
        (node_id,user_id,project_id,binding_id,name,profile,profile_sha256,identity_public_jwk,encryption_public_jwk,
         identity_fingerprint,encryption_fingerprint,state,registration_digest,idempotency_key)
        values($1,$2,$3,$4,$5,'{}',$6,'{}','{}',$7,$8,$9,$10,$5)`,
      [node, owner, project, binding, name, sha('profile'), sha(node), sha(binding), state, sha(name)]);
    }
    await role(id(11), 'ci-admission');
    const heartbeat = async (node, age = '0 seconds') => admin.query(`insert into clued_private.ci_node_liveness_v1
      (node_id,user_id,last_heartbeat_at,last_sender_binding_id,heartbeat_sequence,reported_mode,reported_state,
       reported_service_running,reported_source_sha256)
      select node_id,user_id,clock_timestamp()-$2::interval,binding_id,1,$3,'NORMAL',true,$4
      from clued_private.ci_nodes_v1 where node_id=$1
      on conflict(node_id) do update set last_heartbeat_at=excluded.last_heartbeat_at,
        heartbeat_sequence=ci_node_liveness_v1.heartbeat_sequence+1`,
    [node, age, node === primary ? 'ACTIVE' : 'STANDBY', installedSource]);
    await heartbeat(primary);
    await heartbeat(standby);
    const anon = await connect('anon'), human = await connect('authenticated');
    await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [owner, JSON.stringify({ sub: owner, role: 'authenticated', session_id: id(6), aal: 'aal1',
        amr: [{ method: 'password', timestamp: 1795000000 }] })]);
    return { admin, anon, human, heartbeat, upgrade: async () => {
      assert.ok(names.includes(sealMigration), `缺迁移 ${sealMigration}`);
      for (const name of names.filter(name => name >= sealMigration)) await migrate(name);
    }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function releaseAssets(t, now) {
  const d = await tempDir(t, 'fleet-release-');
  // 用候选工作树的通用包输入创建小型 Git 仓库，保留真实对象和附注标签。
  const { repo: source, commit } = await fixtureRepo(t);
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
      ciPrincipalBindingId: id(11), ciPrincipalRoleRef: id(14) } });
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
    deps: { generationTags, kitOf: options => firstInstallKitOf({ ...options, now }) } });
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
  return { build, prepared, out, assets, asset, input, timeline, generationTags, ghCommand, index, template, fleet,
    takeOpen: () => { const queued = openQueued; openQueued = false; return queued; } };
}

async function checkWindowsBoundary(t, w, acceptance, checked, now) {
  const dir = await tempDir(t, 'fleet-win-');
  const from = path.join(dir, 'release'), script = path.join(dir, 'check.ps1');
  await fs.mkdir(from);
  for (const { name } of w.assets()) {
    // 自拉取读取接受请求，bootstrap 的输入目录只放安装资产。
    if (!name.endsWith('.acceptance-request.json')) await fs.writeFile(path.join(from, name), w.asset(name));
  }
  const pins = path.join(dir, 'pins.json');
  await fs.writeFile(pins, JSON.stringify(checked));
  await fs.writeFile(script, String.raw`
param([string]$AssetsDir, [string]$Pins, [string]$Runtime, [string]$Scratch)
$ErrorActionPreference = 'Stop'
$names = @(Get-ChildItem -LiteralPath $AssetsDir -File | ForEach-Object Name)
$boot = Join-Path $AssetsDir @($names -like '*.bootstrap.ps1')[0]
. $boot
$version = Get-ReleaseVersion $names
$tag = 'fleet-node-' + $version
$sums = Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $AssetsDir 'SHA256SUMS')))
$first = Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $AssetsDir "$tag.first-install.SHA256SUMS")))
foreach ($mode in @($true, $false)) {
  $codes = Test-AssetSet $names $sums $first $version $mode @()
  if ($codes.Count) { throw ($codes -join ',') }
}
foreach ($set in @($sums, $first)) {
  foreach ($name in $set.Keys) {
    if ((Sha256File (Join-Path $AssetsDir $name)) -cne $set[$name]) { throw "asset hash: $name" }
  }
}
$js = New-Object Web.Script.Serialization.JavaScriptSerializer
$check = $js.DeserializeObject([IO.File]::ReadAllText($Pins))
$tar = "$tag.tar"
$kit = "$tag.first-install-kit.json"
$prereq = "$tag.prereq-manifest.json"
$codes = Test-FirstInstallCheck $check $sums[$tar] $first[$kit] (Sha256File $Runtime)
if ($codes.Count) { throw ($codes -join ',') }
$bad = Test-FirstInstallCheck $check $sums[$tar] $first[$kit] ('0' * 64)
if ($bad -cnotcontains 'CONTROLLER_NODE_NOT_THE_FLEETS') { throw 'controller digest accepted' }
$localTar = Copy-ToWork (Join-Path $AssetsDir $tar) $Scratch $sums[$tar]
$localKit = Copy-ToWork (Join-Path $AssetsDir $kit) $Scratch $first[$kit]
$localPrereq = Copy-ToWork (Join-Path $AssetsDir $prereq) $Scratch $sums[$prereq]
$hostArgs = Get-ElevatedArguments $boot @('-Stage', 'host', '-Tar', $localTar, '-ArchiveSha256', $sums[$tar],
  '-PrereqManifest', $localPrereq, '-PrereqManifestSha256', $sums[$prereq], '-Kit', $localKit,
  '-KitSha256', $first[$kit], '-ToolchainNodeSha256', $check['toolchainNodeSha256'],
  '-RegistrarSha256', $check['registrarSha256'], '-ExpectedOperatorSid', 'S-1-5-21-1-2-3-1001')
if ($hostArgs -cnotcontains $localKit -or $hostArgs -cnotcontains $check['registrarSha256']) { throw 'host argument pins' }
foreach ($local in @($localTar, $localKit, $localPrereq)) {
  if (-not (Test-UnderDirectory $local $Scratch)) { throw 'non-local host input' }
}
`);
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, from, pins, path.join(w.template.root, 'runtime', 'node.exe'), path.join(dir, 'host-inputs')], { encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.error?.message ?? ps.stderr);

  // 执行真实 Node 重装计划入口，用本地记录器承接依赖主机的 Python 调用。
  // 计划写出后停在生成器的 --check 调用处，早于 W1 暂停。
  // 已装节点的记录校验器要求固定的公开 App 编号，首装 kit 则保留独立的假编号。
  const installed = await nodeSite(t, 'b', w.fleet, { now,
    recordOverrides: { scope, appKeyId: 104, ciPrincipalBindingId: id(12), ciPrincipalRoleRef: id(15) } });
  const workDir = path.join(dir, 'reinstall');
  const planBoundary = new Error('测试已到达重装计划核对边界');
  const calls = [];
  const python = (file, args) => {
    const name = path.basename(file);
    calls.push(name);
    const json = value => ({ status: 0, stdout: JSON.stringify(value) });
    if (name === 'rehearse.py') {
      const { residentManifestSha256 } = JSON.parse(fsSync.readFileSync(path.join(installed.root, 'upgrade', 'current.json')));
      const verify = path.join(installed.root, 'resident', residentManifestSha256, 'windows', 'verify-resident.ps1');
      const report = path.join(workDir, 'rehearsal', 'fixture.json');
      fsSync.writeFileSync(report, JSON.stringify({ checks: { verify: { sha256: sha(fsSync.readFileSync(verify)) } } }));
      return json({ status: 'REHEARSAL_PASS', report });
    }
    if (name === 'prep.py') {
      const linux = path.join(workDir, 'linux');
      fsSync.mkdirSync(linux);
      const paths = {}, scripts = {};
      for (const name of Object.values(LINUX_SCRIPTS)) {
        const bytes = Buffer.from(`#!/usr/bin/bash\n# fixture ${name}\n`);
        paths[name] = path.join(linux, name);
        scripts[name] = sha(bytes);
        fsSync.writeFileSync(paths[name], bytes);
      }
      return json({ paths, scripts });
    }
    assert.deepEqual([name, ...args], ['generate.py', '--fleet-plan', path.join(workDir, 'install-plan.json'), '--check']);
    throw planBoundary;
  };
  await assert.rejects(prepareInstall({
    artifactPath: w.build.tar, artifactSha256: acceptance.archive_sha256, acceptance, root: installed.root,
    workDir, now, python, scm: () => ({ sddl: 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)' }),
    wslConfigPath: path.join(dir, '.wslconfig'),
  }), error => {
    if (error !== planBoundary) throw new Error(`重装计划编制失败：${error.code ?? error.message} ${JSON.stringify(error.detail)}`, { cause: error });
    return true;
  });
  assert.deepEqual(calls, ['rehearse.py', 'prep.py', 'generate.py']);
  const plan = JSON.parse(await fs.readFile(path.join(workDir, 'install-plan.json'), 'utf8'));
  assert.deepEqual([plan.contract, plan.node, plan.commit, plan.archive_sha256, plan.ciSourceManifestSha256],
    [PLAN_CONTRACT, installed.profile.nodeName, acceptance.commit, acceptance.archive_sha256, acceptance.ciSourceManifestSha256]);
  assert.equal(plan.installedPackage.packageGeneration, 25);
  assert.equal(plan.w1Paused, null);
  assert.equal(plan.launcher, null);
  assert.equal(sha(await fs.readFile(path.join(plan.packageDir, 'package-manifest.json'))), plan.packageManifestSha256);
}

test('真实第 25 代资产和迁移贯通预检、接受、封存与节点入口', async t => {
  const db = await seedPreviousSchema(t);
  try {
    const { admin, anon, human, heartbeat } = db;
    // 以隔离库的观测时间对齐 SQL 新鲜度，用虚拟时钟推进发布器轮询。
    let now = Number(await dbValue(admin, "select extract(epoch from now()) * 1000 v")) + 60_000;
    const clock = () => now;
    const w = await releaseAssets(t, now);
    const operations = { project: 'fleet_delivery_registry_v1', open: 'fleet_accept_door_v1', confirm: 'fleet_delivery_seal_v1' };
    const targetOf = node => dbValue(admin, 'select clued_private.fleet_node_target_v1($1,$2) v', [owner, node]);
    const dbErrors = [];
    let afterProject, loseSealResponse = false, openError;
    const database = async (op, input) => {
      w.timeline.push(`sql:${op}`);
      let value;
      try { value = await dbValue(admin, `select clued_private.${operations[op]}($1) v`, [input]); }
      catch (error) { dbErrors.push(error); throw error; }
      if (op === 'project') await afterProject?.(value);
      return value;
    };
    const workflow = async (op, subject, details) => {
      const input = await w.input(op, details ?? undefined);
      assert.deepEqual(input.delivery.candidate, subject);
      if (op === 'confirm') {
        assert.equal(sha(w.asset(acceptanceName)), details.acceptanceSha256);
        assert.deepEqual(await targetOf(primary), { status: 'pending_seal' }, '仅上传接受文件不能发布节点目标');
      }
      const result = await qualifyDelivery(input, database, clock);
      if (op === 'confirm' && loseSealResponse) throw new Error('测试传输丢失封存响应');
      return result;
    };
    const readStatus = async resource => {
      if (w.takeOpen()) {
        try { await qualifyDelivery(await w.input('open'), database, clock); }
        catch (error) { openError = error; throw error; }
      }
      return dbValue(anon, 'select public.clued_fleet_accept_status_v1($1) v', [resource]);
    };
    const publish = async (openOnly = true) => {
      openError = undefined;
      try {
        return await seal({ request: w.prepared.request, ghCommand: w.ghCommand, index: w.index, now, openOnly, deadline: now + 1_200_000,
          deps: { readStatus, generationTags: w.generationTags, fleetWorkflow: workflow, clock,
            sleep: async ms => { if (openError) throw openError; now += ms; } } });
      } catch (error) { throw openError ?? error; }
    };
    const trace = () => w.timeline.splice(0);
    const requests = () => dbValue(admin, "select count(*)::int v from clued_private.owner_requests_v1 where action='fleet.accept'");
    const refuseBeforeOpen = async (reason, reads = ['sql:project', 'sql:project']) => {
      await assert.rejects(publish(), error => {
        assert.equal(error.code, 'FLEET_DELIVERY_PREFLIGHT_REFUSED');
        assert.equal(error.detail.phase, 'before-open');
        assert.equal(error.detail.reason, reason);
        return true;
      });
      assert.deepEqual(trace(), reads);
      assert.equal(await requests(), 0);
      assert.ok(!w.assets().some(a => a.name === acceptanceName));
    };
    await t.test('缺 20261127120000 时只读投影即报缺迁移，尚未派发 open', async () => {
      await refuseBeforeOpen('FLEET_REGISTRY_INCOMPLETE', ['sql:project']);
      assert.equal(dbErrors.length, 1);
      assert.equal(dbErrors[0].code, '42883');
      assert.match(dbErrors[0].message, /function clued_private\.fleet_delivery_registry_v1\(.*\) does not exist/);
      dbErrors.length = 0;
    });
    await db.upgrade();
    await t.test('发布端拒绝被替换的请求、tar、kit 和 Source', async () => {
      const requestName = `${tag}.acceptance-request.json`;
      const alteredSource = Buffer.from(JSON.stringify({ ...JSON.parse(w.asset(requestName)), ciSourceManifestSha256: sha('other Source') }));
      for (const [name, code] of [[requestName, 'FLEET_ACCEPT_REQUEST_SHA256_MISMATCH'],
        [`${tag}.tar`, 'FLEET_ARTIFACT_SHA_MISMATCH'], [kitName, 'FLEET_DELIVERY_KIT_REFUSED']]) {
        await assert.rejects(w.input('open', { overrides: { [name]: Buffer.concat([w.asset(name), Buffer.from('\n')]) } }),
          new RegExp(code));
      }
      await assert.rejects(w.input('open', { requestSha256: sha(alteredSource), overrides: { [requestName]: alteredSource } }),
        /FLEET_DELIVERY_SOURCE_CHANGED/);
      assert.deepEqual(trace(), []);
      assert.equal(await requests(), 0);
    });
    await t.test('过期心跳、混合 Windows/Linux Source、投影读取中漂移均阻断开单', async () => {
      await heartbeat(standby, '16 minutes');
      await refuseBeforeOpen('FLEET_TRANSITION_NODE_NOT_READY');
      await heartbeat(standby);

      await admin.query(`with mixed as (
        select n.node_id,n.user_id,n.version,n.binding_generation,l.heartbeat_sequence,l.last_heartbeat_at,
          jsonb_build_object('schemaVersion',1,'nodeId',n.node_id,'bindingGeneration',n.binding_generation,
            'packageGeneration',24,'installGeneration',1,'installReceiptSha256',$2::text,
            'windowsSourceSha256',l.reported_source_sha256,'linuxSourceSha256',$3::text,
            'brokerObservedAt',l.last_heartbeat_at,'linuxObservedAt',l.last_heartbeat_at,
            'upgraderSha256',null,'linuxToolSha256',null,'supervisorSourceSha256',null,'sourceRefsSha256',null,
            'brokerEvidenceSha256',$2::text,'linuxFactsSha256',$2::text,
            'linuxReady',true,'linuxConsistent',false,'acl',true,'connectionCarry',true,'operations',true,'processClearance',true) as evidence
        from clued_private.ci_nodes_v1 n join clued_private.ci_node_liveness_v1 l using (node_id,user_id) where n.node_id=$1
      ) insert into clued_private.fleet_node_delivery_evidence_v1
        (node_id,user_id,registration_version,binding_generation,heartbeat_sequence,observed_at,evidence_sha256,evidence)
        select node_id,user_id,version,binding_generation,heartbeat_sequence,last_heartbeat_at,
          encode(extensions.digest(evidence::text,'sha256'),'hex'), evidence from mixed
        where clued_private.fleet_delivery_evidence_ok_v1(evidence)`,
      [standby, sha('mixed observation'), sha('other Linux Source')]);
      await refuseBeforeOpen('FLEET_TRANSITION_NODE_NOT_READY');
      await admin.query('delete from clued_private.fleet_node_delivery_evidence_v1 where node_id=$1', [standby]);

      afterProject = async () => {
        afterProject = undefined;
        await admin.query('update clued_private.ci_nodes_v1 set version=version+1 where node_id=$1', [standby]);
      };
      await refuseBeforeOpen('FLEET_REGISTRY_CHANGED');
    });
    afterProject = async projection => {
      afterProject = undefined;
      assert.equal(projection.scope, 'global');
      assert.deepEqual(projection.nodes.map(row => [row.id, row.state, row.onDuty, row.mode]), [
        [primary, 'pending', true, 'ACTIVE'], [standby, 'pending', false, 'STANDBY'], [retired, 'retired', false, null],
      ]);
    };
    const pending = await publish();
    assert.equal(pending.status, 'FLEET_ACCEPTANCE_WAITING_OWNER', '两台 pending 节点必须通过开单预检');
    assert.deepEqual(trace(), ['sql:project', 'sql:project', 'dispatch:open', 'sql:project', 'sql:project', 'sql:open']);
    assert.equal(await requests(), 1);
    const requestId = new URL(pending.confirmUrl).pathname.split('/').at(-1);
    const issue = await dbValue(human, 'select public.clued_owner_grant_confirmation_issue_v1($1) v',
      [{ request_id: requestId, choice: 'once' }]);
    assert.equal(issue.status, 'issued', JSON.stringify(issue));
    const approval = await dbValue(human, 'select public.clued_owner_grant_v1($1) v',
      [{ confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }]);
    assert.equal(approval.status, 'committed', JSON.stringify(approval));
    w.timeline.push('owner:approved');
    const observation = (node, fleetTarget) => ({ at: new Date(now).toISOString(), code: null, onDuty: node === primary, fleetTarget });
    const unsealed = await targetOf(primary);
    assert.deepEqual(unsealed, { status: 'pending_seal' });
    assert.equal(observationOf(observation(primary, unsealed), repo, now), null);

    await heartbeat(standby, '16 minutes');
    await assert.rejects(publish(false), error => error.code === 'FLEET_DELIVERY_PREFLIGHT_REFUSED' && error.detail.phase === 'before-attach');
    assert.deepEqual(trace(), ['owner:approved', 'sql:project', 'sql:project']);
    assert.ok(!w.assets().some(a => a.name === acceptanceName));
    await heartbeat(standby);

    loseSealResponse = true;
    await assert.rejects(publish(false), { code: 'FLEET_DELIVERY_SEAL_NOT_CONFIRMED' });
    assert.deepEqual(trace(), ['sql:project', 'sql:project', 'upload:acceptance', 'read:acceptance', 'sql:project', 'sql:project', 'sql:confirm']);
    const sealed = await publish(false);
    assert.equal(sealed.status, 'FLEET_ACCEPTANCE_SEALED');
    assert.deepEqual(trace(), [], '回读同一封存后不重复开单、上传或封存');
    assert.equal(await requests(), 1);
    assert.deepEqual(await fs.readFile(sealed.acceptance), w.asset(acceptanceName));
    assert.deepEqual(dbErrors, []);

    for (const node of [primary, standby]) {
      const target = await targetOf(node);
      assert.equal(target.acceptance_sha256, sha(w.asset(acceptanceName)));
      assert.ok(observationOf(observation(node, target), repo, now));
      const request = await fs.readFile(w.prepared.request);
      const acceptance = acceptanceFromTarget(target, request);
      assert.deepEqual(acceptance, JSON.parse(w.asset(acceptanceName)));
      assert.throws(() => acceptanceFromTarget({ ...target, acceptance_sha256: sha('other seal') }, request),
        { code: 'FLEET_ACCEPTANCE_SEAL_MISMATCH' });
      const checked = await firstInstallCheck({ artifactPath: w.build.tar, artifactSha256: target.archive_sha256, acceptance, from: w.out, now });
      assert.equal(checked.status, 'FIRST_INSTALL_INPUTS_ACCEPTED');
      assert.equal(checked.kitSha256, w.prepared.firstInstallKitSha256);
      if (process.platform === 'win32' && node === primary) await checkWindowsBoundary(t, w, acceptance, checked, now);
    }
  } finally { await db.close(); }
});
