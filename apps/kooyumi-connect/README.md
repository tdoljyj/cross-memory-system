# BeamingFace Connect

The adopted public domains are `beamingface.com` and `dev.beamingface.com`. This
candidate changes display branding only: generated installation links stay on
the configured, existing `kooyomi.com` route until DNS, routing and end-to-end
connection acceptance establish a separate domain cutover. The upstream OAuth
identity never follows the public display name.

Repository source for the existing `clued-connect` Worker. `captured-source.json` records its production source version and hashes; the migration candidate keeps the Worker name, KV namespace, service binding and protocol IDs.

The candidate uses BeamingFace branding and generates public links at `https://kooyomi.com/connect`. New requests pin their server-configured `upstream_origin` and `upstream_resource`; `KOOYUMI_UPSTREAM_ORIGIN` continues to default to `https://kooyumi.pixelgrav.com` and accepts only that issuer or `https://clued.pixelgrav.com`. The public `kooyomi.com` origin does not become another issuer or audience. Requests created before these fields existed retain the old MCP audience, including after the installation window expires. Configuration changes do not move an issued request's audience. Unknown, partial or inconsistent stored targets fail closed. Both old Connect routes remain configured until real acceptance allows their retirement.

MCP, request-specific contract/Skill, health checks and rebind use that same pinned upstream. Newly issued proxy URLs use the closed-set `/connect/mcp/kooyumi` or `/connect/mcp/legacy` path, so deleting an expired installation record cannot move an authorized connection to another audience. A present record must match its challenge and typed path. Historical untyped `/connect/mcp` URLs with complete syntactically valid selectors and no remaining record retain the legacy upstream. Forwarding without a record never recreates installation evidence or signs READY; OAuth remains mandatory at the real upstream.

Untyped `/connect/mcp` and `/connect/api/smoke` without selectors use the configured stable upstream. Partial or malformed selectors are rejected. Smoke with missing installation state remains 404. No KV retention extension or bulk migration is required. Canonical public installation links remain on BeamingFace, while OAuth challenges retain their actual upstream issuer. Existing old-audience sessions must be migrated before the old issuer/domain can be retired.

Run the offline checks from this directory:

```text
node --check worker.mjs
node --test tests/connect-migration.test.mjs tests/release.test.mjs
```

The tests intercept all network and storage operations. They do not establish a live MCP connection, account authorization or production READY.

The main-only, Owner-only `clued-cloud-production-release` workflow includes an explicit Connect target. It runs the offline tests, builds one module carrying the exact release commit and publishes it only after the same commit's Owner Grant and main application verification pass. Postflight checks the BeamingFace Connect page, existing issuer/resource metadata, actual upstream, contract hash, revision and compiled commit. It makes no request to the legacy domain, so later retirement of legacy DNS does not block a new release. Existing legacy routes and sessions still require separate migration acceptance before retirement. Build and postflight evidence are retained with the release; committing the source alone does not deploy Connect.

Postflight verifies two contract byte boundaries independently: the new-origin bootstrap must advertise the repository contract's version and SHA-256, and the served document must begin with that exact contract. Connect's smoke hash must then match a separately fetched complete `/clued-agent.md` response, including its origin-specific service information. Evidence records both `contract_sha256` and `served_contract_sha256`; neither hash substitutes for the other.

The existing `https://kooyumi.pixelgrav.com` MCP/OAuth issuer must remain correctly provisioned for these checks to pass. Postflight checks the public `https://kooyomi.com/connect` page separately from this pinned upstream; the public website domain does not become a new OAuth issuer. A passed release health check does not establish any user's authenticated MCP acceptance. Only a matching protected-call response with valid structured success can add connection evidence; MCP tool errors and rejected business results cannot sign READY. Old-audience sessions must still be migrated before retiring the old domain.
