# Context Ownership / Publication v1.1 — Supersession Decision

- Decision date: 2026-09-08
- Decision status: `SUPERSEDED_BEFORE_ACTIVATION`
- Superseded release subject: `Clued Context Ownership / Publication v1.1` standalone production release and Developer→later-User bridge acceptance flow
- Historical implementation commit: `5344d320ecee49655999bdf1f473406d38387fad`
- Successor branch: `feat/clued-unified-skill-authorization`
- Observed successor candidate commit at decision time: `3dbda2396f1a8fdc78336950a8caa0b6bd81c15d`
- Authority effect of this file: stop/supersession record for the old release task only. It does not accept, deploy or publish the successor candidate.

## Decision

The standalone v1.1 production-release task is superseded before capability activation.

The use case that caused the old release task was:

1. a Developer connection exists independently and saves development Context;
2. the human later logs into Dogfood/User;
3. Owner creates a Grant and Project Link;
4. a separate User Binding recovers the earlier Developer history.

The current successor changes the authorization model. A human keeps the authenticated Clued/Supabase account identity and explicitly authorizes each MCP/OAuth connection. Each independently consented connection receives an independent revocable Binding with exact resource/action/environment permissions. Developer work becomes an optional authorized capability of that authenticated connection model; a Skill or workflow label does not itself create or expand authority.

Therefore the old special-case “Developer first, later bridge into User after login” release and its dedicated dual-connection acceptance are no longer the controlling product flow.

## Stop-work effect

Effective immediately for the old v1.1 release subject:

- do not deploy the old standalone v1.1 Worker release as a separate product flow;
- do not enable the old flow merely to finish its checklist;
- do not create v1.1 production Grant/Link objects for the obsolete bridge scenario;
- do not run or sign the old Developer+User dual-connection acceptance as evidence of the successor authorization model;
- do not issue a final v1.1 Production Release Receipt;
- do not restore or widen legacy OAuth permissions to make old tests pass.

## Production state at decision time

Before this supersession was recognized, the reviewed v1.1 database migration had already been applied to production Supabase project `ccxsikzwxlolxqlosril` and recorded in migration history as:

`20260907140346 clued_context_ownership_publication_v11`

A read-only production query performed after the supersession decision counted all ten v1.1 business tables. Every table contained zero rows:

- `context_spaces_v11`: 0
- `context_records_v11`: 0
- `context_record_versions_v11`: 0
- `context_grants_v11`: 0
- `context_links_v11`: 0
- `context_acceptances_v11`: 0
- `context_publications_v11`: 0
- `context_publication_heads_v11`: 0
- `context_feedback_v11`: 0
- `context_operations_v11`: 0

No v1.1 business dependency, Grant/Link, Publication, Feedback, Operation or Receipt/Event was created through this release attempt.

At decision time there was also no verified evidence that production Worker `clued-cloud` had deployed `5344d32`, no verified old-flow feature activation, no completed old dual-connection acceptance, and no final v1.1 Release Receipt.

## Schema handling

Do **not** destructively roll back or DROP the applied migration merely because the old release task is superseded.

The successor candidate currently documents `CONTEXT_OWNERSHIP_V11` as a prerequisite for development-context tools. This means the old release semantics can be superseded while some v1.1 storage/RPC primitives remain reusable implementation dependencies.

Disposition rule:

1. keep the already-applied v1.1 schema inert unless the successor explicitly consumes it;
2. let the successor's accepted design determine which v1.1 primitives remain supported;
3. retire unused structures only through a reviewed forward migration after consumer/dependency inventory;
4. never rewrite production migration history or use force/reset as cleanup.

## Successor boundary

The observed successor is the implementation candidate on `feat/clued-unified-skill-authorization`, commit `3dbda2396f1a8fdc78336950a8caa0b6bd81c15d`, whose commit message is `Unify Clued skill and add explicit connection authorization candidate` and whose rollout document is `apps/clued-cloud/docs/connection-authorization-rollout.md`.

That candidate remains subject to its own tests, review, authorization, production configuration, real OAuth/ChatGPT validation and release Gates. This supersession decision must not be cited as successor acceptance or production activation.
