-- Close "a Binding without a v12 authorization is let through" (P0-4 step 7b; Clued Task 9a4d6d2c, Owner
-- Decisions 096df8b8, 29bff239 and d0458559; development/contracts/database-access/DatabaseCallerAuthentication.v0.1.md
-- §4.6 and §8 step 7).
--
-- clued_private.authorization_assert_entry_v12 returned without any check when a Binding had no
-- clued_private.authorizations_v12 row, so a Binding inserted outside the v12 issuance flow carried whatever
-- scopes and context keys its row named. After step 7a the only live Binding like that in production is the
-- Projection Builder (05effaa9), and clued_private.projection_refresh_builder_binding refuses a Builder Binding
-- that has a v12 authorization, so it cannot be given one.
--
-- From here a Binding without a v12 authorization is refused unless clued_private.raw_binding_grants_v1 names
-- it, and then only for the scope and actions that row lists. Only the database owner can write that table.
-- This migration gives the Projection Builder one row: scope `global`, action `read`, which is all its
-- refresh RPCs ask for (resolve_binding(..., 'context:read', 'global')). Applying it twice changes nothing.

create table if not exists clued_private.raw_binding_grants_v1 (
  binding_id uuid primary key references public.clued_agent_bindings(id) on delete cascade,
  -- null: any scope or context, as before this migration. Only test fixtures use it; a production row names one scope.
  context_key text check (context_key is null or length(context_key) between 1 and 160),
  actions text[] not null check (cardinality(actions) > 0
    and actions <@ array['read','write','close','restore','audit','feedback_submit']::text[]),
  reason text not null check (length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp()
);
revoke all on clued_private.raw_binding_grants_v1 from public, anon, authenticated, service_role;

insert into clued_private.raw_binding_grants_v1(binding_id, context_key, actions, reason)
select b.id, 'global', array['read'],
       'Projection Builder: its refresh RPCs resolve context:read on global, and '
       || 'projection_refresh_builder_binding refuses a v12 authorization (Decision 29bff239)'
  from public.clued_agent_bindings b
 where b.id = '05effaa9-966d-43ad-904b-1f3426394410'::uuid
   and b.revoked_at is null
   and not exists (select 1 from clued_private.authorizations_v12 a where a.binding_id = b.id)
on conflict (binding_id) do nothing;

-- The body below is the current one (20260907173032 and the project:* line from 20261004210000) with the
-- `if not found then return; end if;` after the authorization lookup replaced.
create or replace function clued_private.authorization_assert_entry_v12(p_binding uuid,p_kind text,p_id text,p_environment text,p_action text)
returns void language plpgsql security definer set search_path='' as $$
declare a clued_private.authorizations_v12; e clued_private.authorization_entries_v12; m clued_private.project_memberships_v13;
begin
 if p_kind='scope' and p_id='project:*' then raise exception 'resource_action_not_authorized' using errcode='42501'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for share;
 if not found then
  -- No v12 authorization: only an explicit raw grant, for the scope it names (null: any resource).
  if exists(select 1 from clued_private.raw_binding_grants_v1 g
      where g.binding_id=p_binding and p_action=any(g.actions)
        and (g.context_key is null or (p_kind='scope' and g.context_key=p_id))) then
   return;
  end if;
  raise exception 'resource_action_not_authorized' using errcode='42501';
 end if;
 perform clued_private.authorization_account_v12(a.owner_id);
 if a.revoked_at is not null or a.expires_at<=clock_timestamp() then raise exception 'authorization_revoked_or_expired' using errcode='42501'; end if;
 select * into e from clued_private.authorization_entries_v12 where binding_id=p_binding and resource_kind=p_kind and resource_id=p_id and environment=p_environment;
 if not found or not(p_action=any(e.actions)) then raise exception 'resource_action_not_authorized' using errcode='42501'; end if;
 if e.qualification_id is not null then
  if p_kind<>'context' then raise exception 'qualification_resource_mismatch' using errcode='42501'; end if;
  m:=clued_private.project_context_membership_v13(a.owner_id,p_id::uuid,p_environment,e.qualification_id);
  if not(p_action=any(m.actions)) then raise exception 'current_project_action_required' using errcode='42501'; end if;
  perform 1 from clued_private.development_spaces_v14 where id=p_id::uuid and environment=p_environment for update;
 else
  -- A previously owned entry cannot silently acquire a new member role.
  perform clued_private.authorization_owner_resource_v12(a.owner_id,p_kind,p_id,p_environment);
 end if;
end $$;
