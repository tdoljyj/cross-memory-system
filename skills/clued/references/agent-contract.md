# Clued Agent Contract

Contract version: 2

This file is the single normative source for how any Agent, on any Host, uses Clued. The Clued service serves it at `/clued-agent.md`; the `clued` Skill, repository `AGENTS.md` files and the MCP server instructions point here instead of restating it. Host- or repository-specific procedures may add steps; they never relax this contract. A working Binding or scope is required for every protected call but is never, by itself, a reason to read or write.

## 1. Start

1. Use a dedicated Clued Binding for this vendor/client; never share another vendor's token. Keep credentials in the Host's secret storage and Authorization headers, never in prompts, files, Git or receipts.
2. A generic task that needs no personal or project context reads nothing. Every other session calls `clued_session_resume` first. `context_key` is `global` (default) or `project:<canonical_project_id>`; a development resource UUID is a `context_id`, not a session key.
3. Keep the returned `session_token` and `version`. That `version` is the session version, used only as the checkpoint `base_version`. Record mutations use each record's own `version`. The `canonical_version` in mutation results is neither.
4. A session token expires after 3600 seconds. After expiry, or when you continue after a long wait (CI, scheduled checks), resume again instead of reusing old values.

## 2. Read

1. For current work, read Global registry and priority first, then Project State, Task and Decision within authorized scope. Read Log or Archive only when history or evidence is needed. Active Event truth carriers are separate current sources; checkpoint absorption does not retire them. Read profile facts only when identity or preference matters.
2. Default reads return current records only. When a result reports `current_projection_unavailable: true` or `projection_rebuild_required: true`, the current view is unknown, not empty. Say so. You may read `include_history: true` to locate subjects, but label every such item non-authoritative and never select a next action from it alone.
3. Unknown, stale, conflicting or incomplete results never mean no work; never recover current actions from old Markdown, pointers or checkpoint prose. A checkpoint `next_action` is a dated note; reconcile it with later records and evidence before acting on it. When an old checkpoint or active Task conflicts with later terminal evidence, report the conflict, verify the exact subject and repair the records (§3) before recommending anything; never recommend repeating completed work because an old Task still ranks high.
4. Resolve Projects by canonical ID. A mention is not a Project.
5. Report `sources_read` for every current-status answer.

## 3. Capture

When a material outcome happens in work you are doing for the user, write it to Clued in the same turn, before you report it as done. Do not wait for "remember this", for the end of the session, or for a reminder.

| Material outcome | Write | Authority |
|---|---|---|
| The Owner decides: accepts or rejects, chooses between options, freezes, defers, cancels, sets priority, grants or revokes | `decision` create, or `clued_decision_supersede` to replace an earlier decision | `user_explicit` |
| The Owner states a standing preference or rule | `decision` with `type_fields.constraint: true`, or `profile_fact` | `user_explicit` |
| Tracked work finishes: PR merged, migration or deployment applied, task done | Close the Task: `operation: close`, `lifecycle_status: completed`, `mutation.closure_summary` citing PR, commit or receipt. A close or restore carries only `closure_summary` and `closed_reason` in `mutation`, and no `source_refs`, `source_unavailable_reason`, `observed_at` or `confidence` | `observed` |
| Tracked work changes state: blocked, unblocked, a named milestone reached | `update` the active Task | `observed` |
| New work the Owner wants tracked: a bug, a follow-up | `task` create with `execution_bucket` | `user_explicit` |
| A follow-up on a record that is already completed, cancelled or archived | `note` create (`note_kind: log`) with `relations: {"follows": ["<record id>"]}`. Terminal records are read-only; `restore` only when the work itself reopens, with Owner confirmation | per its main claim |
| A recorded fact turns out wrong | `update` the active record, or supersede the decision. Never delete history | per the correction's source |

Not material: drafts, exploration, options the Owner has not chosen, narration of your own steps, conversation that changes nothing tracked. Session progress belongs in the checkpoint (§5), not in records. A write grant alone never authorizes recording general conversation.

Rules for every capture:

1. Authority is the source of the record's main claim. The Owner's own words in this conversation are `user_explicit`; send `user_confirmed: true`, because those words are the confirmation, and do not ask again. Facts you verified from a system (merge API, CI, database) are `observed`; cite the source in `confidence_reason`. Your own judgement is `inferred` with a `confidence`. Never change authority to get a write accepted.
2. `create` requires `mutation.title`, `mutation.content`, the type field in `mutation.type_fields` (`rationale`, `state_kind`, `execution_bucket`, `fact_kind` or `note_kind`), `source_refs` (`[]` when there are no Evidence IDs) and `source_unavailable_reason` (a truthful string, or `null`). Create active, without `base_version`. Never invent Evidence IDs.
3. Mutations of an existing record pass that record's `version` as `base_version`.
4. Use a stable idempotency key built from the originating session, the subject and the outcome, for example `<origin-session>:<subject-id>:<outcome>`. Retries of the same outcome reuse it, including after an uncertain result such as a timeout, so the original operation is recovered rather than duplicated. A corrected request uses a new key.
5. In the reply, name what you wrote in one line (record ID and Receipt). If a write fails, say that it failed and why; never describe the outcome as recorded, and never call a local file or Markdown note a saved Clued record.

## 4. Write discipline

1. Write once with `clued_record_mutate`; use `clued_decision_supersede` for replacement, `clued_project_mutate` for explicit Project create, update, complete, archive or restore (merge writes are disabled), `clued_evidence_ingest` for sources and `clued_event_append` for extension Events. The database transaction creates the Canonical entity + Event + Receipt; do not append a second event to mirror that write, and never dual-write Markdown. The legacy `clued_append_event` adapter is not a mandatory session step.
2. Preserve the returned canonical `id` across API, MCP, UI and Markdown mirrors. Markdown contains query results or stable-ID references, not copied canonical bodies. Superseded and archived facts stay in history.
3. Use `clued_read_log` for the canonical human-readable 日志.md. Import an authorized baseline only with `clued_import_log`.
4. On a rejection, fix the stated cause and retry once:

| Error | Meaning | Action |
|---|---|---|
| `authority_escalation_forbidden` | `user_explicit` without `user_confirmed: true` | Add `user_confirmed: true` only if the Owner actually said it; otherwise use the true, lower authority |
| `terminal_record_read_only` | The record is completed, cancelled or archived | Follow-up note (§3) |
| `record_version_conflict` | Someone changed the record | Re-read and reconcile meaning; never overwrite a newer decision |
| `stale_base_version` (checkpoint) | Wrong counter | Use the session version from resume or the last checkpoint |
| `resume_required_or_session_expired` | The token expired or was used by a checkpoint | Resume, reconcile if asked, retry with the new token (§5) |
| `current_truth_changed_since_resume` (checkpoint) | A write changed current state after resume or the last reconcile | Reconcile with the same token, then retry the checkpoint (§5) |
| `checkpoint_event_not_authorized` (checkpoint) | `coverage.event_ids` lists an event of another context | Checkpoint each context in its own session (§5) |
| `lifecycle_action_cannot_edit_record_content` | A close or restore carried content fields | Send only `closure_summary` / `closed_reason` |
| `INVALID_RECORD_FIELDS` | Missing or malformed fields | Add the named fields |

5. Treat revoked or expired credentials as hard stops and resume again instead of overwriting; missing capability or failed admission remains unavailable. Report exactly what is unavailable and continue unrelated work.
6. Some Hosts show every HTTP 403 as "blocked by a firewall or security service". Clued returns 403 for authorization denials and for contract-rule rejections it has not yet mapped to a tool error, so check your arguments against the tool's contract before calling it a network or infrastructure failure, and label any unverified cause as a guess.

## 5. End

1. Before ending or handing off a supported, authorized and admitted session, call `clued_session_checkpoint` with the session version, explicit coverage (contexts, tracks and the event IDs your writes created), a summary and one next action. Uncovered events remain pending. Respect returned checkpoint thresholds. When resume requires `clued_session_reconcile`, use that authorized tool first.
2. The session remembers the current state it saw at resume or at its last reconcile. Any write since then, including your own §3 writes, makes the checkpoint fail with `current_truth_changed_since_resume`. So when you have written anything since resume or the last reconcile, call `clued_session_reconcile` with the same token before the checkpoint.
3. A committed checkpoint ends that session token. To checkpoint again later in the same conversation, resume again, reconcile if the resume asks for it or you have written since, then checkpoint with the new token and the new session version.
4. A checkpoint never replaces a §3 write, and a §3 write never needs a separate event to mirror it.
5. A checkpoint covers only events of its own `context_key`. Project-scope writes belong to that project's context: resume with `context_key` `project:<id>`, reconcile, and checkpoint there with those writes' event IDs. Global writes are checkpointed in a global session. Never list one context's events in another context's checkpoint; when a context has nothing to absorb, pass an empty `event_ids`.
6. Hosts with end-of-session hooks should enforce §3 and §5 there. Hosts without hooks rely on this text; the next resume reports capture state as unknown.

## 6. Boundaries

1. The authenticated Clued service is the only online Canonical Store. Repository `memory/` is a read-only, versioned export of one snapshot; it never becomes a write target and never establishes online Current Truth. Cross-client continuity goes through the service, never through another client's private files or library.
2. Currentness CURRENT covers only writes that reached Clued. It never means every authoritative decision from a Host conversation was captured; `authority_capture_completeness` is reported separately and is never `complete`.
3. Both Global and Project five views are Standard Work Projection. Task owns executable text; State references Task. A Frontier requires exact Task identity, version, scope, rules and currentness.
4. Read access and priority do not grant execution permission. Deployment, migration, release, credential, billing, other-user access, explicit Project creation and destructive Project actions need their own explicit authorization.
5. Report a suggestion as a suggestion and completion only when an operation result supports it.
