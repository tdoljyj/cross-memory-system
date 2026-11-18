import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function checkDatabaseMaintenance(t, db) {
  await t.test('cron retention preserves ongoing and recent runs on install and on the next scheduled sweep', async () => {
    const migration = await readFile(new URL('../supabase/migrations/20261118080000_cron_run_history_retention.sql', import.meta.url), 'utf8');
    await db.query(migration); // A plain PostgreSQL install has no pg_cron.
    await db.query(`begin;
      create schema cron;
      create table cron.job(jobid bigint generated always as identity, jobname name unique, schedule text, command text);
      create function cron.schedule(name,text,text) returns bigint language sql as
        $$insert into cron.job(jobname,schedule,command) values($1,$2,$3) on conflict(jobname)
          do update set schedule=excluded.schedule, command=excluded.command returning jobid$$;
      create table cron.job_run_details(runid int, status text, start_time timestamptz, end_time timestamptz);
      insert into cron.job_run_details values
        (1, 'succeeded', now() - interval '3 days', now() - interval '2 days'),
        (2, 'failed', now() - interval '2 days', null),
        (3, 'running', now() - interval '3 days', null),
        (4, 'succeeded', now() - interval '3 days', now()),
        (5, 'succeeded', now() - interval '3 days', now() - interval '1 day')`);
    const remaining = async () => (await db.query('select runid from cron.job_run_details order by runid')).rows.map(r => r.runid);
    await db.query(migration);
    assert.deepEqual(await remaining(), [3, 4, 5]);
    await db.query(migration);
    const jobs = (await db.query("select schedule, command from cron.job where jobname = 'clued-cron-run-history-retention'")).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].schedule, '37 3 * * *');
    await db.query("update cron.job_run_details set end_time = now() - interval '25 hours' where runid = 5");
    await db.query(jobs[0].command);
    assert.deepEqual(await remaining(), [3, 4]);
    await db.query('rollback');
  });

  await t.test('selective claim, decision and pending-event reads use their partial indexes on a skewed fixture', async t => {
    // One large scope per owner, with sparse claim receipts, active decisions and work-log events.
    await db.query(`create table public.clued_audit_receipts as select md5('owner')::uuid user_id, 'global'::text context_key,
        g::text object_id, case when g%100=0 then 'work_claim_queue_keepalive' else 'other' end operation, now() created_at
        from generate_series(1,20000) g;
      create index on public.clued_audit_receipts(user_id,context_key,created_at desc);
      create table public.clued_memories as select md5('owner')::uuid user_id, 'global'::text canonical_scope,
        1 record_schema_version, 'decision'::text record_type, case when g%100=0 then 'active' else 'archived' end lifecycle_status,
        now() updated_at from generate_series(1,20000) g;
      create index on public.clued_memories(user_id,updated_at desc);
      create table public.clued_context_events as select md5('owner')::uuid user_id, 'global'::text context_key, g::bigint id,
        case when g%100=0 then 'work_log' when g%100=1 then null else 'audit_only' end audit_visibility,
        case when g%100=1 then null else 1 end event_schema_version from generate_series(1,20000) g;
      create index on public.clued_context_events(user_id,context_key,id);
      analyze public.clued_audit_receipts; analyze public.clued_memories; analyze public.clued_context_events`);
    const owner = "user_id=md5('owner')::uuid";
    const cases = [
      ['20261118080100_claim_receipt_lookup_idx', 'clued_audit_receipts', 'clued_audit_receipts_claim_activity_idx',
        `${owner} and object_id='100' and operation='work_claim_queue_keepalive' and created_at>now()-interval '1 hour'`],
      ['20261118080200_resume_decision_lookup_idx', 'clued_memories', 'clued_memories_active_decision_scope_idx',
        `${owner} and canonical_scope='global' and record_schema_version is not null and record_type='decision'
          and lifecycle_status='active' and updated_at>now()-interval '1 day'`],
      ['20261118080300_pending_work_log_lookup_idx', 'clued_context_events', 'clued_context_events_work_log_idx',
        `${owner} and context_key='global' and id>1000 and (audit_visibility='work_log' or
          (event_schema_version is null and audit_visibility is null))`],
    ];
    for (const [migration, table, index, predicate] of cases) {
      const explain = async () => (await db.query(`explain (analyze, buffers, format json) select * from public.${table} where ${predicate}`))
        .rows[0]['QUERY PLAN'][0].Plan;
      const before = await explain();
      await db.query(await readFile(new URL(`../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'));
      const after = await explain();
      assert.ok(JSON.stringify(after).includes(`"Index Name":"${index}"`), JSON.stringify(after));
      assert.equal(after['Actual Rows'], before['Actual Rows']);
      const buffers = plan => `${plan['Shared Hit Blocks']} hits + ${plan['Shared Read Blocks']} reads`;
      t.diagnostic(`${table}: ${before['Node Type']} -> ${after['Node Type']} via ${index}, rows ${after['Actual Rows']}, ${buffers(before)} -> ${buffers(after)}`);
    }
  });
}
