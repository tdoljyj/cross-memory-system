# BeamingFace memory operations

Use this workflow for personal and project context, including project records maintained during engineering. It does not authorize source changes, privileged administration or release publication.

The served BeamingFace Agent Contract governs every step: start, read order, capture of material outcomes, write discipline, error handling and checkpoint. Obtain its full text through `clued_agent_bootstrap` (all parts), or `/clued-agent.md` when the Host cannot pass `part`; it wins over this workflow. This file adds only what is specific to memory operations.

## Development-context projections

If the actual resume response is `scoped_context_ready` with `session_checkpoint_supported=false`, it is an authorized development-context projection, not a restored M1 checkpoint. Read only its returned authorized context IDs through the supported `clued_context` record-list operation in `development_history` mode, selecting relevant State/Task/Decision records by their returned `record_type`. The current development `record_list` does not filter by `record_type` or `record_id`; list once, follow pagination as needed, and select locally. Do not infer access to personal Global records or another project from a shared name, and do not invent a session token. A missing or denied scope remains unavailable.

When only a development resource ID is known, resume `global` to obtain the authorized development projection, then select the exact returned `context_id`; this does not request additional permissions. A developer-only Binding may receive only its authorized Global projection; it must not read private personal Global data to satisfy the read order. Missing Global capability is a scoped limitation, not a reason to request unrestricted access.

In this mode, retain and verify the development-operation receipts instead of a checkpoint; do not claim a checkpoint was saved or expand permissions to create one.

## Projects

The deployed v1 API may still expose legacy `certainty_status`; treat it as compatibility metadata, not as product organization semantics, and do not build workflows around "confirming" a Project. Creation follows an actual Project-recognition decision or explicit user creation.

## Standard work projections (Context v2)

A Frontier cache must bind the current Task ID, version, scope, renderer and current rules. Use `authoritative_current_action` only when resolved and the surrounding Currentness evaluation is current. Missing source or capability, or a limited Global view, is `PROJECTION_REQUIRED`/unknown, never a reason to select from old Markdown, `current.json`, `index.json` or checkpoint prose. Discover and use the advertised reconcile tool when the session requires it; if the Host lacks it, report the scoped capability gap and keep current-action claims unavailable. Read-only snapshot verification for historical/offline artifacts does not turn the artifact into online Current Truth.

A governance Bug/Research that already is a Task keeps its ID. A separate governance entity may reference multiple distinct execution intents; one Task may reference several governance sources. Different request keys do not deduplicate an intent. Resolve a stable existing Task relationship, or retain a non-executable candidate/conflict; never create duplicate executable wrappers from labels, prose or checkpoint suggestions. A merge retains the accepted execution identity and revalidates scope access.

At the actual mutation, deployment or migration, recheck the exact subject/Binding, target, operation, environment, revocation, source version and applicable phase gate. User, Developer and Dogfood are usage modes, not grants.

## Stage closure

When the Owner accepts a final review or closes a stage, that is a material outcome under the contract's capture rules: in the same turn, close or update every related Task, State and Frontier record through Canonical mutations, then checkpoint each authorized context the stage affected. If any write or scope is unavailable, name exactly which projection remains stale.
