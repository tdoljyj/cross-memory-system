# Clued Cloud production release

The supported production Worker release entry is the owner-dispatched
`Clued Cloud production release` GitHub Actions workflow on `main`. It checks
the exact checkout, builds and tests it, verifies the production database,
deploys `clued-cloud`, and then verifies the live source commit and both
projection keys after a new scheduled Worker heartbeat. A failing preflight
stops before `wrangler deploy`.
The production Wrangler configuration also runs the read-only preflight as its
build command, so a direct Wrangler deployment using that configuration fails
when the database credential or required production state is missing.
Use the workflow's `preflight_only` option to verify the live database and
store evidence without needing a Cloudflare token or changing production.

The workflow needs the existing `CLUED_ATTESTATION_DATABASE_URL` secret, a
`CLUED_CLOUDFLARE_DEPLOY_TOKEN` secret scoped to edit the existing `clued-cloud`
Worker, and the `CLUED_CLOUDFLARE_ACCOUNT_ID` repository variable. The token
belongs in GitHub secret storage; never put it in Git, logs, an artifact, or a
command argument. Keep the one-minute Cron and existing Worker bindings in
`wrangler.production.jsonc`; deployment uses `--keep-vars`.

## Database sequence

Apply reviewed schema migrations to production through the authorized
Supabase process **before** dispatching the Worker release. The release gate
reads `supabase_migrations.schema_migrations` and compares the recorded SQL
with repository files. It checks the projection pipeline predecessors, the
MTPE selector, a fresh healthy Worker heartbeat, and CURRENT revision/digest
for `global.priority_frontier` and `global.__aggregate__`.

Production migration history predates a unified versioning convention. The
MTPE source file `20260924110000_mtpe_universal_intake_auto_priority.sql` was
applied on 2026-09-23 as history version `20260923050444`; the SQL is identical
except for a trailing CRLF in the stored statement. The immutable
`scripts/production-release-baseline.json` records that one observed alias
and its source SHA-256. The release gate compares the full statement, not
just the migration name. It also refuses any modification to a migration
already present in the baseline commit.

New migration filenames must sort after the baseline migration. Each new
file must have exactly one production history row with the same name and SQL
body; the production service may assign a different version number. If a
migration is missing or the SQL differs, apply or reconcile the migration
through an authorized, evidence-backed operation, then rerun the release.
Do not run a blind `supabase db push` against this historically divergent
production ledger or mark a migration applied without checking its live SQL.

## Release evidence

The workflow stores three safe artifacts: the preflight result, the exact
deployed-commit/currentness attestation, and the post-deploy projection result.
The database URL, Cloudflare token and full SQL are omitted. A failed
post-deploy check means the release is not accepted; currentness reads continue
to fail closed until the underlying state is repaired.

For an authorized manual operation outside GitHub Actions, run the read-only
`node scripts/production-release-gate.mjs --pre-deploy` immediately before
the release and again afterward. A manual `wrangler deploy` without this gate
has no release acceptance evidence.
