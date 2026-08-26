# Clued v1.6 Memory Root Cutover Report

- Migration run: `memory-v16-root-cutover-cv155`
- Executed: 2026-08-26 (Asia/Shanghai)
- Recovery tag: `pre-memory-v16-root-cutover-20260826`
- Source commit: `d7075c5ed1a1c493605897e7cb73ad2826c84fcc`
- Target snapshot: `snap_f6134235591bfcbfe4ba3a674383c3e0`
- Canonical version: `cv_155`
- Export Receipt: `4636ef85-17f0-4214-9d03-55e34da23ae8`

## G0 — freeze and inventory

`main` and `origin/main` were equal at `d7075c5…`; the worktree was clean and no sync-failure marker existed. The pre-cutover tag was pushed before any mutation.

The old repository root contained the Chinese five Markdown files, `index.json`, `object-index.json`, 272 local Memory Engine objects, three routing files and one local audit log. The formal M2 pointer referenced `snap_76d8a4a701098649c9941083c96c4ddf / cv_139`.

## G2 — zero-write deterministic reconciliation

Stable source-reference comparison proved that 262 of the 272 local objects were already represented in the live-rechecked Bundle. The ten unmatched objects were all Clued v1.6 M0/M1/M2 execution records created after the previous export. Before writes, the effective Clued Project (`0597aa60-9b98-4da6-a4ab-63d7705b632f`) had no source reference or record key matching any of those ten IDs.

## G3 — M1 canonical writes

All writes used authenticated M1 mutation contracts, stable idempotency keys, explicit authority, and preserved-source reasons pointing to the recovery tag. Historical State objects were created active and immediately closed as archived; the Decision pair used one atomic supersede transaction.

| Legacy ID | Canonical ID | Final lifecycle | Receipt/Event evidence |
|---|---|---|---|
| `mem_e1a85496` | `a1bbcf90-ff13-4ca7-8ed6-6f226e38cf2d` | active | Receipt `4556bbd2…`, Event `438` |
| `mem_026206b4` | `94451820-b233-4bdf-b94d-eae8e771da58` | active | Receipt `32fd4986…`, Event `439` |
| `mem_1ce82c47` | `a39382c2-d528-4d59-a992-8d9789a3fc19` | archived v2 | Events `440–441` |
| `mem_20f858e3` | `0c0d4216-23f6-4e5b-8c92-1aaf7f9b4e1e` | archived v2 | Events `442–443` |
| `mem_714dd47d` | `7cfc4648-b680-4b66-bac7-a3f658067111` | archived v2 | Events `444–445` |
| `mem_a004c38c` | `c1dc1bdf-8787-4ec4-b3f9-f6850814dc5c` | archived v2 | Events `446–447` |
| `mem_a4996fc9` | `e343e4db-c11d-4204-b97b-45368555a2f3` | archived v2 | Events `448–449` |
| `mem_b8b13e65` | `ffb7c3a9-b812-495d-ab33-a53ede2e5909` | active | Receipt `63eb99bc…`, Event `450` |
| `mem_8c35bf42` | `fd2c65d4-b507-4b9c-81eb-666201727d8f` | superseded v2 | Events `451–452` |
| `mem_9540a21b` | `46fcdf0e-6921-4d62-a1d4-5e8d86f79861` | active replacement | Receipt `ddf97d0c…`, Event `452` |

The Receipt-backed Canonical Export advanced the Store to `cv_155` and returned `source_verification=live_rechecked`, `views_complete=true`: 4 Projects, 136 Canonical Records, 141 Canonical Events, 0 Evidence, 136 legacy Records and 265 legacy Events. The 401 pending-review entries are compatibility history; no current State/Task/Decision is incomplete.

## G4 — root and consumer cutover

The authenticated export deterministically built and validated `snap_f6134235591bfcbfe4ba3a674383c3e0`. M2 expected-current CAS changed the formal pointer from `snap_76d8a4…` to `snap_f613…`; the Store remained healthy with no active alert.

Repository `memory/` is now an exact materialization of the pointed Bundle: `profile.md`, Global five views, per-Project five views, `objects/{records,projects,legacy}`, `events/raw`, `evidence/migration`, one `index.json`, and one `manifest.json`. The Chinese root five files, local `object-index.json`, local audit/session/context directories and Markdown business-write path are retired.

`memory.py` now performs read-only status/doctor/recall. Mutating legacy commands fail closed. `sync-memory.py` and `sync-memory.ps1` only align Git and atomically mirror the complete snapshot; business-memory push fails closed. `AGENTS.md` routes canonical writes exclusively through authenticated Clued M1 tools.

## G5 — verification and release gates

The production build completed successfully. The Node contract suite passed 63/63, the v2 red-test suite passed 14/14, the root-cutover suite passed 5/5, TypeScript typecheck passed, and ESLint passed. `memory.py doctor` verified all 710 manifest-listed files; the repository root and endpoint-local mirror contain 711 files including `manifest.json` and have zero byte/hash differences. Read-only recall reports its exact source files, while the retired business push command fails closed with exit code 2 and `local_snapshot_is_read_only`.

The formal M2 pointer was exercised in both directions: rollback from `snap_f6134235591bfcbfe4ba3a674383c3e0` to `snap_76d8a4a701098649c9941083c96c4ddf`, then rollback forward to `snap_f6134235591bfcbfe4ba3a674383c3e0`. Reconciliation completed with zero failures, no active alert, and the final pointer remains `snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155`.

## Rollback boundaries

Canonical writes are append-only history and are not deleted by a filesystem rollback. Snapshot rollback changes only the formal pointer/root/read-only mirror. Recoverable points are the Git tag above, M2 `previous_snapshot_version`, and the endpoint-local pre-cutover directory backup.
