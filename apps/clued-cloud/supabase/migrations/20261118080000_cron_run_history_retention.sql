-- Some installations have no pg_cron. The cleanup and its schedule commit together.
do $retention$
declare
  cleanup constant text := $sql$
    delete from cron.job_run_details
    where status in ('succeeded', 'failed')
      and coalesce(end_time, start_time) < now() - interval '1 day'
  $sql$;
begin
  if to_regclass('cron.job_run_details') is not null then
    execute cleanup;
    perform cron.schedule('clued-cron-run-history-retention', '37 3 * * *', cleanup);
  end if;
end
$retention$;
