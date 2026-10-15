# Kooyumi MCP for Codex

This local desktop plugin connects directly to the authenticated Kooyumi MCP
service. It replaces the local package's dependency on the old registered Clued
app. It does not include or enable the Kooyumi Skill.

The package retains the existing local plugin name so it can update the personal
Kooyumi installation rather than create a second plugin. The MCP server is named
`kooyumi`; existing `clued_*` tool names and account IDs remain unchanged.

## Connection and verification

Install this directory through Codex's local plugin installation flow. Load the
updated plugin, then use the host's MCP authentication flow for `kooyumi`. OAuth
client registration and PKCE are handled by the host and server discovery; the
package contains no client secret, bearer token or account selector. An existing
registered-app connection is not assumed to authenticate this independent MCP
connection.

Verify the host reports the actual `kooyumi` server and its available tools, then
perform an authorized protected call using the intended account. Package parsing,
installation and discovery alone do not establish a working connection. Enable
the separate Skill only after that verification succeeds.

## Domain migration

Version 1.0.3 targets `https://kooyumi.pixelgrav.com/mcp`. Install it after the
matching Worker release has activated the new resource and independent issuer.
The old origin retains its existing issuer and OAuth storage for existing
connections. Its credentials do not authenticate the new resource; complete the
normal host OAuth flow and protected-call verification for the new origin.

Retire the old domain only after the cloud registered app, callbacks and all
remaining consumers have completed their migration and passed verification.

This local package does not rename the cloud registered app or publish a public
directory plugin. Those changes require their own verified updates.
