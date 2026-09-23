# Clued memory operations

Use this workflow for personal and project context, including project records maintained during engineering. It does not authorize source changes, privileged administration or release publication.

## Read the necessary context

After the applicable prerequisites and `clued_session_resume`, read authorized Global priority/registry, then the selected confirmed canonical Project's State, Task and Decision. Use Archive/Log views only when history is needed. Active Event truth carriers returned by current search/reconciliation remain current sources until their explicit lifecycle transition; checkpoint absorption does not retire them. Read profile facts only when identity or preference matters; generic tasks use no private memory.

For `clued_session_resume`, `context_key` is `global` (also the default) or `project:<canonical_project_id>`. A development resource UUID is a `context_id`, not a session key. When only that resource ID is known, resume `global` to obtain the authorized development projection, then select the exact returned `context_id`; this does not request additional permissions.

Resolve the project by its actual canonical ID. A mere or ambiguous mention is not enough to invent a Project; creation follows an actual Project-recognition decision or explicit user creation. The deployed v1 API may still expose legacy `certainty_status`; treat it as compatibility metadata, not as product organization semantics, and do not build new workflows around “confirming” a Project. A developer-only Binding may receive only its authorized Global projection; it must not read private personal Global data to satisfy the read order. Missing Global capability is a scoped limitation, not a reason to request unrestricted access.

If the actual resume response is `scoped_context_ready` with `session_checkpoint_supported=false`, it is an authorized development-context projection, not a restored M1 checkpoint. Read only its returned authorized context IDs through the supported `clued_context` record-list operation in `development_history` mode, selecting relevant State/Task/Decision records by their returned `record_type`. The current development `record_list` does not filter by `record_type` or `record_id`; list once, follow pagination as needed, and select locally instead of repeating nominally filtered calls. Do not infer access to personal Global records or another project from a shared name, and do not invent a session token. A missing or denied scope remains unavailable.

Use current supported list/search tools. Preserve stable canonical IDs and versions in results; legacy envelopes are history, not current truth. Report `sources_read` for authoritative current-status answers. Cross-client continuity uses the service, not another client's private filesystem or ChatGPT Library.

Before answering a current-status or “what next” question, reconcile the restored checkpoint with the latest authorized Global and Project State/Task/Decision records and any later acceptance or merge evidence already supplied or verified for that exact subject. A checkpoint is a dated continuity snapshot, not a license to repeat its `next_action` after a stage reaches a terminal state. If an old checkpoint or active Task conflicts with later terminal evidence, report the conflict, verify the exact subject, and repair the authorized records before recommending another action. Never recommend repeating a completed review merely because its old Task still has a high priority.

## Standard work projections (Context v2)

Global and Project retain State / Task / Decision / Archive / Log as derived work views with the same canonical IDs. State references the current Task; the Task owns executable text. A Frontier cache must bind that Task ID, version, scope, renderer and current rules. Use `authoritative_current_action` only when resolved and the surrounding Currentness evaluation is current. Missing source/capability or a limited Global view is `PROJECTION_REQUIRED`/unknown, never a reason to select from old Markdown, `current.json`, `index.json` or checkpoint prose.

Discover and use the advertised reconcile tool when the session requires it. If the Host lacks it, report the scoped capability gap and keep current-action claims unavailable. Preserve the existing read-only snapshot verification for historical/offline artifacts; it does not turn the artifact into online Current Truth.

A governance Bug/Research that already is a Task keeps its ID. A separate governance entity may reference multiple distinct execution intents; one Task may reference several governance sources. Different request keys do not deduplicate an intent. Resolve a stable existing Task relationship, or retain a non-executable candidate/conflict; never create duplicate executable wrappers from labels, prose or checkpoint suggestions. A merge retains the accepted execution identity and revalidates scope access.

Read access, priority and `now` are separate from permission to act. At the actual mutation/deployment/migration, recheck exact subject/Binding, target, operation, environment, revocation, source version and applicable phase gate. User, Developer and Dogfood are usage modes, not grants. No local files, fixture labels, caches or previous Receipts bypass these checks.

## Make authorized changes once

A durable change requires explicit intent covering its scope; existing clear instructions can supply that intent. An OAuth write grant alone does not authorize recording every conversation. Project creation/confirmation and destructive actions require their actual explicit intent.

Use current canonical operations:
- Record create/update/close/restore/reclassification: `clued_record_mutate`.
- Decision replacement: `clued_decision_supersede`.
- Project lifecycle: `clued_project_mutate`.
- Evidence and extension events: `clued_evidence_ingest` and `clued_event_append`, when their actual contract is applicable.

Supply the minimum supported authority, exact authenticated scope and IDs, stable idempotency key, and CAS base version for operations requiring it. Preserve superseded and archived history rather than deleting it to express corrections.

For `clued_record_mutate` with `operation=create`, explicitly supply `mutation`, `source_refs` (an empty list when no Evidence IDs exist), and a truthful `source_unavailable_reason` or explicit null. Place text in `mutation.title`/`mutation.content`. Required type-specific fields in `mutation.type_fields` include `note_kind`, `state_kind`, `fact_kind`, decision `rationale`, or task `execution_bucket`. Create active without a base version. These are existing create-contract requirements, subject to the current advertised schema; never invent Evidence IDs.

When a business mutation succeeds, retain its canonical ID, version and Receipt/operation ID, and verify by rereading the actual canonical record. Its Event and Receipt already belong to the same transaction: a checkpoint or separate event is not a substitute for the business write and must not duplicate it.

When the user accepts a final review or explicitly closes a stage, reconcile the related Task, State and current Frontier through supported Canonical mutations before reporting the stage as fully recorded. Then reconcile and checkpoint continuity in every authorized context that the stage actually affected; checkpoint text is not a second execution authority. Preserve the old wording as history; if any write or scope is unavailable, say precisely which projection remains stale rather than silently treating it as current.

## Recover and finish

- Uncertain outcome: retain the original request and idempotency key; query or retry under the supported contract to recover that operation.
- Definite rejection: fix the cause; use a new key for a genuinely corrected request.
- CAS conflict: reread the current record and reconcile meaning; never overwrite a newer decision merely to make a request pass.
- Missing authorization/capability: state exactly what is unavailable and continue unrelated work. No local Markdown fallback may be called a saved Clued record.

Before ending or handing off a protected authorized session, use the supported session checkpoint when the service returned an actual session token and base version. If it explicitly reports `session_checkpoint_supported=false`, retain and verify the actual development-operation receipts; do not claim a checkpoint was saved or expand permissions to create one. Keep lifecycle checkpoints distinct from business records; do not make extra event writes merely for narration.
