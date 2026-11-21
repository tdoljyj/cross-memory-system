-- Whether a PR -> Task relation is still open has one answer
-- (FABLE-botmerge-auth-carry-20261122 §2 step 1, Task 30643342).
--
-- A relation is 'unknown' from the holder's authorize_head (pr_number/pr_ref)
-- until the CI admission's write resolve sees one of its heads authorized and
-- makes it 'active' (20261108161615 work_claim_pr_bind_v1); 'closed' and
-- 'merged' are terminal. 'unknown' says only that the CI has not yet seen the
-- relation open, not that it is not. Two readers took it as "not open":
--   * carry_main_merge (20261116090000) answered pr_task_binding_unbound for
--     every PR the CI had never admitted, so the main-merge robot's commit on
--     such a PR always needed the holder's lease key again (#1220, 11-22);
--   * every read-only resolve_pr_claim answered no_live_claim /
--     pr_task_binding_unknown whatever the head's authorization, so a holder's
--     authorize_head never changed what the resident's observation saw.
-- Both now read work_claim_pr_binding_open_v1. Nothing else changes: carry
-- still needs the on-duty issuer and an exact live authorization of the
-- source head by the PR's one current claim; a read-only resolve still binds,
-- activates and meters nothing (the write stays in the can_write branch);
-- 'closed' and 'merged' are refused as before; bound_prs
-- (work_claim_pr_refs_v1), the merge queue target and the terminal release
-- keep their own readings.

create function clued_private.work_claim_pr_binding_open_v1(p_status text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_status in ('active','unknown'),false)
$$;
revoke all on function clued_private.work_claim_pr_binding_open_v1(text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Rewrite one exact clause of each function's current text. The full body
-- hash binds the predecessor (carry: 20261116090000 as written; resolve:
-- 20261108161615 with the 20261113100000 issuer_role reader), so an unknown
-- successor stops the migration instead of being patched blindly.
do $pr_binding_open$
declare
  patch record;
  definition text;
begin
  for patch in select * from (values
    ('clued_private.work_claim_carry_main_merge_v1(text,jsonb)'::regprocedure,
     '2adc9e86eff0ea0fbb16cb4f42505c6894e47f05c18b388c748caa71bb8457ec',
     $a$where user_id=b.user_id and repo_id=repo and pr_number=number and status='active';$a$,
     $r$where user_id=b.user_id and repo_id=repo and pr_number=number and clued_private.work_claim_pr_binding_open_v1(status);$r$),
    ('clued_private.work_claim_resolve_pr_v1(text,jsonb)'::regprocedure,
     '4c278ecd5b1fe5f8b30c4d6e77b0a023db6381f2e87a746e5cecb0996d084f3b',
     $a$if target.status<>'active' and not can_write then$a$,
     $r$if not clued_private.work_claim_pr_binding_open_v1(target.status) and not can_write then$r$)
  ) p(target,body_sha256,anchor,replacement) loop
    definition:=null;
    select pg_catalog.pg_get_functiondef(p.oid) into definition from pg_catalog.pg_proc p
      where p.oid=patch.target
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=patch.body_sha256
        and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""']
        and pg_catalog.pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}';
    if definition is null
      or length(definition)-length(replace(definition,patch.anchor,'')) <> length(patch.anchor) then
      raise exception 'work_claim_pr_binding_open_source_changed: %',patch.target using errcode='22023';
    end if;
    -- CREATE OR REPLACE keeps the owner and ACL; the complete definition keeps
    -- SECURITY DEFINER and the fixed search_path.
    execute replace(definition,patch.anchor,patch.replacement);
    if position('clued_private.work_claim_pr_binding_open_v1(' in
        (select p.prosrc from pg_catalog.pg_proc p where p.oid=patch.target))=0 then
      raise exception 'work_claim_pr_binding_open_not_applied: %',patch.target using errcode='22023';
    end if;
  end loop;
end $pr_binding_open$;

notify pgrst,'reload schema';
