-- Read-only provider observation. This does not qualify a runtime, enable an
-- issuer, grant a Binding, renew a token, or touch any mutation journal/fence.
create table clued_private.storage_directory_probes_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  session_id uuid not null,
  issuer_hash text not null references clued_private.storage_oauth_apps_v1(issuer_hash),
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  descriptor jsonb not null,
  credential_digest text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '90 seconds',
  observation jsonb,
  receipt_id uuid references public.clued_audit_receipts(id),
  check ((observation is null)=(receipt_id is null))
);
create index storage_directory_probe_connection_v1 on clued_private.storage_directory_probes_v1(connection_id);
alter table clued_private.storage_directory_probes_v1 enable row level security;
revoke all on clued_private.storage_directory_probes_v1 from public,anon,authenticated,service_role;

-- Caller has already locked the account, issuer and provider-root. The profile
-- SHARE lock serializes artifact registration/revocation (admin takes UPDATE),
-- including insert phantoms. Pin the complete active directory vector, not just
-- paths or a caller-supplied root. No credential is retained in this descriptor.
create function clued_private.storage_directory_descriptor_v1(p_owner uuid,p_connection uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  a clued_private.resource_center_artifacts_v1; dirs jsonb:='[]'; vector jsonb:='[]';
  decisions jsonb; tracks jsonb; suffix text;
begin
  c:=clued_private.storage_connection_current_v1(p_connection,p_owner);
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  perform 1 from public.clued_memories where id in (
    select source_decision_id from clued_private.resource_center_artifacts_v1
      where profile_id=p.id and user_id=p_owner and state='active' and target_kind='directory'
    union select c.source_decision_id union select p.source_decision_id) order by id for share;
  select jsonb_agg(jsonb_build_object('id',id,'version',version) order by id) into decisions
    from public.clued_memories where id in (
      select source_decision_id from clued_private.resource_center_artifacts_v1
        where profile_id=p.id and user_id=p_owner and state='active' and target_kind='directory'
      union select c.source_decision_id union select p.source_decision_id);
  for a in select * from clued_private.resource_center_artifacts_v1
    where profile_id=p.id and user_id=p_owner and state='active' and target_kind='directory' order by path for share
  loop
    if not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,a.source_decision_id) then
      raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
    vector:=vector||jsonb_build_array(jsonb_build_object('id',a.id,'version',a.version,'path',a.path,
      'provider_file_id',a.provider_file_id,'provider_file_version',a.provider_file_version,
      'source_decision_id',a.source_decision_id));
    -- Start-here governance material is registered but never a writable track.
    if a.path=p.managed_root or (left(a.path,length(p.managed_root)+1)=p.managed_root||'/'
      and split_part(substr(a.path,length(p.managed_root)+2),'/',1)<>'00_从这里开始') then
      dirs:=dirs||jsonb_build_array(jsonb_build_object('path',a.path,'provider_file_id',a.provider_file_id));
    end if;
  end loop;
  select jsonb_agg(name order by name) into tracks from (
    select substr(e->>'path',length(p.managed_root)+2) name from jsonb_array_elements(dirs) e
    where left(e->>'path',length(p.managed_root)+1)=p.managed_root||'/'
      and position('/' in substr(e->>'path',length(p.managed_root)+2))=0) t;
  if tracks is null or jsonb_array_length(tracks) not between 1 and 32 or jsonb_array_length(dirs) not between 2 and 1024
    or not exists(select 1 from jsonb_array_elements(dirs) e where e->>'path'=p.managed_root and e->>'provider_file_id'=p.root_folder_id) then
    raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  for suffix in select value from jsonb_array_elements_text(tracks) loop
    if length(suffix) not between 1 and 160 or suffix ~ '[/\\]' or btrim(suffix)<>suffix or suffix in ('.','..') then
      raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  end loop;
  return jsonb_build_object('owner_id',p_owner,'connection_id',c.id,'connection_version',c.version,
    'credential_version',c.credential_version,'provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,
    'profile_id',p.id,'profile_version',p.version,'policy_version',p.policy_version,'project_id',p.project_id,
    'decisions',decisions,'artifact_vector',vector,'layout',jsonb_build_object(
      'contract','clued.storage-directory-layout/1','managed_root',p.managed_root,'root_folder_id',p.root_folder_id,
      'root_parent_id',p.root_parent_id,'allowed_root_children',tracks,'directories',dirs));
end $$;
revoke all on function clued_private.storage_directory_descriptor_v1(uuid,uuid) from public,anon,authenticated,service_role;

-- Dual-authenticated server channel, not a browser report ingestion endpoint.
-- The Worker sends only its own metadata observation. The browser cannot supply
-- an issuer, owner, profile, directory vector, credentials or observation.
create function public.clued_storage_directory_probe_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); app clued_private.storage_oauth_apps_v1;
  c clued_private.storage_connections_v1; x clued_private.storage_directory_probes_v1;
  cid uuid; root_id text; d jsonb; o jsonb:=p_input->'observation'; item jsonb; expected jsonb; parent_id text;
  r public.clued_audit_receipts; req jsonb; refs jsonb; ev text; result jsonb; op text:=p_input->>'action';
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('prepare','complete') then
    raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  if op='prepare' then
    if p_input is distinct from jsonb_build_object('action','prepare','connection_id',p_input->>'connection_id') then
      raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
    cid:=(p_input->>'connection_id')::uuid;
  else
    if (p_input-array['action','attempt_id','observation'])<>'{}'::jsonb then
      raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
    select * into x from clued_private.storage_directory_probes_v1 where id=(p_input->>'attempt_id')::uuid and owner_id=u
      and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=app.issuer_hash;
    if not found then raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
    cid:=x.connection_id;
  end if;
  select pr.root_folder_id into root_id from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u where co.id=cid and co.owner_id=u;
  if root_id is null then raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root_id,0));
  perform clued_private.storage_root_quiet_v1(u,root_id);
  d:=clued_private.storage_directory_descriptor_v1(u,cid);
  select * into c from clued_private.storage_connections_v1 where id=cid;
  if c.oauth_client_id<>app.oauth_client_id or not clued_private.storage_envelope_valid_v1(c.credential_envelope) then
    raise exception 'storage_directory_probe_denied' using errcode='42501'; end if;
  if op='prepare' then
    insert into clued_private.storage_directory_probes_v1(owner_id,session_id,issuer_hash,connection_id,descriptor,credential_digest)
      values(u,(auth.jwt()->>'session_id')::uuid,app.issuer_hash,cid,d,clued_private.m1_sha256(c.credential_envelope)) returning * into x;
    result:=jsonb_build_object('status','prepared','attempt_id',x.id,'descriptor',d,
      'credential_envelope',c.credential_envelope,'expires_at',x.expires_at);
  else
    select * into x from clued_private.storage_directory_probes_v1 where id=x.id for update;
    if x.expires_at<=clock_timestamp() or x.descriptor is distinct from d or
      x.credential_digest is distinct from clued_private.m1_sha256(c.credential_envelope) then
      raise exception 'storage_directory_probe_stale' using errcode='40001'; end if;
    if x.receipt_id is not null then
      if o is distinct from x.observation then raise exception 'storage_directory_probe_conflict' using errcode='40001'; end if;
    else
      if jsonb_typeof(o) is distinct from 'object' or (o-array['contract','status','execution_permitted','observed_at_ms','directories'])<>'{}'::jsonb
        or o->>'contract' is distinct from 'clued.storage-directory-observation/1' or o->>'status' is distinct from 'metadata_observed'
        or o->'execution_permitted' is distinct from 'false'::jsonb or jsonb_typeof(o->'observed_at_ms') is distinct from 'number'
        or (o->>'observed_at_ms')::numeric < extract(epoch from x.created_at)*1000-1000
        or (o->>'observed_at_ms')::numeric > extract(epoch from clock_timestamp())*1000+1000
        or jsonb_typeof(o->'directories') is distinct from 'array' then
        raise exception 'storage_directory_probe_invalid' using errcode='22023'; end if;
      if jsonb_array_length(o->'directories')<>jsonb_array_length(d->'layout'->'directories') or
        (select count(distinct e->>'path') from jsonb_array_elements(o->'directories') e)<>jsonb_array_length(o->'directories') then
        raise exception 'storage_directory_probe_invalid' using errcode='22023'; end if;
      for item in select value from jsonb_array_elements(o->'directories') loop
        select e into expected from jsonb_array_elements(d->'layout'->'directories') e where e->>'path'=item->>'path';
        if item->>'path'=d->'layout'->>'managed_root' then parent_id:=d->'layout'->>'root_parent_id';
        else select e->>'provider_file_id' into parent_id from jsonb_array_elements(d->'layout'->'directories') e
          where e->>'path'=regexp_replace(item->>'path','/[^/]+$',''); end if;
        if expected is null or parent_id is null or jsonb_typeof(item) is distinct from 'object'
          or (item-array['path','provider_file_id','provider_file_version','parent_id'])<>'{}'::jsonb
          or item->>'provider_file_id' is distinct from expected->>'provider_file_id' or item->>'parent_id' is distinct from parent_id
          or coalesce(item->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$' then
          raise exception 'storage_directory_probe_invalid' using errcode='22023'; end if;
      end loop;
      req:=jsonb_build_object('idempotency_key',x.id::text||':directory-observation','attempt_id',x.id,
        'descriptor_digest',clued_private.m1_sha256(d),'observation_digest',clued_private.m1_sha256(o));
      r:=clued_private.m1_begin_receipt(u,null,'storage_directory_observe',req,clued_private.m1_sha256(req));
      if r.status<>'pending' then raise exception 'storage_directory_probe_conflict' using errcode='40001'; end if;
      refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',cid));
      ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:directory_observed',refs,
        'project:'||(d->>'project_id'),null,req-'idempotency_key',req->>'idempotency_key',r.request_sha256,
        'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
      perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
      update clued_private.storage_directory_probes_v1 set observation=o,receipt_id=r.id where id=x.id;
      x.receipt_id:=r.id;
    end if;
    result:=jsonb_build_object('status','metadata_observed','attempt_id',x.id,'receipt_id',x.receipt_id,'execution_permitted',false);
  end if;
  -- Wall-clock checks after all lock waits. Expiry is not transaction-start now().
  perform clued_private.storage_owner_v1();
  if x.expires_at<=clock_timestamp() then raise exception 'storage_directory_probe_stale' using errcode='40001'; end if;
  return result;
end $$;
revoke all on function public.clued_storage_directory_probe_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_directory_probe_v1(text,jsonb) to authenticated;
