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

### Tests

`.github/workflows/clued-connection-authorization.yml` runs
`db-security-hygiene-db.test.mjs` on every change to a migration, without
`--test-force-exit`: the file stops its embedded PostgreSQL servers itself.

`integration-runtime-identity-db.test.mjs` and
`integration-runtime-lifecycle-db.test.mjs` apply the migrations in production
order: `20261005163000_integration_runtime_grants` in its sorted place, this
migration after it. Each checks exactly §5.13 right after the grant migration
and, after every later migration, that the nine `clued_integration_*_v1` RPCs
are executable by `anon` only.

`integration-runtime-verification-db.test.mjs:338` still asserts the old grants
(`anon, authenticated` on the Binding path). It passes only because it applies
the grant migration last, after this one, which grants `authenticated` back.
It will be moved to production order in a follow-up once the session that
holds that file releases it.

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

## Credential table privileges, 2026-10-08

Migration `20261008150000_credential_table_privileges_v1.sql` (P0-4 step 1,
Owner Decisions `1427642f` and `096df8b8`). Production gave `authenticated`
SELECT, INSERT, UPDATE and DELETE on `public.clued_agent_bindings`; the
migrations grant only SELECT, so the rest was granted outside the repository.
Row security limits each user to their own rows, but a stolen session could
read a working `token_hash`, insert a Binding outside the v12 issuance flow
(`authorization_assert_entry_v12` lets a Binding without an
`authorizations_v12` row through), rewrite a Binding's `token_hash`, or
un-revoke one.

After the migration a signed-in session can:

- read every column of `clued_agent_bindings` and `clued_continuity_sessions`
  except `token_hash` (column-level SELECT);
- set `revoked_at` on a live Binding, and nothing else: UPDATE is granted on
  that column only, and the trigger `clued_agent_bindings_session_revoke_only`
  refuses un-revoking or moving it when the current role is `authenticated`.

That is exactly what the Worker does with the user's session
(`worker/continuity.ts` `listBindings` and `revokeBinding`). SECURITY DEFINER
functions run as their owner and are unaffected. Test:
`apps/clued-cloud/tests/credential-table-privileges-db.test.mjs`.

Rollback (restores the production state before the migration):

```sql
drop trigger if exists clued_agent_bindings_session_revoke_only on public.clued_agent_bindings;
drop function if exists clued_private.agent_binding_session_revoke_only_v1();
grant select, insert, update, delete on table public.clued_agent_bindings to authenticated;
grant select on table public.clued_continuity_sessions to authenticated;
notify pgrst, 'reload schema';
```

## Left for later

- **Stored hash is the credential; G6 trusts `__transport_source_commit`.**
  Designed in
  [DatabaseCallerAuthentication.v0.1](../../development/contracts/database-access/DatabaseCallerAuthentication.v0.1.md)
  (Task `9a4d6d2c`, Owner Decision `1427642f`): the database stores a verifier,
  `sha256` of what callers send, so a leaked column is useless and no caller
  changes; the Worker moves to its own database role, which also closes the G6
  claim. Each step is its own PR and Owner approval.
- **MTPE test schemas.** `mtpe_m0_test` (four functions executable by `PUBLIC`)
  and `mtpe_m0_work` remain in production. Export them and drop them; no API role
  has USAGE on them, so this is latent.
- **Leaked-password protection.** A Supabase Auth dashboard setting; the Owner
  turns it on.
- **Contract text.** IntegrationRuntime v0.1.8 §5.13 still says
  `anon, authenticated` for the Binding path.
- **Kept functions.** Move the tests in the table above to the successors, then
  revoke those grants too.
