-- One authoritative PR -> Task relation. Claims remain ephemeral and are
-- resolved from the Task at the moment of use, never copied into this table.
create table clued_private.work_claim_pr_task_bindings_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  repo_id text not null check(repo_id ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  pr_number bigint not null check(pr_number between 1 and 9999999999),
  task_id uuid not null references public.clued_memories(id),
  status text not null default 'unknown' check(status in ('unknown','active','closed','merged')),
  primary key(user_id,repo_id,pr_number)
);
create index work_claim_pr_task_targets_v1 on clued_private.work_claim_pr_task_bindings_v1(user_id,task_id,status);
alter table clued_private.work_claim_pr_task_bindings_v1 enable row level security;
revoke all on clued_private.work_claim_pr_task_bindings_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_pr_refs_v1(c clued_private.work_claims_v1,p_active boolean default true)
returns text[] language sql stable set search_path='' as $$
  select coalesce(array_agg(t.repo_id||'#'||t.pr_number::text order by t.repo_id,t.pr_number),'{}'::text[])
    from clued_private.work_claim_pr_task_bindings_v1 t
    where t.user_id=c.user_id and t.task_id=c.task_id and (not p_active or t.status='active')
$$;
create function clued_private.work_claim_pr_matches_v1(c clued_private.work_claims_v1,p_pr text,p_active boolean default true)
returns boolean language sql stable set search_path='' as $$
  select lower(p_pr)=any(clued_private.work_claim_pr_refs_v1(c,p_active))
$$;
create function clued_private.work_claim_pr_compat_v1(c clued_private.work_claims_v1)
returns text language sql stable set search_path='' as $$
  select case when cardinality(x)=1 then x[1] else null end from (select clued_private.work_claim_pr_refs_v1(c) x) s
$$;
-- A repository-scoped observation must not expose a Task's targets from a
-- different repository. The underlying Task relation remains the authority.
create function clued_private.work_claim_pr_repository_refs_v1(c clued_private.work_claims_v1,p_repo text)
returns text[] language sql stable set search_path='' as $$
  select coalesce(array_agg(r.pr_ref order by r.pr_ref),'{}'::text[])
    from unnest(clued_private.work_claim_pr_refs_v1(c)) r(pr_ref)
    where split_part(r.pr_ref,'#',1)=lower(p_repo)
$$;
create function clued_private.work_claim_pr_repository_compat_v1(c clued_private.work_claims_v1,p_repo text)
returns text language sql stable set search_path='' as $$
  select case when cardinality(x)=1 then x[1] else null end
    from (select clued_private.work_claim_pr_repository_refs_v1(c,p_repo) x) s
$$;

create function clued_private.work_claim_pr_bind_v1(
  b public.clued_agent_bindings,c clued_private.work_claims_v1,p_repo text,p_number bigint,p_authorization uuid,p_discovery boolean
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare target clued_private.work_claim_pr_task_bindings_v1; receipt uuid;
begin
  perform clued_private.work_claim_lock(b.user_id);
  perform clued_private.work_claim_task(b.user_id,c.context_key,c.task_id::text);
  if c.user_id is distinct from b.user_id then raise exception 'pr_task_binding_conflict' using errcode='PT343'; end if;
  select * into target from clued_private.work_claim_pr_task_bindings_v1
    where user_id=b.user_id and repo_id=p_repo and pr_number=p_number for update;
  if found and target.task_id<>c.task_id then raise exception 'pr_task_binding_conflict' using errcode='PT343'; end if;
  if found and (target.status='active' or not p_discovery) then return null; end if;
  insert into clued_private.work_claim_pr_task_bindings_v1(user_id,repo_id,pr_number,task_id,status)
    values(b.user_id,p_repo,p_number,c.task_id,case when p_discovery then 'active' else 'unknown' end)
    on conflict(user_id,repo_id,pr_number) do update set status='active';
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(b.user_id,b.id,c.context_key,'work_claim_pr_task_bind','task',c.task_id::text,c.fence,
      jsonb_build_object('receipt_kind','WORK_CLAIM_PR_TASK_BOUND','repository',p_repo,'pr_number',p_number,
        'task_id',c.task_id,'claim_id',c.claim_id,'authorization_id',p_authorization,'discovery',p_discovery)) returning id into receipt;
  return receipt;
end $$;

-- Historical import requires an immutable CI-role receipt and a unique Task
-- across every legacy row for that target. The receipt proves identity, not
-- current PR lifecycle: imported targets remain unknown until qualified CI
-- observes an open or terminal target. Ambiguity is not resolved by age.
insert into clued_private.work_claim_pr_task_bindings_v1(user_id,repo_id,pr_number,task_id,status)
select w.user_id,lower(split_part(w.bound_pr,'#',1)),split_part(w.bound_pr,'#',2)::bigint,
  min(w.task_id::text)::uuid,'unknown'
from clued_private.work_claims_v1 w
join public.clued_memories m on m.id=w.task_id and m.user_id=w.user_id
where w.bound_pr ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[1-9][0-9]{0,9}$'
group by w.user_id,lower(split_part(w.bound_pr,'#',1)),split_part(w.bound_pr,'#',2)::bigint
having count(distinct w.task_id)=1 and bool_or(exists(
  select 1 from public.clued_audit_receipts r join clued_private.binding_roles_v1 role
    on role.user_id=r.user_id and role.binding_id=r.binding_id and role.role='ci-admission'
      and role.granted_at<=r.created_at and (role.revoked_at is null or role.revoked_at>r.created_at)
  where r.user_id=w.user_id and r.operation='work_claim_bind_pr' and r.object_id=w.claim_id::text
    and r.metadata->>'receipt_kind'='WORK_CLAIM_BOUND_TO_PR'
    and lower(r.metadata->>'bound_pr')=lower(w.bound_pr)))
on conflict do nothing;

-- Replace legacy authority reads in existing functions, including historical
-- wrappers that remain callable internally. Presentation bound_pr is derived
-- only when the Task has one active target; bound_prs is the complete view.
do $replace_pr_authority$
declare f record; body text; changed text;
begin
  for f in select p.oid,p.proname,n.nspname from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','clued_private') and p.prosrc ~ '\mbound_pr\M'
      and p.proname not in ('work_claim_pr_compat_v1','work_claim_pr_refs_v1','work_claim_pr_matches_v1')
      and (p.proname like 'work_claim%' or p.proname like 'clued_work%' or p.proname='clued_merge_queue_v1'
        or p.proname in ('ci_claim_current_v1','ci_scan_start_begin_v1')) loop
    body:=pg_catalog.pg_get_functiondef(f.oid); changed:=body;
    -- Remove first-admission binding: only holder authorization and qualified
    -- discovery may create the relation, never a caller's claimed identity.
    changed:=regexp_replace(changed,
      '(?s)if v_pr is not null and c\.bound_pr is null and jsonb_array_length\(v_reasons\)=0 then.*?end if;',
      '-- PR/Task binding is maintained at the authenticated source.');
    changed:=regexp_replace(changed,
      '(?s)if v_pr is not null and c\.bound_pr is not null and c\.bound_pr<>v_pr then.*?end if;',
      'if v_pr is not null and not clued_private.work_claim_pr_matches_v1(c,v_pr) then v_reasons:=v_reasons||to_jsonb(''pr_task_binding_required''::text); end if;');
    changed:=regexp_replace(changed,
      '(?s)if code is null and c\.bound_pr is not null and \(pull_ref is distinct from c\.bound_pr\) then.*?end if;',
      '-- A Task may authorize more than one PR; the relation is checked atomically below.');
    changed:=replace(changed,'w.bound_pr=any(v_prs)',
      'exists(select 1 from unnest(v_prs) q(pr_ref) where clued_private.work_claim_pr_matches_v1(w,q.pr_ref))');
    changed:=replace(changed,'w.bound_pr=v_pr','clued_private.work_claim_pr_matches_v1(w,v_pr)');
    changed:=replace(changed,'w.bound_pr=p_pr','clued_private.work_claim_pr_matches_v1(w,p_pr)');
    changed:=replace(changed,'w.bound_pr=pr','clued_private.work_claim_pr_matches_v1(w,pr)');
    if f.proname in ('work_claim_merge_slot_return_core_v1','clued_work_claim_adopt_v1','clued_work_merge_slot_return_v1') then
      changed:=replace(changed,'clued_private.work_claim_pr_matches_v1(w,p_pr)','clued_private.work_claim_pr_matches_v1(w,p_pr,false)');
      changed:=replace(changed,'clued_private.work_claim_pr_matches_v1(w,v_pr)','clued_private.work_claim_pr_matches_v1(w,v_pr,false)');
    end if;
    changed:=replace(changed,'bound_pr=p_input->>''pr_ref''',
      'clued_private.work_claim_pr_matches_v1(work_claims_v1,p_input->>''pr_ref'')');
    changed:=replace(changed,'c.bound_pr is distinct from j.pr_ref',
      'not clued_private.work_claim_pr_matches_v1(c,j.pr_ref)');
    changed:=replace(changed,'c.bound_pr is distinct from pr_ref',
      'not clued_private.work_claim_pr_matches_v1(c,pr_ref)');
    changed:=replace(changed,'(w.bound_pr is null or lower(split_part(w.bound_pr,''#'',1))=repo)',
      '(cardinality(clued_private.work_claim_pr_refs_v1(w))=0 or exists(select 1 from unnest(clued_private.work_claim_pr_refs_v1(w)) r(pr_ref) where split_part(r.pr_ref,''#'',1)=repo))');
    -- Every target must be revoked on a holder/epoch change, not just one.
    if f.proname='work_claim_revocations_capture_v1' then
      changed:=replace(changed,E'\nbegin',E'\ndeclare bound_target text;\nbegin');
      changed:=regexp_replace(changed,'(?s)if old\.bound_pr is not null then.*?end if;',
        'foreach bound_target in array clued_private.work_claim_pr_refs_v1(old,false) loop
          insert into clued_private.work_claim_revocation_outbox_v1(user_id,claim_id,context_key,execution_epoch,repository,pr_ref)
          values(old.user_id,old.claim_id,old.context_key,new.execution_epoch,split_part(bound_target,''#'',1),bound_target);
          insert into clued_private.work_claim_revocation_outbox_v1(user_id,claim_id,context_key,execution_epoch,repository,head_sha,pr_ref)
          select distinct old.user_id,old.claim_id,old.context_key,new.execution_epoch,split_part(bound_target,''#'',1),head,bound_target
          from unnest(old.admitted_heads) h(head) where head ~ ''^[0-9a-f]{40}$'';
        end loop;');
    end if;
    if f.proname='work_claim_execution_current_v1' then
      changed:=replace(changed,'if c.status<>''ACTIVE''',
        'if (pr is not null and not clued_private.work_claim_pr_matches_v1(c,pr)) or c.status<>''ACTIVE''');
    end if;
    changed:=replace(changed,'''bound_pr'',c.bound_pr',
      '''bound_pr'',clued_private.work_claim_pr_compat_v1(c),''bound_prs'',to_jsonb(clued_private.work_claim_pr_refs_v1(c))');
    changed:=replace(changed,'''bound_pr'',w.bound_pr',
      '''bound_pr'',clued_private.work_claim_pr_compat_v1(w),''bound_prs'',to_jsonb(clued_private.work_claim_pr_refs_v1(w))');
    changed:=replace(changed,'''bound_pr'',a->''bound_pr''',
      '''bound_pr'',a->''bound_pr'',''bound_prs'',a->''bound_prs''');
    changed:=replace(changed,'''bound_pr'',r->''bound_pr''',
      '''bound_pr'',r->''bound_pr'',''bound_prs'',r->''bound_prs''');
    changed:=regexp_replace(changed,'\m(c|w|old|p_claim|claim_row)\.bound_pr\M',
      'clued_private.work_claim_pr_compat_v1(\1)','g');
    if f.proname='clued_work_merge_slot_holders_v1' then
      changed:=replace(changed,'''claim_id'',w.claim_id,','''claim_id'',w.claim_id,''task_id'',w.task_id,');
      changed:=replace(changed,'work_claim_pr_compat_v1(w)','work_claim_pr_repository_compat_v1(w,lower(v_repo))');
      changed:=replace(changed,'work_claim_pr_refs_v1(w)','work_claim_pr_repository_refs_v1(w,lower(v_repo))');
    end if;
    if changed<>body then execute changed; end if;
  end loop;
end $replace_pr_authority$;

-- Keep an unknown-PR authorization reusable for this exact head/Task. The old
-- mutation to the first observed PR would silently block a second valid PR.
do $preserve_unbound_head_authorization$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  body:=regexp_replace(body,
    '(?s)if a\.authorization_id is not null and result->>''verdict''=''ADMITTED'' and a\.pr_ref is null and pull_ref is not null then.*?end if;',
    '-- PR binding is Task-owned; an exact no-PR head authorization is not consumed by its first PR.');
  execute body;
end $preserve_unbound_head_authorization$;

-- Reuse the authenticated head-authorization action. An explicit PR number
-- participates in the same subtransaction, so a conflicting Task rolls back
-- the authorization and receipt instead of leaving a partial successful write.
do $copy_head_authorizer$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_authorize_head_v1(text,jsonb)'::regprocedure);
  execute replace(body,'FUNCTION clued_private.work_claim_authorize_head_v1(',
    'FUNCTION clued_private.work_claim_authorize_head_before_pr_task_v1(');
end $copy_head_authorizer$;
create or replace function clued_private.work_claim_authorize_head_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare input jsonb:=p_input-'pr_number'; b public.clued_agent_bindings; c clued_private.work_claims_v1;
  result jsonb; pr text:=nullif(p_input->>'pr_ref',''); number bigint; repo text:=lower(p_input->>'repository'); receipt uuid;
begin
  if p_input ? 'pr_number' then
    if jsonb_typeof(p_input->'pr_number') is distinct from 'number' or coalesce(p_input->>'pr_number','') !~ '^[1-9][0-9]{0,9}$' then
      raise exception 'work_claim_head_authorization_input_invalid' using errcode='22023'; end if;
    number:=(p_input->>'pr_number')::bigint;
    if pr is not null and lower(pr)<>repo||'#'||number::text then
      raise exception 'work_claim_head_authorization_input_invalid' using errcode='22023'; end if;
    pr:=repo||'#'||number::text; input:=input||jsonb_build_object('pr_ref',pr);
  elsif pr is not null then
    if pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[1-9][0-9]{0,9}$'
      or lower(split_part(pr,'#',1)) is distinct from repo then
      raise exception 'work_claim_head_authorization_input_invalid' using errcode='22023'; end if;
    number:=split_part(pr,'#',2)::bigint;
  end if;
  begin
    result:=clued_private.work_claim_authorize_head_before_pr_task_v1(p_token_hash,input);
    if result->>'status'<>'committed' or pr is null then return result; end if;
    b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(input->>'scope','global'));
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=(input->>'claim_id')::uuid;
    receipt:=clued_private.work_claim_pr_bind_v1(b,c,repo,number,(result->>'authorization_id')::uuid,false);
    return result||jsonb_build_object('task_id',c.task_id,'pr_ref',pr,'binding_receipt_id',receipt);
  exception when sqlstate 'PT343' then
    return jsonb_build_object('status','rejected','error_code','pr_task_binding_conflict');
  end;
end $$;

-- Public execution/role/head checks remain in their original function. The
-- wrapper adds one resolve action and requires the authoritative relation
-- before a normal PR verify can bind/meter/admit a caller-selected claim.
do $copy_pr_verifier$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  execute replace(body,'FUNCTION public.clued_work_verify_v1(',
    'FUNCTION clued_private.work_claim_verify_before_pr_task_v1(');
end $copy_pr_verifier$;
create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; projection jsonb; c clued_private.work_claims_v1;
  proof_binding public.clued_agent_bindings; proof_error text;
begin
  if p_input->>'action'='resolve_pr_claim' then return clued_private.work_claim_resolve_pr_v1(p_token_hash,p_input); end if;
  if p_input->>'pr_ref' is not null and not(p_input ? 'action') then
    -- Preserve the predecessor's restrictive proof gate when mechanical
    -- coverage is installed. Its pure input/CI-role validation must precede
    -- even the read-only PR lookup; it grants no identity or execution.
    if p_input ? 'mechanical_paths_proven' and pg_catalog.to_regprocedure(
      'clued_private.work_claim_mechanical_proof_error_v1(public.clued_agent_bindings,jsonb)') is not null then
      proof_binding:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
      execute 'select clued_private.work_claim_mechanical_proof_error_v1($1,$2)'
        into proof_error using proof_binding,p_input;
      if proof_error is not null then
        return jsonb_build_object('status','ok','verdict','REJECTED','execution_authorized',false,
          'reasons',jsonb_build_array(proof_error));
      end if;
    end if;
    projection:=clued_private.work_claim_resolve_pr_v1(p_token_hash,
      jsonb_build_object('action','resolve_pr_claim','scope',coalesce(p_input->>'scope','global'),
        'pr_ref',p_input->>'pr_ref','head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha',
        'target_branch',coalesce(p_input->>'target_branch','main'),'read_only',true));
    if projection->>'binding_status'<>'bound' or projection#>>'{claim,claim_id}' is distinct from p_input->>'claim_id' then
      return jsonb_build_object('status','ok','verdict','REJECTED','execution_authorized',false,
        'reasons',jsonb_build_array(coalesce(projection->>'reason','pr_task_claim_changed')),'claim_binding',projection);
    end if;
  end if;
  result:=clued_private.work_claim_verify_before_pr_task_v1(p_token_hash,p_input);
  if projection is not null then
    result:=result||jsonb_build_object('bound_pr',projection->>'pr_ref','claim_binding',projection);
    if jsonb_typeof(result->'claim')='object' then
      result:=jsonb_set(result,'{claim}',result->'claim'||jsonb_build_object('bound_pr',projection->>'pr_ref'));
    end if;
  end if;
  return result;
end $$;

-- Closing one PR must not evict the same Task's other active PR from the
-- repository queue. Explicit Task-level release keeps its existing semantics.
do $copy_pr_slot_return$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_merge_slot_return_core_v1(uuid,uuid,text,text,text,jsonb)'::regprocedure);
  execute replace(body,'FUNCTION clued_private.work_claim_merge_slot_return_core_v1(',
    'FUNCTION clued_private.work_claim_merge_slot_return_before_pr_task_v1(');
end $copy_pr_slot_return$;
create or replace function clued_private.work_claim_merge_slot_return_core_v1(
  p_user_id uuid,p_binding_id uuid,p_scope text,p_pr text,p_why text,p_ref jsonb
) returns uuid[] language plpgsql volatile security definer set search_path='' as $$
begin
  if p_why in ('merged','closed') and exists(
    select 1 from clued_private.work_claim_pr_task_bindings_v1 t
    join public.clued_memories m on m.id=t.task_id and m.user_id=t.user_id
    where t.user_id=p_user_id and t.repo_id=lower(split_part(p_pr,'#',1))
      and t.pr_number=split_part(p_pr,'#',2)::bigint
      and coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)=p_scope
      and exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 other
        where other.user_id=t.user_id and other.task_id=t.task_id and other.repo_id=t.repo_id
          and other.pr_number<>t.pr_number and other.status='active')) then return '{}'::uuid[]; end if;
  return clued_private.work_claim_merge_slot_return_before_pr_task_v1(p_user_id,p_binding_id,p_scope,p_pr,p_why,p_ref);
end $$;
create function clued_private.work_claim_pr_finish_v1(b public.clued_agent_bindings,p_scope text,p_pr text,p_status text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare target clued_private.work_claim_pr_task_bindings_v1; receipt uuid;
begin
  select t.* into target from clued_private.work_claim_pr_task_bindings_v1 t
    join public.clued_memories m on m.id=t.task_id and m.user_id=t.user_id
    where t.user_id=b.user_id and t.repo_id=lower(split_part(p_pr,'#',1)) and t.pr_number=split_part(p_pr,'#',2)::bigint
      and coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)=p_scope for update of t;
  if not found or target.status=p_status then return null; end if;
  update clued_private.work_claim_pr_task_bindings_v1 set status=p_status
    where user_id=target.user_id and repo_id=target.repo_id and pr_number=target.pr_number;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(b.user_id,b.id,p_scope,'work_claim_pr_task_finish','task',target.task_id::text,1,
      jsonb_build_object('receipt_kind','WORK_CLAIM_PR_TASK_FINISHED','repository',target.repo_id,
        'pr_number',target.pr_number,'task_id',target.task_id,'status',p_status)) returning id into receipt;
  return receipt;
end $$;
do $copy_pr_finish_doors$
declare name text; body text;
begin
  foreach name in array array['clued_work_claim_adopt_v1','clued_work_merge_slot_return_v1'] loop
    body:=pg_catalog.pg_get_functiondef(('public.'||name||'(text,jsonb)')::regprocedure);
    if name='clued_work_claim_adopt_v1' then
      body:=replace(body,'and w.copy_index is not null',
        'and w.copy_index is not null and exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
          where e.claim_id=w.claim_id and e.execution_epoch=w.execution_epoch and e.pr_ref=v_pr)');
    end if;
    execute replace(body,'FUNCTION public.'||name||'(', 'FUNCTION clued_private.'||name||'_before_pr_task(');
  end loop;
end $copy_pr_finish_doors$;
create or replace function public.clued_work_claim_adopt_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; b public.clued_agent_bindings; receipt uuid; candidates integer;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
  if clued_private.merge_slot_admits_v1(b) then
    perform clued_private.work_claim_lock(b.user_id);
    select count(*) into candidates from clued_private.work_claims_v1 c
      where c.user_id=b.user_id and c.context_key=coalesce(p_input->>'scope','global') and c.copy_index is not null
        and clued_private.work_claim_pr_matches_v1(c,p_input->>'pr_ref')
        and exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
          where e.claim_id=c.claim_id and e.execution_epoch=c.execution_epoch and e.pr_ref=p_input->>'pr_ref');
    if candidates>1 then return jsonb_build_object('status','rejected','error_code','pr_task_current_claim_ambiguous'); end if;
  end if;
  result:=clued_private.clued_work_claim_adopt_v1_before_pr_task(p_token_hash,p_input);
  if result->>'status'='ok' and result->>'reason' is distinct from 'admission_binding_required' then
    b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
    receipt:=clued_private.work_claim_pr_finish_v1(b,coalesce(p_input->>'scope','global'),p_input->>'pr_ref','merged');
    return result||jsonb_build_object('binding_receipt_id',receipt);
  end if;
  return result;
end $$;
create or replace function public.clued_work_merge_slot_return_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; b public.clued_agent_bindings; receipt uuid;
begin
  result:=clued_private.clued_work_merge_slot_return_v1_before_pr_task(p_token_hash,p_input);
  if result->>'status'='ok' and result->>'reason' is distinct from 'admission_binding_required' then
    b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
    receipt:=clued_private.work_claim_pr_finish_v1(b,coalesce(p_input->>'scope','global'),p_input->>'pr_ref','closed');
    return result||jsonb_build_object('binding_receipt_id',receipt);
  end if;
  return result;
end $$;

create or replace function clued_private.work_claim_ci_assist_target_v1(p_user uuid,p_scope text,p_pr text,p_head text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1; ids uuid[]:='{}'; target uuid;
begin
  select t.task_id into target from clued_private.work_claim_pr_task_bindings_v1 t
    where t.user_id=p_user and t.repo_id=lower(split_part(p_pr,'#',1))
      and t.pr_number=split_part(p_pr,'#',2)::bigint and t.status='active';
  if not found then return jsonb_build_object('reason','claim_not_bound'); end if;
  begin perform clued_private.work_claim_task(p_user,p_scope,target::text);
  exception when others then return jsonb_build_object('reason','task_not_current'); end;
  for c in select * from clued_private.work_claim_pr_current_v1(p_user,target) loop
    continue when c.context_key<>p_scope or c.execution_handover_pending;
    if clued_private.work_claim_pr_authorization_v1(c,lower(split_part(p_pr,'#',1)),lower(p_pr),p_head,'main') is not null
      and exists(select 1 from clued_private.work_claim_execution_admissions_v1 e where e.claim_id=c.claim_id
        and e.execution_epoch=c.execution_epoch and e.head_sha=p_head and e.pr_ref=p_pr
        and e.repository=lower(split_part(p_pr,'#',1)) and e.target_branch='main') then ids:=ids||c.claim_id; end if;
  end loop;
  if cardinality(ids)=1 then return jsonb_build_object('claim_id',ids[1]); end if;
  return jsonb_build_object('reason',case when cardinality(ids)>1 then 'pr_task_current_claim_ambiguous' else 'head_not_admitted' end);
end $$;

-- Legacy values remain immutable historical data; there is no second writable
-- binding authority. Every public view is projected from the Task relation.
create function clued_private.work_claim_legacy_pr_retired_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if (tg_op='INSERT' and new.bound_pr is not null) or (tg_op='UPDATE' and new.bound_pr is distinct from old.bound_pr) then
    raise exception 'work_claim_legacy_pr_binding_retired' using errcode='22023'; end if;
  return new;
end $$;
create trigger work_claim_legacy_pr_retired_v1 before insert or update on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_legacy_pr_retired_v1();

-- The current claim set is not chosen by recency. Multiple legal race copies
-- require an unambiguous exact-head authorization; otherwise resolution stops.
create function clued_private.work_claim_pr_current_v1(p_user uuid,p_task uuid)
returns setof clued_private.work_claims_v1 language sql volatile set search_path='' as $$
  select c.* from clued_private.work_claims_v1 c
    where c.user_id=p_user and c.task_id=p_task and c.status='ACTIVE' and c.expires_at>clock_timestamp()
      and c.outcome is distinct from 'not_adopted'
      and (c.copy_index is not null or not exists(select 1 from clued_private.work_claims_v1 n
        where n.user_id=c.user_id and n.task_id=c.task_id and n.fence>c.fence))
$$;
create function clued_private.work_claim_pr_authorization_v1(c clued_private.work_claims_v1,p_repo text,p_pr text,p_head text,p_branch text)
returns uuid language sql stable set search_path='' as $$
  select a.authorization_id from clued_private.work_claim_head_authorizations_v1 a
    where a.user_id=c.user_id and a.claim_id=c.claim_id and a.execution_epoch=c.execution_epoch
      and a.binding_id=c.holder_binding_id and a.copy_index is not distinct from c.copy_index
      and a.repository=p_repo and a.head_sha=p_head and a.target_branch=p_branch
      and a.workflow is null and (a.pr_ref is null or lower(a.pr_ref)=p_pr) and a.revoked_at is null
    order by a.issued_at,a.authorization_id limit 1
$$;

create function clued_private.work_claim_resolve_pr_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; holder public.clued_agent_bindings; c clued_private.work_claims_v1;
  chosen clued_private.work_claims_v1; target clued_private.work_claim_pr_task_bindings_v1; m public.clued_memories;
  wanted text:=nullif(p_input->>'scope',''); actual text; pr text:=lower(p_input->>'pr_ref'); repo text;
  head text:=p_input->>'head_sha'; base text:=p_input->>'base_sha'; branch text:=p_input->>'target_branch'; number bigint;
  read_only boolean:=false; ci boolean; task_ids uuid[]:='{}'; live_count integer:=0; authorized_count integer:=0;
  authorized_head uuid; chosen_authorization uuid; receipt uuid; v_result jsonb; can_write boolean; need_bind boolean:=false;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['action','scope','pr_ref','head_sha','base_sha','target_branch','read_only']<>'{}'::jsonb
    or p_input->>'action' is distinct from 'resolve_pr_claim'
    or jsonb_typeof(p_input->'pr_ref') is distinct from 'string'
    or coalesce(pr,'') !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}#[1-9][0-9]{0,9}$'
    or jsonb_typeof(p_input->'head_sha') is distinct from 'string' or coalesce(head,'') !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(p_input->'base_sha') is distinct from 'string' or coalesce(base,'') !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(p_input->'target_branch') is distinct from 'string' or coalesce(length(branch),0) not between 1 and 200
    or branch ~ '[[:space:]]'
    or (p_input ? 'scope' and (jsonb_typeof(p_input->'scope') is distinct from 'string'
      or coalesce(wanted,'') !~ '^(global|project:[0-9a-fA-F-]{36})$'))
    or (p_input ? 'read_only' and jsonb_typeof(p_input->'read_only') is distinct from 'boolean') then
    raise exception 'work_claim_pr_binding_input_invalid' using errcode='22023';
  end if;
  read_only:=coalesce((p_input->>'read_only')::boolean,false);
  repo:=split_part(pr,'#',1); number:=split_part(pr,'#',2)::bigint;
  -- Bootstrap identity without assuming access to global. Context permission
  -- is checked with the existing resolver after the actual Task is derived.
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1(p_token_hash) for share;
  if not found or b.revoked_at is not null or not clued_private.binding_live_v1(b) or not('context:read'=any(b.scopes)) then
    raise exception 'binding_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(b.user_id);
  if wanted is not null then perform clued_private.resolve_binding(p_token_hash,'context:read',wanted); end if;
  ci:=exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id and r.binding_id=b.id
    and r.role='ci-admission' and r.revoked_at is null);
  can_write:=ci and not read_only;
  v_result:=jsonb_build_object('status','ok','binding_status','unbound','reason','pr_task_binding_unbound',
    'repository',repo,'pr_number',number,'pr_ref',pr,'head_sha',head,'base_sha',base,'target_branch',branch,
    'scope',wanted,'task_id',null,'claim',null,'head_authorization_id',null,'auto_bound',false,'receipt_id',null);
  if can_write then perform clued_private.work_claim_lock(b.user_id); end if;
  select * into target from clued_private.work_claim_pr_task_bindings_v1
    where user_id=b.user_id and repo_id=repo and pr_number=number;
  if not found then
    if not can_write then return v_result; end if;
    -- Examine all of this tenant's scopes before deciding uniqueness. A
    -- fixed Source scope must not hide another valid Task's authorization.
    for c in select w.* from clued_private.work_claims_v1 w where w.user_id=b.user_id
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
    end loop;
    if cardinality(task_ids)=0 then return v_result||jsonb_build_object('reason','head_authorization_required'); end if;
    if cardinality(task_ids)<>1 then return v_result||jsonb_build_object('binding_status','conflict','reason','pr_task_binding_ambiguous'); end if;
    target.user_id:=b.user_id; target.repo_id:=repo; target.pr_number:=number; target.task_id:=task_ids[1]; target.status:='active';
    need_bind:=true;
  end if;
  select * into m from public.clued_memories where user_id=b.user_id and id=target.task_id;
  if not found then return v_result||jsonb_build_object('binding_status','conflict','reason','task_not_current'); end if;
  actual:=coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end);
  if wanted is not null and wanted<>actual then return v_result||jsonb_build_object('binding_status','conflict','reason','scope_not_served'); end if;
  perform clued_private.resolve_binding(p_token_hash,'context:read',actual);
  v_result:=v_result||jsonb_build_object('scope',actual,'task_id',m.id);
  if target.status<>'active' and not can_write then
    return v_result||jsonb_build_object('binding_status','no_live_claim','reason','pr_task_binding_'||target.status,'claim',null);
  end if;
  begin perform clued_private.work_claim_task(b.user_id,actual,m.id::text);
  exception when others then return v_result||jsonb_build_object('binding_status','no_live_claim','reason','task_not_current'); end;
  for c in select * from clued_private.work_claim_pr_current_v1(b.user_id,m.id) w where w.context_key=actual loop
    live_count:=live_count+1; chosen:=c;
    authorized_head:=clued_private.work_claim_pr_authorization_v1(c,repo,pr,head,branch);
    if authorized_head is not null and not c.execution_handover_pending then
      authorized_count:=authorized_count+1; chosen_authorization:=authorized_head;
    end if;
  end loop;
  if live_count=0 then return v_result||jsonb_build_object('binding_status','no_live_claim','reason','claim_not_current'); end if;
  if live_count>1 then
    if authorized_count<>1 then return v_result||jsonb_build_object('binding_status','conflict','reason','pr_task_current_claim_ambiguous','task_id',null,'claim',null); end if;
    for c in select * from clued_private.work_claim_pr_current_v1(b.user_id,m.id) w where w.context_key=actual loop
      if clued_private.work_claim_pr_authorization_v1(c,repo,pr,head,branch)=chosen_authorization then chosen:=c; exit; end if;
    end loop;
  end if;
  v_result:=v_result||jsonb_build_object('claim',jsonb_build_object('claim_id',chosen.claim_id,'task_id',chosen.task_id,
    'context_key',chosen.context_key,'fence',chosen.fence,'execution_epoch',chosen.execution_epoch,
    'expires_at',chosen.expires_at,'lease_version',chosen.lease_version,'status',chosen.status,
    'execution_handover_pending',chosen.execution_handover_pending));
  if chosen.execution_handover_pending then return v_result||jsonb_build_object('binding_status','handover_pending','reason','work_claim_handover_pending'); end if;
  authorized_head:=clued_private.work_claim_pr_authorization_v1(chosen,repo,pr,head,branch);
  if authorized_head is null then return v_result||jsonb_build_object('binding_status','head_not_authorized','reason','head_authorization_required'); end if;
  select * into holder from public.clued_agent_bindings where id=chosen.holder_binding_id and user_id=chosen.user_id;
  begin perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(holder.token_hash),'context:write',actual);
  exception when others then return v_result||jsonb_build_object('binding_status','no_live_claim','reason','holder_not_authorized','claim',null); end;
  if need_bind or (target.status<>'active' and can_write) then
    receipt:=clued_private.work_claim_pr_bind_v1(b,chosen,repo,number,authorized_head,true);
  end if;
  return v_result||jsonb_build_object('binding_status','bound','reason',null,'head_authorization_id',authorized_head,
    'auto_bound',receipt is not null,'receipt_id',receipt);
end $$;

revoke all on function
  clued_private.work_claim_pr_refs_v1(clued_private.work_claims_v1,boolean),
  clued_private.work_claim_pr_matches_v1(clued_private.work_claims_v1,text,boolean),
  clued_private.work_claim_pr_compat_v1(clued_private.work_claims_v1),
  clued_private.work_claim_pr_repository_refs_v1(clued_private.work_claims_v1,text),
  clued_private.work_claim_pr_repository_compat_v1(clued_private.work_claims_v1,text),
  clued_private.work_claim_pr_bind_v1(public.clued_agent_bindings,clued_private.work_claims_v1,text,bigint,uuid,boolean),
  clued_private.work_claim_pr_current_v1(uuid,uuid),
  clued_private.work_claim_pr_authorization_v1(clued_private.work_claims_v1,text,text,text,text),
  clued_private.work_claim_resolve_pr_v1(text,jsonb),
  clued_private.work_claim_authorize_head_before_pr_task_v1(text,jsonb),
  clued_private.work_claim_verify_before_pr_task_v1(text,jsonb),
  clued_private.work_claim_merge_slot_return_before_pr_task_v1(uuid,uuid,text,text,text,jsonb),
  clued_private.work_claim_pr_finish_v1(public.clued_agent_bindings,text,text,text),
  clued_private.clued_work_claim_adopt_v1_before_pr_task(text,jsonb),
  clued_private.clued_work_merge_slot_return_v1_before_pr_task(text,jsonb),
  clued_private.work_claim_legacy_pr_retired_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;
