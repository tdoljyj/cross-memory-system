-- A qualified CI issuer can discover a Task from the authorized source of
-- an attested main merge. Share the ordinary PR resolver's discovery loop
-- so both paths count the same live Tasks across all scopes of the tenant.
create function clued_private.work_claim_pr_discover_tasks_v1(
  p_user uuid,p_repo text,p_pr text,p_head text,p_branch text
) returns uuid[] language plpgsql volatile set search_path='' as $$
declare c clued_private.work_claims_v1; holder public.clued_agent_bindings; task_ids uuid[]:='{}';
begin
  for c in select w.* from clued_private.work_claims_v1 w where w.user_id=p_user
    and w.status='ACTIVE' and w.expires_at>clock_timestamp() and not w.execution_handover_pending
    and w.outcome is distinct from 'not_adopted'
    and (w.copy_index is not null or not exists(select 1 from clued_private.work_claims_v1 n
      where n.user_id=w.user_id and n.task_id=w.task_id and n.fence>w.fence)) loop
    continue when clued_private.work_claim_pr_authorization_v1(c,p_repo,p_pr,p_head,p_branch) is null;
    begin
      perform clued_private.work_claim_task(c.user_id,c.context_key,c.task_id::text);
      select * into holder from public.clued_agent_bindings where id=c.holder_binding_id and user_id=c.user_id;
      perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(holder.token_hash),'context:write',c.context_key);
    exception when insufficient_privilege then continue;
    end;
    if not c.task_id=any(task_ids) then task_ids:=task_ids||c.task_id; end if;
  end loop;
  return task_ids;
end $$;
revoke all on function clued_private.work_claim_pr_discover_tasks_v1(uuid,text,text,text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Both full hashes bind the definitions left by 20261122090000. Each
-- anchor must occur exactly once. CREATE OR REPLACE preserves the ACL.
do $main_merge_unbound_discovery$
declare patch record; definition text; anchor text;
begin
  for patch in select * from (values
    ('clued_private.work_claim_resolve_pr_v1(text,jsonb)'::regprocedure,
     '35970defcc84e05b3c215c5d9e25e891263f27627516750440d0f0a47c037975',
     array[$a$    for c in select w.* from clued_private.work_claims_v1 w where w.user_id=b.user_id
      and w.status='ACTIVE' and w.expires_at>clock_timestamp() and not w.execution_handover_pending
      and w.outcome is distinct from 'not_adopted'
      and (w.copy_index is not null or not exists(select 1 from clued_private.work_claims_v1 n
        where n.user_id=w.user_id and n.task_id=w.task_id and n.fence>w.fence)) loop
      authorized_head:=clued_private.work_claim_pr_authorization_v1(c,repo,pr,head,branch);
      continue when authorized_head is null;
      begin
        perform clued_private.work_claim_task(c.user_id,c.context_key,c.task_id::text);
        select * into holder from public.clued_agent_bindings where id=c.holder_binding_id and user_id=c.user_id;
        perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(holder.token_hash),'context:write',c.context_key);
      exception when insufficient_privilege then continue;
        when others then return v_result||jsonb_build_object('binding_status','conflict','reason','pr_task_authorization_unconfirmed');
      end;
      if not c.task_id=any(task_ids) then task_ids:=task_ids||c.task_id; end if;
    end loop;$a$],
     array[$r$    begin
      task_ids:=clued_private.work_claim_pr_discover_tasks_v1(b.user_id,repo,pr,head,branch);
    exception when others then
      return v_result||jsonb_build_object('binding_status','conflict','reason','pr_task_authorization_unconfirmed');
    end;$r$]),
    ('clued_private.work_claim_carry_main_merge_v1(text,jsonb)'::regprocedure,
     'e761222685995167fd7b6c4e58826945c249ef45a535a64a1c682dfb6e4a32f4',
     array[
       $a$  branch text:=p_input->>'target_branch'; existing uuid; receipt uuid;$a$,
       $a$    or jsonb_typeof(p_input->'scope') is distinct from 'string' or coalesce(wanted,'') !~ '^(global|project:[0-9a-fA-F-]{36})$'$a$,
       $a$  b:=clued_private.resolve_binding(p_token_hash,'context:read',wanted);$a$,
       $a$    where user_id=b.user_id and repo_id=repo and pr_number=number and clued_private.work_claim_pr_binding_open_v1(status);
  if not found then return refuse||jsonb_build_object('error_code','pr_task_binding_unbound'); end if;
  select * into m from public.clued_memories where user_id=b.user_id and id=target.task_id;
  if not found or coalesce(nullif(m.canonical_scope,''),
      case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)<>wanted then
    return refuse||jsonb_build_object('error_code','scope_not_served'); end if;$a$,
       $a$  existing:=clued_private.work_claim_pr_authorization_v1(chosen,repo,pr,head,branch);$a$
     ],
     array[
       $r$  branch text:=p_input->>'target_branch'; actual text; task_ids uuid[]; need_bind boolean:=false;
  existing uuid; receipt uuid;$r$,
       $r$    or (p_input ? 'scope' and (jsonb_typeof(p_input->'scope') is distinct from 'string'
      or coalesce(wanted,'') !~ '^(global|project:[0-9a-fA-F-]{36})$'))$r$,
       $r$  if wanted is not null then
    b:=clued_private.resolve_binding(p_token_hash,'context:read',wanted);
  else
    -- Generic CI has no scope before discovery. Bootstrap the issuer's
    -- identity as resolve_pr_claim does, then require the actual scope below.
    if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'binding_not_authorized' using errcode='42501'; end if;
    select * into b from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1(p_token_hash) for share;
    if not found or b.revoked_at is not null or not clued_private.binding_live_v1(b) or not('context:read'=any(b.scopes)) then
      raise exception 'binding_not_authorized' using errcode='42501'; end if;
    perform clued_private.authorization_account_v12(b.user_id);
  end if;$r$,
       $r$    where user_id=b.user_id and repo_id=repo and pr_number=number;
  if not found then
    begin
      task_ids:=clued_private.work_claim_pr_discover_tasks_v1(b.user_id,repo,pr,from_head,branch);
    exception when others then
      return refuse||jsonb_build_object('error_code','pr_task_authorization_unconfirmed');
    end;
    if cardinality(task_ids)=0 then return refuse||jsonb_build_object('error_code','head_authorization_required'); end if;
    if cardinality(task_ids)<>1 then return refuse||jsonb_build_object('error_code','pr_task_binding_ambiguous'); end if;
    target.task_id:=task_ids[1];
    need_bind:=true;
  elsif not clued_private.work_claim_pr_binding_open_v1(target.status) then
    return refuse||jsonb_build_object('error_code','pr_task_binding_unbound');
  end if;
  select * into m from public.clued_memories where user_id=b.user_id and id=target.task_id;
  if not found then return refuse||jsonb_build_object('error_code','scope_not_served'); end if;
  actual:=coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end);
  if wanted is not null and wanted<>actual then return refuse||jsonb_build_object('error_code','scope_not_served'); end if;
  if wanted is null then perform clued_private.resolve_binding(p_token_hash,'context:read',actual); end if;
  wanted:=actual;$r$,
       $r$  -- The existing tenant lock covers discovery, binding and carry. Bind
  -- only after source and scope checks, using the source as discovery evidence.
  if need_bind then
    perform clued_private.work_claim_pr_bind_v1(b,chosen,repo,number,source.authorization_id,true);
  end if;
  existing:=clued_private.work_claim_pr_authorization_v1(chosen,repo,pr,head,branch);$r$
     ])
  ) p(target,body_sha256,anchors,replacements) loop
    select pg_catalog.pg_get_functiondef(p.oid) into definition from pg_catalog.pg_proc p
      where p.oid=patch.target
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=patch.body_sha256
        and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""']
        and pg_catalog.pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}';
    if definition is null then
      raise exception 'work_claim_main_merge_unbound_discovery_source_changed: %',patch.target using errcode='22023';
    end if;
    for i in 1..cardinality(patch.anchors) loop
      anchor:=patch.anchors[i];
      if length(definition)-length(replace(definition,anchor,''))<>length(anchor) then
        raise exception 'work_claim_main_merge_unbound_discovery_anchor_mismatch: % anchor %',patch.target,i using errcode='22023';
      end if;
      definition:=replace(definition,anchor,patch.replacements[i]);
    end loop;
    execute definition;
  end loop;
end $main_merge_unbound_discovery$;

notify pgrst,'reload schema';
