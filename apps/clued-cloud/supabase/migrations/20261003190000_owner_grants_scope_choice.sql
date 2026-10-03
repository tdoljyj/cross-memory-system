-- Owner Credential v0.1 §4 item 3 (Task fcd55008, Owner Decision c4e82dee):
-- on the confirmation page, "grant for a while" can narrow or widen the
-- requested resources. Each requested resource is one row the Owner keeps or
-- unticks, and may widen to a parent wildcard Clued generates
-- (owner_request_scope_options_v1), for example
-- repo:<owner>/<name>/<commit> to repo:<owner>/<name>/**. Nothing is typed,
-- and a resource never changes kind. What the Owner approves is still the view
-- Clued renders from the chosen resources, bound by the two-step token.
-- "Approve once" keeps exactly the requested resources.

-- The resource itself, then each wider parent wildcard, narrowest first:
-- one per literal path segment, never above <owner>/<name> for repo:, never
-- for record: (a record id has no parent).
create function clued_private.owner_grant_scope_options_v1(p_resource text) returns text[]
language plpgsql immutable set search_path='' as $$
declare v_split text[]:=clued_private.work_claim_resource_split(p_resource); v_segs text[];
  v_literal integer:=0; v_min integer; v_out text[]:=array[p_resource]; v_option text; v_seg text; k integer;
begin
  if v_split[1]='record' then return v_out; end if;
  v_segs:=string_to_array(v_split[2],'/');
  foreach v_seg in array v_segs loop
    exit when position('*' in v_seg)>0;
    v_literal:=v_literal+1;
  end loop;
  v_min:=case when v_split[1]='repo' then 2 else 1 end;
  for k in reverse least(v_literal,cardinality(v_segs)-1)..v_min loop
    v_option:=coalesce(v_split[1]||':','')||array_to_string(v_segs[1:k],'/')||'/**';
    if not (v_option=any(v_out)) then v_out:=v_out||v_option; end if;
  end loop;
  return v_out;
end $$;

-- [{resource, options}] for each requested resource, in request order.
create function clued_private.owner_request_scope_options_v1(p_resources text[]) returns jsonb
language sql immutable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('resource',r,
    'options',to_jsonb(clued_private.owner_grant_scope_options_v1(r))) order by n),'[]'::jsonb)
  from unnest(p_resources) with ordinality as t(r,n)
$$;

revoke all on function clued_private.owner_grant_scope_options_v1(text),
  clued_private.owner_request_scope_options_v1(text[]) from public,anon,authenticated,service_role;

-- Same as 20261002220000 plus resource_options.
create or replace function public.clued_owner_request_view_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_req clued_private.owner_requests_v1%rowtype;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(p_input->>'request_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'owner_request_id_invalid' using errcode='22023'; end if;
  select * into v_req from clued_private.owner_requests_v1 where id=(p_input->>'request_id')::uuid and user_id=v_owner;
  if not found then return jsonb_build_object('status','rejected','error_code','owner_request_not_found'); end if;
  return jsonb_build_object('status','ok','request',clued_private.owner_request_public_v1(v_req),
    'resource_options',clued_private.owner_request_scope_options_v1(v_req.resources),
    'view',clued_private.owner_grant_view_v1(v_owner,jsonb_build_object('request_id',v_req.id,'action',v_req.action,
      'resources',to_jsonb(v_req.resources),'task_id',v_req.task_id,'grantee_binding_id',v_req.binding_id,
      'choice','grant','expires_seconds',coalesce(v_req.suggested_expires_seconds,14400),
      'max_uses',v_req.suggested_max_uses)));
end $$;

-- Same as 20261002220000, except that a request's resources may be chosen for
-- "grant" from the offered options.
create or replace function public.clued_owner_grant_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_req clued_private.owner_requests_v1%rowtype;
  v_choices jsonb; v_view jsonb; v_digest text; v_raw text; v_token_id uuid; v_expires timestamptz;
  v_choice text; v_seconds integer; v_max integer; v_resources text[]; v_task public.clued_memories%rowtype;
  v_subject text; v_error text; v_now timestamptz;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object' then
      raise exception 'owner_grant_input_invalid' using errcode='22023'; end if;
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in
        ('request_id','choice','expires_seconds','max_uses','grantee','action','resources','task_id','scope')) then
      raise exception 'owner_grant_unknown_field' using errcode='22023'; end if;
    perform clued_private.owner_grant_lock_v1(v_owner);
    begin
      v_seconds:=(p_input->>'expires_seconds')::integer;
      v_max:=(p_input->>'max_uses')::integer;
    exception when others then raise exception 'owner_grant_limits_invalid' using errcode='22023'; end;
    if p_input ? 'request_id' then
      if exists(select 1 from jsonb_object_keys(p_input) k where k in ('action','task_id','scope'))
          or (p_input ? 'resources' and coalesce(p_input->>'choice','grant')<>'grant') then
        raise exception 'owner_grant_request_fields_fixed' using errcode='22023'; end if;
      select * into v_req from clued_private.owner_requests_v1
        where id=(p_input->>'request_id')::uuid and user_id=v_owner for update;
      if not found then raise exception 'owner_request_not_found' using errcode='22023'; end if;
      if v_req.status<>'pending' then raise exception 'owner_request_decided' using errcode='55000'; end if;
      if v_req.expires_at<=clock_timestamp() then raise exception 'owner_request_expired' using errcode='55000'; end if;
      v_choice:=coalesce(p_input->>'choice','grant');
      if v_choice not in ('once','grant') then raise exception 'owner_grant_choice_invalid' using errcode='22023'; end if;
      if coalesce(p_input->>'grantee','requester') not in ('requester','any_agent') then
        raise exception 'owner_grant_grantee_invalid' using errcode='22023'; end if;
      if v_choice='once' then v_seconds:=86400; v_max:=1;
      else v_seconds:=coalesce(v_seconds,v_req.suggested_expires_seconds,14400); v_max:=coalesce(v_max,v_req.suggested_max_uses);
      end if;
      -- Decision c4e82dee: for "grant", the Owner may keep a subset of the
      -- requested resources and widen each to a parent Clued offers
      -- (owner_request_scope_options_v1); nothing typed, no other kind.
      v_resources:=v_req.resources;
      if p_input ? 'resources' then
        if jsonb_typeof(p_input->'resources') is distinct from 'array'
            or jsonb_array_length(p_input->'resources') not between 1 and 50 then
          raise exception 'owner_grant_resources_invalid' using errcode='22023'; end if;
        v_resources:=clued_private.work_claim_normalize_paths(p_input->'resources');
        if exists(select 1 from unnest(v_resources) r where not (r=any(
            select jsonb_array_elements_text(o->'options')
            from jsonb_array_elements(clued_private.owner_request_scope_options_v1(v_req.resources)) o))) then
          raise exception 'owner_grant_resources_not_offered' using errcode='22023'; end if;
      end if;
      v_choices:=jsonb_build_object('request_id',v_req.id,'action',v_req.action,'resources',to_jsonb(v_resources),
        'task_id',v_req.task_id,'choice',v_choice,'expires_seconds',v_seconds,'max_uses',v_max,
        'grantee_binding_id',case when coalesce(p_input->>'grantee','requester')='any_agent' then null else v_req.binding_id end);
      v_subject:=v_req.id::text;
    else
      if p_input ? 'choice' or p_input ? 'grantee' then
        raise exception 'owner_grant_direct_fields_invalid' using errcode='22023'; end if;
      if not exists(select 1 from clued_private.owner_grant_actions where action=p_input->>'action') then
        raise exception 'owner_grant_action_unknown' using errcode='22023'; end if;
      v_resources:=clued_private.work_claim_normalize_paths(p_input->'resources');
      if cardinality(v_resources)>50 then raise exception 'owner_grant_resources_invalid' using errcode='22023'; end if;
      if p_input ? 'task_id' then
        v_task:=clued_private.work_claim_task(v_owner,coalesce(p_input->>'scope','global'),p_input->>'task_id'); end if;
      v_seconds:=coalesce(v_seconds,14400);
      v_choices:=jsonb_build_object('request_id',null,'action',p_input->>'action','resources',to_jsonb(v_resources),
        'task_id',v_task.id,'choice','grant','expires_seconds',v_seconds,'max_uses',v_max,'grantee_binding_id',null);
      v_subject:='direct:'||(p_input->>'action');
    end if;
    if v_seconds not between 60 and 604800 then raise exception 'owner_grant_duration_invalid' using errcode='22023'; end if;
    if v_max is not null and v_max not between 1 and 1000 then raise exception 'owner_grant_limits_invalid' using errcode='22023'; end if;
    v_view:=clued_private.owner_grant_view_v1(v_owner,v_choices);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='owner_grant' and subject_key=v_subject and consumed_at is null and revoked_at is null;
    v_raw:='clued_ogr_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'owner_grant',v_subject,0,v_choices,v_view,v_digest,
      encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),
      coalesce(clued_private.native_auth_time_v1(),v_now),v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,'expires_at',v_expires,
      'confirmation_view',v_view,'view_digest',v_digest,'authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '42501' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

notify pgrst,'reload schema';
