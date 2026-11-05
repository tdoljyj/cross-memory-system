import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { serialize } from '../../../scripts/phase2-qualification/minimum-context-compiler/compiler.mjs';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Information Flow M0-D slice S5 (contract M0DCloseout.v0.1 sections 4.1,
// 4.3.3, 5.1, 6.3, 6.4, 7 E2E-03/04/05/14, 8 gates M0D-B01 and M0D-B05):
// knowledge lineage, Evidence withdrawal, record_evidence_status and the
// proactive invalidation fan-out, on the full migration chain, driven through
// the local Worker transport with an account session and Agent Bindings.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S5_MIGRATION = '20260924220000_information_flow_invalidation.sql';
const S5_PREDECESSOR = '20260924210000_bug_20260924_001_capture_unknown.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const stale = (sub, session = 'sess-main') =>
  ({ ...fresh(sub, session), amr: [{ method: 'password', timestamp: nowEpoch() - 16 * 60 }] });
const TOKENIZER = { package: 'js-tiktoken', version: '1.0.21', encoding: 'o200k_base', model_mapping: 'gpt-4.1-2025-04-14' };
const ALL_TIERS = ['authority_information', 'authority_knowledge', 'candidate_information', 'candidate_knowledge'];
let keyCounter = 0;
// Short, patterned synthetic idempotency keys.
const key = (label) => `if-s5-${label}-${String(++keyCounter).padStart(4, '0')}`;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const TEXT = 'Qingshi withdrawal fixture confirmed by the owner.';
const segment = (segmentId) => ({
  schema_version: 'segment_input.v1', segment_id: segmentId,
  reference_time: '2026-09-24T10:00:00+08:00', timezone: 'Asia/Shanghai',
  messages: [{ message_id: 'msg_s5_a', evidence_id: 'ev_s5_a', author_role: 'user',
    created_at: '2026-09-24T09:58:00+08:00', context_only: false, content: TEXT }],
});
const item = (local, itemType) => ({
  candidate_local_id: `item_${local}`, item_type: itemType,
  claim: `${itemType} claim ${local}: ${TEXT}`.slice(0, 300), summary: `${itemType} summary ${local}`.slice(0, 120),
  action_level: 'reference', priority: null,
  entity_mentions: [{ type: 'project', mention: 'Qingshi', role: 'subject' }], topics: ['risk'],
  temporal_mentions: [], source_anchors: [{ message_id: 'msg_s5_a', exact_quote: 'withdrawal fixture confirmed' }],
  confidence: 0.9, uncertainties: [], sensitivity_hint: 'none',
});
const documentOf = (segmentId, items) => ({ schema_version: 'candidate_information.v1', segment_id: segmentId, items });
const policyDoc = (taskClass, scopes, overrides = {}) => ({
  schema: 'clued.context-policy.v1', task_class: taskClass, allowed_scopes: scopes,
  allowed_record_types: ['decision', 'note', 'profile_fact', 'state', 'task'], require_evidence: false,
  fields: { required: ['title'], optional: ['content', 'rationale'] }, max_items: 50, token_budget: 32768,
  tokenizer: TOKENIZER, freshness: { mode: 'current' }, ...overrides,
});
const noteInput = (id, title, { scope = 'global', content = title, sources = [], extra = {} } = {}) => ({
  operation: 'create', id, record_type: 'note', record_schema_version: 1, lifecycle_status: 'active', scope,
  idempotency_key: key('note'), authority: 'user_explicit', user_confirmed: true, confidence: 1,
  confidence_reason: 'S5 fixture', source_refs: sources, source_unavailable_reason: sources.length ? null : 'Synthetic fixture',
  mutation: { title, content, type_fields: { note_kind: 'general' }, relations: {} }, ...extra,
});

test('Information Flow S5: lineage, Evidence withdrawal and invalidation fan-out', { timeout: 900000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-if-s5-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
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
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort();
    // Later slices sort after S5; the chain before S5 is applied first, S5
    // itself after the pre-S5 fixture, and every later migration right after.
    const s5Index = migrations.indexOf(S5_MIGRATION);
    assert.ok(s5Index > 0, 'the S5 migration is in the chain');
    assert.equal(migrations[s5Index - 1], S5_PREDECESSOR, 'S5 directly follows the #312 migration');
    const versions = migrations.map((name) => name.split('_')[0]);
    assert.equal(new Set(versions).size, versions.length, 'migration versions are unique');
    const apply = async (name) => {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    };
    for (const name of migrations.slice(0, s5Index)) await apply(name);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'if-s5@example.invalid',now()),($2,'if-s5-other@example.invalid',now())`, [userId, otherUser]);
    const tokenA = hash();
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values
      ($1,'synthetic','Agent A',$2,array['context:read','context:write'],array['*'])`, [userId, tokenA]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    let workerCaller; // The pre-S5 historical phase predates the C1 role.
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const as = async (claims) => human.query(
      "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [claims.sub ?? '', JSON.stringify(claims)]);
    const agent = async (token, name, input) => workerCaller
      ? await workerGatewayRpc(workerCaller, name, token, input)
      : (await anon.query(`select public.${name}($1,$2) v`, [token,input])).rows[0].v;
    const native = async (name, input, claims = fresh(userId)) => {
      await as(claims);
      return (await human.query(`select public.${name}($1,$2) v`, [input, sha256(JSON.stringify(input))])).rows[0].v;
    };
    const nativeOne = async (name, input, claims = fresh(userId)) => {
      await as(claims);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const count = async (table, where = 'true', params = []) =>
      (await admin.query(`select count(*)::int n from ${table} where ${where}`, params)).rows[0].n;
    const manifest = async (id) => (await admin.query(
      'select * from clued_private.context_pack_manifests where id=$1', [id])).rows[0];
    const lineage = async (knowledgeId) => (await admin.query(`select source_record_id,source_version::int,
        lineage_stale,stale_reason,seeded_by,version,stale_receipt_id
      from clued_private.knowledge_lineage where knowledge_record_id=$1 order by source_record_id`, [knowledgeId])).rows;
    const lineageOf = async (knowledgeId, sourceId) => (await lineage(knowledgeId))
      .find((row) => row.source_record_id === sourceId);
    const rowJson = async (table, id) => (await admin.query(`select to_jsonb(t) j from ${table} t where id=$1`, [id]))
      .rows[0].j;

    // ---- Pre-S5 fixture (direct RPC; migration evidence, not E2E).
    const preNote = async (title) => {
      const id = uuid();
      const written = await native('clued_user_record_mutate', noteInput(id, title));
      assert.equal(written.status, 'committed', JSON.stringify(written));
      return id;
    };
    const prePromoteKnowledge = async (sources, rule = 'knowledge.consolidate.v1') => {
      const proposed = await agent(tokenA, 'clued_knowledge_propose', { idempotency_key: key('prekp'), scope: 'global',
        rule_id: rule, assertion: `Pre-S5 knowledge ${keyCounter}`, sources });
      assert.equal(proposed.status, 'committed', JSON.stringify(proposed));
      const kcId = proposed.supplemental.candidate_id;
      const issued = await nativeOne('clued_candidate_confirmation_issue_v1', { tier: 'knowledge', candidate_id: kcId,
        base_version: 1, authority: 'user_explicit' });
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      const promoted = await native('clued_candidate_promote_v1', { idempotency_key: key('prekpp'), tier: 'knowledge',
        candidate_id: kcId, base_version: 1, confirmation_token: issued.confirmation_token, view_digest: issued.view_digest });
      assert.equal(promoted.supplemental?.outcome, 'promoted', JSON.stringify(promoted));
      return issued.record_id;
    };
    const s1 = await preNote('Pre-S5 source one');
    const s2 = await preNote('Pre-S5 source two');
    const s3 = await preNote('Pre-S5 drifting source');
    const k0 = await prePromoteKnowledge([{ id: s1, version: 1 }, { id: s2, version: 1 }]);
    const k0b = await prePromoteKnowledge([{ id: s3, version: 1 }], 'knowledge.dedup.v1');
    const drift = await native('clued_user_record_mutate', { operation: 'update', id: s3, record_type: 'note',
      record_schema_version: 1, lifecycle_status: 'active', scope: 'global', idempotency_key: key('predrift'),
      authority: 'user_explicit', confidence: 1, confidence_reason: 'S5 fixture', base_version: 1,
      mutation: { title: 'Pre-S5 drifting source v2' } });
    assert.equal(drift.status, 'committed', JSON.stringify(drift));
    const preIssued = await nativeOne('clued_context_policy_confirmation_issue_v1', {
      policy: policyDoc('pre.s5', ['global'], { allowed_record_types: ['note'] }), rationale: 'Pre-S5 policy',
      base_policy_version: 0 });
    assert.equal(preIssued.status, 'issued', JSON.stringify(preIssued));
    const preAccepted = await native('clued_context_policy_accept_v1', { idempotency_key: key('preacc'),
      task_class: 'pre.s5', base_policy_version: 0, confirmation_token: preIssued.confirmation_token,
      view_digest: preIssued.view_digest });
    assert.equal(preAccepted.status, 'committed', JSON.stringify(preAccepted));
    const m0 = await nativeOne('clued_user_context_pack', { scope: 'global', task_class: 'pre.s5' });
    assert.equal(m0.status, 'ok', JSON.stringify(m0));
    assert.deepEqual(m0.pack.items.map((row) => row.canonical_id).sort(), [s1, s2, s3, k0].sort(),
      'pre-S5: K0b is already excluded by the S4 exact-version recheck');

    await apply(S5_MIGRATION);
    for (const name of migrations.slice(s5Index + 1)) await apply(name);
    workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);

    // Backfill: live lineage for K0, backfill_source_changed for K0b.
    assert.deepEqual((await lineage(k0)).map((row) => [row.source_record_id, row.source_version, row.lineage_stale,
      row.stale_reason, row.seeded_by, row.version]), [s1, s2].sort().map((id) => [id, 1, false, null, 'backfill', 1]));
    assert.deepEqual((await lineage(k0b)).map((row) => [row.source_record_id, row.lineage_stale, row.stale_reason,
      row.seeded_by]), [[s3, true, 'backfill_source_changed', 'backfill']]);
    // A pre-S5 manifest over unaffected Records still revalidates VALID with
    // byte-identical digests (envelope and digest construction unchanged).
    const m0Valid = await nativeOne('clued_user_context_pack', { manifest_id: m0.manifest.id });
    assert.deepEqual([m0Valid.status, m0Valid.revalidation, m0Valid.pack_digest], ['ok', 'VALID', m0.pack_digest],
      JSON.stringify(m0Valid));

    // ---- M0D-B01 for the S5 tables and functions.
    for (const table of ['knowledge_lineage', 'record_evidence_status', 'evidence_withdrawals']) {
      await assert.rejects(anon.query(`select 1 from clued_private.${table}`), /permission denied/);
      await assert.rejects(human.query(`select 1 from clued_private.${table}`), /permission denied/);
      const meta = (await admin.query(`select c.relrowsecurity rls,
          has_table_privilege('anon',c.oid,'select,insert,update,delete,truncate,references,trigger') anon,
          has_table_privilege('authenticated',c.oid,'select,insert,update,delete,truncate,references,trigger') authenticated,
          has_table_privilege('service_role',c.oid,'select,insert,update,delete,truncate,references,trigger') service_role
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='clued_private' and c.relname=$1`, [table])).rows[0];
      assert.deepEqual(meta, { rls: true, anon: false, authenticated: false, service_role: false }, table);
    }
    const privateFns = ['invalidation_row_immutable_v1()', 'knowledge_lineage_guard_v1()',
      'record_evidence_unflagged_v1(uuid,uuid,bigint)', 'knowledge_lineage_current_v1(uuid,uuid,bigint)',
      'evidence_withdrawal_lock_v1(uuid,boolean)', 'pack_manifest_mark_stale_v1(uuid[],text,boolean)',
      'pack_manifest_stale_v1(uuid,text[],text,boolean)', 'pack_manifest_binding_stale_v1(uuid,boolean)',
      'knowledge_lineage_seed_v1()', 'record_source_change_v1()', 'knowledge_lineage_evidence_flag_v1()',
      'knowledge_lineage_manifest_stale_v1()', 'record_evidence_status_on_write_v1()',
      'pack_manifest_binding_change_v1()', 'pack_manifest_authorization_change_v1()',
      'evidence_withdrawal_view_v1(uuid,uuid,bigint,text)', 'evidence_withdrawal_effects_v1(uuid,uuid)',
      'evidence_withdrawal_confirmation_issue_core_v1(uuid,jsonb)', 'evidence_withdraw_core_v1(uuid,jsonb,text)',
      // Patched earlier-slice bodies keep their revoked ACL.
      'knowledge_propose_core_v1(uuid,uuid,jsonb,text)', 'knowledge_lineage_ok_v1(uuid,jsonb)',
      'context_knowledge_lineage_v1(uuid,jsonb)', 'context_pack_compile_v1(uuid,uuid,uuid,jsonb,text[])'];
    for (const fn of privateFns) {
      const grants = (await admin.query(`select has_function_privilege('anon',$1::regprocedure,'execute') anon,
        has_function_privilege('authenticated',$1::regprocedure,'execute') authenticated,
        has_function_privilege('service_role',$1::regprocedure,'execute') service_role`,
      [`clued_private.${fn}`])).rows[0];
      assert.deepEqual(grants, { anon: false, authenticated: false, service_role: false }, fn);
    }
    const newPrivate = (await admin.query(`select p.oid::regprocedure::text sig from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_private'
        and (p.proname like 'evidence\\_withdraw%' or p.proname like 'pack\\_manifest\\_%'
          or p.proname like 'knowledge\\_lineage\\_%' or p.proname in ('invalidation_row_immutable_v1',
            'record_source_change_v1','record_evidence_status_on_write_v1'))`)).rows.map((row) => row.sig);
    assert.deepEqual(newPrivate.map((sig) => sig.replace(/^clued_private\./, '')).sort(),
      privateFns.filter((fn) => !/^(record_evidence_unflagged|knowledge_propose_core|context_)/.test(fn)).sort(),
      'every new private function is listed (knowledge_lineage_ok_v1 is the patched S3 check)');
    const entryGrants = async (sig) => (await admin.query(`select has_function_privilege('anon',$1::regprocedure,'execute') anon,
      has_function_privilege('authenticated',$1::regprocedure,'execute') authenticated,
      has_function_privilege('service_role',$1::regprocedure,'execute') service_role,
      (select prosecdef from pg_proc where oid=$1::regprocedure) definer,
      (select proconfig from pg_proc where oid=$1::regprocedure) config`, [sig])).rows[0];
    for (const sig of ['public.clued_evidence_withdrawal_confirmation_issue_v1(jsonb)',
      'public.clued_evidence_withdraw_v1(jsonb,text)']) {
      const grants = await entryGrants(sig);
      assert.deepEqual([grants.anon, grants.authenticated, grants.service_role, grants.definer], [false, true, false, true],
        sig);
      assert.deepEqual(grants.config, ['search_path=""'], sig);
    }
    assert.deepEqual((await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'clued\\_evidence\\_withdraw%' order by 1`)).rows.map((row) => row.proname),
    ['clued_evidence_withdraw_v1', 'clued_evidence_withdrawal_confirmation_issue_v1']);
    const oauthBody = (await admin.query(
      "select pg_get_functiondef('public.clued_oauth_call(text,jsonb)'::regprocedure) d")).rows[0].d;
    assert.ok(!/evidence_withdraw/.test(oauthBody), 'no delegated OAuth case reaches Evidence withdrawal');
    const triggers = (await admin.query(`select c.relname tbl,t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where not t.tgisinternal and (t.tgname like 'information\\_flow\\_%' or t.tgname in ('knowledge_lineage_guard',
        'evidence_withdrawals_immutable','record_evidence_status_immutable')) order by 1,2`)).rows
      .map((row) => `${row.tbl}.${row.tgname}`);
    assert.deepEqual(triggers, ['authorizations_v12.information_flow_manifest_authorization_change',
      'candidate_promotions.information_flow_lineage_seed',
      'clued_agent_bindings.information_flow_manifest_binding_change',
      'clued_agent_bindings.information_flow_manifest_binding_delete',
      'clued_memories.information_flow_record_evidence_on_insert',
      'clued_memories.information_flow_record_evidence_on_update',
      'clued_memories.information_flow_source_change', 'clued_memories.information_flow_source_delete',
      'evidence_withdrawals.evidence_withdrawals_immutable',
      'knowledge_lineage.information_flow_lineage_manifest_stale', 'knowledge_lineage.knowledge_lineage_guard',
      'record_evidence_status.information_flow_lineage_evidence_flag',
      'record_evidence_status.record_evidence_status_immutable']);
    assert.equal(await count('pg_trigger t join pg_class c on c.oid=t.tgrelid',
      "c.relname='clued_context_events' and t.tgname like 'information\\_flow%'"), 0,
    'no trigger on clued_context_events: forged Events cannot change state');
    assert.equal(await count('clued_private.typed_event_currentness_registry',
      "event_type like 'extension:information\\_flow:%'"), 0);

    // ---- Worker transport. Only the PostgREST hop is shimmed.
    const worker = await loadContinuityWorker();
    const gatewayToken = 'synthetic-information-flow-invalidation-worker-gateway';
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await gateway.query('set session authorization authenticator; set role clued_worker_gateway');
    await gateway.query(`select set_config('request.jwt.claims','{"role":"clued_worker_gateway"}',false)`);
    const workerEnv = { PROJECT_VIEWS_V2: 'true', SUPABASE_URL: 'https://storage.clued.test',
      CLUED_DB_GATEWAY_TOKEN: gatewayToken,
      ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
    const rawBinding = `clued_bnd_${'s'.repeat(43)}`;
    const rawDeleted = `clued_bnd_${'d'.repeat(43)}`;
    const rawNarrowed = `clued_bnd_${'n'.repeat(43)}`;
    const rawAuthorized = `clued_bnd_${'v'.repeat(43)}`;
    const rawAuthorized2 = `clued_bnd_${'u'.repeat(43)}`;
    await admin.query(`insert into public.clued_agent_bindings (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Worker agent',$2,array['context:read','context:write'],array['*']),
            ($1,'synthetic','Deleted agent',$3,array['context:read','context:write'],array['*']),
            ($1,'synthetic','Narrowed agent',$4,array['context:read','context:write'],array['*'])`,
    [userId, sha256(rawBinding), sha256(rawDeleted), sha256(rawNarrowed)]);
    const sessions = new Map([
      ['account-jwt', () => fresh(userId)],
      ['second-session-jwt', () => fresh(userId, 'sess-second')],
      ['stale-jwt', () => stale(userId)],
      ['delegated-jwt', () => ({ ...fresh(userId), client_id: 'delegated-oauth' })],
      ['other-jwt', () => fresh(otherUser, 'sess-other')],
    ]);
    const rpcLog = [];
    const warnings = [];
    const previousFetch = globalThis.fetch;
    const previousWarn = console.warn;
    console.warn = (line) => { warnings.push(String(line)); };
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.host, 'storage.clued.test', 'no external call');
      const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '');
      const claims = sessions.get(token)?.();
      if (url.pathname === '/auth/v1/user') {
        return claims ? Response.json({ id: claims.sub }) : Response.json({ message: 'invalid JWT' }, { status: 401 });
      }
      const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname)?.[1];
      assert.ok(rpc, url.pathname);
      if (!claims && token !== gatewayToken) {
        return Response.json({ code: 'PGRST301', message: 'invalid JWT' }, { status: 401 });
      }
      rpcLog.push(rpc);
      const body = JSON.parse(init.body);
      const keys = Object.keys(body);
      const client = claims ? human : gateway;
      if (claims) await as(claims);
      try {
        const value = (await client.query(`select public.${rpc}(${keys.map((name, i) => `${name}=>$${i + 1}`).join(',')}) v`,
          keys.map((name) => body[name]))).rows[0].v;
        return Response.json(value);
      } catch (error) {
        const status = error.code === '42501' ? (claims ? 403 : 401)
          : /^54/.test(error.code) ? 413
            : /^(P0|XX|55|40|25)/.test(error.code) && error.code !== 'P0001' ? 500
              : ['23503', '23505'].includes(error.code) ? 409 : 400;
        return Response.json({ code: error.code, message: error.message }, { status });
      }
    };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const request = async (method, pathname, body, token = 'account-jwt') => {
      const response = await worker.fetch(new Request(`https://clued.test${pathname}`, {
        method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), workerEnv, ctx);
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const post = async (pathname, body, token = 'account-jwt') => request('POST', pathname, body, token);
    const call = async (name, args, token = rawBinding) => {
      const response = await worker.fetch(new Request('https://clued.test/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }), workerEnv, ctx);
      const envelope = await response.json();
      return envelope.result?.structuredContent ?? envelope.error ?? envelope;
    };
    const project = async (name) => {
      const id = uuid();
      const created = await agent(tokenA, 'clued_project_mutate_v2', { operation: 'create', canonical_project_id: id,
        project_schema_version: 2, base_version: null, idempotency_key: key('proj'), mutation: { name: `S5 ${name}`,
          progress_status: 'active', aliases: [] } });
      assert.equal(created.status, 'committed', JSON.stringify(created));
      return `project:${id}`;
    };
    const nativeNote = async (title, options = {}) => {
      const id = uuid();
      const created = await post('/v1/records', noteInput(id, title, options));
      assert.equal(created.status, 200, JSON.stringify(created.body));
      assert.equal(created.body.status, 'committed');
      return id;
    };
    const updateNote = async (id, scope, base, mutation, extra = {}) => {
      const updated = await post('/v1/records', { operation: 'update', id, record_type: 'note', record_schema_version: 1,
        lifecycle_status: 'active', scope, idempotency_key: key('upd'), authority: 'user_explicit', confidence: 1,
        confidence_reason: 'S5 fixture', base_version: base, mutation, ...extra });
      assert.equal(updated.body.status, 'committed', JSON.stringify(updated.body));
      return updated.body;
    };
    const nativeEvidence = async (label) => {
      const ingested = await post('/v1/evidence', { idempotency_key: key('ev'), evidence_schema_version: 1,
        evidence_type: 'file', storage_ref: `native:${label}`, content_hash: sha256(label), mime_type: 'text/plain',
        size_bytes: label.length });
      assert.equal(ingested.body.status, 'committed', JSON.stringify(ingested.body));
      return ingested.body.evidence_ids[0];
    };
    const accept = async (doc, base = 0) => {
      const issued = await post('/v1/context/policies/confirmation', { policy: doc, rationale: 'Owner accepts', base_policy_version: base });
      assert.equal(issued.body.status, 'issued', JSON.stringify(issued.body));
      const accepted = await post('/v1/context/policies', { idempotency_key: key('acc'), task_class: issued.body.task_class,
        base_policy_version: base, confirmation_token: issued.body.confirmation_token, view_digest: issued.body.view_digest });
      assert.equal(accepted.body.status, 'committed', JSON.stringify(accepted.body));
      return accepted.body.supplemental.policy_id;
    };
    const packOk = (result, label) => {
      assert.equal(result.status, 'ok', `${label}: ${JSON.stringify(result)}`);
      assert.equal(sha256(result.pack_text), result.pack_digest, `${label}: digest binds pack_text`);
      assert.equal(serialize(JSON.parse(result.pack_text)), result.pack_text, `${label}: serialize()`);
      return result;
    };
    const insufficient = async (taskClass, scope, reason, token = rawBinding) => {
      const result = await call('clued_context_pack', { scope, task_class: taskClass }, token);
      assert.deepEqual([result.status, result.error_code, result.reason], ['rejected', 'CONTEXT_INSUFFICIENT', reason],
        `${taskClass} ${JSON.stringify(result)}`);
    };
    const revalidate = async (id) => post('/v1/context/pack', { manifest_id: id });
    const proposeAgent = async (scope, sources, rule = 'knowledge.consolidate.v1', token = rawBinding) => {
      const proposed = await call('clued_knowledge_propose', { idempotency_key: key('kp'), scope, rule_id: rule,
        assertion: `Knowledge ${keyCounter} over ${sources.length} sources.`, sources }, token);
      assert.equal(proposed.status, 'committed', JSON.stringify(proposed));
      return proposed.supplemental.candidate_id;
    };
    const promoteKnowledge = async (kcId) => {
      const issued = await post(`/v1/knowledge/candidates/${kcId}/confirmation`, { base_version: 1,
        authority: 'user_explicit' });
      assert.equal(issued.body.status, 'issued', JSON.stringify(issued.body));
      const promoted = await post(`/v1/knowledge/candidates/${kcId}/promote`, { idempotency_key: key('kpp'),
        base_version: 1, confirmation_token: issued.body.confirmation_token, view_digest: issued.body.view_digest });
      assert.equal(promoted.body.supplemental?.outcome, 'promoted', JSON.stringify(promoted.body));
      return issued.body.record_id;
    };
    const issueWithdrawal = async (evidenceId, base, reason = 'Source was wrong', token = 'account-jwt', extra = {}) =>
      post(`/v1/evidence/${evidenceId}/withdrawal/confirmation`, { base_version: base, reason, ...extra }, token);
    const withdrawInput = (issued, overrides = {}) => ({ idempotency_key: key('wd'), base_version: issued.base_version,
      confirmation_token: issued.confirmation_token, view_digest: issued.view_digest, ...overrides });
    const withdraw = async (evidenceId, input, token = 'account-jwt') =>
      post(`/v1/evidence/${evidenceId}/withdrawal`, input, token);
    const tokenRow = async (id) => (await admin.query('select * from clued_private.native_confirmation_tokens where id=$1',
      [id])).rows[0];
    const flags = async (recordId) => (await admin.query(`select record_version::int,evidence_id,flagged_by
      from clued_private.record_evidence_status where record_id=$1 order by record_version`, [recordId])).rows;
    const unflagged = async (id, version) => (await admin.query(
      'select clued_private.record_evidence_unflagged_v1($1,$2,$3) v', [userId, id, version])).rows[0].v;
    const deltas = async () => (await admin.query(`select
      (select count(*)::int from public.clued_memories where user_id=$1) memories,
      (select count(*)::int from public.clued_audit_receipts where user_id=$1) receipts,
      (select count(*)::int from public.clued_context_events where user_id=$1) events`, [userId])).rows[0];

    try {
      // ---- E2E-03: lineage. Knowledge over two human-confirmed Authority
      // Records; one source update flags lineage_stale only.
      const p3 = await project('e2e-03');
      const noteA = await nativeNote('Lineage source A', { scope: p3 });
      const noteB = await nativeNote('Lineage source B', { scope: p3 });
      const kc3 = await proposeAgent(p3, [{ id: noteA, version: 1 }, { id: noteB, version: 1 }]);
      const k3 = await promoteKnowledge(kc3);
      assert.deepEqual((await lineage(k3)).map((row) => [row.source_record_id, row.source_version, row.lineage_stale,
        row.seeded_by, row.version]), [noteA, noteB].sort().map((id) => [id, 1, false, 'promotion', 1]));
      assert.deepEqual((await admin.query(`select rule_id,candidate_id,promotion_record_receipt_id=(select receipt_id
          from clued_private.candidate_promotions where record_id=$1) bound
        from clued_private.knowledge_lineage where knowledge_record_id=$1 limit 1`, [k3])).rows[0],
      { rule_id: 'knowledge.consolidate.v1', candidate_id: kc3, bound: true });
      await accept(policyDoc('e03.know', [p3], { allowed_tiers: ['authority_knowledge'], allowed_record_types: ['note'] }));
      await accept(policyDoc('e03.mixed', [p3], { allowed_record_types: ['note'] }));
      const m1 = packOk(await call('clued_context_pack', { scope: p3, task_class: 'e03.know' }), 'e03.know');
      assert.deepEqual(m1.pack.items.map((row) => [row.canonical_id, row.tier, row.status.lineage]),
        [[k3, 'authority_knowledge', 'OK']]);
      const m2 = packOk(await call('clued_context_pack', { scope: p3, task_class: 'e03.mixed' }), 'e03.mixed');
      assert.deepEqual(m2.pack.items.map((row) => row.canonical_id).sort(), [noteA, noteB, k3].sort());
      // Control: an unrelated update's Record/Receipt/Event deltas.
      const pControl = await project('e2e-03-control');
      const control = await nativeNote('Control note', { scope: pControl });
      let before = await deltas();
      await updateNote(control, pControl, 1, { title: 'Control note v2' });
      const controlDelta = await deltas();
      const expected = { memories: controlDelta.memories - before.memories, receipts: controlDelta.receipts - before.receipts,
        events: controlDelta.events - before.events };
      const k3Row = await rowJson('public.clued_memories', k3);
      const marker = (await admin.query('select now() t')).rows[0].t;
      before = await deltas();
      await updateNote(noteA, p3, 1, { title: 'Lineage source A v2' });
      const after = await deltas();
      assert.deepEqual({ memories: after.memories - before.memories, receipts: after.receipts - before.receipts,
        events: after.events - before.events }, expected, 'the triggers write no Record, Receipt or Event');
      const staleA = await lineageOf(k3, noteA);
      assert.deepEqual([staleA.lineage_stale, staleA.stale_reason, staleA.version], [true, 'source_updated', 2]);
      assert.equal((await lineageOf(k3, noteB)).lineage_stale, false);
      assert.deepEqual(await rowJson('public.clued_memories', k3), k3Row, 'the knowledge Record is byte-identical');
      assert.equal(await count('public.clued_audit_receipts', 'created_at>=$1 and (committed_versions ? $2 or target_refs::text like $3)',
        [marker, k3, `%${k3}%`]), 0, 'no Receipt references K');
      assert.equal(await count('public.clued_context_events', 'occurred_at>=$1 and target_refs::text like $2',
        [marker, `%${k3}%`]), 0, 'no Event references K');
      assert.deepEqual([(await manifest(m1.manifest.id)).stale, (await manifest(m1.manifest.id)).stale_reason,
        (await manifest(m1.manifest.id)).version], [true, 'lineage_stale', 2]);
      assert.deepEqual([(await manifest(m2.manifest.id)).stale, (await manifest(m2.manifest.id)).stale_reason],
        [true, 'source_updated'], 'the direct source reason wins for a manifest listing A');
      const m1Revalidated = await revalidate(m1.manifest.id);
      assert.deepEqual([m1Revalidated.status, m1Revalidated.body.revalidation, m1Revalidated.body.reason],
        [409, 'STALE', 'lineage_stale']);
      assert.ok(!('pack_text' in m1Revalidated.body), 'a pack is never an online fallback');
      await insufficient('e03.know', p3, 'no_eligible_sources');
      const m2After = packOk(await call('clued_context_pack', { scope: p3, task_class: 'e03.mixed' }), 'e03.mixed after');
      assert.deepEqual(m2After.pack.items.map((row) => row.canonical_id).sort(), [noteA, noteB].sort(), 'K is omitted');
      // Variants: supersede, close and delete of a lineage source.
      const p3v = await project('e2e-03-variants');
      const decisionId = uuid();
      assert.equal((await post('/v1/records', { operation: 'create', id: decisionId, record_type: 'decision',
        record_schema_version: 1, lifecycle_status: 'active', scope: p3v, idempotency_key: key('dec'),
        authority: 'user_explicit', confidence: 1, confidence_reason: 'S5 fixture', source_refs: [],
        source_unavailable_reason: 'Synthetic fixture', mutation: { title: 'Lineage decision', content: 'Decide',
          type_fields: { rationale: 'Because' }, relations: {} } })).body.status, 'committed');
      const kSup = await promoteKnowledge(await proposeAgent(p3v, [{ id: decisionId, version: 1 }], 'knowledge.dedup.v1'));
      const superseded = await post('/v1/decisions/supersede', { idempotency_key: key('sup'), supersede_reason: 'Replaced',
        source_decisions: [{ id: decisionId, base_version: 1 }],
        replacement: { id: uuid(), scope: p3v, record_schema_version: 1, title: 'New decision', content: 'New',
          type_fields: { rationale: 'Now' }, relations: { supersedes: [decisionId] }, authority: 'user_explicit',
          source_refs: [], source_unavailable_reason: 'Synthetic fixture', confidence_reason: 'S5 fixture' } });
      assert.equal(superseded.body.status, 'committed', JSON.stringify(superseded.body));
      assert.deepEqual([(await lineageOf(kSup, decisionId)).lineage_stale, (await lineageOf(kSup, decisionId)).stale_reason],
        [true, 'source_superseded']);
      const closable = await nativeNote('Closable source', { scope: p3v });
      const kClose = await promoteKnowledge(await proposeAgent(p3v, [{ id: closable, version: 1 }], 'knowledge.dedup.v1'));
      assert.equal((await post('/v1/records', { operation: 'close', id: closable, record_type: 'note',
        record_schema_version: 1, lifecycle_status: 'archived', scope: p3v, idempotency_key: key('close'),
        authority: 'user_explicit', confidence_reason: 'S5 fixture', base_version: 1,
        mutation: { closure_summary: 'Archived' } })).body.status, 'committed');
      assert.deepEqual([(await lineageOf(kClose, closable)).lineage_stale, (await lineageOf(kClose, closable)).stale_reason],
        [true, 'source_closed']);
      const deletable = await nativeNote('Deletable source', { scope: p3v });
      const kDelete = await promoteKnowledge(await proposeAgent(p3v, [{ id: deletable, version: 1 }], 'knowledge.dedup.v1'));
      await admin.query('delete from public.clued_memories where id=$1', [deletable]);
      assert.deepEqual([(await lineageOf(kDelete, deletable)).lineage_stale, (await lineageOf(kDelete, deletable)).stale_reason],
        [true, 'source_deleted']);
      // Authority Knowledge needs promotion lineage (Owner decision, option A):
      // a knowledge-shaped note written directly through /v1/records is excluded.
      const directKnowledge = uuid();
      assert.equal((await post('/v1/records', { ...noteInput(directKnowledge, 'Direct knowledge-shaped note', { scope: p3 }),
        mutation: { title: 'Direct knowledge-shaped note', content: 'x', type_fields: { note_kind: 'knowledge',
          knowledge: { schema: 'clued.knowledge-lineage.v1', rule_id: 'knowledge.dedup.v1',
            sources: [{ id: noteB, version: 1 }], evidence_ids: [], candidate_id: uuid() } }, relations: {} } }))
        .body.status, 'committed');
      await insufficient('e03.know', p3, 'no_eligible_sources');

      // ---- E2E-04: Evidence withdrawal fan-out.
      const p4 = await project('e2e-04');
      const intake = await post('/v1/intake', { idempotency_key: key('e04'), scope: p4, segment: segment('seg_s5_e04'),
        candidates: documentOf('seg_s5_e04', [item('one', 'fact'), item('two', 'fact')]) });
      assert.equal(intake.status, 200, JSON.stringify(intake.body));
      const [cand1, cand2] = ['item_one', 'item_two'].map((local) => intake.body.supplemental.candidates
        .find((row) => row.candidate_local_id === local).id);
      const evidenceE = (await admin.query('select evidence_id from clued_private.information_intake_submissions where id=$1',
        [intake.body.supplemental.submission_id])).rows[0].evidence_id;
      const r1View = (await post(`/v1/intake/${cand1}/confirmation`, { base_version: 1, authority: 'user_explicit' })).body;
      const r1Promote = await post(`/v1/intake/${cand1}/promote`, { idempotency_key: key('e04p'), base_version: 1,
        confirmation_token: r1View.confirmation_token, view_digest: r1View.view_digest });
      assert.equal(r1Promote.body.supplemental?.outcome, 'promoted', JSON.stringify(r1Promote.body));
      const recordR = r1View.record_id;
      assert.deepEqual((await admin.query('select source_refs from public.clued_memories where id=$1', [recordR])).rows[0]
        .source_refs, [evidenceE]);
      const noteS = await nativeNote('Independent source S', { scope: p4 });
      const k4 = await promoteKnowledge(await proposeAgent(p4, [{ id: recordR, version: 1 }, { id: noteS, version: 1 }]));
      const kc4 = await proposeAgent(p4, [{ id: recordR, version: 1 }], 'knowledge.dedup.v1');
      await accept(policyDoc('e04.all', [p4], { allowed_tiers: ALL_TIERS, allowed_record_types: ['note'],
        allow_agent_authored: true }));
      const e04Pack = packOk((await post('/v1/context/pack', { scope: p4, task_class: 'e04.all' })).body, 'e04 before');
      assert.deepEqual(e04Pack.pack.items.map((row) => row.canonical_id).sort(), [recordR, noteS, k4, cand2, kc4].sort());
      const e04Manifest = e04Pack.manifest.id;
      const candToken = (await post(`/v1/intake/${cand2}/confirmation`, { base_version: 1, authority: 'user_explicit' })).body;
      const kcToken = (await post(`/v1/knowledge/candidates/${kc4}/confirmation`, { base_version: 1,
        authority: 'user_explicit' })).body;
      assert.equal(candToken.status, 'issued');
      assert.equal(kcToken.status, 'issued');
      const snapshot = {
        evidence: await rowJson('public.clued_evidence', evidenceE),
        r: await rowJson('public.clued_memories', recordR),
        k: await rowJson('public.clued_memories', k4),
      };
      const heads = async () => (await admin.query(`select
        (select md5(coalesce(string_agg(to_jsonb(h)::text,',' order by h.canonical_scope),'')) from clued_private.scope_currentness_heads h where h.user_id=$1) scope,
        (select md5(coalesce(string_agg(to_jsonb(h)::text,',' order by h.target_scope,h.projection_key),'')) from clued_private.projection_invalidation_heads h where h.user_id=$1) projection,
        (select md5(coalesce(string_agg(to_jsonb(h)::text,',' order by to_jsonb(h)::text),'')) from clued_private.mtpe_intake_projection h where h.user_id=$1) mtpe`,
      [userId])).rows[0];
      const headsBefore = await heads();
      const issued4 = await issueWithdrawal(evidenceE, 0, 'The capture was pasted into the wrong chat');
      assert.equal(issued4.status, 200, JSON.stringify(issued4.body));
      assert.equal(issued4.body.status, 'issued');
      assert.match(issued4.body.confirmation_token, /^clued_cwt_[0-9a-f]{64}$/);
      assert.equal(issued4.headers.get('cache-control'), 'no-store');
      assert.deepEqual(issued4.body.confirmation_view, { action: 'evidence_withdraw', base_version: 0,
        reason: 'The capture was pasted into the wrong chat', evidence: { id: evidenceE,
          evidence_type: snapshot.evidence.evidence_type, content_hash: snapshot.evidence.content_hash,
          size_bytes: snapshot.evidence.size_bytes, mime_type: snapshot.evidence.mime_type,
          storage_ref: snapshot.evidence.storage_ref, recorded_at: snapshot.evidence.recorded_at } });
      assert.equal(issued4.body.view_digest, (await tokenRow(issued4.body.token_id)).view_digest);
      assert.deepEqual(issued4.body.effects_preview.records, [{ id: recordR, version: 1 }]);
      assert.deepEqual([issued4.body.effects_preview.counts.records, issued4.body.effects_preview.truncated], [1, false]);
      assert.equal(await count('public.clued_audit_receipts', "operation_family='evidence_withdraw'"), 0,
        'issuing writes no Receipt');
      const withdrawn4 = await withdraw(evidenceE, withdrawInput(issued4.body));
      assert.equal(withdrawn4.status, 200, JSON.stringify(withdrawn4.body));
      assert.equal(withdrawn4.body.status, 'committed');
      const out4 = withdrawn4.body.supplemental;
      assert.deepEqual([out4.outcome, out4.evidence_id, out4.withdrawal_version], ['withdrawn', evidenceE, 1]);
      assert.deepEqual(out4.conflicted_candidates.map((row) => [row.tier, row.id, row.version]).sort(),
        [['information', cand2, 2], ['knowledge', kc4, 2]].sort());
      assert.deepEqual(out4.flagged_records, [{ id: recordR, version: 1 }]);
      assert.deepEqual(out4.stale_lineage, [{ knowledge_record_id: k4, knowledge_version: 1 }]);
      assert.equal(out4.stale_manifests, 1);
      const withdrawalRow = (await admin.query('select * from clued_private.evidence_withdrawals where evidence_id=$1',
        [evidenceE])).rows[0];
      assert.deepEqual([withdrawalRow.status, withdrawalRow.version, withdrawalRow.reason, withdrawalRow.withdrawn_receipt_id,
        withdrawalRow.token_id, withdrawalRow.withdrawn_session_id, withdrawalRow.evidence_content_hash],
      ['withdrawn', 1, 'The capture was pasted into the wrong chat', withdrawn4.body.receipt_id, issued4.body.token_id,
        'sess-main', snapshot.evidence.content_hash]);
      const m1sha = async (value) => (await admin.query('select clued_private.m1_sha256($1::jsonb) v',
        [JSON.stringify(value)])).rows[0].v;
      assert.deepEqual(withdrawalRow.fanout, {
        records: { count: 1, digest: await m1sha([{ id: recordR, version: 1 }]) },
        candidates: { count: 2, information: 1, knowledge: 1, digest: await m1sha([
          { tier: 'information', id: cand2, version: 1 }, { tier: 'knowledge', id: kc4, version: 1 }]) },
        knowledge: { count: 1, digest: await m1sha([{ knowledge_record_id: k4, knowledge_version: 1 }]) },
      }, 'the withdrawal row stores counts and digests, not id lists');
      assert.deepEqual(out4.fanout, { ...withdrawalRow.fanout, stale_manifests: 1 });
      assert.deepEqual([out4.list_cap, out4.truncated], [100, false]);
      for (const [table, id] of [['information_candidates', cand2], ['knowledge_candidates', kc4]]) {
        const row = (await admin.query(`select status,version,decided_by,last_receipt_id from clued_private.${table}
          where id=$1`, [id])).rows[0];
        assert.deepEqual(row, { status: 'conflict', version: 2, decided_by: 'native_ui',
          last_receipt_id: withdrawn4.body.receipt_id }, table);
        assert.equal(await count('clued_private.candidate_transitions', "candidate_id=$1 and to_status='conflict' and receipt_id=$2",
          [id, withdrawn4.body.receipt_id]), 1);
      }
      for (const tokenId of [candToken.token_id, kcToken.token_id]) {
        assert.ok((await admin.query('select revoked_at from clued_private.candidate_confirmation_tokens where id=$1',
          [tokenId])).rows[0].revoked_at instanceof Date, 'dependent candidate tokens are revoked');
      }
      assert.deepEqual(await flags(recordR), [{ record_version: 1, evidence_id: evidenceE, flagged_by: 'withdrawal' }]);
      assert.deepEqual(await flags(k4), [], 'K cites no Evidence itself; only its lineage is flagged');
      const kr = await lineageOf(k4, recordR);
      assert.deepEqual([kr.lineage_stale, kr.stale_reason, kr.stale_receipt_id],
        [true, 'source_evidence_withdrawn', withdrawn4.body.receipt_id]);
      assert.equal((await lineageOf(k4, noteS)).lineage_stale, false);
      assert.deepEqual([(await manifest(e04Manifest)).stale, (await manifest(e04Manifest)).stale_reason],
        [true, 'evidence_withdrawn']);
      const e04After = packOk((await post('/v1/context/pack', { scope: p4, task_class: 'e04.all' })).body, 'e04 after');
      assert.deepEqual(e04After.pack.items.map((row) => row.canonical_id), [noteS], 'R, K, C and KC are excluded');
      assert.deepEqual(await rowJson('public.clued_evidence', evidenceE), snapshot.evidence, 'the Evidence row is unchanged');
      assert.deepEqual(await rowJson('public.clued_memories', recordR), snapshot.r, 'the Record body is unchanged');
      assert.deepEqual(await rowJson('public.clued_memories', k4), snapshot.k);
      const wdReceipt = (await admin.query('select * from public.clued_audit_receipts where id=$1',
        [withdrawn4.body.receipt_id])).rows[0];
      assert.deepEqual([wdReceipt.operation_family, wdReceipt.status, wdReceipt.binding_id, wdReceipt.evidence_ids],
        ['evidence_withdraw', 'committed', null, [evidenceE]]);
      assert.deepEqual(wdReceipt.base_versions, { [`evidence_withdrawal:${evidenceE}`]: 0 });
      assert.deepEqual(wdReceipt.committed_versions, { [`evidence_withdrawal:${evidenceE}`]: 1 },
        'no Record keys and no per-candidate keys: the Receipt size is bounded');
      const fanoutRef = `evidence_withdrawal_fanout:${await m1sha(out4.fanout)}`;
      assert.ok(wdReceipt.target_refs.some((ref) => ref.id === fanoutRef),
        'the Receipt binds the fan-out summary digest');
      assert.ok(!JSON.stringify(wdReceipt.canonical_result).includes(cand2), 'no candidate id in the Receipt');
      const wdEvent = (await admin.query('select * from public.clued_context_events where id=$1::bigint',
        [withdrawn4.body.event_ids[0]])).rows[0];
      assert.deepEqual([wdEvent.canonical_event_type, wdEvent.event_type, wdEvent.audit_visibility, wdEvent.event_scope],
        ['extension:information_flow:evidence_withdrawn', 'action', 'audit_only', 'global']);
      assert.ok(wdEvent.target_refs.every((ref) => ['system', 'evidence'].includes(ref.kind)), 'no Record refs');
      assert.deepEqual(Object.keys(wdEvent.change_summary).sort(), ['evidence_id', 'fanout', 'token_id', 'withdrawal_id']);
      assert.deepEqual(wdEvent.change_summary.fanout, out4.fanout, 'the Event carries counts and digests only');
      assert.ok(!JSON.stringify(wdEvent.change_summary).includes(recordR));
      assert.equal(await count('clued_private.event_truth_carriers', 'event_id=$1', [wdEvent.id]), 0, 'no carrier');
      assert.ok(!JSON.stringify(wdEvent).includes(issued4.body.confirmation_token), 'the token never reaches an Event');
      assert.equal((await tokenRow(issued4.body.token_id)).consume_outcome, 'committed');
      assert.deepEqual(await heads(), headsBefore, 'no Currentness, projection or MTPE head changes');
      await as(fresh(userId));
      const listed = (await human.query('select public.clued_user_record_list($1) v',
        [{ level: 'project', project_id: p4.slice('project:'.length), record_type: 'note' }])).rows[0].v;
      const listedR = listed.records.find((row) => row.id === recordR);
      assert.ok(listedR, JSON.stringify(listed).slice(0, 400));
      assert.equal(listedR.lifecycle_status ?? listedR.status, 'active', 'MSCP-only flag scope (A03)');
      // Promotion of a dependent candidate with a pre-withdrawal token.
      const lateC = await post(`/v1/intake/${cand2}/promote`, { idempotency_key: key('late'), base_version: 1,
        confirmation_token: candToken.confirmation_token, view_digest: candToken.view_digest });
      assert.deepEqual([lateC.status, lateC.body.error_code], [403, 'confirmation_token_revoked']);
      // Proposals: citing E, over a flagged source, over knowledge.
      const citeE = await post('/v1/knowledge/candidates', { idempotency_key: key('kpe'), scope: p4,
        rule_id: 'knowledge.dedup.v1', assertion: 'Cites withdrawn Evidence', sources: [{ id: noteS, version: 1 }],
        evidence_ids: [evidenceE] });
      assert.deepEqual([citeE.status, citeE.body.error_code], [409, 'knowledge_evidence_withdrawn']);
      const overFlagged = await call('clued_knowledge_propose', { idempotency_key: key('kpf'), scope: p4,
        rule_id: 'knowledge.dedup.v1', assertion: 'Over a flagged source', sources: [{ id: recordR, version: 1 }] });
      assert.equal(overFlagged.error_code, 'knowledge_source_evidence_withdrawn', JSON.stringify(overFlagged));
      const overKnowledge = await post('/v1/knowledge/candidates', { idempotency_key: key('kpk'), scope: p4,
        rule_id: 'knowledge.dedup.v1', assertion: 'Over knowledge', sources: [{ id: k4, version: 1 }] });
      assert.deepEqual([overKnowledge.status, overKnowledge.body.error_code], [422, 'knowledge_source_not_information']);
      // A later version that still cites E is flagged at write time.
      await updateNote(recordR, p4, 1, { title: 'R v2 still citing E' });
      assert.deepEqual((await flags(recordR)).map((row) => [row.record_version, row.flagged_by]),
        [[1, 'withdrawal'], [2, 'record_write']]);
      assert.equal(await unflagged(recordR, 2), false);
      assert.deepEqual(packOk((await post('/v1/context/pack', { scope: p4, task_class: 'e04.all' })).body, 'e04 v2')
        .pack.items.map((row) => row.canonical_id), [noteS]);
      // Re-sourcing through the M1 wrapper lifts the exclusion.
      const evidenceF = await nativeEvidence('s5-fresh-evidence-f');
      await updateNote(recordR, p4, 2, { title: 'R v3 re-sourced' }, { source_refs: [evidenceF] });
      assert.equal(await unflagged(recordR, 3), true);
      const e04Resourced = packOk((await post('/v1/context/pack', { scope: p4, task_class: 'e04.all' })).body, 'e04 v3');
      assert.deepEqual(e04Resourced.pack.items.map((row) => [row.canonical_id, row.version, row.human_confirmed]).sort(),
        [[noteS, 1, true], [recordR, 3, true]].sort());

      // ---- Output cap: the fan-out is uncapped, the echoed lists are not.
      const pCap = await project('cap');
      const eCap = await nativeEvidence('s5-cap-evidence');
      const capIds = [];
      for (let i = 0; i < 101; i += 1) {
        const id = uuid();
        capIds.push(id);
        const written = (await admin.query('select clued_private.record_mutation_with_terminal_guard($1,null,$2,$3) v',
          [userId, noteInput(id, `Cap note ${i}`, { scope: pCap, sources: [eCap] }), hash()])).rows[0].v;
        assert.equal(written.status, 'committed', JSON.stringify(written));
      }
      const capIssued = (await issueWithdrawal(eCap, 0)).body;
      assert.deepEqual([capIssued.effects_preview.records.length, capIssued.effects_preview.counts.records,
        capIssued.effects_preview.truncated], [100, 101, true]);
      const capWithdrawn = await withdraw(eCap, withdrawInput(capIssued));
      assert.equal(capWithdrawn.body.status, 'committed', JSON.stringify(capWithdrawn.body).slice(0, 400));
      const capOut = capWithdrawn.body.supplemental;
      assert.deepEqual([capOut.flagged_records.length, capOut.fanout.records.count, capOut.truncated, capOut.list_cap],
        [100, 101, true, 100]);
      assert.equal(await count('clued_private.record_evidence_status', 'evidence_id=$1', [eCap]), 101,
        'every dependent Record is flagged');
      const capEvent = (await admin.query('select change_summary from public.clued_context_events where id=$1::bigint',
        [capWithdrawn.body.event_ids[0]])).rows[0].change_summary;
      assert.equal(capEvent.fanout.records.count, 101);
      assert.ok(JSON.stringify(capEvent).length < 1000, 'the Event size does not grow with the fan-out');

      // ---- Withdrawal guard matrix.
      const eg = await nativeEvidence('s5-guard-evidence');
      for (const [pathname, route] of [[`/v1/evidence/${eg}/withdrawal/confirmation`, 'evidence_withdrawal_confirmation'],
        [`/v1/evidence/${eg}/withdrawal`, 'evidence_withdraw']]) {
        for (const token of [rawBinding, null]) {
          const rpcsBefore = rpcLog.length;
          const refused = await post(pathname, { base_version: 0, reason: 'r' }, token);
          assert.equal(refused.status, 401, pathname);
          assert.equal(rpcLog.length, rpcsBefore, 'no RPC ran');
          assert.deepEqual(JSON.parse(warnings.at(-1)), { event: 'information_flow_native_route_denied', route,
            reason: 'binding_or_missing_token' });
        }
      }
      const receiptsBefore = await count('public.clued_audit_receipts');
      for (const [name, args] of [['clued_evidence_withdraw_v1', [{ idempotency_key: 'if-s5-direct-0001',
        evidence_id: eg, base_version: 0 }, hash()]],
      ['clued_evidence_withdrawal_confirmation_issue_v1', [{ evidence_id: eg, base_version: 0, reason: 'r' }]]]) {
        await assert.rejects(anon.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args),
          (error) => error.code === '42501' && /permission denied/.test(error.message), name);
      }
      assert.equal(await count('public.clued_audit_receipts'), receiptsBefore, 'no Receipt for a direct anon call');
      assert.equal((await issueWithdrawal(eg, 0, 'r', 'delegated-jwt')).status, 403, 'a delegated OAuth session is refused');
      const staleIssue = await issueWithdrawal(eg, 0, 'r', 'stale-jwt');
      assert.deepEqual([staleIssue.status, staleIssue.body.error_code], [401, 'reauthentication_required']);
      assert.match(staleIssue.headers.get('www-authenticate'), /insufficient_user_authentication.*max_age="900"/);
      for (const [body, code] of [[{ base_version: 0, reason: 'r', surprise: 1 }, 'evidence_withdrawal_confirmation_unknown_field'],
        [{ base_version: 0, reason: '   ' }, 'evidence_withdrawal_reason_required'],
        [{ base_version: -1, reason: 'r' }, 'invalid_evidence_withdrawal_input']]) {
        const refused = await post(`/v1/evidence/${eg}/withdrawal/confirmation`, body);
        assert.deepEqual([refused.status, refused.body.error_code], [422, code], JSON.stringify(body));
      }
      assert.equal((await issueWithdrawal(eg, 0, 'r', 'account-jwt', { confirmation_token: 'x' })).status, 422);
      assert.equal((await issueWithdrawal(eg, 0, 'r', 'account-jwt', { evidence_id: uuid() })).status, 422);
      assert.equal((await request('GET', `/v1/evidence/${eg}/withdrawal`)).status, 405);
      assert.equal((await issueWithdrawal(eg, 1)).body.error_code, 'evidence_withdrawal_version_conflict');
      const foreign = await issueWithdrawal(eg, 0, 'r', 'other-jwt');
      assert.deepEqual([foreign.status, foreign.body.error_code], [422, 'evidence_not_found'],
        'another user\'s Evidence is invisible');
      // Issue and consume in one transaction are refused and burn the token.
      await as(fresh(userId));
      await human.query('begin');
      const sameIssued = (await human.query('select public.clued_evidence_withdrawal_confirmation_issue_v1($1) v',
        [{ evidence_id: eg, base_version: 0, reason: 'r' }])).rows[0].v;
      const sameInput = { ...withdrawInput(sameIssued), evidence_id: eg };
      const sameWithdraw = (await human.query('select public.clued_evidence_withdraw_v1($1,$2) v',
        [sameInput, sha256(JSON.stringify(sameInput))])).rows[0].v;
      await human.query('commit');
      assert.deepEqual([sameWithdraw.status, sameWithdraw.error_code], ['rejected', 'confirmation_token_same_request']);
      assert.equal((await tokenRow(sameIssued.token_id)).consume_outcome, 'rejected');
      // Expired token.
      const expiring = (await issueWithdrawal(eg, 0)).body;
      await admin.query('set session_replication_role=replica');
      await admin.query(`update clued_private.native_confirmation_tokens
        set issued_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '5 minutes' where id=$1`,
      [expiring.token_id]);
      await admin.query('set session_replication_role=origin');
      const expired = await withdraw(eg, withdrawInput(expiring));
      assert.deepEqual([expired.status, expired.body.error_code], [403, 'confirmation_token_expired']);
      // Session, view digest and base version binding; each attempt burns.
      const crossSession = await withdraw(eg, withdrawInput((await issueWithdrawal(eg, 0)).body), 'second-session-jwt');
      assert.deepEqual([crossSession.status, crossSession.body.error_code], [403, 'confirmation_token_binding_mismatch']);
      const digestIssued = (await issueWithdrawal(eg, 0)).body;
      const badDigest = await withdraw(eg, withdrawInput(digestIssued, { view_digest: 'b'.repeat(64) }));
      assert.deepEqual([badDigest.status, badDigest.body.error_code], [403, 'confirmation_token_binding_mismatch']);
      assert.equal((await tokenRow(digestIssued.token_id)).consume_outcome, 'rejected', 'a failed attempt burns the token');
      assert.equal((await withdraw(eg, withdrawInput(digestIssued))).body.error_code, 'confirmation_token_reused');
      const baseIssued = (await issueWithdrawal(eg, 0)).body;
      assert.equal((await withdraw(eg, withdrawInput(baseIssued, { base_version: 1 }))).body.error_code,
        'confirmation_token_binding_mismatch');
      // A live token presented with a malformed request is burned too.
      for (const overrides of [{ surprise: 1 }, { view_digest: 'Z' }, { base_version: 'x' }]) {
        const shapeIssued = (await issueWithdrawal(eg, 0)).body;
        const shapeRefused = await withdraw(eg, withdrawInput(shapeIssued, overrides));
        assert.equal(shapeRefused.body.status, 'rejected', JSON.stringify(overrides));
        assert.equal((await tokenRow(shapeIssued.token_id)).consume_outcome, 'rejected', JSON.stringify(overrides));
        assert.equal((await withdraw(eg, withdrawInput(shapeIssued))).body.error_code, 'confirmation_token_reused');
      }
      const staleWithdraw = await withdraw(eg, withdrawInput((await issueWithdrawal(eg, 0)).body), 'stale-jwt');
      assert.deepEqual([staleWithdraw.status, staleWithdraw.body.error_code], [401, 'reauthentication_required']);
      // Success, replay, key conflict and terminal state.
      const egIssued = (await issueWithdrawal(eg, 0)).body;
      const egInput = withdrawInput(egIssued);
      const egWithdrawn = await withdraw(eg, egInput);
      assert.equal(egWithdrawn.body.status, 'committed', JSON.stringify(egWithdrawn.body));
      assert.deepEqual(egWithdrawn.body.supplemental.flagged_records, []);
      const egReplay = await withdraw(eg, egInput);
      assert.deepEqual([egReplay.status, egReplay.body.replayed, egReplay.body.receipt_id],
        [200, true, egWithdrawn.body.receipt_id]);
      const eh = await nativeEvidence('s5-conflict-evidence');
      const ehIssued = (await issueWithdrawal(eh, 0)).body;
      const conflict = await withdraw(eh, { ...withdrawInput(ehIssued), idempotency_key: egInput.idempotency_key });
      assert.equal(conflict.body.error_code, 'IDEMPOTENCY_KEY_CONFLICT');
      assert.equal((await tokenRow(ehIssued.token_id)).consume_outcome, 'rejected', 'the presented token is burned');
      const again1 = await issueWithdrawal(eg, 1);
      assert.deepEqual([again1.status, again1.body.error_code], [409, 'evidence_already_withdrawn']);
      const again0 = await issueWithdrawal(eg, 0);
      assert.deepEqual([again0.status, again0.body.error_code], [409, 'evidence_withdrawal_version_conflict']);
      // A Binding-ingested Evidence is withdrawn by the owner only.
      const agentEvidence = await call('clued_evidence_ingest', { idempotency_key: key('aev'), evidence_schema_version: 1,
        evidence_type: 'file', storage_ref: 'binding:s5', content_hash: sha256('s5-binding'), mime_type: 'text/plain',
        size_bytes: 10 });
      assert.equal(agentEvidence.status, 'committed', JSON.stringify(agentEvidence));
      const agentIssued = (await issueWithdrawal(agentEvidence.evidence_ids[0], 0)).body;
      assert.equal((await withdraw(agentEvidence.evidence_ids[0], withdrawInput(agentIssued))).body.status, 'committed');
      assert.equal(await count('clued_private.evidence_withdrawals', 'user_id=$1', [userId]), 4);

      // ---- E2E-05 (B05 half): proactive stale on Binding scope reduction.
      const p5a = await project('e2e-05-a');
      const p5b = await project('e2e-05-b');
      const p5c = await project('e2e-05-c');
      const p5aNote = await nativeNote('Scope A note', { scope: p5a });
      await nativeNote('Scope B note', { scope: p5b });
      await nativeNote('Scope C note', { scope: p5c });
      const issuer = hash();
      const resource = 'https://mcp.example.invalid/mcp';
      await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'S5 issuer')",
        [issuer, resource]);
      const scopeEntry = (id) => ({ resource_kind: 'scope', resource_id: id, environment: 'canonical', actions: ['read'] });
      const authorize = async (raw, scopes, client) => {
        await as(fresh(userId));
        const prepared = (await human.query('select public.clued_authorization_prepare_v12($1,$2) v', [issuer, {
          request_digest: hash(), client_id: client, client_name: `S5 ${client}`, redirect_uri: 'https://client.example.invalid/cb',
          resource, requested_scopes: ['context:read'] }])).rows[0].v;
        return (await human.query('select public.clued_authorization_approve_v12($1,$2,$3,$4,$5,$6) v',
          [issuer, prepared.request_id, prepared.version, JSON.stringify(scopes.map(scopeEntry)),
            sha256(raw), new Date(Date.now() + 3600000).toISOString()])).rows[0].v;
      };
      const manage = async (input) => {
        await as(fresh(userId));
        return (await human.query('select public.clued_authorization_manage_v12($1) v', [input])).rows[0].v;
      };
      const removeSource = async (bindingId, removedScope, proveFlatRefusal = false) => {
        const view = async () => (await manage({ op: 'list' })).bindings.find((binding) => binding.binding_id === bindingId);
        const current = await view();
        assert.equal(current.selection_format, 'sources_v1');
        const targets = current.sources.filter((source) => source.kind === 'direct' && source.contributions.length === 1
          && source.contributions[0].resource_kind === 'scope' && source.contributions[0].resource_id === removedScope
          && source.contributions[0].environment === 'canonical');
        assert.equal(targets.length, 1, 'the Native DTO identifies one exact direct consent for the removed scope');
        const [target] = targets;
        if (proveFlatRefusal) {
          const bindingAndAuthorization = async () => (await admin.query(`select to_jsonb(b) binding,to_jsonb(a) authorization
            from public.clued_agent_bindings b join clued_private.authorizations_v12 a on a.binding_id=b.id
            where b.id=$1`, [bindingId])).rows[0];
          const beforeFlat = await bindingAndAuthorization();
          await assert.rejects(manage({ op: 'reduce', binding_id: bindingId, base_version: current.version,
            selected: [scopeEntry(p5a)] }),
          (error) => error.code === '22023' && error.message === 'authorization_source_selection_required_sources_v1');
          assert.deepEqual(await bindingAndAuthorization(), beforeFlat, 'refused flat selection changes no Binding or Authorization body/version');
          assert.deepEqual(await view(), current, 'refused flat selection changes no source, grant or limit DTO');
        }
        const reduced = await manage({ op: 'reduce', binding_id: bindingId, base_version: current.version,
          selection_format: 'sources_v1', sources: [{ source_id: target.source_id, base_version: target.version, action_cap: [] }],
          exceptions: [] });
        assert.equal(reduced.binding_id, bindingId);
        assert.equal(Number(reduced.version), Number(current.version) + 1);
        const after = await view();
        assert.equal(after.selection_format, 'sources_v1');
        assert.deepEqual(after.sources.map((source) => source.source_id).sort(),
          current.sources.filter((source) => source.source_id !== target.source_id).map((source) => source.source_id).sort(),
          'only the submitted source is removed and no replacement consent is invented');
        for (const source of current.sources.filter((source) => source.source_id !== target.source_id)) {
          assert.deepEqual(after.sources.find((kept) => kept.source_id === source.source_id), source,
            'an unsubmitted source retains its complete identity, version and consent DTO');
        }
        const keptScopes = current.grants.filter((grant) => grant.resource_id !== removedScope).map((grant) => grant.resource_id).sort();
        assert.deepEqual(after.grants.map((grant) => grant.resource_id).sort(), keptScopes);
        assert.deepEqual(reduced.selected.map((entry) => entry.resource_id).sort(), keptScopes);
        assert.deepEqual(after.overrides, current.overrides, 'source reduction does not invent precise exceptions');
        return reduced;
      };
      const approved = await authorize(rawAuthorized, [p5a, p5b], 's5-client');
      await accept(policyDoc('e05.check', [p5a, p5b], { allowed_record_types: ['note'] }));
      const e05First = packOk(await call('clued_context_pack', { scope: p5a, task_class: 'e05.check' }, rawAuthorized),
        'E2E-05 before');
      const me = e05First.manifest.id;
      assert.deepEqual((await manifest(me)).effective_scopes, [p5a, p5b].sort());
      const reduced = await removeSource(approved.binding_id, p5b, true);
      const meRow = await manifest(me);
      assert.deepEqual([meRow.stale, meRow.stale_reason, meRow.version], [true, 'binding_scope_reduced', 2],
        'stale immediately, before any recompile or revalidation');
      const e05After = packOk(await call('clued_context_pack', { scope: p5a, task_class: 'e05.check' }, rawAuthorized),
        'E2E-05 after');
      assert.deepEqual([e05After.pack.scopes, e05After.pack.items.map((row) => row.canonical_id)], [[p5a], [p5aNote]]);
      const meRevalidated = await revalidate(me);
      assert.deepEqual([meRevalidated.status, meRevalidated.body.revalidation, meRevalidated.body.reason],
        [409, 'STALE', 'binding_scope_reduced']);
      // op revoke.
      await manage({ op: 'revoke', binding_id: approved.binding_id, base_version: reduced.version });
      assert.deepEqual([(await manifest(e05After.manifest.id)).stale, (await manifest(e05After.manifest.id)).stale_reason],
        [true, 'binding_revoked']);
      // A reduction outside effective_scopes does not stale; the SKIP LOCKED
      // probe; revalidation remains the backstop.
      const approved2 = await authorize(rawAuthorized2, [p5a, p5b, p5c], 's5-client-two');
      const me2 = packOk(await call('clued_context_pack', { scope: p5a, task_class: 'e05.check' }, rawAuthorized2),
        'E2E-05 second').manifest.id;
      const outside = await removeSource(approved2.binding_id, p5c);
      assert.equal((await manifest(me2)).stale, false, 'removing a scope outside effective_scopes does not stale');
      await admin.query('begin');
      await admin.query('select 1 from clued_private.context_pack_manifests where id=$1 for update', [me2]);
      await human.query("set lock_timeout='2s'");
      try {
        const probed = await removeSource(approved2.binding_id, p5b);
        assert.equal(probed.version, outside.version + 1, 'the reduction does not wait on a locked manifest');
      } finally {
        await human.query('reset lock_timeout');
        await admin.query('rollback');
      }
      assert.equal((await manifest(me2)).stale, false, 'a skipped manifest stays live (disclosed residual)');
      const me2Revalidated = await revalidate(me2);
      assert.deepEqual([me2Revalidated.status, me2Revalidated.body.revalidation, me2Revalidated.body.reason],
        [409, 'STALE', 'inputs_changed'], 'revalidation is the backstop');
      // Raw Binding deletion and raw context_keys narrowing (widening does not stale).
      const md = packOk(await call('clued_context_pack', { scope: p5a, task_class: 'e05.check' }, rawDeleted),
        'raw deleted').manifest.id;
      await admin.query('delete from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1($1)', [sha256(rawDeleted)]);
      assert.deepEqual([(await manifest(md)).stale, (await manifest(md)).stale_reason], [true, 'binding_deleted']);
      const mn = packOk(await call('clued_context_pack', { scope: p5a, task_class: 'e05.check' }, rawNarrowed),
        'raw narrowed').manifest.id;
      assert.deepEqual((await manifest(mn)).effective_scopes, [p5a, p5b].sort());
      await admin.query('update public.clued_agent_bindings set context_keys=array[$2] where token_hash=clued_private.credential_verifier_v1($1)',
        [sha256(rawNarrowed), p5a]);
      assert.deepEqual([(await manifest(mn)).stale, (await manifest(mn)).stale_reason], [true, 'binding_scope_reduced']);
      const mn2 = packOk(await call('clued_context_pack', { scope: p5a, task_class: 'e05.check' }, rawNarrowed),
        'raw narrowed again').manifest.id;
      await admin.query("update public.clued_agent_bindings set context_keys=array['*'] where token_hash=clued_private.credential_verifier_v1($1)",
        [sha256(rawNarrowed)]);
      assert.equal((await manifest(mn2)).stale, false, 'widening does not stale');

      // ---- E2E-14: a forged evidence_withdrawn Event changes no state.
      const p14 = await project('e2e-14');
      const e2 = await nativeEvidence('s5-e14-evidence');
      const r2 = await nativeNote('Record citing E2', { scope: p14, sources: [e2] });
      await accept(policyDoc('e14.check', [p14], { allowed_record_types: ['note'] }));
      const e14Before = packOk(await call('clued_context_pack', { scope: p14, task_class: 'e14.check' }), 'E2E-14');
      assert.deepEqual(e14Before.pack.items.map((row) => row.canonical_id), [r2]);
      const stateHash = async () => (await admin.query(`select
          (select md5(coalesce(string_agg(to_jsonb(w)::text,',' order by id),'')) from clued_private.evidence_withdrawals w) withdrawals,
          (select md5(coalesce(string_agg(to_jsonb(s)::text,',' order by record_id,record_version,evidence_id),'')) from clued_private.record_evidence_status s) flags,
          (select md5(coalesce(string_agg(to_jsonb(l)::text,',' order by knowledge_record_id,knowledge_version,source_record_id),'')) from clued_private.knowledge_lineage l) lineage,
          (select md5(coalesce(string_agg(id::text||status||version,',' order by id),'')) from clued_private.information_candidates) info,
          (select md5(coalesce(string_agg(id::text||status||version,',' order by id),'')) from clued_private.knowledge_candidates) know,
          (select md5(coalesce(string_agg(to_jsonb(p)::text,',' order by id),'')) from clued_private.context_policies p) policies,
          (select md5(coalesce(string_agg(id::text||stale::text||version,',' order by id),'')) from clued_private.context_pack_manifests) manifests,
          (select md5(coalesce(string_agg(to_jsonb(t)::text,',' order by id),'')) from clued_private.native_confirmation_tokens t) native_tokens,
          (select md5(coalesce(string_agg(to_jsonb(t)::text,',' order by id),'')) from clued_private.candidate_confirmation_tokens t) candidate_tokens`))
        .rows[0];
      const beforeForged = await stateHash();
      const forged = await call('clued_event_append', { idempotency_key: key('forged'), event_schema_version: 1,
        event_type: 'extension:information_flow:evidence_withdrawn', event_scope: 'global', audit_visibility: 'work_log',
        target_refs: [{ kind: 'system', id: `evidence_withdrawal:${e2}` }],
        change_summary: { evidence_id: e2, record_id: r2 } });
      assert.equal(forged.status, 'committed', JSON.stringify(forged));
      assert.deepEqual(await stateHash(), beforeForged, 'a forged Event is audit data only');
      assert.equal(await unflagged(r2, 1), true);
      const e14After = packOk(await call('clued_context_pack', { scope: p14, task_class: 'e14.check' }), 'E2E-14 after');
      assert.deepEqual([e14After.pack_digest, e14After.manifest.reused], [e14Before.pack_digest, true]);
      assert.equal(await count('clued_private.typed_event_currentness_registry',
        "event_type like 'extension:information\\_flow:%'"), 0);

      // ---- Lock probes.
      // An open shared compile lock makes a withdrawal wait (currentness first).
      const probeEvidence = await nativeEvidence('s5-lock-probe');
      await admin.query('begin');
      await admin.query('select clued_private.context_pack_read_lock_v1($1)', [userId]);
      await as(fresh(userId));
      await human.query("set lock_timeout='1s'");
      try {
        await assert.rejects(human.query('select public.clued_evidence_withdraw_v1($1,$2)', [{ idempotency_key: key('lock'),
          evidence_id: probeEvidence, base_version: 0, confirmation_token: 'x', view_digest: 'a'.repeat(64) }, hash()]),
        /lock timeout/);
      } finally {
        await human.query('reset lock_timeout');
        await admin.query('rollback');
      }
      // The compile path still takes no row locks with the S5 triggers and
      // lineage checks installed.
      const pLock = await project('lock');
      const lockA = await nativeNote('Lock source A', { scope: pLock });
      const lockK = await promoteKnowledge(await proposeAgent(pLock, [{ id: lockA, version: 1 }], 'knowledge.dedup.v1'));
      await accept(policyDoc('lock.check', [pLock], { allowed_record_types: ['note'] }));
      await admin.query('begin');
      await admin.query('select 1 from public.clued_memories where id=$1 for update', [lockA]);
      await admin.query('select 1 from clued_private.knowledge_lineage where knowledge_record_id=$1 for update', [lockK]);
      await workerCaller.query("set lock_timeout='2s'");
      try {
        const locked = await agent(tokenA, 'clued_context_pack', { scope: pLock, task_class: 'lock.check' });
        assert.equal(locked.status, 'ok', JSON.stringify(locked));
        assert.deepEqual(locked.pack.items.map((row) => row.canonical_id).sort(), [lockA, lockK].sort());
      } finally {
        await workerCaller.query('reset lock_timeout');
        await admin.query('rollback');
      }
    } finally {
      globalThis.fetch = previousFetch;
      console.warn = previousWarn;
    }

    // ---- Guard triggers.
    const anyLineage = (await admin.query(`select knowledge_record_id,knowledge_version,source_record_id
      from clued_private.knowledge_lineage where lineage_stale limit 1`)).rows[0];
    const liveLineage = (await admin.query(`select knowledge_record_id,knowledge_version,source_record_id
      from clued_private.knowledge_lineage where not lineage_stale limit 1`)).rows[0];
    const lineageWhere = 'knowledge_record_id=$1 and knowledge_version=$2 and source_record_id=$3';
    await assert.rejects(admin.query(`update clued_private.knowledge_lineage set lineage_stale=false,stale_reason=null,
      stale_at=null,version=version+1 where ${lineageWhere}`, Object.values(anyLineage)), /knowledge_lineage_immutable/,
    'stale never reverts');
    await assert.rejects(admin.query(`update clued_private.knowledge_lineage set source_version=source_version+1
      where ${lineageWhere}`, Object.values(liveLineage)), /knowledge_lineage_immutable/);
    await assert.rejects(admin.query(`update clued_private.knowledge_lineage set lineage_stale=true,
      stale_reason='source_updated',stale_at=now() where ${lineageWhere}`, Object.values(liveLineage)),
    /knowledge_lineage_immutable/, 'marking stale bumps the row version');
    await assert.rejects(admin.query("update clued_private.evidence_withdrawals set reason='changed'"),
      /invalidation_row_immutable/);
    await assert.rejects(admin.query("update clued_private.record_evidence_status set flagged_by='withdrawal'"),
      /invalidation_row_immutable/);
    // Reapply the actual formal closeout after all fixture scenarios; no skip.
    const closeoutMigration = await findGatewayCloseoutMigration(root);
    const closeoutBefore = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
