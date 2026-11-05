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
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import { serialize } from '../../../scripts/phase2-qualification/minimum-context-compiler/compiler.mjs';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Information Flow M0-D slice S4 (contract M0DCloseout.v0.1 sections 6.1-6.3,
// 7, 8 gates M0D-B01 and M0D-B04): Context Policy acceptance, the service
// Compiler and MSCP manifests, on the full migration chain, driven through
// the local Worker transport with an account session and Agent Bindings.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S4_MIGRATION = '20260924200000_information_flow_context_policy.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const stale = (sub, session = 'sess-main') =>
  ({ ...fresh(sub, session), amr: [{ method: 'password', timestamp: nowEpoch() - 16 * 60 }] });
const TOKENIZER = { package: 'js-tiktoken', version: '1.0.21', encoding: 'o200k_base', model_mapping: 'gpt-4.1-2025-04-14' };
const S2_OBJECT = { status: 'rejected', error_code: 'CONTEXT_POLICY_REQUIRED', authoritative: false,
  execution_authorization: 'NOT_GRANTED', model_extraction: 'NOT_EVALUATED' };
const encoder = new Tiktoken(o200kBase);
const countTokens = (text) => encoder.encode(text, [], []).length;
let keyCounter = 0;
// Short, patterned synthetic idempotency keys.
const key = (label) => `if-s4-${label}-${String(++keyCounter).padStart(4, '0')}`;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const TEXT = 'Qingshi risk list confirmed by the owner.';
const segment = (segmentId) => ({
  schema_version: 'segment_input.v1', segment_id: segmentId,
  reference_time: '2026-09-24T10:00:00+08:00', timezone: 'Asia/Shanghai',
  messages: [{ message_id: 'msg_s4_a', evidence_id: 'ev_s4_a', author_role: 'user',
    created_at: '2026-09-24T09:58:00+08:00', context_only: false, content: TEXT }],
});
const item = (local, itemType) => ({
  candidate_local_id: `item_${local}`, item_type: itemType,
  claim: `${itemType} claim ${local}: ${TEXT}`.slice(0, 300), summary: `${itemType} summary ${local}`.slice(0, 120),
  action_level: 'reference', priority: null,
  entity_mentions: [{ type: 'project', mention: 'Qingshi', role: 'subject' }], topics: ['risk'],
  temporal_mentions: [], source_anchors: [{ message_id: 'msg_s4_a', exact_quote: 'risk list confirmed' }],
  confidence: 0.9, uncertainties: [], sensitivity_hint: 'none',
});
const documentOf = (segmentId, items) => ({ schema_version: 'candidate_information.v1', segment_id: segmentId, items });
const policyDoc = (taskClass, scopes, overrides = {}) => ({
  schema: 'clued.context-policy.v1', task_class: taskClass, allowed_scopes: scopes,
  allowed_record_types: ['decision', 'note', 'profile_fact', 'state', 'task'], require_evidence: false,
  fields: { required: ['title'], optional: ['content', 'rationale'] }, max_items: 50, token_budget: 32768,
  tokenizer: TOKENIZER, freshness: { mode: 'current' }, ...overrides,
});

test('Information Flow S4: Context Policy, service Compiler and MSCP manifests', { timeout: 900000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-if-s4-'));
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
    // Later migrations sort after S4 and are applied in the same chain. Pin
    // the exact neighbours so a reordering or collision fails loudly; later
    // slices (S6+) may append after these without breaking the check.
    const s4Index = migrations.indexOf(S4_MIGRATION);
    assert.equal(migrations[s4Index - 1], '20260924190000_information_flow_promotion.sql',
      'the S4 migration directly follows S3');
    assert.deepEqual(migrations.slice(s4Index + 1, s4Index + 3), ['20260924210000_bug_20260924_001_capture_unknown.sql',
      '20260924220000_information_flow_invalidation.sql'], 'the migrations right after S4 are #312 and S5');
    const versions = migrations.map((name) => name.split('_')[0]);
    assert.equal(new Set(versions).size, versions.length, 'migration versions are unique');
    for (const name of migrations) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'if-s4@example.invalid',now()),($2,'if-s4-other@example.invalid',now())`, [userId, otherUser]);
    const tokenA = hash();
    const tokenDoomed = hash();
    const tokenWriteOnly = hash();
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values
      ($1,'synthetic','Agent A',$2,array['context:read','context:write'],array['*']),
      ($1,'synthetic','Doomed agent',$3,array['context:read','context:write'],array['*']),
      ($1,'synthetic','Write-only agent',$4,array['context:write'],array['*'])`,
    [userId, tokenA, tokenDoomed, tokenWriteOnly]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const as = async (claims) => human.query(
      "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [claims.sub ?? '', JSON.stringify(claims)]);
    const agent = async (token, name, input) =>
      await workerGatewayRpc(workerCaller, name, token, input);
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
    const confirmed = async (id, version) => (await admin.query(
      'select clued_private.record_human_confirmed_v1($1,$2,$3) v', [userId, id, version])).rows[0].v;
    const writer = async (id, version) => (await admin.query(
      'select clued_private.record_writer_principal_v1($1,$2,$3) v', [userId, id, version])).rows[0].v;
    const manifest = async (id) => (await admin.query(
      'select * from clued_private.context_pack_manifests where id=$1', [id])).rows[0];
    const noteInput = (id, title, { scope = 'global', content = title, authority = 'user_explicit', sources = [],
      extra = {} } = {}) => ({
      operation: 'create', id, record_type: 'note', record_schema_version: 1, lifecycle_status: 'active', scope,
      idempotency_key: key('note'), authority, user_confirmed: true, confidence: 1, confidence_reason: 'S4 fixture',
      source_refs: sources, source_unavailable_reason: sources.length ? null : 'Synthetic fixture',
      mutation: { title, content, type_fields: { note_kind: 'general' }, relations: {} }, ...extra,
    });

    // ---- M0D-B01: the three new tables are private; helpers are not
    // executable by any role; entries carry exactly the planned grants.
    for (const table of ['native_confirmation_tokens', 'context_policies', 'context_pack_manifests']) {
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
    const privateFns = ['context_policy_guard_v1()', 'context_pack_manifest_guard_v1()',
      'context_canonical_json_v1(jsonb)', 'context_sha256_text_v1(text)', 'context_digest_v1(jsonb)',
      'context_policy_tokenizer_v1()', 'context_policy_uint_v1(jsonb,integer,integer)',
      'context_policy_set_v1(jsonb,text[],boolean)', 'context_scope_resolve_v1(uuid,text)',
      'context_policy_normalize_v1(uuid,jsonb)', 'context_policy_usable_v1(uuid,uuid)',
      'record_writer_principal_v1(uuid,uuid,bigint)', 'context_pack_read_lock_v1(uuid)',
      'context_candidate_record_type_v1(text)', 'context_evidence_v1(uuid,uuid[])',
      'context_knowledge_lineage_v1(uuid,jsonb)',
      'context_pack_rejection_v1(text,text)', 'context_pack_compile_v1(uuid,uuid,uuid,jsonb,text[])',
      'context_pack_core_v1(uuid,uuid,jsonb)', 'context_policy_view_v1(uuid,jsonb)',
      'context_policy_lineage_lock_v1(uuid,text)', 'context_policy_confirmation_issue_core_v1(uuid,jsonb)',
      'context_policy_accept_core_v1(uuid,jsonb,text)'];
    const newPrivate = (await admin.query(`select p.oid::regprocedure::text sig from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_private'
        and (p.proname like 'context\\_%' or p.proname='record_writer_principal_v1')`)).rows.map((row) => row.sig);
    assert.deepEqual(newPrivate.map((sig) => sig.replace(/^clued_private\./, '')).sort(), [...privateFns].sort(),
      'every new private function is listed');
    for (const fn of privateFns) {
      const grants = (await admin.query(`select has_function_privilege('anon',$1::regprocedure,'execute') anon,
        has_function_privilege('authenticated',$1::regprocedure,'execute') authenticated,
        has_function_privilege('service_role',$1::regprocedure,'execute') service_role`,
      [`clued_private.${fn}`])).rows[0];
      assert.deepEqual(grants, { anon: false, authenticated: false, service_role: false }, fn);
    }
    const entryGrants = async (sig) => (await admin.query(`select has_function_privilege('anon',$1::regprocedure,'execute') anon,
      has_function_privilege('authenticated',$1::regprocedure,'execute') authenticated,
      has_function_privilege('service_role',$1::regprocedure,'execute') service_role,
      (select prosecdef from pg_proc where oid=$1::regprocedure) definer,
      (select proconfig from pg_proc where oid=$1::regprocedure) config`, [sig])).rows[0];
    for (const [sig, expected] of [
      ['public.clued_context_policy_confirmation_issue_v1(jsonb)', [false, true, false]],
      ['public.clued_context_policy_accept_v1(jsonb,text)', [false, true, false]],
      ['public.clued_context_pack(text,jsonb)', [false, false, false]],
      ['public.clued_user_context_pack(jsonb)', [false, true, false]]]) {
      const grants = await entryGrants(sig);
      assert.deepEqual([grants.anon, grants.authenticated, grants.service_role, grants.definer], [...expected, true], sig);
      assert.deepEqual(grants.config, ['search_path=""'], sig);
      assert.equal((await admin.query("select has_function_privilege('clued_worker_gateway',$1::regprocedure,'execute') gateway",[sig])).rows[0].gateway, sig === 'public.clued_context_pack(text,jsonb)');
    }
    assert.deepEqual((await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'clued\\_context\\_polic%' order by 1`)).rows.map((row) => row.proname),
    ['clued_context_policy_accept_v1', 'clued_context_policy_confirmation_issue_v1']);
    const oauthBody = (await admin.query(
      "select pg_get_functiondef('public.clued_oauth_call(text,jsonb)'::regprocedure) d")).rows[0].d;
    assert.ok(!/context_policy/.test(oauthBody), 'no delegated OAuth case reaches policy acceptance');

    // ---- Worker transport. Only the PostgREST hop is shimmed.
    const worker = await loadContinuityWorker();
    const gatewayToken = 'synthetic-information-flow-context-worker-gateway';
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await gateway.query('set session authorization authenticator; set role clued_worker_gateway');
    await gateway.query(`select set_config('request.jwt.claims','{"role":"clued_worker_gateway"}',false)`);
    const workerEnv = { PROJECT_VIEWS_V2: 'true', SUPABASE_URL: 'https://storage.clued.test',
      CLUED_DB_GATEWAY_TOKEN: gatewayToken,
      ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
    const rawBinding = `clued_bnd_${'s'.repeat(43)}`;
    const rawBindingB = `clued_bnd_${'b'.repeat(43)}`;
    const rawScoped = `clued_bnd_${'c'.repeat(43)}`;
    const rawNoRead = `clued_bnd_${'w'.repeat(43)}`;
    const rawAuthorized = `clued_bnd_${'v'.repeat(43)}`;
    const workerBindingId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Worker agent',$2,array['context:read','context:write'],array['*']) returning id`,
    [userId, sha256(rawBinding)])).rows[0].id;
    await admin.query(`insert into public.clued_agent_bindings (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Worker agent B',$2,array['context:read','context:write'],array['*']),
            ($1,'synthetic','Write-only worker agent',$3,array['context:write'],array['*'])`,
    [userId, sha256(rawBindingB), sha256(rawNoRead)]);
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
    const post = async (pathname, body, token = 'account-jwt') => {
      const response = await worker.fetch(new Request(`https://clued.test${pathname}`, {
        method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json' },
        body: JSON.stringify(body) }), workerEnv, ctx);
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const mcp = async (method, params, token = rawBinding) => {
      const response = await worker.fetch(new Request('https://clued.test/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }), workerEnv, ctx);
      return await response.json();
    };
    const call = async (name, args, token = rawBinding) => {
      const envelope = await mcp('tools/call', { name, arguments: args }, token);
      return envelope.result?.structuredContent ?? envelope.error ?? envelope;
    };
    const assertMcpPolicyRefusal = async (args, reason) => {
      const envelope = await mcp('tools/call', { name: 'clued_context_pack', arguments: args });
      assert.equal(envelope.result.isError, true);
      assert.deepEqual(envelope.result.structuredContent, { ...S2_OBJECT,
        ...(reason === undefined ? {} : { reason }),
        error: { code: 'CONTEXT_POLICY_REQUIRED', category: 'canonical_result', status: 'rejected' } }, reason);
      assert.deepEqual(JSON.parse(envelope.result.content[0].text), envelope.result.structuredContent);
    };
    const project = async (name) => {
      const id = uuid();
      const created = await agent(tokenA, 'clued_project_mutate_v2', { operation: 'create', canonical_project_id: id,
        project_schema_version: 2, base_version: null, idempotency_key: key('proj'), mutation: { name: `S4 ${name}`,
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
    const issuePolicy = async (doc, base, token = 'account-jwt', rationale = 'Owner accepts this policy') =>
      post('/v1/context/policies/confirmation', { policy: doc, rationale, base_policy_version: base }, token);
    const acceptInput = (issued, overrides = {}) => ({ idempotency_key: key('acc'), task_class: issued.task_class,
      base_policy_version: issued.base_policy_version, confirmation_token: issued.confirmation_token,
      view_digest: issued.view_digest, ...overrides });
    const accept = async (doc, base, token = 'account-jwt') => {
      const issued = await issuePolicy(doc, base, token);
      assert.equal(issued.status, 200, JSON.stringify(issued.body));
      assert.equal(issued.body.status, 'issued');
      const accepted = await post('/v1/context/policies', acceptInput(issued.body), token);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(accepted.body.status, 'committed');
      assert.equal(accepted.body.supplemental.outcome, 'accepted');
      return { issued: issued.body, accepted: accepted.body, policyId: accepted.body.supplemental.policy_id };
    };
    const packOk = (result, label) => {
      assert.equal(result.status, 'ok', `${label}: ${JSON.stringify(result)}`);
      assert.equal(sha256(result.pack_text), result.pack_digest, `${label}: digest binds pack_text`);
      assert.equal(serialize(JSON.parse(result.pack_text)), result.pack_text,
        `${label}: byte-compatible with minimum-context-compiler serialize()`);
      assert.deepEqual(JSON.parse(result.pack_text), result.pack);
      return result;
    };

    try {
      // ---- Raw and REST S2 responses stay byte-identical; MCP also carries
      // the canonical code through connector error normalization.
      for (const result of [await agent(tokenA, 'clued_context_pack', { scope: 'global' }),
        await nativeOne('clued_user_context_pack', { scope: 'global' })]) {
        assert.deepEqual(result, S2_OBJECT);
      }
      await assertMcpPolicyRefusal({ scope: 'global' });
      await assertMcpPolicyRefusal({ scope: 'global', task_class: 'no.policy.yet' });
      const restNoPolicy = await post('/v1/context/pack', { scope: 'global' });
      assert.deepEqual([restNoPolicy.status, restNoPolicy.body], [422, S2_OBJECT]);
      assert.equal(await count('clued_private.context_pack_manifests'), 0, 'a refused compile stores no manifest');
      await assert.rejects(agent(tokenWriteOnly, 'clued_context_pack', { scope: 'global' }), /binding_not_authorized/,
        'a Binding without context:read is denied by resolve_binding');
      const noReadMcp = await call('clued_context_pack', { scope: 'global' }, rawNoRead);
      assert.notEqual(noReadMcp.status, 'ok');
      // This raw fixture has no v12 authorization lifecycle. Status lookup
      // must refuse it without suggesting permissions for an unknown grant.
      assert.deepEqual(noReadMcp, {
        code: -32000,
        message: 'authorization_revoked_or_expired',
        data: { code: '42501' },
      });

      // ---- Policy validation at issue (22023 codes, no token row).
      const issue = async (input, claims = fresh(userId)) =>
        nativeOne('clued_context_policy_confirmation_issue_v1', input, claims);
      const tokensBefore = await count('clued_private.native_confirmation_tokens');
      const base = policyDoc('tc.validate', ['global']);
      const invalid = [
        [{ ...base, surprise: 1 }, 'context_policy_unknown_field'],
        [{ ...base, schema: 'clued.context-policy.v2' }, 'context_policy_schema_invalid'],
        [{ ...base, task_class: 'Bad Class' }, 'context_policy_task_class_invalid'],
        [{ ...base, allowed_scopes: [] }, 'context_policy_scopes_invalid'],
        [{ ...base, allowed_scopes: ['global', 'global'] }, 'context_policy_scopes_invalid'],
        [{ ...base, allowed_scopes: ['team'] }, 'context_policy_scope_invalid'],
        [{ ...base, allowed_scopes: [`project:${uuid()}`] }, 'project_not_found'],
        [{ ...base, allowed_record_types: ['memo'] }, 'context_policy_record_types_invalid'],
        [{ ...base, allowed_record_types: [] }, 'context_policy_record_types_invalid'],
        [{ ...base, allowed_record_types: ['note', 'note'] }, 'context_policy_record_types_invalid'],
        [{ ...base, allowed_tiers: ['authority'] }, 'context_policy_tiers_invalid'],
        [{ ...base, allow_agent_authored: 'yes' }, 'context_policy_allow_agent_authored_invalid'],
        [{ ...base, require_evidence: undefined }, 'context_policy_require_evidence_invalid'],
        [{ ...base, fields: { required: [] } }, 'context_policy_fields_invalid'],
        [{ ...base, fields: { required: ['summary'] } }, 'context_policy_fields_invalid'],
        [{ ...base, fields: { required: ['title'], optional: ['title'] } }, 'context_policy_fields_invalid'],
        [{ ...base, fields: { required: ['title'], extra: [] } }, 'context_policy_fields_invalid'],
        [{ ...base, verbatim_constraints: [{ record_id: uuid(), field: 'closure_summary', exact_text: 'x' }] },
          'context_policy_constraint_field_not_selected'],
        [{ ...base, verbatim_constraints: [{ record_id: uuid(), field: 'title' }] }, 'context_policy_constraints_invalid'],
        [{ ...base, max_items: 0 }, 'context_policy_max_items_invalid'],
        [{ ...base, max_items: 201 }, 'context_policy_max_items_invalid'],
        [{ ...base, token_budget: 0 }, 'context_policy_token_budget_invalid'],
        [{ ...base, token_budget: 32769 }, 'context_policy_token_budget_invalid'],
        [{ ...base, token_budget: 1.5 }, 'context_policy_token_budget_invalid'],
        [{ ...base, tokenizer: { ...TOKENIZER, encoding: 'cl100k_base' } }, 'context_policy_tokenizer_unsupported'],
        [{ ...base, tokenizer: { ...TOKENIZER, status: 'accepted' } }, 'context_policy_tokenizer_unsupported'],
        [{ ...base, freshness: { mode: 'degraded' } }, 'context_policy_freshness_reason_required'],
        [{ ...base, freshness: { mode: 'historical', reason: '   ' } }, 'context_policy_freshness_reason_required'],
        [{ ...base, freshness: { mode: 'current', reason: 'why' } }, 'context_policy_freshness_invalid'],
        [{ ...base, freshness: { mode: 'live' } }, 'context_policy_freshness_invalid'],
      ];
      for (const [doc, code] of invalid) {
        const refused = await issue({ policy: doc, rationale: 'r', base_policy_version: 0 });
        assert.deepEqual([refused.status, refused.error_code], ['rejected', code], JSON.stringify(doc));
      }
      for (const [input, code] of [[{ policy: base, rationale: '  ', base_policy_version: 0 }, 'context_policy_rationale_required'],
        [{ policy: base, rationale: 'r', base_policy_version: -1 }, 'invalid_base_policy_version'],
        [{ policy: base, rationale: 'r', base_policy_version: 0, confirmation_token: 'x' },
          'context_policy_confirmation_unknown_field']]) {
        assert.equal((await issue(input)).error_code, code);
      }
      assert.equal(await count('clued_private.native_confirmation_tokens'), tokensBefore, 'no token for invalid input');
      // Normalization, defaults and a digest that is stable under key order.
      const normA = await issue({ policy: { ...base, fields: { optional: ['rationale', 'content'], required: ['title'] } },
        rationale: 'r', base_policy_version: 0 });
      const normB = await issue({ policy: Object.fromEntries(Object.entries(base).reverse()), rationale: 'r',
        base_policy_version: 0 });
      assert.equal(normA.status, 'issued', JSON.stringify(normA));
      assert.equal(normA.policy_digest, normB.policy_digest, 'the digest is independent of key order');
      assert.deepEqual(normA.confirmation_view.policy, { schema: 'clued.context-policy.v1', task_class: 'tc.validate',
        allowed_scopes: ['global'], allowed_record_types: ['decision', 'note', 'profile_fact', 'state', 'task'],
        allowed_tiers: ['authority_information', 'authority_knowledge'], allow_agent_authored: false,
        require_evidence: false, fields: { required: ['title'], optional: ['content', 'rationale'] },
        verbatim_constraints: [], max_items: 50, token_budget: 32768, tokenizer: TOKENIZER,
        freshness: { mode: 'current', reason: null } });
      assert.equal(normA.policy_digest, sha256(serialize(normA.confirmation_view.policy)),
        'policy_digest = sha256(serialize(normalized policy))');
      assert.equal(normA.decision_operation, 'create');
      assert.match(normA.confirmation_token, /^clued_cpt_[0-9a-f]{64}$/);
      assert.ok((await admin.query('select revoked_at from clued_private.native_confirmation_tokens where id=$1',
        [normA.token_id])).rows[0].revoked_at instanceof Date, 'issuing revokes the previous live token');

      // ---- Acceptance guard (two-step, Native only).
      const guardDoc = policyDoc('tc.guard', ['global']);
      const staleIssue = await issuePolicy(guardDoc, 0, 'stale-jwt');
      assert.equal(staleIssue.status, 401);
      assert.equal(staleIssue.body.error_code, 'reauthentication_required');
      assert.match(staleIssue.headers.get('www-authenticate'), /insufficient_user_authentication.*max_age="900"/);
      for (const [pathname, route] of [['/v1/context/policies/confirmation', 'policy_confirmation'],
        ['/v1/context/policies', 'policy_accept']]) {
        for (const token of [rawBinding, null]) {
          const rpcsBefore = rpcLog.length;
          const warningsBefore = warnings.length;
          const refused = await post(pathname, { policy: guardDoc, rationale: 'r', base_policy_version: 0 }, token);
          assert.equal(refused.status, 401, pathname);
          assert.equal(rpcLog.length, rpcsBefore, 'no RPC ran');
          assert.equal(warnings.length, warningsBefore + 1);
          assert.deepEqual(JSON.parse(warnings.at(-1)), { event: 'information_flow_native_route_denied', route,
            reason: 'binding_or_missing_token' });
        }
      }
      assert.equal((await post('/v1/context/policies/confirmation', { policy: guardDoc, rationale: 'r',
        base_policy_version: 0, confirmation_token: 'x' })).status, 422, 'issue and accept are separate requests');
      assert.equal((await issuePolicy(guardDoc, 0, 'delegated-jwt')).status, 403, 'a delegated OAuth session is refused');
      const receiptsBefore = await count('public.clued_audit_receipts');
      for (const [name, args] of [['clued_context_policy_accept_v1', [{ idempotency_key: 'if-s4-direct-0001',
        task_class: 'tc.guard', base_policy_version: 0 }, hash()]],
      ['clued_context_policy_confirmation_issue_v1', [{ policy: guardDoc, rationale: 'r', base_policy_version: 0 }]]]) {
        await assert.rejects(anon.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args),
          (error) => error.code === '42501' && /permission denied/.test(error.message), name);
      }
      assert.equal(await count('public.clued_audit_receipts'), receiptsBefore, 'no Receipt for a direct anon call');
      assert.equal((await issuePolicy(guardDoc, 1)).body.error_code, 'context_policy_version_conflict');
      assert.equal((await issuePolicy(guardDoc, 1)).status, 409);
      // Issue and consume in one transaction are refused and burn the token.
      await as(fresh(userId));
      await human.query('begin');
      const sameIssued = (await human.query('select public.clued_context_policy_confirmation_issue_v1($1) v',
        [{ policy: guardDoc, rationale: 'r', base_policy_version: 0 }])).rows[0].v;
      const sameInput = acceptInput(sameIssued);
      const sameAccept = (await human.query('select public.clued_context_policy_accept_v1($1,$2) v',
        [sameInput, sha256(JSON.stringify(sameInput))])).rows[0].v;
      await human.query('commit');
      assert.deepEqual([sameAccept.status, sameAccept.error_code], ['rejected', 'confirmation_token_same_request']);
      const tokenRow = async (id) => (await admin.query('select * from clued_private.native_confirmation_tokens where id=$1',
        [id])).rows[0];
      assert.equal((await tokenRow(sameIssued.token_id)).consume_outcome, 'rejected');
      // Expired token.
      const expiring = (await issuePolicy(guardDoc, 0)).body;
      await admin.query('set session_replication_role=replica');
      await admin.query(`update clued_private.native_confirmation_tokens
        set issued_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '5 minutes' where id=$1`,
      [expiring.token_id]);
      await admin.query('set session_replication_role=origin');
      const expired = await post('/v1/context/policies', acceptInput(expiring));
      assert.deepEqual([expired.status, expired.body.error_code], [403, 'confirmation_token_expired']);
      assert.ok(expired.body.receipt_id);
      // Session binding, view digest and lineage version binding.
      const crossSession = await post('/v1/context/policies', acceptInput((await issuePolicy(guardDoc, 0)).body),
        'second-session-jwt');
      assert.deepEqual([crossSession.status, crossSession.body.error_code], [403, 'confirmation_token_binding_mismatch']);
      const digestIssued = (await issuePolicy(guardDoc, 0)).body;
      const badDigest = await post('/v1/context/policies', acceptInput(digestIssued, { view_digest: 'b'.repeat(64) }));
      assert.deepEqual([badDigest.status, badDigest.body.error_code], [403, 'confirmation_token_binding_mismatch']);
      assert.equal((await tokenRow(digestIssued.token_id)).consume_outcome, 'rejected', 'a failed attempt burns the token');
      assert.equal((await post('/v1/context/policies', acceptInput(digestIssued))).body.error_code,
        'confirmation_token_reused');
      // A live token presented with a malformed request is burned too.
      for (const overrides of [{ surprise: 1 }, { view_digest: 'Z' }, { task_class: 'Bad Class' }]) {
        const shapeIssued = (await issuePolicy(guardDoc, 0)).body;
        const shapeRefused = await post('/v1/context/policies', acceptInput(shapeIssued, overrides));
        assert.equal(shapeRefused.body.status, 'rejected', JSON.stringify(overrides));
        assert.equal((await tokenRow(shapeIssued.token_id)).consume_outcome, 'rejected', JSON.stringify(overrides));
        assert.equal((await post('/v1/context/policies', acceptInput(shapeIssued))).body.error_code,
          'confirmation_token_reused');
      }
      const staleAccept = await post('/v1/context/policies', acceptInput((await issuePolicy(guardDoc, 0)).body), 'stale-jwt');
      assert.deepEqual([staleAccept.status, staleAccept.body.error_code], [401, 'reauthentication_required']);
      // A foreign user's token is invisible.
      const foreignIssued = (await issuePolicy(guardDoc, 0, 'other-jwt')).body;
      assert.equal(foreignIssued.status, 'issued');
      const foreign = await post('/v1/context/policies', acceptInput(foreignIssued));
      assert.deepEqual([foreign.status, foreign.body.error_code], [403, 'confirmation_token_invalid']);
      assert.equal((await tokenRow(foreignIssued.token_id)).consumed_at, null, 'a foreign token is not touched');
      assert.equal(await count('clued_private.context_policies'), 0, 'no refused attempt stored a policy');
      // Success.
      const guardIssued = (await issuePolicy(guardDoc, 0)).body;
      const guardInput = acceptInput(guardIssued);
      const guardAccepted = await post('/v1/context/policies', guardInput);
      assert.equal(guardAccepted.status, 200, JSON.stringify(guardAccepted.body));
      const guardOut = guardAccepted.body.supplemental;
      assert.deepEqual([guardOut.outcome, guardOut.task_class, guardOut.policy_version, guardOut.policy_digest,
        guardOut.decision_record_id, guardOut.decision_version],
      ['accepted', 'tc.guard', 1, guardIssued.policy_digest, guardIssued.decision_record_id, 1]);
      const acceptanceReceipt = (await admin.query('select * from public.clued_audit_receipts where id=$1',
        [guardAccepted.body.receipt_id])).rows[0];
      assert.deepEqual([acceptanceReceipt.operation_family, acceptanceReceipt.status, acceptanceReceipt.binding_id],
        ['context_policy_accept', 'committed', null]);
      assert.deepEqual(acceptanceReceipt.base_versions, { 'context_policy:tc.guard': 0 });
      assert.deepEqual(acceptanceReceipt.committed_versions, { 'context_policy:tc.guard': 1 });
      const decision = (await admin.query('select * from public.clued_memories where id=$1',
        [guardOut.decision_record_id])).rows[0];
      assert.deepEqual([decision.record_type, decision.version, decision.authority, decision.canonical_scope,
        decision.lifecycle_status, decision.receipt_id],
      ['decision', '1', 'user_explicit', 'global', 'active', guardOut.decision_receipt_id]);
      assert.deepEqual(decision.type_fields, { rationale: 'Owner accepts this policy', context_policy: {
        schema: 'clued.context-policy.v1', task_class: 'tc.guard', policy_version: 1, policy_digest: guardOut.policy_digest } });
      assert.equal(decision.content, serialize(guardIssued.confirmation_view.policy), 'the Decision carries the policy text');
      const decisionReceipt = (await admin.query('select * from public.clued_audit_receipts where id=$1',
        [decision.receipt_id])).rows[0];
      assert.deepEqual([decisionReceipt.operation_family, decisionReceipt.binding_id], ['record_mutation', null]);
      assert.equal(await confirmed(decision.id, 1), true, 'the approving Decision is human_confirmed');
      assert.equal((await admin.query('select entry from clued_private.native_write_markers where receipt_id=$1',
        [decision.receipt_id])).rows[0].entry, 'context_policy_accept');
      const policyRow = (await admin.query('select * from clued_private.context_policies where id=$1',
        [guardOut.policy_id])).rows[0];
      assert.deepEqual([policyRow.status, policyRow.policy_version, policyRow.decision_receipt_id, policyRow.acceptance_receipt_id,
        policyRow.token_id, policyRow.accepted_session_id, policyRow.policy_digest],
      ['active', 1, decision.receipt_id, guardAccepted.body.receipt_id, guardIssued.token_id, 'sess-main',
        guardIssued.policy_digest]);
      assert.deepEqual(policyRow.policy, guardIssued.confirmation_view.policy);
      assert.deepEqual([(await tokenRow(guardIssued.token_id)).consume_outcome,
        (await tokenRow(guardIssued.token_id)).consumed_receipt_id], ['committed', guardAccepted.body.receipt_id]);
      const acceptEvent = (await admin.query('select * from public.clued_context_events where id=$1::bigint',
        [guardAccepted.body.event_ids[0]])).rows[0];
      assert.deepEqual([acceptEvent.canonical_event_type, acceptEvent.audit_visibility, acceptEvent.event_scope],
        ['extension:information_flow:context_policy_accepted', 'audit_only', 'global']);
      assert.ok(acceptEvent.target_refs.every((ref) => ref.kind === 'system'));
      assert.ok(!JSON.stringify(acceptEvent).includes(guardIssued.confirmation_token), 'the token never reaches an Event');
      assert.equal(await count('clued_private.event_truth_carriers', 'event_id=$1', [acceptEvent.id]), 0);
      assert.equal(await count('clued_private.typed_event_currentness_registry',
        "event_type like 'extension:information_flow:%'"), 0);
      const guardReplay = await post('/v1/context/policies', guardInput);
      assert.deepEqual([guardReplay.status, guardReplay.body.replayed, guardReplay.body.receipt_id],
        [200, true, guardAccepted.body.receipt_id]);
      const guardKeyConflict = await post('/v1/context/policies', { ...guardInput, view_digest: 'c'.repeat(64) });
      assert.equal(guardKeyConflict.body.error_code, 'IDEMPOTENCY_KEY_CONFLICT');
      assert.equal((await issuePolicy(guardDoc, 0)).status, 409, 'lineage CAS: base 0 is no longer current');
      // A Binding-written Decision carrying type_fields.context_policy creates no policy row.
      const forgedDecision = await call('clued_record_mutate', { operation: 'create', id: uuid(), record_type: 'decision',
        record_schema_version: 1, lifecycle_status: 'active', scope: 'global', idempotency_key: key('forge'),
        authority: 'user_explicit', user_confirmed: true, confidence: 1, confidence_reason: 'S4 forged',
        source_refs: [], source_unavailable_reason: 'Synthetic fixture', mutation: { title: 'Forged policy',
          content: 'x', type_fields: { rationale: 'x', context_policy: { schema: 'clued.context-policy.v1',
            task_class: 'tc.forged', policy_version: 1, policy_digest: 'd'.repeat(64) } }, relations: {} } });
      assert.equal(forgedDecision.status, 'committed', JSON.stringify(forgedDecision));
      assert.equal(await count('clued_private.context_policies'), 1);
      await assertMcpPolicyRefusal({ scope: 'global', task_class: 'tc.forged' });

      // ---- E2E-01: Native capture -> Candidate -> token -> Authority
      // Information -> policy -> MSCP consumed by the third-party Agent.
      const p1 = await project('e2e-01');
      const e01Segment = segment('seg_s4_e01');
      const e01 = await post('/v1/intake', { idempotency_key: key('e01'), scope: p1, segment: e01Segment,
        candidates: documentOf('seg_s4_e01', [item('e01', 'fact')]) });
      assert.equal(e01.status, 200, JSON.stringify(e01.body));
      const e01Candidate = e01.body.supplemental.candidates[0].id;
      const e01View = (await post(`/v1/intake/${e01Candidate}/confirmation`, { base_version: 1, authority: 'observed' })).body;
      assert.equal(e01View.status, 'issued', JSON.stringify(e01View));
      const e01Promote = await post(`/v1/intake/${e01Candidate}/promote`, { idempotency_key: key('e01p'), base_version: 1,
        confirmation_token: e01View.confirmation_token, view_digest: e01View.view_digest });
      assert.equal(e01Promote.body.supplemental?.outcome, 'promoted', JSON.stringify(e01Promote.body));
      const e01Record = e01View.record_id;
      const e01Evidence = (await admin.query(`select e.id,e.content_hash,e.size_bytes,s.segment_sha256 from public.clued_evidence e
        join clued_private.information_intake_submissions s on s.evidence_id=e.id where s.id=$1`,
      [e01.body.supplemental.submission_id])).rows[0];
      assert.equal(e01Evidence.content_hash, e01Evidence.segment_sha256, 'server-computed segment hash');
      const e01Policy = await accept(policyDoc('e2e.01', [p1], { require_evidence: true,
        fields: { required: ['title', 'content'], optional: [] } }), 0);
      const e01Pack = packOk(await call('clued_context_pack', { scope: p1, task_class: 'e2e.01' }), 'E2E-01');
      assert.equal(e01Pack.pack.items.length, 1);
      const e01Item = e01Pack.pack.items[0];
      const e01Row = (await admin.query('select * from public.clued_memories where id=$1', [e01Record])).rows[0];
      assert.deepEqual(e01Item, {
        canonical_id: e01Record, version: 1, scope: p1, record_type: 'note', tier: 'authority_information', labels: [],
        writer_principal: 'native_account_session', writer_receipt_id: e01Row.receipt_id, human_confirmed: true,
        evidence: [{ evidence_id: e01Evidence.id, content_hash: e01Evidence.content_hash,
          size_bytes: Number(e01Evidence.size_bytes) }],
        source_unavailable_reason: null,
        status: { currentness: 'NOT_APPLICABLE', lifecycle_status: 'active', lineage: null },
        fields: { title: e01Row.title, content: e01Row.content },
      });
      assert.deepEqual(Object.keys(e01Pack.pack).sort(), ['authoritative', 'compile_inputs_digest', 'constraints',
        'execution_authorization', 'freshness', 'items', 'model_extraction', 'policy', 'request', 'schema', 'scopes',
        'token_budget', 'tokenizer']);
      assert.deepEqual([e01Pack.pack.schema, e01Pack.pack.authoritative, e01Pack.pack.execution_authorization,
        e01Pack.pack.model_extraction, e01Pack.authoritative, e01Pack.execution_authorization],
      ['clued.context-pack.v1', true, 'NOT_GRANTED', 'NOT_EVALUATED', true, 'NOT_GRANTED']);
      assert.deepEqual(e01Pack.pack.policy, { id: e01Policy.policyId, task_class: 'e2e.01', version: 1,
        digest: e01Policy.issued.policy_digest, decision: { id: e01Policy.accepted.supplemental.decision_record_id,
          version: 1, receipt_id: e01Policy.accepted.supplemental.decision_receipt_id } });
      assert.deepEqual([e01Pack.pack.request, e01Pack.pack.freshness, e01Pack.pack.scopes],
        [{ scope: p1, task_class: 'e2e.01' }, { mode: 'current', reason: null }, [p1]]);
      assert.ok(!/"(user_id|binding_id|actor_user_id|actor_binding_id)"/.test(e01Pack.pack_text),
        'no sanitizer-stripped key in the body');
      // Token labeling (6.2).
      assert.deepEqual(e01Pack.pack.tokenizer, { ...TOKENIZER, status: 'offline_target' });
      assert.deepEqual(e01Pack.measurement, { status: 'measured', token_count: countTokens(e01Pack.pack_text),
        token_budget: 32768, tokenizer_status: 'offline_target', tokenizer: TOKENIZER, counted: 'pack_text',
        pack_digest: e01Pack.pack_digest });
      // The manifest stores digests and versions only.
      const e01Manifest = await manifest(e01Pack.manifest.id);
      assert.deepEqual([e01Manifest.principal_kind, e01Manifest.binding_id, e01Manifest.policy_id,
        e01Manifest.pack_digest, e01Manifest.inputs_digest, e01Manifest.stale, e01Manifest.effective_scopes],
      ['agent_binding', workerBindingId, e01Policy.policyId, e01Pack.pack_digest, e01Pack.compile_inputs_digest,
        false, [p1]]);
      assert.deepEqual(e01Manifest.sources, [{ tier: 'authority_information', id: e01Record, version: 1 }]);
      assert.deepEqual(e01Manifest.request, { scope: p1, task_class: 'e2e.01' });
      assert.ok(!JSON.stringify(e01Manifest).includes(e01Row.content), 'no pack body is stored');
      assert.equal(e01Pack.manifest.reused, false);

      // ---- Determinism: same inputs, byte-identical pack; manifest reused.
      const e01Again = packOk(await call('clued_context_pack', { scope: p1, task_class: 'e2e.01' }), 'E2E-01 again');
      assert.deepEqual([e01Again.pack_text, e01Again.pack_digest, e01Again.manifest.id, e01Again.manifest.reused],
        [e01Pack.pack_text, e01Pack.pack_digest, e01Pack.manifest.id, true]);
      const e01ById = packOk(await call('clued_context_pack', { scope: p1, policy_id: e01Policy.policyId }), 'by id');
      assert.equal(e01ById.pack_text, e01Pack.pack_text);
      const e01Native = await post('/v1/context/pack', { scope: p1, task_class: 'e2e.01' });
      assert.equal(e01Native.status, 200, JSON.stringify(e01Native.body));
      packOk(e01Native.body, 'Native');
      assert.equal(e01Native.body.pack_text, e01Pack.pack_text, 'Native and Binding with equal scopes: identical bytes');
      assert.equal(e01Native.body.measurement.status, 'measured');
      assert.equal((await manifest(e01Native.body.manifest.id)).principal_kind, 'native_account_session');
      const e01Direct = await agent(tokenA, 'clued_context_pack', { scope: p1, task_class: 'e2e.01' });
      assert.deepEqual([e01Direct.pack_text, e01Direct.measurement], [e01Pack.pack_text, { status: 'not_measured' }],
        'a direct PostgREST caller gets no measurement');
      assert.equal(await count('public.clued_audit_receipts', 'user_id=$1 and operation_family like $2',
        [userId, 'context_pack%']), 0, 'compiles write no Receipt');
      // A foreign policy id reads like no policy (no existence oracle).
      const otherPolicy = await accept(policyDoc('other.user', ['global']), 0, 'other-jwt');
      await assertMcpPolicyRefusal({ scope: p1, policy_id: otherPolicy.policyId });
      await assertMcpPolicyRefusal({ scope: p1, policy_id: uuid() });
      // A Binding cannot revalidate a manifest through MCP.
      const bindingRevalidate = await call('clued_context_pack', { manifest_id: e01Pack.manifest.id });
      assert.equal(bindingRevalidate.error_code, 'manifest_revalidation_native_only');

      // Serializer byte compatibility with quotes, backslashes, control
      // characters, CJK and emoji.
      const pSer = await project('serializer');
      const tricky = 'Quote " back \\ slash / ctrl \u0001\u001f tab\t nl\n cr\r CJK 中文 emoji 😀 del \u007f ls   end';
      const trickyId = await nativeNote(tricky, { scope: pSer, content: `${tricky} <|endoftext|> ${'x'.repeat(10)}` });
      await accept(policyDoc('serializer.check', [pSer]), 0);
      const serPack = packOk(await call('clued_context_pack', { scope: pSer, task_class: 'serializer.check' }), 'serializer');
      assert.equal(serPack.pack.items[0].fields.title, tricky);
      assert.equal(serPack.pack.items[0].canonical_id, trickyId);
      assert.equal(serPack.measurement.token_count, countTokens(serPack.pack_text),
        'special-token text is counted as ordinary text');
      for (const value of [{ b: [1, { z: null, a: true }], a: 'é"\\\u0002', c: -9007199254740991 }, [], {}, 'x', 0]) {
        const text = (await admin.query('select clued_private.context_canonical_json_v1($1::jsonb) v',
          [JSON.stringify(value)])).rows[0].v;
        assert.equal(`${text}\n`, serialize(value), JSON.stringify(value));
      }
      for (const unsafe of ['1.5', '9007199254740992', '1e30']) {
        await assert.rejects(admin.query('select clued_private.context_canonical_json_v1($1::jsonb)', [unsafe]),
          /context_unsafe_number/, unsafe);
      }

      // ---- Token budget enforced by the Worker (fail closed).
      await accept(policyDoc('budget.tiny', [p1], { token_budget: 1 }), 0);
      const tiny = await call('clued_context_pack', { scope: p1, task_class: 'budget.tiny' });
      assert.deepEqual([tiny.status, tiny.error_code, tiny.reason, tiny.token_budget, tiny.authoritative],
        ['rejected', 'CONTEXT_INSUFFICIENT', 'token_budget_exceeded', 1, false]);
      assert.ok(tiny.token_count > 1 && !('pack_text' in tiny), 'no pack body on a budget refusal');
      const tinyEnvelope = await mcp('tools/call', { name: 'clued_context_pack',
        arguments: { scope: p1, task_class: 'budget.tiny' } });
      assert.equal(tinyEnvelope.result.isError, true, 'a budget refusal is an MCP tool error');
      const tinyRest = await post('/v1/context/pack', { scope: p1, task_class: 'budget.tiny' });
      assert.deepEqual([tinyRest.status, tinyRest.body.reason], [422, 'token_budget_exceeded']);
      assert.equal((await agent(tokenA, 'clued_context_pack', { scope: p1, task_class: 'budget.tiny' })).status, 'ok',
        'the budget is enforced on the Worker path only (disclosed)');

      // ---- Compiler fail-closed cases.
      const insufficient = async (taskClass, scope, reason) => {
        const result = await post('/v1/context/pack', { scope, task_class: taskClass });
        assert.equal(result.status, 422, `${taskClass} ${JSON.stringify(result.body)}`);
        assert.deepEqual(result.body, { status: 'rejected', error_code: 'CONTEXT_INSUFFICIENT', reason,
          authoritative: false, execution_authorization: 'NOT_GRANTED', model_extraction: 'NOT_EVALUATED' });
      };
      const pEmpty = await project('empty');
      await accept(policyDoc('fail.empty', [pEmpty]), 0);
      await insufficient('fail.empty', pEmpty, 'no_eligible_sources');
      const pMany = await project('many');
      const manyIds = [];
      for (let i = 0; i < 3; i += 1) manyIds.push(await nativeNote(`Many ${i}`, { scope: pMany }));
      await accept(policyDoc('fail.max', [pMany], { max_items: 2 }), 0);
      await insufficient('fail.max', pMany, 'max_items_exceeded');
      await accept(policyDoc('fail.required', [p1], { fields: { required: ['closure_summary'] } }), 0);
      await insufficient('fail.required', p1, `required_field_missing:${e01Record}`);
      await accept(policyDoc('fail.evidence', [pMany], { require_evidence: true }), 0);
      await insufficient('fail.evidence', pMany, `evidence_required:${[...manyIds].sort()[0]}`);
      await accept(policyDoc('fail.constraint', [p1], { verbatim_constraints: [{ record_id: e01Record, field: 'title',
        exact_text: 'NOT IN THE TITLE' }] }), 0);
      await insufficient('fail.constraint', p1, `constraint_not_grounded:${e01Record}`);
      await accept(policyDoc('ok.constraint', [p1], { verbatim_constraints: [{ record_id: e01Record.toUpperCase(),
        field: 'title', exact_text: e01Row.title.slice(0, 12) }] }), 0);
      const grounded = packOk((await post('/v1/context/pack', { scope: p1, task_class: 'ok.constraint' })).body, 'grounded');
      assert.deepEqual(grounded.pack.constraints, [{ record_id: e01Record, field: 'title', exact_text: e01Row.title.slice(0, 12) }]);
      const pBig = await project('big');
      // Content is capped at 8000 characters; each control character
      // serializes to six bytes, so 23 records exceed 1 MiB of pack_text.
      for (let i = 0; i < 23; i += 1) {
        const id = uuid();
        const big = await native('clued_user_record_mutate', noteInput(id, `Big ${i}`, { scope: pBig,
          content: `${i}${'\u0001'.repeat(7990)}${i}` }));
        assert.equal(big.status, 'committed', JSON.stringify(big));
      }
      await accept(policyDoc('fail.bytes', [pBig], { fields: { required: ['content'] } }), 0);
      await insufficient('fail.bytes', pBig, 'pack_byte_limit');
      const mismatch = await post('/v1/context/pack', { scope: 'global', task_class: 'e2e.01' });
      assert.deepEqual([mismatch.status, mismatch.body.error_code], [422, 'CONTEXT_POLICY_SCOPE_MISMATCH']);
      assert.equal(await count('clued_private.context_pack_manifests', 'user_id=$1 and policy_id in (select id from clued_private.context_policies where task_class like $2)',
        [userId, 'fail.%']), 0, 'no manifest for a refused compile');

      // ---- Filter before LIMIT: unreadable rows never consume max_items.
      const pHidden = await project('hidden');
      const pVisible = await project('visible');
      for (let i = 0; i < 4; i += 1) await nativeNote(`Hidden ${i}`, { scope: pHidden });
      const visibleIds = [await nativeNote('Visible 0', { scope: pVisible }), await nativeNote('Visible 1', { scope: pVisible })];
      await admin.query(`insert into public.clued_agent_bindings (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','Scoped agent',$2,array['context:read'],array['global',$3])`, [userId, sha256(rawScoped), pVisible]);
      await accept(policyDoc('limit.check', [pHidden, pVisible], { max_items: 3 }), 0);
      const scopedPack = packOk(await call('clued_context_pack', { scope: pVisible, task_class: 'limit.check' }, rawScoped),
        'filter before limit');
      assert.deepEqual(scopedPack.pack.scopes, [pVisible]);
      assert.deepEqual(scopedPack.pack.items.map((row) => row.canonical_id).sort(), [...visibleIds].sort());
      await insufficient('limit.check', pVisible, 'max_items_exceeded');

      // ---- Tiers and labels.
      const pCand = await project('candidates');
      const candNote = await nativeNote('Candidate scope note', { scope: pCand });
      const nativeCand = (await post('/v1/intake', { idempotency_key: key('cand'), scope: pCand,
        segment: segment('seg_s4_cn'), candidates: documentOf('seg_s4_cn', [item('cn', 'fact')]) })).body
        .supplemental.candidates[0].id;
      const ownCand = (await call('clued_intake_submit', { idempotency_key: key('cand'), scope: pCand,
        segment: segment('seg_s4_cw'), candidates: documentOf('seg_s4_cw', [item('cw', 'decision')]) }))
        .supplemental.candidates[0].id;
      const otherCand = (await call('clued_intake_submit', { idempotency_key: key('cand'), scope: pCand,
        segment: segment('seg_s4_cb'), candidates: documentOf('seg_s4_cb', [item('cb', 'fact')]) }, rawBindingB))
        .supplemental.candidates[0].id;
      const allTiers = ['authority_information', 'authority_knowledge', 'candidate_information', 'candidate_knowledge'];
      await accept(policyDoc('cand.native', [pCand], { allowed_tiers: allTiers }), 0);
      await accept(policyDoc('cand.agent', [pCand], { allowed_tiers: allTiers, allow_agent_authored: true }), 0);
      const candDefault = packOk(await call('clued_context_pack', { scope: pCand, task_class: 'cand.native' }), 'cand');
      assert.deepEqual(candDefault.pack.items.map((row) => [row.canonical_id, row.tier, row.labels, row.writer_principal,
        row.human_confirmed]),
      [[candNote, 'authority_information', [], 'native_account_session', true],
        [nativeCand, 'candidate_information', ['CANDIDATE'], 'native_ui', false]]);
      assert.equal(candDefault.pack.authoritative, false, 'any CANDIDATE item makes the pack non-authoritative');
      assert.equal(candDefault.pack.items[1].evidence.length, 1);
      assert.deepEqual(candDefault.pack.items[1].status, { currentness: 'NOT_APPLICABLE', lifecycle_status: 'pending',
        lineage: null });
      const candAgent = packOk(await call('clued_context_pack', { scope: pCand, task_class: 'cand.agent' }), 'cand agent');
      assert.deepEqual(candAgent.pack.items.map((row) => [row.canonical_id, row.labels, row.record_type]).sort(),
        [[candNote, [], 'note'], [nativeCand, ['CANDIDATE'], 'note'], [ownCand, ['AGENT_AUTHORED', 'CANDIDATE'], 'decision']]
          .sort(), 'a Binding sees only its own and native_ui candidates');
      assert.ok(!candAgent.pack_text.includes(otherCand));
      const candNative = packOk((await post('/v1/context/pack', { scope: pCand, task_class: 'cand.agent' })).body,
        'cand native');
      assert.deepEqual(candNative.pack.items.map((row) => row.canonical_id).sort(),
        [candNote, nativeCand, ownCand, otherCand].sort());
      // Authority Knowledge only while its lineage holds.
      const k1 = await nativeNote('Knowledge source one', { scope: pCand });
      const k2 = await nativeNote('Knowledge source two', { scope: pCand });
      const proposed = await call('clued_knowledge_propose', { idempotency_key: key('kp'), scope: pCand,
        rule_id: 'knowledge.consolidate.v1', assertion: 'Both knowledge sources agree.',
        sources: [{ id: k1, version: 1 }, { id: k2, version: 1 }] });
      assert.equal(proposed.status, 'committed', JSON.stringify(proposed));
      const kId = proposed.supplemental.candidate_id;
      const kIssued = (await post(`/v1/knowledge/candidates/${kId}/confirmation`, { base_version: 1,
        authority: 'user_explicit' })).body;
      const kPromoted = await post(`/v1/knowledge/candidates/${kId}/promote`, { idempotency_key: key('kpp'),
        base_version: 1, confirmation_token: kIssued.confirmation_token, view_digest: kIssued.view_digest });
      assert.equal(kPromoted.body.supplemental?.outcome, 'promoted', JSON.stringify(kPromoted.body));
      await accept(policyDoc('know.check', [pCand], { allowed_tiers: ['authority_knowledge'],
        allowed_record_types: ['note'] }), 0);
      const knowPack = packOk(await call('clued_context_pack', { scope: pCand, task_class: 'know.check' }), 'knowledge');
      assert.deepEqual(knowPack.pack.items.map((row) => [row.canonical_id, row.tier, row.status.lineage]),
        [[kIssued.record_id, 'authority_knowledge', 'OK']]);
      assert.equal((await post('/v1/records', { operation: 'update', id: k1, record_type: 'note', record_schema_version: 1,
        lifecycle_status: 'active', scope: pCand, idempotency_key: key('kup'), authority: 'user_explicit',
        confidence: 1, confidence_reason: 'S4 fixture', base_version: 1, mutation: { title: 'Knowledge source one v2' } }))
        .body.status, 'committed');
      await insufficient('know.check', pCand, 'no_eligible_sources');
      // Candidate Knowledge visibility across Bindings.
      const nativeK = (await post('/v1/knowledge/candidates', { idempotency_key: key('kcn'), scope: pCand,
        rule_id: 'knowledge.dedup.v1', assertion: 'Native knowledge candidate', sources: [{ id: candNote, version: 1 }] }))
        .body.supplemental.candidate_id;
      const ownK = (await call('clued_knowledge_propose', { idempotency_key: key('kcw'), scope: pCand,
        rule_id: 'knowledge.dedup.v1', assertion: 'Own Binding knowledge candidate',
        sources: [{ id: candNote, version: 1 }] })).supplemental.candidate_id;
      const otherK = (await call('clued_knowledge_propose', { idempotency_key: key('kcb'), scope: pCand,
        rule_id: 'knowledge.dedup.v1', assertion: 'Other Binding knowledge candidate',
        sources: [{ id: candNote, version: 1 }] }, rawBindingB)).supplemental.candidate_id;
      assert.ok(nativeK && ownK && otherK);
      await accept(policyDoc('know.cand', [pCand], { allowed_tiers: ['candidate_knowledge'],
        allowed_record_types: ['note'], allow_agent_authored: true }), 0);
      const kcBinding = packOk(await call('clued_context_pack', { scope: pCand, task_class: 'know.cand' }), 'know.cand');
      assert.deepEqual(kcBinding.pack.items.map((row) => [row.canonical_id, row.labels, row.writer_principal]).sort(),
        [[nativeK, ['CANDIDATE'], 'native_ui'], [ownK, ['AGENT_AUTHORED', 'CANDIDATE'], 'agent_binding']].sort());
      const kcNative = packOk((await post('/v1/context/pack', { scope: pCand, task_class: 'know.cand' })).body, 'kc native');
      assert.deepEqual(kcNative.pack.items.map((row) => row.canonical_id).sort(), [nativeK, ownK, otherK].sort());
      // degraded freshness is never authoritative; historical with a reason may be.
      await accept(policyDoc('fresh.degraded', [p1], { freshness: { mode: 'degraded', reason: 'Offline audit' } }), 0);
      const degraded = packOk(await call('clued_context_pack', { scope: p1, task_class: 'fresh.degraded' }), 'degraded');
      assert.deepEqual([degraded.pack.authoritative, degraded.authoritative, degraded.pack.freshness,
        degraded.pack.items.every((row) => row.human_confirmed)], [false, false,
        { mode: 'degraded', reason: 'Offline audit' }, true]);
      await accept(policyDoc('fresh.historical', [p1], { freshness: { mode: 'historical', reason: 'Audit trail' } }), 0);
      const historical = packOk(await call('clued_context_pack', { scope: p1, task_class: 'fresh.historical' }), 'historical');
      assert.equal(historical.pack.authoritative, true);

      // ---- Review M1 regression: per-item state that changes without a
      // source version bump is a compile input; a recompile succeeds and the
      // previous manifest becomes stale (never context_pack_nondeterministic).
      const revalidate = async (id) => (await post('/v1/context/pack', { manifest_id: id })).body;
      // (1) Candidate Knowledge lineage.
      const pLin = await project('lineage');
      const ls1 = await nativeNote('Lineage source one', { scope: pLin });
      const ls2 = await nativeNote('Lineage source two', { scope: pLin });
      const linProposed = await post('/v1/knowledge/candidates', { idempotency_key: key('kpn'), scope: pLin,
        rule_id: 'knowledge.consolidate.v1', assertion: 'Lineage sources agree.',
        sources: [{ id: ls1, version: 1 }, { id: ls2, version: 1 }] });
      assert.equal(linProposed.body.status, 'committed', JSON.stringify(linProposed.body));
      await accept(policyDoc('lineage.change', [pLin], { allowed_tiers: ['candidate_knowledge'],
        allowed_record_types: ['note'] }), 0);
      const lin1 = packOk(await call('clued_context_pack', { scope: pLin, task_class: 'lineage.change' }), 'lineage 1');
      assert.deepEqual(lin1.pack.items.map((row) => row.status.lineage), ['OK']);
      // Review m1: the compile path takes no row locks.
      await admin.query('begin');
      await admin.query('select 1 from public.clued_memories where id=$1 for update', [ls2]);
      await workerCaller.query("set lock_timeout='2s'");
      try {
        assert.equal((await agent(tokenA, 'clued_context_pack', { scope: pLin, task_class: 'lineage.change' })).status,
          'ok', 'a compile does not wait on source row locks');
      } finally {
        await workerCaller.query('reset lock_timeout');
        await admin.query('rollback');
      }
      assert.equal((await post('/v1/records', { operation: 'update', id: ls1, record_type: 'note', record_schema_version: 1,
        lifecycle_status: 'active', scope: pLin, idempotency_key: key('lup'), authority: 'user_explicit',
        confidence: 1, confidence_reason: 'S4 fixture', base_version: 1, mutation: { title: 'Lineage source one v2' } }))
        .body.status, 'committed');
      const lin2 = packOk(await call('clued_context_pack', { scope: pLin, task_class: 'lineage.change' }), 'lineage 2');
      assert.deepEqual(lin2.pack.items.map((row) => row.status.lineage), ['knowledge_source_version_mismatch']);
      assert.notEqual(lin2.compile_inputs_digest, lin1.compile_inputs_digest, 'lineage is a compile input');
      assert.notEqual(lin2.manifest.id, lin1.manifest.id);
      assert.deepEqual([(await manifest(lin1.manifest.id)).stale, (await manifest(lin1.manifest.id)).stale_reason],
        [true, 'inputs_changed']);
      assert.equal((await revalidate(lin1.manifest.id)).revalidation, 'STALE');
      assert.equal((await revalidate(lin2.manifest.id)).revalidation, 'VALID');
      // (2) Degraded currentness changed by a Binding's shadowing Event.
      const pShadow = await project('shadow');
      const shadowDecision = uuid();
      assert.equal((await post('/v1/records', { operation: 'create', id: shadowDecision, record_type: 'decision',
        record_schema_version: 1, lifecycle_status: 'active', scope: pShadow, idempotency_key: key('sdec'),
        authority: 'user_explicit', confidence: 1, confidence_reason: 'S4 fixture', source_refs: [],
        source_unavailable_reason: 'Synthetic fixture', mutation: { title: 'Shadowable decision', content: 'Decide',
          type_fields: { rationale: 'Because' }, relations: {} } })).body.status, 'committed');
      await accept(policyDoc('degraded.shadow', [pShadow], { allowed_record_types: ['decision'],
        freshness: { mode: 'degraded', reason: 'Shadow probe' } }), 0);
      const sh1 = packOk(await call('clued_context_pack', { scope: pShadow, task_class: 'degraded.shadow' }), 'shadow 1');
      assert.deepEqual(sh1.pack.items.map((row) => row.status.currentness), ['CURRENT']);
      const shadowSession = await call('clued_session_resume', { context_key: pShadow });
      assert.ok(shadowSession.session_token, JSON.stringify(shadowSession));
      // Decision-class Events are rejected by the public adapter; seed a pre-guard row.
      assert.equal((await admin.query('select clued_private.clued_mcp_append_event_unguarded($1,$2) value', [sha256(rawBinding),
        { context_key: pShadow, session_token: shadowSession.session_token,
          base_version: shadowSession.version, event_type: 'decision', payload: { note: 'Agent decision event' },
          idempotency_key: key('pshadow') }])).rows[0].value.status, 'appended');
      const sh2 = packOk(await call('clued_context_pack', { scope: pShadow, task_class: 'degraded.shadow' }), 'shadow 2');
      assert.deepEqual(sh2.pack.items.map((row) => row.status.currentness), ['SHADOWED_BY_ACTIVE_EVENT']);
      assert.notEqual(sh2.compile_inputs_digest, sh1.compile_inputs_digest, 'currentness is a compile input');
      assert.deepEqual([(await manifest(sh1.manifest.id)).stale, (await manifest(sh1.manifest.id)).stale_reason],
        [true, 'inputs_changed']);
      // Review m2: a degraded manifest can revalidate as VALID.
      assert.equal((await revalidate(sh2.manifest.id)).revalidation, 'VALID');
      // (3) Historical lifecycle change.
      const pHist = await project('historical');
      const histNote = await nativeNote('Historical note', { scope: pHist });
      await accept(policyDoc('historical.lifecycle', [pHist], { freshness: { mode: 'historical', reason: 'Audit' } }), 0);
      const h1 = packOk(await call('clued_context_pack', { scope: pHist, task_class: 'historical.lifecycle' }), 'hist 1');
      assert.deepEqual(h1.pack.items.map((row) => row.status.lifecycle_status), ['active']);
      assert.equal((await post('/v1/records', { operation: 'close', id: histNote, record_type: 'note',
        record_schema_version: 1, lifecycle_status: 'archived', scope: pHist, idempotency_key: key('hclose'),
        authority: 'user_explicit', confidence_reason: 'S4 fixture', base_version: 1,
        mutation: { closure_summary: 'Archived' } })).body.status, 'committed');
      const h2 = packOk(await call('clued_context_pack', { scope: pHist, task_class: 'historical.lifecycle' }), 'hist 2');
      assert.deepEqual(h2.pack.items.map((row) => [row.version, row.status.lifecycle_status]), [[2, 'archived']]);
      // S5 marks a manifest stale proactively when a listed source closes.
      assert.deepEqual([(await manifest(h1.manifest.id)).stale, (await manifest(h1.manifest.id)).stale_reason],
        [true, 'source_closed']);
      // (4) Defense in depth: an out-of-band edit without a version bump
      // changes the bytes under equal inputs; the old manifest goes stale.
      await admin.query('set session_replication_role=replica');
      await admin.query("update public.clued_memories set title='Historical note (edited out of band)' where id=$1", [histNote]);
      await admin.query('set session_replication_role=origin');
      const h3 = packOk(await call('clued_context_pack', { scope: pHist, task_class: 'historical.lifecycle' }), 'hist 3');
      assert.equal(h3.compile_inputs_digest, h2.compile_inputs_digest);
      assert.notEqual(h3.pack_digest, h2.pack_digest);
      assert.deepEqual([h3.manifest.reused, (await manifest(h2.manifest.id)).stale,
        (await manifest(h2.manifest.id)).stale_reason], [false, true, 'pack_changed']);
      assert.equal((await manifest(h3.manifest.id)).pack_digest, h3.pack_digest);

      // ---- E2E-12: Agent-authored Records only under an explicit opt-in.
      const p12 = await project('e2e-12');
      const p12Native = await nativeNote('Native in E2E-12', { scope: p12 });
      const bypassId = uuid();
      assert.equal((await call('clued_record_mutate', noteInput(bypassId, 'E2E-11 bypass write', { scope: p12 }))).status,
        'committed', 'E2E-11 OPEN_BY_OD-5: a Binding user_explicit write still commits');
      const agentEvidence = await call('clued_evidence_ingest', { idempotency_key: key('ev'), evidence_schema_version: 1,
        evidence_type: 'file', storage_ref: 'binding:s4-e12', content_hash: sha256('s4-e12'),
        mime_type: 'text/plain', size_bytes: 6 });
      assert.equal(agentEvidence.status, 'committed', JSON.stringify(agentEvidence));
      const observedId = uuid();
      assert.equal((await call('clued_record_mutate', noteInput(observedId, 'Agent observed note', { scope: p12,
        authority: 'observed', sources: agentEvidence.evidence_ids }))).status, 'committed');
      await accept(policyDoc('e12.default', [p12]), 0);
      await accept(policyDoc('e12.optin', [p12], { allow_agent_authored: true }), 0);
      const e12Default = packOk(await call('clued_context_pack', { scope: p12, task_class: 'e12.default' }), 'E2E-12 default');
      assert.deepEqual(e12Default.pack.items.map((row) => row.canonical_id), [p12Native]);
      assert.equal(e12Default.pack.authoritative, true);
      const e12Optin = packOk(await call('clued_context_pack', { scope: p12, task_class: 'e12.optin' }), 'E2E-12 opt-in');
      const e12Items = Object.fromEntries(e12Optin.pack.items.map((row) => [row.canonical_id, row]));
      assert.deepEqual(Object.keys(e12Items).sort(), [p12Native, bypassId, observedId].sort());
      for (const id of [bypassId, observedId]) {
        assert.deepEqual([e12Items[id].labels, e12Items[id].writer_principal, e12Items[id].human_confirmed],
          [['AGENT_AUTHORED'], 'agent_binding', false], id);
      }
      assert.deepEqual(e12Items[observedId].evidence.map((row) => row.content_hash), [sha256('s4-e12')]);
      assert.equal(e12Optin.pack.authoritative, false);

      // ---- E2E-13: null-writer, unmarked Records are excluded even under opt-in.
      const p13 = await project('e2e-13');
      const p13Native = await nativeNote('Native in E2E-13', { scope: p13 });
      const maintenanceId = uuid();
      await admin.query('select clued_private.record_mutation_with_terminal_guard($1,null,$2,$3)',
        [userId, noteInput(maintenanceId, 'Maintenance write', { scope: p13 }), hash()]);
      const doomedId = uuid();
      assert.equal((await agent(tokenDoomed, 'clued_record_mutate', noteInput(doomedId, 'Doomed agent write',
        { scope: p13 }))).status, 'committed');
      await admin.query('delete from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1($1)', [tokenDoomed]);
      for (const id of [maintenanceId, doomedId]) {
        assert.equal(await confirmed(id, 1), false);
        assert.equal((await writer(id, 1)).writer_principal, 'unknown', id);
      }
      await accept(policyDoc('e13.default', [p13]), 0);
      await accept(policyDoc('e13.optin', [p13], { allow_agent_authored: true }), 0);
      for (const taskClass of ['e13.default', 'e13.optin']) {
        const pack = packOk(await call('clued_context_pack', { scope: p13, task_class: taskClass }), taskClass);
        assert.deepEqual(pack.pack.items.map((row) => row.canonical_id), [p13Native], taskClass);
      }

      // ---- Review m2: malformed agent knowledge lineage excludes the item,
      // never fails the compile (default and opt-in policies).
      const pMal = await project('malformed');
      const malNative = await nativeNote('Malformed scope note', { scope: pMal });
      for (const [label, knowledge] of [['uuid', { sources: [{ id: 'not-a-uuid', version: 1 }] }],
        ['version', { sources: [{ id: malNative, version: 'x' }] }], ['shape', { sources: ['x'] }]]) {
        const written = await call('clued_record_mutate', { operation: 'create', id: uuid(), record_type: 'note',
          record_schema_version: 1, lifecycle_status: 'active', scope: pMal, idempotency_key: key('mal'),
          authority: 'inferred', confidence: 0.5, confidence_reason: 'agent', source_refs: [],
          source_unavailable_reason: 'Synthetic fixture', mutation: { title: `Agent knowledge ${label}`, content: 'y',
            type_fields: { note_kind: 'knowledge', knowledge }, relations: {} } });
        assert.equal(written.status, 'committed', JSON.stringify(written));
        assert.equal((await admin.query('select clued_private.context_knowledge_lineage_v1($1,$2) v',
          [userId, JSON.stringify(knowledge.sources)])).rows[0].v, 'knowledge_source_malformed', label);
      }
      await accept(policyDoc('mal.default', [pMal]), 0);
      await accept(policyDoc('mal.optin', [pMal], { allow_agent_authored: true }), 0);
      for (const taskClass of ['mal.default', 'mal.optin']) {
        const viaMcp = packOk(await call('clued_context_pack', { scope: pMal, task_class: taskClass }), taskClass);
        assert.deepEqual(viaMcp.pack.items.map((row) => row.canonical_id), [malNative], taskClass);
        const viaRest = await post('/v1/context/pack', { scope: pMal, task_class: taskClass });
        assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));
        assert.deepEqual(viaRest.body.pack.items.map((row) => row.canonical_id), [malNative], taskClass);
      }

      // ---- historical mode admits HISTORY-fenced decisions; current does not.
      const pHistory = await project('history-fence');
      const oldDecision = uuid();
      const newDecision = uuid();
      assert.equal((await post('/v1/records', { operation: 'create', id: oldDecision, record_type: 'decision',
        record_schema_version: 1, lifecycle_status: 'active', scope: pHistory, idempotency_key: key('hdec'),
        authority: 'user_explicit', confidence: 1, confidence_reason: 'S4 fixture', source_refs: [],
        source_unavailable_reason: 'Synthetic fixture', mutation: { title: 'Old decision', content: 'Old',
          type_fields: { rationale: 'Then' }, relations: {} } })).body.status, 'committed');
      assert.equal((await post('/v1/decisions/supersede', { idempotency_key: key('hsup'), supersede_reason: 'Replaced',
        source_decisions: [{ id: oldDecision, base_version: 1 }],
        replacement: { id: newDecision, scope: pHistory, record_schema_version: 1, title: 'New decision', content: 'New',
          type_fields: { rationale: 'Now' }, relations: { supersedes: [oldDecision] }, authority: 'user_explicit',
          source_refs: [], source_unavailable_reason: 'Synthetic fixture', confidence_reason: 'S4 fixture' } }))
        .body.status, 'committed');
      await accept(policyDoc('history.fence', [pHistory], { allowed_record_types: ['decision'],
        freshness: { mode: 'historical', reason: 'Decision history' } }), 0);
      await accept(policyDoc('history.current', [pHistory], { allowed_record_types: ['decision'] }), 0);
      const historyPack = packOk(await call('clued_context_pack', { scope: pHistory, task_class: 'history.fence' }),
        'history');
      assert.deepEqual(historyPack.pack.items.map((row) => [row.canonical_id, row.status.currentness,
        row.status.lifecycle_status]).sort(), [[oldDecision, 'HISTORY', 'superseded'],
        [newDecision, 'CURRENT', 'active']].sort());
      assert.equal(historyPack.pack.authoritative, true);
      const currentPack = packOk(await call('clued_context_pack', { scope: pHistory, task_class: 'history.current' }),
        'current');
      assert.deepEqual(currentPack.pack.items.map((row) => row.canonical_id), [newDecision]);

      // ---- E2E-05: Binding scope reduction; the manifest fails revalidation.
      const p5a = await project('e2e-05-a');
      const p5b = await project('e2e-05-b');
      const p5aNote = await nativeNote('Scope A note', { scope: p5a });
      const p5bNote = await nativeNote('Scope B note', { scope: p5b });
      const issuer = hash();
      const resource = 'https://mcp.example.invalid/mcp';
      await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'S4 issuer')",
        [issuer, resource]);
      const scopeEntry = (id) => ({ resource_kind: 'scope', resource_id: id, environment: 'canonical', actions: ['read'] });
      await as(fresh(userId));
      const prepared = (await human.query('select public.clued_authorization_prepare_v12($1,$2) v', [issuer, {
        request_digest: hash(), client_id: 's4-client', client_name: 'S4 client', redirect_uri: 'https://client.example.invalid/cb',
        resource, requested_scopes: ['context:read'] }])).rows[0].v;
      const approved = (await human.query('select public.clued_authorization_approve_v12($1,$2,$3,$4,$5,$6) v',
        [issuer, prepared.request_id, prepared.version, JSON.stringify([scopeEntry(p5a), scopeEntry(p5b)]),
          sha256(rawAuthorized), new Date(Date.now() + 3600000).toISOString()])).rows[0].v;
      await accept(policyDoc('e05.check', [p5a, p5b]), 0);
      const e05First = packOk(await call('clued_context_pack', { scope: p5a, task_class: 'e05.check' }, rawAuthorized),
        'E2E-05 before');
      assert.deepEqual(e05First.pack.scopes, [p5a, p5b].sort());
      assert.deepEqual(e05First.pack.items.map((row) => row.canonical_id).sort(), [p5aNote, p5bNote].sort());
      const e05Manifest = e05First.manifest.id;
      const valid = await post('/v1/context/pack', { manifest_id: e05Manifest });
      assert.deepEqual([valid.status, valid.body.status, valid.body.revalidation, valid.body.pack_digest],
        [200, 'ok', 'VALID', e05First.pack_digest]);
      assert.ok(!('pack_text' in valid.body));
      assert.deepEqual(valid.body.measurement, { status: 'not_measured', token_budget_verified: false },
        'revalidation never attests the token budget');
      assert.equal((await manifest(e05Manifest)).token_measurement, 'not_measured');
      // The owner reduces the Binding (Native authorization management).
      await as(fresh(userId));
      const manage = async (input) => (await human.query('select public.clued_authorization_manage_v12($1) v',
        [input])).rows[0].v;
      const authorizationView = async () => (await manage({ op: 'list' })).bindings
        .find((binding) => binding.binding_id === approved.binding_id);
      const currentAuthorization = await authorizationView();
      assert.equal(currentAuthorization.selection_format, 'sources_v1');
      const exactSource = (scope) => currentAuthorization.sources.filter((source) => source.kind === 'direct'
        && source.contributions.length === 1 && source.contributions[0].resource_kind === 'scope'
        && source.contributions[0].resource_id === scope && source.contributions[0].environment === 'canonical');
      assert.equal(exactSource(p5a).length, 1);
      assert.equal(exactSource(p5b).length, 1);
      const [sourceA] = exactSource(p5a), [sourceB] = exactSource(p5b);
      const bindingAndAuthorization = async () => (await admin.query(`select to_jsonb(b) binding,to_jsonb(a) authorization
        from public.clued_agent_bindings b join clued_private.authorizations_v12 a on a.binding_id=b.id
        where b.id=$1`, [approved.binding_id])).rows[0];
      const beforeFlat = await bindingAndAuthorization();
      await assert.rejects(manage({ op: 'reduce', binding_id: approved.binding_id,
        base_version: currentAuthorization.version, selected: [scopeEntry(p5a)] }),
      (error) => error.code === '22023' && error.message === 'authorization_source_selection_required_sources_v1');
      assert.deepEqual(await bindingAndAuthorization(), beforeFlat, 'rejected flat reduction changes no Binding or Authorization version or body');
      assert.deepEqual(await authorizationView(), currentAuthorization, 'rejected flat reduction changes no source, grant or limit DTO');
      // Omitted sources keep their consent. Revoke the exact B source using
      // its actual Native identity/version rather than resubmitting projection A.
      const reduced = await manage({ op: 'reduce', binding_id: approved.binding_id,
        base_version: currentAuthorization.version, selection_format: 'sources_v1',
        sources: [{ source_id: sourceB.source_id, base_version: sourceB.version, action_cap: [] }], exceptions: [] });
      assert.equal(reduced.binding_id, approved.binding_id);
      assert.equal(Number(reduced.version), Number(currentAuthorization.version) + 1);
      assert.deepEqual(reduced.selected.map((entry) => entry.resource_id), [p5a]);
      const afterReduction = await authorizationView();
      assert.equal(afterReduction.selection_format, 'sources_v1');
      assert.deepEqual(afterReduction.sources.find((source) => source.source_id === sourceA.source_id), sourceA,
        'the unsubmitted A source retains its complete identity, version and consent DTO');
      assert.equal(afterReduction.sources.some((source) => source.source_id === sourceB.source_id), false);
      assert.deepEqual(afterReduction.grants.map((entry) => entry.resource_id), [p5a], 'Native effective grants retain only A');
      assert.deepEqual(afterReduction.overrides, currentAuthorization.overrides, 'source removal invents no precise override');
      const e05After = packOk(await call('clued_context_pack', { scope: p5a, task_class: 'e05.check' }, rawAuthorized),
        'E2E-05 after');
      assert.deepEqual(e05After.pack.scopes, [p5a], 'the next compile omits the reduced scope');
      assert.deepEqual(e05After.pack.items.map((row) => row.canonical_id), [p5aNote]);
      assert.notEqual(e05After.pack_digest, e05First.pack_digest);
      const revalidated = await post('/v1/context/pack', { manifest_id: e05Manifest });
      assert.deepEqual([revalidated.status, revalidated.body.status, revalidated.body.revalidation],
        [409, 'stale', 'STALE'], JSON.stringify(revalidated.body));
      assert.ok(!('pack_text' in revalidated.body), 'a pack is never an online fallback');
      const staleRow = await manifest(e05Manifest);
      // S5 flags the manifest proactively at the reduction (before any
      // recompile or revalidation); the first stale reason is final.
      assert.deepEqual([staleRow.stale, staleRow.stale_reason, staleRow.version], [true, 'binding_scope_reduced', 2]);
      const again = await post('/v1/context/pack', { manifest_id: e05Manifest });
      assert.deepEqual([again.status, again.body.revalidation, again.body.reason], [409, 'STALE', 'binding_scope_reduced']);
      assert.equal((await post('/v1/context/pack', { manifest_id: uuid() })).body.error_code, 'CONTEXT_MANIFEST_NOT_FOUND');
      assert.equal((await post('/v1/context/pack', { manifest_id: e05Manifest }, 'other-jwt')).body.error_code,
        'CONTEXT_MANIFEST_NOT_FOUND', 'a foreign manifest is invisible');

      // ---- E2E-14: Native marker; forged Events change no policy, candidate or manifest state.
      const p14 = await project('e2e-14');
      const p14Note = await nativeNote('Native record after S3', { scope: p14 });
      assert.equal(await confirmed(p14Note, 1), true);
      await accept(policyDoc('e14.check', [p14]), 0);
      const e14Before = packOk(await call('clued_context_pack', { scope: p14, task_class: 'e14.check' }), 'E2E-14');
      assert.deepEqual(e14Before.pack.items.map((row) => row.canonical_id), [p14Note]);
      const stateHash = async () => (await admin.query(`select
          (select md5(coalesce(string_agg(to_jsonb(p)::text,',' order by id),'')) from clued_private.context_policies p) policies,
          (select md5(coalesce(string_agg(id::text||status||version,',' order by id),'')) from clued_private.information_candidates) info,
          (select md5(coalesce(string_agg(id::text||status||version,',' order by id),'')) from clued_private.knowledge_candidates) know,
          (select md5(coalesce(string_agg(id::text||stale::text||version,',' order by id),'')) from clued_private.context_pack_manifests) manifests`))
        .rows[0];
      const beforeForged = await stateHash();
      const e14PolicyId = (await admin.query("select id from clued_private.context_policies where task_class='e14.check'")).rows[0].id;
      for (const [name, target] of [['evidence_withdrawn', `evidence:${e01Evidence.id}`],
        ['context_policy_accepted', `context_policy:${e14PolicyId}`]]) {
        const forged = await call('clued_event_append', { idempotency_key: key('forged'), event_schema_version: 1,
          event_type: `extension:information_flow:${name}`, event_scope: 'global', audit_visibility: 'work_log',
          target_refs: [{ kind: 'system', id: target }], change_summary: { policy_id: e14PolicyId, record_id: p14Note } });
        assert.equal(forged.status, 'committed', JSON.stringify(forged));
      }
      assert.deepEqual(await stateHash(), beforeForged, 'forged Events are audit data only');
      const e14After = packOk(await call('clued_context_pack', { scope: p14, task_class: 'e14.check' }), 'E2E-14 after');
      assert.deepEqual([e14After.pack_digest, e14After.manifest.reused], [e14Before.pack_digest, true]);

      // ---- Policy -> Decision binding: every change fails compiles closed
      // until a fresh Native acceptance.
      const pDos = await project('dos');
      await nativeNote('DoS scope note', { scope: pDos });
      const compileDos = async (taskClass = 'dos.check') => call('clued_context_pack', { scope: pDos, task_class: taskClass });
      const refusedWith = async (reason, taskClass = 'dos.check') =>
        assertMcpPolicyRefusal({ scope: pDos, task_class: taskClass }, reason);
      const decisionOf = async (policyId) => {
        const row = (await admin.query('select decision_record_id id from clued_private.context_policies where id=$1',
          [policyId])).rows[0];
        return (await admin.query('select id,version,lifecycle_status from public.clued_memories where id=$1', [row.id])).rows[0];
      };
      const dosDoc = policyDoc('dos.check', [pDos]);
      let dos = await accept(dosDoc, 0);
      const dosV1 = packOk(await compileDos(), 'dos v1');
      let dosDecision = await decisionOf(dos.policyId);
      const decisionUpdate = (id, base, extra = {}) => ({ operation: 'update', id, record_type: 'decision',
        record_schema_version: 1, lifecycle_status: 'active', scope: 'global', idempotency_key: key('dup'),
        authority: 'user_explicit', user_confirmed: true, confidence_reason: 'S4 DoS probe', base_version: base,
        mutation: { title: 'Edited approving Decision' }, ...extra });
      // (a) Native /v1/records update.
      assert.equal((await post('/v1/records', decisionUpdate(dosDecision.id, 1))).body.status, 'committed');
      await refusedWith('policy_decision_changed');
      dos = await accept(dosDoc, 1);
      assert.equal(dos.issued.decision_operation, 'update', 're-acceptance updates the same Decision');
      assert.equal(dos.accepted.supplemental.decision_version, 3);
      packOk(await compileDos(), 'dos v2');
      // (h) The v1 policy id now fails; its manifests are stale.
      await assertMcpPolicyRefusal({ scope: pDos, policy_id: dosV1.pack.policy.id }, 'policy_superseded');
      const v1Manifest = await manifest(dosV1.manifest.id);
      assert.deepEqual([v1Manifest.stale, v1Manifest.stale_reason], [true, 'policy_version_changed']);
      assert.equal(dos.accepted.supplemental.stale_manifests, 1);
      // (b) Native supersede.
      dosDecision = await decisionOf(dos.policyId);
      const supersede = await post('/v1/decisions/supersede', { idempotency_key: key('sup'), supersede_reason: 'Replaced',
        source_decisions: [{ id: dosDecision.id, base_version: Number(dosDecision.version) }],
        replacement: { id: uuid(), scope: 'global', record_schema_version: 1, title: 'Replacement', content: 'New',
          type_fields: { rationale: 'Better' }, relations: { supersedes: [dosDecision.id] }, authority: 'user_explicit',
          source_refs: [], source_unavailable_reason: 'Synthetic fixture', confidence_reason: 'S4 fixture' } });
      assert.equal(supersede.body.status, 'committed', JSON.stringify(supersede.body));
      await refusedWith('policy_decision_changed');
      dos = await accept(dosDoc, 2);
      assert.equal(dos.issued.decision_operation, 'create', 'a superseded Decision is replaced by a new one');
      packOk(await compileDos(), 'dos v3');
      // (c) Native close.
      dosDecision = await decisionOf(dos.policyId);
      assert.equal((await post('/v1/records', { operation: 'close', id: dosDecision.id, record_type: 'decision',
        record_schema_version: 1, lifecycle_status: 'archived', scope: 'global', idempotency_key: key('close'),
        authority: 'user_explicit', confidence_reason: 'S4 DoS probe', base_version: Number(dosDecision.version),
        mutation: { closure_summary: 'Closed' } })).body.status, 'committed');
      await refusedWith('policy_decision_changed');
      dos = await accept(dosDoc, 3);
      assert.equal(dos.issued.decision_operation, 'create');
      packOk(await compileDos(), 'dos v4');
      // (d) Binding update (DoS, never a policy change).
      dosDecision = await decisionOf(dos.policyId);
      const bindingEdit = await call('clued_record_mutate', decisionUpdate(dosDecision.id, Number(dosDecision.version),
        { observed_at: '2020-01-01T00:00:00Z', mutation: { title: 'Agent edit', closure_summary: 'AGENT-INJECTED summary',
          closed_reason: 'AGENT-INJECTED reason', type_fields: { rationale: 'x', constraint: true,
            agent_injected: 'AGENT-INJECTED key', context_policy: {
            schema: 'clued.context-policy.v1', task_class: 'dos.check', policy_version: 99,
            policy_digest: 'e'.repeat(64) } }, relations: { agent_injected: ['AGENT-INJECTED relation'] } } }));
      assert.equal(bindingEdit.status, 'committed', JSON.stringify(bindingEdit));
      await refusedWith('policy_decision_changed');
      assert.equal(await count('clued_private.context_policies', "task_class='dos.check' and status='active'"), 1);
      dos = await accept(dosDoc, 4);
      assert.equal(dos.issued.decision_operation, 'update');
      // Review m1: fields the agent injected are cleared by the confirmed body.
      assert.deepEqual([dos.issued.confirmation_view.decision_body.observed_at,
        dos.issued.confirmation_view.decision_body.mutation.closure_summary,
        dos.issued.confirmation_view.decision_body.mutation.closed_reason], [null, null, null]);
      assert.ok(!JSON.stringify(dos.issued.confirmation_view).includes('AGENT-INJECTED'));
      const reaccepted = (await admin.query(`select version,closure_summary,closed_reason,observed_at from public.clued_memories
        where id=$1`, [dos.accepted.supplemental.decision_record_id])).rows[0];
      assert.deepEqual([reaccepted.closure_summary, reaccepted.closed_reason, reaccepted.observed_at], [null, null, null],
        'no agent text reaches the human-confirmed Decision version');
      assert.equal(await confirmed(dos.accepted.supplemental.decision_record_id, Number(reaccepted.version)), true);
      // field_mode='replace': keys the Binding injected into type_fields and relations do not survive
      // into the confirmed version (record updates otherwise merge field by field).
      const reacceptedFields = (await admin.query('select type_fields,relations from public.clued_memories where id=$1',
        [dos.accepted.supplemental.decision_record_id])).rows[0];
      assert.deepEqual(reacceptedFields.type_fields, dos.issued.confirmation_view.decision_body.mutation.type_fields);
      assert.deepEqual(reacceptedFields.relations, dos.issued.confirmation_view.decision_body.mutation.relations);
      assert.equal(dos.issued.confirmation_view.decision_body.field_mode, 'replace');
      packOk(await compileDos(), 'dos v5');
      // (e) Binding supersede.
      dosDecision = await decisionOf(dos.policyId);
      const bindingSupersede = await call('clued_decision_supersede', { idempotency_key: key('bsup'), user_confirmed: true,
        supersede_reason: 'Agent replaced', source_decisions: [{ id: dosDecision.id, base_version: Number(dosDecision.version) }],
        replacement: { id: uuid(), scope: 'global', record_schema_version: 1, title: 'Agent replacement', content: 'New',
          type_fields: { rationale: 'Agent' }, relations: { supersedes: [dosDecision.id] }, authority: 'user_explicit',
          user_confirmed: true, source_refs: [], source_unavailable_reason: 'Synthetic fixture',
          confidence_reason: 'S4 fixture' } });
      assert.equal(bindingSupersede.status, 'committed', JSON.stringify(bindingSupersede));
      await refusedWith('policy_decision_changed');
      dos = await accept(dosDoc, 5);
      packOk(await compileDos(), 'dos v6');
      // (g) Tampered policy document (digest mismatch).
      await admin.query('set session_replication_role=replica');
      await admin.query(`update clued_private.context_policies set policy=jsonb_set(policy,'{max_items}','1'::jsonb)
        where id=$1`, [dos.policyId]);
      await admin.query('set session_replication_role=origin');
      await refusedWith('policy_digest_mismatch');
      dos = await accept(dosDoc, 6);
      packOk(await compileDos(), 'dos v7');
      // (f) A Binding work_log Event that shadows global decisions no longer
      // disables the policy: the approving Decision is judged on its own
      // lifecycle (Owner Decision 0b183c2e, contract 6.1).
      const resumed = await call('clued_session_resume', { context_key: 'global' });
      assert.ok(resumed.session_token, JSON.stringify(resumed));
      const shadowInput = { context_key: 'global', session_token: resumed.session_token,
        base_version: resumed.version, event_type: 'decision', payload: { note: 'Agent decision event' },
        idempotency_key: key('shadow') };
      const refused = await call('clued_append_event', shadowInput);
      assert.equal(refused.status, 'rejected', JSON.stringify(refused));
      assert.equal(refused.error.code, 'decision_event_requires_record');
      // Seed the same Event as a pre-guard row to keep exercising the shadow.
      const shadow = (await admin.query('select clued_private.clued_mcp_append_event_unguarded($1,$2) value',
        [sha256(rawBinding), shadowInput])).rows[0].value;
      assert.equal(shadow.status, 'appended', JSON.stringify(shadow));
      assert.equal((await admin.query('select clued_private.record_currentness_fence($1,$2,null) f',
        [userId, (await decisionOf(dos.policyId)).id])).rows[0].f, 'SHADOWED_BY_ACTIVE_EVENT',
        'the generic fence still shadows the approving Decision');
      packOk(await compileDos(), 'dos v7 under an active global Event');
      assert.equal((await post('/v1/context/policies', acceptInput((await issuePolicy(dosDoc, 7)).body))).status, 200,
        'acceptance itself still commits');
      packOk(await compileDos(), 'dos v8 under an active global Event');
    } finally {
      globalThis.fetch = previousFetch;
      console.warn = previousWarn;
    }

    // ---- Guard triggers.
    const anyPolicy = (await admin.query("select id from clued_private.context_policies where status='superseded' limit 1"))
      .rows[0].id;
    await assert.rejects(admin.query("update clued_private.context_policies set policy_digest=repeat('0',64) where id=$1",
      [anyPolicy]), /context_policy_immutable/);
    await assert.rejects(admin.query("update clued_private.context_policies set status='active',superseded_by=null,superseded_at=null,version=version+1 where id=$1",
      [anyPolicy]), /context_policy_immutable/);
    const staleManifest = (await admin.query('select id from clued_private.context_pack_manifests where stale limit 1')).rows[0].id;
    await assert.rejects(admin.query('update clued_private.context_pack_manifests set stale=false,stale_reason=null,stale_at=null where id=$1',
      [staleManifest]), /context_pack_manifest_immutable/, 'stale never reverts');
    const liveManifest = (await admin.query('select id from clued_private.context_pack_manifests where not stale limit 1')).rows[0].id;
    await assert.rejects(admin.query("update clued_private.context_pack_manifests set pack_digest=repeat('0',64) where id=$1",
      [liveManifest]), /context_pack_manifest_immutable/);
    await assert.rejects(admin.query("update clued_private.context_pack_manifests set stale=true,stale_reason='x',stale_at=now() where id=$1",
      [liveManifest]), /context_pack_manifest_immutable/, 'marking stale bumps the row version');
    const anyToken = (await admin.query("select id from clued_private.native_confirmation_tokens where consume_outcome='committed' limit 1"))
      .rows[0].id;
    await assert.rejects(admin.query("update clued_private.native_confirmation_tokens set view_digest=repeat('0',64) where id=$1",
      [anyToken]), /confirmation_token_immutable/);
    await assert.rejects(admin.query('update clued_private.native_confirmation_tokens set consumed_at=null,consumed_receipt_id=null,consume_outcome=null where id=$1',
      [anyToken]), /confirmation_token_immutable/);
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
