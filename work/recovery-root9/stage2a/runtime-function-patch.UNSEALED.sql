-- CANDIDATE ONLY / UNSEALED / DO NOT APPLY.
-- Narrow Root9 exact-history branch for the two existing bounded-series admission functions.
-- Generated only from read-only captured live definitions with source SHA checks.
begin;
do $unsealed$ begin
  raise exception 'ROOT9_RUNTIME_FUNCTION_PATCH_UNSEALED_DO_NOT_APPLY';
end $unsealed$;

CREATE OR REPLACE FUNCTION clued_control.reserve_execution_budget(p_raw text, p_sha text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding; w record;
 c clued_control.execution_current; previous clued_control.execution_events; r jsonb; v jsonb; next_sequence bigint; ref jsonb;
begin
 if p_raw is null or octet_length(p_raw)>16384 or not(p_raw is json object with unique keys)
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'exact_budget_bytes_required'; end if;
 v:=p_raw::jsonb;
 if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from
 array['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation']::text[]
 or jsonb_typeof(v->'idempotency_key') is distinct from 'string'
 or coalesce(v->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or v->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION' or v->>'environment' is distinct from 'ISOLATED_TEST'
 or v->'seconds' is distinct from '600'::jsonb or v->'evidence_bytes' is distinct from '134217728'::jsonb
 then raise exception 'fixed_budget_scope_required'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into b from clued_control.effective_execution_binding(); select * into w from clued_control.effective_execution_window() where root_id=root;
 if b.root_id is null or c.root_id is null then raise exception 'accepted_execution_binding_missing'; end if;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key=v->>'idempotency_key';
 if found then
  if previous.request->>'operation' is distinct from 'BUDGET_RESERVED' or previous.request->'body'->>'raw' is distinct from p_raw
  or previous.request->'body'->>'sha256' is distinct from p_sha then raise exception 'budget_idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
-- Inline LOCAL CANDIDATE. Caller already holds current_head SHARE then execution_current UPDATE.
-- BUDGET is generator-fixed BUDGET or GATE, never a request parameter.
declare
 series_view jsonb; series_events jsonb; series_attempts jsonb; series_old jsonb;
 series_e jsonb; series_a jsonb; series_receipt jsonb; series_budget jsonb; series_ga jsonb;
 series_n integer; series_f integer; series_count integer; series_latest bigint;
 series_root9 boolean;
begin
 series_view := clued_control.read_execution();
 series_events := series_view->'events'; series_attempts := series_view->'attempts';
 if jsonb_typeof(series_events) is distinct from 'array' or jsonb_typeof(series_attempts) is distinct from 'array'
 or series_view->'current' is distinct from to_jsonb(c)
 or series_view->'root'->>'generation_id' is distinct from w.generation_id
 or series_view->'root'->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY'
 or w.expires_at is null
 then raise exception 'series_current_root_window_mismatch'; end if;
 series_root9 := w.is_successor
  and w.generation_id='ctrgen_308a1dfc185cff633892638581e0a34c'
  and series_view->'root'->>'generation_id'='ctrgen_308a1dfc185cff633892638581e0a34c';
 if encode(sha256(convert_to((select jsonb_agg(e order by (e->>'sequence')::bigint) from jsonb_array_elements(series_view->'root'->'events') e where (e->>'sequence')::bigint<=6)::text,'UTF8')),'hex') is distinct from 'd34490fc17bf86e062fe28c1164193c735a49550d904e9ff2cd6b7167f766f43'
 then raise exception 'series_full_original_root_changed'; end if;
 if jsonb_array_length(series_view->'root'->'events') is distinct from
      (case when series_root9 then 9 when w.is_successor then 8 else 7 end)
 then raise exception 'series_full_original_root_changed'; end if;
 if series_root9 then
  if series_view->'root'->>'sequence' is distinct from '9'
  or series_view->'root'->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY'
  or series_view->'root'->>'metadata_binding_sha256' is distinct from w.binding_digest
  or encode(sha256(convert_to((select jsonb_agg(e order by (e->>'sequence')::bigint)
       from jsonb_array_elements(series_view->'root'->'events') e
       where (e->>'sequence')::bigint<=8)::text,'UTF8')),'hex')
       is distinct from '48be880b2a66a396b388fce96e2429de9ce7394449b9cf21ff2250e299ad2e21'
  or not exists(
       select 1 from jsonb_array_elements(series_view->'root'->'events') e
       where (e->>'sequence')::bigint=9
       and e->'request'->>'kind'='GENERATION_REGISTERED'
       and e->'request'->>'root_set_id'='ctr_414bd3c724264a83894b0c55cf2ab878'
       and e->'request'->>'expected_sequence'='8'
       and e->'request'->>'generation_id'='ctrgen_308a1dfc185cff633892638581e0a34c'
       and e->'request'->>'predecessor_generation_id'='ctrgen_b060bc520329398936e461af6a477f94'
       and e->'request'->>'idempotency_key'='root9_successor_atomic_install_v1_root'
       and e->'request'->>'metadata_binding_sha256'='5a43eb7f5afe213c83a829599e2c69de4d58365a7b8124f3ccb335b7601654a0'
       and e->'request'->'body'->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c'
       and e->'request'->'body'->>'object_type'='ControlTrustRootSet'
       and e->'request'->'body'->'predecessor'->>'generation_id'='ctrgen_b060bc520329398936e461af6a477f94'
       and e->'request'->'body'->'predecessor'->>'sha256'='cafe4ed82c21cc3fc4a9e009afe6a29017be6834f60150d81f3c77d6897dd0ce'
       and e->'request'->'body'->'history'->>'prefix_sequence'='8'
       and e->'request'->'body'->'history'->>'prefix_digest'='bf0660f3afe7de7e9506e642fdf7ecd15b61de97775b62c3a7d6e5c98f0b1a75')
  then raise exception 'series_full_original_root_changed'; end if;
 else
 if encode(sha256(convert_to(((((series_view->'root') - 'events')) || jsonb_build_object('registration_event',(select e - 'recorded_at' from jsonb_array_elements(series_view->'root'->'events') e where (e->>'sequence')::bigint=7)))::text,'UTF8')),'hex') is distinct from 'ae0575bdf6dc13d22814fe632221ac6cfb2b91e17f48bffa23c8454043d4abb7'
 then raise exception 'series_full_original_root_changed'; end if;
 end if;
 if jsonb_array_length(series_events)<>c.sequence or c.sequence<44
 or exists(select 1 from jsonb_array_elements(series_events) with ordinality t(e,n) where e->>'root_id' is distinct from root or (e->>'sequence')::bigint is distinct from n)
 then raise exception 'series_complete_contiguous_history_required'; end if;
 select jsonb_agg(e order by n) into series_old from jsonb_array_elements(series_events) with ordinality t(e,n) where n<=44;
 if encode(sha256(convert_to(series_old::text,'UTF8')),'hex') is distinct from '7f28f748c5ca671b9813232aebcd131c0ba1713469d530f1548c423505951bc2'
 then raise exception 'series_original_44_events_changed'; end if;
 select jsonb_agg(a order by a->>'ga_id') into series_old from jsonb_array_elements(series_attempts) a where a->>'ga_id'=any(ARRAY['ga_165dc2e72b62414a8023e726d8114f28','ga_18ce0e28e92f448c967fae1c92de7100','ga_6de636122e9c4fb782c0dc12fd223a9b','ga_87882f42d0b4460f8430d73239386c35','ga_a7a420f7de4a4037b9dcb5cd7dae796e','ga_c5041817c641487f827cc4ed5e0fc9ad']::text[]);
 if encode(sha256(convert_to(series_old::text,'UTF8')),'hex') is distinct from 'b5ed3460a9447b8240155129c8901a1a3ec78c6ac980ed8c4fa3e4eb0997116c'
 then raise exception 'series_original_six_attempts_changed'; end if;
 select count(*),max((e->>'sequence')::bigint) into series_n,series_latest from jsonb_array_elements(series_events) e where (e->>'sequence')::bigint>44 and e->'request'->>'operation'='BUDGET_RESERVED';
 select count(*) into series_f from jsonb_array_elements(series_events) e where (e->>'sequence')::bigint>44 and e->'request'->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED';
 if series_n>10 or series_f>19 or c.charged_seconds is distinct from 5106+600*series_n
 or c.charged_evidence_bytes is distinct from 1127852979::bigint+134217728::bigint*series_n
 or c.charged_seconds>11106 or c.charged_evidence_bytes>2470030259
 then raise exception 'series_exact_charges_or_count_mismatch'; end if;
 for series_e in select e from jsonb_array_elements(series_events) e where (e->>'sequence')::bigint>44 and e->'request'->>'operation'='BUDGET_RESERVED' loop
  if series_e->'request'->'body'->>'raw' is null or encode(sha256(convert_to(series_e->'request'->'body'->>'raw','UTF8')),'hex') is distinct from series_e->'request'->'body'->>'sha256'
  then raise exception 'series_original_budget_bytes_required'; end if;
  series_budget:=(series_e->'request'->'body'->>'raw')::jsonb;
  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  or ((series_e->>'sequence')::bigint >= w.budget_sequence_floor and (series_budget->>'root_generation' is distinct from w.generation_id or (series_budget->>'expires_at')::timestamptz is distinct from w.expires_at))
  or ((series_e->>'sequence')::bigint >= 89 and (series_e->>'sequence')::bigint < w.budget_sequence_floor and (
       series_budget->>'root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198'
       or series_budget->>'expires_at' is distinct from '2026-09-14T05:45:14Z'))
  or ((series_e->>'sequence')::bigint >= 64 and (series_e->>'sequence')::bigint < 89 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint >= 59 and (series_e->>'sequence')::bigint < 64 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint < 59 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'))
  then raise exception 'series_original_budget_scope_required'; end if;
 end loop;
 series_count:=0;
 for series_a in select a from jsonb_array_elements(series_attempts) a where not(a->>'ga_id'=any(ARRAY['ga_165dc2e72b62414a8023e726d8114f28','ga_18ce0e28e92f448c967fae1c92de7100','ga_6de636122e9c4fb782c0dc12fd223a9b','ga_87882f42d0b4460f8430d73239386c35','ga_a7a420f7de4a4037b9dcb5cd7dae796e','ga_c5041817c641487f827cc4ed5e0fc9ad']::text[])) loop
  series_count:=series_count+1;
  if series_a->>'root_id' is distinct from root or series_a->>'ga_raw' is null
  or encode(sha256(convert_to(series_a->>'ga_raw','UTF8')),'hex') is distinct from series_a->>'ga_sha256'
  or (series_a->>'ga_raw')::jsonb is distinct from series_a->'ga'
  then raise exception 'series_original_ga_bytes_required'; end if;
  series_ga:=series_a->'ga';
  if series_ga->>'gate_authorization_id' is distinct from series_a->>'ga_id'
  or (series_ga->>'issued_at') is null or (series_ga->>'deadline') is null
  or ((series_a->>'budget_sequence')::bigint >= 89 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198'
       or (series_ga->>'deadline')::timestamptz>'2026-09-14T05:45:14Z'::timestamptz))
  or ((series_a->>'budget_sequence')::bigint >= 64 and (series_a->>'budget_sequence')::bigint < 89 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
       or (series_ga->>'deadline')::timestamptz>'2026-09-11T10:21:05Z'::timestamptz))
  or ((series_a->>'budget_sequence')::bigint >= 59 and (series_a->>'budget_sequence')::bigint < 64 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or (series_ga->>'deadline')::timestamptz>'2026-09-11T10:21:05Z'::timestamptz))
  or ((series_a->>'budget_sequence')::bigint < 59 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or (series_ga->>'deadline')::timestamptz>'2026-09-10T10:13:16Z'::timestamptz))
  or (series_ga->>'deadline')::timestamptz-(series_ga->>'issued_at')::timestamptz>interval '600 seconds'
  then raise exception 'series_original_ga_window_required'; end if;
  if series_a->>'phase'='PASS' then raise exception 'series_first_pass_stops'; end if;
  if coalesce(series_a->>'phase','') not in ('FAIL','BLOCKED','STALE') or series_a->>'receipt_raw' is null
  or encode(sha256(convert_to(series_a->>'receipt_raw','UTF8')),'hex') is distinct from series_a->>'receipt_sha256'
  then raise exception 'series_prior_attempt_not_closed'; end if;
  series_receipt:=(series_a->>'receipt_raw')::jsonb;
  if series_receipt->>'result' is distinct from series_a->>'phase'
  or series_receipt->>'gate_authorization_id' is distinct from series_a->>'ga_id'
  or series_receipt->>'gate_authorization_sha256' is distinct from series_a->>'ga_sha256'
  or ((series_a->>'budget_sequence')::bigint >= 89 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198')
  or ((series_a->>'budget_sequence')::bigint >= 64 and (series_a->>'budget_sequence')::bigint < 89 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96')
  or ((series_a->>'budget_sequence')::bigint >= 59 and (series_a->>'budget_sequence')::bigint < 64 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06')
  or ((series_a->>'budget_sequence')::bigint < 59 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e')
  then raise exception 'series_terminal_receipt_binding_mismatch'; end if;
  select e into series_budget from jsonb_array_elements(series_events) e where (e->>'sequence')::bigint=(series_a->>'budget_sequence')::bigint and (e->>'sequence')::bigint>44 and e->'request'->>'operation'='BUDGET_RESERVED';
  if series_budget is null or (select count(*) from jsonb_array_elements(series_attempts) a where a->>'budget_sequence'=series_a->>'budget_sequence')<>1
  then raise exception 'series_attempt_requires_unique_new_budget'; end if;
 end loop;
 select count(*) into series_count from (
   select distinct (a->>'budget_sequence')::bigint budget_sequence
     from jsonb_array_elements(series_attempts) a
    where not(a->>'ga_id'=any(ARRAY['ga_165dc2e72b62414a8023e726d8114f28','ga_18ce0e28e92f448c967fae1c92de7100','ga_6de636122e9c4fb782c0dc12fd223a9b','ga_87882f42d0b4460f8430d73239386c35','ga_a7a420f7de4a4037b9dcb5cd7dae796e','ga_c5041817c641487f827cc4ed5e0fc9ad']::text[]))
   union
   select distinct (e->'request'->'body'->>'budget_sequence')::bigint
     from jsonb_array_elements(series_events) e
    where e->'request'->>'operation' in ('BUDGET_OWNER_FORFEITED_UNCONSUMED','BUDGET_EXPIRED_UNCONSUMED')
 ) accounted;
 if w.is_successor and not exists(select 1 from clued_control.execution_events e
   where e.root_id=root and e.request->>'operation'='EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED')
 then raise exception 'successor_not_activated'; end if;
 if c.active_ga_id is not null then raise exception 'series_active_attempt_blocks'; end if;
 if 'BUDGET'='BUDGET' then
  if series_n>=10 or series_count<>series_n or c.pending_budget_sequence is not null
  or clock_timestamp()+interval '600 seconds'>=w.expires_at
  then raise exception 'series_no_new_budget_capacity'; end if;
 else
  if series_n<1 or series_count<>series_n-1 or c.pending_budget_sequence is distinct from series_latest
  then raise exception 'series_exact_unconsumed_budget_required'; end if;
 end if;
end;

 if (v->>'expires_at')::timestamptz is distinct from w.expires_at then raise exception 'series_exact_new_budget_expiry_required'; end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or v->>'root_generation' is distinct from r->>'generation_id'
 or v->>'profile_digest' is distinct from b.profile_sha256 or v->>'controller_digest' is distinct from b.controller_sha256
 or v->>'scope_digest' is distinct from b.scope_sha256 or v->>'runner_generation' is distinct from c.runner_generation
 or v->>'credential_generation' is distinct from c.credential_generation or v->>'session_generation' is distinct from c.session_generation
 then raise exception 'budget_current_binding_mismatch'; end if;
 if (v->>'not_before') is null or (v->>'expires_at') is null or (v->>'not_before')::timestamptz>clock_timestamp()
 or (v->>'not_before')::timestamptz<w.not_before
 or (v->>'expires_at')::timestamptz<=clock_timestamp()
 or (v->>'expires_at')::timestamptz>w.expires_at
 then raise exception 'budget_window_invalid'; end if;
 if c.active_ga_id is not null or c.pending_budget_sequence is not null or c.charged_seconds<b.prior_seconds
 or c.charged_evidence_bytes<b.prior_evidence_bytes or c.charged_seconds+600>11106
 or c.charged_evidence_bytes+134217728>2470030259 then raise exception 'budget_or_pending_capacity_unavailable'; end if;
 next_sequence:=c.sequence+1;
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
 values(root,next_sequence,v->>'idempotency_key',jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',p_raw,'sha256',p_sha)));
 update clued_control.execution_current set sequence=next_sequence,pending_budget_sequence=next_sequence,
 charged_seconds=charged_seconds+600,charged_evidence_bytes=charged_evidence_bytes+134217728 where root_id=root;
 ref:=jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||next_sequence,'sha256',p_sha);
 return jsonb_build_object('status','BUDGET_RESERVED','budget_reservation_ref',ref,'sequence',next_sequence,
 'authority_effect','NONE','automatic_refund',false);
end $function$


CREATE OR REPLACE FUNCTION clued_control.reserve_gate(p_raw text, p_sha text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding; w record;
 c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer; budget clued_control.execution_events; allocation jsonb;
begin
 if p_raw is null or octet_length(p_raw)>65536 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'invalid_exact_ga_bytes'; end if;
 if not (p_raw is json object with unique keys) then raise exception 'invalid_unique_ga_object'; end if;
 g:=p_raw::jsonb;
 if jsonb_typeof(g)<>'object' or coalesce(g->>'gate_authorization_id','') !~ '^ga_[A-Za-z0-9_.-]{1,128}$'
 or coalesce(g->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'invalid_ga_identity'; end if;
 -- Serialize root revocation/generation and runtime capacity in consistent order.
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into b from clued_control.effective_execution_binding(); select * into w from clued_control.effective_execution_window() where root_id=root;
 if b.root_id is null or c.root_id is null then raise exception 'accepted_execution_binding_missing'; end if;
 select * into old from clued_control.gate_attempts where root_id=root and idempotency_key=g->>'idempotency_key';
 if found then
  if old.ga_raw is distinct from p_raw or old.ga_sha256 is distinct from p_sha then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','attempt',to_jsonb(old),'authority_effect','NONE');
 end if;
-- Inline LOCAL CANDIDATE. Caller already holds current_head SHARE then execution_current UPDATE.
-- GATE is generator-fixed BUDGET or GATE, never a request parameter.
declare
 series_view jsonb; series_events jsonb; series_attempts jsonb; series_old jsonb;
 series_e jsonb; series_a jsonb; series_receipt jsonb; series_budget jsonb; series_ga jsonb;
 series_n integer; series_f integer; series_count integer; series_latest bigint;
 series_root9 boolean;
begin
 series_view := clued_control.read_execution();
 series_events := series_view->'events'; series_attempts := series_view->'attempts';
 if jsonb_typeof(series_events) is distinct from 'array' or jsonb_typeof(series_attempts) is distinct from 'array'
 or series_view->'current' is distinct from to_jsonb(c)
 or series_view->'root'->>'generation_id' is distinct from w.generation_id
 or series_view->'root'->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY'
 or w.expires_at is null
 then raise exception 'series_current_root_window_mismatch'; end if;
 series_root9 := w.is_successor
  and w.generation_id='ctrgen_308a1dfc185cff633892638581e0a34c'
  and series_view->'root'->>'generation_id'='ctrgen_308a1dfc185cff633892638581e0a34c';
 if encode(sha256(convert_to((select jsonb_agg(e order by (e->>'sequence')::bigint) from jsonb_array_elements(series_view->'root'->'events') e where (e->>'sequence')::bigint<=6)::text,'UTF8')),'hex') is distinct from 'd34490fc17bf86e062fe28c1164193c735a49550d904e9ff2cd6b7167f766f43'
 then raise exception 'series_full_original_root_changed'; end if;
 if jsonb_array_length(series_view->'root'->'events') is distinct from
      (case when series_root9 then 9 when w.is_successor then 8 else 7 end)
 then raise exception 'series_full_original_root_changed'; end if;
 if series_root9 then
  if series_view->'root'->>'sequence' is distinct from '9'
  or series_view->'root'->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY'
  or series_view->'root'->>'metadata_binding_sha256' is distinct from w.binding_digest
  or encode(sha256(convert_to((select jsonb_agg(e order by (e->>'sequence')::bigint)
       from jsonb_array_elements(series_view->'root'->'events') e
       where (e->>'sequence')::bigint<=8)::text,'UTF8')),'hex')
       is distinct from '48be880b2a66a396b388fce96e2429de9ce7394449b9cf21ff2250e299ad2e21'
  or not exists(
       select 1 from jsonb_array_elements(series_view->'root'->'events') e
       where (e->>'sequence')::bigint=9
       and e->'request'->>'kind'='GENERATION_REGISTERED'
       and e->'request'->>'root_set_id'='ctr_414bd3c724264a83894b0c55cf2ab878'
       and e->'request'->>'expected_sequence'='8'
       and e->'request'->>'generation_id'='ctrgen_308a1dfc185cff633892638581e0a34c'
       and e->'request'->>'predecessor_generation_id'='ctrgen_b060bc520329398936e461af6a477f94'
       and e->'request'->>'idempotency_key'='root9_successor_atomic_install_v1_root'
       and e->'request'->>'metadata_binding_sha256'='5a43eb7f5afe213c83a829599e2c69de4d58365a7b8124f3ccb335b7601654a0'
       and e->'request'->'body'->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c'
       and e->'request'->'body'->>'object_type'='ControlTrustRootSet'
       and e->'request'->'body'->'predecessor'->>'generation_id'='ctrgen_b060bc520329398936e461af6a477f94'
       and e->'request'->'body'->'predecessor'->>'sha256'='cafe4ed82c21cc3fc4a9e009afe6a29017be6834f60150d81f3c77d6897dd0ce'
       and e->'request'->'body'->'history'->>'prefix_sequence'='8'
       and e->'request'->'body'->'history'->>'prefix_digest'='bf0660f3afe7de7e9506e642fdf7ecd15b61de97775b62c3a7d6e5c98f0b1a75')
  then raise exception 'series_full_original_root_changed'; end if;
 else
 if encode(sha256(convert_to(((((series_view->'root') - 'events')) || jsonb_build_object('registration_event',(select e - 'recorded_at' from jsonb_array_elements(series_view->'root'->'events') e where (e->>'sequence')::bigint=7)))::text,'UTF8')),'hex') is distinct from 'ae0575bdf6dc13d22814fe632221ac6cfb2b91e17f48bffa23c8454043d4abb7'
 then raise exception 'series_full_original_root_changed'; end if;
 end if;
 if jsonb_array_length(series_events)<>c.sequence or c.sequence<44
 or exists(select 1 from jsonb_array_elements(series_events) with ordinality t(e,n) where e->>'root_id' is distinct from root or (e->>'sequence')::bigint is distinct from n)
 then raise exception 'series_complete_contiguous_history_required'; end if;
 select jsonb_agg(e order by n) into series_old from jsonb_array_elements(series_events) with ordinality t(e,n) where n<=44;
 if encode(sha256(convert_to(series_old::text,'UTF8')),'hex') is distinct from '7f28f748c5ca671b9813232aebcd131c0ba1713469d530f1548c423505951bc2'
 then raise exception 'series_original_44_events_changed'; end if;
 select jsonb_agg(a order by a->>'ga_id') into series_old from jsonb_array_elements(series_attempts) a where a->>'ga_id'=any(ARRAY['ga_165dc2e72b62414a8023e726d8114f28','ga_18ce0e28e92f448c967fae1c92de7100','ga_6de636122e9c4fb782c0dc12fd223a9b','ga_87882f42d0b4460f8430d73239386c35','ga_a7a420f7de4a4037b9dcb5cd7dae796e','ga_c5041817c641487f827cc4ed5e0fc9ad']::text[]);
 if encode(sha256(convert_to(series_old::text,'UTF8')),'hex') is distinct from 'b5ed3460a9447b8240155129c8901a1a3ec78c6ac980ed8c4fa3e4eb0997116c'
 then raise exception 'series_original_six_attempts_changed'; end if;
 select count(*),max((e->>'sequence')::bigint) into series_n,series_latest from jsonb_array_elements(series_events) e where (e->>'sequence')::bigint>44 and e->'request'->>'operation'='BUDGET_RESERVED';
 select count(*) into series_f from jsonb_array_elements(series_events) e where (e->>'sequence')::bigint>44 and e->'request'->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED';
 if series_n>10 or series_f>19 or c.charged_seconds is distinct from 5106+600*series_n
 or c.charged_evidence_bytes is distinct from 1127852979::bigint+134217728::bigint*series_n
 or c.charged_seconds>11106 or c.charged_evidence_bytes>2470030259
 then raise exception 'series_exact_charges_or_count_mismatch'; end if;
 for series_e in select e from jsonb_array_elements(series_events) e where (e->>'sequence')::bigint>44 and e->'request'->>'operation'='BUDGET_RESERVED' loop
  if series_e->'request'->'body'->>'raw' is null or encode(sha256(convert_to(series_e->'request'->'body'->>'raw','UTF8')),'hex') is distinct from series_e->'request'->'body'->>'sha256'
  then raise exception 'series_original_budget_bytes_required'; end if;
  series_budget:=(series_e->'request'->'body'->>'raw')::jsonb;
  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  or ((series_e->>'sequence')::bigint >= w.budget_sequence_floor and (series_budget->>'root_generation' is distinct from w.generation_id or (series_budget->>'expires_at')::timestamptz is distinct from w.expires_at))
  or ((series_e->>'sequence')::bigint >= 89 and (series_e->>'sequence')::bigint < w.budget_sequence_floor and (
       series_budget->>'root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198'
       or series_budget->>'expires_at' is distinct from '2026-09-14T05:45:14Z'))
  or ((series_e->>'sequence')::bigint >= 64 and (series_e->>'sequence')::bigint < 89 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint >= 59 and (series_e->>'sequence')::bigint < 64 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint < 59 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'))
  then raise exception 'series_original_budget_scope_required'; end if;
 end loop;
 series_count:=0;
 for series_a in select a from jsonb_array_elements(series_attempts) a where not(a->>'ga_id'=any(ARRAY['ga_165dc2e72b62414a8023e726d8114f28','ga_18ce0e28e92f448c967fae1c92de7100','ga_6de636122e9c4fb782c0dc12fd223a9b','ga_87882f42d0b4460f8430d73239386c35','ga_a7a420f7de4a4037b9dcb5cd7dae796e','ga_c5041817c641487f827cc4ed5e0fc9ad']::text[])) loop
  series_count:=series_count+1;
  if series_a->>'root_id' is distinct from root or series_a->>'ga_raw' is null
  or encode(sha256(convert_to(series_a->>'ga_raw','UTF8')),'hex') is distinct from series_a->>'ga_sha256'
  or (series_a->>'ga_raw')::jsonb is distinct from series_a->'ga'
  then raise exception 'series_original_ga_bytes_required'; end if;
  series_ga:=series_a->'ga';
  if series_ga->>'gate_authorization_id' is distinct from series_a->>'ga_id'
  or (series_ga->>'issued_at') is null or (series_ga->>'deadline') is null
  or ((series_a->>'budget_sequence')::bigint >= 89 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198'
       or (series_ga->>'deadline')::timestamptz>'2026-09-14T05:45:14Z'::timestamptz))
  or ((series_a->>'budget_sequence')::bigint >= 64 and (series_a->>'budget_sequence')::bigint < 89 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
       or (series_ga->>'deadline')::timestamptz>'2026-09-11T10:21:05Z'::timestamptz))
  or ((series_a->>'budget_sequence')::bigint >= 59 and (series_a->>'budget_sequence')::bigint < 64 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or (series_ga->>'deadline')::timestamptz>'2026-09-11T10:21:05Z'::timestamptz))
  or ((series_a->>'budget_sequence')::bigint < 59 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or (series_ga->>'deadline')::timestamptz>'2026-09-10T10:13:16Z'::timestamptz))
  or (series_ga->>'deadline')::timestamptz-(series_ga->>'issued_at')::timestamptz>interval '600 seconds'
  then raise exception 'series_original_ga_window_required'; end if;
  if series_a->>'phase'='PASS' then raise exception 'series_first_pass_stops'; end if;
  if coalesce(series_a->>'phase','') not in ('FAIL','BLOCKED','STALE') or series_a->>'receipt_raw' is null
  or encode(sha256(convert_to(series_a->>'receipt_raw','UTF8')),'hex') is distinct from series_a->>'receipt_sha256'
  then raise exception 'series_prior_attempt_not_closed'; end if;
  series_receipt:=(series_a->>'receipt_raw')::jsonb;
  if series_receipt->>'result' is distinct from series_a->>'phase'
  or series_receipt->>'gate_authorization_id' is distinct from series_a->>'ga_id'
  or series_receipt->>'gate_authorization_sha256' is distinct from series_a->>'ga_sha256'
  or ((series_a->>'budget_sequence')::bigint >= 89 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198')
  or ((series_a->>'budget_sequence')::bigint >= 64 and (series_a->>'budget_sequence')::bigint < 89 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96')
  or ((series_a->>'budget_sequence')::bigint >= 59 and (series_a->>'budget_sequence')::bigint < 64 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06')
  or ((series_a->>'budget_sequence')::bigint < 59 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e')
  then raise exception 'series_terminal_receipt_binding_mismatch'; end if;
  select e into series_budget from jsonb_array_elements(series_events) e where (e->>'sequence')::bigint=(series_a->>'budget_sequence')::bigint and (e->>'sequence')::bigint>44 and e->'request'->>'operation'='BUDGET_RESERVED';
  if series_budget is null or (select count(*) from jsonb_array_elements(series_attempts) a where a->>'budget_sequence'=series_a->>'budget_sequence')<>1
  then raise exception 'series_attempt_requires_unique_new_budget'; end if;
 end loop;
 select count(*) into series_count from (
   select distinct (a->>'budget_sequence')::bigint budget_sequence
     from jsonb_array_elements(series_attempts) a
    where not(a->>'ga_id'=any(ARRAY['ga_165dc2e72b62414a8023e726d8114f28','ga_18ce0e28e92f448c967fae1c92de7100','ga_6de636122e9c4fb782c0dc12fd223a9b','ga_87882f42d0b4460f8430d73239386c35','ga_a7a420f7de4a4037b9dcb5cd7dae796e','ga_c5041817c641487f827cc4ed5e0fc9ad']::text[]))
   union
   select distinct (e->'request'->'body'->>'budget_sequence')::bigint
     from jsonb_array_elements(series_events) e
    where e->'request'->>'operation' in ('BUDGET_OWNER_FORFEITED_UNCONSUMED','BUDGET_EXPIRED_UNCONSUMED')
 ) accounted;
 if w.is_successor and not exists(select 1 from clued_control.execution_events e
   where e.root_id=root and e.request->>'operation'='EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED')
 then raise exception 'successor_not_activated'; end if;
 if c.active_ga_id is not null then raise exception 'series_active_attempt_blocks'; end if;
 if 'GATE'='BUDGET' then
  if series_n>=3 or series_count<>series_n or c.pending_budget_sequence is not null
  or clock_timestamp()+interval '600 seconds'>=w.expires_at
  then raise exception 'series_no_new_budget_capacity'; end if;
 else
  if series_n<1 or series_count<>series_n-1 or c.pending_budget_sequence is distinct from series_latest
  then raise exception 'series_exact_unconsumed_budget_required'; end if;
 end if;
end;

 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or g->>'control_trust_root_generation' is distinct from r->>'generation_id'
 or g->>'runner_generation' is distinct from c.runner_generation or g->>'credential_generation' is distinct from c.credential_generation
 or g->>'session_generation' is distinct from c.session_generation then raise exception 'current_authority_or_generation_changed'; end if;
 if g->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION' or g->>'environment' is distinct from 'ISOLATED_TEST'
 or g->>'authorization_status' is distinct from 'AUTHORIZED' or g->>'profile_digest' is distinct from b.profile_sha256
 or g->>'controller_digest' is distinct from b.controller_sha256 or g->>'scope_digest' is distinct from b.scope_sha256
 or g->>'gate_id' is distinct from b.gate_id
 or g->'controller_qualification_ref'->>'sha256' is distinct from b.qualification_sha256 then raise exception 'exact_accepted_scope_mismatch'; end if;
 if not exists(select 1 from clued_control.control_objects co where co.root_id=root
 and co.uri=g->'status_manifest_ref'->>'uri' and co.sha256=g->'status_manifest_ref'->>'sha256')
 then raise exception 'exact_stored_status_required'; end if;
 -- Full original Schema, exact static Gate version/digest, signature/issuer,
 -- Profile/NA evidence and target bindings are checked by the trusted host verifier.
 start_time:=(g->>'issued_at')::timestamptz;end_time:=(g->>'deadline')::timestamptz;
 if start_time is null or end_time is null or (g->>'expires_at') is null or start_time>clock_timestamp()
 or start_time<w.not_before
 or end_time<=clock_timestamp() or end_time>(g->>'expires_at')::timestamptz
 or (g->>'expires_at')::timestamptz-start_time>interval '600 seconds'
 or (g->>'expires_at')::timestamptz>w.expires_at
 then raise exception 'ga_window_invalid'; end if;
 seconds:=ceil(extract(epoch from ((g->>'expires_at')::timestamptz-start_time)))::integer;
 if c.charged_seconds<b.prior_seconds or c.charged_evidence_bytes<b.prior_evidence_bytes then raise exception 'prior_budget_binding_mismatch'; end if;
 if seconds<1 or c.active_ga_id is not null or c.pending_budget_sequence is null
 then raise exception 'actual_pending_budget_required'; end if;
 select * into budget from clued_control.execution_events where root_id=root and sequence=c.pending_budget_sequence;
 if not found or budget.recording_transaction_id=pg_current_xact_id() or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
 or g->'budget_reservation_ref'->>'uri' is distinct from 'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||budget.sequence
 or g->'budget_reservation_ref'->>'sha256' is distinct from budget.request->'body'->>'sha256'
 then raise exception 'exact_prior_committed_budget_required'; end if;
 allocation:=(budget.request->'body'->>'raw')::jsonb;
 if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'controller_digest' is distinct from g->>'controller_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest' or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer or start_time<(allocation->>'not_before')::timestamptz
 or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
 then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;
 insert into clued_control.gate_attempts(root_id,ga_id,idempotency_key,ga_raw,ga_sha256,ga,phase,expires_at,budget_sequence)
 values(root,g->>'gate_authorization_id',g->>'idempotency_key',p_raw,p_sha,g,'PENDING',end_time,budget.sequence);
 update clued_control.execution_current set active_ga_id=g->>'gate_authorization_id',pending_budget_sequence=null where root_id=root;
 return jsonb_build_object('status','RESERVED','ga_id',g->>'gate_authorization_id','authority_effect','NONE');
end $function$

revoke all on function clued_control.reserve_execution_budget(text,text) from public,anon,authenticated;
grant execute on function clued_control.reserve_execution_budget(text,text) to service_role;
revoke all on function clued_control.reserve_gate(text,text) from public,anon,authenticated;
grant execute on function clued_control.reserve_gate(text,text) to service_role;
commit;
