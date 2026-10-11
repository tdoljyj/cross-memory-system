# Merge Admission measurement history v0.1

Status: implementation candidate, not deployed or accepted as complete R9 measurement.
Task: `c20f91d3-baf9-4e2c-ac69-d1455ed4c57c`.
Owner forward-window decision: `40904bf6-2217-4c5f-b372-471cc8a8acee@1`.

## Acceptance boundary

Retain original historical results and NOT_MEASURED gaps. Only after all five qualified sources are installed and continuity is proven does T0 start a continuous seven-day R9 window. Hosted fees use complete UTC days, by workflow/SKU/gross/discount/net with workload attribution. This decision grants neither production installation nor broader access, and never turns a candidate, mock test or elapsed duration into acceptance.

## Private evidence core

The active migration is `20261011033947_merge_admission_measurement_history_atomic_v1.sql`, generated with the installed official CLI. It wraps the original definition in one PL/pgSQL DO block, so both a reset and the configured production publisher can apply it atomically. The publisher's outer transaction still binds the schema change and its exact-byte migration-history row; the publisher is unchanged. The original `20261011005515_merge_admission_measurement_history_v1.sql` was never applied by this task and is preserved byte-for-byte under `supabase/history-only/` solely as the transaction-control negative fixture. That directory is outside `supabase/ledger/history-only/`; the fixture is not represented as an applied production row. Its immutable original also remains in merge commit `7ad67401f57dfcabcfe4e4cd1ea59d358cb14376`. Neither the retired pending file nor a successful local wrapper test establishes production installation. Old exact-7ad production grants must not be used for this successor.

The generated SQL migration creates two private, RLS-enabled tables. Per-user sequence allocation and append happen in the source transaction. A rollback rolls both back. Policy/claim/queue-marker snapshots are seeded under source-table locks; accounts first active later receive a policy boundary before the first change. Source hashes cover the existing FIFO, deadline, stamp, merge-ref projection, profile and recorder definitions.

The recorder copies only the fields needed to replay the existing FIFO plus explicitly identified server admission receipts. It excludes lease keys, tokens, labels, budgets, arbitrary request metadata and file contents. It never changes claim/queue policy. Its writes add bounded per-change work and can fail the containing transaction; production review must evaluate this cost and failure effect. The migration uses a 3-second lock timeout, and must not be installed during another migration window.

Every event carries transaction identity. `recorded_at` is an observation **inside** the transaction, not a PostgreSQL commit timestamp. A reader must fold all members of a transaction atomically. Raw page fragments and intermediate marker/claim prefixes are not independently committed snapshots or duration intervals. A pinned end watermark may not split a transaction. These facts must remain explicit in a later duration estimator/qualifier; this core alone does not prove complete wall-clock FIFO history.

The private page core has no public grants. An optional `measurement` branch in the existing `clued_audit_receipts` tool/RPC selects the user through the existing `audit:read` resolver and rechecks every contributing context before returning rows; unreadable contributors refuse the measurement rather than disappearing from the denominator. The public RPC signature/ACL and tool permission are unchanged. The first page establishes stream ID and a fixed end sequence; subsequent pages must retain both. Missing sequences, source changes or an unstarted stream refuse completion. Pages may split transport fragments, so consumers must finish transaction groups before applying state. A writer-observed source mismatch permanently invalidates the stream; a reader-observed current mismatch rejects that read. Continuity across unobserved/transient DDL changes is not established.

Direct update/delete/truncate of events is refused. Account erasure keeps the new ledger's own FK cascade semantics; no pruning API is added. Existing unrelated whole-account deletion limitations remain outside this change. All new tables/functions revoke access from PUBLIC, anon, authenticated and service_role. No new secret, permission, role, budget or public SECURITY DEFINER entry point is introduced.

## Remaining integration requirements

The authenticated metadata reader remains a candidate until independently reviewed, installed and naturally qualified. A repository-qualified consumer and its source/provenance checks are still required. Existing CI token/measurement App boundaries must be preserved. Cross-context claims cannot leak through a project-scoped reader or be silently omitted from a supposedly complete queue denominator.

The CI source must separately prove every relevant admission outcome, including unknown/failed/cancelled cases and the policy/claim disposition at that time. HEAD_ADMITTED server receipts alone are not a complete failure denominator. Actual update-main metrics require confirmed operations and contemporaneous main/head evidence; HTTP202 acceptance and later DAG ancestry are insufficient. Wasted-final-round and cancellation-cause metrics need explicit causal links, not merely later heads. The existing measurement App budget remains 2000 requests, remaining-quota floor600, immutable completed-job caching, and no retry or measurement-triggered extra CI.

No T0, official metric value, production install, pipeline compatibility, real CI success or full R9 closure is claimed by this private SQL milestone. Complete-source integration, independent exact-head review, actual applicable CI, exact Owner grants, FIFO platform merge, separate production doors and natural-runtime evidence remain required.
