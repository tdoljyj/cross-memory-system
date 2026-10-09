-- Numbered DatasetSplit installation migration. Applying it installs the fixed
-- constants, Binding-protected RPC EXECUTE ACLs and Native action catalog below.
-- It issues no Owner Grant or Canonical projection; existing readers are unchanged.
create or replace function clued_private.model_domain_bootstrap_adoption_constant_candidate() returns jsonb language sql immutable set search_path='' as $$ select $M2JSON${"canonical_record_id":"b8c1d482-9eb4-4bc5-8dd1-372b0d55174e","record_version":1,"canonical_scope":"project:0597aa60-9b98-4da6-a4ab-63d7705b632f","record_content_sha256":"b58db4fe2cc81c123f078aeff789fcc9fe971902321ffd36a9e3ebaa1af477eb","canonical_receipt_id":"45a657d9-ba34-437e-b17c-2d792ce5c692","quote_evidence_id":"1257e89f-d6b6-4015-8712-0bab340cc1b4","quote_sha256":"905819e2e3a059a02087855e9f326d05c877c1767ec31dc012c5c44652840230","quote_size_bytes":6,"effect":"OWNER_BASELINE_ADOPTION_ONLY"}$M2JSON$::jsonb $$;
revoke all on function clued_private.model_domain_bootstrap_adoption_constant_candidate() from public,anon,authenticated,service_role;
create or replace function clued_private.model_domain_bootstrap_recognizer_constant_candidate() returns jsonb language sql immutable set search_path='' as $$ select $M2JSON${"role":"OWNER","effect":"FINAL_RECOGNIZER_DESIGNATION_AND_NON_PRODUCTION_PREPARATION_ONLY","subject":{"version":"v0.1","definition_id":"clued.model-program.DatasetSplit","definition_sha256":"f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77","instance_schema_sha256":"062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f"},"owner_subject_id":null,"production_enabled":false,"domain_permission_granted":false,"authenticated_identity_status":"NOT_EXPOSED_BY_CURRENT_MCP"}$M2JSON$::jsonb $$;
revoke all on function clued_private.model_domain_bootstrap_recognizer_constant_candidate() from public,anon,authenticated,service_role;

-- Exact immutable proposal bytes. Installation does not approve or execute it.
create or replace function clued_private.model_domain_bootstrap_exact_plan_candidate()
returns jsonb language sql immutable set search_path='' as $BIND$
 select $PLANJSON${"source_resource":"repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json","source_sha256":"fc83a4a1f69de07d6de9dea5e879f1498b1b8f288ba3f9b8fba11d979de110ea","raw_utf8":"{\n  \"schema\": \"clued.model-dataset-split-bootstrap-exact/1\",\n  \"canonical_scope\": \"project:0597aa60-9b98-4da6-a4ab-63d7705b632f\",\n  \"task_id\": \"1502fd80-8ff8-4adc-b4f5-da6d462f4f8a\",\n  \"contract_sha256\": \"d8599ca8148f63a7893133ad3b13426edab25f3f48bc5291b1fb7c038a04754f\",\n  \"authority_registry_sha256\": \"b89bb15a047cd59390428e86d33e8e2fc59d3a83954c68c2393d0e5b3dc4f3cc\",\n  \"max_uses\": 1,\n  \"max_window_seconds\": 3600,\n  \"subject\": {\n    \"definition_id\": \"clued.model-program.DatasetSplit\",\n    \"version\": \"v0.1\",\n    \"definition_sha256\": \"f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77\",\n    \"instance_schema_sha256\": \"062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f\"\n  },\n  \"mutation_roles\": [\n    {\n      \"role\": \"producer\",\n      \"operation\": \"create\",\n      \"record_type\": \"state\",\n      \"authority\": \"user_explicit\",\n      \"identity_not_persisted\": true\n    },\n    {\n      \"role\": \"permission\",\n      \"operation\": \"create\",\n      \"record_type\": \"decision\",\n      \"authority\": \"user_explicit\",\n      \"identity_not_persisted\": true\n    },\n    {\n      \"role\": \"recognition\",\n      \"operation\": \"create\",\n      \"record_type\": \"state\",\n      \"authority\": \"observed\",\n      \"identity_not_persisted\": true\n    }\n  ],\n  \"targets\": {\n    \"producer_record_id\": \"36f0b1f1-3352-4a0a-abab-011b39164143\",\n    \"permission_record_id\": \"adfb0f98-c415-42a5-944c-c5fc91af0fc6\",\n    \"recognition_record_id\": \"1f443b83-e612-4bec-84ea-b5f2e0e22eb5\"\n  },\n  \"owner_anchor_refs\": {\n    \"owner_adoption_server_ref\": {\n      \"id\": \"b8c1d482-9eb4-4bc5-8dd1-372b0d55174e\",\n      \"version\": 1,\n      \"content_hash\": \"b58db4fe2cc81c123f078aeff789fcc9fe971902321ffd36a9e3ebaa1af477eb\"\n    },\n    \"final_recognizer_server_ref\": {\n      \"id\": \"46b0ff1c-f608-4ff9-89b9-dc90a61ce70f\",\n      \"version\": 1,\n      \"content_hash\": \"74fb324321a23eaa4dbc7194b9ec9964a9e1d59d1ef12e6c6f3c7dfce6b91329\"\n    }\n  },\n  \"idempotency_key\": \"model-bootstrap-1b397478-b792-4d73-864b-cee9af714052\"\n}\n"}$PLANJSON$::jsonb
$BIND$;
revoke all on function clued_private.model_domain_bootstrap_exact_plan_candidate()
 from public,anon,authenticated,service_role;

create or replace function clued_private.model_domain_bootstrap_claim_candidate(
 p_token_hash text,p_binding public.clued_agent_bindings,p_targets uuid[]
) returns jsonb language plpgsql volatile security definer set search_path='' as $CLAIM$
declare c clued_private.work_claims_v1; admission jsonb; paths jsonb;
 s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
 task constant uuid:='1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
begin
 if cardinality(p_targets) is distinct from 3 then raise exception 'BOOTSTRAP_THREE_TARGETS_REQUIRED' using errcode='42501'; end if;
 select * into c from clued_private.work_claims_v1 w where w.user_id=p_binding.user_id
  and w.task_id=task and w.context_key=s and w.holder_binding_id=p_binding.id
  and w.status='ACTIVE' and w.expires_at>clock_timestamp() and w.hard_deadline_at>clock_timestamp()
  and w.copy_index is null for update;
 if not found then raise exception 'BOOTSTRAP_CURRENT_OWN_TASK_CLAIM_REQUIRED' using errcode='42501'; end if;
 select jsonb_agg('record:'||x::text) into paths from unnest(p_targets) x;
 admission:=public.clued_work_verify_v1(p_token_hash,jsonb_build_object('scope',s,'claim_id',c.claim_id,'changed_paths',paths));
 if admission->>'verdict' is distinct from 'ADMITTED' or
    admission->>'current_fence' is distinct from c.fence::text or
    c.status is distinct from 'ACTIVE' or clock_timestamp()>=c.expires_at
 then raise exception 'BOOTSTRAP_TASK_FENCE_OR_WRITE_SET_NOT_ADMITTED' using errcode='42501'; end if;
 if not exists(select 1 from public.clued_memories m where m.id=task and m.user_id=p_binding.user_id
   and m.record_type='task' and m.lifecycle_status='active' and m.canonical_scope=s
   and clued_private.record_currentness_fence(p_binding.user_id,m.id,array[s])='CURRENT')
 then raise exception 'BOOTSTRAP_TASK_NOT_CURRENT_ACTIVE' using errcode='42501'; end if;
 return jsonb_build_object('claim_id',c.claim_id,'fence',c.fence);
end $CLAIM$;
revoke all on function clued_private.model_domain_bootstrap_claim_candidate(text,public.clued_agent_bindings,uuid[])
 from public,anon,authenticated,service_role;

-- Installation candidate. Invokes only existing M1 under independent exact Native permission.
-- No automatic grant, model permission, training, DataGate or Kernel authority.
-- Native write action is separate from every read-only source grant. No new
-- authorization table, local Receipt or direct Canonical row INSERT is used.
create or replace function public.clued_model_dataset_split_bootstrap_commit_candidate(
 p_token_hash text,p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
 task constant uuid:='1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
 v_action constant text:='model.dataset_split.bootstrap';
 contract_hash constant text:='d8599ca8148f63a7893133ad3b13426edab25f3f48bc5291b1fb7c038a04754f';
 registry_hash constant text:='b89bb15a047cd59390428e86d33e8e2fc59d3a83954c68c2393d0e5b3dc4f3cc';
 subject constant jsonb:='{"definition_id":"clued.model-program.DatasetSplit","version":"v0.1","definition_sha256":"f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77","instance_schema_sha256":"062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f"}';
 identity constant jsonb:='{"source":"NATIVE_GRANTEE_AND_M1_RECEIPT_EVENT_ACTOR","identity_not_persisted":true}';
 b public.clued_agent_bindings; final_b public.clued_agent_bindings;
 g clued_private.owner_grants_v1; t clued_private.native_confirmation_tokens; nr public.clued_audit_receipts;
 m public.clued_memories; own public.clued_memories; designation public.clued_memories;
 rr public.clued_audit_receipts; ev public.clued_context_events;
 expected_resources text[]; candidate_resources text[]; ids uuid[]; anchor jsonb; k text; n integer;
 approved_native boolean:=false; consumed jsonb; result jsonb; input jsonb; fields jsonb;
 producer_ref jsonb; permission_ref jsonb; recognition_ref jsonb; source_binding jsonb;
 receipt_ids jsonb:='[]'; event_ids jsonb:='[]'; refs jsonb:='[]'; now_at timestamptz;
 expected_targets jsonb; key text; new_record_id uuid; source_fingerprint jsonb;
 adoption jsonb; recognizer_fields jsonb; installed_plan jsonb; plan jsonb; expected_role_policy jsonb;
 owner_proof jsonb; claim_proof jsonb;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or
    (select array_agg(x order by x) from jsonb_object_keys(p_input) x) is distinct from
      array['final_recognizer_server_ref','idempotency_key','immutable_plan_resource','owner_adoption_server_ref','permission_record_id','producer_record_id','recognition_record_id']::text[]
 then raise exception 'BOOTSTRAP_EXACT_CREATE_INPUT_REQUIRED' using errcode='22023'; end if;
 foreach k in array array['owner_adoption_server_ref','final_recognizer_server_ref'] loop
  anchor:=p_input->k;
  if jsonb_typeof(anchor) is distinct from 'object' or
     (select array_agg(x order by x) from jsonb_object_keys(anchor) x) is distinct from array['content_hash','id','version']::text[] or
     coalesce(anchor->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
     anchor->'version' is distinct from '1'::jsonb or coalesce(anchor->>'content_hash','') !~ '^[0-9a-f]{64}$'
  then raise exception 'BOOTSTRAP_EXACT_OWNER_REF_REQUIRED' using errcode='22023'; end if;
 end loop;
 if p_input->'owner_adoption_server_ref'->>'id' is distinct from 'b8c1d482-9eb4-4bc5-8dd1-372b0d55174e' or
    p_input->'final_recognizer_server_ref'->>'id' is distinct from '46b0ff1c-f608-4ff9-89b9-dc90a61ce70f' or
    coalesce(p_input->>'immutable_plan_resource','') !~ '^repo:tdoljyj/cross-memory-system/[0-9a-f]{40}/development/contracts/model-program/stage-admission/[A-Za-z0-9_.-]+\.json$' or
    jsonb_typeof(p_input->'idempotency_key') is distinct from 'string' or
    char_length(p_input->>'idempotency_key') not between 8 and 100
 then raise exception 'BOOTSTRAP_FIXED_OWNER_PLAN_OR_KEY_REQUIRED' using errcode='22023'; end if;
 ids:='{}';
 foreach k in array array['producer_record_id','permission_record_id','recognition_record_id'] loop
  if jsonb_typeof(p_input->k) is distinct from 'string' or coalesce(p_input->>k,'') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'BOOTSTRAP_CREATE_ID_REQUIRED' using errcode='22023'; end if;
  ids:=ids||(p_input->>k)::uuid;
 end loop;
 if (select count(distinct x) from unnest(ids) x)<>3 or
    (p_input->'owner_adoption_server_ref'->>'id')::uuid=any(ids) or
    (p_input->'final_recognizer_server_ref'->>'id')::uuid=any(ids)
 then raise exception 'BOOTSTRAP_DISTINCT_CREATE_TARGETS_REQUIRED' using errcode='22023'; end if;
 b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',s,'write');
 if b.user_id=any(ids) or b.id=any(ids)
 then raise exception 'BOOTSTRAP_TARGET_MUST_NOT_BE_PRIVATE_PRINCIPAL' using errcode='42501'; end if;
 -- Lock ordering follows the existing M1 + Owner stores. Both locks last for
 -- this one transaction; Native revocation/use cannot race the three writes.
 perform clued_private.work_claim_lock(b.user_id);
 perform clued_private.owner_grant_lock_v1(b.user_id);
 expected_resources:=array[
   'record:'||(p_input->'owner_adoption_server_ref'->>'id')||'@1#'||(p_input->'owner_adoption_server_ref'->>'content_hash'),
   'record:'||(p_input->'final_recognizer_server_ref'->>'id')||'@1#'||(p_input->'final_recognizer_server_ref'->>'content_hash'),
   'record:'||ids[1]::text,'record:'||ids[2]::text,'record:'||ids[3]::text,p_input->>'immutable_plan_resource'];
 select array_agg(x order by x) into expected_resources from unnest(expected_resources) x;
 if not exists(select 1 from clued_private.owner_grant_actions a where a.action=v_action and 'model-domain-bootstrap'=any(a.doors))
 then raise exception 'REAL_NATIVE_BOOTSTRAP_ACTION_NOT_REGISTERED' using errcode='42501'; end if;
 now_at:=clock_timestamp();
 select count(*) into n from clued_private.owner_grants_v1 x where x.user_id=b.user_id and x.grantee_binding_id=b.id and x.task_id=task and x.action=v_action
   and x.revoked_at is null and x.granted_at<=now_at and now_at<x.expires_at and x.expires_at-x.granted_at<=interval '1 hour'
   and x.max_uses=1 and x.uses=0 and (select array_agg(v order by v) from unnest(x.resources) v)=expected_resources;
 if n<>1 then raise exception 'EXACT_SINGLE_USE_NATIVE_BOOTSTRAP_WRITE_GRANT_REQUIRED' using errcode='42501'; end if;
 select * into strict g from clued_private.owner_grants_v1 x where x.user_id=b.user_id and x.grantee_binding_id=b.id and x.task_id=task and x.action=v_action
   and x.revoked_at is null and x.granted_at<=now_at and now_at<x.expires_at and x.expires_at-x.granted_at<=interval '1 hour'
   and x.max_uses=1 and x.uses=0 and (select array_agg(v order by v) from unnest(x.resources) v)=expected_resources for update;
 select * into t from clued_private.native_confirmation_tokens x where x.id=g.token_id and x.user_id=b.user_id;
 if not found then raise exception 'REAL_NATIVE_CONFIRMATION_SOURCE_REQUIRED' using errcode='42501'; end if;
 select * into nr from public.clued_audit_receipts x where x.id=g.receipt_id and x.user_id=b.user_id;
 if not found then raise exception 'REAL_NATIVE_CONFIRMATION_RECEIPT_REQUIRED' using errcode='42501'; end if;
 select array_agg(v order by v) into candidate_resources from jsonb_array_elements_text(t.native_choices->'resources') v;
 -- Do not demand M1 committed/status fields on owner_grant: this existing
 -- operation uses the legacy audit Receipt shape. Native consumed outcome,
 -- exact confirmation choices and OWNER_GRANT_GIVEN provenance are the proof.
 approved_native:=t.action='owner_grant' and t.consume_outcome='committed' and t.consumed_at is not null
   and t.consumed_receipt_id=g.receipt_id and t.session_id is not null and t.session_id=g.granted_session_id
   and t.consumed_at<=t.expires_at and t.native_choices->>'action'=v_action
   and t.native_choices->>'task_id'=task::text and t.native_choices->>'grantee_binding_id'=b.id::text
   and t.native_choices->>'max_uses'='1' and clued_private.m1_sha256(t.confirmation_view)=t.view_digest
   and extract(epoch from (g.expires_at-g.granted_at))=(t.native_choices->>'expires_seconds')::numeric
   and candidate_resources=expected_resources and nr.operation='owner_grant' and nr.binding_id is null
   and nr.metadata->>'receipt_kind'='OWNER_GRANT_GIVEN' and nr.metadata->>'principal'='native_account_session'
   and nr.metadata->>'token_id'=t.id::text and nr.metadata->>'view_digest'=t.view_digest and nr.metadata->>'session_id'=t.session_id
   and nr.metadata->'choices'=t.native_choices;
 if approved_native is distinct from true then raise exception 'NATIVE_APPROVAL_NOT_CURRENT_EXACT_OWNER_INTENT' using errcode='42501'; end if;
 -- Exact plan identity/content is trusted deployment code, never a caller
 -- claim. The deployed constant must match the frozen original UTF-8 bytes.
 installed_plan:=clued_private.model_domain_bootstrap_exact_plan_candidate();
 if jsonb_typeof(installed_plan->'raw_utf8') is distinct from 'string' or
    jsonb_typeof(installed_plan->'source_resource') is distinct from 'string' or
    jsonb_typeof(installed_plan->'source_sha256') is distinct from 'string'
 then raise exception 'MODEL_DOMAIN_EXACT_PLAN_NOT_INSTALLED' using errcode='42501'; end if;
 if installed_plan->>'source_resource' is distinct from 'repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json' or
    installed_plan->>'source_sha256' is distinct from 'fc83a4a1f69de07d6de9dea5e879f1498b1b8f288ba3f9b8fba11d979de110ea' or
    installed_plan->>'source_resource' is distinct from p_input->>'immutable_plan_resource' or
    coalesce(installed_plan->>'source_sha256','') !~ '^[0-9a-f]{64}$' or
    encode(extensions.digest(convert_to(installed_plan->>'raw_utf8','UTF8'),'sha256'),'hex') is distinct from installed_plan->>'source_sha256'
 then raise exception 'MODEL_DOMAIN_EXACT_PLAN_ARTIFACT_BINDING_INVALID' using errcode='42501'; end if;
 plan:=(installed_plan->>'raw_utf8')::jsonb;
 expected_role_policy:='[{"role":"producer","operation":"create","record_type":"state","authority":"user_explicit","identity_not_persisted":true},{"role":"permission","operation":"create","record_type":"decision","authority":"user_explicit","identity_not_persisted":true},{"role":"recognition","operation":"create","record_type":"state","authority":"observed","identity_not_persisted":true}]'::jsonb;
 if jsonb_typeof(plan) is distinct from 'object' or
    (select array_agg(x order by x) from jsonb_object_keys(plan) x) is distinct from
      array['authority_registry_sha256','canonical_scope','contract_sha256','idempotency_key','max_uses','max_window_seconds','mutation_roles','owner_anchor_refs','schema','subject','targets','task_id']::text[] or
    plan->>'schema' is distinct from 'clued.model-dataset-split-bootstrap-exact/1' or
    plan->>'canonical_scope' is distinct from s or plan->>'task_id' is distinct from task::text or
    plan->>'contract_sha256' is distinct from contract_hash or plan->>'authority_registry_sha256' is distinct from registry_hash or
    plan->'subject' is distinct from subject or plan->'mutation_roles' is distinct from expected_role_policy or
    plan->>'idempotency_key' is distinct from p_input->>'idempotency_key' or
    plan->'targets' is distinct from jsonb_build_object('producer_record_id',ids[1],'permission_record_id',ids[2],'recognition_record_id',ids[3]) or
    plan->'owner_anchor_refs' is distinct from jsonb_build_object('owner_adoption_server_ref',p_input->'owner_adoption_server_ref','final_recognizer_server_ref',p_input->'final_recognizer_server_ref') or
    plan->'max_uses' is distinct from '1'::jsonb or plan->'max_window_seconds' is distinct from '3600'::jsonb
 then raise exception 'MODEL_DOMAIN_EXACT_PLAN_INPUT_ROLE_WINDOW_MISMATCH' using errcode='42501'; end if;
 claim_proof:=clued_private.model_domain_bootstrap_claim_candidate(p_token_hash,b,ids);
 -- Only now are any Canonical target rows read. Owner adoption/designation
 -- still do NOT grant domain permission; the independent Native write does.
 select * into own from public.clued_memories x where x.user_id=b.user_id and x.id='b8c1d482-9eb4-4bc5-8dd1-372b0d55174e';
 select * into designation from public.clued_memories x where x.user_id=b.user_id and x.id='46b0ff1c-f608-4ff9-89b9-dc90a61ce70f';
 adoption:=clued_private.model_domain_bootstrap_adoption_constant_candidate();
 recognizer_fields:=clued_private.model_domain_bootstrap_recognizer_constant_candidate();
 -- Those generated constants are exact copied contract objects, not caller
 -- metadata. Their installation is part of this candidate source closure.
 if own.id is null or designation.id is null or own.version is distinct from 1 or designation.version is distinct from 1 or
    own.record_schema_version is distinct from 1 or designation.record_schema_version is distinct from 1 or
    own.record_type is distinct from 'decision' or designation.record_type is distinct from 'decision' or
    own.authority is distinct from 'user_explicit' or designation.authority is distinct from 'user_explicit' or
    own.canonical_scope is distinct from s or designation.canonical_scope is distinct from s or
    own.lifecycle_status is distinct from 'active' or designation.lifecycle_status is distinct from 'active' or
    own.receipt_id is distinct from '45a657d9-ba34-437e-b17c-2d792ce5c692'::uuid or designation.receipt_id is distinct from '4c9b9066-5146-4bd5-9e5d-8660624fdecb'::uuid or
    own.content_hash is distinct from p_input->'owner_adoption_server_ref'->>'content_hash' or
    designation.content_hash is distinct from p_input->'final_recognizer_server_ref'->>'content_hash' or
    own.content_hash is distinct from adoption->>'record_content_sha256' or
    designation.content_hash is distinct from '74fb324321a23eaa4dbc7194b9ec9964a9e1d59d1ef12e6c6f3c7dfce6b91329' or
    designation.type_fields->'model_final_recognizer' is distinct from recognizer_fields or
    clued_private.record_currentness_fence(b.user_id,own.id,array[s]) is distinct from 'CURRENT' or
    clued_private.record_currentness_fence(b.user_id,designation.id,array[s]) is distinct from 'CURRENT'
 then raise exception 'OWNER_FULL_CONTRACT_OR_LEGACY_SERVER_REF_UNRESOLVED' using errcode='42501'; end if;
 -- Validate full hashes with the genuine server algorithm. No body-SHA alias.
 owner_proof:=jsonb_build_object('adoption',clued_private.model_domain_owner_chain_successor(b,own),
   'designation',clued_private.model_domain_owner_chain_successor(b,designation));
 source_fingerprint:=jsonb_build_object('adoption',to_jsonb(own),'designation',to_jsonb(designation),'proof',owner_proof);
 if exists(select 1 from public.clued_memories x where x.user_id=b.user_id and x.id=any(ids)) then
   raise exception 'BOOTSTRAP_CREATE_TARGET_ALREADY_EXISTS_NO_REPLAY' using errcode='42501'; end if;
 consumed:=clued_private.owner_grant_consume_v1(b.user_id,b.id,v_action,expected_resources,task);
 if consumed->>'grant_id' is distinct from g.id::text or consumed->>'use' is distinct from '1'
 then raise exception 'EXACT_NATIVE_BOOTSTRAP_USE_NOT_CONSUMED' using errcode='42501'; end if;
 for n in 1..3 loop
  final_b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',s,'write');
  now_at:=clock_timestamp();
  if final_b.id is distinct from b.id or final_b.user_id is distinct from b.user_id or now_at<g.granted_at or now_at>=g.expires_at
  then raise exception 'BOOTSTRAP_BINDING_OR_NATIVE_WINDOW_CHANGED' using errcode='42501'; end if;
  if n=1 then
   fields:=jsonb_build_object('state_kind','model_dataset_split_domain_producer','identity_binding',identity,
    'domain_producer',jsonb_build_object('service','clued-cloud/supabase','role','EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE','domain_owner','MODEL PROGRAM','environment','NON_PRODUCTION','authority_registry_sha256',registry_hash));
  elsif n=2 then
   fields:=jsonb_build_object('rationale','Exact independent Native bootstrap write approval; prior adoption/designation do not grant domain permission.','identity_binding',identity,
    'domain_permission',jsonb_build_object('status','active','revoked_at',null,'not_before',to_char(g.granted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'expires_at',to_char(g.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'action','DatasetSplit.definition.recognize','effect','NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY',
      'environment','NON_PRODUCTION','canonical_scope',s,'subject',subject,'producer_registration_ref',producer_ref));
  else
   fields:=jsonb_build_object('state_kind','model_dataset_split_domain_recognition','identity_binding',identity,
    'domain_recognition',jsonb_build_object('contract_id','clued.model-program.DatasetSplitDomainRecognition','contract_version','v0.1-candidate','contract_sha256',contract_hash,
      'subject',subject,'owner_adoption',adoption,'permission_record_ref',permission_ref,'producer_registration_ref',producer_ref,
      'producer',jsonb_build_object('service','clued-cloud/supabase'),'effect','NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY'),
    'owner_source_bindings',jsonb_build_object('owner_adoption_server_ref',p_input->'owner_adoption_server_ref','final_recognizer_server_ref',p_input->'final_recognizer_server_ref','hash_binding','ORIGINAL_EXACT_SERVER_HASH_GUARD_NO_BODY_HASH_FALLBACK'));
  end if;
  new_record_id:=ids[n];key:=(p_input->>'idempotency_key')||':'||n::text;
  input:=jsonb_build_object('operation','create','id',new_record_id,'scope',s,'record_type',case when n=2 then 'decision' else 'state' end,
   'record_schema_version',1,'lifecycle_status','active','base_version',null,'authority',case when n=3 then 'observed' else 'user_explicit' end,
   'user_confirmed',case when n=3 then false else approved_native end,'idempotency_key',key,'source_refs','[]'::jsonb,
   'source_unavailable_reason','Protected Native Grant and Canonical Record/Receipt refs are not Evidence IDs; exact bindings retained in typed fields.',
   'confidence_reason','Registered fixed non-production model-domain producer; authority derived from real protected Native confirmation.',
   'mutation',jsonb_build_object('title','DatasetSplit v0.1 Native source projection','content','Fixed non-production DatasetSplit definition source projection. Actor identity is retained only in real M1 Receipt/Event and normalized privately.','type_fields',fields,'relations','{}'::jsonb));
  -- Call the genuine public M1 entry, preserving every current wrapper. The
  -- three invocations remain within this same PostgreSQL outer transaction.
  result:=public.clued_record_mutate(p_token_hash,input);
  if result->>'status' is distinct from 'committed' or coalesce((result->>'replayed')::boolean,false) then
   raise exception 'M1_BOOTSTRAP_REJECTED_FAILED_OR_UNEXPECTED_REPLAY' using errcode='42501'; end if;
  select * into m from public.clued_memories x where x.user_id=b.user_id and x.id=new_record_id;
  select * into rr from public.clued_audit_receipts x where x.user_id=b.user_id and x.id=(result->>'receipt_id')::uuid;
  expected_targets:=jsonb_build_array(jsonb_build_object('id',new_record_id,'kind','record','role','primary'));
  if m.id is null or m.version is distinct from 1 or m.receipt_id is distinct from rr.id or rr.status is distinct from 'committed' or
     rr.operation_family is distinct from 'record_mutation' or rr.binding_id is distinct from b.id or rr.target_refs is distinct from expected_targets or
     rr.committed_versions is distinct from jsonb_build_object(new_record_id::text,1) or cardinality(rr.event_ids) is distinct from 1
  then raise exception 'BOOTSTRAP_M1_RECEIPT_TARGET_VERSION_INVALID' using errcode='42501'; end if;
  select * into ev from public.clued_context_events x where x.user_id=b.user_id and x.id::text=rr.event_ids[1];
  if ev.id is null or ev.receipt_id is distinct from rr.id or ev.event_scope is distinct from s or ev.target_refs is distinct from expected_targets or
     ev.result is distinct from 'success' or ev.canonical_event_type is distinct from 'record_created' or
     ev.actor_user_id is distinct from b.user_id or ev.actor_binding_ref is distinct from b.id::text or
     rr.canonical_version is null or rr.canonical_version<=0 or ev.committed_canonical_version is distinct from rr.canonical_version
  then raise exception 'BOOTSTRAP_M1_EVENT_ACTOR_TRANSACTION_INVALID' using errcode='42501'; end if;
  perform clued_private.model_domain_normalize_row_successor(b,m);
  if clued_private.model_domain_bootstrap_claim_candidate(p_token_hash,b,ids) is distinct from claim_proof
  then raise exception 'BOOTSTRAP_CLAIM_CHANGED_DURING_WRITE' using errcode='42501'; end if;
  anchor:=jsonb_build_object('id',m.id,'version',m.version,'content_hash',m.content_hash);
  if n=1 then producer_ref:=anchor;elsif n=2 then permission_ref:=anchor;else recognition_ref:=anchor;end if;
  refs:=refs||jsonb_build_array(anchor);receipt_ids:=receipt_ids||jsonb_build_array(rr.id);event_ids:=event_ids||jsonb_build_array(rr.event_ids[1]);
 end loop;
 select * into own from public.clued_memories x where x.user_id=b.user_id and x.id='b8c1d482-9eb4-4bc5-8dd1-372b0d55174e';
 select * into designation from public.clued_memories x where x.user_id=b.user_id and x.id='46b0ff1c-f608-4ff9-89b9-dc90a61ce70f';
 owner_proof:=jsonb_build_object('adoption',clued_private.model_domain_owner_chain_successor(b,own),
   'designation',clued_private.model_domain_owner_chain_successor(b,designation));
 if jsonb_build_object('adoption',to_jsonb(own),'designation',to_jsonb(designation),'proof',owner_proof) is distinct from source_fingerprint
 then raise exception 'OWNER_SOURCES_CHANGED_DURING_ATOMIC_WRITE' using errcode='42501'; end if;
 final_b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',s,'write');now_at:=clock_timestamp();
 if final_b.id is distinct from b.id or final_b.user_id is distinct from b.user_id or now_at>=g.expires_at or
    clued_private.record_currentness_fence(b.user_id,own.id,array[s]) is distinct from 'CURRENT' or
    clued_private.record_currentness_fence(b.user_id,designation.id,array[s]) is distinct from 'CURRENT'
 then raise exception 'FINAL_BOOTSTRAP_AUTHORITY_OR_CURRENTNESS_INVALID' using errcode='42501'; end if;
 -- No exception catcher: any failed postcondition rolls back the Native use,
 -- all three M1 Records, Events and Receipts in the same outer transaction.
 -- A successful duplicate request is refused once its one grant is consumed;
 -- callers inspect original Receipt IDs, never auto-retry or create new keys.
 return jsonb_build_object('status','COMMITTED_NON_PRODUCTION_M1_DEFINITION_PROJECTIONS_ONLY','actual_execution','CANONICAL_RECORD_MUTATION',
  'producer_record_ref',producer_ref,'permission_record_ref',permission_ref,'recognition_record_ref',recognition_ref,
  'canonical_receipt_ids',receipt_ids,'canonical_event_ids',event_ids,'evaluated_at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'domain_authority_receipt','NOT_KERNEL_RECEIPT','data_gate','NOT_ISSUED','m2_verdict','NOT_ISSUED','training_or_data_use_authorized',false,'private_actor_fields_exposed',false);
end $$;
revoke all on function public.clued_model_dataset_split_bootstrap_commit_candidate(text,jsonb)
 from public,anon,authenticated,service_role;

-- Readiness is a neutral fixed-selector read; it neither creates nor consumes any grant.
create or replace function public.clued_model_dataset_split_bootstrap_readiness_candidate(
 p_token_hash text,p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $READY$
declare b public.clued_agent_bindings; after_b public.clued_agent_bindings;
 own public.clued_memories; designation public.clued_memories; fingerprint jsonb; final_fingerprint jsonb;
 installed jsonb; plan jsonb; proof jsonb; refs jsonb; now_at timestamptz;
 s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
begin
 if p_input is distinct from '{}'::jsonb then raise exception 'BOOTSTRAP_READINESS_NO_CALLER_SELECTORS' using errcode='22023'; end if;
 b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
 perform clued_private.currentness_user_lock(b.user_id);
 installed:=clued_private.model_domain_bootstrap_exact_plan_candidate();
 if installed->>'source_resource' is distinct from 'repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json' or
    installed->>'source_sha256' is distinct from 'fc83a4a1f69de07d6de9dea5e879f1498b1b8f288ba3f9b8fba11d979de110ea' or
    jsonb_typeof(installed->'raw_utf8') is distinct from 'string' or
    encode(extensions.digest(convert_to(installed->>'raw_utf8','UTF8'),'sha256'),'hex') is distinct from installed->>'source_sha256'
 then raise exception 'BOOTSTRAP_READINESS_EXACT_PLAN_NOT_INSTALLED' using errcode='42501'; end if;
 plan:=(installed->>'raw_utf8')::jsonb;
 select * into own from public.clued_memories m where m.user_id=b.user_id and m.id='b8c1d482-9eb4-4bc5-8dd1-372b0d55174e';
 select * into designation from public.clued_memories m where m.user_id=b.user_id and m.id='46b0ff1c-f608-4ff9-89b9-dc90a61ce70f';
 if own.id is null or designation.id is null or own.version is distinct from 1 or designation.version is distinct from 1 or
    own.receipt_id is distinct from '45a657d9-ba34-437e-b17c-2d792ce5c692'::uuid or
    designation.receipt_id is distinct from '4c9b9066-5146-4bd5-9e5d-8660624fdecb'::uuid or
    own.content_hash is distinct from plan->'owner_anchor_refs'->'owner_adoption_server_ref'->>'content_hash' or
    designation.content_hash is distinct from plan->'owner_anchor_refs'->'final_recognizer_server_ref'->>'content_hash' or
    designation.type_fields->'model_final_recognizer' is distinct from clued_private.model_domain_bootstrap_recognizer_constant_candidate()
 then raise exception 'BOOTSTRAP_READINESS_FIXED_OWNER_SOURCES_NOT_CURRENT' using errcode='42501'; end if;
 proof:=jsonb_build_object('adoption',clued_private.model_domain_owner_chain_successor(b,own),
  'designation',clued_private.model_domain_owner_chain_successor(b,designation));
 fingerprint:=jsonb_build_object('adoption',to_jsonb(own),'designation',to_jsonb(designation),'proof',proof);
 after_b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
 select * into own from public.clued_memories m where m.user_id=after_b.user_id and m.id='b8c1d482-9eb4-4bc5-8dd1-372b0d55174e';
 select * into designation from public.clued_memories m where m.user_id=after_b.user_id and m.id='46b0ff1c-f608-4ff9-89b9-dc90a61ce70f';
 proof:=jsonb_build_object('adoption',clued_private.model_domain_owner_chain_successor(after_b,own),
  'designation',clued_private.model_domain_owner_chain_successor(after_b,designation));
 final_fingerprint:=jsonb_build_object('adoption',to_jsonb(own),'designation',to_jsonb(designation),'proof',proof);
 if after_b.id is distinct from b.id or after_b.user_id is distinct from b.user_id or final_fingerprint is distinct from fingerprint or
    clued_private.model_domain_bootstrap_exact_plan_candidate() is distinct from installed
 then raise exception 'BOOTSTRAP_READINESS_SOURCE_CHANGED' using errcode='42501'; end if;
 perform clued_private.resolve_binding(p_token_hash,'context:read',s);
 now_at:=clock_timestamp();
 return jsonb_build_object('status','FIXED_OWNER_CHAIN_AND_PLAN_READINESS_ONLY',
  'owner_adoption_server_ref',plan->'owner_anchor_refs'->'owner_adoption_server_ref',
  'final_recognizer_server_ref',plan->'owner_anchor_refs'->'final_recognizer_server_ref',
  'immutable_plan_resource',installed->>'source_resource','plan_sha256',installed->>'source_sha256',
  'max_uses',1,'max_window_seconds',3600,'evaluated_at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'bootstrap_write_authorized',false,'domain_permission','NOT_GRANTED','m2_verdict','NOT_ISSUED','private_actor_fields_exposed',false);
end $READY$;
revoke all on function public.clued_model_dataset_split_bootstrap_readiness_candidate(text,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.clued_model_dataset_split_bootstrap_readiness_candidate(text,jsonb),
 public.clued_model_dataset_split_bootstrap_commit_candidate(text,jsonb) to anon;

-- This numbered migration registers the high-risk Native write action.
-- MCP feature flags gate Worker routes only; direct RPCs still require the
-- same Binding, exact single-use Native grant and current Task claim.
-- The existing grant engine may select a broader covering grant first; the
-- exact-ID postcondition then fails and rolls back, never borrowing that grant.
-- Existing model.dataset_split.verify/recognize/producer grants from the
-- read-only source package must NOT be consumed as Canonical write permission.
-- Reuse only the existing Owner Grant/Native confirmation storage and engine.
insert into clued_private.owner_grant_actions(action,doors,title,risk) values
 ('model.dataset_split.bootstrap',array['model-domain-bootstrap'],
  '一次创建指定的非生产DatasetSplit生产者、权限投影与认定记录：固定Owner来源、三目标ID和真实Native确认；不授权Kernel/M2/训练',
  'high');
-- The RPC EXECUTE ACLs above are installed; no Owner Grants, producer
-- registrations or Canonical source records are created by this migration.
-- Native approval remains external, exact, single-use and at most one hour.
