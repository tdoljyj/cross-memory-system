-- Account-owned standing delegation: refresh only, never a file-operation grant.
-- No seed or automatic opt-in. Workers use a private connector issuer, not an
-- owner's browser refresh token or a general service-role credential.
create table clued_private.storage_refresh_delegations_v1 (
  connection_id uuid primary key references clued_private.storage_connections_v1(id),
  issuer_hash text not null references clued_private.storage_oauth_apps_v1(issuer_hash),
  enabled boolean not null default false,
  version bigint not null default 1,
  next_refresh_at timestamptz not null default clock_timestamp(),
  last_polled_at timestamptz,
  failures integer not null default 0 check(failures between 0 and 3),
  receipt_id uuid not null references public.clued_audit_receipts(id)
);
create table clued_private.storage_refresh_attempts_v1 (
  id uuid primary key,
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  issuer_hash text not null references clued_private.storage_oauth_apps_v1(issuer_hash),
  delegation_version bigint not null,
  credential_version bigint not null,
  state text not null check(state in ('claimed','committed','failed','superseded')),
  expires_at timestamptz not null,
  request_digest text,
  receipt_id uuid references public.clued_audit_receipts(id)
);
create unique index storage_refresh_one_pending_v1 on clued_private.storage_refresh_attempts_v1(connection_id) where state='claimed';
create index storage_refresh_issuer_due_v1 on clued_private.storage_refresh_delegations_v1(issuer_hash,next_refresh_at) where enabled;
alter table clued_private.storage_refresh_delegations_v1 enable row level security;
alter table clued_private.storage_refresh_attempts_v1 enable row level security;
revoke all on clued_private.storage_refresh_delegations_v1,clued_private.storage_refresh_attempts_v1 from public,anon,authenticated,service_role;

-- Existing mutation journal and provider-root advisory lock remain authoritative.
create function clued_private.storage_root_quiet_v1(p_owner uuid,p_root text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from clued_private.resource_center_mutations_v1 m
    join clued_private.resource_center_profiles_v1 p on p.id=m.profile_id
    where m.user_id=p_owner and p.root_folder_id=p_root and m.state in ('prepared','started','uncertain')) then
    raise exception 'storage_root_has_unresolved_mutation' using errcode='42501'; end if;
end $$;
revoke all on function clued_private.storage_root_quiet_v1(uuid,text) from public,anon,authenticated,service_role;

create function public.clued_storage_refresh_manage_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); c clued_private.storage_connections_v1;
  d clued_private.storage_refresh_delegations_v1; issuer text; r public.clued_audit_receipts;
  refs jsonb; ev text; result jsonb; op text:=p_input->>'action'; project uuid;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('status','enable','disable') then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for update;
  if not found then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  select * into d from clued_private.storage_refresh_delegations_v1 where connection_id=c.id for update;
  if op='status' then
    if p_input<>jsonb_build_object('action','status','connection_id',c.id) then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    return jsonb_build_object('enabled',coalesce(d.enabled,false) and c.state='active','version',coalesce(d.version,0),
      'connection_version',c.version,'failures',coalesce(d.failures,0),'next_refresh_at',d.next_refresh_at,
      'pending',exists(select 1 from clued_private.storage_refresh_attempts_v1 where connection_id=c.id and state='claimed'));
  end if;
  if (p_input-array['action','connection_id','base_version','delegation_version','idempotency_key','until_revoked'])<>'{}'::jsonb
    or coalesce(length(p_input->>'idempotency_key'),0) not between 1 and 160 then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  r:=clued_private.m1_begin_receipt(u,null,'storage_refresh_'||op,p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then return r.canonical_result; end if;
  if c.version is distinct from (p_input->>'base_version')::bigint or coalesce(d.version,0) is distinct from (p_input->>'delegation_version')::bigint then
    raise exception 'storage_version_conflict' using errcode='40001'; end if;
  if op='enable' then
    perform clued_private.storage_connection_current_v1(c.id,u);
    if p_input->'until_revoked' is distinct from 'true'::jsonb then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    select min(issuer_hash) into issuer from clued_private.storage_oauth_apps_v1 where oauth_client_id=c.oauth_client_id and revoked_at is null;
    if issuer is null or (select count(*) from clued_private.storage_oauth_apps_v1 where oauth_client_id=c.oauth_client_id and revoked_at is null)<>1 then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    -- Re-enabling cannot erase an unknown token exchange. Fresh OAuth is required.
    if exists(select 1 from clued_private.storage_refresh_attempts_v1 where connection_id=c.id and state='claimed') then
      raise exception 'storage_refresh_pending' using errcode='42501'; end if;
    insert into clued_private.storage_refresh_delegations_v1(connection_id,issuer_hash,enabled,receipt_id)
      values(c.id,issuer,true,r.id) on conflict(connection_id) do update set issuer_hash=excluded.issuer_hash,
      enabled=true,version=storage_refresh_delegations_v1.version+1,failures=0,next_refresh_at=clock_timestamp(),receipt_id=r.id;
  else
    if p_input ? 'until_revoked' then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    update clued_private.storage_refresh_delegations_v1 set enabled=false,version=version+1,receipt_id=r.id where connection_id=c.id;
  end if;
  select project_id into project from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:refresh_'||op,
    refs,'project:'||project::text,null,jsonb_build_object('connection_id',c.id,'enabled',op='enable'),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  perform clued_private.storage_owner_v1();
  return result;
end $$;
revoke all on function public.clued_storage_refresh_manage_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_refresh_manage_v1(jsonb) to authenticated;

-- This API is never forwarded from a browser or Agent route. Possession of the
-- private issuer is necessary but insufficient: each connection must opt in.
create function public.clued_storage_refresh_worker_v1(p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a clued_private.storage_oauth_apps_v1; c clued_private.storage_connections_v1;
  d clued_private.storage_refresh_delegations_v1; x clued_private.storage_refresh_attempts_v1;
  p clued_private.resource_center_profiles_v1; op text:=p_input->>'action';
  r public.clued_audit_receipts; refs jsonb; ev text; req jsonb; expiry timestamptz; result jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('due','claim','commit','fail') then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  select * into a from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if op='due' then
    if p_input<>jsonb_build_object('action','due') then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    with candidates as (select g.connection_id from clued_private.storage_refresh_delegations_v1 g join clued_private.storage_connections_v1 candidate_connection on candidate_connection.id=g.connection_id
       where g.issuer_hash=a.issuer_hash and g.enabled and g.failures<3 and g.next_refresh_at<=clock_timestamp() and candidate_connection.state='active'
       and not exists(select 1 from clued_private.storage_refresh_attempts_v1 pending_attempt where pending_attempt.connection_id=candidate_connection.id and pending_attempt.state='claimed')
       order by g.last_polled_at nulls first,g.next_refresh_at,g.connection_id limit 10 for update of g skip locked),
      selected as (update clued_private.storage_refresh_delegations_v1 g set last_polled_at=clock_timestamp()
        from candidates q where g.connection_id=q.connection_id returning g.connection_id)
      select jsonb_build_object('connections',coalesce(jsonb_agg(connection_id),'[]'::jsonb)) into result from selected;
    return result||jsonb_build_object('pending_expired', (select count(*) from clued_private.storage_refresh_attempts_v1
      where issuer_hash=a.issuer_hash and state='claimed' and expires_at<=clock_timestamp()));
  end if;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid;
  if not found then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.owner_id::text||':'||p.root_folder_id,0));
  perform clued_private.authorization_account_v12(c.owner_id);
  select * into c from clued_private.storage_connections_v1 where id=c.id for update;
  select * into d from clued_private.storage_refresh_delegations_v1 where connection_id=c.id for update;
  select * into x from clued_private.storage_refresh_attempts_v1 where id=(p_input->>'attempt_id')::uuid for update;
  if x.id is not null and (x.connection_id<>c.id or x.issuer_hash<>a.issuer_hash) then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  -- Exact terminal recovery is metadata-only even after stop/reauthorization.
  -- It cannot disclose ciphertext, issue a new grant or contact the provider.
  if x.state in ('committed','failed') and x.request_digest=clued_private.m1_sha256(p_input) then
    return jsonb_build_object('status',x.state,'receipt_id',x.receipt_id); end if;
  if d.connection_id is null or not d.enabled or d.issuer_hash<>a.issuer_hash or c.oauth_client_id<>a.oauth_client_id then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  perform clued_private.storage_connection_current_v1(c.id,c.owner_id);
  perform clued_private.storage_root_quiet_v1(c.owner_id,p.root_folder_id);
  if op='claim' then
    if p_input<>jsonb_build_object('action','claim','connection_id',c.id,'attempt_id',(p_input->>'attempt_id')::uuid) then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    if x.id is not null then return jsonb_build_object('status',x.state,'receipt_id',x.receipt_id); end if;
    if d.failures>=3 or d.next_refresh_at>clock_timestamp() or exists(select 1 from clued_private.storage_refresh_attempts_v1 where connection_id=c.id and state='claimed') then
      raise exception 'storage_refresh_not_due' using errcode='42501'; end if;
    insert into clued_private.storage_refresh_attempts_v1(id,connection_id,issuer_hash,delegation_version,credential_version,state,expires_at)
      values((p_input->>'attempt_id')::uuid,c.id,a.issuer_hash,d.version,c.credential_version,'claimed',clock_timestamp()+interval '2 minutes') returning * into x;
    -- Only the first successful claim discloses ciphertext to the trusted Worker.
    return jsonb_build_object('status','acquired','attempt_id',x.id,'connection_id',c.id,'owner_id',c.owner_id,
      'provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,'credential_version',c.credential_version,
      'credential_envelope',c.credential_envelope,'expires_at',x.expires_at,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id);
  end if;
  if x.id is null then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if x.state<>'claimed' or x.expires_at<=clock_timestamp() or x.delegation_version<>d.version or x.credential_version<>c.credential_version then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if op='commit' then
    if (p_input-array['action','connection_id','attempt_id','credential_envelope','expires_at'])<>'{}'::jsonb
      or not clued_private.storage_envelope_valid_v1(p_input->'credential_envelope') then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    expiry:=(p_input->>'expires_at')::timestamptz;
    if expiry is null or expiry<=clock_timestamp()+interval '60 seconds' or expiry>clock_timestamp()+interval '24 hours' then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  elsif p_input<>jsonb_build_object('action','fail','connection_id',c.id,'attempt_id',x.id,'reason',p_input->>'reason')
    or coalesce(p_input->>'reason','') not in ('provider_rejected','provider_unavailable','credential_invalid') then
    raise exception 'storage_refresh_denied' using errcode='42501';
  end if;
  req:=jsonb_build_object('idempotency_key',x.id::text||':'||op,'request_digest',clued_private.m1_sha256(p_input));
  r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_refresh_result',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if op='commit' then
    update clued_private.storage_connections_v1 set version=version+1,credential_version=credential_version+1,credential_envelope=p_input->'credential_envelope',receipt_id=r.id where id=c.id;
    update clued_private.storage_refresh_delegations_v1 set failures=0,next_refresh_at=greatest(clock_timestamp()+interval '60 seconds',expiry-interval '5 minutes') where connection_id=c.id;
  else
    update clued_private.storage_refresh_delegations_v1 set failures=least(3,failures+1),
      enabled=enabled and p_input->>'reason'='provider_unavailable' and failures<2,
      next_refresh_at=clock_timestamp()+((failures+1)*5)*interval '1 minute' where connection_id=c.id;
    if p_input->>'reason'<>'provider_unavailable' then
      update clued_private.storage_connections_v1 set state='reauthorization_required',version=version+1,receipt_id=r.id where id=c.id; end if;
  end if;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
  ev:=clued_private.m1_append_event_row(c.owner_id,null,r.id,r.canonical_version,'extension:storage:credential_'||op,
    refs,'project:'||p.project_id::text,null,jsonb_build_object('connection_id',c.id,'attempt_id',x.id),
    req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  update clued_private.storage_refresh_attempts_v1 set state=case when op='commit' then 'committed' else 'failed' end,
    request_digest=clued_private.m1_sha256(p_input),receipt_id=r.id where id=x.id returning * into x;
  if x.expires_at<=clock_timestamp() then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  return jsonb_build_object('status',x.state,'receipt_id',r.id);
end $$;
revoke all on function public.clued_storage_refresh_worker_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_refresh_worker_v1(text,jsonb) to anon;

-- Any registered profile for the same root sees the pending refresh fence.
-- Taking the same lock as the original journal serializes claim vs new mutation.
create function clued_private.storage_refresh_mutation_fence_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare root text;
begin
  if new.state not in ('prepared','started') or (tg_op='UPDATE' and new.state=old.state) then return new; end if;
  select root_folder_id into root from clued_private.resource_center_profiles_v1 where id=new.profile_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text||':'||root,0));
  if exists(select 1 from clued_private.storage_refresh_attempts_v1 a
    join clued_private.storage_connections_v1 c on c.id=a.connection_id
    join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
    where c.owner_id=new.user_id and p.root_folder_id=root and a.state='claimed') then
    raise exception 'storage_refresh_pending' using errcode='42501'; end if;
  return new;
end $$;
revoke all on function clued_private.storage_refresh_mutation_fence_v1() from public,anon,authenticated,service_role;
create trigger storage_refresh_mutation_fence_v1 before insert or update on clued_private.resource_center_mutations_v1
  for each row execute function clued_private.storage_refresh_mutation_fence_v1();

-- Fresh native Google consent can recover a lost refresh exchange, but never an
-- unresolved file mutation. Keep the original OAuth implementation and receipt.
alter function public.clued_storage_oauth_v1(text,jsonb) set schema clued_private;
revoke all on function clued_private.clued_storage_oauth_v1(text,jsonb) from public,anon,authenticated,service_role;
create function public.clued_storage_oauth_v1(p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); connection uuid; root text; result jsonb;
begin
  if p_input->>'action' in ('claim','complete') then
    select connection_id into connection from clued_private.storage_oauth_attempts_v1
      where state_hash=p_input->>'state_hash' and owner_id=u;
  else connection:=(p_input->>'connection_id')::uuid; end if;
  select p.root_folder_id into root from clued_private.storage_connections_v1 c
    join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=connection and c.owner_id=u;
  if root is null then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  if p_input->>'action'='complete' then perform clued_private.storage_root_quiet_v1(u,root); end if;
  result:=clued_private.clued_storage_oauth_v1(p_issuer_hash,p_input);
  if p_input->>'action'='complete' and result->>'status'='completed' then
    -- A fresh, verified native OAuth result replaces unknown credential-only
    -- attempts for this exact owner/root, including a previously revoked
    -- connection. This does not settle ANY file mutation or revive old grants.
    update clued_private.storage_refresh_attempts_v1 x set state='superseded',receipt_id=(result->>'receipt_id')::uuid
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
      where x.connection_id=c.id and c.owner_id=u and p.root_folder_id=root and x.state='claimed';
    update clued_private.storage_refresh_delegations_v1 d set enabled=false,version=d.version+1
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
      where d.connection_id=c.id and c.owner_id=u and p.root_folder_id=root;
  end if;
  -- Wrapper recovery updates can wait on delegation rows after the original
  -- function's checks. Expiry during that wait must roll back activation too.
  perform clued_private.storage_owner_v1();
  if p_input->>'action' in ('claim','complete') and not exists (
    select 1 from clued_private.storage_oauth_attempts_v1
    where state_hash=p_input->>'state_hash' and owner_id=u
      and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=p_issuer_hash
      and expires_at>clock_timestamp()) then
    raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  return result;
end $$;
revoke all on function public.clued_storage_oauth_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_oauth_v1(text,jsonb) to authenticated;
