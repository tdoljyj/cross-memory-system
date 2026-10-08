-- Storage step 1 (Clued Task ce5c725e, Decision 56d61a92; design
-- StorageFineGrainedConcurrency.v0.1 §4.4): the waits between automatic
-- retries are capped at 10 minutes instead of 60.
--
-- * clued_storage_scheduled_recovery_v2 `due` (BUG-20261007-005,
--   20261007200000): a job past its first 10 minutes waits 2, 4, 8, then 10
--   minutes between listings, plus up to 30 seconds of random jitter so jobs
--   that became due together do not stay in step. Before: 2, 4 ... 64 capped
--   at 60 minutes, so a job that became provable after a few listings could
--   wait an hour (BUG-20261008-002 waited from 05:27Z to a planned 06:27Z).
-- * clued_storage_queued_sweep_v1 (BUG-20261008-001, 20261008000000): queued
--   jobs are listed again after 2, 4, 8, then 10 minutes instead of up to 60.
--
-- Anchored patches with exact hit counts; nothing else in either function
-- changes.

do $migration$
declare patch record; body text; hits int;
begin
  for patch in select * from (values
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$    -- doubles its wait (2, 4, 8, ... minutes, at most 60).
$a$,
     $r$    -- doubles its wait (2, 4, 8, then 10 minutes, plus up to 30 seconds of jitter).
$r$),
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$      next_at=clock_timestamp()+least(interval '1 minute'*power(2,least(b.attempts+1,6)),interval '60 minutes');$a$,
     $r$      next_at=clock_timestamp()+least(interval '1 minute'*power(2,least(b.attempts+1,6)),interval '10 minutes')
        +random()*interval '30 seconds';$r$),
    ('public.clued_storage_queued_sweep_v1(text,jsonb)',
     $a$least(interval '60 minutes',interval '2 minutes'*power(2,least(cand.redispatch_attempts,6)-1))$a$,
     $r$least(interval '10 minutes',interval '2 minutes'*power(2,least(cand.redispatch_attempts,6)-1))$r$)
  ) as p(signature, anchor, replacement)
  loop
    body:=pg_get_functiondef(patch.signature::regprocedure);
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>1 then
      raise exception 'storage_backoff_cap_definition_mismatch: % (% of 1)',patch.signature,hits;
    end if;
    execute replace(body,patch.anchor,patch.replacement);
  end loop;
end $migration$;
