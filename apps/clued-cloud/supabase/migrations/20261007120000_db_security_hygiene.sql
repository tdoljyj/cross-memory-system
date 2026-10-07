-- Database permission hygiene, P0-4 (Clued Task 9a4d6d2c, Owner Decision eed7154f).
-- Findings: read-only catalog review of clued-prod on 2026-10-07, summarized in
-- docs/maintenance/database-security.md. This migration only takes privileges away and pins one
-- search_path; it creates, drops and rewrites nothing.
--
-- Every statement is idempotent. Objects that exist only in production (schema mtpe_m0 and the
-- public.mtpe_m0_*_digest functions, created by history-only migrations) are handled in guarded DO
-- blocks, so a local or CI database that lacks them applies this file unchanged. No transaction
-- control and no SELECT ... INTO: the production release workflow runs this text through plpgsql
-- EXECUTE inside its own transaction.
--
-- Rollback: the matching GRANT statements, listed in docs/maintenance/database-security.md.

-- 1. Public RPCs no caller uses: no Worker route or app page calls them, no test or SQL test calls
--    them as anon or authenticated on a database that has this migration, and the production edge
--    logs of the 24 hours before 2026-10-07 03:40 UTC hold no request for them. The Worker calls the
--    _v2 successors (clued_canonical_export_v2, clued_project_list_v2, clued_user_project_list_v2).
--    clued_development_oauth_call_v14 was executable by PUBLIC.
revoke execute on function public.clued_development_oauth_call_v14(jsonb) from public, anon, authenticated;
revoke execute on function public.clued_authorization_revoke_self_v12(text) from public, anon, authenticated;
revoke execute on function public.clued_canonical_export(text, jsonb) from public, anon, authenticated;
revoke execute on function public.clued_project_list(text, jsonb) from public, anon, authenticated;
revoke execute on function public.clued_user_project_list(jsonb) from public, anon, authenticated;

-- 1b. Production only: the MTPE M0 digest helpers were executable by PUBLIC and had a mutable
--     search_path. Their bodies use only pg_catalog and schema-qualified information_schema objects.
do $hygiene$
declare
  f text;
begin
  foreach f in array array['public.mtpe_m0_structure_digest()', 'public.mtpe_m0_grants_digest()'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
      execute format('alter function %s set search_path = %L', f, '');
    end if;
  end loop;
end
$hygiene$;

-- 2. Functions every role could execute through PUBLIC. API roles have no USAGE on clued_private or
--    mtpe_m0, so this was latent. legacy_inventory_complete is called only inside SECURITY DEFINER
--    code; guard_condition6_d3_change is a trigger function (EXECUTE is checked when the trigger is
--    created, not when it fires).
revoke execute on function clued_private.legacy_inventory_complete(uuid) from public;

do $hygiene$
begin
  if to_regnamespace('mtpe_m0') is not null
     and to_regprocedure('mtpe_m0.guard_condition6_d3_change()') is not null then
    execute 'revoke execute on function mtpe_m0.guard_condition6_d3_change() from public';
  end if;
end
$hygiene$;

-- 3. SECURITY DEFINER RPCs executable by both anon and authenticated. Every caller reaches them as
--    anon: the Worker sends the publishable key and authenticates the Binding or issuer by the token
--    hash inside the function; no app page and no user-session call names them. anon keeps EXECUTE.
--    Narrows IntegrationRuntime v0.1.8 §5.13 for the Binding path from "anon, authenticated" to anon;
--    .github/workflows/clued-integration-runtime-config.yml expects exactly this.
revoke execute on function public.clued_integration_request_open_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_integration_create_or_bind_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_integration_identity_update_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_integration_reconcile_request_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_integration_status_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_integration_declare_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_integration_report_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_integration_verify_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_integration_revoke_self_v1(text, jsonb) from authenticated;
revoke execute on function public.clued_authorization_revoke_issuer_v12(text, uuid) from authenticated;
revoke execute on function public.clued_authorization_status_v12(text) from authenticated;
revoke execute on function public.clued_development_call_v14(text, jsonb) from authenticated;
revoke execute on function public.clued_mcp_audit_receipts(text, jsonb) from authenticated;
revoke execute on function public.clued_mcp_search_context(text, jsonb) from authenticated;

-- 4. Pin the search_path of the one clued_private function without it. The body uses only
--    pg_catalog built-ins (jsonb_array_elements, jsonb_array_elements_text, array_agg, ->).
alter function clued_private.authorization_scope_union_v12(jsonb) set search_path = '';

-- 5. API roles never need TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public relations; TRUNCATE
--    is not subject to RLS. Also stop postgres's default privileges in public from granting them to
--    tables created later. service_role is not changed. MAINTAIN exists from PostgreSQL 17 on
--    (production 17.6, supabase/config.toml major_version 17, embedded-postgres 18).
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

do $hygiene$
begin
  if current_setting('server_version_num')::integer >= 170000 then
    execute 'revoke maintain on all tables in schema public from anon, authenticated';
    execute 'alter default privileges for role postgres in schema public revoke maintain on tables from anon, authenticated';
  end if;
end
$hygiene$;
