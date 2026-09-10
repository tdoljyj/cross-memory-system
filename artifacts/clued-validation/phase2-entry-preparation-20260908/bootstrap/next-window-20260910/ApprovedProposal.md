# Clued Phase 2 — non-production continuation window and final single run

State: explicitly approved in the current conversation; publication, binding maintenance, successor registration, budget allocation and execution remain separate guarded effects.

## Exact scope

- Supabase project: `uscrdifznmlvczcekqpw`
- Control schema: `clued_control`
- Existing root set: `ctr_414bd3c724264a83894b0c55cf2ab878`
- Environment: `ISOLATED_TEST`; no production authority, paid model action or business-data permission.
- Fixed window: `2026-09-10T10:21:05Z` inclusive to `2026-09-11T10:21:05Z` exclusive. It does not roll, renew automatically or backdate.
- Reuse the previously accepted NW-01 maintenance mechanism for the same single `accepted_binding` row. Only `not_before`, `expires_at`, `owner_approval_commit`, `subject_sha256`, `registration_acceptance_sha256`, `store_acceptance_sha256`, and `signature_evidence_sha256` may change. Only the three exact binding CHECK values may be replaced; `accepted_binding_immutable` must be restored in the same transaction.
- Preserve every prior Root, Status, GateAuthorization, GateResult, execution event, receipt and charge. No refund, deletion, reset, force update, second root set, reusable renewal API or automatic retry.
- Publish and verify an Owner-signed continuation record, append exactly one forward Root generation and its Status successor, then perform the already planned final ordinary forward.
- Reserve at most one final GateAuthorization: exactly 600 seconds and 134,217,728 evidence bytes. Existing charges are 6,306 seconds and 1,396,288,435 bytes; the authorized final ceilings are 6,906 seconds and 1,530,506,163 bytes.
- Run the original isolated historical subject once, evaluate the same 19 checks, stop the process tree, publish the GateResultReceipt, close the attempt by exact CAS, and perform the established independent/readback closeout.
- First terminal result ends the run. There is no automatic retry or additional allocation.

## Authority source

The user explicitly wrote `同意授权`, then `继续执行吧`, and finally `还是别简化了，按照之前的执行`. The final instruction rejects the proposed simplification and requires the previously established exact time/Root/Status/publication/signing/staged-check execution discipline.

## Boundaries

This approval does not authorize production, paid services, a new trust root, removal of history, refunds, retry, scope expansion, unrelated repository changes, or bypass of current service permissions. Any mismatch, expiry, unknown effect or failed exact CAS stops the affected path and is reconciled from durable state before further action.

