-- The run-history retention rule no longer names pg_cron's table in its own text
-- (PLAN-g4-lint-cron-20261125; Clued Task 4432ee9b).
--
-- 20261124120000 wrote the delete as a constant string under EXECUTE. plpgsql_check parses a constant EXECUTE
-- string as SQL, and a database without pg_cron has no such relation, so the G4 database lint failed with 42P01
-- on this one function. The table is now resolved once into a regclass variable and that value is formatted into
-- the statement, as storage_conflict_require_scheduler_v1 (20261016040000) does: the check and the delete use the
-- same resolved object, and the statement text exists only at run time.
--
-- Same name, arguments, return type, language and search_path, so this replaces the function in place: its owner
-- and the privileges revoked in 20261124120000 stay, and retention_sweep_v1 keeps finding it by name. The rows it
-- removes are the same. No job, table or data changes.
create or replace function clued_private.retention_rule_cron_run_history_v1(p_at timestamptz)
returns integer language plpgsql set search_path='' as $$
declare v_runs regclass; v_count integer;
begin
  v_runs := pg_catalog.to_regclass('cron.job_run_details');
  if v_runs is null then return 0; end if;
  execute pg_catalog.format($sql$
    delete from %s
    where status in ('succeeded', 'failed')
      and coalesce(end_time, start_time) < $1 - interval '1 day'
  $sql$, v_runs) using p_at;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
