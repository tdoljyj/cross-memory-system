// Retention sweep v1 (design: production database back inside its budget, B1a).
// A real PostgreSQL replays every migration before the retention one, takes stock rows, and applies the
// retention migration the way the release workflow's migrate mode does (one plpgsql EXECUTE in one transaction).
// pg_cron is a stub here (the platform stub of production-schema-drift.mjs): what pg_cron itself does with the
// registered command text is only seen in production.
import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { MIGRATE_MODE_SQL, PLATFORM_SQL } from '../scripts/production-schema-drift.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP_MIGRATION = '20261124120000_retention_sweep_v1.sql';
const SWEEP_JOB = 'clued-retention-sweep';
const OLD_JOB = 'clued-cron-run-history-retention';
const RULES = ['retention_rule_cron_run_history_v1', 'retention_rule_memory_audit_v1', 'retention_rule_session_payload_v1'];
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

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
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: uuid(),
    port: await freePort(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [];
  const connect = async () => { const db = server.getPgClient(); clients.push(db); await db.connect(); return db; };
  try {
    await server.initialise(); await server.start();
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

    await migrate(admin, migrationText);

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
      assert.deepEqual(Object.keys(await sweep(at)), RULES, 'rules run in name order');
      const rows = await auditCount();
      await audit(2, new Date(at - 31 * 86400e3)); await audit(1, new Date(at - 29 * 86400e3));
      const due = await session(at, -36, -36), recent = await session(at, -34, -34);
      const untouched = await sessions([due, recent]);
      assert.deepEqual(await sweep(at), counts(2, 1));
      assert.equal(await auditCount(), rows + 1);
      assert.deepEqual(await sessions([due, recent]), { [due]: cleared(untouched[due]), [recent]: untouched[recent] });
      await admin.query('begin');
      assert.deepEqual(await sweep(at), counts(0, 0));
      const written = await one(`select coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int n from pg_stat_xact_user_tables`);
      await admin.query('commit');
      assert.equal(written.n, 0, 'no row inserted, updated or deleted');
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

    await t.test('the statement timeout in the registered command cancels the whole run; one set on the function would not', async () => {
      const { command } = await one('select command from cron.job where jobname=$1', [SWEEP_JOB]);
      assert.ok(command.startsWith("set local statement_timeout='60s';"), command);
      await admin.query(`create function pg_temp.retention_slow_delete() returns trigger language plpgsql as
        $f$ begin perform pg_sleep(2); return old; end $f$;
        create trigger retention_slow_delete before delete on public.clued_memory_audit
          for each row execute function pg_temp.retention_slow_delete()`);
      try {
        const rows = await auditCount();
        await audit(1, new Date(await now() - 31 * 86400e3));
        // pg_cron sends the command text as one simple query; so does this.
        await assert.rejects(admin.query(command.replace("'60s'", "'200ms'")), error => error.code === '57014');
        assert.equal(await auditCount(), rows + 1, 'the cancelled run removed nothing');
        assert.equal((await one("select current_setting('statement_timeout') v")).v, '0');
        // The timeout is armed when a statement starts, so a function-level setting is too late for its own call.
        await admin.query("begin; alter function clued_private.retention_sweep_v1(timestamptz) set statement_timeout='200ms'");
        const result = (await admin.query('select clued_private.retention_sweep_v1() v')).rows[0].v;
        assert.equal(result.retention_rule_memory_audit_v1, 1, 'ran for two seconds without being cancelled');
        await admin.query('rollback');
        assert.equal(await auditCount(), rows + 1);
      } finally {
        await admin.query('rollback').catch(() => {});
        await admin.query('drop trigger if exists retention_slow_delete on public.clued_memory_audit');
      }
      assert.equal((await sweep(await now())).retention_rule_memory_audit_v1, 1);
    });
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
