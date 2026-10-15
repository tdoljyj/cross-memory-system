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

The URL intentionally remains `https://clued.pixelgrav.com/mcp` during connection
recovery. The deployed new origin currently rejects `/mcp` and redirects OAuth
discovery to the old issuer. Switching only this URL cannot migrate the OAuth
resource or issuer.

After the new resource, issuer, callbacks and Connect have passed end-to-end
verification, update `.mcp.json`, raise the plugin version and repeat protected
call verification. Retire the old domain only after its remaining consumers have
completed that migration.

This local package does not rename the cloud registered app or publish a public
directory plugin. Those changes require their own verified updates.
