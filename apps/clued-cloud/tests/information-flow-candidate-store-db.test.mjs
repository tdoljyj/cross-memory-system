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
import { setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendored = path.resolve(root, '../../development/contracts/information-flow/vendored/m0a');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Frozen M0-A file digests (M0-A SHA256SUMS; contract section 4.2).
const PINNED = {
  'candidate-information.v1.schema.json': '52b270b24458a76ae40257df4e9a3d220aad232ba9ee939b2fde96f33b9c7702',
  'segment-input.v1.schema.json': 'a4f174a56a3e53bad8c72ba0e888bd012164542920df293466c2e711aaece865',
};

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const segment = (overrides = {}) => ({
  schema_version: 'segment_input.v1', segment_id: 'seg_s1_001',
  reference_time: '2026-09-23T10:00:00+08:00', timezone: 'Asia/Shanghai',
  messages: [
    { message_id: 'msg_s1_a', evidence_id: 'ev_s1_a', author_role: 'user',
      created_at: '2026-09-23T09:58:00+08:00', context_only: false,
      content: '请在 2026 年 9 月 30 日前完成青石项目的风险清单。' },
    { message_id: 'msg_s1_b', evidence_id: 'ev_s1_b', author_role: 'assistant',
      created_at: '2026-09-23T09:59:00+08:00', context_only: true,
      content: '好的，我会整理青石项目的风险。' },
  ],
  ...overrides,
});
const item = (overrides = {}) => ({
  candidate_local_id: 'item_risk_list', item_type: 'task',
  claim: '需要在 2026 年 9 月 30 日前完成青石项目的风险清单。', summary: '完成青石项目风险清单',
  action_level: 'needs_action', priority: 'medium',
  entity_mentions: [{ type: 'project', mention: '青石项目', role: 'subject' }],
  topics: ['风险清单'],
  temporal_mentions: [{ kind: 'due_at', source_text: '2026 年 9 月 30 日前', source_message_id: 'msg_s1_a' }],
  source_anchors: [{ message_id: 'msg_s1_a', exact_quote: '完成青石项目的风险清单' }],
  confidence: 0.9, uncertainties: [], sensitivity_hint: 'none',
  ...overrides,
});
const documentOf = (items, segmentId = 'seg_s1_001') =>
  ({ schema_version: 'candidate_information.v1', segment_id: segmentId, items });

test('vendored M0-A files are byte-identical to the frozen parent', async () => {
  for (const [name, digest] of Object.entries(PINNED)) {
    assert.equal(sha256(await fs.readFile(path.join(vendored, name))), digest, name);
  }
  const lines = (await fs.readFile(path.join(vendored, 'SHA256SUMS.m0a-subset'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 20);
  for (const line of lines) {
    const [digest, file] = line.split(/\s+/);
    assert.equal(sha256(await fs.readFile(path.join(vendored, file))), digest, file);
  }
});

test('Information Flow S1 candidate store: isolation, validation, idempotency, provenance',
  { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-if-s1-'));
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

    // DB enum sets must equal the vendored frozen schemas.
    const candidateSchema = JSON.parse(await fs.readFile(path.join(vendored, 'candidate-information.v1.schema.json'), 'utf8'));
    const segmentSchema = JSON.parse(await fs.readFile(path.join(vendored, 'segment-input.v1.schema.json'), 'utf8'));
    const enums = (await admin.query('select clued_private.intake_schema_enums_v1() v')).rows[0].v;
    const defs = candidateSchema.$defs;
    const sorted = (values) => [...values].map(String).sort();
    assert.deepEqual(sorted(enums.item_type), sorted(defs.item.properties.item_type.enum));
    assert.deepEqual(sorted(enums.action_level), sorted(defs.item.properties.action_level.enum));
    assert.deepEqual(sorted(enums.priority), sorted(defs.item.properties.priority.enum));
    assert.deepEqual(sorted(enums.entity_type), sorted(defs.entityMention.properties.type.enum));
    assert.deepEqual(sorted(enums.entity_role), sorted(defs.entityMention.properties.role.enum));
    assert.deepEqual(sorted(enums.temporal_kind), sorted(defs.temporalMention.properties.kind.enum));
    assert.deepEqual(sorted(enums.sensitivity_hint), sorted(defs.item.properties.sensitivity_hint.enum));
    assert.deepEqual(sorted(enums.author_role), sorted(segmentSchema.$defs.message.properties.author_role.enum));
    assert.deepEqual(sorted(enums.item_keys), sorted(defs.item.required));
    assert.deepEqual(sorted(enums.item_keys), sorted(Object.keys(defs.item.properties)));
    assert.deepEqual(sorted(enums.message_keys), sorted(segmentSchema.$defs.message.required));
    assert.deepEqual(sorted(enums.segment_keys), sorted(segmentSchema.required));
    assert.deepEqual(sorted(enums.document_keys), sorted(Object.keys(candidateSchema.properties)));
    assert.equal(candidateSchema.additionalProperties, false);
    assert.equal(defs.item.additionalProperties, false);

    const validate = async (seg, doc) =>
      (await admin.query('select clued_private.intake_validate_v1($1,$2) v', [seg, doc])).rows[0].v;
    assert.deepEqual(await validate(segment(), documentOf([item()])), []);
    assert.deepEqual(await validate(segment(), documentOf([])), []);
    assert.deepEqual(await validate(segment(), documentOf([item({ extra: 1 })])), ['INSTANCE_SCHEMA_INVALID']);
    assert.deepEqual(await validate(segment(), documentOf([item({ item_type: 'fact' })])),
      ['INSTANCE_SCHEMA_INVALID'], 'priority must be null unless task');
    assert.deepEqual(await validate(segment(), documentOf([item({ confidence: '0.9' })])), ['INSTANCE_SCHEMA_INVALID']);
    assert.deepEqual(await validate(segment(), documentOf([item({ topics: ['a', 'a'] })])), ['INSTANCE_SCHEMA_INVALID']);
    assert.deepEqual(await validate(segment({ reference_time: 'yesterday' }), documentOf([item()])), ['INSTANCE_SCHEMA_INVALID']);
    assert.deepEqual(await validate(segment(), documentOf([item({
      source_anchors: [{ message_id: 'msg_s1_a', exact_quote: '不存在的原文' }] })])), ['SOURCE_QUOTE_MISMATCH']);
    assert.deepEqual(await validate(segment(), documentOf([item({
      source_anchors: [{ message_id: 'msg_s1_b', exact_quote: '整理青石项目的风险' }] })])), ['NO_EXTRACTABLE_ANCHOR']);
    assert.deepEqual(await validate(segment(), documentOf([item({
      source_anchors: [{ message_id: 'msg_missing', exact_quote: 'x' }] })])),
    ['NO_EXTRACTABLE_ANCHOR', 'SOURCE_MESSAGE_NOT_FOUND']);
    assert.deepEqual(await validate(segment(), documentOf([item(), item()])), ['DUPLICATE_CANDIDATE_LOCAL_ID']);
    assert.deepEqual(await validate(segment(), documentOf([item()], 'seg_other')), ['CANDIDATE_SEGMENT_MISMATCH']);
    assert.deepEqual(await validate(segment(), documentOf([item({ temporal_mentions: [
      { kind: 'due_at', source_text: '9 月 30 日', source_message_id: 'msg_x' }] })])), ['TEMPORAL_SOURCE_NOT_FOUND']);

    // The frozen M0-A candidate smoke fixtures (vendored, digest-checked) reproduce their expectations.
    {
      const smoke = path.join(vendored, 'fixtures/smoke');
      const ids = (await fs.readdir(smoke)).filter((name) => /^SMK-(CAN|NEG)-/.test(name));
      assert.equal(ids.length, 6);
      for (const id of ids) {
        const read = async (file) => JSON.parse(await fs.readFile(path.join(smoke, id, file), 'utf8'));
        const expectation = await read('expectation.json');
        if (expectation.fixture_type !== 'candidate') continue;
        assert.deepEqual(await validate(await read('input.json'), await read('output.json')),
          [...expectation.expected_error_codes].sort(), id);
      }
    }

    const userId = uuid();
    const tokenA = hash();
    const tokenB = hash();
    const tokenGlobalOnly = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'if-s1@example.invalid',now())", [userId]);
    const otherUser = uuid();
    const tokenOther = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'if-s1-other@example.invalid',now())", [otherUser]);
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Other user agent',$2,array['context:read','context:write'],array['*'])`,
    [otherUser, tokenOther]);
    const bindingA = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Agent A',$2,array['context:read','context:write'],array['*']) returning id`,
    [userId, tokenA])).rows[0].id;
    await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Agent B',$2,array['context:read','context:write'],array['*']),
            ($1,'synthetic','Global only',$3,array['context:read','context:write'],array['global'])`,
    [userId, tokenB, tokenGlobalOnly]);

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
    const snapshot = async () => (await admin.query(`select
        (select count(*)::int from public.clued_memories where user_id=$1) memories,
        (select count(*)::int from clued_private.mtpe_intake_projection where user_id=$1) mtpe,
        (select coalesce(sum(invalidation_revision),0)::int from clued_private.projection_invalidation_heads where user_id=$1) projection_inv,
        (select coalesce(sum(snapshot_revision),0)::int from clued_private.scope_currentness_heads where user_id=$1) currentness,
        (select count(*)::int from clued_private.event_truth_carriers where user_id=$1) carriers`, [userId])).rows[0];
    const before = await snapshot();

    // Agent submit: route fixes tier/source; server computes the Evidence hash.
    const submitInput = { idempotency_key: 'if-s1-submit-0001', scope: 'global', client_label: 'agent-a',
      segment: segment(), candidates: documentOf([item(), item({ candidate_local_id: 'item_decision',
        item_type: 'decision', priority: null, action_level: 'reference',
        claim: '青石项目需要风险清单。', summary: '青石项目需要风险清单' })]) };
    const submitted = await agent(tokenA, 'clued_intake_submit', submitInput);
    assert.equal(submitted.status, 'committed', JSON.stringify(submitted));
    assert.equal(submitted.supplemental.candidates.length, 2);
    const submission = (await admin.query(
      'select * from clued_private.information_intake_submissions where id=$1',
      [submitted.supplemental.submission_id])).rows[0];
    assert.equal(submission.source_kind, 'agent_binding');
    assert.equal(submission.binding_id, bindingA);
    const evidence = (await admin.query('select * from public.clued_evidence where id=$1',
      [submission.evidence_id])).rows[0];
    const segmentText = (await admin.query('select $1::jsonb::text t', [submitInput.segment])).rows[0].t;
    assert.equal(evidence.content_hash, sha256(Buffer.from(segmentText, 'utf8')));
    assert.equal(evidence.storage_ref, `intake:${submission.id}`);
    const candidates = (await admin.query(`select * from clued_private.information_candidates
      where submission_id=$1 order by candidate_local_id`, [submission.id])).rows;
    assert.deepEqual(candidates.map((row) => [row.tier, row.status, row.version, row.source_kind]),
      [['information', 'pending', 1, 'agent_binding'], ['information', 'pending', 1, 'agent_binding']]);
    assert.deepEqual(candidates[0].evidence_ids, [submission.evidence_id]);

    // Audit-only Event: event_type 'action', extension name only in canonical_event_type, no carrier.
    const event = (await admin.query(`select * from public.clued_context_events
      where id=$1::bigint`, [submitted.event_ids[0]])).rows[0];
    assert.equal(event.event_type, 'action');
    assert.equal(event.canonical_event_type, 'extension:information_flow:candidate_submitted');
    assert.equal(event.audit_visibility, 'audit_only');
    assert.equal((await admin.query('select count(*)::int n from clued_private.event_truth_carriers where event_id=$1',
      [event.id])).rows[0].n, 0);
    // Candidates never touch Canonical Records, MTPE, projections or Currentness.
    assert.deepEqual(await snapshot(), before);

    // Idempotent replay; same key with a different payload conflicts.
    const replay = await agent(tokenA, 'clued_intake_submit', submitInput);
    assert.equal(replay.receipt_id, submitted.receipt_id);
    assert.equal(replay.replayed, true);
    const conflict = await agent(tokenA, 'clued_intake_submit', { ...submitInput, client_label: 'changed' });
    assert.equal(conflict.status, 'rejected');
    assert.equal(conflict.error_code, 'IDEMPOTENCY_KEY_CONFLICT');
    assert.equal((await admin.query('select count(*)::int n from clued_private.information_intake_submissions where user_id=$1',
      [userId])).rows[0].n, 1);

    // Payload cannot choose tier/authority/target; invalid anchors are rejected with no residue.
    const evidenceBefore = (await admin.query('select count(*)::int n from public.clued_evidence where user_id=$1', [userId])).rows[0].n;
    const smuggled = await agent(tokenA, 'clued_intake_submit', { ...submitInput,
      idempotency_key: 'if-s1-submit-0002', tier: 'authority', authority: 'user_explicit' });
    assert.equal(smuggled.status, 'rejected');
    assert.match(smuggled.error_code, /intake_unknown_field/);
    const smuggledItem = await agent(tokenA, 'clued_intake_submit', { ...submitInput,
      idempotency_key: 'if-s1-submit-0003', candidates: documentOf([item({ record_type: 'task' })]) });
    assert.equal(smuggledItem.status, 'rejected');
    assert.match(smuggledItem.error_code, /INSTANCE_SCHEMA_INVALID/);
    const badQuote = await agent(tokenA, 'clued_intake_submit', { ...submitInput,
      idempotency_key: 'if-s1-submit-0004', candidates: documentOf([item({
        source_anchors: [{ message_id: 'msg_s1_a', exact_quote: '伪造原文' }] })]) });
    assert.equal(badQuote.status, 'rejected');
    assert.match(badQuote.error_code, /SOURCE_QUOTE_MISMATCH/);
    assert.equal((await admin.query('select count(*)::int n from public.clued_evidence where user_id=$1', [userId])).rows[0].n,
      evidenceBefore, 'rejected submits leave no Evidence');
    assert.equal((await admin.query('select count(*)::int n from clued_private.information_candidates where user_id=$1',
      [userId])).rows[0].n, 2);

    // Scope is authorized through the Binding's context_keys.
    await assert.rejects(agent(tokenGlobalOnly, 'clued_intake_submit', { ...submitInput,
      idempotency_key: 'if-s1-submit-0005', scope: 'profile' }), /binding_not_authorized/);

    // Native submit records the account session and no Binding.
    const nativeSubmit = await native('clued_user_intake_submit', { ...submitInput, idempotency_key: 'if-s1-native-0001',
      client_label: 'native', segment: segment({ segment_id: 'seg_s1_002' }),
      candidates: documentOf([item()], 'seg_s1_002') });
    assert.equal(nativeSubmit.status, 'committed', JSON.stringify(nativeSubmit));
    const nativeRow = (await admin.query('select * from clued_private.information_intake_submissions where id=$1',
      [nativeSubmit.supplemental.submission_id])).rows[0];
    assert.equal(nativeRow.source_kind, 'native_ui');
    assert.equal(nativeRow.binding_id, null);

    // Listing: a Binding sees only its own candidates; the owner sees all; nothing is authoritative.
    const listA = await agent(tokenA, 'clued_intake_list', { scope: 'global' });
    assert.equal(listA.candidates.length, 2);
    assert.ok(listA.candidates.every((row) => row.authority === 'none' && row.authoritative === false));
    assert.equal((await agent(tokenB, 'clued_intake_list', { scope: 'global' })).candidates.length, 0);
    assert.equal((await human.query('select public.clued_user_intake_list($1) v', [{ scope: 'global' }])).rows[0].v
      .candidates.length, 3);

    // Withdraw: owner-Binding only, row-version CAS, pending only, Receipt per transition.
    const target = candidates[0];
    const byOther = await agent(tokenB, 'clued_intake_withdraw',
      { idempotency_key: 'if-s1-withdraw-b1', scope: 'global', candidate_id: target.id, base_version: 1 });
    assert.equal(byOther.status, 'rejected');
    assert.match(byOther.error_code, /candidate_not_found/);
    const stale = await agent(tokenA, 'clued_intake_withdraw',
      { idempotency_key: 'if-s1-withdraw-a0', scope: 'global', candidate_id: target.id, base_version: 7 });
    assert.equal(stale.status, 'rejected');
    assert.match(stale.error_code, /candidate_version_conflict/);
    const withdrawn = await agent(tokenA, 'clued_intake_withdraw',
      { idempotency_key: 'if-s1-withdraw-a1', scope: 'global', candidate_id: target.id, base_version: 1 });
    assert.equal(withdrawn.status, 'committed', JSON.stringify(withdrawn));
    const after = (await admin.query('select status,version,last_receipt_id from clued_private.information_candidates where id=$1',
      [target.id])).rows[0];
    assert.deepEqual([after.status, after.version, after.last_receipt_id], ['withdrawn', 2, withdrawn.receipt_id]);
    const again = await agent(tokenA, 'clued_intake_withdraw',
      { idempotency_key: 'if-s1-withdraw-a2', scope: 'global', candidate_id: target.id, base_version: 2 });
    assert.equal(again.status, 'rejected');
    assert.match(again.error_code, /candidate_not_pending/);
    assert.deepEqual((await admin.query(`select from_status,to_status,receipt_id from clued_private.candidate_transitions
      where candidate_id=$1 order by id`, [target.id])).rows.map((row) => [row.from_status, row.to_status, row.receipt_id]),
    [[null, 'pending', submitted.receipt_id], ['pending', 'withdrawn', withdrawn.receipt_id]]);
    assert.deepEqual(await snapshot(), before, 'withdrawal also leaves Canonical state untouched');

    // A forged Event with the same extension name changes no candidate state, and the
    // extension names stay out of the typed currentness registry.
    const stateBefore = (await admin.query(`select id,status,version from clued_private.information_candidates
      where user_id=$1 order by id`, [userId])).rows;
    const forged = await agent(tokenA, 'clued_event_append', { idempotency_key: 'if-s1-forged-01',
      event_schema_version: 1, event_type: 'extension:information_flow:candidate_withdrawn', event_scope: 'global',
      audit_visibility: 'work_log', target_refs: [{ kind: 'system', id: `information_candidate:${candidates[1].id}` }],
      change_summary: { candidate_id: candidates[1].id } });
    assert.equal(forged.status, 'committed', JSON.stringify(forged));
    assert.deepEqual((await admin.query(`select id,status,version from clued_private.information_candidates
      where user_id=$1 order by id`, [userId])).rows, stateBefore);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.typed_event_currentness_registry
      where event_type like 'extension:information_flow:%'`)).rows[0].n, 0);

    // Cross-user isolation: another user's Binding can neither see nor withdraw these candidates.
    assert.equal((await agent(tokenOther, 'clued_intake_list', { scope: 'global' })).candidates.length, 0);
    const foreign = await agent(tokenOther, 'clued_intake_withdraw',
      { idempotency_key: 'if-s1-foreign-01', scope: 'global', candidate_id: candidates[1].id, base_version: 1 });
    assert.equal(foreign.status, 'rejected');
    assert.match(foreign.error_code, /candidate_not_found/);
    const malformed = await agent(tokenA, 'clued_intake_withdraw',
      { idempotency_key: 'if-s1-malformed-01', scope: 'global', candidate_id: 'not-a-uuid', base_version: 1 });
    assert.equal(malformed.status, 'rejected', 'malformed input is a rejection, not a failure');

    // The same client key reused across operations does not collide on the Event key.
    const reusedKey = await agent(tokenA, 'clued_intake_withdraw',
      { idempotency_key: 'if-s1-submit-0001', scope: 'global', candidate_id: candidates[1].id, base_version: 1 });
    assert.equal(reusedKey.status, 'committed', JSON.stringify(reusedKey));

    // Submission lookup after an unknown outcome.
    const bySubmission = await agent(tokenA, 'clued_intake_list',
      { scope: 'global', submission_id: submitted.supplemental.submission_id });
    assert.deepEqual(bySubmission.candidates.map((row) => row.submission_id),
      [submitted.supplemental.submission_id, submitted.supplemental.submission_id]);

    // Grants: tables are private; each entry is callable only by its own principal kind.
    for (const table of ['information_intake_submissions', 'information_candidates',
      'knowledge_candidates', 'candidate_transitions']) {
      await assert.rejects(anon.query(`select 1 from clued_private.${table}`), /permission denied/);
      await assert.rejects(human.query(`select 1 from clued_private.${table}`), /permission denied/);
    }
    const privileges = (await admin.query(`select p.oid::regprocedure::text fn,
        has_function_privilege('anon',p.oid,'execute') anon,
        has_function_privilege('authenticated',p.oid,'execute') authenticated,
        has_function_privilege('service_role',p.oid,'execute') service_role
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='clued_private' and p.proname like 'intake\\_%'`)).rows;
    // Eight S1 functions plus the S2 payload cap and context-key helper.
    assert.equal(privileges.length, 10);
    for (const row of privileges) {
      assert.deepEqual([row.anon, row.authenticated, row.service_role], [false, false, false], row.fn);
    }
    const entries = (await admin.query(`select p.proname,
        has_function_privilege('anon',p.oid,'execute') anon,
        has_function_privilege('authenticated',p.oid,'execute') authenticated,
        has_function_privilege('service_role',p.oid,'execute') service_role,
        has_function_privilege('clued_worker_gateway',p.oid,'execute') gateway
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'clued\\_%intake\\_%' order by 1`)).rows;
    assert.deepEqual(entries.map((row) => [row.proname, row.anon, row.authenticated, row.service_role, row.gateway]), [
      ['clued_intake_list', false, false, false, true], ['clued_intake_submit', false, false, false, true],
      ['clued_intake_withdraw', false, false, false, true], ['clued_user_intake_list', false, true, false, false],
      ['clued_user_intake_submit', false, true, false, false], ['clued_user_intake_withdraw', false, true, false, false]]);
    await assert.rejects(human.query('select public.clued_intake_submit($1,$2)', [tokenA, submitInput]), /permission denied/);
    await assert.rejects(anon.query('select public.clued_user_intake_submit($1,$2)', [submitInput, hash()]), /permission denied/);
    await assert.rejects(anon.query('select clued_private.intake_submit_core_v1($1,null,$2,$3)',
      [userId, submitInput, hash()]), /permission denied/);
    await human.query(`select set_config('request.jwt.claims','{"client_id":"delegated-oauth"}',false)`);
    await assert.rejects(native('clued_user_intake_submit', { ...submitInput, idempotency_key: 'if-s1-native-0002' }),
      /direct_human_session_required/);
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
