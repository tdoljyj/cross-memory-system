-- Candidate implementation of Owner-accepted proposal ece45d7e...424b8f.
-- Task 1502fd80-8ff8-4adc-b4f5-da6d462f4f8a; implementation-only acceptance
-- Decision f9d4b125-a639-4c70-9d87-261923c4afb0, Receipt 449c94d5-1d38-408e-8f01-299a85c17cce.
-- Native only. No request reset, schema relaxation, new request/key, model
-- record write, DomainAuthority, DataGate, M2 or training permission.
-- Reuse the existing owner_grant token, writer and receipt protocol.

create function clued_private.dataset_split_grant_correction_context_v1(p_owner uuid,p_request uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r clued_private.owner_requests_v1; g clued_private.owner_grants_v1;
  t clued_private.native_confirmation_tokens; a public.clued_audit_receipts;
  b public.clued_agent_bindings; m public.clued_memories; installed jsonb; plan jsonb;
  expected text[]; choices jsonb; view jsonb; snapshot text; now_at timestamptz;
  s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
begin
  if p_request is distinct from 'af1cabdb-5259-4ca3-94d3-133f1af122c8'::uuid then
    raise exception 'dataset_split_correction_request_not_eligible' using errcode='42501'; end if;
  perform clued_private.owner_grant_lock_v1(p_owner);
  select * into r from clued_private.owner_requests_v1 where id=p_request and user_id=p_owner for update;
  if not found or r.status is distinct from 'approved_once' or
    r.action is distinct from 'model.dataset_split.bootstrap' or
    r.idempotency_key is distinct from 'model-bootstrap-1b397478-b792-4d73-864b-cee9af714052' or
    r.task_id is distinct from '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a'::uuid or
    r.grant_id is distinct from '4970e492-d26e-4974-adaa-757b2146b171'::uuid then
    raise exception 'dataset_split_correction_request_not_eligible' using errcode='42501'; end if;
  select * into g from clued_private.owner_grants_v1 where id=r.grant_id and user_id=p_owner for update;
  now_at:=clock_timestamp();
  if not found or g.request_id is distinct from r.id or g.action is distinct from r.action or
    g.task_id is distinct from r.task_id or g.grantee_binding_id is distinct from r.binding_id or
    g.revoked_at is not null or g.uses is distinct from 0 or g.max_uses is distinct from 1 or
    g.granted_at>now_at or g.expires_at<=now_at+interval '1 hour' or
    g.expires_at-g.granted_at is distinct from interval '24 hours' or
    coalesce((to_jsonb(g)->>'auto_approved')::boolean,false) then
    raise exception 'dataset_split_correction_grant_not_eligible' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where id=r.binding_id and user_id=p_owner for update;
  if not found or b.revoked_at is not null or
    (to_jsonb(b)->>'expires_at' is not null and (to_jsonb(b)->>'expires_at')::timestamptz<=now_at) then
    raise exception 'dataset_split_correction_binding_not_current' using errcode='42501'; end if;
  select * into m from public.clued_memories where id=r.task_id and user_id=p_owner for update;
  if not found or m.record_type is distinct from 'task' or m.lifecycle_status is distinct from 'active' or
    m.canonical_scope is distinct from s or
    clued_private.record_currentness_fence(p_owner,m.id,array[s]) is distinct from 'CURRENT' then
    raise exception 'dataset_split_correction_task_not_current' using errcode='42501'; end if;
  installed:=clued_private.model_domain_bootstrap_exact_plan_candidate();
  if installed->>'source_sha256' is distinct from 'fc83a4a1f69de07d6de9dea5e879f1498b1b8f288ba3f9b8fba11d979de110ea' or
    encode(extensions.digest(convert_to(installed->>'raw_utf8','UTF8'),'sha256'),'hex') is distinct from installed->>'source_sha256' then
    raise exception 'dataset_split_correction_plan_not_current' using errcode='42501'; end if;
  plan:=(installed->>'raw_utf8')::jsonb;
  select array_agg(v order by v) into expected from (
    select 'record:'||value v from jsonb_each_text(plan->'targets')
    union all select 'record:'||(value->>'id')||'@'||(value->>'version')||'#'||(value->>'content_hash')
      from jsonb_each(plan->'owner_anchor_refs')
    union all select installed->>'source_resource'
  ) x;
  if cardinality(expected) is distinct from 6 or
    (select array_agg(v order by v) from unnest(r.resources) v) is distinct from expected or
    (select array_agg(v order by v) from unnest(g.resources) v) is distinct from expected then
    raise exception 'dataset_split_correction_resources_not_exact' using errcode='42501'; end if;
  if exists(select 1 from public.clued_memories x where x.user_id=p_owner
    and x.id in (select value::uuid from jsonb_each_text(plan->'targets'))) then
    raise exception 'dataset_split_correction_targets_already_exist' using errcode='42501'; end if;
  select * into t from clued_private.native_confirmation_tokens where id=g.token_id and user_id=p_owner;
  select * into a from public.clued_audit_receipts where id=g.receipt_id and user_id=p_owner;
  if t.id is null or a.id is null or t.action is distinct from 'owner_grant' or
    t.consume_outcome is distinct from 'committed' or t.consumed_at is null or
    t.consumed_at>t.expires_at or t.consumed_receipt_id is distinct from g.receipt_id or
    t.session_id is null or t.session_id is distinct from g.granted_session_id or
    clued_private.m1_sha256(t.confirmation_view) is distinct from t.view_digest or
    t.native_choices->>'request_id' is distinct from r.id::text or
    t.native_choices->>'action' is distinct from r.action or
    t.native_choices->>'task_id' is distinct from r.task_id::text or
    t.native_choices->>'grantee_binding_id' is distinct from r.binding_id::text or
    t.native_choices->>'choice' is distinct from 'once' or
    t.native_choices->>'expires_seconds' is distinct from '86400' or
    t.native_choices->>'max_uses' is distinct from '1' or
    (select array_agg(v order by v) from jsonb_array_elements_text(t.native_choices->'resources') v) is distinct from expected or
    a.operation is distinct from 'owner_grant' or a.binding_id is not null or
    a.metadata->>'receipt_kind' is distinct from 'OWNER_GRANT_GIVEN' or
    a.metadata->>'principal' is distinct from 'native_account_session' or
    a.metadata->>'token_id' is distinct from t.id::text or
    a.metadata->>'view_digest' is distinct from t.view_digest or
    a.metadata->>'session_id' is distinct from t.session_id or
    a.metadata->'choices' is distinct from t.native_choices then
    raise exception 'dataset_split_correction_original_native_chain_invalid' using errcode='42501'; end if;
  -- Hash private rows internally; no raw Binding, token, Actor or receipt
  -- payload enters the confirmation view or any caller-controlled field.
  snapshot:=clued_private.m1_sha256(jsonb_build_object('request',to_jsonb(r),'grant',to_jsonb(g),
    'binding',jsonb_build_object('id',b.id,'user_id',b.user_id,'vendor',b.vendor,'agent_name',b.agent_name,
      'revoked_at',b.revoked_at,'expires_at',to_jsonb(b)->'expires_at','scopes',b.scopes,
      'context_keys',to_jsonb(b)->'context_keys'),
    'task',jsonb_build_object('id',m.id,'title',m.title,'record_type',m.record_type,
      'lifecycle_status',m.lifecycle_status,'canonical_scope',m.canonical_scope),
    'token',to_jsonb(t),'receipt',to_jsonb(a)));
  -- request_id is null for the successor: the original grant retains its
  -- immutable unique request_id FK. Its original request's current grant_id
  -- pointer links the successor; signed correction fields retain the chain.
  choices:=jsonb_build_object('request_id',null,'action',r.action,'resources',to_jsonb(expected),
    'task_id',r.task_id,'grantee_binding_id',r.binding_id,'choice','grant','expires_seconds',3600,'max_uses',1,
    'correction_request_id',r.id,'correction_grant_id',g.id,'correction_snapshot',snapshot);
  view:=clued_private.owner_grant_view_v1(p_owner,choices)||jsonb_build_object('correction',
    jsonb_build_object('request_id',r.id,'previous_grant_id',g.id,'previous_receipt_id',g.receipt_id,
      'previous_expires_at',g.expires_at,'snapshot',snapshot,
      'effect','REPLACE_UNUSED_GRANT_WITH_ONE_HOUR_SINGLE_USE_KEEP_ORIGINAL_APPROVAL_HISTORY'));
  return jsonb_build_object('choices',choices,'view',view);
end $$;
revoke all on function clued_private.dataset_split_grant_correction_context_v1(uuid,uuid)
  from public,anon,authenticated,service_role;

create function public.clued_dataset_split_grant_correction_view_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); ctx jsonb;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    raise exception 'confirmation_token_session_id_required' using errcode='42501'; end if;
  if jsonb_typeof(p_input) is distinct from 'object' or
    (select array_agg(k order by k) from jsonb_object_keys(p_input) k) is distinct from array['request_id']::text[] then
    raise exception 'dataset_split_correction_exact_input_required' using errcode='22023'; end if;
  ctx:=clued_private.dataset_split_grant_correction_context_v1(owner_id,(p_input->>'request_id')::uuid);
  return jsonb_build_object('status','eligible','confirmation_view',ctx->'view','authoritative',false);
end $$;

create function public.clued_dataset_split_grant_correction_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); ctx jsonb; raw_token text;
  token_id uuid; digest text; now_at timestamptz;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    raise exception 'confirmation_token_session_id_required' using errcode='42501'; end if;
  if jsonb_typeof(p_input) is distinct from 'object' or
    (select array_agg(k order by k) from jsonb_object_keys(p_input) k) is distinct from array['request_id']::text[] then
    raise exception 'dataset_split_correction_exact_input_required' using errcode='22023'; end if;
  ctx:=clued_private.dataset_split_grant_correction_context_v1(owner_id,(p_input->>'request_id')::uuid);
  digest:=clued_private.m1_sha256(ctx->'view'); now_at:=clock_timestamp();
  update clued_private.native_confirmation_tokens set revoked_at=now_at where user_id=owner_id
    and action='owner_grant' and subject_key='dataset-split-correction:'||(p_input->>'request_id')
    and consumed_at is null and revoked_at is null;
  raw_token:='clued_ogr_'||encode(extensions.gen_random_bytes(32),'hex');
  insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
    confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
  values(owner_id,'owner_grant','dataset-split-correction:'||(p_input->>'request_id'),0,ctx->'choices',ctx->'view',digest,
    encode(extensions.digest(convert_to(raw_token,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),
    coalesce(clued_private.native_auth_time_v1(),now_at),now_at,now_at+interval '5 minutes') returning id into token_id;
  return jsonb_build_object('status','issued','confirmation_token',raw_token,'token_id',token_id,
    'expires_at',now_at+interval '5 minutes','confirmation_view',ctx->'view','view_digest',digest,'authoritative',false);
end $$;

-- Called only inside the existing owner_grant writer after its exact Native
-- token/session/digest checks, and before its first grant/receipt write.
create function clued_private.dataset_split_grant_correction_view_for_choices_v1(p_owner uuid,c jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare ctx jsonb;
begin
  if not (c ? 'correction_request_id') then return clued_private.owner_grant_view_v1(p_owner,c); end if;
  ctx:=clued_private.dataset_split_grant_correction_context_v1(p_owner,(c->>'correction_request_id')::uuid);
  if ctx->'choices' is distinct from c then
    raise exception 'confirmation_view_stale' using errcode='40001'; end if;
  return ctx->'view';
end $$;

-- Revoke + successor pointer are in the same outer writer transaction.
-- A rejection rolls both back; its fresh confirmation token is burned using
-- the existing writer's rejection protocol. Original token/receipt stay intact.
create function clued_private.dataset_split_grant_correction_link_v1(p_owner uuid,c jsonb,p_new uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare ctx jsonb; result jsonb; new_g clued_private.owner_grants_v1; old_g clued_private.owner_grants_v1;
begin
  if not (c ? 'correction_request_id') then return; end if;
  ctx:=clued_private.dataset_split_grant_correction_context_v1(p_owner,(c->>'correction_request_id')::uuid);
  if ctx->'choices' is distinct from c then raise exception 'confirmation_view_stale' using errcode='40001'; end if;
  select * into new_g from clued_private.owner_grants_v1 where id=p_new and user_id=p_owner;
  select * into old_g from clued_private.owner_grants_v1 where id=(c->>'correction_grant_id')::uuid and user_id=p_owner;
  if new_g.id is null or new_g.request_id is not null or new_g.uses is distinct from 0 or
    new_g.max_uses is distinct from 1 or new_g.action is distinct from old_g.action or
    new_g.task_id is distinct from old_g.task_id or new_g.grantee_binding_id is distinct from old_g.grantee_binding_id or
    new_g.resources is distinct from old_g.resources or new_g.expires_at>old_g.expires_at or
    new_g.expires_at-new_g.granted_at is distinct from interval '1 hour' then
    raise exception 'dataset_split_correction_successor_not_exact' using errcode='42501'; end if;
  result:=public.clued_owner_grant_revoke_v1(jsonb_build_object('grant_id',old_g.id));
  if result->>'status' is distinct from 'committed' or result->>'replayed' is distinct from 'false' then
    raise exception 'dataset_split_correction_original_revoke_failed' using errcode='42501'; end if;
  update clued_private.owner_requests_v1 set status='granted',grant_id=p_new,decided_at=new_g.granted_at
    where id=(c->>'correction_request_id')::uuid and user_id=p_owner and grant_id=old_g.id and status='approved_once';
  if not found then raise exception 'confirmation_view_stale' using errcode='40001'; end if;
end $$;

revoke all on function clued_private.dataset_split_grant_correction_view_for_choices_v1(uuid,jsonb),
  clued_private.dataset_split_grant_correction_link_v1(uuid,jsonb,uuid),
  public.clued_dataset_split_grant_correction_view_v1(jsonb),
  public.clued_dataset_split_grant_correction_issue_v1(jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.clued_dataset_split_grant_correction_view_v1(jsonb),
  public.clued_dataset_split_grant_correction_issue_v1(jsonb) to authenticated;

-- Fail closed if the upstream writer changed: preserve all its current
-- authorization/replay/rejection and connection-permission hooks verbatim.
do $PATCH$
declare src text:=pg_get_functiondef('public.clued_owner_grant_v1(jsonb)'::regprocedure); patched text;
  marker text:='clued_private.m1_sha256(clued_private.owner_grant_view_v1(v_owner,c))';
  anchor text:='    if v_req.id is not null then';
begin
  if strpos(src,'dataset_split_grant_correction_view_for_choices_v1')>0 then
    raise exception 'dataset_split_correction_writer_already_patched'; end if;
  if (length(src)-length(replace(src,marker,'')))/length(marker)<>1 or
    (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 then
    raise exception 'dataset_split_correction_writer_source_changed'; end if;
  patched:=replace(src,marker,'clued_private.m1_sha256(clued_private.dataset_split_grant_correction_view_for_choices_v1(v_owner,c))');
  patched:=replace(patched,anchor,'    perform clued_private.dataset_split_grant_correction_link_v1(v_owner,c,v_grant.id);'||chr(10)||anchor);
  execute patched;
end $PATCH$;

notify pgrst,'reload schema';
