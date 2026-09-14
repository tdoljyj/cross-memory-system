CREATE OR REPLACE FUNCTION clued_control.reserve_gate(p_raw text, p_sha text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding; w record;
 c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer; budget clued_control.execution_events; allocation jsonb;
 repoint clued_control.execution_events; correction_event clued_control.execution_events; root9_qualification_event clued_control.execution_events; inherited_budget jsonb; previous_binding jsonb; replacement_binding jsonb; correction_evidence_sha text;
 expected_p3_publication_uri constant text := 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/1b357124369e2f91a6aad24a889d0c22f1ca5599'; expected_p3_publication_sha constant text := '9bb054fe3c7d54ea22fe6db358c919089bb81889fd85b93f3d91786755fb1744';
 expected_review_uri constant text := 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/4a4eb52aa6117c6ade9e00015633cc1f80a22813'; expected_review_sha constant text := 'fa8e0cd3af4a95e544b418a64ab3d0c78a84d4e69b0791e70537d32ae6e9a57a'; expected_correction_evidence_sha constant text := '56e01663ada2b788a937a945da299c4b1a2bc175cda374ec72b0cc58a24e0de0';
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
 series_root9 boolean; series_recovery boolean;
begin
 series_view := clued_control.read_execution();
 series_events := series_view->'events'; series_attempts := series_view->'attempts';
 series_recovery := c.sequence=108
  and c.active_ga_id is null
  and c.pending_budget_sequence=102
  and c.charged_seconds=11106
  and c.charged_evidence_bytes=2470030259
  and exists(
    select 1 from clued_control.gate_attempts ra
    where ra.root_id=root
      and ra.ga_id='ga_4a88b0436cf80beeb5e194c98bb0297e'
      and ra.ga_sha256='50583449ba31202aa5a7cbb908ff82e556baf95bc6a8734c5b8e58890d6d8819'
      and ra.budget_sequence=102 and ra.phase='BLOCKED'
      and ra.container_id is null and not ra.revoked
      and ra.ga->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c'
      and ra.ga->>'controller_digest'='c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a'
      and ra.decision->>'termination_mode'='EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9'
      and ra.receipt_raw is not null
      and encode(sha256(convert_to(ra.receipt_raw,'UTF8')),'hex')=ra.receipt_sha256
      and (ra.receipt_raw::jsonb)->>'result'='BLOCKED'
      and (ra.receipt_raw::jsonb)->>'gate_authorization_id'=ra.ga_id
      and (ra.receipt_raw::jsonb)->>'gate_authorization_sha256'=ra.ga_sha256
      and (ra.receipt_raw::jsonb)->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c'
  );
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
  or ((series_a->>'budget_sequence')::bigint >= 89
       and not (series_recovery and series_a->>'ga_id'='ga_4a88b0436cf80beeb5e194c98bb0297e'
         and series_a->>'ga_sha256'='50583449ba31202aa5a7cbb908ff82e556baf95bc6a8734c5b8e58890d6d8819'
         and (series_a->>'budget_sequence')::bigint=102
         and series_ga->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c'
         and series_ga->>'controller_digest'='c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a'
         and (series_ga->>'deadline')::timestamptz<='2026-09-15T03:00:00Z'::timestamptz)
       and (series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198'
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
  or ((series_a->>'budget_sequence')::bigint >= 89
      and not (series_recovery and series_a->>'ga_id'='ga_4a88b0436cf80beeb5e194c98bb0297e'
        and (series_a->>'budget_sequence')::bigint=102
        and series_receipt->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c')
      and series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198')
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
  if series_n<1
  or not (
    (series_count=series_n-1 and c.pending_budget_sequence is not distinct from series_latest)
    or (series_recovery and series_n=10 and series_latest=102 and series_count=series_n and c.pending_budget_sequence=102)
  ) then raise exception 'series_exact_unconsumed_budget_required'; end if;
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
  'controller_sha256','c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  'qualification_sha256','a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013',
  'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  'gate_id','G-PREENTRY-SKILL-QUALIFICATION','gate_version','fixed-synthetic-20260910.v10-env-order-repair',
  'gate_sha256','3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
  'runtime_acceptance_sha256','c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552',
  'prior_seconds',1506,'prior_evidence_bytes',322546611);
replacement_binding := previous_binding || jsonb_build_object(
  'controller_sha256','9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1',
  'qualification_sha256','3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa',
  'runtime_acceptance_sha256','2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df');
inherited_budget := jsonb_build_object(
  'budget_sequence',102,'budget_reservation_ref',jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102','sha256','51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'),
  'original_controller_sha256','c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b',
  'predecessor_controller_sha256','c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  'replacement_controller_sha256','9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1',
  'root_generation','ctrgen_308a1dfc185cff633892638581e0a34c','profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5','scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  'runner_generation','runnergen_a256855fec9441839105c69b746c5244','credential_generation','credgen_bac92a11e7144a3fb9e67f40a6a07d11','session_generation','sessiongen_ffb02a907d334b0da0b37bf457a758c2',
  'reason','ROOT9_EXACT_PREDISPATCH_BUDGET_INHERITANCE','additional_allocation',false,'automatic_refund',false,'capacity_increase',false,'budget_reassignment',false,'remaining_seconds',600,'remaining_evidence_bytes',134217728);
if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'scope_digest' is distinct from g->>'scope_digest'
 or allocation->>'runner_generation' is distinct from g->>'runner_generation' or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer or start_time<(allocation->>'not_before')::timestamptz or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
 then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;
if allocation->>'controller_digest' is distinct from g->>'controller_digest' then
 select * into correction_event from clued_control.execution_events where root_id=root and sequence=105;
 select * into repoint from clued_control.execution_events where root_id=root and sequence=106;
 correction_evidence_sha:=encode(sha256(convert_to((correction_event.request->'body'->'evidence')::text,'UTF8')),'hex');
 if budget.sequence is distinct from 102 or budget.idempotency_key is distinct from 'root9_final_skill_qualification_budget_v1' or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
 or budget.request->'body'->>'sha256' is distinct from '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'
 or encode(sha256(convert_to(budget.request->'body'->>'raw','UTF8')),'hex') is distinct from '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'
 or allocation->>'controller_digest' is distinct from 'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b'
 or c.sequence is distinct from 108 or c.pending_budget_sequence is distinct from 102 or c.active_ga_id is not null
 or c.charged_seconds is distinct from 11106 or c.charged_evidence_bytes is distinct from 2470030259
 or b.controller_sha256 is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
 or b.qualification_sha256 is distinct from '3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa'
 or b.runtime_acceptance_sha256 is distinct from '2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df'
 or to_jsonb(b) is distinct from replacement_binding
 or g->>'controller_digest' is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
 or g->'controller_qualification_ref'->>'sha256' is distinct from '3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa'
 or g->'status_manifest_ref' is distinct from jsonb_build_object('uri','control://status-manifests/sm_root9_status28_exact_pair_recovery_v1','sha256','4a6dddd73433b51aa1339ae2ebcd08f0d170f71d8ec35e9fb5905efecb3f5944')
 or correction_event.recording_transaction_id is null or correction_event.recording_transaction_id=pg_current_xact_id()
 or correction_event.idempotency_key is distinct from 'root9_exact_pair_successor_v1_qualification' or correction_event.request->>'operation' is distinct from 'SUCCESSOR_BINDING_QUALIFICATION_CORRECTED'
 or correction_event.request->'body'->'supersedes_execution_sequence' is distinct from '103'::jsonb
 or correction_event.request->'body'->>'evidence_sha256' is distinct from correction_evidence_sha
 or correction_event.request->'body'->'evidence'->>'defect_code' is distinct from 'ROOT9_EXPIRED_PREDISPATCH_EXACT_PAIR_SUCCESSOR'
 or correction_event.request->'body'->'evidence'->>'new_controller_sha256' is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
 or correction_event.request->'body'->'evidence'->>'new_qualification_sha256' is distinct from '3197a38e686ec6b8f8ebff0cf8b6344bfd427d7c6e6a0bdb8f157d142fe307aa'
 or correction_event.request->'body'->'evidence'->>'new_runtime_acceptance_sha256' is distinct from '2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df'
 or correction_event.request->'body'->'evidence'->'pending_budget_inheritance' is distinct from inherited_budget
 or jsonb_array_length(correction_event.request->'body'->'evidence'->'required_repair_refs')<>9
 or correction_event.request->'body'->'evidence'->'required_repair_refs'->8 is distinct from jsonb_build_object('budget_sequence',102,'ga_id','ga_4a88b0436cf80beeb5e194c98bb0297e','receipt_sha256','fd1b884641e0752bdf3e5446dfdca5efe2d0f6d0ef27d3a9db201aeb174a772d')
 or repoint.recording_transaction_id is null or repoint.recording_transaction_id=pg_current_xact_id() or repoint.recording_transaction_id is distinct from correction_event.recording_transaction_id
 or repoint.idempotency_key is distinct from 'root9_exact_pair_successor_v1_repoint' or repoint.request->>'operation' is distinct from 'EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'
 or repoint.request->'body'->'supersedes_execution_sequence' is distinct from '104'::jsonb or repoint.request->'body'->'qualification_correction_sequence' is distinct from '105'::jsonb
 or repoint.request->'body'->'previous_binding' is distinct from previous_binding or repoint.request->'body'->'new_binding' is distinct from replacement_binding
 or repoint.request->'body'->>'old_runtime_acceptance_sha256' is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
 or repoint.request->'body'->>'new_runtime_acceptance_sha256' is distinct from '2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df'
 or encode(sha256(convert_to(repoint.request->'body'->>'acceptance_raw','UTF8')),'hex') is distinct from '2231d936ce0dcaeae53b5ae5a2756c50626ab1824d5682ca514ec8b5d66ee1df'
 or repoint.request->'body'->'pending_budget_inheritance' is distinct from inherited_budget
 or repoint.request->'body'->'qualified_evidence' is distinct from correction_event.request->'body'->'evidence'
 then raise exception 'exact_pair_budget_inheritance_binding_mismatch'; end if;
end if;
 insert into clued_control.gate_attempts(root_id,ga_id,idempotency_key,ga_raw,ga_sha256,ga,phase,expires_at,budget_sequence)
 values(root,g->>'gate_authorization_id',g->>'idempotency_key',p_raw,p_sha,g,'PENDING',end_time,budget.sequence);
 update clued_control.execution_current set active_ga_id=g->>'gate_authorization_id',pending_budget_sequence=null where root_id=root;
 return jsonb_build_object('status','RESERVED','ga_id',g->>'gate_authorization_id','authority_effect','NONE');
end $function$
