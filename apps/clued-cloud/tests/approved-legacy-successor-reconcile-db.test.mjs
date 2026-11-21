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

test('approved legacy successor requires live whole-table owner proof and exact CAS', { timeout: 180000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-approved-successor-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await port(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  try {
    await server.initialise();
    await server.start();
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
    await allowRawTestBindings(admin);
    const userId = uuid();
    const activationId = '0d09405e-f918-43c3-b476-6e3c4465eef4';
    const approvalReceiptId = '58d4dce0-92c1-4245-ab1b-af3712a4009f';
    const successorReceiptId = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'approved-successor@example.invalid',now())", [userId]);
    await admin.query(`create schema mtpe_m0;
      create table mtpe_m0.inventory_activation(id uuid primary key,diff_digest text not null,approval_event text not null,approval_receipt text not null,activated_at timestamptz not null default now(),note text);
      create table mtpe_m0.verdict_table(id uuid primary key default gen_random_uuid(),object_key text unique not null,object_title text,object_source_kind text not null,object_source_id text not null,classification text not null,governance_category text,verdict text,evidence_ref text,evidence_note text,supersedes_object_key text,decided_at timestamptz,activation_id uuid);`);
    const approvalBindingId = uuid();
    await admin.query(`insert into public.clued_agent_bindings(id,user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,$2,'fixture','owner-approval',$3,array['context:read'],array['global'])`, [approvalBindingId, userId, hash()]);
    await admin.query(`insert into public.clued_context_events(id,user_id,binding_id,context_key,event_type,payload,version,audit_visibility,occurred_at)
      values(637,$1,null,'global','decision','{"baseline_id":"old"}',73,'work_log','2026-01-01T00:00:00Z'),
            (638,$1,null,'global','decision','{"baseline_id":"new"}',74,'work_log','2026-01-02T00:00:00Z'),
            (744,$1,$2,'global','decision','{}',201,'work_log','2026-01-03T00:00:00Z')`, [userId, approvalBindingId]);
    await admin.query(`insert into public.clued_audit_receipts(id,user_id,binding_id,context_key,operation,object_type,object_id,version,metadata,created_at)
      values($1,$3,null,'global','append','event','638',74,'{}','2026-01-02T00:00:00Z'),
            ($2,$3,$4,'global','append','event','744',201,'{}','2026-01-03T00:00:00Z')`, [successorReceiptId, approvalReceiptId, userId, approvalBindingId]);
    await admin.query(`insert into clued_private.event_truth_carriers(event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
      values(637,$1,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',73),
            (638,$1,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',74),
            (744,$1,'global',array['decision'],'work_log','legacy','ACTIVE_UNSTRUCTURED',201)`, [userId]);
    await admin.query(`insert into mtpe_m0.verdict_table(object_key,object_title,object_source_kind,object_source_id,classification,governance_category,verdict,evidence_ref,evidence_note,supersedes_object_key,activation_id)
      values('canonical_event:637','Old baseline','canonical_event','637','GOVERNANCE_OBJECT','FROZEN_BASELINE','SUPERSEDED','canonical_event:638','Owner-approved successor','canonical_event:638',$1)`, [activationId]);
    const digests = (await admin.query(`select count(*) n,
      encode(extensions.digest(convert_to(string_agg(object_key||'|'||object_source_kind::text||'|'||object_source_id,E'\n' order by object_key collate "C"),'UTF8'),'sha256'),'hex') d1,
      encode(extensions.digest(convert_to(string_agg(object_key||'|'||coalesce(verdict::text,'')||'|'||classification::text||'|'||coalesce(governance_category::text,'')||'|'||coalesce(evidence_ref,'')||'|'||coalesce(supersedes_object_key,'')||'|'||coalesce(evidence_note,''),E'\n' order by object_key collate "C"),'UTF8'),'sha256'),'hex') d2 from mtpe_m0.verdict_table`)).rows[0];
    await admin.query(`insert into mtpe_m0.inventory_activation(id,diff_digest,approval_event,approval_receipt,note) values($1,$2,'canonical_event:744',$3,'fixture')`, [activationId, digests.d2, approvalReceiptId]);
    await admin.query(`update public.clued_context_events set payload=jsonb_build_object(
      'digest_verification_at_approval',jsonb_build_object('D1_live',$1::text,'D2_v3_live',$2::text,'rows_total',$3::int,'echo_matches_live',true),
      'ar_section12_compliance',jsonb_build_object('d1_referenced',true,'d2_echoed_by_owner',true)) where id=744`, [digests.d1, digests.d2, Number(digests.n)]);
    const validApprovalPayload = (await admin.query('select payload from public.clued_context_events where id=744')).rows[0].payload;
    const requiredApprovalPaths = [
      ['digest_verification_at_approval', 'D1_live'],
      ['digest_verification_at_approval', 'D2_v3_live'],
      ['digest_verification_at_approval', 'rows_total'],
      ['digest_verification_at_approval', 'echo_matches_live'],
      ['ar_section12_compliance', 'd1_referenced'],
      ['ar_section12_compliance', 'd2_echoed_by_owner'],
    ];
    for (const pathParts of requiredApprovalPaths) {
      await admin.query('update public.clued_context_events set payload=$1::jsonb #- $2::text[] where id=744', [JSON.stringify(validApprovalPayload), pathParts]);
      await assert.rejects(() => admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638)', [userId]), /approved_successor_owner_proof_invalid/);
      await admin.query('update public.clued_context_events set payload=jsonb_set($1::jsonb,$2::text[],\'null\'::jsonb,true) where id=744', [JSON.stringify(validApprovalPayload), pathParts]);
      await assert.rejects(() => admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638)', [userId]), /approved_successor_owner_proof_invalid/);
    }
    await admin.query('update public.clued_context_events set payload=$1::jsonb where id=744', [JSON.stringify(validApprovalPayload)]);
    await admin.query('update public.clued_audit_receipts set binding_id=null where id=$1', [approvalReceiptId]);
    await assert.rejects(() => admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638)', [userId]), /approved_successor_owner_proof_invalid/);
    await admin.query('update public.clued_audit_receipts set binding_id=$1 where id=$2', [approvalBindingId, approvalReceiptId]);
    await admin.query("update clued_private.event_truth_carriers set carrier_state='RETRACTED' where event_id=744");
    await assert.rejects(() => admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638)', [userId]), /approved_successor_owner_proof_invalid/);
    await admin.query("update clued_private.event_truth_carriers set carrier_state='ACTIVE_UNSTRUCTURED' where event_id=744");
    await admin.query('begin');
    await admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638)', [userId]);
    const concurrent = server.getPgClient();
    await concurrent.connect();
    await concurrent.query("set lock_timeout='300ms'");
    await assert.rejects(() => concurrent.query("update mtpe_m0.verdict_table set evidence_note=evidence_note where object_key='canonical_event:637'"), /lock timeout/);
    await assert.rejects(() => concurrent.query("update mtpe_m0.inventory_activation set note=note where id=$1", [activationId]), /lock timeout/);
    await concurrent.end();
    await admin.query('commit');
    const sourceHash = (await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=637')).rows[0].hash;
    const successorHash = (await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=638')).rows[0].hash;
    const dry = (await admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638) result', [userId])).rows[0].result;
    assert.equal(dry.status, 'dry_run');
    assert.equal(dry.manifest.d1, digests.d1);
    assert.equal(dry.manifest.d2_v3, digests.d2);
    await assert.rejects(() => admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638,$2,true)', [userId, hash()]), /approved_successor_manifest_changed/);
    const done = (await admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638,$2,true) result', [userId, dry.manifest_digest])).rows[0].result;
    assert.equal(done.status, 'superseded');
    assert.equal(done.currentness_claim, false);
    const carrier = (await admin.query('select carrier_state,successor_event_id,transition_version from clued_private.event_truth_carriers where event_id=637')).rows[0];
    assert.equal(carrier.carrier_state, 'SUPERSEDED');
    assert.equal(Number(carrier.successor_event_id), 638);
    assert.equal(Number(carrier.transition_version), 2);
    assert.equal((await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=637')).rows[0].hash, sourceHash);
    assert.equal((await admin.query('select clued_private.currentness_hash(to_jsonb(e)) hash from public.clued_context_events e where id=638')).rows[0].hash, successorHash);
    assert.equal((await admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638,$2,true) result', [userId, dry.manifest_digest])).rows[0].result.status, 'duplicate');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await admin.query("select has_function_privilege($1,'clued_private.reconcile_approved_legacy_successor_v1(uuid,bigint,bigint,text,boolean)','EXECUTE') allowed", [role])).rows[0].allowed, false);
    }
    await admin.query("update clued_private.event_truth_carriers set carrier_state='ACTIVE_UNSTRUCTURED',successor_event_id=null,transition_version=1,transition_receipt_id=null where event_id=637");
    await admin.query("update mtpe_m0.verdict_table set evidence_note='changed after approval' where object_key='canonical_event:637'");
    await assert.rejects(() => admin.query('select clued_private.reconcile_approved_legacy_successor_v1($1,637,638)', [userId]), /approved_successor_adjudication_invalid|approved_successor_owner_proof_invalid/);
    await admin.end();
  } finally {
    await stopCluster(server);
    await removeTestDirectory(dir);
  }
});
