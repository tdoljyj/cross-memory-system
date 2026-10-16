-- A4 phase 1 / StorageFineGrainedConcurrency.v0.1 r10.1: bounded UNKNOWN is a
-- conflict, never success or permission to replay an effect. Running journals
-- retain the original root lock and single-writer index. Conflict scopes remain
-- immutable until a receipt-backed review exit in this very transaction.
alter table clued_private.resource_center_mutations_v1
  drop constraint resource_center_mutations_v1_state_check;
alter table clued_private.resource_center_mutations_v1
  add constraint resource_center_mutations_v1_state_check
  check(state in ('prepared','started','uncertain','cancelled','committed','conflict'));

create table clued_private.storage_conflict_isolations_v1 (
  intent_id uuid primary key references clued_private.resource_center_mutations_v1(id),
  user_id uuid not null references auth.users(id), profile_id uuid not null,
  connection_id uuid, job_id uuid, root_folder_id text not null,
  provider text, provider_subject text, oauth_client_id text,
  paths text[] not null, subtree_paths text[] not null, object_ids text[] not null,
  ancestor_ids text[] not null, slots jsonb not null,
  scope_complete boolean not null,
  original_state text not null, original_version bigint not null,
  original_receipt_id uuid not null references public.clued_audit_receipts(id),
  close_receipt_id uuid not null references public.clued_audit_receipts(id),
  closed_version bigint not null, closed_at timestamptz not null default clock_timestamp(),
  state text not null default 'active' check(state in ('active','resolved')),
  resolution_receipt_id uuid references public.clued_audit_receipts(id),
  next_recovery_at timestamptz not null default clock_timestamp(), attempts integer not null default 0,
  check((state='active' and resolution_receipt_id is null) or (state='resolved' and resolution_receipt_id is not null))
);
create index storage_conflict_active_root_v1 on clued_private.storage_conflict_isolations_v1(user_id,root_folder_id) where state='active';
create table clued_private.storage_conflict_exit_permits_v1 (
  intent_id uuid not null, receipt_id uuid not null references public.clued_audit_receipts(id),
  transaction_id bigint not null, primary key(intent_id,receipt_id)
);
-- Failed candidates get their own technical retry clock. It is not a journal
-- mutation and prevents one damaged old record monopolizing every cron batch.
create table clued_private.storage_conflict_scan_v1 (
 intent_id uuid primary key references clued_private.resource_center_mutations_v1(id),
 attempts integer not null default 0, next_attempt_at timestamptz not null
);
create table clued_private.storage_recovery_diagnostics_v1 (
  user_id uuid not null, connection_id uuid not null, job_id uuid not null,
  diagnostic jsonb not null, observed_at timestamptz not null,
  primary key(user_id,job_id), foreign key(user_id,job_id) references clued_private.storage_jobs_v1(owner_id,job_id)
);
create table clued_private.storage_conflict_observations_v1 (
 id uuid primary key default gen_random_uuid(), intent_id uuid not null references clued_private.storage_conflict_isolations_v1(intent_id),
 user_id uuid not null, connection_id uuid not null, job_id uuid not null, base_version bigint not null,
 source_receipt_id uuid not null references public.clued_audit_receipts(id), observation jsonb not null,
 artifact_id uuid, artifact_version bigint, profile_version bigint not null, parent_artifact_id uuid, parent_artifact_version bigint,
 observed_at timestamptz not null, expires_at timestamptz not null,
 resolution_receipt_id uuid references public.clued_audit_receipts(id)
);
create table clued_private.storage_conflict_validations_v1 (
 observation_id uuid primary key references clued_private.storage_conflict_observations_v1(id),
 validated_at timestamptz not null, semantic_sha256 text not null
);
alter table clued_private.storage_conflict_isolations_v1 enable row level security;
alter table clued_private.storage_conflict_exit_permits_v1 enable row level security;
alter table clued_private.storage_conflict_scan_v1 enable row level security;
alter table clued_private.storage_recovery_diagnostics_v1 enable row level security;
alter table clued_private.storage_conflict_observations_v1 enable row level security;
alter table clued_private.storage_conflict_validations_v1 enable row level security;
revoke all on clued_private.storage_conflict_isolations_v1,clued_private.storage_conflict_exit_permits_v1,
  clued_private.storage_recovery_diagnostics_v1,clued_private.storage_conflict_observations_v1,clued_private.storage_conflict_scan_v1,
  clued_private.storage_conflict_validations_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_conflict_exit_allowed_v1(p_intent uuid,p_receipt uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from clued_private.storage_conflict_exit_permits_v1 x
  join clued_private.storage_conflict_isolations_v1 q on q.intent_id=x.intent_id
  join public.clued_audit_receipts r on r.id=x.receipt_id and r.user_id=q.user_id
  where x.intent_id=p_intent and x.receipt_id=p_receipt and x.transaction_id=txid_current()
   and r.status in ('pending','committed') and r.operation in ('storage_verified_settle','storage_conflict_abandon','storage_conflict_accept'))
$$;

create function clued_private.storage_conflict_immutable_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'storage_isolation_immutable' using errcode='42501'; end if;
 if (to_jsonb(new)-array['state','resolution_receipt_id','next_recovery_at','attempts'])
    is distinct from (to_jsonb(old)-array['state','resolution_receipt_id','next_recovery_at','attempts'])
  or old.state='resolved' and new is distinct from old
  or (new.state is distinct from old.state and (new.state<>'resolved'
    or not clued_private.storage_conflict_exit_allowed_v1(old.intent_id,new.resolution_receipt_id)))
  or (new.resolution_receipt_id is distinct from old.resolution_receipt_id and new.state<>'resolved') then
   raise exception 'storage_isolation_immutable' using errcode='42501';
 end if;
 return new;
end $$;
create trigger storage_conflict_immutable_v1 before update or delete on clued_private.storage_conflict_isolations_v1
 for each row execute function clued_private.storage_conflict_immutable_v1();
create function clued_private.storage_conflict_observation_immutable_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or (to_jsonb(new)-'resolution_receipt_id') is distinct from (to_jsonb(old)-'resolution_receipt_id')
  or old.resolution_receipt_id is not null or not clued_private.storage_conflict_exit_allowed_v1(old.intent_id,new.resolution_receipt_id) then
  raise exception 'storage_observation_immutable' using errcode='42501'; end if; return new;
end $$;
create trigger storage_conflict_observation_immutable_v1 before update or delete on clued_private.storage_conflict_observations_v1
 for each row execute function clued_private.storage_conflict_observation_immutable_v1();

-- The caller cannot select an exemption with a GUC, a flag or an intent ID.
-- Only a private permit tied to an actual exit Receipt in this tx can do so.
create function clued_private.storage_conflict_assert_v1(p_owner uuid,p_profile uuid,p_mutation jsonb,p_provider jsonb default '{}'::jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare root text; q clued_private.storage_conflict_isolations_v1; touched text[]; ids text[]; object_touches text[]; item text; conflict boolean;
 candidate_slots jsonb; source_parent text; destination_parent text; identity text;
begin
 select root_folder_id into root from clued_private.resource_center_profiles_v1 where id=p_profile and user_id=p_owner;
 if root is null then raise exception 'storage_object_under_review' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':'||root,0));
 touched:=array_remove(array[p_mutation->>'source_path',p_mutation->>'destination_path',p_mutation->>'path'],null);
 ids:=array_remove(array[p_mutation->>'source_file_id',p_mutation->>'provider_file_id',
   p_provider->>'source_file_id',p_provider->>'destination_file_id'],null);
 select ids||coalesce(array_agg(a.provider_file_id),'{}'::text[]) into ids
  from clued_private.resource_center_artifacts_v1 a where a.user_id=p_owner and a.profile_id=p_profile
   and a.state in ('active','trashed') and a.path=any(touched) and a.provider_file_id is not null;
 source_parent:=p_provider->>'source_parent_id'; destination_parent:=p_provider->>'destination_parent_id';
 if source_parent is null and p_mutation->>'source_path' is not null then
  select provider_file_id into source_parent from clued_private.resource_center_artifacts_v1
   where user_id=p_owner and profile_id=p_profile and state='active' and target_kind='directory'
    and path=regexp_replace(p_mutation->>'source_path','/[^/]+$','');
 end if;
 if destination_parent is null and coalesce(p_mutation->>'destination_path',p_mutation->>'path') is not null then
  select provider_file_id into destination_parent from clued_private.resource_center_artifacts_v1
   where user_id=p_owner and profile_id=p_profile and state='active' and target_kind='directory'
    and path=regexp_replace(coalesce(p_mutation->>'destination_path',p_mutation->>'path'),'/[^/]+$','');
 end if;
 candidate_slots:=jsonb_build_array(jsonb_build_object('parent_id',source_parent,'name',regexp_replace(p_mutation->>'source_path','^.*/','')),
  jsonb_build_object('parent_id',destination_parent,'name',regexp_replace(coalesce(p_mutation->>'destination_path',p_mutation->>'path'),'^.*/','')));
 object_touches:=ids;
 -- The physical root is shared even when two Owner registrations use
 -- different local profiles. I9 locks this same ID before publishing scopes.
 ids:=ids||array_remove(array[root,source_parent,destination_parent],null);
 for identity in select value from (select distinct value from unnest(ids) value) s order by value collate "C" loop
  perform pg_advisory_xact_lock(hashtextextended('storage-object:'||identity,0));
 end loop;
 for q in select * from clued_private.storage_conflict_isolations_v1
  where state='active' and (root_folder_id=root or object_ids&&ids or ancestor_ids&&ids
   or exists(select 1 from jsonb_array_elements(slots) slot where slot->>'parent_id'=any(ids))) loop
  if exists(select 1 from clued_private.storage_conflict_exit_permits_v1 x where x.intent_id=q.intent_id
    and clued_private.storage_conflict_exit_allowed_v1(q.intent_id,x.receipt_id)) then continue; end if;
  conflict:=not q.scope_complete or q.object_ids&&ids or q.paths&&touched;
  if exists(select 1 from jsonb_array_elements(q.slots) a cross join jsonb_array_elements(candidate_slots) b
    where a->>'parent_id' is not null and a->>'name' is not null and a=b) then conflict:=true; end if;
  if p_mutation->>'target_kind'='directory' and q.ancestor_ids&&object_touches then conflict:=true; end if;
  foreach item in array touched loop
   if exists(select 1 from unnest(q.subtree_paths) p where item=p or left(item,length(p)+1)=p||'/') then conflict:=true; end if;
   if p_mutation->>'target_kind'='directory' and exists(select 1 from unnest(q.paths) p
      where p=item or left(p,length(item)+1)=item||'/') then conflict:=true; end if;
  end loop;
  if conflict then raise exception 'storage_object_under_review' using errcode='42501'; end if;
 end loop;
end $$;

create function clued_private.storage_conflict_artifact_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then perform clued_private.storage_conflict_assert_v1(old.user_id,old.profile_id,
  jsonb_build_object('path',old.path,'target_kind',old.target_kind,'provider_file_id',old.provider_file_id)); end if;
 if tg_op<>'DELETE' then perform clued_private.storage_conflict_assert_v1(new.user_id,new.profile_id,
  jsonb_build_object('path',new.path,'target_kind',new.target_kind,'provider_file_id',new.provider_file_id)); return new; end if;
 return old;
end $$;
create trigger storage_conflict_artifact_guard_v1 before insert or update or delete on clued_private.resource_center_artifacts_v1
 for each row execute function clued_private.storage_conflict_artifact_guard_v1();
create function clued_private.storage_conflict_prepare_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (new.state in ('prepared','started') and (tg_op='INSERT' or old.state is distinct from new.state))
  or (tg_op='UPDATE' and new.provider_attempt is distinct from old.provider_attempt) then
  perform clued_private.storage_conflict_assert_v1(new.user_id,new.profile_id,new.exact_request->'mutation',new.authority_request->'provider_identity');
 end if; return new;
end $$;
create trigger storage_conflict_prepare_guard_v1 before insert or update on clued_private.resource_center_mutations_v1
 for each row execute function clued_private.storage_conflict_prepare_guard_v1();

-- A job insert is already inside the caller's validated submit transaction.
-- Resolve ownership from its real connection, never a payload profile. This
-- also protects validated legacy/new entry points before a queued row exists.
create function clued_private.storage_conflict_job_insert_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare profile uuid;
begin
 select c.profile_id into profile from clued_private.storage_connections_v1 c where c.id=new.connection_id and c.owner_id=new.owner_id;
 if profile is null then raise exception 'storage_job_unavailable' using errcode='42501'; end if;
 perform clued_private.storage_conflict_assert_v1(new.owner_id,profile,new.mutation);
 return new;
end $$;
create trigger storage_conflict_job_insert_guard_v1 before insert on clued_private.storage_jobs_v1
 for each row execute function clued_private.storage_conflict_job_insert_guard_v1();

-- The ordinary account submit keeps authorization and both historical replay
-- checks first, but refuses overlap before the Work Claim, Receipt or job.
do $submit$ declare body text; anchor text:=$a$  gate:=clued_private.work_claim_gate_v1((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,$a$;
begin
 body:=pg_get_functiondef('clued_private.storage_jobs_policy_core_v2(text,jsonb)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_conflict_submit_source_mismatch'; end if;
 execute replace(body,anchor,$r$  begin
   perform clued_private.storage_conflict_assert_v1((snapshot->>'owner_id')::uuid,(snapshot->>'profile_id')::uuid,m);
  exception when insufficient_privilege then
   if sqlerrm<>'storage_object_under_review' then raise; end if;
   return jsonb_build_object('status','rejected','error_code','storage_object_under_review',
    'job_id',v_job_id,'connection_id',connection_id,'execution_permitted',false);
  end;
  gate:=clued_private.work_claim_gate_v1((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,$r$);
end $submit$;

-- A job queued before an isolation was published must end as a real denied
-- dispatch, rather than remain queued after a load exception. The existing
-- authenticated report path supplies its independent Receipt and Event.
-- Original job/history responses above this load branch remain readable.
do $load$ declare body text; anchor text:=$a$  if op='load' then
    perform clued_private.storage_root_quiet_v1(c.owner_id,p.root_folder_id);$a$;
begin
 body:=pg_get_functiondef('clued_private.ii_priv_storage_cloud_worker_v2(text,jsonb)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_conflict_load_source_mismatch'; end if;
 execute replace(body,anchor,$r$  if op='load' then
    begin
     perform clued_private.storage_conflict_assert_v1(c.owner_id,p.id,j.mutation);
    exception when insufficient_privilege then
     if sqlerrm<>'storage_object_under_review' then raise; end if;
     result:=clued_private.ii_priv_storage_cloud_worker_v2(p_issuer_identity,jsonb_build_object('action','report',
      'connection_id',c.id,'job_id',j.job_id,'credential_version',c.credential_version,
      'outcome',jsonb_build_object('status','denied','reason',jsonb_build_object('code','STORAGE_OBJECT_UNDER_REVIEW'))));
     return jsonb_build_object('contract','clued.storage-job-execution/1','owner_id',c.owner_id)||result;
    end;
    perform clued_private.storage_root_quiet_v1(c.owner_id,p.root_folder_id);$r$);
end $load$;

-- Also enforce before resolving authority: registration, legacy writers and
-- new entry points cannot bypass the durable object/slot/subtree quarantine.
do $patch$ declare body text; anchor text:=$a$  if v_provider->>'root_folder_id' is distinct from v_profile.root_folder_id or$a$;
begin
 body:=pg_get_functiondef('public.clued_resource_center_authority_v1(text,jsonb)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_conflict_authority_source_mismatch'; end if;
 execute replace(body,anchor,E'  perform clued_private.storage_conflict_assert_v1(v_profile.user_id,v_profile.id,v_mutation,v_provider);\n'||anchor);
end $patch$;

create function clued_private.storage_conflict_close_candidate_v1(p_intent uuid) returns text
language plpgsql security definer set search_path='' as $$
declare m clued_private.resource_center_mutations_v1; p clued_private.resource_center_profiles_v1;
 j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1;
 r public.clued_audit_receipts; req jsonb; refs jsonb; ev text; no_attempt boolean; paths text[]; ids text[]; ancestors text[]; slots jsonb; before jsonb;
 op text; threshold timestamptz; cloud boolean; reason text; state_after text; saved_version bigint; saved_receipt uuid; identity text; complete boolean;
begin
 select * into m from clued_private.resource_center_mutations_v1 where id=p_intent;
 if m.id is null then return 'unchanged'; end if;
 select * into j from clued_private.storage_jobs_v1 where owner_id=m.user_id and intent_id=m.id;
 if j.job_id is not null then perform pg_advisory_xact_lock(hashtextextended('storage-job:'||m.user_id::text||':'||j.job_id::text,0)); end if;
 select * into p from clued_private.resource_center_profiles_v1 where id=m.profile_id and user_id=m.user_id;
 perform pg_advisory_xact_lock(hashtextextended(m.user_id::text||':'||p.root_folder_id,0));
 select * into m from clued_private.resource_center_mutations_v1 where id=p_intent for update;
 if m.state not in ('prepared','started','uncertain') then return 'unchanged'; end if;
 op:=m.exact_request->'mutation'->>'operation';
 if m.state<>'prepared' and ((op='move' and m.exact_request->'mutation'->>'target_kind'='directory')
  or (op='adopt' and j.authority_snapshot_v2 is null)) then return 'owner_directory_recovery'; end if;
 cloud:=j.job_id is not null and j.cloud_writer_binding_id is not null and m.writer_binding_id is not distinct from j.cloud_writer_binding_id;
 no_attempt:=m.state='prepared' or (cloud and j.authority_snapshot_v2 is not null and
  ((m.provider_attempt is null and m.provider_attempt_receipt_id is null and m.verified_result_v2 is null) or op='adopt'));
 threshold:=case when no_attempt then m.expires_at+interval '60 seconds'
  when cloud and m.provider_attempt is not null then m.expires_at+interval '130 minutes'+
   case when m.exact_request->'mutation' ? 'content_ref' then interval '120 seconds'
    when op='create' then interval '60 seconds' else interval '10 seconds' end
  else m.expires_at+interval '130 minutes' end;
 if threshold>clock_timestamp() then return 'not_due'; end if;
 -- Existing immutable proof is tried before conflict. Failure cannot erase it.
 if m.verified_result_v2 is not null and j.job_id is not null then
  begin
   perform clued_private.ii_priv_storage_verified_result_v2(
    coalesce((select legacy_key from clued_private.issuer_identities_v1 where id=(m.verified_result_v2->>'issuer_id')::uuid and kind='storage'),m.verified_result_v2->>'issuer_hash'),
    jsonb_build_object('action','settle_verified','connection_id',j.connection_id,'job_id',j.job_id));
   select * into m from clued_private.resource_center_mutations_v1 where id=p_intent;
   if m.state='committed' then return 'committed'; end if;
  exception when others then null; end;
 end if;
 saved_version:=m.version; saved_receipt:=m.receipt_id;
 state_after:=case when no_attempt then 'cancelled' else 'conflict' end;
 reason:=case when no_attempt then case when op='adopt' then 'ADOPT_NOT_SETTLED' else 'NO_PROVIDER_ATTEMPT' end else 'PROVIDER_STATE_CONFLICT' end;
 req:=jsonb_build_object('idempotency_key','storage-i9:'||m.id::text,'intent_id',m.id,'job_id',j.job_id,
  'base_version',m.version,'reason_code',reason);
 r:=clued_private.m1_begin_receipt(m.user_id,null,case when no_attempt then 'storage_unattempted_release' else 'storage_conflict_settle' end,req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_conflict_receipt_conflict' using errcode='40001'; end if;
 if not no_attempt then
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=m.user_id;
  select coalesce(array_agg(distinct value),'{}') into paths from unnest(array[
   m.exact_request->'mutation'->>'source_path',m.exact_request->'mutation'->>'destination_path']) value where value is not null;
  select coalesce(array_agg(distinct value),'{}') into ids from unnest(array[m.provider_attempt->>'provider_file_id',
   m.authority_request->'provider_identity'->>'source_file_id',m.authority_request->'provider_identity'->>'destination_file_id']) value where value is not null;
  before:=m.authority_request->'provider_identity';
  select coalesce(array_agg(distinct value),'{}') into ancestors from (
   select before->>'root_folder_id' value union all select before->>'source_parent_id' union all select before->>'destination_parent_id'
   union all select a->>'id' from jsonb_array_elements(case when jsonb_typeof(before->'ancestors')='array' then before->'ancestors' else '[]' end) a
  ) s where value is not null;
  slots:=jsonb_build_array(jsonb_build_object('parent_id',before->>'source_parent_id','name',regexp_replace(m.exact_request->'mutation'->>'source_path','^.*/','')),
   jsonb_build_object('parent_id',before->>'destination_parent_id','name',regexp_replace(m.exact_request->'mutation'->>'destination_path','^.*/','')));
  for identity in select value from (select distinct value from unnest(ids||ancestors) value) s order by value collate "C" loop
   perform pg_advisory_xact_lock(hashtextextended('storage-object:'||identity,0));
  end loop;
  complete:=cardinality(paths)>0 and (cardinality(ids)>0 or (op='create' and not cloud)) and before->>'root_folder_id'=p.root_folder_id
   and (m.exact_request->'mutation'->>'source_path' is null or before->>'source_parent_id' is not null)
   and (m.exact_request->'mutation'->>'destination_path' is null or before->>'destination_parent_id' is not null)
   and not exists(select 1 from unnest(paths) value where left(value,length(p.managed_root)+1)<>p.managed_root||'/')
   and not exists(select 1 from clued_private.resource_center_artifacts_v1 a where a.user_id=m.user_id and a.profile_id=p.id
    and a.state='active' and a.target_kind='directory' and exists(select 1 from unnest(paths) value where left(value,length(a.path)+1)=a.path||'/')
    and not(a.provider_file_id=any(ancestors)));
  insert into clued_private.storage_conflict_isolations_v1(intent_id,user_id,profile_id,connection_id,job_id,root_folder_id,
   provider,provider_subject,oauth_client_id,paths,subtree_paths,object_ids,ancestor_ids,slots,scope_complete,original_state,original_version,
   original_receipt_id,close_receipt_id,closed_version)
  values(m.id,m.user_id,m.profile_id,j.connection_id,j.job_id,p.root_folder_id,c.provider,c.provider_subject,c.oauth_client_id,
   paths,case when m.exact_request->'mutation'->>'target_kind'='directory' then paths else '{}' end,ids,ancestors,slots,
   coalesce(complete,false),m.state,m.version,m.receipt_id,r.id,m.version+1);
 end if;
 update clued_private.resource_center_mutations_v1 set state=state_after,version=version+1,updated_at=clock_timestamp(),receipt_id=r.id,
  final_result=jsonb_build_object('outcome',case when no_attempt then 'released_unattempted' else 'conflict' end,
   'reason_code',reason,'observation','unknown','execution_permitted',false) where id=m.id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 ev:=clued_private.m1_append_event_row(m.user_id,null,r.id,r.canonical_version,
  case when no_attempt then 'extension:storage:unattempted_released' else 'extension:storage:conflict_settled' end,
  refs,'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(m.id::text,saved_version),
  jsonb_build_object(m.id::text,saved_version+1),array[ev],'{}'::uuid[],null);
 return state_after;
end $$;

-- This delivery deliberately admits only the existing account-policy cloud
-- job lineage (including Owner-native jobs of that lineage). Legacy/null
-- snapshots and non-job writers retain their original recovery behavior;
-- their full I9/I12 Owner experience is a subsequent implementation phase.
-- Current credential, connection/policy state, expiry and OAuth flags are not
-- prerequisites for ending an old, already admitted attempt.
create function clued_private.storage_conflict_supported_v1(p_intent uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from clued_private.resource_center_mutations_v1 m
  join clued_private.storage_jobs_v1 j on j.owner_id=m.user_id and j.intent_id=m.id
  join clued_private.resource_center_profiles_v1 p on p.id=m.profile_id and p.user_id=m.user_id
  join clued_private.storage_connections_v1 c on c.id=j.connection_id and c.owner_id=j.owner_id and c.profile_id=p.id
  join clued_private.storage_account_policies_v2 policy on policy.id::text=j.authority_snapshot_v2->>'policy_id'
   and policy.owner_id=j.owner_id and policy.connection_id=c.id and policy.profile_id=p.id
  where m.id=p_intent and j.authority_snapshot_v2 is not null and j.cloud_writer_binding_id is not null
   and m.writer_binding_id=j.cloud_writer_binding_id and c.provider='google-drive' and c.provider_subject is not null
   and c.oauth_client_id is not null and policy.provider=c.provider and policy.provider_subject=c.provider_subject
   and policy.root_folder_id=p.root_folder_id and m.authority_request->'provider_identity'->>'root_folder_id'=p.root_folder_id
   and j.authority_snapshot_v2->>'owner_id'=j.owner_id::text
   and j.authority_snapshot_v2->>'connection_id'=c.id::text and j.authority_snapshot_v2->>'profile_id'=p.id::text
   and j.authority_snapshot_v2->>'profile_version'=m.profile_version::text)
$$;
create function clued_private.storage_conflict_close_v1(p_intent uuid) returns text
language plpgsql security definer set search_path='' as $$
begin
 if not clued_private.storage_conflict_supported_v1(p_intent) then return 'outside_delivery_scope'; end if;
 return clued_private.storage_conflict_close_candidate_v1(p_intent);
end $$;

create function clued_private.storage_conflict_sweep_v1() returns jsonb
language plpgsql security definer set search_path='' as $$
declare cand record; outcome text; n integer:=0; released integer:=0; conflicts integer:=0; errors integer:=0;
begin
 perform clued_private.storage_conflict_require_scheduler_v1();
 perform set_config('lock_timeout','2s',true);
 for cand in select m.id from clued_private.resource_center_mutations_v1 m
  left join clued_private.storage_jobs_v1 j on j.owner_id=m.user_id and j.intent_id=m.id
  left join clued_private.storage_conflict_scan_v1 scan on scan.intent_id=m.id
  where m.state in ('prepared','started','uncertain')
   and clued_private.storage_conflict_supported_v1(m.id)
   and coalesce(scan.next_attempt_at,'-infinity'::timestamptz)<=clock_timestamp()
   and (m.state='prepared' or not((m.exact_request->'mutation'->>'operation'='move' and m.exact_request->'mutation'->>'target_kind'='directory')
    or (m.exact_request->'mutation'->>'operation'='adopt' and j.authority_snapshot_v2 is null)))
   and case when m.state='prepared' or (j.authority_snapshot_v2 is not null and j.cloud_writer_binding_id is not null and m.writer_binding_id is not distinct from j.cloud_writer_binding_id
     and ((m.provider_attempt is null and m.provider_attempt_receipt_id is null and m.verified_result_v2 is null)
       or m.exact_request->'mutation'->>'operation'='adopt')) then m.expires_at+interval '60 seconds'
    when j.cloud_writer_binding_id is not null and m.writer_binding_id is not distinct from j.cloud_writer_binding_id and m.provider_attempt is not null
     then m.expires_at+interval '130 minutes'+case when m.exact_request->'mutation'?'content_ref' then interval '120 seconds'
      when m.exact_request->'mutation'->>'operation'='create' then interval '60 seconds' else interval '10 seconds' end
    else m.expires_at+interval '130 minutes' end<=clock_timestamp()
   order by m.expires_at,m.id limit 50 loop
  begin
   outcome:=clued_private.storage_conflict_close_v1(cand.id); n:=n+1;
   if outcome='cancelled' then released:=released+1; elsif outcome='conflict' then conflicts:=conflicts+1; end if;
  exception when others then
   errors:=errors+1;
   insert into clued_private.storage_conflict_scan_v1(intent_id,attempts,next_attempt_at)
    values(cand.id,1,clock_timestamp()+interval '1 minute') on conflict(intent_id)
    do update set attempts=clued_private.storage_conflict_scan_v1.attempts+1,
     next_attempt_at=clock_timestamp()+least(interval '10 minutes',interval '1 minute'*(clued_private.storage_conflict_scan_v1.attempts+1));
  end;
 end loop;
 return jsonb_build_object('status','ok','examined',n,'released',released,'conflicted',conflicts,'errors',errors,'execution_permitted',false);
end $$;

-- Public status remains compatible: conflict is attention_required, with its
-- own durable Receipt, never a queued/started job which a dispatcher can replay.
do $patch$ declare body text; anchor text:=$a$'status',coalesce(m.state,$a$;
begin
 body:=pg_get_functiondef('clued_private.storage_job_status_v1(clued_private.storage_jobs_v1)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_conflict_status_source_mismatch'; end if;
 body:=replace(body,anchor,$r$'status',coalesce(case when m.state='conflict' then 'attention_required' else m.state end,$r$);
 anchor:=$a$    ||case when m.state='cancelled'$a$;
 if strpos(body,anchor)=0 then raise exception 'storage_conflict_reason_source_mismatch'; end if;
 body:=replace(body,anchor,$r$    ||case when m.state in ('cancelled','conflict')$r$);
 anchor:=$a$  from (values(1)) seed(n) left join clued_private.resource_center_mutations_v1 m on m.id=p_job.intent_id$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_conflict_resolution_source_mismatch'; end if;
 body:=replace(body,anchor,$r$    ||coalesce((select jsonb_build_object('reason_code','PROVIDER_RESULT_RECONCILED',
      'resolution',m.final_result->>'review_outcome','resolution_receipt_id',q.resolution_receipt_id,'source_receipt_id',q.close_receipt_id)
      from clued_private.storage_conflict_isolations_v1 q join public.clued_audit_receipts receipt on receipt.id=q.resolution_receipt_id
       and receipt.user_id=q.user_id and receipt.status='committed'
      where q.intent_id=m.id and q.user_id=p_job.owner_id and q.state='resolved'
       and m.final_result->>'review_outcome' in ('accepted_current_state','abandoned_registration')),'{}'::jsonb)
  from (values(1)) seed(n) left join clued_private.resource_center_mutations_v1 m on m.id=p_job.intent_id$r$);
 execute body;
end $patch$;

create function clued_private.storage_recovery_report_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1; d jsonb:=p_input->'diagnostic'; observed timestamptz;
begin
 if p_input-array['action','connection_id','job_id','diagnostic']<>'{}'::jsonb or p_input->>'action'<>'report'
  or jsonb_typeof(d) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(d) k)
   is distinct from array['automatic_next_action','observed_at','reason','stage']
  or coalesce(d->>'stage','') not in ('request','descriptor','credential','provider','verification','verified_record','settlement')
  or coalesce(d->>'reason','') not in ('REQUEST_UNAVAILABLE','DESCRIPTOR_UNAVAILABLE','CREDENTIAL_UNAVAILABLE','CREDENTIAL_EXPIRING','PROVIDER_TIMEOUT',
   'PROVIDER_UNAVAILABLE','PROVIDER_RESPONSE_INVALID','PROVIDER_IDENTITY_CHANGED','REVISION_UNCHANGED','CONTENT_MISMATCH',
   'PREVIOUS_REVISION_UNCONFIRMED','RESULT_NOT_YET_VISIBLE','VERIFIED_RECORD_UNCONFIRMED','SETTLEMENT_UNCONFIRMED','UNKNOWN_EFFECT')
  or coalesce(d->>'automatic_next_action','') not in ('retry_metadata','check_existing_authorization','inspect_original_receipt','continue_object_recovery','none') then
   raise exception 'storage_recovery_diagnostic_invalid' using errcode='22023'; end if;
 observed:=(d->>'observed_at')::timestamptz;
 if observed is null or abs(extract(epoch from observed-clock_timestamp()))>60 then raise exception 'storage_recovery_diagnostic_invalid' using errcode='22023'; end if;
 select * into j from clued_private.storage_jobs_v1 where job_id=(p_input->>'job_id')::uuid and connection_id=(p_input->>'connection_id')::uuid;
 select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=j.owner_id;
 if j.job_id is null or not exists(select 1 from clued_private.storage_oauth_apps_v1 a where a.issuer_hash=p_issuer_identity
   and a.revoked_at is null and a.oauth_client_id=c.oauth_client_id) then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
 insert into clued_private.storage_recovery_diagnostics_v1 values(j.owner_id,j.connection_id,j.job_id,
  d||jsonb_build_object('observed_at',clock_timestamp()),clock_timestamp()) on conflict(user_id,job_id)
  do update set diagnostic=excluded.diagnostic,observed_at=excluded.observed_at;
 return jsonb_build_object('status','recorded','connection_id',j.connection_id,'job_id',j.job_id,'execution_permitted',false);
end $$;

-- A review descriptor is settlement-only. It pins the historical subject,
-- client and root, accepts no browser metadata and never calls begin/start.
create function clued_private.storage_conflict_load_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q clued_private.storage_conflict_isolations_v1; j clued_private.storage_jobs_v1;
 m clued_private.resource_center_mutations_v1; c clued_private.storage_connections_v1;
 p clued_private.resource_center_profiles_v1; policy clued_private.storage_account_policies_v2;
begin
 select * into j from clued_private.storage_jobs_v1 where connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid;
 if j.job_id is null then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||j.owner_id::text||':'||j.job_id::text,0));
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
 if q.intent_id is null or q.state<>'active' then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||':'||q.root_folder_id,0));
 perform clued_private.authorization_account_v12(j.owner_id);
 select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=j.owner_id for share;
 select * into p from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=j.owner_id for share;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for share;
 select * into policy from clued_private.storage_account_policies_v2 where id=(j.authority_snapshot_v2->>'policy_id')::uuid and owner_id=j.owner_id;
 if m.state<>'conflict' or not q.scope_complete or c.provider<>'google-drive' or c.revoked_at is not null
  or c.state not in ('active','reauthorization_required') or c.provider is distinct from q.provider
  or c.provider_subject is distinct from q.provider_subject or c.oauth_client_id is distinct from q.oauth_client_id
  or p.root_folder_id is distinct from q.root_folder_id
  or (j.authority_snapshot_v2 is not null and (policy.id is null
   or policy.provider_subject is distinct from q.provider_subject or policy.root_folder_id is distinct from q.root_folder_id))
  or j.cloud_writer_binding_id is null or m.writer_binding_id is distinct from j.cloud_writer_binding_id
  or m.provider_attempt is null or m.provider_attempt_receipt_id is null
  or not clued_private.storage_envelope_valid_v1(c.credential_envelope)
  or not exists(select 1 from clued_private.storage_oauth_apps_v1 a where a.issuer_hash=p_issuer_identity and a.revoked_at is null and a.oauth_client_id=q.oauth_client_id)
  or exists(select 1 from clued_private.storage_client_denies_v2 d where d.owner_id=j.owner_id
    and d.lineage_id=(j.authority_snapshot_v2->>'registration_lineage')::uuid and d.denied)
  or exists(select 1 from clued_private.storage_root_denies_v2 d where d.owner_id=j.owner_id and d.provider=q.provider
    and d.provider_subject=q.provider_subject and d.root_folder_id=q.root_folder_id
    and (d.lineage_id is null or d.lineage_id=(j.authority_snapshot_v2->>'registration_lineage')::uuid) and d.denied) then
   raise exception 'storage_recovery_denied' using errcode='42501'; end if;
 return jsonb_build_object('status','recovery_only','owner_id',j.owner_id,'connection_id',j.connection_id,'job_id',j.job_id,
  'provider','google-drive','provider_subject',q.provider_subject,'oauth_client_id',q.oauth_client_id,
  'credential_version',c.credential_version,'credential_envelope',c.credential_envelope,
  'profile',jsonb_build_object('managed_root',p.managed_root),'root_folder_id',q.root_folder_id,'root_parent_id',p.root_parent_id,
  'mutation',m.exact_request->'mutation','provider_before',m.authority_request->'provider_identity','attempt',m.provider_attempt,
  'intent_id',m.id,'version',m.version,'request_sha256',m.request_sha256);
end $$;

create function clued_private.storage_conflict_observe_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare descriptor jsonb; q clued_private.storage_conflict_isolations_v1; m clued_private.resource_center_mutations_v1;
 a clued_private.resource_center_artifacts_v1; parent clued_private.resource_center_artifacts_v1; p clued_private.resource_center_profiles_v1;
 o jsonb:=p_input->'observation'; observed timestamptz; observation_id uuid;
begin
 if p_input-array['action','connection_id','job_id','base_version','source_receipt_id','observation']<>'{}'
  or p_input->>'action'<>'review_observe' or jsonb_typeof(o) is distinct from 'object'
  or (select array_agg(k order by k) from jsonb_object_keys(o) k) is distinct from array[
   'head_revision_id','mime_type','name','observed_at','observed_state','parent_id','provider_file_id','provider_file_version','sha256','size','trashed']
  or coalesce(o->>'observed_state','') not in ('before','after','changed','absent') then
   raise exception 'storage_conflict_observation_invalid' using errcode='22023'; end if;
 descriptor:=clued_private.storage_conflict_load_v1(p_issuer_identity,p_input);
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=(descriptor->>'intent_id')::uuid for update;
 select * into m from clued_private.resource_center_mutations_v1 where id=q.intent_id for update;
 observed:=(o->>'observed_at')::timestamptz;
 if q.closed_version>m.version or m.version::text is distinct from p_input->>'base_version'
  or q.close_receipt_id::text is distinct from p_input->>'source_receipt_id'
  or m.exact_request->'mutation'->>'target_kind'<>'file' or cardinality(q.object_ids)<>1
  or o->>'provider_file_id' is distinct from q.object_ids[1]
  or observed is null or abs(extract(epoch from observed-clock_timestamp()))>60 then
   raise exception 'storage_conflict_observation_conflict' using errcode='40001'; end if;
 if o->>'observed_state'='absent' then
  if o-array['provider_file_id','observed_at','observed_state'] is distinct from jsonb_build_object('provider_file_version',null,'parent_id',null,
    'name',null,'trashed',null,'mime_type',null,'size',null,'sha256',null,'head_revision_id',null) then
   raise exception 'storage_conflict_observation_invalid' using errcode='22023'; end if;
 else
  if coalesce(o->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$'
   or coalesce(o->>'parent_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
   or coalesce(length(o->>'name'),0) not between 1 and 255 or o->>'name' ~ '[/\\[:cntrl:]]'
   or jsonb_typeof(o->'trashed')<>'boolean' or coalesce(length(o->>'mime_type'),0) not between 1 and 255
   or o->>'mime_type'='application/vnd.google-apps.folder'
   or (o->>'sha256' is not null and o->>'sha256' !~ '^[0-9a-f]{64}$')
   or (o->>'size' is not null and o->>'size' !~ '^(0|[1-9][0-9]{0,19})$') then
   raise exception 'storage_conflict_observation_invalid' using errcode='22023'; end if;
  select * into parent from clued_private.resource_center_artifacts_v1 pa where pa.user_id=q.user_id and pa.profile_id=q.profile_id
    and pa.state='active' and pa.target_kind='directory' and pa.provider_file_id=o->>'parent_id' for share;
  if parent.id is null then
   raise exception 'storage_conflict_parent_unqualified' using errcode='42501'; end if;
 end if;
 select * into a from clued_private.resource_center_artifacts_v1 where user_id=q.user_id and profile_id=q.profile_id
  and provider_file_id=q.object_ids[1] and state='active';
 if a.id is null and (m.exact_request->'mutation'->>'operation'<>'create' or exists(
  select 1 from clued_private.resource_center_artifacts_v1 x where x.user_id=q.user_id and x.profile_id=q.profile_id
   and x.state in ('active','trashed') and x.path=any(q.paths))) then
  raise exception 'storage_conflict_artifact_changed' using errcode='40001'; end if;
 select * into p from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=q.user_id for share;
 insert into clued_private.storage_conflict_observations_v1(intent_id,user_id,connection_id,job_id,base_version,source_receipt_id,
  observation,artifact_id,artifact_version,profile_version,parent_artifact_id,parent_artifact_version,observed_at,expires_at)
 values(q.intent_id,q.user_id,q.connection_id,q.job_id,m.version,q.close_receipt_id,o,a.id,a.version,p.version,parent.id,parent.version,observed,observed+interval '5 minutes') returning id into observation_id;
 return jsonb_build_object('status','review_prepared','connection_id',q.connection_id,'job_id',q.job_id,
  'observation_id',observation_id,'base_version',m.version,
  'source_receipt_id',q.close_receipt_id,'observed_at',observed,'observed_state',o->>'observed_state','execution_permitted',false,
  'file_name',coalesce(o->>'name',regexp_replace(coalesce(a.path,q.paths[1]),'^.*/','')),'provider_file_id',o->>'provider_file_id',
  'provider_file_version',o->'provider_file_version','mime_type',o->'mime_type','size',o->'size','sha256',o->'sha256');
end $$;

-- Final Owner acceptance is preceded by another server-side GET-only stable
-- observation. Its semantic snapshot must equal the one the Owner reviewed.
create function clued_private.storage_conflict_revalidate_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare descriptor jsonb; o clued_private.storage_conflict_observations_v1; m clued_private.resource_center_mutations_v1;
 fresh jsonb:=p_input->'observation'; observed timestamptz;
begin
 if p_input-array['action','connection_id','job_id','base_version','source_receipt_id','observation_id','observation']<>'{}'
  or p_input->>'action'<>'review_revalidate' or jsonb_typeof(fresh) is distinct from 'object' then
  raise exception 'storage_conflict_observation_invalid' using errcode='22023'; end if;
 descriptor:=clued_private.storage_conflict_load_v1(p_issuer_identity,p_input);
 select * into o from clued_private.storage_conflict_observations_v1 where id=(p_input->>'observation_id')::uuid
  and user_id=(descriptor->>'owner_id')::uuid and connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid for update;
 select * into m from clued_private.resource_center_mutations_v1 where id=o.intent_id for share;
 observed:=(fresh->>'observed_at')::timestamptz;
 if o.id is null or o.resolution_receipt_id is not null or o.expires_at<=clock_timestamp()
  or o.base_version::text is distinct from p_input->>'base_version' or m.version<>o.base_version
  or o.source_receipt_id::text is distinct from p_input->>'source_receipt_id'
  or observed is null or observed<clock_timestamp()-interval '30 seconds' or observed>clock_timestamp()+interval '5 seconds'
  or (fresh-'observed_at') is distinct from (o.observation-'observed_at') then
  raise exception 'storage_conflict_observation_changed' using errcode='40001'; end if;
 insert into clued_private.storage_conflict_validations_v1 values(o.id,least(observed,clock_timestamp()),clued_private.m1_sha256(fresh-'observed_at'))
  on conflict(observation_id) do update set validated_at=excluded.validated_at,semantic_sha256=excluded.semantic_sha256;
 return jsonb_build_object('status','review_revalidated','connection_id',o.connection_id,'job_id',o.job_id,'observation_id',o.id,
  'source_receipt_id',o.source_receipt_id,'base_version',o.base_version,'execution_permitted',false);
end $$;

create function clued_private.storage_conflict_accept_v1(p_owner uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o clued_private.storage_conflict_observations_v1; q clued_private.storage_conflict_isolations_v1;
 m clued_private.resource_center_mutations_v1; a clued_private.resource_center_artifacts_v1; p clued_private.resource_center_profiles_v1; parent_path text;
 r public.clued_audit_receipts; req jsonb; refs jsonb; ev text; registered jsonb;
begin
 if p_input-array['action','connection_id','job_id','observation_id','base_version','source_receipt_id','confirmed']<>'{}'
  or p_input->>'action'<>'review_accept' or p_input->'confirmed' is distinct from 'true'::jsonb then
   raise exception 'storage_conflict_review_invalid' using errcode='22023'; end if;
 select * into o from clued_private.storage_conflict_observations_v1 where id=(p_input->>'observation_id')::uuid and user_id=p_owner
  and connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid;
 if o.id is null or o.base_version::text is distinct from p_input->>'base_version' or o.source_receipt_id::text is distinct from p_input->>'source_receipt_id' then
  raise exception 'storage_conflict_review_conflict' using errcode='40001'; end if;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||p_owner::text||':'||o.job_id::text,0));
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=o.intent_id and user_id=p_owner;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':'||q.root_folder_id,0));
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=o.intent_id for update;
 if q.state='resolved' and q.resolution_receipt_id=o.resolution_receipt_id then
  return jsonb_build_object('status','resolved','resolution','accepted_current_state','connection_id',o.connection_id,'job_id',o.job_id,
   'receipt_id',q.resolution_receipt_id,'source_receipt_id',o.source_receipt_id,'base_version',o.base_version,'observation_id',o.id,'execution_permitted',false);
 end if;
 select * into m from clued_private.resource_center_mutations_v1 where id=q.intent_id and user_id=p_owner for update;
 select * into a from clued_private.resource_center_artifacts_v1 where id=o.artifact_id and user_id=p_owner for update;
 select * into p from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=p_owner for share;
 if q.state<>'active' or m.state<>'conflict' or m.version<>o.base_version or q.close_receipt_id<>o.source_receipt_id
  or o.expires_at<=clock_timestamp()
  or not exists(select 1 from clued_private.storage_conflict_validations_v1 v where v.observation_id=o.id
   and v.validated_at>clock_timestamp()-interval '30 seconds' and v.validated_at<=clock_timestamp()
   and v.semantic_sha256=clued_private.m1_sha256(o.observation-'observed_at'))
  or (o.artifact_id is not null and (a.id is null or a.state<>'active' or a.version<>o.artifact_version))
  or (o.artifact_id is null and (m.exact_request->'mutation'->>'operation'<>'create' or exists(
   select 1 from clued_private.resource_center_artifacts_v1 x where x.user_id=p_owner and x.profile_id=q.profile_id
    and ((x.state in ('active','trashed') and x.path=any(q.paths)) or x.provider_file_id=q.object_ids[1]))))
  or q.job_id is null or p.state<>'active' or p.version<>o.profile_version or p.root_folder_id is distinct from q.root_folder_id
  or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,p.source_decision_id)
  or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,m.source_decision_id)
  or exists(select 1 from clued_private.storage_root_denies_v2 d where d.owner_id=p_owner and d.provider=q.provider
   and d.provider_subject=q.provider_subject and d.root_folder_id=q.root_folder_id and d.lineage_id is null and d.denied)
  or exists(select 1 from clued_private.storage_jobs_v1 j join clued_private.storage_client_denies_v2 d
   on d.owner_id=j.owner_id and d.lineage_id=(j.authority_snapshot_v2->>'registration_lineage')::uuid and d.denied
   where j.owner_id=p_owner and j.job_id=q.job_id)
  or exists(select 1 from clued_private.storage_jobs_v1 j join clued_private.storage_root_denies_v2 d
   on d.owner_id=j.owner_id and d.lineage_id=(j.authority_snapshot_v2->>'registration_lineage')::uuid and d.denied
   where j.owner_id=p_owner and j.job_id=q.job_id and d.provider=q.provider and d.provider_subject=q.provider_subject and d.root_folder_id=q.root_folder_id)
  then raise exception 'storage_conflict_review_conflict' using errcode='40001'; end if;
 if not exists(select 1 from clued_private.storage_jobs_v1 j where j.owner_id=p_owner and j.job_id=q.job_id
   and j.cloud_writer_binding_id is not null and j.cloud_writer_binding_id is not distinct from m.writer_binding_id) then
   raise exception 'storage_conflict_termination_evidence_required' using errcode='42501'; end if;
 req:=p_input||jsonb_build_object('idempotency_key','storage-review-accept:'||o.id::text,'intent_id',m.id);
 r:=clued_private.m1_begin_receipt(p_owner,null,'storage_conflict_accept',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_conflict_review_conflict' using errcode='40001'; end if;
 insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
 if o.observation->>'observed_state'='absent' or o.observation->'trashed'='true'::jsonb then
  update clued_private.resource_center_artifacts_v1 set state='revoked',version=version+1,updated_at=clock_timestamp(),receipt_id=r.id where id=a.id;
 else
  select path into parent_path from clued_private.resource_center_artifacts_v1 where user_id=p_owner and profile_id=q.profile_id
   and id=o.parent_artifact_id and version=o.parent_artifact_version and state='active' and target_kind='directory'
   and provider_file_id=o.observation->>'parent_id' for share;
  if parent_path is null or not clued_private.resource_center_path_current_v1(p_owner,p.project_id,p.id,p.managed_root,parent_path) then
   raise exception 'storage_conflict_parent_unqualified' using errcode='42501'; end if;
  if o.artifact_id is null then
   registered:=public.clued_resource_center_admin_v1(p_owner,jsonb_build_object('action','artifact_register','profile_id',p.id,
    'source_decision_id',m.source_decision_id,'idempotency_key','storage-review-artifact:'||o.id::text,
    'path',parent_path||'/'||(o.observation->>'name'),'provider_file_id',o.observation->>'provider_file_id',
    'provider_file_version',o.observation->>'provider_file_version','target_kind','file',
    'governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false));
   if registered->>'status' is distinct from 'committed' then raise exception 'storage_conflict_artifact_changed' using errcode='40001'; end if;
  else
   update clued_private.resource_center_artifacts_v1 set path=parent_path||'/'||(o.observation->>'name'),
    provider_file_version=o.observation->>'provider_file_version',version=version+1,updated_at=clock_timestamp(),receipt_id=r.id where id=a.id;
  end if;
 end if;
 update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 update clued_private.storage_conflict_observations_v1 set resolution_receipt_id=r.id where id=o.id;
 update clued_private.resource_center_mutations_v1 set version=version+1,updated_at=clock_timestamp(),
  final_result=final_result||jsonb_build_object('review_outcome','accepted_current_state','review_receipt_id',r.id,
   'review_base_version',o.base_version,'review_observation_id',o.id) where id=m.id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 ev:=clued_private.m1_append_event_row(p_owner,null,r.id,r.canonical_version,'extension:storage:conflict_current_state_accepted',refs,
  'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(m.id::text,m.version),jsonb_build_object(m.id::text,m.version+1),array[ev],'{}'::uuid[],null);
 return jsonb_build_object('status','resolved','resolution','accepted_current_state','connection_id',o.connection_id,'job_id',o.job_id,
  'receipt_id',r.id,'source_receipt_id',o.source_receipt_id,'base_version',o.base_version,'observation_id',o.id,'execution_permitted',false);
end $$;

create function clued_private.storage_conflict_abandon_v1(p_owner uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q clued_private.storage_conflict_isolations_v1; m clued_private.resource_center_mutations_v1;
 j clued_private.storage_jobs_v1; r public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
 cloud boolean; evidence jsonb:=p_input->'termination_evidence'; terminated timestamptz; observed timestamptz;
begin
 if p_input-array['action','connection_id','job_id','intent_id','base_version','source_receipt_id','observation_id','idempotency_key','confirmed','termination_evidence']<>'{}'
  or p_input->>'action'<>'conflict_abandon' or p_input->'confirmed' is distinct from 'true'::jsonb
  or coalesce(length(p_input->>'idempotency_key'),0) not between 1 and 160 then
   raise exception 'storage_conflict_review_invalid' using errcode='22023'; end if;
 if p_input ? 'intent_id' then
  select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=(p_input->>'intent_id')::uuid and user_id=p_owner;
  if q.job_id is not null then raise exception 'storage_conflict_review_invalid' using errcode='22023'; end if;
 else
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid;
  if j.job_id is null then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('storage-job:'||p_owner::text||':'||j.job_id::text,0));
  select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=p_owner;
 end if;
 if q.intent_id is null then raise exception 'storage_conflict_review_unavailable' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':'||q.root_folder_id,0));
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=q.intent_id for update;
 select * into m from clued_private.resource_center_mutations_v1 where id=q.intent_id and user_id=p_owner for update;
 if q.state='resolved' then
  if exists(select 1 from public.clued_audit_receipts x where x.id=q.resolution_receipt_id and x.user_id=p_owner
    and x.operation='storage_conflict_abandon' and x.idempotency_key=p_input->>'idempotency_key') then
   return jsonb_build_object('status','resolved','resolution','abandoned_registration','job_id',q.job_id,
    'connection_id',q.connection_id,'receipt_id',q.resolution_receipt_id,'source_receipt_id',q.close_receipt_id,
    'base_version',m.final_result->'review_base_version','observation_id',m.final_result->'review_observation_id','execution_permitted',false); end if;
  raise exception 'storage_conflict_review_conflict' using errcode='40001';
 end if;
 if m.state<>'conflict' or m.version::text is distinct from p_input->>'base_version'
  or q.close_receipt_id::text is distinct from p_input->>'source_receipt_id' then
  raise exception 'storage_conflict_review_conflict' using errcode='40001'; end if;
 cloud:=j.cloud_writer_binding_id is not null and m.writer_binding_id is not distinct from j.cloud_writer_binding_id;
 if not cloud then
  if not exists(select 1 from clued_private.resource_center_writer_bindings_v1 w where w.id=m.writer_binding_id and w.revoked_at is not null)
   or jsonb_typeof(evidence) is distinct from 'object' or evidence-array['executor_terminated','local_effect_settled_after_termination',
    'provider_observed_after_termination','terminated_at','observed_at']<>'{}'
   or evidence->'executor_terminated' is distinct from 'true'::jsonb
   or evidence->'local_effect_settled_after_termination' is distinct from 'true'::jsonb
   or evidence->'provider_observed_after_termination' is distinct from 'true'::jsonb then
   raise exception 'storage_conflict_termination_evidence_required' using errcode='42501'; end if;
  terminated:=(evidence->>'terminated_at')::timestamptz; observed:=(evidence->>'observed_at')::timestamptz;
  if terminated is null or observed is null or terminated>=observed or observed>clock_timestamp() then
   raise exception 'storage_conflict_termination_evidence_required' using errcode='42501'; end if;
 elsif evidence is not null then raise exception 'storage_conflict_review_invalid' using errcode='22023'; end if;
 if p_input->>'observation_id' is not null and not exists(select 1 from clued_private.storage_conflict_observations_v1 o
   where o.id=(p_input->>'observation_id')::uuid and o.intent_id=m.id and o.user_id=p_owner and o.base_version=m.version and o.source_receipt_id=q.close_receipt_id) then
  raise exception 'storage_conflict_review_conflict' using errcode='40001'; end if;
 req:=p_input||jsonb_build_object('intent_id',m.id,'isolation_receipt_id',q.close_receipt_id,'owner_session_id',auth.jwt()->>'session_id');
 r:=clued_private.m1_begin_receipt(p_owner,null,'storage_conflict_abandon',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_conflict_review_conflict' using errcode='40001'; end if;
 insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
 -- This only withdraws registration. It never deletes, trashes, renames or
 -- replaces any provider object and never grants a writer or credential.
 update clued_private.resource_center_artifacts_v1 a set state='revoked',version=version+1,updated_at=clock_timestamp(),receipt_id=r.id
  where a.user_id=p_owner and a.profile_id=q.profile_id and a.state='active'
   and (a.path=any(q.paths) or a.provider_file_id=any(q.object_ids));
 update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 update clued_private.resource_center_mutations_v1 set version=version+1,updated_at=clock_timestamp(),
  final_result=final_result||jsonb_build_object('review_outcome','abandoned_registration','review_receipt_id',r.id,
   'review_base_version',m.version,'review_observation_id',p_input->'observation_id') where id=m.id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 ev:=clued_private.m1_append_event_row(p_owner,null,r.id,r.canonical_version,'extension:storage:conflict_registration_abandoned',
  refs,'project:'||(select project_id::text from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=p_owner),
  null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(m.id::text,m.version),
  jsonb_build_object(m.id::text,m.version+1),array[ev],'{}'::uuid[],null);
 return jsonb_build_object('status','resolved','resolution','abandoned_registration','job_id',q.job_id,'intent_id',m.id,
  'connection_id',q.connection_id,'receipt_id',r.id,'source_receipt_id',q.close_receipt_id,'base_version',m.version,
  'observation_id',p_input->'observation_id','execution_permitted',false);
end $$;

do $clone$ declare body text; begin
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_scheduled_recovery_v2(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.ii_pub_clued_storage_scheduled_recovery_v2(',
  'FUNCTION clued_private.storage_scheduled_before_conflict_v1(');
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_native_recovery_v1(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.ii_pub_clued_storage_native_recovery_v1(',
  'FUNCTION clued_private.storage_native_before_conflict_v1(');
 body:=pg_get_functiondef('public.clued_storage_native_recovery_load_v2(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION public.clued_storage_native_recovery_load_v2(',
  'FUNCTION clued_private.storage_native_load_before_conflict_v1(');
end $clone$;

create or replace function public.clued_storage_native_recovery_load_v2(p_issuer_secret text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); identity text;
begin
 if exists(select 1 from clued_private.storage_conflict_isolations_v1 q where q.user_id=u and q.connection_id=(p_input->>'connection_id')::uuid
  and q.job_id=(p_input->>'job_id')::uuid and q.state='active') then
  if p_input is distinct from jsonb_build_object('action','recovery_load','connection_id',p_input->>'connection_id','job_id',p_input->>'job_id') then
   raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  identity:=clued_private.issuer_resolve_identity_compatible_v1(encode(sha256(convert_to(p_issuer_secret,'UTF8')),'hex'),'storage','storage_recovery_denied');
  return clued_private.storage_conflict_load_v1(identity,p_input);
 end if;
 return clued_private.storage_native_load_before_conflict_v1(p_issuer_secret,p_input);
end $$;

create or replace function clued_private.ii_pub_clued_storage_scheduled_recovery_v2(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; jobs jsonb; cand record; n integer:=0;
begin
 if p_input->>'action'='report' then return clued_private.storage_recovery_report_v1(p_issuer_identity,p_input); end if;
 if p_input->>'action'='review_observe' then return clued_private.storage_conflict_observe_v1(p_issuer_identity,p_input); end if;
 if p_input->>'action'='review_revalidate' then return clued_private.storage_conflict_revalidate_v1(p_issuer_identity,p_input); end if;
 if p_input->>'action'='load' and exists(select 1 from clued_private.storage_conflict_isolations_v1
   where connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid and state='active') then
  if p_input is distinct from jsonb_build_object('action','load','connection_id',p_input->>'connection_id','job_id',p_input->>'job_id') then
   raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  return clued_private.storage_conflict_load_v1(p_issuer_identity,p_input);
 end if;
 result:=clued_private.storage_scheduled_before_conflict_v1(p_issuer_identity,p_input);
 if p_input->>'action'='due' then
  jobs:=result->'jobs';
  -- Share the bounded listing fairly. Each selected conflict advances its own
  -- due time; a permanently unchanged target cannot monopolise all next scans.
  for cand in select q.intent_id,q.connection_id,q.job_id,q.attempts from clued_private.storage_conflict_isolations_v1 q
   join clued_private.storage_oauth_apps_v1 a on a.issuer_hash=p_issuer_identity and a.oauth_client_id=q.oauth_client_id and a.revoked_at is null
   where q.state='active' and q.job_id is not null and q.scope_complete and q.next_recovery_at<=clock_timestamp()
   order by q.next_recovery_at,q.closed_at,q.intent_id limit 3 for update of q skip locked loop
   exit when n>=2;
   jobs:=jsonb_build_array(jsonb_build_object('connection_id',cand.connection_id,'job_id',cand.job_id))||jobs;
   update clued_private.storage_conflict_isolations_v1 set attempts=attempts+1,
    next_recovery_at=clock_timestamp()+least(interval '10 minutes',interval '1 minute'*power(2,least(attempts+1,4)))+random()*interval '30 seconds'
    where intent_id=cand.intent_id;
   n:=n+1;
  end loop;
  select coalesce(jsonb_agg(x),'[]') into jobs from (select x from jsonb_array_elements(jobs) x limit 3) s;
  return result||jsonb_build_object('jobs',jobs);
 end if;
 return result;
end $$;

create function clued_private.storage_conflict_public_status_v1(j clued_private.storage_jobs_v1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb:=clued_private.storage_job_status_v1(j); q clued_private.storage_conflict_isolations_v1;
 m clued_private.resource_center_mutations_v1; diagnostic jsonb; available boolean; abandon boolean; target_name text;
begin
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id;
 if q.state='resolved' and m.final_result->>'review_outcome' in ('accepted_current_state','abandoned_registration') then
  return result||jsonb_build_object('status','resolved','resolution',m.final_result->>'review_outcome','receipt_id',q.resolution_receipt_id,
   'source_receipt_id',q.close_receipt_id,'base_version',m.final_result->'review_base_version','observation_id',m.final_result->'review_observation_id',
   'review_available',false,'abandon_available',false,'execution_permitted',false);
 end if;
 available:=coalesce(q.state='active' and q.scope_complete and cardinality(q.object_ids)=1 and m.exact_request->'mutation'->>'target_kind'='file'
  and j.cloud_writer_binding_id is not null and j.cloud_writer_binding_id is not distinct from m.writer_binding_id,false);
 -- Withdrawal needs no new provider read. I9 already ended this exact cloud
 -- admission; incomplete identity must not create an isolation with no Owner
 -- exit. Fresh Owner confirmation and exact receipt/version remain mandatory.
 abandon:=coalesce(q.state='active' and m.state='conflict' and q.job_id=j.job_id and q.connection_id=j.connection_id
  and j.authority_snapshot_v2 is not null and j.cloud_writer_binding_id is not null
  and j.cloud_writer_binding_id=m.writer_binding_id and m.version>=q.closed_version,false);
 result:=result||jsonb_build_object('review_available',available,'abandon_available',abandon);
 if available or abandon then
  result:=result||jsonb_build_object('base_version',m.version,'source_receipt_id',q.close_receipt_id);
  target_name:=regexp_replace(q.paths[1],'^.*/','');
  if length(target_name) between 1 and 255 and target_name!~'[/\\[:cntrl:]]' then
   result:=result||jsonb_build_object('file_name',target_name); end if;
 end if;
 if not available and q.state='active' then
  result:=result||jsonb_build_object('review_unavailable_reason','DIRECTORY_REVIEW_UNSUPPORTED'); end if;
 if m.state in ('started','uncertain','conflict') and coalesce(q.state,'active')='active' then
  select d.diagnostic into diagnostic from clued_private.storage_recovery_diagnostics_v1 d where d.user_id=j.owner_id and d.job_id=j.job_id;
  if diagnostic is not null then result:=result||jsonb_build_object('diagnostic',diagnostic); end if;
 end if;return result;
end $$;

create or replace function clued_private.ii_pub_clued_storage_native_recovery_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid; c clued_private.storage_connections_v1; jobs jsonb; result jsonb;
begin
 if p_input->>'action' in ('recovery_list','review_abandon','review_accept') then
  u:=clued_private.storage_owner_v1();
  if p_input->>'action'='recovery_list' and p_input is distinct from jsonb_build_object('action','recovery_list','connection_id',p_input->>'connection_id') then
   raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
  if c.id is null or not exists(select 1 from clued_private.storage_oauth_apps_v1 a where a.issuer_hash=p_issuer_identity
    and a.revoked_at is null and a.oauth_client_id=c.oauth_client_id) then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  if p_input->>'action'='review_accept' then return clued_private.storage_conflict_accept_v1(u,p_input); end if;
  if p_input->>'action'='review_abandon' then
   return clued_private.storage_conflict_abandon_v1(u,(p_input-'action')||jsonb_build_object('action','conflict_abandon',
    'idempotency_key','storage-review-abandon:'||clued_private.m1_sha256(p_input)));
  end if;
  select coalesce(jsonb_agg(row.result order by row.resolved,row.active_at,row.history_at desc,row.job_id),'[]') into jobs from (
   select j.job_id,coalesce(q.state='resolved',false) resolved,
    case when q.state is distinct from 'resolved' then m.updated_at end active_at,
    case when q.state='resolved' then m.updated_at end history_at,clued_private.storage_conflict_public_status_v1(j) result
   from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id and m.user_id=u
   left join clued_private.storage_recovery_diagnostics_v1 d on d.user_id=u and d.job_id=j.job_id
   left join clued_private.storage_conflict_isolations_v1 q on q.intent_id=m.id
   where j.owner_id=u and j.connection_id=c.id and m.state in ('started','uncertain','conflict')
   order by coalesce(q.state='resolved',false),
    case when q.state is distinct from 'resolved' then m.updated_at end,
    case when q.state='resolved' then m.updated_at end desc,j.job_id limit 20) row;
  return jsonb_build_object('status','ok','connection_id',c.id,'jobs',jobs,'execution_permitted',false);
 end if;
 result:=clued_private.storage_native_before_conflict_v1(p_issuer_identity,p_input);
 if p_input->>'action'='recovery_inspect' then
  select clued_private.storage_conflict_public_status_v1(j) into result from clued_private.storage_jobs_v1 j
   where j.owner_id=clued_private.storage_owner_v1() and j.connection_id=(p_input->>'connection_id')::uuid and j.job_id=(p_input->>'job_id')::uuid;
 end if;
 return result;
end $$;

-- Preserve the complete current verifier (including replace revisions,
-- destructive operations, ancestor identity and issuer lineage). Only the
-- conflict clone accepts the new terminal receipt and its one version step.
create function clued_private.storage_conflict_proof_version_v1(p_intent uuid,p_saved bigint) returns bigint
language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from clued_private.storage_conflict_isolations_v1 q
  where q.intent_id=p_intent and q.original_version=p_saved and q.closed_version=p_saved+1) then p_saved+1 else p_saved end
$$;
do $verified$ declare body text; original text; patch record; hits integer; begin
 original:=pg_get_functiondef('clued_private.ii_priv_storage_verified_result_v2(text,jsonb)'::regprocedure);
 execute replace(original,'FUNCTION clued_private.ii_priv_storage_verified_result_v2(',
  'FUNCTION clued_private.storage_verified_before_conflict_v1(');
 body:=replace(original,'FUNCTION clued_private.ii_priv_storage_verified_result_v2(',
  'FUNCTION clued_private.storage_conflict_verified_v1(');
 for patch in select * from (values
 ($a$declare op text:=p_input->>'action';$a$,
  $r$declare q clued_private.storage_conflict_isolations_v1; op text:=p_input->>'action';$r$,1),
 ($a$  saved:=m.verified_result_v2;$a$,
  $r$  select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=m.id and user_id=c.owner_id for update;
  if q.intent_id is null or q.job_id is distinct from j.job_id or q.connection_id is distinct from c.id or not q.scope_complete
   or q.provider is distinct from c.provider or q.provider_subject is distinct from c.provider_subject or q.oauth_client_id is distinct from c.oauth_client_id
   or q.root_folder_id is distinct from p.root_folder_id or q.closed_version<>q.original_version+1
   or not exists(select 1 from public.clued_audit_receipts x where x.id=q.close_receipt_id and x.user_id=c.owner_id
    and x.operation='storage_conflict_settle' and x.status='committed'
    and x.committed_versions=jsonb_build_object(m.id::text,q.closed_version)
    and x.canonical_result=clued_private.m1_result_envelope(x) and x.response_hash=clued_private.m1_sha256(x.canonical_result))
   or not ((q.state='active' and m.state='conflict' and m.version=q.closed_version and m.receipt_id=q.close_receipt_id)
    or (q.state='resolved' and m.state='committed' and m.receipt_id=q.resolution_receipt_id)) then
   raise exception 'storage_verified_conflict' using errcode='40001'; end if;
  saved:=m.verified_result_v2;$r$,1),
 ($a$    select * into audit from public.clued_audit_receipts where id=m.receipt_id and user_id=c.owner_id
      and operation='resource_center_journal' and status='committed';$a$,
  $r$    select * into audit from public.clued_audit_receipts where id=q.close_receipt_id and user_id=c.owner_id
      and operation='storage_conflict_settle' and status='committed';$r$,1),
 ($a$m.state not in ('started','uncertain')$a$,$r$m.state not in ('started','uncertain','conflict')$r$,2),
 ($a$(saved->>'intent_version')::bigint$a$,$r$clued_private.storage_conflict_proof_version_v1(m.id,(saved->>'intent_version')::bigint)$r$,5),
 ($a$  registered:=public.clued_resource_center_admin_v1(c.owner_id,registration_input);$a$,
  $r$  insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
  registered:=public.clued_resource_center_admin_v1(c.owner_id,registration_input);$r$,1),
 ($a$  return result||jsonb_build_object('state','committed'$a$,
  $r$  update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
  return result||jsonb_build_object('state','committed'$r$,1)
 ) v(anchor,replacement,expected) loop
  hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
  if hits<>patch.expected then raise exception 'storage_conflict_verified_source_mismatch: % %',left(patch.anchor,70),hits; end if;
  body:=replace(body,patch.anchor,patch.replacement);
 end loop;
 execute body;
end $verified$;
create or replace function clued_private.ii_priv_storage_verified_result_v2(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from clued_private.storage_conflict_isolations_v1 q where q.connection_id=(p_input->>'connection_id')::uuid
  and q.job_id=(p_input->>'job_id')::uuid) then
  return clued_private.storage_conflict_verified_v1(p_issuer_identity,p_input);
 end if;
 return clued_private.storage_verified_before_conflict_v1(p_issuer_identity,p_input);
end $$;

-- A conflict keeps the original exact-job refresh delegation and limits.
-- Neither issuer execution switches, policy authority, refresh grants, nor
-- credential TTL checks are relaxed. Only the journal state admission changes.
do $refresh$ declare body text; patch record; begin
 body:=pg_get_functiondef('clued_private.storage_account_recovery_refresh_v1(uuid,uuid,uuid,uuid,boolean,uuid,uuid,text)'::regprocedure);
 for patch in select * from (values
  ($a$  digest:=clued_private.m1_sha256(jsonb_build_object('request_sha256',m.request_sha256,'provider_attempt',m.provider_attempt));$a$,
   $r$  if m.state='conflict' and (exists(select 1 from clued_private.storage_client_denies_v2 d
    where d.owner_id=p_owner and d.lineage_id=(j.authority_snapshot_v2->>'registration_lineage')::uuid and d.denied)
    or exists(select 1 from clued_private.storage_root_denies_v2 d where d.owner_id=p_owner and d.provider=c.provider
     and d.provider_subject=c.provider_subject and d.root_folder_id=p.root_folder_id
     and d.lineage_id=(j.authority_snapshot_v2->>'registration_lineage')::uuid and d.denied)) then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  digest:=clued_private.m1_sha256(jsonb_build_object('request_sha256',m.request_sha256,'provider_attempt',m.provider_attempt));$r$),
  ($a$m.state not in ('started','uncertain')$a$,$r$(m.state not in ('started','uncertain') and not(m.state='conflict' and exists(
   select 1 from clued_private.storage_conflict_isolations_v1 q where q.intent_id=m.id and q.user_id=p_owner
    and q.job_id=p_job and q.connection_id=p_connection and q.state='active' and q.closed_version=m.version)))$r$),
  ($a$m.state not in ('started','uncertain','committed','cancelled')$a$,$r$(m.state not in ('started','uncertain','committed','cancelled') and not(m.state='conflict' and exists(
   select 1 from clued_private.storage_conflict_isolations_v1 q where q.intent_id=m.id and q.user_id=p_owner
    and q.job_id=p_job and q.connection_id=p_connection and q.state='active' and q.closed_version=m.version)))$r$)
 ) v(anchor,replacement) loop
  if (length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor)<>1 then raise exception 'storage_conflict_refresh_source_mismatch'; end if;
  body:=replace(body,patch.anchor,patch.replacement);
 end loop; execute body;
end $refresh$;

-- A conflict has ended effect dispatch; immutable descriptors and the review
-- receipt retain recovery truth without retaining consumed upload staging.
do $staging$ declare signature text; body text; anchor text:=$a$m.state in ('committed','cancelled')$a$; begin
 foreach signature in array array[
  'clued_private.storage_staging_deletable_v1(clued_private.storage_staging_v1)',
  'clued_private.storage_staging_purgeable_v1(clued_private.storage_staging_v1)'] loop
  body:=pg_get_functiondef(signature::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_conflict_staging_source_mismatch'; end if;
  execute replace(body,anchor,$r$m.state in ('committed','cancelled','conflict')$r$);
 end loop;
end $staging$;

-- Schema-only fixtures need no pg_cron, but the configured production
-- publisher MUST call this guard after executing the migration and before
-- inserting its ledger entry in the SAME transaction. A missing/inactive or
-- changed scheduler then rolls back both DDL and ledger. Sweep repeats the
-- check; merely loading schema never asserts an automatic service is active.
create function clued_private.storage_conflict_require_scheduler_v1() returns void
language plpgsql security definer set search_path='' as $$
declare scheduler_ready boolean;
begin
 if to_regprocedure('cron.schedule(text,text,text)') is null then raise exception 'storage_conflict_scheduler_required'; end if;
 execute $query$select exists(select 1 from cron.job where jobname='clued-storage-i9-conflict' and active
  and schedule='* * * * *' and command='select clued_private.storage_conflict_sweep_v1()'
  and database=current_database() and username=pg_get_userbyid(
   (select proowner from pg_proc where oid='clued_private.storage_conflict_sweep_v1()'::regprocedure)))$query$
  into scheduler_ready;
 if scheduler_ready is distinct from true then
  raise exception 'storage_conflict_scheduler_unconfirmed'; end if;
end $$;
do $schedule$ begin
 if to_regprocedure('cron.schedule(text,text,text)') is not null then
  perform cron.schedule('clued-storage-i9-conflict','* * * * *','select clued_private.storage_conflict_sweep_v1()');
  perform clued_private.storage_conflict_require_scheduler_v1();
 end if;
end $schedule$;
do $acl$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_private' and (p.proname like 'storage_conflict_%' or p.proname in
   ('storage_recovery_report_v1','storage_scheduled_before_conflict_v1','storage_native_before_conflict_v1','storage_native_load_before_conflict_v1','storage_verified_before_conflict_v1',
    'ii_pub_clued_storage_scheduled_recovery_v2','ii_pub_clued_storage_native_recovery_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,clued_worker_gateway',f.sig);
 end loop;
end $acl$;
notify pgrst,'reload schema';
