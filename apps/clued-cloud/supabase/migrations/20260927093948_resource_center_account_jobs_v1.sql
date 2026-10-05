-- Account-wide correlation, not a new permission system or execution grant.
-- Provider effects still use the original journal, admission and root fence.
create table clued_private.storage_jobs_v1 (
  owner_id uuid not null references auth.users(id),
  job_id uuid not null,
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  binding_id uuid not null references public.clued_agent_bindings(id),
  grant_receipt_id uuid not null references public.clued_audit_receipts(id),
  authorization_version bigint not null,
  request_digest text not null check(request_digest ~ '^[0-9a-f]{64}$'),
  mutation jsonb not null,
  intent_id uuid unique references clued_private.resource_center_mutations_v1(id),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,job_id)
);
create index storage_jobs_connection_v1 on clued_private.storage_jobs_v1(connection_id);
alter table clued_private.storage_jobs_v1 enable row level security;
revoke all on clued_private.storage_jobs_v1 from public,anon,authenticated,service_role;

-- All job paths take owner/job -> provider-root -> Binding/authorization ->
-- account/connection/grant -> profile/Decision -> job -> original journal.
-- No lock is held over provider HTTP. A committed start is already in flight.
create function clued_private.storage_job_status_v1(p_job clued_private.storage_jobs_v1)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('job_id',p_job.job_id,'request_digest',p_job.request_digest,
    'connection_id',p_job.connection_id,'status',coalesce(m.state,'queued'),
    'intent_id',m.id,'receipt_id',coalesce(m.receipt_id,p_job.receipt_id),
    'execution_permitted',false)
  from (values(1)) seed(n) left join clued_private.resource_center_mutations_v1 m on m.id=p_job.intent_id
$$;
revoke all on function clued_private.storage_job_status_v1(clued_private.storage_jobs_v1) from public,anon,authenticated,service_role;

create function public.clued_storage_jobs_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; j clued_private.storage_jobs_v1;
  r public.clued_audit_receipts; g clued_private.storage_client_grants_v1;
  op text:=p_input->>'action'; m jsonb:=p_input->'mutation';
  job uuid; wanted text; digest text; refs jsonb; ev text;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('submit','inspect')
    or (p_input-array['action','connection_id','job_id','mutation'])<>'{}'::jsonb
    or jsonb_typeof(p_input->'job_id') is distinct from 'string'
    or jsonb_typeof(p_input->'connection_id') is distinct from 'string'
    or (op='inspect' and p_input ? 'mutation') then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  job:=(p_input->>'job_id')::uuid;
  wanted:='inspect';
  if op='submit' then
    if jsonb_typeof(m) is distinct from 'object'
      or (m-array['operation','destination_path','target_kind','directory_semantics','content'])<>'{}'::jsonb
      or m->>'operation' is distinct from 'create'
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or jsonb_typeof(m->'destination_path') is distinct from 'string'
      or length(m->>'destination_path') not between 1 and 1000 then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    if m->>'target_kind'='file' then
      wanted:='create_file';
      if jsonb_typeof(m->'content') is distinct from 'string' or m ? 'directory_semantics'
        or octet_length(m->>'content')>1048576 then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    else
      wanted:='create_topic';
      if m ? 'content' or coalesce(m->>'directory_semantics','') not in ('topic','asset_collection') then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    end if;
  end if;
  -- Unlocked lookup only chooses locks; storage_binding_v1 revalidates authority.
  select * into b from public.clued_agent_bindings where token_hash=p_token_hash;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=b.user_id;
  if c.id is null then raise exception 'storage_binding_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||b.user_id::text||':'||job::text,0));
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(b.user_id::text||':'||p.root_folder_id,0));
  b:=clued_private.storage_binding_v1(p_token_hash,c.id,wanted);
  select * into j from clued_private.storage_jobs_v1 where owner_id=b.user_id and job_id=job for update;
  if op='inspect' then
    if j.job_id is null or j.connection_id<>c.id then raise exception 'storage_job_unavailable' using errcode='42501'; end if;
    return clued_private.storage_job_status_v1(j);
  end if;
  digest:=clued_private.m1_sha256(jsonb_build_object('connection_id',c.id,'mutation',m));
  if j.job_id is not null then
    if j.request_digest<>digest or j.connection_id<>c.id then
      raise exception 'storage_job_identity_conflict' using errcode='40001'; end if;
    return clued_private.storage_job_status_v1(j)||jsonb_build_object('replayed',true);
  end if;
  r:=clued_private.m1_begin_receipt(b.user_id,b.id,'storage_job_submit',
    jsonb_build_object('idempotency_key','storage-job:'||job::text,'job_id',job,'request_digest',digest),digest);
  if r.status<>'pending' then raise exception 'storage_job_receipt_conflict' using errcode='40001'; end if;
  select * into g from clued_private.storage_client_grants_v1 where connection_id=c.id and binding_id=b.id;
  insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,authorization_version,request_digest,mutation,receipt_id)
    values(b.user_id,job,c.id,b.id,g.receipt_id,g.authorization_version,digest,m,r.id) returning * into j;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',job));
  ev:=clued_private.m1_append_event_row(b.user_id,b.id,r.id,r.canonical_version,'extension:storage:job_submitted',
    refs,'project:'||p.project_id::text,null,jsonb_build_object('job_id',job,'connection_id',c.id,'request_digest',digest),
    'storage-job:'||job::text,r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,jsonb_build_object(job::text,1),array[ev],'{}'::uuid[],null);
  perform clued_private.storage_binding_v1(p_token_hash,c.id,wanted);
  return clued_private.storage_job_status_v1(j)||jsonb_build_object('replayed',false);
end $$;
revoke all on function public.clued_storage_jobs_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_jobs_v1(text,jsonb) to anon;

-- Internal composition point only: no public/service-role execute grant. The
-- eventual qualified cloud writer must consume this, not return it to an Agent.
-- Preparation and single start commit atomically with the account job link.
-- No independent attempt state, retry flag, timeout reset or second root fence.
create function clued_private.storage_job_begin_v1(p_owner uuid,p_job uuid,p_writer_hash text,p_prepare jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; b public.clued_agent_bindings;
  w clued_private.resource_center_writer_bindings_v1; a clued_private.resource_center_bindings_v1;
  prepared jsonb; started jsonb; wanted text; field text; am jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
  if not found then raise exception 'storage_job_unavailable' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text||':'||p.root_folder_id,0));
  select * into b from public.clued_agent_bindings where id=j.binding_id and user_id=p_owner;
  wanted:=case when j.mutation->>'target_kind'='file' then 'create_file' else 'create_topic' end;
  perform clued_private.storage_binding_v1(b.token_hash,c.id,wanted);
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job for update;
  if j.intent_id is not null then return clued_private.storage_job_status_v1(j)||jsonb_build_object('replayed',true); end if;
  -- Regrant/reduction must never silently revive queued work admitted under a
  -- previous grant. Receipt identity is its immutable generation, not a device.
  if not exists(select 1 from clued_private.storage_client_grants_v1 g where g.connection_id=c.id and g.binding_id=b.id
    and g.receipt_id=j.grant_receipt_id and g.authorization_version=j.authorization_version) then
    raise exception 'storage_job_grant_changed' using errcode='42501'; end if;
  select * into w from clued_private.resource_center_writer_bindings_v1 where token_hash=p_writer_hash;
  select * into a from clued_private.resource_center_bindings_v1 where id=w.authority_binding_id;
  if a.profile_id is distinct from p.id or a.user_id is distinct from p_owner
    or p_prepare->>'action' is distinct from 'prepare'
    or p_prepare->>'request_key' is distinct from ('account-job:'||p_job::text)
    or p_prepare->'exact_request'->'mutation' is distinct from (j.mutation||jsonb_build_object('artifact_role','clued_resource')) then
    raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
  -- Host-derived authority/binding cannot authorize B while the stored job
  -- and provider payload still describe A. Only canonical exact paths enter
  -- this composition point; the Host must not silently retarget/normalize it.
  am:=p_prepare->'authority_request'->'mutation';
  foreach field in array array['operation','destination_path','target_kind','directory_semantics'] loop
    if coalesce(am->field,'null'::jsonb) is distinct from coalesce(j.mutation->field,'null'::jsonb) then
      raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
  end loop;
  if am->>'artifact_role' is distinct from 'clued_resource' or am->>'source_path' is not null then
    raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
  prepared:=public.clued_resource_center_write_v1(p_writer_hash,p_prepare);
  if prepared->>'state' is distinct from 'prepared' or prepared->>'status' is distinct from 'committed' then
    raise exception 'storage_job_prepare_denied' using errcode='42501'; end if;
  started:=public.clued_resource_center_write_v1(p_writer_hash,jsonb_build_object('action','start',
    'intent_id',prepared->'intent_id','base_version',prepared->'version','request_sha256',prepared->'request_sha256',
    'idempotency_key','account-job:'||p_job::text||':start'));
  if started->>'state' is distinct from 'started' or started->'execution_permitted' is distinct from 'true'::jsonb then
    raise exception 'storage_job_start_denied' using errcode='42501'; end if;
  update clued_private.storage_jobs_v1 set intent_id=(started->>'intent_id')::uuid where owner_id=p_owner and job_id=p_job;
  -- Expiry during profile/journal/receipt locks rolls back the whole attempt.
  perform clued_private.storage_binding_v1(b.token_hash,c.id,wanted);
  return started||jsonb_build_object('job_id',p_job,'job_request_digest',j.request_digest);
end $$;
revoke all on function clued_private.storage_job_begin_v1(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
