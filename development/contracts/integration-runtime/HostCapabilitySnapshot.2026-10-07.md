# Host Capability Snapshot 2026-10-07

Plugin line S3 (Task `9966975d`, Owner Decisions `e577beb6` and `bfc51984`). This is a Qualification input in the sense of Cross-Host v0.2.6 §2.4 and §55.1. It is a dated record of what the Hosts' public documentation said on 2026-10-07. It is **not** Clued Core semantics and **not** a Qualification result: every row still has to be confirmed by a run on the real surface (§23, §41.0 S3). It succeeds the 2026-09-24 snapshot in baseline §55.1 and the `capability_snapshot_ref 'v0.2.6 §55.1 2026-09-24'` on the registry's host rows.

Marks follow §24.1 and §25.3:
- `SUPPORTED`: the documentation says so and the S3 run still has to confirm it.
- `CONDITIONAL`: it depends on plan, workspace, role or surface.
- `UNSUPPORTED`: the documentation says no.
- `UNKNOWN`: no official source could be read, or official sources conflict.

## Anthropic

| Surface | Remote MCP (Clued connector) | Skills | Hooks (H1) | Sub-agents | Plugin |
|---|---|---|---|---|---|
| Web Chat | SUPPORTED: custom connector by URL (Customize > Connectors), Streamable HTTP, OAuth. One custom connector on Free; Team and Enterprise owners add it, members connect. | SUPPORTED (code execution on) | UNSUPPORTED: plugin hooks are ignored in chat | UNSUPPORTED | CONDITIONAL: paid plans; chat loads skills, commands and remote MCP from a plugin |
| Desktop Chat | SUPPORTED: same account connectors as web | SUPPORTED | UNSUPPORTED | UNSUPPORTED | CONDITIONAL: as web |
| Cowork | SUPPORTED: account connectors, synced at session start | SUPPORTED: from claude.ai, not from `~/.claude` | CONDITIONAL: plugin hooks only; which events fire is UNKNOWN | SUPPORTED (plugin agents) | CONDITIONAL: paid plans |
| Claude Code, local CLI and desktop Code tab | SUPPORTED: `claude mcp add --transport http`, `.mcp.json`, and claude.ai connectors when signed in with that account; OAuth via `/mcp` | SUPPORTED: `~/.claude/skills`, `.claude/skills`, plugin `skills/`, synced claude.ai skills | SUPPORTED: settings hooks and plugin hooks (Stop blocks with exit 2) | SUPPORTED | SUPPORTED: `.claude-plugin` plugins and marketplaces |
| Claude Code, cloud sessions | CONDITIONAL: repository `.mcp.json` in single-repo sessions, plus claude.ai connectors; not user-scope servers | CONDITIONAL: repository `.claude/skills` and claude.ai skills only | CONDITIONAL: repository `.claude/settings.json` hooks only, single-repo sessions | SUPPORTED | UNSUPPORTED: cloud sessions do not install plugins |

Mobile apps show account connectors and plugin skills in chat. They cannot add plugins, and whether they can add a custom connector is UNKNOWN. The registry has no separate mobile surface for `anthropic.claude`.

## OpenAI

Every OpenAI row is `UNKNOWN` until a person reads the pages. On 2026-10-07 the session's network policy blocked `help.openai.com`, `developers.openai.com` and `platform.openai.com`. Search snippets of those pages contradict each other:
- One snippet: developer mode with full MCP is a beta for Business, Enterprise and Edu on ChatGPT web, and Pro gets read/fetch only.
- Another snippet: developer mode was removed in favour of "Create MCP App" under plugins.

| Surface | Remote MCP | Skills | Hooks | Sub-agents | Plugin |
|---|---|---|---|---|---|
| ChatGPT Web | UNKNOWN (plan-dependent; Owner has personal Plus/Pro) | UNKNOWN (snippet: Skills in ChatGPT) | UNKNOWN | UNKNOWN | UNKNOWN (snippet: one plugin directory shared with Codex) |
| ChatGPT Desktop | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN (baseline §55.1: `.mcp.json` plugins are Desktop only) |
| ChatGPT Mobile | UNKNOWN (snippet: MCP apps web only) | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| Codex (CLI, desktop app) | UNKNOWN (snippet: `[mcp_servers.<name>] url = ...` in `config.toml`, `codex mcp login`) | UNKNOWN (snippet: `.agents/skills`) | UNKNOWN (snippet: `hooks.json` with a Stop event; plugin hooks need trust) | UNKNOWN (snippet: TOML agents) | UNKNOWN (snippet: `plugin.json`, `.agents/plugins/marketplace.json`) |

## What changed since §55.1 (2026-09-24)

- Claude Code cloud sessions do not install plugins. A Claude Code profile that needs a plugin is a local-session profile.
- Cowork reads only plugin hooks and does not read `~/.claude`. H1 reaches Cowork only through a plugin, and §24.2 leaves plugin-distributed H1 to packaging (Phase E).
- Chat ignores plugin hooks and agents. This confirms §24: Hooks and Sub-agents are never a Chat READY prerequisite.
- The OpenAI plugin form may have moved from `.codex-plugin/plugin.json` to a root `plugin.json` (snippet). This is UNKNOWN until read.

## Consequences for S3

1. The production READY profiles in `20261007060000_integration_runtime_ready_profiles.sql` ask, on every surface, only for read and write through the connector (`context.read`, `context.write`). Every Anthropic surface above lists the connector as SUPPORTED or CONDITIONAL. For OpenAI it is UNKNOWN (consequence 4), so an OpenAI profile states only what READY would need. It does not say that the surface can meet it. Hooks stay class C qualification evidence (§21 AC-2).
2. AC-2 (H1 blocks a stop) is checked on Claude Code with the repository-level H1 (`.claude/settings.json`), as §41.0 S3 requires. Cowork's H1 waits for packaging.
3. The registry's `host_features` (seeded from §55.1) stay as they are until a run disagrees. A change ships as a new registry version. That first needs a migration design, because `registry_version` is in neither table's key. `integration_hosts_v1` is keyed by `host`. `integration_host_surfaces_v1` is keyed by `(host, surface)`, and `host_features` lives there.
4. OpenAI runs start only after a person has read the current OpenAI pages and updated this table.

## Sources

Anthropic, read on 2026-10-07 (most pages show no date):
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/plugin-marketplaces
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
- https://support.claude.com/en/articles/12512180-using-skills-in-claude
- https://support.claude.com/en/articles/13837440-use-plugins-in-claude
- https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- https://claude.com/docs/plugins/platform-support

OpenAI, search snippets only:
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://help.openai.com/en/articles/20001256-plugins-in-chatgpt
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/hooks
- https://developers.openai.com/codex/plugins
