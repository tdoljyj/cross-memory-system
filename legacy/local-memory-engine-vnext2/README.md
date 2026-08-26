# Frozen local Memory Engine (historical)

This directory preserves the pre-cutover local Python Memory Engine, Clued v0.x endpoint runtime, evaluation code, tools and tests for audit only.

It is not a current consumer and must not be imported or executed against repository `memory/`. Its path contract (`memory/objects`, `object-index.json`, local audit/session files and Chinese root Markdown files) was retired by the Clued v1.6 root cutover. The exact executable baseline also remains recoverable at git tag `pre-memory-v16-root-cutover-20260826`.

Current reads use root `memory/` as a verified two-level/five-view snapshot. Current writes use authenticated Clued M1 API/MCP contracts only.
