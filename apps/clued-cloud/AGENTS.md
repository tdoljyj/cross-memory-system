# Clued continuity rules

These rules apply to every task under `apps/clued-cloud/`.

1. Invoke `$clued-continuity` before inspecting, changing, testing, or deploying Clued.
2. Before production Binding cutover, restore `project:clued` from the authorized private-repository path `memory/contexts/projects/clued/日志.md`. Do not use deprecated root or Library filenames as repository truth.
3. For personal or project questions about current work, todos, priorities, progress, or the next action—including “我现在要做的有哪些”—read `memory/contexts/routes.json` and load `状态.md + 待办.md + 决策.md` plus each relevant authorized project log.
4. A project log supplements global memory; it never replaces status, todos, or decisions. Surface conflicts and report `sources_read`. If a required source is unavailable, do not present the result as authoritative current state.
5. Identify the exact execution target before acting. Keep ChatGPT Sites separate from the production Cloudflare Worker `clued-cloud` at `https://clued.pixelgrav.com`.
6. Treat Cloudflare DNS as healthy unless new direct evidence proves otherwise.
7. Preserve decisions with reasons, actions with evidence, failures, retractions, blockers, and one explicit next action. Update the same authorized `memory/contexts/projects/clued/日志.md` before finishing.
8. Use scoped maturity language. A validated memory-kernel milestone does not mean the end-to-end Clued cloud product is mature.

Do not run the real flat-to-directory migration, Trial 3B, deploy, tag, release, purge, or touch the real flat binding without separate authorization.
