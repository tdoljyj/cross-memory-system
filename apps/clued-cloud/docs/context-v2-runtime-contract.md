# Context v2 runtime compatibility

Reviewed architecture: draft.4, SHA-256 `cd6a2dc91868d14a38b773c7d6cd29696167845fbdda45ec74fd7e804ce86325`.
[Original definition and 24-row mapping](https://drive.google.com/file/d/1HVwdSnAzx4IggkO82lVJSWU-cBTrIU7w/view), ZIP SHA-256 `e83b339ba9467af05fdcdb54ef242a3bae659f54a7ceaaf359bdade029a7e217`.

## Authority and consumers

| Existing entry | Successor behavior |
|---|---|
| Global / Project five views | Standard Work Projection, same Canonical IDs |
| State / current_action | State facts and derived Task reference; executable body comes from Task |
| Account REST, Binding MCP, delegated OAuth | Existing authenticated M1 entrypoints and shared Currentness fence; source scopes filtered before LIMIT |
| Event / Log | Log is a history view; active Event truth carriers retain their separate current-source role |
| checkpoint / old Markdown / current.json / index.json | Continuity or historical snapshot only; no online fallback |
| resolver output | Read observation, `execution_authorization=NOT_GRANTED`; actual operation revalidates authorization/CAS/phase |
| restricted Global reader/builder | Fixed PROJECTION_REQUIRED / explicit source-coverage rejection; target projection grant does not grant source access |
| archive | Same terminal object identity; no body duplication |
| Legacy User Memory Bundle CLI | Export, validation and historical dry-run remain; live execution of its retired pre-M1 import payload is rejected before side effects |
| Public bootstrap / Agent instructions | Durable writes are conditional on authorized changes; M1 already emits Event/Receipt, so an extra append is never a mandatory lifecycle step |

MTPE Universal Intake & Auto-Priority M0 is implemented by the additive `mtpe-universal-intake.v1` derived projection. Canonical Records remain the work authority; the runtime deterministically routes and scores actionable objects, keeps priority separate from executability, applies explicit Owner focus, validates coverage, and supplies the authorized Frontier Builder. The source-binding contract verifies the selected Task/version, Candidate Universe digest, selection source, Task rendering and Currentness. None of those fields turns priority, an Owner Pin or a cached action into deployment permission; missing phase/operation authority remains unknown at the actual operation.

## Global source binding

An authorized builder must have complete source-read coverage. A global.priority_frontier projection uses these `type_fields`:

- `source_task`: exact `{id, version, scope}` of the active, current Task selected by the bound MTPE snapshot; never another projection.
- `render_rule_version`: `task-body.v1` (exact title/content rendering).
- `rule_set_digest`: server-computed digest of active dependency rules.
- `mtpe_rule_set`: `mtpe-universal-intake.v1`.
- `mtpe_candidate_universe_digest`: server-computed digest of the complete eligible Candidate Universe.
- `selection_source`: `SYSTEM_RECOMMENDED` or `OWNER_PIN`.
- System recommendation, Owner-selected focus, algorithm priority and executability are separate fields.
- Optional legacy `current_action`: must equal the derived title/content exactly.

Missing/wrong version/scope/rule/digest, stale source, mismatched cached body or missing stable intent relationship yields PROJECTION_REQUIRED. Pre-MTPE projections retain their former exact unique-now proof only until the next automatic rebuild; they cannot opt into Owner Pin or automatic arbitration without the new digest fields. Rebuild checks these before publishing a generation.

## Stable execution identity

For a separate governance Record, first register `type_fields.execution_intents` with stable UUID `id` and explicit `completion_criteria`. A Task references one registered intent through `type_fields.execution_intent={id,source_id,source_version,source_scope}`. This reference does not duplicate executable text. A governance source that already is a Task must be reused, not wrapped.

The existing Task owns the identity. A unique index across owner+intent includes terminal Tasks. Different Bindings/request keys cannot create a second Task for one registered intent; conflicts emit existing M1 rejected Receipts. Different registered intents can own distinct Tasks. Project merge does not change intent identity. Once assigned, the ID cannot be removed or changed to bypass deduplication. Version, currentness and source-read authority are checked on writes, current reads, Frontier resolution and session admission. Invalid relations remain unknown and omitted from current list/search; explicit history remains available.

Missing registered identity is rejected; caller-generated request keys, similar titles and text are not semantic identities. Ordinary tasks without governance links retain their existing v1.6 IDs and behavior. One Task may carry multiple supporting governance references, but only its registered primary execution intent establishes deduplication.

## Restore and migration

Restore requires explicit owner confirmation, reason, exact terminal Receipt and CAS. Validation is inside the existing M1 Receipt transaction. The existing per-user Currentness transaction lock precedes Receipt/row locks, including reclassification. Account writes retain direct-human and account-status checks. Replays retain the original result after later closeout; rejected valid requests retain immutable failure Receipts.

Apply only the four reviewed Context v2 incremental migrations, using actual installed dependencies; never bulk-push the historical migration directory. Terminal audit and intent index are additive; invalid old projection caches fail closed. Preserve the prior Worker version and encrypted database backup. Application rollback must not reinstate the old online-current consumer or remove the database authorization/fencing guards.

## Repository/artifact migration

[Private original archive](https://drive.google.com/file/d/11swRsrWD5jJeh3zKIEoEVijHepzVjAiO/view), SHA-256 `ee43ff590ae33dfe5cc19f856087f8645ddf1e7a3868756fdb2b524779df225b`, contains 686 exact original paths, independently downloaded and verified. Two historical narrative reports become locators; the 684-path historical Bundle source remains under existing M2 retention. current/previous/minimum protected Bundles, memory and active engineering projections remain intact. These copy-verification facts are not an ArtifactCommitReceipt and do not change Canonical business state. No real archived data is classified as a fixture or included in ordinary current search.

Portable export/validation resolve every object, evidence, manifest and payload path against the explicitly authorized root and reject escaping links. A user export is not synthetic merely because an old manifest called it a fixture. The legacy importer uses an obsolete write contract and name-based Project resolution; its execute mode now fails before network or filesystem side effects. Its historical dry-run is not permission or a valid current M1 request. This retirement does not change supported Canonical M1 mutations or implement a new Artifact import platform.

## Verification

CI runs `test:context:v2`; the post-deploy verifier includes terminal, currentness, authorization and transport database suites. Tests cover concurrent restoration/close/retry, different-record key conflicts, merged-source pagination authorization, stable intent cross-Binding concurrency, merge identity and source Event shadowing. Database clients are not proof of separate installed Host discovery; production verification separately checks actual MCP and account consumer routes.
