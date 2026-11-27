import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
    return { admin, anon, human, heartbeat, upgrade: async () => {
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
    const recordEvidence = (node, linuxSource, linuxConsistent, acl) => admin.query(`with report as (
        select n.node_id,n.user_id,n.version,n.binding_generation,l.heartbeat_sequence,l.last_heartbeat_at,
          jsonb_build_object('schemaVersion',1,'nodeId',n.node_id,'bindingGeneration',n.binding_generation,
            'packageGeneration',24,'installGeneration',1,'installReceiptSha256',$2::text,
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
      [node, sha(`evidence for ${node}`), linuxSource, linuxConsistent, acl]);
    await t.test('过期心跳、混合 Windows/Linux Source、投影读取中漂移均阻断开单', async () => {
      await heartbeat(standby, '16 minutes');
      await refuseBeforeOpen('FLEET_TRANSITION_NODE_NOT_READY');
      await heartbeat(standby);

      assert.equal((await recordEvidence(standby, sha('other Linux Source'), false, true)).rowCount, 1);
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
