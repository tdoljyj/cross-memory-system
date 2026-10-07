# Production migration ledger

`apps/clued-cloud/supabase/ledger/production-history.json` is the committed
record of production's `supabase_migrations.schema_migrations` (Supabase
project `clued-prod`). It exists because the table and the repository drifted
apart without anyone being able to tell from either side (audit 2026-10-06,
P0-3; Owner decision 2026-10-07, Decision `d592ac9e`):

- the release workflow's `migrate` mode records the apply time as `version`,
  so most rows do not carry their file's timestamp;
- earlier applies through other tools stored the text with CRLF endings, an
  appended CRLF, a stripped final newline or a doubled carriage return;
- 19 rows were applied from text no migration file holds (the MTPE M0/M1
  series, the projection-watchdog cloud series, one bug fix, and three rows
  whose file was edited after the apply);
- 8 migration files were never applied to production.

The ledger makes every one of these explicit, and two checks keep it true.

## What the file holds

```json
{
  "contract": "clued.production-migration-ledger.v1",
  "database_project": "clued-prod",
  "exported_at": "...",
  "row_count": 202,
  "rows": [
    { "version": "20260823154017", "name": "mandatory_continuity_002",
      "statements_md5": "b761f47a…", "statements_length": 31887,
      "source": "migrations/202608230002_mandatory_continuity.sql",
      "transform": "strip_final_newline" }
  ],
  "repository_only": [
    { "file": "migrations/20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql",
      "status": "never_applied", "reason": "…" }
  ],
  "known_deviations": [
    { "kind": "schema", "name": "mtpe_m0_test", "note": "…" }
  ]
}
```

- `rows`: one entry per production row, sorted by `version`. `statements_md5`
  is `md5(array_to_string(statements, E'\n'))`, the same value the apply step
  and the release gate compute. `source` is the repository file whose text,
  after `transform`, has that md5: a file under `supabase/migrations/` or, when
  no migration file holds the applied text, under `supabase/ledger/history-only/`
  (named `<version>_<name>.sql`, exact text, LF only).
- `transform`: `identical` (the release workflow's shape), `append_crlf`,
  `strip_final_newline`, `crlf` (every newline is CRLF) or `cr_crlf` (every
  newline is CR CR LF). A row's `name` may differ from its file's name; the
  file is bound by content.
- `repository_only`: every `supabase/migrations/*.sql` no row carries, with
  `status` `never_applied` (the text never reached production) or
  `diverged_from_production` (production holds another text under the same
  name; the row then points at a history-only file) and a `reason`.
- `known_deviations`: production state the migrations do not explain and the
  Owner chose to keep for now (the `mtpe_m0_test` and `mtpe_m0_work` schemas,
  the apply-time versioning).

CI's `db reset` still applies every file in `supabase/migrations/` in file
order, repository-only files included; the ledger records that difference, it
does not change it. Retiring or applying those files is a separate decision
(P1-5), as is removing the test schema (P0-4).

## Checks

- **Offline, every pull request**: `npm run ledger:verify`
  (`scripts/migration-ledger.mjs verify`, a step of the `clued-cloud-quality`
  workflow and part of `tests/migration-ledger.test.mjs` under `test:unit`).
  Every row resolves to a file with the recorded md5; every migration file is
  carried by a row or listed under `repository_only`; every history-only file
  is referenced; versions are unique and sorted.
- **Online, every production release**: `scripts/production-release-gate.mjs`
  reads the live history and calls `compareLedgerWithHistory`. It blocks the
  release on a production row the repository cannot account for
  (`production_row_not_in_repository`), a row whose text changed
  (`production_statements_changed`), a renamed row, a multi-statement row, or a
  ledger row production no longer has (`ledger_row_not_in_production`). A row
  the ledger lacks but a migration file carries verbatim, the normal state right
  after a `migrate` run, is a warning that prints the entry to add.
- **By hand**: `node scripts/migration-ledger.mjs compare --database-url "$URL"`
  with a read-only connection, or `--history rows.json` where `rows.json` is
  `select json_agg(json_build_object('version', version, 'name', name,
  'statements', statements) order by version) from supabase_migrations.schema_migrations`.

## Refreshing after a production migration

1. Run the release workflow in `migrate` mode as before; it applies the named
   files and writes `production-migrations.json` (file, name, version, md5).
2. In the next pull request, add one row per applied file to `rows`, in version
   order: `version` and `name` from the evidence, `statements_md5` = the file's
   md5, `source` = `migrations/<file>`, `transform` = `identical`,
   `statements_length` = the file's length; set `row_count`. Or regenerate the
   whole file from the live history:
   `node scripts/migration-ledger.mjs export --database-url "$URL"` (or
   `--history rows.json`). `export` keeps `repository_only` and
   `known_deviations`, maps rows to files by content, and writes the text of any
   row no file carries to `history-only/`; it refuses to overwrite a history-only
   file with different text.
3. `npm run ledger:verify` must pass; the pull request template's local-checks
   list includes it through `test:unit`.

A migration file that production applied from a different text is never
edited into agreement: the applied text goes to `history-only/`, the file is
listed under `repository_only` as `diverged_from_production`, and the release
gate's `historical_migration_changed` check keeps the file itself untouched.
