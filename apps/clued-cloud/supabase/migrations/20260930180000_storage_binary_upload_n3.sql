-- StorageNormalUse.v0.1 N3 (§5.3, §6, §7.2, m-e, m-f, m-l, MAJOR-2): binary
-- `create` through an encrypted staging object.
--
-- * storage_staging_v1: one row per staged object (issued -> receiving ->
--   validating -> ready -> consumed, or rejected / expired). It records owner,
--   connection, Binding, destination_path and the declared size / sha256 /
--   MIME, the staging keyring key_id, and the upload budget reservation. The
--   bytes live only in R2, AEAD-encrypted by the Worker; no byte, key or URL
--   token is stored here.
-- * public.clued_storage_staging_v1 (anon, fixed server issuer): `begin`
--   (with the caller's Binding token; policy evaluation + binary gate + upload
--   budget reserved at URL issue), `receive` (signed-URL claims; single-use
--   issued -> receiving CAS; gate re-evaluated for the row's Binding),
--   `received`, `validated`, `sweep` (TTL expiry, 12 h job cancel, deletable
--   objects) and `object_deleted`.
-- * Binary gate (§6.1, M3, m-c): create_file in the active write policy AND
--   active read access with content_profile 'normal/1' (read_content) AND
--   provider_scope_profile 'normal'. Checked at begin, at the PUT, at submit
--   and at execution admission (until the provider attempt is recorded).
-- * Submit accepts {create, file, destination_path, mime_type, content_sha256,
--   staging_id} and stores {create, file, destination_path, content_ref:
--   {staging_id, sha256, size, mime_type}}; the request digest covers
--   content_ref. The staging row must be ready, unexpired and match Binding,
--   connection, path, MIME and sha256; it becomes consumed by that job.
-- * Every live size / sha256 derivation from mutation.content now takes
--   content_ref for a content_ref job (m-f): storage_job_provider_attempt_v2
--   and storage_verified_result_v2 (anchored patches, exact hit counts). The
--   verified proof of a binary create is clued.storage-create-verified/3
--   (adds mime_type; Drive's sha256Checksum must equal the declared sha256).
--   Text creates keep /2; P4 replace (text only) is unchanged; the legacy v1
--   job path never accepts a staging_id.

create table clued_private.storage_staging_v1 (
  id uuid primary key,
  owner_id uuid not null references auth.users(id),
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  binding_id uuid not null references public.clued_agent_bindings(id),
  destination_path text not null check(length(destination_path) between 1 and 1000),
  mime_type text not null check(mime_type ~ '^[a-z0-9][a-z0-9.+-]{0,126}/[a-z0-9][a-z0-9.+-]{0,126}$'),
  size bigint not null check(size between 1 and 20971520),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  transport text not null check(transport in ('url','inline')),
  state text not null default 'issued'
    check(state in ('issued','receiving','validating','ready','consumed','rejected','expired')),
  key_id text check(key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  reject_reason text check(reject_reason in ('digest_mismatch','length_mismatch','content_type_mismatch','storage_failed','stalled')),
  job_id uuid,
  reserved_bytes bigint not null check(reserved_bytes=size),
  bytes_received boolean not null default false,
  released_at timestamptz,
  expires_at timestamptz not null,
  received_at timestamptz,
  ready_at timestamptz,
  ready_expires_at timestamptz,
  object_deleted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check((state='consumed')=(job_id is not null)),
  check(state='issued' or state='expired' or bytes_received),
  check(released_at is null or not bytes_received),
  check(state not in ('ready','consumed') or (ready_at is not null and ready_expires_at is not null and key_id is not null))
);
create index storage_staging_binding_window_v1 on clued_private.storage_staging_v1(binding_id,created_at) where released_at is null;
create index storage_staging_owner_window_v1 on clued_private.storage_staging_v1(owner_id,created_at) where released_at is null;
create index storage_staging_sweep_v1 on clued_private.storage_staging_v1(state,expires_at) where object_deleted_at is null;
create unique index storage_staging_job_v1 on clued_private.storage_staging_v1(job_id) where job_id is not null;

-- Identity and reservation are immutable; only the listed lifecycle moves.
create function clued_private.storage_staging_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare mutable constant text[]:=array['state','key_id','job_id','released_at','received_at','ready_at','ready_expires_at',
  'reject_reason','object_deleted_at','bytes_received'];
begin
  if tg_op='DELETE' then raise exception 'storage_staging_immutable' using errcode='42501'; end if;
  if (to_jsonb(new)-mutable) is distinct from (to_jsonb(old)-mutable)
    or (new.state<>old.state and (old.state,new.state) not in (('issued','receiving'),('issued','expired'),
      ('receiving','validating'),('receiving','rejected'),('validating','ready'),('validating','rejected'),
      ('ready','consumed'),('ready','expired')))
    or (new.key_id is distinct from old.key_id and not (old.state='issued' and new.state='receiving'))
    or (new.bytes_received is distinct from old.bytes_received and not (old.state='issued' and new.state='receiving'))
    or (new.job_id is distinct from old.job_id and not (old.state='ready' and new.state='consumed'))
    or (new.released_at is distinct from old.released_at and not (old.released_at is null and old.state='issued' and new.state='expired'))
    or (old.object_deleted_at is not null and new.object_deleted_at is distinct from old.object_deleted_at) then
    raise exception 'storage_staging_immutable' using errcode='42501'; end if;
  return new;
end $$;
create trigger storage_staging_immutable_v1 before update or delete on clued_private.storage_staging_v1
  for each row execute function clued_private.storage_staging_guard_v1();
alter table clued_private.storage_staging_v1 enable row level security;
revoke all on clued_private.storage_staging_v1 from public,anon,authenticated,service_role;

-- Extension <-> MIME allow table (§6.3). Mirrors kernel/host/resource-center-storage-binary.mjs;
-- macro-enabled, executable, script, HTML/XHTML/SVG and Google-native types are absent by design.
create function clued_private.storage_binary_mime_v1(p_path text,p_mime text)
returns boolean language plpgsql immutable set search_path='' as $$
declare name text; ext text; bad constant text:='(\\|//|/\./|/\.\./|/\.$|/\.\.$|/$)';
begin
  if p_path is null or p_mime is null or length(p_path) not between 1 and 1000 or p_path ~ bad or strpos(p_path,'/')=0 then return false; end if;
  name:=regexp_replace(p_path,'^.*/','');
  if strpos(name,'.')<=1 or right(name,1)='.' then return false; end if;
  ext:=lower(regexp_replace(name,'^.*\.',''));
  -- An unlisted extension yields NULL, which must refuse (never pass through as unknown).
  return coalesce(p_mime = case ext
    when 'png' then 'image/png' when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg'
    when 'gif' then 'image/gif' when 'webp' then 'image/webp' when 'pdf' then 'application/pdf'
    when 'zip' then 'application/zip'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'pptx' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    when 'odt' then 'application/vnd.oasis.opendocument.text'
    when 'ods' then 'application/vnd.oasis.opendocument.spreadsheet'
    when 'odp' then 'application/vnd.oasis.opendocument.presentation'
    when 'doc' then 'application/msword' when 'xls' then 'application/vnd.ms-excel'
    when 'ppt' then 'application/vnd.ms-powerpoint' end,false);
end $$;

-- §6.1 binary gate for one connection (the create_file half is the policy evaluation).
create function clued_private.storage_binary_gate_v1(p_connection uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.storage_connections_v1 c
    join clued_private.storage_read_access_v1 ra on ra.connection_id=c.id and ra.owner_id=c.owner_id
      and ra.state='active' and ra.account_policy_id=c.account_policy_id
    where c.id=p_connection and c.auth_mode='account_policy' and c.state='active' and c.revoked_at is null
      and c.provider_scope_profile='normal' and ra.content_profile='normal/1' and 'read_content'=any(ra.classes))
$$;

-- §7.1 / §7.2: upload bytes per rolling hour, reserved at URL issue (inline: at
-- request start). Owner lock before Binding lock, both after policy evaluation.
create function clued_private.storage_upload_budget_v1(p_owner uuid,p_binding uuid,p_size bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-upload-budget-owner:'||p_owner::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-upload-budget:'||p_binding::text,0));
  if (select coalesce(sum(reserved_bytes),0) from clued_private.storage_staging_v1
        where binding_id=p_binding and released_at is null and created_at>clock_timestamp()-interval '1 hour')+p_size>268435456
    or (select coalesce(sum(reserved_bytes),0) from clued_private.storage_staging_v1
        where owner_id=p_owner and released_at is null and created_at>clock_timestamp()-interval '1 hour')+p_size>1073741824 then
    raise exception 'storage_upload_budget_exhausted' using errcode='42501'; end if;
end $$;

-- Submit shape of a binary create and its stored form. Values come from the
-- staging row (immutable identity), so a replay derives the same digest.
create function clued_private.storage_binary_submit_mutation_v1(p_connection uuid,m jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare keys text[]; s clued_private.storage_staging_v1;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  select array_agg(k order by k) into keys from jsonb_object_keys(m) k;
  if keys is distinct from array['content_sha256','destination_path','mime_type','operation','staging_id','target_kind']
    or m->>'operation' is distinct from 'create' or m->>'target_kind' is distinct from 'file'
    or jsonb_typeof(m->'staging_id') is distinct from 'string' or m->>'staging_id' !~ uuid_re
    or jsonb_typeof(m->'content_sha256') is distinct from 'string' or m->>'content_sha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(m->'mime_type') is distinct from 'string'
    or not clued_private.storage_binary_mime_v1(m->>'destination_path',m->>'mime_type') then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  select * into s from clued_private.storage_staging_v1 where id=(m->>'staging_id')::uuid and connection_id=p_connection;
  if not found or s.destination_path is distinct from m->>'destination_path' or s.mime_type is distinct from m->>'mime_type'
    or s.sha256 is distinct from m->>'content_sha256' then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('operation','create','target_kind','file','destination_path',s.destination_path,
    'content_ref',jsonb_build_object('staging_id',s.id,'sha256',s.sha256,'size',s.size,'mime_type',s.mime_type));
end $$;

-- At submit, after policy evaluation: the ready row of the same Binding is
-- consumed by this job (single use); gate rechecked.
create function clued_private.storage_staging_consume_v1(m jsonb,p_owner uuid,p_binding uuid,p_connection uuid,p_job uuid)
returns void language plpgsql security definer set search_path='' as $$
declare s clued_private.storage_staging_v1;
begin
  if not (m ? 'content_ref') then return; end if;
  select * into s from clued_private.storage_staging_v1 where id=(m->'content_ref'->>'staging_id')::uuid for update;
  if not found or s.owner_id<>p_owner or s.connection_id<>p_connection or s.binding_id<>p_binding
    or s.destination_path<>m->>'destination_path' or s.sha256<>m->'content_ref'->>'sha256'
    or s.size<>(m->'content_ref'->>'size')::bigint or s.mime_type<>m->'content_ref'->>'mime_type' then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  if s.state<>'ready' or s.ready_expires_at<=clock_timestamp() then raise exception 'staging_expired' using errcode='42501'; end if;
  if not clued_private.storage_binary_gate_v1(p_connection) then
    raise exception 'storage_binary_upload_disabled' using errcode='42501'; end if;
  update clued_private.storage_staging_v1 set state='consumed',job_id=p_job where id=s.id;
end $$;

-- Execution admission of a binary job, until its provider attempt is recorded:
-- the gate again, the consumed row of this job, and the 12 h start window.
create function clued_private.storage_binary_execution_v1(j clued_private.storage_jobs_v1)
returns void language plpgsql stable security definer set search_path='' as $$
declare s clued_private.storage_staging_v1;
begin
  if not (j.mutation ? 'content_ref') then return; end if;
  if j.intent_id is not null and exists(select 1 from clued_private.resource_center_mutations_v1
      where id=j.intent_id and user_id=j.owner_id and provider_attempt is not null) then return; end if;
  if not clued_private.storage_binary_gate_v1(j.connection_id) then
    raise exception 'storage_binary_upload_disabled' using errcode='42501'; end if;
  select * into s from clued_private.storage_staging_v1 where id=(j.mutation->'content_ref'->>'staging_id')::uuid;
  if not found or s.state<>'consumed' or s.job_id<>j.job_id or s.owner_id<>j.owner_id or s.connection_id<>j.connection_id
    or s.binding_id<>j.binding_id or s.sha256<>j.mutation->'content_ref'->>'sha256'
    or s.size<>(j.mutation->'content_ref'->>'size')::bigint or s.mime_type<>j.mutation->'content_ref'->>'mime_type' then
    raise exception 'storage_cloud_snapshot_changed' using errcode='42501'; end if;
  if j.intent_id is null and (s.object_deleted_at is not null or j.created_at<=clock_timestamp()-interval '12 hours') then
    raise exception 'staging_expired' using errcode='42501'; end if;
end $$;

-- Execution descriptor: where the Worker finds and how it opens the staged object.
create function clued_private.storage_staging_descriptor_v1(j clued_private.storage_jobs_v1)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when j.mutation ? 'content_ref' then (select jsonb_build_object('staging_id',s.id,'key_id',s.key_id,
      'size',s.size,'sha256',s.sha256,'mime_type',s.mime_type)
    from clued_private.storage_staging_v1 s where s.id=(j.mutation->'content_ref'->>'staging_id')::uuid and s.job_id=j.job_id) end
$$;

-- A binary job not started within 12 hours is cancelled like a denied dispatch.
create function clued_private.storage_staging_cancel_job_v1(p_owner uuid,p_job uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; p clued_private.resource_center_profiles_v1; root text;
  r public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
begin
  select pr.root_folder_id into root from clued_private.storage_jobs_v1 j0
    join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
    join clued_private.resource_center_profiles_v1 pr on pr.id=c0.profile_id and pr.user_id=j0.owner_id
    where j0.owner_id=p_owner and j0.job_id=p_job;
  if root is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text||':'||root,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job for update;
  if not (j.mutation ? 'content_ref') or j.intent_id is not null or j.dispatch_outcome is not null
    or j.created_at>clock_timestamp()-interval '12 hours' then return false; end if;
  select pr.* into p from clued_private.storage_connections_v1 c0
    join clued_private.resource_center_profiles_v1 pr on pr.id=c0.profile_id and pr.user_id=c0.owner_id where c0.id=j.connection_id;
  req:=jsonb_build_object('idempotency_key','cloud-dispatch-outcome:'||j.job_id::text,'job_id',j.job_id,
    'outcome',jsonb_build_object('status','denied'));
  r:=clued_private.m1_begin_receipt(p_owner,null,'storage_dispatch_outcome',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then return false; end if;
  update clued_private.storage_jobs_v1 set dispatch_outcome=req->'outcome',dispatch_outcome_receipt_id=r.id
    where owner_id=p_owner and job_id=j.job_id;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',j.job_id));
  ev:=clued_private.m1_append_event_row(p_owner,null,r.id,r.canonical_version,'extension:storage:dispatch_outcome',
    refs,'project:'||p.project_id::text,null,req||jsonb_build_object('reason','staging_expired'),req->>'idempotency_key',
    r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  return true;
end $$;

-- Objects the Worker may delete from R2: rejected / expired rows that received
-- bytes, and consumed rows whose job started (intent) or was settled out.
create function clued_private.storage_staging_deletable_v1(s clued_private.storage_staging_v1)
returns boolean language sql stable security definer set search_path='' as $$
  select s.object_deleted_at is null and s.bytes_received and (s.state in ('rejected','expired') or (s.state='consumed' and exists(
    select 1 from clued_private.storage_jobs_v1 j where j.owner_id=s.owner_id and j.job_id=s.job_id
      and (j.intent_id is not null or j.dispatch_outcome is not null))))
$$;

create function public.clued_storage_staging_v1(p_issuer_hash text,p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op text:=p_input->>'action'; app clued_private.storage_oauth_apps_v1; c clued_private.storage_connections_v1;
  s clued_private.storage_staging_v1; b public.clued_agent_bindings; snapshot jsonb; sid uuid;
  expired int:=0; stalled int:=0; cancelled int:=0; marked int:=0; job record; deletable jsonb;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(p_issuer_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
    or coalesce(op,'') not in ('begin','receive','received','validated','sweep','object_deleted')
    -- Only begin carries the caller's Binding token; every other action is the fixed server issuer alone.
    or (op='begin') is distinct from (p_token_hash is not null)
    or (p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'storage_staging_input_invalid' using errcode='22023'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null and execution_enabled for share;
  if not found then raise exception 'storage_staging_denied' using errcode='42501'; end if;

  if op='begin' then
    if (p_input-array['action','connection_id','destination_path','mime_type','size','content_sha256','transport'])<>'{}'::jsonb
      or not (p_input ?& array['action','connection_id','destination_path','mime_type','size','content_sha256','transport'])
      or coalesce(p_input->>'connection_id','') !~ uuid_re
      or jsonb_typeof(p_input->'destination_path') is distinct from 'string' or jsonb_typeof(p_input->'mime_type') is distinct from 'string'
      or jsonb_typeof(p_input->'size') is distinct from 'number' or p_input->>'size' !~ '^[1-9][0-9]{0,7}$'
      or (p_input->>'size')::bigint>20971520
      or jsonb_typeof(p_input->'content_sha256') is distinct from 'string' or p_input->>'content_sha256' !~ '^[0-9a-f]{64}$'
      or coalesce(p_input->>'transport','') not in ('url','inline') then
      raise exception 'storage_staging_input_invalid' using errcode='22023'; end if;
    if not clued_private.storage_binary_mime_v1(p_input->>'destination_path',p_input->>'mime_type') then
      raise exception 'content_type_mismatch' using errcode='22023'; end if;
    sid:=gen_random_uuid();
    snapshot:=clued_private.storage_policy_evaluate_v2(p_token_hash,(p_input->>'connection_id')::uuid,'create_file',sid);
    select * into c from clued_private.storage_connections_v1 where id=(snapshot->>'connection_id')::uuid for share;
    if c.oauth_client_id is distinct from app.oauth_client_id then raise exception 'storage_staging_denied' using errcode='42501'; end if;
    if not clued_private.storage_binary_gate_v1(c.id) then raise exception 'storage_binary_upload_disabled' using errcode='42501'; end if;
    perform clued_private.storage_upload_budget_v1(c.owner_id,(snapshot->>'binding_id')::uuid,(p_input->>'size')::bigint);
    insert into clued_private.storage_staging_v1(id,owner_id,connection_id,binding_id,destination_path,mime_type,size,sha256,
      transport,reserved_bytes,expires_at)
    values(sid,c.owner_id,c.id,(snapshot->>'binding_id')::uuid,p_input->>'destination_path',p_input->>'mime_type',
      (p_input->>'size')::bigint,p_input->>'content_sha256',p_input->>'transport',(p_input->>'size')::bigint,
      date_trunc('second',clock_timestamp())+interval '10 minutes')
    returning * into s;
    return jsonb_build_object('contract','clued.storage-staging/1','staging_id',s.id,'owner_id',s.owner_id,'connection_id',s.connection_id,
      'binding_id',s.binding_id,'destination_path',s.destination_path,'mime_type',s.mime_type,'size',s.size,'sha256',s.sha256,
      'transport',s.transport,'state',s.state,'expires_at',extract(epoch from s.expires_at)::bigint);
  end if;

  if op='receive' then
    if (p_input-array['action','staging_id','owner_id','connection_id','binding_id','sha256','size','mime_type','exp','key_id'])<>'{}'::jsonb
      or not (p_input ?& array['action','staging_id','owner_id','connection_id','binding_id','sha256','size','mime_type','exp','key_id'])
      or coalesce(p_input->>'staging_id','') !~ uuid_re or coalesce(p_input->>'owner_id','') !~ uuid_re
      or coalesce(p_input->>'connection_id','') !~ uuid_re or coalesce(p_input->>'binding_id','') !~ uuid_re
      or jsonb_typeof(p_input->'size') is distinct from 'number' or jsonb_typeof(p_input->'exp') is distinct from 'number'
      or coalesce(p_input->>'key_id','') !~ '^[A-Za-z0-9_-]{1,64}$' then
      raise exception 'upload_url_invalid' using errcode='42501'; end if;
    -- Unlocked hint for the Binding only; everything is rechecked after the evaluator's locks.
    select * into s from clued_private.storage_staging_v1 where id=(p_input->>'staging_id')::uuid;
    if not found or s.owner_id::text<>p_input->>'owner_id' or s.connection_id::text<>p_input->>'connection_id'
      or s.binding_id::text<>p_input->>'binding_id' or s.sha256 is distinct from p_input->>'sha256'
      or s.size::text<>p_input->>'size' or s.mime_type is distinct from p_input->>'mime_type'
      or extract(epoch from s.expires_at)::bigint::text<>p_input->>'exp' then
      raise exception 'upload_url_invalid' using errcode='42501'; end if;
    select * into c from clued_private.storage_connections_v1 where id=s.connection_id and owner_id=s.owner_id;
    if not found or c.oauth_client_id is distinct from app.oauth_client_id then raise exception 'storage_staging_denied' using errcode='42501'; end if;
    select * into b from public.clued_agent_bindings where id=s.binding_id and user_id=s.owner_id;
    if not found then raise exception 'storage_binary_upload_disabled' using errcode='42501'; end if;
    -- The row's Binding must still hold create_file on this connection (lifecycle, policy, client deny).
    perform clued_private.storage_policy_evaluate_v2(b.token_hash,s.connection_id,'create_file',s.id);
    select * into s from clued_private.storage_staging_v1 where id=s.id for update;
    if s.state<>'issued' then raise exception 'upload_url_used' using errcode='42501'; end if;
    if s.expires_at<=clock_timestamp() then raise exception 'staging_expired' using errcode='42501'; end if;
    if not clued_private.storage_binary_gate_v1(s.connection_id) then raise exception 'storage_binary_upload_disabled' using errcode='42501'; end if;
    update clued_private.storage_staging_v1 set state='receiving',key_id=p_input->>'key_id',bytes_received=true,
      received_at=clock_timestamp() where id=s.id returning * into s;
    return jsonb_build_object('staging_id',s.id,'owner_id',s.owner_id,'connection_id',s.connection_id,'size',s.size,
      'sha256',s.sha256,'mime_type',s.mime_type,'key_id',s.key_id,'state',s.state);
  end if;

  if op in ('received','validated') then
    if (p_input-array['action','staging_id','outcome','reason'])<>'{}'::jsonb or coalesce(p_input->>'staging_id','') !~ uuid_re
      or coalesce(p_input->>'outcome','') not in (case op when 'received' then 'validating' else 'ready' end,'rejected')
      or (p_input->>'outcome'='rejected') is distinct from (p_input ? 'reason')
      or (p_input ? 'reason' and coalesce(p_input->>'reason','') not in ('digest_mismatch','length_mismatch','content_type_mismatch','storage_failed')) then
      raise exception 'storage_staging_input_invalid' using errcode='22023'; end if;
    select s0.* into s from clued_private.storage_staging_v1 s0 join clued_private.storage_connections_v1 c0
      on c0.id=s0.connection_id and c0.oauth_client_id=app.oauth_client_id where s0.id=(p_input->>'staging_id')::uuid for update of s0;
    if not found then raise exception 'storage_staging_denied' using errcode='42501'; end if;
    if s.state=p_input->>'outcome' and (s.state<>'rejected' or s.reject_reason=p_input->>'reason') then
      return jsonb_build_object('staging_id',s.id,'state',s.state,'replayed',true); end if;
    if s.state<>(case op when 'received' then 'receiving' else 'validating' end) then
      raise exception 'storage_staging_state_conflict' using errcode='40001'; end if;
    update clued_private.storage_staging_v1 set state=p_input->>'outcome',reject_reason=p_input->>'reason',
      ready_at=case when p_input->>'outcome'='ready' then clock_timestamp() end,
      ready_expires_at=case when p_input->>'outcome'='ready' then clock_timestamp()+interval '1 hour' end
      where id=s.id returning * into s;
    return jsonb_build_object('staging_id',s.id,'state',s.state,'replayed',false,
      'ready_expires_at',case when s.ready_expires_at is not null then extract(epoch from s.ready_expires_at)::bigint end);
  end if;

  if op='sweep' then
    if p_input<>'{"action":"sweep"}'::jsonb then raise exception 'storage_staging_input_invalid' using errcode='22023'; end if;
    -- Unused URLs: no byte arrived, so the reservation is released.
    with x as (update clued_private.storage_staging_v1 s0 set state='expired',released_at=clock_timestamp()
      from clued_private.storage_connections_v1 c0 where c0.id=s0.connection_id and c0.oauth_client_id=app.oauth_client_id
        and s0.state='issued' and s0.expires_at<=clock_timestamp() returning 1) select count(*) into expired from x;
    -- Ready but never submitted within 1 hour: bytes arrived, the reservation stays.
    with x as (update clued_private.storage_staging_v1 s0 set state='expired'
      from clued_private.storage_connections_v1 c0 where c0.id=s0.connection_id and c0.oauth_client_id=app.oauth_client_id
        and s0.state='ready' and s0.ready_expires_at<=clock_timestamp() returning 1) select expired+count(*) into expired from x;
    with x as (update clued_private.storage_staging_v1 s0 set state='rejected',reject_reason='stalled'
      from clued_private.storage_connections_v1 c0 where c0.id=s0.connection_id and c0.oauth_client_id=app.oauth_client_id
        and s0.state in ('receiving','validating') and s0.received_at<=clock_timestamp()-interval '30 minutes' returning 1)
      select count(*) into stalled from x;
    for job in select j.owner_id,j.job_id from clued_private.storage_jobs_v1 j
        join clued_private.storage_connections_v1 c0 on c0.id=j.connection_id and c0.owner_id=j.owner_id and c0.oauth_client_id=app.oauth_client_id
        where j.mutation ? 'content_ref' and j.intent_id is null and j.dispatch_outcome is null
          and j.created_at<=clock_timestamp()-interval '12 hours' order by j.created_at limit 20 loop
      if clued_private.storage_staging_cancel_job_v1(job.owner_id,job.job_id) then cancelled:=cancelled+1; end if;
    end loop;
    select coalesce(jsonb_agg(s0.id order by s0.created_at),'[]'::jsonb) into deletable from (
      select s1.* from clued_private.storage_staging_v1 s1 join clued_private.storage_connections_v1 c0
        on c0.id=s1.connection_id and c0.oauth_client_id=app.oauth_client_id
      where clued_private.storage_staging_deletable_v1(s1) order by s1.created_at limit 50) s0;
    return jsonb_build_object('status','ok','expired',expired,'stalled',stalled,'cancelled_jobs',cancelled,'delete',deletable);
  end if;

  -- object_deleted: the Worker deleted these R2 objects (idempotent).
  if (p_input-array['action','staging_ids'])<>'{}'::jsonb or jsonb_typeof(p_input->'staging_ids') is distinct from 'array'
    or jsonb_array_length(p_input->'staging_ids') not between 1 and 50
    or exists(select 1 from jsonb_array_elements(p_input->'staging_ids') e where jsonb_typeof(e)<>'string' or e#>>'{}' !~ uuid_re) then
    raise exception 'storage_staging_input_invalid' using errcode='22023'; end if;
  with x as (update clued_private.storage_staging_v1 s0 set object_deleted_at=clock_timestamp()
    from clued_private.storage_connections_v1 c0 where c0.id=s0.connection_id and c0.oauth_client_id=app.oauth_client_id
      and s0.id in (select (jsonb_array_elements_text(p_input->'staging_ids'))::uuid) and clued_private.storage_staging_deletable_v1(s0)
    returning 1) select count(*) into marked from x;
  return jsonb_build_object('status','ok','marked',marked);
end $$;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- Submit: binary create shape -> stored content_ref form; consume the staging row.
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$      or m-array['operation','destination_path','target_kind','directory_semantics','content','source_path','source_file_version',
        'destination_file_version','restore_job_id']<>'{}'::jsonb$a$,
     $r$      or m-array['operation','destination_path','target_kind','directory_semantics','content','source_path','source_file_version',
        'destination_file_version','restore_job_id','staging_id','mime_type','content_sha256']<>'{}'::jsonb$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$    elsif m->>'target_kind'='file' then
      wanted:='create_file';
      if jsonb_typeof(m->'content') is distinct from 'string' or m ? 'directory_semantics'$a$,
     $r$    elsif m->>'target_kind'='file' and m ? 'staging_id' then
      wanted:='create_file';
      m:=clued_private.storage_binary_submit_mutation_v1(connection_id,m);
    elsif m->>'target_kind'='file' then
      wanted:='create_file';
      if jsonb_typeof(m->'content') is distinct from 'string' or m ? 'directory_semantics'
        or m ?| array['staging_id','mime_type','content_sha256']$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$      if m ? 'content' or coalesce(m->>'directory_semantics','') not in ('topic','asset_collection')$a$,
     $r$      if m ? 'content' or coalesce(m->>'directory_semantics','') not in ('topic','asset_collection')
        or m ?| array['staging_id','mime_type','content_sha256']$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$  receipt:=clued_private.m1_begin_receipt((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,$a$,
     $r$  perform clued_private.storage_staging_consume_v1(m,(snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,connection_id,v_job_id);
  receipt:=clued_private.m1_begin_receipt((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$      'capability_id',snapshot->'capability_id','scope_digest',snapshot->'scope_digest'),$a$,
     $r$      'capability_id',snapshot->'capability_id','scope_digest',snapshot->'scope_digest',
      'upload_bytes',m->'content_ref'->'size'),$r$,1),
    -- Execution admission of a queued binary job.
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$    raise exception 'storage_cloud_snapshot_changed' using errcode='42501'; end if;
  return s;$a$,
     $r$    raise exception 'storage_cloud_snapshot_changed' using errcode='42501'; end if;
  perform clued_private.storage_binary_execution_v1(j);
  return s;$r$,1),
    -- Execution descriptor carries the staging object reference.
    ('clued_private.storage_cloud_worker_v2(text,jsonb)',
     $a$      'restore',clued_private.storage_restore_v1(j),'revision_releases',clued_private.storage_revision_releases_for_job_v1(j),$a$,
     $r$      'restore',clued_private.storage_restore_v1(j),'revision_releases',clued_private.storage_revision_releases_for_job_v1(j),
      'staging',clued_private.storage_staging_descriptor_v1(j),$r$,1),
    -- m-f: provider attempt size / sha256.
    ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)',
     $a$    'size',case when j.mutation->>'target_kind'='file' then octet_length(j.mutation->>'content')::text end,
    'sha256',case when j.mutation->>'target_kind'='file' then
      encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);$a$,
     $r$    'size',case when j.mutation ? 'content_ref' then j.mutation->'content_ref'->>'size'
      when j.mutation->>'target_kind'='file' then octet_length(j.mutation->>'content')::text end,
    'sha256',case when j.mutation ? 'content_ref' then j.mutation->'content_ref'->>'sha256'
      when j.mutation->>'target_kind'='file' then
      encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);$r$,1),
    -- m-f: verified result size / sha256 and the /3 proof of a binary create.
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$      'size',case when j.mutation->>'target_kind'='file' then octet_length(j.mutation->>'content')::text end,
      'sha256',case when j.mutation->>'target_kind'='file' then encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);$a$,
     $r$      'size',case when j.mutation ? 'content_ref' then j.mutation->'content_ref'->>'size'
        when j.mutation->>'target_kind'='file' then octet_length(j.mutation->>'content')::text end,
      'sha256',case when j.mutation ? 'content_ref' then j.mutation->'content_ref'->>'sha256'
        when j.mutation->>'target_kind'='file' then encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    else
    expected:=post||jsonb_build_object('contract','clued.storage-create-verified/2',$a$,
     $r$    elsif j.mutation ? 'content_ref' then
      expected:=post||jsonb_build_object('contract','clued.storage-create-verified/3','target_kind','file',
        'size',attempt_expected->'size','sha256',attempt_expected->'sha256','mime_type',j.mutation->'content_ref'->'mime_type',
        'provider_before',m.authority_request->'provider_identity',
        'checks',jsonb_build_object('identity',true,'content',true,'ancestors',true,'unique_name',true,'stable_version',true,
          'mime_type',true,'sha256_checksum',true));
    else
    expected:=post||jsonb_build_object('contract','clued.storage-create-verified/2',$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Every edit of one function first, then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_binary_upload_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_staging_guard_v1(),
  clued_private.storage_binary_mime_v1(text,text),
  clued_private.storage_binary_gate_v1(uuid),
  clued_private.storage_upload_budget_v1(uuid,uuid,bigint),
  clued_private.storage_binary_submit_mutation_v1(uuid,jsonb),
  clued_private.storage_staging_consume_v1(jsonb,uuid,uuid,uuid,uuid),
  clued_private.storage_binary_execution_v1(clued_private.storage_jobs_v1),
  clued_private.storage_staging_descriptor_v1(clued_private.storage_jobs_v1),
  clued_private.storage_staging_cancel_job_v1(uuid,uuid),
  clued_private.storage_staging_deletable_v1(clued_private.storage_staging_v1)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_staging_v1(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_staging_v1(text,text,jsonb) to anon;
