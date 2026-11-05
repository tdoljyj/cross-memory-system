import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const m0c = path.resolve(root, '../../development/contracts/information-flow/vendored/m0c');
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

test('migration versions are unique', async () => {
  // Supabase keys schema_migrations by the version prefix; filename sorting in
  // the embedded tests would hide a duplicate.
  const versions = (await fs.readdir(path.join(root, 'supabase/migrations')))
    .filter((name) => name.endsWith('.sql')).map((name) => name.split('_')[0]);
  assert.deepEqual(versions.filter((version, index) => versions.indexOf(version) !== index), []);
});

test('vendored M0-C security fixtures are byte-identical to the frozen parent', async () => {
  const lines = (await fs.readFile(path.join(m0c, 'SHA256SUMS.m0c-subset'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 24);
  for (const line of lines) {
    const [digest, file] = line.split(/\s+/);
    assert.match(file, /^corpus\/security\/SEC-00[1-8]\/(input|output|expectation)\.json$/);
    assert.equal(sha256(await fs.readFile(path.join(m0c, file))), digest, file);
  }
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
    await allowRawTestBindings(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'if-s2@example.invalid',now()),($2,'if-s2-other@example.invalid',now())`, [userId, otherUser]);
    const tokenA = hash();
    const tokenB = hash();
    const tokenProfileOnly = hash();
    const tokenReadOnly = hash();
    const tokenOther = hash();
    const tokenWriteOnly = hash();
    const bindingA = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Agent A',$2,array['context:read','context:write'],array['*']) returning id`,
    [userId, tokenA])).rows[0].id;
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys) values
      ($1,'synthetic','Agent B',$2,array['context:read','context:write'],array['*']),
      ($1,'synthetic','Profile only',$3,array['context:read','context:write'],array['profile']),
      ($1,'synthetic','Read only',$4,array['context:read'],array['*']),
      ($5,'synthetic','Other user',$6,array['context:read','context:write'],array['*']),
      ($1,'synthetic','Write only',$7,array['context:write'],array['*'])`,
    [userId, tokenB, tokenProfileOnly, tokenReadOnly, otherUser, tokenOther, tokenWriteOnly]);

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
    await human.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);

    const agent = async (token, name, input) =>
      await workerGatewayRpc(workerCaller, name, token, input);
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
    // An Agent-authored source (Binding write, even with user_confirmed) has no
    // Native marker, so it never reads human_confirmed (contract 6.3).
    const agentSource = uuid();
    const agentWrite = (await workerCaller.query('select public.clued_record_mutate($1,$2) v', [tokenA, {
      operation: 'create', id: agentSource, record_type: 'note', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: `if-s2-agent-note-${agentSource}`, authority: 'user_explicit', user_confirmed: true,
      confidence: 1, confidence_reason: 'S2 fixture', source_refs: [], source_unavailable_reason: 'Synthetic fixture',
      mutation: { title: 'Agent-authored source', content: 'Agent-authored source', type_fields: { note_kind: 'general' },
        relations: {} },
    }])).rows[0].v;
    assert.equal(agentWrite.status, 'committed', JSON.stringify(agentWrite));

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

    // A source without a positive Native marker fails closed with a rejected
    // Receipt and no candidate row, for either entry.
    const unconfirmedSources = [{ id: sourceA, version: 1 }, { id: agentSource, version: 1 }];
    const unconfirmed = await agent(tokenA, 'clued_knowledge_propose', proposal({ sources: unconfirmedSources }));
    assert.equal(unconfirmed.status, 'rejected', JSON.stringify(unconfirmed));
    assert.match(unconfirmed.error_code, /knowledge_source_not_human_confirmed/);
    assert.ok(unconfirmed.receipt_id);
    const nativeUnconfirmed = await native('clued_user_knowledge_propose', proposal({ sources: unconfirmedSources }));
    assert.match(nativeUnconfirmed.error_code, /knowledge_source_not_human_confirmed/);
    assert.equal(await knowledgeRows(), 0);

    // Sources written through Native /v1/records carry the S3 marker, so the
    // accepted path runs on real markers (no override).
    for (const id of [sourceA, sourceB]) {
      assert.equal((await admin.query('select clued_private.record_human_confirmed_v1($1,$2,1) v', [userId, id]))
        .rows[0].v, true);
    }

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
    // Stored in canonical (uuid) order, whatever order the caller sent.
    assert.deepEqual(row.sources, [{ id: sourceA, version: 1 }, { id: sourceB, version: 1 }]
      .sort((a, b) => (a.id < b.id ? -1 : 1)));
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
    // A Binding cites only Evidence it ingested itself, not another Binding's.
    await rejected(tokenB, { evidence_ids: [ownEvidenceId] }, /knowledge_evidence_not_found/);
    // A Binding cites only Records its read authorization covers.
    await rejected(tokenProfileOnly, { scope: 'profile' }, /knowledge_source_not_found/);
    // context:write alone grants no read: an existing source reads as not found.
    await rejected(tokenWriteOnly, {}, /knowledge_source_not_found/);
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
    // Reordering the sources does not produce a fresh digest.
    await rejected(tokenA, { rule_id: 'knowledge.dedup.v1',
      sources: [{ id: sourceB, version: 1 }, { id: sourceA, version: 1 }] }, /knowledge_previously_rejected/);

    // Native proposal records the account session and no Binding.
    const nativeProposed = await native('clued_user_knowledge_propose',
      proposal({ rule_id: 'knowledge.cross_record_fact.v1' }));
    assert.equal(nativeProposed.status, 'committed', JSON.stringify(nativeProposed));
    assert.deepEqual((await admin.query('select source_kind,binding_id from clued_private.knowledge_candidates where id=$1',
      [nativeProposed.supplemental.candidate_id])).rows[0], { source_kind: 'native_ui', binding_id: null });
    // The Native owner may cite any of its own Evidence, including a Binding's.
    const nativeWithEvidence = await native('clued_user_knowledge_propose',
      proposal({ assertion: 'Native citation of Agent A evidence.', evidence_ids: [ownEvidenceId] }));
    assert.equal(nativeWithEvidence.status, 'committed', JSON.stringify(nativeWithEvidence));

    // Knowledge listing: own Binding only; the owner sees all; never authoritative.
    const listA = await agent(tokenA, 'clued_intake_list', { scope: 'global', tier: 'knowledge' });
    assert.deepEqual(listA.candidates.map((item) => item.id), [proposed.supplemental.candidate_id]);
    assert.ok(listA.candidates.every((item) => item.authority === 'none' && item.authoritative === false));
    const listOwner = await nativeRead('clued_user_intake_list', { scope: 'global', tier: 'knowledge' });
    assert.equal(listOwner.candidates.length, 4);
    assert.equal((await nativeRead('clued_user_intake_list', { scope: 'global', tier: 'knowledge', status: 'rejected' }))
      .candidates.length, 1);
    assert.equal((await agent(tokenOther, 'clued_intake_list', { scope: 'global', tier: 'knowledge' })).candidates.length, 0);
    assert.equal((await agent(tokenA, 'clued_intake_list', { scope: 'global' })).candidates.length, 1,
      'the default tier stays Candidate Information');
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 'global', tier: 'authority' }), /invalid_tier/);
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 'foo' }), /invalid_scope/);
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 'project:not-a-uuid' }), /invalid_scope/);
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 'global', include_all: true }),
      /intake_list_unknown_field/);
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 'global', tier: 'knowledge',
      submission_id: evidenceOwn.submission_id }), /invalid_submission_id/);

    // Payload cap on every submit/propose entry, before any Receipt is opened.
    const receipts = async () => (await admin.query(
      'select count(*)::int n from public.clued_audit_receipts where user_id=$1', [userId])).rows[0].n;
    const receiptsBefore = await receipts();
    const huge = { idempotency_key: 'if-s2-huge-0001', scope: 'global', segment: segment(), candidates: documentOf(),
      client_label: 'x'.repeat(9 * 1024 * 1024) };
    await assert.rejects(agent(tokenA, 'clued_intake_submit', huge), /intake_payload_too_large/);
    await assert.rejects(native('clued_user_intake_submit', huge), /intake_payload_too_large/);
    const hugeProposal = proposal({ assertion: '知'.repeat(3200000) });
    await assert.rejects(agent(tokenA, 'clued_knowledge_propose', hugeProposal), /intake_payload_too_large/);
    await assert.rejects(native('clued_user_knowledge_propose', hugeProposal), /intake_payload_too_large/);
    assert.equal(await receipts(), receiptsBefore);
    // The cap runs after Binding resolution: an unknown token never reaches it.
    await assert.rejects(agent(hash(), 'clued_knowledge_propose', hugeProposal), /binding/);
    // Exponent-notation numbers are small when stored but render to all their
    // digits in the M1 request hash; the cap refuses outsized magnitudes
    // before any render or Receipt.
    const exponentBody = JSON.stringify({ idempotency_key: 'if-s2-submit-0101', scope: 'global',
      segment: { ...segment('seg_s2_exp'), padding: '__EXP__' }, candidates: documentOf('seg_s2_exp') })
      .replace('"__EXP__"', `[${Array(100).fill('1e100000').join(',')}]`);
    assert.ok((await admin.query('select pg_column_size($1::jsonb) n', [exponentBody])).rows[0].n < 64 * 1024);
    await assert.rejects(workerCaller.query('select public.clued_intake_submit($1,$2::jsonb) v', [tokenA, exponentBody]),
      /intake_payload_too_large/);
    await assert.rejects(workerCaller.query('select public.clued_intake_withdraw($1,$2::jsonb) v', [tokenA,
      '{"idempotency_key":"if-s2-exp-wd-01","candidate_id":"00000000-0000-4000-8000-000000000000","base_version":1e-16000}']),
    /intake_payload_too_large/);
    const receiptsAfterExponent = await receipts();
    // A non-string scope is refused before the token is even looked up, so it
    // is never rendered as text for an unauthenticated caller.
    const numericScope = `{"idempotency_key":"if-s2-submit-0102","scope":[${Array(1000).fill('1e100000').join(',')}]}`;
    for (const name of ['clued_intake_submit', 'clued_intake_list', 'clued_intake_withdraw',
      'clued_knowledge_propose', 'clued_context_pack']) {
      for (const token of [hash(), tokenA]) {
        await assert.rejects(workerCaller.query(`select public.${name}($1,$2::jsonb)`, [token, numericScope]),
          /invalid_binding_or_context/, name);
      }
    }
    await assert.rejects(agent(tokenA, 'clued_intake_list', { scope: 7 }), /invalid_binding_or_context/);
    // A short non-string scope that S1's ->> would have turned into a key.
    for (const name of ['clued_intake_submit', 'clued_intake_list', 'clued_intake_withdraw',
      'clued_knowledge_propose', 'clued_context_pack']) {
      await assert.rejects(agent(tokenA, name, { idempotency_key: 'if-s2-submit-0103', scope: ['global'] }),
        /invalid_binding_or_context/, name);
    }
    // A JSON null scope keeps S1's meaning: the global default.
    assert.equal((await agent(tokenA, 'clued_intake_list', { scope: null })).status, 'ok');

    // Context pack fails closed until S4 accepts a policy; it reads no source.
    for (const result of [await agent(tokenA, 'clued_context_pack', { scope: 'global' }),
      await agent(tokenReadOnly, 'clued_context_pack', { scope: 'global' }),
      await nativeRead('clued_user_context_pack', { scope: 'global' })]) {
      assert.deepEqual(result, { status: 'rejected', error_code: 'CONTEXT_POLICY_REQUIRED', authoritative: false,
        execution_authorization: 'NOT_GRANTED', model_extraction: 'NOT_EVALUATED' });
    }
    await assert.rejects(agent(tokenProfileOnly, 'clued_context_pack', { scope: 'global' }), /binding_not_authorized/);
    assert.equal(await receipts(), receiptsAfterExponent, 'scope refusals and the pack open no Receipt');

    // A compact body just under the Worker's 1 MiB wire limit re-serializes
    // larger in jsonb::text but stays below the database backstop.
    const dense = { idempotency_key: 'if-s2-dense-0001', scope: 'global', segment: segment('seg_s2_dense'),
      candidates: documentOf('seg_s2_dense'), client_label: 'dense' };
    dense.segment.messages[0].padding = Array.from({ length: 500000 }, () => 0);
    assert.ok(Buffer.byteLength(JSON.stringify(dense)) < 1024 * 1024);
    assert.ok((await admin.query('select pg_column_size($1::jsonb) n', [dense])).rows[0].n < 8 * 1024 * 1024,
      'a Worker-accepted body stays under the stored-size cap');
    assert.ok((await admin.query('select octet_length($1::jsonb::text) n', [dense])).rows[0].n > 1024 * 1024,
      'the re-serialized form exceeds the wire size');
    const denseResult = await agent(tokenA, 'clued_intake_submit', dense);
    assert.equal(denseResult.status, 'rejected', 'the cap passes it through to schema validation');
    assert.match(denseResult.error_code, /INSTANCE_SCHEMA_INVALID/);

    // ---- Worker transport over this database (E2E-06 / E2E-07, contract 5.2 and 7).
    // The real Worker handler runs; only the PostgREST hop is replaced by a shim
    // that executes each RPC as the role PostgREST would use: an account JWT
    // as `authenticated` with its claims, the synthetic Worker credential as
    // the real `clued_worker_gateway` role. Unknown Authorization fails closed.
    const worker = await loadContinuityWorker();
    const gatewayToken = 'synthetic-information-flow-worker-gateway';
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await gateway.query('set session authorization authenticator');
    await setWorkerGatewayCaller(gateway);
    await gateway.query(`select set_config('request.jwt.claims','{"role":"clued_worker_gateway"}',false)`);
    const workerEnv = { PROJECT_VIEWS_V2: 'true', SUPABASE_URL: 'https://storage.clued.test',
      CLUED_DB_GATEWAY_TOKEN: gatewayToken,
      ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
    const rawBinding = `clued_bnd_${'w'.repeat(43)}`;
    const workerBindingId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Worker agent',$2,array['context:read','context:write'],array['*']) returning id`,
    [userId, sha256(rawBinding)])).rows[0].id;
    const sessions = new Map([['account-jwt', '{}'], ['delegated-jwt', '{"client_id":"delegated-oauth"}']]);
    const external = [];
    let dropNextResponse = false;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.host !== 'storage.clued.test') { external.push(url.href); throw new Error('external call'); }
      const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '');
      const claims = sessions.get(token);
      if (url.pathname === '/auth/v1/user') {
        return claims ? Response.json({ id: userId }) : Response.json({ message: 'invalid JWT' }, { status: 401 });
      }
      const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname)?.[1];
      assert.ok(rpc, url.pathname);
      const body = JSON.parse(init.body);
      const keys = Object.keys(body);
      if (!claims && token !== gatewayToken) {
        return Response.json({ code: 'PGRST301', message: 'invalid JWT' }, { status: 401 });
      }
      const client = claims ? human : gateway;
      if (claims) {
        await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
          [userId, claims]);
      }
      let value;
      try {
        value = (await client.query(`select public.${rpc}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) v`,
          keys.map((key) => body[key]))).rows[0].v;
      } catch (error) {
        // PostgREST's SQLSTATE -> HTTP mapping for the codes these entries raise.
        const status = error.code === '42501' ? (claims ? 403 : 401)
          : /^54/.test(error.code) ? 413
            : /^(P0|XX|55|40|25)/.test(error.code) && error.code !== 'P0001' ? 500
              : ['23503', '23505'].includes(error.code) ? 409 : 400;
        return Response.json({ code: error.code, message: error.message }, { status });
      }
      // E2E-07: the transaction committed, then the response is lost.
      if (dropNextResponse) { dropNextResponse = false; throw new TypeError('connection reset before response'); }
      return Response.json(value);
    };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const post = async (pathname, body, token = 'account-jwt') => {
      const response = await worker.fetch(new Request(`https://clued.test${pathname}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body) }), workerEnv, ctx);
      return { status: response.status, body: await response.json() };
    };
    const call = async (name, args) => {
      const response = await worker.fetch(new Request('https://clued.test/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${rawBinding}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }), workerEnv, ctx);
      const envelope = await response.json();
      return { status: response.status, body: envelope.result?.structuredContent ?? envelope.error ?? envelope };
    };
    try {
      // A missing/wrong Worker credential must never silently reach an anon RPC.
      for (const value of [undefined, 'wrong-synthetic-gateway']) {
        workerEnv.CLUED_DB_GATEWAY_TOKEN = value;
        assert.equal((await call('clued_intake_list', { scope: 'global' })).status, 503);
      }
      workerEnv.CLUED_DB_GATEWAY_TOKEN = gatewayToken;
      // A project scope exercises the effective-project mapping end to end.
      const projectId = uuid();
      assert.equal((await agent(tokenA, 'clued_project_mutate_v2', {
        operation: 'create', canonical_project_id: projectId, project_schema_version: 2, base_version: null,
        idempotency_key: uuid(), mutation: { name: 'S2 transport project', progress_status: 'active',
          aliases: [] } })).status, 'committed');
      const projectScope = `project:${projectId}`;
      const baseline = await snapshot();

      // E2E-06: SEC-001…008 through both entries. Tier, scope, authority and
      // target are fixed by the route; the texts are stored only as data.
      for (let n = 1; n <= 8; n += 1) {
        const id = `SEC-00${n}`;
        const read = async (name) => JSON.parse(await fs.readFile(path.join(m0c, 'corpus/security', id, name), 'utf8'));
        const [segmentInput, output, expectation] = await Promise.all(
          ['input.json', 'output.json', 'expectation.json'].map(read));
        const injectionText = segmentInput.messages.map((message) => message.content).join('\n');
        const active = segmentInput.messages.find((message) => message.context_only === false);
        // The injection text itself, captured verbatim as the claim and anchor.
        const asData = { schema_version: 'candidate_information.v1', segment_id: segmentInput.segment_id,
          items: [{ candidate_local_id: 'item_injection_as_data', item_type: 'fact',
            claim: active.content.slice(0, 300), summary: active.content.slice(0, 120), action_level: 'reference',
            priority: null, entity_mentions: [], topics: [], temporal_mentions: [],
            source_anchors: [{ message_id: active.message_id, exact_quote: active.content.slice(0, 1000) }],
            confidence: 1, uncertainties: [], sensitivity_hint: 'none' }] };
        for (const [entry, send] of [
          ['agent', (body) => call('clued_intake_submit', body)],
          ['native', (body) => post('/v1/intake', body)],
        ]) {
          const scope = n % 2 ? 'global' : projectScope;
          const expectStored = async (key, document) => {
            const rows = (await admin.query(`select c.* from clued_private.information_candidates c
              join clued_private.information_intake_submissions s on s.id=c.submission_id
              where s.idempotency_key=$1`, [key])).rows;
            assert.equal(rows.length, document.items.length, `${id} ${entry} ${key}`);
            for (const row of rows) {
              assert.equal(row.tier, 'information');
              assert.equal(row.scope, scope);
              assert.equal(row.status, 'pending');
              assert.equal(row.promoted_record_id, null);
              assert.deepEqual([row.source_kind, row.binding_id],
                entry === 'agent' ? ['agent_binding', workerBindingId] : ['native_ui', null]);
              assert.deepEqual(row.payload,
                document.items.find((item) => item.candidate_local_id === row.candidate_local_id));
            }
          };
          // 1. The frozen M0-C output for the fixture.
          const goldKey = `if-s2-e2e06-${entry}-${id}`;
          const gold = await send({ idempotency_key: goldKey, scope, client_label: injectionText.slice(0, 120),
            segment: segmentInput, candidates: output });
          if (output.schema_version !== 'candidate_information.v1') {
            // SEC-007/008 freeze a segment-boundary document, not candidates.
            assert.equal(gold.body.status, 'rejected', `${id} ${entry}`);
            assert.match(gold.body.error_code, /INSTANCE_SCHEMA_INVALID/);
            await expectStored(goldKey, { items: [] });
          } else if (output.items.length === 0) {
            assert.equal(expectation.expected_item_count, 0);
            assert.equal(gold.body.status, 'rejected', `${id} ${entry}`);
            assert.match(gold.body.error_code, /intake_no_candidates/);
            await expectStored(goldKey, output);
          } else {
            assert.equal(gold.status, 200, `${id} ${entry} ${JSON.stringify(gold.body)}`);
            assert.equal(gold.body.status, 'committed');
            await expectStored(goldKey, output);
          }
          // 2. The injection text stored as a candidate is data only.
          const dataKey = `if-s2-e2e06-data-${entry}-${id}`;
          const data = await send({ idempotency_key: dataKey, scope, segment: segmentInput, candidates: asData });
          assert.equal(data.body.status, 'committed', `${id} ${entry} ${JSON.stringify(data.body)}`);
          await expectStored(dataKey, asData);
          // 3. The same text cannot smuggle routing fields next to the payload.
          const smuggled = await send({ idempotency_key: `if-s2-e2e06-smuggle-${entry}-${id}`, scope: 'global',
            segment: segmentInput, candidates: asData, tier: 'authority', authority: 'user_explicit',
            target_record_id: sourceA, note: injectionText });
          assert.equal(smuggled.body.status, 'rejected');
          assert.match(smuggled.body.error_code, /intake_unknown_field/);
        }
        // Knowledge proposals keep an injected assertion as data.
        const kp = await call('clued_knowledge_propose', { idempotency_key: `if-s2-e2e06-kp-${id}`, scope: projectScope,
          rule_id: 'knowledge.cross_record_fact.v1', assertion: injectionText.slice(0, 2000),
          sources: [{ id: sourceA, version: 1 }] });
        assert.equal(kp.body.status, 'committed', JSON.stringify(kp.body));
        const kpRow = (await admin.query('select * from clued_private.knowledge_candidates where id=$1',
          [kp.body.supplemental.candidate_id])).rows[0];
        assert.deepEqual([kpRow.tier, kpRow.scope, kpRow.status, kpRow.source_kind, kpRow.assertion],
          ['knowledge', projectScope, 'pending', 'agent_binding', injectionText.slice(0, 2000)]);
      }
      assert.deepEqual(external, [], 'zero external actions');
      assert.deepEqual(await snapshot(), baseline, 'injection inputs change no Canonical state');
      const projectList = await call('clued_intake_list', { scope: projectScope });
      assert.ok(projectList.body.candidates.length > 0);
      assert.ok(projectList.body.candidates.every((row) => row.scope === projectScope && row.authoritative === false));
      assert.equal((await call('clued_intake_list', { scope: projectScope, tier: 'knowledge' })).body.candidates.length, 8);

      // E2E-07: the response is lost after commit; the retry with the same key
      // replays the Receipt and leaves one submission; a new digest is rejected.
      const retryBody = { idempotency_key: 'if-s2-e2e07-native', scope: 'global',
        segment: segment('seg_s2_e2e07'), candidates: documentOf('seg_s2_e2e07') };
      dropNextResponse = true;
      assert.equal((await post('/v1/intake', retryBody)).status, 500);
      const retried = await post('/v1/intake', retryBody);
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.equal(retried.body.replayed, true);
      assert.equal((await admin.query(`select count(*)::int n from clued_private.information_intake_submissions
        where user_id=$1 and idempotency_key='if-s2-e2e07-native'`, [userId])).rows[0].n, 1);
      const digestConflict = await post('/v1/intake', { ...retryBody, client_label: 'different digest' });
      assert.equal(digestConflict.status, 409);
      assert.equal(digestConflict.body.error_code, 'IDEMPOTENCY_KEY_CONFLICT');
      assert.ok(digestConflict.body.receipt_id, 'the digest conflict carries a rejected Receipt');
      const kpRetry = { idempotency_key: 'if-s2-e2e07-agent-kp', scope: 'global', rule_id: 'knowledge.consolidate.v1',
        assertion: 'Retry after a lost response.', sources: [{ id: sourceA, version: 1 }] };
      dropNextResponse = true;
      assert.notEqual((await call('clued_knowledge_propose', kpRetry)).body.status, 'committed');
      const kpReplay = await call('clued_knowledge_propose', kpRetry);
      assert.equal(kpReplay.body.replayed, true, JSON.stringify(kpReplay.body));
      assert.equal((await admin.query(`select count(*)::int n from clued_private.knowledge_candidates
        where user_id=$1 and idempotency_key='if-s2-e2e07-agent-kp'`, [userId])).rows[0].n, 1);
      const kpConflict = await call('clued_knowledge_propose', { ...kpRetry, assertion: 'changed' });
      assert.equal(kpConflict.body.error_code, 'IDEMPOTENCY_KEY_CONFLICT');
      assert.ok(kpConflict.body.receipt_id);

      // A Binding token never reaches the account entries; a delegated OAuth
      // session is refused by the database guard and writes nothing.
      const submissions = async () => (await admin.query(
        'select count(*)::int n from clued_private.information_intake_submissions where user_id=$1', [userId])).rows[0].n;
      const count = await submissions();
      assert.equal((await post('/v1/intake', { ...retryBody, idempotency_key: 'if-s2-e2e-bnd' }, rawBinding)).status, 401);
      const delegated = await post('/v1/intake', { ...retryBody, idempotency_key: 'if-s2-e2e-oauth' }, 'delegated-jwt');
      assert.equal(delegated.status, 403);
      assert.match(JSON.stringify(delegated.body), /direct_human_session_required/);
      assert.equal(await submissions(), count);
      assert.deepEqual(await snapshot(), baseline);
    } finally {
      globalThis.fetch = previousFetch;
      await human.query("select set_config('request.jwt.claims','{}',false)");
    }

    // A legacy Record without canonical_scope resolves its scope like other
    // readers, and a Binding outside that scope still gets not-found.
    const legacySource = await note('Legacy scope source');
    await admin.query("set session_replication_role=replica");
    await admin.query('update public.clued_memories set canonical_scope=null where id=$1', [legacySource]);
    await admin.query("set session_replication_role=origin");
    const legacyCount = await knowledgeRows();
    const legacy = await agent(tokenProfileOnly, 'clued_knowledge_propose',
      proposal({ scope: 'profile', sources: [{ id: legacySource, version: 1 }] }));
    assert.equal(legacy.status, 'rejected');
    assert.match(legacy.error_code, /knowledge_source_not_found/);
    assert.equal(await knowledgeRows(), legacyCount);

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
    for (const fn of ['record_human_confirmed_v1(uuid,uuid,bigint)', 'record_evidence_unflagged_v1(uuid,uuid,bigint)',
      'intake_payload_cap_v1(jsonb)', 'intake_context_key_v1(jsonb)',
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
        has_function_privilege('service_role',p.oid,'execute') service_role,
        has_function_privilege('clued_worker_gateway',p.oid,'execute') gateway
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like 'clued\\_%intake\\_%' or p.proname like 'clued\\_%knowledge\\_%'
        or p.proname like 'clued\\_%context\\_pack') order by 1`)).rows;
    assert.deepEqual(entries.map((item) => [item.proname, item.anon, item.authenticated, item.service_role, item.gateway]), [
      ['clued_context_pack', false, false, false, true], ['clued_intake_list', false, false, false, true],
      ['clued_intake_submit', false, false, false, true], ['clued_intake_withdraw', false, false, false, true],
      ['clued_knowledge_propose', false, false, false, true], ['clued_user_context_pack', false, true, false, false],
      ['clued_user_intake_list', false, true, false, false], ['clued_user_intake_submit', false, true, false, false],
      ['clued_user_intake_withdraw', false, true, false, false], ['clued_user_knowledge_propose', false, true, false, false]]);
    await assert.rejects(anon.query('select clued_private.knowledge_propose_core_v1($1,null,$2,$3)',
      [userId, proposal(), hash()]), /permission denied/);
    await assert.rejects(human.query('select public.clued_knowledge_propose($1,$2)', [tokenA, proposal()]),
      /permission denied/);
    await human.query(`select set_config('request.jwt.claims','{"client_id":"delegated-oauth"}',false)`);
    await assert.rejects(native('clued_user_knowledge_propose', proposal()), /direct_human_session_required/);
    await assert.rejects(nativeRead('clued_user_context_pack', { scope: 'global' }), /direct_human_session_required/);
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
