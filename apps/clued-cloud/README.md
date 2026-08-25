# Clued Cloud

Clued's vendor-neutral continuity kernel and account portal, running on Cloudflare Workers with Supabase as the canonical store.

## Project lifecycle v1

Project certainty and work progress are deliberately independent:

- `unconfirmed` is the default when an authorized AI observes a possible project mention.
- `confirmed` is used for explicit intent or material work; promotion updates the same project id and `project:<id>` context key.
- Progress is one of `not_started`, `active`, `paused`, `completed`, or `archived`.
- Exact normalized names and aliases deduplicate automatically. Probable lexical duplicates are returned for review; merge remains explicit.
- Dismiss, restore, rename, status updates and merge are idempotent, audited and serialized in Postgres.

The additive migration `supabase/migrations/202608240003_project_lifecycle_v1.sql`
is applied in formal production. It creates only `clued_projects` and
`clued_project_mentions`, reuses `clued_audit_receipts`, enables RLS, and keeps
private transaction helpers outside the exposed schema.

MCP adds exactly three tools: `clued_project_observe`, `clued_project_list`, and `clued_project_update`. Existing Binding scopes are reused against `system:projects`; no additional setup is required for wildcard bindings.

The signed-in account API has four operations:

- `GET /v1/projects`
- `POST /v1/projects/observe`
- `PATCH /v1/projects/:id`
- `POST /v1/projects/:id/merge`

## Unified Record v2

`supabase/migrations/20260824014005_unified_record_v2.sql` additively extends
`clued_memories` into the single canonical record table. Global and Project are
query levels over the same IDs; State, Task, Decision and Archive are record
filters, while Log remains the append-only `clued_context_events` stream.

REST and MCP both delegate writes to `clued_private.record_write_core`. The
core validates confirmed effective projects, optimistic versions and request
hashes, then commits Record + Event + Receipt in one database transaction.
Legacy `/api/memories` and `/api/memories/audit` are retired. Non-`OPTIONS`
requests return HTTP `410 Gone` with `/v1/records` as the replacement; the
underlying legacy rows and audit evidence remain preserved and are not exposed
as a second write path.

The Worker flag `PROJECT_VIEWS_V2` is disabled when absent. Only `true`, `1`,
`on`, or `enabled` exposes `/v1/records`, the two MCP record tools and the
account-page five-view panel. The approved production migration and formal V2
gate are complete; production currently publishes the enabled
`two-level-five-view-v1` contract.

### Two-level five-view semantic contract

All consumers use the `two-level-five-view-v1` contract exposed by
`GET /v1/records/config` and the continuity bootstrap:

1. Read Global registry and priority.
2. Read the selected Project's current State, Tasks and Decisions.
3. Read Log or Archive only when history or evidence is needed; neither can
   override current records.

REST `GET /v1/records`, MCP `clued_record_list`, the account UI and the
`clued-continuity` Skill preserve the database `id` as the canonical record ID.
Markdown mirrors contain query results or stable-ID references, never a second
canonical body.

The readable mirror layout is fixed and does not create another store:

```text
Global/{State,Task,Decision,Archive,Log}.md
Projects/{canonical-project-id}/{State,Task,Decision,Archive,Log}.md
```

Every entry includes the canonical `id` and only a query conclusion or stable-ID
reference in one deterministic form:

```text
- `{id}` — {title}: {conclusion} [status={status}; version={version}]
```

The account UI uses the same record-presentation mapping for ID, title,
conclusion, status and version. The directory and file names are views, not
writable business records.

Writes follow one path: canonical Record → Event + Receipt in the same database
transaction → derived Global/Project views. REST and MCP already delegate to the
same write core; clients must not dual-write Markdown. A merely mentioned project
remains unconfirmed, and no Skill or client may invent or auto-confirm a project.

When `PROJECT_VIEWS_V2` is disabled, the contract remains discoverable while the
record endpoints/tools/panel remain unavailable and fail closed.

### User Memory Bundle v1

The repository `memory/` directory may be exported as a complete, portable
single-user bundle. It is not an online production data directory and never
replaces the Supabase `user_id + RLS` data plane.

- `memory/objects/*.json` is the only importable business-body source.
- Legacy Markdown and audit logs are checksum-protected read-only evidence.
- Generated Global/Project Markdown contains stable-ID references only.
- The importer defaults to a zero-network dry-run and executes only through an
  authenticated user's `/v1/projects*` and `/v1/records` APIs.
- Tokens, tenant IDs, service-role credentials, direct table writes and runtime
  Git writes are forbidden by the bundle contract.

See `docs/clued-two-level-views/19-User-Memory-Bundle-v1合同与导入验收.md` for
the complete contract and acceptance record.

Local database verification requires Docker and the pinned Supabase CLI entry:

```bash
npm run db:start
npm run db:reset
npm run db:lint
npm run db:test:m1
```

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Linux with `flock`, `curl`, and GNU `timeout`

## Sites Lifecycle

The Sites lifecycle CLI runs the locked dependency install before returning this checkout. Edit the source under `app/`, then checkpoint when a coherent milestone is ready to inspect or share. The remote Sites builder runs `npm run build` against the pushed commit. Do not repeat install or build as a normal pre-checkpoint step.

This starter does not use `wrangler.jsonc`.

`install:ci` is intentionally a single, non-retrying `npm ci`. It refuses a concurrent install for the same project, consumes a matching image-seeded npm cache with `--prefer-offline` while retaining registry fallback for a missing cache object, otherwise downloads and verifies the complete vinext tarball recorded in `package-lock.json`, limits npm to one socket, and terminates a stalled install. `build` applies a short timeout. These helpers target Linux and use GNU `timeout`; they are not native macOS scripts.

Scripts that need writable project-scoped home, npm, XDG, and temporary paths use `scripts/sites-env.sh`. The `dev` and `start` scripts honor the caller's runtime environment and keep Wrangler logs inside the checkout. The generated `.sites-runtime/` directory is disposable and ignored by Git.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Diagnostic Commands

- `npm run install:ci`: perform the one bounded lockfile install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: start the built Vinext application
- `npm test`: build and verify the rendered development-preview metadata
- `npm run typecheck`: run the independent TypeScript gate
- `npm run test:v2:red`: run the frozen V2 contracts (green after Stage 4)
- `npm run db:start`: start the isolated Supabase stack (Docker required)
- `npm run db:reset`: recreate only the local database from migrations
- `npm run db:lint`: lint the local public and private schemas
- `npm run db:test:m1`: replay and verify the v1.6 M1 Record/Project/Event/Evidence/Receipt/Export contracts, RLS, CAS, failure and replay paths, plus deterministic audited promotion of authorized non-terminal legacy Records
- `npm run snapshot:m2:enable -- --export-root <path> --at <iso>`: enable the threshold-triggered M2 persistent snapshot store after at least two ready versions exist
- `npm run snapshot:m2:reconcile -- --export-root <path> --at <iso>`: validate the formal pointer and every registered version, repair registry drift, and raise a bounded file alert after repeated failures
- `npm run snapshot:m2:sweep -- --export-root <path> --at <iso> [--apply]`: report retention candidates by default; delete only versions outside current/previous/minimum retention when explicitly applied
- `npm run snapshot:m2:publish -- --snapshot <path> --export-root <path> --expected-current <version> --at <iso>`: publish under an exclusive lock and current-pointer CAS
- `npm run db:test:v2`: historical pre-M1 suite; its retired write wrapper is intentionally revoked after the M1 migration
- `npm run db:generate`: generate Drizzle migrations after schema changes

Use build commands for targeted diagnosis after a remote failure, not as part of the normal checkpoint path.

The timeout defaults can be overridden for a controlled canary with `SITES_INSTALL_TIMEOUT`, `SITES_INSTALL_KILL_AFTER`, `SITES_BUILD_TIMEOUT`, and `SITES_BUILD_KILL_AFTER`. A timeout fails the command; the helpers never retry an unchanged install or build.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
