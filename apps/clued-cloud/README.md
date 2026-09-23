# Clued Cloud

Clued Cloud is the production-service implementation for Clued continuity, Canonical context and the signed-in account surface. The deployed service uses Cloudflare Workers and a Supabase/PostgreSQL-backed Canonical Store.

This directory is an engineering source tree. Repository source, tests and documentation do **not** by themselves prove what is currently deployed in production.

## Start here

- Repository-wide rules: [`../../AGENTS.md`](../../AGENTS.md)
- App-specific rules: [`AGENTS.md`](./AGENTS.md)
- Root architecture/navigation: [`../../README.md`](../../README.md)
- Currentness/projection implementation note: [`docs/model-program-m0/post-commit-projection-refresh.md`](./docs/model-program-m0/post-commit-projection-refresh.md)
- Project lifecycle successor: [`../../development/contracts/project-lifecycle/ProjectLifecycleSuccessor.v0.1.md`](../../development/contracts/project-lifecycle/ProjectLifecycleSuccessor.v0.1.md)
- Project lifecycle production candidate: [`../../development/contracts/project-lifecycle/ProductionMigrationCandidate.v0.1.md`](../../development/contracts/project-lifecycle/ProductionMigrationCandidate.v0.1.md)

## Runtime authority boundary

The authenticated Clued service is the online Canonical Authority.

```text
App / Web / Agent / MCP
        ↓
Identity + Authorization
        ↓
Cloudflare Worker / API
        ↓
Supabase/PostgreSQL Canonical Store
        ↓
Currentness + policy + derived projections
        ↓
minimal sufficient context
        ↓
Agent / Model
```

Canonical writes commit through governed database/RPC contracts and emit the applicable Event/Receipt in the same business transaction. Markdown, repository snapshots, account-page views and repository projections are derived consumers, not second write paths.

Production deployment, schema application, secrets, bindings and release operations remain separate authorized actions.

## Currentness and projections

A successful Canonical mutation does not permit an old derived view to continue claiming `CURRENT`.

The intended flow is:

```text
Canonical commit
  → projection invalidation
  → durable refresh/reconciliation
  → CURRENT
```

If refresh/reconciliation cannot prove the required source vector and revision, the read path remains fail-closed as `STALE`, `UNKNOWN` or `PROJECTION_REQUIRED`.

The minimal post-commit refresh implementation currently in this repository is documented separately. Its source presence or local test PASS does not mean that its migration, Builder grant or Worker schedule has been deployed.

## Canonical Project contract

The deployed v1 Project schema still contains legacy `certainty_status = unconfirmed | confirmed` compatibility fields and related invariants.

Do **not** treat that physical compatibility field as the long-term product organization model.

The accepted successor direction is implemented in a reviewable v2 candidate:

- Clued creates a Project when it determines the item is a Project.
- Recognition confidence/reason remain backend metadata/evidence.
- Project progress remains separate from recognition.
- The v2 public/product Project contract removes certainty as a lifecycle/filter axis.
- Legacy `unconfirmed` rows require explicit migration disposition; they are not silently bulk-promoted.

The candidate adds versioned v2 RPCs/views, an immutable private disposition ledger, a read-only production inventory query, Bundle v2 and Snapshot v6. The old v1 RPCs and physical compatibility fields remain only for the bounded rollout/rollback window. See [Project Lifecycle Successor v0.1](../../development/contracts/project-lifecycle/ProjectLifecycleSuccessor.v0.1.md) and the [Production Migration Candidate](../../development/contracts/project-lifecycle/ProductionMigrationCandidate.v0.1.md). Source presence remains **not a deployed migration**.

## Canonical Records and two-level views

Global and Project are query scopes over stable Canonical IDs. State, Task, Decision and Archive are work projections; Log/Event remains historical/evidence-oriented and cannot override a newer current Record/Decision.

For current work:

1. read authorized Global current state/priority;
2. resolve the exact effective Project;
3. read Project State / Task / Decision;
4. use Log / Archive only when history or evidence is needed;
5. honor Currentness fences before presenting a result as current.

Record/Project mutations use the current governed RPC/MCP implementation. Do not duplicate the mutation in Markdown or Git.

## MCP surface

The MCP surface is generated from the runtime code and verified against the machine baseline:

- runtime tools: `worker/continuity.ts`, `worker/records.ts`, `worker/projects.ts`
- frozen production-equivalent baseline: `evals/public-mcp/tools-list.baseline.json`
- flag matrix: `evals/public-mcp/verify-flag-matrix.ts`

Do not hardcode an MCP tool count in human documentation. Tool names, schemas, annotations and required scopes must be checked against the generated runtime surface and frozen baseline.

The unified active Skill is [`../../skills/clued/SKILL.md`](../../skills/clued/SKILL.md). Historical `clued-user`, `clued-developer` and `clued-continuity` Skill entries are not active installation targets.

## User Memory Bundle / Repository snapshot

Repository `memory/` is a versioned, single-user, read-only snapshot. It is not the online production data directory.

Formal repository readers follow:

`../../artifacts/clued-two-level-snapshots/current.json`

and validate the pointed bundle/Manifest according to the repository trust policy. Snapshot `baseline_claim=current` means “current-claimed at its recorded export boundary”; it never replaces online Currentness.

Bundle/import compatibility contracts remain versioned. Bundle v2 and Snapshot v6 remove the Project certainty axis; historical Bundle v1 and Snapshot v5 remain readable rather than being rewritten in place.

## Production Worker vs Sites

The production service target is the Cloudflare Worker `clued-cloud` at:

<https://clued.pixelgrav.com>

ChatGPT/Sites publishing surfaces are separate targets. A successful Sites build or preview must not be used as evidence that the production Worker, Supabase migrations, secrets or bindings were changed.

## Local prerequisites

- Node.js `>=22.13.0`
- Docker for local Supabase/database suites
- Linux/GNU utilities for scripts that explicitly require `bash`, `flock` or `timeout`

Install from the locked package set:

```bash
npm ci
```

## Common verification commands

From `apps/clued-cloud`:

```bash
npm run typecheck
npm run test:context:v2
npm run test:projection:refresh
npm run test:authorization:transport
npm run test:authorization:database
npm run test:authorization:migrations
npm run test:authorization:integration
npm run mcp:gate-receipt:test
```

Database suites use the pinned local Supabase tooling:

```bash
npm run db:start
npm run db:reset
npm run db:lint
npm run db:test:m1
```

Stop the local Supabase stack after the run.

## Public MCP acceptance

The public MCP acceptance surface uses:

- `evals/public-mcp/protocol-check.mjs`
- `evals/public-mcp/verify-tools.mjs`
- `evals/public-mcp/verify-flag-matrix.ts`
- Promptfoo positive/negative cases
- the isolated MCP fixture/runtime

The four historical public-MCP gate names remain `public-mcp-protocol`, `public-mcp-behavior`, `gitleaks` and `trivy`; they prove only their declared acceptance scope and do not authorize deployment.

## Feature flags

Feature flags are implementation/rollout controls, not product truth. Tests must cover the supported matrix; documentation must not infer production enablement from a default value in source.

Relevant compatibility flags currently include `PROJECT_VIEWS_V2`, `P5_TENANT_WRITES` and other explicitly versioned runtime flags in `worker/` and deployment configuration.

## Deployment discipline

Before any production change:

- identify the exact Worker/database target;
- bind the exact source commit;
- run the required repository/DB/currentness gates;
- preserve rollback/readback evidence;
- keep secrets out of source and logs;
- obtain separate authority for schema apply, deployment, binding/secret mutation and release.

After deployment, production Currentness/build attestation is a separate verification step. A repository merge alone is not production acceptance.
