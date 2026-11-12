import { stopCluster, waitForPidExit } from './cluster-cleanup.mjs';
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

// Whether a Binding's role is in force is read in one place,
// clued_private.binding_role_in_force_v1 (migration 20261112120000). A role row
// that has not started yet (a hand change's delay) is not in force anywhere.
// ci-admission-handover-db.test.mjs holds the list of functions that may read
// binding_roles_v1 and checks that only that reader compares a start with the clock.
const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('a role row that has not started is in force for neither PR door', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-role-reader-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(cloud, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8')); }
      catch (e) { throw new Error(`Migration ${name}: ${e.message}`, { cause: e }); }
    }
    await allowRawTestBindings(admin);

    const user = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'role-reader@example.invalid',now())", [user]);
    const token = hash();
    const ci = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','ci',$2,array['context:read'],array['*']) returning id`, [user, token])).rows[0].id;
    const receipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`, [user, ci])).rows[0].id;
    // What a hand change leaves: the new holder's row, starting an hour from now.
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      values($1,$2,'ci-admission',now(),$3,now()+interval '1 hour','resident-node')`, [user, ci, receipt]);
    const anon = server.getPgClient(); clients.push(anon); await anon.connect(); await anon.query('set role anon');
    const resolve = async () => (await anon.query('select public.clued_work_verify_v1($1::text,$2::jsonb) v', [token,
      { action: 'resolve_pr_claim', scope: 'global', pr_ref: 'fixture/role-reader#1', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
        target_branch: 'main', read_only: false }])).rows[0].v;
    const proofError = async () => (await admin.query(`select clued_private.work_claim_mechanical_proof_error_v1(b,$2::jsonb) e
      from public.clued_agent_bindings b where b.id=$1`, [ci, { mechanical_policy: {} }])).rows[0].e;
    const judged = async () => (await admin.query(`select clued_private.binding_role_in_force_v1($1,$2,'ci-admission') in_force,
      clued_private.ci_duty_admits_v1($1,$2,'issuer_role') issuer`, [user, ci])).rows[0];

    await t.test('before the row starts: not in force, PR discovery may not write, the mechanical proof gate refuses', async () => {
      assert.deepEqual(await judged(), { in_force: false, issuer: false });
      const pending = await resolve();
      assert.equal(pending.binding_status, 'unbound', JSON.stringify(pending));
      assert.equal(pending.reason, 'pr_task_binding_unbound', 'a CI Binding that is not in force only reads');
      assert.equal(await proofError(), 'ci_binding_required');
    });

    await t.test('once the row starts: in force, PR discovery writes, the proof gate goes on to the policy', async () => {
      await admin.query("update clued_private.binding_roles_v1 set effective_at=now() where binding_id=$1 and revoked_at is null", [ci]);
      assert.deepEqual(await judged(), { in_force: true, issuer: true });
      const started = await resolve();
      assert.equal(started.reason, 'head_authorization_required', JSON.stringify(started));
      assert.notEqual(await proofError(), 'ci_binding_required');
    });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid = server.process?.pid;
    await stopCluster(server);
    assert.equal(await waitForPidExit(ownPid), true, 'this fixture must stop its own PostgreSQL child');
  }
});
