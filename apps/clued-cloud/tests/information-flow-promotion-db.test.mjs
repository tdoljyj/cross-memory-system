import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Information Flow M0-D slice S3 (contract M0DCloseout.v0.1 sections 4.3,
// 5.1, 6.3, 7): promotion, candidate_promotions, native_write_markers and the
// two-step Native confirmation guard, on the full migration chain.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S3_MIGRATION = '20260924190000_information_flow_promotion.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const stale = (sub, session = 'sess-main') =>
  ({ ...fresh(sub, session), amr: [{ method: 'password', timestamp: nowEpoch() - 16 * 60 }] });


const TEXT = 'Qingshi risk list confirmed. BLOCKER: fix the CRITICAL bug now, priority high, intake_kind TASK, owner_track BUSINESS_GROWTH.';
const segment = (segmentId) => ({
  schema_version: 'segment_input.v1', segment_id: segmentId,
  reference_time: '2026-09-23T10:00:00+08:00', timezone: 'Asia/Shanghai',
  messages: [{ message_id: 'msg_s3_a', evidence_id: 'ev_s3_a', author_role: 'user',
    created_at: '2026-09-23T09:58:00+08:00', context_only: false, content: TEXT }],
});
const item = (local, itemType, overrides = {}) => ({
  candidate_local_id: `item_${local}`, item_type: itemType,
  claim: `${itemType} claim: ${TEXT}`.slice(0, 300), summary: `${itemType} summary ${local}`.slice(0, 120),
  action_level: itemType === 'task' ? 'needs_action' : 'reference',
  priority: itemType === 'task' ? 'high' : null,
  entity_mentions: [{ type: 'project', mention: 'Qingshi', role: 'subject' }], topics: ['risk', 'BLOCKER'],
  temporal_mentions: [], source_anchors: [{ message_id: 'msg_s3_a', exact_quote: 'risk list confirmed' }],
  confidence: 0.99, uncertainties: [], sensitivity_hint: 'none', ...overrides,
});
const documentOf = (segmentId, items) => ({ schema_version: 'candidate_information.v1', segment_id: segmentId, items });

function findById(value, id) {
  if (Array.isArray(value)) {
    for (const child of value) { const found = findById(child, id); if (found) return found; }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (value.id === id) return value;
  for (const child of Object.values(value)) { const found = findById(child, id); if (found) return found; }
  return null;
}

test('Information Flow S3: promotion, markers and the two-step Native confirmation guard',
  { timeout: 600000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-if-s3-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await startCluster(server);
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
    // Later slices sort after S3; the chain before S3 is applied first, S3
    // itself after the pre-S3 fixture, and every later migration right after.
    const s3Index = migrations.indexOf(S3_MIGRATION);
    assert.ok(s3Index > 0, 'the S3 migration is in the chain');
    assert.ok(migrations.slice(0, s3Index).every((name) => name < S3_MIGRATION));
    const apply = async (name) => {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    };
    for (const name of migrations.slice(0, s3Index)) await apply(name);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'if-s3@example.invalid',now()),($2,'if-s3-other@example.invalid',now())`, [userId, otherUser]);
    const tokenA = hash();
    const tokenDoomed = hash();
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values
      ($1,'synthetic','Agent A',$2,array['context:read','context:write'],array['*']),
      ($1,'synthetic','Doomed agent',$3,array['context:read','context:write'],array['*'])`,
    [userId, tokenA, tokenDoomed]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    let workerCaller; // Native pre-S3 setup precedes creation of the gateway role.
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
    const issue = async (input, claims = fresh(userId)) => {
      await as(claims);
      return (await human.query('select public.clued_candidate_confirmation_issue_v1($1) v', [input])).rows[0].v;
    };
    const confirmed = async (id, version) => (await admin.query(
      'select clued_private.record_human_confirmed_v1($1,$2,$3) v', [userId, id, version])).rows[0].v;
    const noteInput = (id, title, extra = {}) => ({
      operation: 'create', id, record_type: 'note', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: `if-s3-note-${id}`, authority: 'user_explicit', user_confirmed: true,
      confidence: 1, confidence_reason: 'S3 fixture', source_refs: [], source_unavailable_reason: 'Synthetic fixture',
      mutation: { title, content: title, type_fields: { note_kind: 'general' }, relations: {} }, ...extra,
    });

    // ---- E2E-13 (c): no backfill. A Native write made before S3 stays unmarked.
    const preS3Record = uuid();
    const preS3Input = noteInput(preS3Record, 'Written before S3');
    assert.equal((await native('clued_user_record_mutate', preS3Input)).status, 'committed');
    await apply(S3_MIGRATION);
    for (const name of migrations.slice(s3Index + 1)) await apply(name);
    await allowRawTestBindings(admin);
    workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    assert.equal(await confirmed(preS3Record, 1), false, 'pre-S3 Native writes are not backfilled');
    const preS3Replay = await native('clued_user_record_mutate', preS3Input);
    assert.equal(preS3Replay.replayed, true);
    assert.equal(await confirmed(preS3Record, 1), false, 'a replay after S3 writes no marker');
    assert.equal((await admin.query('select count(*)::int n from clued_private.native_write_markers')).rows[0].n, 0);

    const counts = async () => (await admin.query(`select
        (select count(*)::int from public.clued_memories where user_id=$1) memories,
        (select count(*)::int from public.clued_audit_receipts where user_id=$1) receipts,
        (select count(*)::int from clued_private.candidate_confirmation_tokens where user_id=$1) tokens,
        (select count(*)::int from clued_private.candidate_promotions where user_id=$1) promotions,
        (select count(*)::int from clued_private.native_write_markers where user_id=$1) markers`, [userId])).rows[0];
    const heads = async () => (await admin.query(`select
        (select count(*)::int from clued_private.mtpe_intake_projection where user_id=$1) mtpe,
        (select coalesce(sum(snapshot_revision),0)::int from clued_private.scope_currentness_heads where user_id=$1) currentness`,
    [userId])).rows[0];
    const candidate = async (tier, id) => (await admin.query(
      `select status,version,promoted_record_id,promoted_version,decided_by,last_receipt_id
         from clued_private.${tier === 'information' ? 'information_candidates' : 'knowledge_candidates'} where id=$1`,
      [id])).rows[0];
    const receipt = async (id) => (await admin.query(
      'select status,error_code,operation_family,binding_id from public.clued_audit_receipts where id=$1', [id])).rows[0];
    const tokenRow = async (id) => (await admin.query(
      'select * from clued_private.candidate_confirmation_tokens where id=$1', [id])).rows[0];
    let submitCounter = 0;
    const submit = async (items, { via = 'native', scope = 'global', claims } = {}) => {
      submitCounter += 1;
      const segmentId = `seg_s3_${submitCounter}`;
      const input = { idempotency_key: `if-s3-submit-${submitCounter}-${uuid()}`, scope,
        segment: segment(segmentId), candidates: documentOf(segmentId, items) };
      const result = via === 'native' ? await native('clued_user_intake_submit', input, claims)
        : await agent(tokenA, 'clued_intake_submit', input);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return { input, ids: Object.fromEntries(result.supplemental.candidates.map((row) => [row.candidate_local_id, row.id])),
        submissionId: result.supplemental.submission_id };
    };
    const promoteInput = (tier, id, issued, overrides = {}) => ({ idempotency_key: `if-s3-promote-${uuid()}`, tier,
      candidate_id: id, base_version: issued.candidate_version, confirmation_token: issued.confirmation_token,
      view_digest: issued.view_digest, ...overrides });

    // ---- Grants and RLS: new tables are private; private helpers are not
    // executable; the three entries are authenticated-only.
    for (const table of ['candidate_confirmation_tokens', 'candidate_promotions', 'native_write_markers']) {
      await assert.rejects(anon.query(`select 1 from clued_private.${table}`), /permission denied/);
      await assert.rejects(human.query(`select 1 from clued_private.${table}`), /permission denied/);
      const meta = (await admin.query(`select c.relrowsecurity rls,
          has_table_privilege('anon',c.oid,'select,insert,update,delete') anon,
          has_table_privilege('authenticated',c.oid,'select,insert,update,delete') authenticated,
          has_table_privilege('service_role',c.oid,'select,insert,update,delete') service_role
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='clued_private' and c.relname=$1`, [table])).rows[0];
      assert.deepEqual(meta, { rls: true, anon: false, authenticated: false, service_role: false }, table);
    }
    const privateFns = ['candidate_confirmation_token_guard_v1()', 'promotion_marker_immutable_v1()',
      'native_auth_time_v1()', 'native_session_fresh_v1()', 'native_direct_session_v1()',
      'native_write_marker_v1(uuid,jsonb,text)', 'record_human_confirmed_v1(uuid,uuid,bigint)',
      'candidate_observed_evidence_ok_v1(uuid,uuid)', 'knowledge_lineage_ok_v1(uuid,jsonb)',
      'candidate_record_body_v1(uuid,text,uuid,jsonb,uuid)', 'candidate_lock_v1(uuid,text,uuid)',
      'candidate_transition_v1(uuid,text,uuid,text,uuid,uuid,bigint)',
      'candidate_confirmation_issue_core_v1(uuid,jsonb)', 'candidate_promote_core_v1(uuid,jsonb,text)',
      'candidate_reject_core_v1(uuid,jsonb,text)', 'intake_submit_core_v1(uuid,uuid,jsonb,text)',
      'intake_withdraw_core_v1(uuid,uuid,jsonb,text)'];
    for (const fn of privateFns) {
      const grants = (await admin.query(`select has_function_privilege('anon',$1::regprocedure,'execute') anon,
        has_function_privilege('authenticated',$1::regprocedure,'execute') authenticated,
        has_function_privilege('service_role',$1::regprocedure,'execute') service_role`,
      [`clued_private.${fn}`])).rows[0];
      assert.deepEqual(grants, { anon: false, authenticated: false, service_role: false }, fn);
    }
    const entries = (await admin.query(`select p.proname,
        has_function_privilege('anon',p.oid,'execute') anon,
        has_function_privilege('authenticated',p.oid,'execute') authenticated,
        has_function_privilege('service_role',p.oid,'execute') service_role,
        p.prosecdef definer, p.proconfig config
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'clued\\_candidate\\_%' order by 1`)).rows;
    assert.deepEqual(entries.map((row) => [row.proname, row.anon, row.authenticated, row.service_role, row.definer]), [
      ['clued_candidate_confirmation_issue_v1', false, true, false, true],
      ['clued_candidate_promote_v1', false, true, false, true],
      ['clued_candidate_reject_v1', false, true, false, true]]);
    for (const row of entries) assert.deepEqual(row.config, ['search_path=""'], row.proname);
    for (const name of ['clued_user_record_mutate(jsonb,text)', 'clued_user_decision_supersede(jsonb,text)']) {
      const grants = (await admin.query(`select has_function_privilege('anon',$1::regprocedure,'execute') anon,
        has_function_privilege('authenticated',$1::regprocedure,'execute') authenticated`, [`public.${name}`])).rows[0];
      assert.deepEqual(grants, { anon: false, authenticated: true }, name);
    }
    const oauthBody = (await admin.query(
      "select pg_get_functiondef('public.clued_oauth_call(text,jsonb)'::regprocedure) d")).rows[0].d;
    assert.ok(!/promote|confirmation|candidate_reject/.test(oauthBody), 'no delegated OAuth case reaches promotion');

    // ---- E2E-14 (S3 portion): Native /v1/records writes carry a positive marker.
    const nativeRecord = uuid();
    const created = await native('clued_user_record_mutate', noteInput(nativeRecord, 'Native record'));
    assert.equal(created.status, 'committed');
    assert.equal(await confirmed(nativeRecord, 1), true);
    const marker = (await admin.query('select * from clued_private.native_write_markers where record_id=$1',
      [nativeRecord])).rows[0];
    assert.deepEqual([marker.receipt_id, marker.record_version, marker.actor, marker.entry, marker.session_id],
      [created.receipt_id, '1', 'native_account_session', 'record_mutate', 'sess-main']);
    assert.ok(marker.auth_time instanceof Date);
    // The account result is unchanged by the marker write.
    assert.deepEqual(Object.keys(created).sort(), ['artifact_refs', 'canonical_version', 'committed_versions', 'error_code',
      'event_ids', 'evidence_ids', 'receipt_id', 'replayed', 'status', 'supplemental', 'target_refs']);
    const updateInput = (id, base, key, title) => ({ operation: 'update', id, record_type: 'note', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: key, authority: 'user_explicit', user_confirmed: true,
      confidence: 1, confidence_reason: 'S3 fixture', base_version: base, mutation: { title, content: title } });
    // A Binding update makes the new version Agent-authored.
    assert.equal((await agent(tokenA, 'clued_record_mutate',
      updateInput(nativeRecord, 1, 'if-s3-bnd-upd-1', 'Agent edit'))).status, 'committed');
    assert.equal(await confirmed(nativeRecord, 2), false);
    assert.equal(await confirmed(nativeRecord, 1), true, 'the marker stays bound to its exact version');
    assert.equal((await native('clued_user_record_mutate',
      updateInput(nativeRecord, 2, 'if-s3-nat-upd-1', 'Native re-confirm'))).status, 'committed');
    assert.equal(await confirmed(nativeRecord, 3), true);
    // Rejected and replayed Native writes add no marker.
    const markerCount = (await counts()).markers;
    const conflict = await native('clued_user_record_mutate', updateInput(nativeRecord, 1, 'if-s3-nat-upd-2', 'Stale'));
    assert.equal(conflict.status, 'rejected');
    assert.equal((await native('clued_user_record_mutate',
      updateInput(nativeRecord, 2, 'if-s3-nat-upd-1', 'Native re-confirm'))).replayed, true);
    assert.equal((await counts()).markers, markerCount);

    // Decision supersede: markers for the superseded and replacement versions.
    const decisionInput = (id, key) => ({ operation: 'create', id, record_type: 'decision', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: key, authority: 'user_explicit', confidence: 1,
      confidence_reason: 'S3 fixture', source_refs: [], source_unavailable_reason: 'Synthetic fixture',
      mutation: { title: `Decision ${key}`, content: 'Decide', type_fields: { rationale: 'Because' }, relations: {} } });
    const supersedeInput = (source, replacement, key) => ({ idempotency_key: key, supersede_reason: 'Replaced',
      source_decisions: [{ id: source, base_version: 1 }],
      replacement: { id: replacement, scope: 'global', record_schema_version: 1, title: 'Replacement', content: 'New',
        type_fields: { rationale: 'Better' }, relations: { supersedes: [source] }, authority: 'user_explicit',
        source_refs: [], source_unavailable_reason: 'Synthetic fixture', confidence_reason: 'S3 fixture' } });
    const decisionA = uuid();
    const replacementA = uuid();
    assert.equal((await native('clued_user_record_mutate', decisionInput(decisionA, 'if-s3-dec-a'))).status, 'committed');
    const superseded = await native('clued_user_decision_supersede', supersedeInput(decisionA, replacementA, 'if-s3-sup-a'));
    assert.equal(superseded.status, 'committed', JSON.stringify(superseded));
    assert.equal(await confirmed(decisionA, 2), true);
    assert.equal(await confirmed(replacementA, 1), true);
    assert.deepEqual((await admin.query(`select record_id::text,record_version::int,entry from clued_private.native_write_markers
      where receipt_id=$1 order by record_id`, [superseded.receipt_id])).rows,
    [{ record_id: decisionA, record_version: 2, entry: 'decision_supersede' },
      { record_id: replacementA, record_version: 1, entry: 'decision_supersede' }]
      .sort((a, b) => (a.record_id < b.record_id ? -1 : 1)));
    // A delegated OAuth JWT is refused on supersede (the v12 guard, restored by
    // 20260924230000 after S3 dropped it) and on /v1/records; nothing commits.
    const delegated = { ...fresh(userId), client_id: 'delegated-oauth' };
    const decisionB = uuid();
    const replacementB = uuid();
    assert.equal((await native('clued_user_record_mutate', decisionInput(decisionB, 'if-s3-dec-b'))).status, 'committed');
    const receiptsBeforeDelegated = (await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n;
    await assert.rejects(native('clued_user_decision_supersede',
      supersedeInput(decisionB, replacementB, 'if-s3-sup-b'), delegated), /direct_human_session_required/);
    assert.equal((await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n,
      receiptsBeforeDelegated, 'a refused delegated supersede writes no Receipt');
    assert.equal((await admin.query('select count(*)::int n from public.clued_memories where id=$1', [replacementB])).rows[0].n, 0);
    assert.equal(await confirmed(decisionB, 1), true, 'the Decision stays at its Native version');
    await assert.rejects(native('clued_user_record_mutate', noteInput(uuid(), 'Delegated'), delegated),
      /direct_human_session_required/);

    // ---- E2E-13 (a)/(b) and E2E-11 observation.
    const maintenanceRecord = uuid();
    await admin.query('select clued_private.record_mutation_with_terminal_guard($1,null,$2,$3)',
      [userId, noteInput(maintenanceRecord, 'Maintenance write'), hash()]);
    assert.equal(await confirmed(maintenanceRecord, 1), false, 'a null-binding maintenance write is not human-confirmed');
    const proposeMaintenance = await agent(tokenA, 'clued_knowledge_propose', { idempotency_key: 'if-s3-kp-maint',
      scope: 'global', rule_id: 'knowledge.consolidate.v1', assertion: 'Maintenance citation',
      sources: [{ id: maintenanceRecord, version: 1 }] });
    assert.equal(proposeMaintenance.status, 'rejected');
    assert.match(proposeMaintenance.error_code, /knowledge_source_not_human_confirmed/);
    // E2E-11: the OD-5 bypass succeeds (observed behavior, not a pass) and reads false.
    const bypassRecord = uuid();
    const bypass = await agent(tokenDoomed, 'clued_record_mutate', noteInput(bypassRecord, 'Agent bypass write'));
    assert.equal(bypass.status, 'committed', 'E2E-11 OPEN_BY_OD-5: a Binding user_explicit write still commits');
    assert.equal(await confirmed(bypassRecord, 1), false);
    // E2E-13 (b): deleting the Binding nulls the Receipt binding_id; still false.
    await admin.query('delete from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1($1)', [tokenDoomed]);
    assert.equal((await receipt(bypass.receipt_id)).binding_id, null);
    assert.equal(await confirmed(bypassRecord, 1), false, 'a null binding_id alone never counts');

    // Marker immutability.
    await assert.rejects(admin.query("update clued_private.native_write_markers set entry='forged' where record_id=$1",
      [nativeRecord]), /promotion_marker_immutable/);

    // ---- Worker transport over this database. Only the PostgREST hop is
    // shimmed: an account JWT runs as `authenticated` with real claims
    // (sub, session_id, amr), the synthetic Worker credential as the real
    // gateway role. Unknown Authorization fails closed; direct anon SQL remains.
    const worker = await loadContinuityWorker();
    const gatewayToken = 'synthetic-information-flow-promotion-worker-gateway';
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await gateway.query('set session authorization authenticator; set role clued_worker_gateway');
    await gateway.query(`select set_config('request.jwt.claims','{"role":"clued_worker_gateway"}',false)`);
    const workerEnv = { PROJECT_VIEWS_V2: 'true', SUPABASE_URL: 'https://storage.clued.test',
      CLUED_DB_GATEWAY_TOKEN: gatewayToken,
      ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
    const rawBinding = `clued_bnd_${'s'.repeat(43)}`;
    const workerBindingId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Worker agent',$2,array['context:read','context:write'],array['*']) returning id`,
    [userId, sha256(rawBinding)])).rows[0].id;
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
        const value = (await client.query(`select public.${rpc}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) v`,
          keys.map((key) => body[key]))).rows[0].v;
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
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body) }), workerEnv, ctx);
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const mcp = async (method, params) => {
      const response = await worker.fetch(new Request('https://clued.test/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${rawBinding}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }), workerEnv, ctx);
      return await response.json();
    };
    const call = async (name, args) => {
      const envelope = await mcp('tools/call', { name, arguments: args });
      return envelope.result?.structuredContent ?? envelope.error ?? envelope;
    };
    try {
      // ---- E2E-01 (S3 portion): Native capture -> Candidate -> token -> Authority Information.
      const e01Segment = segment('seg_s3_e01');
      const e01 = await post('/v1/intake', { idempotency_key: 'if-s3-e01-submit', scope: 'global',
        segment: e01Segment, candidates: documentOf('seg_s3_e01', [item('e01', 'fact')]) });
      assert.equal(e01.status, 200, JSON.stringify(e01.body));
      const e01Id = e01.body.supplemental.candidates[0].id;
      const e01Confirmation = await post(`/v1/intake/${e01Id}/confirmation`, { base_version: 1, authority: 'observed' });
      assert.equal(e01Confirmation.status, 200, JSON.stringify(e01Confirmation.body));
      assert.equal(e01Confirmation.headers.get('pragma'), 'no-cache');
      const view = e01Confirmation.body;
      assert.equal(view.status, 'issued');
      assert.match(view.confirmation_token, /^clued_cft_[0-9a-f]{64}$/);
      assert.equal(view.authoritative, false);
      assert.equal(view.view_digest, (await admin.query('select clued_private.m1_sha256($1::jsonb) v',
        [view.confirmation_view])).rows[0].v, 'the digest covers the exact rendered view');
      const storedToken = await tokenRow(view.token_id);
      assert.equal(storedToken.token_hash, sha256(view.confirmation_token));
      assert.ok(!JSON.stringify(storedToken).includes(view.confirmation_token), 'the raw token is never stored');
      assert.equal(storedToken.session_id, 'sess-main');
      assert.ok(storedToken.expires_at - storedToken.issued_at === 5 * 60 * 1000, 'TTL is five minutes');
      const e01Promote = await post(`/v1/intake/${e01Id}/promote`, { idempotency_key: 'if-s3-promo-0101',
        base_version: 1, confirmation_token: view.confirmation_token, view_digest: view.view_digest });
      assert.equal(e01Promote.status, 200, JSON.stringify(e01Promote.body));
      assert.equal(e01Promote.body.status, 'committed');
      const e01Out = e01Promote.body.supplemental;
      assert.deepEqual([e01Out.outcome, e01Out.record_id, e01Out.record_version, e01Out.authority],
        ['promoted', view.record_id, 1, 'observed']);
      const record = (await admin.query('select * from public.clued_memories where id=$1', [view.record_id])).rows[0];
      const cv = view.confirmation_view;
      assert.deepEqual([record.version, record.record_type, record.title, record.content, record.authority,
        record.canonical_scope, record.lifecycle_status, record.confidence_reason],
      ['1', cv.record_type, cv.mutation.title, cv.mutation.content, cv.authority, cv.scope, 'active', cv.confidence_reason]);
      assert.deepEqual(record.type_fields, cv.mutation.type_fields);
      const evidenceId = (await admin.query('select evidence_id from clued_private.information_intake_submissions where id=$1',
        [e01.body.supplemental.submission_id])).rows[0].evidence_id;
      assert.deepEqual(record.source_refs, [evidenceId]);
      const evidence = (await admin.query(`select e.content_hash,s.segment_sha256,clued_private.m1_sha256($2::jsonb) computed
        from public.clued_evidence e join clued_private.information_intake_submissions s on s.evidence_id=e.id
        where e.id=$1`, [evidenceId, e01Segment])).rows[0];
      assert.equal(evidence.content_hash, evidence.segment_sha256);
      assert.equal(evidence.content_hash, evidence.computed, 'server-computed hash over the submitted segment');
      const promotion = (await admin.query('select * from clued_private.candidate_promotions where record_id=$1',
        [view.record_id])).rows[0];
      assert.deepEqual([promotion.receipt_id, promotion.promotion_receipt_id, promotion.origin_principal,
        promotion.origin_binding_id, promotion.confirming_principal, promotion.confirming_session_id, promotion.token_id,
        promotion.view_digest, promotion.authority, promotion.record_version],
      [record.receipt_id, e01Promote.body.receipt_id, 'native_ui', null, 'native_account_session', 'sess-main',
        view.token_id, view.view_digest, 'observed', '1']);
      assert.equal((await receipt(record.receipt_id)).operation_family, 'record_mutation');
      assert.equal((await receipt(record.receipt_id)).binding_id, null);
      assert.equal(await confirmed(view.record_id, 1), true);
      assert.deepEqual(await candidate('information', e01Id), { status: 'promoted', version: 2,
        promoted_record_id: view.record_id, promoted_version: 1, decided_by: 'native_ui',
        last_receipt_id: e01Promote.body.receipt_id });
      const consumed = await tokenRow(view.token_id);
      assert.deepEqual([consumed.consume_outcome, consumed.consumed_receipt_id], ['promoted', e01Promote.body.receipt_id]);
      const promoteEvent = (await admin.query('select * from public.clued_context_events where id=$1::bigint',
        [e01Promote.body.event_ids[0]])).rows[0];
      assert.deepEqual([promoteEvent.event_type, promoteEvent.canonical_event_type, promoteEvent.audit_visibility],
        ['action', 'extension:information_flow:candidate_promoted', 'audit_only']);
      assert.ok(promoteEvent.target_refs.every((ref) => ref.kind === 'system' || ref.kind === 'evidence'));
      assert.ok(!JSON.stringify(promoteEvent).includes(view.confirmation_token), 'the token never reaches an Event');
      assert.equal((await admin.query('select count(*)::int n from clued_private.event_truth_carriers where event_id=$1',
        [promoteEvent.id])).rows[0].n, 0);
      // The Agent reads the Record at its exact version.
      const listed = findById(await call('clued_record_list', { record_type: 'note' }), view.record_id);
      assert.ok(listed, 'the promoted Record is visible to the Agent');
      assert.equal(Number(listed.version), 1);
      // No Context Policy is accepted in this test, so the pack fails closed.
      assert.equal((await call('clued_context_pack', { scope: 'global' })).error_code, 'CONTEXT_POLICY_REQUIRED');
      // Idempotent replay of the same key and body.
      const e01Replay = await post(`/v1/intake/${e01Id}/promote`, { idempotency_key: 'if-s3-promo-0101',
        base_version: 1, confirmation_token: view.confirmation_token, view_digest: view.view_digest });
      assert.equal(e01Replay.status, 200);
      assert.deepEqual([e01Replay.body.replayed, e01Replay.body.receipt_id], [true, e01Promote.body.receipt_id]);

      // ---- E2E-02: an Agent candidate cannot be promoted by the Binding.
      const e02Segment = segment('seg_s3_e02');
      const e02Submit = await call('clued_intake_submit', { idempotency_key: 'if-s3-e02-submit', scope: 'global',
        segment: e02Segment, candidates: documentOf('seg_s3_e02', [item('e02', 'fact')]) });
      assert.equal(e02Submit.status, 'committed', JSON.stringify(e02Submit));
      const e02Id = e02Submit.supplemental.candidates[0].id;
      const before02 = await counts();
      for (const body of [{ idempotency_key: 'if-s3-e02-i', base_version: 1, authority: 'user_explicit', user_confirmed: true },
        { idempotency_key: 'if-s3-e02-ii', base_version: 1, record_type: 'note', authority: 'observed' }]) {
        const rpcsBefore = rpcLog.length;
        const warningsBefore = warnings.length;
        const refused = await post(`/v1/intake/${e02Id}/promote`, body, rawBinding);
        assert.equal(refused.status, 401);
        assert.equal(rpcLog.length, rpcsBefore, 'no RPC ran');
        assert.equal(warnings.length, warningsBefore + 1, 'the refusal is logged');
        assert.deepEqual(JSON.parse(warnings.at(-1)), { event: 'information_flow_native_route_denied', route: 'promote',
          tier: 'information', reason: 'binding_or_missing_token' });
      }
      assert.equal((await post(`/v1/intake/${e02Id}/confirmation`, { base_version: 1, authority: 'user_explicit' },
        rawBinding)).status, 401);
      assert.equal((await post(`/v1/intake/${e02Id}/reject`, { idempotency_key: 'if-s3-e02-rej', base_version: 1 },
        rawBinding)).status, 401);
      // (iii) A direct Binding-role call has no execute grant: 42501, no Receipt.
      for (const [name, args] of [['clued_candidate_promote_v1', [{ idempotency_key: 'if-s3-e02-iii', tier: 'information',
        candidate_id: e02Id, base_version: 1 }, hash()]], ['clued_candidate_confirmation_issue_v1', [{ tier: 'information',
        candidate_id: e02Id, base_version: 1, authority: 'user_explicit' }]], ['clued_candidate_reject_v1',
        [{ idempotency_key: 'if-s3-e02-iii-r', tier: 'information', candidate_id: e02Id, base_version: 1 }, hash()]]]) {
        await assert.rejects(anon.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args),
          (error) => error.code === '42501' && /permission denied/.test(error.message), name);
      }
      assert.deepEqual(await counts(), before02, 'no Receipt, token or Record');
      // MCP exposes no promotion tool.
      const tools = (await mcp('tools/list', {})).result.tools.map((tool) => tool.name);
      assert.ok(!tools.some((name) => /promot|confirm|reject/.test(name)), tools.join(','));
      const unknownTool = await mcp('tools/call', { name: 'clued_candidate_promote_v1', arguments: {} });
      assert.ok(unknownTool.error || unknownTool.result?.isError, JSON.stringify(unknownTool));
      assert.equal((await candidate('information', e02Id)).status, 'pending');

      // Issue and consume in one request (transaction) are rejected (DB level;
      // no Worker request can run both RPCs).
      await as(fresh(userId));
      await human.query('begin');
      const sameIssued = (await human.query('select public.clued_candidate_confirmation_issue_v1($1) v',
        [{ tier: 'information', candidate_id: e02Id, base_version: 1, authority: 'user_explicit' }])).rows[0].v;
      assert.equal(sameIssued.status, 'issued', JSON.stringify(sameIssued));
      const sameInput = promoteInput('information', e02Id, sameIssued);
      const samePromote = (await human.query('select public.clued_candidate_promote_v1($1,$2) v',
        [sameInput, sha256(JSON.stringify(sameInput))])).rows[0].v;
      await human.query('commit');
      assert.deepEqual([samePromote.status, samePromote.error_code], ['rejected', 'confirmation_token_same_request']);
      assert.equal((await receipt(samePromote.receipt_id)).status, 'rejected');
      assert.equal((await tokenRow(sameIssued.token_id)).consume_outcome, 'rejected', 'the presented token is burned');
      assert.equal((await candidate('information', e02Id)).status, 'pending');

      // An expired token (TTL passed) is rejected with a Receipt.
      const expiring = await post(`/v1/intake/${e02Id}/confirmation`, { base_version: 1, authority: 'user_explicit' });
      assert.equal(expiring.body.status, 'issued');
      await admin.query('set session_replication_role=replica');
      await admin.query(`update clued_private.candidate_confirmation_tokens
        set issued_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '5 minutes' where id=$1`,
      [expiring.body.token_id]);
      await admin.query('set session_replication_role=origin');
      const expired = await post(`/v1/intake/${e02Id}/promote`, promoteInput('information', e02Id, expiring.body));
      assert.equal(expired.status, 403);
      assert.deepEqual([expired.body.status, expired.body.error_code], ['rejected', 'confirmation_token_expired']);
      assert.ok(expired.body.receipt_id);
      // A delegated OAuth session cannot obtain a token.
      const tokensBefore = (await counts()).tokens;
      const delegatedIssue = await post(`/v1/intake/${e02Id}/confirmation`, { base_version: 1, authority: 'user_explicit' },
        'delegated-jwt');
      assert.equal(delegatedIssue.status, 403);
      assert.match(JSON.stringify(delegatedIssue.body), /direct_human_session_required/);
      // A stale session (authenticated more than 15 minutes ago) gets a step-up challenge.
      const staleIssue = await post(`/v1/intake/${e02Id}/confirmation`, { base_version: 1, authority: 'user_explicit' },
        'stale-jwt');
      assert.equal(staleIssue.status, 401);
      assert.equal(staleIssue.body.error_code, 'reauthentication_required');
      assert.match(staleIssue.headers.get('www-authenticate'), /insufficient_user_authentication.*max_age="900"/);
      assert.equal((await counts()).tokens, tokensBefore, 'no token row for refused sessions');
      // A token issued to a fresh session and presented after the session went stale.
      const staleLater = await post(`/v1/intake/${e02Id}/confirmation`, { base_version: 1, authority: 'user_explicit' });
      const staleConsume = await post(`/v1/intake/${e02Id}/promote`, promoteInput('information', e02Id, staleLater.body),
        'stale-jwt');
      assert.equal(staleConsume.status, 401);
      assert.deepEqual([staleConsume.body.status, staleConsume.body.error_code], ['rejected', 'reauthentication_required']);
      assert.ok(staleConsume.headers.get('www-authenticate'));
      // A token from another session of the same account is bound to its session.
      const otherSession = await post(`/v1/intake/${e02Id}/confirmation`, { base_version: 1, authority: 'user_explicit' });
      const crossSession = await post(`/v1/intake/${e02Id}/promote`, promoteInput('information', e02Id, otherSession.body),
        'second-session-jwt');
      assert.equal(crossSession.status, 403);
      assert.equal(crossSession.body.error_code, 'confirmation_token_binding_mismatch');
      // A foreign user's token is invisible: invalid.
      const foreignSubmit = await submit([item('foreign', 'fact')], { claims: fresh(otherUser, 'sess-other') });
      const foreignIssued = await post(`/v1/intake/${foreignSubmit.ids.item_foreign}/confirmation`,
        { base_version: 1, authority: 'user_explicit' }, 'other-jwt');
      assert.equal(foreignIssued.body.status, 'issued', JSON.stringify(foreignIssued.body));
      const foreign = await post(`/v1/intake/${e02Id}/promote`, promoteInput('information', e02Id, foreignIssued.body));
      assert.equal(foreign.status, 403);
      assert.equal(foreign.body.error_code, 'confirmation_token_invalid');
      assert.equal((await tokenRow(foreignIssued.body.token_id)).consumed_at, null, 'a foreign token is not touched');
      assert.equal((await candidate('information', e02Id)).status, 'pending');
      assert.equal(before02.memories, (await counts()).memories, 'no Record from any refused attempt');

      // A later valid Native confirmation succeeds, with the Agent origin kept.
      const valid = await post(`/v1/intake/${e02Id}/confirmation`, { base_version: 1, authority: 'user_explicit' });
      const validInput = promoteInput('information', e02Id, valid.body);
      const promoted = await post(`/v1/intake/${e02Id}/promote`, validInput);
      assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
      assert.equal(promoted.body.supplemental.outcome, 'promoted');
      const agentOrigin = (await admin.query('select origin_principal,origin_binding_id,authority from clued_private.candidate_promotions where candidate_id=$1',
        [e02Id])).rows[0];
      assert.deepEqual(agentOrigin, { origin_principal: 'agent_binding', origin_binding_id: workerBindingId,
        authority: 'user_explicit' });
      assert.equal((await receipt((await admin.query('select receipt_id from public.clued_memories where id=$1',
        [valid.body.record_id])).rows[0].receipt_id)).binding_id, null);
      assert.equal(await confirmed(valid.body.record_id, 1), true);
      // Replayed (consumed) token with a new key: rejected.
      const reused = await post(`/v1/intake/${e02Id}/promote`, { ...validInput, idempotency_key: 'if-s3-e02-reuse' });
      assert.equal(reused.status, 403);
      assert.equal(reused.body.error_code, 'confirmation_token_reused');
      // Same key and body: the committed result replays.
      const replayed = await post(`/v1/intake/${e02Id}/promote`, validInput);
      assert.deepEqual([replayed.status, replayed.body.replayed, replayed.body.receipt_id],
        [200, true, promoted.body.receipt_id]);
      // Same key, different body: idempotency conflict.
      const keyConflict = await post(`/v1/intake/${e02Id}/promote`, { ...validInput, view_digest: 'f'.repeat(64) });
      assert.equal(keyConflict.body.error_code, 'IDEMPOTENCY_KEY_CONFLICT');
      // A live token presented under a conflicting idempotency key is burned too (D4).
      const burnId = (await submit([item('burn', 'fact')])).ids.item_burn;
      const burnIssued = await post(`/v1/intake/${burnId}/confirmation`, { base_version: 1, authority: 'user_explicit' });
      assert.equal(burnIssued.body.status, 'issued', JSON.stringify(burnIssued.body));
      const burnConflict = await post(`/v1/intake/${burnId}/promote`,
        { ...promoteInput('information', burnId, burnIssued.body), idempotency_key: validInput.idempotency_key });
      assert.equal(burnConflict.body.error_code, 'IDEMPOTENCY_KEY_CONFLICT');
      const burnedToken = await tokenRow(burnIssued.body.token_id);
      assert.deepEqual([burnedToken.consume_outcome, burnedToken.consumed_receipt_id],
        ['rejected', burnConflict.body.receipt_id]);
      assert.equal((await candidate('information', burnId)).status, 'pending');

      // ---- E2E-15: direct PostgREST calls with a valid user JWT; each is a
      // rejected Receipt, the candidate stays pending, no Record changes.
      const e15 = await submit([item('e15a', 'fact'), item('e15b', 'fact')]);
      const e15Id = e15.ids.item_e15a;
      const e15Other = e15.ids.item_e15b;
      const direct = async (input, claims = fresh(userId)) => {
        const memoriesBefore = (await counts()).memories;
        const result = await native('clued_candidate_promote_v1', input, claims);
        assert.equal(result.status, 'rejected', JSON.stringify(result));
        assert.equal((await receipt(result.receipt_id)).status, 'rejected');
        assert.equal((await candidate('information', e15Id)).status, 'pending');
        assert.equal((await counts()).memories, memoriesBefore);
        return result.error_code;
      };
      const issue15 = async (id = e15Id, extra = {}) => {
        const result = await issue({ tier: 'information', candidate_id: id, base_version: 1, authority: 'user_explicit',
          ...extra });
        assert.equal(result.status, 'issued', JSON.stringify(result));
        return result;
      };
      assert.equal(await direct({ idempotency_key: 'if-s3-e15-none', tier: 'information', candidate_id: e15Id,
        base_version: 1, view_digest: 'a'.repeat(64) }), 'confirmation_token_required');
      assert.equal(await direct({ idempotency_key: 'if-s3-e15-num', tier: 'information', candidate_id: e15Id,
        base_version: 1, view_digest: 'a'.repeat(64), confirmation_token: 7 }), 'confirmation_token_required');
      const e15Expired = await issue15();
      await admin.query('set session_replication_role=replica');
      await admin.query(`update clued_private.candidate_confirmation_tokens
        set issued_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' where id=$1`,
      [e15Expired.token_id]);
      await admin.query('set session_replication_role=origin');
      assert.equal(await direct(promoteInput('information', e15Id, e15Expired)), 'confirmation_token_expired');
      const e15Once = await issue15();
      assert.equal(await direct(promoteInput('information', e15Id, e15Once, { view_digest: 'b'.repeat(64) })),
        'confirmation_token_binding_mismatch', 'view_digest mismatch');
      assert.equal(await direct(promoteInput('information', e15Id, e15Once)), 'confirmation_token_reused',
        'a token presented once is burned (single use)');
      const e15ForOther = await issue15(e15Other);
      assert.equal(await direct(promoteInput('information', e15Id, e15ForOther)), 'confirmation_token_binding_mismatch',
        'a token for another candidate');
      const e15Stale = await issue15();
      assert.equal(await direct(promoteInput('information', e15Id, e15Stale), stale(userId)), 'reauthentication_required');
      const noAmr = await issue15();
      assert.equal(await direct(promoteInput('information', e15Id, noAmr),
        { sub: userId, role: 'authenticated', session_id: 'sess-main' }), 'reauthentication_required',
      'no auth_time and no amr fails closed');
      // auth_time, when present, is used instead of amr.
      const withAuthTime = await issue({ tier: 'information', candidate_id: e15Id, base_version: 1,
        authority: 'user_explicit' }, { sub: userId, session_id: 'sess-main', auth_time: nowEpoch() - 20 * 60,
        amr: [{ method: 'password', timestamp: nowEpoch() }] });
      assert.equal(withAuthTime.error_code, 'reauthentication_required');
      const futureAuth = await issue({ tier: 'information', candidate_id: e15Id, base_version: 1,
        authority: 'user_explicit' }, { sub: userId, session_id: 'sess-main', amr: [{ method: 'password',
        timestamp: nowEpoch() + 3600 }] });
      assert.equal(futureAuth.error_code, 'reauthentication_required', 'a future auth time fails closed');
      // (a) Caller-asserted Evidence or authority cannot ride on either step.
      const e15Live = await issue15();
      for (const key of ['source_refs', 'evidence_ids', 'authority', 'user_confirmed', 'record_type', 'scope',
        'native_type_fields']) {
        assert.equal(await direct(promoteInput('information', e15Id, e15Live,
          { idempotency_key: `if-s3-e15-${key}`, [key]: key === 'user_confirmed' ? true : [evidenceId] })),
        'candidate_promote_unknown_field', key);
      }
      for (const key of ['source_refs', 'evidence_ids', 'confirmation_token', 'record_type', 'scope', 'title', 'content',
        'user_confirmed']) {
        const refused = await issue({ tier: 'information', candidate_id: e15Id, base_version: 1, authority: 'observed',
          [key]: [evidenceId] });
        assert.deepEqual([refused.status, refused.error_code], ['rejected', 'candidate_confirmation_unknown_field'], key);
      }
      // (b) Defense in depth: Evidence with a caller-asserted hash never
      // qualifies for observed, even when the candidate row points at it.
      const asserted = await native('clued_user_evidence_ingest', { idempotency_key: 'if-s3-e15-asserted',
        evidence_schema_version: 1, evidence_type: 'file', storage_ref: `intake:${e15.submissionId}`,
        content_hash: (await admin.query('select segment_sha256 from clued_private.information_intake_submissions where id=$1',
          [e15.submissionId])).rows[0].segment_sha256, mime_type: 'application/json', size_bytes: 1 });
      assert.equal(asserted.status, 'committed', JSON.stringify(asserted));
      const assertedId = asserted.evidence_ids[0];
      const observedOk = await issue15(e15Id, { authority: 'observed' });
      await admin.query('update clued_private.information_candidates set evidence_ids=array[$2::uuid] where id=$1',
        [e15Other, assertedId]);
      const assertedIssue = await issue({ tier: 'information', candidate_id: e15Other, base_version: 1, authority: 'observed' });
      assert.deepEqual([assertedIssue.status, assertedIssue.error_code],
        ['rejected', 'observed_requires_server_computed_evidence']);
      // A pre-issued observed token: the Evidence linkage is broken after issue.
      await admin.query('set session_replication_role=replica');
      const e15EvidenceId = (await admin.query('select evidence_id from clued_private.information_intake_submissions where id=$1',
        [e15.submissionId])).rows[0].evidence_id;
      await admin.query('update public.clued_evidence set content_hash=$2 where id=$1', [e15EvidenceId, hash()]);
      await admin.query('set session_replication_role=origin');
      assert.equal(await direct(promoteInput('information', e15Id, observedOk)), 'observed_requires_server_computed_evidence');
      // user_explicit does not depend on the Evidence hash; the candidate is still promotable.
      const e15Final = await issue15();
      const e15Promoted = await native('clued_candidate_promote_v1', promoteInput('information', e15Id, e15Final));
      assert.equal(e15Promoted.supplemental?.outcome, 'promoted', JSON.stringify(e15Promoted));

      // ---- Mapping table (D8), stripped keys (E2E-10) and the step-2 allow-list.
      const mapped = await submit(['fact', 'preference', 'decision', 'task', 'status', 'event', 'artifact', 'issue',
        'unclassified'].map((type) => item(type, type)));
      const expected = {
        fact: ['note', { note_kind: 'fact' }], preference: ['profile_fact', { fact_kind: 'preference' }],
        decision: ['decision', { rationale: item('decision', 'decision').claim }],
        task: ['task', { execution_bucket: 'later' }], status: ['state', { state_kind: 'status' }],
        event: ['note', { note_kind: 'event' }], artifact: ['note', { note_kind: 'artifact' }],
        issue: ['note', { note_kind: 'issue' }], unclassified: ['note', { note_kind: 'unclassified' }],
      };
      const views = {};
      for (const [type, [recordType, typeFields]] of Object.entries(expected)) {
        const id = mapped.ids[`item_${type}`];
        const issued = await issue({ tier: 'information', candidate_id: id, base_version: 1, authority: 'user_explicit',
          ...(type === 'task' ? { native_type_fields: { execution_bucket: 'later' } } : {}) });
        assert.equal(issued.status, 'issued', `${type} ${JSON.stringify(issued)}`);
        const inputDigest = (await admin.query('select input_digest from clued_private.information_candidates where id=$1',
          [id])).rows[0].input_digest;
        assert.equal(issued.confirmation_view.record_type, recordType, type);
        assert.deepEqual(issued.confirmation_view.mutation.type_fields, { ...typeFields, information_flow: {
          schema: 'clued.promotion.v1', candidate_id: id, item_type: type, input_digest: inputDigest } }, type);
        assert.deepEqual([issued.confirmation_view.mutation.title, issued.confirmation_view.mutation.content],
          [item(type, type).summary, item(type, type).claim]);
        assert.equal(issued.confirmation_view.confidence, null, 'the item confidence never reaches the Record');
        assert.deepEqual(issued.confirmation_view.mutation.relations, {});
        views[type] = { id, issued };
      }
      const allowListCases = [
        ['fact', { native_type_fields: { governance_profile: 'OUT_OF_GOVERNANCE_PROFILE' } }, /^native_type_field_not_allowed:governance_profile$/],
        ['fact', { native_type_fields: { priority: 90 } }, /^native_type_field_not_allowed:priority$/],
        ['fact', { native_type_fields: { execution_bucket: 'now' } }, /^native_type_field_not_allowed:execution_bucket$/],
        ['fact', { native_type_fields: { state_kind: 'risk' } }, /^native_type_field_not_allowed:state_kind$/],
        ['fact', { native_type_fields: { note_kind: 'fact' } }, /^native_type_field_invalid:note_kind$/],
        ['fact', { native_type_fields: { criticality: 'URGENT' } }, /^native_type_field_invalid:criticality$/],
        ['fact', { native_type_fields: { current_frontier_blocking: 'yes' } }, /^native_type_field_invalid:current_frontier_blocking$/],
        ['fact', { native_type_fields: [] }, /^invalid_native_type_fields$/],
        ['task', {}, /^execution_bucket_required$/],
        ['task', { native_type_fields: { execution_bucket: 'soon' } }, /^native_type_field_invalid:execution_bucket$/],
        // 20261031070000: the Owner's custom priority is set on /priority, not here.
        ['task', { native_type_fields: { execution_bucket: 'later', priority: 70 } }, /^native_type_field_not_allowed:priority$/],
        ['status', { native_type_fields: { state_kind: 'status' } }, /^native_type_field_invalid:state_kind$/],
        ['decision', { native_type_fields: { rationale: '' } }, /^native_type_field_invalid:rationale$/],
        ['fact', { authority: null }, /^authority_required$/],
        ['fact', { authority: 'imported' }, /^authority_not_permitted$/],
        ['fact', { authority: 'self_asserted' }, /^invalid_authority$/],
        ['fact', { authority: 'inferred' }, /^inferred_confidence_required$/],
        ['fact', { authority: 'inferred', confidence: 1.5 }, /^invalid_confidence$/],
        ['fact', { confidence_reason: '   ' }, /^invalid_confidence_reason$/],
        ['fact', { base_version: 2 }, /^candidate_version_conflict$/],
        ['fact', { candidate_id: uuid() }, /^candidate_not_found$/],
        ['fact', { tier: 'authority' }, /^invalid_confirmation_input$/],
      ];
      for (const [type, overrides, pattern] of allowListCases) {
        const input = { tier: 'information', candidate_id: views[type].id, base_version: 1, authority: 'user_explicit',
          ...overrides };
        if (input.authority === null) delete input.authority;
        const refused = await issue(input);
        assert.equal(refused.status, 'rejected', `${type} ${JSON.stringify(overrides)}`);
        assert.match(refused.error_code, pattern, `${type} ${JSON.stringify(overrides)}`);
      }
      // Explicit Native choices are carried into the digest-bound view.
      const chosen = await issue({ tier: 'information', candidate_id: views.task.id, base_version: 1, authority: 'inferred',
        confidence: 0.4, confidence_reason: 'Owner judgement', native_type_fields: { execution_bucket: 'next',
          criticality: 'HIGH', owner_track: 'PRODUCT_EXPERIENCE', current_frontier_blocking: true, intake_kind: 'TASK' } });
      assert.equal(chosen.status, 'issued', JSON.stringify(chosen));
      assert.deepEqual([chosen.confirmation_view.authority, chosen.confirmation_view.confidence,
        chosen.confirmation_view.confidence_reason], ['inferred', 0.4, 'Owner judgement']);
      assert.equal(chosen.confirmation_view.mutation.type_fields.criticality, 'HIGH');
      assert.notEqual(chosen.view_digest, views.task.issued.view_digest, 'every choice is inside the digest');
      assert.equal((await tokenRow(views.task.issued.token_id)).revoked_at instanceof Date, true,
        'issuing revokes the previous live token');
      const decisionRationale = await issue({ tier: 'information', candidate_id: views.decision.id, base_version: 1,
        authority: 'user_explicit', native_type_fields: { rationale: 'Owner rationale', decision_follow_up: false } });
      assert.equal(decisionRationale.confirmation_view.mutation.type_fields.rationale, 'Owner rationale');

      // E2E-10: promotion to task touches MTPE and Currentness; to note does not.
      const taskIssued = await issue({ tier: 'information', candidate_id: views.task.id, base_version: 1,
        authority: 'user_explicit', native_type_fields: { execution_bucket: 'later' } });
      const beforeTask = await heads();
      const taskPromoted = await native('clued_candidate_promote_v1', promoteInput('information', views.task.id, taskIssued));
      assert.equal(taskPromoted.supplemental?.outcome, 'promoted', JSON.stringify(taskPromoted));
      const taskRecord = (await admin.query('select type_fields,priority from public.clued_memories where id=$1',
        [taskIssued.record_id])).rows[0];
      assert.deepEqual(taskRecord.type_fields, taskIssued.confirmation_view.mutation.type_fields);
      for (const key of ['priority', 'intake_kind', 'criticality', 'owner_track', 'current_frontier_blocking',
        'priority_eligibility', 'executability', 'governance_profile']) {
        assert.ok(!(key in taskRecord.type_fields), `stripped: ${key}`);
      }
      assert.equal(taskRecord.priority, 0, 'the item priority=high never becomes the Record priority');
      const afterTask = await heads();
      assert.equal(afterTask.mtpe, beforeTask.mtpe + 1, 'task promotion syncs into mtpe_intake_projection');
      assert.ok(afterTask.currentness > beforeTask.currentness, 'task promotion touches Currentness');
      const noteIssued = await issue({ tier: 'information', candidate_id: views.fact.id, base_version: 1,
        authority: 'user_explicit' });
      const beforeNote = await heads();
      const notePromoted = await native('clued_candidate_promote_v1', promoteInput('information', views.fact.id, noteIssued));
      assert.equal(notePromoted.supplemental?.outcome, 'promoted', JSON.stringify(notePromoted));
      assert.deepEqual(await heads(), beforeNote, 'note promotion leaves MTPE and Currentness unchanged');
      const stateIssued = await issue({ tier: 'information', candidate_id: views.status.id, base_version: 1,
        authority: 'user_explicit' });
      const beforeState = await heads();
      assert.equal((await native('clued_candidate_promote_v1',
        promoteInput('information', views.status.id, stateIssued))).supplemental?.outcome, 'promoted');
      assert.ok((await heads()).currentness > beforeState.currentness, 'state promotion touches Currentness');

      // A downstream M1 rejection rolls the whole promotion back and burns the token (D4).
      const nowTasks = await submit([item('now_a', 'task'), item('now_b', 'task')]);
      const nowA = await issue({ tier: 'information', candidate_id: nowTasks.ids.item_now_a, base_version: 1,
        authority: 'user_explicit', native_type_fields: { execution_bucket: 'now' } });
      assert.equal((await native('clued_candidate_promote_v1',
        promoteInput('information', nowTasks.ids.item_now_a, nowA))).supplemental?.outcome, 'promoted');
      const nowB = await issue({ tier: 'information', candidate_id: nowTasks.ids.item_now_b, base_version: 1,
        authority: 'user_explicit', native_type_fields: { execution_bucket: 'now' } });
      const beforeNow = await counts();
      const nowConflict = await native('clued_candidate_promote_v1', promoteInput('information', nowTasks.ids.item_now_b, nowB));
      assert.deepEqual([nowConflict.status, nowConflict.error_code], ['rejected', 'promotion_record_rejected:NOW_CONFLICT']);
      assert.equal((await candidate('information', nowTasks.ids.item_now_b)).status, 'pending');
      const afterNow = await counts();
      assert.deepEqual([afterNow.memories, afterNow.promotions], [beforeNow.memories, beforeNow.promotions]);
      assert.equal(afterNow.receipts, beforeNow.receipts + 1, 'only the outer rejected Receipt remains');
      assert.equal((await tokenRow(nowB.token_id)).consume_outcome, 'rejected');

      // A scope merge after issue makes the confirmed view stale.
      const projectId = uuid();
      const mergeTarget = uuid();
      for (const id of [projectId, mergeTarget]) {
        assert.equal((await agent(tokenA, 'clued_project_mutate_v2', { operation: 'create', canonical_project_id: id,
          project_schema_version: 2, base_version: null, idempotency_key: uuid(), mutation: { name: `S3 project ${id}`,
            progress_status: 'active', aliases: [] } })).status, 'committed');
      }
      const projectCandidate = await submit([item('proj', 'fact')], { scope: `project:${projectId}` });
      const projectIssued = await issue({ tier: 'information', candidate_id: projectCandidate.ids.item_proj, base_version: 1,
        authority: 'user_explicit' });
      assert.equal(projectIssued.confirmation_view.scope, `project:${projectId}`);
      await admin.query('set session_replication_role=replica');
      await admin.query('update public.clued_projects set merged_into_project_id=$2 where id=$1', [projectId, mergeTarget]);
      await admin.query('set session_replication_role=origin');
      const staleView = await native('clued_candidate_promote_v1',
        promoteInput('information', projectCandidate.ids.item_proj, projectIssued));
      assert.deepEqual([staleView.status, staleView.error_code], ['rejected', 'confirmation_view_stale']);
      await admin.query('set session_replication_role=replica');
      await admin.query('update public.clued_projects set merged_into_project_id=null where id=$1', [projectId]);
      await admin.query('set session_replication_role=origin');

      // ---- E2E-03 (S3 portion): Agent proposal over two Native-marked Records -> Native promotion.
      const sourceK1 = uuid();
      const sourceK2 = uuid();
      for (const [id, title] of [[sourceK1, 'Risk list confirmed'], [sourceK2, 'Risk owner assigned']]) {
        assert.equal((await native('clued_user_record_mutate', noteInput(id, title))).status, 'committed');
        assert.equal(await confirmed(id, 1), true);
      }
      const knowledgeSources = [{ id: sourceK1, version: 1 }, { id: sourceK2, version: 1 }];
      const proposed = await call('clued_knowledge_propose', { idempotency_key: 'if-s3-e03-kp', scope: 'global',
        rule_id: 'knowledge.consolidate.v1', assertion: 'The risk list is confirmed and has an owner.',
        sources: knowledgeSources });
      assert.equal(proposed.status, 'committed', JSON.stringify(proposed));
      const kId = proposed.supplemental.candidate_id;
      const kObserved = await post(`/v1/knowledge/candidates/${kId}/confirmation`, { base_version: 1, authority: 'observed' });
      assert.deepEqual([kObserved.status, kObserved.body.error_code], [422, 'authority_not_permitted']);
      const kNoConfidence = await post(`/v1/knowledge/candidates/${kId}/confirmation`, { base_version: 1, authority: 'inferred' });
      assert.equal(kNoConfidence.body.error_code, 'inferred_confidence_required');
      const kIssued = await post(`/v1/knowledge/candidates/${kId}/confirmation`,
        { base_version: 1, authority: 'inferred', confidence: 0.8 });
      assert.equal(kIssued.status, 200, JSON.stringify(kIssued.body));
      assert.equal(kIssued.body.lineage_check, 'OK');
      const kView = kIssued.body.confirmation_view;
      assert.deepEqual([kView.record_type, kView.authority, kView.confidence, kView.source_refs, kView.source_unavailable_reason],
        ['note', 'inferred', 0.8, [], 'Derived knowledge; lineage in type_fields.knowledge']);
      assert.deepEqual(kView.mutation.type_fields, { note_kind: 'knowledge', knowledge: {
        schema: 'clued.knowledge-lineage.v1', rule_id: 'knowledge.consolidate.v1',
        sources: [...knowledgeSources].sort((a, b) => (a.id < b.id ? -1 : 1)), evidence_ids: [], candidate_id: kId } });
      const kPromoted = await post(`/v1/knowledge/candidates/${kId}/promote`, promoteInput('knowledge', kId, kIssued.body));
      assert.equal(kPromoted.status, 200, JSON.stringify(kPromoted.body));
      assert.equal(kPromoted.body.supplemental.outcome, 'promoted');
      const kRecord = (await admin.query('select record_type,authority,confidence,type_fields,version from public.clued_memories where id=$1',
        [kIssued.body.record_id])).rows[0];
      assert.deepEqual([kRecord.record_type, kRecord.authority, Number(kRecord.confidence), kRecord.version],
        ['note', 'inferred', 0.8, '1']);
      assert.deepEqual(kRecord.type_fields, kView.mutation.type_fields);
      assert.equal(await confirmed(kIssued.body.record_id, 1), true);
      assert.equal((await admin.query('select candidate_tier,origin_principal from clued_private.candidate_promotions where candidate_id=$1',
        [kId])).rows[0].candidate_tier, 'knowledge');
      // Conflict: a lineage source moves after issue.
      const k2 = await call('clued_knowledge_propose', { idempotency_key: 'if-s3-e03-kp2', scope: 'global',
        rule_id: 'knowledge.cross_record_fact.v1', assertion: 'The risk owner confirmed the list.', sources: knowledgeSources });
      assert.equal(k2.status, 'committed', JSON.stringify(k2));
      const k2Id = k2.supplemental.candidate_id;
      const k2Issued = await post(`/v1/knowledge/candidates/${k2Id}/confirmation`,
        { base_version: 1, authority: 'user_explicit' });
      assert.equal(k2Issued.body.status, 'issued');
      assert.equal((await native('clued_user_record_mutate', updateInput(sourceK1, 1, 'if-s3-e03-move', 'Risk list revised')))
        .status, 'committed');
      const beforeConflict = await counts();
      const k2Conflict = await post(`/v1/knowledge/candidates/${k2Id}/promote`, promoteInput('knowledge', k2Id, k2Issued.body));
      assert.equal(k2Conflict.status, 409, JSON.stringify(k2Conflict.body));
      assert.equal(k2Conflict.body.status, 'committed');
      assert.deepEqual([k2Conflict.body.supplemental.outcome, k2Conflict.body.supplemental.promoted,
        k2Conflict.body.supplemental.reason], ['conflict', false, 'knowledge_source_version_mismatch']);
      assert.deepEqual(await candidate('knowledge', k2Id), { status: 'conflict', version: 2, promoted_record_id: null,
        promoted_version: null, decided_by: 'native_ui', last_receipt_id: k2Conflict.body.receipt_id });
      assert.equal((await receipt(k2Conflict.body.receipt_id)).status, 'committed');
      assert.equal((await counts()).memories, beforeConflict.memories, 'no Record on conflict');
      assert.equal((await tokenRow(k2Issued.body.token_id)).consume_outcome, 'conflict');
      const conflictEvent = (await admin.query('select canonical_event_type from public.clued_context_events where id=$1::bigint',
        [k2Conflict.body.event_ids[0]])).rows[0];
      assert.equal(conflictEvent.canonical_event_type, 'extension:information_flow:candidate_conflict');

      // Expiry is a committed transition at promote time (D10).
      const expiringCandidate = await submit([item('expiring', 'fact')]);
      const expId = expiringCandidate.ids.item_expiring;
      const expIssued = await issue({ tier: 'information', candidate_id: expId, base_version: 1, authority: 'user_explicit' });
      await admin.query("update clued_private.information_candidates set expires_at=now()-interval '1 second' where id=$1",
        [expId]);
      const expOutcome = await post(`/v1/intake/${expId}/promote`, promoteInput('information', expId, expIssued));
      assert.equal(expOutcome.status, 409);
      assert.deepEqual([expOutcome.body.status, expOutcome.body.supplemental.outcome], ['committed', 'expired']);
      assert.equal((await candidate('information', expId)).status, 'expired');
      const expConfirm = await post(`/v1/intake/${expId}/confirmation`, { base_version: 2, authority: 'user_explicit' });
      assert.deepEqual([expConfirm.status, expConfirm.body.error_code], [409, 'candidate_not_pending']);

      // ---- Reject (D2: direct Native session, no token).
      const rejectable = await submit([item('reject', 'fact')]);
      const rejId = rejectable.ids.item_reject;
      const preRejectToken = await issue({ tier: 'information', candidate_id: rejId, base_version: 1, authority: 'user_explicit' });
      const rejectBody = { idempotency_key: 'if-s3-reject-0001', base_version: 1, reason: 'Not accurate' };
      const rejected = await post(`/v1/intake/${rejId}/reject`, rejectBody);
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.deepEqual([rejected.body.status, rejected.body.supplemental.outcome], ['committed', 'rejected']);
      assert.equal((await candidate('information', rejId)).status, 'rejected');
      assert.ok((await tokenRow(preRejectToken.token_id)).revoked_at instanceof Date, 'reject revokes live tokens');
      const afterReject = await post(`/v1/intake/${rejId}/promote`, promoteInput('information', rejId, preRejectToken));
      assert.deepEqual([afterReject.status, afterReject.body.error_code], [403, 'confirmation_token_revoked']);
      assert.equal((await post(`/v1/intake/${rejId}/reject`, rejectBody)).body.replayed, true);
      const rejectAgain = await post(`/v1/intake/${rejId}/reject`, { ...rejectBody, idempotency_key: 'if-s3-reject-0002',
        base_version: 2 });
      assert.deepEqual([rejectAgain.status, rejectAgain.body.error_code], [409, 'candidate_not_pending']);
      assert.equal((await post(`/v1/intake/${rejId}/reject`, { idempotency_key: 'if-s3-reject-0003', base_version: 2,
        authority: 'user_explicit' })).body.error_code, 'candidate_reject_unknown_field');
      assert.equal((await post(`/v1/intake/${rejId}/reject`, rejectBody, 'delegated-jwt')).status, 403);
      // 4.3.4 / D14: the same digest is never silently re-submitted.
      const resubmit = await post('/v1/intake', { ...rejectable.input, idempotency_key: 'if-s3-resubmit-0001' });
      assert.deepEqual([resubmit.status, resubmit.body.status, resubmit.body.error_code],
        [409, 'rejected', 'candidate_previously_rejected']);
      // Knowledge reject feeds the S2 re-proposal guard.
      const k3 = await call('clued_knowledge_propose', { idempotency_key: 'if-s3-e03-kp3', scope: 'global',
        rule_id: 'knowledge.dedup.v1', assertion: 'Duplicate risk notes.', sources: [{ id: sourceK2, version: 1 }] });
      const k3Reject = await post(`/v1/knowledge/candidates/${k3.supplemental.candidate_id}/reject`,
        { idempotency_key: 'if-s3-promo-0102', base_version: 1 });
      assert.equal(k3Reject.status, 200, JSON.stringify(k3Reject.body));
      const k3Again = await call('clued_knowledge_propose', { idempotency_key: 'if-s3-e03-kp4', scope: 'global',
        rule_id: 'knowledge.dedup.v1', assertion: 'Duplicate risk notes.', sources: [{ id: sourceK2, version: 1 }] });
      assert.match(k3Again.error_code, /knowledge_previously_rejected/);

      // Withdraw revokes live tokens too.
      const withdrawable = await submit([item('withdraw', 'fact')], { via: 'agent' });
      const wdId = withdrawable.ids.item_withdraw;
      const wdToken = await issue({ tier: 'information', candidate_id: wdId, base_version: 1, authority: 'user_explicit' });
      assert.equal((await agent(tokenA, 'clued_intake_withdraw', { idempotency_key: 'if-s3-promo-0103', scope: 'global',
        candidate_id: wdId, base_version: 1 })).status, 'committed');
      assert.ok((await tokenRow(wdToken.token_id)).revoked_at instanceof Date);

      // ---- E2E-14: forged extension Events change no candidate, token, promotion or marker state.
      const state = async () => (await admin.query(`select
          (select md5(coalesce(string_agg(id::text||status||version,',' order by id),'')) from clued_private.information_candidates) info,
          (select md5(coalesce(string_agg(id::text||status||version,',' order by id),'')) from clued_private.knowledge_candidates) know,
          (select md5(coalesce(string_agg(to_jsonb(t)::text,',' order by id),'')) from clued_private.candidate_confirmation_tokens t) tokens,
          (select md5(coalesce(string_agg(to_jsonb(p)::text,',' order by receipt_id),'')) from clued_private.candidate_promotions p) promotions,
          (select md5(coalesce(string_agg(to_jsonb(n)::text,',' order by receipt_id,record_id),'')) from clued_private.native_write_markers n) markers`))
        .rows[0];
      const stateBefore = await state();
      for (const [name, target] of [['evidence_withdrawn', `evidence:${evidenceId}`],
        ['candidate_promoted', `information_candidate:${e15Other}`], ['candidate_rejected', `information_candidate:${e15Other}`]]) {
        const forged = await agent(tokenA, 'clued_event_append', { idempotency_key: `if-s3-forged-${name}`,
          event_schema_version: 1, event_type: `extension:information_flow:${name}`, event_scope: 'global',
          audit_visibility: 'work_log', target_refs: [{ kind: 'system', id: target }],
          change_summary: { candidate_id: e15Other, record_id: view.record_id } });
        assert.equal(forged.status, 'committed', JSON.stringify(forged));
      }
      assert.deepEqual(await state(), stateBefore, 'forged Events are audit data only');
      assert.equal(await confirmed(bypassRecord, 1), false);
      assert.equal(await confirmed(view.record_id, 1), true);
      assert.equal((await admin.query(`select count(*)::int n from clued_private.typed_event_currentness_registry
        where event_type like 'extension:information_flow:%'`)).rows[0].n, 0);
    } finally {
      globalThis.fetch = previousFetch;
      console.warn = previousWarn;
    }

    // ---- Immutability of tokens and promotion markers.
    const anyToken = (await admin.query("select id from clued_private.candidate_confirmation_tokens where consume_outcome='promoted' limit 1"))
      .rows[0].id;
    await assert.rejects(admin.query("update clued_private.candidate_confirmation_tokens set view_digest=repeat('0',64) where id=$1",
      [anyToken]), /confirmation_token_immutable/);
    await assert.rejects(admin.query('update clued_private.candidate_confirmation_tokens set consumed_at=null,consumed_receipt_id=null,consume_outcome=null where id=$1',
      [anyToken]), /confirmation_token_immutable/);
    // revoked_at may be set once; it can never be cleared or moved.
    await admin.query('update clued_private.candidate_confirmation_tokens set revoked_at=now() where id=$1', [anyToken]);
    await assert.rejects(admin.query('update clued_private.candidate_confirmation_tokens set revoked_at=null where id=$1',
      [anyToken]), /confirmation_token_immutable/);
    await assert.rejects(admin.query("update clued_private.candidate_promotions set authority='observed'"),
      /promotion_marker_immutable/);

    // ---- S1 alignment: a project redirect cycle is a rejection, not a failure.
    const cycleA = uuid();
    const cycleB = uuid();
    for (const id of [cycleA, cycleB]) {
      assert.equal((await agent(tokenA, 'clued_project_mutate_v2', { operation: 'create', canonical_project_id: id,
        project_schema_version: 2, base_version: null, idempotency_key: uuid(), mutation: { name: `Cycle ${id}`,
          progress_status: 'active', aliases: [] } })).status, 'committed');
    }
    const pendingForCycle = (await submit([item('cycle', 'fact')], { via: 'agent' })).ids.item_cycle;
    await admin.query('set session_replication_role=replica');
    await admin.query('update public.clued_projects set merged_into_project_id=$2 where id=$1', [cycleA, cycleB]);
    await admin.query('update public.clued_projects set merged_into_project_id=$2 where id=$1', [cycleB, cycleA]);
    await admin.query('set session_replication_role=origin');
    const cycleSubmit = await agent(tokenA, 'clued_intake_submit', { idempotency_key: 'if-s3-promo-0104',
      scope: `project:${cycleA}`, segment: segment('seg_s3_cycle'), candidates: documentOf('seg_s3_cycle', [item('c', 'fact')]) });
    assert.deepEqual([cycleSubmit.status, cycleSubmit.error_code], ['rejected', 'project_redirect_cycle']);
    const cycleWithdraw = await agent(tokenA, 'clued_intake_withdraw', { idempotency_key: 'if-s3-promo-0105',
      scope: `project:${cycleA}`, candidate_id: pendingForCycle, base_version: 1 });
    assert.deepEqual([cycleWithdraw.status, cycleWithdraw.error_code], ['rejected', 'project_redirect_cycle']);
    // Reapply the actual formal closeout after all fixture scenarios; no skip.
    const closeoutMigration = await findGatewayCloseoutMigration(root);
    const closeoutBefore = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
