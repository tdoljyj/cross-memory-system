-- UNINSTALLED narrow existing-M1 read. No action catalog, authority issuer,
-- Profile mutation, Native approval, claim, model, Record/Event/Receipt write.
create or replace function public.clued_model_reference_owner_approval_refs_candidate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
 task constant text:='1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
 b public.clued_agent_bindings; last_b public.clued_agent_bindings;
 m public.clued_memories; r public.clued_audit_receipts; e public.clued_context_events;
 a jsonb; budget jsonb; ref jsonb; targets jsonb; fingerprint jsonb; initial jsonb;
 calculated text; pass integer; now_at timestamptz; not_before timestamptz; stop_at timestamptz; key text;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or
   (select array_agg(x order by x) from jsonb_object_keys(p_input) x) is distinct from array['approval_binding','receipt_id','record_ref','request_sha256']::text[]
 then raise exception 'EXACT_OWNER_APPROVAL_SOURCE_INPUT_REQUIRED' using errcode='22023'; end if;
 ref:=p_input->'record_ref'; a:=p_input->'approval_binding'; budget:=a->'budget';
 if jsonb_typeof(ref) is distinct from 'object' or
   (select array_agg(x order by x) from jsonb_object_keys(ref) x) is distinct from array['content_hash','id','version']::text[] or
   coalesce(ref->>'id','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or
   jsonb_typeof(ref->'version') is distinct from 'number' or coalesce(ref->>'version','') !~ '^[1-9][0-9]{0,15}$' or
   coalesce(ref->>'content_hash','') !~ '^[0-9a-f]{64}$' or coalesce(p_input->>'request_sha256','') !~ '^[0-9a-f]{64}$' or
   coalesce(p_input->>'receipt_id','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
 then raise exception 'EXACT_SERVER_DECISION_RECEIPT_AND_REQUEST_REFS_REQUIRED' using errcode='22023'; end if;
 if jsonb_typeof(a) is distinct from 'object' or
   (select array_agg(x order by x) from jsonb_object_keys(a) x) is distinct from array['allowed_operations','budget','candidate_role','canonical_scope','confirmation_origin','host_ref','kind','materializer_code_sha256','output_target_ref','parent_boundary','profile_id','prohibited_operations','purpose_id','request_sha256','source_stage','task_id','template_sha256','window']::text[] or
   a->>'kind' is distinct from 'M2_REFERENCE_QUALIFICATION_PROFILE_EXACT_APPROVAL' or a->>'task_id' is distinct from task or
   a->>'canonical_scope' is distinct from s or a->>'purpose_id' is distinct from 'qualification' or a->>'parent_boundary' is distinct from 'QUALIFICATION' or
   a->>'candidate_role' is distinct from 'M2_REFERENCE_BASELINE' or a->>'source_stage' is distinct from 'M1_FIXED_REFERENCE' or
   a->>'confirmation_origin' is distinct from 'OWNER_CURRENT_CONVERSATION_EXACT_REQUEST' or
   a->>'request_sha256' is distinct from p_input->>'request_sha256' or coalesce(a->>'template_sha256','') !~ '^[0-9a-f]{64}$' or
   coalesce(a->>'materializer_code_sha256','') !~ '^[0-9a-f]{64}$' or
   coalesce(a->>'profile_id','') !~ '^M2-REFERENCE-QUALIFICATION-PC-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or
   jsonb_typeof(a->'host_ref') is distinct from 'string' or char_length(a->>'host_ref') not between 1 and 512 or
   jsonb_typeof(a->'output_target_ref') is distinct from 'string' or char_length(a->>'output_target_ref') not between 1 and 512 or
   a->'allowed_operations' is distinct from '["LOCAL_FIXED_M1_REFERENCE_QUALIFICATION_INFERENCE","SAVE_ACTUAL_QUALIFICATION_OUTPUTS","DETERMINISTIC_SCORING_REPLAY_OF_SAVED_ACTUAL_OUTPUTS"]'::jsonb or
   a->'prohibited_operations' is distinct from '["WEIGHT_LEARNING","TRAINING","MODEL_SELECTION_OR_TUNING","QUALIFICATION_FEEDBACK_TO_SELECTION","FINAL_HOLDOUT","PROTECTED48","PUBLIC_OR_SYNTHETIC_GENERATION","OLD_M1_T0_T1_PROFILE_REUSE","INSTALLATION","VM","PRODUCTION","RELEASE"]'::jsonb
 then raise exception 'FIXED_M2_OWNER_EXACT_SEMANTICS_REQUIRED' using errcode='22023'; end if;
 if jsonb_typeof(budget) is distinct from 'object' or
   (select array_agg(x order by x) from jsonb_object_keys(budget) x) is distinct from array['currency','currency_exponent','currency_profile_digest','max_attempts','max_compute','max_concurrency','max_cost_minor_units','max_input_bytes','max_input_tokens','max_output_bytes','max_output_tokens','max_parallel_experiments','max_requests','max_response_bytes','max_storage_bytes','max_total_tokens','max_wall_time','provider_deadline_at']::text[] or
   budget->'max_attempts' is distinct from '1'::jsonb or budget->'max_concurrency' is distinct from '1'::jsonb or
   budget->'max_parallel_experiments' is distinct from '1'::jsonb or budget->'max_cost_minor_units' is distinct from '0'::jsonb or
   budget->>'currency' is distinct from 'USD' or coalesce(budget->>'currency_profile_digest','') !~ '^[0-9a-f]{64}$' or
   jsonb_typeof(budget->'currency_exponent') is distinct from 'number' or coalesce(budget->>'currency_exponent','') !~ '^[0-6]$' or
   jsonb_typeof(budget->'max_compute') is distinct from 'object' or
   (select array_agg(x order by x) from jsonb_object_keys(budget->'max_compute') x) is distinct from array['device_class','max_compute_bytes']::text[] or
   budget->'max_compute'->>'device_class' is distinct from 'PC' or jsonb_typeof(budget->'max_compute'->'max_compute_bytes') is distinct from 'number' or
   coalesce(budget->'max_compute'->>'max_compute_bytes','') !~ '^[1-9][0-9]{0,15}$'
 then raise exception 'EXACT_NON_LEARNING_PC_BUDGET_REQUIRED' using errcode='22023'; end if;
 foreach key in array array['max_input_bytes','max_input_tokens','max_output_bytes','max_output_tokens','max_requests','max_response_bytes','max_storage_bytes','max_total_tokens','max_wall_time'] loop
   if jsonb_typeof(budget->key) is distinct from 'number' or coalesce(budget->>key,'') !~ '^[1-9][0-9]{0,15}$'
   then raise exception 'EXACT_POSITIVE_INTEGER_BUDGET_REQUIRED' using errcode='22023'; end if;
 end loop;
 if jsonb_typeof(a->'window') is distinct from 'object' or
   (select array_agg(x order by x) from jsonb_object_keys(a->'window') x) is distinct from array['not_before','stop_at']::text[] or
   coalesce(a->'window'->>'not_before','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' or
   coalesce(a->'window'->>'stop_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' or
   budget->>'provider_deadline_at' is distinct from a->'window'->>'stop_at'
 then raise exception 'EXACT_TYPED_UTC_OWNER_WINDOW_REQUIRED' using errcode='22023'; end if;
 begin not_before:=(a->'window'->>'not_before')::timestamptz; stop_at:=(a->'window'->>'stop_at')::timestamptz;
 exception when others then raise exception 'EXACT_TYPED_UTC_OWNER_WINDOW_REQUIRED' using errcode='22023'; end;
 if not_before>=stop_at or extract(epoch from(stop_at-not_before))<(budget->>'max_wall_time')::numeric
 then raise exception 'APPROVED_WINDOW_MUST_COVER_BUDGET' using errcode='22023'; end if;

 -- Existing actual token/account/scope/Binding admission BEFORE any Canon row.
 b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
 targets:=jsonb_build_array(jsonb_build_object('id',(ref->>'id')::uuid,'kind','record','role','primary'));
 for pass in 1..2 loop
   now_at:=clock_timestamp();
   if now_at<not_before or now_at>=stop_at then raise exception 'OWNER_EXACT_APPROVAL_WINDOW_NOT_CURRENT' using errcode='42501'; end if;
   select * into m from public.clued_memories x where x.user_id=b.user_id and x.id=(ref->>'id')::uuid;
   if not found or m.record_schema_version is distinct from 1 or m.record_type is distinct from 'decision' or
     m.authority is distinct from 'user_explicit' or m.lifecycle_status is distinct from 'active' or m.canonical_scope is distinct from s or
     to_jsonb(m.version) is distinct from ref->'version' or m.content_hash is distinct from ref->>'content_hash' or
     m.receipt_id is distinct from (p_input->>'receipt_id')::uuid or
     m.type_fields->'experiment_authorization' is distinct from a or
     m.type_fields->'experiment_authorization_state' is distinct from '{"status":"active","revoked_at":null}'::jsonb or
     clued_private.record_currentness_fence(b.user_id,m.id,array[s]) is distinct from 'CURRENT'
   then raise exception 'CURRENT_EXACT_OWNER_M1_DECISION_NOT_AVAILABLE' using errcode='42501'; end if;
   calculated:=clued_private.m1_record_content_hash(m.record_type,m.canonical_scope,m.lifecycle_status,m.title,m.content,m.type_fields,m.relations,
     m.source_refs,m.source_unavailable_reason,m.authority,m.observed_at,m.closed_at,m.confidence,m.confidence_reason);
   if m.content_hash is distinct from calculated or coalesce(calculated,'') !~ '^[0-9a-f]{64}$'
   then raise exception 'OWNER_M1_NORMALIZED_FULL_RECORD_HASH_INVALID' using errcode='42501'; end if;
   select * into r from public.clued_audit_receipts x where x.user_id=b.user_id and x.id=m.receipt_id;
   if not found or r.status is distinct from 'committed' or r.operation_family is distinct from 'record_mutation' or
     r.binding_id is distinct from b.id or r.context_key is distinct from 'm1:record_mutation' or r.target_refs is distinct from targets or
     r.committed_versions is distinct from jsonb_build_object(m.id::text,m.version) or cardinality(r.event_ids) is distinct from 1 or
     r.canonical_version is null or r.canonical_version<=0 or r.canonical_version>9007199254740991
   then raise exception 'OWNER_M1_RECEIPT_ACTOR_TARGET_VERSION_INVALID' using errcode='42501'; end if;
   select * into e from public.clued_context_events x where x.user_id=b.user_id and x.id::text=r.event_ids[1];
   if not found or e.receipt_id is distinct from r.id or e.event_scope is distinct from s or e.target_refs is distinct from targets or
     e.result is distinct from 'success' or coalesce(e.canonical_event_type,'') not in ('record_created','record_updated') or
     e.committed_canonical_version is distinct from r.canonical_version or e.actor_user_id is distinct from b.user_id or
     e.actor_binding_ref is distinct from b.id::text
   then raise exception 'OWNER_M1_EVENT_SCOPE_RECEIPT_ACTOR_INVALID' using errcode='42501'; end if;
   fingerprint:=jsonb_build_object('record',to_jsonb(m),'receipt',to_jsonb(r),'event',to_jsonb(e));
   if pass=1 then initial:=fingerprint;
   elsif fingerprint is distinct from initial then raise exception 'OWNER_APPROVAL_SOURCE_CHANGED_DURING_READ' using errcode='42501'; end if;
   last_b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
   if last_b.id is distinct from b.id or last_b.user_id is distinct from b.user_id
   then raise exception 'OWNER_APPROVAL_BINDING_CHANGED_DURING_READ' using errcode='42501'; end if;
 end loop;
 now_at:=clock_timestamp();
 if now_at<not_before or now_at>=stop_at then raise exception 'OWNER_APPROVAL_EXPIRED_AFTER_FINAL_READ' using errcode='42501'; end if;
 return jsonb_build_object('status','CURRENT_EXACT_OWNER_APPROVAL_REFS_ONLY','approval_record_ref',ref,'receipt_id',r.id,'event_id',e.id::text,
   'canonical_version',r.canonical_version,'request_sha256',p_input->>'request_sha256','template_sha256',a->>'template_sha256',
   'profile_id',a->>'profile_id','source_scope',s,'task_id',task,'evaluated_at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'authority_effect','NONE','actual_execution','NONE','profile_issued',false,'private_actor_fields_exposed',false,'record_body_exposed',false);
end $$;
revoke all on function public.clued_model_reference_owner_approval_refs_candidate(text,jsonb) from public,anon,authenticated,service_role;
-- Intended minimal existing Binding RPC role; candidate script is NOT installed.
grant execute on function public.clued_model_reference_owner_approval_refs_candidate(text,jsonb) to anon;
