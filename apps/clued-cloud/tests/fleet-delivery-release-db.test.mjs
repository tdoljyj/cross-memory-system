import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readTar, extractTar } from '../../../work/independent-ci-resident-v1/rollout/fleet/tar.mjs';
import { landMain } from '../../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-landing.mjs';
import { createMergeTrainNativeWriter } from '../../../scripts/ci/clued-merge-train-native.mjs';
import { qualifyDelivery } from '../../../scripts/ci/clued-fleet-accept.mjs';
import { firstInstallCheck } from '../../../work/independent-ci-resident-v1/rollout/fleet/install.mjs';
import { DEFAULT_REPO, seal } from '../../../work/independent-ci-resident-v1/rollout/fleet/publish.mjs';
import { missingMigrations, readbackSql, releaseRequirements } from '../../../work/independent-ci-resident-v1/rollout/fleet/release-migrations.mjs';
import { sha } from '../../../work/independent-ci-resident-v1/rollout/fleet/test/fleet-fixtures.mjs';
import { fixtureId as id, releaseAssets } from '../../../work/independent-ci-resident-v1/rollout/fleet/test/delivery-release-fixture.mjs';
import { checkWindowsBoundary } from '../../../work/independent-ci-resident-v1/rollout/fleet/test/windows-delivery-fixture.mjs';
import { acceptanceFromTarget, observationOf } from '../../../work/independent-ci-resident-v1/src/fleet-self-pull.mjs';
import { EPHEMERAL_INITDB_FLAGS, EPHEMERAL_POSTGRES_FLAGS, removeTestDirectory, startCluster, stopCluster } from './cluster-cleanup.mjs';
import { newCluster } from './pg-cluster-fixture.mjs';
import { drill as sharedTrainFixture, landReadyBatch } from './merge-train-rollout-db.test.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

const repo = DEFAULT_REPO;
const sealMigration = '20261127120000_fleet_delivery_seal_v1.sql';
const migrations = new URL('../supabase/migrations/', import.meta.url);
const owner = id(1), project = id(2), primary = id(3), standby = id(4), retired = id(5);
const otherProject = id(7), revoked = id(8);
const scope = `project:${project}`;
const installedSource = sha('installed fleet Source');
const dbValue = async (client, sql, params) => (await client.query(sql, params)).rows[0].v;

async function seedPreviousSchema(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'fleet-db-'));
  t.after(async () => {
    assert.ok(await removeTestDirectory(directory), `未能清理 PostgreSQL 测试目录 ${directory}`);
  });
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
      values($1,$2,'Fleet','fleet',$3),($4,$2,'Other project','other project',$5)`,
    [project, owner, scope, otherProject, `project:${otherProject}`]);
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
    for (const [node, binding, name, state, home] of [
      [primary, id(11), 'fixture-primary', 'pending', project],
      [standby, id(12), 'fixture-standby', 'pending', otherProject],
      [retired, id(13), 'fixture-retired', 'retired', project],
      [revoked, id(16), 'fixture-revoked', 'revoked', otherProject],
    ]) {
      await bind(binding, name);
      if (state === 'revoked') await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [binding]);
      await admin.query(`insert into clued_private.ci_nodes_v1
        (node_id,user_id,project_id,binding_id,name,profile,profile_sha256,identity_public_jwk,encryption_public_jwk,revoked_at,
         identity_fingerprint,encryption_fingerprint,state,registration_digest,idempotency_key)
        values($1,$2,$3,$4,$5,'{}',$6,'{}','{}',case when $9='revoked' then now() end,$7,$8,$9,$10,$5)`,
      [node, owner, home, binding, name, sha('profile'), sha(node), sha(binding), state, sha(name)]);
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
    return { admin, anon, human, heartbeat, connect, upgrade: async () => {
      assert.ok(names.includes(sealMigration), `缺迁移 ${sealMigration}`);
      for (const name of names.filter(name => name >= sealMigration)) await migrate(name);
    }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('真实舰队资产和迁移贯通预检、接受、封存与节点入口', async t => {
  const db = await seedPreviousSchema(t);
  try {
    const { admin, anon, human, heartbeat } = db;
    let sqlNow = (await dbValue(admin, 'select statement_timestamp() v')).getTime();
    let pollNow = sqlNow;
    const observe = at => {
      sqlNow = Math.max(sqlNow, Date.parse(at));
      pollNow = Math.max(pollNow, sqlNow);
    };
    const sqlClock = () => sqlNow;
    const pollClock = () => pollNow;
    const w = await releaseAssets(t, sqlNow);
    const { tag, acceptanceName } = w;
    const regular = await releaseAssets(t, sqlNow, 'g000026', w.sourceRepo);
    await heartbeat(primary);
    await heartbeat(standby);
    const operations = { project: 'fleet_delivery_registry_v1', open: 'fleet_accept_door_v1', confirm: 'fleet_delivery_seal_v1' };
    const targetOf = node => dbValue(admin, 'select clued_private.fleet_node_target_v1($1,$2) v', [owner, node]);
    const dbErrors = [];
    let afterProject, loseSealResponse = false, openError;
    const database = async (release, op, input) => {
      release.timeline.push(`sql:${op}`);
      let value;
      try { value = await dbValue(admin, `select clued_private.${operations[op]}($1) v`, [input]); }
      catch (error) { dbErrors.push(error); throw error; }
      if (op === 'project') {
        observe(value.observedAt);
        await afterProject?.(value);
      }
      return value;
    };
    const workflow = async (release, op, subject, details) => {
      const input = await release.input(op, details ?? undefined);
      assert.deepEqual(input.delivery.candidate, subject);
      if (op === 'confirm') {
        assert.equal(sha(w.asset(acceptanceName)), details.acceptanceSha256);
        assert.deepEqual(await targetOf(primary), { status: 'pending_seal' }, '仅上传接受文件不能发布节点目标');
      }
      const result = await qualifyDelivery(input, (op, arg) => database(release, op, arg), sqlClock);
      if (op === 'confirm' && loseSealResponse) throw new Error('测试传输丢失封存响应');
      return result;
    };
    const readStatus = async (release, resource) => {
      if (release.takeOpen()) {
        try { await qualifyDelivery(await release.input('open'), (op, arg) => database(release, op, arg), sqlClock); }
        catch (error) { openError = error; throw error; }
      }
      const { v, observed_at } = (await anon.query(
        'select public.clued_fleet_accept_status_v1($1) v, statement_timestamp() observed_at', [resource])).rows[0];
      observe(observed_at.toISOString());
      return v;
    };
    const publish = async (openOnly = true, release = w) => {
      openError = undefined;
      // SQL 时间决定投影新鲜度，模拟等待只推进当次发布命令的轮询。
      observe((await dbValue(admin, 'select statement_timestamp() v')).toISOString());
      pollNow = sqlNow;
      try {
        return await seal({ request: release.prepared.request, ghCommand: release.ghCommand, index: release.index,
          now: sqlNow, openOnly, deadline: pollNow + 1_200_000,
          deps: { readStatus: resource => readStatus(release, resource), generationTags: release.generationTags,
            fleetWorkflow: (...args) => workflow(release, ...args), clock: pollClock,
            sleep: async ms => { if (openError) throw openError; pollNow += ms; } } });
      } catch (error) { throw openError ?? error; }
    };
    const trace = () => w.timeline.splice(0);
    const requests = () => dbValue(admin, "select count(*)::int v from clued_private.owner_requests_v1 where action='fleet.accept'");
    const refuseBeforeOpen = async (reason, { release = w, reads = ['sql:project', 'sql:project'], verify } = {}) => {
      const assetsBefore = release.assets();
      const indexBefore = await fs.readFile(release.index);
      const outputBefore = (await fs.readdir(release.out)).sort();
      await assert.rejects(publish(true, release), error => {
        assert.equal(error.code, 'FLEET_DELIVERY_PREFLIGHT_REFUSED');
        assert.equal(error.detail.phase, 'before-open');
        assert.equal(error.detail.reason, reason);
        verify?.(error.detail.nodes);
        return true;
      });
      assert.deepEqual(release.timeline.splice(0), reads);
      assert.equal(await requests(), 0);
      assert.equal(await dbValue(admin, 'select count(*)::int v from clued_private.fleet_accepted_v1'), 0);
      assert.deepEqual(release.assets(), assetsBefore, '拒单不得写入或替换发布资产');
      assert.deepEqual(await fs.readFile(release.index), indexBefore);
      assert.deepEqual((await fs.readdir(release.out)).sort(), outputBefore);
    };
    await t.test('缺 20261127120000 时只读投影即报缺迁移，尚未派发 open', async () => {
      await refuseBeforeOpen('FLEET_REGISTRY_INCOMPLETE', { reads: ['sql:project'] });
      assert.equal(dbErrors.length, 1);
      assert.equal(dbErrors[0].code, '42883');
      assert.match(dbErrors[0].message, /function clued_private\.fleet_delivery_registry_v1\(.*\) does not exist/);
      dbErrors.length = 0;
    });
    await db.upgrade();
    await t.test('发布门通过同一 SQL 快照核对 pending 交付迁移和实际续期接口', async () => {
      const root = new URL('../../../', import.meta.url);
      const plan = releaseRequirements(w.build.source.commit, file => readFileSync(new URL(file, root)));
      await admin.query(`create schema supabase_migrations;
        create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[])`);
      for (const { file, name, version } of plan) {
        const sql = await fs.readFile(new URL(file, migrations), 'utf8');
        await admin.query('insert into supabase_migrations.schema_migrations values ($1, $2, array[$3])', [version, name, sql]);
      }
      const snapshot = (await admin.query(readbackSql(plan)))[1].rows[0].jsonb_build_object;
      assert.equal(snapshot.interfaces.pendingDelivery, true);
      assert.deepEqual(missingMigrations(plan, snapshot), []);
    });
    await t.test('发布端拒绝被替换的请求、tar、kit 和 Source', async () => {
      const requestName = `${tag}.acceptance-request.json`;
      const alteredSource = Buffer.from(JSON.stringify({ ...JSON.parse(w.asset(requestName)), ciSourceManifestSha256: sha('other Source') }));
      for (const [name, code] of [[requestName, 'FLEET_ACCEPT_REQUEST_SHA256_MISMATCH'],
        [`${tag}.tar`, 'FLEET_ARTIFACT_SHA_MISMATCH'], [`${tag}.first-install-kit.json`, 'FLEET_DELIVERY_KIT_REFUSED']]) {
        await assert.rejects(w.input('open', { overrides: { [name]: Buffer.concat([w.asset(name), Buffer.from('\n')]) } }),
          new RegExp(code));
      }
      await assert.rejects(w.input('open', { requestSha256: sha(alteredSource), overrides: { [requestName]: alteredSource } }),
        /FLEET_DELIVERY_SOURCE_CHANGED/);
      assert.deepEqual(trace(), []);
      assert.equal(await requests(), 0);
    });
    const recordEvidence = (node, linuxSource, linuxConsistent, acl, generation = 24) => admin.query(`with report as (
        select n.node_id,n.user_id,n.version,n.binding_generation,l.heartbeat_sequence,l.last_heartbeat_at,
          jsonb_build_object('schemaVersion',1,'nodeId',n.node_id,'bindingGeneration',n.binding_generation,
            'packageGeneration',$6::int,'installGeneration',1,'installReceiptSha256',$2::text,
            'windowsSourceSha256',l.reported_source_sha256,'linuxSourceSha256',$3::text,
            'brokerObservedAt',l.last_heartbeat_at,'linuxObservedAt',l.last_heartbeat_at,
            'upgraderSha256',null,'linuxToolSha256',null,'supervisorSourceSha256',null,'sourceRefsSha256',null,
            'brokerEvidenceSha256',$2::text,'linuxFactsSha256',$2::text,
            'linuxReady',true,'linuxConsistent',$4::boolean,'acl',$5::boolean,'connectionCarry',true,'operations',true,'processClearance',true) as evidence
        from clued_private.ci_nodes_v1 n join clued_private.ci_node_liveness_v1 l using (node_id,user_id) where n.node_id=$1
      ) insert into clued_private.fleet_node_delivery_evidence_v1
        (node_id,user_id,registration_version,binding_generation,heartbeat_sequence,observed_at,evidence_sha256,evidence)
        select node_id,user_id,version,binding_generation,heartbeat_sequence,last_heartbeat_at,
          encode(extensions.digest(evidence::text,'sha256'),'hex'), evidence from report
        where clued_private.fleet_delivery_evidence_ok_v1(evidence)`,
      [node, sha(`evidence for ${node}`), linuxSource, linuxConsistent, acl, generation]);
    await t.test('过期心跳、混合 Windows/Linux Source、投影读取中漂移均阻断开单', async () => {
      await heartbeat(standby, '16 minutes');
      await refuseBeforeOpen('FLEET_TRANSITION_NODE_NOT_READY');
      await heartbeat(standby);

      assert.equal((await recordEvidence(standby, sha('other Linux Source'), false, true, null)).rowCount, 1);
      await refuseBeforeOpen('FLEET_TRANSITION_NODE_NOT_READY');
      await admin.query('delete from clued_private.fleet_node_delivery_evidence_v1 where node_id=$1', [standby]);

      afterProject = async () => {
        afterProject = undefined;
        await admin.query('update clued_private.ci_nodes_v1 set version=version+1 where node_id=$1', [standby]);
      };
      await refuseBeforeOpen('FLEET_REGISTRY_CHANGED');
    });
    await t.test('SQL 投影显示待重绑，过渡代拒单且无副作用', async () => {
      await admin.query(`insert into clued_private.native_confirmation_tokens
        (user_id,action,subject_key,subject_version,native_choices,confirmation_view,view_digest,token_hash,auth_time,expires_at)
        select user_id,'ci_node_binding_rebind',node_id::text,version,'{}','{}',$2,$3,now(),now()+interval '10 minutes'
        from clued_private.ci_nodes_v1 where node_id=$1`, [standby, sha('rebind view'), sha('rebind confirmation fixture')]);
      afterProject = projection => {
        afterProject = undefined;
        assert.equal(projection.nodes.find(row => row.id === standby).rebindPending, true);
      };
      try {
        await refuseBeforeOpen('FLEET_TRANSITION_NODE_NOT_READY', { verify: nodes => {
          assert.deepEqual(nodes.find(node => node.id === standby).transition, { status: 'FAIL', reasons: ['NODE_REBIND_IN_FLIGHT'] });
          assert.equal(nodes.find(node => node.id === primary).transition.status, 'PASS');
        } });
      } finally {
        await admin.query("delete from clued_private.native_confirmation_tokens where user_id=$1 and action='ci_node_binding_rebind'", [owner]);
      }
    });
    await t.test('第 26 代只要一台登记节点缺完整路径便拒单且无副作用', async () => {
      await admin.query("update clued_private.ci_nodes_v1 set state='active' where node_id=$1", [primary]);
      await admin.query("update clued_private.ci_nodes_v1 set state='draining' where node_id=$1", [standby]);
      await heartbeat(primary);
      await heartbeat(standby);
      assert.equal((await recordEvidence(primary, installedSource, true, true)).rowCount, 1);
      assert.equal((await recordEvidence(standby, installedSource, true, false)).rowCount, 1);
      afterProject = projection => {
        afterProject = undefined;
        assert.equal(projection.candidate.version, 'g000026');
        assert.equal(projection.scope, 'global');
        assert.deepEqual(projection.nodes.map(row => [row.id, row.state, row.bindingLive, row.onDuty, row.mode]), [
          [primary, 'active', true, true, 'ACTIVE'], [standby, 'draining', true, false, 'STANDBY'],
          [retired, 'retired', true, false, null], [revoked, 'revoked', false, false, null],
        ]);
        assert.deepEqual(projection.nodes.slice(0, 2).map(row => [row.evidence.currentHeartbeat, row.evidence.acl]),
          [[true, true], [true, false]]);
      };
      try {
        await refuseBeforeOpen('FLEET_NODE_HAS_NO_COMPLETE_PATH', { release: regular, verify: nodes => {
          assert.deepEqual(nodes.map(node => [node.id, node.upgrade.status, node.reinstall.status]),
            [[primary, 'UNKNOWN', 'PASS'], [standby, 'UNKNOWN', 'FAIL']]);
          assert.deepEqual(nodes[1].reinstall.reasons, ['acl']);
        } });
      } finally {
        await admin.query('delete from clued_private.fleet_node_delivery_evidence_v1');
        await admin.query("update clued_private.ci_nodes_v1 set state='pending' where node_id in ($1,$2)", [primary, standby]);
      }
    });
    afterProject = async projection => {
      afterProject = undefined;
      assert.equal(projection.scope, 'global');
      assert.deepEqual(projection.nodes.map(row => [row.id, row.state, row.onDuty, row.mode]), [
        [primary, 'pending', true, 'ACTIVE'], [standby, 'pending', false, 'STANDBY'],
        [retired, 'retired', false, null], [revoked, 'revoked', false, null],
      ]);
    };
    assert.equal(await dbValue(admin, 'select project_id v from clued_private.ci_nodes_v1 where node_id=$1', [standby]), otherProject);
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
    const observation = (node, fleetTarget) => ({ at: new Date(sqlNow).toISOString(), code: null, onDuty: node === primary, fleetTarget });
    const unsealed = await targetOf(primary);
    assert.deepEqual(unsealed, { status: 'pending_seal' });
    assert.equal(observationOf(observation(primary, unsealed), repo, sqlNow), null);

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
      assert.deepEqual(target.other_sources, [installedSource], '同伴投影必须包含另一项目中已登记的 pending 节点');
      assert.ok(observationOf(observation(node, target), repo, sqlNow));
      const request = await fs.readFile(w.prepared.request);
      const acceptance = acceptanceFromTarget(target, request);
      assert.deepEqual(acceptance, JSON.parse(w.asset(acceptanceName)));
      assert.throws(() => acceptanceFromTarget({ ...target, acceptance_sha256: sha('other seal') }, request),
        { code: 'FLEET_ACCEPTANCE_SEAL_MISMATCH' });
      const checked = await firstInstallCheck({ artifactPath: w.build.tar, artifactSha256: target.archive_sha256, acceptance, from: w.out, now: sqlNow });
      assert.equal(checked.status, 'FIRST_INSTALL_INPUTS_ACCEPTED');
      assert.equal(checked.kitSha256, w.prepared.firstInstallKitSha256);
      if (process.platform === 'win32' && node === primary) await checkWindowsBoundary(t, w, acceptance, checked, sqlNow);
    }
  } finally { await db.close(); }
});

function testDelivery(node, source, generation, at) {
  return { schemaVersion: 1, nodeId: node, bindingGeneration: 1, installGeneration: 2,
    packageGeneration: generation, installReceiptSha256: sha('fresh receipt'), linuxSourceSha256: source, windowsSourceSha256: source,
    linuxObservedAt: at, brokerObservedAt: at, brokerEvidenceSha256: sha('broker'), linuxFactsSha256: sha('linux'),
    linuxReady: true, linuxConsistent: true, acl: true, connectionCarry: true, operations: true, processClearance: true,
    upgraderSha256: null, linuxToolSha256: null, supervisorSourceSha256: null, sourceRefsSha256: null };
}

async function seedSealedPackage({ admin, human }, generation, sourceSha256, identity = {}) {
  const version = 'g' + String(generation).padStart(6, '0');
  const candidate = { version, repository: repo, scope: 'global', commit: 'a'.repeat(40),
    sourceSha256, archiveSha256: sha(version), requestSha256: sha('request' + version), kitSha256: sha('kit'), ...identity };
  const resource = ['fleet-node:' + repo, version, candidate.archiveSha256, candidate.requestSha256].join('/');
  const registry = () => dbValue(admin, 'select clued_private.fleet_delivery_registry_v1($1) v', [candidate]);
  const { request_id } = await dbValue(admin, 'select clued_private.fleet_accept_door_v1($1) v',
    [{ action: 'fleet.accept', resources: [resource], delivery: { candidate, snapshotToken: (await registry()).snapshotToken } }]);
  const issue = await dbValue(human, 'select public.clued_owner_grant_confirmation_issue_v1($1) v', [{ request_id, choice: 'once' }]);
  const approval = await dbValue(human, 'select public.clued_owner_grant_v1($1) v',
    [{ confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }]);
  assert.equal(approval.status, 'committed');
  const record = await dbValue(admin, 'select public.clued_fleet_accept_status_v1($1) v', [resource]);
  return dbValue(admin, 'select clued_private.fleet_delivery_seal_v1($1) v',
    [{ candidate, acceptanceSha256: sha(version + 'sealed'), grantId: record.grant_id, receiptId: record.receipt_id,
      acceptedAt: new Date(Math.floor(Date.parse(record.accepted_at) / 1000) * 1000).toISOString(),
      snapshotToken: (await registry()).snapshotToken }]);
}

test('封存前同源兜底，封存后正常交班只给当前包，旧包能故障接班', async t => {
  const db = await seedPreviousSchema(t);
  try {
    await db.upgrade();
    const { admin } = db;
    const currentSource = sha('new sealed fleet Source');
    await admin.query('update clued_private.ci_node_liveness_v1 set reported_source_sha256=$1 where node_id=$2',
      [currentSource, standby]);
    const handover = binding => admin.query('select clued_private.ci_admission_target_require_v1($1,$2)', [owner, binding]);
    await assert.rejects(handover(id(12)), /ci_admission_target_source_not_accepted/);
    await seedSealedPackage(db, 25, installedSource);
    const current = await seedSealedPackage(db, 26, currentSource);
    await admin.query('begin');
    try {
      await admin.query('update clued_private.ci_node_liveness_v1 set reported_source_sha256=$1 where user_id=$2',
        [sha('out of set on both nodes'), owner]);
      assert.equal((await dbValue(admin,'select clued_private.fleet_execution_view_v1($1,$2) v',[owner,id(11)])).nodes,null);
      await admin.query('update clued_private.ci_node_liveness_v1 set reported_source_sha256=null where node_id=$1',[primary]);
      assert.equal((await dbValue(admin,'select clued_private.fleet_execution_view_v1($1,$2) v',[owner,id(11)])).holder_package.refusal,
        'ci_admission_target_source_unknown');
    } finally { await admin.query('rollback'); }
    await handover(id(12));
    await assert.rejects(handover(id(11)), /ci_admission_target_source_not_accepted/);
    assert.equal(await dbValue(admin,
      "select clued_private.fleet_source_reason_v1($1,$2,'failover') v", [owner, primary]), null);
    const classification = node => dbValue(admin, 'select clued_private.fleet_node_package_v1($1,$2) v', [owner, node]);
    const maintenance = (client, node, args, proof = null) => {
      const input = { node_id: node, binding_generation: 1, grant_id: current.grantId, scope: 'global', ...args };
      return proof ? dbValue(client, 'select public.clued_work_verify_v1($1,$2) v',
        [proof, { ...input, action: 'fleet_maintenance', command: args.action }]) :
        dbValue(client, 'select public.clued_fleet_maintenance_v1($1) v', [input]);
    };
    const request = (i, method = 'reinstall') => ({ action: 'delist', operation_id: id(i), method });
    const tick = () => dbValue(admin, 'select clued_private.ci_admission_failover_owner_v1($1) v', [owner]);
    const housekeep = () => admin.query('select clued_private.fleet_maintenance_tick_v1($1)', [owner]);
    const status = () => dbValue(admin, 'select clued_private.fleet_execution_view_v1($1,$2) v', [owner, id(11)]);
    assert.equal((await status()).nodes.length, 1, '旧列车只比较通过验证的真实当班');
    assert.equal((await status()).fleet_nodes.length, 2);
    await assert.rejects(maintenance(db.anon, primary, request(54), sha('fixture-standby')), /fleet_maintenance_identity_refused/);
    await assert.rejects(handover(id(11)), /source_not_accepted/);
    await assert.rejects(dbValue(db.anon, 'select public.clued_work_verify_v1($1,$2) v',
      [sha('fixture-primary'), { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'ACTIVE',
        service_running: true, delisted: true }]), /work_claim_ci_command_invalid/);
    assert.equal((await classification(primary)).maintenance, 'available');

    await admin.query(`insert into clued_private.ci_failover_members_v1 values
      ($1,$2,1,now()-interval '1 hour',$4),($1,$3,2,now()-interval '1 hour',$4)`,
    [owner, id(11), id(12), current.receiptId]);
    await admin.query(`insert into clued_private.ci_failover_settings_v1 values
      ($1,true,now()-interval '1 hour',1,now(),$2)`, [owner, current.receiptId]);
    await admin.query("update clued_private.ci_node_liveness_v1 set reported_probe='not-held' where node_id=$1", [standby]);
    const queue = { contract: 'clued.merge-queue-node-view/1', current: null, executor: { state: 'IDLE' }, pending: [] };
    for (const who of ['fixture-primary', 'fixture-standby']) {
      const reply = await dbValue(db.anon, 'select public.clued_work_verify_v1($1,$2) v',
        [sha(who), { action: 'ci_queue_report', scope: 'global', view: queue }]);
      assert.equal(reply.status, 'ok', JSON.stringify(reply));
    }
    await admin.query("update clued_private.ci_node_queue_view_v1 set view=jsonb_set(view,'{current}','{}') where node_id=$1", [primary]);
    assert.equal((await tick()).outcome, 'holder_alive', '在途旧批先收口');
    await admin.query("update clued_private.ci_node_queue_view_v1 set view=$1 where node_id=$2", [queue, primary]);
    await housekeep();
    const alerts = kind => dbValue(admin, `select count(*)::int v from public.clued_audit_receipts
      where user_id=$1 and metadata->>'receipt_kind'=$2`, [owner,kind]);
    assert.equal(await alerts('FLEET_MIXED_TIMEOUT'), 0);
    await admin.query("update clued_private.fleet_mixed_v1 set since_at=now()-interval '12 hours' where user_id=$1",[owner]);
    await housekeep();
    await housekeep();
    assert.equal(await alerts('FLEET_MIXED_TIMEOUT'), 1);
    const promoted = await tick();
    assert.equal(promoted.outcome, 'fleet_promoted', JSON.stringify(promoted));
    assert.equal((await classification(primary)).maintenance, 'reserve');
    await assert.rejects(handover(id(11)), /in_maintenance/);
    await assert.rejects(admin.query('select clued_private.ci_job_lease_next_v1($1,$2,$3)', [owner, project, primary]), /IN_MAINTENANCE/);
    await admin.query(`update clued_private.binding_roles_v1 set effective_at=granted_at
      where user_id=$1 and binding_id=$2 and revoked_at is null`, [owner, id(12)]);
    await admin.query(`update clued_private.ci_node_liveness_v1 set reported_mode=case when node_id=$1 then 'STANDBY' else 'ACTIVE' end,
      reported_probe=case when node_id=$1 then 'not-held' else 'held' end where user_id=$2`, [primary, owner]);
    await admin.query("select clued_private.fleet_fail_holder_v1($1,$2,'TRAIN_LANDING_CHECK_FAILED')", [owner, standby]);
    assert.equal((await classification(standby)).maintenance, 'available', 'PR 自身测试红不算节点故障');
    await housekeep();
    assert.equal((await classification(primary)).maintenance, 'reserve', '只跑作业不能清理后备');

    assert.equal(await dbValue(admin,'select count(*)::int v from clued_private.fleet_mixed_v1 where user_id=$1',[owner]),0);
    await admin.query('begin');
    try {
      const at = (await dbValue(admin,'select clock_timestamp() v')).toISOString();
      await dbValue(admin,'select public.clued_work_verify_v1($1,$2) v',[sha('fixture-standby'), {
        action: 'ci_node_heartbeat',scope: 'global',state: 'NORMAL',mode: 'ACTIVE',probe: 'held',service_running:true,
        ci_source_manifest_sha256:currentSource,snapshot_age_seconds:0,fleet_delivery:testDelivery(standby,currentSource,26,at),
        fleet_runtime:{idle:true,selfcheckAt:at} }]);
      await admin.query("update clued_private.fleet_maintenance_v1 set started_at=now()-interval '11 hours 59 minutes' where node_id=$1",[primary]);
      await housekeep();
      assert.equal((await classification(primary)).maintenance,'reserve');
      await admin.query("update clued_private.fleet_maintenance_v1 set started_at=now()-interval '12 hours' where node_id=$1",[primary]);
      await housekeep();
      assert.equal((await classification(primary)).maintenance,'delisted','12 小时无活，用本代新当班的新鲜健康自检收口');
    } finally { await admin.query('rollback'); }
    await db.anon.query('begin');
    try {
      const writer = createMergeTrainNativeWriter({ repository: repo, scope: 'global', nativeToken: 'fixture-standby',
        supabaseUrl: 'https://fixture.invalid', publishableKey: 'pk-fixture', fetchImpl: async (_url, options) => {
          const { p_input, p_token_hash } = JSON.parse(options.body);
          const v = await dbValue(db.anon, 'select public.clued_work_verify_v1($1,$2) v', [p_token_hash, p_input]);
          return Response.json(v);
        } });
      const status = await writer.nodesStatus();
      assert.equal(status.holderPackage.grantId, current.grantId);
      const base = 'a'.repeat(40), next = 'b'.repeat(40);
      let main = base;
      const intent = { grant_id: current.grantId, source: currentSource, effect_key: sha('node landing'), base_sha: base, test_sha: next };
      assert.equal((await writer.fleetLanding({ ...intent, command: 'begin', main_sha: main })).authorized, true);
      const reserve = () => maintenance(db.anon, primary, { action: 'status' }, sha('fixture-primary'));
      assert.equal((await reserve()).state, 'reserve', '发送授权和检查通过都不能清理后备');
      const result = await landMain({ baseSha: base, testSha: next, readMain: async () => main,
        port: { fastForwardMain: async tip => { assert.equal(main, base); main = tip; return { status: 200, sha: tip }; } } });
      assert.deepEqual(result, { state: 'landed', mainSha: next, sent: true });
      assert.equal((await writer.fleetLanding({ ...intent, command: 'settle', main_sha: result.mainSha })).settled, true);
      assert.equal((await reserve()).state, 'delisted');
    } finally { await db.anon.query('rollback'); }
    await admin.query(`update clued_private.ci_node_liveness_v1 set reported_state='HALTED',readable_state='HALTED',readable_at=last_heartbeat_at,
      halted_since=now()-interval '6 minutes' where node_id=$1`, [standby]);
    const fallback = await tick();
    assert.equal(fallback.outcome, 'handed_over', JSON.stringify(fallback));
    assert.equal(fallback.target, id(11));
    assert.equal((await classification(primary)).maintenance, 'available');
    assert.equal((await classification(standby)).maintenance, 'repair');
    assert.ok(await dbValue(admin, 'select promotion_paused_at v from clued_private.fleet_accepted_v1 where grant_id=$1', [current.grantId]));
    await db.heartbeat(standby);
    await housekeep();
    assert.equal((await classification(standby)).maintenance, 'repair');
    assert.equal((await maintenance(db.human, primary, { action: 'status' })).has_other_healthy, false);
    await assert.rejects(maintenance(db.human, primary, request(55)), /last_node/);
    await assert.rejects(maintenance(db.human, primary, request(56, 'in_place')), /in_place_capability_unverified/);
    const at = (await dbValue(admin,'select clock_timestamp() v')).toISOString();
    const delivery = { ...testDelivery(primary,installedSource,25,at), upgraderSha256: sha('upgrader'), linuxToolSha256: sha('linux tool') };
    await dbValue(db.anon,'select public.clued_work_verify_v1($1,$2) v',[sha('fixture-primary'), {
      action:'ci_node_heartbeat',scope:'global',state:'NORMAL',mode:'STANDBY',probe:'not-held',service_running:true,
      snapshot_age_seconds:0,ci_source_manifest_sha256:installedSource,fleet_delivery:delivery }]);
    const solo = await maintenance(db.anon, primary, request(56, 'in_place'), sha('fixture-primary'));
    assert.equal(solo.state,'delisted');
    assert.equal((await maintenance(db.human, primary, request(56, 'in_place'))).receipt_id,solo.receipt_id);
    const repairStart = await maintenance(db.human, primary, {action: 'verify_started', operation_id: id(56)});
    assert.equal(repairStart.state, 'delisted');
    await admin.query("update clued_private.fleet_maintenance_v1 set verify_started_at=now()-interval '45 minutes' where node_id=$1",[primary]);
    await housekeep();
    assert.equal(await alerts('FLEET_VERIFY_TIMEOUT'), 1);
    assert.equal(await alerts('FLEET_MAINTENANCE_TIMEOUT'), 0);
    await admin.query("update clued_private.fleet_maintenance_v1 set started_at=now()-interval '24 hours' where node_id=$1",[primary]);
    await housekeep();
    await housekeep();
    assert.equal(await alerts('FLEET_MAINTENANCE_TIMEOUT'), 1);

    const revoke = () => dbValue(db.human, 'select public.clued_owner_grant_revoke_v1($1) v',
      [{ grant_id: current.grantId, acceptance_sha256: current.acceptanceSha256 }]);
    const grants = await dbValue(db.human,'select public.clued_owner_grants_list_v1($1) v',[{}]);
    assert.equal(grants.sealed_packages.find(pkg => pkg.classification==='current').after_revoke_version,'g000025');
    const rollback = await revoke();
    assert.equal(rollback.current_package.version,'g000025');
    assert.deepEqual((await revoke()).current_package,rollback.current_package);
    assert.equal((await revoke()).receipt_id, rollback.receipt_id);
    assert.equal((await classification(primary)).classification, 'current');
    // 在独立子场景中让维护已结束的节点申请普通交班，验证回滚后的准入。
    await admin.query('begin');
    try {
      await admin.query("update clued_private.fleet_maintenance_v1 set state='returned' where node_id=$1",[primary]);
      await handover(id(11));
    } finally { await admin.query('rollback'); }
    assert.equal((await classification(standby)).classification, 'revoked');
    const prior = await dbValue(admin,'select clued_private.fleet_node_target_v1($1,$2) v',[owner,primary]);
    assert.equal(prior.version,'g000025');
    await dbValue(db.human,'select public.clued_owner_grant_revoke_v1($1) v',
      [{grant_id: prior.grant_id, acceptance_sha256: prior.acceptance_sha256}]);
    assert.equal((await classification(primary)).classification,'revoked');
    assert.equal(await dbValue(admin,'select clued_private.fleet_node_target_v1($1,$2) v',[owner,primary]),null);

  } finally { await db.close(); }
});

test('并发摘牌、精确包验证和单机重装确认', async t => {
  const db = await seedPreviousSchema(t);
  try {
    await db.upgrade();
    const { admin } = db;
    const pkg = await seedSealedPackage(db, 25, installedSource);
    const other = await db.connect('anon');
    const tokens = [sha('fixture-primary'), sha('fixture-standby')];
    const nodes = [primary, standby];
    const call = (client, index, command, fields = {}) =>
      dbValue(client, 'select public.clued_work_verify_v1($1,$2) v', [tokens[index], {
        action: 'fleet_maintenance', scope: 'global', command, node_id: nodes[index], binding_generation: 1,
        grant_id: pkg.grantId, ...fields }]);
    const operations = [id(601),id(602)];
    for (const i of [0,1]) assert.equal((await call(db.anon,i,'status')).has_other_healthy,true);
    const results = await Promise.allSettled([db.anon,other].map((c,i) =>
      call(c,i,'delist',{ method: 'in_place', operation_id: operations[i] })));
    const winner = results.findIndex(r => r.status === 'fulfilled');
    assert.ok(winner >= 0, results.map(r => r.reason).join(', '));
    const loser = 1 - winner;
    assert.equal(results[loser].status,'rejected');
    assert.match(results[loser].reason.message,/fleet_maintenance_last_node/);
    assert.equal((await call(db.anon,winner,'status')).install_ready,true);
    assert.equal((await call(db.anon,loser,'status')).has_other_healthy,false);
    await admin.query('begin');
    try {
      await admin.query('update clued_private.ci_nodes_v1 set binding_generation=binding_generation+1 where node_id=$1',[nodes[winner]]);
      const rebound = await dbValue(admin,'select clued_private.fleet_node_package_v1($1,$2) v',[owner,nodes[winner]]);
      assert.equal(rebound.maintenance,'delisted','同一节点在维护中轮换凭据仍不可派活');
    } finally { await admin.query('rollback'); }
    await assert.rejects(call(db.anon,loser,'delist',{ method: 'reinstall', operation_id: id(605) }),/last_node/);

    const beat = async (source, ok, identity = {}) => {
      const at = (await dbValue(admin, 'select clock_timestamp() v')).toISOString();
      const evidence = { ...testDelivery(nodes[winner],source,25,at), ...identity };
      return dbValue(db.anon,'select public.clued_work_verify_v1($1,$2) v',[tokens[winner], {
        action: 'ci_node_heartbeat', scope: 'global', state: 'NORMAL', mode: 'STANDBY', probe: 'not-held',
        ci_source_manifest_sha256: source, snapshot_age_seconds: 0, service_running: true,
        fleet_delivery: evidence, fleet_runtime: { idle: true, selfcheckAt: ok ? at : null } }]);
    };
    const tick = () => admin.query('select clued_private.fleet_maintenance_tick_v1($1)',[owner]);
    const started = await call(db.anon,winner,'verify_started',{ operation_id: operations[winner] });
    assert.equal((await beat(sha('outside'),true)).status,'ok');
    await tick();
    assert.equal((await call(db.anon,winner,'status')).state,'delisted');
    await beat(installedSource,true,{packageGeneration:null,linuxSourceSha256:sha('different Linux runtime')});
    const skew = await dbValue(admin,'select clued_private.fleet_node_package_v1($1,$2) v',[owner,nodes[winner]]);
    assert.equal(skew.classification,'outside','两个系统的 Source 已知不同时，不能靠唯一的 Windows Source 归包');
    await beat(installedSource,false);
    await tick();
    assert.equal((await call(db.anon,winner,'status')).state,'delisted');
    await beat(installedSource,true);
    await tick();
    assert.equal((await call(db.anon,winner,'status')).state,'returned');
    assert.equal((await call(db.anon,winner,'verify_started',{operation_id:operations[winner]})).receipt_id,started.receipt_id);
    assert.equal((await call(db.anon,winner,'delist',{method:'in_place',operation_id:operations[winner]})).receipt_id,results[winner].value.receipt_id);
    await admin.query('select clued_private.ci_admission_target_require_v1($1,$2)',[owner,id(11+winner)]);
    const maintain = command => call(db.anon,winner,command,{operation_id:id(607),method:'in_place'});
    await admin.query(`insert into clued_private.fleet_landing_v1(user_id,node_id,effect_key,grant_id,binding_generation,base_sha,test_sha,started_at)
      values($1,$2,$3,$4,1,$5,$6,clock_timestamp()-interval '30 seconds')`,
    [owner,nodes[winner],sha('drain cancel'),pkg.grantId,'a'.repeat(40),'b'.repeat(40)]);
    assert.equal((await maintain('delist')).install_ready,false);
    // 回拨测试时钟，保留“原发送 → 摘牌 → 毫秒精度的客户端观测”的次序。
    await admin.query("update clued_private.fleet_maintenance_v1 set started_at=clock_timestamp()-interval '1 second' where node_id=$1",[nodes[winner]]);
    assert.equal((await beat(installedSource,true)).status,'ok');
    assert.equal(await dbValue(admin,'select clued_private.fleet_selfcheck_v1(user_id,node_id,started_at) v from clued_private.fleet_maintenance_v1 where node_id=$1',[nodes[winner]]),true);
    const cancelled=await maintain('cancel');
    assert.equal(cancelled.state,'returned');
    assert.equal((await maintain('cancel')).receipt_id,cancelled.receipt_id);
    await seedSealedPackage(db,26,installedSource);
    const classify = node => dbValue(admin,'select clued_private.fleet_node_package_v1($1,$2) v',[owner,node]);
    assert.equal((await classify(nodes[winner])).classification,'previous','同源重打包按本次心跳的安装代次归属');
    assert.equal((await classify(nodes[loser])).classification,'outside','共用 Source 且没有安装代次时不能猜测当前包');
    const sameSource = await dbValue(admin,"select grant_id v from clued_private.fleet_seals_v1($1) where classification='current'",[owner]);
    await admin.query("delete from clued_private.ci_node_liveness_v1 where node_id=$1", [nodes[winner]]);
    const single = await call(other,loser,'delist',{method:'reinstall',operation_id:id(606),sole_node_agreed:true,grant_id:sameSource});
    assert.equal(single.state,'delisted');
  } finally { await db.close(); }
});

// CI 默认使用自建的正式格式资产。指定已下载的第 25 代原件时，运行其原版心跳、严格开批判定与落地代码。
const previousRelease = fileURLToPath(new URL('../../../.fleet-compat-g000025/', import.meta.url));
test('第 25 代发布原包对新库心跳、读取当班资格并在混版舰队落地',
  { skip: !existsSync(path.join(previousRelease, 'fleet-node-g000025.tar')) }, async t => {
  const folder = previousRelease;
  const asset = name => fs.readFile(path.join(folder, 'fleet-node-g000025.' + name));
  const [tar, requestBytes, acceptance] = await Promise.all([asset('tar'),asset('acceptance-request.json'),asset('acceptance.json')]);
  assert.equal(sha(tar),'8f12a26255f64967ec508bd3fd70672d64238fa91b15be3eca4720cbc1319856');
  assert.equal(sha(requestBytes),'be15cae483a63917715c5841d637adeb3b5c316bfc68c565df7210e7c5d0c93e');
  assert.equal(sha(acceptance),'af01b77e8f3c96e4087886933b7149b0eb26ed837310df8a337d740e0d662dd8');
  const req = JSON.parse(requestBytes);
  assert.equal(req.archive_sha256,sha(tar));
  const extract = await fs.mkdtemp(path.join(os.tmpdir(),'fleet-g25-reader-'));
  t.after(() => removeTestDirectory(extract));
  const entries = readTar(tar);
  await extractTar(entries.filter(e => e.path.startsWith('tree/') && /\.(mjs|json)$/.test(e.path)),path.join(extract,'release'));
  const old = relative => import(pathToFileURL(path.join(extract,'release','tree',relative)).href);
  const prefix = 'work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/';
  const { heartbeatPayload } = await old('work/independent-ci-resident-v1/src/companion-heartbeat.mjs');
  const { createMergeTrainNativeWriter: oldWriter } = await old('scripts/ci/clued-merge-train-native.mjs');
  const { strictFrontSourceHealthy } = await old(prefix + 'train-strict.mjs');
  const { landMain: oldLand } = await old(prefix + 'train-landing.mjs');
  const db = await seedPreviousSchema(t);
  try {
    await db.upgrade();
    const { admin, anon } = db;
    const source = req.ciSourceManifestSha256;
    await seedSealedPackage(db,25,source,{ commit: req.commit, archiveSha256: sha(tar), requestSha256: sha(requestBytes), kitSha256: req.firstInstallKitSha256 });
    await seedSealedPackage(db,26,installedSource);
    const now = (await dbValue(admin,'select clock_timestamp() v')).getTime();
    const heartbeat = heartbeatPayload({ scope: 'global', now, serviceRunning: true,
      status: { writtenAt: now, versions: { windows: { ciSourceManifestSha256: source }, consistent: true },
        node: { mode: 'ACTIVE', probe: { result: 'held' } }, pending: [] } });
    assert.equal((await dbValue(anon,'select public.clued_work_verify_v1($1,$2) v',[sha('fixture-primary'),heartbeat])).status,'ok');
    const writer = oldWriter({ repository: repo, scope: 'global', nativeToken: 'fixture-primary',
      supabaseUrl: 'https://fixture.invalid', publishableKey: 'fixture', fetchImpl: async (_url, options) => {
        const {p_input,p_token_hash} = JSON.parse(options.body);
        return Response.json(await dbValue(anon,'select public.clued_work_verify_v1($1,$2) v',[p_token_hash,p_input]));
      } });
    const view = await writer.nodesStatus();
    assert.equal(view.nodes.length,1);
    assert.equal(strictFrontSourceHealthy(view,source,Date.parse(view.observedAt)),true,JSON.stringify(view));
    const probe = await dbValue(admin,'select clued_private.fleet_probe_targets_v1($1,$2) v',[owner,primary]);
    assert.equal(probe.fleet_target,null);
    assert.equal(probe.fleet_update.holder_package.classification,'previous');
    let main = 'a'.repeat(40);
    const testSha = 'b'.repeat(40);
    const outcome = await oldLand({ baseSha: main, testSha, readMain: async () => main,
      port: { fastForwardMain: async tip => { main = tip; return { status: 200, sha: tip }; } } });
    assert.deepEqual(outcome,{state:'landed',mainSha:testSha,sent:true});
    await admin.query('update clued_private.ci_node_liveness_v1 set reported_source_sha256=$1 where node_id=$2',[sha('unsealed'),primary]);
    await assert.rejects(writer.nodesStatus(),/MERGE_TRAIN_NATIVE_UNREADABLE/);
  } finally { await db.close(); }
});

test('共享列车签名开批和落地由真实当班授权，检查完成后后备仍可救场，主线读回才摘牌', async t => {
  const d = await sharedTrainFixture(t);
  const {admin,user,claimResult} = d.db;
  const holder = await d.addNode('sealed holder',{legacy:true});
  const reserve = await d.addNode('sealed reserve');
  const subject = d.head();
  await d.authorize(subject);
  await d.enableV2();
  const release = await dbValue(admin,`insert into public.clued_agent_bindings
    (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic','release fixture',$2,
      array['context:read','context:write'],array['*']) returning id v`,[user,d.digest('release fixture')]);
  await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
    values($1,$2,'release-door',now(),$3)`,[user,release,claimResult.receipt_id]);
  await admin.query('select clued_private.release_door_install_v1($1)',[repo]);
  await seedSealedPackage(d.db,25,sha('reserve package'),{commit:d.sha('source')});
  const pack = await seedSealedPackage(d.db,26,d.source,{commit:d.sha('source')});
  await admin.query(`update clued_private.ci_node_liveness_v1 set reported_source_sha256=case when node_id=$1 then $2 else $3 end
    where user_id=$4`,[holder.id,d.source,sha('reserve package'),user]);
  await admin.query(`insert into clued_private.fleet_maintenance_v1(node_id,user_id,binding_generation,operation_id,grant_id,state,method,successor)
    select node_id,user_id,binding_generation,$2,$3,'reserve','handover',$4 from clued_private.ci_nodes_v1 where node_id=$1`,
    [reserve.id,d.uuid(),pack.grantId,holder.id]);
  const state = () => dbValue(admin,'select state v from clued_private.fleet_maintenance_v1 where node_id=$1',[reserve.id]);
  const projection = await d.command(holder,'work_pending');
  assert.equal(projection.holder_package?.refusal,null,JSON.stringify(projection));
  assert.equal(projection.holder_package.classification,'current');
  const staged = await d.joinAndStage(holder,subject);
  assert.equal(await state(),'reserve');
  const acquired = await d.command(holder,'batch_acquire',{batchId:staged.batchId});
  await admin.query('update clued_private.ci_node_liveness_v1 set reported_source_sha256=$1 where node_id=$2',[sha('outside'),holder.id]);
  const wrong = await d.command(holder,'landing_prepare',{ batchId:acquired.batchId,generation:acquired.generation });
  assert.equal(wrong.error_code,'ci_source_mismatch');
  await admin.query('update clued_private.ci_node_liveness_v1 set reported_source_sha256=$1 where node_id=$2',[d.source,holder.id]);
  await landReadyBatch(d,holder,acquired,staged);
  assert.equal(await state(),'delisted');
});
