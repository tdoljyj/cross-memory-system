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
}
