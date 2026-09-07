# Clued memory operations

Use this workflow for personal and project context, including project records maintained during engineering. It does not authorize source changes, privileged administration or release publication.

## Read the necessary context

After the applicable prerequisites and `clued_session_resume`, read authorized Global priority/registry, then the selected confirmed canonical Project's State, Task and Decision. Use Archive/Log only when history is needed. Read profile facts only when identity or preference matters; generic tasks use no private memory.

Resolve the project by its actual canonical ID. Do not create or confirm a project from a mention or an ambiguous name. A developer-only Binding may receive only its authorized Global projection; it must not read private personal Global data to satisfy the read order. Missing Global capability is a scoped limitation, not a reason to request unrestricted access.

If the actual resume response is `scoped_context_ready` with `session_checkpoint_supported=false`, it is an authorized development-context projection, not a restored M1 checkpoint. Read only its returned authorized context IDs through the supported `clued_context` record-list operation in `development_history` mode, selecting relevant State/Task/Decision records. Do not infer access to personal Global records or another project from a shared name, and do not invent a session token. A missing or denied scope remains unavailable.

Use current supported list/search tools. Preserve stable canonical IDs and versions in results; legacy envelopes are history, not current truth. Report `sources_read` for authoritative current-status answers. Cross-client continuity uses the service, not another client's private filesystem or ChatGPT Library.

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

## Recover and finish

- Uncertain outcome: retain the original request and idempotency key; query or retry under the supported contract to recover that operation.
- Definite rejection: fix the cause; use a new key for a genuinely corrected request.
- CAS conflict: reread the current record and reconcile meaning; never overwrite a newer decision merely to make a request pass.
- Missing authorization/capability: state exactly what is unavailable and continue unrelated work. No local Markdown fallback may be called a saved Clued record.

Before ending or handing off a protected authorized session, use the supported session checkpoint when the service returned an actual session token and base version. If it explicitly reports `session_checkpoint_supported=false`, retain and verify the actual development-operation receipts; do not claim a checkpoint was saved or expand permissions to create one. Keep lifecycle checkpoints distinct from business records; do not make extra event writes merely for narration.
