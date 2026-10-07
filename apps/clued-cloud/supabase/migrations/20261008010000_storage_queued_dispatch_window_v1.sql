-- BUG-20261008-001 follow-up (Clued Task f7a4dd7d): a text job past its
-- 2-hour window is never dispatched again.
--
-- clued_storage_queued_sweep_v1 (20261008000000) settles at most 3 text jobs
-- per call as DISPATCH_NOT_STARTED, then lists redispatch candidates in the
-- same call. The candidate query had no upper age bound, so a fourth text job
-- older than 2 hours was dispatched instead of settled. In production, after
-- the release at ac26d9f, job ...a004 (submitted about 8 hours earlier) was
-- dispatched and denied before any reservation (ARTIFACT_AUTHORITY_RESOLUTION_FAILED,
-- no intent, nothing changed in Drive), while ...a001-a003 were settled.
--
-- The candidate query now skips text jobs submitted 2 hours ago or earlier; the
-- next call settles them. A binary job keeps its own 12-hour cancellation and
-- stays a candidate until then, as before. Anchored patch, exact hit count.

do $migration$
declare body text; hits int;
  anchor text:=$a$        and j0.created_at<=clock_timestamp()-interval '90 seconds'
$a$;
  replacement text:=$r$        and j0.created_at<=clock_timestamp()-interval '90 seconds'
        and (j0.mutation ? 'content_ref' or j0.created_at>clock_timestamp()-interval '2 hours')
$r$;
begin
  body:=pg_get_functiondef('public.clued_storage_queued_sweep_v1(text,jsonb)'::regprocedure);
  hits:=(length(body)-length(replace(body,anchor,'')))/length(anchor);
  if hits<>1 then
    raise exception 'storage_queued_dispatch_window_definition_mismatch: clued_storage_queued_sweep_v1 (% of 1)',hits;
  end if;
  execute replace(body,anchor,replacement);
end $migration$;
