-- Credential table privileges for signed-in users (P0-4 step 1, Clued Task 9a4d6d2c, Owner Decisions
-- 1427642f and 096df8b8; development/contracts/database-access/DatabaseCallerAuthentication.v0.1.md §4.5).
--
-- authenticated held SELECT, INSERT, UPDATE and DELETE on public.clued_agent_bindings (row security limits
-- them to the user's own rows) and SELECT on public.clued_continuity_sessions. The stored token_hash is the
-- value the Binding RPCs accept, and clued_private.authorization_assert_entry_v12 lets a Binding without a
-- clued_private.authorizations_v12 row through, so a stolen session could read a working credential, insert
-- a Binding outside the v12 issuance flow, take one over by rewriting its token_hash, or un-revoke one.
--
-- The only direct table access left is what the Worker does with the user's session (worker/continuity.ts
-- listBindings and revokeBinding): read every column except token_hash, and set revoked_at on a live
-- Binding. Every other change goes through the SECURITY DEFINER functions, which this migration leaves
-- alone. Applying it twice changes nothing.

revoke select, insert, update, delete, truncate, references, trigger on table public.clued_agent_bindings
  from authenticated;
revoke select on table public.clued_continuity_sessions from authenticated;

do $grants$
declare
  t text;
  cols text;
begin
  foreach t in array array['clued_agent_bindings', 'clued_continuity_sessions'] loop
    -- Drop any column grants first so the result does not depend on what an earlier run left.
    select string_agg(quote_ident(a.attname), ',' order by a.attnum) into cols
      from pg_catalog.pg_attribute a
     where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0 and not a.attisdropped;
    execute format('revoke select, insert, update, references on table public.%I from authenticated', t);
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.%I from authenticated',
      cols, cols, cols, cols, t);
    select string_agg(quote_ident(a.attname), ',' order by a.attnum) into cols
      from pg_catalog.pg_attribute a
     where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname <> 'token_hash';
    execute format('grant select (%s) on table public.%I to authenticated', cols, t);
  end loop;
end
$grants$;

grant update (revoked_at) on table public.clued_agent_bindings to authenticated;

-- A signed-in user may revoke a live Binding and nothing else: no un-revoking, no moving revoked_at.
-- SECURITY DEFINER functions run as their owner and are not affected.
create or replace function clued_private.agent_binding_session_revoke_only_v1() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and not (old.revoked_at is null and new.revoked_at is not null) then
    raise exception 'binding_revoke_only' using errcode = '42501',
      detail = 'A signed-in session may only revoke a live Binding.';
  end if;
  return new;
end $$;

revoke all on function clued_private.agent_binding_session_revoke_only_v1() from public, anon, authenticated, service_role;

drop trigger if exists clued_agent_bindings_session_revoke_only on public.clued_agent_bindings;
create trigger clued_agent_bindings_session_revoke_only
  before update on public.clued_agent_bindings
  for each row execute function clued_private.agent_binding_session_revoke_only_v1();

notify pgrst, 'reload schema';
