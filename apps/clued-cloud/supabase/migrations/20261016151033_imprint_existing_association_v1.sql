-- Task d5dee826, Step 3: owner reading pointers, never execution relations.
alter table clued_private.imprint_organization_v1
  add column associations jsonb not null default '[]' check(jsonb_typeof(associations)='array'),
  add column association_version bigint not null default 0 check(association_version>=0),
  add column association_receipt_id uuid references public.clued_audit_receipts(id);
alter table clued_private.imprint_development_organization_v1
  add column associations jsonb not null default '[]' check(jsonb_typeof(associations)='array'),
  add column association_version bigint not null default 0 check(association_version>=0),
  add column association_receipt_id uuid references public.clued_audit_receipts(id);

create function clued_private.imprint_association_projection_v1(p_owner uuid,p_kind text,p_id uuid,p_scope text,p_context uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare refs jsonb; av bigint; visible jsonb; n bigint;
begin
  if p_kind='development' then
    select o.associations,o.association_version into refs,av from clued_private.imprint_development_organization_v1 o
      where o.user_id=p_owner and o.record_id=p_id and o.context_id=p_context;
  else
    select o.associations,o.association_version into refs,av from clued_private.imprint_organization_v1 o
      where o.user_id=p_owner and o.record_id=p_id;
  end if;
  refs:=coalesce(refs,'[]'); av:=coalesce(av,0);
  select coalesce(jsonb_agg(jsonb_build_object('record_id',m.id,'record_version',(r->>'version')::bigint,
      'current_version',m.version,'source_kind','canonical','record_type',m.record_type,'title',m.title)
      order by m.id),'[]'),count(*) into visible,n
    from jsonb_array_elements(refs) r join public.clued_memories m on m.id=(r->>'record_id')::uuid
      and m.user_id=p_owner and m.record_schema_version=1 and m.lifecycle_status='active'
      and m.record_type in ('task','decision') and clued_private.imprint_record_scope_v1(m)=p_scope
    where clued_private.imprint_record_currentness_v1(p_owner,m,clued_private.imprint_owner_scopes_v1(p_owner))='CURRENT';
  return jsonb_build_object('associations',visible,'association_version',av,
    'association_unavailable_count',jsonb_array_length(refs)-n);
end $$;

-- Preserve the actual qualified selection/coverage implementation, including
-- its currentness transport. Old public aliases cease to be callable APIs.
alter function public.clued_imprint_read_v1(jsonb) rename to clued_imprint_read_before_associations_v1;
alter function public.clued_development_imprint_read_v1(jsonb) rename to clued_development_imprint_read_before_associations_v1;
revoke all on function public.clued_imprint_read_before_associations_v1(jsonb),
  public.clued_development_imprint_read_before_associations_v1(jsonb) from public,anon,authenticated,service_role;

create function public.clued_imprint_read_v1(p_input jsonb default '{}')
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); result jsonb;
begin
  result:=public.clued_imprint_read_before_associations_v1(p_input);
  if result->>'status'='ok' and jsonb_typeof(result->'records')='array' then
    result:=jsonb_set(result,'{records}',coalesce((select jsonb_agg(r||clued_private.imprint_association_projection_v1(
      owner_id,'canonical',(r->>'id')::uuid,r->>'scope',null) order by ord)
      from jsonb_array_elements(result->'records') with ordinality rows(r,ord)),'[]'));
  end if;
  return result;
end $$;

create function public.clued_development_imprint_read_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); result jsonb;
begin
  result:=public.clued_development_imprint_read_before_associations_v1(p_input);
  if result->>'status'='ok' and jsonb_typeof(result->'records')='array' then
    result:=jsonb_set(result,'{records}',coalesce((select jsonb_agg(r||clued_private.imprint_association_projection_v1(
      owner_id,r->>'source_kind',(r->>'id')::uuid,r->>'scope',(p_input->>'context_id')::uuid) order by ord)
      from jsonb_array_elements(result->'records') with ordinality rows(r,ord)),'[]'));
  end if;
  return result;
end $$;

create function public.clued_imprint_association_set_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); s public.clued_memories%rowtype;
  target public.clued_memories%rowtype; raw clued_private.development_records_v14%rowtype;
  space clued_private.development_spaces_v14%rowtype; receipt public.clued_audit_receipts%rowtype;
  sid uuid; tid uuid; cid uuid; kind text; scope_key text; base bigint; current_base bigint;
  links jsonb; next_links jsonb; snapshot jsonb; ref text; refs jsonb; result jsonb; event_id text;
  message text; state text; changed boolean;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('record_id','record_version','base_version','source_kind','context_id','environment','target_id','target_version','action','idempotency_key'))
    or jsonb_typeof(p_input->'record_id') is distinct from 'string' or (p_input->>'record_id') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_input->'target_id') is distinct from 'string' or (p_input->>'target_id') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_input->'record_version') is distinct from 'number' or (p_input->>'record_version') !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_input->'base_version') is distinct from 'number' or (p_input->>'base_version') !~ '^[0-9]{1,18}$'
    or coalesce(p_input->>'source_kind','') not in ('canonical','development')
    or coalesce(p_input->>'action','') not in ('add','remove')
    or (p_input->>'action'='add' and (jsonb_typeof(p_input->'target_version') is distinct from 'number'
      or (p_input->>'target_version') !~ '^[1-9][0-9]{0,17}$'))
    or (p_input->>'action'='remove' and p_input ? 'target_version')
    or (p_input ? 'context_id' and (jsonb_typeof(p_input->'context_id') is distinct from 'string'
      or (p_input->>'context_id') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'))
    or (p_input ? 'environment' and (not(p_input ? 'context_id') or jsonb_typeof(p_input->'environment') is distinct from 'string'))
    or (p_input->>'source_kind'='development' and not(p_input ? 'context_id'))
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string' or char_length(p_input->>'idempotency_key') not between 8 and 160
    or coalesce(p_received_payload_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'imprint_association_input_invalid' using errcode='22023';
  end if;
  sid:=(p_input->>'record_id')::uuid; tid:=(p_input->>'target_id')::uuid;
  cid:=(p_input->>'context_id')::uuid; kind:=p_input->>'source_kind'; base:=(p_input->>'base_version')::bigint;
  -- The authorization writer guard precedes all Context/record locks, matching
  -- the existing permission/Core writer serialization contract.
  perform clued_private.authorization_writer_guard_v2(owner_id);
  if cid is not null then space:=clued_private.imprint_development_space_v1(owner_id,cid,p_input->>'environment'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text||':imprint_association:'||btrim(p_input->>'idempotency_key'),0));
  -- Authenticate source access before exposing even a settled retry receipt.
  if kind='development' then
    select * into raw from clued_private.development_records_v14 r where r.id=sid and r.context_id=cid for update;
    if not found then raise exception 'association_source_unavailable' using errcode='42501'; end if;
    scope_key:='project:'||space.project_id::text;
  else
    -- A->B and B->A lock the same rows in the same order.
    perform 1 from public.clued_memories m where m.user_id=owner_id and m.id=any(array[sid,tid]) order by m.id for update;
    select * into s from public.clued_memories m where m.id=sid and m.user_id=owner_id
      and clued_private.imprint_record_scope_v1(m)=any(clued_private.imprint_owner_scopes_v1(owner_id));
    if not found or (cid is not null and s.project_id is distinct from space.project_id) then
      raise exception 'association_source_unavailable' using errcode='42501'; end if;
    scope_key:=clued_private.imprint_record_scope_v1(s);
  end if;
  receipt:=clued_private.m1_begin_receipt(owner_id,null,'imprint_association',p_input,p_received_payload_hash);
  if receipt.status<>'pending' then
    return coalesce(receipt.canonical_result,clued_private.m1_result_envelope(receipt))
      ||jsonb_build_object('replayed',receipt.related_receipt_id is null)
      ||case when receipt.metadata ? 'association' then jsonb_build_object('supplemental',jsonb_build_object('association',receipt.metadata->'association')) else '{}'::jsonb end;
  end if;
  begin
    if kind='development' then
      if raw.version<>(p_input->>'record_version')::bigint then raise exception 'record_version_conflict' using errcode='40001'; end if;
      if raw.lifecycle_status is distinct from 'ACTIVE' or raw.valid_until<clock_timestamp() then raise exception 'association_source_unavailable' using errcode='42501'; end if;
    else
      if s.version<>(p_input->>'record_version')::bigint then raise exception 'record_version_conflict' using errcode='40001'; end if;
      if s.record_schema_version is distinct from 1 or s.lifecycle_status is distinct from 'active'
        or clued_private.imprint_record_currentness_v1(owner_id,s,clued_private.imprint_owner_scopes_v1(owner_id)) is distinct from 'CURRENT' then
        raise exception 'association_source_unavailable' using errcode='42501'; end if;
      if sid=tid then raise exception 'association_target_unavailable' using errcode='42501'; end if;
    end if;
    if p_input->>'action'='add' then
      select * into target from public.clued_memories m where m.id=tid and m.user_id=owner_id for update;
      if not found or target.record_schema_version is distinct from 1 or target.lifecycle_status is distinct from 'active'
        or coalesce(target.record_type,'') not in ('task','decision') or clued_private.imprint_record_scope_v1(target) is distinct from scope_key
        or clued_private.imprint_record_currentness_v1(owner_id,target,clued_private.imprint_owner_scopes_v1(owner_id)) is distinct from 'CURRENT' then
        raise exception 'association_target_unavailable' using errcode='42501'; end if;
      if target.version<>(p_input->>'target_version')::bigint then raise exception 'record_version_conflict' using errcode='40001'; end if;
    end if;
    if kind='development' then
      select o.associations,o.association_version into links,current_base from clued_private.imprint_development_organization_v1 o
        where o.user_id=owner_id and o.record_id=sid and o.context_id=cid for update;
    else
      select o.associations,o.association_version into links,current_base from clued_private.imprint_organization_v1 o
        where o.user_id=owner_id and o.record_id=sid for update;
    end if;
    links:=coalesce(links,'[]'); current_base:=coalesce(current_base,0);
    if current_base<>base then raise exception 'association_version_conflict' using errcode='40001'; end if;
    next_links:=links;
    if p_input->>'action'='add' and not exists(select 1 from jsonb_array_elements(links) r where r->>'record_id'=tid::text) then
      if jsonb_array_length(links)>=20 then raise exception 'association_limit_reached' using errcode='22023'; end if;
      select jsonb_agg(r order by r->>'record_id') into next_links from jsonb_array_elements(
        links||jsonb_build_array(jsonb_build_object('record_id',tid,'version',target.version))) r;
    elsif p_input->>'action'='remove' then
      select coalesce(jsonb_agg(r order by r->>'record_id'),'[]') into next_links from jsonb_array_elements(links) r where r->>'record_id'<>tid::text;
    end if;
    changed:=next_links is distinct from links;
    if changed and kind='development' then
      insert into clued_private.imprint_development_organization_v1(user_id,context_id,record_id,domains,version,receipt_id,associations,association_version,association_receipt_id)
        values(owner_id,cid,sid,'{}',1,receipt.id,next_links,base+1,receipt.id)
        on conflict(user_id,record_id) do update set associations=excluded.associations,
          association_version=excluded.association_version,association_receipt_id=excluded.association_receipt_id;
    elsif changed then
      insert into clued_private.imprint_organization_v1(user_id,record_id,domains,version,receipt_id,associations,association_version,association_receipt_id)
        values(owner_id,sid,'{}',1,receipt.id,next_links,base+1,receipt.id)
        on conflict(user_id,record_id) do update set associations=excluded.associations,
          association_version=excluded.association_version,association_receipt_id=excluded.association_receipt_id;
    end if;
    snapshot:=jsonb_build_object('record_id',sid,'source_kind',kind,'version',base+case when changed then 1 else 0 end,'changed',changed);
    update public.clued_audit_receipts set metadata=metadata||jsonb_build_object('association',snapshot) where id=receipt.id and status='pending';
    ref:='imprint_association:'||kind||':'||sid::text;
    refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id',ref));
    if changed then
      event_id:=clued_private.m1_append_event_row(owner_id,null,receipt.id,receipt.canonical_version,
        'extension:imprint:association_updated',refs,scope_key,null,jsonb_build_object('association',snapshot),
        'imprint-association:'||receipt.id::text,receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    end if;
    result:=clued_private.m1_finish_receipt(receipt.id,'committed',refs,jsonb_build_object(ref,base),
      jsonb_build_object(ref,snapshot->'version'),case when changed then array[event_id] else '{}'::text[] end,'{}'::uuid[],null);
    return result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('association',snapshot));
  exception when others then
    get stacked diagnostics message=message_text,state=returned_sqlstate;
    return clued_private.m1_finish_receipt(receipt.id,case when state in ('22023','40001','42501','P0002') then 'rejected' else 'failed' end,
      '[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::text[],'{}'::uuid[],message)||jsonb_build_object('replayed',false);
  end;
end $$;

revoke all on function clued_private.imprint_association_projection_v1(uuid,text,uuid,text,uuid),
  public.clued_imprint_read_v1(jsonb),public.clued_development_imprint_read_v1(jsonb),
  public.clued_imprint_association_set_v1(jsonb,text) from public,anon,authenticated,service_role;
do $acl$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='clued_worker_gateway') then
    revoke all on function clued_private.imprint_association_projection_v1(uuid,text,uuid,text,uuid),
      public.clued_imprint_read_before_associations_v1(jsonb),public.clued_development_imprint_read_before_associations_v1(jsonb),
      public.clued_imprint_read_v1(jsonb),public.clued_development_imprint_read_v1(jsonb),
      public.clued_imprint_association_set_v1(jsonb,text) from clued_worker_gateway;
  end if;
end $acl$;
grant execute on function public.clued_imprint_read_v1(jsonb),public.clued_development_imprint_read_v1(jsonb),
  public.clued_imprint_association_set_v1(jsonb,text) to authenticated;
notify pgrst,'reload schema';
