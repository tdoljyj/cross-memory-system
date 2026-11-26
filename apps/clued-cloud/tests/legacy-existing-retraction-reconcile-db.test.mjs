import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

test('existing explicit retraction reconciliation is exact, private and does not duplicate business Events', { timeout: 180000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-existing-retraction-'));
  const server = newCluster({ databaseDir: dir, user: 'postgres', password: hash(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  try {
    await startCluster(server);
    const admin = server.getPgClient();
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
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'retraction@example.invalid',now())", [userId]);
    const append = async (eventType, payload) => {
      const receiptId = uuid();
      const version = Number((await admin.query("select nextval('clued_private.canonical_version_seq') v")).rows[0].v);
      const eventId = Number((await admin.query(`insert into public.clued_context_events(user_id,context_key,event_type,payload,version,audit_visibility,idempotency_key,receipt_id,occurred_at)
        values($1,'global',$2,$3,$4,'work_log',$5,$6,now()) returning id`, [userId, eventType, payload, version, uuid(), receiptId])).rows[0].id);
      await admin.query(`insert into public.clued_audit_receipts(id,user_id,context_key,operation,object_type,object_id,version,metadata,created_at)
        select $1::uuid,$2::uuid,'global','append','event',$3::text,$4::bigint,jsonb_build_object('status','committed'),occurred_at from public.clued_context_events where id=$3::bigint`, [receiptId, userId, eventId, version]);
      return { event_id: eventId, receipt_id: receiptId };
    };
    const source = await append('decision', { status: 'incorrect_authorization' });
    const successor = await append('retraction', { retracts_event_id: String(source.event_id), reason: 'Owner correction' });
    await admin.query(`insert into clued_private.event_truth_carriers(event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
      select id,user_id,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',version
      from public.clued_context_events where id=any($1::bigint[])`, [[source.event_id, successor.event_id]]);
    const eventCount = Number((await admin.query('select count(*) n from public.clued_context_events where user_id=$1', [userId])).rows[0].n);
    const sourceHash = (await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=$1', [source.event_id])).rows[0].hash;
    const successorHash = (await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=$1', [successor.event_id])).rows[0].hash;
    const dry = (await admin.query('select clued_private.reconcile_existing_retraction_v1($1,$2,$3) result', [userId, source.event_id, successor.event_id])).rows[0].result;
    assert.equal(dry.status, 'dry_run');
    assert.match(dry.manifest_digest, /^[0-9a-f]{64}$/);
    await assert.rejects(() => admin.query('select clued_private.reconcile_existing_retraction_v1($1,$2,$3,$4,true)', [userId, source.event_id, successor.event_id, hash()]), /existing_retraction_manifest_changed/);
    const done = (await admin.query('select clued_private.reconcile_existing_retraction_v1($1,$2,$3,$4,true) result', [userId, source.event_id, successor.event_id, dry.manifest_digest])).rows[0].result;
    assert.equal(done.status, 'retracted');
    assert.equal(done.currentness_claim, false);
    const carrier = (await admin.query('select carrier_state,successor_event_id,transition_version from clued_private.event_truth_carriers where event_id=$1', [source.event_id])).rows[0];
    assert.equal(carrier.carrier_state, 'RETRACTED');
    assert.equal(Number(carrier.successor_event_id), successor.event_id);
    assert.equal(Number(carrier.transition_version), 2);
    assert.equal(Number((await admin.query('select count(*) n from public.clued_context_events where user_id=$1', [userId])).rows[0].n), eventCount);
    assert.equal((await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=$1', [source.event_id])).rows[0].hash, sourceHash);
    assert.equal((await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=$1', [successor.event_id])).rows[0].hash, successorHash);
    const retry = (await admin.query('select clued_private.reconcile_existing_retraction_v1($1,$2,$3,$4,true) result', [userId, source.event_id, successor.event_id, dry.manifest_digest])).rows[0].result;
    assert.equal(retry.status, 'duplicate');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await admin.query("select has_function_privilege($1,'clued_private.reconcile_existing_retraction_v1(uuid,bigint,bigint,text,boolean)','EXECUTE') allowed", [role])).rows[0].allowed, false);
    }
    await admin.query("update public.clued_audit_receipts set status='failed',error_code='fixture_failure' where id=$1", [successor.receipt_id]);
    await admin.query("update clued_private.event_truth_carriers set carrier_state='ACTIVE_UNSTRUCTURED',successor_event_id=null,transition_version=1,transition_receipt_id=null where event_id=$1", [source.event_id]);
    await assert.rejects(() => admin.query('select clued_private.reconcile_existing_retraction_v1($1,$2,$3)', [userId, source.event_id, successor.event_id]), /existing_retraction_successor_receipt_invalid/);
    await admin.query("update public.clued_audit_receipts set status=null,error_code=null where id=$1", [successor.receipt_id]);
    const laterSource = await append('decision', { status: 'other' });
    const wrongSuccessor = await append('retraction', { retracts_event_id: String(source.event_id), reason: 'Wrong subject' });
    await admin.query(`insert into clued_private.event_truth_carriers(event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
      select id,user_id,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',version from public.clued_context_events where id=any($1::bigint[])`, [[laterSource.event_id, wrongSuccessor.event_id]]);
    await assert.rejects(() => admin.query('select clued_private.reconcile_existing_retraction_v1($1,$2,$3)', [userId, laterSource.event_id, wrongSuccessor.event_id]), /existing_retraction_source_invalid/);
    await admin.end();
  } finally {
    await stopCluster(server);
    await removeTestDirectory(dir);
  }
});
