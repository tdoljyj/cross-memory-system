-- authorize_head: the server decides a pull request's target branch (Clued Task 0ca0479d; Fable 2026-11-20 §2.1).
--
-- Production 2026-11-20 (Beijing): claim 4d3fe9eb authorized head b228cedc5f for PR #1200 with target_branch
-- claude/train-required-rerun, the PR's own head branch. The call answered committed with a WORK_CLAIM_HEAD_AUTHORIZED
-- Receipt and pinned the lease, but CI resolves a PR by its real base (pr.base.ref, main) and the authorization matches
-- only that exact string (work_claim_pr_authorization_v1), so the row never matched: the resident answered
-- CLAIM_NOT_CURRENT for 2 h 05 min until the head was authorized again with main. 5 of 588 production authorizations
-- named the PR's own branch, 4 of them on 11-20; none named a real non-main target.
--
-- target_branch was a field the caller had to fill, the server could not check, and that has one legal value: the
-- resident train takes main only, independent CI admits PRs into the default branch only, and the SQL already fixes
-- main in several places. So for a pull-request authorization (workflow absent) the server now decides it:
--   - target_branch omitted: the served target is filled in and the authorization goes on as before;
--   - target_branch equal to the served target: unchanged (older clients and Workers);
--   - target_branch a different string: rejected work_claim_target_branch_not_served with served_target, before any
--     authorization row, WORK_CLAIM_HEAD_AUTHORIZED Receipt, PR binding or lease pin is written.
-- A committed pull-request authorization therefore always matches CI's resolve of the same head.
--
-- A workflow dispatch authorization is unchanged: its target_branch is the ref the workflow runs on, another meaning.
-- work_claim_served_target_v1 is the one place that says which branch a repository's pull requests merge into; it
-- returns main for every repository today. Only functions change: no table and no row.

create function clued_private.work_claim_served_target_v1(p_repository text) returns text
language sql immutable security definer set search_path='' as $$ select 'main'::text $$;

do $copy_served_target_authorizer$
declare definition text;
begin
  definition:=pg_catalog.pg_get_functiondef('clued_private.work_claim_authorize_head_v1(text,jsonb)'::regprocedure);
  if position('FUNCTION clued_private.work_claim_authorize_head_v1(' in definition)=0 then
    raise exception 'work_claim_authorize_head_source_unexpected';
  end if;
  execute replace(definition,'FUNCTION clued_private.work_claim_authorize_head_v1(',
    'FUNCTION clued_private.work_claim_authorize_head_before_served_target_v1(');
end $copy_served_target_authorizer$;

create or replace function clued_private.work_claim_authorize_head_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare served text;
begin
  -- Only a pull-request target of a well-formed object; anything else keeps its predecessor's answer.
  if jsonb_typeof(p_input) is distinct from 'object' or nullif(p_input->>'workflow','') is not null then
    return clued_private.work_claim_authorize_head_before_served_target_v1(p_token_hash,p_input);
  end if;
  served:=clued_private.work_claim_served_target_v1(lower(p_input->>'repository'));
  if not (p_input ? 'target_branch') then
    return clued_private.work_claim_authorize_head_before_served_target_v1(p_token_hash,
      p_input||jsonb_build_object('target_branch',served));
  end if;
  if jsonb_typeof(p_input->'target_branch')='string' and p_input->>'target_branch'<>served then
    return jsonb_build_object('status','rejected','error_code','work_claim_target_branch_not_served',
      'served_target',served);
  end if;
  return clued_private.work_claim_authorize_head_before_served_target_v1(p_token_hash,p_input);
end $$;

revoke all on function
  clued_private.work_claim_served_target_v1(text),
  clued_private.work_claim_authorize_head_before_served_target_v1(text,jsonb),
  clued_private.work_claim_authorize_head_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

notify pgrst,'reload schema';
