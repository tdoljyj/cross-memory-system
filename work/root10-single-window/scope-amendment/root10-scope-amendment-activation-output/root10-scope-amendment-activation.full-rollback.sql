-- Root10 scope amendment full rollback. One transaction; restores the three event-119 function bodies
-- verbatim and removes event 120 only when nothing was built on it.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s'; set local idle_in_transaction_session_timeout='90s';
do $guard$ declare c clued_control.execution_current;a clued_control.gate_attempts;e clued_control.execution_events;rc clued_control.execution_events;begin
 select * into c from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for update; select * into a from clued_control.gate_attempts where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and ga_id='ga_32daa5daf52c4deb8e893c25b08eff38' for update; select * into e from clued_control.execution_events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence=120; select * into rc from clued_control.execution_events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence=119;
 if c.sequence<>120 or c.active_ga_id<>'ga_32daa5daf52c4deb8e893c25b08eff38' or c.pending_budget_sequence is not null or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987 or a.phase<>'PENDING' or a.sequence<>0 or a.container_id is not null or a.decision is not null or a.receipt_raw is not null or a.revoked or a.ga_sha256<>'68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' or a.budget_sequence<>117 or e.idempotency_key<>'root10_scope_amendment_20260915' or e.request->>'operation'<>'SCOPE_AMENDMENT_ACTIVATED' or e.request->>'ga_id'<>'ga_32daa5daf52c4deb8e893c25b08eff38' or rc.idempotency_key<>'root10_runtime_clock_amendment_20260915' or rc.request->>'operation'<>'RUNTIME_CLOCK_AMENDMENT_ACTIVATED' or rc.request->'body'->>'amendment_sha256'<>'e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402' or exists(select 1 from clued_control.execution_events x where x.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and x.sequence>120) then raise exception 'ROOT10_SCOPE_ROLLBACK_GUARD_FAILED'; end if;
end $guard$;
CREATE OR REPLACE FUNCTION clued_control.effective_execution_binding()
 RETURNS SETOF clued_control.execution_binding
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
  with base as (
    select b, to_jsonb(b) j from clued_control.execution_binding b
  ), latest as (
    select e.request->'body'->'new_binding' j
      from clued_control.execution_events e
     where e.request->>'operation' in
       ('EXECUTION_BINDING_FORWARD_ACCEPTED','EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED','TEMPORAL_CONTINUATION_ACTIVATED','RUNTIME_CLOCK_AMENDMENT_ACTIVATED')
       and jsonb_typeof(e.request->'body'->'new_binding')='object'
       and (e.request->>'operation'<>'TEMPORAL_CONTINUATION_ACTIVATED' or (e.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and e.sequence=118 and e.idempotency_key='root10_same_ga_temporal_continuation_20260915' and (select array_agg(k order by k) from jsonb_object_keys(e.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[] and e.request->>'operation'='TEMPORAL_CONTINUATION_ACTIVATED' and e.request->>'ga_id'='ga_32daa5daf52c4deb8e893c25b08eff38' and e.request->>'idempotency_key'='root10_same_ga_temporal_continuation_20260915' and e.request->'expected_sequence'='117'::jsonb and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body') k)=array['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','effect_deadline','finalization_expires_at','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','prior_ga_sha256']::text[] and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body'->'amendment_ref') k)=array['sha256','uri']::text[] and e.request->'body'->'amendment_ref'='{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/fc0770fc90b90a1fb3bfa167fd3ee75c0db92604","sha256":"38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6"}'::jsonb and e.request->'body'->>'amendment_sha256'='38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6' and e.request->'body'->>'budget_raw_sha256'='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' and e.request->'body'->'budget_sequence'='117'::jsonb and e.request->'body'->>'prior_ga_sha256'='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' and e.request->'body'->'automatic_retry'='false'::jsonb and e.request->'body'->'new_ga'='false'::jsonb and e.request->'body'->'new_budget'='false'::jsonb and e.request->'body'->'budget_refund'='false'::jsonb and e.request->'body'->>'finalization_expires_at'='2026-09-16T03:00:00Z' and (e.request->'body'->>'activated_at')::timestamptz<(e.request->'body'->>'effect_deadline')::timestamptz and (e.request->'body'->>'effect_deadline')::timestamptz-(e.request->'body'->>'activated_at')::timestamptz=interval '600 seconds' and (e.request->'body'->>'effect_deadline')::timestamptz<'2026-09-16T03:00:00Z'::timestamptz and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body'->'old_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and e.request->'body'->'old_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"d01bd55e02614c0d2b6f51f80fe5b56816aecc2f29e753344a4bcac56aaaf559","prior_evidence_bytes":322546611,"qualification_sha256":"3cd157e704660dac18d3e6c5fb790f6854f29d644c66d53b968bf94c07f12143","runtime_acceptance_sha256":"bc6cb688231763f2ad1a56bbc77a22eb7a35cfd749b12e8827f5040582443a88"}'::jsonb and e.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((e.request->'body'->'old_binding')::text,'UTF8')),'hex') and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body'->'new_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and e.request->'body'->'new_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041","prior_evidence_bytes":322546611,"qualification_sha256":"e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405","runtime_acceptance_sha256":"17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42"}'::jsonb and e.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((e.request->'body'->'new_binding')::text,'UTF8')),'hex')))
       and (e.request->>'operation'<>'RUNTIME_CLOCK_AMENDMENT_ACTIVATED' or (e.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and e.sequence=119 and e.idempotency_key='root10_runtime_clock_amendment_20260915' and (select array_agg(k order by k) from jsonb_object_keys(e.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[] and e.request->>'operation'='RUNTIME_CLOCK_AMENDMENT_ACTIVATED' and e.request->>'ga_id'='ga_32daa5daf52c4deb8e893c25b08eff38' and e.request->>'idempotency_key'='root10_runtime_clock_amendment_20260915' and e.request->'expected_sequence'='118'::jsonb and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body') k)=array['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','finalization_expires_at','max_predispatch_resets','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','preparation_expires_at','prior_ga_sha256','runtime_seconds']::text[] and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body'->'amendment_ref') k)=array['sha256','uri']::text[] and e.request->'body'->'amendment_ref'='{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/492b2cc6a13554cf8760195c620bc7ea8b7f05f3","sha256":"e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402"}'::jsonb and e.request->'body'->>'amendment_sha256'='e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402' and e.request->'body'->>'budget_raw_sha256'='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' and e.request->'body'->'budget_sequence'='117'::jsonb and e.request->'body'->>'prior_ga_sha256'='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' and e.request->'body'->'automatic_retry'='false'::jsonb and e.request->'body'->'new_ga'='false'::jsonb and e.request->'body'->'new_budget'='false'::jsonb and e.request->'body'->'budget_refund'='false'::jsonb and e.request->'body'->>'preparation_expires_at'='2026-09-16T03:00:00Z' and e.request->'body'->>'finalization_expires_at'='2026-09-16T03:00:00Z' and e.request->'body'->'runtime_seconds'='600'::jsonb and e.request->'body'->'max_predispatch_resets'='3'::jsonb and (e.request->'body'->>'activated_at')::timestamptz<(e.request->'body'->>'finalization_expires_at')::timestamptz and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body'->'old_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and e.request->'body'->'old_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041","prior_evidence_bytes":322546611,"qualification_sha256":"e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405","runtime_acceptance_sha256":"17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42"}'::jsonb and e.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((e.request->'body'->'old_binding')::text,'UTF8')),'hex') and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body'->'new_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and e.request->'body'->'new_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6","prior_evidence_bytes":322546611,"qualification_sha256":"6a7145fa0c09a00a917b40c42f5dbaa38f4c6028e75ab747dd234351b993b849","runtime_acceptance_sha256":"321221816f4c368d98833de6f698adcb1835d88e6b7c991c0b9d9537abba3c1e"}'::jsonb and e.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((e.request->'body'->'new_binding')::text,'UTF8')),'hex')))
     order by e.sequence desc
     limit 1
  )
  select jsonb_populate_record(null::clued_control.execution_binding,
                               coalesce((select j from latest),base.j))
    from base
$function$;
CREATE OR REPLACE FUNCTION clued_control.execution_transition(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current;
 a clued_control.gate_attempts; previous clued_control.execution_events; intent_event clued_control.execution_events; temporal_event clued_control.execution_events;
 temporal_deadline timestamptz;
 rc_event clued_control.execution_events; rc_active boolean:=false; temporal_active boolean:=false;
 running_event clued_control.execution_events; rc_started text; rc_deadline timestamptz;
 rc_prep timestamptz; rc_final timestamptz; rc_seconds integer; rc_max_resets integer; rc_last_reset bigint; rc_reset_count bigint; rc_overrun boolean; obs jsonb;
 r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb; field_name text;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>131072
 or coalesce(p->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or jsonb_typeof(p->'expected_sequence') is distinct from 'number'
 or coalesce(p->>'expected_sequence','') !~ '^(0|[1-9][0-9]{0,14})$'
 or jsonb_typeof(p->'body') is distinct from 'object' then raise exception 'invalid_transition'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 if not found then raise exception 'execution_binding_missing'; end if;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key=p->>'idempotency_key';
 if found then
  if previous.request is distinct from p then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
 if (p->>'expected_sequence')::bigint<>c.sequence then raise exception 'sequence_conflict'; end if;
 op:=p->>'operation';
 select * into a from clued_control.gate_attempts where root_id=root and ga_id=p->>'ga_id' for update;
 if not found or c.active_ga_id is distinct from a.ga_id then raise exception 'exact_active_attempt_missing'; end if;
 select * into rc_event from clued_control.execution_events e where e.root_id=root and e.sequence=119 and e.request->>'operation'='RUNTIME_CLOCK_AMENDMENT_ACTIVATED' and e.request->>'ga_id'=a.ga_id;
 if found then
  if a.ga_id<>'ga_32daa5daf52c4deb8e893c25b08eff38' or a.ga_sha256<>'68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' or a.budget_sequence<>117 or not (rc_event.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and rc_event.sequence=119 and rc_event.idempotency_key='root10_runtime_clock_amendment_20260915' and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[] and rc_event.request->>'operation'='RUNTIME_CLOCK_AMENDMENT_ACTIVATED' and rc_event.request->>'ga_id'='ga_32daa5daf52c4deb8e893c25b08eff38' and rc_event.request->>'idempotency_key'='root10_runtime_clock_amendment_20260915' and rc_event.request->'expected_sequence'='118'::jsonb and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request->'body') k)=array['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','finalization_expires_at','max_predispatch_resets','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','preparation_expires_at','prior_ga_sha256','runtime_seconds']::text[] and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request->'body'->'amendment_ref') k)=array['sha256','uri']::text[] and rc_event.request->'body'->'amendment_ref'='{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/492b2cc6a13554cf8760195c620bc7ea8b7f05f3","sha256":"e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402"}'::jsonb and rc_event.request->'body'->>'amendment_sha256'='e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402' and rc_event.request->'body'->>'budget_raw_sha256'='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' and rc_event.request->'body'->'budget_sequence'='117'::jsonb and rc_event.request->'body'->>'prior_ga_sha256'='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' and rc_event.request->'body'->'automatic_retry'='false'::jsonb and rc_event.request->'body'->'new_ga'='false'::jsonb and rc_event.request->'body'->'new_budget'='false'::jsonb and rc_event.request->'body'->'budget_refund'='false'::jsonb and rc_event.request->'body'->>'preparation_expires_at'='2026-09-16T03:00:00Z' and rc_event.request->'body'->>'finalization_expires_at'='2026-09-16T03:00:00Z' and rc_event.request->'body'->'runtime_seconds'='600'::jsonb and rc_event.request->'body'->'max_predispatch_resets'='3'::jsonb and (rc_event.request->'body'->>'activated_at')::timestamptz<(rc_event.request->'body'->>'finalization_expires_at')::timestamptz and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request->'body'->'old_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and rc_event.request->'body'->'old_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041","prior_evidence_bytes":322546611,"qualification_sha256":"e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405","runtime_acceptance_sha256":"17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42"}'::jsonb and rc_event.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((rc_event.request->'body'->'old_binding')::text,'UTF8')),'hex') and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request->'body'->'new_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and rc_event.request->'body'->'new_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6","prior_evidence_bytes":322546611,"qualification_sha256":"6a7145fa0c09a00a917b40c42f5dbaa38f4c6028e75ab747dd234351b993b849","runtime_acceptance_sha256":"321221816f4c368d98833de6f698adcb1835d88e6b7c991c0b9d9537abba3c1e"}'::jsonb and rc_event.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((rc_event.request->'body'->'new_binding')::text,'UTF8')),'hex'))
  then raise exception 'invalid_root10_runtime_clock_event'; end if;
  rc_active:=true;
  rc_prep:=(rc_event.request->'body'->>'preparation_expires_at')::timestamptz;
  rc_final:=(rc_event.request->'body'->>'finalization_expires_at')::timestamptz;
  rc_seconds:=600; rc_max_resets:=3;
  rc_last_reset:=coalesce((select max(e.sequence) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='PREDISPATCH_RESET'),0);
  rc_reset_count:=(select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='PREDISPATCH_RESET');
  if clock_timestamp()>=rc_final and op not in ('UNKNOWN','REVOKE','RECONCILED_CONTAINER','STOP_SENT','STOPPED') then raise exception 'root10_runtime_clock_finalization_expired'; end if;
 end if;
 select * into temporal_event from clued_control.execution_events e where e.root_id=root and e.sequence=118 and e.request->>'operation'='TEMPORAL_CONTINUATION_ACTIVATED' and e.request->>'ga_id'=a.ga_id;
 if found then
  if a.ga_id<>'ga_32daa5daf52c4deb8e893c25b08eff38' or a.ga_sha256<>'68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' or a.budget_sequence<>117 or not (temporal_event.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and temporal_event.sequence=118 and temporal_event.idempotency_key='root10_same_ga_temporal_continuation_20260915' and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[] and temporal_event.request->>'operation'='TEMPORAL_CONTINUATION_ACTIVATED' and temporal_event.request->>'ga_id'='ga_32daa5daf52c4deb8e893c25b08eff38' and temporal_event.request->>'idempotency_key'='root10_same_ga_temporal_continuation_20260915' and temporal_event.request->'expected_sequence'='117'::jsonb and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body') k)=array['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','effect_deadline','finalization_expires_at','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','prior_ga_sha256']::text[] and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'amendment_ref') k)=array['sha256','uri']::text[] and temporal_event.request->'body'->'amendment_ref'='{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/fc0770fc90b90a1fb3bfa167fd3ee75c0db92604","sha256":"38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6"}'::jsonb and temporal_event.request->'body'->>'amendment_sha256'='38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6' and temporal_event.request->'body'->>'budget_raw_sha256'='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' and temporal_event.request->'body'->'budget_sequence'='117'::jsonb and temporal_event.request->'body'->>'prior_ga_sha256'='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' and temporal_event.request->'body'->'automatic_retry'='false'::jsonb and temporal_event.request->'body'->'new_ga'='false'::jsonb and temporal_event.request->'body'->'new_budget'='false'::jsonb and temporal_event.request->'body'->'budget_refund'='false'::jsonb and temporal_event.request->'body'->>'finalization_expires_at'='2026-09-16T03:00:00Z' and (temporal_event.request->'body'->>'activated_at')::timestamptz<(temporal_event.request->'body'->>'effect_deadline')::timestamptz and (temporal_event.request->'body'->>'effect_deadline')::timestamptz-(temporal_event.request->'body'->>'activated_at')::timestamptz=interval '600 seconds' and (temporal_event.request->'body'->>'effect_deadline')::timestamptz<'2026-09-16T03:00:00Z'::timestamptz and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'old_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and temporal_event.request->'body'->'old_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"d01bd55e02614c0d2b6f51f80fe5b56816aecc2f29e753344a4bcac56aaaf559","prior_evidence_bytes":322546611,"qualification_sha256":"3cd157e704660dac18d3e6c5fb790f6854f29d644c66d53b968bf94c07f12143","runtime_acceptance_sha256":"bc6cb688231763f2ad1a56bbc77a22eb7a35cfd749b12e8827f5040582443a88"}'::jsonb and temporal_event.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((temporal_event.request->'body'->'old_binding')::text,'UTF8')),'hex') and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'new_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and temporal_event.request->'body'->'new_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041","prior_evidence_bytes":322546611,"qualification_sha256":"e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405","runtime_acceptance_sha256":"17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42"}'::jsonb and temporal_event.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((temporal_event.request->'body'->'new_binding')::text,'UTF8')),'hex')) or temporal_event.request->>'idempotency_key'<>'root10_same_ga_temporal_continuation_20260915'
  or temporal_event.request->'body'->>'amendment_sha256'<>'38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6' or temporal_event.request->'body'->'amendment_ref'->>'sha256'<>'38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6'
  or temporal_event.request->'body'->>'budget_raw_sha256'<>'669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' or temporal_event.request->'body'->>'prior_ga_sha256'<>a.ga_sha256
  or temporal_event.request->'body'->'automatic_retry'<>'false'::jsonb or temporal_event.request->'body'->'new_ga'<>'false'::jsonb or temporal_event.request->'body'->'new_budget'<>'false'::jsonb or temporal_event.request->'body'->'budget_refund'<>'false'::jsonb
  or temporal_event.request->'body'->>'finalization_expires_at'<>'2026-09-16T03:00:00Z'
  or (temporal_event.request->'body'->>'effect_deadline')::timestamptz-(temporal_event.request->'body'->>'activated_at')::timestamptz<>interval '600 seconds'
  then raise exception 'invalid_root10_temporal_continuation_event'; end if;
  temporal_active:=true;
  if not rc_active then
   temporal_deadline:=(temporal_event.request->'body'->>'effect_deadline')::timestamptz;
   if clock_timestamp()>=(temporal_event.request->'body'->>'finalization_expires_at')::timestamptz and op not in ('UNKNOWN','REVOKE','RECONCILED_CONTAINER') then raise exception 'root10_temporal_finalization_expired'; end if;
  else
   temporal_deadline:=null;
  end if;
 end if;
 if op='INTENT_RECORDED' then
  if not ((a.phase='PENDING' and p->'body'->>'operation'='CREATE') or (a.phase='CREATED' and p->'body'->>'operation'='START'))
  then raise exception 'intent_phase_conflict'; end if;
  evidence_raw:=p->'body'->>'raw';
  if jsonb_typeof(p->'body'->'raw') is distinct from 'string' or not (evidence_raw is json object with unique keys)
  or p->'body'->>'sha256' is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex') then raise exception 'exact_intent_bytes_required'; end if;
  evidence_json:=evidence_raw::jsonb;
  if evidence_json->>'ga_sha256' is distinct from a.ga_sha256 or evidence_json->>'ga_id' is distinct from a.ga_id
  or evidence_json->>'operation' is distinct from p->'body'->>'operation' then raise exception 'intent_binding_mismatch'; end if;
  if exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id
   and e.request->>'operation'='INTENT_RECORDED' and e.request->'body'->>'operation'=p->'body'->>'operation'
   and (not rc_active or e.sequence>rc_last_reset))
  then raise exception 'one_immutable_intent_per_effect'; end if;
  next_phase:=a.phase;
 elsif op in ('CREATE_SENT','START_SENT') then
  r:=clued_control.read_root(root);
  if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or a.revoked or clock_timestamp()>=(case when rc_active then rc_prep else coalesce(temporal_deadline,a.expires_at) end)
  or a.ga->>'control_trust_root_generation' is distinct from r->>'generation_id'
  or a.ga->>'runner_generation' is distinct from c.runner_generation
  or a.ga->>'credential_generation' is distinct from c.credential_generation
  or a.ga->>'session_generation' is distinct from c.session_generation then raise exception 'current_authority_or_generation_changed'; end if;
  if not ((op='CREATE_SENT' and a.phase='PENDING') or (op='START_SENT' and a.phase='CREATED')) then raise exception 'phase_conflict'; end if;
  if coalesce(p->'body'->>'intent_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'durable_intent_binding_missing'; end if;
  if jsonb_typeof(p->'body'->'intent_sequence') is distinct from 'number'
  or coalesce(p->'body'->>'intent_sequence','') !~ '^[1-9][0-9]{0,14}$' then raise exception 'committed_intent_sequence_required'; end if;
  select * into intent_event from clued_control.execution_events where root_id=root and sequence=(p->'body'->>'intent_sequence')::bigint;
  if not found or intent_event.recording_transaction_id=pg_current_xact_id()
  or intent_event.request->>'operation' is distinct from 'INTENT_RECORDED'
  or intent_event.request->>'ga_id' is distinct from a.ga_id
  or intent_event.request->'body'->>'operation' is distinct from replace(op,'_SENT','')
  or intent_event.request->'body'->>'sha256' is distinct from p->'body'->>'intent_sha256'
  or (rc_active and intent_event.sequence<=rc_last_reset)
  then raise exception 'exact_prior_committed_intent_required'; end if;
  next_phase:=op;
 elsif op='CREATED' then
  if a.phase<>'CREATE_SENT' or coalesce(p->'body'->>'container_id','') !~ '^[0-9a-f]{64}$' then raise exception 'exact_container_missing'; end if;
  update clued_control.gate_attempts set container_id=p->'body'->>'container_id' where root_id=root and ga_id=a.ga_id;
  next_phase:='CREATED';
 elsif op='RECONCILED_CONTAINER' then
  if a.phase<>'UNKNOWN' or a.container_id is not null
  or coalesce(p->'body'->>'container_id','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'observation_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'exact_unknown_reconciliation_required'; end if;
  update clued_control.gate_attempts set container_id=p->'body'->>'container_id' where root_id=root and ga_id=a.ga_id;
  next_phase:='UNKNOWN'; -- Discovery permits cleanup, never a replacement START.
 elsif op='RUNNING' then
  if a.phase<>'START_SENT' or p->'body'->>'container_id' is distinct from a.container_id then raise exception 'phase_or_container_conflict'; end if;
  if rc_active and exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='RUNNING') then raise exception 'one_runtime_interval_only'; end if;
  next_phase:='RUNNING';
 elsif op='STOP_SENT' then
  if a.container_id is null or (not rc_active and temporal_active and clock_timestamp()>=temporal_deadline) or p->'body'->>'container_id' is distinct from a.container_id then raise exception 'exact_container_missing'; end if;
  next_phase:='STOP_SENT';
 elsif op='STOPPED' then
  if a.phase<>'STOP_SENT' or p->'body'->>'container_id' is distinct from a.container_id
  or coalesce(p->'body'->>'observation_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'stopped_observation_missing'; end if;
  next_phase:='STOPPED';
 elsif op in ('UNKNOWN','REVOKE') then
  next_phase:='UNKNOWN';
  if op='REVOKE' then update clued_control.gate_attempts set revoked=true where root_id=root and ga_id=a.ga_id;end if;
 elsif op='PREDISPATCH_RESET' then
  if not rc_active then raise exception 'runtime_clock_amendment_required'; end if;
  if clock_timestamp()>=rc_prep then raise exception 'predispatch_reset_window_expired'; end if;
  if a.phase not in ('PENDING','CREATE_SENT','CREATED','START_SENT')
  or exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='RUNNING')
  then raise exception 'predispatch_reset_phase_conflict'; end if;
  if rc_reset_count>=rc_max_resets then raise exception 'max_predispatch_resets_exhausted'; end if;
  if jsonb_typeof(p->'body'->'reason') is distinct from 'string' or length(p->'body'->>'reason') not between 1 and 200
  or p->'body'->'automatic_retry' is distinct from 'false'::jsonb then raise exception 'exact_reset_declaration_required'; end if;
  if a.container_id is not null then
   evidence_raw:=p->'body'->>'raw';
   if jsonb_typeof(p->'body'->'raw') is distinct from 'string' or not (evidence_raw is json object with unique keys)
   or p->'body'->>'sha256' is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex') then raise exception 'exact_reset_evidence_bytes_required'; end if;
   evidence_json:=evidence_raw::jsonb;
   if evidence_json->>'ga_id' is distinct from a.ga_id or evidence_json->>'ga_sha256' is distinct from a.ga_sha256
   or evidence_json->>'operation' is distinct from 'PREDISPATCH_RESET' or evidence_json->>'container_id' is distinct from a.container_id
   or jsonb_typeof(evidence_json->'observation') is distinct from 'object'
   or evidence_json->'observation'->>'Id' is distinct from a.container_id
   or evidence_json->'observation'->'State'->'Running' is distinct from 'false'::jsonb
   or evidence_json->'observation'->'State'->>'StartedAt' is distinct from '0001-01-01T00:00:00Z'
   then raise exception 'zero_effect_reset_observation_required'; end if;
   update clued_control.gate_attempts set container_id=null where root_id=root and ga_id=a.ga_id;
  end if;
  next_phase:='PENDING'; -- Never touches charged counters, decision, receipt or budgets.
 elsif op='DECISION_RESERVED' then
  if not (
    a.phase='STOPPED'
    or (
      a.phase='PENDING'
      and clock_timestamp()>=a.expires_at
      and a.container_id is null
      and p->'body'->>'result'='STALE'
      and not exists(
        select 1 from clued_control.execution_events e
        where e.root_id=root and e.request->>'ga_id'=a.ga_id
      )
    )
    or (
      rc_active
      and a.phase='PENDING'
      and a.container_id is null
      and not exists(
        select 1 from clued_control.execution_events e
        where e.root_id=root and e.request->>'ga_id'=a.ga_id
        and e.request->>'operation' in ('RUNNING','CREATED')
      )
      and p->'body'->>'result'='STALE'
    )
  ) or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;
  if rc_active and p->'body'->>'result'='PASS' and exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='STOPPED' and e.request->'body'->'overrun'='true'::jsonb) then raise exception 'overrun_run_cannot_pass'; end if;
  foreach field_name in array array['decision','evidence_index'] loop
   evidence_raw:=p->'body'->>(field_name||'_raw');
   if jsonb_typeof(p->'body'->(field_name||'_raw')) is distinct from 'string'
   or not(evidence_raw is json object with unique keys)
   or p->'body'->>(field_name||'_sha256') is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex')
   then raise exception 'complete_reserved_evidence_bytes_required'; end if;
   evidence_json:=evidence_raw::jsonb;
   if evidence_json->>'ga_id' is distinct from a.ga_id or evidence_json->>'ga_sha256' is distinct from a.ga_sha256
   then raise exception 'reserved_evidence_ga_mismatch'; end if;
   if field_name='decision' and (evidence_json->>'result' is distinct from p->'body'->>'result'
    or coalesce(evidence_json->>'result','') not in ('PASS','FAIL','BLOCKED','STALE'))
   then raise exception 'reserved_decision_result_mismatch'; end if;
  end loop;
  update clued_control.gate_attempts set decision=p->'body' where root_id=root and ga_id=a.ga_id;next_phase:=op;
 elsif op='SIGNING' then
  if a.phase<>'DECISION_RESERVED' or p->'body'->>'decision_sha256' is distinct from a.decision->>'decision_sha256' then raise exception 'signing_reservation_conflict'; end if;next_phase:=op;
 else raise exception 'unsupported_transition'; end if;
 if op in ('CREATED','RUNNING','STOPPED','RECONCILED_CONTAINER') then
  evidence_raw:=p->'body'->>'raw';
  if jsonb_typeof(p->'body'->'raw') is distinct from 'string' or not (evidence_raw is json object with unique keys)
  or p->'body'->>'sha256' is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex') then raise exception 'exact_result_bytes_required'; end if;
  evidence_json:=evidence_raw::jsonb;
  if evidence_json->>'ga_sha256' is distinct from a.ga_sha256 or evidence_json->>'ga_id' is distinct from a.ga_id
  or evidence_json->>'operation' is distinct from op or evidence_json->>'container_id' is distinct from p->'body'->>'container_id'
  or jsonb_typeof(evidence_json->'observation') is distinct from 'object' then raise exception 'result_binding_mismatch'; end if;
  if not rc_active and temporal_active and (coalesce(evidence_json->>'started_utc','') !~ '^\d{4}-\d\d-\d\dT' or coalesce(evidence_json->>'ended_utc','') !~ '^\d{4}-\d\d-\d\dT' or (evidence_json->>'started_utc')::timestamptz<(temporal_event.request->'body'->>'activated_at')::timestamptz or (evidence_json->>'started_utc')::timestamptz>(evidence_json->>'ended_utc')::timestamptz or (evidence_json->>'ended_utc')::timestamptz>temporal_deadline or (op='STOPPED' and (coalesce(evidence_json->'observation'->'State'->>'FinishedAt','') !~ '^\d{4}-\d\d-\d\dT' or (evidence_json->'observation'->'State'->>'FinishedAt')::timestamptz<(temporal_event.request->'body'->>'activated_at')::timestamptz or (evidence_json->'observation'->'State'->>'FinishedAt')::timestamptz>(evidence_json->>'ended_utc')::timestamptz))) then raise exception 'root10_temporal_effect_timestamp_outside_window'; end if;
  if rc_active and op in ('CREATED','RUNNING','STOPPED') and (coalesce(evidence_json->>'started_utc','') !~ '^\d{4}-\d\d-\d\dT' or coalesce(evidence_json->>'ended_utc','') !~ '^\d{4}-\d\d-\d\dT' or (evidence_json->>'started_utc')::timestamptz<(rc_event.request->'body'->>'activated_at')::timestamptz or (evidence_json->>'started_utc')::timestamptz>(evidence_json->>'ended_utc')::timestamptz or (op='STOPPED' and coalesce(evidence_json->'observation'->'State'->>'FinishedAt','') !~ '^\d{4}-\d\d-\d\dT')) then raise exception 'root10_runtime_clock_effect_timestamp_invalid'; end if;
  -- The runtime deadline is anchored to the container's own observed State.StartedAt,
  -- the same anchor the STOPPED overrun rule uses; one second of tolerance absorbs the
  -- nanosecond-vs-millisecond precision gap between Docker and the recording client.
  if rc_active and op='RUNNING' and (jsonb_typeof(p->'body'->'runtime_deadline') is distinct from 'string' or coalesce(p->'body'->>'runtime_deadline','') !~ '^\d{4}-\d\d-\d\dT' or coalesce(evidence_json->'observation'->'State'->>'StartedAt','') !~ '^\d{4}-\d\d-\d\dT' or (p->'body'->>'runtime_deadline')::timestamptz>(evidence_json->'observation'->'State'->>'StartedAt')::timestamptz+make_interval(secs=>rc_seconds) or (p->'body'->>'runtime_deadline')::timestamptz<(evidence_json->'observation'->'State'->>'StartedAt')::timestamptz+make_interval(secs=>rc_seconds)-interval '1 second') then raise exception 'exact_runtime_deadline_binding'; end if;
  if rc_active and op='STOPPED' then
   if (select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='RUNNING')<>1 then raise exception 'exact_single_running_interval_required'; end if;
   select * into running_event from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='RUNNING';
   if running_event.sequence is null or running_event.recording_transaction_id=pg_current_xact_id() then raise exception 'exact_single_running_interval_required'; end if;
   obs:=evidence_json->'observation';
   rc_started:=((running_event.request->'body'->>'raw')::jsonb)->'observation'->'State'->>'StartedAt';
   rc_deadline:=(running_event.request->'body'->>'runtime_deadline')::timestamptz;
   -- The stop report never sets its own clock: the start instant and the
   -- deadline both come from the committed RUNNING event, and the report must
   -- agree with that recorded start.
   if coalesce(rc_started,'') !~ '^\d{4}-\d\d-\d\dT' or rc_deadline is null
   or coalesce(obs->'State'->>'StartedAt','') !~ '^\d{4}-\d\d-\d\dT'
   or (obs->'State'->>'StartedAt')::timestamptz is distinct from rc_started::timestamptz
   or (obs->'State'->>'StartedAt')::timestamptz<(rc_event.request->'body'->>'activated_at')::timestamptz
   or coalesce(obs->'State'->>'FinishedAt','') !~ '^\d{4}-\d\d-\d\dT'
   or (obs->'State'->>'FinishedAt')::timestamptz<(obs->'State'->>'StartedAt')::timestamptz then raise exception 'exact_observed_runtime_interval_required'; end if;
   rc_overrun:=(obs->'State'->>'FinishedAt')::timestamptz>rc_deadline;
   if jsonb_typeof(p->'body'->'overrun') is distinct from 'boolean' or (p->'body'->'overrun')::text::boolean is distinct from rc_overrun then raise exception 'exact_overrun_disclosure_required'; end if;
  end if;
 end if;
 -- UNKNOWN never releases the active slot, even after expiry or root revocation.
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values(root,c.sequence+1,p->>'idempotency_key',p);
 update clued_control.execution_current set sequence=c.sequence+1 where root_id=root;
 update clued_control.gate_attempts set phase=next_phase,sequence=sequence+1 where root_id=root and ga_id=a.ga_id;
 return jsonb_build_object('status','RECORDED','phase',next_phase,'sequence',c.sequence+1,
  'prior_committed_intent_readback',case when intent_event.sequence is null then null else to_jsonb(intent_event) end,
  'current_context',clued_control.read_execution()||jsonb_build_object('observed_at',clock_timestamp()),'authority_effect','NONE');
end $function$;
CREATE OR REPLACE FUNCTION clued_control.commit_gate_result(p_raw text, p_sha text, p_decision_sha text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current;
 a clued_control.gate_attempts; receipt jsonb; r jsonb; final_result text; temporal_event clued_control.execution_events;
 temporal_deadline timestamptz; temporal_finalization timestamptz;
 rc_event clued_control.execution_events; rc_final timestamptz;
begin
 if p_raw is null or octet_length(p_raw)>131072 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'invalid_exact_receipt_bytes'; end if;
 if not (p_raw is json object with unique keys) then raise exception 'invalid_unique_receipt_object'; end if;
 receipt:=p_raw::jsonb;final_result:=receipt->>'result';
 if jsonb_typeof(receipt)<>'object' or coalesce(receipt->>'gate_result_receipt_id','') !~ '^grr_[A-Za-z0-9_.-]{1,128}$'
 or final_result is null or final_result not in ('PASS','FAIL','BLOCKED','STALE') then raise exception 'invalid_original_grr_result'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into a from clued_control.gate_attempts where root_id=root and ga_id=receipt->>'gate_authorization_id' for update;
 if a.ga_id is null then raise exception 'original_ga_missing'; end if;
 select * into rc_event from clued_control.execution_events e where e.root_id=root and e.sequence=119 and e.request->>'operation'='RUNTIME_CLOCK_AMENDMENT_ACTIVATED' and e.request->>'ga_id'=a.ga_id;
 if found then if not (rc_event.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and rc_event.sequence=119 and rc_event.idempotency_key='root10_runtime_clock_amendment_20260915' and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[] and rc_event.request->>'operation'='RUNTIME_CLOCK_AMENDMENT_ACTIVATED' and rc_event.request->>'ga_id'='ga_32daa5daf52c4deb8e893c25b08eff38' and rc_event.request->>'idempotency_key'='root10_runtime_clock_amendment_20260915' and rc_event.request->'expected_sequence'='118'::jsonb and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request->'body') k)=array['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','finalization_expires_at','max_predispatch_resets','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','preparation_expires_at','prior_ga_sha256','runtime_seconds']::text[] and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request->'body'->'amendment_ref') k)=array['sha256','uri']::text[] and rc_event.request->'body'->'amendment_ref'='{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/492b2cc6a13554cf8760195c620bc7ea8b7f05f3","sha256":"e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402"}'::jsonb and rc_event.request->'body'->>'amendment_sha256'='e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402' and rc_event.request->'body'->>'budget_raw_sha256'='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' and rc_event.request->'body'->'budget_sequence'='117'::jsonb and rc_event.request->'body'->>'prior_ga_sha256'='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' and rc_event.request->'body'->'automatic_retry'='false'::jsonb and rc_event.request->'body'->'new_ga'='false'::jsonb and rc_event.request->'body'->'new_budget'='false'::jsonb and rc_event.request->'body'->'budget_refund'='false'::jsonb and rc_event.request->'body'->>'preparation_expires_at'='2026-09-16T03:00:00Z' and rc_event.request->'body'->>'finalization_expires_at'='2026-09-16T03:00:00Z' and rc_event.request->'body'->'runtime_seconds'='600'::jsonb and rc_event.request->'body'->'max_predispatch_resets'='3'::jsonb and (rc_event.request->'body'->>'activated_at')::timestamptz<(rc_event.request->'body'->>'finalization_expires_at')::timestamptz and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request->'body'->'old_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and rc_event.request->'body'->'old_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041","prior_evidence_bytes":322546611,"qualification_sha256":"e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405","runtime_acceptance_sha256":"17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42"}'::jsonb and rc_event.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((rc_event.request->'body'->'old_binding')::text,'UTF8')),'hex') and (select array_agg(k order by k) from jsonb_object_keys(rc_event.request->'body'->'new_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and rc_event.request->'body'->'new_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6","prior_evidence_bytes":322546611,"qualification_sha256":"6a7145fa0c09a00a917b40c42f5dbaa38f4c6028e75ab747dd234351b993b849","runtime_acceptance_sha256":"321221816f4c368d98833de6f698adcb1835d88e6b7c991c0b9d9537abba3c1e"}'::jsonb and rc_event.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((rc_event.request->'body'->'new_binding')::text,'UTF8')),'hex')) then raise exception 'invalid_root10_runtime_clock_event'; end if; rc_final:=(rc_event.request->'body'->>'finalization_expires_at')::timestamptz; if clock_timestamp()>=rc_final then raise exception 'root10_runtime_clock_finalization_expired'; end if; end if;
 select * into temporal_event from clued_control.execution_events e where e.root_id=root and e.sequence=118 and e.request->>'operation'='TEMPORAL_CONTINUATION_ACTIVATED' and e.request->>'ga_id'=a.ga_id;
 if found then if not (temporal_event.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and temporal_event.sequence=118 and temporal_event.idempotency_key='root10_same_ga_temporal_continuation_20260915' and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[] and temporal_event.request->>'operation'='TEMPORAL_CONTINUATION_ACTIVATED' and temporal_event.request->>'ga_id'='ga_32daa5daf52c4deb8e893c25b08eff38' and temporal_event.request->>'idempotency_key'='root10_same_ga_temporal_continuation_20260915' and temporal_event.request->'expected_sequence'='117'::jsonb and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body') k)=array['activated_at','amendment_ref','amendment_sha256','automatic_retry','budget_raw_sha256','budget_refund','budget_sequence','effect_deadline','finalization_expires_at','new_binding','new_binding_sha256','new_budget','new_ga','old_binding','old_binding_sha256','prior_ga_sha256']::text[] and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'amendment_ref') k)=array['sha256','uri']::text[] and temporal_event.request->'body'->'amendment_ref'='{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/fc0770fc90b90a1fb3bfa167fd3ee75c0db92604","sha256":"38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6"}'::jsonb and temporal_event.request->'body'->>'amendment_sha256'='38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6' and temporal_event.request->'body'->>'budget_raw_sha256'='669d96057a44ed5e9c3eae9fed6ed8720aae8a2b48eef03761b8e9361433a462' and temporal_event.request->'body'->'budget_sequence'='117'::jsonb and temporal_event.request->'body'->>'prior_ga_sha256'='68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78' and temporal_event.request->'body'->'automatic_retry'='false'::jsonb and temporal_event.request->'body'->'new_ga'='false'::jsonb and temporal_event.request->'body'->'new_budget'='false'::jsonb and temporal_event.request->'body'->'budget_refund'='false'::jsonb and temporal_event.request->'body'->>'finalization_expires_at'='2026-09-16T03:00:00Z' and (temporal_event.request->'body'->>'activated_at')::timestamptz<(temporal_event.request->'body'->>'effect_deadline')::timestamptz and (temporal_event.request->'body'->>'effect_deadline')::timestamptz-(temporal_event.request->'body'->>'activated_at')::timestamptz=interval '600 seconds' and (temporal_event.request->'body'->>'effect_deadline')::timestamptz<'2026-09-16T03:00:00Z'::timestamptz and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'old_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and temporal_event.request->'body'->'old_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"d01bd55e02614c0d2b6f51f80fe5b56816aecc2f29e753344a4bcac56aaaf559","prior_evidence_bytes":322546611,"qualification_sha256":"3cd157e704660dac18d3e6c5fb790f6854f29d644c66d53b968bf94c07f12143","runtime_acceptance_sha256":"bc6cb688231763f2ad1a56bbc77a22eb7a35cfd749b12e8827f5040582443a88"}'::jsonb and temporal_event.request->'body'->>'old_binding_sha256'=encode(sha256(convert_to((temporal_event.request->'body'->'old_binding')::text,'UTF8')),'hex') and (select array_agg(k order by k) from jsonb_object_keys(temporal_event.request->'body'->'new_binding') k)=array['controller_sha256','gate_id','gate_sha256','gate_version','prior_evidence_bytes','prior_seconds','profile_sha256','qualification_sha256','root_id','runtime_acceptance_sha256','scope_sha256']::text[] and temporal_event.request->'body'->'new_binding'='{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"aca4db237a7572426fdf43c384abcc7fd945e5d0554b8a3b01a71959c2102041","prior_evidence_bytes":322546611,"qualification_sha256":"e3ded3a817082660fce7edc6e5a1964327cb7e7af413d15d49ce155298788405","runtime_acceptance_sha256":"17a5d20b7e6236cb276c7321955f6d0a5e5f83d9a35e83a570fcef251d59af42"}'::jsonb and temporal_event.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((temporal_event.request->'body'->'new_binding')::text,'UTF8')),'hex')) then raise exception 'invalid_root10_temporal_continuation_event'; end if; if rc_event.sequence is distinct from 119 then temporal_deadline:=(temporal_event.request->'body'->>'effect_deadline')::timestamptz; temporal_finalization:=(temporal_event.request->'body'->>'finalization_expires_at')::timestamptz; if clock_timestamp()>=temporal_finalization then raise exception 'root10_temporal_finalization_expired'; end if; end if; end if;
 if a.receipt_raw is not null then
  if a.receipt_raw is distinct from p_raw or a.receipt_sha256 is distinct from p_sha or a.decision->>'decision_sha256' is distinct from p_decision_sha
  then raise exception 'one_ga_one_immutable_grr'; end if;
  return jsonb_build_object('status','DUPLICATE','receipt_sha256',a.receipt_sha256,'authority_effect','NONE');
 end if;
 if c.active_ga_id is distinct from a.ga_id or a.phase<>'SIGNING' or a.decision->>'decision_sha256' is distinct from p_decision_sha
 or a.decision->>'result' is distinct from final_result then raise exception 'exact_decision_reservation_required'; end if;
 if coalesce(receipt->>'schema_digest','') !~ '^[0-9a-f]{64}$' or receipt->>'issuer_purpose' is distinct from 'GATE_RESULT'
 or coalesce(receipt->>'audience','')='' or jsonb_typeof(receipt->'signature') is distinct from 'string'
 or coalesce(receipt->>'signature','')=''
 then raise exception 'signed_receipt_envelope_required'; end if;
 -- The existing trusted host must verify this exact signed payload, issuer and
 -- stopped evidence BEFORE calling. JSON shape/storage is not cryptography.
 r:=clued_control.read_root(root);
 if final_result='PASS' and (a.revoked or (case when coalesce(rc_event.sequence=119,false) then ((select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='STOPPED' and (e.request->'body'->>'raw') is json object with unique keys and e.request->'body'->>'sha256'=encode(sha256(convert_to(e.request->'body'->>'raw','UTF8')),'hex') and e.request->'body'->'overrun'='false'::jsonb and exists(select 1 from clued_control.execution_events run where run.root_id=root and run.request->>'ga_id'=a.ga_id and run.request->>'operation'='RUNNING' and ((e.request->'body'->>'raw')::jsonb->'observation'->'State'->>'StartedAt')::timestamptz=((run.request->'body'->>'raw')::jsonb->'observation'->'State'->>'StartedAt')::timestamptz and ((e.request->'body'->>'raw')::jsonb->'observation'->'State'->>'FinishedAt')::timestamptz<=(run.request->'body'->>'runtime_deadline')::timestamptz))<>1 or (select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='RUNNING')<>1) when temporal_event.sequence is null then clock_timestamp()>=a.expires_at else (select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='STOPPED' and e.recorded_at<temporal_finalization and (e.request->'body'->>'raw') is json object with unique keys and e.request->'body'->>'sha256'=encode(sha256(convert_to(e.request->'body'->>'raw','UTF8')),'hex') and ((e.request->'body'->>'raw')::jsonb->>'ended_utc')::timestamptz<=temporal_deadline and ((e.request->'body'->>'raw')::jsonb->'observation'->'State'->>'FinishedAt')::timestamptz<=temporal_deadline)<>1 end) or r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY'
 or a.ga->>'control_trust_root_generation' is distinct from r->>'generation_id'
 or a.ga->>'runner_generation' is distinct from c.runner_generation or a.ga->>'credential_generation' is distinct from c.credential_generation
 or a.ga->>'session_generation' is distinct from c.session_generation) then raise exception 'stale_or_revoked_pass_forbidden'; end if;
 update clued_control.gate_attempts set receipt_id=receipt->>'gate_result_receipt_id',receipt_raw=p_raw,receipt_sha256=p_sha,phase=final_result where root_id=root and ga_id=a.ga_id;
 update clued_control.execution_current set active_ga_id=null where root_id=root;
 return jsonb_build_object('status','COMMITTED','receipt_sha256',p_sha,'result',final_result,'authority_effect','NONE');
end $function$;
do $undo$ declare b clued_control.execution_binding;begin
 delete from clued_control.execution_events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence=120 and idempotency_key='root10_scope_amendment_20260915' and request->>'operation'='SCOPE_AMENDMENT_ACTIVATED'; if not found then raise exception 'ROOT10_SCOPE_ROLLBACK_EVENT_MISSING'; end if;
 update clued_control.execution_current set sequence=119 where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence=120 and active_ga_id='ga_32daa5daf52c4deb8e893c25b08eff38'; if not found then raise exception 'ROOT10_SCOPE_ROLLBACK_CAS_FAILED'; end if;
 select * into b from clued_control.effective_execution_binding(); if to_jsonb(b)<>'{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a","gate_version":"fixed-synthetic-20260910.v10-env-order-repair","scope_sha256":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6","prior_evidence_bytes":322546611,"qualification_sha256":"6a7145fa0c09a00a917b40c42f5dbaa38f4c6028e75ab747dd234351b993b849","runtime_acceptance_sha256":"321221816f4c368d98833de6f698adcb1835d88e6b7c991c0b9d9537abba3c1e"}'::jsonb or encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex')<>'635c067dadb5c59f3d6de79c65bf537909fc31fe9f0c04ca680f7a606af4fb54' or encode(sha256(convert_to(pg_get_functiondef('clued_control.execution_transition(jsonb)'::regprocedure),'UTF8')),'hex')<>'b75f7aae6a15b27299d6f73e8ec2406daf0f2d94387aec302b7ac777fbe465e4' or encode(sha256(convert_to(pg_get_functiondef('clued_control.commit_gate_result(text,text,text)'::regprocedure),'UTF8')),'hex')<>'22701cb22ce1c520e0761b0a1f04de0f7c9833636b291c1dd44d13f467858a40' then raise exception 'ROOT10_SCOPE_ROLLBACK_POSTIMAGE_DRIFT'; end if;
end $undo$;
commit;
