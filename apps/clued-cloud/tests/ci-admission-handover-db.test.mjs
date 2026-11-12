import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Resident CI active/standby, C10 (migration 20261023010000, Task bb13efb5,
// design v0.4 §5.9, Owner Decisions bd86149e and 1c5d34fd): the Owner hands
// ci-admission from X to Y in one transaction, Y's row starts 5 minutes later,
// a row that has not started marks the role but admits nobody, a parking spot
// never admits and cannot be ended while it is the only one, a resident-node
// mark is refused while a live resident-node holder exists (N4), and every
// exact-holder reader asks whether the row has started.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261023010000_ci_admission_handover_v1.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const sha = (i) => i.toString(16).padStart(40, '0');
const minutes = (later, earlier) => (new Date(later).getTime() - new Date(earlier).getTime()) / 60000;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('ci-admission handover (Z1): one transaction, delayed start, purposes, parking and every exact-holder reader',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-ci-admission-handover-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  const connect = async (role) => {
    const client = server.getPgClient(); clients.push(client); await client.connect();
    if (role) await client.query(`set role ${role}`);
    return client;
  };
  try {
    await server.initialise();
    await server.start();
    const admin = await connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(names.includes(MIGRATION));
    const apply = async (list) => {
      for (const name of list) {
        try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
      }
    };
    await apply(names.filter((name) => name < MIGRATION));
    await allowRawTestBindings(admin);

    const owner = uuid();
    const stranger = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'handover@example.invalid',now()),($2,'handover-other@example.invalid',now())`, [owner, stranger]);
    const tokens = {};
    const ids = {};
    const bind = async (name, scopes, user = owner) => {
      tokens[name] = hash();
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, name, tokens[name], scopes])).rows[0].id;
    };
    for (const name of ['turing', 'company', 'envci', 'parking', 'parking2', 'spare', 'gone', 'reader']) await bind(name, ['context:read']);
    await bind('claude', ['context:read', 'context:write']);
    await bind('writer', ['context:write']);
    await bind('foreign', ['context:read'], stranger);
    for (const name of ['a', 'b']) await bind('second-' + name, ['context:read'], stranger);
    const receipt = async (user = owner) => (await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,null,'global','binding_role_set','binding_role','fixture',1,'{}'::jsonb) returning id`, [user])).rows[0].id;

    // --- Production before the migration: one live ci-admission holder, an
    // ended one, and a release door. ---
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',now()-interval '30 days',$3),($1,$4,'release-door',now()-interval '20 days',$5)`,
    [owner, ids.turing, await receipt(), ids.claude, await receipt()]);
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,revoked_at,revoked_receipt_id)
      values($1,$2,'ci-admission',now()-interval '40 days',$3,now()-interval '31 days',$4)`,
    [owner, ids.gone, await receipt(), await receipt()]);
    await apply(names.filter((name) => name >= MIGRATION));
    await allowRawTestBindings(admin);
    await enableManualOwnerApprovalFixture(admin);

    // --- The migration keeps every existing row as it was. ---
    const rows = (await admin.query(`select role,purpose,effective_at=granted_at same,revoked_at is null live
      from clued_private.binding_roles_v1 order by granted_at`)).rows;
    assert.deepEqual(rows, [
      { role: 'ci-admission', purpose: 'unspecified', same: true, live: false },
      { role: 'ci-admission', purpose: 'unspecified', same: true, live: true },
      { role: 'release-door', purpose: 'unspecified', same: true, live: true },
    ]);
    for (const [sql, constraint] of [
      [`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,purpose)
        values($1,$2,'ci-admission',now(),$3,'parking')`, 'binding_roles_v1_parking_check'],
      [`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,purpose)
        values($1,$2,'release-door',now(),$3,'other')`, 'binding_roles_v1_purpose_role_check'],
      [`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at)
        values($1,$2,'ci-admission',now(),$3,now()-interval '1 minute')`, 'binding_roles_v1_effective_check'],
    ]) {
      await assert.rejects(async () => {
        const r = await receipt();
        await admin.query(sql, [owner, ids.spare, r]);
      }, new RegExp(constraint));
    }

    // --- Every function that reads binding_roles_v1 is a known one, and each
    // exact-holder read asks whether the row has started. ---
    const readers = (await admin.query(`select p.oid::regprocedure::text sig,p.prosrc from pg_proc p
      where p.prosrc like '%binding_roles_v1%' order by 1`)).rows;
    assert.deepEqual(readers.map((r) => r.sig).sort(), [
      'clued_binding_role_set_v1(jsonb)',
      'clued_binding_roles_list_v1(jsonb)', 'clued_headless_binding_confirmation_issue_v1(jsonb)', 'clued_headless_binding_issue_v1(jsonb)',
      'clued_headless_binding_list_v1(jsonb)', 'clued_headless_binding_revoke_v1(jsonb)',
      'clued_private.binding_role_admits_v1(clued_agent_bindings,text)', 'clued_private.binding_role_change_check_v1(clued_agent_bindings,text,boolean,jsonb)',
      'clued_private.binding_role_handover_check_v1(clued_agent_bindings,clued_agent_bindings)',
      'clued_private.binding_role_handover_view_v1(clued_agent_bindings,clued_agent_bindings)',
      'clued_private.binding_role_holders_v1(uuid,text,uuid[])', 'clued_private.binding_role_resident_held_v1(uuid,uuid[])',
      'clued_private.headless_binding_view_before_sources_v2(uuid,jsonb)', 'clued_private.owner_grant_resident_upgrade_door_v1(text,jsonb)',
      'clued_private.work_claim_verify_before_execution_v1(text,jsonb)',
      // 20261105160000 (unified scheduling 2A): the command door, the independent publication commands, verify, the
      // Owner Grant admission door, admission validity and the Stage 1 publisher check no longer read the table
      // themselves; they ask ci_duty_admits_v1, which requires effective_at<=clock_timestamp() (checked below).
      'clued_private.ci_duty_admits_v1(uuid,uuid,text,uuid)', 'clued_private.ci_duty_holder_v1(uuid,uuid)',
      'clued_private.ci_phase_3_to_4_v1(uuid,uuid,integer,jsonb)', 'clued_private.ci_phase_4_to_3_v1(uuid,uuid,integer,boolean)',
      // 20261031090000 (merge train 2b): the one-click handover now calls this core.
      'clued_private.binding_role_handover_core_v1(uuid,uuid,uuid,text,jsonb)',
    ].sort(),'a new reader of binding_roles_v1 must be reviewed for rows that have not started');
    const started = (sig) => readers.find((r) => r.sig === sig).prosrc.split('effective_at<=clock_timestamp()').length - 1;
    assert.equal(started('clued_private.owner_grant_resident_upgrade_door_v1(text,jsonb)'), 1);
    assert.equal(started('clued_private.binding_role_admits_v1(clued_agent_bindings,text)'), 1);
    // ci_duty_admits_v1: the started-row test and the not-parking publisher test; ci_duty_holder_v1: the single holder row.
    assert.equal(started('clued_private.ci_duty_admits_v1(uuid,uuid,text,uuid)'), 2);
    assert.equal(started('clued_private.ci_duty_holder_v1(uuid,uuid)'), 1);
    assert.match(readers.find((r) => r.sig === 'clued_headless_binding_issue_v1(jsonb)').prosrc,
      /greatest\(e\.effective_at,v_now\),e\.purpose/);

    // --- Callers. ---
    const anon = await connect('anon');
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const human = await connect('authenticated');
    const native = async (name, input, claims = fresh(owner), client = human) => {
      await client.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await client.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    for (const name of ['clued_binding_role_handover_confirmation_issue_v1', 'clued_binding_role_handover_v1']) {
      await assert.rejects(() => anon.query(`select public.${name}($1)`, [{}]), /permission denied/, name);
      await assert.rejects(() => gateway.query(`select public.${name}($1)`, [{}]), /permission denied/, name);
    }
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const issued = (result) => { assert.equal(result.status, 'issued', JSON.stringify(result)); return result; };
    const issueRole = (binding, role, enabled, purpose, claims) => native('clued_binding_role_confirmation_issue_v1',
      purpose === undefined ? { binding_id: ids[binding], role, enabled } : { binding_id: ids[binding], role, enabled, purpose }, claims);
    const setRole = async (binding, role, enabled, purpose, claims) => {
      const token = issued(await issueRole(binding, role, enabled, purpose, claims));
      return native('clued_binding_role_set_v1', { confirmation_token: token.confirmation_token, view_digest: token.view_digest }, claims);
    };
    const issueHandover = (from, to, claims) => native('clued_binding_role_handover_confirmation_issue_v1',
      { from_binding_id: ids[from], to_binding_id: ids[to] }, claims);
    const handover = async (from, to, claims) => {
      const token = issued(await issueHandover(from, to, claims));
      return { token, result: await native('clued_binding_role_handover_v1',
        { confirmation_token: token.confirmation_token, view_digest: token.view_digest }, claims) };
    };
    // Five minutes pass for a Binding's started-later row.
    const elapse = (binding) => admin.query(`update clued_private.binding_roles_v1
      set granted_at=granted_at-interval '5 minutes',effective_at=effective_at-interval '5 minutes'
      where binding_id=$1 and revoked_at is null and purpose<>'parking'`, [ids[binding]]);
    const admits = async (binding) => (await admin.query(`select clued_private.binding_role_admits_v1(b,'ci-admission') ok
      from public.clued_agent_bindings b where b.id=$1`, [ids[binding]])).rows[0].ok;
    const role = async (binding) => (await admin.query(`select id,purpose,granted_at,effective_at,granted_receipt_id
      from clued_private.binding_roles_v1 where binding_id=$1 and role='ci-admission' and revoked_at is null`, [ids[binding]])).rows[0];
    const task = (await workerGatewayRpc(gateway, 'clued_record_mutate', tokens.claude, {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'handover fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'handover', content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = committed(await workerGatewayRpc(gateway, 'clued_work_claim_v1', tokens.claude,
      { scope: 'global', idempotency_key: uuid(), task_id: task, write_set: ['fixture/**'], holder_session_ref: 'session-a' }));
    let head = 100;
    const verify = async (who) => (await anon.query('select public.clued_work_verify_v1($1,$2) v', [tokens[who],
      { scope: 'global', claim_id: claim.claim.claim_id, pr_ref: 'o/r#1', head_sha: sha(++head) }])).rows[0].v;
    const verdict = async (who) => { const v = await verify(who); return [v.verdict, v.reasons]; };
    const ADMITTED = ['ADMITTED', []];
    const REFUSED = ['REJECTED', ['admission_binding_required']];
    const door = async (who) => {
      try {
        return (await anon.query('select public.clued_owner_grant_admission_door_v1($1,$2) v', [tokens[who],
          { action: 'repo.protected_change', resources: ['repo:tdoljyj/cross-memory-system/' + sha(++head)] }])).rows[0].v.status;
      } catch (error) { return error.message; }
    };
    const command = async (who) => {
      const v = (await anon.query('select public.clued_work_verify_v1($1,$2) v', [tokens[who],
        { scope: 'global', action: 'revocations_contexts' }])).rows[0].v;
      return v.error_code ?? v.status;
    };
    const holderOnly = async (who) => [await door(who), await command(who)];
    const CLOSED = ['owner_grant_door_binding_not_authorized', 'admission_binding_required'];
    const OPEN = ['ok', 'ok'];

    // --- The holder from before the migration keeps working; nobody else. ---
    assert.deepEqual(await verdict('turing'), ADMITTED);
    assert.deepEqual(await verdict('reader'), REFUSED);
    assert.deepEqual(await holderOnly('turing'), OPEN);
    assert.deepEqual(await holderOnly('reader'), CLOSED);

    // --- A ci-admission mark needs a purpose; release-door takes none. ---
    const issueError = async (...args) => (await issueRole(...args)).error_code;
    assert.equal(await issueError('envci', 'ci-admission', true), 'binding_role_purpose_required');
    assert.equal(await issueError('envci', 'ci-admission', true, 'leader'), 'binding_role_purpose_invalid');
    assert.equal(await issueError('envci', 'ci-admission', true, null), 'binding_role_purpose_invalid');
    assert.equal(await issueError('envci', 'ci-admission', true, ['other']), 'binding_role_purpose_invalid');
    assert.equal(await issueError('claude', 'release-door', true, 'other'), 'binding_role_unchanged');
    assert.equal(await issueError('writer', 'release-door', true, 'other'), 'binding_role_purpose_invalid');
    assert.equal(await issueError('turing', 'ci-admission', false, 'other'), 'binding_role_purpose_invalid');
    assert.equal(await issueError('turing', 'ci-admission', true, 'other'), 'binding_role_unchanged');

    // --- N4: a second resident node is refused while the live holder from
    // before the migration (unspecified) exists. ---
    assert.equal(await issueError('company', 'ci-admission', true, 'resident-node'), 'binding_role_resident_holder_exists');

    // --- The GitHub environment connection is marked "other": allowed, and
    // it starts 5 minutes after the Owner confirms. ---
    const envView = issued(await issueRole('envci', 'ci-admission', true, 'other')).confirmation_view;
    assert.deepEqual([envView.purpose, envView.activation, envView.delay_minutes], ['other', 'delayed', 5]);
    assert.deepEqual(envView.others.map((o) => [o.binding_id, o.purpose, o.live]), [[ids.turing, 'unspecified', true]]);
    const env = committed(await setRole('envci', 'ci-admission', true, 'other'));
    let row = await role('envci');
    assert.equal(minutes(row.effective_at, row.granted_at), 5);
    assert.equal(new Date(env.effective_at).getTime(), row.effective_at.getTime());
    assert.equal(env.purpose, 'other');
    assert.equal(await admits('envci'), false);
    assert.deepEqual(await verdict('envci'), REFUSED);
    assert.deepEqual(await holderOnly('envci'), CLOSED);
    await elapse('envci');
    assert.equal(await admits('envci'), true);
    assert.deepEqual(await verdict('envci'), ADMITTED);
    assert.deepEqual(await holderOnly('envci'), OPEN);
    const grantReceipt = (await admin.query('select metadata from public.clued_audit_receipts where id=$1', [env.receipt_id])).rows[0].metadata;
    assert.deepEqual([grantReceipt.receipt_kind, grantReceipt.purpose], ['BINDING_ROLE_GRANTED', 'other']);

    // --- A parking spot marks the role and never admits, even while live. ---
    const parkingView = issued(await issueRole('parking', 'ci-admission', true, 'parking')).confirmation_view;
    assert.deepEqual([parkingView.activation, parkingView.delay_minutes], ['never', null]);
    const parked = committed(await setRole('parking', 'ci-admission', true, 'parking'));
    assert.equal(parked.effective_at, 'infinity');
    assert.deepEqual([(await role('parking')).purpose, (await role('parking')).effective_at], ['parking', Infinity]);
    assert.equal(await admits('parking'), false);
    assert.deepEqual(await verdict('parking'), REFUSED);
    assert.deepEqual(await holderOnly('parking'), CLOSED);
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [ids.parking]);
    assert.equal(await issueError('parking', 'ci-admission', false), 'binding_role_parking_protected',
      'the only parking spot cannot be ended');
    assert.equal((await issueHandover('parking', 'company')).error_code, 'binding_role_parking_protected');

    // --- Handover: refusals. ---
    const handoverError = async (input, claims) => (await native('clued_binding_role_handover_confirmation_issue_v1', input, claims)).error_code;
    assert.equal(await handoverError({ from_binding_id: ids.turing }), 'binding_role_handover_target_invalid');
    assert.equal(await handoverError({ from_binding_id: ids.turing, to_binding_id: ids.company, role: 'release-door' }),
      'binding_role_handover_input_invalid');
    assert.equal(await handoverError({ from_binding_id: 'nope', to_binding_id: ids.company }), 'binding_role_handover_source_invalid');
    assert.equal((await issueHandover('company', 'spare')).error_code, 'binding_role_handover_source_invalid', 'X must hold the role');
    assert.equal((await issueHandover('gone', 'company')).error_code, 'binding_role_handover_source_invalid', 'an ended row is not held');
    assert.equal((await issueHandover('turing', 'turing')).error_code, 'binding_role_handover_target_invalid');
    assert.equal((await issueHandover('turing', 'writer')).error_code, 'binding_role_scope_missing');
    assert.equal((await issueHandover('turing', 'envci')).error_code, 'binding_role_handover_target_holds_role');
    assert.equal((await issueHandover('turing', 'parking')).error_code, 'binding_role_handover_target_invalid', 'Y must be live');
    assert.equal((await issueHandover('turing', 'foreign')).error_code, 'binding_role_handover_target_invalid');
    assert.equal((await issueHandover('foreign', 'company')).error_code, 'binding_role_handover_source_invalid');
    const { session_id: _omit, ...noSession } = fresh(owner);
    assert.equal((await issueHandover('turing', 'company', noSession)).error_code, 'confirmation_token_session_id_required');

    // --- Handover X → Y: one transaction, Y starts 5 minutes later, parking
    // and other holders untouched. ---
    const before = (await admin.query(`select to_jsonb(r) v from clued_private.binding_roles_v1 r
      where binding_id = any($1) order by id`, [[ids.envci, ids.parking, ids.claude]])).rows;
    const older = issued(await issueHandover('turing', 'company'));
    const { token, result } = await handover('turing', 'company');
    assert.equal((await native('clued_binding_role_handover_v1', { confirmation_token: older.confirmation_token,
      view_digest: older.view_digest })).error_code, 'confirmation_token_revoked', 'a newer issue revokes the older token');
    assert.deepEqual([token.confirmation_view.from.binding_id, token.confirmation_view.from.purpose, token.confirmation_view.from.live,
      token.confirmation_view.to.binding_id, token.confirmation_view.to.purpose, token.confirmation_view.delay_minutes],
    [ids.turing, 'unspecified', true, ids.company, 'resident-node', 5]);
    assert.deepEqual(token.confirmation_view.others.map((o) => [o.binding_id, o.purpose]),
      [[ids.envci, 'other'], [ids.parking, 'parking']]);
    committed(result);
    const moved = (await admin.query(`select x.revoked_at x_end,x.revoked_receipt_id x_receipt,y.granted_at y_start,
      y.granted_receipt_id y_receipt,y.effective_at y_effective,y.purpose y_purpose,x.xmin::text x_xact,y.xmin::text y_xact
      from clued_private.binding_roles_v1 x,clued_private.binding_roles_v1 y
      where x.binding_id=$1 and x.role='ci-admission' and x.revoked_at is not null
        and y.binding_id=$2 and y.role='ci-admission' and y.revoked_at is null`, [ids.turing, ids.company])).rows;
    assert.equal(moved.length, 1);
    assert.equal(moved[0].x_end.getTime(), moved[0].y_start.getTime(), 'X ends when Y is granted');
    assert.equal(moved[0].x_receipt, moved[0].y_receipt);
    assert.equal(moved[0].x_receipt, result.receipt_id);
    assert.equal(moved[0].x_xact, moved[0].y_xact, 'one transaction');
    assert.equal(minutes(moved[0].y_effective, moved[0].y_start), 5);
    assert.equal(new Date(result.effective_at).getTime(), moved[0].y_effective.getTime());
    assert.equal(moved[0].y_purpose, 'resident-node');
    assert.deepEqual((await admin.query(`select to_jsonb(r) v from clued_private.binding_roles_v1 r
      where binding_id = any($1) order by id`, [[ids.envci, ids.parking, ids.claude]])).rows, before);
    const handed = (await admin.query('select metadata from public.clued_audit_receipts where id=$1', [result.receipt_id])).rows[0].metadata;
    assert.deepEqual([handed.receipt_kind, handed.from_binding_id, handed.to_binding_id, handed.purpose, handed.principal],
      ['BINDING_ROLE_HANDED_OVER', ids.turing, ids.company, 'resident-node', 'native_account_session']);
    const replay = await native('clued_binding_role_handover_v1', { confirmation_token: token.confirmation_token,
      view_digest: token.view_digest });
    assert.deepEqual([replay.status, replay.replayed, replay.receipt_id], ['committed', true, result.receipt_id]);
    assert.equal(replay.effective_at, result.effective_at);

    // --- For 5 minutes neither X nor Y is admitted anywhere. ---
    for (const who of ['turing', 'company']) {
      assert.equal(await admits(who), false, who);
      assert.deepEqual(await verdict(who), REFUSED, who);
      assert.deepEqual(await holderOnly(who), CLOSED, who);
    }
    const listed = await native('clued_binding_roles_list_v1', {});
    const company = listed.bindings.find((b) => b.binding_id === ids.company).role_details[0];
    assert.deepEqual([company.purpose, company.in_force, company.purpose_title], ['resident-node', false, '常驻节点']);
    assert.equal(listed.bindings.find((b) => b.binding_id === ids.parking).role_details[0].effective_at, 'infinity');
    assert.deepEqual([listed.roles[0].role, listed.roles[0].marked, listed.roles[0].parking_count], ['ci-admission', true, 1]);
    assert.equal(listed.activation_delay_minutes, 5);
    assert.deepEqual(listed.purposes.map((p) => p.purpose), ['resident-node', 'parking', 'other']);
    await elapse('company');
    assert.equal(await admits('company'), true);
    assert.deepEqual(await verdict('company'), ADMITTED);
    assert.deepEqual(await holderOnly('company'), OPEN);
    assert.deepEqual(await verdict('turing'), REFUSED);

    // --- N4 does not misfire on the GitHub environment connection: with only
    // "other" and parking holders left, a resident node can be marked. ---
    assert.equal(await issueError('spare', 'ci-admission', true, 'resident-node'), 'binding_role_resident_holder_exists');
    committed(await setRole('company', 'ci-admission', false));
    const spare = committed(await setRole('spare', 'ci-admission', true, 'resident-node'));
    row = await role('spare');
    assert.equal(minutes(row.effective_at, row.granted_at), 5);
    assert.equal(spare.purpose, 'resident-node');
    assert.equal(await admits('spare'), false);
    // A handover out of a row that has not started is allowed, and Y waits again.
    const again = committed((await handover('spare', 'company')).result);
    row = await role('company');
    assert.equal(minutes(row.effective_at, row.granted_at), 5);
    assert.equal(new Date(again.effective_at).getTime(), row.effective_at.getTime());
    // Another live resident-node row, however it came to be, stops a handover.
    const stray = await receipt();
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,purpose)
      values($1,$2,'ci-admission',now(),$3,'resident-node')`, [owner, ids.turing, stray]);
    assert.equal((await issueHandover('company', 'spare')).error_code, 'binding_role_resident_holder_exists');
    await admin.query(`update clued_private.binding_roles_v1 set revoked_at=now(),revoked_receipt_id=$2
      where binding_id=$1 and revoked_at is null`, [ids.turing, stray]);

    // --- A parking spot can be ended once a second one holds the role. ---
    committed(await setRole('parking2', 'ci-admission', true, 'parking'));
    const parkingEnded = committed(await setRole('parking', 'ci-admission', false));
    assert.equal(parkingEnded.purpose, 'parking');
    assert.equal(await issueError('parking2', 'ci-admission', false), 'binding_role_parking_protected');

    // --- A view that changed between the two steps is stale, and the token is
    // burned. ---
    const stale = issued(await issueHandover('company', 'spare'));
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [ids.envci]);
    assert.equal((await native('clued_binding_role_handover_v1', { confirmation_token: stale.confirmation_token,
      view_digest: stale.view_digest })).error_code, 'confirmation_view_stale');
    assert.equal((await admin.query('select consume_outcome from clued_private.native_confirmation_tokens where id=$1',
      [stale.token_id])).rows[0].consume_outcome, 'rejected');
    assert.equal((await native('clued_binding_role_handover_v1', { confirmation_token: stale.confirmation_token,
      view_digest: stale.view_digest })).error_code, 'confirmation_token_reused');
    // Another session of the Owner cannot use the token.
    const otherSession = issued(await issueHandover('company', 'spare'));
    assert.equal((await native('clued_binding_role_handover_v1', { confirmation_token: otherSession.confirmation_token,
      view_digest: otherSession.view_digest }, fresh(owner, 'sess-other'))).error_code, 'confirmation_token_binding_mismatch');

    // --- A role whose only row has not started is marked: nobody is let in. ---
    assert.equal(await admits('second-b'), true, 'never marked: every Binding keeps the earlier behaviour');
    committed(await setRole('second-a', 'ci-admission', true, 'resident-node', fresh(stranger)));
    assert.equal(await admits('second-a'), false);
    assert.equal(await admits('second-b'), false, 'a row that has not started still marks the role');
    await elapse('second-a');
    assert.equal(await admits('second-a'), true);
    assert.equal(await admits('second-b'), false);
    // A revoked resident-node holder (its token no longer works) does not
    // stop a new resident-node mark; its row keeps the role marked meanwhile.
    assert.equal(await issueError('second-b', 'ci-admission', true, 'resident-node', fresh(stranger)),
      'binding_role_resident_holder_exists');
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1', [ids['second-a']]);
    issued(await issueRole('second-b', 'ci-admission', true, 'resident-node', fresh(stranger)));
    assert.equal(await admits('second-b'), false);

    // --- Two resident-node marks at once: the role's lock lets one through. ---
    committed(await setRole('second-a', 'ci-admission', false, undefined, fresh(stranger)));
    await bind('second-c', ['context:read'], stranger);
    const first = issued(await issueRole('second-b', 'ci-admission', true, 'resident-node', fresh(stranger)));
    const second = issued(await issueRole('second-c', 'ci-admission', true, 'resident-node', fresh(stranger)));
    const humanA = await connect('authenticated');
    const humanB = await connect('authenticated');
    await humanA.query('begin');
    committed(await native('clued_binding_role_set_v1', { confirmation_token: first.confirmation_token,
      view_digest: first.view_digest }, fresh(stranger), humanA));
    const racing = native('clued_binding_role_set_v1', { confirmation_token: second.confirmation_token,
      view_digest: second.view_digest }, fresh(stranger), humanB);
    for (let i = 0; i < 100; i++) {
      if ((await admin.query(`select count(*)::int n from pg_stat_activity
        where wait_event_type='Lock' and wait_event='advisory'`)).rows[0].n === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await admin.query(`select count(*)::int n from pg_stat_activity
      where wait_event_type='Lock' and wait_event='advisory'`)).rows[0].n, 1, 'the second mark waits for the first');
    await humanA.query('commit');
    assert.equal((await racing).error_code, 'binding_role_resident_holder_exists');

    // --- A handover and a resident-node mark at once: both passed step 1
    // (the handover's X is an "other" holder), only one is committed. ---
    committed(await setRole('second-b', 'ci-admission', false, undefined, fresh(stranger)));
    committed(await setRole('second-c', 'ci-admission', true, 'other', fresh(stranger)));
    for (const name of ['second-d', 'second-e']) await bind(name, ['context:read'], stranger);
    const mark = issued(await issueRole('second-e', 'ci-admission', true, 'resident-node', fresh(stranger)));
    const move = issued(await issueHandover('second-c', 'second-d', fresh(stranger)));
    await humanA.query('begin');
    committed(await native('clued_binding_role_set_v1', { confirmation_token: mark.confirmation_token,
      view_digest: mark.view_digest }, fresh(stranger), humanA));
    const racingHandover = native('clued_binding_role_handover_v1', { confirmation_token: move.confirmation_token,
      view_digest: move.view_digest }, fresh(stranger), humanB);
    for (let i = 0; i < 100; i++) {
      if ((await admin.query(`select count(*)::int n from pg_stat_activity
        where wait_event_type='Lock' and wait_event='advisory'`)).rows[0].n === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await admin.query(`select count(*)::int n from pg_stat_activity
      where wait_event_type='Lock' and wait_event='advisory'`)).rows[0].n, 1, 'the handover waits for the mark');
    await humanA.query('commit');
    assert.equal((await racingHandover).error_code, 'binding_role_resident_holder_exists');
    assert.equal((await role('second-c')).purpose, 'other', 'the refused handover left X as it was');
    assert.equal(await role('second-d'), undefined);

    // --- The guarded verify path, the execution observation and the CI
    // command door ask whether the CI row has started. ---
    await elapse('company');
    const guarded = committed(await workerGatewayRpc(gateway, 'clued_work_claim_v1', tokens.claude,
      { scope: 'global', idempotency_key: uuid(), task_id: (await workerGatewayRpc(gateway, 'clued_record_mutate', tokens.claude, {
        operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
        scope: 'global', idempotency_key: uuid(), authority: 'observed',
        confidence_reason: 'guarded fixture', source_refs: [], source_unavailable_reason: 'fixture',
        mutation: { title: 'guarded', content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
      })).target_refs[0].id, write_set: ['guarded/**'], holder_session_ref: 'session-g' }));
    await admin.query('update clued_private.work_claims_v1 set lease_key_required=true where claim_id=$1', [guarded.claim.claim_id]);
    const guardedRow = (await admin.query('select fence,lease_version from clued_private.work_claims_v1 where claim_id=$1',
      [guarded.claim.claim_id])).rows[0];
    committed(await workerGatewayRpc(gateway, 'clued_work_renew_v1', tokens.claude, { action: 'authorize_head', scope: 'global',
      claim_id: guarded.claim.claim_id, fence: Number(guardedRow.fence), lease_version: Number(guardedRow.lease_version),
      progress_ref: 'head:' + 'a'.repeat(40), repository: 'owner/repository', head_sha: 'a'.repeat(40), target_branch: 'main',
      idempotency_key: uuid(), lease_key: guarded.lease_key }));
    await admin.query("update clued_private.work_claim_execution_policy_v1 set activated_at=clock_timestamp(),qualification_commit=$1",
      ['f'.repeat(40)]);
    const wanted = { scope: 'global', claim_id: guarded.claim.claim_id, pr_ref: 'owner/repository#7', head_sha: 'a'.repeat(40),
      target_branch: 'main', changed_paths: ['guarded/file'] };
    const guardedVerify = async (who) => (await anon.query('select public.clued_work_verify_v1($1,$2) v', [tokens[who], wanted])).rows[0].v;
    const observe = async () => (await anon.query('select public.clued_work_verify_v1(null,$1) v', [{ action: 'execution_current',
      repository: 'owner/repository', head_sha: wanted.head_sha, pr_ref: wanted.pr_ref, target_branch: 'main' }])).rows[0].v;
    let v = await guardedVerify('company');
    assert.deepEqual([v.verdict, v.execution_authorized], ['ADMITTED', true], JSON.stringify(v));
    assert.equal((await admin.query(`select ci_binding_id from clued_private.work_claim_execution_admissions_v1
      where claim_id=$1`, [guarded.claim.claim_id])).rows[0].ci_binding_id, ids.company);
    assert.deepEqual(await observe(), { status: 'ok', guard_required: true, epoch_current: true });
    // The same row, not started yet: every exact-holder reader refuses it. The admission already issued while
    // the row had started stays current (G9, 20261106150000: validity is the issue-time fact, not today's role).
    await admin.query(`update clued_private.binding_roles_v1 set effective_at=clock_timestamp()+interval '1 hour'
      where binding_id=$1 and revoked_at is null`, [ids.company]);
    assert.deepEqual(await observe(), { status: 'ok', guard_required: true, epoch_current: true });
    v = await guardedVerify('company');
    assert.deepEqual([v.verdict, v.reasons, v.execution_authorized], ['REJECTED', ['admission_binding_required'], false]);
    assert.deepEqual(await holderOnly('company'), CLOSED);
    await admin.query(`update clued_private.binding_roles_v1 set effective_at=granted_at
      where binding_id=$1 and revoked_at is null`, [ids.company]);
    assert.deepEqual(await observe(), { status: 'ok', guard_required: true, epoch_current: true });
    assert.deepEqual(await holderOnly('company'), OPEN);

    // --- release-door is unchanged: it starts at once and takes no purpose. ---
    const door2 = committed(await setRole('writer', 'release-door', true));
    assert.equal(door2.purpose, 'unspecified');
    assert.equal(new Date(door2.effective_at).getTime(),
      (await admin.query("select granted_at from clued_private.binding_roles_v1 where binding_id=$1 and role='release-door' and revoked_at is null",
        [ids.writer])).rows[0].granted_at.getTime());

    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
