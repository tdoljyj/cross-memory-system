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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
async function port() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}

test('legacy create notification reconciliation requires exact source and produces only auditable carrier transitions', { timeout: 180000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-create-carrier-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await port(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    const userId = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'legacy-create@example.invalid',now())", [userId]);
    const write = async (title, type = 'archive_snapshot') => {
      const result = (await admin.query('select clued_private.record_write_core($1,null,$2) result', [userId, { action: 'create', scope: 'global', record_type: type, title, content: 'Historical snapshot', source_ref: 'fixture:legacy-create', idempotency_key: uuid() }])).rows[0].result;
      await admin.query(`insert into clued_private.event_truth_carriers(event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
        values($1,$2,'global',array['state','task'],'work_log','legacy','ACTIVE_UNSTRUCTURED',null)`, [result.event_id, userId]);
      return result;
    };
    const source = await write('Exact archived create');
    assert.equal(source.status, 'written');
    const sourceHash = (await admin.query('select clued_private.currentness_hash(to_jsonb(m)) hash from public.clued_memories m where id=$1', [source.record.id])).rows[0].hash;
    const eventHash = (await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=$1', [source.event_id])).rows[0].hash;
    const dry = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global'])).rows[0].result;
    assert.equal(dry.count, 1, JSON.stringify({sourceEvent:source.event_id, carriers:(await admin.query('select event_id,carrier_state,visibility,source_kind,canonical_scope from clued_private.event_truth_carriers')).rows}));
    assert.match(dry.manifest_digest, /^[0-9a-f]{64}$/);
    await assert.rejects(() => admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2,null,null,null)', [userId, 'global']), /legacy_create_execute_flag_required/);
    assert.equal((await admin.query('select carrier_state from clued_private.event_truth_carriers where event_id=$1', [source.event_id])).rows[0].carrier_state, 'ACTIVE_UNSTRUCTURED');
    await assert.rejects(() => admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2,$3,$4,true)', [userId, 'global', 1, hash()]), /legacy_create_manifest_changed/);
    const done = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2,$3,$4,true) result', [userId, 'global', dry.count, dry.manifest_digest])).rows[0].result;
    assert.equal(done.status, 'reconciled');
    assert.equal(done.currentness_claim, false);
    const carrier = (await admin.query('select carrier_state,transition_version from clued_private.event_truth_carriers where event_id=$1', [source.event_id])).rows[0];
    assert.equal(carrier.carrier_state, 'RESOLVED_CONTINUITY_ONLY');
    assert.equal(Number(carrier.transition_version), 2);
    assert.equal((await admin.query('select clued_private.currentness_hash(to_jsonb(m)) hash from public.clued_memories m where id=$1', [source.record.id])).rows[0].hash, sourceHash);
    assert.equal((await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=$1', [source.event_id])).rows[0].hash, eventHash);
    const proof = (await admin.query("select metadata from public.clued_audit_receipts where operation='continuity_only_resolution_authorized' and object_id=$1", [String(source.event_id)])).rows[0].metadata;
    assert.equal(proof.source_manifest_entry.event_id, source.event_id);
    assert.equal(proof.source_manifest_entry.create_receipt_id, source.receipt_id);
    const retry = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2,$3,$4,true) result', [userId, 'global', dry.count, dry.manifest_digest])).rows[0].result;
    assert.equal(retry.status, 'duplicate');
    assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts where operation='carrier_transition' and object_id=$1", [String(source.event_id)])).rows[0].n, 1);

    const mapped = await write('M1 mapped legacy note', 'note');
    await admin.query("select clued_private.m1_migrate_current_legacy_records(1,'legacy-create-test-20260923')");
    const mappedRecord = (await admin.query('select record_schema_version,version from public.clued_memories where id=$1', [mapped.record.id])).rows[0];
    assert.equal(mappedRecord.record_schema_version, 1);
    assert.equal(Number(mappedRecord.version), 2);
    const mappedDry = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global'])).rows[0].result;
    assert.equal(mappedDry.count, 1);
    const mappedDone = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2,$3,$4,true) result', [userId, 'global', mappedDry.count, mappedDry.manifest_digest])).rows[0].result;
    assert.equal(mappedDone.status, 'reconciled');
    assert.equal((await admin.query('select carrier_state from clued_private.event_truth_carriers where event_id=$1', [mapped.event_id])).rows[0].carrier_state, 'RESOLVED_CONTINUITY_ONLY');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const allowed = (await admin.query("select has_function_privilege($1,'clued_private.reconcile_legacy_create_notifications_v1(uuid,text,integer,text,boolean)','EXECUTE') allowed", [role])).rows[0].allowed;
      assert.equal(allowed, false, `${role} must not execute the administrative proof function`);
    }

    const broken = await write('Broken mapped receipt chain', 'note');
    await admin.query("select clued_private.m1_migrate_current_legacy_records(1,'legacy-create-broken-20260923')");
    await admin.query(`update public.clued_audit_receipts set status='failed'
      where operation_family='legacy_record_mapping' and target_refs @> jsonb_build_array(jsonb_build_object('kind','record','id',$1::uuid))`, [broken.record.id]);
    await assert.rejects(() => admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global']), /legacy_create_mapping_missing/);
    assert.equal((await admin.query('select carrier_state from clued_private.event_truth_carriers where event_id=$1', [broken.event_id])).rows[0].carrier_state, 'ACTIVE_UNSTRUCTURED');
    await admin.query(`update public.clued_audit_receipts set status='committed'
      where operation_family='legacy_record_mapping' and target_refs @> jsonb_build_array(jsonb_build_object('kind','record','id',$1::uuid))`, [broken.record.id]);
    const brokenDry = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global'])).rows[0].result;
    assert.equal(brokenDry.count, 1);
    const change = {operation:'update', id:broken.record.id, record_type:'note', record_schema_version:1, lifecycle_status:'active', scope:'global', base_version:2, idempotency_key:uuid(), authority:'imported', confidence_reason:'Local chain test', mutation:{content:'Updated legacy note'}};
    const changed = (await admin.query('select clued_private.record_mutation_core($1,null,$2,$3) result', [userId, change, hash()])).rows[0].result;
    assert.equal(changed.status, 'committed');
    assert.equal(Number((await admin.query('select version from public.clued_memories where id=$1', [broken.record.id])).rows[0].version), 3);
    const unbroken = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global'])).rows[0].result;
    assert.equal(unbroken.count, 1);
    await admin.query('update public.clued_audit_receipts set committed_versions=\'{}\'::jsonb where id=(select receipt_id from public.clued_memories where id=$1)', [broken.record.id]);
    await assert.rejects(() => admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global']), /legacy_create_version_chain_invalid/);
    await admin.query('update public.clued_audit_receipts set committed_versions=jsonb_build_object($1::text,3) where id=(select receipt_id from public.clued_memories where id=$1)', [broken.record.id]);
    const brokenAgain = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global'])).rows[0].result;
    assert.equal((await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2,$3,$4,true) result', [userId, 'global', brokenAgain.count, brokenAgain.manifest_digest])).rows[0].result.status, 'reconciled');

    const stale = await write('Source before competing append');
    const beforeAppend = (await admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global'])).rows[0].result;
    const altered = await write('Changed archived source');
    await assert.rejects(() => admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2,$3,$4,true)', [userId, 'global', beforeAppend.count, beforeAppend.manifest_digest]), /legacy_create_manifest_changed/);
    assert.equal((await admin.query('select carrier_state from clued_private.event_truth_carriers where event_id=$1', [stale.event_id])).rows[0].carrier_state, 'ACTIVE_UNSTRUCTURED');
    await admin.query("update public.clued_context_events set payload=payload||'{\"extra\":true}'::jsonb where id=$1", [altered.event_id]);
    await assert.rejects(() => admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global']), /legacy_create_source_not_exact/);
    assert.equal((await admin.query('select carrier_state from clued_private.event_truth_carriers where event_id=$1', [altered.event_id])).rows[0].carrier_state, 'ACTIVE_UNSTRUCTURED');
    await admin.query("update public.clued_context_events set payload='{\"action\":\"create\",\"record_type\":\"archive_snapshot\"}'::jsonb where id=$1", [altered.event_id]);
    await admin.query("update public.clued_audit_receipts set metadata=jsonb_set(metadata,'{result,event_id}','9999'::jsonb) where id=$1", [altered.receipt_id]);
    await assert.rejects(() => admin.query('select clued_private.reconcile_legacy_create_notifications_v1($1,$2) result', [userId, 'global']), /legacy_create_receipt_not_unique/);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(dir);
  }
});
