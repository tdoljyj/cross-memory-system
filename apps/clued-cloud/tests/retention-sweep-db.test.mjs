// Retention sweep v1 (design: production database back inside its budget, B1a).
// A real PostgreSQL replays every migration before the retention one, takes stock rows, and applies the
// retention migration the way the release workflow's migrate mode does (one plpgsql EXECUTE in one transaction).
// pg_cron is a stub here (the platform stub of production-schema-drift.mjs): what pg_cron itself does with the
// registered command text is only seen in production.
import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { MIGRATE_MODE_SQL, PLATFORM_SQL } from '../scripts/production-schema-drift.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP_MIGRATION = '20261124120000_retention_sweep_v1.sql';
const KEEP_MIGRATION = '20261124130000_imprint_history_keep_v1.sql';
// Replaces the run-history rule of SWEEP_MIGRATION in place; everything after it below runs on the new body.
const RUN_HISTORY_MIGRATION = '20261125020000_retention_rule_cron_run_history_regclass_v1.sql';
const SWEEP_JOB = 'clued-retention-sweep';
const OLD_JOB = 'clued-cron-run-history-retention';
const RULES = ['retention_rule_cron_run_history_v1', 'retention_rule_memory_audit_v1', 'retention_rule_session_payload_v1'];
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');


// The release workflow's migrate mode: the whole file is one EXECUTE inside one transaction.
async function migrate(client, text) {
  await client.query('begin');
  try {
    await client.query("select set_config('clued.migration_text', $1, true)", [text]);
    await client.query(MIGRATE_MODE_SQL);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

test('retention sweep: stock cleanup in the migration transaction and the daily sweep',
  { timeout: 600000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-retention-sweep-'));
  const server = newCluster({ databaseDir: directory, user: 'postgres', password: uuid(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [];
  const connect = async () => { const db = server.getPgClient(); clients.push(db); await db.connect(); return db; };
  try {
    await startCluster(server);
    const admin = await connect();
    await admin.query(PLATFORM_SQL);
    // Production has pg_cron's run history; with it the 20261118080000 migration registers the job this one replaces.
    await admin.query('create table cron.job_run_details(runid bigint, status text, start_time timestamptz, end_time timestamptz)');
    const migrations = path.join(root, 'supabase/migrations');
    const names = (await fs.readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
    for (const name of names.filter(name => name < SWEEP_MIGRATION)) {
      try { await admin.query(await fs.readFile(path.join(migrations, name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    const other = await connect();

    const owner = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'retention@example.invalid',now())", [owner]);
    const binding = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','retention',$2,array['context:read'],array['*']) returning id`, [owner, hash()])).rows[0].id;
    const one = async (sql, args) => (await admin.query(sql, args)).rows[0];
    const audit = (count, at, pad = 8) => admin.query(`insert into public.clued_memory_audit(user_id,memory_id,action,details,occurred_at)
      select $1,gen_random_uuid(),'update',jsonb_build_object('n',g,'pad',repeat(md5(g::text),$3)),$2::timestamptz
      from generate_series(1,$4::int) g returning id`, [owner, at, pad, count]);
    // ended/expires are offsets in days from the reference time; null = not ended.
    const session = async (at, endedDays, expiresDays) => (await admin.query(`insert into public.clued_continuity_sessions
      (user_id,binding_id,context_key,token_hash,restored_version,started_at,expires_at,ended_at,delivered_constraint_refs,constraint_view)
      values($1,$2,'global',$3,0,$4::timestamptz-interval '90 days',$4::timestamptz+$6::float8*interval '1 day',
        $4::timestamptz+$5::float8*interval '1 day','[{"id":"c1","version":1}]','index') returning id`,
    [owner, binding, hash(), at, endedDays, expiresDays])).rows[0].id;
    const sessions = async ids => (await admin.query(
      'select id,to_jsonb(s) v from public.clued_continuity_sessions s where id=any($1::uuid[])', [ids]))
      .rows.reduce((all, row) => ({ ...all, [row.id]: row.v }), {});
    const auditRows = async () => (await admin.query('select to_jsonb(a) v from public.clued_memory_audit a order by id')).rows.map(r => r.v);
    const auditSize = async () => Number((await one("select pg_total_relation_size('public.clued_memory_audit') n")).n);
    const jobs = async () => (await admin.query('select jobname,schedule,command from cron.job order by jobname')).rows;
    const cleared = v => ({ ...v, restored_currentness_vector: null, delivered_constraint_refs: null });

    // ---- stock rows, taken before the migration ---------------------------------------------------------------
    const start = (await one('select clock_timestamp() t')).t;
    await audit(20000, new Date(start - 60 * 86400e3), 12);
    const old31 = (await audit(3, new Date(start - 31 * 86400e3))).rows.map(r => r.id);
    const kept = [...(await audit(3, new Date(start - 29 * 86400e3))).rows, ...(await audit(3, start)).rows].map(r => r.id);
    const ended36 = await session(start, -36, -36), expired36 = await session(start, null, -36);
    const ended34 = await session(start, -34, -34), active = await session(start, null, 1);
    const stock = [ended36, expired36, ended34, active];
    await admin.query('set session_replication_role=replica');
    const eventId = (await one(`insert into public.clued_context_events(user_id,context_key,session_id,binding_id,event_type,payload)
      values($1,'global',$2,$3,'note','{"marker":"retention"}') returning id`, [owner, ended36, binding])).id;
    const checkpointId = (await one(`insert into public.clued_context_checkpoints(user_id,binding_id,context_key,version,snapshot,summary,next_action,session_id)
      values($1,$2,'global',1,'{}','retention','none',$3) returning id`, [owner, binding, ended36])).id;
    await admin.query('set session_replication_role=origin');
    const references = async () => ({
      event: (await one('select session_id from public.clued_context_events where id=$1', [eventId])).session_id,
      checkpoint: (await one('select session_id from public.clued_context_checkpoints where id=$1', [checkpointId])).session_id });
    const before = { sessions: await sessions(stock), audit: await auditRows(), size: await auditSize(), jobs: await jobs(),
      views: (await admin.query('select constraint_view,count(*)::int n from public.clued_continuity_sessions group by 1 order by 1')).rows };
    for (const id of stock) {
      assert.ok(before.sessions[id].restored_currentness_vector, 'the insert trigger binds a currentness vector');
      assert.ok(before.sessions[id].delivered_constraint_refs);
    }
    assert.ok(before.jobs.some(job => job.jobname === OLD_JOB), 'the job this migration replaces is registered');
    const migrationText = await fs.readFile(path.join(migrations, SWEEP_MIGRATION), 'utf8');
    const sweepExists = async () => (await one("select to_regprocedure('clued_private.retention_sweep_v1(timestamptz)') is not null ok")).ok;

    await t.test('a held lock on the audit table fails the migration with 55P03 within the lock timeout and leaves nothing behind', async () => {
      await other.query('begin; lock table public.clued_memory_audit in access share mode'); // a backup reading the table
      const began = Date.now();
      await assert.rejects(migrate(admin, migrationText), error => error.code === '55P03');
      assert.ok(Date.now() - began < 10000, `gave up after ${Date.now() - began} ms`);
      await other.query('rollback');
      assert.equal(await sweepExists(), false);
      assert.equal((await one("select count(*)::int n from pg_proc where proname like 'retention\\_%'")).n, 0);
      assert.deepEqual(await auditRows(), before.audit);
      assert.deepEqual(await sessions(stock), before.sessions);
      assert.deepEqual(await jobs(), before.jobs);
    });

    await other.query('begin');
    const racedAudit = (await other.query("insert into public.clued_memory_audit(user_id,memory_id,action) values($1,gen_random_uuid(),'create') returning id", [owner])).rows[0].id;
    { const pending = migrate(admin, migrationText); await new Promise(r => setTimeout(r, 1500)); await other.query('commit'); await pending; }
    await t.test('an audit row committed while the migration waits for its lock is kept', async () => {
      assert.equal((await one('select count(*)::int n from public.clued_memory_audit where id=$1', [racedAudit])).n, 1);
    });
    await admin.query('delete from public.clued_memory_audit where id=$1', [racedAudit]);
    await migrate(admin, await fs.readFile(path.join(migrations, RUN_HISTORY_MIGRATION), 'utf8'));

    await t.test('memory audit stock: only the last 30 days remain, unchanged, and the files shrink', async () => {
      const after = await auditRows();
      assert.deepEqual(after.map(row => row.id).sort(), [...kept].sort());
      assert.deepEqual(after, before.audit.filter(row => kept.includes(row.id)), 'every column of a kept row is as it was');
      assert.ok(!after.some(row => old31.includes(row.id)));
      const size = await auditSize();
      assert.ok(size < before.size / 2, `table and indexes ${before.size} -> ${size} bytes`);
      t.diagnostic(`clued_memory_audit: ${before.size} -> ${size} bytes`);
      assert.match((await one("select obj_description('public.clued_memory_audit'::regclass) c")).c, /30 days/);
    });

    await t.test('session stock: only the two payload columns of sessions over 35 days past are emptied', async () => {
      const after = await sessions(stock);
      assert.deepEqual(after[ended36], cleared(before.sessions[ended36]), 'ended 36 days ago: id, times, token_hash and the rest unchanged');
      assert.deepEqual(after[expired36], cleared(before.sessions[expired36]), 'expired 36 days ago and never ended');
      assert.equal(after[ended36].constraint_view, 'index');
      assert.deepEqual(after[ended34], before.sessions[ended34], 'ended 34 days ago');
      assert.deepEqual(after[active], before.sessions[active], 'active');
      assert.deepEqual(await references(), { event: ended36, checkpoint: ended36 });
      assert.deepEqual((await admin.query('select constraint_view,count(*)::int n from public.clued_continuity_sessions group by 1 order by 1')).rows,
        before.views);
    });

    await t.test('one daily job replaces the run-history job; the job count is unchanged', async () => {
      const after = await jobs();
      assert.equal(after.length, before.jobs.length);
      assert.equal(after.some(job => job.jobname === OLD_JOB), false);
      assert.deepEqual(after.filter(job => job.jobname === SWEEP_JOB), [{ jobname: SWEEP_JOB, schedule: '37 20 * * *',
        command: "set local statement_timeout='60s'; select clued_private.retention_sweep_v1()" }]);
      assert.deepEqual(after.filter(job => ![SWEEP_JOB, OLD_JOB].includes(job.jobname)),
        before.jobs.filter(job => job.jobname !== OLD_JOB));
    });

    await t.test('no API role can execute a retention function', async () => {
      const rows = (await admin.query(`select p.oid::regprocedure::text signature, r.rolname
        from pg_proc p cross join unnest(array['anon','authenticated','service_role']) r(rolname)
        where p.pronamespace='clued_private'::regnamespace and p.proname like 'retention\\_%'
          and has_function_privilege(r.rolname, p.oid, 'execute')`)).rows;
      assert.deepEqual(rows, []);
      const publicGrants = (await one(`select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.pronamespace='clued_private'::regnamespace and p.proname like 'retention\\_%' and a.grantee=0`)).n;
      assert.equal(publicGrants, 0);
    });

    const sweep = async (at, db = admin) => (await db.query('select clued_private.retention_sweep_v1($1) v', [at])).rows[0].v;
    const counts = (audits, payloads, runs = 0) => ({ retention_rule_cron_run_history_v1: runs,
      retention_rule_memory_audit_v1: audits, retention_rule_session_payload_v1: payloads });
    const now = async () => (await one('select clock_timestamp() t')).t;
    const auditCount = async () => (await one('select count(*)::int n from public.clued_memory_audit')).n;

    await t.test('daily sweep: the counts it returns are what it changed, and a second run writes nothing', async () => {
      const at = await now();
      assert.deepEqual(Object.keys(await sweep(at)).sort(), RULES, 'every rule function is found by its name');
      const rows = await auditCount();
      await audit(2, new Date(at - 31 * 86400e3)); await audit(1, new Date(at - 29 * 86400e3));
      const due = await session(at, -36, -36), recent = await session(at, -34, -34);
      const untouched = await sessions([due, recent]);
      assert.deepEqual(await sweep(at), counts(2, 1));
      assert.equal(await auditCount(), rows + 1);
      assert.deepEqual(await sessions([due, recent]), { [due]: cleared(untouched[due]), [recent]: untouched[recent] });
      // A new connection: these counters also hold a backend's earlier writes until it reports them.
      const fresh = await connect();
      await fresh.query('begin');
      assert.deepEqual(await sweep(at, fresh), counts(0, 0));
      const written = (await fresh.query(`select schemaname||'.'||relname relation, (n_tup_ins+n_tup_upd+n_tup_del)::int n
        from pg_stat_xact_user_tables where n_tup_ins+n_tup_upd+n_tup_del<>0 order by 1`)).rows;
      await fresh.query('commit');
      assert.deepEqual(written, [], 'no row inserted, updated or deleted');
    });

    await t.test('the audit rule removes at most 5000 rows a run', async () => {
      const at = await now();
      const rows = await auditCount();
      await audit(5001, new Date(at - 31 * 86400e3), 1);
      assert.deepEqual(await sweep(at), counts(5000, 0));
      assert.equal(await auditCount(), rows + 1);
      assert.deepEqual(await sweep(at), counts(1, 0));
      assert.equal(await auditCount(), rows);
    });

    await t.test('a locked session row is left for the next run; a locked table skips only its own rule', async () => {
      const at = await now();
      const held = await session(at, -36, -36), free = await session(at, -36, -36);
      const rows = await auditCount();
      await audit(1, new Date(at - 31 * 86400e3));
      await other.query('begin');
      await other.query('select id from public.clued_continuity_sessions where id=$1 for update', [held]);
      let began = Date.now();
      assert.deepEqual(await sweep(at), counts(1, 1));
      assert.ok(Date.now() - began < 2500, `the sweep waited ${Date.now() - began} ms for a row lock`);
      await other.query('rollback');
      const after = await sessions([held, free]);
      assert.ok(after[held].restored_currentness_vector && after[held].delivered_constraint_refs);
      assert.equal(after[free].restored_currentness_vector, null);
      assert.equal(await auditCount(), rows);

      await audit(1, new Date(at - 31 * 86400e3));
      await other.query('begin; lock table public.clued_memory_audit in access exclusive mode');
      began = Date.now();
      assert.deepEqual(await sweep(at), { ...counts(0, 1), retention_rule_memory_audit_v1: 'lock_not_available' });
      assert.ok(Date.now() - began < 8000, `the sweep waited ${Date.now() - began} ms for a table lock`);
      await other.query('rollback');
      assert.equal((await sessions([held]))[held].restored_currentness_vector, null);
      assert.deepEqual(await sweep(at), counts(1, 0));
    });

    await t.test('the run-history rule keeps running and recent runs, as the job it replaces did', async () => {
      const at = await now();
      await admin.query(`insert into cron.job_run_details values
        (1, 'succeeded', $1::timestamptz - interval '3 days', $1::timestamptz - interval '2 days'),
        (2, 'failed', $1::timestamptz - interval '2 days', null),
        (3, 'running', $1::timestamptz - interval '3 days', null),
        (4, 'succeeded', $1::timestamptz - interval '3 days', $1::timestamptz),
        (5, 'succeeded', $1::timestamptz - interval '3 days', $1::timestamptz - interval '1 day')`, [at]);
      const remaining = async () => (await admin.query('select runid::int from cron.job_run_details order by runid')).rows.map(r => r.runid);
      assert.deepEqual(await sweep(at), counts(0, 0, 2));
      assert.deepEqual(await remaining(), [3, 4, 5]);
      await admin.query("update cron.job_run_details set end_time = now() - interval '25 hours' where runid = 5");
      await admin.query((await one('select command from cron.job where jobname=$1', [SWEEP_JOB])).command);
      assert.deepEqual(await remaining(), [3, 4]);
    });

    await t.test('without pg_cron run history the run-history rule returns 0; its search path is still empty', async () => {
      const rule = 'clued_private.retention_rule_cron_run_history_v1(timestamptz)';
      assert.deepEqual((await one('select proconfig from pg_proc where oid=$1::regprocedure', [rule])).proconfig, ['search_path=""']);
      assert.equal((await one("select count(*)::int n from pg_proc where proname='retention_rule_cron_run_history_v1'")).n, 1);
      await admin.query('begin');
      try {
        await admin.query('drop table cron.job_run_details');
        assert.equal((await one('select clued_private.retention_rule_cron_run_history_v1($1) n', [await now()])).n, 0);
        assert.equal((await sweep(await now())).retention_rule_cron_run_history_v1, 0);
      } finally {
        await admin.query('rollback');
      }
      assert.equal((await one("select to_regclass('cron.job_run_details') is not null ok")).ok, true);
    });

    await t.test('the statement timeout in the registered command cancels the whole run; one set on the function would not', async () => {
      const cron = await connect();
      const { command } = await one('select command from cron.job where jobname=$1', [SWEEP_JOB]);
      assert.ok(command.startsWith("set local statement_timeout='60s';"), command);
      await admin.query(`create function pg_temp.retention_slow_delete() returns trigger language plpgsql as
        $f$ begin perform pg_sleep(2); return old; end $f$;
        create trigger retention_slow_delete before delete on public.clued_memory_audit
          for each row execute function pg_temp.retention_slow_delete()`);
      try {
        const rows = await auditCount();
        await audit(1, new Date(await now() - 31 * 86400e3));
        // As pg_cron's connection: no statement timeout of its own (production's postgres role has none), and the
        // command text sent as one simple query.
        assert.equal((await cron.query("select current_setting('statement_timeout') v")).rows[0].v, '0');
        await assert.rejects(cron.query(command.replace("'60s'", "'200ms'")), error => error.code === '57014');
        assert.equal(await auditCount(), rows + 1, 'the cancelled run removed nothing');
        assert.equal((await cron.query("select current_setting('statement_timeout') v")).rows[0].v, '0');
        // The timeout is armed when a statement starts, so a function-level setting is too late for its own call.
        await cron.query("begin; alter function clued_private.retention_sweep_v1(timestamptz) set statement_timeout='200ms'");
        const result = (await cron.query('select clued_private.retention_sweep_v1() v')).rows[0].v;
        assert.equal(result.retention_rule_memory_audit_v1, 1, 'ran for two seconds without being cancelled');
        await cron.query('rollback');
        assert.equal(await auditCount(), rows + 1);
      } finally {
        await cron.query('rollback').catch(() => {});
        await admin.query('drop trigger if exists retention_slow_delete on public.clued_memory_audit');
      }
      assert.equal((await sweep(await now())).retention_rule_memory_audit_v1, 1);
    });

    // ---- B1b: imprint record history keeps the 20 newest prior versions of a record ---------------------------
    const human = await connect();
    await human.query("set statement_timeout='30s'; set lock_timeout='10s'; set role authenticated");
    await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [owner, JSON.stringify({ sub: owner, role: 'authenticated', session_id: 'retention-history',
        amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
    const call = async (name, input, writing = false) => (await human.query(`select public.${name}($1${writing ? ',$2' : ''}) v`,
      writing ? [JSON.stringify(input), crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')] : [JSON.stringify(input)])).rows[0].v;
    const mark = n => `mark-${n}-end`;
    // Bodies that do not compress, so a removed version is a visible part of the table's files.
    const body = n => `${mark(n)} ${crypto.randomBytes(3900).toString('hex')}`;
    const versions = {};
    async function createRecord() {
      const input = { operation: 'create', id: uuid(), record_type: 'note', record_schema_version: 1,
        lifecycle_status: 'active', scope: 'global', idempotency_key: 'retention-create:' + uuid(), authority: 'user_explicit',
        user_confirmed: true, confidence_reason: 'Isolated synthetic owner write', source_refs: [],
        source_unavailable_reason: 'Isolated synthetic record',
        mutation: { title: 'Synthetic retention history', content: body(1), type_fields: { note_kind: 'log' } } };
      const result = await call('clued_user_record_mutate', input, true);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      versions[input.id] = 1; return input.id;
    }
    async function advance(id, times) {
      for (let i = 0; i < times; i++) {
        const input = { operation: 'update', id, record_type: 'note', record_schema_version: 1, base_version: versions[id],
          lifecycle_status: 'active', scope: 'global', idempotency_key: 'retention-update:' + uuid(), authority: 'user_explicit',
          user_confirmed: true, confidence_reason: 'Isolated synthetic owner update', mutation: { content: body(versions[id] + 1) } };
        const result = await call('clued_user_record_mutate', input, true);
        assert.equal(result.status, 'committed', JSON.stringify(result));
        versions[id]++;
      }
    }
    const history = async id => (await admin.query(
      'select version::int version,to_jsonb(h) v from clued_private.imprint_record_history_v1 h where record_id=$1 order by version', [id])).rows;
    // The prior versions a record may keep: the 20 below its current version.
    const newest20 = id => Array.from({ length: 20 }, (_, i) => versions[id] - 20 + i);
    const historySize = async () => Number((await one("select pg_total_relation_size('clued_private.imprint_record_history_v1') n")).n);
    // What the Native reader gets for one prior version: the stored body after its hash check, or nothing.
    const prior = async (id, version) => (await one(`select (clued_private.imprint_history_record_v1($1,m,$3)).content
      from public.clued_memories m where m.id=$2`, [owner, id, version])).content;
    const search = async n => (await call('clued_imprint_read_v1', { query: mark(n), include_history: true })).records;

    const long = await createRecord(), short = await createRecord(), bulk = await createRecord();
    await advance(long, 25); await advance(short, 3);
    const stockHistory = { long: await history(long), short: await history(short), size: await historySize() };
    assert.deepEqual(stockHistory.long.map(row => row.version), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal(stockHistory.short.length, 3);
    assert.equal((await search(3)).find(row => row.id === long).matched_revision_count, 1, 'before the migration version 3 is found');
    const keepText = await fs.readFile(path.join(migrations, KEEP_MIGRATION), 'utf8');
    const keepRule = async () => (await one("select to_regprocedure('clued_private.retention_rule_imprint_history_v1(timestamptz)') is not null ok")).ok;

    await t.test('a held lock on the history table fails the history migration with 55P03 and leaves nothing behind', async () => {
      await other.query('begin; lock table clued_private.imprint_record_history_v1 in access share mode');
      const began = Date.now();
      await assert.rejects(migrate(admin, keepText), error => error.code === '55P03');
      assert.ok(Date.now() - began < 10000, `gave up after ${Date.now() - began} ms`);
      await other.query('rollback');
      assert.equal(await keepRule(), false);
      assert.deepEqual(await history(long), stockHistory.long);
      assert.deepEqual(await history(short), stockHistory.short);
    });

    const jobsBeforeKeep = await jobs();
    await other.query('begin');
    await other.query("insert into clued_private.imprint_record_history_v1(user_id,record_id,version,scope,envelope,envelope_sha256) select $1,$2::uuid,900,'global',jsonb_build_object('id',$2::text,'version',900),repeat('0',64)", [owner, bulk]);
    { const pending = migrate(admin, keepText); await new Promise(r => setTimeout(r, 1500)); await other.query('commit'); await pending; }
    await t.test('a history row committed while the history migration waits for its lock is kept', async () => {
      assert.equal((await one('select count(*)::int n from clued_private.imprint_record_history_v1 where record_id=$1 and version=900', [bulk])).n, 1);
    });
    await admin.query('delete from clued_private.imprint_record_history_v1 where record_id=$1 and version=900', [bulk]);

    await t.test('history stock: the 20 newest prior versions stay readable, older ones are gone and the files shrink', async () => {
      assert.deepEqual(await history(long), stockHistory.long.filter(row => row.version > 5), 'kept rows are unchanged');
      assert.deepEqual(await history(short), stockHistory.short, 'a record with three prior versions is untouched');
      const size = await historySize();
      assert.ok(size < stockHistory.size, `table and indexes ${stockHistory.size} -> ${size} bytes`);
      t.diagnostic(`imprint_record_history_v1: ${stockHistory.size} -> ${size} bytes`);
      for (const version of newest20(long)) {
        assert.ok((await prior(long, version)).startsWith(mark(version) + ' '), `version ${version} passes its hash check`);
      }
      for (const version of [1, 5]) assert.equal(await prior(long, version), null);
      assert.deepEqual((await search(3)).filter(row => row.id === long), [], 'a removed version no longer matches, and the search does not fail');
      const found = (await search(10)).filter(row => row.id === long);
      assert.equal(found.length, 1);
      assert.equal(found[0].matched_revision_count, 1); assert.equal(found[0].matched_revisions[0].matched_record_version, 10);
      assert.deepEqual(await jobs(), jobsBeforeKeep, 'no pg_cron job is added or changed');
      assert.deepEqual((await admin.query(`select r from unnest(array['anon','authenticated','service_role']) r
        where has_function_privilege(r, 'clued_private.retention_rule_imprint_history_v1(timestamptz)', 'execute')`)).rows, []);
    });

    await t.test('daily sweep: a record back over 20 prior versions returns to 20, at most 200 rows a run', async () => {
      await advance(long, 3);
      assert.equal((await history(long)).length, 23);
      assert.equal((await sweep(await now())).retention_rule_imprint_history_v1, 3);
      assert.deepEqual((await history(long)).map(row => row.version), newest20(long));
      assert.equal((await history(short)).length, 3);
      assert.equal((await sweep(await now())).retention_rule_imprint_history_v1, 0);
      // 221 prior versions written straight into the table: 201 over the limit.
      await admin.query(`insert into clued_private.imprint_record_history_v1(user_id,record_id,version,scope,envelope,envelope_sha256)
        select $1,$2::uuid,g,'global',jsonb_build_object('id',$2::text,'version',g),repeat('0',64) from generate_series(1001,1221) g`, [owner, bulk]);
      assert.equal((await sweep(await now())).retention_rule_imprint_history_v1, 200);
      assert.equal((await sweep(await now())).retention_rule_imprint_history_v1, 1);
      assert.deepEqual((await history(bulk)).map(row => row.version), Array.from({ length: 20 }, (_, i) => 1202 + i));
    });

    await t.test('after the refill the capture trigger, the immutable trigger and the cascade still work', async () => {
      await advance(long, 1);
      assert.deepEqual((await history(long)).map(row => row.version), [versions[long] - 21, ...newest20(long)]);
      await assert.rejects(admin.query('update clued_private.imprint_record_history_v1 set scope=scope where record_id=$1', [long]),
        /imprint_history_immutable/);
      await admin.query('delete from public.clued_memories where id=$1', [short]);
      assert.deepEqual(await history(short), []);
    });
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
