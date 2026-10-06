-- Read scopes evaluated once per statement (Task 5dd61a3f).
--
-- The current-view queries of reconcile, resume, checkpoint renewal and the
-- rendered log passed clued_private.binding_read_scopes_v2(...) straight into
-- record_currentness_fence in a WHERE clause. The arguments do not change
-- between rows, but a STABLE function in a per-row expression is evaluated
-- for every row, and each evaluation re-runs the Binding's authorization
-- checks. On 2026-10-06 a project of 632 State/Task/Decision rows took 3.7 s,
-- past the 3 s statement_timeout of the anon role, and every reconcile and
-- project checkpoint of that context failed with SQLSTATE 57014.
--
-- Wrapping the call in a scalar subquery makes it an InitPlan: evaluated once
-- per statement with the same arguments and snapshot, so the scopes and the
-- rows returned are unchanged (measured on the same data: 101 ms, identical
-- result). The definitions are rewritten in place from the deployed ones, as
-- 20260922143312 did; a definition that does not match exactly stops the
-- migration.

do $migration$
declare
  item record;
  body text;
  found_count integer;
begin
  for item in
    select * from (values
      ('clued_private.clued_mcp_session_reconcile_explicit_context(text,jsonb)'::regprocedure,
       'clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id))',
       '(select clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id)))', 1),
      ('public.clued_mcp_restore_before_project_access_v13(text,jsonb)'::regprocedure,
       'clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id))',
       '(select clued_private.binding_read_scopes_v2(v_binding.user_id,v_binding.id)))', 2),
      ('clued_private.renew_checkpoint_session(public.clued_agent_bindings,public.clued_continuity_sessions,bigint,uuid)'::regprocedure,
       'clued_private.binding_read_scopes_v2(p_binding.user_id,p_binding.id))',
       '(select clued_private.binding_read_scopes_v2(p_binding.user_id,p_binding.id)))', 1),
      ('clued_private.render_log(uuid,text,uuid)'::regprocedure,
       'else clued_private.binding_read_scopes_v2(p_user_id,p_binding_id) end',
       'else (select clued_private.binding_read_scopes_v2(p_user_id,p_binding_id)) end', 2)
    ) as t(target, old_text, new_text, expected)
  loop
    body := pg_get_functiondef(item.target);
    found_count := (length(body) - length(replace(body, item.old_text, ''))) / length(item.old_text);
    if found_count <> item.expected then
      raise exception 'binding_scopes_once_definition_mismatch: % has % occurrence(s), expected %',
        item.target, found_count, item.expected;
    end if;
    execute replace(body, item.old_text, item.new_text);
  end loop;
end $migration$;
