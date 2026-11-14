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

`db-security-hygiene-db.test.mjs` runs in the required check `migration-verify`
(suite `production-schema` in `scripts/ci/ci-required-selection.mjs`) on every
change to a migration, without `--test-force-exit`: the file stops its embedded
PostgreSQL servers itself.

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

## Credential verifiers, 2026-10-08

Migration `20261008210000_credential_verifier_v1.sql` (P0-4 step 2a, Owner
Decisions `1427642f` and `2ec964af`). Binding and Resource Center credential
columns used to hold the value callers present, `sha256(token)`. Anyone who
read a row could call as that Binding. The columns now hold a verifier,
`'cv1:' || sha256('clued.credential-verifier.v1:' || proof)`:

| Column | Table |
|---|---|
| `token_hash` | `public.clued_agent_bindings`, `clued_private.resource_center_bindings_v1`, `resource_center_writer_bindings_v1`, `resource_center_renewals_v1` |
| `old_token_hash`, `old_reader_hash`, `old_writer_hash`, and the hashes in `request` | `clued_private.resource_center_rotations_v1` |
| `authority_token_hash` | `clued_private.resource_center_mutations_v1` |

- `clued_private.credential_verifier_v1(proof)` computes the verifier. Every
  comparison with a caller's proof goes through it. Any other input gets
  `'cv0:'`, which matches nothing.
- The trigger `credential_verifier_normalize_v1` on each table turns a written
  proof into its verifier and leaves a verifier alone. Functions and fixtures
  that write credentials do not change, and each column's check constraint only
  accepts `^cv1:[0-9a-f]{64}$`.
- A function that passes a stored credential to a function expecting a proof
  passes `clued_private.credential_internal_proof_v1(stored)` instead. That is a
  random proof which maps back to the verifier only until the transaction ends
  (setting `clued.credential_internal_v1`). This covers `clued_oauth_call`, the
  storage cloud workers and the Resource Center write journal.
- The migration ends with a guard: no function compares one of these columns
  with a raw parameter. `apps/clued-cloud/tests/credential-verifier-db.test.mjs`
  repeats that guard, also checks that no function passes a stored value on as
  a proof, and checks that a second run changes nothing.
- Functions written by later migrations must compare with
  `clued_private.credential_verifier_v1(<proof>)` too.
  `apps/clued-cloud/tests/credential-verifier-later-migrations.test.mjs` scans
  the source of every later migration for a raw comparison (either order,
  `= any(...)`, `in (...)`, `$n` and `v_` parameters, JSON fields, any case);
  each known exception is listed with its exact text and reason.
  `20261106010000_storage_route_destination_verifier_v1` fixed one such
  function (`storage_route_destination_v1`, Clued Task e21ff6fd) and repeats
  this migration's guard against `pg_proc`.

Issuer columns (`authorization_issuers_v12`, `authorization_requests_v12`,
`storage_*.issuer_hash`) are step 2b; see
[DatabaseCallerAuthentication.v0.1 §4.7](../../development/contracts/database-access/DatabaseCallerAuthentication.v0.1.md).

Production check after applying (read-only): a live Binding still works
through the Worker. Calling `clued_work_claims_active_v1` with that Binding's
stored `token_hash` as `p_token_hash` must be refused.

The old values are kept in `clued_private.credential_proof_backup_v1`, and the
rewritten function definitions in `clued_private.credential_function_backup_v1`.
Both are kept until `delete_after` (seven days); the `pg_cron` job
`clued-credential-backup-purge` then deletes them. Rollback works only while the
backup exists. Credentials issued after the migration were stored as verifiers
only, so rollback leaves them unusable; reissue them.

```sql
begin;
do $rollback$
declare
  f record;
  t record;
  c text;
begin
  for f in select definition from clued_private.credential_function_backup_v1 loop
    execute f.definition;
  end loop;
  alter table public.clued_agent_bindings disable trigger information_flow_manifest_binding_change;
  alter table clued_private.resource_center_mutations_v1 disable trigger resource_center_verified_immutable_v2;
  alter table clued_private.resource_center_mutations_v1 disable trigger storage_refresh_mutation_fence_v1;
  for t in select * from (values
      ('public', 'clued_agent_bindings', array['token_hash'], array['id']),
      ('clued_private', 'resource_center_bindings_v1', array['token_hash'], array['id']),
      ('clued_private', 'resource_center_writer_bindings_v1', array['token_hash'], array['id']),
      ('clued_private', 'resource_center_renewals_v1', array['token_hash'], array['id']),
      ('clued_private', 'resource_center_rotations_v1', array['old_token_hash', 'old_reader_hash', 'old_writer_hash'],
        array['grant_id', 'generation']),
      ('clued_private', 'resource_center_mutations_v1', array['authority_token_hash'], array['id'])
    ) v(schema_name, table_name, cols, keys) loop
    execute format('drop trigger if exists credential_verifier_normalize_v1 on %I.%I', t.schema_name, t.table_name);
    foreach c in array t.cols || case when t.table_name = 'resource_center_rotations_v1' then array['request'] else array[]::text[] end loop
      execute format('alter table %I.%I drop constraint if exists %I', t.schema_name, t.table_name, t.table_name || '_' || c || '_check');
      execute format('update %I.%I x set %I = k.old_value%s from clued_private.credential_proof_backup_v1 k
          where k.table_name = %L and k.column_name = %L and k.row_key = jsonb_build_object(%s)',
        t.schema_name, t.table_name, c, case when c = 'request' then '::jsonb' else '' end, t.table_name, c,
        (select string_agg(format('%L, x.%I', key, key), ', ') from unnest(t.keys) key));
    end loop;
  end loop;
  -- The four columns that had a format check get it back; NOT VALID skips rows issued after the migration.
  alter table public.clued_agent_bindings add constraint clued_agent_bindings_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$') not valid;
  alter table clued_private.resource_center_bindings_v1 add constraint resource_center_bindings_v1_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$') not valid;
  alter table clued_private.resource_center_writer_bindings_v1 add constraint resource_center_writer_bindings_v1_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$') not valid;
  alter table clued_private.resource_center_renewals_v1 add constraint resource_center_renewals_v1_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$') not valid;
  alter table public.clued_agent_bindings enable trigger information_flow_manifest_binding_change;
  alter table clued_private.resource_center_mutations_v1 enable trigger resource_center_verified_immutable_v2;
  alter table clued_private.resource_center_mutations_v1 enable trigger storage_refresh_mutation_fence_v1;
end
$rollback$;
commit;
notify pgrst, 'reload schema';
```

## Legacy audit Bindings, 2026-10-09

`clued_private.authorization_assert_entry_v12` lets a Binding without a
`clued_private.authorizations_v12` row through. Three live production
Bindings had no such row (checked 2026-10-09):

| Binding | What | Last used | Now |
| --- | --- | --- | --- |
| `c0cc5abf` | OAuth "Clued A03 read-only audit", `context:read` on `system:projects` | never | revoked |
| `b3603c56` | OAuth "Clued A03 read-only audit (port 6400)", same grant | 2026-08-29 | revoked |
| `05effaa9` | Projection Builder, `context:read` on `*` | in use | kept |

Migration `20261009040000_revoke_legacy_audit_bindings_v1.sql` revokes the
first two (Owner Decision `29bff239`). It only touches a row that still has
the same id, vendor and name, is live and has no v12 authorization, and it
writes one `clued_private.authorization_audit_v12` row per revocation
(operation `legacy_binding_revoke`). A second run changes nothing.

Check after applying:

```sql
select id, revoked_at from public.clued_agent_bindings
 where revoked_at is null
   and not exists (select 1 from clued_private.authorizations_v12 a where a.binding_id = id);
-- one row: 05effaa9-966d-43ad-904b-1f3426394410
```

Rollback, only if one of them turns out to be needed (reissue through the v12
flow is the better fix):

```sql
update public.clued_agent_bindings set revoked_at = null
 where id in ('c0cc5abf-68f5-4a97-9a14-ab9379c854c0', 'b3603c56-0649-47ca-91e3-d1e8e06588c4');
```

The Projection Builder cannot get a v12 authorization:
`clued_private.projection_refresh_builder_binding` refuses a Builder Binding
that has one. Closing the fallback (step 7b, below) therefore keeps a narrow,
explicit exception for it.

## Raw Binding grants, 2026-10-09

Migration `20261009050000_close_v12_raw_binding_fallback_v1.sql` (step 7b,
Owner Decision `d0458559`) makes `authorization_assert_entry_v12` refuse a
Binding that has no v12 authorization, unless
`clued_private.raw_binding_grants_v1` names it. A row lets that Binding do the
listed `actions` on the scope in `context_key`; nothing else. Only the database
owner can read or write the table. The migration writes one row: the Projection
Builder (`05effaa9`), `global`, `read`, which is all its refresh RPCs ask for.

Check after applying:

```sql
select binding_id, context_key, actions from clued_private.raw_binding_grants_v1;
-- one row: 05effaa9-966d-43ad-904b-1f3426394410 | global | {read}
select outcome, max(started_at) from clued_private.projection_refresh_attempts
 where started_at > now() - interval '15 minutes' group by 1;
-- SUCCEEDED rows keep appearing after the next Canonical write
```

If a live Binding turns out to depend on the old fallback, give it a v12
authorization (reissue it), or as a stopgap add a row naming its scope and
actions. Rollback restores the old body of the function:

```sql
create or replace function clued_private.authorization_assert_entry_v12(p_binding uuid,p_kind text,p_id text,p_environment text,p_action text)
returns void language plpgsql security definer set search_path='' as $$
declare a clued_private.authorizations_v12; e clued_private.authorization_entries_v12; m clued_private.project_memberships_v13;
begin
 if p_kind='scope' and p_id='project:*' then raise exception 'resource_action_not_authorized' using errcode='42501'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for share;
 if not found then return; end if;
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
  perform clued_private.authorization_owner_resource_v12(a.owner_id,p_kind,p_id,p_environment);
 end if;
end $$;
```

Database tests insert raw Bindings freely; after applying the migrations they
call `allowRawTestBindings` from `apps/clued-cloud/tests/raw-binding-grants-fixture.mjs`,
which installs a test-only trigger granting such Bindings everything (a row with
an empty `context_key`). `tests/raw-binding-grants-guard.test.mjs` fails when a
test inserts Bindings without it.

## Left for later

### Issuer credential separation candidate, 2026-10-09

P0-4 step 2b has an implementation candidate in `20261009070001_issuer_identity_credentials_v1.sql`
(Owner Decision `818a9b05`). This is a revision of the original all-issuer-columns-to-cv1 design: existing
64-hex PK/FK and historical digest/Receipt values remain fixed identity/history, while actual authentication
uses `issuer_credentials_v1.verifier` and active credential generation. Do not report all issuer columns as
converted to cv1, or report production closure before deployment and both key rotations are verified.

Existing issuers receive only one bounded legacy cutover generation; it expires at most 24 hours after the
first migration application and must be retired immediately after successful replacement verification.
Permanent issuer insert triggers create identity, never credentials. New issuer credentials require the
offline operator's explicit stage/activate calls. These invoker-only operations remain denied to API roles
even if an accidental EXECUTE grant appears. Retired generations cannot be reactivated by these operations.

The issuer resolver uses the domain-separated verifier formula but deliberately ignores the transaction-local
Binding internal-proof map. Public callers cannot authenticate with a stored verifier. The original legacy
proof remains usable only through its active, unexpired cutover credential; after that generation is retired
or expires, retained identity/history alone cannot authenticate. The identity-only implementations are private
and retain the original business guards. Requests/new registrations
use digest `/3` over UUID identity; historical `/2` digests, registrations, request links, Receipts and persisted
verification JSON are not rewritten. New verification `/3` and default-refresh request hashes bind UUID/kind/
credential generation without an issuer credential value.

The Native policy-transition and onboarding-sweep entries use fixed private resolvers for their existing
recovery contracts. Both require an active, unexpired storage credential even after issuer-wide revocation.
The Native Owner can recover only an exact committed historical Receipt; the original body rejects fresh
or changed requests. Sweep only expires the same issuer's staged attempts, without starting provider work.
Transition keeps table-before-app-row locks; both recheck the clock after their locks. Retired credentials
remain denied and no public bypass flag is added. Other authenticated entries retain the strict resolver.

There is no rollback that restores issuer proofs as credentials. `issuer_function_sources_v1` is necessary
versioned implementation source for deterministic migration reapplication, not a seven-day credential backup;
retain it while that migration remains replayable. The seven-day backup/rollback section above applies only
to historical step 2a. A repeated step 2a rewrite over newer issuer identity bodies is not a supported rollback.
Repair issuer cutovers forward, preserving retired keys and historical evidence. The detailed independent
authorization/storage rotation runbook is in `apps/clued-cloud/docs/connection-authorization-rollout.md`.
The 24-hour legacy credential limit starts with the first 2b migration and is independent of C1's minimum
24-hour observation after successful gateway cutover. The resolver checks expiry after its credential and
issuer SHARE locks; it does not enforce commit-time expiry after every later business lock wait.

Database tests explicitly use `allowTestIssuerCredentials` from `tests/issuer-credentials-fixture.mjs` for
synthetic issuer rows created after migration. Its test-only trigger is absent from production migrations and
Worker code; `issuer-credentials-guard.test.mjs` verifies this separation. Tests of an older migration stop at
their own historical boundary rather than changing the production migration to accommodate their fixtures.

- **Issuer credential separation and G6 hardening await their production gates.**
  Designed in
  [DatabaseCallerAuthentication.v0.1](../../development/contracts/database-access/DatabaseCallerAuthentication.v0.1.md)
  (Task `9a4d6d2c`, Owner Decision `1427642f`). Bindings and Resource Center
  tokens are done (above). Step 2b separates issuer identity and credentials;
  C1 develops in parallel. C1 phase 1 moves the Worker to its own database role
  and retains the old grants and G6 body. G6 hardening and grant withdrawal belong
  to phase 2 after at least 24 hours of successful production observation. Each
  production migration, secret configuration, release and withdrawal has its own gate.
- **MTPE test schemas.** `mtpe_m0_test` (four functions executable by `PUBLIC`)
  and `mtpe_m0_work` remain in production. Export them and drop them; no API role
  has USAGE on them, so this is latent.
- **Leaked-password protection.** A Supabase Auth dashboard setting that needs
  the Pro plan; the organization is on the free plan, so it stays off until an
  upgrade (Owner Decision `c4bc1ebe`).
- **Contract text.** IntegrationRuntime v0.1.8 §5.13 still says
  `anon, authenticated` for the Binding path.
- **Kept functions.** Move the tests in the table above to the successors, then
  revoke those grants too.
