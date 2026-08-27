-- P5 second independent-review repair: an exact retry may share one open
-- Attempt with another Worker request.  The Attempt row is the serialization
-- point, so bind it to the complete request before looking at its state.  A
-- terminal exact match replays the stored canonical result; every mismatch or
-- ambiguous state remains fail-closed.

create or replace function public.clued_p5_mutate(
  p_token_hash text,p_input jsonb,p_attempt_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v record; v_attempt public.clued_p5_gateway_attempts%rowtype; v_result jsonb;
  v_hash text:=clued_private.p5_sha256(p_input-'session_token');
begin
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  select * into v_attempt from public.clued_p5_gateway_attempts a where a.id=p_attempt_id for update;
  if not found then raise exception 'P5_ATTEMPT_NOT_FOUND'; end if;

  -- The binding check must precede every terminal-state replay.  Using
  -- IS DISTINCT FROM also fails closed for missing/null request fields.
  if v_attempt.organization_id is distinct from v.organization_id
     or v_attempt.workspace_id is distinct from v.workspace_id
     or v_attempt.user_id is distinct from v.user_id
     or v_attempt.binding_id is distinct from v.binding_id
     or v_attempt.request_hash is distinct from v_hash
     or v_attempt.idempotency_key is distinct from p_input->>'idempotency_key'
     or v_attempt.target_kind is distinct from p_input->>'target_kind'
     or v_attempt.target_id is distinct from (p_input->>'target_id')::uuid
     or v_attempt.base_version is distinct from (p_input->>'base_version')::bigint then
    raise exception 'P5_ATTEMPT_REQUEST_MISMATCH';
  end if;

  if v_attempt.status in ('completed','failed') then
    if v_attempt.canonical_result is null then
      raise exception 'P5_ATTEMPT_CANONICAL_RESULT_MISSING';
    end if;
    return v_attempt.canonical_result;
  end if;
  if v_attempt.status is distinct from 'open' then
    raise exception 'P5_ATTEMPT_STATUS_UNKNOWN';
  end if;
  if v_attempt.expires_at<=now() then raise exception 'P5_ATTEMPT_EXPIRED'; end if;

  v_result:=clued_private.p5_mutate_gateway_core(p_token_hash,p_input);
  update public.clued_p5_gateway_attempts
     set status='completed',canonical_result=v_result,completed_at=now()
   where id=v_attempt.id;
  return v_result;
exception when others then
  return jsonb_build_object('status','rejected',
    'error',jsonb_build_object('type',sqlerrm,'sqlstate',sqlstate));
end $$;

revoke execute on function public.clued_p5_mutate(text,jsonb,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_p5_mutate(text,jsonb,uuid)
  to clued_p5_gateway;

notify pgrst,'reload schema';
