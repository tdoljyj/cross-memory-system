-- Candidate only (Task dcc53013). No policy is activated or seeded by this migration.
--
-- The physical scan-start K of 20261102151506 was (repository, head, role). A
-- resident batch is not identified by its head alone: a merge-train front batch
-- runs on GitHub's test merge S of [T, H] with the same head H as the plain
-- batch of H, and an automatic attempt 2 repeats the same (H, S) as a new job
-- (job-v2.mjs: identity = content + S + attempt). With the Source switch
-- NATIVE_SCAN_START_REQUIRED=true every such batch found the K of an earlier
-- batch of H already burned (scan_start_already_consumed) and could never start
-- its scanner.
--
-- K becomes (repository, head H, tested commit S, attempt, role): exactly the
-- identity the independent controller asks with. What stays as it was:
--  * one launch per K, permanent and immutable; no finish/reset/transfer door;
--  * a caller that names neither S nor attempt asks for S = H, attempt 1, the
--    K it always got (an old Source therefore keeps the old global K);
--  * the hosted provider always asks for S = H, attempt 1 (it never tests a
--    merge and GitHub's run_attempt is not a batch attempt), so hosted and a
--    plain first independent run of H still share one global K;
--  * attempt is 1 or 2 (MAX_ATTEMPT_V2, nothing creates attempt 3); S is H or a
--    commit that is neither H nor the base;
--  * the claim, PR binding, fence/epoch, exact head grant and Native full
--    verification of the head are unchanged.
--
-- S is not a fact Native can verify: it cannot read Git, and the base sent with
-- it is only echoed by the full verification. So the number of distinct tested
-- commits S != H per (repository, head, role) is capped at 8 (two moves of main
-- times the up to four compositions of a batch, train-landing.mjs
-- BATCH_MAX_LIMIT). One admitted head can therefore take at most 2 + 8 x 2 = 18
-- launches per role, never an unbounded number; past the cap the answer is
-- ci_scan_start_front_batch_limit (a new head starts afresh). The grant to the
-- independent controller is clued.ci-scan-start-grant/2 and names S and attempt;
-- the hosted grant keeps its /1 shape, which the serving Worker checks exactly.
--
-- Execution: one transaction. The first statement takes the table's ACCESS
-- EXCLUSIVE lock, so it fails outside a transaction block and nothing can write
-- K while the immutability trigger is briefly off for the carry-over.
-- Forward only: K rows taken after this migration (fronts, attempt 2) cannot be
-- expressed under the old (repository, head, role) key; going back means a new
-- forward migration, never restoring the old key or bodies.

lock table clued_private.ci_scan_start_keys_v1 in access exclusive mode;

alter table clued_private.ci_scan_start_keys_v1 add column test_sha text, add column attempt smallint;
-- Existing K were taken for S = H, attempt 1 (no caller could name anything
-- else): record exactly that. A carried-over K keeps burning that plain first
-- batch and nothing else; its front batches and its attempt 2 are new K.
alter table clued_private.ci_scan_start_keys_v1 disable trigger ci_scan_start_no_update_delete_v1;
update clued_private.ci_scan_start_keys_v1 set test_sha=head_sha,attempt=1;
alter table clued_private.ci_scan_start_keys_v1 enable trigger ci_scan_start_no_update_delete_v1;
alter table clued_private.ci_scan_start_keys_v1
  alter column test_sha set not null,
  alter column attempt set not null,
  add constraint ci_scan_start_test_sha_v1 check(test_sha ~ '^[0-9a-f]{40}$' and (test_sha=head_sha or test_sha<>base_sha)),
  add constraint ci_scan_start_attempt_v1 check(attempt between 1 and 2),
  add constraint ci_scan_start_hosted_tests_head_v1 check(provider<>'github-actions' or (test_sha=head_sha and attempt=1)),
  drop constraint ci_scan_start_keys_v1_pkey,
  -- still global, not per tenant/provider/run/Source/claim
  add primary key(repository_id,head_sha,test_sha,attempt,role);

-- Anchored rewrites of the current definitions (20261102151506, as rewritten by
-- 20261105160000). Each anchor is one exact, unique line of the current text; a
-- missing function or an anchor that is absent or repeated aborts the migration.
create function clued_private.ci_scan_batch_key_patch_v1(p_signature text,p_anchor text,p_replacement text) returns void
language plpgsql set search_path='' as $$
declare target regprocedure:=to_regprocedure(p_signature); body text;
begin
  if target is null then raise exception 'ci_scan_batch_key_patch_function_missing: %',p_signature; end if;
  body:=pg_get_functiondef(target);
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'ci_scan_batch_key_patch_anchor_mismatch: %',p_signature; end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- The local command may name S and attempt, both or neither.
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_local_v1(text,jsonb)',
$a$    or p_input-array['action','scope','repository_id','repository','execution_id','claim_id','fence','epoch','pr','head_sha','base_sha','changed_paths','role','source_manifest_sha256','registry_sha256']<>'{}'::jsonb$a$,
$r$    or p_input-array['action','scope','repository_id','repository','execution_id','claim_id','fence','epoch','pr','head_sha','base_sha','changed_paths','role','source_manifest_sha256','registry_sha256','test_sha','attempt']<>'{}'::jsonb
    or (p_input ? 'test_sha') is distinct from (p_input ? 'attempt')$r$);

-- The common transaction resolves and checks the batch identity before any lock,
-- Native verification or receipt. The hosted entry passes exact closed facts
-- without S or attempt, so it always resolves to S = H, attempt 1.
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$  perform clued_private.work_claim_lock(b.user_id);$a$,
$r$  if not(data ? 'test_sha') and not(data ? 'attempt') then
    data:=data||jsonb_build_object('test_sha',data->>'head_sha','attempt',1);
  end if;
  if jsonb_typeof(data->'test_sha') is distinct from 'string' or coalesce(data->>'test_sha','') !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(data->'attempt') is distinct from 'number' or coalesce(data->>'attempt','') !~ '^[12]$'
    or (data->>'test_sha'<>data->>'head_sha' and data->>'test_sha'=data->>'base_sha')
    or (provider_name<>'independent-controller' and (data->>'test_sha'<>data->>'head_sha' or data->>'attempt'<>'1')) then
    raise exception 'CI_SCAN_START_INPUT_INVALID' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(b.user_id);$r$);
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$    and head_sha=data->>'head_sha' and role=scan_role;$a$,
$r$    and head_sha=data->>'head_sha' and test_sha=data->>'test_sha' and attempt=(data->>'attempt')::smallint and role=scan_role;$r$);
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$    jsonb_build_object('repository_id',p.repository_id,'head_sha',data->>'head_sha','role',scan_role,$a$,
$r$    jsonb_build_object('repository_id',p.repository_id,'head_sha',data->>'head_sha','test_sha',data->>'test_sha','attempt',(data->>'attempt')::int,'role',scan_role,$r$);
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$  insert into clued_private.ci_scan_start_keys_v1(repository_id,head_sha,role,execution_id,policy_id,user_id,scope,provider,$a$,
$r$  insert into clued_private.ci_scan_start_keys_v1(repository_id,head_sha,test_sha,attempt,role,execution_id,policy_id,user_id,scope,provider,$r$);
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$    values(p.repository_id,data->>'head_sha',scan_role,(data->>'execution_id')::uuid,p.policy_id,b.user_id,p.scope,provider_name,$a$,
$r$    values(p.repository_id,data->>'head_sha',data->>'test_sha',(data->>'attempt')::smallint,scan_role,(data->>'execution_id')::uuid,p.policy_id,b.user_id,p.scope,provider_name,$r$);

-- The cap on invented tested commits (see the header). It runs under the
-- owner's work-claim lock taken above, after the consumed answer for a known K
-- and before the attempt receipt, so a refused request records nothing.
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$  r:=clued_private.work_claim_ci_receipt_v1(b,p.scope,'ci_scan_start_requested',c.claim_id,c.execution_epoch,$a$,
$r$  if data->>'test_sha'<>data->>'head_sha' and (select count(distinct k.test_sha) from clued_private.ci_scan_start_keys_v1 k
      where k.repository_id=p.repository_id and k.head_sha=data->>'head_sha' and k.role=scan_role
        and k.test_sha<>k.head_sha and k.test_sha<>data->>'test_sha')>=8 then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_front_batch_limit','launch_allowed',false); end if;
  r:=clued_private.work_claim_ci_receipt_v1(b,p.scope,'ci_scan_start_requested',c.claim_id,c.execution_epoch,$r$);
-- The independent controller's grant names the batch it burned (/2); the hosted
-- grant keeps the exact /1 shape the serving Worker checks.
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$  return jsonb_build_object('status','committed','contract','clued.ci-scan-start-grant/1','launch_allowed',true,$a$,
$r$  return jsonb_build_object('status','committed','contract',case when provider_name='independent-controller'
      then 'clued.ci-scan-start-grant/2' else 'clued.ci-scan-start-grant/1' end,'launch_allowed',true,$r$);
select clued_private.ci_scan_batch_key_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$    'provider',provider_name,'start_requested_at',to_char(authorized_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));$a$,
$r$    'provider',provider_name,'start_requested_at',to_char(authorized_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ||case when provider_name='independent-controller'
      then jsonb_build_object('test_sha',data->>'test_sha','attempt',(data->>'attempt')::int) else '{}'::jsonb end;$r$);

drop function clued_private.ci_scan_batch_key_patch_v1(text,text,text);
