# BeamingFace app for Codex

This local desktop plugin references the existing registered app for BeamingFace
and uses that app's authenticated account connection. The BeamingFace Skill is installed and
enabled independently under its compatible Skill ID `clued`.

The package retains its existing technical name
`dev-6a9f92f8ec908191a9ef87838c60177f` so it updates the personal installation.
Its sole app dependency is `asdk_app_6ad0cb1db0c48191a97bd2bd158836e3`, registered
under the compatible registration name Kooyumi for
`https://kooyumi.pixelgrav.com/mcp`. The package display brand is BeamingFace; that
label does not rename the external registration. Existing `clued_*` tool names
and canonical account IDs remain unchanged.

## Clean package and installation

Use an exact copy of this package for the personal source and installed version.
Its complete file set is:

```text
.codex-plugin/plugin.json
.app.json
README.md
validate-package.mjs
validate-package.test.mjs
```

Version 1.0.7 updates the display brand to BeamingFace and retains the single registered app reference introduced in 1.0.5,
which replaced the temporary direct MCP packages. Remove obsolete `.mcp.json`,
`mcp.json` and other extra files when updating the source; replace any old `.app.json` with this version's file.
Copying only changed files leaves old connections behind. The Codex legacy
loader can discover root `.app.json` and `.mcp.json` even without their manifest
fields, so removing only `mcpServers` does not remove a direct MCP connection.
Keep the explicit `apps: "./.app.json"` declaration. Do not bundle the Skill.

Validate the source and actual installed version using the source's validator:

```sh
node integrations/codex/kooyumi/validate-package.mjs
node integrations/codex/kooyumi/validate-package.mjs <installed-plugin-directory>
node --test integrations/codex/kooyumi/validate-package.test.mjs
```

Install the updated package through Codex's normal local plugin flow. Verify
version 1.0.7 has one registered app under its existing Kooyumi registration
name, with the exact app ID above, and no separately bundled direct MCP server
or duplicate Clued app dependency.
Use the registered app's normal OAuth flow with the intended account, then
verify its tools and an authorized protected call. Installation, package checks
and discovery alone do not establish a working authenticated connection.

## Account display and authorization

Complete the new app's first OAuth authorization after service 0.8.1 is deployed
to the new origin. New authorizations can include the authenticated account's
email for connection display. The service captures it from the normal identity
response at approval, keeps it in provider-encrypted properties, and returns it
only after the live Binding and matching account ID checks.

Email is an authorization-time display snapshot: refresh does not update a
changed email. Existing tokens without it remain valid and return the stable
account ID; they do not require another sign-in. A new authorization can capture
a new email. Verify the real account label in the Host; a profile schema or an
OAuth success alone does not prove which label that Host displays.

The old origin retains its existing issuer and OAuth storage for existing
connections. Its credentials do not authorize the new resource. Keep each
connection's own resource, issuer and Binding, and never copy tokens between
clients. Retire the old domain only after its registered app, callbacks and
remaining consumers have completed their migration and verification.

This package references an existing app registration; its alias and display
name do not edit that registration's name or endpoint. It does not publish a
public directory plugin or change the separately installed Skill.
