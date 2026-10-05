# MTPE Universal Intake & Auto-Priority M0

Implementation contract: `mtpe-universal-intake.v1`.

## Authority boundary

Canonical Records remain the only editable work authority. The MTPE tables are a deterministic projection keyed by `(user_id, record_id)` and are rebuilt by database triggers after Canonical Record commits. They do not duplicate Task text or create executable wrappers.

An Owner Pin is accepted only through `clued_mtpe_owner_pin` with explicit user confirmation, exact Task version, write authorization and an idempotency key. The Owner focus is one per user, so a `set` also names the focus it replaces: `expected_current_focus_id` is the current focus's record ID, or `null` when no focus is expected; a mismatch is rejected with `owner_pin_focus_conflict` and the rejection returns `supplemental.current_focus_id`. Parallel execution is a work claim (`clued_work_claim`), never an Owner Pin. That M1 mutation supplies the Event and immutable Receipt. Stored `type_fields.owner_pin` values are inert, so replaying or updating an older Task cannot silently steal focus. Runtime projection rows are private and have no direct Agent grants.

## Intake and routing

The governed universe includes Task plus explicit Proposal, Bug, Defect, Blocker, Risk, Incident, Technical Debt, Legacy residual scope, Research Question, product/brand/commercial issue and Decision follow-up Records. `governance_profile=OUT_OF_GOVERNANCE_PROFILE` excludes an object explicitly.

Every active governed object receives exactly one `owner_track`, zero or more `affected_tracks`, an `intake_kind`, provenance, lifecycle/disposition, `priority_eligibility`, algorithm priority and executability. The primary key and stable Canonical Record ID provide cross-Host/Agent deduplication.

## Priority and executability

The deterministic score includes criticality, Current Frontier blocking, downstream unlock value, Authority/Data/Currentness/Security risk, user/product impact, time sensitivity, explicit priority signal and resource cost. Scores are clamped to `0..100` and mapped to CRITICAL/HIGH/NORMAL/LOW. Blocking never reduces the algorithmic importance score.

Executability is a separate value: READY, BLOCKED_HARD_GATE, BLOCKED_DEPENDENCY, SCHEDULED, DEFERRED or TERMINAL. Unknown eligibility/executability values, malformed blocker payloads and non-current Records fail closed as blocked; none can default to READY. The Candidate Universe contains active ready, blocked, scheduled and deferred-with-trigger objects; terminal objects remain in the projection for audit.

The system recommendation records both the highest-priority governed object and the highest-priority READY Task Frontier. Context v2 Frontier binding remains Task-only even when a non-Task intake item has the highest general priority. An Owner Pin can select an eligible Task and overrides soft ranking without rewriting the algorithmic score. A blocked Owner Pin remains selected with exact blocker data; it is never silently exchanged for a ready Task.

## Recompute and validation

Record creation, criticality/impact/dependency changes, lifecycle changes, Owner Pin changes and other relevant Canonical updates recompute the one projection row. The existing post-commit pipeline invalidates and rebuilds `global.priority_frontier` and `global.__aggregate__` with exact revision/source-vector CAS.

`clued_mtpe_validate` reports Registered, Terminal, Missing Route, Missing Priority, stale projection and verified SUPERSEDED/MERGED successor binding counts. Successors must resolve to an owned Canonical Record through the existing replacement or merge contract; the presence of an arbitrary JSON key is insufficient. `clued_mtpe_snapshot` returns the deterministic Candidate Universe digest, recommendations, Owner focus and selected Frontier. Both require read scope plus read-set coverage (`mtpe-read-set-coverage.v1`): the Binding's effective read scopes, as resolved by `binding_read_scopes_v2` including per-entry OAuth actions, revocation and expiry, must contain every Canonical source scope the operation actually reads. The read set is computed in the same database snapshot as the result, and returned candidate scopes are rechecked against the grant. An explicit grant never inherits a newly created Project; an unknown scope kind or a source row without a canonical scope fails closed; `*` remains unrestricted and is not issued by OAuth consent. Denial is a structured tool result (`status=denied`, `error.code=INSUFFICIENT_CONTEXT_COVERAGE`, `missing_context_keys`, `unscoped_sources`) rather than an HTTP authorization failure, so hosts do not prompt a reconnect for a coverage gap. Inputs are never filtered to the grant, because a partial universe would rank differently from the Global Frontier.

## Acceptance

`npm run test:mtpe:intake` covers the complete intake taxonomy, automatic routing/priority/executability, blocked and ready Owner Pin scenarios, cross-Host recompute/deduplication, deterministic replay, terminal retention, no-silent-disappearance validation, scope denial and MCP Binding/OAuth parity. Projection, Context v2 and authorization suites remain required regressions.
