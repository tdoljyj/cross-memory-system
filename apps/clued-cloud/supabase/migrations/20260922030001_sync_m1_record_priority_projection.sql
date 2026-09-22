-- BUG-20260922-001: M1 type_fields.priority is the write contract, while
-- clued_records_v2 and record_list_core still sort on the compatibility column.
-- Keep the latter derived on every M1 write without changing legacy rows.
create or replace function clued_private.m1_sync_record_priority()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.type_fields ? 'priority' then
    new.priority := coalesce((new.type_fields->>'priority')::smallint, 0);
  elsif tg_op='UPDATE' and old.type_fields ? 'priority' then
    -- Explicitly removing the override returns this Record to the M1 default.
    new.priority := 0;
  end if;
  return new;
end $$;

revoke all on function clued_private.m1_sync_record_priority() from public, anon, authenticated;

create trigger clued_m1_record_priority_sync
  before insert or update of type_fields on public.clued_memories
  for each row when (new.record_schema_version is not null)
  execute function clued_private.m1_sync_record_priority();

-- Only records with an explicit M1 priority can be repaired mechanically.
-- Older imported records can carry a meaningful compatibility priority with
-- no type_fields.priority; preserve those, along with Record version,
-- updated_at, content_hash, lifecycle and every legacy row.
update public.clued_memories
   set priority = coalesce((type_fields->>'priority')::smallint, 0)
 where record_schema_version is not null
   and type_fields ? 'priority'
   and priority is distinct from coalesce((type_fields->>'priority')::smallint, 0);
