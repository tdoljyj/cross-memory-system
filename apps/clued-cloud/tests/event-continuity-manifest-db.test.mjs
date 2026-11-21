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
import { setWorkerGatewayCaller, findGatewayCloseoutMigration, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Task 32dbbd35: reusable Owner-approved exact-manifest continuity-only resolution.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const FN = 'clued_private.reconcile_event_continuity_manifest_v1';
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('event continuity manifest resolves only an exact, Owner-approved, unchanged set', { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-continuity-manifest-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
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
    // The complete migration chain must include the formal G6 closeout.
    await findGatewayCloseoutMigration(root);
    await assertGatewayCloseoutBoundary(admin);
    await allowRawTestBindings(admin);

    // The entry is private to the database owner.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') ok',
        [role, `${FN}(uuid,jsonb,text,uuid,uuid,boolean)`])).rows[0].ok, false, role);
    }

    const userId = uuid();
    const otherUser = uuid();
    const token = hash();
    const projectScope = `project:${uuid()}`;
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'owner@example.invalid',now()),($2,'other@example.invalid',now())`, [userId, otherUser]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Owner host',$2,array['context:read','context:write'],array['global'])`, [userId, token]);
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const mutate = async (input) => (await gateway.query('select public.clued_record_mutate($1,$2) v', [token, input])).rows[0].v;
    const decision = async (title, relations = {}) => {
      const result = await mutate({
        operation: 'create', record_type: 'decision', record_schema_version: 1, lifecycle_status: 'active',
        scope: 'global', authority: 'user_explicit', user_confirmed: true, idempotency_key: uuid(),
        confidence_reason: 'Synthetic fixture', source_refs: [], source_unavailable_reason: 'fixture',
        mutation: { title, content: title, type_fields: { rationale: 'fixture' }, relations },
      });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return { id: result.target_refs[0].id, receipt: result.receipt_id };
    };

    // Two active unstructured global Events (the 1270/1275 shape) and one of another owner.
    await admin.query(`insert into public.clued_context_events(id,user_id,binding_id,context_key,event_type,payload,version,audit_visibility,occurred_at)
      values(9270,$1,null,'global','decision','{"step":"S06.14"}',1,'work_log',now()),
            (9275,$1,null,'global','decision','{"step":"S06.15"}',2,'work_log',now()),
            (9280,$2,null,'global','decision','{"step":"other"}',1,'work_log',now())`, [userId, otherUser]);
    await admin.query(`insert into clued_private.event_truth_carriers(event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
      values(9270,$1,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',1),
            (9275,$1,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',2),
            (9280,$2,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',1)`, [userId, otherUser]);
    const payloadSha = async (id) => (await admin.query(`select encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') h
      from public.clued_context_events where id=$1`, [id])).rows[0].h;
    const eventHash = async (id) => (await admin.query(
      'select clued_private.currentness_hash(to_jsonb(e)) h from public.clued_context_events e where id=$1', [id])).rows[0].h;
    const carrier = async (id) => (await admin.query(
      'select carrier_state,transition_version::int v from clued_private.event_truth_carriers where event_id=$1', [id])).rows[0];

    const pinOf = async (id) => {
      const row = (await admin.query('select version::int v,content_hash h from public.clued_memories where id=$1', [id])).rows[0];
      return { id, version: row.v, content_hash: row.h };
    };
    const carrying = await decision('Carried meaning of 9270 and 9275');
    const carryingPin = await pinOf(carrying.id);
    const entry = async (id, extra = {}) => ({
      event_id: id, scope: 'global', event_type: 'decision', payload_sha256: await payloadSha(id),
      expected_transition_version: 1, expected_carrier_state: 'ACTIVE_UNSTRUCTURED',
      carrier_source_kind: 'legacy', carrier_dimensions: ['decision'],
      reason_code: 'CARRIED_BY_DECISION', carried_by_records: [carryingPin], ...extra,
    });
    const manifestOf = async (events, extra = {}) => ({
      contract: 'event-continuity-manifest.v1', user_id: userId, target_state: 'RESOLVED_CONTINUITY_ONLY', events, ...extra,
    });
    const run = (manifest, ...rest) => admin.query(`select ${FN}($1,$2,$3,$4,$5,$6) r`,
      [userId, manifest, rest[0] ?? null, rest[1] ?? null, rest[2] ?? null, rest[3] ?? false]);
    const digestOf = async (manifest) => (await run(manifest)).rows[0].r.manifest_digest;
    const approve = async (manifest, count = manifest.events.length) => decision(`Owner approves ${hash().slice(0, 8)}`, {
      manifest_digest: await digestOf(manifest), event_count: String(count), target_state: 'RESOLVED_CONTINUITY_ONLY' });
    const proofCount = async () => (await admin.query(`select count(*)::int n from public.clued_audit_receipts
      where user_id=$1 and operation='continuity_only_resolution_authorized'`, [userId])).rows[0].n;
    const manifest = await manifestOf([await entry(9270), await entry(9275)]);

    // 1. Shape: only the exact v1 manifest is accepted, and malformed values fail
    //    with the manifest error, never a raw cast error.
    for (const bad of [
      { ...manifest, extra: true },
      { ...manifest, contract: 'other' },
      { ...manifest, target_state: 'RETRACTED' },
      { ...manifest, events: [] },
      { ...manifest, events: [manifest.events[0], manifest.events[0]] },
      { ...manifest, events: [{ ...manifest.events[0], carried_by_records: [] }] },
      { ...manifest, events: [{ ...manifest.events[0], carried_by_records: [carryingPin, carryingPin] }] },
      { ...manifest, events: [{ ...manifest.events[0], carried_by_records: [carrying.id] }] },
      { ...manifest, events: [{ ...manifest.events[0], note: 'x' }] },
      { ...manifest, events: [{ ...manifest.events[0], event_id: '9270' }] },
      { ...manifest, events: [{ ...manifest.events[0], event_id: 99999999999999999999 }] },
      { ...manifest, events: [{ ...manifest.events[0], expected_carrier_state: 'LEGACY_UNBOUND' }] },
      { ...manifest, events: [{ ...manifest.events[0], expected_carrier_state: null }] },
      { ...manifest, user_id: '-'.repeat(36) },
      { ...manifest, user_id: otherUser },
    ]) {
      await assert.rejects(() => run(bad), /continuity_manifest_invalid/, JSON.stringify(bad));
    }

    // 2. Dry run passes on the exact set and changes nothing.
    const dry = (await run(manifest)).rows[0].r;
    assert.equal(dry.status, 'dry_run_ok');
    assert.match(dry.manifest_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(await carrier(9270), { carrier_state: 'ACTIVE_UNSTRUCTURED', v: 1 });

    // 3. Drift and cross-owner sources reject the whole batch.
    const second = manifest.events[1];
    for (const [changed, pattern] of [
      [{ ...second, expected_transition_version: 2 }, /continuity_manifest_source_changed event=9275/],
      [{ ...second, payload_sha256: '0'.repeat(64) }, /continuity_manifest_source_changed event=9275/],
      [{ ...second, scope: projectScope }, /continuity_manifest_source_changed event=9275/],
      [{ ...second, expected_carrier_state: 'ACTIVE_TYPED' }, /continuity_manifest_source_changed event=9275/],
      [{ ...second, carrier_dimensions: ['decision', 'task'] }, /continuity_manifest_source_changed event=9275/],
      [{ ...second, carrier_source_kind: 'direct' }, /continuity_manifest_source_changed event=9275/],
      [{ ...second, carried_by_records: [{ ...carryingPin, version: 2 }] }, /continuity_manifest_carrying_record_changed event=9275/],
      [{ ...second, carried_by_records: [{ ...carryingPin, content_hash: '0'.repeat(64) }] }, /continuity_manifest_carrying_record_changed event=9275/],
      [{ ...second, carried_by_records: [{ ...carryingPin, id: uuid() }] }, /continuity_manifest_carrying_record_changed event=9275/],
    ]) {
      await assert.rejects(() => run({ ...manifest, events: [manifest.events[0], changed] }), pattern, JSON.stringify(changed));
    }
    await assert.rejects(async () => run(await manifestOf([await entry(9280)])),
      /continuity_manifest_source_changed event=9280/);
    // Another owner's Record cannot carry this owner's Event.
    const otherToken = hash();
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Other host',$2,array['context:read','context:write'],array['global'])`, [otherUser, otherToken]);
    const foreign = (await gateway.query('select public.clued_record_mutate($1,$2) v', [otherToken, {
      operation: 'create', record_type: 'decision', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', authority: 'user_explicit', user_confirmed: true, idempotency_key: uuid(),
      confidence_reason: 'Synthetic fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'Foreign', content: 'Foreign', type_fields: { rationale: 'fixture' }, relations: {} } }])).rows[0].v;
    const foreignPin = await pinOf(foreign.target_refs[0].id);
    await assert.rejects(() => run({ ...manifest, events: [{ ...manifest.events[0], carried_by_records: [foreignPin] }] }),
      /continuity_manifest_carrying_record_changed event=9270/);

    // A carrying Record that is closed or rewritten no longer carries the pinned meaning.
    const closedRecord = await decision('Carrying record that will be closed');
    const closedPin = await pinOf(closedRecord.id);
    const closeResult = await mutate({ operation: 'close', record_type: 'decision', record_schema_version: 1,
      lifecycle_status: 'completed', scope: 'global', id: closedRecord.id, base_version: 1,
      authority: 'user_explicit', user_confirmed: true, idempotency_key: uuid(), confidence_reason: 'fixture',
      mutation: { closed_reason: 'fixture' } });
    assert.equal(closeResult.status, 'committed', JSON.stringify(closeResult));
    await assert.rejects(() => run({ ...manifest, events: [{ ...manifest.events[0], carried_by_records: [closedPin] }] }),
      /continuity_manifest_carrying_record_changed event=9270/);

    // A carrying version whose Evidence was withdrawn no longer carries the meaning.
    const withdrawnRecord = await decision('Carrying record whose Evidence is withdrawn');
    const withdrawnPin = await pinOf(withdrawnRecord.id);
    // Throwaway database: a flag row stands in for a full Native withdrawal.
    await admin.query('alter table clued_private.record_evidence_status drop constraint record_evidence_status_withdrawal_id_fkey');
    await admin.query('alter table clued_private.record_evidence_status disable trigger user');
    await admin.query(`insert into clued_private.record_evidence_status(user_id,record_id,record_version,evidence_id,withdrawal_id,flagged_by)
      values($1,$2,$3,$4,$5,'withdrawal')`, [userId, withdrawnRecord.id, withdrawnPin.version, uuid(), uuid()]);
    await admin.query('alter table clued_private.record_evidence_status enable trigger user');
    await assert.rejects(() => run({ ...manifest, events: [{ ...manifest.events[0], carried_by_records: [withdrawnPin] }] }),
      /continuity_manifest_carrying_record_changed event=9270/);

    // 4. Execution needs the exact digest and an Owner Decision that names it.
    await assert.rejects(() => run(manifest, null, null, null, true), /continuity_manifest_approval_required/);
    await assert.rejects(() => run(manifest, '0'.repeat(64), uuid(), uuid(), true), /continuity_manifest_digest_mismatch/);
    const noDigest = await decision('Approval without digest');
    await assert.rejects(() => run(manifest, dry.manifest_digest, noDigest.id, noDigest.receipt, true),
      /continuity_manifest_approval_invalid/);
    const wrongCount = await approve(manifest, 3);
    await assert.rejects(() => run(manifest, dry.manifest_digest, wrongCount.id, wrongCount.receipt, true),
      /continuity_manifest_approval_invalid/);
    const approval = await approve(manifest);
    await assert.rejects(() => run(manifest, dry.manifest_digest, approval.id, carrying.receipt, true),
      /continuity_manifest_approval_invalid/);
    // A Receipt that did not come through a Binding cannot stand in for the approval.
    await admin.query('update public.clued_audit_receipts set binding_id=null where id=$1', [approval.receipt]);
    await assert.rejects(() => run(manifest, dry.manifest_digest, approval.id, approval.receipt, true),
      /continuity_manifest_approval_invalid/);
    const approvalBinding = (await admin.query('select id from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1($1)', [token])).rows[0].id;
    await admin.query('update public.clued_audit_receipts set binding_id=$1 where id=$2', [approvalBinding, approval.receipt]);
    // A project-scope Decision cannot approve global Events.
    await admin.query('update public.clued_memories set canonical_scope=$1 where id=$2', [projectScope, approval.id]);
    await assert.rejects(() => run(manifest, dry.manifest_digest, approval.id, approval.receipt, true),
      /continuity_manifest_approval_invalid/);
    await admin.query("update public.clued_memories set canonical_scope='global' where id=$1", [approval.id]);
    // Drift after approval still rejects at execution, and a failed execution writes nothing.
    await admin.query(`update public.clued_context_events set payload='{"step":"S06.15","edited":true}' where id=9275`);
    await assert.rejects(() => run(manifest, dry.manifest_digest, approval.id, approval.receipt, true),
      /continuity_manifest_source_changed event=9275/);
    assert.equal(await proofCount(), 0);
    assert.deepEqual(await carrier(9270), { carrier_state: 'ACTIVE_UNSTRUCTURED', v: 1 });
    await admin.query(`update public.clued_context_events set payload='{"step":"S06.15"}' where id=9275`);
    assert.equal(await payloadSha(9275), manifest.events[1].payload_sha256);

    // 5. An ordinary Canonical write Receipt cannot stand in for the proof on the MCP path.
    await assert.rejects(() => gateway.query('select public.clued_mcp_event_carrier_transition($1,$2) v', [token, {
      context_key: 'global', transition: 'resolve', source_event_id: 9270, expected_transition_version: 1,
      idempotency_key: uuid(), proof_receipt_id: approval.receipt }]), /continuity_only_proof_required/);
    assert.deepEqual(await carrier(9270), { carrier_state: 'ACTIVE_UNSTRUCTURED', v: 1 });

    // 6. The approved exact set resolves; Events and carrying Records stay unchanged.
    const before = { e1: await eventHash(9270), e2: await eventHash(9275),
      record: (await admin.query('select version,content_hash from public.clued_memories where id=$1', [carrying.id])).rows[0] };
    const invalidationBefore = (await admin.query(`select invalidation_revision::int n
      from clued_private.projection_invalidation_heads where user_id=$1 and target_scope='global'
        and projection_key='global.__aggregate__'`, [userId])).rows[0]?.n ?? 0;
    const done = (await run(manifest, dry.manifest_digest, approval.id, approval.receipt, true)).rows[0].r;
    assert.equal(done.status, 'reconciled', JSON.stringify(done));
    assert.equal(done.count, 2);
    assert.equal(done.currentness_claim, false);
    for (const id of [9270, 9275]) assert.deepEqual(await carrier(id), { carrier_state: 'RESOLVED_CONTINUITY_ONLY', v: 2 });
    assert.deepEqual(await carrier(9280), { carrier_state: 'ACTIVE_UNSTRUCTURED', v: 1 });
    assert.equal(await eventHash(9270), before.e1);
    assert.equal(await eventHash(9275), before.e2);
    assert.deepEqual((await admin.query('select version,content_hash from public.clued_memories where id=$1', [carrying.id])).rows[0], before.record);
    const proofs = (await admin.query(`select id,object_id,context_key,version::int v,metadata,related_receipt_id
      from public.clued_audit_receipts where user_id=$1 and operation='continuity_only_resolution_authorized'
      order by object_id`, [userId])).rows;
    assert.equal(proofs.length, 2);
    for (const proof of proofs) {
      const item = manifest.events.find((e) => String(e.event_id) === proof.object_id);
      assert.equal(proof.context_key, 'global');
      assert.equal(proof.v, 1);
      assert.equal(proof.related_receipt_id, approval.receipt);
      assert.equal(proof.metadata.manifest_digest, dry.manifest_digest);
      assert.equal(proof.metadata.target_state, 'RESOLVED_CONTINUITY_ONLY');
      assert.equal(proof.metadata.expected_transition_version, '1');
      assert.equal(proof.metadata.expected_carrier_state, 'ACTIVE_UNSTRUCTURED');
      assert.equal(proof.metadata.event_type, item.event_type);
      assert.equal(proof.metadata.payload_sha256, item.payload_sha256);
      assert.equal(proof.metadata.approval_record_id, approval.id);
      assert.equal(proof.metadata.approval_receipt_id, approval.receipt);
      assert.equal(proof.metadata.reason_code, 'CARRIED_BY_DECISION');
      assert.match(proof.metadata.transaction_id, /^[0-9]+$/);
      assert.deepEqual(proof.metadata.carried_by_records, [carryingPin]);
      const transition = (await admin.query(`select metadata,related_receipt_id from public.clued_audit_receipts
        where user_id=$1 and operation='carrier_transition' and object_id=$2`, [userId, proof.object_id])).rows;
      assert.equal(transition.length, 1);
      assert.equal(transition[0].related_receipt_id, proof.id);
      assert.equal(transition[0].metadata.proof_receipt_id, proof.id);
      assert.equal(transition[0].metadata.transaction_id, proof.metadata.transaction_id);
    }
    const batch = (await admin.query(`select metadata from public.clued_audit_receipts
      where user_id=$1 and operation='event_continuity_manifest_reconcile'`, [userId])).rows;
    assert.equal(batch.length, 1);
    assert.deepEqual(batch[0].metadata.manifest, manifest);
    assert.equal((await admin.query(`select encode(extensions.digest(convert_to($1::jsonb::text,'UTF8'),'sha256'),'hex') d`,
      [batch[0].metadata.manifest])).rows[0].d, dry.manifest_digest, 'the stored manifest reproduces the approved digest');
    const invalidationAfter = (await admin.query(`select invalidation_revision::int n
      from clued_private.projection_invalidation_heads where user_id=$1 and target_scope='global'
        and projection_key='global.__aggregate__'`, [userId])).rows[0].n;
    // Carrier transitions also touch currentness, so the revision may move more than once;
    // the function's own invalidation is the last writer of both Global heads.
    assert.ok(invalidationAfter > invalidationBefore, `${invalidationBefore} -> ${invalidationAfter}`);
    for (const key of ['global.priority_frontier', 'global.__aggregate__']) {
      const head = (await admin.query(`select latest_source_ref r from clued_private.projection_invalidation_heads
        where user_id=$1 and target_scope='global' and projection_key=$2`, [userId, key])).rows[0].r;
      assert.equal(head.kind, 'continuity_resolution', key);
      assert.equal(head.manifest_digest, dry.manifest_digest, key);
    }

    // 7. Replay is a no-op; the resolved Events cannot enter a new batch.
    assert.equal((await run(manifest, dry.manifest_digest, approval.id, approval.receipt, true)).rows[0].r.status,
      'already_reconciled');
    assert.equal(await proofCount(), 2);
    await assert.rejects(async () => run(await manifestOf([await entry(9270)])),
      /continuity_manifest_source_changed event=9270/);

    // 8. A typed carrier resolves only when the manifest says it is typed.
    await admin.query(`insert into public.clued_context_events(id,user_id,binding_id,context_key,event_type,payload,version,audit_visibility,occurred_at)
      values(9290,$1,null,'global','action','{"typed":true}',3,'work_log',now())`, [userId]);
    await admin.query(`insert into clued_private.event_truth_carriers(event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
      values(9290,$1,'global',array['task'],'work_log','direct','ACTIVE_TYPED',3)`, [userId]);
    const typedAsUnstructured = await manifestOf([await entry(9290, { event_type: 'action',
      carrier_source_kind: 'direct', carrier_dimensions: ['task'] })]);
    await assert.rejects(() => run(typedAsUnstructured), /continuity_manifest_source_changed event=9290/);
    const typed = await manifestOf([await entry(9290, { event_type: 'action', expected_carrier_state: 'ACTIVE_TYPED',
      carrier_source_kind: 'direct', carrier_dimensions: ['task'] })]);
    const typedApproval = await approve(typed);
    const typedDone = (await run(typed, await digestOf(typed), typedApproval.id, typedApproval.receipt, true)).rows[0].r;
    assert.equal(typedDone.status, 'reconciled', JSON.stringify(typedDone));
    assert.deepEqual(await carrier(9290), { carrier_state: 'RESOLVED_CONTINUITY_ONLY', v: 2 });

    // 9. A database without the Evidence status table (before Information Flow S5) still reconciles.
    await admin.query(`insert into public.clued_context_events(id,user_id,binding_id,context_key,event_type,payload,version,audit_visibility,occurred_at)
      values(9295,$1,null,'global','decision','{"pre_s5":true}',4,'work_log',now())`, [userId]);
    await admin.query(`insert into clued_private.event_truth_carriers(event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
      values(9295,$1,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',4)`, [userId]);
    const preS5 = await manifestOf([await entry(9295)]);
    const preS5Approval = await approve(preS5);
    await admin.query('alter table clued_private.record_evidence_status rename to record_evidence_status_absent');
    assert.equal((await run(preS5)).rows[0].r.status, 'dry_run_ok');
    const preS5Done = (await run(preS5, await digestOf(preS5), preS5Approval.id, preS5Approval.receipt, true)).rows[0].r;
    assert.equal(preS5Done.status, 'reconciled', JSON.stringify(preS5Done));
    assert.deepEqual(await carrier(9295), { carrier_state: 'RESOLVED_CONTINUITY_ONLY', v: 2 });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
