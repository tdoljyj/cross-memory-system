-- Native Owner lifecycle only. No legacy connection, credential, policy,
-- client restriction or delegation is revived. No provider request runs here.
create table clued_private.storage_owner_lifecycle_v1 (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
  session_id uuid not null, issuer_hash text not null references clued_private.storage_oauth_apps_v1(issuer_hash),
  operation text not null check(operation in ('reconnect','delete')),
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  connection_version bigint not null, profile_id uuid not null references clued_private.resource_center_profiles_v1(id),
  profile_version bigint not null, root_folder_id text not null,
  root_stop_id uuid references clued_private.storage_root_denies_v2(id), root_stop_generation bigint,
  confirmation jsonb not null, request_key uuid not null, request_digest text not null,
  new_connection_id uuid references clued_private.storage_connections_v1(id),
  state text not null check(state in ('prepared','started','completed','uncertain')),
  admission uuid, expires_at timestamptz not null, intent_id uuid references clued_private.resource_center_mutations_v1(id),
  receipt_id uuid not null references public.clued_audit_receipts(id), result jsonb,
  created_at timestamptz not null default clock_timestamp(), unique(owner_id,request_key)
);
create unique index storage_owner_lifecycle_pending_v1 on clued_private.storage_owner_lifecycle_v1(profile_id)
  where state in ('prepared','started','uncertain');
create table clued_private.storage_owner_connection_hidden_v1 (
  connection_id uuid primary key references clued_private.storage_connections_v1(id),
  owner_id uuid not null references auth.users(id), receipt_id uuid not null references public.clued_audit_receipts(id),
  hidden_at timestamptz not null default clock_timestamp()
);
alter table clued_private.storage_owner_lifecycle_v1 enable row level security;
alter table clued_private.storage_owner_connection_hidden_v1 enable row level security;
revoke all on clued_private.storage_owner_lifecycle_v1,clued_private.storage_owner_connection_hidden_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Provenance is not a name/prefix or browser assertion. The exact completed
-- onboard result must link this profile, root and immutable created effect.
create function clued_private.storage_owner_created_root_v1(p_owner uuid,p_profile uuid,p_root text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.storage_onboard_attempts_v1 o
    join public.clued_audit_receipts r on r.id=(o.result->>'receipt_id')::uuid and r.user_id=o.owner_id and r.status='committed'
    where o.owner_id=p_owner and o.state='completed' and o.root_mode='new'
      and o.result->>'profile_id'=p_profile::text and o.effects->'root'->>'provider_file_id'=p_root
      and o.effects->'root'->'created'='true'::jsonb and o.effects->'root' ? 'result_at')
$$;
revoke all on function clued_private.storage_owner_created_root_v1(uuid,uuid,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function public.clued_storage_owner_lifecycle_v1(p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); sid uuid:=(auth.jwt()->>'session_id')::uuid;
  issuer text; app clued_private.storage_oauth_apps_v1; op text:=p_input->>'action';
  c clued_private.storage_connections_v1; fresh clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; stop clued_private.storage_root_denies_v2;
  l clued_private.storage_owner_lifecycle_v1; policy clued_private.storage_account_policies_v2;
  r public.clued_audit_receipts; outcome jsonb; req jsonb; answer jsonb; decision uuid; dv bigint;
  root text; digest text; created boolean; normal boolean; oauth clued_private.storage_oauth_attempts_v1;
  snapshot jsonb; trash boolean; intent uuid; confirmation jsonb;
begin
  if current_setting('role',true) is distinct from 'authenticated'
    or auth.jwt()->>'role' is distinct from 'authenticated' then
    raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
  issuer:=clued_private.issuer_resolve_identity_compatible_v1(p_issuer_hash,'storage','storage_owner_lifecycle_denied');
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=issuer and revoked_at is null;
  if app.issuer_hash is null or (select count(*) from clued_private.storage_oauth_apps_v1
    where oauth_client_id=app.oauth_client_id and revoked_at is null)<>1
    or jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
  if op='list' and p_input=jsonb_build_object('action','list') then
    if (select count(*) from clued_private.storage_connections_v1 co where co.owner_id=u and not exists(
      select 1 from clued_private.storage_owner_connection_hidden_v1 h where h.connection_id=co.id)
      and not exists(select 1 from clued_private.storage_owner_lifecycle_v1 lp where lp.new_connection_id=co.id
        and (lp.state<>'completed' or lp.result->>'status' is distinct from 'completed')))>100 then
      raise exception 'storage_owner_lifecycle_list_incomplete' using errcode='42501'; end if;
    return jsonb_build_object('contract','clued.storage-owner-lifecycle/1','complete',true,'connections',coalesce((select jsonb_agg(
      jsonb_build_object('id',co.id,'version',co.version,'provider',co.provider,'state',co.state,'auth_mode',co.auth_mode,
        'scope_name',pr.profile_version,'provider_scope_profile',co.provider_scope_profile,
        'policy_active',exists(select 1 from clued_private.storage_account_policies_v2 ap where ap.id=co.account_policy_id and ap.state='active' and co.state='active' and co.revoked_at is null),
        'actions',coalesce((select to_jsonb(ap.actions) from clued_private.storage_account_policies_v2 ap where ap.id=co.account_policy_id and ap.state='active'),'[]'::jsonb),
        'database_execution_enabled',app.execution_enabled,'profile_current',pr.state='active' and pr.version=co.profile_version,
        'access_digest_missing',jsonb_build_object(
          'count',(select count(*) from clued_private.resource_center_artifacts_v1 x
            where x.profile_id=pr.id and x.user_id=u and x.state='active' and x.access_digest_missing_at is not null),
          'directories',coalesce((select jsonb_agg(jsonb_build_object('path',y.path,'since',y.since) order by y.path collate "C")
            from (select substr(x.path,char_length(pr.managed_root)+2) path,x.access_digest_missing_at since
              from clued_private.resource_center_artifacts_v1 x where x.profile_id=pr.id and x.user_id=u
                and x.state='active' and x.access_digest_missing_at is not null order by x.path collate "C" limit 20) y),'[]'::jsonb)),
        'profile_id',pr.id,'profile_version',pr.version,'project_id',pr.project_id,'managed_root',pr.managed_root,
        'root_folder_id',pr.root_folder_id,'root_parent_id',pr.root_parent_id,'root_name',coalesce(pr.display_name,pr.managed_root),
        'tracks',coalesce(pr.cloud_runtime->'allowed_root_children','[]'::jsonb),'created_by_clued',clued_private.storage_owner_created_root_v1(u,pr.id,pr.root_folder_id),
        'root_stop_generation',coalesce(ds.generation,0),'root_stopped',coalesce(ds.denied,false),
        'pending_lifecycle',(select jsonb_build_object('attempt_id',lp.id,'operation',lp.operation,'state',lp.state,'expires_at',lp.expires_at,'execution_permitted',false)
          from clued_private.storage_owner_lifecycle_v1 lp where lp.owner_id=u and lp.connection_id=co.id and lp.state in ('prepared','started','uncertain')),
        'normal_use_enabled',exists(select 1 from clued_private.storage_read_access_v1 ra where ra.connection_id=co.id and ra.state='active'
          and ra.content_profile='normal/1' and co.revoked_at is null),
        'refresh_enabled',exists(select 1 from clued_private.storage_refresh_delegations_v1 de where de.connection_id=co.id and de.enabled and co.revoked_at is null))
      order by co.id) from clued_private.storage_connections_v1 co
      join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
      left join clued_private.storage_root_denies_v2 ds on ds.owner_id=u and ds.provider=co.provider
        and ds.provider_subject=co.provider_subject and ds.root_folder_id=pr.root_folder_id and ds.lineage_id is null
      where co.owner_id=u and not exists(select 1 from clued_private.storage_owner_connection_hidden_v1 h where h.connection_id=co.id)
        and not exists(select 1 from clued_private.storage_owner_lifecycle_v1 lp where lp.new_connection_id=co.id
          and (lp.state<>'completed' or lp.result->>'status' is distinct from 'completed'))),'[]'::jsonb));
  end if;
  if op='recover_request' then
    if p_input<>jsonb_build_object('action',op,'request_id',p_input->>'request_id') then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    select * into l from clued_private.storage_owner_lifecycle_v1 where owner_id=u and session_id=sid
      and issuer_hash=issuer and request_key=(p_input->>'request_id')::uuid;
    if l.id is null then return jsonb_build_object('status','not_found','execution_permitted',false); end if;
    return jsonb_build_object('status',l.state,'attempt_id',l.id,'execution_permitted',false);
  end if;
  if op in ('reconnect_activate') then
    if p_input<>jsonb_build_object('action',op,'state_hash',p_input->>'state_hash') or coalesce(p_input->>'state_hash','') !~ '^[0-9a-f]{64}$' then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    select * into oauth from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash'
      and owner_id=u and session_id=sid and issuer_hash=issuer and purpose='connection';
    select * into l from clued_private.storage_owner_lifecycle_v1 where owner_id=u and session_id=sid
      and issuer_hash=issuer and new_connection_id=oauth.connection_id and operation='reconnect';
    if l.id is null then return jsonb_build_object('status','not_applicable'); end if;
  elsif op in ('delete_start','delete_revalidate','delete_observe','recover') then
    select * into l from clued_private.storage_owner_lifecycle_v1 where id=(p_input->>'attempt_id')::uuid
      and owner_id=u and (session_id=sid or op in ('recover','delete_observe')) and issuer_hash=issuer and (operation='delete' or op='recover');
    if l.id is null then raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
  end if;
  select pr.root_folder_id into root from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
    where co.id=coalesce(l.connection_id,(p_input->>'connection_id')::uuid) and co.owner_id=u;
  if root is null then raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  perform clued_private.storage_owner_v1();
  -- Both session and credential can expire while waiting for Root ownership.
  perform clued_private.issuer_resolve_identity_compatible_v1(p_issuer_hash,'storage','storage_owner_lifecycle_denied');
  perform clued_private.authorization_account_v12(u);
  select * into c from clued_private.storage_connections_v1
    where id=coalesce(l.connection_id,(p_input->>'connection_id')::uuid) and owner_id=u for update;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u for share;
  if l.id is not null then
    select * into l from clued_private.storage_owner_lifecycle_v1 where id=l.id for update;
    if l.state='completed' and op in ('recover','reconnect_activate') then return l.result; end if;
  end if;
  if p.id is null or p.state<>'active' or p.root_folder_id is distinct from root or c.profile_version<>p.version
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,c.source_decision_id) then
    raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
  select * into stop from clued_private.storage_root_denies_v2 where owner_id=u and provider=c.provider
    and provider_subject=c.provider_subject and root_folder_id=root and lineage_id is null for update;
  if l.id is not null then
    select * into l from clued_private.storage_owner_lifecycle_v1 where id=l.id for update;
    if l.state='completed' then
      if op not in ('recover','reconnect_activate') then raise exception 'storage_owner_lifecycle_replayed' using errcode='42501'; end if;
      return l.result; end if;
    if l.profile_version<>p.version or l.connection_version<>c.version or l.root_folder_id<>root then
      raise exception 'storage_owner_lifecycle_conflict' using errcode='40001'; end if;
  end if;
  if op='describe' then
    if p_input<>jsonb_build_object('action',op,'connection_id',c.id) then raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    perform clued_private.storage_connection_current_v1(c.id,u);
    if c.oauth_client_id is distinct from app.oauth_client_id then raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    return jsonb_build_object('owner_id',u,'connection_id',c.id,'connection_version',c.version,'profile_id',p.id,'profile_version',p.version,
      'credential_version',c.credential_version,'credential_envelope',c.credential_envelope,'provider_subject',c.provider_subject,
      'oauth_client_id',c.oauth_client_id,'root_folder_id',root,'root_parent_id',p.root_parent_id,'managed_root',p.managed_root,
      'created_by_clued',clued_private.storage_owner_created_root_v1(u,p.id,root));
  end if;
  if op in ('reconnect_begin','delete_prepare') then
    if (p_input-array['action','connection_id','base_version','profile_version','root_stop_generation','request_id','confirmation','snapshot'])<>'{}'::jsonb
      or not(p_input ?& array['action','connection_id','base_version','profile_version','request_id','confirmation'])
      or jsonb_typeof(p_input->'confirmation') is distinct from 'object' then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    confirmation:=p_input->'confirmation';
    if confirmation->>'contract' is distinct from 'clued.storage-owner-confirmation/1'
      or confirmation->>'root_folder_id' is distinct from root
      or confirmation->'confirmed' is distinct from 'true'::jsonb
      or (confirmation-array['contract','root_folder_id','confirmed','normal_use','trash_created_root','metadata_digest','root_version'])<>'{}'::jsonb then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    digest:=clued_private.m1_sha256(p_input);
    select * into l from clued_private.storage_owner_lifecycle_v1 where owner_id=u and request_key=(p_input->>'request_id')::uuid for update;
    if l.id is not null then
      if l.request_digest is distinct from digest then raise exception 'storage_owner_lifecycle_conflict' using errcode='40001'; end if;
      -- A retry may recover metadata but never a second provider permit.
      return coalesce(l.result,jsonb_build_object('status',l.state,'attempt_id',l.id,'connection_id',l.new_connection_id,'execution_permitted',false));
    end if;
    if c.version is distinct from (p_input->>'base_version')::bigint or p.version is distinct from (p_input->>'profile_version')::bigint
      or exists(select 1 from clued_private.storage_owner_connection_hidden_v1 where connection_id=c.id) then
      raise exception 'storage_owner_lifecycle_conflict' using errcode='40001'; end if;
    perform clued_private.storage_root_quiet_v1(u,root);
    if exists(select 1 from clued_private.storage_jobs_v1 j join clued_private.storage_connections_v1 jc on jc.id=j.connection_id
      join clued_private.resource_center_profiles_v1 jp on jp.id=jc.profile_id
      left join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id
      where j.owner_id=u and jp.root_folder_id=root and (m.state in ('prepared','started','uncertain')
        or (m.id is null and (j.intent_id is not null or j.dispatch_outcome is null
          or not coalesce(clued_private.storage_dispatch_outcome_valid_v1(j.dispatch_outcome),false)
          or not exists(select 1 from public.clued_audit_receipts jr where jr.id=j.dispatch_outcome_receipt_id
            and jr.user_id=u and jr.status='committed'))))) then
      raise exception 'storage_root_has_unresolved_mutation' using errcode='42501'; end if;
    if op='reconnect_begin' then
      if c.state<>'revoked' or c.revoked_at is null or c.auth_mode<>'revoked' or not coalesce(stop.denied,false)
        or stop.generation is distinct from (p_input->>'root_stop_generation')::bigint
        or jsonb_typeof(confirmation->'normal_use') is distinct from 'boolean'
        or confirmation ?| array['trash_created_root','metadata_digest','root_version'] then
        raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
      normal:=(confirmation->>'normal_use')::boolean;
      -- A cancelled Google consent must not strand the old root forever.
      -- Only a NEW exact Native confirmation may close an expired unactivated
      -- replacement. It revokes that replacement (never revives an old row),
      -- and the original root stop remains denied until fresh activation.
      select * into l from clued_private.storage_owner_lifecycle_v1
        where owner_id=u and profile_id=p.id and connection_id=c.id and operation='reconnect' and state='prepared' for update;
      if l.id is not null then
        if l.expires_at>clock_timestamp() then raise exception 'storage_owner_lifecycle_conflict' using errcode='40001'; end if;
        select * into fresh from clued_private.storage_connections_v1 where id=l.new_connection_id and owner_id=u for update;
        if fresh.id is null or fresh.account_policy_id is not null or fresh.auth_mode<>'legacy' or fresh.revoked_at is not null then
          raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
        r:=clued_private.storage_onboard_receipt_v1(u,'storage_owner_reconnect_expired',
          jsonb_build_object('idempotency_key','storage-reconnect-expired:'||l.id,'attempt_id',l.id,'replacement_id',fresh.id));
        update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),auth_mode='revoked',
          auth_generation=auth_generation+1,version=version+1,receipt_id=r.id where id=fresh.id;
        insert into clued_private.storage_owner_connection_hidden_v1(connection_id,owner_id,receipt_id) values(fresh.id,u,r.id);
        perform clued_private.storage_onboard_finish_v1(u,r,p.project_id,'extension:storage:owner_reconnect_expired',fresh.id,
          jsonb_build_object('attempt_id',l.id,'replacement_id',fresh.id),'{}'::jsonb,'{}'::jsonb);
        update clued_private.storage_owner_lifecycle_v1 set state='completed',
          result=jsonb_build_object('status','cancelled','attempt_id',l.id,'execution_permitted',false) where id=l.id;
      end if;
      -- Explicit fresh decision in the EXISTING project. Only base create
      -- permission and the separately chosen normal read set are restored.
      decision:=gen_random_uuid();
      req:=jsonb_build_object('operation','create','id',decision,'scope','project:'||p.project_id,'record_type','decision',
        'record_schema_version',1,'authority','user_explicit','user_confirmed',true,
        'confidence_reason','Native Owner confirmed a fresh connection to the exact existing root.',
        'source_refs','[]'::jsonb,'source_unavailable_reason','Native Owner storage lifecycle confirmation.',
        'idempotency_key','storage-reconnect-decision:'||(p_input->>'request_id'),
        'mutation',jsonb_build_object('title','重新连接 Google Drive 资料根',
          'content','重新授权原资料根；只恢复基础创建权限及本次明确选择的正常使用。旧连接与凭据保持撤销，后台续签不自动恢复。',
          'type_fields',jsonb_build_object('rationale','Native Owner fresh reconnect confirmation.',
            'root_folder_id',root,'profile_id',p.id,'old_connection_id',c.id,'root_stop_generation',stop.generation,'normal_use',normal)));
      outcome:=clued_private.record_mutation_with_terminal_guard(u,null,req,clued_private.m1_sha256(req));
      if outcome->>'status'<>'committed' then raise exception 'storage_owner_lifecycle_conflict' using errcode='40001'; end if;
      perform clued_private.native_write_marker_v1(u,outcome,'storage_owner_reconnect');
      select version into dv from public.clued_memories where id=decision and user_id=u;
      r:=clued_private.storage_onboard_receipt_v1(u,'storage_owner_reconnect',
        jsonb_build_object('idempotency_key','storage-owner:'||(p_input->>'request_id'),'request_digest',digest,'connection_id',c.id));
      insert into clued_private.storage_connections_v1(owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,
        provider_subject,oauth_client_id,provider_scope_profile,refresh_default_blocked,receipt_id)
      values(u,p.id,p.version,decision,dv,c.provider,c.provider_subject,app.oauth_client_id,
        case when normal then 'normal' else 'legacy' end,true,r.id) returning * into fresh;
      insert into clued_private.storage_owner_lifecycle_v1(owner_id,session_id,issuer_hash,operation,connection_id,connection_version,
        profile_id,profile_version,root_folder_id,root_stop_id,root_stop_generation,confirmation,request_key,request_digest,
        new_connection_id,state,expires_at,receipt_id)
      values(u,sid,issuer,'reconnect',c.id,c.version,p.id,p.version,root,stop.id,stop.generation,confirmation,
        (p_input->>'request_id')::uuid,digest,fresh.id,'prepared',clock_timestamp()+interval '10 minutes',r.id) returning * into l;
      perform clued_private.storage_onboard_finish_v1(u,r,p.project_id,'extension:storage:owner_reconnect_prepared',fresh.id,
        jsonb_build_object('old_connection_id',c.id,'new_connection_id',fresh.id,'root_folder_id',root,'root_stop_generation',stop.generation),
        '{}'::jsonb,jsonb_build_object(fresh.id::text,1));
      return jsonb_build_object('status','prepared','connection_id',fresh.id,'attempt_id',l.id,'normal_use',normal,'refresh_enabled',false);
    end if;
    trash:=coalesce((confirmation->>'trash_created_root')::boolean,false);
    if jsonb_typeof(confirmation->'trash_created_root') is distinct from 'boolean' or confirmation ? 'normal_use' then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    snapshot:=p_input->'snapshot';
    if trash then
      perform clued_private.storage_connection_current_v1(c.id,u);
      if c.auth_mode<>'account_policy' or c.oauth_client_id is distinct from app.oauth_client_id
        or not clued_private.storage_owner_created_root_v1(u,p.id,root)
        or jsonb_typeof(snapshot) is distinct from 'object' or snapshot->>'root_folder_id' is distinct from root
        or snapshot->>'root_parent_id' is distinct from p.root_parent_id
        or snapshot->>'metadata_digest' is distinct from confirmation->>'metadata_digest'
        or snapshot->>'root_version' is distinct from confirmation->>'root_version'
        or coalesce(snapshot->>'metadata_digest','') !~ '^[0-9a-f]{64}$'
        or coalesce(snapshot->>'root_version','') !~ '^[0-9]{1,30}$'
        or coalesce(snapshot->>'etag','') !~ '^"[^"\r\n]{1,200}"$'
        or snapshot->'owned_by_me' is distinct from 'true'::jsonb
        or snapshot->'can_trash' is distinct from 'true'::jsonb
        or snapshot->'trashed' is distinct from 'false'::jsonb then
        raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    end if;
    r:=clued_private.storage_onboard_receipt_v1(u,'storage_owner_delete',
      jsonb_build_object('idempotency_key','storage-owner:'||(p_input->>'request_id'),'request_digest',digest,
        'connection_id',c.id,'root_folder_id',root,'trash_created_root',trash));
    if trash then
      insert into clued_private.resource_center_mutations_v1(user_id,profile_id,request_key,request_sha256,exact_request,authority_request,
        authority_result,authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id)
      values(u,p.id,'owner-root-trash:'||(p_input->>'request_id'),digest,confirmation,
        jsonb_build_object('contract','clued.storage-owner-root-lifecycle/1','purpose','owner_root_decommission','root_folder_id',root),
        jsonb_build_object('native_owner_confirmed',true,'created_by_clued',true),digest,p.version,c.source_decision_id,
        'prepared',clock_timestamp()+interval '60 seconds',r.id) returning id into intent;
    end if;
    insert into clued_private.storage_owner_lifecycle_v1(owner_id,session_id,issuer_hash,operation,connection_id,connection_version,
      profile_id,profile_version,root_folder_id,confirmation,request_key,request_digest,state,admission,expires_at,intent_id,receipt_id)
    values(u,sid,issuer,'delete',c.id,c.version,p.id,p.version,root,confirmation||jsonb_build_object('snapshot',snapshot),
      (p_input->>'request_id')::uuid,digest,'prepared',gen_random_uuid(),clock_timestamp()+interval '60 seconds',intent,r.id) returning * into l;
    perform clued_private.storage_onboard_finish_v1(u,r,p.project_id,'extension:storage:owner_delete_prepared',c.id,
      jsonb_build_object('attempt_id',l.id,'root_folder_id',root,'trash_created_root',trash),'{}'::jsonb,'{}'::jsonb);
    return jsonb_build_object('status','prepared','attempt_id',l.id,'admission',l.admission,'expires_at',l.expires_at);
  end if;
  if op='reconnect_activate' then
    if l.state<>'prepared' or l.expires_at<=clock_timestamp() or oauth.status<>'completed'
      or stop.id is distinct from l.root_stop_id or stop.generation is distinct from l.root_stop_generation or not stop.denied then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    perform clued_private.storage_root_quiet_v1(u,root);
    select * into fresh from clued_private.storage_connections_v1 where id=l.new_connection_id and owner_id=u for update;
    if fresh.state<>'active' or fresh.credential_version<>1 or fresh.profile_id<>p.id or fresh.profile_version<>p.version
      or fresh.provider_subject is distinct from c.provider_subject or fresh.oauth_client_id is distinct from app.oauth_client_id
      or fresh.source_decision_id=c.source_decision_id or not clued_private.resource_center_decision_current_v1(u,p.project_id,fresh.source_decision_id) then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    r:=clued_private.storage_onboard_receipt_v1(u,'storage_owner_reconnect_activate',
      jsonb_build_object('idempotency_key','storage-reconnect-activate:'||l.id,'attempt_id',l.id,'oauth_receipt_id',oauth.receipt_id));
    digest:=clued_private.storage_policy_scope_digest_v2(fresh.id);
    if digest is null then raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    insert into clued_private.storage_account_policies_v2(owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
      scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id,activation_receipt_id,state)
    values(u,fresh.id,fresh.provider,fresh.provider_subject,root,p.id,digest,1,fresh.source_decision_id,fresh.decision_version,
      'explicit_restore','clued.storage-owner-confirmation/1',l.receipt_id,r.id,'active') returning * into policy;
    update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=policy.id,auth_generation=auth_generation+1
      where id=fresh.id returning * into fresh;
    update clued_private.storage_root_denies_v2 set denied=false,generation=generation+1,receipt_id=r.id where id=stop.id;
    normal:=(l.confirmation->>'normal_use')::boolean and fresh.provider_scope_profile in ('normal','full');
    perform clued_private.storage_normal_use_write_v1(u,fresh.id,policy.id,p.project_id,normal,
      case when normal then 'clued.storage-normal-use-disclosure/1' end,r,'storage-reconnect-read:'||l.id,'owner');
    answer:=jsonb_build_object('status','completed','receipt_id',r.id,'connection_id',fresh.id,'old_connection_id',c.id,
      'profile_id',p.id,'project_id',p.project_id,'provider_scope_profile',fresh.provider_scope_profile,
      'requested_scope_profile',oauth.requested_scope_profile,'normal_use_enabled',normal,'refresh_enabled',false);
    insert into clued_private.storage_owner_connection_hidden_v1(connection_id,owner_id,receipt_id) values(c.id,u,r.id);
    update clued_private.storage_owner_lifecycle_v1 x set state='completed',result=answer where x.id=l.id;
    perform clued_private.storage_owner_v1();
    perform clued_private.issuer_resolve_identity_v1(p_issuer_hash,'storage');
    return answer;
  end if;
  if op in ('delete_start','delete_revalidate') then
    if p_input<>jsonb_build_object('action',op,'attempt_id',l.id,'admission',p_input->>'admission')
      or l.admission is null or jsonb_typeof(p_input->'admission') is distinct from 'string'
      or coalesce(p_input->>'admission','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or l.admission is distinct from (p_input->>'admission')::uuid or l.expires_at<=clock_timestamp()
      or (op='delete_start' and l.state<>'prepared') or (op='delete_revalidate' and l.state<>'started') then
      raise exception 'storage_owner_lifecycle_replayed' using errcode='42501'; end if;
    if l.intent_id is not null then
      perform clued_private.storage_connection_current_v1(c.id,u);
      if c.oauth_client_id is distinct from app.oauth_client_id or not clued_private.storage_owner_created_root_v1(u,p.id,root)
        or exists(select 1 from clued_private.resource_center_mutations_v1 m join clued_private.resource_center_profiles_v1 mp on mp.id=m.profile_id
          where m.user_id=u and mp.root_folder_id=root and m.id<>l.intent_id and m.state in ('prepared','started','uncertain')) then
        raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
      if op='delete_start' then update clued_private.resource_center_mutations_v1 set state='started',version=version+1 where id=l.intent_id; end if;
    end if;
    if op='delete_start' then
      update clued_private.storage_owner_lifecycle_v1 set state='started',
        admission=case when intent_id is null then null else admission end where id=l.id;
    else
      -- The last check consumes the effect capability. It can never grant a
      -- second outbound write, even before the TTL expires.
      update clued_private.storage_owner_lifecycle_v1 set admission=null where id=l.id;
    end if;
    perform clued_private.storage_owner_v1();
    perform clued_private.issuer_resolve_identity_compatible_v1(p_issuer_hash,'storage','storage_owner_lifecycle_denied');
    return jsonb_build_object('status','admitted','attempt_id',l.id,'expires_at',l.expires_at);
  end if;
  if op='recover' then
    if p_input<>jsonb_build_object('action',op,'attempt_id',l.id) then raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    if l.operation='reconnect' then
      if l.state<>'prepared' then raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
      if l.expires_at>clock_timestamp() then
        return jsonb_build_object('status','waiting','operation','reconnect','attempt_id',l.id,'expires_at',l.expires_at,'execution_permitted',false);
      end if;
      select * into fresh from clued_private.storage_connections_v1 where id=l.new_connection_id and owner_id=u for update;
      if fresh.id is null or fresh.account_policy_id is not null or fresh.auth_mode<>'legacy' or fresh.revoked_at is not null then
        raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
      r:=clued_private.storage_onboard_receipt_v1(u,'storage_owner_reconnect_expired',
        jsonb_build_object('idempotency_key','storage-reconnect-expired:'||l.id,'attempt_id',l.id,'replacement_id',fresh.id));
      update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),auth_mode='revoked',
        auth_generation=auth_generation+1,version=version+1,receipt_id=r.id where id=fresh.id;
      insert into clued_private.storage_owner_connection_hidden_v1(connection_id,owner_id,receipt_id) values(fresh.id,u,r.id);
      perform clued_private.storage_onboard_finish_v1(u,r,p.project_id,'extension:storage:owner_reconnect_expired',fresh.id,
        jsonb_build_object('attempt_id',l.id,'replacement_id',fresh.id),'{}'::jsonb,'{}'::jsonb);
      update clued_private.storage_owner_lifecycle_v1 set state='completed',
        result=jsonb_build_object('status','cancelled','attempt_id',l.id,'execution_permitted',false) where id=l.id;
      return jsonb_build_object('status','cancelled','attempt_id',l.id,'execution_permitted',false);
    end if;
    if l.state='prepared' and l.expires_at<=clock_timestamp() then
      -- A durable start never occurred: prove that exact state under the
      -- Root lock and release only this reservation. Unknown started effects
      -- remain fenced forever until a provider observation resolves them.
      update clued_private.resource_center_mutations_v1 set state='cancelled',version=version+1,
        final_result=jsonb_build_object('outcome','released_not_started') where id=l.intent_id and state='prepared';
      update clued_private.storage_owner_lifecycle_v1 set state='completed',admission=null,
        result=jsonb_build_object('status','cancelled','attempt_id',l.id,'execution_permitted',false) where id=l.id;
      return jsonb_build_object('status','cancelled','attempt_id',l.id,'execution_permitted',false);
    end if;
    if l.intent_id is null then return jsonb_build_object('status',l.state,'attempt_id',l.id,'execution_permitted',false); end if;
    -- Recovery is GET only and may read the same still-current envelope after
    -- admission TTL. It cannot hand out or recreate an execution admission.
    perform clued_private.storage_connection_current_v1(c.id,u);
    return jsonb_build_object('status',l.state,'attempt_id',l.id,'execution_permitted',false,'snapshot',l.confirmation->'snapshot',
      'descriptor',jsonb_build_object('owner_id',u,'connection_id',c.id,'connection_version',c.version,'profile_id',p.id,'profile_version',p.version,
        'credential_version',c.credential_version,'credential_envelope',c.credential_envelope,'provider_subject',c.provider_subject,
        'oauth_client_id',c.oauth_client_id,'root_folder_id',root,'root_parent_id',p.root_parent_id,'created_by_clued',true));
  end if;
  if op='delete_observe' then
    if (p_input-array['action','attempt_id','outcome','root_folder_id','root_version'])<>'{}'::jsonb
      or l.state not in ('started','uncertain') or p_input->>'root_folder_id' is distinct from root
      or coalesce(p_input->>'outcome','') not in ('trashed','uncertain','kept') then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    if p_input->>'outcome'='uncertain' then
      update clued_private.storage_owner_lifecycle_v1 set state='uncertain',admission=null where id=l.id;
      update clued_private.resource_center_mutations_v1 set state='uncertain',version=version+1 where id=l.intent_id;
      return jsonb_build_object('status','uncertain','attempt_id',l.id,'execution_permitted',false);
    end if;
    if (l.intent_id is null) is distinct from (p_input->>'outcome'='kept')
      or (l.intent_id is not null and coalesce(p_input->>'root_version','') !~ '^[0-9]{1,30}$') then
      raise exception 'storage_owner_lifecycle_denied' using errcode='42501'; end if;
    -- Logical hide retains every connection/policy/credential/audit row. An
    -- active account-policy connection is first disconnected by the existing
    -- Native operation; its Root stop and delegation revocation stay intact.
    r:=clued_private.storage_onboard_receipt_v1(u,'storage_owner_hidden',jsonb_build_object('idempotency_key','owner-delete-hidden:'||l.id,
      'attempt_id',l.id,'connection_id',c.id,'root_folder_id',root,'outcome',p_input->>'outcome'));
    -- Close only this lifecycle under the SAME Root lock/transaction before
    -- invoking the existing Native disconnect. Another session sees no window:
    -- it waits for the lock and then sees either the final state or rollback.
    update clued_private.storage_owner_lifecycle_v1 set state='completed',admission=null where id=l.id;
    if c.revoked_at is null then
      select * into policy from clued_private.storage_account_policies_v2 where id=c.account_policy_id and connection_id=c.id and owner_id=u for update;
      if c.auth_mode='account_policy' and c.state in ('active','reauthorization_required') and policy.state='active' then
        perform public.clued_storage_owner_manage_v2(jsonb_build_object('action','disconnect','connection_id',c.id,
          'base_version',c.version,'idempotency_key','owner-delete-disconnect:'||l.id));
      else
        -- Awaiting-provider and legacy connections have no live account policy
        -- for the old API to disconnect. Retire them in this confirmed Native
        -- transaction, with the same stop/delegation semantics where identity
        -- exists. Never open their old credential or resurrect a policy.
        if c.provider_subject is not null then
          if stop.id is null then
            insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,denied,receipt_id)
              values(u,c.provider,c.provider_subject,root,true,r.id);
          elsif not stop.denied then
            update clued_private.storage_root_denies_v2 set denied=true,generation=generation+1,receipt_id=r.id where id=stop.id;
          end if;
        end if;
        update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=r.id
          where connection_id=c.id and owner_id=u and state<>'revoked';
        update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),auth_mode='revoked',
          auth_generation=auth_generation+1,version=version+1,receipt_id=r.id where id=c.id;
        update clued_private.storage_refresh_delegations_v1 set enabled=false,version=version+1,receipt_id=r.id where connection_id=c.id;
      end if;
    end if;
    insert into clued_private.storage_owner_connection_hidden_v1(connection_id,owner_id,receipt_id) values(c.id,u,r.id);
    if l.intent_id is not null then
      update clued_private.resource_center_mutations_v1 set state='committed',version=version+1,
        final_result=jsonb_build_object('outcome','root_trashed','provider_file_version',p_input->>'root_version') where id=l.intent_id;
      -- Registry root is now unavailable, not physically erased. Old Decision,
      -- Project, artifacts and audit remain. Profile revocation blocks reuse.
      update clued_private.resource_center_profiles_v1 set state='revoked',version=version+1 where id=p.id;
    end if;
    perform clued_private.storage_onboard_finish_v1(u,r,p.project_id,'extension:storage:owner_connection_hidden',c.id,
      jsonb_build_object('attempt_id',l.id,'root_folder_id',root,'outcome',p_input->>'outcome'),'{}'::jsonb,'{}'::jsonb);
    answer:=jsonb_build_object('status','completed','receipt_id',r.id,'attempt_id',l.id,'connection_id',c.id,'root_trashed',l.intent_id is not null);
    update clued_private.storage_owner_lifecycle_v1 x set state='completed',admission=null,result=answer where x.id=l.id;
    perform clued_private.storage_owner_v1();
    return answer;
  end if;
  raise exception 'storage_owner_lifecycle_denied' using errcode='42501';
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'storage_owner_lifecycle_denied' using errcode='42501';
end $$;
revoke all on function public.clued_storage_owner_lifecycle_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_storage_owner_lifecycle_v1(text,jsonb) to authenticated;
notify pgrst,'reload schema';

-- Owner discovery also hides terminal logical deletions. Preserve its business
-- implementation verbatim outside this one exact list predicate. No row is
-- deleted and the historical ID remains available for audit lookup.
do $hide_owner_list$
declare s text; definition text;
  old_anchor constant text:=$a$      where co.owner_id=u),'[]'::jsonb));$a$;
  new_anchor constant text:=$a$      where co.owner_id=u and not exists(select 1 from clued_private.storage_owner_connection_hidden_v1 h
        where h.connection_id=co.id) and not exists(select 1 from clued_private.storage_owner_lifecycle_v1 lp
          where lp.new_connection_id=co.id and (lp.state<>'completed' or lp.result->>'status' is distinct from 'completed'))),'[]'::jsonb));$a$;
  disconnect_anchor constant text:=$a$    perform clued_private.authorization_account_v12(u);$a$;
  guarded_disconnect constant text:=$a$    perform clued_private.authorization_account_v12(u);
    if exists(select 1 from clued_private.storage_owner_lifecycle_v1 pending
      where pending.owner_id=u and pending.root_folder_id=root and pending.state in ('prepared','started','uncertain')) then
      raise exception 'storage_owner_lifecycle_pending' using errcode='42501'; end if;$a$;
begin
  select pg_catalog.pg_get_functiondef('public.clued_storage_owner_manage_v2(jsonb)'::regprocedure) into definition;
  if (length(definition)-length(replace(definition,old_anchor,'')))/length(old_anchor)<>1 then
    raise exception 'storage_owner_lifecycle_owner_list_drift' using errcode='42501'; end if;
  if (length(definition)-length(replace(definition,disconnect_anchor,'')))/length(disconnect_anchor)<>1 then
    raise exception 'storage_owner_lifecycle_disconnect_drift' using errcode='42501'; end if;
  s:=replace(replace(definition,old_anchor,new_anchor),disconnect_anchor,guarded_disconnect); execute s;
end $hide_owner_list$;
