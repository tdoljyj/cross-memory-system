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

Inspector 2.4.0 Web stores OAuth tokens in `byIssuer[activeIssuer]`, while its CLI `--use-stored-auth` path reads only top-level token fields. The A03 session adapter stages only that CLI compatibility projection in the same isolated `oauth.json` during the one protected call and restores the original file bytes in `finally`. It never puts a token in argv, stdout, stderr, evidence, or Git.

## Fixed local configuration

Use `a03-inspector-config.json` and an isolated storage directory. Inspector Web 2.4.0 resolves its OAuth state from `MCP_STORAGE_DIR`; the A03 session commands resolve the same `<directory>\oauth.json`:

```powershell
$env:HOST='localhost'
$env:CLIENT_PORT='6400'
$env:MCP_SANDBOX_PORT='6401'
$env:MCP_APP_ORIGIN_PORT='6402'
$env:MCP_STORAGE_DIR='<fresh-local-directory>'
$env:MCP_INSPECTOR_OAUTH_STATE_PATH="$env:MCP_STORAGE_DIR\oauth.json"
node evals/public-mcp/a03-session.mjs inspector
```

`HOST=localhost` is mandatory: Inspector 2.4.0 otherwise defaults to `127.0.0.1` and derives the wrong OAuth callback origin. The session adapter exposes a redacting loopback proxy on `localhost:6400`, runs Inspector itself on the fixed internal port `6403`, and disables Inspector's internal auto-open. Open only the bare `http://localhost:6400/` URL. The browser still derives the registered callback `http://localhost:6400/oauth/callback` from its visible origin.

The proxy instruments the pinned Inspector 2.4.0 OAuth navigation hook in memory. Immediately before navigation it synchronously submits the authorization URL to a one-shot, nonce-bound, same-origin endpoint. The endpoint validates the fixed authorization server, response type, client, callback, resource, S256 method, non-empty challenge and scope allowance. It writes only `pkce-and-callback.redacted.json`; the complete URL, state, challenge, verifier, authorization code and tokens are never persisted or logged. A missing/drifted hook, rejected assertion, or duplicate assertion blocks navigation and fails the attempt closed. The installed Inspector package is never modified.

Connect only to `clued-a03-production-readonly`. The Owner enters the password, verification code and consent. Do not capture the launcher URL because it contains the Inspector API token.

After the authorization redirect has started, read only the already-redacted one-shot assertion:

```powershell
node evals/public-mcp/a03-session.mjs pkce
```

The command must succeed before claims validation or any protected call. Store only this redacted output. Do not inspect the browser history, authorization URL, Inspector OAuth internals, or Supabase temporary authorization rows to reconstruct missing evidence.

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
