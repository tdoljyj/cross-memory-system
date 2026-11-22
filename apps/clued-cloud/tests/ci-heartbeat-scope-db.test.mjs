import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Heartbeat-only connections (migration 20261031085000, Task f2e9a8c6,
// DESIGN.md §41.6a): the scope ci:heartbeat, alone; issued only by the Owner in
// two Native steps on the headless page; stored under a salted verifier that no
// existing lookup can match; resolved only by resolve_heartbeat_binding_v1.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261031085000_ci_heartbeat_scope_v1.sql';
const uuid = () => crypto.randomUUID();
const hex = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const EXISTING_SCOPES = ['context:read', 'context:write', 'audit:read', 'canonical:read', 'canonical:write', 'project:read', 'project:write'];

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('ci:heartbeat: Owner-only issuance, alone, unreachable by every existing interface, one resolver', { timeout: 600000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-ci-heartbeat-scope-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hex(), port: await freePort(),
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
    for (const name of names) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);

    const userId = uuid();
    const otherUser = uuid();
    const projectId = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'heartbeat@example.invalid',now()),($2,'heartbeat-other@example.invalid',now())`, [userId, otherUser]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
      values($1,$2,'Alpha','alpha',$3,'confirmed',now())`, [projectId, userId, `project:${projectId}`]);
    const anon = await connect('anon');
    const human = await connect('authenticated');
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const native = async (name, input, claims = fresh(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const issueHeartbeat = async (input, claims) => {
      const confirmation = await native('clued_headless_heartbeat_binding_confirmation_issue_v1', input, claims);
      assert.equal(confirmation.status, 'issued', JSON.stringify(confirmation));
      return { confirmation, result: await native('clued_headless_heartbeat_binding_issue_v1',
        { confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest }, claims) };
    };
    // Any failure, thrown or returned, counts as refused; success never does.
    const refused = async (call) => {
      try {
        const v = await call();
        const value = v?.rows ? v.rows[0]?.v ?? v.rows[0] : v;
        return value === null || value === undefined || ['rejected', 'failed', 'error'].includes(value?.status)
          || value?.verdict === 'REJECTED' || value?.ok === false;
      } catch { return true; }
    };

    let heartbeat;
    let proof;

    await t.test('surface: Owner RPCs to authenticated only; private functions and the salt to nobody; CI8 and GW80 unchanged', async () => {
      const can = async (role, signature) => (await admin.query(
        `select has_function_privilege($1,$2::regprocedure,'execute') v`, [role, signature])).rows[0].v;
      for (const fn of ['public.clued_headless_heartbeat_binding_confirmation_issue_v1(jsonb)', 'public.clued_headless_heartbeat_binding_issue_v1(jsonb)']) {
        assert.deepEqual([await can('anon', fn), await can('authenticated', fn), await can('service_role', fn),
          await can('clued_worker_gateway', fn)], [false, true, false, false], fn);
        await assert.rejects(() => anon.query(`select ${fn.replace('(jsonb)', '')}($1)`, [{}]), /permission denied/);
      }
      for (const fn of ['clued_private.ci_heartbeat_token_hash_v1(text)', 'clued_private.resolve_heartbeat_binding_v1(text)',
        'clued_private.binding_has_only_heartbeat_scope_v1(public.clued_agent_bindings)',
        'clued_private.headless_heartbeat_binding_view_v1(jsonb)']) {
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
          assert.equal(await can(role, fn), false, `${role} ${fn}`);
        }
      }
      for (const client of [anon, human]) {
        await assert.rejects(() => client.query('select * from clued_private.ci_heartbeat_token_salt_v1'), /permission denied/);
      }
      assert.deepEqual((await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.provolatile<>'v' and p.prosrc like '%authorization_owner_v12%' order by 1`)).rows, []);
      await assertGatewayCloseoutBoundary(admin);
    });

    await t.test('the scope list: ci:heartbeat only alone', async () => {
      const raw = async (scopes) => admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','scope fixture',$2,$3,array['global']) returning id`, [userId, hex(), scopes]);
      for (const mixed of [['ci:heartbeat', 'context:read'], ['context:write', 'ci:heartbeat'], ['ci:heartbeat', 'audit:read']]) {
        await assert.rejects(() => raw(mixed), /clued_agent_bindings_scopes_check/, mixed.join(','));
      }
      await assert.rejects(() => raw(['ci:other']), /clued_agent_bindings_scopes_check/);
      await assert.rejects(() => raw([]), /clued_agent_bindings_scopes_check/);
      const alone = (await raw(['ci:heartbeat'])).rows[0].id;
      await assert.rejects(() => admin.query(`update public.clued_agent_bindings set scopes=array['ci:heartbeat','context:read'] where id=$1`, [alone]),
        /clued_agent_bindings_scopes_check/, 'never widened');
      for (const existing of EXISTING_SCOPES) (await raw([existing])).rows[0].id;
      await admin.query('delete from public.clued_agent_bindings where agent_name=$1', ['scope fixture']);
    });

    await t.test('issuance: two Native steps, the Owner only, validation, single use, token shown once', async () => {
      await assert.rejects(() => native('clued_headless_heartbeat_binding_confirmation_issue_v1', { label: 'x', days: 7 },
        { ...fresh(userId), client_id: 'some-oauth-client' }), /direct_human_session_required/);
      assert.equal((await native('clued_headless_heartbeat_binding_confirmation_issue_v1', { label: 'x', days: 7 },
        { ...fresh(userId), session_id: undefined })).error_code, 'confirmation_token_session_id_required');
      const step1 = async (input) => (await native('clued_headless_heartbeat_binding_confirmation_issue_v1', input)).error_code;
      assert.equal(await step1({ label: '', days: 7 }), 'headless_binding_label_invalid');
      assert.equal(await step1({ label: 'a\nb', days: 7 }), 'headless_binding_label_invalid');
      assert.equal(await step1({ label: 'hb', days: 0 }), 'headless_binding_expiry_invalid');
      assert.equal(await step1({ label: 'hb', days: 91 }), 'headless_binding_expiry_invalid');
      assert.equal(await step1({ label: 'hb', days: 7, selected: [] }), 'headless_binding_input_invalid', 'no permission to choose');
      assert.equal(await step1({ label: 'hb', days: 7, scopes: ['context:read'] }), 'headless_binding_input_invalid');
      const { confirmation, result } = await issueHeartbeat({ label: 'TURING heartbeat', days: 90 });
      assert.deepEqual([confirmation.confirmation_view.kind, confirmation.confirmation_view.scopes, confirmation.confirmation_view.selected],
        ['headless_heartbeat_binding_issue', ['ci:heartbeat'], []]);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      assert.match(result.token, /^clued_hbt_[A-Za-z0-9_-]{43}$/);
      heartbeat = result;
      proof = sha256(result.token);
      const row = (await admin.query(`select b.*,a.issuance,a.request_id,a.client_id,a.expires_at auth_expires,
          (select count(*)::int from clued_private.authorization_entries_v12 e where e.binding_id=b.id) entries
        from public.clued_agent_bindings b join clued_private.authorizations_v12 a on a.binding_id=b.id where b.id=$1`,
      [result.binding_id])).rows[0];
      assert.deepEqual([row.vendor, row.agent_name, row.scopes, row.context_keys, row.issuance, row.request_id, row.client_id, row.entries],
        ['Headless', 'TURING heartbeat', ['ci:heartbeat'], ['global'], 'headless', null, 'clued-headless', 0],
        'a headless v12 authorization with no entries');
      const days = (row.auth_expires.getTime() - Date.now()) / 86400000;
      assert.ok(days > 89.9 && days <= 90, String(days));
      // The stored verifier is the salted one, never the ordinary verifier of the proof.
      const ordinary = (await admin.query('select clued_private.credential_verifier_v1($1) v', [proof])).rows[0].v;
      assert.notEqual(row.token_hash, ordinary);
      assert.match(row.token_hash, /^cv1:[0-9a-f]{64}$/);
      assert.equal((await admin.query('select count(*)::int n from public.clued_agent_bindings where token_hash=$1 or token_hash=$2',
        [ordinary, proof])).rows[0].n, 0, 'no existing lookup of this proof can find any connection');
      assert.equal(row.token_hash, (await admin.query('select clued_private.ci_heartbeat_token_hash_v1($1) v', [proof])).rows[0].v);
      // The raw token is nowhere in the database; the receipt says what was issued.
      const dump = JSON.stringify((await admin.query(`select (select jsonb_agg(r) from public.clued_audit_receipts r) a,
        (select jsonb_agg(x) from clued_private.native_confirmation_tokens x) b,
        (select jsonb_agg(x) from clued_private.authorization_audit_v12 x) c`)).rows);
      assert.ok(!dump.includes(result.token) && !dump.includes(proof));
      const receipt = (await admin.query('select metadata from public.clued_audit_receipts where id=$1', [result.receipt_id])).rows[0].metadata;
      assert.deepEqual([receipt.receipt_kind, receipt.heartbeat_only, receipt.scopes, receipt.principal],
        ['HEADLESS_BINDING_ISSUED', true, ['ci:heartbeat'], 'native_account_session']);
      // Single use; replay never shows the token; another session cannot use it.
      const replay = await native('clued_headless_heartbeat_binding_issue_v1',
        { confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest });
      assert.deepEqual([replay.status, replay.replayed, replay.token], ['committed', true, null]);
      const pending = await native('clued_headless_heartbeat_binding_confirmation_issue_v1', { label: 'elsewhere', days: 7 });
      assert.equal((await native('clued_headless_heartbeat_binding_issue_v1', { confirmation_token: pending.confirmation_token,
        view_digest: pending.view_digest }, fresh(userId, 'sess-other'))).error_code, 'confirmation_token_binding_mismatch');
      assert.equal((await native('clued_headless_heartbeat_binding_issue_v1', { confirmation_token: pending.confirmation_token,
        view_digest: pending.view_digest })).error_code, 'confirmation_token_reused');
      // The headless page lists it like any headless token.
      const listed = (await native('clued_headless_binding_list_v1', {})).bindings.find((b) => b.binding_id === result.binding_id);
      assert.deepEqual([listed.kind, listed.scopes], ['headless', ['ci:heartbeat']]);
    });

    await t.test('every existing interface refuses it: resolve_binding for every scope, CI8 and Worker calls', async () => {
      for (const scope of [...EXISTING_SCOPES, 'ci:heartbeat']) {
        for (const key of ['global', '*', `project:${projectId}`]) {
          await assert.rejects(() => admin.query('select clued_private.resolve_binding($1,$2,$3)', [proof, scope, key]),
            /binding_not_authorized/, `${scope} ${key}`);
        }
      }
      for (const [scope, action] of [['context:read', 'read'], ['context:write', 'write'], ['audit:read', 'audit']]) {
        await assert.rejects(() => admin.query('select clued_private.resolve_binding_action_v12($1,$2,$3,$4)', [proof, scope, 'global', action]),
          /binding_not_authorized/, scope);
      }
      assert.ok(await refused(() => anon.query('select public.clued_work_verify_v1($1,$2) v', [proof,
        { scope: 'global', claim_id: uuid(), pr_ref: 'o/r#1', head_sha: 'a'.repeat(40) }])), 'CI8 verify');
      assert.ok(await refused(() => anon.query('select public.clued_work_verify_v1($1,$2) v', [proof,
        { scope: 'global', action: 'revocations_contexts' }])), 'CI8 command door');
      assert.ok(await refused(() => anon.query('select public.clued_work_merge_slot_holders_v1($1,$2) v', [proof,
        { scope: 'global', repository: 'o/r' }])), 'CI8 holders');
      assert.ok(await refused(() => workerGatewayRpc(gateway, 'clued_record_mutate', proof, {
        operation: 'create', record_type: 'note', record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
        idempotency_key: uuid(), authority: 'observed', confidence_reason: 'x', source_refs: [], source_unavailable_reason: 'x',
        mutation: { title: 'x', content: 'x', type_fields: { note_kind: 'x' }, relations: {} } })), 'Worker record write');
      assert.equal((await admin.query("select count(*)::int n from public.clued_memories where user_id=$1 and record_type='note'",
        [userId])).rows[0].n, 0);
    });

    await t.test('the resolver: only a live ci:heartbeat connection with a current authorization', async () => {
      const resolve = (p) => admin.query('select (clued_private.resolve_heartbeat_binding_v1($1)).id', [p]);
      assert.equal((await resolve(proof)).rows[0].id, heartbeat.binding_id);
      assert.equal((await admin.query(`select clued_private.binding_has_only_heartbeat_scope_v1(b) v from public.clued_agent_bindings b
        where b.id=$1`, [heartbeat.binding_id])).rows[0].v, true);
      await assert.rejects(() => resolve('nope'), /invalid_binding_or_context/);
      await assert.rejects(() => resolve(hex()), /binding_not_authorized/);
      // An ordinary connection is not reached through the heartbeat resolver.
      const ordinaryToken = hex();
      const ordinary = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','reader',$2,array['context:read'],array['*']) returning *`, [userId, ordinaryToken])).rows[0];
      await assert.rejects(() => resolve(ordinaryToken), /binding_not_authorized/);
      assert.equal((await admin.query('select clued_private.binding_has_only_heartbeat_scope_v1(b) v from public.clued_agent_bindings b where b.id=$1',
        [ordinary.id])).rows[0].v, false);
      // A headless rotation never replaces it.
      assert.equal((await native('clued_headless_binding_confirmation_issue_v1', { label: 'rotated', days: 7,
        selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }],
        replaces_binding_id: heartbeat.binding_id })).error_code, 'headless_binding_replace_target_invalid');
      // Expiry and revocation end it.
      await admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1",
        [heartbeat.binding_id]);
      await assert.rejects(() => resolve(proof), /binding_not_authorized/, 'expired');
      await admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()+interval '1 day' where binding_id=$1",
        [heartbeat.binding_id]);
      assert.equal((await resolve(proof)).rows[0].id, heartbeat.binding_id);
      const version = (await admin.query('select version from clued_private.authorizations_v12 where binding_id=$1', [heartbeat.binding_id])).rows[0].version;
      const revoked = await native('clued_authorization_manage_v12', { op: 'revoke', binding_id: heartbeat.binding_id, base_version: Number(version) });
      assert.notEqual(revoked.status, 'rejected', JSON.stringify(revoked));
      await assert.rejects(() => resolve(proof), /binding_not_authorized/, 'revoked');
      // Another account's Owner session cannot issue for this one; its own issue is its own.
      const other = await issueHeartbeat({ label: 'other node', days: 7 }, fresh(otherUser));
      assert.equal((await admin.query('select user_id from public.clued_agent_bindings where id=$1', [other.result.binding_id])).rows[0].user_id, otherUser);
    });

    await t.test('OAuth never offers it: the prepare and eligibility lists are unchanged', async () => {
      // The OAuth prepare entry and the function it delegates to (issuer identity wrapper).
      const prepares = (await admin.query(`select p.oid::regprocedure::text sig,p.prosrc from pg_proc p
        where p.proname like '%authorization_prepare_v12' order by 1`)).rows;
      assert.ok(prepares.length >= 2, prepares.map((r) => r.sig).join(' '));
      assert.ok(prepares.some((r) => /scopes <@ array\['context:read','context:write','audit:read'\]/.test(r.prosrc)),
        'the requested scopes are checked against the three OAuth scopes');
      assert.ok(prepares.every((r) => !r.prosrc.includes('ci:heartbeat')));
      const eligible = (await admin.query(`select prosrc from pg_proc where oid='clued_private.headless_binding_eligible_v1(uuid)'::regprocedure`)).rows[0].prosrc;
      assert.ok(!eligible.includes('ci:heartbeat'), 'the ordinary headless selection never offers it');
      const union = (await admin.query(`select clued_private.authorization_scope_union_v12($1::jsonb) v`,
        [JSON.stringify([{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write', 'audit', 'close', 'restore', 'feedback_submit'] }])])).rows[0].v;
      assert.ok(!union.includes('ci:heartbeat'), 'no selected action maps to it');
    });

    await assertGatewayCloseoutBoundary(admin);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
