---
name: clued-continuity
description: Restore and preserve authoritative context for the user's Clued product across conversations, agents, tools, repositories, devices, and deployment targets. Use whenever a request names Clued, clued.pixelgrav.com, Pixel Gravity, clued-cloud, the Clued memory kernel/cloud/client, or implicitly asks to continue, deploy, debug, define, review, or report status on the Clued project. Also use when designing Clued's own continuity or memory features so the product promise remains consistent.
---

# Clued Continuity

Make the user repeat nothing that Clued has already captured. Treat continuity as a correctness requirement, not a courtesy.

This installed Skill is the ChatGPT/Codex adapter, not the cross-vendor protocol itself. The portable source of behavior belongs to Clued Kernel and is exposed through `/.well-known/clued-continuity`, `/v1/continuity/bootstrap`, `/clued-agent.md`, MCP, and the vendor-neutral JSON API. Never imply that an external agent can install this personal Skill or read ChatGPT Library directly.

## Start every Clued task

1. Determine the authorized continuity channel.
   - If a working Clued Binding is available, load the portable Kernel contract and call `clued_agent_bootstrap`, then `clued_session_resume`.
   - Before production cutover, an agent with access to the user-authorized private kernel repository `tdoljyj/cross-memory-system` must inspect the current remote target ref, then read `memory/contexts/projects/clued/日志.md` as the current user's `project:clued` work-log source. Use `main` for ordinary status work, but preserve an explicitly authorized repair or feature branch instead of moving or merging `main`.
   - For ChatGPT/Codex operator work without repository access, use Personal Context plus the persistent Library file `日志.md` as the current operator mirror. Library is a fallback after repository access is actually unavailable, not the default when the authorized private repository can be read.
2. Search Personal Context for the latest Clued decisions, constraints, status, errors, and next action. Use a self-contained query because that search cannot see the current conversation.
3. Read the complete `日志.md` from the selected authorized channel. Prefer the current private-repository copy before production cutover, use the Library mirror when no repository channel is available, and use `clued_read_log` after Binding production cutover.
4. Read every applicable `AGENTS.md` before inspecting or changing a Clued code checkout.
5. Inspect fresh local or external state when the task depends on mutable facts such as deployed code, DNS, Worker bindings, releases, or service configuration.
6. Form a private checkpoint containing: product identity, canonical truth, last verified state, hard constraints, current blocker, and next action. Do not ask the user to restate facts already recovered.

### Current-work routing guard

For a personal or project-related question about current work, todos, priorities, progress, or the next action—including `我现在要做的有哪些`—do not treat the project log as the complete memory set.

1. When the repository channel is available, read `memory/contexts/routes.json` if present.
2. Always load `memory/状态.md`, `memory/待办.md`, and `memory/决策.md` for this intent.
3. Also load each relevant project log that the current Binding or repository authorization permits, including `memory/contexts/projects/clued/日志.md` for `project:clued`.
4. Surface contradictions instead of silently choosing a source. Return or internally preserve `sources_read`, and do not present the result as authoritative when a required source is unavailable.

This guard is deterministic and does not require semantic recall, embeddings, a vector database, or a new paid service.

If the persistent log cannot be found, say so plainly, reconstruct only from available evidence, mark uncertain items, and create or restore the canonical log when authorized.

## Support every authorized agent

Read [references/vendor-neutral-agent-contract.md](references/vendor-neutral-agent-contract.md) completely whenever configuring, implementing, documenting, testing, or handing off Clued access for WorkBuddy, Claude/Anthropic, Qwen, DeepSeek, Google, Microsoft, OpenAI, or another agent host.

- Give each agent its own revocable Binding and minimum scopes/context keys.
- Prefer MCP Streamable HTTP when supported; use the JSON API otherwise.
- Require `resume → append authoritative events → checkpoint` for every vendor.
- Allow an authorized owner to seed the existing `日志.md` with `clued_import_log`. The user has explicitly authorized the complete log at `memory/contexts/projects/clued/日志.md` in the private repository `tdoljyj/cross-memory-system`; this path is a pre-production mirror for the current user's `project:clued` context, not the production storage model. Never copy it to a public or unapproved repository, a Skill bundle, a prompt template, a CI artifact, or build output.
- Require `clued_read_log` for log access. A public bootstrap endpoint may expose protocol instructions, but never user context.
- Do not claim cross-vendor access is live until migration 002, the matching Worker build, and a real two-Binding acceptance test have passed on `https://clued.pixelgrav.com`.

## Resolve conflicting information

Use this priority order:

1. Fresh evidence from the real target system
2. Current canonical work log
3. Repository instructions and versioned project documents
4. Personal Context retrieval
5. Conversation recollection

Never silently overwrite a contradiction. State what conflicted, which evidence won, and why. Record retracted conclusions in the log so a later agent does not repeat them.

## Preserve deployment identity

Keep these targets distinct unless fresh evidence proves they have been deliberately unified:

- Production: `https://clued.pixelgrav.com` routed to Cloudflare Worker `clued-cloud`
- ChatGPT Sites: `https://clued-cloud.tdoljyj.chatgpt.site`, a separate deployment
- Cloudflare DNS and Worker routing
- Supabase Auth/PostgreSQL
- Clued memory kernel, device clients, and cloud services

Do not infer that a successful Sites deployment changed the production Worker. DNS is currently verified healthy; do not recommend changing it without new contrary evidence.

Respect the existing safety constraint: do not run the real flat-to-directory migration, Trial 3B, push, tag, release, purge, or touch the real flat binding unless the user separately authorizes it after an executable migration transaction has been implemented and validated.

## Work and write back

During execution, keep evidence for every material action: target, operation, result, verification, and failure.

Before finishing any Clued task:

1. Update the same `日志.md` rather than creating a new copy. Use `clued_append_event` and `clued_session_checkpoint` when the Kernel channel is live; before cutover, update `memory/contexts/projects/clued/日志.md` in the authorized private kernel repository and keep the Library operator mirror byte-equivalent when that channel is available.
2. Record the date, actual target, actions, evidence, current status, errors or retractions, blockers, and one explicit next action.
3. Preserve stable product decisions and hard constraints; distinguish observed facts from plans.
4. If working in a Clued repository, ensure its root `AGENTS.md` requires this skill and the canonical log before future work.
5. Give the user a concise result and a link to the persistent log. Explain access boundaries when relevant, but do not expose credentials or synchronization internals.

## Product continuity contract

When defining or implementing Clued's memory behavior, read [references/product-continuity-contract.md](references/product-continuity-contract.md) completely and treat it as a product requirement.

Do not call Clued mature merely because one subsystem passes tests. Use scoped maturity language. The memory kernel can be mature or release-candidate while the end-to-end cloud product remains unreleased or incomplete.
