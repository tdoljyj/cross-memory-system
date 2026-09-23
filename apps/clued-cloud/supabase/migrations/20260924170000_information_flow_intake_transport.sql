-- Information Flow M0-D slice S2: intake and knowledge-proposal transport.
-- Contract: development/contracts/information-flow/M0DCloseout.v0.1.md (frozen,
-- Decision 825aa822-7cb2-4239-a3a1-0989200ef068), sections 4.3.3, 5.1, 5.2, 6.1.
--
-- Adds the Candidate Knowledge proposal RPC, a fail-closed Context Pack entry
-- (the Policy/Compiler arrive in S4), a database-side payload cap on the intake
-- entries, knowledge listing, and the delegated OAuth dispatch for the five
-- Information Flow MCP tools. Nothing here creates or changes a Canonical
-- Record; the M1 receipt core and m1_append_event_row are reused, not forked.

-- human_confirmed (contract 6.3) is true only from a positive marker for the
-- exact Record version. The marker tables arrive in S3, which replaces this
-- function; until then every source reads false and proposals fail closed.
create function clued_private.record_human_confirmed_v1(p_user_id uuid,p_record_id uuid,p_version bigint)
returns boolean language sql stable security definer set search_path='' as $$
  select false
$$;

-- Same ceiling as the Worker transport (MAX_JSON_BYTES), enforced again here
-- because the Binding entries are also reachable through PostgREST directly.
create function clued_private.intake_payload_cap_v1(p_input jsonb)
returns void language plpgsql immutable security definer set search_path='' as $$
begin
  if octet_length(convert_to(coalesce(p_input,'null'::jsonb)::text,'UTF8'))>1048576 then
    raise exception 'intake_payload_too_large' using errcode='54000';
  end if;
end $$;

-- Explicit, deterministic Candidate Knowledge proposal (contract 5.1): no rule
-- engine, no model. The route fixes tier, source_kind and binding.
create function clued_private.knowledge_propose_core_v1(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_scope text:=p_input->>'scope';
  v_rule text:=p_input->>'rule_id'; v_sources jsonb:=p_input->'sources';
  v_evidence jsonb:=coalesce(p_input->'evidence_ids','[]'::jsonb);
  v_kind text:=case when p_binding_id is null then 'native_ui' else 'agent_binding' end;
  v_read_scopes text[]; v_src jsonb; v_rec public.clued_memories%rowtype; v_seen uuid[]:='{}';
  v_normalized jsonb:='[]'; v_ev uuid[]:='{}'; v_x jsonb; v_digest text; v_id uuid; v_refs jsonb;
  v_event_id text; v_result jsonb; v_error text; v_state text;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'knowledge_propose',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k
        where k not in ('idempotency_key','request_hash','scope','rule_id','assertion','sources','evidence_ids')) then
      raise exception 'knowledge_unknown_field' using errcode='22023';
    end if;
    if v_scope is null or not (v_scope in ('profile','global') or v_scope ~ '^project:[0-9a-f-]{36}$') then
      raise exception 'invalid_scope' using errcode='22023';
    end if;
    if v_scope like 'project:%' then
      v_scope:='project:'||clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(v_scope));
    end if;
    if v_rule is null or v_rule not in ('knowledge.consolidate.v1','knowledge.dedup.v1','knowledge.cross_record_fact.v1') then
      raise exception 'invalid_rule_id' using errcode='22023';
    end if;
    if not clued_private.intake_is_str_v1(p_input->'assertion',1,2000) then
      raise exception 'invalid_assertion' using errcode='22023';
    end if;
    if jsonb_typeof(v_sources) is distinct from 'array' or jsonb_array_length(v_sources) not between 1 and 20 then
      raise exception 'invalid_sources' using errcode='22023';
    end if;
    if jsonb_typeof(v_evidence)<>'array' or jsonb_array_length(v_evidence)>20 then
      raise exception 'invalid_evidence_ids' using errcode='22023';
    end if;
    for v_x in select value from jsonb_array_elements(v_evidence) loop
      if jsonb_typeof(v_x)<>'string'
        or (v_x#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'invalid_evidence_ids' using errcode='22023';
      end if;
      if (v_x#>>'{}')::uuid=any(v_ev) then raise exception 'invalid_evidence_ids' using errcode='22023'; end if;
      if not exists(select 1 from public.clued_evidence e where e.user_id=p_user_id and e.id=(v_x#>>'{}')::uuid) then
        raise exception 'knowledge_evidence_not_found' using errcode='P0002';
      end if;
      v_ev:=array_append(v_ev,(v_x#>>'{}')::uuid);
    end loop;
    -- A Binding may cite only Records its read authorization covers; the
    -- Native owner reads every scope (null = unrestricted, as in Currentness).
    v_read_scopes:=case when p_binding_id is null then null
      else clued_private.binding_read_scopes_v2(p_user_id,p_binding_id) end;
    for v_src in select value from jsonb_array_elements(v_sources) loop
      if not clued_private.intake_keys_exact_v1(v_src,'["id","version"]')
        or jsonb_typeof(v_src->'id')<>'string'
        or (v_src->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(v_src->'version')<>'number' or (v_src->>'version') !~ '^[1-9][0-9]{0,8}$' then
        raise exception 'invalid_sources' using errcode='22023';
      end if;
      if (v_src->>'id')::uuid=any(v_seen) then raise exception 'invalid_sources' using errcode='22023'; end if;
      v_seen:=array_append(v_seen,(v_src->>'id')::uuid);
      select * into v_rec from public.clued_memories m where m.user_id=p_user_id and m.id=(v_src->>'id')::uuid;
      if not found or (v_read_scopes is not null and not (v_rec.canonical_scope=any(v_read_scopes))) then
        raise exception 'knowledge_source_not_found' using errcode='P0002';
      end if;
      if v_rec.version<>(v_src->>'version')::integer then
        raise exception 'knowledge_source_version_mismatch' using errcode='40001';
      end if;
      if (v_rec.record_type in ('state','task','decision')
          and clued_private.record_currentness_fence(p_user_id,v_rec.id,v_read_scopes)<>'CURRENT')
        or (v_rec.record_type not in ('state','task','decision') and v_rec.lifecycle_status<>'active') then
        raise exception 'knowledge_source_not_current' using errcode='55000';
      end if;
      if not clued_private.record_human_confirmed_v1(p_user_id,v_rec.id,v_rec.version) then
        raise exception 'knowledge_source_not_human_confirmed' using errcode='42501';
      end if;
      v_normalized:=v_normalized||jsonb_build_object('id',v_rec.id,'version',v_rec.version);
    end loop;
    v_digest:=clued_private.m1_sha256(jsonb_build_object('scope',v_scope,'rule_id',v_rule,
      'assertion',p_input->'assertion','sources',v_normalized,'evidence_ids',to_jsonb(v_ev)));
    -- Contract 4.3.4: a rejected Candidate is never silently re-proposed.
    if exists(select 1 from clued_private.knowledge_candidates k
        where k.user_id=p_user_id and k.input_digest=v_digest and k.status='rejected') then
      raise exception 'knowledge_previously_rejected' using errcode='55000';
    end if;
    insert into clued_private.knowledge_candidates(
      user_id,scope,rule_id,assertion,sources,source_kind,binding_id,evidence_ids,input_digest,
      idempotency_key,created_receipt_id,last_receipt_id)
    values(p_user_id,v_scope,v_rule,p_input->>'assertion',v_normalized,v_kind,p_binding_id,v_ev,v_digest,
      p_input->>'idempotency_key',v_receipt.id,v_receipt.id)
    returning id into v_id;
    insert into clued_private.candidate_transitions(
      user_id,candidate_tier,candidate_id,from_status,to_status,from_version,to_version,actor,binding_id,receipt_id)
    values(p_user_id,'knowledge',v_id,null,'pending',null,1,v_kind,p_binding_id,v_receipt.id);
    -- System refs only: Record refs on an Event can reach Currentness, and
    -- this audit Event must not touch the sources it cites.
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id','knowledge_candidate:'||v_id))
      ||coalesce((select jsonb_agg(jsonb_build_object('role','evidence','kind','evidence','id',e::text))
        from unnest(v_ev) e),'[]'::jsonb);
    v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,
      'extension:information_flow:knowledge_proposed',v_refs,v_scope,null,
      jsonb_build_object('candidate_id',v_id,'rule_id',v_rule,'sources',v_normalized,
        'source_kind',v_kind,'input_digest',v_digest),
      'knowledge_propose:'||(p_input->>'idempotency_key'),v_receipt.request_sha256,'success','audit_only',v_ev,'[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,'{}','{}',array[v_event_id],v_ev,null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object(
      'candidate_id',v_id,'tier','knowledge','status','pending','version',1,'input_digest',v_digest,
      'authority','none','authoritative',false));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,
      case when v_state in ('22023','23505','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

-- List own candidates of one tier. Replaces the S1 body: adds tier=knowledge
-- and rejects unknown query fields; the information listing is unchanged.
create or replace function clued_private.intake_list_core_v1(p_user_id uuid,p_binding_id uuid,p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_status text:=p_input->>'status'; v_limit integer; v_scope text:=coalesce(p_input->>'scope','global');
  v_submission uuid; v_tier text:=coalesce(p_input->>'tier','information');
begin
  if exists(select 1 from jsonb_object_keys(p_input) k
      where k not in ('status','limit','scope','submission_id','tier')) then
    raise exception 'intake_list_unknown_field' using errcode='22023';
  end if;
  if v_tier not in ('information','knowledge') then raise exception 'invalid_tier' using errcode='22023'; end if;
  if coalesce(p_input->>'limit','50') !~ '^[0-9]{1,3}$' then raise exception 'invalid_limit' using errcode='22023'; end if;
  v_limit:=coalesce(p_input->>'limit','50')::integer;
  if p_input ? 'submission_id' then
    if v_tier<>'information'
      or coalesce(p_input->>'submission_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_submission_id' using errcode='22023';
    end if;
    v_submission:=(p_input->>'submission_id')::uuid;
  end if;
  if v_scope like 'project:%' then
    v_scope:='project:'||clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(v_scope));
  end if;
  if v_status is not null and v_status not in ('pending','promoted','rejected','conflict','withdrawn','expired') then
    raise exception 'invalid_status' using errcode='22023';
  end if;
  if v_limit not between 1 and 200 then raise exception 'invalid_limit' using errcode='22023'; end if;
  if v_tier='knowledge' then
    return jsonb_build_object('status','ok','tier','knowledge','candidates',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',k.id,'scope',k.scope,'tier',k.tier,'rule_id',k.rule_id,'assertion',k.assertion,'sources',k.sources,
        'source_kind',k.source_kind,'status',k.status,'version',k.version,'evidence_ids',to_jsonb(k.evidence_ids),
        'input_digest',k.input_digest,'expires_at',k.expires_at,'created_at',k.created_at,
        'authority','none','authoritative',false) order by k.created_at desc,k.id)
      from (select * from clued_private.knowledge_candidates k
        where k.user_id=p_user_id
          and (p_binding_id is null or k.binding_id=p_binding_id)
          and k.scope=v_scope
          and (v_status is null or k.status=v_status)
        order by k.created_at desc,k.id limit v_limit) k),'[]'::jsonb));
  end if;
  return jsonb_build_object('status','ok','candidates',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',c.id,'submission_id',c.submission_id,'scope',c.scope,'tier',c.tier,'candidate_local_id',c.candidate_local_id,'payload',c.payload,
      'source_kind',c.source_kind,'status',c.status,'version',c.version,'evidence_ids',to_jsonb(c.evidence_ids),
      'input_digest',c.input_digest,'expires_at',c.expires_at,'created_at',c.created_at,
      -- Always explicit: a candidate is never current truth.
      'authority','none','authoritative',false) order by c.created_at desc,c.id)
    from (select * from clued_private.information_candidates c
      where c.user_id=p_user_id
        and (p_binding_id is null or c.binding_id=p_binding_id)
        and c.scope=v_scope
        and (v_submission is null or c.submission_id=v_submission)
        and (v_status is null or c.status=v_status)
      order by c.created_at desc,c.id limit v_limit) c),'[]'::jsonb));
end $$;

-- Contract 6.1: compiling without an accepted Context Policy fails closed.
-- No policy can be accepted before S4, so this entry never reads a source.
create function clued_private.context_pack_core_v1(p_user_id uuid,p_binding_id uuid,p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'invalid_context_pack_input' using errcode='22023'; end if;
  return jsonb_build_object('status','rejected','error_code','CONTEXT_POLICY_REQUIRED',
    'authoritative',false,'execution_authorization','NOT_GRANTED','model_extraction','NOT_EVALUATED');
end $$;

revoke all on function clued_private.record_human_confirmed_v1(uuid,uuid,bigint),
  clued_private.intake_payload_cap_v1(jsonb),
  clued_private.knowledge_propose_core_v1(uuid,uuid,jsonb,text),
  clued_private.intake_list_core_v1(uuid,uuid,jsonb),
  clued_private.context_pack_core_v1(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;

-- Intake submit entries gain the payload cap; everything else is unchanged.
create or replace function public.clued_intake_submit(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  return clued_private.intake_submit_core_v1(b.user_id,b.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','intake_submit','payload',p_input)));
end $$;
create or replace function public.clued_user_intake_submit(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  return clued_private.intake_submit_core_v1(clued_private.authorization_owner_v12(),null,p_input,p_received_payload_hash);
end $$;

create function public.clued_knowledge_propose(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  return clued_private.knowledge_propose_core_v1(b.user_id,b.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','knowledge_propose','payload',p_input)));
end $$;
create function public.clued_context_pack(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
  return clued_private.context_pack_core_v1(b.user_id,b.id,coalesce(p_input,'{}'::jsonb));
end $$;
revoke all on function public.clued_knowledge_propose(text,jsonb),public.clued_context_pack(text,jsonb)
  from public,authenticated,service_role;
grant execute on function public.clued_knowledge_propose(text,jsonb),public.clued_context_pack(text,jsonb) to anon;

create function public.clued_user_knowledge_propose(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  return clued_private.knowledge_propose_core_v1(clued_private.authorization_owner_v12(),null,p_input,p_received_payload_hash);
end $$;
create function public.clued_user_context_pack(p_input jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.context_pack_core_v1(clued_private.authorization_owner_v12(),null,coalesce(p_input,'{}'::jsonb))
$$;
revoke all on function public.clued_user_knowledge_propose(jsonb,text),public.clued_user_context_pack(jsonb)
  from public,anon,service_role;
grant execute on function public.clued_user_knowledge_propose(jsonb,text),public.clued_user_context_pack(jsonb)
  to authenticated;

-- Delegated OAuth reaches the same Binding entries as a clued_bnd_ token.
do $migration$
declare body text; anchor text:=$anchor$    else raise exception 'unknown_oauth_tool' using errcode='22023';$anchor$;
begin
  body:=pg_get_functiondef('public.clued_oauth_call(text,jsonb)'::regprocedure);
  if strpos(body,anchor)=0 or strpos(body,'clued_intake_submit')>0 then
    raise exception 'oauth_call_definition_mismatch';
  end if;
  execute replace(body,anchor,$cases$    when 'clued_intake_submit' then return public.clued_intake_submit(v_binding.token_hash,v_input);
    when 'clued_intake_list' then return public.clued_intake_list(v_binding.token_hash,v_input);
    when 'clued_intake_withdraw' then return public.clued_intake_withdraw(v_binding.token_hash,v_input);
    when 'clued_knowledge_propose' then return public.clued_knowledge_propose(v_binding.token_hash,v_input);
    when 'clued_context_pack' then return public.clued_context_pack(v_binding.token_hash,v_input);
$cases$||anchor);
end $migration$;

notify pgrst,'reload schema';
