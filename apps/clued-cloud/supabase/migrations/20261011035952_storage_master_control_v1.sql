-- Native Owner three-state master control. Existing connections are not
-- re-consented or changed by installation. The state is derived from live
-- grant/policy/read access; the only new persisted flag is a deny gate.
-- Qualify the exact predecessor definitions before any DDL. A source drift
-- outside an insertion anchor must fail as well; caller ACLs stay unchanged.
do $qualified$
declare q record;
begin
  for q in select * from (values
    ('public.clued_storage_owner_manage_v2(jsonb)','1188986d05c2e876da4f0a1e87eeba949e87a0ab4778b863e8d1836d793572fd',true),
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)','bbff4a33c0b7a01dba02da11efc77015555bc8c6405d611cbce6b5dc265b05c8',false),
    ('clued_private.storage_read_evaluate_v1(text,uuid,text)','ac5a5d0387d42836091126669940760adc217472a011fac83898f71367bbad1e',false),
    ('clued_private.storage_job_history_v2(text,uuid,uuid,text)','cd75c18af16b44fa1555fc25cce66bdf31283e564e150fe795b405ad74b33b7b',false),
    ('clued_private.storage_binding_v1(text,uuid,text)','135d06d1850bdc8ffb05be443e6a7b8fd90cc869e8dcf2bf0ef888ea475e1a70',false),
    ('clued_private.storage_binary_gate_v1(uuid)','91521c6867c4ccbeaa634e0dfe376a1a714f43c49cc6052ac7367a38161dfdbc',false),
    ('public.clued_storage_read_access_v1(jsonb)','783e0c5c8954adf61c8eb94c02ee123f646109e91f93400280caa103f51d1814',true),
    ('public.clued_storage_write_access_v1(jsonb)','a6901ea4b05a23d923a3cc0efb6f8022bbd843342602d254594dca78d8bb0973',true),
    ('public.clued_storage_normal_use_v1(jsonb)','7fe3d0074a67a9dec67375f57012f6e64fd97effac04dbf5ad70f602a216a37b',true),
    ('public.clued_storage_onboard_v1(text,jsonb)','13d477b7963b9d1c1de90804d99aabd95985bcb8c36585a17879da12a22e4ced',true),
    ('clued_private.storage_onboard_view_v1(clued_private.storage_onboard_attempts_v1)','0663e26209554fdb5771c12a125112283cdc17b39159a9b3e9406819755898bd',false),
    ('clued_private.ii_priv_storage_onboard_oauth_v1(text,jsonb)','378bd4aacdf730f1edbb303cc0cc0bdc424c20bcc3bd12733a80f17e614a07d5',false),
    ('clued_private.storage_onboard_activate_v1(uuid,clued_private.storage_onboard_attempts_v1,clued_private.storage_oauth_apps_v1,jsonb)','3701f4c58ef06c2d9ccaf308dc3ec36e9282a0dca28d933c499035fdd369107f',false),
    ('clued_private.ii_pub_clued_storage_oauth_v1(text,jsonb)','a83cc44d3975e9c39b4893aeff73cf21c6c109bed1832c05996ad3a16ff6ac21',false),
    ('public.clued_storage_owner_lifecycle_v1(text,jsonb)','a6eb23ee9c69dae6e1f0ac709587f2b46f675478a326b30f2b3a909bf8170017',true)
  ) v(sig,source_hash,native) loop
    if not exists(select 1 from pg_proc p where p.oid=q.sig::regprocedure
      and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig=array['search_path=""']
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=q.source_hash
      and p.proacl::text=case when q.native then '{postgres=X/postgres,authenticated=X/postgres}' else '{postgres=X/postgres}' end)
    then raise exception 'storage_master_upgrade_unqualified' using errcode='42501'; end if;
  end loop;
end $qualified$;

create table clued_private.storage_master_controls_v1 (
  connection_id uuid primary key references clued_private.storage_connections_v1(id),
  owner_id uuid not null references auth.users(id),
  enabled boolean not null,
  allow_base_create boolean not null,
  generation bigint not null check(generation>0),
  receipt_id uuid not null references public.clued_audit_receipts(id)
);
alter table clued_private.storage_master_controls_v1 enable row level security;
revoke all on clued_private.storage_master_controls_v1 from public,anon,authenticated,service_role;

create function clued_private.storage_master_rows_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'storage_master_history_immutable' using errcode='42501'; end if;
  if not exists(select 1 from clued_private.storage_connections_v1 c where c.id=new.connection_id and c.owner_id=new.owner_id)
    or (tg_op='INSERT' and new.generation<>1)
    or (tg_op='UPDATE' and (new.connection_id<>old.connection_id or new.owner_id<>old.owner_id
      or new.generation<>old.generation+1 or new.receipt_id=old.receipt_id)) then
    raise exception 'storage_master_version_conflict' using errcode='40001'; end if;
  return new;
end $$;
create trigger storage_master_rows_guard_v1 before insert or update or delete on clued_private.storage_master_controls_v1
  for each row execute function clued_private.storage_master_rows_guard_v1();

create function clued_private.storage_master_agent_enabled_v1(p_owner uuid,p_connection uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.storage_connections_v1 c
    where c.id=p_connection and c.owner_id=p_owner and not exists(
      select 1 from clued_private.storage_master_controls_v1 m
      where m.connection_id=c.id and m.owner_id=c.owner_id and not m.enabled))
$$;

create function clued_private.storage_master_action_enabled_v1(p_owner uuid,p_connection uuid,p_action text) returns boolean
language sql stable security definer set search_path='' as $$
  select clued_private.storage_master_agent_enabled_v1(p_owner,p_connection) and not exists(
    select 1 from clued_private.storage_master_controls_v1 m where m.owner_id=p_owner and m.connection_id=p_connection
      and p_action in ('create_file','create_topic') and not m.allow_base_create)
$$;

-- All callers hold the existing owner/root advisory lock before this helper.
-- No credential bytes or client-restricted grants are returned to the browser.
create function clued_private.storage_master_snapshot_v1(p_owner uuid,p_connection uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; ra clued_private.storage_read_access_v1;
  gate clued_private.storage_master_controls_v1; app clued_private.storage_oauth_apps_v1;
  ready boolean; effective boolean; reading boolean; content boolean; normal boolean;
  stopped boolean; snapshot jsonb; classes text[]; writes text[];
begin
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=p_owner for share;
  if not found then raise exception 'storage_owner_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner for share;
  select * into policy from clued_private.storage_account_policies_v2 where id=c.account_policy_id and owner_id=p_owner and connection_id=c.id for share;
  select * into ra from clued_private.storage_read_access_v1 where connection_id=c.id and owner_id=p_owner and state='active' for share;
  select * into gate from clued_private.storage_master_controls_v1 where connection_id=c.id and owner_id=p_owner for share;
  select * into app from clued_private.storage_oauth_apps_v1 where oauth_client_id=c.oauth_client_id and revoked_at is null;
  perform 1 from public.clued_memories d where d.user_id=p_owner and (d.id in(c.source_decision_id,p.source_decision_id,policy.source_decision_id)
    or d.id::text=p.cloud_runtime->>'source_decision_id') order by d.id for share;
  stopped:=exists(select 1 from clued_private.storage_root_denies_v2 d where d.owner_id=p_owner and d.provider=c.provider
    and d.provider_subject=c.provider_subject and d.root_folder_id=p.root_folder_id and d.lineage_id is null and d.denied);
  ready:=coalesce(c.state='active' and c.revoked_at is null and c.auth_mode='account_policy'
    and p.state='active' and p.version=c.profile_version and policy.state='active'
    and p.cloud_runtime->>'contract'='clued.storage-cloud-runtime/1'
    and p.cloud_runtime->>'profile_version'=p.version::text
    and exists(select 1 from public.clued_memories d where d.user_id=p_owner and d.id::text=p.cloud_runtime->>'source_decision_id'
      and d.version::text=p.cloud_runtime->>'decision_version' and clued_private.resource_center_decision_current_v1(p_owner,p.project_id,d.id))
    and policy.profile_id=p.id and policy.provider=c.provider and policy.provider_subject=c.provider_subject
    and policy.root_folder_id=p.root_folder_id and not coalesce(policy.expires_at<=clock_timestamp(),false)
    and policy.scope_digest=clued_private.storage_policy_scope_digest_v3(c.id,policy.scope_contract,policy.actions)
    and app.issuer_hash is not null and (select count(*) from clued_private.storage_oauth_apps_v1
      where oauth_client_id=c.oauth_client_id and revoked_at is null)=1
    and clued_private.resource_center_decision_current_v1(p_owner,p.project_id,c.source_decision_id)
    and clued_private.resource_center_decision_current_v1(p_owner,p.project_id,p.source_decision_id)
    and clued_private.resource_center_decision_current_v1(p_owner,p.project_id,policy.source_decision_id)
    and exists(select 1 from public.clued_memories d where d.id=c.source_decision_id and d.user_id=p_owner and d.version=c.decision_version)
    and exists(select 1 from public.clued_memories d where d.id=policy.source_decision_id and d.user_id=p_owner and d.version=policy.decision_version)
    and not exists(select 1 from unnest(array[c.receipt_id,policy.consent_receipt_id,policy.activation_receipt_id]) id
      where not exists(select 1 from public.clued_audit_receipts r where r.id=id and r.user_id=p_owner and r.status='committed'))
    and not exists(select 1 from clued_private.storage_owner_lifecycle_v1 l where l.owner_id=p_owner
      and l.root_folder_id=p.root_folder_id and l.state in ('prepared','started','uncertain')),false);
  effective:=ready and not stopped and coalesce(gate.enabled,true)
    and (gate.connection_id is null or exists(select 1 from public.clued_audit_receipts r where r.id=gate.receipt_id and r.user_id=p_owner and r.status='committed'));
  classes:=case when ra.state='active' and ra.account_policy_id=policy.id
    and exists(select 1 from public.clued_audit_receipts r where r.id=ra.consent_receipt_id and r.user_id=p_owner and r.status='committed')
    then ra.classes else '{}'::text[] end;
  writes:=array(select x from unnest(array['modify','overwrite','destructive','modify_subtree']) x where x=any(policy.actions));
  reading:=effective and app.read_enabled and 'read'=any(classes);
  content:=effective and app.read_enabled and 'read_content'=any(classes);
  normal:=reading and content and ra.content_profile='normal/1' and clued_private.storage_scope_covers_v1(c.provider_scope_profile,'normal');
  snapshot:=jsonb_build_object('contract','clued.storage-master-control/1','connection_id',c.id,
    'master_generation',coalesce(gate.generation,0),'disclosure_version','clued.storage-master-disclosure/1',
    'provider_scope_profile',c.provider_scope_profile,'reconsent_required',c.provider_scope_profile is distinct from 'full',
    'agent_enabled',effective,'create_enabled',effective and app.execution_enabled and coalesce(gate.allow_base_create,true),
    'read_classes',to_jsonb(classes),'write_classes',to_jsonb(writes),
    'read_content',content,'normal_use',normal,'read_enabled',reading,'write_enabled',effective and app.execution_enabled,
    'state',case when not coalesce(gate.enabled,true) or stopped or c.revoked_at is not null then 'off'
      when effective and coalesce(gate.allow_base_create,true) and app.execution_enabled and normal and c.provider_scope_profile='full'
        and writes=array['modify','overwrite','destructive','modify_subtree']::text[] then 'on' else 'partial' end,
    'connection_version',c.version,'auth_generation',c.auth_generation,'policy_id',policy.id,
    'policy_generation',coalesce(policy.policy_generation,0),'read_generation',coalesce(ra.read_generation,0),
    'profile_version',p.version,'root_stopped',stopped,'gate_enabled',coalesce(gate.enabled,true),
    'allow_base_create',coalesce(gate.allow_base_create,true),
    'policy_current',ready,'read_access_id',ra.id);
  return snapshot||jsonb_build_object('status_digest',clued_private.m1_sha256(snapshot));
end $$;

-- Same transaction as its caller's immutable Receipt; never called by an API
-- role. The Owner's precise root/decision/governance policy remains intact.
create function clued_private.storage_master_apply_v1(p_owner uuid,p_connection uuid,p_enable boolean,
  p_r public.clued_audit_receipts,p_source text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; fresh clued_private.storage_account_policies_v2;
  ra clued_private.storage_read_access_v1; gate clued_private.storage_master_controls_v1;
  queued clued_private.storage_jobs_v1; qr public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
  actions text[]:=case when p_enable then array['inspect','create_file','create_topic','modify','overwrite','destructive','modify_subtree']
    else array['inspect','create_file','create_topic'] end;
  digest text; result jsonb; cancelled jsonb:='[]'::jsonb;
begin
  if p_r.user_id is distinct from p_owner or p_r.status<>'pending' or p_enable is null
    or p_source not in ('owner','oauth','onboard','reconnect') then raise exception 'storage_master_denied' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=p_owner for update;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner for share;
  select * into policy from clued_private.storage_account_policies_v2 where id=c.account_policy_id and connection_id=c.id and owner_id=p_owner for update;
  select * into ra from clued_private.storage_read_access_v1 where connection_id=c.id and owner_id=p_owner and state='active' for update;
  select * into gate from clued_private.storage_master_controls_v1 where connection_id=c.id and owner_id=p_owner for update;
  if c.id is null or c.auth_mode<>'account_policy' or c.state<>'active' or c.revoked_at is not null
    or policy.id is null or policy.state<>'active' or p.state<>'active' or p.version<>c.profile_version
    or policy.scope_digest is distinct from clued_private.storage_policy_scope_digest_v3(c.id,policy.scope_contract,policy.actions)
    or coalesce(policy.expires_at<=clock_timestamp(),false) then raise exception 'storage_master_scope_changed' using errcode='42501'; end if;
  perform clued_private.storage_connection_current_v1(c.id,p_owner);
  perform clued_private.storage_root_quiet_v1(p_owner,p.root_folder_id);
  if exists(select 1 from clued_private.storage_jobs_v1 j left join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id
    where j.owner_id=p_owner and j.connection_id=c.id and j.intent_id is not null and m.id is null) then
    raise exception 'storage_root_has_unresolved_mutation' using errcode='42501'; end if;
  if exists(select 1 from clued_private.storage_owner_lifecycle_v1 l where l.owner_id=p_owner
      and l.root_folder_id=p.root_folder_id and l.state in ('prepared','started','uncertain')) then
    raise exception 'storage_owner_lifecycle_pending' using errcode='42501'; end if;
  if p_enable and (c.provider_scope_profile<>'full' or exists(select 1 from clued_private.storage_root_denies_v2 d
      where d.owner_id=p_owner and d.provider=c.provider and d.provider_subject=c.provider_subject
        and d.root_folder_id=p.root_folder_id and d.lineage_id is null and d.denied)) then
    raise exception 'storage_master_reconsent_required' using errcode='42501'; end if;
  -- Only queued, never-started jobs can be cancelled. In-flight/unknown effects
  -- remain fenced by storage_root_quiet_v1 and are not overwritten as success.
  for queued in select * from clued_private.storage_jobs_v1 j where j.owner_id=p_owner and j.connection_id=c.id
    and j.intent_id is null and j.dispatch_outcome is null order by j.job_id for update loop
    req:=jsonb_build_object('idempotency_key','cloud-dispatch-outcome:'||queued.job_id,'job_id',queued.job_id,'outcome',jsonb_build_object('status','denied'));
    qr:=clued_private.m1_begin_receipt(p_owner,null,'storage_dispatch_outcome',req,clued_private.m1_sha256(req));
    if qr.status<>'pending' then raise exception 'storage_master_version_conflict' using errcode='40001'; end if;
    update clued_private.storage_jobs_v1 set dispatch_outcome=req->'outcome',dispatch_outcome_receipt_id=qr.id where owner_id=p_owner and job_id=queued.job_id;
    perform clued_private.storage_onboard_finish_v1(p_owner,qr,p.project_id,'extension:storage:dispatch_outcome',queued.job_id,req,'{}'::jsonb,'{}'::jsonb);
    cancelled:=cancelled||to_jsonb(queued.job_id);
  end loop;
    digest:=clued_private.storage_policy_scope_digest_v3(c.id,'clued.storage-account-scope/3',actions);
    if digest is null then raise exception 'storage_master_scope_changed' using errcode='42501'; end if;
    update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=p_r.id where id=policy.id;
    insert into clued_private.storage_account_policies_v2(owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
      actions,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,
      consent_receipt_id,activation_receipt_id,state,expires_at,scope_contract)
    values(p_owner,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,actions,digest,
      (select max(policy_generation)+1 from clued_private.storage_account_policies_v2 where connection_id=c.id),
      policy.source_decision_id,policy.decision_version,'native_level_change','clued.storage-master-disclosure/1',p_r.id,p_r.id,'active',policy.expires_at,'clued.storage-account-scope/3') returning * into fresh;
    update clued_private.storage_connections_v1 set account_policy_id=fresh.id,auth_generation=auth_generation+1 where id=c.id returning * into c;
    if ra.id is not null then update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=p_r.id where id=ra.id; end if;
    if p_enable then insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id,content_profile)
    values(p_owner,c.id,fresh.id,array['read','read_content'],
      coalesce((select max(read_generation) from clued_private.storage_read_access_v1 where connection_id=c.id),0)+1,
      'clued.storage-master-disclosure/1',p_r.id,'normal/1'); end if;
  if gate.connection_id is null then
    insert into clued_private.storage_master_controls_v1(connection_id,owner_id,enabled,allow_base_create,generation,receipt_id) values(c.id,p_owner,p_enable,p_enable,1,p_r.id);
  else
    update clued_private.storage_master_controls_v1 set enabled=p_enable,allow_base_create=p_enable,generation=generation+1,receipt_id=p_r.id where connection_id=c.id;
  end if;
  result:=clued_private.storage_onboard_finish_v1(p_owner,p_r,p.project_id,'extension:storage:master_control_v1',c.id,
    jsonb_build_object('connection_id',c.id,'enabled',p_enable,'source',p_source,'cancelled_jobs',cancelled,
      'disclosure_version','clued.storage-master-disclosure/1'),jsonb_build_object(c.id::text,coalesce(gate.generation,0)),
    jsonb_build_object(c.id::text,coalesce(gate.generation,0)+1));
  return result;
end $$;

create function clued_private.storage_master_native_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); c clued_private.storage_connections_v1;
  root text; app clued_private.storage_oauth_apps_v1; snapshot jsonb; r public.clued_audit_receipts; result jsonb;
  op text:=p_input->>'action'; uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if current_setting('role',true) is distinct from 'authenticated' or auth.jwt()->>'role' is distinct from 'authenticated'
    or jsonb_typeof(p_input) is distinct from 'object' or op not in ('master_status','master_set')
    or coalesce(p_input->>'connection_id','') !~ uuid_re then raise exception 'storage_master_denied' using errcode='42501'; end if;
  if op='master_status' then
    if p_input<>jsonb_build_object('action',op,'connection_id',p_input->>'connection_id') then raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  elsif (p_input-array['action','connection_id','enabled','base_generation','base_status_digest','disclosure_version','idempotency_key'])<>'{}'::jsonb
    or not(p_input ?& array['action','connection_id','enabled','base_generation','base_status_digest','disclosure_version','idempotency_key'])
    or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
    or jsonb_typeof(p_input->'base_generation') is distinct from 'number' or coalesce(p_input->>'base_generation','') !~ '^(0|[1-9][0-9]{0,17})$'
    or coalesce(p_input->>'base_status_digest','') !~ '^[0-9a-f]{64}$'
    or p_input->>'disclosure_version' is distinct from 'clued.storage-master-disclosure/1'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string' or length(p_input->>'idempotency_key') not between 8 and 160
    or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key') then raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  select pr.root_folder_id into root from clued_private.storage_connections_v1 co join clued_private.resource_center_profiles_v1 pr
    on pr.id=co.profile_id and pr.user_id=u where co.id=(p_input->>'connection_id')::uuid and co.owner_id=u;
  if root is null then raise exception 'storage_master_denied' using errcode='42501'; end if;
  -- Storage issuer/app is the outer row lock, matching existing transports.
  -- Native ownership selects the exact connection's configured issuer; the
  -- browser cannot supply an issuer, provider subject or another root.
  select a.* into app from clued_private.storage_oauth_apps_v1 a join clued_private.storage_connections_v1 co
    on co.oauth_client_id=a.oauth_client_id and co.owner_id=u where co.id=(p_input->>'connection_id')::uuid and a.revoked_at is null for share of a;
  if op='master_status' then perform pg_advisory_xact_lock_shared(hashtextextended(u::text||':'||root,0));
  else perform pg_advisory_xact_lock(hashtextextended(u::text||':'||root,0)); end if;
  perform clued_private.storage_owner_v1();
  snapshot:=clued_private.storage_master_snapshot_v1(u,(p_input->>'connection_id')::uuid);
  if op='master_status' then return snapshot; end if;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
  if app.issuer_hash is null or app.oauth_client_id is distinct from c.oauth_client_id or (select count(*) from clued_private.storage_oauth_apps_v1 where oauth_client_id=c.oauth_client_id and revoked_at is null)<>1
    or ((p_input->>'enabled')::boolean and (not app.execution_enabled or not app.read_enabled)) then raise exception 'storage_master_unavailable' using errcode='42501'; end if;
  r:=clued_private.m1_begin_receipt(u,null,'storage_master_control_v1',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    if r.status='committed' then return r.canonical_result; end if;
    raise exception 'storage_master_version_conflict' using errcode='40001'; end if;
  if snapshot->>'status_digest' is distinct from p_input->>'base_status_digest'
    or (snapshot->>'master_generation')::bigint is distinct from (p_input->>'base_generation')::bigint then
    raise exception 'storage_master_version_conflict' using errcode='40001'; end if;
  result:=clued_private.storage_master_apply_v1(u,c.id,(p_input->>'enabled')::boolean,r,'owner');
  perform clued_private.storage_owner_v1();
  return result;
end $$;

-- A deliberate Native fine-control change resumes the Agent gate in that
-- same existing Receipt transaction; the remaining classes derive partial.
create function clued_private.storage_master_resume_v1(p_owner uuid,p_connection uuid,p_receipt uuid,p_base boolean default false) returns void
language plpgsql volatile security definer set search_path='' as $$
declare gate clued_private.storage_master_controls_v1; desired boolean; base boolean;
begin
  if not exists(select 1 from public.clued_audit_receipts r where r.id=p_receipt and r.user_id=p_owner and r.status='committed') then
    raise exception 'storage_master_receipt_required' using errcode='42501'; end if;
  select * into gate from clued_private.storage_master_controls_v1 where connection_id=p_connection and owner_id=p_owner for update;
  if gate.connection_id is null then return; end if;
  base:=gate.allow_base_create or p_base;
  desired:=base or exists(select 1 from clued_private.storage_read_access_v1 ra join clued_private.storage_connections_v1 c on c.id=ra.connection_id
    where ra.connection_id=p_connection and ra.owner_id=p_owner and ra.state='active' and ra.account_policy_id=c.account_policy_id and cardinality(ra.classes)>0)
    or exists(select 1 from clued_private.storage_account_policies_v2 ap join clued_private.storage_connections_v1 c on c.account_policy_id=ap.id
      where c.id=p_connection and ap.owner_id=p_owner and ap.state='active' and ap.actions && array['modify','overwrite','destructive','modify_subtree']);
  update clued_private.storage_master_controls_v1 set enabled=desired,allow_base_create=base,
    generation=generation+1,receipt_id=p_receipt
    where connection_id=p_connection and owner_id=p_owner and (enabled is distinct from desired or allow_base_create is distinct from base);
end $$;

revoke all on function clued_private.storage_master_rows_guard_v1(),clued_private.storage_master_agent_enabled_v1(uuid,uuid),
  clued_private.storage_master_action_enabled_v1(uuid,uuid,text),
  clued_private.storage_master_snapshot_v1(uuid,uuid),clued_private.storage_master_apply_v1(uuid,uuid,boolean,public.clued_audit_receipts,text),
  clued_private.storage_master_native_v1(jsonb),clued_private.storage_master_resume_v1(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;

-- Exact anchored changes retain all existing client, grant, root, governance,
-- admission, Receipt, audit and recovery checks. No public callable is added.
do $patch$
declare patch record; definition text; hits int;
begin
  for patch in select * from (values
    ('public.clued_storage_owner_manage_v2(jsonb)',
      $a$begin
  if jsonb_typeof(p_input)$a$,
      $r$begin
  if op in ('master_status','master_set') then return clued_private.storage_master_native_v1(p_input); end if;
  if jsonb_typeof(p_input)$r$,1),
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
      $a$  select * into policy from clued_private.storage_account_policies_v2$a$,
      $r$  if not clued_private.storage_master_action_enabled_v1(owner_key,c.id,p_action) then raise exception 'storage_master_disabled' using errcode='42501'; end if;
  select * into policy from clued_private.storage_account_policies_v2$r$,1),
    ('clued_private.storage_read_evaluate_v1(text,uuid,text)',
      $a$  select * into policy from clued_private.storage_account_policies_v2$a$,
      $r$  if not clued_private.storage_master_agent_enabled_v1(owner_key,c.id) then raise exception 'storage_master_disabled' using errcode='42501'; end if;
  select * into policy from clued_private.storage_account_policies_v2$r$,1),
    ('clued_private.storage_job_history_v2(text,uuid,uuid,text)',
      $a$  return clued_private.storage_job_status_v1(j)||jsonb_build_object('submit_receipt_id',j.receipt_id,'execution_permitted',false);$a$,
      $r$  if not clued_private.storage_master_agent_enabled_v1(owner_key,c.id) then raise exception 'storage_master_disabled' using errcode='42501'; end if;
  return clued_private.storage_job_status_v1(j)||jsonb_build_object('submit_receipt_id',j.receipt_id,'execution_permitted',false);$r$,1),
    ('clued_private.storage_binding_v1(text,uuid,text)',
      $a$  perform clued_private.storage_connection_current_v1(c.id,b.user_id);$a$,
      $r$  perform clued_private.storage_connection_current_v1(c.id,b.user_id);
  if not clued_private.storage_master_action_enabled_v1(b.user_id,c.id,p_action) then raise exception 'storage_master_disabled' using errcode='42501'; end if;$r$,1),
    ('clued_private.storage_binary_gate_v1(uuid)',
      $a$where c.id=p_connection and c.auth_mode=$a$,
      $r$where c.id=p_connection and clued_private.storage_master_agent_enabled_v1(c.owner_id,c.id) and c.auth_mode=$r$,1),
    ('public.clued_storage_read_access_v1(jsonb)',
      $a$    perform clued_private.storage_owner_v1();
    return result;$a$,
      $r$    perform clued_private.storage_master_resume_v1(u,c.id,r.id);
    perform clued_private.storage_owner_v1();
    return result;$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
      $a$  perform clued_private.storage_owner_v1();
  return result;$a$,
      $r$  perform clued_private.storage_master_resume_v1(u,c.id,r.id);
  perform clued_private.storage_owner_v1();
  return result;$r$,1),
    ('public.clued_storage_normal_use_v1(jsonb)',
      $a$  perform clued_private.storage_owner_v1();
  return result;$a$,
      $r$  perform clued_private.storage_master_resume_v1(u,c.id,r.id,op='enable');
  perform clued_private.storage_owner_v1();
  return result;$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if not exists(select 1 from pg_proc p where p.oid=patch.sig::regprocedure and pg_get_userbyid(p.proowner)='postgres'
      and p.prosecdef and p.proconfig=array['search_path=""']) then raise exception 'storage_master_upgrade_unqualified' using errcode='42501'; end if;
    definition:=pg_get_functiondef(patch.sig::regprocedure);
    hits:=(length(definition)-length(replace(definition,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then raise exception 'storage_master_definition_mismatch: % (% of %)',patch.sig,hits,patch.expected; end if;
    execute replace(definition,patch.anchor,patch.replacement);
  end loop;
end $patch$;

-- Successor disclosure versions are new consent sources. Old attempts and
-- old scope-only upgrades retain their previous semantics.
create function clued_private.storage_master_disclosure_v1(p_root text) returns text
language sql immutable set search_path='' as $$
  select '开启总开关后，你授权的 Agent 可以在「'||p_root||'」内查看文件名和目录、读取文件内容、按内容搜索、新建文件与目录、上传支持的文件，并纳管你自己拥有的已有文件和文件夹。纳管后可以改名、移动、覆盖文本内容、移入回收站和恢复，也可以移动整个文件夹。已有对象仍须先纳管，每次操作仍须通过目录和任务检查，并留下回执。'||E'\n'||
    '读取到的内容会发送给该 Agent 所用的模型服务，已经返回的内容无法收回。覆盖前的内容按原规则保留为 Drive 版本；回收站不立即永久删除，但 Google 会在 30 天后自动永久删除。批量回收站确认和每小时额度继续生效。'||E'\n'||
    'Google 授权页会请求“查看、修改、创建和删除你 Google 云端硬盘中的所有文件”。Clued 服务端将操作限制在这个目录内；Google 授权本身覆盖整个云端硬盘。只有 Google 实际授予所需范围、全部权限生效后，总开关才显示全开。'||E'\n'||
    '关闭总开关会停止此连接的全部 Agent 文件操作，不删除文件，也不撤回 Google 授权。已经完成的读取和改动无法收回；尚未结束的文件任务需先核对结束。调整细项后，总开关会按实际权限显示部分开启。'
$$;
create function clued_private.storage_onboard_master_disclosure_v1(p_input jsonb) returns text
language sql immutable set search_path='' as $$
  select '点击“确认并连接 Google Drive”即表示你确认：Clued 使用你 Google 云端硬盘中的「'||(p_input->'root'->>'name')||'」作为资料根目录'||
    case when p_input->'root'->>'mode'='new' then '，在“我的云端硬盘”下新建该目录及子目录' else '，并在该目录下新建子目录' end||
    (select string_agg('「'||x||'」','' order by n) from jsonb_array_elements_text(p_input->'tracks') with ordinality t(x,n))||
    '，并以你的名义记录这一决定。'||
    case when p_input->'normal_use_requested'='true'::jsonb then E'\n'||clued_private.storage_master_disclosure_v1(p_input->'root'->>'name')||E'\n连接完成并取得完整授权后，总开关默认全开。\n'
      else E'\n连接完成后，总开关关闭，全部 Agent 文件操作停止。\n' end||
    case when p_input->'default_refresh_requested'='true'::jsonb then 'Clued 会在后台自动续期 Google 授权，直到你关闭或断开连接。' else '' end||
    '你可以随时在连接页关闭总开关或断开连接。'
$$;
revoke all on function clued_private.storage_master_disclosure_v1(text),clued_private.storage_onboard_master_disclosure_v1(jsonb) from public,anon,authenticated,service_role;

alter table clued_private.storage_onboard_attempts_v1
  drop constraint storage_onboard_attempts_v1_disclosure_version_check,
  add constraint storage_onboard_attempts_v1_disclosure_version_check check(disclosure_version in ('clued.storage-onboard-disclosure/1','clued.storage-onboard-disclosure/2')),
  drop constraint storage_onboard_attempts_v1_granted_scope_profile_check,
  add constraint storage_onboard_attempts_v1_granted_scope_profile_check check(granted_scope_profile in ('legacy','normal','full'));
alter table clued_private.storage_oauth_attempts_v1
  add column master_requested boolean not null default false,
  add column master_status_digest text check(master_status_digest ~ '^[0-9a-f]{64}$'),
  add constraint storage_oauth_master_intent_v1 check(not master_requested or (purpose='connection'
    and requested_scope_profile='full' and disclosure_version='clued.storage-master-disclosure/1' and master_status_digest is not null)),
  drop constraint storage_oauth_full_scope_v1,
  add constraint storage_oauth_full_scope_v1 check(requested_scope_profile is distinct from 'full'
    or (purpose='connection' and not normal_use_requested and (disclosure_version is null
      or disclosure_version in ('clued.storage-full-scope-disclosure/1','clued.storage-master-disclosure/1'))));

create function clued_private.storage_master_initialize_v1(p_owner uuid,p_connection uuid,p_enable boolean,p_source text,p_key text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare req jsonb; r public.clued_audit_receipts;
begin
  req:=jsonb_build_object('idempotency_key','storage-master-'||p_source||':'||p_key,'connection_id',p_connection,
    'enabled',p_enable,'disclosure_version','clued.storage-master-disclosure/1','source',p_source);
  r:=clued_private.m1_begin_receipt(p_owner,null,'storage_master_control_v1',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then
    if r.status='committed' then return r.canonical_result; end if;
    raise exception 'storage_master_version_conflict' using errcode='40001'; end if;
  return clued_private.storage_master_apply_v1(p_owner,p_connection,p_enable,r,p_source);
end $$;
revoke all on function clued_private.storage_master_initialize_v1(uuid,uuid,boolean,text,text) from public,anon,authenticated,service_role;

do $successor$
declare patch record; definition text; hits int;
begin
  for patch in select * from (values
    ('public.clued_storage_onboard_v1(text,jsonb)',
      $a$    if p_input->>'disclosure_version' is distinct from 'clued.storage-onboard-disclosure/1' then$a$,
      $r$    if coalesce(p_input->>'disclosure_version','') not in ('clued.storage-onboard-disclosure/1','clued.storage-onboard-disclosure/2') then$r$,1),
    ('public.clued_storage_onboard_v1(text,jsonb)',
      $a$    if p_input->>'disclosure_sha256' is distinct from encode(sha256(convert_to(p_input->>'disclosure_text','UTF8')),'hex')$a$,
      $r$    if p_input->>'disclosure_version'='clued.storage-onboard-disclosure/2' and p_input->>'disclosure_text' is distinct from
      clued_private.storage_onboard_master_disclosure_v1(p_input) then
      raise exception 'storage_onboard_disclosure_changed' using errcode='40001'; end if;
    if p_input->>'disclosure_sha256' is distinct from encode(sha256(convert_to(p_input->>'disclosure_text','UTF8')),'hex')$r$,1),
    ('clued_private.storage_onboard_view_v1(clued_private.storage_onboard_attempts_v1)',
      $a$case when o.normal_use_requested then 'normal' else 'legacy' end$a$,
      $r$case when o.normal_use_requested and o.disclosure_version='clued.storage-onboard-disclosure/2' then 'full'
        when o.normal_use_requested then 'normal' else 'legacy' end$r$,1),
    ('clued_private.ii_priv_storage_onboard_oauth_v1(text,jsonb)',
      $a$requested:=case when o.normal_use_requested then 'normal' else 'legacy' end;$a$,
      $r$requested:=case when o.normal_use_requested and o.disclosure_version='clued.storage-onboard-disclosure/2' then 'full'
      when o.normal_use_requested then 'normal' else 'legacy' end;$r$,1),
    ('clued_private.ii_priv_storage_onboard_oauth_v1(text,jsonb)',
      $a$p_input->>'provider_scope_profile' not in (requested,'legacy')$a$,
      $r$not clued_private.storage_scope_covers_v1(requested,p_input->>'provider_scope_profile')$r$,1),
    ('clued_private.storage_onboard_activate_v1(uuid,clued_private.storage_onboard_attempts_v1,clued_private.storage_oauth_apps_v1,jsonb)',
      $a$normal:=o.normal_use_requested and o.granted_scope_profile='normal' and c.provider_scope_profile='normal';$a$,
      $r$normal:=o.normal_use_requested and clued_private.storage_scope_covers_v1(o.granted_scope_profile,'normal')
    and clued_private.storage_scope_covers_v1(c.provider_scope_profile,'normal');$r$,1),
    ('clued_private.storage_onboard_activate_v1(uuid,clued_private.storage_onboard_attempts_v1,clued_private.storage_oauth_apps_v1,jsonb)',
      $a$  -- 10. Drop the staged envelope; attempt and OAuth attempt complete.$a$,
      $r$  if o.disclosure_version='clued.storage-onboard-disclosure/2' then
    if not o.normal_use_requested or c.provider_scope_profile='full' then
      perform clued_private.storage_master_initialize_v1(u,c.id,o.normal_use_requested,'onboard',o.id::text);
    end if;
  end if;
  -- 10. Drop the staged envelope; attempt and OAuth attempt complete.$r$,1),
    ('clued_private.storage_onboard_activate_v1(uuid,clued_private.storage_onboard_attempts_v1,clued_private.storage_oauth_apps_v1,jsonb)',
      $a$case when o.normal_use_requested then 'normal' else 'legacy' end$a$,
      $r$case when o.normal_use_requested and o.disclosure_version='clued.storage-onboard-disclosure/2' then 'full'
      when o.normal_use_requested then 'normal' else 'legacy' end$r$,1),
    ('clued_private.storage_onboard_activate_v1(uuid,clued_private.storage_onboard_attempts_v1,clued_private.storage_oauth_apps_v1,jsonb)',
      $a$  update clued_private.storage_onboard_attempts_v1 set state='completed',credential_envelope=null$a$,
      $r$  if o.disclosure_version='clued.storage-onboard-disclosure/2' then
    done:=done||jsonb_build_object('master_state',clued_private.storage_master_snapshot_v1(u,c.id)->>'state',
      'master_requested',o.normal_use_requested);
  end if;
  update clued_private.storage_onboard_attempts_v1 set state='completed',credential_envelope=null$r$,1),
    ('clued_private.ii_pub_clued_storage_oauth_v1(text,jsonb)',
      $a$normal boolean:=false; generation bigint;$a$,
      $r$normal boolean:=false; generation bigint; master boolean:=false;$r$,1),
    ('clued_private.ii_pub_clued_storage_oauth_v1(text,jsonb)',
      $a$if p_input ? 'full_scope' and p_input->'full_scope'->>'disclosure_version' is distinct from full_disclosure then$a$,
      $r$if p_input ? 'full_scope' and coalesce(p_input->'full_scope'->>'disclosure_version','') not in
      (full_disclosure,'clued.storage-master-disclosure/1') then$r$,1),
    ('clued_private.ii_pub_clued_storage_oauth_v1(text,jsonb)',
      $a$    normal:=p_input ? 'normal_use';$a$,
      $r$    normal:=p_input ? 'normal_use';
    master:=p_input->'full_scope'->>'disclosure_version'='clued.storage-master-disclosure/1';$r$,1),
    ('clued_private.ii_pub_clued_storage_oauth_v1(text,jsonb)',
      $a$disclosure_version=case when normal then normal_disclosure when p_input ? 'full_scope' then full_disclosure end,$a$,
      $r$disclosure_version=case when normal then normal_disclosure when p_input ? 'full_scope' then p_input->'full_scope'->>'disclosure_version' end,
        master_requested=coalesce(master,false),master_status_digest=case when master then clued_private.storage_master_snapshot_v1(u,c.id)->>'status_digest' end,$r$,1),
    ('clued_private.ii_pub_clued_storage_oauth_v1(text,jsonb)',
      $a$    -- §2.3: the granted profile is the requested one or a lower one.$a$,
      $r$    if x.master_requested and x.status<>'completed' and x.master_status_digest is distinct from
        clued_private.storage_master_snapshot_v1(u,c.id)->>'status_digest' then
      raise exception 'storage_master_version_conflict' using errcode='40001'; end if;
    -- §2.3: the granted profile is the requested one or a lower one.$r$,1),
    ('clued_private.ii_pub_clued_storage_oauth_v1(text,jsonb)',
      $a$    result:=result||jsonb_build_object('provider_scope_profile',after.provider_scope_profile,'requested_scope_profile',requested,$a$,
      $r$    if x.master_requested then
      if after.provider_scope_profile='full' and after.auth_mode='account_policy' and after.state='active' then
        perform clued_private.storage_master_initialize_v1(u,after.id,true,'oauth',x.id::text);
      end if;
      result:=result||jsonb_build_object('master_state',clued_private.storage_master_snapshot_v1(u,after.id)->>'state',
        'master_requested',true);
    end if;
    result:=result||jsonb_build_object('provider_scope_profile',after.provider_scope_profile,'requested_scope_profile',requested,$r$,1),
    ('public.clued_storage_owner_lifecycle_v1(text,jsonb)',
      $a$    elsif confirmation->>'contract' is distinct from 'clued.storage-owner-confirmation/1'$a$,
      $r$    elsif confirmation->>'contract'='clued.storage-owner-confirmation/3' then
      if op<>'reconnect_begin' or jsonb_typeof(confirmation->'master_enabled') is distinct from 'boolean'
        or confirmation is distinct from jsonb_build_object('contract','clued.storage-owner-confirmation/3',
          'root_folder_id',root,'confirmed',true,'master_enabled',confirmation->'master_enabled',
          'disclosure_version','clued.storage-master-disclosure/1') then
        raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    elsif confirmation->>'contract' is distinct from 'clued.storage-owner-confirmation/1'$r$,1),
    ('public.clued_storage_owner_lifecycle_v1(text,jsonb)',
      $a$or jsonb_typeof(confirmation->'normal_use') is distinct from 'boolean'$a$,
      $r$or (confirmation->>'contract'<>'clued.storage-owner-confirmation/3' and jsonb_typeof(confirmation->'normal_use') is distinct from 'boolean')$r$,1),
    ('public.clued_storage_owner_lifecycle_v1(text,jsonb)',
      $a$normal:=(confirmation->>'normal_use')::boolean;$a$,
      $r$normal:=coalesce((confirmation->>'master_enabled')::boolean,(confirmation->>'normal_use')::boolean);$r$,1),
    ('public.clued_storage_owner_lifecycle_v1(text,jsonb)',
      $a$'content','重新授权原资料根；只恢复基础创建权限及本次明确选择的正常使用。旧连接与凭据保持撤销，后台续签不自动恢复。',$a$,
      $r$'content',case when confirmation->>'contract'='clued.storage-owner-confirmation/3' then
          clued_private.storage_master_disclosure_v1(coalesce(p.display_name,p.managed_root))||E'\nOwner 确认的总开关初始状态：'||case when normal then '全开' else '关闭' end
          else '重新授权原资料根；只恢复基础创建权限及本次明确选择的正常使用。旧连接与凭据保持撤销，后台续签不自动恢复。' end,$r$,1),
    ('public.clued_storage_owner_lifecycle_v1(text,jsonb)',
      $a$case when normal then 'normal' else 'legacy' end,true,r.id)$a$,
      $r$case when confirmation->>'contract'='clued.storage-owner-confirmation/3' and normal then 'full'
          when normal then 'normal' else 'legacy' end,true,r.id)$r$,1),
    ('public.clued_storage_owner_lifecycle_v1(text,jsonb)',
      $a$normal:=(l.confirmation->>'normal_use')::boolean and fresh.provider_scope_profile in ('normal','full');$a$,
      $r$normal:=coalesce((l.confirmation->>'master_enabled')::boolean,(l.confirmation->>'normal_use')::boolean)
      and fresh.provider_scope_profile in ('normal','full');$r$,1),
    ('public.clued_storage_owner_lifecycle_v1(text,jsonb)',
      $a$    perform clued_private.storage_owner_v1();
    perform clued_private.issuer_resolve_identity_v1(p_issuer_hash,'storage');
    return answer;$a$,
      $r$    if l.confirmation->>'contract'='clued.storage-owner-confirmation/3' then
      if l.confirmation->'master_enabled'='false'::jsonb or fresh.provider_scope_profile='full' then
        perform clued_private.storage_master_initialize_v1(u,fresh.id,(l.confirmation->>'master_enabled')::boolean,'reconnect',l.id::text);
      end if;
      answer:=answer||jsonb_build_object('master_state',clued_private.storage_master_snapshot_v1(u,fresh.id)->>'state',
        'master_requested',(l.confirmation->>'master_enabled')::boolean);
      update clued_private.storage_owner_lifecycle_v1 x set result=answer where x.id=l.id;
    end if;
    perform clued_private.storage_owner_v1();
    perform clued_private.issuer_resolve_identity_v1(p_issuer_hash,'storage');
    return answer;$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if not exists(select 1 from pg_proc p where p.oid=patch.sig::regprocedure and pg_get_userbyid(p.proowner)='postgres'
      and p.prosecdef and p.proconfig=array['search_path=""']) then raise exception 'storage_master_upgrade_unqualified' using errcode='42501'; end if;
    definition:=pg_get_functiondef(patch.sig::regprocedure);
    hits:=(length(definition)-length(replace(definition,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then raise exception 'storage_master_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,70); end if;
    execute replace(definition,patch.anchor,patch.replacement);
  end loop;
end $successor$;

notify pgrst,'reload schema';
