import { stopCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

// Audit receipt lookups through partial indexes (migration 20261009110000,
// Task 25af334d). Session compliance in clued_mcp_audit_receipts and the
// once-a-minute dedup check of work_claim_reject_log_v1 read
// public.clued_audit_receipts through the (user_id, context_key, created_at)
// index and filtered every receipt of the context on metadata, which timed
// out at 3 s in production. With a context full of other receipts, both now
// scan their own index, and their answers are what they were.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const SESSIONS = 300;
const FILLER = 20000;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('audit receipts: session compliance and claim rejection dedup use their partial indexes',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-audit-receipt-indexes-'));
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
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'audit-indexes@example.invalid',now())`, [userId]);
    const token = hash();
    const bindingId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','audit index test',$2,array['context:read','context:write','audit:read'],array['*'])
      returning id`, [userId, token])).rows[0].id;
    const otherBindingId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','other binding',$2,array['context:read','context:write'],array['*'])
      returning id`, [userId, hash()])).rows[0].id;

    // Sessions 1..300 of the Binding in Global. Session n has n%3 appends, a
    // checkpoint when n%4=0, and has expired when n%5=0. Every session also
    // has a session_renew receipt carrying its session_id, and every seventh an
    // append written by another Binding: neither is counted.
    await admin.query(`insert into public.clued_continuity_sessions
        (user_id,binding_id,context_key,token_hash,restored_version,client_session_id,started_at,expires_at)
      select $1,$2,'global',encode(extensions.gen_random_bytes(32),'hex'),1,n::text,
        now()-n*interval '1 minute',
        case when n%5=0 then now()-interval '1 second' else now()+interval '1 hour' end
      from generate_series(1,${SESSIONS}) n`, [userId, bindingId]);
    await admin.query(`insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,metadata)
      select $1,b.binding_id,'global',b.operation,'continuity_session',jsonb_build_object('session_id',s.id)
      from public.clued_continuity_sessions s
      cross join lateral (
        select $2::uuid binding_id,'append' operation from generate_series(1,s.client_session_id::integer%3)
        union all select $2::uuid,'checkpoint' where s.client_session_id::integer%4=0
        union all select $2::uuid,'session_renew'
        union all select $3::uuid,'append' where s.client_session_id::integer%7=0) b
      where s.user_id=$1 and s.binding_id=$2`, [userId, bindingId, otherBindingId]);
    // The rest of the context: receipts with large metadata, as projection
    // refresh and reconcile receipts are in production.
    await admin.query(`insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,metadata,created_at)
      select $1,$2,'global',case when n%2=0 then 'projection_refresh' else 'currentness_reconcile' end,'fixture',
        jsonb_build_object('n',n,'detail',repeat(md5(n::text),30)),now()-n*interval '1 second'
      from generate_series(1,${FILLER}) n`, [userId, bindingId]);
    // Earlier claim rejections of other Tasks.
    await admin.query(`insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata,created_at)
      select $1,$2,'global','work_claim_reject','work_claim_rejection',gen_random_uuid()::text,1,
        jsonb_build_object('receipt_kind','WORK_CLAIM_REJECTED','error_code','work_claim_conflict','limit',null),
        now()-n*interval '10 minutes'
      from generate_series(1,200) n`, [userId, bindingId]);
    await admin.query('analyze public.clued_audit_receipts; analyze public.clued_continuity_sessions');

    const indexScans = async (name) => {
      await admin.query('select pg_stat_force_next_flush()');
      await admin.query('select pg_stat_clear_snapshot()');
      return Number((await admin.query(`select idx_scan from pg_stat_user_indexes
        where schemaname='public' and indexrelname=$1`, [name])).rows[0].idx_scan);
    };
    // Statistics reach the shared counters once the backend has been idle.
    const scansAfter = async (name, before, minimum) => {
      let scans = await indexScans(name);
      for (let attempt = 0; scans - before < minimum && attempt < 40; attempt += 1) {
        await sleep(100);
        scans = await indexScans(name);
      }
      return scans - before;
    };

    // --- Session compliance: same answer, through the session capture index. ---
    const sessionIndex = 'clued_audit_receipts_session_capture_idx';
    const sessionScansBefore = await indexScans(sessionIndex);
    const audit = (await admin.query('select public.clued_mcp_audit_receipts($1,$2) v',
      [token, { context_key: 'global', limit: 5 }])).rows[0].v;
    assert.equal(audit.status, 'ok', JSON.stringify(audit).slice(0, 500));
    assert.equal(audit.receipts.length, 5);
    assert.equal(audit.session_compliance.length, SESSIONS);
    for (const session of audit.session_compliance) {
      const n = Number(session.client_session_id);
      const appends = n % 3;
      const checkpoints = n % 4 === 0 ? 1 : 0;
      const state = checkpoints > 0 ? 'checkpointed'
        : appends > 0 && n % 5 === 0 ? 'expired_without_checkpoint'
          : appends > 0 ? 'checkpoint_required_before_handoff' : 'capture_unknown';
      assert.deepEqual(
        [session.append_count, session.checkpoint_count, session.state, session.authority_capture],
        [appends, checkpoints, state, appends > 0 && checkpoints === 0 ? 'incomplete' : 'unknown'],
        `session ${n}`);
      assert.equal(session.required_action, appends > 0 && checkpoints === 0 ? 'checkpoint_before_handoff' : null);
    }
    assert.equal(audit.checkpoint_reminder, true);
    assert.equal(audit.authority_capture_completeness.state, 'incomplete');
    assert.ok(await scansAfter(sessionIndex, sessionScansBefore, SESSIONS) >= SESSIONS,
      'session compliance does not use clued_audit_receipts_session_capture_idx');

    // --- Claim rejection dedup: one receipt a minute, through the reject index. ---
    const rejectIndex = 'clued_audit_receipts_work_claim_reject_idx';
    const taskId = uuid();
    const logReject = (code, detail = {}) => admin.query(`select clued_private.work_claim_reject_log_v1(
        b,'global',$2,null,'claim',$3,$4) v from public.clued_agent_bindings b where b.id=$1`,
      [bindingId, taskId, code, detail]);
    const rejections = async () => (await admin.query(`select metadata->>'error_code' code,metadata->>'limit' lim
      from public.clued_audit_receipts where user_id=$1 and operation='work_claim_reject' and object_id=$2
      order by created_at,id`, [userId, taskId])).rows.map((row) => `${row.code}/${row.lim}`);
    const rejectScansBefore = await indexScans(rejectIndex);
    const answer = (await logReject('work_claim_conflict')).rows[0].v;
    assert.equal(answer.error_code, 'work_claim_conflict', JSON.stringify(answer));
    await logReject('work_claim_conflict');
    await logReject('work_claim_budget_exhausted', { limit: 'task_claim_rate' });
    await logReject('work_claim_budget_exhausted', { limit: 'task_claim_rate' });
    await logReject('work_claim_budget_exhausted', { limit: 'binding_claim_rate' });
    assert.deepEqual(await rejections(), ['work_claim_conflict/null',
      'work_claim_budget_exhausted/task_claim_rate', 'work_claim_budget_exhausted/binding_claim_rate']);
    await admin.query(`update public.clued_audit_receipts set created_at=created_at-interval '2 minutes'
      where user_id=$1 and operation='work_claim_reject' and object_id=$2`, [userId, taskId]);
    await logReject('work_claim_conflict');
    assert.equal((await rejections()).length, 4);
    assert.ok(await scansAfter(rejectIndex, rejectScansBefore, 6) >= 6,
      'the rejection dedup check does not use clued_audit_receipts_work_claim_reject_idx');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
