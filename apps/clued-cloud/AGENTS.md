# Clued continuity rules

These rules apply to every task under `apps/clued-cloud/`.

1. Invoke `$clued-continuity` before inspecting, changing, testing, or deploying Clued. If the installed Skill is unavailable, use the versioned fallback at `skills/clued-continuity/SKILL.md` and report the installation drift.
2. Load `memory/contexts/routes.json`. For current work, read in this order: Global registry and priority → relevant Project State/Task/Decision → Log/Archive only when history or evidence is needed.
3. For legacy or pre-cutover continuity, the authorized private-repository log is `memory/contexts/projects/clued/日志.md`. It is evidence only: it supplements but never replaces current State, Task or Decision. Surface conflicts and report `sources_read`.
4. Preserve canonical record `id` across API, MCP, UI, Skill answers and Markdown mirrors. Use `Global/{State,Task,Decision,Archive,Log}.md` and `Projects/{canonical-project-id}/{State,Task,Decision,Archive,Log}.md`; entries may contain query conclusions or stable-ID references, never a copied canonical body.
5. Write in one order only: canonical Record → Event + Receipt in the same database transaction → derived views reflect automatically. Never dual-write Markdown or create a second business record.
6. A mention may create only an unconfirmed candidate through the project lifecycle contract. Never invent a project ID or create/upgrade a confirmed project without explicit user intent or material-work evidence.
7. Identify the exact execution target before acting. Keep ChatGPT Sites separate from the production Cloudflare Worker `clued-cloud` at `https://clued.pixelgrav.com`.
8. Treat Cloudflare DNS as healthy unless new direct evidence proves otherwise.
9. Preserve decisions with reasons, actions with evidence, failures, retractions, blockers, and one explicit next action. Update the same authorized `memory/contexts/projects/clued/日志.md` before finishing.
10. Use scoped maturity language. A validated memory-kernel milestone does not mean the end-to-end Clued cloud product is mature.

Do not run the real flat-to-directory migration, Trial 3B, deploy, tag, release, purge, or touch the real flat binding without separate authorization.
