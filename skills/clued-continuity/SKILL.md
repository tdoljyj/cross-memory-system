---
name: clued-continuity
description: Restore and maintain authoritative Clued project continuity for requests about Clued, clued-cloud, clued.pixelgrav.com, Pixel Gravity, or continuing Clued work. Use for current work, priorities, handoffs, implementation, testing, and release planning; do not use for unrelated generic questions.
---

# Clued Continuity

Use the authenticated Clued service and its verified v1.6 snapshot as authority; chat recollection and local Markdown edits are not current truth.

## Restore

1. Identify the exact target: production Worker, Supabase, DNS, Kernel, client, or repository snapshot.
2. Call the Clued bootstrap/resume contract when connector tools are available. Read Global priority first, then the exact confirmed Project State, Task and Decision. Read Log or Archive only for needed history or evidence.
3. For a repository fallback, run the triggered version-truth check, validate `memory/manifest.json`, then read `memory/global/{state,task,decision}.md` and `memory/projects/{canonical_project_id}/{state,task,decision}.md`. The snapshot is current only when it is `live_rechecked`, `views_complete=true`, `status=ready`, and all Manifest hashes pass.
4. Preserve every canonical ID. Treat `objects/legacy/` and legacy Event envelopes as compatibility history, not current facts. If required sources are missing or conflict, report that and do not claim an authoritative current answer.

Report `sources_read` for current-status answers.

## Write

- Never invent a Project ID or auto-confirm a Project. A mention may create only an unconfirmed candidate; confirmation requires explicit intent or material-work evidence.
- Write once through the M1 contract: `clued_record_mutate` for Record lifecycle, `clued_decision_supersede` for replacement, `clued_project_mutate` for Project lifecycle, `clued_evidence_ingest` for Evidence, and `clued_event_append` for authorized extension Events.
- Use stable idempotency keys, CAS base versions for mutations, exact scope, and the minimum supported authority. `authority=user_explicit` requires the user's confirmation.
- A successful service transaction already creates the Canonical entity change, Event and immutable Receipt. Never dual-write Markdown, a local Memory Object, or a Git business record.
- After an authorized write, refresh repository views only through Receipt-backed Canonical Export, deterministic build/validate and expected-current CAS publish. Do not hand-edit a view or Index.

## Finish

Before handoff, checkpoint authorized continuity with decisions, evidence, failures, retractions, blockers and one explicit next action. Do not write a separate local project log.

Production deployment, DNS, Binding, Secret, Schema, purge, merge, tag and release actions require their own authorization unless already included in the user-approved gate. A validated kernel or migration milestone does not imply that the whole Clued product is mature.
