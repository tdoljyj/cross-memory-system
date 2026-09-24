-- Restore the v12 direct-human guard on public.clued_user_decision_supersede.
--
-- 20260907173031_clued_connection_authorization_v12 rewrote every public
-- clued_user_* RPC from auth.uid() to clued_private.authorization_owner_v12(),
-- which refuses delegated OAuth JWTs (client_id), missing users and unavailable
-- accounts. 20260924190000_information_flow_promotion (S3) redefined this entry
-- from its pre-v12 body with auth.uid(), so a delegated OAuth JWT could again
-- supersede Canonical Decisions through PostgREST and /v1/decisions/supersede.
-- This additive migration restores the guard. Every committed call now comes
-- from a direct human account session, so the S3 Native marker is always
-- written for a fresh commit (native_write_marker_v1 skips replays and
-- rejections). CREATE OR REPLACE keeps the authenticated-only grant.
create or replace function public.clued_user_decision_supersede(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_result jsonb;
begin
  v_result:=clued_private.decision_supersede_core(v_owner,null,p_input,p_received_payload_hash);
  perform clued_private.native_write_marker_v1(v_owner,v_result,'decision_supersede');
  return v_result;
end $$;

revoke all on function public.clued_user_decision_supersede(jsonb,text) from public,anon,service_role;
grant execute on function public.clued_user_decision_supersede(jsonb,text) to authenticated;

notify pgrst,'reload schema';
