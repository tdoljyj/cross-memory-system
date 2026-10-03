# Event carrier block reasons and decision-class Event guard v0.1

Status: candidate, implemented by migration `apps/clued-cloud/supabase/migrations/20261003100000_event_carrier_decision_guard.sql`. Effective in production only after that migration is applied and the Worker is released.

Owner decision: Clued Decision `d8abee58-015f-4edf-90c8-dd6181e39805` (Task `5a646a67-dc18-4429-8508-41eb75a353e5`).

## Problem

An active `work_log` Event truth carrier (`ACTIVE_UNSTRUCTURED`, `ACTIVE_TYPED` or `LEGACY_UNBOUND`) withholds every current State, Task or Decision record of its scope whose type is in the carrier's `dimensions`. The legacy `clued_append_event` adapter created such carriers for `decision` (dimensions `decision`), `correction` and `retraction` (dimensions `state`, `task`, `decision`). On 2026-10-03, one Owner decision written this way (Event 3951) withheld every Global Decision. `clued_record_list` returned an empty list with no reason, and the project work that depends on Global authority (M2) stopped.

## 1. Guard

`public.clued_mcp_append_event` (MCP `clued_append_event`, REST `/v1/continuity/events` and the OAuth call path) rejects `event_type` `decision`, `correction` and `retraction` with the request rule `decision_event_requires_record` (SQLSTATE 42501). The Worker returns it as an `isError` tool result with category `request_rule` and a hint. Nothing is written.

- Authentication runs first, so an unknown token never learns the rule.
- A retry with the `idempotency_key` of an Event that this Binding appended before the guard still returns `duplicate`.
- `action`, `failure`, `blocker` and `note` are unchanged.
- The record-shaped replacements are:
  - `clued_record_mutate` to create a decision;
  - `clued_decision_supersede` to replace a decision;
  - `clued_record_mutate update` to correct a record;
  - `clued_event_carrier_transition` for an existing active Event.
- `clued_event_carrier_transition` still appends supersede and retract successors. It uses the unguarded body `clued_private.clued_mcp_append_event_unguarded`, which no API role may execute.

## 2. Block reasons

`clued_private.blocking_event_carriers_v1(user, scopes, record_types)` returns `null` when nothing blocks. Otherwise it returns:

```json
{
  "schema": "clued.blocking-event-carriers.v1",
  "scopes": ["global"],
  "record_types": ["decision"],
  "carrier_count": 1,
  "carriers_truncated": false,
  "effect": "…",
  "carriers": [{
    "event_id": 3951, "event_type": "decision", "scope": "global", "event_scope": "global",
    "dimensions": ["decision"], "withholds": ["decision"],
    "carrier_state": "ACTIVE_UNSTRUCTURED", "event_version": 812, "transition_version": 1,
    "occurred_at": "…", "summary": "first 200 characters of the Event's title/summary/text",
    "resolutions": [
      {"action": "materialize", "tool": "clued_record_mutate",
       "arguments": {"operation": "create", "record_type": "decision", "scope": "global",
         "lifecycle_status": "active",
         "mutation": {"relations": {"materializes_event": {"id": 3951, "version": 812}}}}},
      {"action": "owner_continuity_resolution", "tool": "clued_event_carrier_transition",
       "arguments": {"context_key": "global", "source_event_id": 3951,
         "expected_transition_version": 1, "transition": "resolve"}}
    ]
  }]
}
```

- At most 20 carriers are listed, newest first.
- `materialize` is offered only when the Event has a stream version. The caller adds the usual create fields and the Event's original meaning.
- `owner_continuity_resolution` needs the `proof_receipt_id` of an Owner-authorized continuity-only resolution.
- A `LEGACY_UNBOUND` carrier offers only `owner_legacy_reconcile`.
- Supersede and retract are not offered, because each leaves an active successor carrier.

The two read surfaces add these keys only when a carrier blocks, so unblocked responses are unchanged:

- **`clued_record_list`** (both the Binding list and the owner list `clued_user_record_list`), for current reads of `state`, `task` or `decision`: adds `withheld_by_active_events`, which is the object above plus `withheld_record_count`. The count is the number of active records of the requested type in the authorized scopes whose fence is `SHADOWED_BY_ACTIVE_EVENT` or `UNKNOWN`. A project read covers the scopes of all of that Project's aliases. History reads are unchanged.
- **`clued_session_resume`**: adds `blocking_event_carriers`, an array that holds one object for the session's own scope. For a project session whose Binding may read Global (the same test the currentness vector uses), it holds a second object for Global.

## Not changed

Fences, shadow rules, currentness vectors, revisions and carrier states are not changed. No read clears a block. Blocking by dimension and record-level dependency were not part of this decision (items 3 and 4 of the 2026-10-03 proposal).
