-- The P5 Binding expiry column is repository-only, not a production dependency.
-- Match the existing resolver's optional expiry check without changing grants,
-- Project checks, Storage checks, function identity, or callable surface.
do $migration$
declare
  body text;
  anchor text:=$a$  select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_owner
    and revoked_at is null and (expires_at is null or expires_at>clock_timestamp());
  if not found then return false; end if;$a$;
  replacement text:=$r$  select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_owner
    and revoked_at is null;
  if not found or coalesce((to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp(),false) then return false; end if;$r$;
begin
  body:=pg_get_functiondef('clued_private.task_goal_delivery_scope_read_v1(uuid,uuid,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'task_goal_delivery_optional_expiry_definition_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $migration$;
