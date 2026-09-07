-- NOT APPLIED. Candidate forward migration only after the accepted scope contract
-- is confirmed and the isolated fixture demonstrates before/after behavior.
-- Keeps the existing function signature and grants; requires both scopes already
-- advertised by Worker publicToolPolicies.clued_canonical_export.
create or replace function public.clued_canonical_export(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  if not ('audit:read'=any(v_binding.scopes)) then
    raise exception 'binding_not_authorized' using errcode='42501';
  end if;
  return clued_private.canonical_export_core(v_binding.user_id,v_binding.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','export','payload',p_input)));
end $$;
