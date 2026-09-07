# Canonical search and create guidance repair

The production search function previously read only checkpoints and events, so an M1-created record could not be found until its text appeared in a checkpoint. Migration `20260907131834_clued_search_canonical_records` adds canonical records and ranks them before session evidence. Results preserve record IDs, versions and explicit `kind=record`.

The existing binding and session resolvers remain mandatory. Canonical record matching uses the exact authorized context scope and user; archived, revoked, cancelled, merged and superseded records are excluded by default. `include_history` permits historical record rows. Record matching treats wildcard characters literally. Project aliases/merged project scopes are not expanded; callers use the canonical context key. Existing checkpoint/event matching remains compatible and is explicitly identified by result kind.

Creation guidance in the maintained User Skill now explains create-only required fields (`mutation`, `source_refs`, `source_unavailable_reason`) and per-record `type_fields`. The shared MCP operation schema remains unchanged; this repair teaches the existing contract without redeploying the application. The installed Skill passed validation and matches repository SHA256 `d7a0c0d3935cfa02a24def96db63c9956d2b5392f00709065cf3e0a5e3603ac8`. Developer Skill is unchanged. The application AGENTS entry now references these two maintained Skills.

## Validation

- `supabase/tests/canonical_search_regression.sql` reproduced `canonical_record_missing_from_search` before the migration.
- The same real PostgreSQL regression passed as part of the production migration transaction: create with complete fields; canonical ID/version search; literal wildcard; default archive exclusion; explicit history; user isolation; context isolation; unauthorized context rejection; expired session rejection. Generated fixture users, bindings, sessions and records are rolled back by a caught test subtransaction exception; the final assertion verifies fixture cleanup.
- Production migration history reports version `20260907131834` and name `clued_search_canonical_records`. CLI-created local migration filename was aligned to that actual MCP-issued version. Application used the migration SQL followed by the standalone regression SQL in one transaction.
- Actual authenticated Clued MCP resume followed by search with limit 1 returned the pre-existing authorized test record, `kind=record`, version 1. This proves live search, not merely matching a checkpoint; private record content and tokens are not copied into this report.
- Existing M1 contract checks: 6 passed. User Skill format validator passed; installation/update check reports both Skills MATCH.
- Supabase security advisors still report the existing public SECURITY DEFINER RPC exposure pattern and disabled leaked-password protection. This migration adds no grants and preserves explicit Binding/session authentication. It does not claim a clean platform-wide security audit. Reference: [RPC advisor](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

This is a scoped post-closeout functional repair. It does not reopen the completed 21-step series or claim a full application deployment. A newly opened desktop task performing its own recall/update remains a distinct user acceptance check.
