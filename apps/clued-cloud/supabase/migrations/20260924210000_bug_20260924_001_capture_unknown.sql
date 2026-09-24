-- BUG-20260924-001 L1: session compliance must not report "no material changes"
-- for a session that simply wrote nothing. The server cannot observe Host
-- conversations, so zero writes only proves that nothing reached Clued. Such a
-- session is now capture_unknown, and every session carries an explicit
-- authority_capture state that is never "complete" and is independent of
-- Currentness.

create or replace function public.clued_mcp_audit_receipts(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,20),1),100);
  v_receipts jsonb; v_sessions jsonb; v_reminder boolean:=false;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'audit:read',v_context_key);
  select coalesce(jsonb_agg(row_data order by created_at desc),'[]'::jsonb) into v_receipts from (
    select jsonb_build_object('id',r.id,'operation',r.operation,'object_type',r.object_type,'object_id',r.object_id,
      'version',r.version,'binding_id',r.binding_id,'metadata',r.metadata,'created_at',r.created_at) row_data,r.created_at
    from public.clued_audit_receipts r where r.user_id=v_binding.user_id and r.context_key=v_context_key
    order by r.created_at desc limit v_limit
  ) matches;
  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id',s.id,'client_session_id',s.client_session_id,'started_at',s.started_at,'last_seen_at',s.last_seen_at,
    'expires_at',s.expires_at,'ended_at',s.ended_at,'append_count',x.append_count,'checkpoint_count',x.checkpoint_count,
    'state',case when x.checkpoint_count>0 then 'checkpointed' when x.append_count>0 and s.expires_at<=now() then 'expired_without_checkpoint'
      when x.append_count>0 then 'checkpoint_required_before_handoff' else 'capture_unknown' end,
    'required_action',case when x.append_count>0 and x.checkpoint_count=0 then 'checkpoint_before_handoff' else null end,
    'authority_capture',case when x.append_count>0 and x.checkpoint_count=0 then 'incomplete' else 'unknown' end
  ) order by s.started_at desc),'[]'::jsonb),
  coalesce(bool_or(x.append_count>0 and x.checkpoint_count=0),false) into v_sessions,v_reminder
  from public.clued_continuity_sessions s
  cross join lateral (select
    count(*) filter(where r.operation='append') append_count,
    count(*) filter(where r.operation='checkpoint') checkpoint_count
    from public.clued_audit_receipts r where r.user_id=s.user_id and r.binding_id=s.binding_id
      and r.context_key=s.context_key and r.metadata->>'session_id'=s.id::text) x
  where s.user_id=v_binding.user_id and s.binding_id=v_binding.id and s.context_key=v_context_key
    and s.started_at>now()-interval '30 days';
  return jsonb_build_object('status','ok','context_key',v_context_key,'receipts',v_receipts,
    'session_compliance',v_sessions,'checkpoint_reminder',v_reminder,
    'authority_capture_completeness',jsonb_build_object(
      'state',case when v_reminder then 'incomplete' else 'unknown' end,
      'basis','server_observes_only_writes_that_reached_clued',
      'independent_of','currentness'));
end $$;

revoke all on function public.clued_mcp_audit_receipts(text,jsonb) from public;
grant execute on function public.clued_mcp_audit_receipts(text,jsonb) to anon;
