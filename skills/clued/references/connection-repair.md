# BeamingFace connection repair

Read this reference only for an Owner-requested connection, installation or diagnosis. Keep the working connection and its actual Binding throughout the procedure. The served Agent Contract remains authoritative; this reference neither grants permissions nor replaces its session and capture rules.

## Separate authentication from adoption

OAuth can succeed before the connection is adopted as an Integration. `clued_integration_status` without an `integration_id` resolves the actual connection's `CURRENT` Integration link. `NOT_ADOPTED` means that link is absent; a historical Integration or historical link may still exist. It does not by itself mean authentication failed, the account has no history, or the service needs another OAuth login.

## Diagnose and finish the requested connection

Normal connection setup does not require cloning the repository. Use current registered Host metadata when available. These existing registry identifiers provide compatibility guidance:

| Actual client | `host` | `host_surface` |
| --- | --- | --- |
| Codex | `openai.chatgpt` | `codex` |
| ChatGPT | `openai.chatgpt` | `web`, `desktop` or `mobile`, matching the actual surface |
| Claude | `anthropic.claude` | `chat`, `cowork` or `claude_code`, matching the actual surface |
| Generic MCP client | `generic.mcp` | `default`, only for an actual generic client |

The server still checks accepted values. A connection implemented as an App does not establish that its Host is ChatGPT web. If the actual Host cannot be identified or a value is rejected, obtain the registered metadata or report the gap; do not cycle through labels or force a generic identity until installation passes.

1. Inspect the exact current Host's advertised tool registry and supported schemas. Use that Host's real surface, adapter/package versions and observable capabilities. A screenshot, another device, a prior catalog, an installed Skill or the model's general abilities do not establish this Host's capabilities. Keep unavailable identity dimensions `UNAVAILABLE`; do not turn an email, display name or guessed tenant into a verified identity.
2. Use the same authenticated connection for bootstrap, resume and the connection-self Integration tools. Read `clued_integration_status` first, without selecting an unrelated Integration. An internal error, denied call or missing tool is not a `NOT_ADOPTED` result. Report that observation as unavailable and diagnose its actual boundary; do not claim an empty history or reinstall repeatedly.
3. If adoption is missing and the Owner requested installation, use the advertised `clued_integration_install` workflow. Supply truthful Host facts and reuse the same request and idempotency keys only for a retry of that exact attempt. The server derives provider-connection identity. Confirm the actual result and its receipt; neither OAuth success nor a submitted request proves installation completed.
4. If the service identifies a matching old Integration or an identity conflict, retain its exact returned identity. Use the supported targeted rebind/reconciliation flow with the Owner's authorization rather than inventing a second Integration or changing identity fields to evade the conflict. A revoked Integration requires the Owner's explicit restore; reconnecting cannot restore it.
5. After a successful formal link, confirm the connection's current Integration through the install/status result, then call `clued_session_resume` again on that same actual Binding. A resume taken before the link cannot prove the adopted session's baseline. Use the current Integration ID and CAS version returned by the service for `clued_integration_verify` with `kind=canonical_baseline`. Its transport evidence comes from the server; never supply invented transport facts or reuse verification from another Binding/build. Preserve a failure as a failure and follow the advertised conflict/retry rules.

Do not run installation on every memory read. Once the connection is adopted, use the normal authorized session workflow; revisit repair only for Owner-requested connection work. If the Host cannot expose the required tool or evidence, report the scoped `UNAVAILABLE` result instead of bypassing the Host through credentials, private APIs, direct database edits or another account.

## Report the observed state

Keep OAuth authentication, the current Integration link, Canonical baseline verification and effective capabilities distinct. `ACTIVE` and `operable` can coexist with an incomplete identity claim; report both without filling unknown fields to obtain a green result. A baseline PASS or successful protected call does not establish every feature's `READY(profile)`. Claim READY only for the exact profile and current evidence the service actually returned. List remaining unavailable capabilities and uncertain or failed steps plainly.
