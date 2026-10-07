# Database security hygiene (clued-prod)

P0-4, Clued Task `9a4d6d2c`, Owner Decision `eed7154f`. Migration
`apps/clued-cloud/supabase/migrations/20261007120000_db_security_hygiene.sql`,
test `apps/clued-cloud/tests/db-security-hygiene-db.test.mjs`.

## Findings, 2026-10-07

From a read-only review of production (Supabase security advisor, catalog
queries, 24 hours of edge logs) and a search of the repository for callers.
Production runs PostgreSQL 17.6.

| Advisor finding | Count | Level |
|---|---|---|
| `rls_enabled_no_policy` (111 in `clued_private`, 6 in `mtpe_m0`) | 117 | INFO |
| `anon_security_definer_function_executable` | 80 | WARN |
| `authenticated_security_definer_function_executable` | 86 | WARN |
| `function_search_path_mutable` | 3 | WARN |
| `auth_leaked_password_protection` | 1 | WARN |

What the catalog showed behind them:

- Of 171 functions in `public`, 82 were executable by `anon` and 89 by
  `authenticated`; 3 were executable by `PUBLIC` (every role):
  `clued_development_oauth_call_v14` and the production-only
  `mtpe_m0_structure_digest` and `mtpe_m0_grants_digest`.
- 16 SECURITY DEFINER functions were executable by both `anon` and
  `authenticated`. Every caller reaches them as `anon`: the Worker sends the
  publishable key and the function authenticates the Binding or issuer by its
  token hash. Every call to them in the 24 hours of edge logs came with the
  publishable key.
- 14 RPCs had no production caller (8 executable by `anon`, 6 by
  `authenticated`): retired versions the Worker replaced with `_v2` successors,
  a self-revoke path nothing calls, a retired exemption flow and the MTPE
  digests. Tests still call 7 of them (see Kept).
- `clued_private.legacy_inventory_complete` and `mtpe_m0.guard_condition6_d3_change`
  were executable through `PUBLIC`.
- `clued_private.authorization_scope_union_v12` and the two MTPE digests had a
  mutable `search_path`.
- `anon` held TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on 5 public tables
  (`clued_agent_bindings`, `clued_audit_receipts`, `clued_context_checkpoints`,
  `clued_context_events`, `clued_context_heads`), `authenticated` on those and
  `devices` and `profiles`. TRUNCATE ignores RLS. postgres's default privileges in
  `public` granted the same to every new table.

## What the migration changes

Only privileges and one setting; nothing is created, dropped or rewritten.

1. EXECUTE revoked from `PUBLIC`, `anon` and `authenticated`:
   `clued_development_oauth_call_v14(jsonb)`, `clued_authorization_revoke_self_v12(text)`,
   `clued_canonical_export(text, jsonb)`, `clued_project_list(text, jsonb)`,
   `clued_user_project_list(jsonb)`, and in production also `mtpe_m0_structure_digest()`
   and `mtpe_m0_grants_digest()` (whose `search_path` is pinned to `''`).
2. EXECUTE revoked from `PUBLIC`: `clued_private.legacy_inventory_complete(uuid)`
   and, in production, `mtpe_m0.guard_condition6_d3_change()`.
3. EXECUTE revoked from `authenticated`, kept for `anon`: the nine
   `clued_integration_*_v1` Binding RPCs, `clued_authorization_revoke_issuer_v12`,
   `clued_authorization_status_v12`, `clued_development_call_v14`,
   `clued_mcp_audit_receipts`, `clued_mcp_search_context`. This narrows
   IntegrationRuntime v0.1.8 §5.13 for the Binding path to `anon`;
   `.github/workflows/clued-integration-runtime-config.yml` now expects that and
   requires this migration to be recorded.
4. `clued_private.authorization_scope_union_v12(jsonb)` gets `search_path = ''`.
5. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN revoked from `anon` and
   `authenticated` on every relation in `public`, and removed from postgres's
   default privileges there. `service_role` is unchanged. MAINTAIN is guarded by
   `server_version_num >= 170000`.

Production-only objects are handled in guarded DO blocks, so CI's `db reset`
applies the file unchanged. Expected advisor counts afterwards: 76 and 69 for the
two SECURITY DEFINER findings, 0 for `function_search_path_mutable`.

### Kept

These have no production caller but a test on a migrated database calls them,
so their grants stay until those tests move to the successors:

| Function | Kept for | Called by |
|---|---|---|
| `clued_project_mutate(text, jsonb)` | `anon` | about ten db tests create projects through it |
| `clued_storage_jobs_v2(text, jsonb)` | `anon` | `resource-center-policy-transition-db.fixture.mjs` |
| `clued_storage_recovery_oauth_start_v1(text, jsonb)` | `authenticated` | `resource-center-credential-recovery-oauth-db.fixture.mjs` |
| `clued_user_canonical_export(jsonb, text)`, `clued_user_project_mutate(jsonb, text)` | `authenticated` | `supabase/tests/m1_runtime_contracts.test.sql` (G4 gate) |
| `clued_work_claim_exemption_confirmation_issue_v1(jsonb)`, `clued_work_claim_exemption_grant_v1(jsonb)` | `authenticated` | `work-claims-owner-grants-db.test.mjs` (confirming an in-flight token; the retirement refusal) |

## Why the 117 `rls_enabled_no_policy` findings are benign

They are all in `clued_private` (111) and `mtpe_m0` (6). `anon`,
`authenticated` and `service_role` have no USAGE on either schema, so PostgREST
cannot reach those tables at all; they are read and written only by SECURITY
DEFINER functions. RLS with no policy is a second lock that denies everything
to any role that ever gets through the first.

## Rollback

```sql
grant execute on function public.clued_development_oauth_call_v14(jsonb) to public;
grant execute on function public.clued_authorization_revoke_self_v12(text) to anon, authenticated;
grant execute on function public.clued_canonical_export(text, jsonb) to anon;
grant execute on function public.clued_project_list(text, jsonb) to anon;
grant execute on function public.clued_user_project_list(jsonb) to authenticated;
grant execute on function public.mtpe_m0_structure_digest() to public;     -- production only
grant execute on function public.mtpe_m0_grants_digest() to public;        -- production only
grant execute on function clued_private.legacy_inventory_complete(uuid) to public;
grant execute on function mtpe_m0.guard_condition6_d3_change() to public;  -- production only
-- each of the 14 functions in item 3:
grant execute on function public.clued_integration_status_v1(text, jsonb) to authenticated;
alter function clued_private.authorization_scope_union_v12(jsonb) reset search_path;
grant truncate, references, trigger, maintain on all tables in schema public to anon, authenticated;
alter default privileges for role postgres in schema public
  grant truncate, references, trigger, maintain on tables to anon, authenticated;
```

Production originally granted the table privileges only on the seven tables
named above; the blanket grant is broader than the original state.

## Left for later

- **Token hashing inside the database.** The `anon` RPCs take `p_token_hash`,
  and the stored hash is the credential: anyone who obtains a hash (a dump, a
  backup, a log) can call as that Binding with the publishable key. Sending the
  token and hashing it inside the function would make a leaked hash useless.
- **G6 gate trusts `__transport_source_commit`.** The Worker adds its build SHA
  to the `clued_mcp_currentness_g6_gate` payload, but the RPC is directly
  callable through PostgREST, so a Binding holder can send any SHA.
- **MTPE test schemas.** `mtpe_m0_test` (four functions executable by `PUBLIC`)
  and `mtpe_m0_work` remain in production. Export them and drop them; no API role
  has USAGE on them, so this is latent.
- **Leaked-password protection.** A Supabase Auth dashboard setting; the Owner
  turns it on.
- **Contract text.** IntegrationRuntime v0.1.8 §5.13 still says
  `anon, authenticated` for the Binding path.
- **Kept functions.** Move the tests in the table above to the successors, then
  revoke those grants too.
