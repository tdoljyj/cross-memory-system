-- Tighten generated table grants to the exact Clued Memory API surface.
revoke all on table public.clued_memories from anon, authenticated;
revoke all on table public.clued_memory_audit from anon, authenticated;

grant select, insert, update, delete
  on table public.clued_memories
  to authenticated;
grant select
  on table public.clued_memory_audit
  to authenticated;

notify pgrst, 'reload schema';
