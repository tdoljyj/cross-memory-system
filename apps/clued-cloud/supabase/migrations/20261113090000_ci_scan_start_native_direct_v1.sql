-- Scan start verifies with the live Native verifier on both providers; the
-- server-principal clones and their source-hash guard are removed.
--
-- 20261102151506 gave the hosted (github-actions) scan start two text clones of
-- the Native verifier, public.clued_work_verify_v1 and its core
-- clued_private.work_claim_verify_before_execution_v1, that differ only in the
-- credential entry (a Binding id instead of a proof), and pinned the two
-- originals' source hashes in clued_private.ci_scan_start_native_source_current_v1().
-- ci_scan_start_begin_v1 refused every scan start, local and hosted, while the
-- pin did not hold. 20261108144312, 20261108161615 and 20261108204157 rewrote
-- the verifier without re-deriving the clones or re-pinning, so every
-- scan_start_independent answered ci_scan_start_native_source_changed: the
-- local path, which never used the clones, included.
--
-- A clone has to be re-derived after every change of what it copies; that
-- step was forgotten once and can be forgotten again. The verifier already
-- has the sanctioned way for code that holds a stored credential to call a
-- proof-taking function as that Binding: credential_internal_proof_v1
-- (20261008210000), a random proof mapped to the stored verifier for the rest
-- of the transaction only, in a setting no PostgREST caller can set. The
-- hosted path now passes it for the Binding the hosted entry resolved (the
-- qualified consumer's principal, through ci_scan_start_resolve_principal_v1,
-- which is unchanged), so both providers run the same live verifier and there
-- is nothing left to keep in step. token_hash is a unique, non-null cv1
-- verifier, so the proof resolves exactly that Binding, as the clone's
-- Binding-id lookup did. The local path is unchanged (it passes the caller's
-- own proof). Nothing else changes: policy, consumer, claim, key and deadline
-- checks of ci_scan_start_begin_v1 stay as they are, and its owner, ACL,
-- SECURITY DEFINER and search_path are kept by CREATE OR REPLACE.
do $ci_scan_start_native_direct_v1$
declare body text; anchor text; replacement text;
begin
  body:=pg_catalog.pg_get_functiondef(
    'clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)'::regprocedure);
  anchor:=$a$  if clued_private.ci_scan_start_native_source_current_v1() is distinct from true then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_native_source_changed','launch_allowed',false); end if;
$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'ci_scan_start_native_direct_guard_unexpected' using errcode='55000'; end if;
  body:=replace(body,anchor,'');
  anchor:=$a$  if provider_name='independent-controller' then
    verification:=public.clued_work_verify_v1(p_proof,verification);
  else
    verification:=clued_private.ci_scan_start_verify_principal_v1(b.id,verification);
  end if;
$a$;
  replacement:=$r$  verification:=public.clued_work_verify_v1(case when provider_name='independent-controller' then p_proof
    else clued_private.credential_internal_proof_v1(b.token_hash) end,verification);
$r$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'ci_scan_start_native_direct_verify_unexpected' using errcode='55000'; end if;
  execute replace(body,anchor,replacement);
end $ci_scan_start_native_direct_v1$;

drop function clued_private.ci_scan_start_native_source_current_v1();
drop function clued_private.ci_scan_start_verify_principal_v1(uuid,jsonb);
drop function clued_private.ci_scan_start_verify_core_principal_v1(uuid,jsonb);

-- PL/pgSQL calls are not catalog dependencies: refuse if any body still names
-- a dropped function.
do $ci_scan_start_native_direct_refs_v1$ begin
  if exists(select 1 from pg_catalog.pg_proc p where p.prosrc ~
      'ci_scan_start_native_source_current_v1|ci_scan_start_verify_principal_v1|ci_scan_start_verify_core_principal_v1') then
    raise exception 'ci_scan_start_native_direct_reference_left' using errcode='55000'; end if;
end $ci_scan_start_native_direct_refs_v1$;
