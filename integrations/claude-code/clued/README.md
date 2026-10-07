# Clued plugin for Claude Code (private trial)

Private trial, not published (Task `67c97003`, plugin line S3). It carries:

- the Clued Skill (`skills/clued`), invoked as `/clued:clued` or picked up by its description;
- the Clued capture guard as a Stop hook: when the agent is about to stop with an
  Owner decision, a merged PR or a Clued write that has no record or checkpoint after
  it, the stop is blocked once with the reason (agent contract §3 and §5).

It adds no MCP server. Use the Clued connector you already added on claude.ai; it shows
up in Claude Code when you sign in with that account, and in Cowork and chat.

## Install

In Claude Code (local CLI or desktop app; cloud sessions do not install plugins):

```
/plugin marketplace add tdoljyj/cross-memory-system
/plugin install clued@clued-private
```

The repository is private, so Claude Code uses your git credentials for GitHub.
After an update on `main`, run `/plugin marketplace update clued-private`.

In this repository the hook stays quiet: `.claude/settings.json` already runs the
same guard. Set `CLUED_CAPTURE_GUARD=off` to turn it off anywhere.

## Maintaining

`skills/clued` and the two hook scripts are copies. Change the sources
(`skills/clued`, `scripts/hooks/`), then run `python3 scripts/build_claude_code_plugin.py`
and raise `version` in `.claude-plugin/plugin.json`. `--check` fails when a copy is stale;
`tests/test_claude_code_plugin.py` runs it.
