# BeamingFace plugin for Claude Code (private trial)

Private trial, not published (Task `67c97003`, plugin line S3). It carries:

- the BeamingFace Skill (`skills/clued`), invoked as `/clued:clued` or picked up by its description;
- the BeamingFace capture guard as a Stop hook: when the agent is about to stop with an
  Owner decision, a merged PR or a BeamingFace write that has no record or checkpoint after
  it, the stop is blocked once with the reason (agent contract §3 and §5).

It adds no MCP server. Use the authorized connector you already added on claude.ai; it shows
up in Claude Code when you sign in with that account, and in Cowork and chat.

## Install

In Claude Code (local CLI or desktop app; cloud sessions do not install plugins):

```
/plugin marketplace add tdoljyj/cross-memory-system
/plugin install clued@clued-private
```

The repository is private, so Claude Code uses your git credentials for GitHub.
After an update on `main`, run `/plugin marketplace update clued-private` and then
`/plugin update clued@clued-private`.

In this repository the hook stays quiet: `.claude/settings.json` already runs the
same guard. Set `CLUED_CAPTURE_GUARD=off` to turn it off anywhere.

## Maintaining

`skills/clued` and the two hook scripts are copies of the tracked sources
(`skills/clued`, `scripts/hooks/`). After changing a source, run
`python3 scripts/build_claude_code_plugin.py` and commit the copies; `--check` fails
when a copy is stale, and `tests/test_clued_components.py` runs it on every pull request.
`plugin.json` has no `version` on purpose: Claude Code versions the install by commit,
so `/plugin marketplace update clued-private` followed by `/plugin update clued@clued-private`
picks up every merged change.
