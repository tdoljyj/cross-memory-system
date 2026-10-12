-- Stage Native demand endpoints without changing public signatures/ACLs or
-- activating idle scheduling. The existing refresh commit remains the journal.
create or replace function clued_private.storage_demand_due_v1(p_identity text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; listed jsonb;
begin
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_identity and revoked_at is null for share;
  if app.issuer_hash is null then raise exception 'storage_demand_denied' using errcode='42501'; end if;
  with candidates as (
    select d.connection_id, job.job_id,
      case when a.connection_id is null or a.credential_version<>c.credential_version then 'observe'
        when job.job_id is not null then 'active'
        else 'keepalive' end wake
    from clued_private.storage_refresh_delegations_v1 d
    join clued_private.storage_connections_v1 c on c.id=d.connection_id
    join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id and p.user_id=c.owner_id
    left join clued_private.storage_refresh_activity_v1 a on a.connection_id=c.id
    left join lateral (select j.job_id from clued_private.storage_jobs_v1 j
      where j.connection_id=c.id and j.owner_id=c.owner_id and j.intent_id is null and j.dispatch_outcome is null
        and j.created_at>clock_timestamp()-interval '2 hours' order by j.created_at,j.job_id limit 1) job on true
    where d.issuer_hash=p_identity and d.enabled and d.failures<3 and c.state='active' and c.revoked_at is null
      and c.oauth_client_id=app.oauth_client_id and p.state='active' and p.version=c.profile_version
      and (d.failures=0 or d.next_refresh_at<=clock_timestamp())
      and not exists(select 1 from clued_private.storage_refresh_attempts_v1 x where x.connection_id=c.id and x.state='claimed')
      and not exists(select 1 from clued_private.resource_center_profiles_v1 bp
        join clued_private.resource_center_mutations_v1 m on m.profile_id=bp.id and m.user_id=c.owner_id
        where bp.root_folder_id=p.root_folder_id and m.state in ('prepared','started','uncertain'))
      and (a.connection_id is null or a.credential_version<>c.credential_version
        or (job.job_id is not null
          and a.credential_expires_at<=clock_timestamp()+interval '5 minutes')
        or greatest(a.last_successful_exchange_at,a.keepalive_anchor_at)<=clock_timestamp()-interval '30 days')
    order by d.last_polled_at nulls first,d.connection_id limit 10 for update of d skip locked
  ), selected as (
    update clued_private.storage_refresh_delegations_v1 d set last_polled_at=clock_timestamp()
      from candidates c where c.connection_id=d.connection_id returning c.connection_id,c.job_id,c.wake
  ) select coalesce(jsonb_agg(jsonb_build_object('connection_id',connection_id,'wake',wake)||
      case when job_id is null then '{}'::jsonb else jsonb_build_object('job_id',job_id) end),'[]'::jsonb) into listed from selected;
  -- A completed read's timestamp never makes an idle connection active. Real
  -- in-flight/unknown journal jobs keep their dedicated recovery-only path;
  -- recurring maintenance obtains demand preflight when its actual work is due.
  -- Hints only. Before an exchange prepare and claim still re-evaluate the
  -- actual job or standing delegation and current root/profile/source/caller.
  return jsonb_build_object('status','ok','connections',listed,'pending_expired',
    (select count(*) from clued_private.storage_refresh_attempts_v1 where issuer_hash=p_identity
      and state='claimed' and expires_at<=clock_timestamp()));
end $$;
revoke all on function clued_private.storage_demand_due_v1(text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function clued_private.storage_demand_proof_current_v1(p_identity text,p_secret text)
returns clued_private.storage_refresh_demand_proofs_v1 language plpgsql volatile security definer set search_path='' as $$
declare proof clued_private.storage_refresh_demand_proofs_v1; c clued_private.storage_connections_v1;
  d clued_private.storage_refresh_delegations_v1;
begin
  if coalesce(p_secret,'') !~ '^clued_srp_[0-9a-f]{64}$' then
    raise exception 'storage_demand_denied' using errcode='42501'; end if;
  select * into proof from clued_private.storage_refresh_demand_proofs_v1
    where proof_hash=encode(sha256(convert_to(p_secret,'UTF8')),'hex') and issuer_hash=p_identity;
  if proof.proof_hash is null or proof.expires_at<=clock_timestamp() then
    raise exception 'storage_demand_denied' using errcode='42501'; end if;
  c:=clued_private.storage_demand_authorize_v1(p_identity,proof.connection_id,proof.caller_kind,
    proof.caller_token_hash,proof.owner_session_id,proof.original_request);
  select * into d from clued_private.storage_refresh_delegations_v1 where connection_id=c.id for share;
  if c.owner_id is distinct from proof.owner_id or c.credential_version is distinct from proof.credential_version
    or coalesce(d.version,0) is distinct from proof.delegation_version then
    raise exception 'storage_demand_stale' using errcode='42501'; end if;
  return proof;
end $$;
revoke all on function clued_private.storage_demand_proof_current_v1(text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function clued_private.storage_demand_observe_v1(p_identity text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare proof clued_private.storage_refresh_demand_proofs_v1; expiry timestamptz;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or (p_input-array['action','proof','credential_version','expires_at'])<>'{}'::jsonb then
    raise exception 'storage_demand_denied' using errcode='42501'; end if;
  begin proof:=clued_private.storage_demand_proof_current_v1(p_identity,p_input->>'proof');
  exception when sqlstate '42501' then
    if sqlerrm='storage_demand_stale' then return jsonb_build_object('status','stale'); end if;
    raise;
  end;
  if proof.credential_version is distinct from (p_input->>'credential_version')::bigint then
    return jsonb_build_object('status','stale'); end if;
  expiry:=(p_input->>'expires_at')::timestamptz;
  if expiry is null or expiry>clock_timestamp()+interval '24 hours' then
    raise exception 'storage_demand_denied' using errcode='42501'; end if;
  insert into clued_private.storage_refresh_activity_v1 as a(connection_id,credential_version,credential_expires_at,last_demand_at)
    values(proof.connection_id,proof.credential_version,expiry,
      case when proof.caller_kind in ('agent_read','job','recovery') then clock_timestamp() end)
    on conflict(connection_id) do update set credential_version=excluded.credential_version,
      credential_expires_at=excluded.credential_expires_at,
      keepalive_anchor_at=case when a.credential_version<>excluded.credential_version then clock_timestamp() else a.keepalive_anchor_at end,
      last_demand_at=coalesce(excluded.last_demand_at,a.last_demand_at),observed_at=clock_timestamp();
  return jsonb_build_object('status','current');
end $$;
revoke all on function clued_private.storage_demand_observe_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Demand claim executes the original Native claim under the same locks. A
-- saved proof supplies a live operation recheck, not cached permission.
-- last successful exchange is updated only by the original committed result.
do $migration$
declare signature text:='clued_private.ii_pub_clued_storage_refresh_worker_v1(text,jsonb)';
  definition text; original text; body_sha text; marker text; catalog record;
begin
  select pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,
    coalesce(array_agg(acl.grantee) filter(where acl.grantee<>p.proowner),'{}'::oid[]) callers,
    encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') source_sha into catalog
    from pg_proc p left join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl on true
    where p.oid=signature::regprocedure group by p.oid;
  if catalog.owner<>'postgres' or not catalog.prosecdef or catalog.proconfig is distinct from array['search_path=""']::text[]
    or cardinality(catalog.callers)<>0 then raise exception 'storage_demand_refresh_catalog_mismatch'; end if;
  body_sha:=catalog.source_sha;
  if body_sha='69a18a60d6cf62e6e9f7a3732b9b69b7fcc715f306c2d4a0fa81fab8f24d7574' then return; end if;
  if body_sha<>'d925287a9b28532744ee58e9f2d9f415892367c10769b012af102cdef09d787b' then
    raise exception 'storage_demand_refresh_source_mismatch'; end if;
  definition:=pg_get_functiondef(signature::regprocedure);original:=definition;
  marker:=$a$begin
  if jsonb_typeof(p_input) is distinct from 'object'$a$;
  if strpos(definition,marker)=0 then raise exception 'storage_demand_refresh_anchor_mismatch'; end if;
  definition:=replace(definition,$a$expiry timestamptz; result jsonb; recovery_job uuid;$a$,
    $r$expiry timestamptz; result jsonb; demand clued_private.storage_refresh_demand_proofs_v1; demand_secret text;
  demand_owner uuid; demand_root text;
  recovery_job uuid;$r$);
  definition:=replace(definition,marker,$r$begin
  if p_input->>'action'='due_demand' then
    if p_input<>jsonb_build_object('action','due_demand') then raise exception 'storage_demand_denied' using errcode='42501'; end if;
    return clued_private.storage_demand_due_v1(p_issuer_identity);
  elsif p_input->>'action'='prepare_credential' then
    if jsonb_typeof(p_input) is distinct from 'object'
      or (p_input-array['action','connection_id','caller_kind','request'])<>'{}'::jsonb
      or coalesce(p_input->>'caller_kind','') not in ('job','recovery','maintenance') then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
    return clued_private.storage_demand_prepare_v1(p_issuer_identity,(p_input->>'connection_id')::uuid,
      p_input->>'caller_kind',null,null,p_input->'request');
  elsif p_input->>'action'='observe_credential' then
    return clued_private.storage_demand_observe_v1(p_issuer_identity,p_input);
  end if;
  demand_secret:=p_input->>'demand_proof';
  if p_input ? 'demand_proof' then
    if coalesce(demand_secret,'') !~ '^clued_srp_[0-9a-f]{64}$' then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
    if p_input->>'action'='claim' then
      demand:=clued_private.storage_demand_proof_current_v1(p_issuer_identity,demand_secret);
      if demand.connection_id::text is distinct from p_input->>'connection_id' then
        raise exception 'storage_demand_denied' using errcode='42501'; end if;
      select co.owner_id,pr.root_folder_id into demand_owner,demand_root
        from clued_private.storage_connections_v1 co join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id
        where co.id=demand.connection_id;
      if demand_root is null then raise exception 'storage_demand_denied' using errcode='42501'; end if;
      -- The read evaluator holds lineage then root S. Never block upgrading S
      -- while another demand also holds S: return a known no-attempt busy result
      -- so the RPC releases S before any bounded claim retry.
      if not pg_try_advisory_xact_lock(hashtextextended(demand_owner::text||':'||demand_root,0)) then
        return jsonb_build_object('status','busy','connection_id',demand.connection_id,'attempt_id',(p_input->>'attempt_id')::uuid);
      end if;
    end if;
    -- The private operational sidecar binds this original claim. Commit/fail
    -- need not replay an expired Agent session or issue a second claim.
    p_input:=p_input-'demand_proof';
  end if;
  if jsonb_typeof(p_input) is distinct from 'object'$r$);
  marker:=$a$if d.failures>=3 or d.next_refresh_at>clock_timestamp() or exists$a$;
  if strpos(definition,marker)=0 then raise exception 'storage_demand_refresh_anchor_mismatch'; end if;
  definition:=replace(definition,marker,$r$if d.failures>=3 or
      (d.next_refresh_at>clock_timestamp() and (demand.proof_hash is null or d.failures>0)) or exists$r$);
  marker:=$a$    insert into clued_private.storage_refresh_attempts_v1(id,connection_id$a$;
  if strpos(definition,marker)=0 then raise exception 'storage_demand_refresh_anchor_mismatch'; end if;
  definition:=replace(definition,marker,$r$    if demand.proof_hash is not null and (demand.credential_version<>c.credential_version
      or demand.delegation_version<>d.version or demand.expires_at<=clock_timestamp()) then
      raise exception 'storage_demand_stale' using errcode='42501'; end if;
    insert into clued_private.storage_refresh_attempts_v1(id,connection_id$r$);
  marker:=$a$    update clued_private.storage_refresh_delegations_v1 set failures=0,next_refresh_at=$a$;
  if strpos(definition,marker)=0 then raise exception 'storage_demand_refresh_anchor_mismatch'; end if;
  definition:=replace(definition,marker,$r$    insert into clued_private.storage_refresh_activity_v1 as activity(connection_id,credential_version,credential_expires_at,last_successful_exchange_at)
      values(c.id,c.credential_version+1,expiry,clock_timestamp())
      on conflict(connection_id) do update set credential_version=excluded.credential_version,
        credential_expires_at=excluded.credential_expires_at,last_successful_exchange_at=excluded.last_successful_exchange_at,
        observed_at=clock_timestamp();
    update clued_private.storage_refresh_delegations_v1 set failures=0,next_refresh_at=$r$);
  if definition=original then raise exception 'storage_demand_refresh_patch_empty'; end if;
  execute definition;
end $migration$;

-- Current live Owner JWT, including session expiry, remains the sole Owner
-- identity. No browser-supplied owner_id or credential bypass is added.
do $migration$
declare definition text; body_sha text; marker text; catalog record;
begin
  select pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl::text acl,
    encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') source_sha into catalog from pg_proc p
    where oid='public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure;
  if catalog.owner<>'postgres' or not catalog.prosecdef or catalog.proconfig is distinct from array['search_path=""']::text[]
    or catalog.acl is distinct from '{postgres=X/postgres,authenticated=X/postgres}' then
    raise exception 'storage_demand_owner_catalog_mismatch'; end if;
  body_sha:=catalog.source_sha;
  if body_sha='e0637d3279d7f1b6bb77f7b12258f2839c51187f8dbe283a030bbbc694c80740' then return; end if;
  if body_sha<>'5507655146cad446408ddb26136a3c8cbeb84b88ee559aa19114b8f3c03a2238' then
    raise exception 'storage_demand_owner_source_mismatch'; end if;
  definition:=pg_get_functiondef('public.clued_storage_owner_lifecycle_v1(text,jsonb)'::regprocedure);
  marker:=$a$  if op='list' and p_input=jsonb_build_object('action','list') then$a$;
  if strpos(definition,marker)=0 then raise exception 'storage_demand_owner_anchor_mismatch'; end if;
  definition:=replace(definition,marker,$r$  if op='prepare_credential' then
    if p_input is distinct from jsonb_build_object('action','prepare_credential','connection_id',p_input->>'connection_id',
      'operation',p_input->>'operation') or coalesce(p_input->>'operation','') not in ('owner_metadata','probe') then
      raise exception 'storage_demand_denied' using errcode='42501'; end if;
    return clued_private.storage_demand_prepare_v1(issuer,(p_input->>'connection_id')::uuid,'owner',null,sid,
      jsonb_build_object('operation',p_input->>'operation'));
  end if;
  if op='list' and p_input=jsonb_build_object('action','list') then$r$);
  execute definition;
end $migration$;

do $migration$
declare definition text; body_sha text; marker text; catalog record;
begin
  select pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,
    coalesce(array_agg(acl.grantee) filter(where acl.grantee<>p.proowner),'{}'::oid[]) callers,
    encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') source_sha into catalog
    from pg_proc p left join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl on true
    where p.oid='clued_private.ii_pub_clued_storage_read_v1(text,text,jsonb)'::regprocedure group by p.oid;
  if catalog.owner<>'postgres' or not catalog.prosecdef or catalog.proconfig is distinct from array['search_path=""']::text[]
    or cardinality(catalog.callers)<>0 then raise exception 'storage_demand_read_catalog_mismatch'; end if;
  body_sha:=catalog.source_sha;
  if body_sha='a152c0f2aa874c9f2699f4dbc9bc4a2d4d1b690664a57e536654c3967fc57e2a' then return; end if;
  if body_sha<>'4c02e9b38b94f86a6d07be9915b4a647985a1868893a59b69b6060a3a11c672b' then
    raise exception 'storage_demand_read_source_mismatch'; end if;
  definition:=pg_get_functiondef('clued_private.ii_pub_clued_storage_read_v1(text,text,jsonb)'::regprocedure);
  marker:=$a$begin
  if coalesce(p_issuer_identity,'')$a$;
  if strpos(definition,marker)=0 then raise exception 'storage_demand_read_anchor_mismatch'; end if;
  definition:=replace(definition,marker,$r$begin
  if p_input->>'action'='prepare_credential' then
    if jsonb_typeof(p_input) is distinct from 'object'
      or (p_input-array['action','connection_id','operation','object_id','condition_hmac','key_id','content_search'])<>'{}'::jsonb
      or (p_input ? 'content_search' and (p_input->'content_search' is distinct from 'true'::jsonb
        or p_input->>'operation' is distinct from 'search' or not (p_input ? 'condition_hmac')))
      or ((p_input ? 'condition_hmac')<>(p_input ? 'key_id'))
      or (p_input ? 'object_id' and coalesce(p_input->>'object_id','') !~ '^[A-Za-z0-9_-]{1,160}$')
      or (p_input ? 'condition_hmac' and (coalesce(p_input->>'condition_hmac','') !~ '^[0-9a-f]{64}$'
        or coalesce(p_input->>'key_id','') !~ '^[A-Za-z0-9._-]{1,64}$'))
      or (p_input->>'operation'='read' and not(p_input ? 'object_id')) then
      raise exception 'storage_read_input_invalid' using errcode='22023'; end if;
    return clued_private.storage_demand_prepare_v1(p_issuer_identity,(p_input->>'connection_id')::uuid,
      'agent_read',p_token_hash,null,p_input-'action');
  end if;
  if coalesce(p_issuer_identity,'')$r$);
  execute definition;
end $migration$;

-- CREATE OR REPLACE preserves every existing public/private ACL. Newly added
-- helpers are revoked above. No flag, delegation or schedule is enabled.
notify pgrst,'reload schema';
