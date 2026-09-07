# Step 12 exact migration candidate

The candidate is ready for Step 9 review and subsequent Architecture Acceptance / Structure Freeze binding. No real repository migration or Freeze has been performed by this package's author. A missing future Freeze is an execution prerequisite, not an unfinished candidate preparation task.

`ExecutionInputs.candidate.json` is the only executable operation/payload selection. Its SHA-256 is `37a6909deedae17dbfe97e844d8ec596c5de46e73c3cefafd4136008d3f3dcec`. The executor SHA-256 is `5d116bb93b5d6509eec4edef3cd51ca56f746bcb191d68bcb1139c3c49747c84`.

It fixes all 64 changed paths and 39 immutable input locks. The 29 original operations cover 19 byte-preserving historical document moves, three governance projections, six tools with root compatibility entries, and one real caller's fixture-copy update. TM17–19 add 12 accepted-contract references, three scoped decision references and five exact Step 7 views. These indexes select existing accepted inputs; they do not create business authority, activate new domains, or replace Canon.

The retained `MigrationPlan.candidate.json`, `HistoryPathMap.candidate.json` and `ToolCompatibilityPlan.candidate.json` preserve original planning and source lineage. Any pending projection hashes or proposed DCP metadata in those older planning records are superseded for execution by the concrete `ExecutionInputs.candidate.json`. Older `payload/` references are historical fixture references; the executor reads only `execution-payload/`. Original history bodies are unchanged, and history links resolve using original commit plus original relative path.

The fixed Step 7 inputs `PreMigration-AGENTS.md` and `PreMigration-CURRENT_STATUS.md` remain immutable. Generated AGENTS content never supplies its own source hash. The old CURRENT_STATUS is preserved byte for byte; the new root file is the selected governance projection. README and AGENTS preserve all original bytes outside the appended governance block. Wrapper and implementation hashes are both bound.

## Execution interface

The following commands are templates for the authorized execution owner. Supply actual absolute paths and independently recorded expected decision hashes; do not use fixture decisions against the repository.

```text
python migration_execute.py preflight --repo REPO --inputs INPUTS --expected-input-sha INPUT_SHA
python migration_execute.py apply --repo REPO --inputs INPUTS --expected-input-sha INPUT_SHA --freeze FREEZE --expected-freeze-sha FREEZE_SHA --transaction-store STORE
python migration_execute.py rollback --repo REPO --transaction TXN_DIR --expected-input-sha INPUT_SHA --expected-freeze-sha FREEZE_SHA
```

`STORE` must be outside the repository; all cooperating executions use the same store. Keep it until the later acceptance and rollback-retention obligations are satisfied. The executor records backups, original hashes/modes/times, intentions before mutations, applied operations and a final local receipt. A normal partial failure attempts restoration automatically. After process interruption, use the saved transaction directory with `rollback`. Unknown changed bytes or corrupted originals block rollback before overwrite. Rejections or apply failures return exit 1; successful preflight, apply and rollback return 0.

Freeze uses the existing `Phase2StructureFreezeDecision` type and `FROZEN` state. Its `migration_execution_inputs_ref` contains `path` and the exact SHA-256 above; the path resolves relative to the Freeze file. `architecture_acceptance_ref` resolves to an `ArchitectureConstitutionAcceptanceDecision` in `ACCEPTED` state, with exact `architecture_acceptance_digest`. The Freeze file's own independently supplied SHA-256 binds this interface. Freeze does not include itself in the input payload. The executor validates these references; it does not perform Step 9 review, issue acceptance, or substitute for the original 40 conditions / 28 findings.

## Verification and retained files

`FixtureVerification.json` records the prior nine compatibility/history/projection-source fixture tests. `ExecutorVerification.json` records five further tests: full 64-path apply/rollback; rejection of six classes of changed inputs/state/targets; automatic partial-failure recovery; abrupt subprocess exit and recovery; and refusal to overwrite concurrent changes or corrupt backups. All 14 tests passed in their recorded fixture runs; the nine earlier tests were not repeated during executor verification. HistoricalFixtureSources.zip preserves original test sources, helpers, payloads and results byte for byte. These tests depend on the original sibling phase2-governance-check repository, its selected commit, the original sibling step7-projection-candidate inputs and recorded runtime paths. They are historical work-layout reproducers, not a portable test command from the retained repository directory. Step 13 must check the actual migrated paths and behavior. No real repository root files were moved or replaced.

Copy only the files listed by `DeliveryManifest.json`, preserving paths, into the retained candidate directory. Exclude `fixtures/`, transaction stores, `__pycache__/`, the older README, old package manifests and superseded pending-path reports. The manifest itself is additional to its listed files. Candidate readiness and successful local file operations do not assert Step 13–21 completion, semantic closure, production enforcement, or publication.
