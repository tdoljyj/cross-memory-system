-- clued-release: breaking removes internal clued_private terminal-admission helpers and one index; no Worker code references them and the public RPC names are unchanged
-- Terminal admission (20261108204157) is removed; a PR's end releases its claim directly.
--
-- 20261108204157 wrapped verify, authorize_head, the lease-key issue, adopt and
-- merge_slot_return to write terminal-admission and readiness Receipts and to
-- release a claim only on a holder-ready, runtime-inventory proof. It never
-- released a claim in production, twice stopped every PR on 2026-11-13, and was
-- paused by 20261113144500. Every wrapper is undone here: each original body
-- becomes the function again under its own name, and nothing terminal is left.
--
-- In its place, adopt (merged) and merge_slot_return (closed) end the PR-Task
-- binding as before and then release the claim(s) that served that PR when
-- both hold: the Task has no other open PR binding, and no live head
-- authorization of the claim is newer than its last authorization or CI
-- admission of that PR. No holder intent, credential or runtime proof. The
-- Receipt is the holder's ordinary completed release with the PR as evidence,
-- so a holder that goes on claims the Task again, within 15 minutes for free.
-- The
-- judgment is auxiliary: any error in it is logged and means "not released";
-- adopt/return answer exactly as without it.

-- 1. authorize_head: the pre-terminal body is again the lease-pin predecessor.
drop function clued_private.work_claim_authorize_head_before_lease_pin_v1(text,jsonb);
alter function clued_private.work_claim_authorize_head_before_terminal_v1(text,jsonb)
  rename to work_claim_authorize_head_before_lease_pin_v1;

-- 2. The lease-key issue writes no readiness revocation.
drop function clued_private.work_claim_lease_key_issue_v1(uuid);
alter function clued_private.work_claim_key_issue_before_terminal_v1(uuid) rename to work_claim_lease_key_issue_v1;

-- 3. verify: the holder edit check stays; no readiness flag, no terminal admission.
alter function clued_private.work_claim_verify_before_terminal_v1(text,jsonb) rename to work_claim_verify_pr_binding_v1;
create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; b public.clued_agent_bindings; c clued_private.work_claims_v1;
  editing boolean:=p_input->>'action'='verify_edit'; code text; verify_input jsonb:=p_input;
begin
  if p_input ? 'lease_key' and p_input->>'action' is distinct from 'verify_edit' then
    raise exception 'work_claim_private_key_action_invalid' using errcode='22023'; end if;
  if editing then
    perform clued_private.intake_payload_cap_v1(p_input);
    if jsonb_typeof(p_input) is distinct from 'object'
      or p_input-array['action','scope','claim_id','fence','execution_epoch','lease_version','changed_paths','lease_key']<>'{}'::jsonb
      or jsonb_typeof(p_input->'scope') is distinct from 'string' or length(p_input->>'scope') not between 1 and 200
      or jsonb_typeof(p_input->'claim_id') is distinct from 'string'
      or coalesce(p_input->>'claim_id','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or jsonb_typeof(p_input->'changed_paths') is distinct from 'array'
      or exists(select 1 from unnest(array['fence','execution_epoch','lease_version']) k
        where jsonb_typeof(p_input->k) is distinct from 'number' or coalesce(p_input->>k,'') !~ '^[1-9][0-9]{0,17}$') then
      raise exception 'work_claim_edit_verification_input_invalid' using errcode='22023'; end if;
    -- A session label or context:read observation is never editing authority.
    -- Use the original holder key checker and current claim CAS, without an
    -- execution target, head admission, renewal or business Receipt write.
    b:=clued_private.resolve_binding(p_token_hash,'context:write',p_input->>'scope');
    perform clued_private.work_claim_lock(b.user_id);
    select * into c from clued_private.work_claims_v1 w where w.user_id=b.user_id
      and w.context_key=p_input->>'scope' and w.claim_id=(p_input->>'claim_id')::uuid for update;
    code:=clued_private.work_claim_execution_key_error_v1(c,b.id,p_input->>'lease_key');
    if code is null and c.fence<>(p_input->>'fence')::bigint then code:='work_claim_fence_mismatch'; end if;
    if code is null and c.execution_epoch<>(p_input->>'execution_epoch')::bigint then code:='work_claim_execution_epoch_mismatch'; end if;
    if code is null and c.lease_version<>(p_input->>'lease_version')::bigint then code:='work_claim_version_conflict'; end if;
    if code is not null then return jsonb_build_object('status','ok','verdict','REJECTED',
      'holder_edit_authorized',false,'execution_authorized',false,'reasons',jsonb_build_array(code)); end if;
    perform clued_private.work_claim_task(c.user_id,c.context_key,c.task_id::text);
    verify_input:=jsonb_build_object('scope',c.context_key,'claim_id',c.claim_id,'changed_paths',p_input->'changed_paths');
  end if;
  result:=clued_private.work_claim_verify_pr_binding_v1(p_token_hash,verify_input);
  if editing and result#>>'{claim,claim_id}' ~ '^[0-9a-f-]{36}$' then
    return result||jsonb_build_object('holder_edit_authorized',result->>'verdict'='ADMITTED'); end if;
  return result;
end $$;

-- 4. A PR's end releases the claim(s) that served it (both conditions above).
create function clued_private.work_claim_pr_end_release_v1(b public.clued_agent_bindings,p_scope text,p_pr text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare pr text:=lower(p_pr); target clued_private.work_claim_pr_task_bindings_v1; c clued_private.work_claims_v1; since timestamptz;
begin
  select * into target from clued_private.work_claim_pr_task_bindings_v1
    where user_id=b.user_id and repo_id=split_part(pr,'#',1) and pr_number=split_part(pr,'#',2)::bigint;
  if not found or target.status not in ('merged','closed') then return; end if;
  if exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 o where o.user_id=target.user_id
      and o.task_id=target.task_id and o.status in ('active','unknown')) then return; end if;
  for c in select * from clued_private.work_claims_v1 w where w.user_id=target.user_id and w.task_id=target.task_id
      and w.context_key=p_scope and w.status='ACTIVE' for update loop
    select max(x.at) into since from (
      select a.issued_at at from clued_private.work_claim_head_authorizations_v1 a
        where a.user_id=c.user_id and a.claim_id=c.claim_id and lower(a.pr_ref)=pr
      union all select e.created_at from clued_private.work_claim_execution_admissions_v1 e
        where e.user_id=c.user_id and e.claim_id=c.claim_id and lower(e.pr_ref)=pr) x;
    continue when since is null or exists(select 1 from clued_private.work_claim_head_authorizations_v1 a
      where a.user_id=c.user_id and a.claim_id=c.claim_id and a.revoked_at is null and a.issued_at>since
        and lower(a.pr_ref) is distinct from pr);
    update clued_private.work_claims_v1 set status='RELEASED',released_outcome='completed',lease_key_hash=null,
      updated_at=pg_catalog.clock_timestamp() where user_id=c.user_id and claim_id=c.claim_id;
    -- The holder's own release Receipt, so its next claim of the Task within the
    -- continuation window takes no token (work_claim_continuation_v1).
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(c.user_id,c.holder_binding_id,c.context_key,'work_claim_release','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('receipt_kind','WORK_CLAIM_RELEASED','claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,
        'outcome','completed','evidence_ref',pr,'status','RELEASED','released_by_binding_id',b.id));
  end loop;
end $$;

-- 5. adopt / merge_slot_return: the pre-terminal bodies, plus the auxiliary release.
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
    if receipt is not null then
      begin perform clued_private.work_claim_pr_end_release_v1(b,coalesce(p_input->>'scope','global'),p_input->>'pr_ref');
      exception when others then raise warning 'work_claim_pr_end_release_skipped: % %',sqlstate,sqlerrm; end;
    end if;
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
    if receipt is not null then
      begin perform clued_private.work_claim_pr_end_release_v1(b,coalesce(p_input->>'scope','global'),p_input->>'pr_ref');
      exception when others then raise warning 'work_claim_pr_end_release_skipped: % %',sqlstate,sqlerrm; end;
    end if;
    return result||jsonb_build_object('binding_receipt_id',receipt);
  end if;
  return result;
end $$;

-- 6. Everything that served only terminal admission.
drop function clued_private.work_claim_pr_terminal_apply_v1(text,jsonb,boolean);
drop function clued_private.clued_work_claim_adopt_v1_before_terminal(text,jsonb);
drop function clued_private.clued_work_merge_slot_return_v1_before_terminal(text,jsonb);
drop function clued_private.work_claim_terminal_release_core_v1(public.clued_agent_bindings,clued_private.work_claims_v1,uuid,boolean,jsonb,jsonb);
drop function clued_private.work_claim_terminal_outcome_v1(public.clued_agent_bindings,text,uuid,uuid,text,text);
drop function clued_private.work_claim_terminal_runtime_error_v1(clued_private.work_claims_v1,jsonb,jsonb);
drop function clued_private.work_claim_terminal_ready_receipt_v1(clued_private.work_claims_v1);
drop function clued_private.work_claim_terminal_resources_v1(clued_private.work_claims_v1);
drop index if exists public.clued_audit_receipts_work_claim_terminal_idx;

revoke all on function clued_private.work_claim_pr_end_release_v1(public.clued_agent_bindings,text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- PL/pgSQL calls are not catalog dependencies: refuse if any body still names
-- a removed function or writes a terminal Receipt.
do $work_claim_terminal_admission_removed_refs_v1$ begin
  if exists(select 1 from pg_catalog.pg_proc p where p.prosrc ~
      '_before_terminal|work_claim_terminal_|work_claim_pr_terminal_apply_v1|terminal_admission|terminal_release_ready') then
    raise exception 'work_claim_terminal_admission_reference_left' using errcode='55000'; end if;
end $work_claim_terminal_admission_removed_refs_v1$;

notify pgrst,'reload schema';
