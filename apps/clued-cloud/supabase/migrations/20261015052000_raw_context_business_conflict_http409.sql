-- A stale raw Record is a business conflict, not a database serialization
-- failure. PostgREST 14 retries SQLSTATE 40001; PT409 returns HTTP 409 instead.
-- Both owned and membership-qualified writes reach this same v14 kernel.
-- Preserve its guards, message, rollback, identity and privileges exactly.
do $migration$
declare
  target regprocedure := to_regprocedure('clued_private.development_execute_authorized_v14(uuid,uuid,jsonb)');
  old_raise text := $old$raise exception 'record_version_conflict' using errcode='40001';$old$;
  new_raise text := $new$raise exception 'record_version_conflict' using errcode='PT409';$new$;
  original_definition text;
  expected_definition text;
  original_metadata jsonb;
  current_metadata jsonb;
  old_count integer;
  new_count integer;
begin
  if target is null then
    raise exception 'raw_context_conflict_kernel_missing';
  end if;
  select pg_get_functiondef(p.oid), to_jsonb(p) - 'prosrc'
    into original_definition, original_metadata from pg_proc p where p.oid=target;
  old_count := (length(original_definition)-length(replace(original_definition,old_raise,'')))/length(old_raise);
  new_count := (length(original_definition)-length(replace(original_definition,new_raise,'')))/length(new_raise);
  if old_count=0 and new_count=2 then
    return; -- An exact replay is harmless; mixed or unfamiliar bodies fail closed.
  end if;
  if old_count<>2 or new_count<>0 then
    raise exception 'raw_context_conflict_kernel_unexpected_raise_count';
  end if;
  expected_definition := replace(original_definition,old_raise,new_raise);
  execute expected_definition;
  select to_jsonb(p) - 'prosrc' into current_metadata from pg_proc p where p.oid=target;
  if current_metadata is distinct from original_metadata
     or pg_get_functiondef(target) is distinct from expected_definition then
    raise exception 'raw_context_conflict_kernel_identity_or_definition_changed';
  end if;
  -- No exception handler: genuine engine serialization failures and all other
  -- business errors retain their original SQLSTATE and transaction semantics.
end
$migration$;
