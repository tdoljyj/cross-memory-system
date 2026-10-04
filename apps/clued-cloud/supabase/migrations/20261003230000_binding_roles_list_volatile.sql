-- PostgREST runs a STABLE or IMMUTABLE RPC in a read-only transaction. The
-- Native owner check (clued_private.authorization_owner_v12) locks the account
-- row with SELECT ... FOR SHARE, which a read-only transaction refuses, so
-- /bindings failed with "cannot execute SELECT FOR SHARE in a read-only
-- transaction". GET /v1/projects reaches the same check through
-- clued_user_project_list_v2. Both become VOLATILE, like
-- clued_owner_grants_list_v1; their bodies are unchanged. Each is altered only
-- where it exists, because some database tests apply migrations out of order.
do $$
declare f regprocedure;
begin
  foreach f in array array[to_regprocedure('public.clued_binding_roles_list_v1(jsonb)'),
      to_regprocedure('public.clued_user_project_list_v2(jsonb)')] loop
    if f is not null then execute format('alter function %s volatile', f); end if;
  end loop;
end $$;
notify pgrst, 'reload schema';
