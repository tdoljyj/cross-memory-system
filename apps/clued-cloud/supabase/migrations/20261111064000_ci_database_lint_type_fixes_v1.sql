-- Forward-only repair of two type errors exposed by the complete G4 replay.
-- Historical migration text, Native source guards and existing ACLs stay intact.
do $ci_database_lint_type_fixes_v1$
declare
  signature text;
  anchor text;
  replacement text;
  target regprocedure;
  definition text;
begin
  for signature,anchor,replacement in
    select * from (values
      ('clued_private.ci_scan_start_verify_principal_v1(uuid,jsonb)',
       $old$    return clued_private.work_claim_ci_command_v1(p_binding_id,p_input);$old$,
       $new$    raise exception 'ci_scan_start_verify_action_forbidden' using errcode='22023';$new$),
      ('clued_private.work_claim_independent_abort_v1(text,jsonb)',
       $old$r.object_id=p.claim_id and r.metadata$old$,
       $new$r.object_id=p.claim_id::text and r.metadata$new$)
    ) patches(signature,anchor,replacement)
  loop
    target:=to_regprocedure(signature);
    if target is null then
      raise exception 'ci_database_lint_source_unexpected: %',signature using errcode='55000';
    end if;
    definition:=pg_get_functiondef(target);
    if (length(definition)-length(replace(definition,anchor,'')))<>length(anchor) then
      raise exception 'ci_database_lint_source_unexpected: %',signature using errcode='55000';
    end if;
    -- CREATE OR REPLACE keeps ownership, ACLs, SECURITY DEFINER and search_path.
    -- The private UUID-principal clone accepts ordinary verification only; its
    -- fixed scan-start caller never supplies action. No token is synthesized.
    execute replace(definition,anchor,replacement);
  end loop;
end
$ci_database_lint_type_fixes_v1$;
