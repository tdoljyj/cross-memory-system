-- Durable fencing for the trusted writer service. No HTTP/MCP grant and no
-- profile is enabled here. Read Bindings cannot call this administrative RPC.
-- An uncertain external effect never expires into permission for another write.
-- A second profile spelling must not become a second writer for one provider root.
create unique index resource_center_profiles_v1_provider_root_active_uidx
  on clued_private.resource_center_profiles_v1(user_id,root_folder_id) where state='active';
create table clued_private.resource_center_mutations_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  profile_id uuid not null references clued_private.resource_center_profiles_v1(id),
  writer_binding_id uuid,
  request_key text not null check (char_length(request_key) between 1 and 160),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  exact_request jsonb not null,
  authority_request jsonb not null,
  authority_result jsonb not null,
  authority_token_hash text not null,
  profile_version bigint not null,
  source_decision_id uuid not null references public.clued_memories(id),
  state text not null check (state in ('prepared','started','uncertain','cancelled','committed')),
  version bigint not null default 1,
  expires_at timestamptz not null,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  final_result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id,request_key)
);
create unique index resource_center_mutations_v1_single_writer
  on clued_private.resource_center_mutations_v1(profile_id)
  where state in ('prepared','started','uncertain');
alter table clued_private.resource_center_mutations_v1 enable row level security;
revoke all on clued_private.resource_center_mutations_v1 from public,anon,authenticated;

-- Called only by the trusted service, never with an Agent-selected user/profile.
-- Initial finalization supports create only. Other operations remain denied
-- until their provider-specific postcondition/CAS contracts are implemented.
create function public.clued_resource_center_mutation_journal_v1(
  p_user_id uuid,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_action text:=p_input->>'action';
  v_profile clued_private.resource_center_profiles_v1%rowtype;
  v_intent clued_private.resource_center_mutations_v1%rowtype;
  v_receipt public.clued_audit_receipts%rowtype;
  v_decision uuid;
  v_authority jsonb;
  v_exact_binding jsonb;
  v_field text;
  v_request jsonb;
  v_result jsonb;
  v_registered jsonb;
  v_refs jsonb;
  v_event text;
  v_error text;
  v_sqlstate text;
begin
  if p_user_id is null or coalesce(v_action,'') not in
    ('prepare','start','cancel','uncertain','finalize','inspect') then
    raise exception 'resource_center_journal_invalid' using errcode='22023';
  end if;
  -- Same order as registry administration: profile, then intent. The row lock
  -- lasts only for this database transaction, never across provider I/O.
  select * into v_profile from clued_private.resource_center_profiles_v1
    where id=(p_input->>'profile_id')::uuid and user_id=p_user_id for update;
  if not found or v_profile.state<>'active' then
    raise exception 'resource_center_profile_unavailable' using errcode='42501';
  end if;
  v_decision:=(p_input->>'source_decision_id')::uuid;
  if not clued_private.resource_center_decision_current_v1(
    p_user_id,v_profile.project_id,v_decision) or
    not clued_private.resource_center_decision_current_v1(
      p_user_id,v_profile.project_id,v_profile.source_decision_id) then
    raise exception 'owner_decision_required' using errcode='42501';
  end if;
  if v_action<>'prepare' then
    select * into v_intent from clued_private.resource_center_mutations_v1
      where (id=(p_input->>'intent_id')::uuid or
        (v_action='inspect' and p_input->>'intent_id' is null and request_key=p_input->>'request_key'))
        and profile_id=v_profile.id
        and user_id=p_user_id for update;
    if not found or v_intent.request_sha256 is distinct from p_input->>'request_sha256' then
      raise exception 'resource_center_intent_mismatch' using errcode='42501';
    end if;
    if v_intent.writer_binding_id is distinct from (p_input->>'writer_binding_id')::uuid then
      raise exception 'resource_center_writer_mismatch' using errcode='42501';
    end if;
    if v_action='inspect' then
      return jsonb_build_object('status',v_intent.state,'intent_id',v_intent.id,
        'version',v_intent.version,'request_sha256',v_intent.request_sha256,
        'receipt_id',v_intent.receipt_id,'final_result',v_intent.final_result);
    end if;
    -- In particular, a replayed start must NOT replay a permit to execute.
    if v_intent.version is distinct from (p_input->>'base_version')::bigint then
      raise exception 'resource_center_intent_conflict' using errcode='40001';
    end if;
  end if;
  v_receipt:=clued_private.m1_begin_receipt(
    p_user_id,null,'resource_center_journal',p_input,clued_private.m1_sha256(p_input));
  if v_receipt.status<>'pending' then
    -- Receipt replay is audit recovery only, never an execution grant.
    return jsonb_build_object('status','replayed','receipt_id',v_receipt.id,
      'execution_permitted',false);
  end if;
  begin
    if v_action='prepare' then
      v_request:=p_input->'authority_request';
      if coalesce(p_input->>'request_sha256','') !~ '^[0-9a-f]{64}$' or
        coalesce(p_input->>'request_key','')='' or
        jsonb_typeof(p_input->'exact_request') is distinct from 'object' or
        v_request->>'profile_id' is distinct from v_profile.id::text or
        v_request->>'profile_version' is distinct from v_profile.profile_version or
        v_request->'mutation'->>'operation' is distinct from 'create' then
        raise exception 'resource_center_journal_request_invalid' using errcode='22023';
      end if;
      v_authority:=public.clued_resource_center_authority_v1(
        p_input->>'authority_token_hash',v_request);
      if v_authority->>'status' is distinct from 'resolved' then
        raise exception 'resource_center_authority_unavailable' using errcode='42501';
      end if;
      v_exact_binding:=p_input->'exact_request'->'binding';
      if jsonb_typeof(v_exact_binding) is distinct from 'object' or
        jsonb_typeof(p_input->'exact_request'->'mutation') is distinct from 'object' or
        v_exact_binding->>'request_sha256' is distinct from p_input->>'request_sha256' or
        v_exact_binding->>'profile_id' is distinct from v_profile.id::text or
        v_exact_binding->>'profile_version' is distinct from v_profile.profile_version or
        v_exact_binding->>'policy_version' is distinct from v_profile.policy_version or
        v_exact_binding->>'artifact_authority_version' is distinct from v_authority->'authority'->>'authority_version' or
        v_exact_binding->>'currentness_identity' is distinct from v_authority->'authority'->>'currentness_identity' or
        v_exact_binding->>'governance_class' is distinct from v_authority->'authority'->>'governance_class' then
        raise exception 'resource_center_exact_binding_mismatch' using errcode='42501';
      end if;
      foreach v_field in array array['operation','source_path','destination_path','artifact_role','target_kind','directory_semantics'] loop
        if v_exact_binding->v_field is distinct from v_request->'mutation'->v_field then
          raise exception 'resource_center_exact_binding_mismatch' using errcode='42501';
        end if;
      end loop;
      insert into clued_private.resource_center_mutations_v1(
        user_id,profile_id,writer_binding_id,request_key,request_sha256,exact_request,
        authority_request,authority_result,authority_token_hash,profile_version,
        source_decision_id,state,expires_at,receipt_id)
      values(p_user_id,v_profile.id,(p_input->>'writer_binding_id')::uuid,p_input->>'request_key',p_input->>'request_sha256',
        p_input->'exact_request',v_request,v_authority,p_input->>'authority_token_hash',
        v_profile.version,v_decision,'prepared',clock_timestamp()+interval '30 seconds',v_receipt.id)
      returning * into v_intent;
    elsif v_action='start' then
      if v_intent.state<>'prepared' or v_intent.expires_at<=clock_timestamp() or
        v_profile.version<>v_intent.profile_version or
        not clued_private.resource_center_decision_current_v1(
          p_user_id,v_profile.project_id,v_intent.source_decision_id) or
        public.clued_resource_center_authority_v1(
          v_intent.authority_token_hash,v_intent.authority_request) is distinct from v_intent.authority_result then
        raise exception 'resource_center_intent_not_startable' using errcode='42501';
      end if;
      update clued_private.resource_center_mutations_v1 set state='started',
        version=version+1,updated_at=now(),receipt_id=v_receipt.id where id=v_intent.id returning * into v_intent;
    elsif v_action='cancel' then
      if v_intent.state<>'prepared' then
        raise exception 'resource_center_effect_may_have_started' using errcode='42501';
      end if;
      update clued_private.resource_center_mutations_v1 set state='cancelled',
        version=version+1,updated_at=now(),receipt_id=v_receipt.id where id=v_intent.id returning * into v_intent;
    elsif v_action='uncertain' then
      if v_intent.state<>'started' then
        raise exception 'resource_center_intent_conflict' using errcode='40001';
      end if;
      update clued_private.resource_center_mutations_v1 set state='uncertain',
        version=version+1,updated_at=now(),receipt_id=v_receipt.id where id=v_intent.id returning * into v_intent;
    elsif v_action='finalize' then
      if v_intent.state not in ('started','uncertain') or
        v_profile.version<>v_intent.profile_version or
        p_input->'postcondition'->>'path' is distinct from
          v_intent.authority_request->'mutation'->>'destination_path' or
        p_input->'postcondition'->>'parent_id' is distinct from
          v_intent.authority_request->'provider_identity'->>'destination_parent_id' or
        coalesce(p_input->'postcondition'->>'provider_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$' or
        coalesce(p_input->'postcondition'->>'provider_file_version','') !~ '^[0-9]{1,40}$' or
        not clued_private.resource_center_decision_current_v1(
          p_user_id,v_profile.project_id,v_intent.source_decision_id) then
        raise exception 'resource_center_postcondition_invalid' using errcode='42501';
      end if;
      -- A registry edit concurrent with the provider effect must not be silently
      -- overwritten. Uncertain intents keep the profile fenced for recovery.
      if public.clued_resource_center_authority_v1(
        v_intent.authority_token_hash,v_intent.authority_request) is distinct from v_intent.authority_result then
        raise exception 'resource_center_authority_changed' using errcode='40001';
      end if;
      v_registered:=public.clued_resource_center_admin_v1(p_user_id,jsonb_build_object(
        'action','artifact_register','profile_id',v_profile.id,
        'source_decision_id',v_intent.source_decision_id,
        'idempotency_key','resource-center-finalize:'||v_intent.id::text,
        'path',p_input->'postcondition'->>'path',
        'provider_file_id',p_input->'postcondition'->>'provider_file_id',
        'provider_file_version',p_input->'postcondition'->>'provider_file_version',
        'target_kind',v_intent.authority_request->'mutation'->>'target_kind',
        'governance_class',v_intent.authority_result->'authority'->>'governance_class',
        'delete_authority',false));
      if v_registered->>'status' is distinct from 'committed' then
        raise exception 'resource_center_registration_failed' using errcode='40001';
      end if;
      update clued_private.resource_center_mutations_v1 set state='committed',
        version=version+1,updated_at=now(),receipt_id=v_receipt.id,final_result=v_registered
        where id=v_intent.id returning * into v_intent;
    end if;
    v_refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',v_intent.id));
    v_event:=clued_private.m1_append_event_row(p_user_id,null,v_receipt.id,v_receipt.canonical_version,
      'extension:resource_center:journal_'||v_action,v_refs,'project:'||v_profile.project_id::text,
      null,jsonb_build_object('intent_id',v_intent.id,'state',v_intent.state),
      p_input->>'idempotency_key',v_receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,
      '{}'::jsonb,jsonb_build_object(v_intent.id::text,v_intent.version),array[v_event],'{}'::uuid[],null);
    return v_result||jsonb_build_object('intent_id',v_intent.id,'state',v_intent.state,
      'version',v_intent.version,'request_sha256',v_intent.request_sha256,
      'execution_permitted',v_action='start','final_result',v_intent.final_result);
  exception when others then
    get stacked diagnostics v_error=message_text,v_sqlstate=returned_sqlstate;
    return clued_private.m1_finish_receipt(v_receipt.id,
      case when v_sqlstate in ('22023','23502','23503','23505','23514','40001','42501','P0002')
        then 'rejected' else 'failed' end,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,
      '{}'::text[],'{}'::uuid[],v_error)||jsonb_build_object('execution_permitted',false);
  end;
end $$;
revoke all on function public.clued_resource_center_mutation_journal_v1(uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.clued_resource_center_mutation_journal_v1(uuid,jsonb) to service_role;

-- A separate revocable credential for the trusted writer. It is never the
-- ordinary Agent/MCP Binding, nor the read resolver's token. No grant is seeded.
create table clued_private.resource_center_writer_bindings_v1 (
  id uuid primary key default gen_random_uuid(),
  authority_binding_id uuid not null references clued_private.resource_center_bindings_v1(id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  source_decision_id uuid not null references public.clued_memories(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  receipt_id uuid not null references public.clued_audit_receipts(id)
);
alter table clued_private.resource_center_writer_bindings_v1 enable row level security;
alter table clued_private.resource_center_mutations_v1 add constraint resource_center_mutations_v1_writer_fk
  foreign key (writer_binding_id) references clued_private.resource_center_writer_bindings_v1(id);
revoke all on clued_private.resource_center_writer_bindings_v1 from public,anon,authenticated;

create function public.clued_resource_center_writer_admin_v1(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding clued_private.resource_center_bindings_v1%rowtype;
  v_profile clued_private.resource_center_profiles_v1%rowtype;
  v_receipt public.clued_audit_receipts%rowtype;
  v_writer uuid;
  v_refs jsonb;
  v_event text;
  v_decision uuid:=(p_input->>'source_decision_id')::uuid;
begin
  select * into v_binding from clued_private.resource_center_bindings_v1
    where id=(p_input->>'authority_binding_id')::uuid and user_id=p_user_id;
  if not found then raise exception 'resource_center_binding_unavailable' using errcode='42501'; end if;
  select * into v_profile from clued_private.resource_center_profiles_v1
    where id=v_binding.profile_id and user_id=p_user_id for update;
  if not found or not clued_private.resource_center_decision_current_v1(
    p_user_id,v_profile.project_id,v_decision) then
    raise exception 'owner_decision_required' using errcode='42501';
  end if;
  if p_input->>'action'='issue' then
    if v_profile.state<>'active' or v_binding.revoked_at is not null or
      v_binding.expires_at<=now() or
      coalesce(p_input->>'token_hash','') !~ '^[0-9a-f]{64}$' or
      p_input->>'token_hash'=v_binding.token_hash or
      (p_input->>'expires_at') is null or
      (p_input->>'expires_at')::timestamptz<=now() or
      (p_input->>'expires_at')::timestamptz>least(v_binding.expires_at,now()+interval '24 hours') then
      raise exception 'resource_center_writer_binding_invalid' using errcode='22023';
    end if;
  elsif p_input->>'action' is distinct from 'revoke' then
    raise exception 'resource_center_writer_admin_invalid' using errcode='22023';
  end if;
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,null,'resource_center_writer_admin',
    p_input,clued_private.m1_sha256(p_input));
  if v_receipt.status<>'pending' then
    return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt));
  end if;
  if p_input->>'action'='issue' then
    insert into clued_private.resource_center_writer_bindings_v1(
      authority_binding_id,token_hash,source_decision_id,expires_at,receipt_id)
    values(v_binding.id,p_input->>'token_hash',v_decision,(p_input->>'expires_at')::timestamptz,v_receipt.id)
    returning id into v_writer;
  else
    update clued_private.resource_center_writer_bindings_v1
      set revoked_at=now(),receipt_id=v_receipt.id
      where id=(p_input->>'writer_binding_id')::uuid and authority_binding_id=v_binding.id
        and revoked_at is null returning id into v_writer;
    if not found then raise exception 'resource_center_writer_unavailable' using errcode='42501'; end if;
  end if;
  v_refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',v_writer));
  v_event:=clued_private.m1_append_event_row(p_user_id,null,v_receipt.id,v_receipt.canonical_version,
    'extension:resource_center:writer_'||(p_input->>'action'),v_refs,
    'project:'||v_profile.project_id::text,null,jsonb_build_object('writer_binding_id',v_writer),
    p_input->>'idempotency_key',v_receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  return clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,'{}'::jsonb,
    '{}'::jsonb,array[v_event],'{}'::uuid[],null);
end $$;
revoke all on function public.clued_resource_center_writer_admin_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.clued_resource_center_writer_admin_v1(uuid,jsonb) to service_role;

-- The writer credential resolves its user, profile, authority Binding and
-- Owner Decision server-side. A caller cannot select or enlarge these fields.
create function public.clued_resource_center_write_v1(p_token_hash text,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_writer clued_private.resource_center_writer_bindings_v1%rowtype;
  v_binding clued_private.resource_center_bindings_v1%rowtype;
  v_profile clued_private.resource_center_profiles_v1%rowtype;
  v_input jsonb;
begin
  if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_request) is distinct from 'object' or
    exists(select 1 from jsonb_object_keys(p_request) k where k not in
      ('action','request_key','request_sha256','exact_request','authority_request',
       'intent_id','base_version','idempotency_key','postcondition')) then
    return jsonb_build_object('status','denied');
  end if;
  select * into v_writer from clued_private.resource_center_writer_bindings_v1
    where token_hash=p_token_hash and revoked_at is null and expires_at>now();
  if not found then return jsonb_build_object('status','denied'); end if;
  select * into v_binding from clued_private.resource_center_bindings_v1
    where id=v_writer.authority_binding_id and revoked_at is null and expires_at>now();
  if not found then return jsonb_build_object('status','denied'); end if;
  select * into v_profile from clued_private.resource_center_profiles_v1
    where id=v_binding.profile_id and user_id=v_binding.user_id and state='active';
  if not found or not clued_private.resource_center_decision_current_v1(
    v_binding.user_id,v_profile.project_id,v_binding.source_decision_id) then
    return jsonb_build_object('status','denied');
  end if;
  v_input:=p_request||jsonb_build_object('profile_id',v_profile.id,
    'source_decision_id',v_writer.source_decision_id,'authority_token_hash',v_binding.token_hash,
    'writer_binding_id',v_writer.id);
  return public.clued_resource_center_mutation_journal_v1(v_binding.user_id,v_input);
exception when others then
  return jsonb_build_object('status','denied');
end $$;
revoke all on function public.clued_resource_center_write_v1(text,jsonb) from public,anon,authenticated;
grant execute on function public.clued_resource_center_write_v1(text,jsonb) to anon;
