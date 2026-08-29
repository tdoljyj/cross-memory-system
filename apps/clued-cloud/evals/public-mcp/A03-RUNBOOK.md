# A03 production read-only OAuth + PKCE acceptance

This runbook fixes the failed-close retry path without weakening the one-call budget.
It is implementation material only until the Worker change is separately approved and deployed.

## Contract

1. The unauthenticated MCP `initialize` request returns `401` plus the protected-resource challenge.
2. Inspector 2.4.0 completes discovery, PKCE S256, login and consent during **Connect**. No `tools/call` has occurred.
3. The authorization request must carry the exact production MCP `resource`. Claims are decoded only in memory. The redacted output requires the fixed subject, client, issuer, `exp > iat`, Supabase's documented `aud=authenticated`, and either an absent `resource` claim or the exact production MCP resource.
4. A new process uses stored auth, forbids interactive OAuth/retry, and issues exactly one `tools/call` with `--tool-args-json '{}'`.
5. Reconciliation and zero-write SQL run read-only. Finally, only the fixed A03 server entry is removed from the local Inspector OAuth state and the browser session is closed.

The standard Supabase OAuth JWT does not promise an RFC 8707 `resource` claim. An absent claim is recorded as `null`; it is not rewritten into a synthetic PASS value. Resource selection is evidenced independently by protected-resource discovery and the authorization request.

## Fixed local configuration

Use `a03-inspector-config.json` and an isolated state file:

```powershell
$env:CLIENT_PORT='6400'
$env:MCP_SANDBOX_PORT='6401'
$env:MCP_APP_ORIGIN_PORT='6402'
$env:MCP_INSPECTOR_OAUTH_STATE_PATH='<fresh-local-directory>\oauth.json'
npx --no-install mcp-inspector --config evals/public-mcp/a03-inspector-config.json
```

Connect only to `clued-a03-production-readonly`. The Owner enters the password, verification code and consent. Do not capture the launcher URL because it contains the Inspector API token.

Before consent, copy only the authorization-server URL from the browser and validate it through stdin so the complete challenge is never written to a command line or evidence file:

```powershell
Get-Clipboard | node evals/public-mcp/a03-session.mjs authorization-request
```

Store only this command's redacted output.

After consent, save only redacted claims:

```powershell
node evals/public-mcp/a03-session.mjs claims
```

After the pre-call database snapshot, execute the only protected tool call:

```powershell
node evals/public-mcp/a03-session.mjs call
```

If this command fails, the attempt is FAIL_CLOSED. Do not retry it within the same A03 attempt.

After post-call reconciliation and evidence sealing:

```powershell
node evals/public-mcp/a03-session.mjs clear
```

Close the authorization/login tab and stop Inspector. Do not delete or revoke the production user, either OAuth client, or either Binding.
