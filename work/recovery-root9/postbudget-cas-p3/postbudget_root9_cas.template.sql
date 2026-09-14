-- TEMPLATE / NOT EXECUTABLE.
-- Root9 post-budget dynamic-signing repair.  Seal every placeholder only after
-- P2/P3 Owner publication and independent review.  Execute as one transaction.
--
-- Exact authorized write set:
--   1) append one immutable StatusManifest generation 27;
--   2) append execution event 103 (qualification correction);
--   3) append execution event 104 (runtime acceptance repoint + seq102 inheritance);
--   4) CAS execution_current.sequence 102 -> 104.
--
-- Forbidden: UPDATE/DELETE of history/control objects/bindings/attempts; refund;
-- capacity change; a BUDGET_RESERVED event; a new attempt; clearing or replacing
-- pending_budget_sequence=102; changing either charged total.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Authorized exact reserve_gate replacement. This is the first mutating
-- statement in the transaction; every later CAS failure rolls it back.
-- Embed this DO block inside the already-authorized P3 transaction.
-- It performs no CAS and consumes no budget; it only fail-closed replaces reserve_gate.
do $reserve_gate_catalog_guard$
declare
 before_catalog jsonb; after_catalog jsonb; before_hash text; after_hash text;
begin
 select to_jsonb(p)-'prosrc', encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
   into strict before_catalog,before_hash from pg_proc p
  where p.oid='clued_control.reserve_gate(text,text)'::regprocedure;
 if before_hash is distinct from '61e700ffd16dc754061676b5cca3ff76aa1ca2ba4eabf3573caac41b00d23db5' then raise exception 'reserve_gate_preimage_mismatch'; end if;
 if encode(sha256(convert_to(before_catalog::text,'UTF8')),'hex') is distinct from '__PRE_CATALOG_JSONB_SHA256__'
 then raise exception 'reserve_gate_pre_catalog_token_mismatch'; end if;
 if (select not p.prosecdef or p.provolatile<>'v' or p.prokind<>'f'
            or p.proconfig is distinct from array['search_path=""','TimeZone=UTC']::text[]
       from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure)
 then raise exception 'reserve_gate_catalog_precondition_mismatch'; end if;
 if exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
              and a.grantee=0 and a.privilege_type='EXECUTE')
    or has_function_privilege('anon','clued_control.reserve_gate(text,text)','EXECUTE')
    or has_function_privilege('authenticated','clued_control.reserve_gate(text,text)','EXECUTE')
    or not has_function_privilege('service_role','clued_control.reserve_gate(text,text)','EXECUTE')
 then raise exception 'reserve_gate_acl_precondition_mismatch'; end if;
 execute $reserve_gate_ddl$CREATE OR REPLACE FUNCTION clued_control.reserve_gate(p_raw text, p_sha text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding; w record;
 c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer; budget clued_control.execution_events; allocation jsonb;
 repoint clued_control.execution_events; correction_event clued_control.execution_events; root9_qualification_event clued_control.execution_events; inherited_budget jsonb; previous_binding jsonb; replacement_binding jsonb; correction_evidence_sha text;
 expected_p3_publication_uri constant text := '__P3_PUBLICATION_EVIDENCE_URI__'; expected_p3_publication_sha constant text := '__P3_PUBLICATION_EVIDENCE_SHA256__';
 expected_review_uri constant text := '__INDEPENDENT_REVIEW_URI__'; expected_review_sha constant text := '__INDEPENDENT_REVIEW_SHA256__'; expected_correction_evidence_sha constant text := '__CORRECTION_EVIDENCE_JSONB_SHA256__';
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
begin
 series_view := clued_control.read_execution();
 series_events := series_view->'events'; series_attempts := series_view->'attempts';
 if jsonb_typeof(series_events) is distinct from 'array' or jsonb_typeof(series_attempts) is distinct from 'array'
 or series_view->'current' is distinct from to_jsonb(c)
 or series_view->'root'->>'generation_id' is distinct from w.generation_id
 or series_view->'root'->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY'
 or w.expires_at is null
 then raise exception 'series_current_root_window_mismatch'; end if;
 if encode(sha256(convert_to((select jsonb_agg(e order by (e->>'sequence')::bigint) from jsonb_array_elements(series_view->'root'->'events') e where (e->>'sequence')::bigint<=6)::text,'UTF8')),'hex') is distinct from 'd34490fc17bf86e062fe28c1164193c735a49550d904e9ff2cd6b7167f766f43'
 then raise exception 'series_full_original_root_changed'; end if;
 if jsonb_array_length(series_view->'root'->'events') is distinct from (case when w.is_successor then 8 else 7 end)
 then raise exception 'series_full_original_root_changed'; end if;
 if encode(sha256(convert_to(((((series_view->'root') - 'events')) || jsonb_build_object('registration_event',(select e - 'recorded_at' from jsonb_array_elements(series_view->'root'->'events') e where (e->>'sequence')::bigint=7)))::text,'UTF8')),'hex') is distinct from 'ae0575bdf6dc13d22814fe632221ac6cfb2b91e17f48bffa23c8454043d4abb7'
 then raise exception 'series_full_original_root_changed'; end if;
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
previous_binding := jsonb_build_object(
  'root_id','ctr_414bd3c724264a83894b0c55cf2ab878',
  'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
  'controller_sha256','c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b',
  'qualification_sha256','171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71',
  'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  'gate_id','G-PREENTRY-SKILL-QUALIFICATION',
  'gate_version','fixed-synthetic-20260910.v10-env-order-repair',
  'gate_sha256','3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
  'runtime_acceptance_sha256','107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9',
  'prior_seconds',1506,
  'prior_evidence_bytes',322546611);

replacement_binding := previous_binding || jsonb_build_object(
  'controller_sha256','c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  'qualification_sha256','a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013',
  'runtime_acceptance_sha256','c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552');

inherited_budget := jsonb_build_object(
  'budget_sequence',102,
  'budget_reservation_ref',jsonb_build_object(
    'uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102',
    'sha256','51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'),
  'original_controller_sha256','c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b',
  'replacement_controller_sha256','c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  'root_generation','ctrgen_308a1dfc185cff633892638581e0a34c',
  'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
  'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  'runner_generation','runnergen_a256855fec9441839105c69b746c5244',
  'credential_generation','credgen_bac92a11e7144a3fb9e67f40a6a07d11',
  'session_generation','sessiongen_ffb02a907d334b0da0b37bf457a758c2',
  'reason','POST_BUDGET_ROOT9_DYNAMIC_SIGNING_REPAIR',
  'additional_allocation',false,
  'automatic_refund',false,
  'remaining_seconds',600,
  'remaining_evidence_bytes',134217728);

-- Every allocation field except controller_digest retains the original general
-- comparison. The old controller may differ only through the exact branch below.
if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest'
 or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation'
 or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer
 or start_time<(allocation->>'not_before')::timestamptz
 or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;

if allocation->>'controller_digest' is distinct from g->>'controller_digest' then
  select * into root9_qualification_event
    from clued_control.execution_events
   where root_id=root and sequence=100;
  select * into correction_event
    from clued_control.execution_events
   where root_id=root and sequence=103;
  select * into repoint
    from clued_control.execution_events
   where root_id=root and sequence=104;
  correction_evidence_sha := encode(sha256(convert_to(
    (correction_event.request->'body'->'evidence')::text,'UTF8')),'hex');

  if budget.sequence is distinct from 102
   or budget.idempotency_key is distinct from 'root9_final_skill_qualification_budget_v1'
   or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
   or (select array_agg(k order by k) from jsonb_object_keys(budget.request) k)
        is distinct from array['body','operation']::text[]
   or (select array_agg(k order by k) from jsonb_object_keys(budget.request->'body') k)
        is distinct from array['raw','sha256']::text[]
   or budget.request->'body'->>'sha256' is distinct from '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'
   or encode(sha256(convert_to(budget.request->'body'->>'raw','UTF8')),'hex')
        is distinct from '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'
   or (select array_agg(k order by k) from jsonb_object_keys(allocation) k) is distinct from
        array['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation']::text[]
   or allocation->>'controller_digest' is distinct from 'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b'
   or allocation->>'root_generation' is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c'
   or allocation->>'profile_digest' is distinct from 'd1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5'
   or allocation->>'scope_digest' is distinct from '115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5'
   or allocation->>'runner_generation' is distinct from 'runnergen_a256855fec9441839105c69b746c5244'
   or allocation->>'credential_generation' is distinct from 'credgen_bac92a11e7144a3fb9e67f40a6a07d11'
   or allocation->>'session_generation' is distinct from 'sessiongen_ffb02a907d334b0da0b37bf457a758c2'
   or allocation->>'environment' is distinct from 'ISOLATED_TEST'
   or allocation->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
   or allocation->>'idempotency_key' is distinct from 'root9_final_skill_qualification_budget_v1'
   or allocation->'seconds' is distinct from '600'::jsonb
   or allocation->'evidence_bytes' is distinct from '134217728'::jsonb
   or (allocation->>'not_before')::timestamptz is distinct from '2026-09-14T03:00:00Z'::timestamptz
   or (allocation->>'expires_at')::timestamptz is distinct from '2026-09-15T03:00:00Z'::timestamptz
   or c.root_id is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878'
   or c.sequence is distinct from 104
   or c.pending_budget_sequence is distinct from 102
   or c.active_ga_id is not null
   or c.charged_seconds is distinct from 11106
   or c.charged_evidence_bytes is distinct from 2470030259
   or c.runner_generation is distinct from 'runnergen_a256855fec9441839105c69b746c5244'
   or c.credential_generation is distinct from 'credgen_bac92a11e7144a3fb9e67f40a6a07d11'
   or c.session_generation is distinct from 'sessiongen_ffb02a907d334b0da0b37bf457a758c2'
   or w.root_id is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878'
   or w.generation_id is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c'
   or w.is_successor is distinct from true
   or w.budget_sequence_floor is distinct from 98
   or w.not_before is distinct from '2026-09-14T03:00:00Z'::timestamptz
   or w.expires_at is distinct from '2026-09-15T03:00:00Z'::timestamptz
   or b.root_id is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878'
   or b.profile_sha256 is distinct from 'd1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5'
   or b.controller_sha256 is distinct from 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a'
   or b.qualification_sha256 is distinct from 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013'
   or b.scope_sha256 is distinct from '115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5'
   or b.gate_id is distinct from 'G-PREENTRY-SKILL-QUALIFICATION'
   or b.gate_version is distinct from 'fixed-synthetic-20260910.v10-env-order-repair'
   or b.gate_sha256 is distinct from '3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a'
   or b.runtime_acceptance_sha256 is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or b.prior_seconds is distinct from 1506
   or b.prior_evidence_bytes is distinct from 322546611
   or g->>'control_trust_root_generation' is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c'
   or g->>'profile_digest' is distinct from 'd1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5'
   or g->>'controller_digest' is distinct from 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a'
   or g->>'scope_digest' is distinct from '115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5'
   or g->'controller_qualification_ref'->>'sha256' is distinct from 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013'
   or g->>'runner_generation' is distinct from 'runnergen_a256855fec9441839105c69b746c5244'
   or g->>'credential_generation' is distinct from 'credgen_bac92a11e7144a3fb9e67f40a6a07d11'
   or g->>'session_generation' is distinct from 'sessiongen_ffb02a907d334b0da0b37bf457a758c2'
   or correction_event.sequence is distinct from 103
   or correction_event.recording_transaction_id is null
   or correction_event.recording_transaction_id=pg_current_xact_id()
   or correction_event.idempotency_key is distinct from 'root9_postbudget_dynamic_signing_repair_v1_qualification'
   or correction_event.request->>'operation' is distinct from 'SUCCESSOR_BINDING_QUALIFICATION_CORRECTED'
   or (select array_agg(k order by k) from jsonb_object_keys(correction_event.request) k)
        is distinct from array['body','operation']::text[]
   or (select array_agg(k order by k) from jsonb_object_keys(correction_event.request->'body') k)
        is distinct from array['binding_id','evidence','evidence_sha256','status_manifest_ref','supersedes_execution_sequence']::text[]
   or correction_event.request->'body'->>'binding_id' is distinct from 'sb_201178b7a8111000d515f7f26a75a28b'
   or correction_event.request->'body'->'supersedes_execution_sequence' is distinct from '100'::jsonb
   or correction_event.request->'body'->>'evidence_sha256' is distinct from correction_evidence_sha
   or correction_evidence_sha is distinct from expected_correction_evidence_sha
   or (select array_agg(k order by k)
         from jsonb_object_keys(correction_event.request->'body'->'evidence') k) is distinct from
        array['authority_effect','controller_file_count','defect_code','independent_review_ref','new_controller_sha256','new_qualification_sha256','new_runtime_acceptance_sha256','p2_publication_ref','p3_publication_ref','pending_budget_inheritance','required_repair_refs','status_manifest_ref']::text[]
   or correction_event.request->'body'->'evidence'->>'authority_effect' is distinct from 'NONE'
   or correction_event.request->'body'->'evidence'->'controller_file_count' is distinct from '23'::jsonb
   or correction_event.request->'body'->'evidence'->>'defect_code' is distinct from 'ROOT9_DYNAMIC_SIGNING_HELPER_NOT_MANIFEST_COVERED'
   or correction_event.request->'body'->'evidence'->>'new_controller_sha256' is distinct from 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a'
   or correction_event.request->'body'->'evidence'->>'new_qualification_sha256' is distinct from 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013'
   or correction_event.request->'body'->'evidence'->>'new_runtime_acceptance_sha256' is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or correction_event.request->'body'->'evidence'->'pending_budget_inheritance' is distinct from inherited_budget
   or (select array_agg(k order by k) from jsonb_object_keys(g->'status_manifest_ref') k)
        is distinct from array['sha256','uri']::text[]
   or correction_event.request->'body'->'status_manifest_ref' is distinct from g->'status_manifest_ref'
   or correction_event.request->'body'->'evidence'->'status_manifest_ref' is distinct from g->'status_manifest_ref'
   or correction_event.request->'body'->'evidence'->'p2_publication_ref' is distinct from
        jsonb_build_object(
          'uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/bfc65714f9b596c6140c745948185e92665a48dd',
          'sha256','dec179df0626c5f22bb33a979336430dd136c8a54895666bae2ce4b2b0eae887')
   or correction_event.request->'body'->'evidence'->'p3_publication_ref' is distinct from
        jsonb_build_object('uri',expected_p3_publication_uri,'sha256',expected_p3_publication_sha)
   or correction_event.request->'body'->'evidence'->'independent_review_ref' is distinct from
        jsonb_build_object('uri',expected_review_uri,'sha256',expected_review_sha)
   or expected_p3_publication_uri !~ '^https://api[.]github[.]com/repos/tdoljyj/cross-memory-system/git/blobs/[0-9a-f]{40}$'
   or expected_p3_publication_sha !~ '^[0-9a-f]{64}$'
   or expected_review_uri !~ '^https://api[.]github[.]com/repos/tdoljyj/cross-memory-system/git/blobs/[0-9a-f]{40}$'
   or expected_review_sha !~ '^[0-9a-f]{64}$'
   or expected_correction_evidence_sha !~ '^[0-9a-f]{64}$'
   or jsonb_typeof(correction_event.request->'body'->'evidence'->'required_repair_refs') is distinct from 'array'
   or jsonb_array_length(correction_event.request->'body'->'evidence'->'required_repair_refs') is distinct from 8
   or root9_qualification_event.sequence is distinct from 100
   or root9_qualification_event.request->>'operation' is distinct from 'SUCCESSOR_BINDING_QUALIFIED'
   or correction_event.request->'body'->'evidence'->'required_repair_refs' is distinct from
        root9_qualification_event.request->'body'->'evidence'->'required_repair_refs'
   or repoint.sequence is distinct from 104
   or repoint.recording_transaction_id is null
   or repoint.recording_transaction_id=pg_current_xact_id()
   or repoint.recording_transaction_id is distinct from correction_event.recording_transaction_id
   or repoint.idempotency_key is distinct from 'root9_postbudget_dynamic_signing_repair_v1_repoint'
   or repoint.request->>'operation' is distinct from 'EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'
   or (select array_agg(k order by k) from jsonb_object_keys(repoint.request) k)
        is distinct from array['body','operation']::text[]
   or (select array_agg(k order by k) from jsonb_object_keys(repoint.request->'body') k) is distinct from
        array['acceptance_raw','acceptance_sha256','binding_id','new_binding','new_binding_sha256','new_runtime_acceptance_sha256','old_runtime_acceptance_sha256','pending_budget_inheritance','previous_binding','previous_binding_sha256','qualification_correction_sequence','qualified_evidence','supersedes_execution_sequence']::text[]
   or repoint.request->'body'->>'binding_id' is distinct from 'sb_201178b7a8111000d515f7f26a75a28b'
   or repoint.request->'body'->'supersedes_execution_sequence' is distinct from '101'::jsonb
   or repoint.request->'body'->'qualification_correction_sequence' is distinct from '103'::jsonb
   or repoint.request->'body'->'previous_binding' is distinct from previous_binding
   or repoint.request->'body'->>'previous_binding_sha256' is distinct from
        encode(sha256(convert_to(previous_binding::text,'UTF8')),'hex')
   or repoint.request->'body'->'new_binding' is distinct from replacement_binding
   or repoint.request->'body'->>'new_binding_sha256' is distinct from
        encode(sha256(convert_to(replacement_binding::text,'UTF8')),'hex')
   or repoint.request->'body'->>'old_runtime_acceptance_sha256' is distinct from '107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9'
   or repoint.request->'body'->>'new_runtime_acceptance_sha256' is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or repoint.request->'body'->>'acceptance_sha256' is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or encode(sha256(convert_to(repoint.request->'body'->>'acceptance_raw','UTF8')),'hex')
        is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or repoint.request->'body'->'pending_budget_inheritance' is distinct from inherited_budget
   or repoint.request->'body'->'qualified_evidence' is distinct from correction_event.request->'body'->'evidence'
  then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;
end if;
 insert into clued_control.gate_attempts(root_id,ga_id,idempotency_key,ga_raw,ga_sha256,ga,phase,expires_at,budget_sequence)
 values(root,g->>'gate_authorization_id',g->>'idempotency_key',p_raw,p_sha,g,'PENDING',end_time,budget.sequence);
 update clued_control.execution_current set active_ga_id=g->>'gate_authorization_id',pending_budget_sequence=null where root_id=root;
 return jsonb_build_object('status','RESERVED','ga_id',g->>'gate_authorization_id','authority_effect','NONE');
end $function$
$reserve_gate_ddl$;
 select to_jsonb(p)-'prosrc', encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
   into strict after_catalog,after_hash from pg_proc p
  where p.oid='clued_control.reserve_gate(text,text)'::regprocedure;
 if after_catalog is distinct from before_catalog then raise exception 'reserve_gate_catalog_changed'; end if;
 if encode(sha256(convert_to(after_catalog::text,'UTF8')),'hex') is distinct from '__PRE_CATALOG_JSONB_SHA256__'
 then raise exception 'reserve_gate_post_catalog_token_mismatch'; end if;
 if after_hash is distinct from '__POST_PG_GET_FUNCTIONDEF_SHA256__' then raise exception 'reserve_gate_postimage_mismatch'; end if;
 if exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
              and a.grantee=0 and a.privilege_type='EXECUTE')
    or has_function_privilege('anon','clued_control.reserve_gate(text,text)','EXECUTE')
    or has_function_privilege('authenticated','clued_control.reserve_gate(text,text)','EXECUTE')
    or not has_function_privilege('service_role','clued_control.reserve_gate(text,text)','EXECUTE')
 then raise exception 'reserve_gate_acl_postcondition_mismatch'; end if;
end
$reserve_gate_catalog_guard$;
do $postbudget_root9_cas$
declare
  p jsonb := convert_from(decode('__REQUEST_BASE64__','base64'),'UTF8')::jsonb;

  root constant text := 'ctr_414bd3c724264a83894b0c55cf2ab878';
  root9 constant text := 'ctrgen_308a1dfc185cff633892638581e0a34c';
  bid constant text := 'sb_201178b7a8111000d515f7f26a75a28b';
  old_controller constant text := 'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b';
  old_qualification constant text := '171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71';
  old_acceptance constant text := '107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9';
  profile_sha constant text := 'd1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5';
  scope_sha constant text := '115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5';
  gate_sha constant text := '3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a';
  status_schema_sha constant text := '6f9a6799109cbad00b4e615b58f535f91fe0ec4a53790fa744000caa2bf3282e';
  window_not_before constant timestamptz := '2026-09-14T03:00:00Z';
  window_expires_at constant timestamptz := '2026-09-15T03:00:00Z';
  budget_sequence constant bigint := 102;
  budget_sha constant text := '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a';
  status_signing_raw_sha constant text := '9701fd4512797f4a90b96a59e06f438422e84f8eb03038fd3ae947ec46fd5c95';
  controller_manifest_sha constant text := 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a';
  dynamic_signing_sha constant text := 'e067177cefb9311b4bce88242661bf6109f0ad78e75ae69b156adc1a8b3c9002';
  runner_generation constant text := 'runnergen_a256855fec9441839105c69b746c5244';
  credential_generation constant text := 'credgen_bac92a11e7144a3fb9e67f40a6a07d11';
  session_generation constant text := 'sessiongen_ffb02a907d334b0da0b37bf457a758c2';
  expected_p2_merge constant text := '20d6ec1e62eebed26e56bc2e4f52eed87704e8ab';
  expected_p2_tree constant text := '54c448837711086bcf0e334de4c6acc97c1f338f';
  expected_p3_merge constant text := '__P3_OWNER_MERGE_SHA__';
  expected_p3_tree constant text := '__P3_OWNER_MERGE_TREE__';
  expected_p3_source constant text := '__P3_SOURCE_HEAD_SHA__';
  expected_p3_pr constant bigint := __P3_PR_NUMBER__;
  expected_p2_evidence_sha constant text := 'dec179df0626c5f22bb33a979336430dd136c8a54895666bae2ce4b2b0eae887';
  expected_p3_evidence_sha constant text := '__P3_PUBLICATION_EVIDENCE_SHA256__';
  expected_status_signature_sha constant text := '__STATUS_SIGNATURE_EVIDENCE_SHA256__';
  expected_review_sha constant text := '__INDEPENDENT_REVIEW_SHA256__';
  expected_read_root_function_sha constant text := '__READ_ROOT_FUNCTION_SHA256__';
  expected_target_trigger_defs_sha constant text := '__TARGET_TRIGGER_DEFS_SHA256__';
  expected_target_constraints_sha constant text := '__TARGET_CONSTRAINTS_SHA256__';
  expected_root_prefix_sha constant text := '__ROOT_EVENTS_1_9_SHA256__';
  expected_execution_prefix_sha constant text := '__EXECUTION_EVENTS_1_102_SHA256__';
  expected_attempts_sha constant text := '__GATE_ATTEMPTS_SHA256__';
  expected_successors_sha constant text := '__SUCCESSOR_BINDINGS_SHA256__';
  expected_control_objects_prefix_sha constant text := '__CONTROL_OBJECTS_THROUGH_26_SHA256__';
  idem constant text := 'root9_postbudget_dynamic_signing_repair_v1';

  h clued_control.current_head;
  c clued_control.execution_current;
  b clued_control.execution_binding;
  s clued_control.successor_binding;
  budget clued_control.execution_events;
  q_old clued_control.execution_events;
  r_old clued_control.execution_events;
  status_row clued_control.control_objects;
  budget_raw jsonb;
  status jsonb;
  qualification jsonb;
  acceptance jsonb;
  p2 jsonb;
  p3 jsonb;
  review jsonb;
  sig jsonb;
  correction jsonb;
  status_ref jsonb;
  inheritance jsonb;
  old_binding jsonb;
  new_binding jsonb;
  q_req jsonb;
  r_req jsonb;
  status_result jsonb;
  new_controller text;
  new_qualification text;
  new_acceptance text;
  status_sha text;
  status_payload_sha text;
  catalog_sha text;
  correction_sha text;
  q_idem text := idem || '_qualification';
  r_idem text := idem || '_repoint';
begin
  -- Exact request envelope.  All externally published artifacts remain exact bytes.
  if p is null or jsonb_typeof(p)<>'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from
       array['acceptance_raw','acceptance_sha256','binding_id','controller_qualification_raw','controller_qualification_sha256','controller_manifest_raw','controller_sha256','correction_evidence','expected_sequence','idempotency_key','independent_review_blob_sha1','independent_review_raw','independent_review_sha256','p2_publication_evidence_raw','p2_publication_evidence_sha256','p3_publication_evidence_blob_sha1','p3_publication_evidence_raw','p3_publication_evidence_sha256','status_raw','status_sha256','status_signature_evidence_raw','status_signature_evidence_sha256','status_signed_payload_sha256']::text[]
     or p->>'binding_id' is distinct from bid
     or p->'expected_sequence' is distinct from '102'::jsonb
     or p->>'idempotency_key' is distinct from idem
  then raise exception 'invalid_root9_postbudget_request'; end if;

  if not ((p->>'controller_manifest_raw') is json object with unique keys)
     or not ((p->>'controller_qualification_raw') is json object with unique keys)
     or not ((p->>'acceptance_raw') is json object with unique keys)
     or not ((p->>'status_raw') is json object with unique keys)
     or not ((p->>'p2_publication_evidence_raw') is json object with unique keys)
     or not ((p->>'p3_publication_evidence_raw') is json object with unique keys)
     or not ((p->>'status_signature_evidence_raw') is json object with unique keys)
     or not ((p->>'independent_review_raw') is json object with unique keys)
  then raise exception 'exact_json_bytes_required'; end if;

  if p->>'controller_sha256' is distinct from
       encode(sha256(convert_to(p->>'controller_manifest_raw','UTF8')),'hex')
     or p->>'controller_sha256' is distinct from controller_manifest_sha
     or p->>'controller_qualification_sha256' is distinct from
       encode(sha256(convert_to(p->>'controller_qualification_raw','UTF8')),'hex')
     or p->>'acceptance_sha256' is distinct from
       encode(sha256(convert_to(p->>'acceptance_raw','UTF8')),'hex')
     or p->>'status_sha256' is distinct from
       encode(sha256(convert_to(p->>'status_raw','UTF8')),'hex')
     or p->>'p2_publication_evidence_sha256' is distinct from
       encode(sha256(convert_to(p->>'p2_publication_evidence_raw','UTF8')),'hex')
     or p->>'p3_publication_evidence_sha256' is distinct from
       encode(sha256(convert_to(p->>'p3_publication_evidence_raw','UTF8')),'hex')
     or p->>'status_signature_evidence_sha256' is distinct from
       encode(sha256(convert_to(p->>'status_signature_evidence_raw','UTF8')),'hex')
     or p->>'independent_review_sha256' is distinct from
       encode(sha256(convert_to(p->>'independent_review_raw','UTF8')),'hex')
     or p->>'p3_publication_evidence_blob_sha1' is distinct from encode(digest(
          convert_to('blob '||octet_length(convert_to(p->>'p3_publication_evidence_raw','UTF8'))::text,'UTF8') ||
          decode('00','hex') || convert_to(p->>'p3_publication_evidence_raw','UTF8'),'sha1'),'hex')
     or p->>'independent_review_blob_sha1' is distinct from encode(digest(
          convert_to('blob '||octet_length(convert_to(p->>'independent_review_raw','UTF8'))::text,'UTF8') ||
          decode('00','hex') || convert_to(p->>'independent_review_raw','UTF8'),'sha1'),'hex')
     or p->>'p2_publication_evidence_sha256' is distinct from expected_p2_evidence_sha
     or p->>'p3_publication_evidence_sha256' is distinct from expected_p3_evidence_sha
     or p->>'status_signature_evidence_sha256' is distinct from expected_status_signature_sha
     or p->>'independent_review_sha256' is distinct from expected_review_sha
  then raise exception 'exact_raw_sha_mismatch'; end if;

  new_controller := p->>'controller_sha256';
  new_qualification := p->>'controller_qualification_sha256';
  new_acceptance := p->>'acceptance_sha256';
  status_sha := p->>'status_sha256';
  status_payload_sha := p->>'status_signed_payload_sha256';
  status := (p->>'status_raw')::jsonb;
  qualification := (p->>'controller_qualification_raw')::jsonb;
  acceptance := (p->>'acceptance_raw')::jsonb;
  p2 := (p->>'p2_publication_evidence_raw')::jsonb;
  p3 := (p->>'p3_publication_evidence_raw')::jsonb;
  review := (p->>'independent_review_raw')::jsonb;
  sig := (p->>'status_signature_evidence_raw')::jsonb;
  correction := p->'correction_evidence';
  correction_sha := encode(sha256(convert_to(correction::text,'UTF8')),'hex');

  if new_controller=old_controller or new_qualification=old_qualification
     or new_acceptance=old_acceptance
     or new_qualification!~'^[0-9a-f]{64}$' or new_acceptance!~'^[0-9a-f]{64}$'
     or status_sha!~'^[0-9a-f]{64}$' or status_payload_sha!~'^[0-9a-f]{64}$'
     or status_sha=status_payload_sha
  then raise exception 'fresh_replacement_digest_domains_required'; end if;

  -- P2 exact Owner publication: the final ten-file Stage2 v3 overlay and every
  -- artifact consumed by this CAS are pinned independently of summary booleans.
  if p2->>'state' is distinct from 'VERIFIED_POSTBUDGET_STAGE2_OWNER_MERGE'
     or p2->>'repository' is distinct from 'tdoljyj/cross-memory-system'
     or p2->'pull_request' is distinct from '177'::jsonb
     or p2->'merge'->>'sha' is distinct from expected_p2_merge
     or p2->'merge'->>'tree' is distinct from expected_p2_tree
     or p2->'merge'->'parents' is distinct from
          '["251b3b7eed1d9d3149c73f4b17dedda8aea7bfa5","64e8dec1549af469cf4647df8a3aa3945b76a3e6"]'::jsonb
     or p2->'merge'->>'first_parent' is distinct from '251b3b7eed1d9d3149c73f4b17dedda8aea7bfa5'
     or p2->'merge'->>'source_parent' is distinct from '64e8dec1549af469cf4647df8a3aa3945b76a3e6'
     or p2->'merge'->>'source_tree' is distinct from expected_p2_tree
     or p2->'merge'->>'author_login' is distinct from 'tdoljyj'
     or p2->'merge'->>'merged_by' is distinct from 'tdoljyj'
     or p2->'merge'->>'committer_login' is distinct from 'web-flow'
     or p2->'merge'->>'base_ref' is distinct from 'main'
     or p2->'merge'->'pull_request_count' is distinct from '1'::jsonb
     or p2->'merge'->'verification'->>'reason' is distinct from 'valid'
     or p2->'merge'->'verification'->'verified' is distinct from 'true'::jsonb
     or p2->'merge'->>'merged_at' is distinct from '2026-09-14T09:42:42Z'
     or p2->'controller'->>'generation_id' is distinct from root9
     or p2->'controller'->'file_count' is distinct from '23'::jsonb
     or p2->'controller'->'manifest_ref'->>'sha256' is distinct from controller_manifest_sha
     or p2->'controller'->'dynamic_signing_ref'->>'sha256' is distinct from dynamic_signing_sha
     or p2->'artifacts'->'controller_qualification'->>'path' is distinct from
          'work/recovery-root9/postbudget-stage2/ControllerQualification.root9.postbudget.candidate.json'
     or p2->'artifacts'->'controller_qualification'->'ref'->>'sha256' is distinct from new_qualification
     or p2->'artifacts'->'runtime_acceptance'->>'path' is distinct from
          'work/recovery-root9/postbudget-stage2/RuntimeAcceptance.root9.postbudget.json'
     or p2->'artifacts'->'runtime_acceptance'->'ref'->>'sha256' is distinct from new_acceptance
     or p2->'artifacts'->'status27_signing_payload'->>'path' is distinct from
          'work/recovery-root9/postbudget-stage2/Status27SigningPayload.json'
     or p2->'artifacts'->'status27_signing_payload'->'ref'->>'sha256' is distinct from status_signing_raw_sha
     or p2->'artifacts'->'status27_signing_payload'->>'signed_payload_sha256' is distinct from status_payload_sha
     or p2->'artifacts'->'build_ga'->>'path' is distinct from 'work/ga-readiness/build-ga.mjs'
     or p2->'artifacts'->'build_ga'->'ref'->>'sha256' is distinct from
          '998e92f41cbe8a04d7205606a0ca883e06a8fdf663457e35b4dc370b9e0ed322'
     or p2->'budget_inheritance' is distinct from jsonb_build_object(
          'sequence',102,
          'uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102',
          'sha256',budget_sha,'seconds',600,'evidence_bytes',134217728,
          'automatic_refund',false,'inherited',true,'new_allocation',false,
          'second_budget_allocation',false)
  then raise exception 'exact_p2_owner_source_publication_required'; end if;

  -- P3 exact Owner artifact publication, cross-bound to P2 and every new digest.
  if p3->>'state' is distinct from 'VERIFIED_POSTBUDGET_CAS_P3_OWNER_MERGE'
     or p3->>'repository' is distinct from 'tdoljyj/cross-memory-system'
     or p3->'pull_request' is distinct from to_jsonb(expected_p3_pr)
     or p3->'merge'->>'sha' is distinct from expected_p3_merge
     or p3->'merge'->>'tree' is distinct from expected_p3_tree
     or p3->'merge'->'parents' is distinct from jsonb_build_array(expected_p2_merge,expected_p3_source)
     or p3->'merge'->>'first_parent' is distinct from expected_p2_merge
     or p3->'merge'->>'source_parent' is distinct from expected_p3_source
     or p3->'merge'->>'source_tree' is distinct from expected_p3_tree
     or p3->'merge'->>'author_login' is distinct from 'tdoljyj'
     or p3->'merge'->>'merged_by' is distinct from 'tdoljyj'
     or p3->'merge'->>'committer_login' is distinct from 'web-flow'
     or p3->'merge'->>'base_ref' is distinct from 'main'
     or p3->'merge'->'pull_request_count' is distinct from '1'::jsonb
     or p3->'merge'->'verification'->'verified' is distinct from 'true'::jsonb
     or p3->'merge'->'verification'->>'reason' is distinct from 'valid'
     or p3->'p2_publication_ref'->>'sha256' is distinct from p->>'p2_publication_evidence_sha256'
     or p3->'controller_manifest_ref'->>'sha256' is distinct from new_controller
     or p3->'controller_qualification_ref'->>'sha256' is distinct from new_qualification
     or p3->'runtime_acceptance_ref'->>'sha256' is distinct from new_acceptance
     or p3->'status_signing_payload_ref'->>'sha256' is distinct from status_signing_raw_sha
     or p3->>'status_signed_payload_sha256' is distinct from status_payload_sha
     or p3->'status_signature_evidence_ref'->>'path' is distinct from
          'work/recovery-root9/postbudget-cas-p3/Status27SignatureEvidence.json'
     or p3->'status_signature_evidence_ref'->>'sha256' is distinct from
          p->>'status_signature_evidence_sha256'
     or p3->'status_signature_evidence_ref'->>'blob_sha1' is distinct from
          '023bc9a616e1454eefe374cc67412e2a3d15976d'
     or p3->'status27_full_ref'->>'path' is distinct from
          'work/recovery-root9/postbudget-cas-p3/Status27Generation.json'
     or p3->'status27_full_ref'->>'sha256' is distinct from status_sha
     or p3->'status27_full_ref'->>'blob_sha1' is distinct from
          'a4702980f8685a6d169a751c7fde6725a32613c3'
  then raise exception 'exact_p3_owner_artifact_publication_required'; end if;

  if review->>'state' is distinct from 'PASS_NO_BLOCKERS'
     or review->>'independent_reviewer' is distinct from '/root/postbudget_p1_review'
     or review->'fresh_context' is distinct from 'true'::jsonb
     or review->>'authority_effect' is distinct from 'NONE'
     or review->'live_writes' is distinct from '0'::jsonb
     or coalesce(review->'blockers','0'::jsonb)<>'0'::jsonb
     or coalesce(review->'majors','0'::jsonb)<>'0'::jsonb
     or coalesce(review->'minors','0'::jsonb)<>'0'::jsonb
     or review->'reviewed_targets'->>'controller_sha256' is distinct from new_controller
     or review->'reviewed_targets'->>'qualification_sha256' is distinct from new_qualification
     or review->'reviewed_targets'->>'runtime_acceptance_sha256' is distinct from new_acceptance
     or review->'reviewed_targets'->>'status_sha256' is distinct from status_sha
     or review->'reviewed_targets'->>'p2_publication_sha256' is distinct from p->>'p2_publication_evidence_sha256'
     or review->'reviewed_targets'->>'p3_publication_sha256' is distinct from p->>'p3_publication_evidence_sha256'
  then raise exception 'independent_pass_required_before_write'; end if;

  status_ref := jsonb_build_object(
    'uri','control://status-manifests/'||(status->>'status_manifest_id'),
    'sha256',status_sha);
  inheritance := jsonb_build_object(
    'budget_sequence',102,
    'budget_reservation_ref',jsonb_build_object(
      'uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102',
      'sha256',budget_sha),
    'original_controller_sha256',old_controller,
    'replacement_controller_sha256',new_controller,
    'root_generation',root9,
    'profile_sha256',profile_sha,
    'scope_sha256',scope_sha,
    'runner_generation',runner_generation,
    'credential_generation',credential_generation,
    'session_generation',session_generation,
    'reason','POST_BUDGET_ROOT9_DYNAMIC_SIGNING_REPAIR',
    'additional_allocation',false,
    'automatic_refund',false,
    'remaining_seconds',600,
    'remaining_evidence_bytes',134217728);

  if status->>'object_type' is distinct from 'StatusManifest'
     or status->'generation' is distinct from '27'::jsonb
     or status->>'control_trust_root_generation' is distinct from root9
     or status->>'schema_digest' is distinct from status_schema_sha
     or (status->>'expires_at')::timestamptz is distinct from window_expires_at
     or status->'observations'->>'controller_digest' is distinct from new_controller
     or status->'observations'->>'root_generation' is distinct from root9
     or status->'observations'->>'runner_generation' is distinct from runner_generation
     or status->'observations'->>'credential_generation' is distinct from credential_generation
     or status->'observations'->>'session_generation' is distinct from session_generation
     or status->'signature_binding'->>'owner_merge_commit' is distinct from expected_p2_merge
     or status->'signature_binding'->>'signed_object_sha256' is distinct from status_payload_sha
     or status->'signature_binding'->'signature_evidence_ref'->>'sha256'
          is distinct from p->>'status_signature_evidence_sha256'
  then raise exception 'exact_complete_status27_required'; end if;

  if sig->>'state' is distinct from 'P2_OWNER_MERGE_BOUND_VERIFIED'
     or sig->>'repository' is distinct from 'tdoljyj/cross-memory-system'
     or sig->>'issuer_purpose' is distinct from 'STATUS'
     or sig->>'audience' is distinct from
          'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw'
     or sig->>'control_trust_root_generation' is distinct from root9
     or sig->'merge' is distinct from p2->'merge'
     or sig->'payload'->>'path' is distinct from
          'work/recovery-root9/postbudget-stage2/Status27SigningPayload.json'
     or sig->'payload'->>'blob_sha1' is distinct from '1816ca696f55bd8d4b182d1edd4d5e2d912f5705'
     or sig->'payload'->>'raw_sha256' is distinct from status_signing_raw_sha
     or sig->'payload'->>'signed_object_sha256' is distinct from status_payload_sha
     or sig->'bound_refs'->'p2_publication_evidence'->>'sha256' is distinct from
          p->>'p2_publication_evidence_sha256'
     or sig->'bound_refs'->'controller_manifest'->>'sha256' is distinct from new_controller
     or sig->'bound_refs'->'controller_qualification'->>'sha256' is distinct from new_qualification
     or sig->'bound_refs'->'runtime_acceptance'->>'sha256' is distinct from new_acceptance
     or sig->>'authority_effect' is distinct from 'NONE'
     or sig->'database_writes' is distinct from '0'::jsonb
  then raise exception 'exact_status27_signature_evidence_required'; end if;

  if qualification->>'state' is distinct from 'ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION'
     or qualification->>'controller_digest' is distinct from new_controller
     or qualification->>'scope_digest' is distinct from scope_sha
     or qualification->>'environment' is distinct from 'ISOLATED_TEST'
     or qualification->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
     or qualification->>'generation_id' is distinct from root9
     or qualification->'controller_source_manifest_ref'->>'sha256' is distinct from new_controller
  then raise exception 'exact_new_root9_controller_qualification_required'; end if;

  if acceptance->>'state' is distinct from 'ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'
     or acceptance->>'controller_digest' is distinct from new_controller
     or acceptance->>'scope_digest' is distinct from scope_sha
     or acceptance->>'environment' is distinct from 'ISOLATED_TEST'
     or acceptance->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
     or acceptance->'accepted_subject'->>'root_id' is distinct from root
     or acceptance->'accepted_subject'->'expected_ga'->>'control_trust_root_generation' is distinct from root9
     or acceptance->'accepted_subject'->'expected_ga'->>'controller_digest' is distinct from new_controller
     or acceptance->'accepted_subject'->'expected_ga'->'controller_qualification_ref'->>'sha256' is distinct from new_qualification
     or acceptance->'accepted_subject'->'expected_ga'->>'runner_generation' is distinct from runner_generation
     or acceptance->'accepted_subject'->'expected_ga'->>'credential_generation' is distinct from credential_generation
     or acceptance->'accepted_subject'->'expected_ga'->>'session_generation' is distinct from session_generation
     or acceptance->'accepted_subject'->'late_bound_fields'->'status_manifest_ref'->>'signed_payload_sha256'
          is distinct from status_payload_sha
     or acceptance->'accepted_subject'->'expected_ga'->'budget_reservation_ref' is not null
     or acceptance->'accepted_subject'->'late_bound_fields'->'budget_reservation_ref' is distinct from
          jsonb_build_object('resolver','CURRENT_EXACT_EXECUTION_BUDGET_EVENT_V1',
                             'maximum_seconds',600,'maximum_evidence_bytes',134217728)
     or acceptance->'root9_binding' is distinct from jsonb_build_object(
          'generation',root9,
          'root_authority_ref',jsonb_build_object(
            'uri','urn:clued:control-trust-root-set:uscrdifznmlvczcekqpw:'||root,
            'sha256','7483e3d240b270d7ad49d9262c63bd49ae0290db08c1dec66aa0de2f239eab60'),
          'root_publication_candidate_ref',jsonb_build_object(
            'uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/9f36e78ce6d3b95d48bc082317548c4abeda143e',
            'sha256','956975e5131aaf858dc06bc7923e0186416740d82db64363af6103e7f69f94e1'),
          'controller_qualification',jsonb_build_object(
            'ref',jsonb_build_object(
              'uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/7ed2fcfa163b98a041403531e718ce37119495b7',
              'sha256',new_qualification),
            'publication',jsonb_build_object(
              'state','PENDING_POSTBUDGET_STAGE2_OWNER_MERGE',
              'resolver','ACTUAL_RUNTIME_AND_SOURCE_MANIFEST_OWNER_MERGE_V1',
              'predecessor_merge_sha','251b3b7eed1d9d3149c73f4b17dedda8aea7bfa5',
              'artifactPath','work/recovery-root9/postbudget-stage2/ControllerQualification.root9.postbudget.candidate.json')),
          'm2_owner_merge_commit','0ae9f5f29cc97982ef30f36fd8efbd67c521e5fd',
          'status27_signing_payload_ref',jsonb_build_object(
            'uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/1816ca696f55bd8d4b182d1edd4d5e2d912f5705',
            'sha256',status_signing_raw_sha),
          'status27_signed_payload_sha256',status_payload_sha,
          'postbudget_source_owner_merge_commit','251b3b7eed1d9d3149c73f4b17dedda8aea7bfa5',
          'root9_generation_unchanged',true,
          'inherited_pending_budget',jsonb_build_object(
            'sequence',102,
            'uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102',
            'sha256',budget_sha,'seconds',600,'evidence_bytes',134217728,
            'automatic_refund',false,'inherited',true,'new_allocation',false,
            'second_budget_allocation',false))
  then raise exception 'exact_new_root9_runtime_acceptance_required'; end if;

  if jsonb_typeof(correction)<>'object'
     or (select array_agg(k order by k) from jsonb_object_keys(correction) k) is distinct from
          array['authority_effect','controller_file_count','defect_code','independent_review_ref','new_controller_sha256','new_qualification_sha256','new_runtime_acceptance_sha256','p2_publication_ref','p3_publication_ref','pending_budget_inheritance','required_repair_refs','status_manifest_ref']::text[]
     or correction->>'defect_code' is distinct from 'ROOT9_DYNAMIC_SIGNING_HELPER_NOT_MANIFEST_COVERED'
     or correction->'controller_file_count' is distinct from '23'::jsonb
     or correction->>'new_controller_sha256' is distinct from new_controller
     or correction->>'new_qualification_sha256' is distinct from new_qualification
     or correction->>'new_runtime_acceptance_sha256' is distinct from new_acceptance
     or correction->'status_manifest_ref' is distinct from status_ref
     or correction->'pending_budget_inheritance' is distinct from inheritance
     or jsonb_typeof(correction->'required_repair_refs') is distinct from 'array'
     or jsonb_array_length(correction->'required_repair_refs')<>8
     or correction->'required_repair_refs' is distinct from
          (select e.request->'body'->'evidence'->'required_repair_refs'
             from clued_control.execution_events e
            where e.root_id=root and e.sequence=100)
     or correction->'p2_publication_ref' is distinct from jsonb_build_object(
          'uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/bfc65714f9b596c6140c745948185e92665a48dd',
          'sha256',p->>'p2_publication_evidence_sha256')
     or (select array_agg(k order by k) from jsonb_object_keys(correction->'p3_publication_ref') k)
          is distinct from array['sha256','uri']::text[]
     or correction->'p3_publication_ref'->>'sha256' is distinct from p->>'p3_publication_evidence_sha256'
     or correction->'p3_publication_ref'->>'uri' is distinct from
          'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'||(p->>'p3_publication_evidence_blob_sha1')
     or (select array_agg(k order by k) from jsonb_object_keys(correction->'independent_review_ref') k)
          is distinct from array['sha256','uri']::text[]
     or correction->'independent_review_ref'->>'sha256' is distinct from p->>'independent_review_sha256'
     or correction->'independent_review_ref'->>'uri' is distinct from
          'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'||(p->>'independent_review_blob_sha1')
     or correction->>'authority_effect' is distinct from 'NONE'
  then raise exception 'exact_postbudget_correction_evidence_required'; end if;

  old_binding := jsonb_build_object(
    'root_id',root,'profile_sha256',profile_sha,'controller_sha256',old_controller,
    'qualification_sha256',old_qualification,'scope_sha256',scope_sha,
    'gate_id','G-PREENTRY-SKILL-QUALIFICATION',
    'gate_version','fixed-synthetic-20260910.v10-env-order-repair',
    'gate_sha256',gate_sha,'runtime_acceptance_sha256',old_acceptance,
    'prior_seconds',1506,'prior_evidence_bytes',322546611);
  new_binding := old_binding || jsonb_build_object(
    'controller_sha256',new_controller,
    'qualification_sha256',new_qualification,
    'runtime_acceptance_sha256',new_acceptance);
  q_req := jsonb_build_object(
    'operation','SUCCESSOR_BINDING_QUALIFICATION_CORRECTED',
    'body',jsonb_build_object('binding_id',bid,'supersedes_execution_sequence',100,
                              'status_manifest_ref',status_ref,'evidence',correction,
                              'evidence_sha256',correction_sha));
  r_req := jsonb_build_object(
    'operation','EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED',
    'body',jsonb_build_object(
      'binding_id',bid,'supersedes_execution_sequence',101,
      'qualification_correction_sequence',103,
      'previous_binding',old_binding,
      'previous_binding_sha256',encode(sha256(convert_to(old_binding::text,'UTF8')),'hex'),
      'new_binding',new_binding,
      'new_binding_sha256',encode(sha256(convert_to(new_binding::text,'UTF8')),'hex'),
      'old_runtime_acceptance_sha256',old_acceptance,
      'new_runtime_acceptance_sha256',new_acceptance,
      'acceptance_raw',p->>'acceptance_raw',
      'acceptance_sha256',new_acceptance,
      'qualified_evidence',correction,
      'pending_budget_inheritance',inheritance));

  -- Lock in the same root -> execution order used by deployed writers.
  select * into h from clued_control.current_head where root_id=root for share;
  select * into c from clued_control.execution_current where root_id=root for update;

  -- Pin every live routine used directly or transitively by this transaction.
  -- This is inside the write transaction and before any status/event mutation.
  select encode(sha256(convert_to(pg_get_functiondef(
    'clued_control.append_status_manifest(text,text)'::regprocedure),'UTF8')),'hex') into catalog_sha;
  if catalog_sha is distinct from '1a75b3b9ecfec1d2fe5c700124544d323506fa16e35a99be7c1dc5c3c1ec6280'
  then raise exception 'append_status_manifest_source_drift'; end if;
  select encode(sha256(convert_to(pg_get_functiondef(
    'clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex') into catalog_sha;
  if catalog_sha is distinct from '9d8278d9845cffab99624d0ab70d592e2398d8d6a906d608ce5bdd0b14d2e7a1'
  then raise exception 'effective_execution_binding_source_drift'; end if;
  select encode(sha256(convert_to(pg_get_functiondef(
    'clued_control.effective_execution_window()'::regprocedure),'UTF8')),'hex') into catalog_sha;
  if catalog_sha is distinct from 'c1531b643ae7ac19079def01664133b236e35b1ba47c10b5a14c321f7131c09f'
  then raise exception 'effective_execution_window_source_drift'; end if;
  select encode(sha256(convert_to(pg_get_functiondef(
    'clued_control.read_root(text)'::regprocedure),'UTF8')),'hex') into catalog_sha;
  if catalog_sha is distinct from expected_read_root_function_sha
  then raise exception 'read_root_source_drift'; end if;

  if has_function_privilege('public','clued_control.append_status_manifest(text,text)','EXECUTE')
     or has_function_privilege('anon','clued_control.append_status_manifest(text,text)','EXECUTE')
     or has_function_privilege('authenticated','clued_control.append_status_manifest(text,text)','EXECUTE')
     or not has_function_privilege('service_role','clued_control.append_status_manifest(text,text)','EXECUTE')
     or has_function_privilege('public','clued_control.effective_execution_binding()','EXECUTE')
     or has_function_privilege('anon','clued_control.effective_execution_binding()','EXECUTE')
     or has_function_privilege('authenticated','clued_control.effective_execution_binding()','EXECUTE')
     or not has_function_privilege('service_role','clued_control.effective_execution_binding()','EXECUTE')
     or has_function_privilege('public','clued_control.effective_execution_window()','EXECUTE')
     or has_function_privilege('anon','clued_control.effective_execution_window()','EXECUTE')
     or has_function_privilege('authenticated','clued_control.effective_execution_window()','EXECUTE')
     or not has_function_privilege('service_role','clued_control.effective_execution_window()','EXECUTE')
     or has_function_privilege('public','clued_control.read_root(text)','EXECUTE')
     or has_function_privilege('anon','clued_control.read_root(text)','EXECUTE')
     or has_function_privilege('authenticated','clued_control.read_root(text)','EXECUTE')
     or not has_function_privilege('service_role','clued_control.read_root(text)','EXECUTE')
  then raise exception 'dependent_function_acl_drift'; end if;

  select encode(sha256(convert_to(coalesce(jsonb_agg(
    jsonb_build_array(c.relname,t.tgname,pg_get_triggerdef(t.oid,true))
    order by c.relname,t.tgname),'[]'::jsonb)::text,'UTF8')),'hex') into catalog_sha
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='clued_control' and not t.tgisinternal
    and c.relname in ('control_objects','execution_events','execution_current');
  if catalog_sha is distinct from expected_target_trigger_defs_sha
  then raise exception 'target_trigger_definition_drift'; end if;

  select encode(sha256(convert_to(coalesce(jsonb_agg(
    jsonb_build_array(c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid,true))
    order by c.conrelid::regclass::text,c.conname),'[]'::jsonb)::text,'UTF8')),'hex') into catalog_sha
  from pg_constraint c join pg_namespace n on n.oid=c.connamespace
  where n.nspname='clued_control'
    and c.conrelid in ('clued_control.control_objects'::regclass,
                       'clued_control.execution_events'::regclass,
                       'clued_control.execution_current'::regclass);
  if catalog_sha is distinct from expected_target_constraints_sha
  then raise exception 'target_constraint_definition_drift'; end if;

  select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) order by e.sequence),
    '[]'::jsonb)::text,'UTF8')),'hex') into catalog_sha
  from clued_control.events e where e.root_id=root and e.sequence between 1 and 9;
  if catalog_sha is distinct from expected_root_prefix_sha
  then raise exception 'immutable_root_prefix_drift'; end if;
  select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) order by e.sequence),
    '[]'::jsonb)::text,'UTF8')),'hex') into catalog_sha
  from clued_control.execution_events e where e.root_id=root and e.sequence between 1 and 102;
  if catalog_sha is distinct from expected_execution_prefix_sha
  then raise exception 'immutable_execution_prefix_drift'; end if;
  select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(a) order by a.ga_id),
    '[]'::jsonb)::text,'UTF8')),'hex') into catalog_sha
  from clued_control.gate_attempts a where a.root_id=root;
  if catalog_sha is distinct from expected_attempts_sha
  then raise exception 'immutable_attempts_drift'; end if;
  select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) order by s.binding_id),
    '[]'::jsonb)::text,'UTF8')),'hex') into catalog_sha
  from clued_control.successor_binding s where s.root_id=root;
  if catalog_sha is distinct from expected_successors_sha
  then raise exception 'immutable_successors_drift'; end if;
  select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(o)
    order by o.object_type,o.generation,o.uri),'[]'::jsonb)::text,'UTF8')),'hex') into catalog_sha
  from clued_control.control_objects o where o.root_id=root
   and not (o.object_type='StatusManifest' and o.generation>26);
  if catalog_sha is distinct from expected_control_objects_prefix_sha
  then raise exception 'immutable_control_object_prefix_drift'; end if;

  select * into q_old from clued_control.execution_events where root_id=root and idempotency_key=q_idem;
  select * into r_old from clued_control.execution_events where root_id=root and idempotency_key=r_idem;

  -- Unknown/lost response replay.  Only the complete exact postimage is DUPLICATE.
  if q_old.sequence is not null or r_old.sequence is not null then
    select * into b from clued_control.effective_execution_binding();
    select * into status_row from clued_control.control_objects
      where root_id=root and object_type='StatusManifest' and generation=27;
    if q_old.sequence is not distinct from 103 and r_old.sequence is not distinct from 104
       and h.sequence is not distinct from 9 and h.generation_id is not distinct from root9
       and h.revoked is not distinct from false
       and c.sequence is not distinct from 104
       and c.pending_budget_sequence is not distinct from 102 and c.active_ga_id is null
       and c.charged_seconds is not distinct from 11106
       and c.charged_evidence_bytes is not distinct from 2470030259
       and c.runner_generation is not distinct from runner_generation
       and c.credential_generation is not distinct from credential_generation
       and c.session_generation is not distinct from session_generation
       and q_old.request is not distinct from q_req
       and r_old.request is not distinct from r_req
       and status_row.raw is not distinct from p->>'status_raw'
       and status_row.sha256 is not distinct from status_sha
       and to_jsonb(b) is not distinct from new_binding
       and (select count(*) from clued_control.events x where x.root_id=root)=9
       and (select count(*) from clued_control.execution_events x where x.root_id=root)=104
       and (select count(*) from clued_control.gate_attempts x where x.root_id=root)=14
       and (select count(*) from clued_control.execution_events x where x.root_id=root and x.sequence>44 and x.request->>'operation'='BUDGET_RESERVED')=10
       and (select count(*) from clued_control.execution_events x where x.root_id=root and x.sequence>44 and x.request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')=17
       and (select count(*) from clued_control.control_objects x where x.root_id=root and x.object_type='StatusManifest' and x.generation>26)=1
    then raise notice 'ROOT9_POSTBUDGET_DUPLICATE_EXACT_POSTIMAGE'; return; end if;
    raise exception 'root9_postbudget_replay_conflict';
  end if;

  -- Exact seq102 live preimage, including the one and only remaining allocation.
  if h.sequence is distinct from 9 or h.generation_id is distinct from root9
     or h.revoked is distinct from false
     or c.sequence is distinct from 102 or c.pending_budget_sequence is distinct from 102
     or c.active_ga_id is not null
     or c.charged_seconds is distinct from 11106
     or c.charged_evidence_bytes is distinct from 2470030259
     or c.runner_generation is distinct from runner_generation
     or c.credential_generation is distinct from credential_generation
     or c.session_generation is distinct from session_generation
     or (select count(*) from clued_control.events x where x.root_id=root)<>9
     or (select count(*) from clued_control.execution_events x where x.root_id=root)<>102
     or (select count(*) from clued_control.gate_attempts x where x.root_id=root)<>14
     or (select count(*) from clued_control.execution_events x where x.root_id=root and x.sequence>44 and x.request->>'operation'='BUDGET_RESERVED')<>10
     or (select count(*) from clued_control.execution_events x where x.root_id=root and x.sequence>44 and x.request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')<>17
     or exists(select 1 from clued_control.execution_events x where x.root_id=root and x.sequence in (103,104))
     or exists(select 1 from clued_control.control_objects x where x.root_id=root and x.object_type='StatusManifest' and x.generation>26)
     or clock_timestamp()<window_not_before
     or clock_timestamp()+interval '600 seconds'>=window_expires_at
  then raise exception 'exact_root9_seq102_pending_preimage_required'; end if;

  select * into budget from clued_control.execution_events where root_id=root and sequence=102;
  if not found or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
     or budget.idempotency_key is distinct from 'root9_final_skill_qualification_budget_v1'
     or budget.request->'body'->>'sha256' is distinct from budget_sha
     or encode(sha256(convert_to(budget.request->'body'->>'raw','UTF8')),'hex') is distinct from budget_sha
  then raise exception 'exact_committed_budget102_required'; end if;
  budget_raw := (budget.request->'body'->>'raw')::jsonb;
  if budget_raw->>'root_generation' is distinct from root9
     or budget_raw->>'controller_digest' is distinct from old_controller
     or budget_raw->>'profile_digest' is distinct from profile_sha
     or budget_raw->>'scope_digest' is distinct from scope_sha
     or budget_raw->'seconds' is distinct from '600'::jsonb
     or budget_raw->'evidence_bytes' is distinct from '134217728'::jsonb
     or budget_raw->>'runner_generation' is distinct from c.runner_generation
     or budget_raw->>'credential_generation' is distinct from c.credential_generation
     or budget_raw->>'session_generation' is distinct from c.session_generation
  then raise exception 'exact_budget102_scope_required'; end if;

  select * into b from clued_control.effective_execution_binding();
  if to_jsonb(b) is distinct from old_binding then raise exception 'exact_old_effective_binding_required'; end if;
  select * into s from clued_control.successor_binding where binding_id=bid;
  if not found or s.root_id is distinct from root or s.generation_id is distinct from root9
     or s.controller_sha256 is distinct from old_controller
     or s.qualification_sha256 is distinct from old_qualification
     or s.status_schema_sha256 is distinct from status_schema_sha
     or s.binding_sha256 is distinct from 'd3c597a2425343bb6fb897e4a6eaddd76cb73adf282a8cd07187e23a527cd76e'
  then raise exception 'exact_immutable_root9_successor_required'; end if;

  status_result := clued_control.append_status_manifest(p->>'status_raw',status_sha);
  if status_result->>'status' is distinct from 'STORED_NO_AUTHORITY'
  then raise exception 'status27_store_failed'; end if;

  insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
  values(root,103,q_idem,q_req),(root,104,r_idem,r_req);
  update clued_control.execution_current set sequence=104
   where root_id=root and sequence=102 and pending_budget_sequence=102
     and active_ga_id is null and charged_seconds=11106
     and charged_evidence_bytes=2470030259;
  if not found then raise exception 'root9_postbudget_final_cas_lost'; end if;

  -- Same-transaction postimage.  Note that pending and charges are only predicates,
  -- never SET targets, so the already paid allocation is preserved byte-for-byte.
  select * into c from clued_control.execution_current where root_id=root;
  select * into b from clued_control.effective_execution_binding();
  if c.sequence is distinct from 104 or c.pending_budget_sequence is distinct from 102
     or c.active_ga_id is not null
     or c.charged_seconds is distinct from 11106
     or c.charged_evidence_bytes is distinct from 2470030259
     or to_jsonb(b) is distinct from new_binding
     or (select count(*) from clued_control.events x where x.root_id=root)<>9
     or (select count(*) from clued_control.execution_events x where x.root_id=root)<>104
     or (select count(*) from clued_control.gate_attempts x where x.root_id=root)<>14
     or (select count(*) from clued_control.execution_events x where x.root_id=root and x.sequence>44 and x.request->>'operation'='BUDGET_RESERVED')<>10
     or (select count(*) from clued_control.execution_events x where x.root_id=root and x.sequence>44 and x.request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')<>17
     or (select count(*) from clued_control.control_objects x where x.root_id=root and x.object_type='StatusManifest' and x.generation>26)<>1
     or not exists(select 1 from clued_control.control_objects x where x.root_id=root and x.object_type='StatusManifest' and x.generation=27 and x.sha256=status_sha and x.raw=p->>'status_raw')
  then raise exception 'root9_postbudget_exact_postimage_failed'; end if;

  raise notice 'ROOT9_POSTBUDGET_REPOINTED seq=104 pending_budget=102 charges=11106/2470030259 status=27';
end
$postbudget_root9_cas$;

commit;

-- IMPORTANT: the current reserve_gate() rejects the inherited budget because the
-- immutable seq102 allocation contains old_controller while a new GA must contain
-- new_controller.  Do not call reserve_gate until a separately reviewed narrow
-- consumer recognizes the exact seq104.pending_budget_inheritance object above.
