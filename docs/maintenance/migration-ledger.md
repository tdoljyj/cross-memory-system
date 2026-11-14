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
- 19 rows were applied from text no migration file holds (the MTPE M0/M1/M2a
  series, the p2_p6 series, the projection-watchdog cloud series, one bug fix,
  and three rows whose file was edited after the apply);
- 8 migration files were never applied to production.

The ledger makes every one of these explicit. The offline check runs on every
pull request and again inside the release gate, which also compares the
ledger with the live history.

## What the file holds

```json
{
  "contract": "clued.production-migration-ledger.v1",
  "database_project": "clued-prod",
  "exported_at": "...",
  "history_through": "20261007003804",
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

- `rows`: one entry per production row, sorted by `version`; `row_count` is
  their number. Every production row holds exactly one `statements` element;
  `statements_md5` is the md5 of that element and `statements_length` its
  length in characters (Postgres `length()`). For a one-element row this is the
  same text the apply step checks with `md5(array_to_string(statements, ''))`
  and the release gate compares as `statements[0]`. A row with more than one
  element is refused by `export` and blocks the release gate.
- `source` is the repository file whose text, after `transform`, has that md5:
  a file under `supabase/migrations/` or, when no migration file holds the
  applied text, under `supabase/ledger/history-only/` (named
  `<version>_<name>.sql`, exact text, LF only, transform `identical`).
- `transform`: `identical` (the release workflow's shape), `append_crlf`,
  `strip_final_newline`, `crlf` (every newline is CRLF) or `cr_crlf` (every
  newline is CR CR LF). A row's `name` may differ from its file's name; the
  file is bound by content.
- `history_through`: the version of the newest ledger row; the ledger holds
  every production row up to it. A production row at or before it that the
  ledger lacks is an error, so a removed row cannot pass as "not recorded
  yet". A ledger reverted together with its `history_through` can only turn
  rows back into warnings, and only rows that are exactly what `migrate` mode
  records for a pending file.
- *Pending* files: a migration file after the release baseline
  (`source_migration` in `apps/clued-cloud/scripts/production-release-baseline.json`,
  a protected path) that no row carries is pending, in any order: not applied
  yet, or applied by `migrate` mode and not recorded yet. Adding a migration
  file needs no ledger edit, but it must be one the release workflow's
  `migrate` mode can apply: a 14-digit timestamp, a short name no ledger row
  and no other migration file has, and UTF-8 text that is non-empty, ends with
  a newline and holds no carriage return, NUL, byte order mark, `\x01`, `\x02`
  or a line that is only `\.`. The text also runs through plpgsql `EXECUTE`,
  so it may not hold transaction control (`begin`, `commit`, `savepoint`,
  `rollback`) or end with `SELECT ... INTO`; verify cannot see that. The
  release gate's `verifyReleaseState` already refuses a release while a file
  after the baseline is not applied. A file after the baseline can never be
  listed under `repository_only`.
- `repository_only`: every migration file up to the release baseline that no
  row carries, with `status` `never_applied` (the text never reached
  production) or `diverged_from_production` (production holds another text
  under the same name; the row then points at a history-only file) and a
  `reason`. Files up to the baseline are history: the release gate refuses to
  add or change one, and the ledger must account for each.
- `known_deviations`: production state the migrations do not explain and the
  Owner chose to keep for now (the `mtpe_m0_test` and `mtpe_m0_work` schemas,
  the apply-time versioning).

CI's `db reset` still applies every file in `supabase/migrations/` in file
order, repository-only and pending files included; the ledger records that
difference, it does not change it. Retiring or applying the never-applied
files is a separate decision (P1-5), as is removing the test schema (P0-4).

## Checks

- **Offline, every pull request**: `npm run ledger:verify`
  (`scripts/migration-ledger.mjs verify`, a step of the `clued-cloud-tests`
  check in `clued-required-tests.yml`, and `tests/migration-ledger.test.mjs` under `test:unit`). Every row
  resolves to a file with the recorded md5 and length; every migration file up
  to the release baseline is carried by a row or listed under
  `repository_only`; every pending file is one `migrate` mode can apply; every
  history-only file is referenced and holds no text a migration file carries
  (which would mean the ledger was exported from a checkout that lacked the
  file); versions are unique, sorted and not after `history_through`;
  `row_count` matches.
- **Every production release**: `scripts/production-release-gate.mjs` runs
  `evaluateLedger`: the same offline check on the release checkout (so a
  ledger broken on a pull request whose quality check was red still blocks),
  then the live history against the ledger. It blocks on a production row at
  or before `history_through` the ledger lacks
  (`production_row_missing_from_ledger`), a row the repository cannot account
  for (`production_row_not_in_repository`), a row whose text matches a file but
  is not what `migrate` mode records (`production_row_not_from_migrate`), a
  changed text, a rename, a multi-statement row, or a ledger row production no
  longer has (`ledger_row_not_in_production`). A newer row the ledger lacks is
  only a warning when it is exactly what `migrate` mode records for a pending
  file: the row's name is the file's short name, its text is the file's exact
  text, no ledger row and no other production row has that name, and no other
  row claims the same file. The gate then prints the entry to add. A hand apply
  that copies all of that cannot be told apart from `migrate` mode here; the
  workflow's `production-migrations.json` evidence is what tells them apart.
  Applying a historical file (for example a `never_applied` one) blocks the
  gate until the ledger records the row.
- **By hand**: `node scripts/migration-ledger.mjs compare --database-url "$URL"`
  with a read-only connection, or `--history rows.json` where `rows.json` is
  `select json_agg(json_build_object('version', version, 'name', name,
  'statements', statements) order by version) from supabase_migrations.schema_migrations`.

## Lifecycle of a migration

1. **Add the file** in a pull request as before. It is pending; no ledger edit.
2. **Apply it** with the release workflow's `migrate` mode. The workflow
   writes `production-migrations.json` (file, name, version, md5). Until the
   ledger lists the row, the release gate warns and prints it.
3. **Record it** in the next pull request: add the printed row to `rows` (in
   version order), set `row_count`, and set `history_through` to the newest
   row's version. A `never_applied` historical file applied through `migrate`
   mode blocks the gate (`ledger_missing_row_repository_only`) until it is
   recorded; its printed row names the `repository_only` entry to remove. Or
   regenerate the whole file from the live history:
   `node scripts/migration-ledger.mjs export --database-url "$URL"` (or
   `--history rows.json`). `export` maps rows to files by content (preferring
   the file named like the row), keeps `known_deviations` and the
   `repository_only` entries no row carries now, sets `history_through` to the
   newest production row, and writes the text of any row no file carries to
   `history-only/`; it refuses to overwrite a history-only file with different
   text. Export from a checkout that has every migration file of `main`.
4. `npm run ledger:verify` must pass.

A historical migration file (up to the release baseline) that production
applied from a different text is never edited into agreement: the applied text goes to `history-only/`, the file is
listed under `repository_only` as `diverged_from_production`, and the release
gate's `historical_migration_changed` check keeps the file itself untouched.
