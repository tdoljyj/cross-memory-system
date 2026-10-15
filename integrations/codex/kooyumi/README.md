# Kooyumi MCP for Codex

This local desktop plugin connects directly to the authenticated Kooyumi MCP
service. It replaces the local package's dependency on the old registered Clued
app. It does not include or enable the Kooyumi Skill.

The package retains the existing local plugin name so it can update the personal
Kooyumi installation rather than create a second plugin. The MCP server is named
`kooyumi`; existing `clued_*` tool names and account IDs remain unchanged.

## Connection and verification

Use an exact copy of this package for the personal source and the installed
version. Its complete file set is:

```text
.codex-plugin/plugin.json
.mcp.json
README.md
validate-package.mjs
validate-package.test.mjs
```

When updating an existing personal source, remove its obsolete `.app.json` and
any other files outside this set before installing the new version. Copying only
the changed files leaves old dependencies behind. The Codex legacy package
loader can discover a root `.app.json` even when the manifest has no `apps`
field; leaving that file can retain the registered Clued app alongside the
direct Kooyumi MCP server. Do not include a Skill in this package.

Validate the source and the actual installed version, using the source's
validator with the target directory as its optional argument:

```sh
node integrations/codex/kooyumi/validate-package.mjs
node integrations/codex/kooyumi/validate-package.mjs <installed-plugin-directory>
node --test integrations/codex/kooyumi/validate-package.test.mjs
```

Install this directory through Codex's local plugin installation flow. Load the
updated plugin, then use the host's MCP authentication flow for `kooyumi`. OAuth
client registration and PKCE are handled by the host and server discovery; the
package contains no client secret, bearer token or account selector. An existing
registered-app connection is not assumed to authenticate this independent MCP
connection.

Verify the installed version is 1.0.4, reports zero registered apps and exactly
one MCP server named `kooyumi`, and exposes its available tools. Then
perform an authorized protected call using the intended account. Package parsing,
installation and discovery alone do not establish a working connection. Enable
the separate Skill only after that verification succeeds.

New OAuth authorizations on service 0.8.1 can include the authenticated account's
email for connection display. It is captured from the normal identity response
at approval, kept in provider-encrypted properties, and returned only after the
live Binding check. It is a display snapshot: refresh does not update a changed
email. Existing tokens without it remain valid and return the stable account ID;
they do not require another sign-in. A new authorization can capture a new email.

## Domain migration

Version 1.0.4 targets `https://kooyumi.pixelgrav.com/mcp`. Install it after the
matching Worker release has activated the new resource and independent issuer.
The old origin retains its existing issuer and OAuth storage for existing
connections. Its credentials do not authenticate the new resource; complete the
normal host OAuth flow and protected-call verification for the new origin.

Retire the old domain only after the cloud registered app, callbacks and all
remaining consumers have completed their migration and passed verification.

This local package does not rename the cloud registered app or publish a public
directory plugin. Those changes require their own verified updates.
