import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import './merge-admission-measurement-capabilities-db.test.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { workerGatewayRpc, setWorkerGatewayCaller, assertGatewayCloseoutBoundary }
  from './worker-gateway-caller-fixture.mjs';
import { validateJournal, emptyReplayState, applyTransaction, queueAt, timestampMicros }
  from '../../../scripts/ci/merge-admission-measurement-history.mjs';

// The override points only to an already-installed pinned test dependency on
// Windows. It is not a database URL, credential or production connection.
const { default: EmbeddedPostgres } = process.env.CLUED_TEST_EMBEDDED_POSTGRES_URL
  ? await import(process.env.CLUED_TEST_EMBEDDED_POSTGRES_URL)
  : await import('embedded-postgres'); // Literal keeps content-driven DB selection correct.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('measurement history: real PostgreSQL transaction, privacy, immutability and stable page bounds',
  { timeout: 300000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-measurement-history-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: hash(),
    port: await freePort(), persistent: true, postgresFlags: ['-c', 'io_method=sync'], onLog() {},
    onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    const rpc = async (client, name, token, input) => {
      try { return await workerGatewayRpc(client, name, token, input); }
      finally { await client.query('reset role'); await client.query("select set_config('request.jwt.claims','{}',false)"); }
    };
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
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort();
    const candidate = migrations.find(n => n.endsWith('_merge_admission_measurement_history_atomic_v1.sql'));
    assert.ok(candidate);
    assert.equal(migrations.some(n => n.endsWith('_merge_admission_measurement_history_v1.sql')), false);
    const original = await fs.readFile(path.join(root,
      'supabase/history-only/20261011005515_merge_admission_measurement_history_v1.sql'), 'utf8');
    const candidateText = await fs.readFile(path.join(root, 'supabase/migrations', candidate), 'utf8');
    // Keep the never-applied source byte-for-byte as a negative-control fixture.
    // It is not a production-history ledger row or an active reset migration.
    assert.equal(candidateText, original.replace(/^begin;$/m, 'do $r9_atomic$ begin')
      .replace(/^commit;$/m, 'end $r9_atomic$;'));
    const publisher = await fs.readFile(path.join(root, '../../.github/workflows/clued-cloud-production-release.yml'), 'utf8');
    assert.match(publisher, /execute s;/);
    assert.match(publisher, /insert into supabase_migrations\.schema_migrations/);
    await admin.query(`create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
      create temp table migration_lines(n bigserial primary key,line text);`);
    const applyPublished = async (text, version) => {
      assert.equal(text.includes('\r'), false); assert.ok(text.endsWith('\n'));
      await admin.query('truncate migration_lines restart identity');
      await admin.query('insert into migration_lines(line) select unnest($1::text[])', [text.split('\n').slice(0, -1)]);
      const expected = crypto.createHash('md5').update(text).digest('hex');
      // The configured publisher runs this DO/EXECUTE and history insert in
      // one outer transaction. Preserve that shape, including its byte guard.
      await admin.query(`begin;
        do $apply$ declare s text := (select string_agg(coalesce(line, ''), e'\\n' order by n) from migration_lines) || e'\\n';
        begin
          if md5(s) is distinct from '${expected}' then raise exception 'migration text differs from the file'; end if;
          execute s;
          insert into supabase_migrations.schema_migrations(version, name, statements)
            values ('${version}', 'measurement_history_test', array[s]);
        end $apply$;
        commit;`);
      assert.equal((await admin.query(`select md5(array_to_string(statements,'')) value
        from supabase_migrations.schema_migrations where version=$1`, [version])).rows[0].value, expected);
    };
    const seedUser = uuid(), seedToken = hash(); let seedClaim, seedQueue;
    for (const name of migrations) {
      if (name === candidate) {
        // Existing source state is created BEFORE the candidate, using the real
        // pre-migration RPCs; the initial snapshot branch must preserve it.
        await allowRawTestBindings(admin);
        await admin.query(`insert into auth.users(id,email,email_confirmed_at)
          values($1,'seed@example.invalid',now())`, [seedUser]);
        await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
          values($1,'openai','seed fixture',$2,array['context:read','context:write'],array['*'])`, [seedUser, seedToken]);
        const task = await rpc(admin, 'clued_record_mutate', seedToken, {
          operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
          scope: 'global', idempotency_key: uuid(), authority: 'observed', confidence_reason: 'bootstrap fixture',
          source_refs: [], source_unavailable_reason: 'synthetic', mutation: { title: 'Seed Task', content: 'fixture',
            type_fields: { execution_bucket: 'next' }, relations: {} } });
        assert.equal(task.status, 'committed');
        const issued = await rpc(admin, 'clued_work_claim_v1', seedToken, {
          scope: 'global', task_id: task.target_refs[0].id, write_set: ['seed/a'],
          trigger_refs: ['merge:owner/repo:main'], idempotency_key: uuid(), holder_label: 'Seed',
          holder_session_ref: 'seed-fixture' });
        assert.equal(issued.status, 'committed'); seedClaim = issued.claim;
        await admin.query(`insert into clued_private.work_claim_merge_queue_v1
          (user_id,merge_ref,head_left_at,left_queued_at,left_claim_id)
          select user_id,'merge:owner/repo:main',merge_queued_at-interval '1 second',
            merge_queued_at-interval '1 second',$2 from clued_private.work_claims_v1 where claim_id=$1`,
          [seedClaim.claim_id, uuid()]);
        seedQueue = (await admin.query(`select clued_private.work_claim_merge_queue_v1($1,'merge:owner/repo:main') v`, [seedUser])).rows[0].v;
      }
      try {
        if (name === candidate) {
          await t.test('publisher refuses the original and rolls back schema and history together', async () => {
            await assert.rejects(applyPublished(original, 'original_negative'),
              /EXECUTE of transaction commands is not implemented/);
            await admin.query('rollback');
            assert.equal((await admin.query("select to_regclass('clued_private.merge_measurement_stream_v1') value")).rows[0].value, null);
            assert.equal((await admin.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n, 0);
          });
          await t.test('atomic successor applies through unchanged publisher with exact history bytes', async () => {
            // Fail AFTER the candidate's DDL: the history write must roll the
            // entire schema change back, rather than leave an unrecorded install.
            await admin.query("alter table supabase_migrations.schema_migrations add constraint test_history_failure check (version <> 'fault_injected')");
            await assert.rejects(applyPublished(candidateText, 'fault_injected'), /test_history_failure/);
            await admin.query('rollback');
            assert.equal((await admin.query("select to_regclass('clued_private.merge_measurement_stream_v1') value")).rows[0].value, null);
            assert.equal((await admin.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n, 0);
            await applyPublished(candidateText, 'atomic_positive');
            assert.equal((await admin.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n, 1);
          });
        } else {
          await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8'));
        }
      }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    await assertGatewayCloseoutBoundary(admin);
    const user = uuid(), other = uuid(), token = hash();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values
      ($1,'measurement@example.invalid',now()),($2,'other@example.invalid',now())`, [user, other]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'openai','measurement fixture',$2,array['context:read','context:write','audit:read'],array['*'])`, [user, token]);
    const agent = (name, input) => rpc(admin, name, token, input);
    const committed = r => { assert.equal(r.status, 'committed', JSON.stringify(r)); return r; };
    const taskId = committed(await agent('clued_record_mutate', { operation: 'create', record_type: 'task',
      record_schema_version: 1, lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(),
      authority: 'observed', confidence_reason: 'measurement SQL fixture', source_refs: [],
      source_unavailable_reason: 'synthetic fixture', mutation: { title: 'Measurement fixture', content: 'fixture',
        type_fields: { execution_bucket: 'next' }, relations: {} } })).target_refs[0].id;
    const claim = committed(await agent('clued_work_claim_v1', { scope: 'global', task_id: taskId,
      write_set: ['fixture/a'], trigger_refs: ['merge:owner/repo:main'], idempotency_key: uuid(),
      holder_label: 'SQL fixture', holder_session_ref: 'measurement-fixture' })).claim;
    const page = async input => (await admin.query(`select clued_private.merge_measurement_page_v1($1,$2) v`, [user, input])).rows[0].v;
    const initial = await page({ limit: 500 });
    assert.equal(initial.status, 'ok'); assert.ok(initial.events.length > 0);
    assert.equal(initial.events[0].kind, 'policy');
    const watermark = initial.end_sequence;

    await t.test('bootstrap includes existing policy, claim and departing-head marker without changing the queue', async () => {
      const seeded = (await admin.query(`select clued_private.merge_measurement_page_v1($1,'{}') v`, [seedUser])).rows[0].v;
      assert.equal(seeded.status, 'ok');
      assert.equal(seeded.events[0].kind, 'policy');
      assert.equal(seeded.events[0].payload.initial_snapshot, true);
      assert.ok(seeded.events.some(e => e.kind === 'claim' && e.payload.claim_id === seedClaim.claim_id));
      assert.ok(seeded.events.some(e => e.kind === 'queue_marker' && e.payload.merge_ref === 'merge:owner/repo:main'));
      assert.deepEqual((await admin.query(`select clued_private.work_claim_merge_queue_v1($1,'merge:owner/repo:main') v`, [seedUser])).rows[0].v, seedQueue);
      assert.equal(new Set(seeded.events.map(e => e.transaction_id)).size, 1);
    });
    await t.test('microsecond replay agrees with the actual existing PostgreSQL FIFO on seeded inputs', async () => {
      const seeded = (await admin.query(`select clued_private.merge_measurement_page_v1($1,'{}') v`, [seedUser])).rows[0].v;
      const validated = validateJournal(JSON.stringify(seeded), { expectedSourceDigest: seeded.source_digest, expectedStream: seeded.stream_id });
      assert.equal(validated.status, 'INTEGRITY_VALIDATED');
      const state = emptyReplayState(); for (const group of validated.groups) applyTransaction(state, group);
      const actual = (await admin.query(`select jsonb_build_object('at',clock_timestamp(),
        'queue',clued_private.work_claim_merge_queue_v1($1,'merge:owner/repo:main')) v`, [seedUser])).rows[0].v;
      const replay = queueAt(state, 'merge:owner/repo:main', timestampMicros(actual.at));
      assert.equal(replay.depth, actual.queue.length); assert.equal(replay.head.claim_id, actual.queue.head.claim_id);
      assert.equal(replay.head.since, timestampMicros(actual.queue.head.since));
      assert.equal(replay.head.until, timestampMicros(actual.queue.head.until));
    });

    await t.test('safe whitelist excludes credentials and mutable owner labels', async () => {
      const wire = JSON.stringify(initial);
      for (const forbidden of ['lease_key','token_hash','holder_label','budget','idempotency_key'])
        assert.equal(wire.includes(forbidden), false, forbidden);
      assert.ok(initial.events.some(e => e.kind === 'claim' && e.payload.claim_id === claim.claim_id));
    });
    await t.test('existing audit entry authenticates history without changing its legacy view', async () => {
      const legacy = await agent('clued_mcp_audit_receipts', { context_key: 'global', limit: 1 });
      assert.equal(legacy.status, 'ok'); assert.ok(Array.isArray(legacy.receipts));
      assert.equal(Object.hasOwn(legacy, 'events'), false);
      const measured = await agent('clued_mcp_audit_receipts', { context_key: 'global', measurement: { limit: 500 } });
      assert.equal(measured.status, 'ok'); assert.equal(measured.stream_id, initial.stream_id);
      assert.equal(measured.official_metric, false); assert.ok(measured.events.length > 0);
      await assert.rejects(agent('clued_mcp_audit_receipts', { measurement: null }), /measurement_input_invalid/);
    });
    await t.test('late unreadable context cannot enter the watermark authorized earlier in the call', async () => {
      const reader = server.getPgClient(); clients.push(reader); await reader.connect();
      const globalOnlyToken = hash();
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'openai','global-only race reader',$2,array['audit:read'],array['global'])`, [user, globalOnlyToken]);
      // Local test hook pauses only the FINAL fixed-watermark page, after
      // contributor authorization. It never changes the production migration.
      await admin.query(`alter function clued_private.merge_measurement_page_v1(uuid,jsonb)
        rename to merge_measurement_page_test_original_v1;
        create function clued_private.merge_measurement_page_v1(p_user uuid,p_input jsonb)
        returns jsonb language plpgsql stable security definer set search_path='' as $$
        begin
          if current_setting('clued_test.pause_measurement',true)='on' and p_input ? 'end_sequence' then
            perform pg_advisory_lock(192611007);
            perform pg_advisory_unlock(192611007);
          end if;
          return clued_private.merge_measurement_page_test_original_v1(p_user,p_input);
        end $$;
        revoke all on function clued_private.merge_measurement_page_v1(uuid,jsonb) from public,anon,authenticated,service_role;`);
      await admin.query('select pg_advisory_lock(192611007)');
      await reader.query("select set_config('clued_test.pause_measurement','on',false)");
      await setWorkerGatewayCaller(reader);
      const pending = reader.query(`select public.clued_mcp_audit_receipts($1,$2) v`,
        [globalOnlyToken, { context_key: 'global', measurement: {} }]);
      let result;
      try {
        let lockSeen = false;
        for (let index = 0; index < 30; index++) {
          const state = await admin.query('select wait_event_type from pg_stat_activity where pid=$1', [reader.processID]);
          if (state.rows[0]?.wait_event_type === 'Lock') { lockSeen = true; break; }
          await admin.query('select pg_sleep(0.01)');
        }
        assert.equal(lockSeen, true, 'reader was actually parked after authorization');
        // Second connection commits a new scope while the reader is parked.
        // The committed late event remains in the append-only journal, but
        // cannot enter the already-authorized pinned packet.
        await admin.query('begin');
        await admin.query(`select clued_private.merge_measurement_append_v1($1,$2,'admission_receipt','late-context-fixture','{}')`,
          [user, `project:${uuid()}`]);
        await admin.query('commit');
        await admin.query('select pg_advisory_unlock(192611007)');
        result = (await pending).rows[0].v;
        assert.equal(result.status, 'ok'); assert.equal(result.end_sequence, watermark);
        assert.equal(result.events.some(e => e.object_key === 'late-context-fixture'), false);
      } finally {
        await admin.query('select pg_advisory_unlock(192611007)');
        await pending.catch(() => {});
        await admin.query(`drop function clued_private.merge_measurement_page_v1(uuid,jsonb);
          alter function clued_private.merge_measurement_page_test_original_v1(uuid,jsonb)
            rename to merge_measurement_page_v1;`);
      }
    });
    await t.test('another authenticated account never reads this account stream', async () => {
      const otherToken = hash();
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'openai','other reader',$2,array['audit:read'],array['*'])`, [other, otherToken]);
      const result = await rpc(admin, 'clued_mcp_audit_receipts', otherToken, { context_key: 'global', measurement: {} });
      assert.equal(result.status, 'NOT_MEASURED'); assert.equal(result.reason, 'stream_not_started');
      assert.deepEqual(result.events, []);
    });
    await t.test('no-op fields do not create queue history noise; clock inputs do', async () => {
      const before = (await page({})).end_sequence;
      await admin.query(`update clued_private.work_claims_v1 set holder_label='not captured' where claim_id=$1`, [claim.claim_id]);
      assert.equal((await page({})).end_sequence, before);
      await admin.query(`update clued_private.work_claims_v1 set expires_at=expires_at-interval '1 second' where claim_id=$1`, [claim.claim_id]);
      assert.equal((await page({})).end_sequence, before + 1);
    });
    await t.test('later writes do not enter a pinned end watermark; every page is consecutive', async () => {
      let after = 0; const seen = [];
      do {
        const p = await page({ after_sequence: after, end_sequence: watermark, stream_id: initial.stream_id, limit: 1 });
        assert.equal(p.status, 'ok'); seen.push(...p.events.map(e => e.sequence)); after = p.next_sequence;
        if (!p.has_more) break;
      } while (true);
      assert.deepEqual(seen, Array.from({ length: watermark }, (_, index) => index + 1));
    });
    await t.test('rollback undoes event and counter together', async () => {
      const before = (await page({})).end_sequence;
      await admin.query('begin');
      await admin.query(`update clued_private.work_claims_v1 set fence=fence+1 where claim_id=$1`, [claim.claim_id]);
      assert.equal((await page({})).end_sequence, before + 1);
      await admin.query('rollback'); assert.equal((await page({})).end_sequence, before);
    });
    await t.test('two live connections serialize the counter; rollback leaves no committed gap', async () => {
      const first = server.getPgClient(), second = server.getPgClient(); clients.push(first, second);
      await first.connect(); await second.connect();
      const before = (await page({})).end_sequence;
      await first.query('begin');
      await first.query(`select clued_private.merge_measurement_append_v1($1,'global','policy','concurrency-a','{}')`, [user]);
      const pending = second.query(`select clued_private.merge_measurement_append_v1($1,'global','policy','concurrency-b','{}') v`, [user]);
      let lockSeen = false;
      for (let index = 0; index < 30; index++) {
        const state = await admin.query('select wait_event_type from pg_stat_activity where pid=$1', [second.processID]);
        if (state.rows[0]?.wait_event_type === 'Lock') { lockSeen = true; break; }
        await admin.query('select pg_sleep(0.01)');
      }
      assert.equal(lockSeen, true, 'second writer was actually observed waiting on the first transaction');
      assert.equal((await page({})).end_sequence, before, 'uncommitted sequence stays invisible to independent reader');
      await first.query('rollback');
      assert.equal((await pending).rows[0].v, String(before + 1)); // pg preserves bigint as text.
      const after = await page({}); assert.equal(after.end_sequence, before + 1);
      assert.equal(after.events.at(-1).object_key, 'concurrency-b');
    });
    await t.test('subsequent pages require both original pins and end cannot cut a transaction', async () => {
      await assert.rejects(page({ after_sequence: 1 }), /pins_required/);
      await assert.rejects(page({ after_sequence: 1, end_sequence: watermark }), /pins_required/);
      await assert.rejects(page({ after_sequence: 1, stream_id: initial.stream_id }), /pins_required/);
      // New-account policy and first claim were committed atomically.
      assert.equal(initial.events[0].transaction_id, initial.events[1].transaction_id);
      await assert.rejects(page({ end_sequence: 1 }), /watermark_in_transaction/);
    });
    await t.test('unstarted other user is not silently zero/completed', async () => {
      const r = (await admin.query(`select clued_private.merge_measurement_page_v1($1,'{}') v`, [other])).rows[0].v;
      assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.reason, 'stream_not_started');
    });
    await t.test('source change is explicit and never treated as complete evidence', async () => {
      const definition = (await admin.query(`select pg_get_functiondef('clued_private.work_claim_profile_v1()'::regprocedure) v`)).rows[0].v;
      await admin.query(definition.replace("'profile_id', 'work-claim-v1-default'", "'profile_id', 'changed-profile'"));
      // Replace the function with a deterministic different body independently of whitespace.
      await admin.query(`create or replace function clued_private.work_claim_profile_v1() returns jsonb
        language sql immutable set search_path='' as $$select '{"profile_id":"changed-profile"}'::jsonb$$`);
      assert.equal((await page({})).status, 'SOURCE_CHANGED');
      await admin.query(definition);
    });
    await t.test('merge-ref projection changes also invalidate the source pin', async () => {
      const definition = (await admin.query(`select pg_get_functiondef('clued_private.work_claim_merge_refs_v1(text[])'::regprocedure) v`)).rows[0].v;
      await admin.query(`create or replace function clued_private.work_claim_merge_refs_v1(p_refs text[]) returns text[]
        language sql immutable set search_path='' as $$select '{}'::text[]$$`);
      assert.equal((await page({})).status, 'SOURCE_CHANGED');
      await admin.query(definition);
    });
    await t.test('direct history mutations and truncation are rejected', async () => {
      for (const statement of [
        'update clued_private.merge_measurement_events_v1 set payload=payload',
        'delete from clued_private.merge_measurement_events_v1',
        'truncate clued_private.merge_measurement_events_v1'])
        await assert.rejects(admin.query(statement), /merge_measurement_immutable/);
    });
    await t.test('unprivileged roles cannot read, write or call the private core', async () => {
      const denied = server.getPgClient(); clients.push(denied); await denied.connect();
      for (const role of ['anon','authenticated','service_role']) {
        await denied.query(`set role ${role}`);
        await assert.rejects(denied.query('select * from clued_private.merge_measurement_events_v1'), /permission denied/);
        await assert.rejects(denied.query(`select clued_private.merge_measurement_page_v1($1,'{}')`, [user]), /permission denied/);
        await denied.query('reset role');
      }
    });
    await t.test('invalid windows, page bounds, stream pins and input fields are refused', async () => {
      for (const input of [{ limit: 0 }, { limit: 501 }, { after_sequence: -1 },
        { end_sequence: '999999' }, { stream_id: uuid() }, { user_id: other }, { limit: null }])
        await assert.rejects(page(input), /merge_measurement_/);
    });
    await t.test('an unreadable contributing context refuses the whole measurement instead of hiding rows', async () => {
      const restrictedToken = hash();
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'openai','restricted reader',$2,array['audit:read'],array['global'])`, [user, restrictedToken]);
      const hiddenContext = `project:${uuid()}`;
      await admin.query(`select clued_private.merge_measurement_append_v1($1,$2,'admission_receipt','context-boundary-fixture','{}')`, [user, hiddenContext]);
      const result = await rpc(admin, 'clued_mcp_audit_receipts', restrictedToken, { context_key: 'global', measurement: {} });
      assert.equal(result.status, 'NOT_MEASURED'); assert.equal(result.reason, 'measurement_scope_incomplete');
      assert.deepEqual(result.events, []); assert.equal(JSON.stringify(result).includes(hiddenContext), false);
    });
    await t.test('account erasure retains established FK semantics', async () => {
      // Scope this check to the new ledger. A separate existing clued_memory_audit
      // deletion trigger cannot insert its user FK after auth.users is removed;
      // that historical whole-account limitation is not silently "fixed" here.
      await admin.query(`select clued_private.merge_measurement_append_v1($1,'global','policy','fixture','{}')`, [other]);
      await admin.query('delete from auth.users where id=$1', [other]);
      assert.equal((await admin.query(`select count(*)::int n from clued_private.merge_measurement_events_v1 where user_id=$1`, [other])).rows[0].n, 0);
    });
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server);
    // Delete only the test-owned temporary directory after absolute boundary verification.
    const actual = await fs.realpath(directory);
    if (actual !== directory || !path.basename(actual).startsWith('clued-measurement-history-') ||
        path.dirname(actual) !== await fs.realpath(os.tmpdir())) throw new Error('test cleanup boundary changed');
    await removeTestDirectory(actual);
  }
});
