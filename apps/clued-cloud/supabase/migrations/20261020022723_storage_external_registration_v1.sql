-- Candidate successor: StorageExternalRegistration.v0.1. No Drive writes.
-- Native opt-in and program calls retain the existing Native/Worker RPCs,
-- authenticated issuer resolver and gateway grants. No new public RPC.
-- Preserve active-path uniqueness while permitting atomic path permutations.
-- It is immediate for every existing writer; only this reconciler defers it,
-- and explicitly rechecks it before the Event/Receipt can commit.
create extension if not exists btree_gist with schema extensions;
do $paths$
declare ns text;
begin
 select n.nspname into strict ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='btree_gist';
 execute format('alter table clued_private.resource_center_artifacts_v1 add constraint resource_center_artifacts_v1_path_active_excl
  exclude using gist (profile_id %I.gist_uuid_ops with =,path %I.gist_text_ops with =) where (state=''active'') deferrable initially immediate',ns,ns);
end $paths$;
drop index clued_private.resource_center_artifacts_v1_path_active_uidx;
create index resource_center_artifacts_v1_path_active_idx on clued_private.resource_center_artifacts_v1(profile_id,path) where state='active';
create table clued_private.storage_external_registration_policy_v1 (
 connection_id uuid primary key references clued_private.storage_connections_v1(id),
 owner_id uuid not null references auth.users(id), enabled boolean not null,
 version bigint not null check(version>0), receipt_id uuid not null references public.clued_audit_receipts(id)
);
create table clued_private.storage_external_registration_scan_v1 (
 connection_id uuid not null references clued_private.storage_connections_v1(id),
 artifact_id uuid not null references clued_private.resource_center_artifacts_v1(id),
 next_attempt_at timestamptz not null, last_result text,
 primary key(connection_id,artifact_id)
);
create table clued_private.storage_external_registration_attempt_v1 (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 connection_id uuid not null references clued_private.storage_connections_v1(id), artifact_id uuid not null,
 authority jsonb not null, plan jsonb not null, created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '2 minutes',
 request_hash text, result jsonb, receipt_id uuid references public.clued_audit_receipts(id)
);
create index storage_external_registration_attempt_expiry_v1 on clued_private.storage_external_registration_attempt_v1(created_at);
alter table clued_private.storage_external_registration_policy_v1 enable row level security;
alter table clued_private.storage_external_registration_scan_v1 enable row level security;
alter table clued_private.storage_external_registration_attempt_v1 enable row level security;
revoke all on clued_private.storage_external_registration_policy_v1,clued_private.storage_external_registration_scan_v1,
 clued_private.storage_external_registration_attempt_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_external_registration_policy_call_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); c clued_private.storage_connections_v1;
 p clued_private.storage_external_registration_policy_v1; m jsonb; r public.clued_audit_receipts; result jsonb; ev text; refs jsonb;
begin
 if current_setting('role',true) is distinct from 'authenticated' or auth.jwt()->>'role' is distinct from 'authenticated'
 or jsonb_typeof(p_input) is distinct from 'object' or p_input->>'action' not in ('external_status','external_set')
 or coalesce(p_input->>'connection_id','') !~ '^[0-9a-f-]{36}$' then raise exception 'storage_owner_input_invalid' using errcode='22023';end if;
 select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
 if c.id is null then raise exception 'storage_owner_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||':'||(select root_folder_id from clued_private.resource_center_profiles_v1 where id=c.profile_id),0));
 perform clued_private.storage_owner_v1();
 select * into p from clued_private.storage_external_registration_policy_v1 where connection_id=c.id and owner_id=u for update;
 if p_input->>'action'='external_status' then
  if p_input-array['action','connection_id']<>'{}'::jsonb then raise exception 'storage_owner_input_invalid' using errcode='22023';end if;
  return jsonb_build_object('connection_id',c.id,'enabled',coalesce(p.enabled,false),'version',coalesce(p.version,0),
   'attention_count',(select count(*) from clued_private.storage_external_registration_scan_v1 s where s.connection_id=c.id
    and (s.last_result='scan_unavailable' or s.last_result='pending' and s.next_attempt_at<clock_timestamp())));
 end if;
 if p_input-array['action','connection_id','enabled','base_version','idempotency_key','disclosure_version']<>'{}'::jsonb
 or not(p_input ?& array['enabled','base_version','idempotency_key','disclosure_version'])
 or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
 or coalesce(p_input->>'base_version','') !~ '^(0|[1-9][0-9]{0,17})$'
 or length(coalesce(p_input->>'idempotency_key','')) not between 8 and 160
 or p_input->>'disclosure_version' is distinct from 'clued.storage-external-registration-disclosure/1' then
  raise exception 'storage_owner_input_invalid' using errcode='22023';end if;
 if (p_input->>'enabled')::boolean then
  c:=clued_private.storage_connection_current_v1(c.id,u); m:=clued_private.storage_master_snapshot_v1(u,c.id);
  if m->'policy_current' is distinct from 'true'::jsonb or m->'write_enabled' is distinct from 'true'::jsonb
  or m->'normal_use' is distinct from 'true'::jsonb or c.provider_scope_profile is distinct from 'full'
  or not(m->'write_classes' @> '["modify"]'::jsonb) then raise exception 'storage_external_registration_denied' using errcode='42501';end if;
 end if;
 r:=clued_private.m1_begin_receipt(u,null,'storage_external_registration_policy',p_input,clued_private.m1_sha256(p_input));
 if r.status='committed' then
  return jsonb_build_object('connection_id',c.id,'enabled',p_input->'enabled','version',r.committed_versions->c.id::text,'receipt_id',r.id);
 elsif r.status<>'pending' then return r.canonical_result;end if;
 if coalesce(p.version,0)<>(p_input->>'base_version')::bigint then raise exception 'storage_owner_version_conflict' using errcode='40001';end if;
 insert into clued_private.storage_external_registration_policy_v1 values(c.id,u,(p_input->>'enabled')::boolean,coalesce(p.version,0)+1,r.id)
 on conflict(connection_id) do update set enabled=excluded.enabled,version=excluded.version,receipt_id=excluded.receipt_id returning * into p;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
 ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:external_registration_policy',refs,
  'project:'||(select project_id from clued_private.resource_center_profiles_v1 where id=c.profile_id),null,
  jsonb_build_object('enabled',p.enabled,'version',p.version,'drive_write',false),p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}','[]',null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(c.id::text,p.version-1),jsonb_build_object(c.id::text,p.version),array[ev],'{}',null);
 result:=jsonb_build_object('connection_id',c.id,'enabled',p.enabled,'version',p.version,'receipt_id',r.id);
 return result;
end $$;

create function clued_private.storage_external_registration_authority_v1(p_identity text,p_connection uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
 app clued_private.storage_oauth_apps_v1; enabled clued_private.storage_external_registration_policy_v1;
 m jsonb; resolved_generation bigint; credential clued_private.issuer_credentials_v1;
begin
 resolved_generation:=clued_private.issuer_credential_generation_v1(p_identity,'storage');
 select cred.* into credential from clued_private.issuer_credentials_v1 cred join clued_private.issuer_identities_v1 i on i.id=cred.issuer_id
 where i.kind='storage' and i.legacy_key=p_identity and cred.generation=resolved_generation for share of cred;
 select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_identity and revoked_at is null for share;
 select * into c from clued_private.storage_connections_v1 where id=p_connection;
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
 if c.id is null or p.id is null or app.issuer_hash is null then raise exception 'storage_external_registration_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text||':'||p.root_folder_id,0));
 c:=clued_private.storage_connection_current_v1(c.id,c.owner_id);
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id for share;
 select * into enabled from clued_private.storage_external_registration_policy_v1 where connection_id=c.id and owner_id=c.owner_id for share;
 m:=clued_private.storage_master_snapshot_v1(c.owner_id,c.id);
 if enabled.enabled is distinct from true or c.oauth_client_id is distinct from app.oauth_client_id
 or c.provider is distinct from 'google-drive' or c.provider_scope_profile is distinct from 'full'
 or app.execution_enabled is distinct from true or app.read_enabled is distinct from true
 or credential.state is distinct from 'active' or coalesce(credential.valid_until<=clock_timestamp(),false)
 or m->'policy_current' is distinct from 'true'::jsonb or m->'write_enabled' is distinct from 'true'::jsonb
 or m->'normal_use' is distinct from 'true'::jsonb or not(m->'write_classes' @> '["modify"]'::jsonb)
 or not exists(select 1 from public.clued_audit_receipts r where r.id=enabled.receipt_id and r.user_id=c.owner_id and r.status='committed')
 or not exists(select 1 from public.clued_audit_receipts r join public.clued_context_events e on e.receipt_id=r.id and e.user_id=r.user_id
  where r.id=(p.cloud_runtime->>'receipt_id')::uuid and r.user_id=c.owner_id and r.status='committed' and r.operation='storage_cloud_qualify'
  and r.response_hash=clued_private.m1_sha256(r.canonical_result) and e.canonical_event_type='extension:storage:cloud_qualified'
  and e.result='success' and e.change_summary->>'profile_id'=p.id::text
  and e.change_summary->>'runtime_digest'=clued_private.m1_sha256(p.cloud_runtime-'receipt_id')) then
  raise exception 'storage_external_registration_denied' using errcode='42501';end if;
 perform clued_private.storage_root_quiet_v1(c.owner_id,p.root_folder_id);
 return jsonb_build_object('owner_id',c.owner_id,'connection_id',c.id,'profile_id',p.id,'profile_version',p.version,
  'connection_version',c.version,'auth_generation',c.auth_generation,
  'issuer_id',credential.issuer_id,'issuer_generation',resolved_generation,'credential_version',c.credential_version,
  'policy_version',enabled.version,'master_digest',m->>'status_digest','root_folder_id',p.root_folder_id,
  'root_parent_id',p.root_parent_id,'managed_root',p.managed_root);
end $$;

create function clued_private.storage_external_registration_call_v1(p_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op text:=p_input->>'action'; app clued_private.storage_oauth_apps_v1; authority jsonb; plan jsonb; listed jsonb;
 c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1; focus clued_private.resource_center_artifacts_v1;
 a clued_private.resource_center_artifacts_v1; parent clued_private.resource_center_artifacts_v1;
 attempt clued_private.storage_external_registration_attempt_v1; observation jsonb; nodes jsonb; selected jsonb; fresh jsonb;
 item jsonb; oldrow jsonb; parentnode jsonb; r public.clued_audit_receipts; req jsonb; refs jsonb:='[]'; bases jsonb:='{}'; versions jsonb:='{}';
 ev text; v_result jsonb; resources text[]:='{}'; changed integer:=0; saved_hash text; prior_lock_timeout text;
begin
 perform clued_private.issuer_credential_generation_v1(p_identity,'storage');
 select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_identity and revoked_at is null;
 if app.issuer_hash is null or not app.execution_enabled or jsonb_typeof(p_input) is distinct from 'object'
 or coalesce(op,'') not in ('external_due','external_load','external_commit','external_failed') then raise exception 'storage_external_registration_denied' using errcode='42501';end if;
 if op='external_due' then
  if p_input<>jsonb_build_object('action',op) then raise exception 'storage_external_registration_input_invalid' using errcode='22023';end if;
  -- Expired scan plans are operational data, never Canonical receipts/events.
  -- Bound retention and serialize the tiny reservation so concurrent cron
  -- deliveries cannot starve other directories by repeatedly selecting two.
  perform pg_advisory_xact_lock(hashtextextended('storage-external-due:'||p_identity,0));
  delete from clued_private.storage_external_registration_attempt_v1 x where x.id in (
   select a0.id from clued_private.storage_external_registration_attempt_v1 a0
   join clued_private.storage_connections_v1 c0 on c0.id=a0.connection_id
   where c0.oauth_client_id=app.oauth_client_id and a0.created_at<clock_timestamp()-interval '1 day'
   order by a0.created_at limit 100);
  select coalesce(jsonb_agg(q),'[]') into listed from (
   select c0.id connection_id,a0.id artifact_id from clued_private.storage_external_registration_policy_v1 enabled
   join clued_private.storage_connections_v1 c0 on c0.id=enabled.connection_id and c0.owner_id=enabled.owner_id
   join clued_private.resource_center_profiles_v1 p0 on p0.id=c0.profile_id and p0.user_id=c0.owner_id
   join clued_private.resource_center_artifacts_v1 a0 on a0.profile_id=p0.id and a0.user_id=c0.owner_id
   left join clued_private.storage_external_registration_scan_v1 s on s.connection_id=c0.id and s.artifact_id=a0.id
   where enabled.enabled and c0.oauth_client_id=app.oauth_client_id and c0.state='active' and c0.revoked_at is null
   and a0.state='active' and a0.target_kind='directory' and a0.governance_class='ordinary' and a0.path<>p0.managed_root
   and coalesce(s.next_attempt_at<=clock_timestamp(),true)
   order by s.next_attempt_at nulls first,a0.path collate "C",a0.id limit 2
  ) q;
  insert into clued_private.storage_external_registration_scan_v1(connection_id,artifact_id,next_attempt_at,last_result)
   select (x->>'connection_id')::uuid,(x->>'artifact_id')::uuid,clock_timestamp()+interval '5 minutes','pending'
   from jsonb_array_elements(listed) x
   on conflict(connection_id,artifact_id) do update set next_attempt_at=excluded.next_attempt_at,last_result=excluded.last_result;
  return jsonb_build_object('status','ok','directories',listed);
 end if;
 if coalesce(p_input->>'connection_id','') !~ '^[0-9a-f-]{36}$' then raise exception 'storage_external_registration_input_invalid' using errcode='22023';end if;
 authority:=clued_private.storage_external_registration_authority_v1(p_identity,(p_input->>'connection_id')::uuid);
 select * into c from clued_private.storage_connections_v1 where id=(authority->>'connection_id')::uuid;
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
 if op='external_load' then
  if p_input-array['action','connection_id','artifact_id']<>'{}'::jsonb or coalesce(p_input->>'artifact_id','') !~ '^[0-9a-f-]{36}$' then
   raise exception 'storage_external_registration_input_invalid' using errcode='22023';end if;
  select * into focus from clued_private.resource_center_artifacts_v1 where id=(p_input->>'artifact_id')::uuid and user_id=c.owner_id and profile_id=p.id for share;
  if focus.id is null or focus.state<>'active' or focus.target_kind<>'directory' or focus.governance_class<>'ordinary' or focus.path=p.managed_root
  or not clued_private.resource_center_path_current_v1(c.owner_id,p.project_id,p.id,p.managed_root,focus.path) then
   raise exception 'storage_external_registration_denied' using errcode='42501';end if;
  if (select count(*) from clued_private.resource_center_artifacts_v1 where profile_id=p.id and user_id=c.owner_id)>5000 then
   raise exception 'storage_external_registration_limit' using errcode='54000';end if;
  select jsonb_agg(to_jsonb(x) order by x.id) into listed from clued_private.resource_center_artifacts_v1 x where profile_id=p.id and user_id=c.owner_id;
  plan:=jsonb_build_object('contract','clued.storage-external-registration-plan/1','root_folder_id',p.root_folder_id,
   'root_parent_id',p.root_parent_id,'managed_root',p.managed_root,'focus_file_id',focus.provider_file_id,'registry',listed);
  insert into clued_private.storage_external_registration_scan_v1 values(c.id,focus.id,clock_timestamp()+interval '5 minutes',null)
   on conflict(connection_id,artifact_id) do update set next_attempt_at=excluded.next_attempt_at;
  insert into clued_private.storage_external_registration_attempt_v1(owner_id,connection_id,artifact_id,authority,plan)
   values(c.owner_id,c.id,focus.id,authority,plan) returning * into attempt;
  return jsonb_build_object('status','read_only','execution_permitted',false,'attempt_id',attempt.id,'authority',authority,'plan',plan,
   'credential_envelope',c.credential_envelope,'provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id);
 end if;
 if (op='external_commit' and p_input-array['action','connection_id','attempt_id','observation']<>'{}'::jsonb)
 or (op='external_failed' and (p_input-array['action','connection_id','attempt_id','reason']<>'{}'::jsonb or p_input->>'reason' is distinct from 'scan_unavailable'))
 or coalesce(p_input->>'attempt_id','') !~ '^[0-9a-f-]{36}$' then
  raise exception 'storage_external_registration_input_invalid' using errcode='22023';end if;
 select * into attempt from clued_private.storage_external_registration_attempt_v1 where id=(p_input->>'attempt_id')::uuid and connection_id=c.id and owner_id=c.owner_id for update;
 if attempt.id is null then raise exception 'storage_external_registration_denied' using errcode='42501';end if;
 if op='external_failed' then
  if attempt.authority is distinct from authority or attempt.expires_at<=clock_timestamp() then raise exception 'storage_external_registration_conflict' using errcode='40001';end if;
  if attempt.result is null then
   update clued_private.storage_external_registration_scan_v1 s set last_result='scan_unavailable'
    where s.connection_id=c.id and s.artifact_id=attempt.artifact_id and not exists (
     select 1 from clued_private.storage_external_registration_attempt_v1 newer
     where newer.connection_id=c.id and newer.artifact_id=attempt.artifact_id and newer.created_at>attempt.created_at);
  end if;
  return jsonb_build_object('status','recorded','attempt_id',attempt.id,'execution_permitted',false);
 end if;
 saved_hash:=clued_private.m1_sha256(p_input);
 if attempt.result is not null then
  if attempt.request_hash is distinct from saved_hash then raise exception 'storage_external_registration_conflict' using errcode='40001';end if;
  return attempt.result;
 end if;
 if attempt.expires_at<=clock_timestamp() or attempt.authority is distinct from authority then raise exception 'storage_external_registration_conflict' using errcode='40001';end if;
 plan:=attempt.plan; observation:=p_input->'observation';
 if jsonb_typeof(observation) is distinct from 'object' or observation-array['contract','observed_at','first_observation','second_observation']<>'{}'::jsonb
 or not(observation ?& array['contract','observed_at','first_observation','second_observation'])
 or jsonb_typeof(observation->'observed_at') is distinct from 'string'
 or observation->>'contract' is distinct from 'clued.storage-external-registration-observation/1'
 or observation->'first_observation' is distinct from observation->'second_observation'
 or jsonb_typeof(observation->'first_observation') is distinct from 'object'
 or (observation->'first_observation')-array['nodes','selected_ids','new_ids']<>'{}'::jsonb
 or (observation->>'observed_at')::timestamptz not between attempt.created_at and clock_timestamp()+interval '5 seconds' then
  raise exception 'storage_external_registration_observation_invalid' using errcode='22023';end if;
 nodes:=observation->'first_observation'->'nodes'; selected:=observation->'first_observation'->'selected_ids';
 if jsonb_typeof(nodes) is distinct from 'array' or jsonb_array_length(nodes) not between 1 and 256
 or jsonb_typeof(selected) is distinct from 'array' or jsonb_typeof(observation->'first_observation'->'new_ids') is distinct from 'array'
 or exists(select 1 from jsonb_array_elements(selected||(observation->'first_observation'->'new_ids')) x
  where jsonb_typeof(x) is distinct from 'string' or (x#>>'{}') !~ '^[A-Za-z0-9_-]{1,160}$')
 or (select count(distinct n->>'provider_file_id') from jsonb_array_elements(nodes) n)<>jsonb_array_length(nodes) then
  raise exception 'storage_external_registration_observation_invalid' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements_text(observation->'first_observation'->'new_ids') id
  where exists(select 1 from jsonb_array_elements(plan->'registry') x where x->>'provider_file_id'=id)) then
  raise exception 'storage_external_registration_observation_invalid' using errcode='22023';end if;
 -- Lock only this profile's exact observed rows, in deterministic ID order.
 perform 1 from clued_private.resource_center_artifacts_v1 x where x.user_id=c.owner_id and x.profile_id=p.id
 and exists(select 1 from jsonb_array_elements(nodes) n where n->>'provider_file_id'=x.provider_file_id) order by x.id for update;
 perform 1 from public.clued_memories d where d.user_id=c.owner_id and d.id in (
  select x.source_decision_id from clued_private.resource_center_artifacts_v1 x where x.user_id=c.owner_id and x.profile_id=p.id
  and exists(select 1 from jsonb_array_elements(nodes) n where n->>'provider_file_id'=x.provider_file_id)) order by d.id for share nowait;
 select * into focus from clued_private.resource_center_artifacts_v1 where id=attempt.artifact_id and user_id=c.owner_id and profile_id=p.id;
 for item in select value from jsonb_array_elements(nodes) loop
  if item-array['provider_file_id','provider_file_version','parent_id','name','target_kind','path','mime_type','access_digest','sharing_digest','content_identity']<>'{}'::jsonb
  or not(item ?& array['provider_file_id','provider_file_version','parent_id','name','target_kind','path','mime_type','access_digest','sharing_digest','content_identity'])
  or exists(select 1 from unnest(array['provider_file_id','provider_file_version','parent_id','name','target_kind','path','mime_type','access_digest','sharing_digest']) k where jsonb_typeof(item->k) is distinct from 'string')
  or coalesce(item->>'provider_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$' or coalesce(item->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$'
  or item->>'target_kind' not in ('file','directory') or length(coalesce(item->>'name','')) not between 1 and 255
  or item->>'name' in ('.','..') or item->>'name' ~ E'[/\\\\[:cntrl:]]' or btrim(item->>'name')<>item->>'name'
  or coalesce(item->>'access_digest','') !~ '^[0-9a-f]{64}$' or coalesce(item->>'sharing_digest','') !~ '^[0-9a-f]{64}$'
  or length(coalesce(item->>'path','')) not between 1 and 1000 then raise exception 'storage_external_registration_observation_invalid' using errcode='22023';end if;
  select value into oldrow from jsonb_array_elements(plan->'registry') where value->>'provider_file_id'=item->>'provider_file_id';
  select to_jsonb(x) into fresh from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id and x.user_id=c.owner_id and x.provider_file_id=item->>'provider_file_id';
  if fresh is distinct from oldrow or oldrow is not null and (oldrow->>'state'<>'active' or oldrow->>'target_kind'<>item->>'target_kind') then
   raise exception 'storage_external_registration_conflict' using errcode='40001';end if;
  if oldrow is not null and ((oldrow->>'provider_access_digest' is not null and oldrow->>'provider_access_digest'<>item->>'access_digest')
   or (oldrow->>'provider_sharing_digest' is not null and oldrow->>'provider_sharing_digest'<>item->>'sharing_digest')) then
   raise exception 'storage_external_registration_access_changed' using errcode='42501';end if;
  if item->>'provider_file_id'=p.root_folder_id then
   if item->>'path'<>p.managed_root or item->>'parent_id'<>p.root_parent_id then raise exception 'storage_external_registration_denied' using errcode='42501';end if;
  else
   select value into parentnode from jsonb_array_elements(nodes) where value->>'provider_file_id'=item->>'parent_id';
   if parentnode is null or parentnode->>'target_kind'<>'directory' or item->>'path'<>parentnode->>'path'||'/'||(item->>'name')
   or not starts_with(item->>'path',p.managed_root||'/') then raise exception 'storage_external_registration_denied' using errcode='42501';end if;
  end if;
  if oldrow is null then
   if (item->>'parent_id'<>focus.provider_file_id and not(observation->'first_observation'->'new_ids' ? (item->>'parent_id')))
   or not(observation->'first_observation'->'new_ids' ? (item->>'provider_file_id'))
   or item->>'access_digest'<>parentnode->>'access_digest' or focus.governance_class<>'ordinary' then raise exception 'storage_external_registration_denied' using errcode='42501';end if;
  elsif selected ? (item->>'provider_file_id') then
   if oldrow->>'governance_class'<>'ordinary' or not(oldrow->>'path'=focus.path or starts_with(oldrow->>'path',focus.path||'/'))
   or (oldrow->>'provider_access_digest' is not null and oldrow->>'provider_access_digest'<>item->>'access_digest')
   or (oldrow->>'provider_sharing_digest' is not null and oldrow->>'provider_sharing_digest'<>item->>'sharing_digest')
   or (regexp_replace(oldrow->>'path','/[^/]+$','')=p.managed_root and item->>'path'<>oldrow->>'path') then
    raise exception 'storage_external_registration_denied' using errcode='42501';end if;
   -- A directory path change must include every active registered descendant.
   if item->>'target_kind'='directory' and item->>'path'<>oldrow->>'path' and exists(
    select 1 from clued_private.resource_center_artifacts_v1 d where d.profile_id=p.id and d.user_id=c.owner_id and d.state='active'
     and starts_with(d.path,(oldrow->>'path')||'/') and not(selected ? d.provider_file_id)) then
    raise exception 'storage_external_registration_subtree_incomplete' using errcode='40001';end if;
  elsif item->>'path'<>oldrow->>'path' then raise exception 'storage_external_registration_ancestor_changed' using errcode='40001';end if;
  if oldrow is not null and not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,(oldrow->>'source_decision_id')::uuid) then
   raise exception 'storage_external_registration_denied' using errcode='42501';end if;
  if oldrow is null or selected ? (item->>'provider_file_id') then
   resources:=resources||('storage:'||c.id||'/'||substr(item->>'path',length(p.managed_root)+2));
   if oldrow is not null then resources:=resources||('storage:'||c.id||'/'||substr(oldrow->>'path',length(p.managed_root)+2));end if;
  end if;
 end loop;
 -- Claim creation, expansion and handover use this same ordered lock pair.
 -- Hold it through settlement so a new claim cannot enter after the check.
 -- Storage already holds root/authority locks; a bounded wait aborts this
 -- transaction rather than retaining them behind a competing source writer.
 prior_lock_timeout:=current_setting('lock_timeout');
 perform set_config('lock_timeout','250ms',true);
 perform clued_private.work_claim_lock(c.owner_id);
 perform set_config('lock_timeout',prior_lock_timeout,true);
 if jsonb_array_length(clued_private.work_claim_conflicts(c.owner_id,null,resources,'{}',null))>0 then raise exception 'work_claim_conflict' using errcode='42501';end if;
 -- Every selected/new ID must be observed exactly once; every direct child
 -- that was registered at plan time is included, even when moved elsewhere.
 if not(selected ? focus.provider_file_id) or exists(select 1 from jsonb_array_elements(plan->'registry') x
   where x->>'state'='active' and regexp_replace(x->>'path','/[^/]+$','')=focus.path and not(selected ? (x->>'provider_file_id')))
 or exists(select 1 from jsonb_array_elements_text(selected||(observation->'first_observation'->'new_ids')) id
   where not exists(select 1 from jsonb_array_elements(nodes) n where n->>'provider_file_id'=id)) then
  raise exception 'storage_external_registration_subtree_incomplete' using errcode='40001';end if;
 if not exists(select 1 from jsonb_array_elements(nodes) n left join clued_private.resource_center_artifacts_v1 x
  on x.user_id=c.owner_id and x.profile_id=p.id and x.provider_file_id=n->>'provider_file_id'
  where x.id is null or (selected ? x.provider_file_id) and (x.path<>n->>'path' or x.provider_file_version<>n->>'provider_file_version')) then
  v_result:=jsonb_build_object('status','unchanged','attempt_id',attempt.id,'changed',0,'execution_permitted',false);
  update clued_private.storage_external_registration_attempt_v1 a0 set request_hash=saved_hash,result=v_result where a0.id=attempt.id;
  update clued_private.storage_external_registration_scan_v1 set last_result='unchanged' where connection_id=c.id and artifact_id=focus.id;
  return v_result;
 end if;
 req:=jsonb_build_object('idempotency_key','storage-external-registration:'||attempt.id,'attempt_id',attempt.id,'observation',observation);
 r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_external_registration',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_external_registration_conflict' using errcode='40001';end if;
 set constraints clued_private.resource_center_artifacts_v1_path_active_excl deferred;
 for item in select value from jsonb_array_elements(nodes) order by length(value->>'path'),value->>'path' loop
  select * into a from clued_private.resource_center_artifacts_v1 where user_id=c.owner_id and profile_id=p.id and provider_file_id=item->>'provider_file_id';
  if a.id is not null and not(selected ? a.provider_file_id) then continue;end if;
  if a.id is not null and a.path=item->>'path' and a.provider_file_version=item->>'provider_file_version' then continue;end if;
  if a.id is null then
   select * into parent from clued_private.resource_center_artifacts_v1 where user_id=c.owner_id and profile_id=p.id and provider_file_id=item->>'parent_id' and state='active';
   insert into clued_private.resource_center_artifacts_v1(user_id,profile_id,path,provider_file_id,provider_file_version,target_kind,governance_class,delete_authority,source_decision_id,receipt_id,provider_access_digest,provider_sharing_digest)
    values(c.owner_id,p.id,item->>'path',item->>'provider_file_id',item->>'provider_file_version',item->>'target_kind','ordinary',false,parent.source_decision_id,r.id,
     case when item->>'target_kind'='directory' then item->>'access_digest' end,case when item->>'target_kind'='directory' then item->>'sharing_digest' end) returning * into a;
   bases:=bases||jsonb_build_object(a.id::text,0);
  else
   bases:=bases||jsonb_build_object(a.id::text,a.version);
   update clued_private.resource_center_artifacts_v1 set path=item->>'path',provider_file_version=item->>'provider_file_version',version=version+1,receipt_id=r.id,updated_at=clock_timestamp()
    where id=a.id returning * into a;
  end if;
  changed:=changed+1; refs:=refs||jsonb_build_array(jsonb_build_object('kind','system','role','target','id',a.id)); versions:=versions||jsonb_build_object(a.id::text,a.version);
 end loop;
 set constraints clued_private.resource_center_artifacts_v1_path_active_excl immediate;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id))||refs;
 ev:=clued_private.m1_append_event_row(c.owner_id,null,r.id,r.canonical_version,'extension:storage:external_registered',refs,'project:'||p.project_id,null,
  jsonb_build_object('attempt_id',attempt.id,'changed',changed,'drive_write',false),req->>'idempotency_key',r.request_sha256,'success','audit_only','{}','[]',null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,bases,versions,array[ev],'{}',null);
 v_result:=jsonb_build_object('status','committed','attempt_id',attempt.id,'changed',changed,'receipt_id',r.id,'execution_permitted',false);
 update clued_private.storage_external_registration_attempt_v1 a0 set request_hash=saved_hash,result=v_result,receipt_id=r.id where a0.id=attempt.id;
 update clued_private.storage_external_registration_scan_v1 set last_result='committed' where connection_id=c.id and artifact_id=focus.id;
 return v_result;
end $$;

revoke all on function clued_private.storage_external_registration_policy_call_v1(jsonb),
 clued_private.storage_external_registration_authority_v1(text,uuid),clued_private.storage_external_registration_call_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

do $route$
declare body text; anchor text:=E'\nbegin\n';
begin
 body:=pg_get_functiondef('public.clued_storage_write_access_v1(jsonb)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'external_registration_native_source_changed';end if;
 execute replace(body,anchor,anchor||$p$ if p_input->>'action' in ('external_status','external_set') then
 return clued_private.storage_external_registration_policy_call_v1(p_input);end if;
$p$);
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'external_registration_worker_source_changed';end if;
 execute replace(body,anchor,anchor||$p$ if p_input->>'action' in ('external_due','external_load','external_commit','external_failed') then
 return clued_private.storage_external_registration_call_v1(p_issuer_identity,p_input);end if;
$p$);
end $route$;

-- Reuse the established demand-renewal boundary with its own typed operation.
-- Recheck consent and the exact current artifact before any renewal proof;
-- neither a connection ID nor a generic maintenance label grants authority.
do $renewal$
declare body text; anchor text:=$a$    if p_request->>'operation'='access_digest' then$a$;
begin
 body:=pg_get_functiondef('clued_private.storage_demand_authorize_v1(text,uuid,text,text,uuid,jsonb)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'external_registration_demand_source_changed';end if;
 execute replace(body,anchor,$p$    if p_request->>'operation'='external_registration' then
      if p_request-array['operation','artifact_id']<>'{}'::jsonb
        or coalesce(p_request->>'artifact_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'storage_demand_denied' using errcode='42501';end if;
      perform clued_private.storage_external_registration_authority_v1(identity,c.id);
      if not exists(select 1 from clued_private.resource_center_artifacts_v1 a
        join clued_private.resource_center_profiles_v1 p on p.id=a.profile_id and p.user_id=a.user_id
        where a.id=(p_request->>'artifact_id')::uuid and a.profile_id=c.profile_id and a.user_id=c.owner_id
        and a.state='active' and a.target_kind='directory' and a.governance_class='ordinary' and a.path<>p.managed_root
        and clued_private.resource_center_path_current_v1(c.owner_id,p.project_id,p.id,p.managed_root,a.path)) then
        raise exception 'storage_demand_denied' using errcode='42501';end if;
    elsif p_request->>'operation'='access_digest' then$p$);
end $renewal$;
