# Clued R5 K2 PostgreSQL foundation

This directory contains the candidate Cloud Data Foundation for Gate K2. It is
not connected to a real Binding and does not change the current production
recall or Git synchronization path.

## Contract

- PostgreSQL 15 or newer.
- Synthetic data only in `local` and `dev`.
- Every tenant table carries `account_id`, has RLS enabled and forced, and uses
  a default-deny account context policy.
- `clued_client` is read-only and never receives the `clued_service` role.
- Cluster roles carry the `clued-k2-managed-v1` ownership marker. Migration up
  rejects an unmarked pre-existing reserved role, and migration down removes
  only marked roles.
- `memory_versions`, `change_events`, `tombstones`, `deletion_ledger`, and
  `audit_events` are append-only through always-enabled triggers.
- `memory_current` is a disposable projection rebuilt by
  `clued.rebuild_memory_current(account_id)`.
- `clued.allocate_committed_seq(account_id)` serializes the account-local
  authoritative cursor. Allocation must occur inside the same transaction as
  the corresponding version, event, index job, and idempotency result.
- Semantic recall remains disabled. `memory_embeddings` is only a versioned
  data contract; K2 does not populate or consume it.
- The database process must load `postgresql.k2.conf`. PostgreSQL otherwise
  logs the full statement that caused an error by default, which can expose a
  memory body even when application errors are redacted. Error messages remain
  available, but statement and parameter text are suppressed.

## Local/dev commands

Set `CLD_K2_DATABASE_URL` and optionally `CLD_K2_PG_BIN`, then run:

```text
python -m clued.cloud_data migrate up
python -m clued.cloud_data scan
python -m clued.cloud_data rebuild-projection <account-uuid>
python -m clued.cloud_data backup <path>
python -m clued.cloud_data restore <path>
python -m clued.cloud_data migrate down
```

Commands emit one JSON object and redact connection credentials. Backup files,
local clusters, and test data belong outside Git under ignored K2 directories.
Custom backups omit ownership but retain ACLs, and the tooling reports a
SHA-256 digest that the restore path rechecks.

The PostgreSQL integration qualification supports an evidence mode through
`CLD_K2_EVIDENCE_DIR`, `CLD_K2_BACKUP_ARTIFACT`,
`CLD_K2_TESTED_COMMIT`, and `CLD_K2_SERVER_LOG`. Evidence mode writes a
structured transcript plus a sanitized server log; the backup itself remains
untracked and temporary while its size and SHA-256 are recorded.
