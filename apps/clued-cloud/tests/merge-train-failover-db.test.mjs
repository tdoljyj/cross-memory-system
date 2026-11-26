import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { digest as trainDigest } from '../../../work/actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Merge train step 2b (migration 20261031090000, DESIGN.md §41.6a, Task
// a3701d3d, Decision 199cf3de): automatic ci-admission failover. Heartbeats go
// to stage 1's ci_nodes_v1 through the CI command door; the Owner marks
// connections, orders them and turns the switch on in two Native steps; the
// watchdog tick hands the resident-node holder to the first healthy marked
// connection only when every §41.6a condition holds, through the same core,
// lock and checks as the one-click handover.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261031090000_merge_train_failover_v1.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const minutes = (later, earlier) => (new Date(later).getTime() - new Date(earlier).getTime()) / 60000;
const SRC = 'c'.repeat(64);
const OTHER_SRC = 'd'.repeat(64);
const HOLDER = { mode: 'ACTIVE', probe: 'held' };
const jwk = () => ({ kty: 'EC', crv: 'P-256', x: crypto.randomBytes(32).toString('base64url'), y: crypto.randomBytes(32).toString('base64url') });


test('ci-admission automatic failover (§41.6a): heartbeat, Owner settings, watchdog triggers, selection and handover',
  { timeout: 900000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-merge-train-failover-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  const connect = async (role) => {
    const client = server.getPgClient(); clients.push(client); await client.connect();
    if (role) await client.query(`set role ${role}`);
    return client;
  };
  try {
    await startCluster(server);
    const admin = await connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(names.includes(MIGRATION));
    for (const name of names) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    await enableManualOwnerApprovalFixture(admin);

    const anon = await connect('anon');
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const human = await connect('authenticated');
    const native = async (claims, name, input) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const issued = (result) => { assert.equal(result.status, 'issued', JSON.stringify(result)); return result; };
    const tickAll = async (client = admin) => (await client.query('select clued_private.ci_admission_failover_tick_v1() v')).rows[0].v;

    // One isolated account per scenario: its own user, project, connections,
    // stage-1 node rows and ci-admission rows. The tick decides every account
    // that has marked connections; close() unmarks them when a scenario ends.
    let accountCount = 0;
    const account = async (label, nodeNames, { holder = nodeNames[0], extra = true, session = 'sess-' + label, plain = [], heartbeat = [] } = {}) => {
      const user = uuid();
      const claims = fresh(user, session);
      await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())`,
        [user, `${label}-${++accountCount}@example.invalid`]);
      const project = uuid();
      await admin.query('begin');
      await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,project_schema_version,project_recognized_v2)
        values($1,$2,$3,$3,$4,2,true)`, [project, user, 'failover-' + project, 'project:' + project]);
      await admin.query(`insert into clued_private.project_lifecycle_v2_dispositions(project_id,user_id,disposition,disposition_reason,
        recognition_confidence,recognition_source,basis,disposition_hash)
        values($1,$2,'recognized_project','Synthetic isolated database fixture',1,'v2_explicit_create','{}',$3)`, [project, user, hash()]);
      await admin.query('commit');
      const ids = {}; const tokens = {}; const nodes = {};
      const bind = async (name, scopes) => {
        tokens[name] = hash();
        ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
          values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, name, tokens[name], scopes])).rows[0].id;
      };
      const receipt = async () => (await admin.query(`insert into public.clued_audit_receipts
        (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
        values($1,null,'global','fixture','fixture','fixture',1,'{}'::jsonb) returning id`, [user])).rows[0].id;
      for (const name of nodeNames) {
        await bind(name, ['context:read']);
        // Registration is stage 1's own Native flow (ci-scheduling-stage1-db); the row is written directly here.
        nodes[name] = (await admin.query(`insert into clued_private.ci_nodes_v1(user_id,project_id,binding_id,name,profile,profile_sha256,
          identity_public_jwk,encryption_public_jwk,identity_fingerprint,encryption_fingerprint,registration_digest,idempotency_key)
          values($1,$2,$3,$4,'{}'::jsonb,$5,$6,$7,$8,$9,$10,$11) returning node_id`,
        [user, project, ids[name], name.toUpperCase(), hash(), jwk(), jwk(), hash(), hash(), hash(), uuid()])).rows[0].node_id;
      }
      // Connections without a node (heartbeat connections to be linked).
      for (const name of plain) await bind(name, ['context:read']);
      // Heartbeat-only connections (ci:heartbeat, 20261031085000), as the headless page issues them:
      // the salted verifier of the token's SHA-256 and a headless authorization. The token below is that SHA-256.
      for (const name of heartbeat) {
        tokens[name] = hash();
        ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
          values($1,'Headless',$2,clued_private.ci_heartbeat_token_hash_v1($3),array['ci:heartbeat'],array['global']) returning id`,
        [user, name, tokens[name]])).rows[0].id;
        await admin.query(`insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
          values($1,null,$2,'clued-headless',$3,'clued:ci-heartbeat',now()+interval '30 days','headless')`, [ids[name], user, name]);
      }
      if (extra) {
        await bind('env', ['context:read']);
        await bind('park', ['context:read']);
        await bind('reader', ['context:read']);
        await bind('writer', ['context:write']);
        await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
          values($1,$2,'ci-admission',now()-interval '1 day',$3,now()-interval '1 day','other'),
                ($1,$4,'ci-admission',now()-interval '1 day',$5,'infinity','parking')`,
        [user, ids.env, await receipt(), ids.park, await receipt()]);
      }
      if (holder) {
        await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
          values($1,$2,'ci-admission',now()-interval '1 day',$3,now()-interval '1 day','resident-node')`, [user, ids[holder], await receipt()]);
      }
      const nameOf = (id) => Object.keys(ids).find((k) => ids[k] === id) ?? id;
      const ctx = {
        user, claims, ids, tokens, nodes, project, nameOf, receipt,
        native: (name, input, c = claims) => native(c, name, input),
        door: async (who, input) => (await anon.query('select public.clued_work_verify_v1($1,$2) v',
          [tokens[who], { scope: 'global', ...input }])).rows[0].v,
        beat: async (who, over = {}) => {
          const input = { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'STANDBY', probe: 'not-held',
            ci_source_manifest_sha256: SRC, service_running: true, snapshot_age_seconds: 5, ...over };
          for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
          const v = await ctx.door(who, input);
          assert.equal(v.status, 'ok', who + ' ' + JSON.stringify(v));
          return v;
        },
        // The stage-1 row's own fields next to the node's liveness row (null fields before its first heartbeat).
        node: async (who) => (await admin.query(`select n.version,n.updated_at,n.state,n.last_heartbeat_at stage1_last_heartbeat_at,
          n.heartbeat_sequence stage1_heartbeat_sequence,l.* from clued_private.ci_nodes_v1 n
          left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id where n.node_id=$1`, [nodes[who]])).rows[0],
        // Time passes for this account: every stored time moves back.
        ago: async (mins) => {
          const i = `${mins} minutes`;
          // Every time column of the liveness row, read from the catalog: a column a later migration adds moves too.
          const times = (await admin.query(`select column_name c from information_schema.columns where table_schema='clued_private'
            and table_name='ci_node_liveness_v1' and data_type='timestamp with time zone' order by ordinal_position`)).rows.map((r) => r.c);
          await admin.query(`update clued_private.ci_node_liveness_v1 set ${times.map((c) => `${c}=${c}-$2::interval`).join(',')}
            where user_id=$1`, [user, i]);
          await admin.query('update clued_private.ci_failover_members_v1 set marked_at=marked_at-$2::interval where user_id=$1', [user, i]);
          await admin.query(`update clued_private.ci_failover_settings_v1 set enabled_at=enabled_at-$2::interval,
            updated_at=updated_at-$2::interval where user_id=$1`, [user, i]);
          await admin.query('update public.clued_audit_receipts set created_at=created_at-$2::interval where user_id=$1', [user, i]);
          await admin.query('update clued_private.ci_duty_answers_v1 set at=at-$2::interval where user_id=$1', [user, i]);
          await admin.query(`update clued_private.binding_roles_v1 set granted_at=granted_at-$2::interval,
            effective_at=effective_at-$2::interval,revoked_at=revoked_at-$2::interval where user_id=$1`, [user, i]);
        },
        tick: async (client) => {
          const all = await tickAll(client);
          const mine = all.accounts.find((a) => a.user_id === user);
          assert.ok(mine, 'the tick decides this account: ' + JSON.stringify(all));
          return mine;
        },
        view: async () => committed({ ...(await ctx.native('clued_resident_failover_v1', {})), status: 'committed' }),
        issueMembers: async (list, base) => ctx.native('clued_resident_failover_confirmation_issue_v1',
          { change: 'members', members: list.map((n) => ids[n] ?? n), base_version: base ?? (await ctx.view()).setting.version }),
        issueSwitch: async (enabled, base) => ctx.native('clued_resident_failover_confirmation_issue_v1',
          { change: 'switch', enabled, base_version: base ?? (await ctx.view()).setting.version }),
        apply: async (token, c = claims) => ctx.native('clued_resident_failover_set_v1',
          { confirmation_token: token.confirmation_token, view_digest: token.view_digest }, c),
        members: async (list) => committed(await ctx.apply(issued(await ctx.issueMembers(list)))),
        switch: async (enabled) => committed(await ctx.apply(issued(await ctx.issueSwitch(enabled)))),
        holders: async () => (await admin.query(`select r.binding_id from clued_private.binding_roles_v1 r
          where r.user_id=$1 and r.role='ci-admission' and r.revoked_at is null and r.purpose in ('resident-node','unspecified')
          order by r.binding_id`, [user])).rows.map((r) => nameOf(r.binding_id)),
        role: async (who) => (await admin.query(`select * from clued_private.binding_roles_v1
          where binding_id=$1 and role='ci-admission' and revoked_at is null`, [ids[who]])).rows[0],
        admits: async (who) => (await admin.query(`select clued_private.binding_role_admits_v1(b,'ci-admission') ok
          from public.clued_agent_bindings b where b.id=$1`, [ids[who]])).rows[0].ok,
        receipt_: async (id) => (await admin.query('select * from public.clued_audit_receipts where id=$1', [id])).rows[0],
        handover: async (from, to) => {
          const token = issued(await ctx.native('clued_binding_role_handover_confirmation_issue_v1',
            { from_binding_id: ids[from], to_binding_id: ids[to] }));
          return committed(await ctx.native('clued_binding_role_handover_v1',
            { confirmation_token: token.confirmation_token, view_digest: token.view_digest }));
        },
        notes: async () => (await admin.query(`select id,title,content,type_fields,record_type from public.clued_memories
          where user_id=$1 and record_type='note' order by created_at,id`, [user])).rows,
        excluded: async (who) => (await admin.query('select clued_private.ci_failover_exclusion_v1($1,$2,clock_timestamp()) v',
          [user, ids[who]])).rows[0].v,
        close: async () => { await admin.query('delete from clued_private.ci_failover_members_v1 where user_id=$1', [user]); },
      };
      return ctx;
    };
    const reasons = (outcome, who, ctx) => outcome.candidates.find((c) => c.binding_id === ctx.ids[who]).reasons;
    const target = (outcome, ctx) => outcome.target ? ctx.nameOf(outcome.target) : null;

    await t.test('surface: CI8 and GW80 unchanged, Owner RPCs to authenticated only, private functions to nobody', async () => {
      await assertGatewayCloseoutBoundary(admin);
      const can = async (role, signature) => (await admin.query(
        `select has_function_privilege($1,$2::regprocedure,'execute') v`, [role, signature])).rows[0].v;
      for (const fn of ['public.clued_resident_failover_v1(jsonb)', 'public.clued_resident_failover_confirmation_issue_v1(jsonb)',
        'public.clued_resident_failover_set_v1(jsonb)', 'public.clued_binding_role_handover_v1(jsonb)']) {
        assert.deepEqual([await can('anon', fn), await can('authenticated', fn), await can('service_role', fn),
          await can('clued_worker_gateway', fn)], [false, true, false, false], fn);
        await assert.rejects(() => anon.query(`select ${fn.replace('(jsonb)', '')}($1)`, [{}]), /permission denied/, fn);
      }
      const privates = (await admin.query(`select p.oid::regprocedure::text sig from pg_proc p
        where p.pronamespace='clued_private'::regnamespace and (p.proname like 'ci_failover%' or p.proname like 'ci_admission_failover%'
          or p.proname in ('ci_node_heartbeat_v1','binding_role_handover_core_v1','work_claim_ci_command_v1','ci_sweep_watermark_v1'))`)).rows.map((r) => r.sig);
      // ADR 0026 added ci_failover_quiet_seconds_v1 and ci_failover_holder_quiet_v1.
      assert.equal(privates.length, 27, privates.join(' '));
      for (const sig of privates) {
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
          assert.equal(await can(role, sig), false, `${role} ${sig}`);
        }
      }
      for (const table of ['ci_failover_settings_v1', 'ci_failover_members_v1', 'ci_failover_watchdog_v1', 'ci_node_liveness_v1',
        'ci_sweep_watermark_v1', 'ci_node_heartbeat_link_v1', 'ci_duty_answers_v1']) {
        assert.equal((await admin.query(`select relrowsecurity from pg_class where oid=('clued_private.'||$1)::regclass`, [table])).rows[0].relrowsecurity, true);
        await assert.rejects(() => anon.query(`select * from clued_private.${table}`), /permission denied/);
        await assert.rejects(() => human.query(`select * from clued_private.${table}`), /permission denied/);
      }
      // Stage 1's node table keeps exactly its own columns: heartbeats live in ci_node_liveness_v1.
      const stage1Columns = (await admin.query(`select column_name from information_schema.columns
        where table_schema='clued_private' and table_name='ci_nodes_v1' order by ordinal_position`)).rows.map((r) => r.column_name);
      assert.ok(!stage1Columns.some((c) => /^(reported_|readable_|unhealthy_|heartbeat_previous)/.test(c)), stage1Columns.join(' '));
      // Every public RPC that makes the Native owner check is VOLATILE (PostgREST read-only transactions).
      assert.deepEqual((await admin.query(`select p.proname from pg_proc p where p.pronamespace='public'::regnamespace
        and p.provolatile<>'v' and p.prosrc like '%authorization_owner_v12%'`)).rows, []);
      // The role checks keep every earlier patch (resident-upgrade, 20261030010000) and gain only the
      // heartbeat-connection check; the patch helper is gone.
      const body = async (sig) => (await admin.query('select prosrc from pg_proc where oid=$1::regprocedure', [sig])).rows[0].prosrc;
      const change = await body('clued_private.binding_role_change_check_v1(clued_agent_bindings,text,boolean,jsonb)');
      for (const piece of ["if p_role='resident-upgrade' then", 'binding_role_exclusive', 'binding_role_scope_invalid',
        'binding_role_node_name_invalid', 'binding_role_node_taken', "x.role='resident-upgrade'",
        'binding_role_resident_holder_exists', 'binding_role_parking_protected', 'binding_role_heartbeat_connection']) {
        assert.ok(change.includes(piece), 'binding_role_change_check_v1 keeps ' + piece);
      }
      assert.equal(change.split('binding_role_exclusive').length - 1, 2);
      const handoverCheck = await body('clued_private.binding_role_handover_check_v1(clued_agent_bindings,clued_agent_bindings)');
      for (const piece of ["r.role in ('ci-admission','resident-upgrade')", 'binding_role_handover_target_holds_role',
        'binding_role_resident_held_v1', 'binding_role_parking_protected', 'binding_role_heartbeat_connection']) {
        assert.ok(handoverCheck.includes(piece), 'binding_role_handover_check_v1 keeps ' + piece);
      }
      assert.equal((await admin.query(`select to_regprocedure('clued_private.ci_failover_role_patch_v1(text,text,text)') r`)).rows[0].r, null);
      // The CI door is 2a's body plus the two node actions; the duty check (20261105160000: ci_duty_admits_v1, which reads
      // the role with effective_at<=clock_timestamp()) is the only duty read and replaces the direct role read.
      const door = (await admin.query(`select prosrc from pg_proc where oid='clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure`)).rows[0].prosrc;
      const gate = "ci_duty_admits_v1(b.user_id,b.id,'duty_role')";
      assert.equal(door.split(gate).length - 1, 1);
      assert.ok(!door.includes('binding_roles_v1'), 'no direct role read is left in the door');
      assert.ok(door.indexOf("op='ci_node_heartbeat'") < door.indexOf(gate), 'heartbeats come before the role check');
      assert.ok(door.indexOf("op='ci_nodes_status'") > door.indexOf(gate), 'the node status is for the holder only');
      // The watchdog adds no direct reader of the role table; only the shared core writes it.
      const readers = (await admin.query(`select p.oid::regprocedure::text sig from pg_proc p where p.prosrc like '%binding_roles_v1%'
        and (p.proname like '%failover%' or p.proname like '%handover%' or p.proname='ci_node_heartbeat_v1') order by 1`)).rows.map((r) => r.sig);
      assert.deepEqual(readers, ['clued_private.binding_role_handover_check_v1(clued_agent_bindings,clued_agent_bindings)',
        'clued_private.binding_role_handover_core_v1(uuid,uuid,uuid,text,jsonb)',
        'clued_private.binding_role_handover_view_v1(clued_agent_bindings,clued_agent_bindings)']);
      // The pg_cron job, guarded like the storage sweep (no pg_cron in this fixture).
      const migration = await fs.readFile(path.join(root, 'supabase/migrations', MIGRATION), 'utf8');
      assert.match(migration, /else\s+raise warning 'ci_admission_failover_scheduler_absent/);
      // The watchdog's receipt reads have their own partial index, matching how the receipts are written.
      assert.match((await admin.query(`select indexdef from pg_indexes where indexname='clued_audit_receipts_ci_failover_v1'`)).rows[0].indexdef,
        /\(user_id, created_at DESC\) WHERE \(\(context_key = 'global'::text\) AND \(operation = ANY/);
      assert.match(migration, /if to_regprocedure\('cron\.schedule\(text,text,text\)'\) is not null then\s+perform cron\.schedule\('clued-ci-admission-failover','\* \* \* \* \*',\s+'select clued_private\.ci_admission_failover_tick_v1\(\)'\);/);
    });

    await t.test('heartbeat: every node, server time, latest report only, look-back, clamp, refusals', async () => {
      const s = await account('hb', ['a', 'b']);
      const before = await s.node('b');
      // A standby node that holds no role reports through the same door.
      const first = await s.beat('b');
      assert.deepEqual(first.node_ids, [s.nodes.b]);
      assert.deepEqual(first.auto_handovers, []);
      assert.ok('last_tick_at' in first.watchdog);
      let n = await s.node('b');
      assert.equal(Number(n.heartbeat_sequence), 1);
      assert.equal(n.heartbeat_previous_at, null);
      assert.ok(Math.abs(n.last_heartbeat_at.getTime() - new Date(first.received_at).getTime()) < 1);
      assert.deepEqual([n.reported_mode, n.reported_probe, n.reported_state, n.reported_source_sha256, n.readable_state],
        ['STANDBY', 'not-held', 'NORMAL', SRC, 'NORMAL']);
      // Stage 1's row is not written at all.
      assert.deepEqual([n.version, n.updated_at, n.state], [before.version, before.updated_at, before.state]);
      assert.deepEqual([n.stage1_last_heartbeat_at, Number(n.stage1_heartbeat_sequence)], [null, 0]);
      // A name in the payload is ignored: the token decides the node.
      await s.beat('b', { node_name: 'A' });
      assert.equal(Number((await s.node('a')).heartbeat_sequence), 0);
      n = await s.node('b');
      assert.equal(Number(n.heartbeat_sequence), 2);
      assert.ok(n.heartbeat_previous_at < n.last_heartbeat_at);
      // A time, a node id or anything else in the payload is refused.
      for (const bad of [{ at: '2020-01-01T00:00:00Z' }, { last_heartbeat_at: '2020-01-01T00:00:00Z' }, { node_id: s.nodes.a },
        { state: 'SLEEPING' }, { state: 'INTAKE_PAUSED' }, { intake_paused_until: '2099-01-01T00:00:00Z' },
        { mode: 'LEADER' }, { mode: undefined }, { service_running: 'yes' }, { snapshot_age_seconds: -1 },
        { ci_source_manifest_sha256: 'x' }, { halt: 'HALT' }, { state: 'INTAKE_PAUSED', intake_paused_until: 'soon' }]) {
        const input = { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'STANDBY', service_running: true, ...bad };
        for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
        await assert.rejects(() => s.door('b', input), /work_claim_ci_command_invalid/, JSON.stringify(bad));
      }
      assert.equal(Number((await s.node('b')).heartbeat_sequence), 2);
      // A connection without a stage-1 node is refused; nothing is written.
      assert.deepEqual(await s.door('reader', { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'STANDBY', service_running: true }),
        { status: 'rejected', error_code: 'ci_node_not_registered' });
      // A revoked or retired node row takes no heartbeat.
      await admin.query("update clued_private.ci_nodes_v1 set state='retired' where node_id=$1", [s.nodes.a]);
      assert.equal((await s.door('a', { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'ACTIVE', service_running: true })).error_code,
        'ci_node_not_registered');
      await admin.query("update clued_private.ci_nodes_v1 set state='pending' where node_id=$1", [s.nodes.a]);
      // UNKNOWN keeps the latest readable report; mode may be absent.
      await s.beat('b', { state: 'HALTED', halt: { code: 'BYTE_DRIFT', at: '2026-10-31T07:00:00Z', pr: 'o/r#9', head: 'a'.repeat(40) } });
      await s.beat('b', { state: 'UNKNOWN', mode: undefined, probe: undefined, service_running: false, snapshot_age_seconds: undefined,
        ci_source_manifest_sha256: undefined });
      n = await s.node('b');
      assert.deepEqual([n.reported_state, n.reported_mode, n.readable_state, n.reported_halt, n.reported_source_sha256],
        ['UNKNOWN', null, 'HALTED', null, SRC], 'the latest report replaces the previous one; Source is the latest recorded');
      assert.ok(n.unhealthy_since);
      // INTAKE_PAUSED's end is clamped to now + 200 minutes.
      const paused = await s.beat('b', { state: 'INTAKE_PAUSED', intake_paused_until: '2099-01-01T00:00:00Z' });
      n = await s.node('b');
      assert.ok(Math.abs(minutes(n.reported_intake_until, paused.received_at) - 200) < 0.01);
      assert.equal(n.readable_intake_until.getTime(), n.reported_intake_until.getTime());
      assert.equal(n.unhealthy_since, null, 'service running with a fresh snapshot ends the run');
      // The node status is the role holder's: a standby node is refused, the holder reads every node.
      assert.equal((await s.door('b', { action: 'ci_nodes_status' })).error_code, 'admission_binding_required');
      const status = await s.door('a', { action: 'ci_nodes_status' });
      assert.equal(status.status, 'ok');
      assert.deepEqual(status.nodes.map((x) => x.agent_name), ['b']);
      assert.equal(status.nodes[0].node.ci_source_manifest_sha256, SRC);
      await assert.rejects(() => s.door('a', { action: 'ci_nodes_status', extra: 1 }), /work_claim_ci_command_invalid/);
      // The watchdog's last tick reaches every heartbeat answer.
      const tick = await tickAll();
      const answer = await s.beat('b');
      assert.equal(new Date(answer.watchdog.last_tick_at).getTime(), new Date(tick.tick_at).getTime());
      assert.equal(answer.watchdog.stale, false);
      await admin.query("update clued_private.ci_failover_watchdog_v1 set last_tick_at=last_tick_at-interval '6 minutes'");
      assert.equal((await s.beat('b')).watchdog.stale, true, 'more than 5 minutes without a tick');
    });

    await t.test('a heartbeat leaves stage 1 untouched: a pending node confirmation still commits', async () => {
      const session = uuid();
      const s = await account('stage1', ['a', 'b'], { session });
      await admin.query(`insert into auth.sessions(id,user_id,not_after) values($1,$2,now()+interval '1 hour')`, [session, s.user]);
      const view = async () => (await admin.query(`select clued_private.ci_node_view_v1(n) v from clued_private.ci_nodes_v1 n
        where n.node_id=$1`, [s.nodes.b])).rows[0].v;
      const before = await view();
      const token = issued(await s.native('clued_ci_node_confirmation_issue_v1', { project_id: s.project, node_id: s.nodes.b,
        base_version: 1, action: 'approve', accepted_ref: 'fixture-owner-acceptance' }));
      // Between the Owner's two steps the node reports, twice, with a new state.
      await s.beat('b');
      await s.beat('b', { state: 'HALTED', halt: { code: 'X' } });
      assert.deepEqual(await view(), before, 'stage 1\'s node view does not move');
      const applied = committed(await s.native('clued_ci_node_apply_v1',
        { confirmation_token: token.confirmation_token, view_digest: token.view_digest }));
      assert.deepEqual([applied.node_id, applied.state, applied.version], [s.nodes.b, 'active', 2]);
      // The approved node keeps reporting into its liveness row.
      await s.beat('b');
      assert.equal(Number((await s.node('b')).heartbeat_sequence), 3);
    });

    await t.test('Owner settings: two Native steps, order, switch, receipts, refusals', async () => {
      const s = await account('owner', ['a', 'b', 'c']);
      const empty = await s.view();
      assert.deepEqual([empty.setting.enabled, empty.setting.version, empty.members], [false, 0, []]);
      // ADR 0026 (migration 20261112130500): 5 minutes (Owner, Decision b2e25a57 v3), the heartbeat comes every minute.
      assert.deepEqual([empty.rules.silence_minutes, empty.rules.unhealthy_minutes, empty.rules.snapshot_stale_minutes, empty.rules.target_heartbeat_minutes],
        [5, 5, 5, 5]);
      assert.deepEqual(empty.connections.map((c) => c.agent_name).sort(), ['a', 'b', 'c', 'env', 'park', 'reader']);
      const err = async (p) => (await p).error_code;
      assert.equal(await err(s.issueMembers(['a', 'writer'])), 'resident_failover_scope_missing');
      assert.equal(await err(s.issueMembers(['a', 'env'])), 'resident_failover_purpose_invalid', 'an "other" holder is not a resident node');
      assert.equal(await err(s.issueMembers(['park'])), 'resident_failover_purpose_invalid');
      assert.equal(await err(s.issueMembers(['a', 'a'])), 'resident_failover_input_invalid');
      assert.equal(await err(s.issueMembers([uuid()])), 'resident_failover_binding_invalid');
      assert.equal(await err(s.issueMembers([])), 'resident_failover_unchanged');
      assert.equal(await err(s.issueMembers(['a'], 3)), 'resident_failover_version_conflict');
      assert.equal(await err(s.issueSwitch(false)), 'resident_failover_unchanged');
      assert.equal((await s.native('clued_resident_failover_confirmation_issue_v1', { change: 'switch', enabled: true, base_version: 0, x: 1 })).error_code,
        'resident_failover_input_invalid');
      const { session_id: _omit, ...noSession } = s.claims;
      assert.equal((await s.native('clued_resident_failover_confirmation_issue_v1', { change: 'switch', enabled: true, base_version: 0 },
        noSession)).error_code, 'confirmation_token_session_id_required');
      const other = await account('owner-other', ['z'], { extra: false });
      assert.equal(await err(s.issueMembers([other.ids.z])), 'resident_failover_binding_invalid', 'another account\'s connection');

      // Step 1 renders exactly what changes; step 2 commits it once.
      const older = issued(await s.issueMembers(['b', 'a']));
      const token = issued(await s.issueMembers(['a', 'b', 'c']));
      assert.equal((await s.apply(older)).error_code, 'confirmation_token_revoked', 'a newer issue revokes the older token');
      assert.deepEqual(token.confirmation_view.members.map((m) => [s.nameOf(m.binding_id), m.rank]), [['a', 1], ['b', 2], ['c', 3]]);
      assert.deepEqual(token.confirmation_view.members_before, []);
      assert.equal((await s.apply(token, fresh(s.user, 'sess-elsewhere'))).error_code, 'confirmation_token_binding_mismatch');
      const again = issued(await s.issueMembers(['a', 'b', 'c']));
      const set = committed(await s.apply(again));
      assert.deepEqual([set.version, set.enabled, set.members.map((m) => s.nameOf(m.binding_id))], [1, false, ['a', 'b', 'c']]);
      const replay = await s.apply(again);
      assert.deepEqual([replay.status, replay.replayed, replay.receipt_id], ['committed', true, set.receipt_id]);
      const r1 = (await s.receipt_(set.receipt_id)).metadata;
      assert.deepEqual([r1.receipt_kind, r1.principal, r1.session_id, r1.members.map((m) => [s.nameOf(m.binding_id), m.rank])],
        ['RESIDENT_FAILOVER_MEMBERS_SET', 'native_account_session', 'sess-owner', [['a', 1], ['b', 2], ['c', 3]]]);
      const marked = Object.fromEntries((await admin.query('select binding_id,marked_at from clued_private.ci_failover_members_v1 where user_id=$1',
        [s.user])).rows.map((r) => [s.nameOf(r.binding_id), r.marked_at.getTime()]));
      // Reordering and unmarking: a connection that stays keeps its marked_at.
      await s.ago(10);
      committed(await s.members(['c', 'a']));
      const after = (await admin.query('select binding_id,rank,marked_at from clued_private.ci_failover_members_v1 where user_id=$1 order by rank',
        [s.user])).rows;
      assert.deepEqual(after.map((r) => [s.nameOf(r.binding_id), r.rank]), [['c', 1], ['a', 2]]);
      assert.equal(after[1].marked_at.getTime(), marked.a - 600000);
      // The switch, default off, also two steps.
      const on = issued(await s.issueSwitch(true));
      assert.deepEqual([on.confirmation_view.change, on.confirmation_view.enabled], ['switch', true]);
      const enabled = committed(await s.apply(on));
      assert.equal(enabled.enabled, true);
      assert.ok(enabled.enabled_at);
      assert.equal((await s.receipt_(enabled.receipt_id)).metadata.receipt_kind, 'RESIDENT_FAILOVER_ENABLED');
      // A view that changed between the steps is stale, and the token is burned.
      const stale = issued(await s.issueMembers(['c', 'a', 'b']));
      await admin.query("update public.clued_agent_bindings set agent_name='a-renamed' where id=$1", [s.ids.a]);
      assert.equal((await s.apply(stale)).error_code, 'confirmation_view_stale');
      assert.equal((await s.apply(stale)).error_code, 'confirmation_token_reused');
      // A connection revoked between the steps is refused by name.
      const gone = issued(await s.issueMembers(['c', 'a', 'b']));
      await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [s.ids.b]);
      assert.equal((await s.apply(gone)).error_code, 'resident_failover_binding_invalid');
      assert.equal(await err(s.issueMembers(['c', 'a', 'b'])), 'resident_failover_binding_invalid');
      const off = committed(await s.switch(false));
      assert.deepEqual([off.enabled, off.enabled_at], [false, null]);
      assert.equal((await s.receipt_(off.receipt_id)).metadata.receipt_kind, 'RESIDENT_FAILOVER_DISABLED');
      // Nobody else reaches the settings.
      await assert.rejects(() => gateway.query('select public.clued_resident_failover_v1($1)', [{}]), /permission denied/);
      await s.close(); await other.close();
    });

    await t.test('selection: unmarked never, Owner order, every unhealthy kind skipped, Source of every node, switch off', async () => {
      const s = await account('pick', ['a', 'b', 'c', 'd', 'e']);
      await s.members(['a', 'b', 'c', 'd']);
      // X never heard since it was marked: wait, then only an alert.
      assert.equal((await s.tick()).outcome, 'holder_not_heard_yet');
      await s.ago(30);
      let o = await s.tick();
      assert.equal(o.outcome, 'holder_never_heartbeated');
      assert.ok(o.alert_receipt_id);
      assert.equal((await s.receipt_(o.alert_receipt_id)).metadata.receipt_kind, 'CI_ADMISSION_FAILOVER_WITHHELD');
      await s.beat('a', HOLDER);
      for (const n of ['b', 'c', 'd', 'e']) await s.beat(n);
      assert.equal((await s.tick()).outcome, 'holder_alive');
      await s.ago(30);
      for (let i = 0; i < 2; i++) for (const n of ['b', 'c', 'd', 'e']) await s.beat(n);
      // The switch is off: the watchdog decides and alerts, and hands nothing over.
      o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s)], ['switch_off', 'b']);
      assert.equal((await s.receipt_(o.alert_receipt_id)).metadata.reason, 'switch_off');
      assert.deepEqual(await s.holders(), ['a']);
      // The first unhealthy candidate is skipped for the next, by its latest report.
      const cases = [
        [{ state: 'HALTED', halt: { code: 'X' } }, 'state_halted'], [{ state: 'PAUSED' }, 'state_paused'],
        [{ state: 'INTAKE_PAUSED', intake_paused_until: '2099-01-01T00:00:00Z' }, 'state_intake_paused'],
        [{ state: 'UNKNOWN', mode: undefined, probe: undefined }, 'state_unknown'], [{ mode: 'ACTIVE' }, 'not_standby'],
        [{ mode: 'UNCERTAIN' }, 'not_standby'], [{ probe: 'held' }, 'probe_not_clear'], [{ probe: undefined }, 'probe_not_clear'],
        [{ service_running: false }, 'service_not_running'], [{ snapshot_age_seconds: 301 }, 'service_not_running'],
      ];
      for (const [report, reason] of cases) {
        await s.beat('b', report);
        o = await s.tick();
        assert.deepEqual([o.outcome, target(o, s)], ['switch_off', 'c'], reason);
        assert.ok(o.alert_receipt_id === null, 'one switch_off alert an hour');
        await s.beat('b');
        assert.equal(target(await s.tick(), s), 'b', 'only the latest report counts: ' + reason);
      }
      // A heartbeat older than 5 minutes (ADR 0026; it was 20).
      // steady_since moves with it: it is never after last_heartbeat_at (20261115120000's check).
      await admin.query(`update clued_private.ci_node_liveness_v1 set last_heartbeat_at=last_heartbeat_at-interval '301 seconds',
        heartbeat_previous_at=heartbeat_previous_at-interval '301 seconds',steady_since=steady_since-interval '301 seconds'
        where node_id=$1`, [s.nodes.b]);
      o = await s.tick();
      assert.equal(target(o, s), 'c');
      // Same Source as X and as every node heard in 24 hours (marked or not):
      // b now runs a different Source, so b differs from X, and c and d differ from b.
      await s.beat('b', { ci_source_manifest_sha256: OTHER_SRC });
      o = await s.tick();
      assert.equal(o.outcome, 'no_target');
      assert.ok(reasons(o, 'b', s).includes('source_differs_from_holder'));
      assert.ok(reasons(o, 'c', s).includes('source_differs'));
      await s.beat('b'); await s.beat('b');
      assert.equal(target(await s.tick(), s), 'b');
      // An unmarked node with another Source, heard in 24 hours, blocks everyone; older than 24 hours it does not count.
      await s.beat('e', { ci_source_manifest_sha256: OTHER_SRC });
      o = await s.tick();
      assert.equal(o.outcome, 'no_target');
      assert.deepEqual(o.candidates.map((c) => c.reasons), [['source_differs'], ['source_differs'], ['source_differs']]);
      await admin.query(`update clued_private.ci_node_liveness_v1 set last_heartbeat_at=last_heartbeat_at-interval '25 hours',
        heartbeat_previous_at=heartbeat_previous_at-interval '25 hours',steady_since=steady_since-interval '25 hours'
        where node_id=$1`, [s.nodes.e]);
      assert.equal(target(await s.tick(), s), 'b');
      // The Owner's order decides.
      await s.members(['a', 'c', 'b', 'd']);
      assert.equal(target(await s.tick(), s), 'c');
      // An unmarked healthy node is never chosen.
      await s.beat('e'); await s.beat('e');
      for (const n of ['b', 'c', 'd']) await s.beat(n, { state: 'HALTED' });
      o = await s.tick();
      assert.equal(o.outcome, 'no_target');
      assert.deepEqual(o.candidates.map((c) => s.nameOf(c.binding_id)), ['c', 'b', 'd'], 'only marked connections, in order');
      // NO_TARGET is alerted at most once an hour.
      const alerts = async () => (await admin.query(`select count(*)::int n from public.clued_audit_receipts where user_id=$1
        and metadata->>'receipt_kind'='CI_ADMISSION_FAILOVER_NO_TARGET'`, [s.user])).rows[0].n;
      const counted = await alerts();
      assert.equal((await s.tick()).alert_receipt_id, null);
      assert.equal(await alerts(), counted);
      await s.close();
    });

    await t.test('silence: 4.9 minutes no, 5 yes (ADR 0026); receiver alive needs 2 heartbeats; handover, 5-minute start, one holder, receipts', async () => {
      const s = await account('silence', ['a', 'b']);
      await s.members(['a', 'b']);
      await s.switch(true);
      // X after the switch: a heartbeat before the switch does not count.
      await s.beat('b'); await s.beat('a', HOLDER);
      await s.ago(4);
      assert.equal((await s.tick()).outcome, 'holder_alive');
      await s.ago(0.9);
      assert.equal((await s.tick()).outcome, 'holder_alive', '4.9 minutes');
      await s.ago(0.1);
      let o = await s.tick();
      // b heard 5 minutes ago too: no target (0 heartbeats during the silence), alert only.
      assert.equal(o.outcome, 'no_target');
      assert.deepEqual(reasons(o, 'b', s), ['heartbeat_stale']);
      const first = o.alert_receipt_id;
      assert.ok(first);
      // The alert written now also writes a KooYomi Note quoting its receipt.
      assert.equal(o.note.status, 'committed', JSON.stringify(o.note));
      let notes = await s.notes();
      assert.equal(notes.length, 1);
      assert.deepEqual([notes[0].id, notes[0].type_fields.note_kind, notes[0].type_fields.receipt_id, notes[0].type_fields.receipt_kind],
        [o.note.note_id, 'ci_admission_failover', first, 'CI_ADMISSION_FAILOVER_NO_TARGET']);
      assert.ok(notes[0].content.includes(first) && notes[0].content.includes('a') && notes[0].content.includes('heartbeat_stale'));
      const quiet = await s.tick();
      assert.deepEqual([quiet.alert_receipt_id, quiet.note], [null, null], 'NO_TARGET at most once an hour, and no Note without it');
      assert.equal((await s.notes()).length, 1);
      await s.ago(60);
      o = await s.tick();
      assert.equal(o.outcome, 'no_target');
      assert.ok(o.alert_receipt_id && o.alert_receipt_id !== first, 'again after an hour');
      assert.equal(o.note.status, 'committed');
      assert.equal((await s.notes()).length, 2);
      // One heartbeat of Y during X's silence: maybe the server was down; alert only.
      await s.beat('b');
      o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s)], ['receiver_not_alive', 'b']);
      assert.equal((await s.receipt_(o.alert_receipt_id)).metadata.reason, 'receiver_not_alive');
      assert.deepEqual(await s.holders(), ['a']);
      // Two: hand over.
      const roleRowsBefore = (await admin.query(`select to_jsonb(r) v from clued_private.binding_roles_v1 r
        where binding_id=any($1) order by id`, [[s.ids.env, s.ids.park]])).rows;
      await s.beat('b');
      o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s), o.trigger], ['handed_over', 'b', 'silence']);
      assert.deepEqual(await s.holders(), ['b'], 'at most one resident-node holder');
      const rows = (await admin.query(`select x.revoked_at x_end,x.revoked_receipt_id x_receipt,y.granted_at y_start,
        y.granted_receipt_id y_receipt,y.effective_at y_effective,y.purpose y_purpose,x.xmin::text x_xact,y.xmin::text y_xact
        from clued_private.binding_roles_v1 x,clued_private.binding_roles_v1 y
        where x.binding_id=$1 and x.role='ci-admission' and x.revoked_at is not null
          and y.binding_id=$2 and y.role='ci-admission' and y.revoked_at is null`, [s.ids.a, s.ids.b])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].x_end.getTime(), rows[0].y_start.getTime());
      assert.equal(rows[0].x_receipt, rows[0].y_receipt);
      assert.equal(rows[0].x_receipt, o.receipt_id);
      assert.equal(rows[0].x_xact, rows[0].y_xact, 'one transaction');
      assert.equal(minutes(rows[0].y_effective, rows[0].y_start), 5, 'Y starts 5 minutes later');
      assert.equal(rows[0].y_purpose, 'resident-node');
      assert.deepEqual((await admin.query(`select to_jsonb(r) v from clued_private.binding_roles_v1 r
        where binding_id=any($1) order by id`, [[s.ids.env, s.ids.park]])).rows, roleRowsBefore, 'parking and other holders untouched');
      assert.equal(o.note.status, 'committed', JSON.stringify(o.note));
      notes = await s.notes();
      assert.equal(notes.length, 3);
      assert.deepEqual([notes[2].id, notes[2].type_fields.receipt_id, notes[2].type_fields.receipt_kind, notes[2].title],
        [o.note.note_id, o.receipt_id, 'CI_ADMISSION_AUTO_HANDOVER', 'CI 准入已自动接班：a → b']);
      assert.ok(notes[2].content.includes(o.receipt_id));
      const receipt = await s.receipt_(o.receipt_id);
      assert.deepEqual([receipt.operation, receipt.metadata.receipt_kind, receipt.metadata.principal, receipt.metadata.trigger,
        receipt.metadata.from_binding_id, receipt.metadata.to_binding_id, receipt.metadata.purpose, receipt.metadata.session_id],
      ['binding_role_handover', 'CI_ADMISSION_AUTO_HANDOVER', 'server_watchdog', 'silence', s.ids.a, s.ids.b, 'resident-node', undefined]);
      assert.deepEqual(receipt.metadata.nodes.map((n) => [n.agent_name, n.rank, n.node.state]), [['a', 1, 'NORMAL'], ['b', 2, 'NORMAL']]);
      assert.ok(receipt.metadata.nodes.every((n) => n.node.last_heartbeat_at));
      // For 5 minutes nobody holds a started row.
      assert.equal(await s.admits('a'), false);
      assert.equal(await s.admits('b'), false);
      assert.equal((await s.door('b', { action: 'ci_nodes_status' })).error_code, 'admission_binding_required');
      assert.equal((await s.door('a', { action: 'ci_nodes_status' })).error_code, 'admission_binding_required');
      // Y's companion relays it, once per receipt.
      const relayed = await s.beat('b');
      assert.deepEqual(relayed.auto_handovers.map((h) => [h.receipt_id, h.from_binding_id, h.to_binding_id]), [[o.receipt_id, s.ids.a, s.ids.b]]);
      assert.deepEqual((await s.beat('a')).auto_handovers, []);
      await s.ago(5);
      assert.equal(await s.admits('b'), true);
      assert.equal((await s.door('b', { action: 'ci_nodes_status' })).status, 'ok');
      // The Owner's page lists it with the alerts.
      const page = await s.view();
      assert.deepEqual(page.alerts.map((a) => a.receipt_kind),
        ['CI_ADMISSION_AUTO_HANDOVER', 'CI_ADMISSION_FAILOVER_WITHHELD', 'CI_ADMISSION_FAILOVER_NO_TARGET', 'CI_ADMISSION_FAILOVER_NO_TARGET']);
      assert.deepEqual(page.nodes.map((n) => [n.agent_name, n.rank]), [['a', 1], ['b', 2]]);
      assert.equal(page.holders.find((h) => h.purpose === 'resident-node').binding_id, s.ids.b);
      // No hand-back: a is the only other candidate and an automatic handover took the role from it.
      await s.beat('a'); await s.beat('a');
      await s.ago(30); await s.beat('a'); await s.beat('a');
      o = await s.tick();
      assert.equal(o.outcome, 'no_target');
      assert.ok(reasons(o, 'a', s).includes('auto_handed_out'));
      await s.close();
    });

    await t.test('service not running or stale snapshot: 4.9 minutes no, 5 yes (ADR 0026), a healthy report restarts, no receiver rule', async () => {
      const s = await account('stuck', ['a', 'b']);
      await s.members(['a', 'b']);
      await s.switch(true);
      const down = { state: 'UNKNOWN', mode: undefined, probe: undefined, service_running: false, snapshot_age_seconds: undefined };
      await s.beat('b'); await s.beat('a', down);
      await s.ago(4); await s.beat('b'); await s.beat('a', down);
      await s.ago(0.9);
      const alone = await s.tick();
      assert.deepEqual([alone.outcome, alone.trigger], ['holder_alive', undefined], 'a single run of 4.9 minutes, and UNKNOWN alone, do not trigger');
      // One report with the service running and a fresh snapshot restarts the count.
      await s.beat('a', HOLDER);
      await s.ago(0.1);
      assert.equal((await s.tick()).outcome, 'holder_alive');
      // A stale snapshot (5.1 minutes) starts a run; a report without a snapshot age neither starts nor ends it.
      await s.beat('a', { ...HOLDER, snapshot_age_seconds: 306 });
      await s.beat('b');
      await s.ago(4.5);
      await s.beat('a', { ...HOLDER, state: 'UNKNOWN', snapshot_age_seconds: undefined });
      await s.beat('b');
      await s.ago(0.4);
      assert.equal((await s.tick()).outcome, 'holder_alive');
      await s.ago(0.1);
      // X's own heartbeats keep coming, so Y's count during a silence does not apply.
      const y = await s.node('b');
      const x = await s.node('a');
      assert.ok(y.heartbeat_previous_at < x.last_heartbeat_at, 'b sent only one heartbeat after a\'s latest');
      const o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s), o.trigger], ['handed_over', 'b', 'service_not_running']);
      assert.equal((await s.receipt_(o.receipt_id)).metadata.trigger, 'service_not_running');
      assert.doesNotMatch((await s.notes()).at(-1).content, /停机|HALT/, 'the Note names the trigger that held');
      await s.close();
    });

    // A holder that has only ever reported UNKNOWN has no readable state (Task aeefed92): the HALTED condition is
    // NULL for it, and before migration 20261122120000 it was handed out at the next tick as 'halted'. UNKNOWN starts
    // no clock of its own: the two server clocks (silence; service down or snapshot stale) alone decide.
    const unknownOnly = async (label, over) => {
      const s = await account(label, ['a', 'b']);
      await s.members(['a', 'b']);
      await s.switch(true);
      const report = { state: 'UNKNOWN', mode: undefined, probe: undefined, service_running: true, snapshot_age_seconds: 5, ...over };
      await s.beat('b'); await s.beat('a', report);
      assert.equal((await s.node('a')).readable_state, null, 'only UNKNOWN so far: no readable state');
      await s.ago(0.1);
      const o = await s.tick();
      assert.deepEqual([o.outcome, o.trigger], ['holder_alive', undefined], 'UNKNOWN alone does not trigger: ' + JSON.stringify(o));
      assert.deepEqual(await s.holders(), ['a']);
      return { s, report };
    };
    const handovers = async (s) => (await admin.query(`select count(*)::int n from public.clued_audit_receipts
      where user_id=$1 and metadata->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER'`, [s.user])).rows[0].n;

    await t.test('UNKNOWN only, service running and snapshot fresh: never handed out (Task aeefed92)', async () => {
      const { s, report } = await unknownOnly('unknown-alive', {});
      for (let i = 0; i < 6; i++) { await s.ago(1); await s.beat('a', report); await s.beat('b'); }
      const o = await s.tick();
      assert.deepEqual([o.outcome, o.trigger], ['holder_alive', undefined], JSON.stringify(o));
      assert.equal(await handovers(s), 0, 'no handover receipt');
      assert.deepEqual(await s.holders(), ['a']);
      await s.close();
    });

    await t.test('UNKNOWN only, service not running: handed out after 5 minutes as service_not_running (Task aeefed92)', async () => {
      const { s, report } = await unknownOnly('unknown-down', { service_running: false });
      for (let i = 0; i < 4; i++) { await s.ago(1); await s.beat('a', report); await s.beat('b'); }
      await s.ago(0.8);
      assert.equal((await s.tick()).outcome, 'holder_alive', '4.9 minutes of a stopped service do not trigger');
      await s.ago(0.1);
      const o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s), o.trigger], ['handed_over', 'b', 'service_not_running']);
      assert.equal((await s.receipt_(o.receipt_id)).metadata.trigger, 'service_not_running');
      assert.equal(o.note.status, 'committed', JSON.stringify(o.note));
      assert.doesNotMatch((await s.notes()).at(-1).content, /停机|HALT/, 'the Note names the trigger that held');
      assert.deepEqual(await s.holders(), ['b']);
      await s.close();
    });

    await t.test('UNKNOWN only, then silent: handed out after 5 minutes as silence (Task aeefed92)', async () => {
      const { s } = await unknownOnly('unknown-silent', {});
      await s.ago(2); await s.beat('b');
      await s.ago(2); await s.beat('b');
      await s.ago(0.8);
      assert.equal((await s.tick()).outcome, 'holder_alive', '4.9 minutes of silence do not trigger');
      await s.ago(0.1);
      const o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s), o.trigger], ['handed_over', 'b', 'silence']);
      assert.equal((await s.receipt_(o.receipt_id)).metadata.trigger, 'silence');
      assert.equal(o.note.status, 'committed', JSON.stringify(o.note));
      assert.doesNotMatch((await s.notes()).at(-1).content, /停机|HALT/, 'the Note names the trigger that held');
      assert.deepEqual(await s.holders(), ['b']);
      await s.close();
    });

    await t.test('a HALTED holder is handed out after halted_minutes, heartbeats coming or not (migration 20261116100000)', async () => {
      // 2026-11-14: TURING held ci-admission, HALTed and went on sending healthy heartbeats (service running,
      // snapshot fresh). Neither kind of lost contact applied and a HALTED holder was never handed out: no CI for ~3 hours.
      const halted = { ...HOLDER, state: 'HALTED', halt: { code: 'STAGE_FAILED', at: '2026-11-14T07:00:00Z' } };
      const unknown = { state: 'UNKNOWN', mode: undefined, probe: undefined, service_running: false, snapshot_age_seconds: undefined };
      const s = await account('halt', ['a', 'b']);
      await s.members(['a', 'b']);
      await s.switch(true);
      await s.beat('a', halted); await s.beat('b');
      await s.ago(4);
      // Every heartbeat repeats the HALT; the count runs from the first.
      await s.beat('a', halted); await s.beat('b');
      await s.ago(0.9);
      let o = await s.tick();
      assert.equal(o.outcome, 'holder_alive', '4.9 minutes of HALT do not trigger');
      assert.equal((await s.node('a')).unhealthy_since, null, 'the HALTED holder reports a running service: no lost contact');
      await s.ago(0.1);
      o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s), o.trigger], ['handed_over', 'b', 'halted']);
      assert.deepEqual(await s.holders(), ['b'], 'at most one resident-node holder');
      assert.equal(await s.admits('a'), false, 'the old holder\'s role ends at once: its next live admission is refused');
      const receipt = await s.receipt_(o.receipt_id);
      assert.deepEqual([receipt.metadata.receipt_kind, receipt.metadata.principal, receipt.metadata.trigger],
        ['CI_ADMISSION_AUTO_HANDOVER', 'server_watchdog', 'halted']);
      assert.equal(o.note.status, 'committed', JSON.stringify(o.note));
      assert.ok((await s.notes()).at(-1).content.includes('STAGE_FAILED'), 'the Note names the HALT code');
      await s.close();
      // A NORMAL report (the Owner rearmed) ends the HALT; a new HALT counts from its own start. UNKNOWN after
      // HALTED still reads HALTED and keeps the start, though the stopped service has only just begun its own count.
      const r = await account('rearm', ['a', 'b']);
      await r.members(['a', 'b']);
      await r.switch(true);
      await r.beat('a', halted); await r.beat('b');
      await r.ago(4);
      await r.beat('a', HOLDER); await r.beat('a', halted); await r.beat('b');
      await r.ago(4.9);
      assert.equal((await r.tick()).outcome, 'holder_alive');
      await r.beat('a', unknown); await r.beat('b');
      await r.ago(0.1);
      o = await r.tick();
      assert.deepEqual([o.outcome, target(o, r), o.trigger], ['handed_over', 'b', 'halted']);
      await r.close();
      // A HALTED holder that falls silent is lost like any other.
      const q = await account('halt-silent', ['a', 'b']);
      await q.members(['a', 'b']);
      await q.switch(true);
      await q.beat('a', halted);
      await q.ago(5); await q.beat('b'); await q.beat('b');
      o = await q.tick();
      assert.deepEqual([o.outcome, target(o, q), o.trigger], ['handed_over', 'b', 'silence']);
      await q.close();
    });

    await t.test('PAUSED and unexpired INTAKE_PAUSED are never handed out; UNKNOWN looks back', async () => {
      const s = await account('pause', ['a', 'b']);
      await s.members(['a', 'b']);
      await s.switch(true);
      const silence = async () => { await s.ago(31); await s.beat('b'); await s.beat('b'); return s.tick(); };
      const unknown = { state: 'UNKNOWN', mode: undefined, probe: undefined, service_running: false, snapshot_age_seconds: undefined };
      await s.beat('a', { ...HOLDER, state: 'PAUSED' });
      assert.equal((await silence()).outcome, 'holder_paused');
      // UNKNOWN after PAUSED still reads PAUSED, for silence and for a stopped service alike.
      await s.beat('a', unknown);
      assert.equal((await silence()).outcome, 'holder_paused');
      await s.beat('a', unknown); await s.beat('b'); await s.ago(20); await s.beat('a', unknown); await s.beat('b'); await s.ago(11);
      assert.equal((await s.tick()).outcome, 'holder_paused');
      // INTAKE_PAUSED until 199 minutes from now (clamped at 200): never handed out before it ends.
      await s.beat('a', { ...HOLDER, state: 'INTAKE_PAUSED', intake_paused_until: '2099-01-01T00:00:00Z' });
      await s.beat('a', unknown);
      assert.equal((await silence()).outcome, 'holder_paused');
      await s.ago(170);
      await s.beat('b'); await s.beat('b');
      assert.equal((await s.tick()).outcome, 'handed_over', 'once the pause has ended, silence counts');
      await s.close();
      // UNKNOWN after a normal report is judged as normal.
      const n = await account('lookback', ['a', 'b']);
      await n.members(['a', 'b']);
      await n.switch(true);
      await n.beat('a', HOLDER);
      await n.beat('a', unknown);
      await n.ago(30); await n.beat('b'); await n.beat('b');
      assert.equal((await n.tick()).outcome, 'handed_over');
      await n.close();
    });

    await t.test('no cooldown after a manual handover; no automatic hand-back, three nodes (migration 20261115100000)', async () => {
      const s = await account('three', ['a', 'b', 'c']);
      await s.members(['a', 'b', 'c']);
      await s.switch(true);
      // The Owner hands A to B by hand; a manual handover's target must have been heard (20261114120000).
      await s.beat('b');
      const manual = await s.handover('a', 'b');
      assert.equal((await s.receipt_(manual.receipt_id)).metadata.principal, 'native_account_session');
      await s.ago(5);
      assert.equal(await s.admits('b'), true);
      // B goes silent: A, handed over by hand and healthy, takes over (first in the Owner's order).
      await s.beat('b', HOLDER);
      await s.ago(30);
      for (let i = 0; i < 2; i++) { await s.beat('a'); await s.beat('c'); }
      let o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s)], ['handed_over', 'a']);
      assert.deepEqual(reasons(o, 'a', s), []);
      await s.ago(5);
      // A goes silent: B was handed out automatically, so C takes over.
      await s.beat('a', HOLDER);
      await s.ago(30);
      for (let i = 0; i < 2; i++) { await s.beat('b'); await s.beat('c'); }
      o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s)], ['handed_over', 'c']);
      assert.deepEqual(reasons(o, 'b', s), ['auto_handed_out']);
      await s.ago(5);
      // C goes silent: A and B were both handed out automatically: nothing, alert only.
      await s.beat('c', HOLDER);
      await s.ago(30);
      for (let i = 0; i < 2; i++) { await s.beat('a'); await s.beat('b'); }
      o = await s.tick();
      assert.equal(o.outcome, 'no_target');
      assert.deepEqual(o.candidates.map((x) => [s.nameOf(x.binding_id), x.reasons]), [['a', ['auto_handed_out']], ['b', ['auto_handed_out']]]);
      // A manual handover involving B restores B only; A stays excluded, and C, which handed over by hand, is not.
      await s.handover('c', 'b');
      assert.equal(await s.excluded('b'), null);
      assert.equal(await s.excluded('a'), 'auto_handed_out');
      assert.equal(await s.excluded('c'), null);
      await s.close();
    });

    await t.test('receiver alive is a candidate condition: Y1 with one heartbeat is passed over for Y2 with two', async () => {
      const s = await account('receiver', ['a', 'b', 'c']);
      await s.members(['a', 'b', 'c']);
      await s.switch(true);
      await s.beat('a', HOLDER);
      await s.ago(30);
      await s.beat('b');
      await s.beat('c'); await s.beat('c');
      const o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s)], ['handed_over', 'c']);
      assert.deepEqual(reasons(o, 'b', s), ['too_few_heartbeats']);
      await s.close();
    });

    await t.test('the switch: heartbeats from before it was turned on do not count', async () => {
      const s = await account('before-switch', ['a', 'b']);
      await s.members(['a', 'b']);
      await s.beat('a', HOLDER); await s.beat('b');
      await s.ago(5);
      await s.switch(true);
      assert.equal((await s.tick()).outcome, 'holder_not_heard_yet', 'X heard before the switch only');
      await s.ago(30);
      await s.beat('b'); await s.beat('b');
      const o = await s.tick();
      assert.equal(o.outcome, 'holder_never_heartbeated', 'silent since the switch, but never heard after it: alert only');
      assert.equal((await s.receipt_(o.alert_receipt_id)).metadata.reason, 'holder_never_heartbeated');
      assert.deepEqual(await s.holders(), ['a']);
      await s.beat('a', HOLDER);
      assert.equal((await s.tick()).outcome, 'holder_alive');
      await s.close();
    });

    await t.test('tick branches: a refused handover and a failing account become alerts, other accounts go on', async () => {
      const s = await account('branches', ['a', 'b']);
      await s.members(['a', 'b']);
      await s.switch(true);
      await s.beat('a', HOLDER);
      await s.ago(30); await s.beat('b'); await s.beat('b');
      // The core refuses at handover time (simulated: the role row cannot be written).
      await admin.query(`create function public.failover_fixture_refuse() returns trigger language plpgsql as
        $$ begin raise exception 'fixture_refused' using errcode='55000'; end $$`);
      await admin.query(`create trigger failover_fixture_refuse before insert on clued_private.binding_roles_v1
        for each row execute function public.failover_fixture_refuse()`);
      let o;
      try { o = await s.tick(); } finally {
        await admin.query('drop trigger failover_fixture_refuse on clued_private.binding_roles_v1');
        await admin.query('drop function public.failover_fixture_refuse()');
      }
      assert.deepEqual([o.outcome, target(o, s), o.error_code], ['handover_refused', 'b', 'fixture_refused']);
      assert.equal((await s.receipt_(o.alert_receipt_id)).metadata.reason, 'handover_refused');
      assert.deepEqual(await s.holders(), ['a'], 'nothing changed');
      assert.equal((await admin.query(`select count(*)::int n from public.clued_audit_receipts where user_id=$1
        and metadata->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER'`, [s.user])).rows[0].n, 0, 'the refused handover left no receipt');
      // The account's evaluation fails outside the handover: watchdog_error, and another account is still decided.
      await s.switch(false);
      const other = await account('branches-other', ['x', 'y']);
      await other.members(['x', 'y']);
      await admin.query(`create function public.failover_fixture_fail() returns trigger language plpgsql as
        $$ begin if new.metadata->>'reason'='switch_off' then raise exception 'fixture_failed'; end if; return new; end $$`);
      await admin.query(`create trigger failover_fixture_fail before insert on public.clued_audit_receipts
        for each row execute function public.failover_fixture_fail()`);
      let all;
      try { all = await tickAll(); } finally {
        await admin.query('drop trigger failover_fixture_fail on public.clued_audit_receipts');
        await admin.query('drop function public.failover_fixture_fail()');
      }
      const mine = all.accounts.find((a) => a.user_id === s.user);
      assert.deepEqual([mine.outcome, mine.error_code], ['error', 'fixture_failed']);
      assert.equal((await s.receipt_(mine.alert_receipt_id)).metadata.reason, 'watchdog_error');
      assert.equal(all.accounts.find((a) => a.user_id === other.user).outcome, 'holder_not_heard_yet');
      await s.close(); await other.close();
    });

    await t.test('heartbeat needs context:read: a connection with only context:write is refused', async () => {
      const s = await account('scopes', ['a']);
      // Stage-1 registration requires context:read; the row is written directly to show the door refuses anyway.
      await admin.query(`insert into clued_private.ci_nodes_v1(user_id,project_id,binding_id,name,profile,profile_sha256,
        identity_public_jwk,encryption_public_jwk,identity_fingerprint,encryption_fingerprint,registration_digest,idempotency_key)
        values($1,$2,$3,'WRITER','{}'::jsonb,$4,$5,$6,$7,$8,$9,$10)`,
      [s.user, s.project, s.ids.writer, hash(), jwk(), jwk(), hash(), hash(), hash(), uuid()]);
      await assert.rejects(() => s.door('writer', { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'STANDBY', service_running: true }),
        /binding_not_authorized/);
      assert.equal((await admin.query(`select count(*)::int n from clued_private.ci_node_liveness_v1 l
        join clued_private.ci_nodes_v1 n on n.node_id=l.node_id where n.binding_id=$1`, [s.ids.writer])).rows[0].n, 0);
    });

    await t.test('full-sweep watermark: the resident-node holder reports, the next holder reads the latest', async () => {
      const s = await account('watermark', ['a', 'b']);
      const mark = (who, over = {}) => s.door(who, { action: 'train_sweep_watermark', repository: 'TDoljyj/Cross-Memory-System',
        completed_at: '2026-10-31T07:00:00Z', updated_cursor: '2026-10-31T06:59:00Z', main_sha: 'e'.repeat(40), ...over });
      const first = await mark('a');
      assert.deepEqual([first.status, first.recorded, first.repository], ['ok', true, 'tdoljyj/cross-memory-system']);
      const r = await s.receipt_(first.receipt_id);
      assert.deepEqual([r.metadata.receipt_kind, r.metadata.binding_id, r.metadata.main_sha], ['CI_TRAIN_SWEEP_WATERMARK', s.ids.a, 'e'.repeat(40)]);
      // An older report never replaces a newer one.
      const older = await mark('a', { completed_at: '2026-10-31T06:00:00Z', updated_cursor: '2026-10-31T05:00:00Z' });
      assert.deepEqual([older.recorded, older.receipt_id], [false, first.receipt_id]);
      for (const bad of [{ main_sha: 'x' }, { completed_at: 'soon' }, { updated_cursor: '2026-10-31T08:00:00Z' },
        { completed_at: '2099-01-01T00:00:00Z' }, { repository: 'nope' }, { extra: 1 }]) {
        await assert.rejects(() => mark('a', bad), /work_claim_ci_command_invalid/, JSON.stringify(bad));
      }
      // Only the started ci-admission holder, and only a resident node.
      assert.equal((await mark('b')).error_code, 'admission_binding_required');
      assert.equal((await mark('env')).error_code, 'admission_binding_required', 'the GitHub environment ("other") holder');
      let status = await s.door('a', { action: 'ci_nodes_status' });
      assert.deepEqual(status.sweep_watermarks.map((w) => [w.repository, w.binding_id, w.main_sha, w.receipt_id]),
        [['tdoljyj/cross-memory-system', s.ids.a, 'e'.repeat(40), first.receipt_id]]);
      // After a handover the new holder reads the previous holder's watermark, and its own newer one wins.
      // A manual handover's target must have been heard (20261114120000).
      await s.beat('b');
      await s.handover('a', 'b');
      await s.ago(5);
      status = await s.door('b', { action: 'ci_nodes_status' });
      assert.equal(status.sweep_watermarks[0].binding_id, s.ids.a);
      const newer = await mark('b', { completed_at: '2026-10-31T07:30:00Z', updated_cursor: '2026-10-31T07:29:00Z', main_sha: 'f'.repeat(40) });
      assert.equal(newer.recorded, true);
      status = await s.door('b', { action: 'ci_nodes_status' });
      assert.deepEqual(status.sweep_watermarks.map((w) => [w.binding_id, w.main_sha]), [[s.ids.b, 'f'.repeat(40)]]);
      assert.equal((await mark('a')).error_code, 'admission_binding_required', 'the previous holder no longer reports');
      // Never backwards, even in a race: a newer first report still uncommitted when an older one arrives.
      const raceRepo = { repository: 'o/race' };
      const newerFirst = await connect('anon');
      const olderSecond = await connect('anon');
      await newerFirst.query('begin');
      const won = (await newerFirst.query('select public.clued_work_verify_v1($1,$2) v', [s.tokens.b, { scope: 'global',
        action: 'train_sweep_watermark', ...raceRepo, completed_at: '2026-10-31T07:30:00Z', updated_cursor: '2026-10-31T07:00:00Z',
        main_sha: '1'.repeat(40) }])).rows[0].v;
      assert.equal(won.recorded, true);
      const late = olderSecond.query('select public.clued_work_verify_v1($1,$2) v', [s.tokens.b, { scope: 'global',
        action: 'train_sweep_watermark', ...raceRepo, completed_at: '2026-10-31T07:10:00Z', updated_cursor: '2026-10-31T07:00:00Z',
        main_sha: '2'.repeat(40) }]).then((r) => r.rows[0].v, (e) => e);
      let blocked = 0;
      for (let i = 0; i < 100 && blocked !== 1; i++) {
        blocked = (await admin.query(`select count(*)::int n from pg_stat_activity where wait_event_type='Lock'`)).rows[0].n;
        if (blocked !== 1) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(blocked, 1, 'the older report waits for the newer one');
      await newerFirst.query('commit');
      assert.match(String((await late).message), /work_claim_ci_command_conflict/);
      assert.equal((await admin.query(`select main_sha from clued_private.ci_sweep_watermark_v1 where user_id=$1 and repository='o/race'`,
        [s.user])).rows[0].main_sha, '1'.repeat(40), 'the newer watermark stays');
      await s.close();
    });

    await t.test('heartbeat connections: the Owner links them in two steps; heartbeats only; a lost CI connection is lost', async () => {
      const s = await account('hblink', ['a', 'b', 'c'], { heartbeat: ['hbA', 'hbB', 'hbB2'] });
      const other = await account('hblink-other', ['z'], { extra: false, heartbeat: ['zz'] });
      const base = async () => (await s.view()).setting.version;
      const issueLink = async (hb, node, c) => s.native('clued_resident_failover_confirmation_issue_v1', { change: 'heartbeat_link',
        heartbeat_binding_id: s.ids[hb] ?? hb, node_binding_id: s.ids[node] ?? node, base_version: await base() }, c);
      const issueUnlink = async (hb) => s.native('clued_resident_failover_confirmation_issue_v1', { change: 'heartbeat_unlink',
        heartbeat_binding_id: s.ids[hb] ?? hb, base_version: await base() });
      const link = async (hb, node) => committed(await s.apply(issued(await issueLink(hb, node))));
      const plainBeat = (who) => s.door(who, { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'STANDBY', service_running: true });
      // Refusals at the first step (and again under the role lock at the second).
      const err = async (p) => (await p).error_code;
      // Only a heartbeat-only connection can be linked: never an ordinary readable connection, a role holder or a node.
      const scopeRequired = 'resident_failover_heartbeat_scope_required';
      assert.equal(await err(issueLink('reader', 'b')), scopeRequired, 'an ordinary context:read connection');
      assert.equal(await err(issueLink('writer', 'b')), scopeRequired, 'a context:write connection');
      assert.equal(await err(issueLink('env', 'b')), scopeRequired, 'an "other" holder');
      assert.equal(await err(issueLink('park', 'b')), scopeRequired, 'a parking spot');
      assert.equal(await err(issueLink('a', 'b')), scopeRequired, 'the resident-node holder');
      assert.equal(await err(issueLink('c', 'b')), scopeRequired, 'another node\'s CI connection');
      assert.equal(await err(issueLink('b', 'b')), 'resident_failover_input_invalid', 'itself');
      assert.equal(await err(issueLink(other.ids.zz, 'b')), 'resident_failover_binding_invalid', 'another account');
      // A heartbeat connection whose authorization is revoked or expired is not linked either.
      await admin.query("update clued_private.authorizations_v12 set expires_at=now()-interval '1 second' where binding_id=$1", [s.ids.hbB2]);
      assert.equal(await err(issueLink('hbB2', 'c')), scopeRequired, 'an expired heartbeat connection');
      await admin.query("update clued_private.authorizations_v12 set expires_at=now()+interval '30 days' where binding_id=$1", [s.ids.hbB2]);
      assert.equal(await err(issueLink('hbB', 'reader')), 'resident_failover_node_invalid', 'not a node');
      assert.equal(await err(issueUnlink('hbB')), 'resident_failover_heartbeat_not_linked');
      assert.equal((await s.native('clued_resident_failover_confirmation_issue_v1', { change: 'heartbeat_link',
        heartbeat_binding_id: s.ids.hbB, node_binding_id: s.ids.b, members: [], base_version: await base() })).error_code,
      'resident_failover_input_invalid');
      assert.equal((await plainBeat('hbB')).error_code, 'ci_node_not_registered', 'not linked yet');
      assert.deepEqual(await s.door('hbB', { action: 'ci_nodes_status' }), { status: 'rejected', error_code: 'heartbeat_connection_only' },
        'not linked, still heartbeats only');
      // The node's CI token cannot link anything: the door actions are gone.
      assert.equal((await s.door('b', { action: 'ci_node_heartbeat_link', heartbeat_binding_id: s.ids.hbB })).error_code,
        'admission_binding_required');
      await assert.rejects(() => s.door('a', { action: 'ci_node_heartbeat_link', heartbeat_binding_id: s.ids.hbB }),
        /work_claim_ci_command_invalid/, 'not even for the holder');
      // Two Native steps: the view, another session, the commit and its receipt.
      const token = issued(await issueLink('hbB', 'b'));
      assert.deepEqual([token.confirmation_view.change, token.confirmation_view.heartbeat.binding_id, token.confirmation_view.node.binding_id,
        token.confirmation_view.replaces], ['heartbeat_link', s.ids.hbB, s.ids.b, null]);
      assert.equal((await s.apply(token, fresh(s.user, 'sess-elsewhere'))).error_code, 'confirmation_token_binding_mismatch');
      const linked = await link('hbB', 'b');
      const linkReceipt = (await s.receipt_(linked.receipt_id)).metadata;
      assert.deepEqual([linkReceipt.receipt_kind, linkReceipt.node.binding_id, linkReceipt.heartbeat.binding_id, linkReceipt.principal],
        ['CI_NODE_HEARTBEAT_LINKED', s.ids.b, s.ids.hbB, 'native_account_session']);
      assert.equal(await err(issueLink('hbB', 'b')), 'resident_failover_unchanged');
      assert.equal(await err(issueLink('hbB', 'c')), 'resident_failover_heartbeat_linked', 'one node per heartbeat connection');
      await link('hbA', 'a');
      // A heartbeat connection can be neither marked for nor handed ci-admission (it cannot read; the
      // role checks also refuse any linked connection, see the surface test).
      assert.equal((await s.native('clued_binding_role_confirmation_issue_v1', { binding_id: s.ids.hbB, role: 'ci-admission',
        enabled: true, purpose: 'resident-node' })).error_code, 'binding_role_scope_missing');
      assert.equal((await s.native('clued_binding_role_handover_confirmation_issue_v1', { from_binding_id: s.ids.a,
        to_binding_id: s.ids.hbB })).error_code, 'binding_role_scope_missing');
      // A heartbeat through the link is the node's.
      const beat = await s.beat('hbB');
      assert.deepEqual([beat.node_binding_id, beat.via_link, beat.node_ids], [s.ids.b, true, [s.nodes.b]]);
      assert.equal((await s.node('b')).last_sender_binding_id, s.ids.hbB);
      // A heartbeat connection may call nothing else on the CI command door.
      for (const action of ['ci_nodes_status', 'train_sweep_watermark', 'revocations_contexts', 'merge_queue_keepalive',
        'publication_begin', 'ci_node_heartbeat_link']) {
        assert.deepEqual(await s.door('hbB', { action }), { status: 'rejected', error_code: 'heartbeat_connection_only' }, action);
      }
      // The Owner's page: every live connection's id, which are nodes, and where heartbeats are linked.
      await s.members(['a', 'b']);
      await s.switch(true);
      await s.beat('hbA', HOLDER);
      let page = await s.view();
      const shown = page.nodes.find((n) => n.binding_id === s.ids.a).node;
      assert.deepEqual([shown.heartbeat_via_link, shown.heartbeat_from_agent_name], [true, 'hbA']);
      const listed = Object.fromEntries(page.bindings.map((x) => [x.agent_name, x]));
      assert.deepEqual(Object.keys(listed).sort(), ['a', 'b', 'c', 'env', 'hbA', 'hbB', 'hbB2', 'park', 'reader', 'writer']);
      assert.deepEqual([listed.hbB.binding_id, listed.hbB.heartbeat_for.node_binding_id, listed.hbB.heartbeat_for.node_agent_name,
        listed.hbB.is_node], [s.ids.hbB, s.ids.b, 'b', false]);
      assert.deepEqual([listed.b.is_node, listed.b.heartbeat_for, listed.hbB2.heartbeat_for, listed.env.purpose, listed.writer.scopes],
        [true, null, null, 'other', ['context:write']]);
      assert.ok(!page.bindings.some((x) => x.binding_id === other.ids.zz), 'only this account\'s connections');
      // The watchdog sees nodes through their heartbeat connections.
      await s.ago(30); await s.beat('hbB'); await s.beat('hbB');
      let o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s), o.trigger], ['handed_over', 'b', 'silence']);
      assert.deepEqual((await s.beat('hbB')).auto_handovers.map((h) => h.receipt_id), [o.receipt_id], 'relayed through the heartbeat connection');
      // Linking another connection to the node replaces its link; the old one is refused.
      const replacing = issued(await issueLink('hbB2', 'b'));
      assert.equal(replacing.confirmation_view.replaces.binding_id, s.ids.hbB);
      committed(await s.apply(replacing));
      assert.equal((await plainBeat('hbB')).error_code, 'ci_node_not_registered');
      assert.equal((await s.beat('hbB2')).node_binding_id, s.ids.b);
      // Unlink: its heartbeats are refused afterwards, and it still can do nothing else.
      const unlinked = committed(await s.apply(issued(await issueUnlink('hbB2'))));
      assert.equal((await s.receipt_(unlinked.receipt_id)).metadata.receipt_kind, 'CI_NODE_HEARTBEAT_UNLINKED');
      assert.equal((await plainBeat('hbB2')).error_code, 'ci_node_not_registered');
      assert.equal((await s.door('hbB2', { action: 'ci_nodes_status' })).error_code, 'heartbeat_connection_only');
      assert.equal(await err(issueUnlink('hbB2')), 'resident_failover_heartbeat_not_linked');
      // The holder's CI connection is revoked: its linked heartbeats are refused; silence decides.
      await s.ago(5);
      committed(await s.apply(issued(await issueLink('hbB', 'b'))));
      await s.beat('hbB', HOLDER);
      await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [s.ids.b]);
      assert.equal((await plainBeat('hbB')).error_code, 'ci_node_not_registered', 'no heartbeat for a node whose CI connection is gone');
      await s.beat('hbA'); await s.beat('hbA');
      assert.equal((await s.tick()).outcome, 'holder_alive', 'a revoked connection alone switches nothing');
      await s.ago(30); await s.beat('hbA'); await s.beat('hbA');
      o = await s.tick();
      // a was handed out automatically, so it is not chosen back.
      assert.deepEqual([o.outcome, o.trigger], ['no_target', 'silence']);
      assert.ok(reasons(o, 'a', s).includes('auto_handed_out'));
      page = await s.view();
      assert.ok(!page.bindings.some((x) => x.agent_name === 'b'), 'only live connections are listed');
      await s.close(); await other.close();
    });

    await t.test('a holder whose CI connection is revoked: heartbeats refused, handed over only after 5 minutes of silence (ADR 0026)', async () => {
      const s = await account('revoked', ['a', 'b'], { heartbeat: ['hbA', 'hbB'] });
      const base = async () => (await s.view()).setting.version;
      const link = async (hb, node) => committed(await s.apply(issued(await s.native('clued_resident_failover_confirmation_issue_v1',
        { change: 'heartbeat_link', heartbeat_binding_id: s.ids[hb], node_binding_id: s.ids[node], base_version: await base() }))));
      await link('hbA', 'a'); await link('hbB', 'b');
      await s.members(['a', 'b']);
      await s.switch(true);
      await s.beat('hbA', HOLDER);
      await s.beat('hbB'); await s.beat('hbB');
      assert.equal((await s.tick()).outcome, 'holder_alive');
      await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [s.ids.a]);
      assert.equal((await s.door('hbA', { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'ACTIVE', service_running: true })).error_code,
        'ci_node_not_registered');
      // Before 5 minutes of silence nothing happens, however many heartbeats b sends.
      await s.beat('hbB'); await s.beat('hbB');
      assert.equal((await s.tick()).outcome, 'holder_alive');
      await s.ago(4.9); await s.beat('hbB'); await s.beat('hbB');
      assert.equal((await s.tick()).outcome, 'holder_alive', '4.9 minutes');
      assert.equal((await s.door('hbA', { action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'ACTIVE', service_running: true })).error_code,
        'ci_node_not_registered', 'still refused');
      await s.ago(0.1);
      const o = await s.tick();
      assert.deepEqual([o.outcome, target(o, s), o.trigger], ['handed_over', 'b', 'silence']);
      const receipt = (await s.receipt_(o.receipt_id)).metadata;
      assert.equal(receipt.holder_connection_live, false);
      const note = (await s.notes()).find((n) => n.type_fields.receipt_id === o.receipt_id);
      assert.ok(note.content.includes('失联 5 分钟（它的 CI 连接已失效）'), note.content);
      await s.close();
    });

    await t.test('a Note that cannot be written leaves the handover in place', async () => {
      const s = await account('note-fails', ['a', 'b']);
      await s.members(['a', 'b']);
      await s.switch(true);
      await s.beat('a', HOLDER);
      await s.ago(30); await s.beat('b'); await s.beat('b');
      await admin.query(`create function public.failover_fixture_no_note() returns trigger language plpgsql as
        $$ begin raise exception 'fixture_no_note'; end $$`);
      await admin.query(`create trigger failover_fixture_no_note before insert on public.clued_memories
        for each row execute function public.failover_fixture_no_note()`);
      let o;
      try { o = await s.tick(); } finally {
        await admin.query('drop trigger failover_fixture_no_note on public.clued_memories');
        await admin.query('drop function public.failover_fixture_no_note()');
      }
      assert.deepEqual([o.outcome, target(o, s), o.note.status], ['handed_over', 'b', 'failed'], JSON.stringify(o.note));
      assert.match(o.note.error_code, /fixture_no_note/);
      assert.deepEqual(await s.holders(), ['b'], 'the holder changed');
      assert.equal((await s.receipt_(o.receipt_id)).metadata.receipt_kind, 'CI_ADMISSION_AUTO_HANDOVER');
      assert.deepEqual(await s.notes(), [], 'no Note was written');
      await s.close();
    });

    await t.test('the watchdog: explicit owner and the same lock without a session; the core re-checks', async () => {
      const s = await account('lock', ['a', 'b']);
      await s.members(['a', 'b']);
      await s.switch(true);
      await s.beat('a', HOLDER);
      await s.ago(30); await s.beat('b'); await s.beat('b');
      // The one-click handover's lock is held: the tick waits for it.
      const locker = await connect();
      await locker.query('begin');
      await locker.query("select pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||$1||':ci-admission',0))", [s.user]);
      const cron = await connect();
      assert.equal((await cron.query("select auth.uid() u,current_setting('request.jwt.claims',true) c")).rows[0].u, null);
      const pending = s.tick(cron);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting !== 1; i++) {
        waiting = (await admin.query(`select count(*)::int n from pg_stat_activity
          where wait_event_type='Lock' and wait_event='advisory'`)).rows[0].n;
        if (waiting !== 1) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(waiting, 1, 'the tick waits for the role lock');
      await locker.query('commit');
      const o = await pending;
      assert.deepEqual([o.outcome, target(o, s)], ['handed_over', 'b']);
      // The core's checks apply under the watchdog: a second live resident holder stops it.
      await s.ago(5);
      await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,purpose)
        values($1,$2,'ci-admission',now(),$3,'other')`, [s.user, s.ids.a, await s.receipt()]);
      await admin.query("update clued_private.binding_roles_v1 set purpose='resident-node' where binding_id=$1 and revoked_at is null", [s.ids.a]);
      assert.equal((await s.tick()).outcome, 'no_single_resident_holder');
      await s.close();
      // The core refuses (target already holds the role): an alert, nothing changes.
      const r = await account('refused', ['a', 'b']);
      await r.members(['a', 'b']);
      await r.switch(true);
      await r.beat('a', HOLDER);
      await r.ago(30); await r.beat('b'); await r.beat('b');
      // The core re-checks under the lock what the decision saw: a target that holds the role is refused.
      const before = await r.holders();
      const raced = await admin.query(`select clued_private.binding_role_handover_core_v1($1,$2,$3,null,'{}'::jsonb) v`,
        [r.user, r.ids.a, r.ids.env]).catch((e) => e);
      assert.match(String(raced.message), /binding_role_handover_target_holds_role/);
      assert.deepEqual(await r.holders(), before);
      await r.close();
    });

    // ADR 0026 (Owner 2026-11-12): the watchdog's hand-over starts the new holder at once when the server gave the old holder
    // no positive duty answer for 210 seconds (150 s an answer can still land a check, plus 60 s); otherwise the 5 minutes stay.
    await t.test('quiet holder: an automatic take-over starts at once only when the old holder got no answer for 210 s', async () => {
      let n = 0;
      const fresh = async () => {
        const s = await account('quiet' + (++n), ['a', 'b']);
        await s.members(['a', 'b']);
        await s.switch(true);
        await s.beat('b'); await s.beat('a', HOLDER);
        return s;
      };
      const duty = async (s, who, client = admin) => (await client.query(
        "select clued_private.ci_duty_admits_v1($1,$2,'duty_role') ok", [s.user, s.ids[who]])).rows[0].ok;
      const answers = async (s, who) => (await admin.query(
        'select count(*)::int n from clued_private.ci_duty_answers_v1 where binding_id=$1', [s.ids[who]])).rows[0].n;
      const setAnswers = async (s, sql) => admin.query(`update clued_private.ci_duty_answers_v1 set at=${sql} where user_id=$1`, [s.user]);
      const start = async (s) => { const r = await s.role('b'); return minutes(r.effective_at, r.granted_at); };
      // X silent for 5 minutes, Y beat twice meanwhile: the watchdog hands over.
      const lose = async (s, between = async () => {}) => { await s.ago(5); await between(); await s.beat('b'); await s.beat('b'); return s.tick(); };

      // Only positive answers are recorded, at the server's time; no API role can write or read them.
      let s = await fresh();
      const before = await answers(s, 'a');
      assert.equal(await duty(s, 'b'), false);
      assert.equal(await answers(s, 'b'), 0);
      assert.equal(await duty(s, 'a'), true);
      assert.equal(await answers(s, 'a'), before + 1);
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        assert.deepEqual((await admin.query(`select has_table_privilege($1,'clued_private.ci_duty_answers_v1','INSERT') i,
          has_table_privilege($1,'clued_private.ci_duty_answers_v1','SELECT') r`, [role])).rows[0], { i: false, r: false }, role);
      }

      // 1. The holder died: its last answer is 5 minutes old. The new holder starts at once.
      let o = await lose(s);
      assert.deepEqual([o.outcome, target(o, s)], ['handed_over', 'b']);
      assert.equal(await start(s), 0, 'starts at once');
      assert.deepEqual([await s.admits('b'), await s.admits('a')], [true, false], 'the old row ended in the same transaction');
      const meta = (await s.receipt_(o.receipt_id)).metadata;
      assert.equal(meta.start, 'quiet_holder');
      assert.equal(new Date(meta.effective_at).getTime(), new Date(o.at).getTime());
      assert.ok((await s.notes()).some((x) => x.type_fields.receipt_id === o.receipt_id && x.content.includes('210 秒内没有拿到准入时立即生效')));
      await s.close();

      // 2. Its heartbeat failed but its executor still works: an answer 200 s ago keeps the 5 minutes; 211 s is quiet.
      for (const [age, minutesToStart] of [[200, 5], [211, 0]]) {
        s = await fresh();
        o = await lose(s, async () => { await duty(s, 'a'); await setAnswers(s, `clock_timestamp()-interval '${age} seconds'`); });
        assert.deepEqual([o.outcome, target(o, s)], ['handed_over', 'b']);
        assert.equal(await start(s), minutesToStart, `last answer ${age} s ago`);
        if (minutesToStart) assert.deepEqual([await s.admits('a'), await s.admits('b')], [false, false], 'nobody admitted for 5 minutes');
        assert.equal(await duty(s, 'a'), false, 'the old holder is refused from the hand-over on');
        await s.close();
      }

      // 3. No answer on record at all (a holder not seen since this migration): the 5 minutes stay.
      s = await fresh();
      o = await lose(s, () => admin.query('delete from clued_private.ci_duty_answers_v1 where user_id=$1', [s.user]));
      assert.equal(o.outcome, 'handed_over');
      assert.equal(await start(s), 5);
      await s.close();

      // 4. An answer being given while the watchdog acts: the hand-over waits for it (FOR SHARE on the old row), reads it and
      // keeps the 5 minutes. An answer asked for while the hand-over is in flight is decided after it: refused.
      const inflight = await connect();
      s = await fresh();
      await s.ago(5); await s.beat('b'); await s.beat('b');
      await inflight.query('begin');
      assert.equal(await duty(s, 'a', inflight), true);
      let settled = false;
      const ticking = s.tick().then((v) => { settled = true; return v; });
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(settled, false, 'the hand-over waits for the answer in flight');
      await inflight.query('commit');
      o = await ticking;
      assert.deepEqual([o.outcome, target(o, s)], ['handed_over', 'b']);
      assert.equal(await start(s), 5, 'the answer just given keeps the 5 minutes');
      await s.close();
      s = await fresh();
      await s.ago(5); await s.beat('b'); await s.beat('b');
      const watchdog = await connect();
      await watchdog.query('begin');
      assert.equal((await watchdog.query('select clued_private.ci_admission_failover_owner_v1($1) v', [s.user])).rows[0].v.outcome, 'handed_over');
      let asked = false;
      const asking = duty(s, 'a', inflight).then((v) => { asked = true; return v; });
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(asked, false, 'the answer waits for the hand-over');
      await watchdog.query('commit');
      assert.equal(await asking, false, 'decided after the revocation: refused');
      await s.close();

      // 5. Clock skew: only the server's clock and records count (heartbeat and answer times are the server's; no node clock is
      // read). An answer stamped ahead of the watchdog's clock (the server clock stepped back) is not quiet.
      s = await fresh();
      o = await lose(s, () => setAnswers(s, "clock_timestamp()+interval '10 minutes'"));
      assert.equal(o.outcome, 'handed_over');
      assert.equal(await start(s), 5, 'an answer the clock has not reached yet keeps the 5 minutes');
      await s.close();
    });

    await t.test('one-click handover through the shared core is unchanged', async () => {
      const s = await account('oneclick', ['a', 'b']);
      // A manual handover's target must have been heard (20261114120000): b now, a for the refused b → a below.
      await s.beat('b'); await s.beat('a');
      // ADR 0026: the quiet start is the watchdog's alone; a quiet old holder changes nothing here.
      await admin.query("insert into clued_private.ci_duty_answers_v1(binding_id,user_id,at) values($1,$2,clock_timestamp()-interval '1 hour')",
        [s.ids.a, s.user]);
      const token = issued(await s.native('clued_binding_role_handover_confirmation_issue_v1', { from_binding_id: s.ids.a, to_binding_id: s.ids.b }));
      const result = committed(await s.native('clued_binding_role_handover_v1',
        { confirmation_token: token.confirmation_token, view_digest: token.view_digest }));
      const meta = (await s.receipt_(result.receipt_id)).metadata;
      assert.deepEqual([meta.receipt_kind, meta.principal, meta.from_binding_id, meta.to_binding_id, meta.purpose, meta.token_id, meta.session_id],
        ['BINDING_ROLE_HANDED_OVER', 'native_account_session', s.ids.a, s.ids.b, 'resident-node', token.token_id, 'sess-oneclick']);
      assert.equal(new Date(result.effective_at).getTime(), (await s.role('b')).effective_at.getTime());
      assert.equal(minutes((await s.role('b')).effective_at, (await s.role('b')).granted_at), 5);
      const replay = await s.native('clued_binding_role_handover_v1', { confirmation_token: token.confirmation_token, view_digest: token.view_digest });
      assert.deepEqual([replay.replayed, replay.receipt_id, replay.effective_at], [true, result.receipt_id, result.effective_at]);
      assert.equal((await admin.query('select consumed_at from clued_private.native_confirmation_tokens where id=$1', [token.token_id])).rows[0]
        .consumed_at.getTime(), (await s.role('b')).granted_at.getTime());
      // Refusals keep their codes and burn the token.
      const stale = issued(await s.native('clued_binding_role_handover_confirmation_issue_v1', { from_binding_id: s.ids.b, to_binding_id: s.ids.a }));
      await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [s.ids.env]);
      assert.equal((await s.native('clued_binding_role_handover_v1', { confirmation_token: stale.confirmation_token,
        view_digest: stale.view_digest })).error_code, 'confirmation_view_stale');
      assert.equal((await s.native('clued_binding_role_handover_v1', { confirmation_token: stale.confirmation_token,
        view_digest: stale.view_digest })).error_code, 'confirmation_token_reused');
      await s.close();
    });

    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});

async function trainFixture(t, repository = 'fixture/repository-12345') {
  const { build, stop } = await import('esbuild');
  const { schedulingFixture, digest, sha, limits } = await import('./ci-scheduling-stage1-fixture.mjs');
  const { TRAIN_FAILURE, TRAIN_PROBE_FIELDS, trainHeadWorkKey, trainBatchKey, trainEffectKey } =
    await import('../../../work/actions-hosted-migration/independent-ci-v1/src/merge-train-v2-contract.mjs');
  const { multiDutyClock, multiDutyGitHub } = await import('../../../work/independent-ci-resident-v1/test/multi-duty-fixture.mjs');
  const bundle = await build({ stdin: { contents: "export * from './worker/ci-node-gateway-v1.ts'; export * from './worker/ci-scheduling-v1.ts';",
    resolveDir: root, loader: 'ts' }, bundle: true, platform: 'neutral', format: 'esm', write: false });
  stop();
  const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const f = await schedulingFixture();
  t.after(f.close);
  const github = multiDutyGitHub(multiDutyClock(f.sessionIssuedAt));
  const { admin, user, project } = f;
  const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
  const tokenA = 'fixture-' + hash();
  const tokenB = 'fixture-' + hash();
  async function addNode(name, token) {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y } = pair.publicKey.export({ format: 'jwk' });
    const binding = await one(admin, `insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic',$2,$3,array['context:read'],array['*']) returning id`, [user, name, digest(token)]);
    const node = f.committed(await f.native('clued_ci_node_registration_v1', {
      ...f.registration(), name, binding_id: binding.id, identity_public_jwk: { kty, crv, x, y },
    }));
    await f.approve(node.node_id);
    await admin.query(`update clued_private.ci_nodes_v1 set qualification_status='verified',
      qualification_verified_at=now(),qualification_expires_at=now()+interval '1 hour',
      eligible_until=now()+interval '1 hour',hardening_observed=true where node_id=$1`, [node.node_id]);
    await f.live(node.node_id);
    const db = await f.connect();
    await setWorkerGatewayCaller(db);
    return { id: node.node_id, binding: binding.id, token, pair, db };
  }
  const a = await addNode('列车节点 A', tokenA);
  const b = await addNode('列车节点 B', tokenB);
  const legacy = await addNode('旧角色对照节点', 'fixture-' + hash());
  await admin.query(`update clued_private.binding_roles_v1 set binding_id=$1
    where user_id=$2 and binding_id=$3 and role='ci-admission'`, [legacy.binding, user, f.binding]);
  const { pool } = await f.native('clued_ci_nodes_v1', { project_id: project });
  const registration = await f.native('clued_ci_pool_confirmation_issue_v1', {
    project_id: project, base_version: pool.version, repository: { id: 12345, name: repository },
    limits: limits(), accepted_ref: 'fixture-pool-acceptance',
  });
  f.committed(await f.native('clued_ci_pool_apply_v1', { confirmation_token: registration.confirmation_token,
    view_digest: registration.view_digest }));
  await f.modelMode();
  await admin.query(`update clued_private.work_claim_execution_policy_v1
    set activated_at=clock_timestamp(),qualification_commit=$1 where singleton`, [sha('source')]);
  await admin.query(`update clued_private.ci_quota_counters_v1 set policy=policy||$2::jsonb
    where project_id=$1 and row_kind='pool_policy'`, [project, {
    signature_gateway_active: true,
    merge_train_v2: { source_manifest_sha256: SRC, source_commit: sha('source'), policy_version: 'fixture-v1', stop_scope: 'none',
      staging_actor_id: 501, recovery_actor_id: 502, admission_mode: 'normal' },
  }]);
  const head = sha('merge-train-v2-head');
  const pr = 1788;
  const subject = {
    pr, head_sha: head, claim_id: f.claim.claim_id, claim_fence: Number(f.claim.fence), execution_epoch: Number(f.claim.execution_epoch),
  };
  f.committed(await workerGatewayRpc(f.gateway, 'clued_work_renew_v1', f.token, {
    scope: 'project:' + project, action: 'authorize_head', claim_id: f.claim.claim_id, fence: f.claim.fence,
    lease_version: f.claim.lease_version, ...(f.claimResult.lease_key ? { lease_key: f.claimResult.lease_key } : {}),
    repository, head_sha: head, target_branch: 'main', idempotency_key: uuid(),
  }));

  async function signed(node, action, fields = {}, overrides = {}) {
    const { v: trust } = await one(node.db, 'select public.clued_ci_node_trust_v1($1,$2) v', [digest(node.token), node.id]);
    const { v: now } = await one(admin, "select floor(extract(epoch from clock_timestamp())*1000)::text v");
    const payload = { protocol_version: 2, action, repository_id: 12345, target_branch: 'main', source_manifest_sha256: SRC, ...fields };
    const command = {
      protocol: 'clued.ci-node-command/1', operation: 'merge_train_v2', ...trust.principal, node_id: node.id,
      node_version: trust.node.version, key_version: trust.node.key_version, key_fingerprint: trust.node.identity_fingerprint,
      payload_sha256: digest(api.ciCanonicalJson(payload)), nonce: crypto.randomBytes(32).toString('base64url'),
      job_id: null, execution_generation: 0, train_generation: 0,
      issued_at_ms: Number(now), expires_at_ms: Number(now)+60000, ...overrides,
    };
    command.signature = crypto.sign('sha256', Buffer.from(api.ciCanonicalJson(command)), {
      key: node.pair.privateKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return { command, payload, now: Number(now) };
  }
  async function send(node, { command, payload, now }, token = node.token) {
    const response = await api.handleCiNodeGatewayV1(new Request('https://clued.example.test/v1/ci/node', {
      method: 'POST', body: JSON.stringify({ command, payload }),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    }), { SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'pk', CLUED_DB_GATEWAY_TOKEN: 'gw' }, {
      now: () => now,
      fetchImpl: async (url, init) => {
        const input = JSON.parse(init.body);
        const reply = new URL(url).pathname.endsWith('/clued_ci_node_trust_v1')
          ? await one(node.db, 'select public.clued_ci_node_trust_v1($1,$2) v', [input.p_token_hash, input.p_node_id])
          : await one(node.db, 'select public.clued_ci_node_command_v1($1,$2,$3,$4) v',
            [input.p_token_hash, input.p_command, input.p_payload, input.p_verified]);
        return Response.json(reply.v);
      },
    });
    return response.json();
  }
  const call = async (node, action, fields) => send(node, await signed(node, action, fields));
  const data = doc => doc.result ?? doc;
  const lease = result => ({ work_key: result.work_key, generation: result.generation, lease_version: result.lease_version });
  const scope = { tenantId: user, projectId: project, repositoryId: 12345, targetBranch: 'main' };
  const paths = ['work/ci-scheduling-fixture/source.mjs'];

  return { f, admin, user, project, github, a, b, head, pr, subject, one, signed, send, call, data, lease, scope, repository, paths, digest, sha, TRAIN_FAILURE, TRAIN_PROBE_FIELDS, trainHeadWorkKey, trainBatchKey, trainEffectKey };
}

test('列车 v2：签名资格、唯一领用、续期竞争与跨节点效果核对', { timeout: 300000 }, async t => {
  const { f, admin, user, project, github, a, b, head, pr, subject, one, signed, send, call, data, lease, scope, repository, paths, digest, sha, TRAIN_FAILURE, TRAIN_PROBE_FIELDS, trainHeadWorkKey, trainBatchKey, trainEffectKey } = await trainFixture(t);

  await t.test('两台独立节点均有资格，同连接异机、跨项目和错 Source 均拒绝', async () => {
    const replies = await Promise.all([call(a, 'role_probe'), call(b, 'role_probe')]);
    for (const [i, reply] of replies.entries()) {
      assert.equal(reply.status, 'committed', JSON.stringify(reply));
      for (const field of TRAIN_PROBE_FIELDS) assert.ok(Object.hasOwn(reply.result, field), field);
      assert.equal(reply.result.on_duty, true);
      assert.equal(reply.result.node_id, [a, b][i].id);
    }
    const otherMachine = await signed({ ...a, pair: b.pair }, 'role_probe');
    assert.equal((await send(a, otherMachine)).error_code, 'CI_NODE_SIGNATURE_INVALID');
    assert.equal((await send(a, await signed(a, 'role_probe'), b.token)).status, 'refused');
    assert.equal((await send(a, await signed(a, 'role_probe', {}, { project_id: f.project2 }))).status, 'refused');
    assert.equal((await send(a, await signed(a, 'head_acquire', subject, {
      user_id: f.other, project_id: f.otherProject,
    }))).status, 'refused');
    assert.equal((await one(admin, 'select count(*)::int n from clued_private.ci_train_work_v2')).n, 0);
    assert.equal(data(await call(a, 'head_acquire', { ...subject, source_manifest_sha256: OTHER_SRC })).error_code, TRAIN_FAILURE.SOURCE_MISMATCH.native);
  });

  await t.test('10：发布资格可在无 job 或 head 租约时读取', async () => {
    const qualification = data(await call(b, 'publisher_current'));
    assert.equal(qualification.current, true, JSON.stringify(qualification));
    assert.notEqual(qualification.send_authorized, true);
  });

  await t.test('5：唤醒只提供 PR/H/T，节点能发现尚无关联的精确认领', async () => {
    const relation = () => one(admin, 'select status from clued_private.work_claim_pr_task_bindings_v1 where user_id=$1 and pr_number=$2',
      [user, pr]);
    const before = await relation();
    const result = data(await call(b, 'resolve_pr_claim', { pr, head_sha: head, base_sha: sha('base') }));
    assert.equal(result.binding_status, 'bound', JSON.stringify(result));
    assert.equal(result.claim.claim_id, f.claim.claim_id);
    assert.equal(result.auto_bound, false);
    assert.deepEqual(await relation(), before);
    const acquired = data(await call(b, 'head_acquire', subject));
    assert.equal(acquired.status, 'leased', JSON.stringify(acquired));
    assert.equal(data(await call(b, 'work_release', lease(acquired))).status, 'released');
  });

  await t.test('11a：双节点辅助派发最多一次获得发送许可，接手可读原回执', async () => {
    const dispatch = { ref: 'main', subject: ['clued-compute-panel.yml', 42] };
    const effect_key = trainEffectKey({ ...scope, action: 'workflow_dispatch', subject: dispatch.subject });
    const fields = { ...dispatch, effect_key };
    const reserved = (await Promise.all([call(a, 'auxiliary_dispatch_reserve', fields),
      call(b, 'auxiliary_dispatch_reserve', fields)])).map(data);
    const winner = reserved.findIndex(result => result.state === 'reserved' && result.generation);
    assert.notEqual(winner, -1, JSON.stringify(reserved));
    const authorization = { ...fields, generation: reserved[winner].generation };
    const grants = (await Promise.all([call(a, 'auxiliary_dispatch_send', authorization),
      call(b, 'auxiliary_dispatch_send', authorization)])).map(data);
    assert.equal(grants.filter(result => result.send_authorized === true).length, 1, JSON.stringify(grants));
    const sent = grants[winner];
    const observer = winner === 0 ? b : a;
    const original = data(await call(observer, 'auxiliary_dispatch_read', fields));
    assert.deepEqual([original.state, original.receipt_id, original.send_authorized], ['sent', sent.receipt_id, false]);
    assert.equal(data(await call(observer, 'auxiliary_dispatch_reconcile',
      { ...fields, evidence_digest: digest('exact workflow dispatch readback') })).state, 'settled');
    assert.notEqual(data(await call(observer, 'auxiliary_dispatch_send', authorization)).send_authorized, true);
  });

  await t.test('同领只有一笔，续期按进展 CAS，心跳无效，旧代次无法复活，未知效果保留', async t => {
    const results = (await Promise.all([call(a, 'head_acquire', subject), call(b, 'head_acquire', subject)])).map(data);
    const won = results.findIndex(r => r.status === 'leased');
    assert.notEqual(won, -1, JSON.stringify(results));
    const current = results[won];
    const other = results[1-won];
    assert.equal(other.error_code, TRAIN_FAILURE.HEAD_LEASE_HELD.native);
    assert.ok(other.ci_retry_after);
    const [holder, successor] = won === 0 ? [a, b] : [b, a];
    assert.equal(current.work_key, trainHeadWorkKey({ ...scope, pr, headSha: head, action: 'verify_head' }));
    assert.equal(data(await call(holder, 'work_renew', lease(current))).error_code, TRAIN_FAILURE.LEASE_STALE.native);
    const verified = data(await call(holder, 'verify_head', { ...lease(current), base_sha: sha('base'), changed_paths: paths }));
    assert.equal(verified.verdict, 'ADMITTED', JSON.stringify(verified));
    const renewed = (await Promise.all([
      call(holder, 'work_renew', lease(current)), call(holder, 'work_renew', lease(current)),
    ])).map(data);
    const live = renewed.find(r => r.status === 'leased');
    assert.equal(renewed.filter(r => r.status === 'leased').length, 1, JSON.stringify(renewed));
    assert.equal(renewed.find(r => r !== live).error_code, TRAIN_FAILURE.LEASE_STALE.native);
    assert.equal((await one(admin, `select count(*)::int n from clued_private.work_claim_door_usage_v1
      where user_id=$1 and door='github-ci' and task_id=$2 and unit_key=$3`, [user, f.task, head])).n, 1);

    await t.test('10：现行 head 可读准入事实，旧租约版本不可读', async () => {
      const fact = data(await call(holder, 'admission_issue_fact', lease(live)));
      assert.equal(fact.issuer_on_duty, true, JSON.stringify(fact));
      assert.equal(fact.head_sha, head);
      assert.equal(data(await call(holder, 'admission_issue_fact', lease(current))).error_code, TRAIN_FAILURE.LEASE_STALE.native);
    });

    const check = { appId: 5368905, headSha: head, externalId: 'fixture-check-1788' };
    const intent = data(await call(holder, 'publication_begin_independent', { ...lease(live), check }));
    assert.equal(intent.state, 'reserved', JSON.stringify(intent));
    assert.equal(intent.effect_key, trainEffectKey({ ...scope, action: 'publication_begin_independent', subject: [pr, head, 'work-admission'] }));
    const sendFields = { ...lease(live), effect_key: intent.effect_key };
    await t.test('4：预留之后缩窄写集，发送时重新验证完整准入', async () => {
      const old = await one(admin, 'select write_set from clued_private.work_claims_v1 where claim_id=$1', [f.claim.claim_id]);
      await admin.query('update clued_private.work_claims_v1 set write_set=$2 where claim_id=$1', [f.claim.claim_id, ['different/**']]);
      try {
        const denied = data(await call(holder, 'verify_head', { ...lease(live), base_sha: sha('base'), changed_paths: paths }));
        assert.equal(denied.verdict, 'REJECTED', JSON.stringify(denied));
        const refusedSend = data(await call(holder, 'publication_send', sendFields));
        assert.equal(refusedSend.error_code, TRAIN_FAILURE.LEASE_STALE.native, JSON.stringify(refusedSend));
        assert.equal((await one(admin, 'select state from clued_private.ci_train_check_effects_v2 where effect_key=$1', [intent.effect_key])).state, 'reserved');
      } finally {
        await admin.query('update clued_private.work_claims_v1 set write_set=$2 where claim_id=$1', [f.claim.claim_id, old.write_set]);
      }
    });
    const sent = data(await call(holder, 'publication_send', sendFields));
    assert.equal(sent.state, 'sent', JSON.stringify(sent));
    let githubCheck;
    github.arm('check create', { loseReply: true });
    await assert.rejects(github.write('check create', () => {
      githubCheck = { ...intent.check, checkRunId: 12345, state: 'published', must_revoke: false };
      return githubCheck;
    }, result => ['checkCreates', result, holder.id]), /丢弃回复/);
    await f.live(holder.id);
    await admin.query(`update clued_private.ci_train_work_v2 set expires_at=clock_timestamp()-interval '1 second' where work_key=$1`, [current.work_key]);
    const takeover = data(await call(successor, 'head_acquire', subject));
    assert.equal(takeover.generation, current.generation+1, JSON.stringify(takeover));
    assert.equal(data(await call(holder, 'work_renew', lease(live))).error_code, TRAIN_FAILURE.LEASE_STALE.native);
    const refused = data(await call(successor, 'publication_begin_independent', { ...lease(takeover), check }));
    assert.equal(refused.error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
    const readback = data(await call(successor, 'publication_reconcile', { ...lease(takeover), effect_key: intent.effect_key }));
    assert.equal(readback.state, 'unknown');
    assert.equal(readback.check.externalId, check.externalId);
    assert.equal(data(await call(holder, 'queue_acquire', subject)).error_code, TRAIN_FAILURE.LEASE_STALE.native);
    const finish = { ...lease(takeover), effect_key: intent.effect_key,
      observation: githubCheck };
    const bad = data(await call(successor, 'publication_finish', {
      ...finish, observation: { ...finish.observation, headSha: sha('different head') },
    }));
    assert.equal(bad.error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
    const settled = data(await call(successor, 'publication_finish', finish));
    assert.equal(settled.state, 'settled', JSON.stringify(settled));
    assert.equal(data(await call(successor, 'publication_finish', finish)).receipt_id, settled.receipt_id);
    assert.equal(data(await call(holder, 'head_acquire', subject)).error_code, TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native);
    await t.test('11b：另一节点能凭旧 B 的精确 PR/H/T 只读发布结清收据', async () => {
      const fields = { key: digest('legacy B fixture'), pr, head_sha: head, base_sha: sha('base') };
      const answer = data(await call(holder, 'legacy_batch_handoff_read', fields));
      assert.deepEqual([answer.protocol_version, answer.key, answer.receiptId], [2, fields.key, settled.receipt_id], JSON.stringify(answer));
      assert.equal(data(await call(holder, 'legacy_batch_handoff_read', { ...fields, base_sha: sha('wrong base') })).receiptId, undefined);
    });
    await t.test('7：队列保活不延长尚未入队的认领', async () => {
      const old = await one(admin, 'select expires_at from clued_private.work_claims_v1 where claim_id=$1', [f.claim.claim_id]);
      const near = await one(admin, `update clued_private.work_claims_v1 set expires_at=clock_timestamp()+interval '5 minutes'
        where claim_id=$1 returning expires_at`, [f.claim.claim_id]);
      const renewalReceipts = () => one(admin, `select count(*)::int n from public.clued_audit_receipts
        where user_id=$1 and object_id=$2 and operation in ('work_claim_lease_extend_by_ci','work_claim_queue_keepalive')`,
      [user, f.claim.claim_id]);
      const before = await renewalReceipts();
      try {
        const keep = data(await call(holder, 'queue_action_acquire', { ...subject, purpose: 'merge_queue_keepalive' }));
        const result = data(await call(holder, 'merge_queue_keepalive', lease(keep)));
        assert.deepEqual(result.kept_alive, [], JSON.stringify(result));
        assert.deepEqual((await one(admin, 'select expires_at from clued_private.work_claims_v1 where claim_id=$1', [f.claim.claim_id])).expires_at, near.expires_at);
        assert.deepEqual(await renewalReceipts(), before);
      } finally {
        await admin.query('update clued_private.work_claims_v1 set expires_at=$2 where claim_id=$1', [f.claim.claim_id, old.expires_at]);
      }
    });
    const awaiting = data(await call(holder, 'work_pending', {}));
    assert.equal(awaiting.more_work, true, JSON.stringify(awaiting));
    assert.deepEqual(awaiting.queue, []);
    assert.equal(awaiting.work.find(work => work.action === 'merge_queue_join')?.head_sha, head);
    let queuedWork = data(await call(holder, 'queue_acquire', subject));
    assert.equal(queuedWork.status, 'leased', JSON.stringify(queuedWork));
    assert.equal(queuedWork.effect_key, intent.effect_key);
    assert.deepEqual(queuedWork.check, { appId: check.appId, headSha: head, externalId: check.externalId, checkRunId: 12345 });
    assert.equal(queuedWork.entered, false);
    const wait = data(await call(holder, 'merge_queue_join', {
      ...lease(queuedWork), check_run_id: 12345, inventory_digest: digest('required check pending'),
      disposition: 'wait', reason: 'REQUIRED_CHECKS_PENDING',
    }));
    assert.equal(wait.disposition, 'wait');
    const delayed = data(await call(successor, 'work_pending', {}));
    assert.equal(delayed.more_work, true);
    assert.equal(delayed.work.some(work => work.action === 'merge_queue_join'), false);
    await admin.query(`update clued_private.ci_train_work_v2 set expires_at=clock_timestamp()-interval '1 second'
      where work_key=$1`, [queuedWork.work_key]);
    queuedWork = data(await call(holder, 'queue_acquire', subject));
    const queue = data(await call(holder, 'merge_queue_join', {
      ...lease(queuedWork), check_run_id: 12345, inventory_digest: digest('fixture check inventory'),
    }));
    assert.equal(queue.joined, true, JSON.stringify(queue));
    assert.equal(data(await call(successor, 'queue_acquire', subject)).error_code, TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native);
    assert.equal(github.totals().checkCreates, 1);
    assert.equal((await one(admin, `select count(*)::int n from public.clued_audit_receipts
      where user_id=$1 and operation='work_claim_merge_queue_join_by_ci'`, [user])).n, 1);

    await t.test('6：归还队位后，同一个 H 可重新评估入队且不重复发检查', async () => {
      const returned = data(await call(holder, 'queue_action_acquire', { ...subject, purpose: 'merge_slot_return' }));
      const receipt = data(await call(holder, 'merge_slot_return', { ...lease(returned), evidence_digest: digest('terminal check failure') }));
      assert.equal(receipt.status, 'ok', JSON.stringify(receipt));
      const next = data(await call(successor, 'queue_acquire', subject));
      assert.equal(next.status, 'leased', JSON.stringify(next));
      const rejoined = data(await call(successor, 'merge_queue_join', {
        ...lease(next), check_run_id: 12345, inventory_digest: digest('recovered check inventory'),
      }));
      assert.equal(rejoined.joined, true, JSON.stringify(rejoined));
      assert.equal(github.totals().checkCreates, 1);
    });

    const baseSha = sha('base');
    const members = [{ pr, headSha: head, claimId: f.claim.claim_id, fence: subject.claim_fence, epoch: subject.execution_epoch }];
    const ready = data(await call(successor, 'work_pending', {}));
    assert.deepEqual(ready.queue, [{ ...members[0], position: 1, sequence: pr, solo: false }]);
    await t.test('2：成员已关闭且无在途 main 写，已暂存批可终结并释放目标', async () => {
      const oldBase = sha('cleanup base');
      const old = data(await call(holder, 'batch_reserve', { baseSha: oldBase, members }));
      const oldHandle = { batchId: old.batchId, generation: old.generation };
      const testSha = sha('cleanup test');
      const generationRefOid = sha('cleanup marker');
      assert.equal(data(await call(holder, 'batch_seal', { ...oldHandle, testSha, treeSha: sha('tree'),
        steps: [{ sha: testSha, firstParent: oldBase, secondParent: head }], checksPolicyVersion: 'fixture-v1' })).state, 'sealed');
      assert.equal(data(await call(holder, 'staging_prepare', { ...oldHandle, generationRefOid })).stagingState, 'reserved');
      assert.equal(data(await call(holder, 'staging_send', oldHandle)).stagingState, 'sent');
      assert.equal(data(await call(holder, 'staging_publish', { ...oldHandle, observation: {
        testSha, generationRefOid, evidence_digest: digest('cleanup readback'),
      } })).state, 'waiting_checks');
      const resumed = data(await call(successor, 'batch_acquire', { batchId: old.batchId }));
      await admin.query("update clued_private.work_claim_pr_task_bindings_v1 set status='closed' where user_id=$1 and pr_number=$2", [user, pr]);
      try {
        const cleaned = data(await call(successor, 'batch_cleanup', { batchId: old.batchId, generation: resumed.generation }));
        assert.equal(cleaned.state, 'invalidated', JSON.stringify(cleaned));
      } finally {
        await admin.query("update clued_private.work_claim_pr_task_bindings_v1 set status='active' where user_id=$1 and pr_number=$2", [user, pr]);
      }
    });
    const reservations = (await Promise.all([call(holder, 'batch_reserve', { baseSha, members }),
      call(successor, 'batch_reserve', { baseSha, members })])).map(data);
    const ownerIndex = reservations.findIndex(r => r.state === 'forming');
    assert.notEqual(ownerIndex, -1, JSON.stringify(reservations));
    const batch = reservations[ownerIndex];
    const [builder, reader] = ownerIndex === 0 ? [holder, successor] : [successor, holder];
    assert.equal(batch.batchId, trainBatchKey({ ...scope, baseSha, members, sourceSha256: SRC, policyVersion: 'fixture-v1' }));
    assert.equal(reservations[1-ownerIndex].batchId, batch.batchId);
    const handle = { batchId: batch.batchId, generation: batch.generation };
    const testSha = sha('v2 batch test');
    const sealed = data(await call(builder, 'batch_seal', { ...handle, testSha, treeSha: sha('tree'),
      steps: [{ sha: testSha, firstParent: baseSha, secondParent: head }], checksPolicyVersion: 'fixture-v1' }));
    assert.equal(sealed.state, 'sealed', JSON.stringify(sealed));
    const generationRefOid = sha('generation ref');
    const staged = data(await call(builder, 'staging_prepare', { ...handle, generationRefOid }));
    assert.equal(staged.stagingState, 'reserved', JSON.stringify(staged));
    assert.equal(data(await call(builder, 'staging_send', handle)).stagingState, 'sent');
    await t.test('8：正确 S 配上其他代次标记不能结清暂存', async () => {
      const prematureStage = data(await call(builder, 'staging_publish', { ...handle, observation: { testSha,
        generationRefOid: sha('wrong staging generation'), evidence_digest: digest('wrong staging readback') } }));
      assert.equal(prematureStage.error_code, TRAIN_FAILURE.LANDING_REF_MISMATCH.native, JSON.stringify(prematureStage));
      assert.equal(data(await call(reader, 'batch_read', { batchId: batch.batchId })).stagingState, 'sent');
    });
    const stage = data(await call(builder, 'staging_publish', { ...handle, observation: { testSha, generationRefOid,
      evidence_digest: digest('staging readback') } }));
    assert.equal(stage.state, 'waiting_checks', JSON.stringify(stage));
    const firstRunLease = data(await call(builder, 'batch_acquire', { batchId: batch.batchId }));
    const firstRunHandle = { batchId: batch.batchId, generation: firstRunLease.generation };
    const runs = [{ checkName: 'ci-suites', platform: 'linux', runId: 811, checkRunId: 921 },
      { checkName: 'ci-suites-windows', platform: 'windows', runId: 812, checkRunId: 922 }]
      .map(run => ({ ...run, testSha, policyVersion: 'fixture-v1', attempt: 1, appId: 15368, actorId: 501, event: 'push',
        ref: 'refs/heads/clued-train/staging',
        workflow: '.github/workflows/clued-required-tests' + (run.platform === 'windows' ? '-windows' : '') + '.yml' }));
    const repair = { testSha, runId: runs[0].runId, attempt: 2, actorId: 502 };
    const runReceipts = new Map();
    await t.test('片 6：共享运行按 S、平台与策略登记，恢复发送预算只消费一次', async () => {
      const original = async run => data(await call(builder, 'required_run_register', { ...firstRunHandle, run }));
      for (const run of runs) {
        const registered = await original(run);
        assert.equal(registered.status, 'committed', JSON.stringify(registered));
        runReceipts.set(run.runId, registered.receipt_id);
        const replay = await original(run);
        assert.equal(replay.receipt_id, registered.receipt_id);
        assert.equal(replay.replayed, true);
        assert.equal((await original({ ...run, runId: 999 })).error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
        assert.equal((await original({ ...run, actorId: 999 })).error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
        assert.equal((await original({ ...run, policyVersion: 'obsolete' })).error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
      }
      const projection = data(await call(reader, 'batch_read', { batchId: batch.batchId }));
      assert.deepEqual(projection.requiredRuns, runs.map(({ testSha, checkName, platform, policyVersion, runId, attempt }) =>
        ({ testSha, checkName, platform, policyVersion, runId, attempt })));
      assert.equal(projection.requiredRunsSha256, trainDigest(projection.requiredRuns));
      const reserve = async patch => data(await call(builder, 'required_run_recovery_reserve', { ...firstRunHandle, ...repair, ...patch }));
      assert.equal((await reserve({ attempt: 3 })).error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
      assert.equal((await reserve({ actorId: 501 })).error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
      assert.equal((await reserve({})).state, 'reserved');
      const sends = await Promise.all([1, 2].map(async () =>
        data(await call(builder, 'required_run_recovery_send', { ...firstRunHandle, ...repair }))));
      assert.equal(sends.filter(send => send.send_authorized === true).length, 1);
      assert.equal(data(await call(builder, 'required_run_recovery_observe', { ...firstRunHandle, ...repair })).state, 'unknown');
      const blocked = data(await call(builder, 'landing_prepare', { ...firstRunHandle, generationRefOid,
        successorRefOid: sha('must not reserve landing'), evidence_digest: digest('old green'),
        requiredRunsSha256: projection.requiredRunsSha256 }));
      assert.equal(blocked.error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
    });
    await call(builder, 'batch_release', firstRunHandle);
    const resume = data(await call(reader, 'batch_acquire', { batchId: batch.batchId }));
    assert.equal(resume.testSha, testSha);
    assert.equal(resume.generation, firstRunLease.generation+1);
    const resumeHandle = { batchId: batch.batchId, generation: resume.generation };
    await t.test('片 6：接手读回同一运行的新尝试，旧代次和错检查不能改账', async () => {
      assert.equal(resume.requiredRunRecovery[0]?.state, 'unknown');
      const prior = data(await call(reader, 'required_run_recovery_read', { ...resumeHandle, ...repair }));
      assert.equal(prior.state, 'unknown');
      assert.equal(data(await call(reader, 'required_run_recovery_send', { ...resumeHandle, ...repair })).send_authorized, false);
      const jobs = [{ checkName: 'ci-suites', checkRunId: 923 }];
      assert.equal(data(await call(builder, 'required_run_recovery_observe', { ...firstRunHandle, ...repair, jobs })).error_code,
        TRAIN_FAILURE.LEASE_STALE.native);
      assert.equal(data(await call(reader, 'required_run_recovery_observe', { ...resumeHandle, ...repair,
        jobs: [{ checkName: 'ci-suites-windows', checkRunId: 923 }] })).error_code, TRAIN_FAILURE.EFFECT_UNKNOWN.native);
      const observed = data(await call(reader, 'required_run_recovery_observe', { ...resumeHandle, ...repair, jobs }));
      assert.equal(observed.state, 'settled', JSON.stringify(observed));
      assert.equal(data(await call(reader, 'required_run_recovery_observe', { ...resumeHandle, ...repair, jobs })).receipt_id, observed.receipt_id);
      const replay = data(await call(reader, 'required_run_register', { ...resumeHandle, run: runs[0] }));
      assert.equal(replay.receipt_id, runReceipts.get(runs[0].runId));
      assert.equal(replay.replayed, true);
    });
    const verifiedRuns = data(await call(reader, 'batch_read', { batchId: batch.batchId }));
    assert.deepEqual(verifiedRuns.requiredRuns.map(run => [run.runId, run.attempt]), [[811, 2], [812, 1]]);
    assert.deepEqual(verifiedRuns.requiredRunRecovery, []);
    assert.equal(verifiedRuns.requiredRunsSha256, trainDigest(verifiedRuns.requiredRuns));
    assert.notEqual(verifiedRuns.requiredRunsSha256, resume.requiredRunsSha256);
    const successorRefOid = sha('landed ref');
    const originalLandingOid = sha('independent landing generation');
    const landing = data(await call(reader, 'landing_prepare', { batchId: batch.batchId, generation: resume.generation, generationRefOid: originalLandingOid, successorRefOid,
      evidence_digest: digest('required checks on S'), requiredRunsSha256: verifiedRuns.requiredRunsSha256 }));
    assert.equal(landing.state, 'reserved', JSON.stringify(landing));
    assert.deepEqual(landing.intent.members, members);
    assert.equal(data(await call(builder, 'landing_send', { ...handle, effect_key: landing.effect_key })).error_code, TRAIN_FAILURE.LEASE_STALE.native);
    const landingHandle = { batchId: resume.batchId, generation: resume.generation, effect_key: landing.effect_key };
    assert.equal(data(await call(reader, 'landing_send', landingHandle)).state, 'sent');
    let main;
    github.arm('main update', { loseReply: true });
    await assert.rejects(github.write('main update', () => {
      main = { mainSha: testSha, generationRefOid: successorRefOid, containsTestSha: true, evidence_digest: digest('remote readback') };
      return main;
    }, result => ['mainUpdates', result, reader.id]), /丢弃回复/);
    const late = await signed(reader, 'landing_send', landingHandle);
    await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1', [reader.binding]);
    assert.equal((await send(reader, late)).status, 'refused');
    await admin.query(`update clued_private.ci_train_batches_v2 set expires_at=clock_timestamp()-interval '1 second'
      where batch_id=$1`, [batch.batchId]);
    let recoveredHandle;
    await t.test('1：接手节点仅凭共享账本发现原落地意图', async () => {
      const pendingReply = data(await call(builder, 'work_pending'));
      assert.equal(pendingReply.status, 'ok', JSON.stringify(pendingReply));
      const pending = pendingReply.work.find(item => item.action === 'batch_acquire');
      assert.ok(pending);
      const read = data(await call(builder, 'batch_read', { batchId: pending.batchId }));
      const recovered = data(await call(builder, 'batch_acquire', { batchId: pending.batchId }));
      assert.equal(recovered.generation, resume.generation+1);
      assert.equal(read.landingIntent.state, 'sent');
      assert.deepEqual({ ...read.landingIntent, state: 'unknown' }, recovered.landingIntent);
      assert.equal(recovered.landingIntent.intent.generationRefOid, originalLandingOid);
      assert.equal(recovered.landingIntent.successorRefOid, successorRefOid);
      assert.equal(recovered.landingIntent.state, 'unknown');
      assert.ok(recovered.landingIntent.receipt_id);
      recoveredHandle = { batchId: recovered.batchId, generation: recovered.generation, effect_key: recovered.landingIntent.effect_key };
    });
    const unresolved = data(await call(builder, 'landing_reconcile', { ...recoveredHandle, observation: null }));
    assert.equal(unresolved.state, 'unknown', JSON.stringify(unresolved));
    assert.equal(data(await call(builder, 'landing_reconcile', { ...recoveredHandle,
      observation: { ...main, generationRefOid: sha('not the successor ref') } })).error_code, TRAIN_FAILURE.LANDING_REF_MISMATCH.native);
    assert.equal(data(await call(builder, 'landing_reconcile', { ...recoveredHandle, observation: main })).state, 'settled');
    const adopt = { ...recoveredHandle, member: members[0], evidence_digest: digest('PR merge readback') };
    assert.equal(data(await call(builder, 'claim_adopt', { ...adopt, member: { ...members[0], epoch: subject.execution_epoch+1 } })).error_code,
      TRAIN_FAILURE.LEASE_STALE.native);
    const newerHead = sha('newer head before old landing adopt');
    const current = await one(admin, 'select lease_version from clued_private.work_claims_v1 where claim_id=$1', [f.claim.claim_id]);
    f.committed(await workerGatewayRpc(f.gateway, 'clued_work_renew_v1', f.token, {
      scope: 'project:' + project, action: 'authorize_head', claim_id: f.claim.claim_id, fence: f.claim.fence,
      lease_version: Number(current.lease_version), ...(f.claimResult.lease_key ? { lease_key: f.claimResult.lease_key } : {}),
      repository, head_sha: newerHead, target_branch: 'main', pr_number: pr, idempotency_key: uuid(),
    }));
    const adopted = data(await call(builder, 'claim_adopt', adopt));
    assert.equal(adopted.completed, true, JSON.stringify(adopted));
    assert.equal(adopted.state, 'claim_changed');
    assert.deepEqual(adopted.member, members[0]);
    assert.equal(data(await call(builder, 'claim_adopt', adopt)).receipt_id, adopted.receipt_id);
    assert.equal((await one(admin, 'select status from clued_private.work_claims_v1 where claim_id=$1', [f.claim.claim_id])).status, 'ACTIVE');
    assert.equal((await one(admin, 'select revoked_at from clued_private.work_claim_head_authorizations_v1 where claim_id=$1 and head_sha=$2',
      [f.claim.claim_id, newerHead])).revoked_at, null);
    assert.equal(github.totals().mainUpdates, 1);
  });
});


test('列车 v2 第 3 项：原认领失效后只撤销共享账本中的精确检查', { timeout: 120000 }, async t => {
  const { f, a, b, admin, call, data, lease, subject, sha, paths, github } = await trainFixture(t);
  const work = data(await call(a, 'head_acquire', subject));
  assert.equal(data(await call(a, 'verify_head', { ...lease(work), base_sha: sha('base'), changed_paths: paths })).verdict, 'ADMITTED');
  const ticket = data(await call(a, 'publication_begin_independent', { ...lease(work),
    check: { appId: 5368905, headSha: subject.head_sha, externalId: 'exact-check-for-revocation' } }));
  const exact = { ...lease(work), effect_key: ticket.effect_key };
  assert.equal(data(await call(a, 'publication_send', exact)).state, 'sent');
  const check = { ...ticket.check, checkRunId: 12345, state: 'published', must_revoke: false };
  assert.equal(data(await call(a, 'publication_finish', { ...exact, observation: check })).state, 'settled');
  await admin.query('update clued_private.work_claim_head_authorizations_v1 set revoked_at=clock_timestamp() where claim_id=$1',
    [f.claim.claim_id]);
  const fields = { effect_key: ticket.effect_key };
  const read = data(await call(b, 'revoke_check', { ...fields, phase: 'read' }));
  assert.equal(read.state, 'settled', JSON.stringify(read));
  assert.deepEqual(read.effect, { appId: check.appId, headSha: check.headSha, externalId: check.externalId, checkRunId: check.checkRunId });
  assert.equal(read.revoke_authorized, false);
  const observation = { ...check, state: 'revoked' };
  delete observation.must_revoke;
  const wrong = data(await call(b, 'revoke_check', { ...fields, phase: 'send', observation: { ...observation, checkRunId: 67890 } }));
  assert.notEqual(wrong.send_authorized, true);
  const revoke = data(await call(b, 'revoke_check', { ...fields, phase: 'send', observation }));
  assert.equal(revoke.send_authorized, true, JSON.stringify(revoke));
  await github.write('check revoke', () => observation, value => ['checkRevocations', value, b.id]);
  assert.notEqual(data(await call(b, 'revoke_check', { ...fields, phase: 'send', observation })).send_authorized, true);
  const readback = { ...fields, observation, phase: 'reconcile', generation: revoke.generation };
  const revoked = data(await call(b, 'revoke_check', readback));
  assert.equal(revoked.state, 'revoked', JSON.stringify(revoked));
  assert.equal(data(await call(b, 'revoke_check', readback)).receipt_id, revoked.receipt_id);
  assert.equal(github.totals().checkRevocations, 1);
});

test('列车 v2 第 12 项：片 2 的实际签名命令与常驻端所需回执', { timeout: 300000 }, async t => {
  const { f, a, b, head, pr, call, data, scope, repository, paths, digest, sha, TRAIN_FAILURE,
    trainHeadWorkKey, trainEffectKey } = await trainFixture(t, 'tdoljyj/cross-memory-system');
  const { admissionExternalIdV2, makeJobV2 } = await import('../../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs');
  const { makeIndependentPublicationIdentity } = await import('../../../scripts/ci/clued-independent-publication-identity.mjs');
  const baseSha = sha('base');
  const work_key = trainHeadWorkKey({ ...scope, pr, headSha: head, action: 'verify_head' });
  const fields = { work_key, scope: scope.contextKey ?? 'project:' + scope.projectId, repository, pr_ref: repository + '#' + pr,
    head_sha: head, base_sha: baseSha, controller_id: uuid() };
  const claim = { claim_id: f.claim.claim_id, fence: Number(f.claim.fence), execution_epoch: Number(f.claim.execution_epoch) };
  const acquisition = data(await call(a, 'verify_head', fields));
  assert.deepEqual([acquisition.protocol_version, acquisition.work_key, acquisition.status, acquisition.resume_required],
    [2, work_key, 'ok', false], JSON.stringify(acquisition));
  const held = data(await call(b, 'verify_head', { ...fields, controller_id: uuid() }));
  assert.deepEqual([held.protocol_version, held.work_key, held.error_code], [2, work_key, TRAIN_FAILURE.HEAD_LEASE_HELD.native]);
  assert.ok(Date.parse(held.ci_retry_after));
  const lease = { ...fields, lease_generation: acquisition.lease_generation };
  const request = { ...lease, changed_paths: paths, claim_id: claim.claim_id, read_only: false };
  assert.equal(data(await call(a, 'verify_head', { ...request, controller_id: uuid() })).error_code, TRAIN_FAILURE.LEASE_STALE.native);
  assert.equal(data(await call(a, 'verify_head', request)).verdict, 'ADMITTED');
  const job = makeJobV2({ repo: repository, pr, headSha: head, baseSha, testSha: head, role: 'work-admission',
    sourceManifestSha256: SRC, createdAt: new Date(f.sessionIssuedAt).toISOString(), attempt: 1 });
  const independent_identity = makeIndependentPublicationIdentity({ job, claim, controller_id: fields.controller_id });
  const effect_key = trainEffectKey({ ...scope, action: 'publication_begin_independent',
    subject: [pr, head, 5368905, 'kooyumi-work-admission'] });
  const effect = { appId: 5368905, headSha: head, checkRunId: null, externalId:
    admissionExternalIdV2('independent-ci:native-work-admission', job,
      { claimId: claim.claim_id, fence: claim.fence, epoch: claim.execution_epoch }) };
  const ticket = data(await call(a, 'publication_begin_independent', { ...lease, phase: 'reserve', effect_key,
    effect, changed_paths: paths, independent_identity }));
  assert.deepEqual([ticket.protocol_version, ticket.status, ticket.state, ticket.effect],
    [2, 'ok', 'reserved', effect], JSON.stringify(ticket));
  assert.deepEqual(ticket.independent_identity, independent_identity);
  const send = { ...lease, phase: 'send', effect_key, publication_id: ticket.publication_id };
  const stale = data(await call(a, 'publication_begin_independent', { ...send, lease_generation: lease.lease_generation + 1 }));
  assert.deepEqual([stale.work_key, stale.lease_generation, stale.error_code],
    [work_key, lease.lease_generation + 1, TRAIN_FAILURE.LEASE_STALE.native]);
  assert.equal(data(await call(a, 'publication_begin_independent', send)).send_authorized, true);
  assert.notEqual(data(await call(a, 'publication_begin_independent', send)).send_authorized, true);
  const original = data(await call(a, 'publication_reconcile', { ...lease, phase: 'read', effect_key }));
  assert.deepEqual([original.receipt_id, original.publication_id, original.independent_identity],
    [ticket.receipt_id, ticket.publication_id, independent_identity]);
  const exact = { ...lease, publication_id: ticket.publication_id, effect_key, check_run_id: '321',
    effect: { ...effect, checkRunId: 321 } };
  const done = data(await call(a, 'publication_finish', exact));
  assert.deepEqual([done.protocol_version, done.status, done.publication_status, done.must_revoke, done.first_queue_pending],
    [2, 'committed', 'published', false, true], JSON.stringify(done));
  assert.equal(data(await call(a, 'publication_finish', exact)).receipt_id, done.receipt_id);
  const completed = data(await call(b, 'verify_head', { ...fields, controller_id: uuid() }));
  assert.deepEqual([completed.protocol_version, completed.work_key, completed.error_code],
    [2, work_key, TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native]);
  const queueSubject = { pr, head_sha: head, claim_id: claim.claim_id, claim_fence: claim.fence, execution_epoch: claim.execution_epoch };
  const queueLease = data(await call(b, 'queue_acquire', queueSubject));
  assert.deepEqual([queueLease.effect_key, queueLease.check, queueLease.base_sha, queueLease.entered],
    [effect_key, exact.effect, baseSha, false]);
  const evalFields = { scope: fields.scope, repository, pr_ref: fields.pr_ref, head_sha: head,
    work_key: queueLease.work_key, lease_generation: queueLease.lease_generation, effect_key,
    ...claim, effect: exact.effect, disposition: 'join', reason: 'ready', observation_sha256: digest('pinned inventory') };
  const waiting = data(await call(b, 'merge_queue_join', { ...evalFields, disposition: 'wait', reason: 'checks_pending' }));
  assert.deepEqual([waiting.status, waiting.disposition], ['committed', 'wait']);
  assert.equal(data(await call(a, 'queue_acquire', queueSubject)).error_code, TRAIN_FAILURE.HEAD_LEASE_HELD.native);
  await f.admin.query('update clued_private.ci_train_work_v2 set expires_at=clock_timestamp() where work_key=$1', [queueLease.work_key]);
  const ready = data(await call(b, 'queue_acquire', queueSubject));
  const readyFields = { ...evalFields, lease_generation: ready.lease_generation };
  const join = data(await call(b, 'merge_queue_join', readyFields));
  assert.deepEqual([join.protocol_version, join.status, join.work_key, join.effect_key, join.disposition, join.joined],
    [2, 'committed', queueLease.work_key, effect_key, 'join', true], JSON.stringify(join));
  assert.equal(data(await call(b, 'merge_queue_join', readyFields)).receipt_id, join.receipt_id);
});


test('列车 v2：未签名的 Binding 无法领用或绕过首次入队闸口', { timeout: 120000 }, async t => {
  const { schedulingFixture, sha } = await import('./ci-scheduling-stage1-fixture.mjs');
  const f = await schedulingFixture();
  t.after(f.close);
  f.committed(await f.pool());
  await f.admin.query(`update clued_private.ci_quota_counters_v1
    set policy=policy||'{"merge_train_v2":{}}'::jsonb where project_id=$1 and row_kind='pool_policy'`, [f.project]);
  const anon = await f.connect('anon');
  const { rows: [{ result }] } = await anon.query('select public.clued_work_verify_v1($1,$2) result', [
    f.token, { action: 'merge_queue_join', scope: 'project:'+f.project, pr_ref: 'fixture/repository-12345#42', head_sha: sha('test head') },
  ]);
  assert.equal(result.error_code, 'ci_work_lease_stale');
  for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
    const { rows: [acl] } = await f.admin.query(`select
      has_table_privilege($1,'clued_private.ci_train_call_v2','INSERT') context_write,
      has_table_privilege($1,'clued_private.ci_train_work_v2','UPDATE') lease_write,
      has_table_privilege($1,'clued_private.ci_train_check_effects_v2','UPDATE') effect_write`, [role]);
    assert.deepEqual(acl, { context_write: false, lease_write: false, effect_write: false });
  }
});


test('列车 v2：目标分支只有一个未结束批次，按作用域隔离', { timeout: 120000 }, async t => {
  const { schedulingFixture, digest, sha } = await import('./ci-scheduling-stage1-fixture.mjs');
  const f = await schedulingFixture();
  t.after(f.close);
  const nodes = [await f.register(), await f.register(f.project2)];
  const insert = (key, project, node, state) => f.admin.query(`insert into clued_private.ci_train_batches_v2(
    batch_id,user_id,project_id,repository_id,target_branch,base_sha,source_manifest_sha256,policy_version,members,
    state,node_id,binding_id,binding_generation,key_version,expires_at,receipt_id)
    values($1,$2,$3,12345,'main',$4,$5,'fixture',$6,$7,$8,$9,1,1,clock_timestamp(),$10)`,
  [digest(key), f.user, project, sha(key), digest('source'), JSON.stringify([{ pr: 42 }]), state, node.node_id, f.binding, f.claimResult.receipt_id]);
  await insert('a', f.project, nodes[0], 'forming');
  await assert.rejects(insert('b', f.project, nodes[0], 'waiting_checks'),
    error => error.code === '23505' && error.constraint === 'ci_train_batches_v2_open_target');
  await insert('other project', f.project2, nodes[1], 'forming');
  await f.admin.query("update clued_private.ci_train_batches_v2 set state='invalidated' where batch_id=$1", [digest('a')]);
  await insert('replacement', f.project, nodes[0], 'forming');
  const { rows } = await f.admin.query(`select count(*)::int n from clued_private.ci_train_batches_v2
    where user_id=$1 and target_branch='main' and state='forming'`, [f.user]);
  assert.equal(rows[0].n, 2);
});
