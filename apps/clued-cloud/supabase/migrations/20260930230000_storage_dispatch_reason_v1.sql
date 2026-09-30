-- Storage dispatch reason v1: a pre-reservation cloud outcome records WHY.
--
-- The account-policy cloud Worker reports a job it denied or could not run
-- before any reservation (op='report'). Until now only {status} was stored and
-- the reason lived in a Worker log line. The report now accepts an optional
-- fixed-shape reason, stored in the job's dispatch_outcome; the dispatch_outcome
-- event's change_summary carries the code and finding_count only (no paths),
-- and the receipt binds the full request through its request hash:
--
--   {"status":"denied"|"attention_required",
--    "reason":{"code":"<^[A-Z][A-Z0-9_]{2,63}$>",
--              "findings":[{"path":"<1..1000 chars>","reason":"<^[a-z][a-z0-9_]{2,63}$>"}]}}
--
-- findings (1..10) are allowed only for a denied outcome. They are the Owner's
-- own Drive paths from the boundary scan, kept in the Owner's private rows and
-- never logged. An outcome without a reason is accepted exactly as before.
-- storage_job_status_v1 exposes only reason.code (as reason_code) and only when
-- a reason was stored, so existing job-status shapes are unchanged.
-- The legacy clued_storage_cloud_worker_v1 report branch is not changed; the
-- Worker sends a reason only in account-policy mode.

-- Each shape check runs only after the type it needs is proven, so a malformed
-- outcome is refused as storage_cloud_denied, never as a jsonb operator error.
create function clued_private.storage_dispatch_outcome_valid_v1(p jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare r jsonb; f jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' or (p-array['status','reason'])<>'{}'::jsonb
    or jsonb_typeof(p->'status') is distinct from 'string' or p->>'status' not in ('denied','attention_required') then
    return false; end if;
  if not (p ? 'reason') then return true; end if;
  r:=p->'reason';
  if jsonb_typeof(r) is distinct from 'object' or (r-array['code','findings'])<>'{}'::jsonb
    or jsonb_typeof(r->'code') is distinct from 'string' or (r->>'code') !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    return false; end if;
  if not (r ? 'findings') then return true; end if;
  -- Boundary findings belong to a denial only.
  if p->>'status'<>'denied' or jsonb_typeof(r->'findings') is distinct from 'array'
    or jsonb_array_length(r->'findings') not between 1 and 10 then
    return false; end if;
  for f in select x from jsonb_array_elements(r->'findings') e(x) loop
    if jsonb_typeof(f) is distinct from 'object' or (f-array['path','reason'])<>'{}'::jsonb
      or jsonb_typeof(f->'path') is distinct from 'string' or length(f->>'path') not between 1 and 1000
      or jsonb_typeof(f->'reason') is distinct from 'string' or (f->>'reason') !~ '^[a-z][a-z0-9_]{2,63}$' then
      return false; end if;
  end loop;
  return true;
end $$;
revoke all on function clued_private.storage_dispatch_outcome_valid_v1(jsonb) from public,anon,authenticated,service_role;

-- The dispatch_outcome event is exported (canonical export) to readers with
-- context:read, so it never carries Drive paths: findings stay only in the
-- Owner's job row; the event keeps the code and the number of findings. The
-- receipt still binds the full request through its request hash.
create function clued_private.storage_dispatch_event_summary_v1(p_req jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_req->'outcome'->'reason'->'findings')='array'
    then (p_req #- '{outcome,reason,findings}')
      || jsonb_build_object('outcome',(p_req->'outcome') #- '{reason,findings}'
        || jsonb_build_object('reason',((p_req->'outcome'->'reason') - 'findings')
          || jsonb_build_object('finding_count',jsonb_array_length(p_req->'outcome'->'reason'->'findings'))))
    else p_req end
$$;
revoke all on function clued_private.storage_dispatch_event_summary_v1(jsonb) from public,anon,authenticated,service_role;

-- Anchored patches on the latest definitions (every edit of one function
-- first, then one CREATE OR REPLACE), as in 20260930160000.
do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- The account-policy report branch accepts the optional reason.
    ('clued_private.storage_cloud_worker_v2(text,jsonb)',
     $a$    if p_input->'outcome' not in ('{"status":"denied"}'::jsonb,'{"status":"attention_required"}'::jsonb)
      or p_input->'outcome' is null then raise exception 'storage_cloud_denied' using errcode='42501'; end if;$a$,
     $r$    if not clued_private.storage_dispatch_outcome_valid_v1(p_input->'outcome') then
      raise exception 'storage_cloud_denied' using errcode='42501'; end if;$r$,1),
    -- The event summary never carries finding paths (see storage_dispatch_event_summary_v1).
    ('clued_private.storage_cloud_worker_v2(text,jsonb)',
     $a$'extension:storage:dispatch_outcome',
      refs,'project:'||p.project_id::text,null,req,req->>'idempotency_key',$a$,
     $r$'extension:storage:dispatch_outcome',
      refs,'project:'||p.project_id::text,null,clued_private.storage_dispatch_event_summary_v1(req),req->>'idempotency_key',$r$,1),
    -- Job status carries the fixed code only, and only when one was stored.
    ('clued_private.storage_job_status_v1(clued_private.storage_jobs_v1)',
     $a$    'execution_permitted',false)$a$,
     $r$    'execution_permitted',false)||case when m.id is null and jsonb_typeof(p_job.dispatch_outcome->'reason')='object'
      then jsonb_build_object('reason_code',p_job.dispatch_outcome->'reason'->>'code') else '{}'::jsonb end$r$,1),
    -- Policy transition quietness is decided by the outcome status, not the
    -- exact {status} document, so a stored reason keeps a job terminal.
    ('public.clued_storage_policy_transition_v2(text,jsonb)',
     $a$      and j.intent_id is null and (j.dispatch_outcome is distinct from '{"status":"denied"}'::jsonb
        and j.dispatch_outcome is distinct from '{"status":"attention_required"}'::jsonb)) then$a$,
     $r$      and j.intent_id is null and coalesce(j.dispatch_outcome->>'status','') not in ('denied','attention_required')) then$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_dispatch_reason_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;
