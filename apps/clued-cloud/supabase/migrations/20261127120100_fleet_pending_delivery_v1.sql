-- Match the delivery registry's registration states in both the signed probe
-- and its peer projection. Scheduling and duty eligibility stay separate.
do $patch$
declare fn regprocedure; body text;
  anchor constant text := $a$n.state in ('active','draining')$a$;
  replacement constant text := $r$n.state in ('pending','active','draining')$r$;
begin
  foreach fn in array array[
    'clued_private.fleet_node_target_v1(uuid,uuid)'::regprocedure,
    'public.clued_ci_connection_renew_v1(jsonb)'::regprocedure
  ] loop
    body := pg_get_functiondef(fn);
    if length(body)-length(replace(body,anchor,'')) <> length(anchor) then
      raise exception 'fleet_pending_delivery_patch_anchor_mismatch: %',fn;
    end if;
    execute replace(body,anchor,replacement);
  end loop;
end $patch$;
