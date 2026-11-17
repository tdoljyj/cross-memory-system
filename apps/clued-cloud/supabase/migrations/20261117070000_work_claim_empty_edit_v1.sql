-- Appendix A.4 needs a holder/key/CAS preflight before a wider renewal.
-- Only verify_edit may use [] for that preflight. Normal verification retains
-- its nonempty path validation; real paths retain the existing coverage check.
-- Keep the public carry_main_merge wrapper and every holder, scope, live Task,
-- key and generation check. No permission, PR binding, head admission, renewal,
-- Receipt or retired terminal/readiness state is created here.
do $empty_edit_preflight$
declare
  target regprocedure := 'clued_private.work_claim_verify_before_main_merge_v1(text,jsonb)'::regprocedure;
  definition text;
  before_clause constant text := $before$verify_input:=jsonb_build_object('scope',c.context_key,'claim_id',c.claim_id,'changed_paths',p_input->'changed_paths');$before$;
  after_clause constant text := $after$verify_input:=jsonb_build_object('scope',c.context_key,'claim_id',c.claim_id);
    if jsonb_array_length(p_input->'changed_paths')>0 then
      verify_input:=verify_input||jsonb_build_object('changed_paths',p_input->'changed_paths');
    end if;$after$;
begin
  -- Bind the currently active wrapper and the complete predecessor body, not
  -- merely a matching substring in an unknown successor. Both hashes were
  -- checked against the accepted source and actual production function bodies.
  if not exists(select 1 from pg_catalog.pg_proc p
    where p.oid='public.clued_work_verify_v1(text,jsonb)'::regprocedure
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='727713b1ee7512d60db93235aa45474e6cca4fc700afd6a52c85f67d2f3d4aef') then
    raise exception 'work_claim_empty_edit_wrapper_changed' using errcode='22023';
  end if;
  select pg_catalog.pg_get_functiondef(p.oid) into definition from pg_catalog.pg_proc p
    where p.oid=target
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='5a6898b1d3c7ead2b6d42bc9a8790275e4cfdb62d1c97ac6d61ff23db1e8c1ec'
      and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""']
      and pg_catalog.pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}';
  if definition is null
    or length(definition)-length(replace(definition,before_clause,'')) <> length(before_clause) then
    raise exception 'work_claim_empty_edit_verifier_changed' using errcode='22023';
  end if;
  -- CREATE OR REPLACE preserves the existing function's owner and ACL. The
  -- complete definition also preserves its security mode and fixed search_path.
  execute replace(definition,before_clause,after_clause);
end $empty_edit_preflight$;

notify pgrst,'reload schema';
