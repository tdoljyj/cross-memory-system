-- Opt-in credential rotation, not an administrator or storage capability.
-- Stable Binding identities; every credential generation is <=24h. No seed.
create table clued_private.resource_center_renewals_v1 (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references clued_private.resource_center_profiles_v1(id),
  reader_id uuid not null unique references clued_private.resource_center_bindings_v1(id),
  writer_id uuid not null unique references clued_private.resource_center_writer_bindings_v1(id),
  profile_version bigint not null,
  decision_versions jsonb not null,
  source_decision_id uuid not null references public.clued_memories(id),
  generation bigint not null default 0 check(generation>=0),
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  receipt_id uuid not null references public.clued_audit_receipts(id)
);
create unique index resource_center_renewals_v1_profile_active
  on clued_private.resource_center_renewals_v1(profile_id) where revoked_at is null;
create table clued_private.resource_center_rotations_v1 (
  grant_id uuid not null references clued_private.resource_center_renewals_v1(id),
  generation bigint not null,
  old_token_hash text not null unique,
  old_reader_hash text not null,
  old_writer_hash text not null,
  request jsonb not null,
  result jsonb not null,
  primary key(grant_id,generation)
);
-- A permanent enrollment marker prevents revoked grants falling back to legacy.
alter table clued_private.resource_center_bindings_v1 add column renewal_id uuid
  references clued_private.resource_center_renewals_v1(id);
alter table clued_private.resource_center_renewals_v1 enable row level security;
alter table clued_private.resource_center_rotations_v1 enable row level security;
revoke all on clued_private.resource_center_renewals_v1,
  clued_private.resource_center_rotations_v1 from public,anon,authenticated;

create function clued_private.resource_center_renewal_current_v1(p_reader_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  b clued_private.resource_center_bindings_v1%rowtype;
  g clued_private.resource_center_renewals_v1%rowtype;
  p clued_private.resource_center_profiles_v1%rowtype;
  d record;
begin
  select * into b from clued_private.resource_center_bindings_v1 where id=p_reader_id;
  if not found then return false; end if;
  if b.renewal_id is null then return true; end if;
  select * into g from clued_private.resource_center_renewals_v1 where id=b.renewal_id and reader_id=b.id;
  if not found or g.revoked_at is not null or g.expires_at<=clock_timestamp() then return false; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=g.profile_id;
  if not found or p.id<>b.profile_id or p.state<>'active' or p.version<>g.profile_version then return false; end if;
  -- Serialize exact Decision row updates/close/supersede. Currentness Core is
  -- evaluated at this admission point; later external truth is rechecked by
  -- every subsequent authority/write call, never cached in the renewal token.
  perform m.id from public.clued_memories m
    where g.decision_versions ? m.id::text order by m.id for share;
  for d in select * from jsonb_each_text(g.decision_versions) loop
    if not clued_private.resource_center_decision_current_v1(p.user_id,p.project_id,d.key::uuid) or
      not exists(select 1 from public.clued_memories m where m.id=d.key::uuid and m.version=d.value::bigint)
      then return false; end if;
  end loop;
  -- Waiting for a Decision lock must not extend the credential deadline.
  return g.expires_at>clock_timestamp();
end $$;
revoke all on function clued_private.resource_center_renewal_current_v1(uuid) from public,anon,authenticated;

-- Bootstrap requires the existing service-role administration boundary and a
-- new exact Owner decision. It cannot issue a profile, Artifact or writer.
create function public.clued_resource_center_renewal_admin_v1(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  p clued_private.resource_center_profiles_v1%rowtype;
  b clued_private.resource_center_bindings_v1%rowtype;
  w clued_private.resource_center_writer_bindings_v1%rowtype;
  g clued_private.resource_center_renewals_v1%rowtype;
  r public.clued_audit_receipts%rowtype;
  d uuid;
  versions jsonb:='{}';
  refs jsonb;
  ev text;
begin
  if p_input->>'action' is distinct from 'enroll' or
    coalesce(p_input->>'token_hash','') !~ '^[0-9a-f]{64}$' then
    raise exception 'resource_center_renewal_invalid' using errcode='22023'; end if;
  select * into p from clued_private.resource_center_profiles_v1
    where id=(p_input->>'profile_id')::uuid and user_id=p_user_id;
  if not found then raise exception 'resource_center_renewal_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p.user_id::text||':'||p.root_folder_id,0));
  select * into p from clued_private.resource_center_profiles_v1 where id=p.id for update;
  select * into b from clued_private.resource_center_bindings_v1
    where id=(p_input->>'reader_id')::uuid and profile_id=p.id and user_id=p_user_id;
  select * into w from clued_private.resource_center_writer_bindings_v1
    where id=(p_input->>'writer_id')::uuid and authority_binding_id=b.id;
  if p.state<>'active' or b.id is null or w.id is null or b.revoked_at is not null or
    w.revoked_at is not null or least(b.expires_at,w.expires_at)<=clock_timestamp() or
    b.token_hash=p_input->>'token_hash' or w.token_hash=p_input->>'token_hash' then
    raise exception 'resource_center_renewal_denied' using errcode='42501'; end if;
  foreach d in array array[p.source_decision_id,b.source_decision_id,w.source_decision_id,(p_input->>'source_decision_id')::uuid] loop
    if not clued_private.resource_center_decision_current_v1(p.user_id,p.project_id,d) then
      raise exception 'owner_decision_required' using errcode='42501'; end if;
    versions:=versions||jsonb_build_object(d::text,(select version from public.clued_memories where id=d));
  end loop;
  if exists(select 1 from clued_private.resource_center_mutations_v1 m
    join clued_private.resource_center_profiles_v1 x on x.id=m.profile_id
    where m.user_id=p.user_id and x.root_folder_id=p.root_folder_id and m.state in ('prepared','started','uncertain')) then
    raise exception 'resource_center_provider_root_fenced' using errcode='40001'; end if;
  r:=clued_private.m1_begin_receipt(p_user_id,null,'resource_center_renewal_enroll',
    (p_input-'token_hash')||jsonb_build_object('request_digest',clued_private.m1_sha256(p_input)),clued_private.m1_sha256(p_input));
  if r.status<>'pending' then return r.canonical_result; end if;
  if b.renewal_id is not null then raise exception 'resource_center_already_enrolled' using errcode='42501'; end if;
  insert into clued_private.resource_center_renewals_v1(profile_id,reader_id,writer_id,profile_version,
    decision_versions,source_decision_id,token_hash,expires_at,receipt_id)
  values(p.id,b.id,w.id,p.version,versions,(p_input->>'source_decision_id')::uuid,
    p_input->>'token_hash',least(b.expires_at,w.expires_at,clock_timestamp()+interval '24 hours'),r.id)
  returning * into g;
  update clued_private.resource_center_bindings_v1 set renewal_id=g.id where id=b.id;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',g.id));
  ev:=clued_private.m1_append_event_row(p.user_id,null,r.id,r.canonical_version,
    'extension:resource_center:renewal_enroll',refs,'project:'||p.project_id::text,null,
    jsonb_build_object('grant_id',g.id,'generation',0),p_input->>'idempotency_key',r.request_sha256,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  return clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,
    array[ev],'{}'::uuid[],null)||jsonb_build_object('grant_id',g.id,'generation',0,'expires_at',g.expires_at);
end $$;
revoke all on function public.clued_resource_center_renewal_admin_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.clued_resource_center_renewal_admin_v1(uuid,jsonb) to service_role;

create function public.clued_resource_center_renew_v1(p_token_hash text,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  g clued_private.resource_center_renewals_v1%rowtype;
  p clued_private.resource_center_profiles_v1%rowtype;
  b clued_private.resource_center_bindings_v1%rowtype;
  w clued_private.resource_center_writer_bindings_v1%rowtype;
  prior clued_private.resource_center_rotations_v1%rowtype;
  r public.clued_audit_receipts%rowtype;
  result jsonb;
  refs jsonb;
  ev text;
  expiry timestamptz;
  a text:=p_request->>'action';
  h text;
begin
  if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_request) is distinct from 'object' or
    coalesce(a,'') not in ('status','rotate','stop') or
    coalesce(p_request->>'request_id','') !~ '^[0-9a-f-]{36}$' or
    exists(select 1 from jsonb_object_keys(p_request) k where k not in
      ('action','request_id','generation','reader_hash','writer_hash','renewal_hash')) then
    return jsonb_build_object('status','denied'); end if;
  select * into g from clued_private.resource_center_renewals_v1 where token_hash=p_token_hash;
  if not found then
    select * into prior from clued_private.resource_center_rotations_v1 where old_token_hash=p_token_hash;
    select * into g from clued_private.resource_center_renewals_v1 where id=prior.grant_id;
  end if;
  if g.id is null then return jsonb_build_object('status','denied'); end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=g.profile_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p.user_id::text||':'||p.root_folder_id,0));
  select * into p from clued_private.resource_center_profiles_v1 where id=g.profile_id for update;
  select * into g from clued_private.resource_center_renewals_v1 where id=g.id for update;
  -- Stop is a monotonic attenuation, even after expiry or uncertain rotation.
  if a='stop' then
    if (p_request-'action'-'request_id')<>'{}'::jsonb then return jsonb_build_object('status','denied'); end if;
    if g.revoked_at is not null then return jsonb_build_object('status','stopped','receipt_id',g.receipt_id); end if;
  else
    select * into b from clued_private.resource_center_bindings_v1 where id=g.reader_id;
    select * into w from clued_private.resource_center_writer_bindings_v1 where id=g.writer_id;
    if not clued_private.resource_center_renewal_current_v1(g.reader_id) or
      b.revoked_at is not null or w.revoked_at is not null or w.authority_binding_id<>b.id or
      least(b.expires_at,w.expires_at)<=clock_timestamp() then return jsonb_build_object('status','denied'); end if;
    -- Re-read after locks: a simultaneous request may have just rotated.
    if g.token_hash<>p_token_hash then
      select * into prior from clued_private.resource_center_rotations_v1
        where old_token_hash=p_token_hash and grant_id=g.id and generation=g.generation;
      if a='rotate' and found and prior.request=p_request then return prior.result; end if;
      return jsonb_build_object('status','denied');
    end if;
    if a='status' then
      if (p_request-'action'-'request_id')<>'{}'::jsonb then return jsonb_build_object('status','denied'); end if;
      return jsonb_build_object('status','active','grant_id',g.id,'generation',g.generation,'expires_at',g.expires_at);
    end if;
    if (p_request->>'generation')::bigint is distinct from g.generation or
      g.expires_at>clock_timestamp()+interval '2 hours' then return jsonb_build_object('status','denied'); end if;
    foreach h in array array[p_request->>'reader_hash',p_request->>'writer_hash',p_request->>'renewal_hash'] loop
      if coalesce(h,'') !~ '^[0-9a-f]{64}$' or
        h in (b.token_hash,w.token_hash,g.token_hash) or
        exists(select 1 from clued_private.resource_center_bindings_v1 where token_hash=h) or
        exists(select 1 from clued_private.resource_center_writer_bindings_v1 where token_hash=h) or
        exists(select 1 from clued_private.resource_center_renewals_v1 where token_hash=h) or
        exists(select 1 from clued_private.resource_center_rotations_v1 where old_token_hash=h or old_reader_hash=h or old_writer_hash=h or
          request->>'reader_hash'=h or request->>'writer_hash'=h or request->>'renewal_hash'=h) then
        return jsonb_build_object('status','denied'); end if;
    end loop;
    if p_request->>'reader_hash'=p_request->>'writer_hash' or p_request->>'reader_hash'=p_request->>'renewal_hash' or
      p_request->>'writer_hash'=p_request->>'renewal_hash' then return jsonb_build_object('status','denied'); end if;
    if exists(select 1 from clued_private.resource_center_mutations_v1 m
      join clued_private.resource_center_profiles_v1 x on x.id=m.profile_id
      where m.user_id=p.user_id and x.root_folder_id=p.root_folder_id and m.state in ('prepared','started','uncertain')) then
      return jsonb_build_object('status','fenced'); end if;
  end if;
  r:=clued_private.m1_begin_receipt(p.user_id,null,'resource_center_renewal',
    jsonb_build_object('idempotency_key','renewal:'||g.id::text||':'||(p_request->>'request_id'),
      'action',a,'grant_id',g.id,'request_digest',clued_private.m1_sha256(p_request)),clued_private.m1_sha256(p_request));
  if r.status<>'pending' then return jsonb_build_object('status','denied'); end if;
  if a='stop' then
    update clued_private.resource_center_renewals_v1 set revoked_at=clock_timestamp(),receipt_id=r.id where id=g.id;
    update clued_private.resource_center_bindings_v1 set revoked_at=clock_timestamp(),version=version+1,receipt_id=r.id where id=g.reader_id;
    update clued_private.resource_center_writer_bindings_v1 set revoked_at=clock_timestamp(),receipt_id=r.id where id=g.writer_id;
    result:=jsonb_build_object('status','stopped','grant_id',g.id,'receipt_id',r.id);
  else
    expiry:=clock_timestamp()+interval '24 hours';
    update clued_private.resource_center_bindings_v1 set token_hash=p_request->>'reader_hash',expires_at=expiry,
      version=version+1,receipt_id=r.id where id=g.reader_id;
    update clued_private.resource_center_writer_bindings_v1 set token_hash=p_request->>'writer_hash',expires_at=expiry,
      receipt_id=r.id where id=g.writer_id;
    update clued_private.resource_center_renewals_v1 set token_hash=p_request->>'renewal_hash',expires_at=expiry,
      generation=g.generation+1,receipt_id=r.id where id=g.id;
    result:=jsonb_build_object('status','rotated','grant_id',g.id,'profile_id',g.profile_id,
      'generation',g.generation+1,'expires_at',expiry,'receipt_id',r.id);
    insert into clued_private.resource_center_rotations_v1 values(g.id,g.generation+1,g.token_hash,b.token_hash,w.token_hash,p_request,result);
  end if;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',g.id));
  ev:=clued_private.m1_append_event_row(p.user_id,null,r.id,r.canonical_version,
    'extension:resource_center:renewal_'||a,refs,'project:'||p.project_id::text,null,result,
    'renewal:'||g.id::text||':'||(p_request->>'request_id'),r.request_sha256,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  return result;
exception when others then return jsonb_build_object('status','denied');
end $$;
revoke all on function public.clued_resource_center_renew_v1(text,jsonb) from public,anon,authenticated;
grant execute on function public.clued_resource_center_renew_v1(text,jsonb) to anon;

create or replace function public.clued_resource_center_authority_v1(
  p_token_hash text,p_request jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding clued_private.resource_center_bindings_v1%rowtype;
  v_profile clued_private.resource_center_profiles_v1%rowtype;
  v_root clued_private.resource_center_artifacts_v1%rowtype;
  v_source clued_private.resource_center_artifacts_v1%rowtype;
  v_parent clued_private.resource_center_artifacts_v1%rowtype;
  v_destination clued_private.resource_center_artifacts_v1%rowtype;
  v_selected clued_private.resource_center_artifacts_v1%rowtype;
  v_decision public.clued_memories%rowtype;
  v_mutation jsonb:=p_request->'mutation';
  v_provider jsonb:=p_request->'provider_identity';
  v_operation text:=v_mutation->>'operation';
  v_source_path text:=v_mutation->>'source_path';
  v_destination_path text:=v_mutation->>'destination_path';
  v_parent_path text;
  v_existing boolean;
begin
  if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or
    jsonb_typeof(p_request)<>'object' or jsonb_typeof(v_mutation)<>'object' or
    jsonb_typeof(v_provider)<>'object' or
    coalesce(p_request->>'policy_version','')<>'clued.resource-center-mutation-policy/1' or
    coalesce(v_mutation->>'artifact_role','')<>'clued_resource' or
    v_operation not in ('create','write','replace','move','rename','delete') or
    coalesce(v_provider->>'provider_version','') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status','denied');
  end if;
  select * into v_binding from clued_private.resource_center_bindings_v1
    where token_hash=p_token_hash and capability='authority:read'
      and revoked_at is null and expires_at>now();
  if not found or not clued_private.resource_center_renewal_current_v1(v_binding.id) then return jsonb_build_object('status','denied'); end if;
  select * into v_profile from clued_private.resource_center_profiles_v1
    where id=v_binding.profile_id and user_id=v_binding.user_id and state='active'
      and id::text=p_request->>'profile_id'
      and profile_version=p_request->>'profile_version'
      and policy_version=p_request->>'policy_version';
  if not found or v_provider->>'root_folder_id' is distinct from v_profile.root_folder_id or
    v_provider->>'root_parent_id' is distinct from v_profile.root_parent_id or
    not clued_private.resource_center_decision_current_v1(
      v_profile.user_id,v_profile.project_id,v_profile.source_decision_id) or
    not clued_private.resource_center_decision_current_v1(
      v_profile.user_id,v_profile.project_id,v_binding.source_decision_id) then
    return jsonb_build_object('status','denied');
  end if;
  select * into v_root from clued_private.resource_center_artifacts_v1
    where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
      and path=v_profile.managed_root and target_kind='directory'
      and provider_file_id=v_profile.root_folder_id
      and provider_file_version=v_provider->>'root_folder_version';
  if not found or not clued_private.resource_center_path_current_v1(
    v_profile.user_id,v_profile.project_id,v_profile.id,
    v_profile.managed_root,v_profile.managed_root) then
    return jsonb_build_object('status','denied');
  end if;
  if v_operation='delete' then
    if v_source_path is null or v_destination_path is not null then
      return jsonb_build_object('status','denied');
    end if;
  elsif v_operation in ('move','rename') then
    if v_source_path is null or v_destination_path is null then
      return jsonb_build_object('status','denied');
    end if;
  elsif v_destination_path is null or v_source_path is not null then
    return jsonb_build_object('status','denied');
  end if;
  if v_source_path is not null then
    select * into v_source from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_source_path and path<>v_profile.managed_root
        and provider_file_id=v_provider->>'source_file_id'
        and provider_file_version=v_provider->>'source_file_version'
        and target_kind=v_mutation->>'target_kind';
    if not found or not clued_private.resource_center_path_current_v1(
      v_profile.user_id,v_profile.project_id,v_profile.id,
      v_profile.managed_root,v_source_path) then
      return jsonb_build_object('status','denied');
    end if;
  elsif v_provider->>'source_file_id' is not null or v_provider->>'source_file_version' is not null then
    return jsonb_build_object('status','denied');
  end if;
  if v_destination_path is not null then
    if left(v_destination_path,char_length(v_profile.managed_root)+1)
       <>v_profile.managed_root||'/' then
      return jsonb_build_object('status','denied');
    end if;
    v_parent_path:=left(v_destination_path,
      char_length(v_destination_path)-strpos(reverse(v_destination_path),'/'));
    select * into v_parent from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_parent_path and target_kind='directory'
        and provider_file_id=v_provider->>'destination_parent_id'
        and provider_file_version=v_provider->>'destination_parent_version';
    if not found or not clued_private.resource_center_path_current_v1(
      v_profile.user_id,v_profile.project_id,v_profile.id,
      v_profile.managed_root,v_parent_path) then
      return jsonb_build_object('status','denied');
    end if;
    v_existing:=v_operation in ('write','replace');
    if v_existing then
      select * into v_destination from clued_private.resource_center_artifacts_v1
        where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
          and path=v_destination_path and target_kind=v_mutation->>'target_kind'
          and provider_file_id=v_provider->>'destination_file_id'
          and provider_file_version=v_provider->>'destination_file_version';
      if not found or not clued_private.resource_center_path_current_v1(
        v_profile.user_id,v_profile.project_id,v_profile.id,
        v_profile.managed_root,v_destination_path) then
        return jsonb_build_object('status','denied');
      end if;
    elsif v_provider->>'destination_file_id' is not null or
      v_provider->>'destination_file_version' is not null or
      exists(select 1 from clued_private.resource_center_artifacts_v1 a
        where a.profile_id=v_profile.id and a.path=v_destination_path and a.state='active') then
      return jsonb_build_object('status','denied');
    end if;
  elsif v_provider->>'destination_parent_id' is not null or
    v_provider->>'destination_file_id' is not null then
    return jsonb_build_object('status','denied');
  end if;
  if v_source.id is not null then v_selected:=v_source;
  elsif v_destination.id is not null then v_selected:=v_destination;
  else v_selected:=v_parent; end if;
  select * into v_decision from public.clued_memories m
    where m.id=v_selected.source_decision_id and m.user_id=v_profile.user_id
      and m.record_type='decision' and m.authority='user_explicit'
      and m.lifecycle_status='active'
      and m.canonical_scope='project:'||v_profile.project_id::text;
  if not found or clued_private.record_currentness_fence(
    v_profile.user_id,v_decision.id,array['project:'||v_profile.project_id::text])<>'CURRENT' then
    return jsonb_build_object('status','denied');
  end if;
  return jsonb_build_object('status','resolved','authority',jsonb_build_object(
    'artifact_id',case when v_operation='create' then null else v_selected.id end,
    'artifact_role','clued_resource','governance_class',v_selected.governance_class,
    'delete_authority',v_selected.delete_authority,
    'authority_version',v_selected.id::text||':'||v_selected.version::text||':'||v_decision.version::text,
    'currentness_identity','decision:'||v_decision.id::text||':'||v_decision.version::text,
    'workspace_version',v_profile.id::text||':'||v_profile.version::text||':'||v_selected.version::text));
exception when others then
  return jsonb_build_object('status','denied');
end $$;
revoke all on function public.clued_resource_center_authority_v1(text,jsonb)
  from public,anon,authenticated;
grant execute on function public.clued_resource_center_authority_v1(text,jsonb) to anon;

create or replace function public.clued_resource_center_write_v1(p_token_hash text,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_writer clued_private.resource_center_writer_bindings_v1%rowtype;
  v_binding clued_private.resource_center_bindings_v1%rowtype;
  v_profile clued_private.resource_center_profiles_v1%rowtype;
  v_input jsonb;
begin
  if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_request) is distinct from 'object' or
    coalesce(p_request->>'action','') not in ('prepare','start','cancel','uncertain','finalize','inspect') or
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
  if not found then return jsonb_build_object('status','denied'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_binding.user_id::text||':'||v_profile.root_folder_id,0));
  select * into v_profile from clued_private.resource_center_profiles_v1
    where id=v_binding.profile_id and user_id=v_binding.user_id and state='active' for update;
  if not found then return jsonb_build_object('status','denied'); end if;
  -- Serialize with writer/read revocation, then refresh both grants. Values
  -- read before the lock may have been revoked or expired while waiting.
  select * into v_writer from clued_private.resource_center_writer_bindings_v1
    where token_hash=p_token_hash and revoked_at is null and expires_at>clock_timestamp();
  if not found then return jsonb_build_object('status','denied'); end if;
  select * into v_binding from clued_private.resource_center_bindings_v1
    where id=v_writer.authority_binding_id and profile_id=v_profile.id
      and user_id=v_profile.user_id and revoked_at is null and expires_at>clock_timestamp();
  if not found or not clued_private.resource_center_renewal_current_v1(v_binding.id) or not clued_private.resource_center_decision_current_v1(
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
