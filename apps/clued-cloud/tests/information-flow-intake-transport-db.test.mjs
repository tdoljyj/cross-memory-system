import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const segment = (segmentId = 'seg_s2_001') => ({
  schema_version: 'segment_input.v1', segment_id: segmentId,
  reference_time: '2026-09-23T10:00:00+08:00', timezone: 'Asia/Shanghai',
  messages: [{ message_id: 'msg_s2_a', evidence_id: 'ev_s2_a', author_role: 'user',
    created_at: '2026-09-23T09:58:00+08:00', context_only: false, content: '青石项目的风险清单已经确认。' }],
});
const documentOf = (segmentId = 'seg_s2_001') => ({
  schema_version: 'candidate_information.v1', segment_id: segmentId,
  items: [{ candidate_local_id: 'item_fact', item_type: 'fact', claim: '青石项目的风险清单已经确认。',
    summary: '风险清单已确认', action_level: 'reference', priority: null, entity_mentions: [], topics: [],
    temporal_mentions: [], source_anchors: [{ message_id: 'msg_s2_a', exact_quote: '风险清单已经确认' }],
    confidence: 0.9, uncertainties: [], sensitivity_hint: 'none' }],
});

test('Information Flow S2: knowledge proposal, payload cap, fail-closed pack, OAuth dispatch, grants',
  { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-if-s2-'));
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
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'if-s2@example.invalid',now()),($2,'if-s2-other@example.invalid',now())`, [userId, otherUser]);
    const tokenA = hash();
    const tokenB = hash();
    const tokenProfileOnly = hash();
    const tokenReadOnly = hash();
    const tokenOther = hash();
    const bindingA = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Agent A',$2,array['context:read','context:write'],array['*']) returning id`,
    [userId, tokenA])).rows[0].id;
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values
      ($1,'synthetic','Agent B',$2,array['context:read','context:write'],array['*']),
      ($1,'synthetic','Profile only',$3,array['context:read','context:write'],array['profile']),
      ($1,'synthetic','Read only',$4,array['context:read'],array['*']),
      ($5,'synthetic','Other user',$6,array['context:read','context:write'],array['*'])`,
    [userId, tokenB, tokenProfileOnly, tokenReadOnly, otherUser, tokenOther]);

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    await human.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);

    const agent = async (token, name, input) =>
      (await anon.query(`select public.${name}($1,$2) v`, [token, input])).rows[0].v;
    const native = async (name, input) =>
      (await human.query(`select public.${name}($1,$2) v`, [input, sha256(JSON.stringify(input))])).rows[0].v;
    const nativeRead = async (name, input) =>
      (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;

    // Source Authority Information written through the Native M1 wrapper.
    const note = async (title) => {
      const id = uuid();
      const result = await native('clued_user_record_mutate', {
        operation: 'create', id, record_type: 'note', record_schema_version: 1, lifecycle_status: 'active',
        scope: 'global', idempotency_key: `if-s2-note-${id}`, authority: 'user_explicit', user_confirmed: true,
        confidence: 1, confidence_reason: 'S2 fixture', source_refs: [], source_unavailable_reason: 'Synthetic fixture',
        mutation: { title, content: title, type_fields: { note_kind: 'general' }, relations: {} },
      });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return id;
    };
    const sourceA = await note('Risk list confirmed');
    const sourceB = await note('Risk owner assigned');
    const sourceClosed = await note('Superseded observation');
    const closed = await native('clued_user_record_mutate', {
      operation: 'close', id: sourceClosed, record_type: 'note', record_schema_version: 1,
      lifecycle_status: 'archived', scope: 'global', idempotency_key: `if-s2-close-${sourceClosed}`,
      authority: 'user_explicit', user_confirmed: true, confidence: 1, confidence_reason: 'S2 fixture',
      base_version: 1, mutation: { closure_summary: 'Archived fixture', closed_reason: 'Test' },
    });
    assert.equal(closed.status, 'committed', JSON.stringify(closed));

    const snapshot = async () => (await admin.query(`select
        (select count(*)::int from public.clued_memories where user_id=$1) memories,
        (select coalesce(sum(version),0)::int from public.clued_memories where user_id=$1) record_versions,
        (select count(*)::int from clued_private.mtpe_intake_projection where user_id=$1) mtpe,
        (select coalesce(sum(invalidation_revision),0)::int from clued_private.projection_invalidation_heads where user_id=$1) projection_inv,
        (select coalesce(sum(snapshot_revision),0)::int from clued_private.scope_currentness_heads where user_id=$1) currentness,
        (select count(*)::int from clued_private.event_truth_carriers where user_id=$1) carriers`, [userId])).rows[0];
    const before = await snapshot();
    const knowledgeRows = async () => (await admin.query(
      'select count(*)::int n from clued_private.knowledge_candidates where user_id=$1', [userId])).rows[0].n;

    const proposal = (overrides = {}) => ({
      idempotency_key: `if-s2-kp-${uuid()}`, scope: 'global', rule_id: 'knowledge.consolidate.v1',
      assertion: 'The risk list is confirmed and has an owner.',
      sources: [{ id: sourceA, version: 1 }, { id: sourceB, version: 1 }], ...overrides,
    });

    // Before S3 no Record carries a positive Native marker, so every proposal
    // fails closed with a rejected Receipt and no candidate row.
    const unconfirmed = await agent(tokenA, 'clued_knowledge_propose', proposal());
    assert.equal(unconfirmed.status, 'rejected', JSON.stringify(unconfirmed));
    assert.match(unconfirmed.error_code, /knowledge_source_not_human_confirmed/);
    assert.ok(unconfirmed.receipt_id);
    const nativeUnconfirmed = await native('clued_user_knowledge_propose', proposal());
    assert.match(nativeUnconfirmed.error_code, /knowledge_source_not_human_confirmed/);
    assert.equal(await knowledgeRows(), 0);

    // Simulate S3's positive marker on this disposable database only, to cover
    // the accepted path. S3 replaces this function with the marker lookup.
    await admin.query(`create or replace function clued_private.record_human_confirmed_v1(
      p_user_id uuid,p_record_id uuid,p_version bigint) returns boolean language sql stable
      security definer set search_path='' as $$ select true $$`);

    // Agent proposal: route fixes tier/source; audit-only Event; no Canonical effect.
    const evidenceOwn = (await agent(tokenA, 'clued_intake_submit', { idempotency_key: 'if-s2-submit-0001',
      scope: 'global', segment: segment(), candidates: documentOf() })).supplemental;
    const ownEvidenceId = (await admin.query(
      'select evidence_id from clued_private.information_intake_submissions where id=$1',
      [evidenceOwn.submission_id])).rows[0].evidence_id;
    const input = proposal({ idempotency_key: 'if-s2-kp-agent-0001', evidence_ids: [ownEvidenceId] });
    const proposed = await agent(tokenA, 'clued_knowledge_propose', input);
    assert.equal(proposed.status, 'committed', JSON.stringify(proposed));
    assert.equal(proposed.supplemental.tier, 'knowledge');
    assert.equal(proposed.supplemental.authoritative, false);
    const row = (await admin.query('select * from clued_private.knowledge_candidates where id=$1',
      [proposed.supplemental.candidate_id])).rows[0];
    assert.deepEqual([row.tier, row.status, row.version, row.source_kind, row.binding_id],
      ['knowledge', 'pending', 1, 'agent_binding', bindingA]);
    assert.deepEqual(row.sources, [{ id: sourceA, version: 1 }, { id: sourceB, version: 1 }]);
    assert.deepEqual(row.evidence_ids, [ownEvidenceId]);
    const event = (await admin.query('select * from public.clued_context_events where id=$1::bigint',
      [proposed.event_ids[0]])).rows[0];
    assert.deepEqual([event.event_type, event.canonical_event_type, event.audit_visibility],
      ['action', 'extension:information_flow:knowledge_proposed', 'audit_only']);
    assert.ok(event.target_refs.every((ref) => ref.kind !== 'record'), 'the Event never targets its source Records');
    assert.equal((await admin.query('select count(*)::int n from clued_private.event_truth_carriers where event_id=$1',
      [event.id])).rows[0].n, 0);
    assert.deepEqual((await admin.query(`select from_status,to_status,actor,receipt_id from clued_private.candidate_transitions
      where candidate_tier='knowledge' and candidate_id=$1`, [row.id])).rows,
    [{ from_status: null, to_status: 'pending', actor: 'agent_binding', receipt_id: proposed.receipt_id }]);
    assert.deepEqual(await snapshot(), before, 'a proposal changes no Record, MTPE, projection, Currentness or carrier');

    // Idempotent replay and key conflict.
    const replay = await agent(tokenA, 'clued_knowledge_propose', input);
    assert.equal(replay.receipt_id, proposed.receipt_id);
    assert.equal(replay.replayed, true);
    const conflict = await agent(tokenA, 'clued_knowledge_propose', { ...input, assertion: 'changed' });
    assert.equal(conflict.error_code, 'IDEMPOTENCY_KEY_CONFLICT');

    // Fail-closed source and input checks, each with a rejected Receipt and no row.
    const rejected = async (token, overrides, pattern) => {
      const count = await knowledgeRows();
      const result = await agent(token, 'clued_knowledge_propose', proposal(overrides));
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.match(result.error_code, pattern);
      assert.equal(await knowledgeRows(), count);
    };
    await rejected(tokenA, { sources: [{ id: sourceA, version: 2 }] }, /knowledge_source_version_mismatch/);
    await rejected(tokenA, { sources: [{ id: sourceClosed, version: 2 }] }, /knowledge_source_not_current/);
    await rejected(tokenA, { sources: [{ id: uuid(), version: 1 }] }, /knowledge_source_not_found/);
    await rejected(tokenA, { sources: [{ id: sourceA, version: 1 }, { id: sourceA, version: 1 }] }, /invalid_sources/);
    await rejected(tokenA, { sources: [{ id: sourceA, version: 1, record_type: 'decision' }] }, /invalid_sources/);
    await rejected(tokenA, { sources: [{ id: 'not-a-uuid', version: 1 }] }, /invalid_sources/);
    await rejected(tokenA, { sources: [] }, /invalid_sources/);
    await rejected(tokenA, { rule_id: 'knowledge.model_summary.v1' }, /invalid_rule_id/);
    await rejected(tokenA, { assertion: '' }, /invalid_assertion/);
    await rejected(tokenA, { tier: 'authority' }, /knowledge_unknown_field/);
    await rejected(tokenA, { authority: 'user_explicit' }, /knowledge_unknown_field/);
    await rejected(tokenA, { evidence_ids: ['not-a-uuid'] }, /invalid_evidence_ids/);
    const foreignEvidence = (await admin.query(`select evidence_id from clued_private.information_intake_submissions
      where id=$1`, [(await agent(tokenOther, 'clued_intake_submit', { idempotency_key: 'if-s2-other-0001',
      scope: 'global', segment: segment(), candidates: documentOf() })).supplemental.submission_id])).rows[0].evidence_id;
    await rejected(tokenA, { evidence_ids: [foreignEvidence] }, /knowledge_evidence_not_found/);
    // A Binding cites only Records its read authorization covers.
    await rejected(tokenProfileOnly, { scope: 'profile' }, /knowledge_source_not_found/);
    // Another user's Binding cannot cite this user's Records.
    await rejected(tokenOther, {}, /knowledge_source_not_found/);
    // Binding scope and capability are enforced before the core runs.
    await assert.rejects(agent(tokenProfileOnly, 'clued_knowledge_propose', proposal()), /binding_not_authorized/);
    await assert.rejects(agent(tokenReadOnly, 'clued_knowledge_propose', proposal()), /binding_not_authorized|scope/);

    // Contract 4.3.4: a rejected candidate is never silently re-proposed with the same digest.
    const toReject = await agent(tokenB, 'clued_knowledge_propose', proposal({ rule_id: 'knowledge.dedup.v1' }));
    assert.equal(toReject.status, 'committed', JSON.stringify(toReject));
    await admin.query("update clued_private.knowledge_candidates set status='rejected' where id=$1",
      [toReject.supplemental.candidate_id]);
    await rejected(tokenA, { rule_id: 'knowledge.dedup.v1' }, /knowledge_previously_rejected/);

    // Native proposal records the account session and no Binding.
    const nativeProposed = await native('clued_user_knowledge_propose',
      proposal({ rule_id: 'knowledge.cross_record_fact.v1' }));
    assert.equal(nativeProposed.status, 'committed', JSON.stringify(nativeProposed));
    assert.deepEqual((await admin.query('select source_kind,binding_id from clued_private.knowledge_candidates where id=$1',
      [nativeProposed.supplemental.candidate_id])).rows[0], { source_kind: 'native_ui', binding_id: null });

    // Knowledge listing: own Binding only; the owner sees all; never authoritative.
    const listA = await agent(tokenA, 'clued_intake_list', { scope: 'global', tier: 'knowledge' });
    assert.deepEqual(listA.candidates.map((item) => item.id), [proposed.supplemental.candidate_id]);
    assert.ok(listA.candidates.every((item) => item.authority === 'none' && item.authoritative === false));
    const listOwner = await nativeRead('clued_user_intake_list', { scope: 'global', tier: 'knowledge' });
    assert.equal(listOwner.candidates.length, 3);
    assert.equal((await nativeRead('clued_user_intake_list', { scope: 'global', tier: 'knowledge', status: 'rejected' }))
      .candidates.length, 1);
    assert.equal((await agent(tokenOther, 'clued_intake_list', { scope: 'global', tier: 'knowledge' })).candidates.length, 0);
    assert.equal((await agent(tokenA, 'clued_intake_list', { scope: 'global' })).candidates.length, 1,
      'the default tier stays Candidate Information');
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 'global', tier: 'authority' }), /invalid_tier/);
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 'global', include_all: true }),
      /intake_list_unknown_field/);
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 'global', tier: 'knowledge',
      submission_id: evidenceOwn.submission_id }), /invalid_submission_id/);

    // Payload cap on every submit/propose entry, before any Receipt is opened.
    const receipts = async () => (await admin.query(
      'select count(*)::int n from public.clued_audit_receipts where user_id=$1', [userId])).rows[0].n;
    const receiptsBefore = await receipts();
    const huge = { idempotency_key: 'if-s2-huge-0001', scope: 'global', segment: segment(), candidates: documentOf(),
      client_label: 'x'.repeat(1024 * 1024) };
    await assert.rejects(agent(tokenA, 'clued_intake_submit', huge), /intake_payload_too_large/);
    await assert.rejects(native('clued_user_intake_submit', huge), /intake_payload_too_large/);
    const hugeProposal = proposal({ assertion: '知'.repeat(400000) });
    await assert.rejects(agent(tokenA, 'clued_knowledge_propose', hugeProposal), /intake_payload_too_large/);
    await assert.rejects(native('clued_user_knowledge_propose', hugeProposal), /intake_payload_too_large/);
    assert.equal(await receipts(), receiptsBefore);

    // Context pack fails closed until S4 accepts a policy; it reads no source.
    for (const result of [await agent(tokenA, 'clued_context_pack', { scope: 'global' }),
      await agent(tokenReadOnly, 'clued_context_pack', { scope: 'global' }),
      await nativeRead('clued_user_context_pack', { scope: 'global' })]) {
      assert.deepEqual(result, { status: 'rejected', error_code: 'CONTEXT_POLICY_REQUIRED', authoritative: false,
        execution_authorization: 'NOT_GRANTED', model_extraction: 'NOT_EVALUATED' });
    }
    await assert.rejects(agent(tokenProfileOnly, 'clued_context_pack', { scope: 'global' }), /binding_not_authorized/);
    assert.equal(await receipts(), receiptsBefore);

    // Delegated OAuth dispatches the five tools to the same Binding entries.
    const oauthBody = (await admin.query(
      "select pg_get_functiondef('public.clued_oauth_call(text,jsonb)'::regprocedure) d")).rows[0].d;
    for (const name of ['clued_intake_submit', 'clued_intake_list', 'clued_intake_withdraw',
      'clued_knowledge_propose', 'clued_context_pack']) {
      assert.ok(oauthBody.includes(`when '${name}' then return public.${name}(v_binding.token_hash,v_input);`), name);
    }
    assert.ok(oauthBody.includes("when 'clued_mtpe_owner_pin' then"), 'existing OAuth cases are preserved');
    assert.ok(!/promote|confirmation/.test(oauthBody), 'no promotion or confirmation surface is reachable by OAuth');

    // Grants: new core functions are private; each entry is callable only by its own principal kind.
    for (const fn of ['record_human_confirmed_v1(uuid,uuid,bigint)', 'intake_payload_cap_v1(jsonb)',
      'knowledge_propose_core_v1(uuid,uuid,jsonb,text)', 'intake_list_core_v1(uuid,uuid,jsonb)',
      'context_pack_core_v1(uuid,uuid,jsonb)']) {
      const grants = (await admin.query(`select has_function_privilege('anon',$1::regprocedure,'execute') anon,
        has_function_privilege('authenticated',$1::regprocedure,'execute') authenticated,
        has_function_privilege('service_role',$1::regprocedure,'execute') service_role`,
      [`clued_private.${fn}`])).rows[0];
      assert.deepEqual(grants, { anon: false, authenticated: false, service_role: false }, fn);
    }
    const entries = (await admin.query(`select p.proname,
        has_function_privilege('anon',p.oid,'execute') anon,
        has_function_privilege('authenticated',p.oid,'execute') authenticated,
        has_function_privilege('service_role',p.oid,'execute') service_role
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like 'clued\\_%intake\\_%' or p.proname like 'clued\\_%knowledge\\_%'
        or p.proname like 'clued\\_%context\\_pack') order by 1`)).rows;
    assert.deepEqual(entries.map((item) => [item.proname, item.anon, item.authenticated, item.service_role]), [
      ['clued_context_pack', true, false, false], ['clued_intake_list', true, false, false],
      ['clued_intake_submit', true, false, false], ['clued_intake_withdraw', true, false, false],
      ['clued_knowledge_propose', true, false, false], ['clued_user_context_pack', false, true, false],
      ['clued_user_intake_list', false, true, false], ['clued_user_intake_submit', false, true, false],
      ['clued_user_intake_withdraw', false, true, false], ['clued_user_knowledge_propose', false, true, false]]);
    await assert.rejects(anon.query('select clued_private.knowledge_propose_core_v1($1,null,$2,$3)',
      [userId, proposal(), hash()]), /permission denied/);
    await assert.rejects(human.query('select public.clued_knowledge_propose($1,$2)', [tokenA, proposal()]),
      /permission denied/);
    await human.query(`select set_config('request.jwt.claims','{"client_id":"delegated-oauth"}',false)`);
    await assert.rejects(native('clued_user_knowledge_propose', proposal()), /direct_human_session_required/);
    await assert.rejects(nativeRead('clued_user_context_pack', { scope: 'global' }), /direct_human_session_required/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
