import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationName = '20261017215600_work_verify_shared_observation_v1.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

test('ordinary work verification shares observations without weakening writer, row or CI barriers',
  { timeout: 300000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-verify-shared-'));
  const server = newCluster({ databaseDir: directory, user: 'postgres', password: hash(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  let oldDefinition;
  let newDefinition;
  let oldCatalog;
  let migration;
  const connect = async role => {
    const client = server.getPgClient();
    clients.push(client);
    await client.connect();
    if (role) await client.query(`set role ${role}`);
    return client;
  };
  try {
    await startCluster(server);
    const admin = await connect();
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
    const catalog = async () => (await admin.query(`select p.oid, p.proowner, p.proacl::text,
      p.proconfig,p.provolatile,p.prosecdef,p.prorettype,p.prolang,p.proargtypes::text
      from pg_proc p where oid='public.clued_work_verify_v1(text,jsonb)'::regprocedure`)).rows[0];
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter(name => name.endsWith('.sql')).sort()) {
      const source = await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
      if (name === migrationName) {
        migration = source;
        oldCatalog = await catalog();
        oldDefinition = (await admin.query(`select pg_get_functiondef(
          'public.clued_work_verify_v1(text,jsonb)'::regprocedure) definition`)).rows[0].definition;
      }
      try { await admin.query(source); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    assert.ok(migration && oldDefinition, 'the real migration and predecessor were executed');
    newDefinition = (await admin.query(`select pg_get_functiondef(
      'public.clued_work_verify_v1(text,jsonb)'::regprocedure) definition`)).rows[0].definition;
    assert.deepEqual(await catalog(), oldCatalog, 'OID, ACL, owner and function attributes survive');
    await assertGatewayCloseoutBoundary(admin);
    await allowRawTestBindings(admin);
    const owner = uuid();
    const stranger = uuid();
    const token = hash();
    const strangerToken = hash();
    let ownerBinding;
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values
      ($1,'shared@example.invalid',now()),($2,'other@example.invalid',now())`, [owner, stranger]);
    for (const [id, proof] of [[owner, token], [stranger, strangerToken]]) {
      const inserted = await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','shared-read-fixture',$2,array['context:read','context:write'],array['*']) returning id`, [id, proof]);
      if (id === owner) ownerBinding = inserted.rows[0].id;
    }
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const reader1 = await connect('anon');
    const reader2 = await connect('anon');
    const writer = await connect();
    const probe = await connect();
    const rpc = (name, input) => workerGatewayRpc(gateway, name, token, input);
    const taskResult = await rpc('clued_record_mutate', { operation: 'create', record_type: 'task',
      record_schema_version: 1, lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'observed', confidence_reason: 'isolated lock regression', source_refs: [],
      source_unavailable_reason: 'synthetic local fixture', mutation: { title: 'Shared observations',
        content: 'Fixture only', type_fields: { execution_bucket: 'next' }, relations: {} } });
    assert.equal(taskResult.status, 'committed');
    const claimed = await rpc('clued_work_claim_v1', { scope: 'global', task_id: taskResult.target_refs[0].id,
      idempotency_key: uuid(), holder_session_ref: 'shared-test-session', write_set: ['shared/**'] });
    assert.equal(claimed.status, 'committed');
    const claim = claimed.claim;
    const input = { scope: 'global', claim_id: claim.claim_id, changed_paths: ['shared/example.mjs'] };
    const verify = async (client, value = input, proof = token) => (await client.query(
      'select public.clued_work_verify_v1($1,$2::jsonb) value', [proof, JSON.stringify(value)])).rows[0].value;
    const pid = async client => (await client.query('select pg_backend_pid() pid')).rows[0].pid;
    const reader1Pid = await pid(reader1);
    const reader2Pid = await pid(reader2);
    const locks = async processId => (await admin.query(`with wanted as (
      select hashtextextended(prefix||$2::text,0) k from (values
        ('clued-currentness-user:'),('clued-work-claim:')) p(prefix))
      select l.mode from pg_locks l join wanted w
      on l.classid::bigint=((w.k>>32)&4294967295::bigint)
        and l.objid::bigint=(w.k&4294967295::bigint)
      where l.locktype='advisory' and l.objsubid=1 and l.pid=$1 and l.granted order by l.mode`,
      [processId, owner])).rows.map(row => row.mode);
    const snapshot = async () => (await admin.query(`select
      (select count(*)::int from public.clued_audit_receipts) receipts,
      (select count(*)::int from clued_private.work_claim_door_usage_v1) usage,
      (select to_jsonb(c) from clued_private.work_claims_v1 c where claim_id=$1) claim`, [claim.claim_id])).rows[0];
    await t.test('ordinary DTOs, errors and side effects match the actual predecessor', async () => {
      const before = await snapshot();
      // Definition replacement must be visible to the other connection; each comparison
      // actually invokes both implementations, never copies an expected error.
      const compare = async (value, proof = token) => {
        await admin.query(oldDefinition);
        let previous;
        try { previous = await verify(reader1, value, proof); delete previous.verified_at; previous = { result: previous }; }
        catch (error) { previous = { code: error.code, message: error.message }; }
        await admin.query(newDefinition);
        let current;
        try { current = await verify(reader1, value, proof); delete current.verified_at; current = { result: current }; }
        catch (error) { current = { code: error.code, message: error.message }; }
        assert.deepEqual(current, previous, JSON.stringify(value));
      };
      for (const value of [input, { ...input, ci_dispatch: false }, { ...input, head_sha: 'a'.repeat(40) },
        { ...input, claim_id: uuid() }, { ...input, claim_id: 'bad-uuid' },
        { ...input, changed_paths: ['outside/file'] }, { ...input, head_sha: 'bad' },
        { ...input, pr_ref: '' }, { ...input, ci_dispatch: 'false' },
        { ...input, ci_dispatch: null }, { ...input, ci_dispatch: true }, null, []]) await compare(value);
      await compare(input, strangerToken);
      assert.deepEqual(await snapshot(), before, 'ordinary verification does not bind, meter or mutate');
      for (const field of ['expires_at', 'execution_handover_pending']) {
        if (field === 'expires_at') {
          await admin.query(`update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '2 hours',
            expires_at=clock_timestamp()-interval '1 second' where claim_id=$1`, [claim.claim_id]);
        } else {
          await admin.query('update clued_private.work_claims_v1 set execution_handover_pending=true where claim_id=$1', [claim.claim_id]);
        }
        try {
          await compare(input);
          assert.equal((await verify(reader1)).verdict, 'REJECTED', field);
        } finally {
          if (field === 'expires_at') {
            await admin.query('update clued_private.work_claims_v1 set issued_at=$2,expires_at=$3 where claim_id=$1',
              [claim.claim_id, before.claim.issued_at, before.claim.expires_at]);
          } else {
            await admin.query('update clued_private.work_claims_v1 set execution_handover_pending=$2 where claim_id=$1',
              [claim.claim_id, before.claim.execution_handover_pending]);
          }
        }
      }
      assert.equal((await admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',
        [ownerBinding])).rowCount, 1, 'exercise the actual stored Binding, whose credential verifier is transformed');
      try { await compare(input); await assert.rejects(() => verify(reader1), error => error.code === '42501'); }
      finally { await admin.query('update public.clued_agent_bindings set revoked_at=null where id=$1', [ownerBinding]); }
    });

    await t.test('predecessor serializes readers; successor holds two real shared Owner locks', async () => {
      await admin.query(oldDefinition);
      await reader1.query('begin');
      try {
        assert.equal((await verify(reader1)).verdict, 'ADMITTED');
        assert.deepEqual(await locks(reader1Pid), ['ExclusiveLock', 'ExclusiveLock']);
        await reader2.query("begin; set local lock_timeout='150ms'");
        await assert.rejects(() => verify(reader2), error => error.code === '55P03');
        await reader2.query('rollback');
      } finally { await reader1.query('rollback'); await reader2.query('rollback'); }
      await admin.query(newDefinition);
      const before = await snapshot();
      await reader1.query('begin');
      await reader2.query("begin; set local lock_timeout='1s'");
      try {
        assert.equal((await verify(reader1)).verdict, 'ADMITTED');
        assert.equal((await verify(reader2)).verdict, 'ADMITTED');
        assert.deepEqual(await locks(reader1Pid), ['ShareLock', 'ShareLock']);
        assert.deepEqual(await locks(reader2Pid), ['ShareLock', 'ShareLock']);
        await writer.query("begin; set local lock_timeout='150ms'");
        await assert.rejects(() => workerGatewayRpc(writer, 'clued_work_release_v1', token,
          { scope: 'global', claim_id: claim.claim_id, fence: claim.fence, outcome: 'completed' }),
        error => error.code === '55P03');
        await writer.query('rollback');
        await probe.query('begin');
        await assert.rejects(() => probe.query('select claim_id from clued_private.work_claims_v1 where claim_id=$1 for update nowait',
          [claim.claim_id]), error => error.code === '55P03');
        await probe.query('rollback');
        assert.deepEqual(await snapshot(), before, 'held readers and refused writer did not mutate');
      } finally {
        await reader1.query('rollback'); await reader2.query('rollback');
        await writer.query('rollback'); await probe.query('rollback');
      }
    });

    await t.test('PR admission and dispatch keep exclusive locking and real head metering', async () => {
      await reader1.query('begin');
      try {
        const admitted = await verify(reader1, { ...input, pr_ref: 'fixture/repo#1', head_sha: 'b'.repeat(40) });
        assert.equal(admitted.verdict, 'ADMITTED');
        assert.equal(admitted.bound_pr, 'fixture/repo#1');
        assert.equal(admitted.task_ci_heads_24h, 1);
        assert.deepEqual(await locks(reader1Pid), ['ExclusiveLock', 'ExclusiveLock']);
      } finally { await reader1.query('rollback'); }
      await reader1.query('begin');
      try {
        const admitted = await verify(reader1, { ...input, ci_dispatch: true, head_sha: 'c'.repeat(40) });
        assert.equal(admitted.verdict, 'ADMITTED');
        assert.equal(admitted.bound_pr, null);
        assert.equal(admitted.task_ci_heads_24h, 1);
        assert.deepEqual(await locks(reader1Pid), ['ExclusiveLock', 'ExclusiveLock']);
      } finally { await reader1.query('rollback'); }
    });

    await t.test('migration rejects replay; release wins after readers finish', async () => {
      await assert.rejects(() => admin.query(migration), /predecessor_mismatch/);
      assert.deepEqual(await catalog(), oldCatalog);
      const released = await rpc('clued_work_release_v1', { scope: 'global', claim_id: claim.claim_id,
        fence: claim.fence, outcome: 'completed' });
      assert.equal(released.status, 'committed');
      const observed = await verify(reader1);
      assert.equal(observed.verdict, 'REJECTED');
      assert.ok(observed.reasons.includes('claim_not_current'));
      await assertGatewayCloseoutBoundary(admin);
    });
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    await stopCluster(server);
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('clued-verify-shared-'));
    await removeTestDirectory(resolved);
  }
});
