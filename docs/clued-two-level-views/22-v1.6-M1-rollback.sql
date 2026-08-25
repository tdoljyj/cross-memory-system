-- Clued v1.6 M1 fast rollback (non-destructive).
-- 1. Roll Worker traffic back to version bb56e002-583f-4893-b53a-6a347267a978.
-- 2. Apply this SQL if legacy V2 clients must write again.
-- New M1 columns/tables/receipts are intentionally retained for audit and forward recovery.

grant execute on function public.clued_record_write(text,jsonb) to anon;
grant execute on function public.clued_user_record_write(jsonb) to authenticated;
grant execute on function public.clued_project_observe(text,jsonb),public.clued_project_update(text,jsonb) to anon;
grant execute on function public.clued_user_project_observe(jsonb),public.clued_user_project_update(jsonb) to authenticated;

create or replace function public.clued_oauth_call(p_tool text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_input jsonb:=coalesce(p_input,'{}');
begin
  v_binding:=clued_private.resolve_oauth_binding();
  case p_tool
    when 'clued_session_resume' then return public.clued_mcp_restore(v_binding.token_hash,v_input);
    when 'clued_append_event' then return public.clued_mcp_append_event(v_binding.token_hash,v_input);
    when 'clued_session_checkpoint' then return public.clued_mcp_commit_checkpoint(v_binding.token_hash,v_input);
    when 'clued_search_context' then return public.clued_mcp_search_context(v_binding.token_hash,v_input);
    when 'clued_read_log' then return public.clued_mcp_read_log(v_binding.token_hash,v_input);
    when 'clued_import_log' then return public.clued_mcp_import_log(v_binding.token_hash,v_input);
    when 'clued_audit_receipts' then return public.clued_mcp_audit_receipts(v_binding.token_hash,v_input);
    when 'clued_project_observe' then return public.clued_project_observe(v_binding.token_hash,v_input);
    when 'clued_project_list' then return public.clued_project_list(v_binding.token_hash,v_input);
    when 'clued_project_update' then return public.clued_project_update(v_binding.token_hash,v_input);
    when 'clued_record_list' then return public.clued_record_list(v_binding.token_hash,v_input);
    when 'clued_record_write' then return public.clued_record_write(v_binding.token_hash,v_input);
    when 'clued_record_mutate' then return public.clued_record_mutate(v_binding.token_hash,v_input);
    when 'clued_decision_supersede' then return public.clued_decision_supersede(v_binding.token_hash,v_input);
    when 'clued_evidence_ingest' then return public.clued_evidence_ingest(v_binding.token_hash,v_input);
    when 'clued_event_append' then return public.clued_event_append(v_binding.token_hash,v_input);
    when 'clued_project_mutate' then return public.clued_project_mutate(v_binding.token_hash,v_input);
    when 'clued_canonical_export' then return public.clued_canonical_export(v_binding.token_hash,v_input);
    else raise exception 'unknown_oauth_tool' using errcode='22023';
  end case;
end $$;

revoke all on function public.clued_oauth_call(text,jsonb) from public,anon;
grant execute on function public.clued_oauth_call(text,jsonb) to authenticated;
notify pgrst,'reload schema';
