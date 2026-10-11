-- DRAFT ONLY. Not an accepted Source, production approval or Native Grant.
-- Owner accepted semantic package:
-- d4dada8b43a3dfe95096cf0add78c828827b1e4f25c25cf871e93cef2ef77e1e.
-- Its exact M1 scope record is integrity/history, not Native attestation.
-- The exact Source containing this pin requires separate Owner acceptance.
-- Depends on formally installed 041300; no fallback or edit of that migration.
-- Patches only the two existing private helpers. Public writer/issue/revoke,
-- action registry, ACLs, original request/key/plan and LIVE view stay unchanged.
-- All scope/Actor derivation stays private. No actual Binding UUID constant.

do $EXPIRED_PATCH$
declare
  context_oid regprocedure :=
    'clued_private.dataset_split_grant_correction_context_v1(uuid,uuid)'::regprocedure;
  link_oid regprocedure :=
    'clued_private.dataset_split_grant_correction_link_v1(uuid,jsonb,uuid)'::regprocedure;
  context_src text := pg_get_functiondef(context_oid);
  link_src text := pg_get_functiondef(link_oid);
  context_expected constant text :=
    'e6479cd30ae02ad9a2d82caf14bc82766cc654983508747cda7f34279c2c83ca';
  link_expected constant text :=
    '2e73e0bc85ee2bed7a789f5e29490992e291613d9240cb2191c01581ec1d0819';
  declaration_marker constant text :=
    '  old_b public.clued_agent_bindings; c clued_private.work_claims_v1; live_claims bigint;';
  window_marker constant text :=
    '    g.granted_at>now_at or g.expires_at<=now_at+interval ''1 hour'' or';
  snapshot_marker constant text := $SNAPSHOT_MARKER$
  -- Complete private snapshots bind version/content, lease/fence, identities
  -- and effective permission metadata. Only the digest enters the view.
  snapshot:=clued_private.m1_sha256(jsonb_build_object('request',to_jsonb(r),'grant',to_jsonb(g),
    'original_binding',to_jsonb(old_b),'binding',to_jsonb(b),'claim',to_jsonb(c),'task',to_jsonb(m),
    'account',(select to_jsonb(x) from auth.users x where x.id=p_owner),
    'project',(select to_jsonb(x) from public.clued_projects x
      where x.id='0597aa60-9b98-4da6-a4ab-63d7705b632f'::uuid and x.user_id=p_owner),
    'authorization',(select to_jsonb(x) from clued_private.authorizations_v12 x where x.binding_id=b.id),
    'authorization_entries',(select coalesce(jsonb_agg(to_jsonb(x)
      order by x.resource_kind,x.resource_id,x.environment),'[]'::jsonb)
      from clued_private.authorization_entries_v12 x where x.binding_id=b.id),
    'raw_grant',(select to_jsonb(x) from clued_private.raw_binding_grants_v1 x where x.binding_id=b.id),
    'token',to_jsonb(t),'receipt',to_jsonb(a)));
$SNAPSHOT_MARKER$;
  return_marker constant text :=
    '  return jsonb_build_object(''choices'',choices,''view'',view);';
  link_window_marker constant text :=
    '    new_g.resources is distinct from old_g.resources or new_g.expires_at>old_g.expires_at or';
  marker text;
  proc_row record;
  original_context_acl aclitem[];
  original_link_acl aclitem[];
begin
  if encode(extensions.digest(convert_to(context_src,'UTF8'),'sha256'),'hex')
      is distinct from context_expected or
    encode(extensions.digest(convert_to(link_src,'UTF8'),'sha256'),'hex')
      is distinct from link_expected then
    raise exception 'dataset_split_expired_successor_source_changed';
  end if;

  -- Exact predecessor body plus owner/security/search_path/ACL qualification.
  -- No role receives permission here. CREATE OR REPLACE must retain the ACL.
  for proc_row in
    select p.oid,p.proowner,p.prosecdef,p.proconfig,p.proacl
    from pg_catalog.pg_proc p where p.oid in (context_oid::oid,link_oid::oid)
  loop
    if pg_catalog.pg_get_userbyid(proc_row.proowner) is distinct from 'postgres' or
      proc_row.prosecdef is distinct from true or
      proc_row.proconfig is distinct from array['search_path=""']::text[] or
      exists(select 1 from pg_catalog.aclexplode(coalesce(proc_row.proacl,
        pg_catalog.acldefault('f',proc_row.proowner))) x
        where x.grantee is distinct from proc_row.proowner or
          x.grantor is distinct from proc_row.proowner or
          x.privilege_type is distinct from 'EXECUTE' or x.is_grantable) or
      not exists(select 1 from pg_catalog.aclexplode(coalesce(proc_row.proacl,
        pg_catalog.acldefault('f',proc_row.proowner))) x
        where x.grantee=proc_row.proowner and x.privilege_type='EXECUTE') then
      raise exception 'dataset_split_expired_successor_acl_changed';
    end if;
  end loop;
  select proacl into original_context_acl from pg_catalog.pg_proc where oid=context_oid;
  select proacl into original_link_acl from pg_catalog.pg_proc where oid=link_oid;

  foreach marker in array array[declaration_marker,window_marker,snapshot_marker,return_marker] loop
    if (length(context_src)-length(replace(context_src,marker,'')))/length(marker) <> 1 then
      raise exception 'dataset_split_expired_successor_context_marker_changed';
    end if;
  end loop;
  if (length(link_src)-length(replace(link_src,link_window_marker,'')))/length(link_window_marker) <> 1 then
    raise exception 'dataset_split_expired_successor_link_marker_changed';
  end if;

  context_src:=replace(context_src,declaration_marker,declaration_marker || $DECLARATIONS$
  expired_fresh boolean := false;
  adopted public.clued_memories; adopted_scope jsonb; adopted_proof jsonb;
  adoption_ref constant jsonb := '{
    "id":"4f7ff043-ea1c-4205-ae6f-115d3c58e70e",
    "version":2,
    "content_hash":"c7df9b20ebe99b707f2555546983524ceb521d410d67a1a89454b23b85de3404",
    "receipt_id":"aea1558c-c24b-491e-a90b-f11224c969c8",
    "event_id":"8497",
    "plan_sha256":"d4dada8b43a3dfe95096cf0add78c828827b1e4f25c25cf871e93cef2ef77e1e"
  }'::jsonb;
  scope_without_grantee constant jsonb := '{
    "schema":"clued.dataset-split-expired-native-adopted-scope/1",
    "task_id":"1502fd80-8ff8-4adc-b4f5-da6d462f4f8a",
    "task_version":593,
    "origin_request_id":"af1cabdb-5259-4ca3-94d3-133f1af122c8",
    "origin_grant_id":"4970e492-d26e-4974-adaa-757b2146b171",
    "bootstrap_idempotency_key":"model-bootstrap-1b397478-b792-4d73-864b-cee9af714052",
    "immutable_plan_resource":"repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json",
    "immutable_plan_sha256":"fc83a4a1f69de07d6de9dea5e879f1498b1b8f288ba3f9b8fba11d979de110ea",
    "targets":["36f0b1f1-3352-4a0a-abab-011b39164143","adfb0f98-c415-42a5-944c-c5fc91af0fc6","1f443b83-e612-4bec-84ea-b5f2e0e22eb5"],
    "resources":[
      "record:36f0b1f1-3352-4a0a-abab-011b39164143",
      "record:adfb0f98-c415-42a5-944c-c5fc91af0fc6",
      "record:1f443b83-e612-4bec-84ea-b5f2e0e22eb5",
      "record:b8c1d482-9eb4-4bc5-8dd1-372b0d55174e@1#b58db4fe2cc81c123f078aeff789fcc9fe971902321ffd36a9e3ebaa1af477eb",
      "record:46b0ff1c-f608-4ff9-89b9-dc90a61ce70f@1#74fb324321a23eaa4dbc7194b9ec9964a9e1d59d1ef12e6c6f3c7dfce6b91329",
      "repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json"
    ],
    "plan_package_sha256":"d4dada8b43a3dfe95096cf0add78c828827b1e4f25c25cf871e93cef2ef77e1e",
    "expired_predicate":"old.expires_at <= server_now AND old.uses=0 AND NOT old.revoked",
    "time_rule":"WRITER_GRANTED_AT_PLUS_3600_SECONDS",
    "max_window_seconds":3600,
    "max_uses":1,
    "scope_approval_only":true,
    "production_approved":false,
    "bootstrap_approved":false,
    "actual_grant_requires_fresh_native_owner_confirmation":true,
    "source_pin_requires_separate_exact_owner_source_acceptance":true
  }'::jsonb;
$DECLARATIONS$);
  -- Common old provenance/uses/revocation gates remain unchanged. The original
  -- LIVE >1h predicate is retained; the positive <=1h gap still fails.
  context_src:=replace(context_src,window_marker,
    '    g.granted_at>now_at or (g.expires_at>now_at and g.expires_at<=now_at+interval ''1 hour'') or');

  context_src:=replace(context_src,snapshot_marker,$ADOPTION_CHECK$
  expired_fresh:=g.expires_at<=now_at;
  if expired_fresh then
    -- This fixed reference is trusted only through separately accepted and
    -- installed exact Source. M1 user_explicit flags are not Owner attestation.
    -- The prior 041300 same-key try locks/NOWAIT ordering remains in force.
    if adoption_ref is null or jsonb_typeof(adoption_ref) is distinct from 'object' then
      raise exception 'dataset_split_expired_scope_not_pinned' using errcode='42501'; end if;
    select * into adopted from public.clued_memories x
      where x.id=(adoption_ref->>'id')::uuid and x.user_id=p_owner for share nowait;
    if not found or adopted.record_schema_version is distinct from 1 or
      adopted.record_type is distinct from 'decision' or adopted.authority is distinct from 'user_explicit' or
      adopted.lifecycle_status is distinct from 'active' or adopted.canonical_scope is distinct from s or
      adopted.version is distinct from (adoption_ref->>'version')::integer or
      adopted.content_hash is distinct from adoption_ref->>'content_hash' or
      adopted.receipt_id is distinct from (adoption_ref->>'receipt_id')::uuid or
      clued_private.m1_record_content_hash(adopted.record_type,adopted.canonical_scope,
        adopted.lifecycle_status,adopted.title,adopted.content,adopted.type_fields,
        adopted.relations,adopted.source_refs,adopted.source_unavailable_reason,
        adopted.authority,adopted.observed_at,adopted.closed_at,adopted.confidence,
        adopted.confidence_reason) is distinct from adoption_ref->>'content_hash' then
      raise exception 'dataset_split_expired_scope_record_not_exact' using errcode='42501'; end if;
    if clued_private.record_currentness_fence(p_owner,adopted.id,array['global',s])
      is distinct from 'CURRENT' then
      raise exception 'dataset_split_expired_scope_not_current' using errcode='42501'; end if;

    -- The existing private verifier recomputes the whole server Record hash
    -- and binds committed M1 target/version, unique Event, scope and historical
    -- writer Actor from actual columns. It confers no Owner or model authority.
    adopted_proof:=clued_private.model_domain_owner_chain_successor(b,adopted);
    if adopted_proof->'receipt'->>'id' is distinct from adoption_ref->>'receipt_id' or
      adopted_proof->'receipt'->'event_ids' is distinct from
        jsonb_build_array(adoption_ref->>'event_id') or
      adopted_proof->'event'->>'id' is distinct from adoption_ref->>'event_id' then
      raise exception 'dataset_split_expired_scope_chain_not_exact' using errcode='42501'; end if;
    adopted_scope:=adopted.relations->'expired_native_adopted_scope';
    if jsonb_typeof(adopted_scope) is distinct from 'object' or
      adopted_scope-'grantee_binding_ref' is distinct from scope_without_grantee then
      raise exception 'dataset_split_expired_scope_relation_not_exact' using errcode='42501'; end if;
    if adopted_scope->>'grantee_binding_ref' is distinct from b.id::text or
      m.version is distinct from (adopted_scope->>'task_version')::integer or
      adopted_scope->>'task_id' is distinct from m.id::text or
      adopted_scope->>'origin_request_id' is distinct from r.id::text or
      adopted_scope->>'origin_grant_id' is distinct from g.id::text or
      adopted_scope->>'bootstrap_idempotency_key' is distinct from r.idempotency_key or
      adopted_scope->>'immutable_plan_resource' is distinct from installed->>'source_resource' or
      adopted_scope->>'immutable_plan_sha256' is distinct from installed->>'source_sha256' or
      adopted_scope->>'plan_package_sha256' is distinct from adoption_ref->>'plan_sha256' or
      adopted_scope->'targets' is distinct from jsonb_build_array(
        plan->'targets'->>'producer_record_id',plan->'targets'->>'permission_record_id',
        plan->'targets'->>'recognition_record_id') or
      jsonb_array_length(adopted_scope->'resources') is distinct from 6 or
      (select count(distinct x) from jsonb_array_elements_text(adopted_scope->'resources') x)
        is distinct from 6::bigint or
      (select array_agg(x order by x) from jsonb_array_elements_text(adopted_scope->'resources') x)
        is distinct from expected then
      raise exception 'dataset_split_expired_scope_grantee_or_task_mismatch' using errcode='42501'; end if;
  end if;
$ADOPTION_CHECK$ || snapshot_marker || $ADOPTED_SNAPSHOT$
  if expired_fresh then
    snapshot:=clued_private.m1_sha256(jsonb_build_object(
      'predecessor_snapshot',snapshot,
      'expired_mode','EXPIRED_FRESH_NATIVE_OWNER_GRANT',
      'time_rule','WRITER_GRANTED_AT_PLUS_3600_SECONDS',
      'adoption_server_ref',adoption_ref,
      'adopted_scope_record',to_jsonb(adopted),
      'adopted_scope',adopted_scope,'adopted_scope_proof',adopted_proof));
  end if;
$ADOPTED_SNAPSHOT$);

  context_src:=replace(context_src,return_marker,$EXPIRED_VIEW$
  if expired_fresh then
    choices:=choices||jsonb_build_object(
      'correction_mode','EXPIRED_FRESH_NATIVE_OWNER_GRANT',
      'correction_time_rule','WRITER_GRANTED_AT_PLUS_3600_SECONDS',
      'correction_adoption_server_ref',adoption_ref);
    view:=jsonb_set(view,'{correction,effect}',
      to_jsonb('EXPIRED_UNUSED_BOOTSTRAP_GRANT_REAUTHORIZED_BY_FRESH_NATIVE_OWNER'::text),false);
    view:=jsonb_set(view,'{correction,expired_reauthorization}',jsonb_build_object(
      'schema','clued.dataset-split-expired-native-reauthorization.v1',
      'mode','EXPIRED_FRESH_NATIVE_OWNER_GRANT',
      'time_rule','WRITER_GRANTED_AT_PLUS_3600_SECONDS',
      'adoption_server_ref',adoption_ref),true);
  end if;
$EXPIRED_VIEW$ || return_marker);

  -- ctx already regenerated exact choices: Caller JSON cannot choose a mode.
  -- LIVE retains the old expiry cap; only the explicit expired fresh choice
  -- allows a new deadline beyond the old expired one. Duration remains 1h.
  link_src:=replace(link_src,link_window_marker,$LINK_WINDOW$
    new_g.resources is distinct from old_g.resources or
    (not (c ? 'correction_mode') and new_g.expires_at>old_g.expires_at) or
    (c->>'correction_mode'='EXPIRED_FRESH_NATIVE_OWNER_GRANT' and
      (new_g.granted_at<old_g.expires_at or new_g.granted_at>clock_timestamp() or
        new_g.revoked_at is not null or coalesce((to_jsonb(new_g)->>'auto_approved')::boolean,false))) or
$LINK_WINDOW$);

  execute context_src;
  execute link_src;

  -- Assert owner/security/search_path and exact ACL preservation afterward.
  if exists(select 1 from pg_catalog.pg_proc p where p.oid in (context_oid::oid,link_oid::oid)
    and (pg_catalog.pg_get_userbyid(p.proowner) is distinct from 'postgres' or
      p.prosecdef is distinct from true or p.proconfig is distinct from array['search_path=""']::text[] or
      p.proacl is distinct from case when p.oid=context_oid::oid then original_context_acl else original_link_acl end)) then
    raise exception 'dataset_split_expired_successor_acl_not_preserved';
  end if;
end $EXPIRED_PATCH$;

notify pgrst,'reload schema';

