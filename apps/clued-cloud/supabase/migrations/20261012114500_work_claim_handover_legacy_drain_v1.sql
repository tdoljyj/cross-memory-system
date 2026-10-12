-- Task617: staged legacy target capture and activation-drain support.
-- No policy activation or historical claim mutation occurs in this migration.
-- Existing GW80/CI8, private proofs, publisher grants and journal rules remain.

-- Guard legacy CI-metered dispatch heads; no new caller, proof or grant.
create or replace function clued_private.work_claim_execution_current_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1; a clued_private.work_claim_execution_admissions_v1;
  holder public.clued_agent_bindings; ci public.clued_agent_bindings; found_guard boolean:=false;
  repo text:=lower(p_input->>'repository'); head text:=p_input->>'head_sha';
  pr text:=nullif(p_input->>'pr_ref',''); wf text:=nullif(p_input->>'workflow',''); branch text:=p_input->>'target_branch';
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['repository','head_sha','pr_ref','workflow','target_branch']<>'{}'::jsonb
    or coalesce(repo,'') !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
    or coalesce(head,'') !~ '^[0-9a-f]{40}$'
    or coalesce(length(branch),0) not between 1 and 200 or branch ~ '[[:space:]]'
    or (pr is not null and (pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$'
      or lower(split_part(pr,'#',1))<>repo))
    or (wf is not null and wf !~ '^[A-Za-z0-9_.-]{1,200}\.ya?ml$')
    or ((pr is null)=(wf is null)) then
    raise exception 'work_claim_execution_observation_invalid' using errcode='22023'; end if;
  if not clued_private.work_claim_execution_enabled_v1() then
    return jsonb_build_object('status','ok','guard_required',false,'epoch_current',null); end if;
  for c in select w.* from clued_private.work_claims_v1 w where w.lease_key_required and (
      (pr is not null and w.bound_pr=pr) or exists(select 1 from clued_private.work_claim_execution_admissions_v1 e
        where e.claim_id=w.claim_id and e.repository=repo and e.head_sha=head
          and e.pr_ref is not distinct from pr and e.workflow is not distinct from wf)
      or (wf is not null and head=any(w.admitted_heads)
        and (w.bound_pr is null or lower(split_part(w.bound_pr,'#',1))=repo)))
      order by w.updated_at desc limit 100 loop
    found_guard:=true;
    perform clued_private.work_claim_lock(c.user_id);
    select * into c from clued_private.work_claims_v1 where claim_id=c.claim_id;
    if c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() or c.execution_handover_pending
      or c.outcome='not_adopted' then continue; end if;
    if exists(select 1 from clued_private.work_claims_v1 newer where newer.user_id=c.user_id
        and newer.task_id=c.task_id and newer.fence>c.fence) then continue; end if;
    select * into a from clued_private.work_claim_execution_admissions_v1 e where e.claim_id=c.claim_id
      and e.execution_epoch=c.execution_epoch and e.repository=repo and e.head_sha=head
      and e.target_branch=branch and e.pr_ref is not distinct from pr and e.workflow is not distinct from wf
      and e.resources_digest=clued_private.m1_sha256(jsonb_build_object('write_set',c.write_set,'trigger_refs',c.trigger_refs))
      order by e.created_at desc limit 1;
    if a.admission_id is null then continue; end if;
    begin
      select * into holder from public.clued_agent_bindings where id=c.holder_binding_id and user_id=c.user_id;
      perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(holder.token_hash),'context:write',c.context_key);
      select * into ci from public.clued_agent_bindings where id=a.ci_binding_id and user_id=c.user_id;
      perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(ci.token_hash),'context:read',c.context_key);
      perform clued_private.work_claim_task(c.user_id,c.context_key,c.task_id::text);
      if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=c.user_id
          and r.binding_id=ci.id and r.role='ci-admission' and r.revoked_at is null) then continue; end if;
      return jsonb_build_object('status','ok','guard_required',true,'epoch_current',true);
    exception when others then continue;
    end;
  end loop;
  return jsonb_build_object('status','ok','guard_required',found_guard,
    'epoch_current',case when found_guard then false else null end);
end $$;

-- Include every metered old head, not only modern admissions or current PR ancestry.
create or replace function clued_private.work_claim_revocations_capture_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.execution_epoch=old.execution_epoch or not clued_private.work_claim_execution_enabled_v1() then
    return new; end if;
  insert into clued_private.work_claim_revocation_outbox_v1
    (user_id,claim_id,context_key,execution_epoch,repository,head_sha,pr_ref,workflow)
    select distinct old.user_id,old.claim_id,old.context_key,new.execution_epoch,
      a.repository,a.head_sha,a.pr_ref,a.workflow
    from clued_private.work_claim_head_authorizations_v1 a
    where a.claim_id=old.claim_id and a.execution_epoch<new.execution_epoch;
  insert into clued_private.work_claim_revocation_outbox_v1
    (user_id,claim_id,context_key,execution_epoch,repository,head_sha,pr_ref,workflow)
    select distinct old.user_id,old.claim_id,old.context_key,new.execution_epoch,
      a.repository,a.head_sha,a.pr_ref,a.workflow
    from clued_private.work_claim_execution_admissions_v1 a
    where a.claim_id=old.claim_id and a.execution_epoch<new.execution_epoch;
  if old.bound_pr is not null then
    insert into clued_private.work_claim_revocation_outbox_v1
      (user_id,claim_id,context_key,execution_epoch,repository,pr_ref)
    values(old.user_id,old.claim_id,old.context_key,new.execution_epoch,
      lower(split_part(old.bound_pr,'#',1)),old.bound_pr);
    insert into clued_private.work_claim_revocation_outbox_v1
      (user_id,claim_id,context_key,execution_epoch,repository,head_sha,pr_ref)
    select distinct old.user_id,old.claim_id,old.context_key,new.execution_epoch,
      lower(split_part(old.bound_pr,'#',1)),head,old.bound_pr
    from unnest(old.admitted_heads) h(head) where head ~ '^[0-9a-f]{40}$';
  end if;
  new.execution_handover_pending:=true;
  return new;
end $$;
revoke all on function clued_private.work_claim_revocations_capture_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Never reset fences, leases, private key hashes, PR bindings, CI meters or quotas.
create table clued_private.work_claim_activation_drains_v1 (
  claim_id uuid primary key references clued_private.work_claims_v1(claim_id),
  execution_epoch bigint not null,
  completed_at timestamptz
);
alter table clued_private.work_claim_activation_drains_v1 enable row level security;
revoke all on clued_private.work_claim_activation_drains_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_activation_drain_finish_v1(p_claim uuid) returns void
language plpgsql security definer set search_path='' as $$
declare c clued_private.work_claims_v1; d clued_private.work_claim_activation_drains_v1;
begin
  select * into c from clued_private.work_claims_v1 where claim_id=p_claim;
  if not found then return; end if;
  perform clued_private.work_claim_lock(c.user_id);
  select * into c from clued_private.work_claims_v1 where claim_id=p_claim for update;
  select * into d from clued_private.work_claim_activation_drains_v1 where claim_id=p_claim for update;
  if d.claim_id is null or d.completed_at is not null or d.execution_epoch<>c.execution_epoch then return; end if;
  if exists(select 1 from clued_private.work_claim_revocation_outbox_v1 o
      where o.claim_id=p_claim and o.execution_epoch<=d.execution_epoch and o.state='pending')
    or exists(select 1 from clued_private.work_claim_publications_v1 p
      where p.claim_id=p_claim and p.execution_epoch<d.execution_epoch and p.state='open') then return; end if;
  -- This is an activation drain, not a receiving delivery. The holder keeps its
  -- existing current private key; no new key is issued or exposed by an ACK.
  update clued_private.work_claims_v1 set execution_handover_pending=false where claim_id=p_claim;
  update clued_private.work_claim_activation_drains_v1 set completed_at=clock_timestamp() where claim_id=p_claim;
end $$;
revoke all on function clued_private.work_claim_activation_drain_finish_v1(uuid)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_activation_ack_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.state='acknowledged' and old.state is distinct from new.state then
    perform clued_private.work_claim_activation_drain_finish_v1(new.claim_id);
  end if;
  return new;
end $$;
revoke all on function clued_private.work_claim_activation_ack_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;
create trigger work_claim_activation_ack_v1 after update of state on clued_private.work_claim_revocation_outbox_v1
  for each row execute function clued_private.work_claim_activation_ack_v1();

create function clued_private.work_claim_execution_activate_v1(p_qualification_commit text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare person uuid; c clued_private.work_claims_v1;
begin
  if p_qualification_commit is null or p_qualification_commit !~ '^[0-9a-f]{40}$' then
    raise exception 'work_claim_activation_qualification_invalid' using errcode='22023';
  end if;
  -- Acquire the established user locks before the table barrier. Concurrent
  -- creates/renews/handover cannot slip an unguarded successor into the cutover.
  for person in select distinct user_id from clued_private.work_claims_v1 order by user_id loop
    perform clued_private.work_claim_lock(person);
  end loop;
  lock table clued_private.work_claims_v1 in share row exclusive mode;
  if exists(select 1 from clued_private.work_claim_execution_policy_v1 where activated_at is not null) then
    raise exception 'work_claim_activation_already_active';
  end if;
  update clued_private.work_claim_execution_policy_v1 set activated_at=clock_timestamp(),
    qualification_commit=p_qualification_commit;
  -- Historical handovers remain the lineage source. Ordinary unrelated Tasks
  -- retain compatibility; future claims inherit their Task's guard.
  for c in select w.* from clued_private.work_claims_v1 w
    where exists(select 1 from clued_private.work_claims_v1 prior
      where prior.user_id=w.user_id and prior.task_id=w.task_id and prior.lease_key_required)
    order by w.user_id,w.claim_id for update loop
    if not c.execution_handover_pending then
      insert into clued_private.work_claim_activation_drains_v1(claim_id,execution_epoch)
        values(c.claim_id,c.execution_epoch+1);
    end if;
    -- Existing epoch/revocation triggers invalidate every old private head and
    -- capture durable targets before the newly guarded generation can execute.
    update clued_private.work_claims_v1 set lease_key_required=true,
      execution_epoch=execution_epoch+1 where claim_id=c.claim_id;
    perform clued_private.work_claim_activation_drain_finish_v1(c.claim_id);
  end loop;
  return jsonb_build_object('status','activated','qualification_commit',p_qualification_commit);
end $$;
revoke all on function clued_private.work_claim_execution_activate_v1(text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

