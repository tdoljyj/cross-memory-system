-- Native Owner storage controls. A client revoke is storage-only and follows
-- the immutable registration lineage; a connection disconnect stops its root,
-- current account policy and refresh delegation in one receipt transaction.
create function public.clued_storage_owner_manage_v2(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; refresh clued_private.storage_refresh_delegations_v1;
  root_stop clued_private.storage_root_denies_v2; b public.clued_agent_bindings;
  a clued_private.authorizations_v12; link clued_private.storage_client_request_links_v2;
  deny clued_private.storage_client_denies_v2; lineage uuid; root text;
  r public.clued_audit_receipts; refs jsonb; ev text; result jsonb; expected bigint;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('connections','clients','disconnect','revoke_client') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if op='connections' then
    if p_input<>jsonb_build_object('action','connections') then raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    return jsonb_build_object('connections',coalesce((select jsonb_agg(jsonb_build_object(
      'id',co.id,'version',co.version,'provider',co.provider,'state',co.state,
      'auth_mode',co.auth_mode,'scope_name',pr.profile_version,'root_name',pr.managed_root,
      'policy_active',ap.state='active' and co.state='active' and co.revoked_at is null,
      'actions',case when ap.state='active' then to_jsonb(ap.actions) else '[]'::jsonb end,
      'refresh_enabled',coalesce(d.enabled,false) and co.state='active',
      'database_execution_enabled',(select count(*)=1 and bool_and(app.execution_enabled)
        from clued_private.storage_oauth_apps_v1 app where app.oauth_client_id=co.oauth_client_id and app.revoked_at is null),
      'profile_current',pr.state='active' and pr.version=co.profile_version) order by co.id)
      from clued_private.storage_connections_v1 co
      join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
      left join clued_private.storage_account_policies_v2 ap on ap.id=co.account_policy_id and ap.owner_id=u
      left join clued_private.storage_refresh_delegations_v1 d on d.connection_id=co.id
      where co.owner_id=u),'[]'::jsonb));
  end if;
  if op='clients' then
    if p_input<>jsonb_build_object('action','clients') then raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    return jsonb_build_object('clients',coalesce((select jsonb_agg(jsonb_build_object(
      'binding_id',b0.id,'denied',coalesce(d.denied,false),'generation',coalesce(d.generation,0),
      'receipt_id',d.receipt_id) order by b0.id)
      from public.clued_agent_bindings b0
      join clued_private.authorizations_v12 a0 on a0.binding_id=b0.id and a0.owner_id=u
      join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id
      left join clued_private.storage_client_denies_v2 d on d.owner_id=u and d.lineage_id=l.lineage_id
      where b0.user_id=u),'[]'::jsonb));
  end if;
  if op='disconnect' then
    if (p_input-array['action','connection_id','base_version','idempotency_key'])<>'{}'::jsonb
      or not(p_input ?& array['action','connection_id','base_version','idempotency_key'])
      or p_input->>'connection_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(p_input->'base_version') is distinct from 'number'
      or p_input->>'base_version' !~ '^[1-9][0-9]{0,17}$'
      or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
      or (length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key')) then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    expected:=(p_input->>'base_version')::bigint;
    -- Unlocked resolution yields only the advisory lock key.
    select pr.root_folder_id into root from clued_private.storage_connections_v1 co
      join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
      where co.id=(p_input->>'connection_id')::uuid and co.owner_id=u;
    if root is null then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
    perform clued_private.storage_owner_v1();
    perform clued_private.authorization_account_v12(u);
    select * into c from clued_private.storage_connections_v1
      where id=(p_input->>'connection_id')::uuid and owner_id=u for update;
    select * into policy from clued_private.storage_account_policies_v2
      where id=c.account_policy_id and connection_id=c.id and owner_id=u for update;
    select * into p from clued_private.resource_center_profiles_v1
      where id=c.profile_id and user_id=u for share;
    r:=clued_private.m1_begin_receipt(u,null,'storage_owner_disconnect_v2',p_input,clued_private.m1_sha256(p_input));
    if r.status<>'pending' then
      if c.state='revoked' and c.receipt_id=r.id and policy.revocation_receipt_id=r.id then return r.canonical_result; end if;
      raise exception 'storage_owner_version_conflict' using errcode='40001';
    end if;
    if c.id is null or c.version<>expected or c.auth_mode<>'account_policy'
      or c.state not in ('active','reauthorization_required') or c.revoked_at is not null
      or policy.id is null or policy.state<>'active' or p.root_folder_id is distinct from root then
      raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
    select * into root_stop from clued_private.storage_root_denies_v2
      where owner_id=u and provider=c.provider and provider_subject=c.provider_subject
        and root_folder_id=root and lineage_id is null for update;
    if root_stop.id is null then
      insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,denied,receipt_id)
        values(u,c.provider,c.provider_subject,root,true,r.id);
    elsif not root_stop.denied then
      update clued_private.storage_root_denies_v2 set denied=true,generation=generation+1,receipt_id=r.id where id=root_stop.id;
    end if;
    update clued_private.storage_account_policies_v2
      set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=r.id where id=policy.id;
    update clued_private.storage_connections_v1
      set state='revoked',revoked_at=clock_timestamp(),auth_mode='revoked',auth_generation=auth_generation+1,
        version=version+1,receipt_id=r.id where id=c.id returning * into c;
    select * into refresh from clued_private.storage_refresh_delegations_v1 where connection_id=c.id for update;
    if refresh.connection_id is not null then
      update clued_private.storage_refresh_delegations_v1
        set enabled=false,version=version+1,receipt_id=r.id where connection_id=c.id;
    end if;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
    ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:owner_disconnect_v2',
      refs,'project:'||p.project_id::text,null,jsonb_build_object('connection_id',c.id,'state','revoked'),
      p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    result:=clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(c.id::text,expected),
      jsonb_build_object(c.id::text,c.version),array[ev],'{}'::uuid[],null);
    perform clued_private.storage_owner_v1();
    return result;
  end if;
  if (p_input-array['action','binding_id','base_generation','idempotency_key'])<>'{}'::jsonb
    or not(p_input ?& array['action','binding_id','base_generation','idempotency_key'])
    or p_input->>'binding_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_input->'base_generation') is distinct from 'number'
    or p_input->>'base_generation' !~ '^(0|[1-9][0-9]{0,17})$'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or (length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key')) then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  expected:=(p_input->>'base_generation')::bigint;
  select l.lineage_id into lineage from public.clued_agent_bindings b0
    join clued_private.authorizations_v12 a0 on a0.binding_id=b0.id and a0.owner_id=u
    join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id
    where b0.id=(p_input->>'binding_id')::uuid and b0.user_id=u;
  if lineage is null then raise exception 'storage_owner_denied' using errcode='42501'; end if;
  perform clued_private.storage_client_guard_v2(u,lineage,true);
  perform clued_private.storage_owner_v1();
  select * into b from public.clued_agent_bindings where id=(p_input->>'binding_id')::uuid and user_id=u for share;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=u for share;
  select * into link from clued_private.storage_client_request_links_v2 where request_id=a.request_id;
  if b.id is null or a.binding_id is null or link.lineage_id is distinct from lineage then
    raise exception 'storage_owner_denied' using errcode='42501'; end if;
  select * into deny from clued_private.storage_client_denies_v2 where owner_id=u and lineage_id=lineage for update;
  r:=clued_private.m1_begin_receipt(u,null,'storage_owner_client_revoke_v2',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    if deny.denied and deny.receipt_id=r.id then return r.canonical_result; end if;
    raise exception 'storage_owner_version_conflict' using errcode='40001';
  end if;
  if coalesce(deny.generation,0)<>expected or coalesce(deny.denied,false) then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  if deny.lineage_id is null then
    insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,generation,denied,receipt_id)
      values(u,lineage,1,true,r.id);
  else
    update clued_private.storage_client_denies_v2 set generation=generation+1,denied=true,receipt_id=r.id
      where owner_id=u and lineage_id=lineage;
  end if;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',b.id));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:owner_client_revoke_v2',
    refs,'global',
    null,jsonb_build_object('binding_id',b.id,'storage_only',true,'denied',true),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  perform clued_private.storage_owner_v1();
  return result;
end $$;
revoke all on function public.clued_storage_owner_manage_v2(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_owner_manage_v2(jsonb) to authenticated;
