# Clued Cloud

Clued Cloud is the production-facing continuity service and account/runtime implementation for Clued. The production Worker runs at `https://clued.pixelgrav.com`; the authenticated Clued service backed by Supabase/PostgreSQL is the online Canonical Authority.

This README is the **current engineering entry point** for `apps/clued-cloud/`. Historical migration files and old acceptance documents retain their original evidence value but do not override the current contracts described by code, tests, Canonical Currentness, and accepted successor decisions.

## Start here

- Repository architecture and boundaries: [root README](../../README.md)
- Repository-wide Agent rules: [root AGENTS.md](../../AGENTS.md)
- Rules specific to this app: [AGENTS.md](./AGENTS.md)
- Unified Clued Skill: [skills/README.md](../../skills/README.md)
- Continuity protocol: [protocol/continuity/v1/README.md](../../protocol/continuity/v1/README.md)
- Connection / authorization rollout notes: [docs/connection-authorization-rollout.md](./docs/connection-authorization-rollout.md)

## Runtime boundary

The logical production path is:

```text
App / Web / Agent / MCP
        ↓
Identity / Authorization
        ↓
Cloudflare Worker API / MCP
        ↓
Supabase/PostgreSQL Canonical Store
        ↓
Canonical Record / Project / Event / Evidence / Receipt
        ↓
Currentness + derived projections
        ↓
Context Policy / Compiler
        ↓
Agent / Model
```

Repository files, Markdown, Snapshot bundles, CI artifacts and Google Drive documents are not a second online Canonical Store.

## Canonical write model

Business mutations use the authenticated v1.6 mutation contracts. A successful business transaction commits the Canonical entity together with its Event and immutable Receipt. Clients must not duplicate that write into Markdown or Git.

Current public contracts include Record, Decision, Project, Evidence and Event mutation/read operations plus session continuity and Currentness operations. **Do not hardcode the MCP tool count in prose.** The production-equivalent frozen tool surface is tracked by:

- [`evals/public-mcp/tools-list.baseline.json`](./evals/public-mcp/tools-list.baseline.json)
- [`evals/public-mcp/verify-flag-matrix.ts`](./evals/public-mcp/verify-flag-matrix.ts)
- `npm run mcp:tools:verify`, which reads the live isolated MCP surface and compares it with the frozen baseline.

The retired `clued-developer`, `clued-user` and `clued-continuity` Skill entry points are historical only. The active Skill entry is `skills/clued/SKILL.md`.

## Currentness and projection refresh

Current State/Task/Decision answers cannot be recovered from old checkpoint prose, Markdown, a repository snapshot or a source-bound projection alone.

The required shape is:

```text
Canonical commit
      ↓
invalidate affected projections
      ↓
post-commit projection refresh / reconciliation
      ↓
CURRENT
```

If rebuild/reconciliation does not complete, the affected projection remains `STALE` / `PROJECTION_REQUIRED` and must not masquerade as CURRENT.

The minimal post-commit projection-refresh implementation and its validation contract are documented in [post-commit-projection-refresh.md](./docs/model-program-m0/post-commit-projection-refresh.md). That document currently records **implementation/local validation complete, production deployment separate**; repository presence does not itself prove deployment.

Focused regression:

```bash
npm run test:projection:refresh
```

## Project compatibility boundary

The current database/runtime implementation still carries the legacy `certainty_status` values `unconfirmed` / `confirmed` and uses them in existing Project/five-view admission contracts.

Treat this as a **current compatibility constraint, not a permanent product taxonomy**. Any successor that removes or reinterprets Project certainty must be versioned across schema, migration, API/MCP contracts, UI, Bundle/Snapshot formats and tests. Do not silently change the meaning of existing rows or historical receipts.

Progress remains separately represented by the implemented lifecycle states such as `active`, `paused`, `completed` and `archived`.

## Repository Snapshot / Bundle boundary

Repository `memory/` is a single-user, versioned, read-only snapshot of a published Canonical export. It is not a production data directory and is never a business-write target.

- Snapshot identity and contents come from `memory/manifest.json` and the formal M2 pointer under `artifacts/clued-two-level-snapshots/current.json`.
- The snapshot proves only its recorded as-of boundary; it does not establish online Current Truth.
- Import/export behavior is defined by the versioned Bundle schemas and scripts, not by treating Markdown as writable business data.
- Direct table writes, runtime Git writes, tokens/service-role credentials in bundles, and Markdown-to-Canonical reverse sync are forbidden.

See [the two-level view engineering materials](../../docs/clued-two-level-views/) for migration/rollback evidence and historical contract detail.

## Deployment targets

Keep these targets separate:

- **Production Worker:** `clued-cloud` at `https://clued.pixelgrav.com`.
- **ChatGPT Sites / workspace publishing:** a separate publishing target and not a substitute for the production Worker.
- **Local/isolated acceptance runtime:** test-only infrastructure; passing it does not itself authorize or prove production deployment.

Deployment, DNS, Binding, Secret, Schema, purge, release and production-data actions require their own authority/gate.

## Prerequisites

- Node.js `>=22.13.0`
- npm lockfile install
- Docker for local Supabase workflows
- Linux utilities such as `flock`, `curl` and GNU `timeout` for the CI-oriented shell helpers

Install dependencies from this directory:

```bash
npm ci
```

## Common development commands

```bash
npm run typecheck
npm run lint

npm run db:start
npm run db:reset
npm run db:lint
npm run db:test:m1

npm run test:context:v2
npm run test:projection:refresh
npm run test:authorization:transport
npm run test:authorization:database
npm run test:authorization:migrations
npm run test:authorization:integration

npm run mcp:protocol:verify
npm run mcp:tools:verify
npm run mcp:flags:verify
```

The database and integration suites have different runtime requirements; see the corresponding tests/workflows before assuming one green command covers all gates.

## Feature flags and public surface

Feature flags such as `PROJECT_VIEWS_V2`, `P5_TENANT_WRITES` and development-context flags are tested as an explicit matrix. Do not infer the public MCP/API surface from one flag name or an old README paragraph.

The authoritative engineering checks for the public MCP surface live under `evals/public-mcp/` and the associated GitHub Actions workflows.

## Evidence and maturity language

Use scoped statements:

- “migration present” does not mean “production deployed”;
- “local/CI PASS” does not mean “production accepted”;
- “snapshot current-claimed” does not mean “online Current Truth”;
- “candidate/frozen historical artifact exists” does not grant present execution authority.

For current production claims, use live service/receipt/currentness evidence appropriate to the claim.
