// Database tests insert Bindings straight into public.clued_agent_bindings, without the v12 issuance flow.
// Since migration 20261009050000 such a Binding is refused unless clued_private.raw_binding_grants_v1 names
// it (P0-4 step 7b, Clued Task 9a4d6d2c, Decision d0458559). Call this after applying the migrations, with the
// owner connection: it grants every Binding that has no v12 authorization, now and inserted later, what its
// row names (any scope or context, every action), which is how such Bindings worked before. resolve_binding still
// checks the row's scopes, context keys and revocation. Only test databases get this trigger; production
// rows are written by migrations. tests/raw-binding-grants-guard.test.mjs checks that every test inserting
// Bindings calls it.

export async function allowRawTestBindings(client) {
  // Before migration 20261009050000 raw Bindings still pass, so a call after a partial apply does nothing.
  if (!(await client.query(`select to_regclass('clued_private.raw_binding_grants_v1') is not null as ready`)).rows[0].ready) return;
  await client.query(`
    create or replace function clued_private.test_raw_binding_grant_v1() returns trigger
    language plpgsql security definer set search_path='' as $$
    begin
      insert into clued_private.raw_binding_grants_v1(binding_id, context_key, actions, reason)
      values (new.id, null, array['read','write','close','restore','audit','feedback_submit'], 'database test fixture')
      on conflict (binding_id) do nothing;
      return null;
    end $$;
    drop trigger if exists test_raw_binding_grant_v1 on public.clued_agent_bindings;
    create trigger test_raw_binding_grant_v1 after insert on public.clued_agent_bindings
      for each row execute function clued_private.test_raw_binding_grant_v1();
    revoke all on function clued_private.test_raw_binding_grant_v1() from public;
    insert into clued_private.raw_binding_grants_v1(binding_id, context_key, actions, reason)
    select b.id, null, array['read','write','close','restore','audit','feedback_submit'], 'database test fixture'
      from public.clued_agent_bindings b
     where not exists (select 1 from clued_private.authorizations_v12 a where a.binding_id = b.id)
    on conflict (binding_id) do nothing;`);
  // Only a direct test administrator INSERT gets the early writer protocol.
  // current_user is postgres inside SECURITY DEFINER Native RPCs too, so it is
  // intentionally not used. SET ROLE authenticated/gateway remains untouched;
  // negative late/fake-guard tests explicitly remove these fixture triggers.
  if ((await client.query(`select to_regprocedure('clued_private.authorization_writer_guard_v2(uuid)') is not null as ready`)).rows[0].ready) {
    await client.query(`
      create or replace function clued_private.test_authorization_early_writer_v2() returns trigger
      language plpgsql security definer set search_path='' as $$
      declare test_owner uuid;
      begin
        if session_user <> 'postgres' or coalesce(current_setting('role',true),'none') <> 'none' then return new; end if;
        if tg_table_name='clued_projects' then test_owner:=new.user_id;
        elsif tg_table_name='development_spaces_v14' then test_owner:=new.owner_id;
        else select b.user_id into test_owner from public.clued_agent_bindings b where b.id=new.binding_id;
        end if;
        perform clued_private.authorization_writer_guard_v2(test_owner);
        return new;
      end $$;
      revoke all on function clued_private.test_authorization_early_writer_v2() from public,anon,authenticated,service_role;
      drop trigger if exists test_authorization_early_writer_v2 on public.clued_projects;
      create trigger test_authorization_early_writer_v2 before insert on public.clued_projects
        for each row execute function clued_private.test_authorization_early_writer_v2();
      drop trigger if exists test_authorization_early_writer_v2 on clued_private.development_spaces_v14;
      create trigger test_authorization_early_writer_v2 before insert on clued_private.development_spaces_v14
        for each row execute function clued_private.test_authorization_early_writer_v2();
      drop trigger if exists test_authorization_early_writer_v2 on clued_private.authorization_entries_v12;
      create trigger test_authorization_early_writer_v2 before insert on clued_private.authorization_entries_v12
        for each row execute function clued_private.test_authorization_early_writer_v2();`);
  }
}
