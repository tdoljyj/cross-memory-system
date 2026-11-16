-- A head that only merged main into an authorized head keeps that head's
-- authorization (Owner Decisions 9e2511fe item 3 and 78a3052f item 2: the
-- robot brings main into a train front that is behind; resident DESIGN §80).
--
-- Before: every new head needed the holder's own authorize_head
-- (work_claim_pr_authorization_v1 matches the exact head). strict lets GitHub
-- merge only a head that contains main's tip, so each front that fell behind
-- needed a person to merge main, authorize the merge commit with the private
-- lease key and push it (11-15: three times for #1123 alone).
--
-- Rule: action carry_main_merge of clued_work_verify_v1. The caller states
-- that head_sha is main_sha merged into from_head_sha and nothing else. Native
-- cannot read git, so the statement is trusted exactly as far as the caller:
--   * only the Binding that is the CI admission issuer now
--     (ci_duty_admits_v1 'issuer_role', the same question both PR doors ask):
--     the on-duty node's admission, which already decides the PR's verdict,
--     binds PRs to Tasks and proves mechanical files;
--   * only from a live, exact authorization of from_head_sha that the PR's one
--     current claim already holds (work_claim_pr_authorization_v1: same claim,
--     epoch, holder binding, copy, repository, PR and branch);
--   * the new row is an ordinary authorization of the same claim, epoch,
--     holder binding and copy, for this PR only, so every consumer reads it
--     as before and every claim-wide revocation (epoch change, release,
--     handover) ends it with its source; carried_from names the source;
--   * nothing else moves: fence, version, lease, hard deadline, CI metering
--     (the new head is still a new head), Owner Grants (a0d93cd0 decides
--     those separately), the merge slot.
-- The admission states it only for a head whose clued-admission App check
-- kooyumi-main-merge (posted by scripts/ci/clued-front-main-merge.mjs after its
-- own update-branch) names this PR, from_head_sha and main_sha, whose parents
-- are exactly [from_head_sha, main_sha], and whose main_sha main contains
-- (scripts/ci/front-main-merge.mjs#mainMergeSource).

alter table clued_private.work_claim_head_authorizations_v1
  add column carried_from uuid references clued_private.work_claim_head_authorizations_v1(authorization_id);

create function clued_private.work_claim_carry_main_merge_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; target clued_private.work_claim_pr_task_bindings_v1; m public.clued_memories;
  c clued_private.work_claims_v1; chosen clued_private.work_claims_v1; live integer:=0;
  source clued_private.work_claim_head_authorizations_v1; a clued_private.work_claim_head_authorizations_v1;
  wanted text:=p_input->>'scope'; pr text:=lower(p_input->>'pr_ref'); repo text; number bigint;
  from_head text:=p_input->>'from_head_sha'; head text:=p_input->>'head_sha'; main_sha text:=p_input->>'main_sha';
  branch text:=p_input->>'target_branch'; existing uuid; receipt uuid;
  refuse constant jsonb:=jsonb_build_object('status','rejected');
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['action','scope','pr_ref','from_head_sha','head_sha','main_sha','target_branch']<>'{}'::jsonb
    or p_input->>'action' is distinct from 'carry_main_merge'
    or jsonb_typeof(p_input->'scope') is distinct from 'string' or coalesce(wanted,'') !~ '^(global|project:[0-9a-fA-F-]{36})$'
    or jsonb_typeof(p_input->'pr_ref') is distinct from 'string'
    or coalesce(pr,'') !~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}#[1-9][0-9]{0,9}$'
    or jsonb_typeof(p_input->'from_head_sha') is distinct from 'string' or coalesce(from_head,'') !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(p_input->'head_sha') is distinct from 'string' or coalesce(head,'') !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(p_input->'main_sha') is distinct from 'string' or coalesce(main_sha,'') !~ '^[0-9a-f]{40}$'
    or head in (from_head,main_sha)
    or jsonb_typeof(p_input->'target_branch') is distinct from 'string'
    or coalesce(length(branch),0) not between 1 and 200 or branch ~ '[[:space:]]' then
    raise exception 'work_claim_main_merge_input_invalid' using errcode='22023';
  end if;
  b:=clued_private.resolve_binding(p_token_hash,'context:read',wanted);
  if not clued_private.ci_duty_admits_v1(b.user_id,b.id,'issuer_role') then
    return refuse||jsonb_build_object('error_code','admission_binding_required'); end if;
  repo:=split_part(pr,'#',1); number:=split_part(pr,'#',2)::bigint;
  perform clued_private.work_claim_lock(b.user_id);
  select * into target from clued_private.work_claim_pr_task_bindings_v1
    where user_id=b.user_id and repo_id=repo and pr_number=number and status='active';
  if not found then return refuse||jsonb_build_object('error_code','pr_task_binding_unbound'); end if;
  select * into m from public.clued_memories where user_id=b.user_id and id=target.task_id;
  if not found or coalesce(nullif(m.canonical_scope,''),
      case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)<>wanted then
    return refuse||jsonb_build_object('error_code','scope_not_served'); end if;
  for c in select * from clued_private.work_claim_pr_current_v1(b.user_id,target.task_id) w where w.context_key=wanted loop
    continue when c.execution_handover_pending
      or clued_private.work_claim_pr_authorization_v1(c,repo,pr,from_head,branch) is null;
    live:=live+1; chosen:=c;
  end loop;
  if live<>1 then
    return refuse||jsonb_build_object('error_code',case when live=0 then 'source_head_not_authorized' else 'pr_task_current_claim_ambiguous' end);
  end if;
  select * into source from clued_private.work_claim_head_authorizations_v1
    where authorization_id=clued_private.work_claim_pr_authorization_v1(chosen,repo,pr,from_head,branch);
  existing:=clued_private.work_claim_pr_authorization_v1(chosen,repo,pr,head,branch);
  if existing is not null then
    return jsonb_build_object('status','committed','replayed',true,'authorization_id',existing,
      'carried_from',source.authorization_id,'head_sha',head);
  end if;
  insert into clued_private.work_claim_head_authorizations_v1
    (user_id,claim_id,execution_epoch,binding_id,copy_index,repository,head_sha,target_branch,
      pr_ref,workflow,idempotency_key,request_digest,carried_from)
  values(b.user_id,chosen.claim_id,chosen.execution_epoch,chosen.holder_binding_id,chosen.copy_index,repo,head,branch,
    pr,null,'main-merge:'||source.authorization_id||':'||head,
    clued_private.m1_sha256(jsonb_build_object('claim_id',chosen.claim_id,'execution_epoch',chosen.execution_epoch,
      'pr_ref',pr,'carried_from',source.authorization_id,'from_head_sha',from_head,'head_sha',head,
      'main_sha',main_sha,'target_branch',branch,'issuer_binding_id',b.id)),
    source.authorization_id) returning * into a;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(b.user_id,b.id,wanted,'work_claim_head_authorization_carried','work_claim',chosen.claim_id::text,chosen.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_HEAD_AUTHORIZATION_CARRIED','authorization_id',a.authorization_id,
      'carried_from',source.authorization_id,'execution_epoch',chosen.execution_epoch,'repository',repo,'pr_ref',pr,
      'from_head_sha',from_head,'head_sha',head,'main_sha',main_sha,'target_branch',branch)) returning id into receipt;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',receipt,'authorization_id',a.authorization_id,
    'carried_from',source.authorization_id,'head_sha',head);
end $$;

do $copy_main_merge_verifier$
declare body text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  execute replace(body,'FUNCTION public.clued_work_verify_v1(',
    'FUNCTION clued_private.work_claim_verify_before_main_merge_v1(');
end $copy_main_merge_verifier$;
create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if p_input->>'action'='carry_main_merge' then return clued_private.work_claim_carry_main_merge_v1(p_token_hash,p_input); end if;
  return clued_private.work_claim_verify_before_main_merge_v1(p_token_hash,p_input);
end $$;

revoke all on function
  clued_private.work_claim_carry_main_merge_v1(text,jsonb),
  clued_private.work_claim_verify_before_main_merge_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

notify pgrst,'reload schema';
