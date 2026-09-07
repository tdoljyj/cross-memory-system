---
name: clued-user
description: Use Clued to recall or maintain the user's authorized context, projects, tasks and decisions through its connected service. Use for Clued personal memory and ordinary user workflows; does not grant engineering or publisher privileges.
---

# Clued user adapter

Clued's authenticated service is the online source of truth. This Skill explains supported actions; it is not a credential, permission grant, private-data store or independent authority. Installing Developer Skill as well never adds its privileges to a user Binding.

For a generic task with no personal relevance, read no memory. For current personal/project work, use the smallest relevant authorized scope: global priority/registry, then the selected canonical Project's State/Task/Decision. Read Archive/Log only when history matters. Do not treat a past log or legacy object as current status.

## Connection and access

Use the existing connected Clued MCP at `https://clued.pixelgrav.com/mcp`, or its supported authenticated JSON API. Discover current public protocol metadata at `https://clued.pixelgrav.com/.well-known/clued-continuity` and `/v1/continuity/bootstrap`. Bootstrap/initialize success is not proof of private-data authorization or a successful write.

Each agent host uses its own revocable least-privilege Binding and matching user/context keys. Keep tokens in the host's approved secret storage and Authorization header, never prompts, Skills, Git, logs or receipts. Do not reuse the developer's/admin's credentials for a user's request. This installed Skill does not itself create a Binding, connect a new account or prove production acceptance of every advertised capability.

When the required protected tools are callable and authorized, resume the session before using user context, then call only the current advertised tool/schema for the requested operation. Preserve actual IDs, versions, role/capability/scopes and session requirements. A description of a tool is not evidence that the current host can invoke it.

## Read and write behavior

Authorized reads can retrieve the user's scoped context, project views or log; present current evidence and its limits. Preserve canonical IDs. Cross-vendor access uses the Clued service, not another host's private filesystem or ChatGPT Library. GitHub access is not required of an ordinary Clued user.

Durable changes require explicit user intent covering the action and the actual operation scope. Respect already supplied intent and authorization. Use the current service mutation tool for records/projects/decisions/evidence; supply stable idempotency keys and exact CAS/base versions. A confirmed business mutation emits its Canonical entity, Event and Receipt in the same transaction: never append a duplicate second business write merely to mirror that success. Separate session events/checkpoints use their own current supported contracts. Project creation/confirmation or destructive changes need the required explicit user intent; mentioning a possible project alone is not confirmation.

Retain the actual visible Receipt/operation ID and result/version so the user can verify the change; report a suggestion as a suggestion and a successful write only after the service confirms it. Reuse the same idempotency key for an uncertain retry. On conflict, reread and reconcile semantics; do not overwrite a newer version. Before handoff, use the supported authorized session checkpoint with the real base version and next action.

## Boundaries and failures

No direct business writes to repository Markdown or snapshots. No namespace/Registry/Manifest changes, policy/pin editing, release publishing, paid service activation or production deployment is granted here. Such engineering actions route to clued-developer with separate actual authorization and gates. Private read scope never implies write/audit/admin scope; a advertised compound scope is not stronger evidence than the actual protected operation and its verified receipt.

If disconnected, expired, denied, a required capability is unavailable, or an outcome is unknown, state exactly what is unavailable/unconfirmed. Do not claim to have read private memory or saved changes. Continue useful non-private work, preserve an explicitly marked draft if requested, and seek only the missing connection/authorization needed for the requested protected action. Do not request another login when the existing connection works.

The engineering acceptance source is `docs/execution-plans/phase2-structure-governance/NamingIntegrityCloseoutDecision_20260907.json` in the authorized Clued checkout. It establishes scoped Naming/Structure closeout, not blanket production-readiness or user-data access. Current protocol and actual protected service results govern user operations.
