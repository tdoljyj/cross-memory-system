# Independent review setting v0.1

Task `ed3755b4` · Owner Decision `d4663fa2` · implementation contract

One account setting, **独立审核自动授权** (the independent-review permission in Agent Contract §8), defaults On when no setting row exists. Its Native page is `/independent-review`, linked from `/grants`. It records standing permission to arrange independent read-only review within existing authorized work. The normative Agent behavior is in Agent Contract §8, rather than copied into a Skill.

| Interface | Input | Result |
|---|---|---|
| `clued_independent_review_setting_v1` | `{}` | effective enabled flag, version, default marker and last change Receipt |
| `clued_independent_review_setting_set_v1` | `{enabled: boolean, base_version: integer}` | committed change, no-op or version conflict with current state |
| existing `clued_session_resume` | existing authorized inputs | `independent_review` with current account policy |
| existing checkpoint renewal | existing checkpoint inputs | `session_renewal.independent_review` with current policy |

The two settings RPCs are Native direct-account calls, protected by `authorization_owner_v12`; a Binding, delegated OAuth login, caller-supplied account ID or other account cannot change this account's setting. The private table has RLS and no client grants. Helpers are private and have no client EXECUTE grant. The Agent can observe its authenticated account policy through its already authorized restore; no new MCP tool or reconnection is needed.

Updates take the existing account currentness lock and use version CAS. Version 0 denotes an absent row and verified default On. A genuine change creates `INDEPENDENT_REVIEW_ENABLED` or `INDEPENDENT_REVIEW_DISABLED` audit evidence. A no-op leaves the version and Receipt unchanged. A stale version refuses the change. The UI shows no actionable switch before a successful typed read; refresh/uncertain completion re-read state, and account epochs reject late responses.

The switch governs future reviewer starts. An Off setting does not cancel an already-started review or retract its findings. A current setting must be read before each start/retry; cached flags and checkpoint observations are not launch capabilities. Task-specific scope, budget, read permissions and Owner preview prerequisites still apply. Unknown policy does not imply On. The setting carries `execution_authority: false`, and review conclusions do not grant any effectful operation (Decision `d4663fa2`).

Clued delivers the policy through the protected restore and renewal path, independently of the Agent-messages feature flag. The Host consumes that policy when arranging its independent reviewer; this contract claims no physical interception of an unrelated Host's execution tools.

Qualification binds the exact migration chain and contract successor. UI tests cover default On, toggle CAS, delegated rejection, unknown/failed reads, account races, accessibility and uncertain writes. The isolated native PostgreSQL tests exercise both repository and production-installed shapes, real two-connection CAS, account isolation, authorization failures, resume/work-log/renewal delivery, immutable change Receipts and revoked Bindings. The v48→v49 exact edit map restores the whole v48 document before the unchanged v47 and v46 normative proofs run. Production activation uses the existing authorized migration/release doors (Task `ed3755b4`); a source candidate or local test is not deployment evidence.
