---
name: clued-continuity
description: Restore and maintain authoritative Clued project continuity for requests about Clued, clued-cloud, clued.pixelgrav.com, Pixel Gravity, or continuing Clued work. Use for current work, priorities, handoffs, implementation, testing, and release planning; do not use for unrelated generic questions.
---

# Clued Continuity

Use the repository and Clued APIs as authority; chat recollection is not current truth.

## Restore

1. Identify the exact target: production Worker, ChatGPT Sites, Supabase, DNS, Kernel, or client.
2. Load `memory/contexts/routes.json` and follow its `semantic_contract`.
3. For current work, read Global registry/priority first, then relevant Project State, Task and Decision. Read Log or Archive only for needed history or evidence.
4. Preserve each returned canonical `id`. If required sources are unavailable or conflict, report that and do not claim an authoritative current answer.

The authorized legacy Clued log is `memory/contexts/projects/clued/日志.md`. It is evidence only and cannot override current State, Task or Decision.

## Write

- Never invent a project ID or auto-confirm a project. A mention may create only an unconfirmed candidate; confirmation requires explicit intent or material-work evidence.
- When Unified Record V2 is enabled, write once through `clued_record_write` or `POST /v1/records`, using an idempotency key and the expected version for mutations. The database transaction creates Record + Event + Receipt and the views update automatically.
- Never dual-write a Markdown business record. Markdown output contains query results or stable-ID references to canonical records.
- When a Markdown mirror is requested, use `Global/{State,Task,Decision,Archive,Log}.md` and `Projects/{canonical-project-id}/{State,Task,Decision,Archive,Log}.md`. Format each item exactly as the following line; this is a query conclusion and stable-ID reference, never a copied canonical body:

      - `{id}` — {title}: {conclusion} [status={status}; version={version}]
- When V2 is disabled, do not claim its record tools or UI are live and do not bypass the flag with legacy logs.

## Finish

Preserve decisions with reasons, evidence, failures, retractions and blockers. Update the same authorized project log with one explicit next action. Production migration, Binding changes, feature enablement and deployment always require their own authorization.
