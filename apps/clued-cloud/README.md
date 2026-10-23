# BeamingFace Cloud

BeamingFace Cloud is the production-service implementation for BeamingFace (formerly Clued) continuity, Canonical context and the signed-in account surface. The deployed service uses Cloudflare Workers and a Supabase/PostgreSQL-backed Canonical Store.

This directory is an engineering source tree. Repository source, tests and documentation do **not** by themselves prove what is currently deployed in production.

## Start here

- Repository-wide rules: [`../../AGENTS.md`](../../AGENTS.md)
- App-specific rules: [`AGENTS.md`](./AGENTS.md)
- Root architecture/navigation: [`../../README.md`](../../README.md)
- Currentness/projection implementation note: [`docs/model-program-m0/post-commit-projection-refresh.md`](./docs/model-program-m0/post-commit-projection-refresh.md)
- Production release sequence and migration-history gate: [`docs/production-release.md`](./docs/production-release.md)
- Project lifecycle successor: [`../../development/contracts/project-lifecycle/ProjectLifecycleSuccessor.v0.1.md`](../../development/contracts/project-lifecycle/ProjectLifecycleSuccessor.v0.1.md)
- Project lifecycle production candidate: [`../../development/contracts/project-lifecycle/ProductionMigrationCandidate.v0.1.md`](../../development/contracts/project-lifecycle/ProductionMigrationCandidate.v0.1.md)

## Runtime authority boundary

The authenticated BeamingFace service is the online Canonical Authority.

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

The post-commit refresh pipeline was observed in production during the 2026-09-23 incident. Future deployment claims require the release gate and live attestation described in the production release document.

## Canonical Project contract

The deployed v1 Project schema still contains legacy `certainty_status = unconfirmed | confirmed` compatibility fields and related invariants.

Do **not** treat that physical compatibility field as the long-term product organization model.

The accepted successor direction is implemented in a reviewable v2 candidate:

- BeamingFace creates a Project when it determines the item is a Project.
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
- frozen production-equivalent baseline: `evals/public-mcp/tools-list.baseline.json`, the list production serves with the flags in `evals/public-mcp/tool-versions.json` (`production_equivalent`; the Integration Runtime is on since S2c stage C). After changing a production flag, refreeze it and update that entry together.
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

<https://kooyomi.com>

The public site and Connect links use `kooyomi.com`. The existing `https://kooyumi.pixelgrav.com/mcp` issuer/resource and legacy `clued.pixelgrav.com` connections remain separate technical identities; changing the public brand does not migrate their credentials or Bindings.

ChatGPT/Sites publishing surfaces are separate targets. A successful Sites build or preview must not be used as evidence that the production Worker, Supabase migrations, secrets or bindings were changed.

## Local prerequisites

- Node.js `>=22.22.0`
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

`scripts/select-tests.mjs` classifies every top-level `tests/*.test.mjs` by content: a test is a database test when it, or a fixture it imports, imports `embedded-postgres`, and a unit test otherwise. Run `npm run build` first: `tests/rendered-html.test.mjs` reads the built server bundle. The named `test:*` scripts above stay for focused runs; the `clued-cloud-quality` workflow runs `lint`, `typecheck`, `build` and `test:unit` on every pull request.

```bash
npm run test:unit    # every tests/*.test.mjs that needs no database
npm run test:db      # every test that starts embedded PostgreSQL (needs a non-root user and libicu)
npm run test:select  # print how each test file is classified
```

`supabase/ledger/production-history.json` is the committed record of production's `supabase_migrations.schema_migrations`: one row per production migration with its version, name, the md5 of its single `statements` element and the repository file that carries its text (`supabase/migrations/` or, for text no migration file holds, `supabase/ledger/history-only/`). A new migration file needs no ledger edit until it is applied, as long as the release workflow's `migrate` mode can apply it (14-digit timestamp, a new short name, LF text ending with a newline). `npm run ledger:verify` checks the ledger against the files offline and runs in `clued-cloud-quality`; the production release gate runs the same check and compares the ledger with the live history. How to read and refresh it: `docs/maintenance/migration-ledger.md`.

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

Use the owner-dispatched `Clued Cloud production release` workflow for the production Worker. It checks the production migration history and both projection currentness fences before deploying, then verifies the exact live commit and currentness again.
