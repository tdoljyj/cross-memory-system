-- Work Claim Admission v0.1, step 2 (development/contracts/execution-admission/
-- WorkClaimAdmission.v0.1.md §4.2, §8.2): transport support for the Worker.
--
-- * clued_work_claims_active_v1: the read the Worker folds into
--   clued_session_resume as active_work_claims, so a compliant Agent sees who
--   holds what, over which paths and triggers, before it spends anything.
-- * clued_oauth_call learns the five work-claim tools and the active read, so a
--   delegated OAuth caller reaches the same RPCs as a clued_bnd_ token.
--
-- Depends on 20261001060000_work_claims_v1.sql. Adds objects only.

create function public.clued_work_claims_active_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global');
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_claims jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  -- Live claims of this user in every scope the Binding may read. Expiry is
  -- judged by the clock here; the write RPCs persist EXPIRED on their next call.
  select coalesce(jsonb_agg(clued_private.work_claim_view(w) order by w.expires_at,w.claim_id),'[]'::jsonb)
    into v_claims
    from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now
      and ('*'=any(v_binding.context_keys) or w.context_key=any(v_binding.context_keys));
  return jsonb_build_object('status','ok','observed_at',v_now,'scope',v_scope,
    'active_work_claims',v_claims,'work_claim_profile',clued_private.work_claim_profile_v1());
end $$;
revoke all on function public.clued_work_claims_active_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_work_claims_active_v1(text,jsonb) to anon;

-- Delegated OAuth reaches the same Binding entries as a clued_bnd_ token
-- (same anchor patch as 20260924180000).
do $migration$
declare body text; anchor text:=$anchor$    else raise exception 'unknown_oauth_tool' using errcode='22023';$anchor$;
begin
  body:=pg_get_functiondef('public.clued_oauth_call(text,jsonb)'::regprocedure);
  if strpos(body,anchor)=0 or strpos(body,'clued_work_claim')>0 then
    raise exception 'oauth_call_definition_mismatch';
  end if;
  execute replace(body,anchor,$cases$    when 'clued_work_claim' then return public.clued_work_claim_v1(v_binding.token_hash,v_input);
    when 'clued_work_renew' then return public.clued_work_renew_v1(v_binding.token_hash,v_input);
    when 'clued_work_release' then return public.clued_work_release_v1(v_binding.token_hash,v_input);
    when 'clued_work_verify' then return public.clued_work_verify_v1(v_binding.token_hash,v_input);
    when 'clued_work_takeover' then return public.clued_work_takeover_v1(v_binding.token_hash,v_input);
    when 'clued_work_claims_active' then return public.clued_work_claims_active_v1(v_binding.token_hash,v_input);
$cases$||anchor);
end $migration$;

notify pgrst,'reload schema';
