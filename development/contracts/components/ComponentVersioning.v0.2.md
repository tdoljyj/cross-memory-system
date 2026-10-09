# Clued component versioning v0.2

Task `af536fcc` · Owner Decisions `07f0edc7` and `56c3fc66` (2026-10-09) · succeeds v0.1 (Task `6dfd7560`, Decision `967df3da`)

Every self-developed Clued component has a version that a person or an Agent can read, and a client can tell whether what it runs is current. This contract defines where versions live, how they change and how staleness is detected.

**Status.** Design accepted by the Owner (Decisions `07f0edc7`, `56c3fc66`). §2.3, §2.4 and §5 take effect with the change of Task `af536fcc` that implements them; until that change is on `main`, v0.1 still describes the running system.

v0.2 changes one thing against v0.1: the Agent Contract is no longer shipped inside the Clued Skill. The service delivers it, so a contract change no longer changes the Skill's version and no longer asks the Owner to reinstall anything (§2). Everything else carries over from v0.1 unchanged. In-place automatic updates of the Skill and connection changes stay outside this contract: Task `892dba1d` (S2b, host plugin packaging) and Task `456e9348` (S6, update and repair flow) carry them.

## 1. The manifest

`config/clued-components.json` (schema `clued.components/1`) is the single list. Each component has:

- `id`, `kind` (`product`, `skill`, `contract`, `service`, `hook`, `script`), `version` (dot-separated numbers, compared numerically) and `description`;
- for a component that ships files: `root`, `files` (globs under `root`) and `content_sha256`, the SHA-256 of the lines `<file sha256>  <path relative to root>` in path order, with CRLF read as LF;
- optionally `version_marker`: a file under `root` and a pattern with `{version}`. The marker repeats the version inside the component, so a copy installed elsewhere still says which version it is (for the Skill, `metadata.version` in `SKILL.md`).

The `mcp.server` component has no files: the deployed build is identified by its `source_commit`; its version is the service's `serverInfo.version` and `kernel_version`.

## 2. The Agent Contract is not part of the Skill

### 2.1 Why

Until v0.2 the contract lived at `skills/clued/references/agent-contract.md`. PR #318 (2026-09-24, BUG-20260924-001) put it there to end six drifting copies of the rules; the goal was one source, not the Skill as its home. Because the Skill's digest covered `references/`, every contract change also raised the Skill's version, and every installed Skill copy then looked out of date: the contract went from v7 (2026-10-01) to v41 (2026-10-09), and the Skill, versioned since 2026-10-05, from 1.0.0 to 1.0.13. Decision `635919f6` kept the contract in the Skill only until the service could deliver its full text to Agents that reach Clued through MCP alone; §2.3 provides that.

### 2.2 Rules

1. **One source, outside every Skill.** The contract's only source is `protocol/agent/agent-contract.md`. It keeps its `Contract version: N` line. `apps/clued-cloud/scripts/generate-agent-contract.mjs` generates the Worker module from it, and the existing drift tests (`stage6-contract`, `served-agent-contract`) bind the served text to it. No other file restates it.
2. **No Skill package carries the contract.** No component of kind `skill`, and no packaged copy of one (`integrations/*/…/skills/clued`, built by `scripts/build_claude_code_plugin.py`), contains `agent-contract.md` or any file with a line matching `^Contract version: \d+$`.
3. **Separate versions.** The `agent-contract` component's `root` lies outside every `skill` component's `root`. A contract change raises only `agent-contract`. The Skill's version rises only when the Skill's own files change.
4. **The Skill points, it does not pin.** `SKILL.md` and its references say how to obtain the contract (§2.3) and that the served contract wins. They never name a contract version or rely on rules that exist only in one contract version.
5. **Order of rollout.** The service delivers the contract (§2.3) in production before any released Skill drops it. A Skill without the contract is never released while the service it points to cannot deliver the text.

### 2.3 How an Agent gets the contract

1. `clued_agent_bootstrap`, the public tool every Clued connection already lists, returns `agent_contract: { version, sha256, markdown }` beside `lifecycle.contract`. Using an existing tool means no Host has to reconnect to see it.
2. Every successful `clued_session_resume` returns `contract_version` (as today) and `agent_contract_sha256`.
3. `GET /clued-agent.md` keeps serving the same text for Agents that can reach the web.
4. An Agent that does not hold the text of the returned `contract_version` in its conversation reads it through item 1 (or item 3) and follows it before any work. This is routine and silent: a contract version that differs from what an Agent saw before is not a stale install, is not reported to the Owner as one, and needs no reinstall. Only when the Agent can read the contract through neither path does it tell the Owner and stop (agent-contract §1.6).

### 2.4 Enforcement

`scripts/clued_components.py check` fails, in the `clued-components` workflow on every pull request and every push to `main`, when:

1. a `skill` component's root, or any packaged Skill copy, contains `agent-contract.md` or a `Contract version:` line (§2.2 item 2);
2. the `agent-contract` component's root lies inside a `skill` component's root (§2.2 item 3);
3. `SKILL.md` or a Skill reference names a contract version (§2.2 item 4).

Each failure message cites this section and Decisions `07f0edc7` and `56c3fc66`. `tests/test_clued_components.py` has a failing fixture for each case. The rule changes only through an Owner Decision that supersedes those two Decisions and a successor of this contract; editing the check to let a pull request through is not such a change.

## 3. Changing a component

A component's files and its version change together. `scripts/clued_components.py check --base <ref>` fails when:

1. the files no longer match `content_sha256`;
2. a marker differs from the manifest version;
3. `apps/clued-cloud/worker/generated/components.ts` differs from the manifest;
4. against the base manifest, a component's digest changed while its version did not, its version went down, or it was removed;
5. any rule of §2.4 is broken.

The `clued-components` workflow runs this on every pull request and every push to `main`. `bump <id> <version>` raises a version and rewrites its marker; `update` re-records digests; `node apps/clued-cloud/scripts/generate-agent-contract.mjs` regenerates the Worker modules.

## 4. What the service reports

The Worker is built with the manifest's versions and reports them:

- `/.well-known/clued-continuity` and `/v1/continuity/bootstrap`: `components: { schema, versions, source_commit }`, beside `kernel_version` and `lifecycle.contract.version`;
- `clued_agent_bootstrap`: the same, plus `agent_contract` (§2.3);
- `/healthz`: `components` (the version map) beside `version` and `source_commit`;
- every successful `clued_session_resume`: `clued_components`, `contract_version` and `agent_contract_sha256`, independent of the work-claims flag.

These describe the released build. A checkout ahead of production is unreleased work, not a mismatch to repair.

## 5. Detecting staleness

`scripts/hooks/clued_version_check.py` runs in Claude Code at two moments only, never on a schedule:

- **SessionStart**: reads the service's component versions and compares them with this checkout's manifest, and with every installed copy of the Clued Skill it finds (`~/.claude/skills/clued`, synced claude.ai Skills under `~/.claude/skills/synced/*/clued`, `$CODEX_HOME/skills/clued`). It reports a checkout older than the service, and a Skill copy that has no version, whose `skill.clued` version is older than the latest, or whose files differ from its version. A contract version is never a reason to report a Skill copy. A copy that still holds `references/agent-contract.md` is a pre-v0.2 Skill and is reported once as an older Skill.
- **PostToolUse on `clued_session_resume`**: compares the resume's `clued_components` with the checkout. When the served `contract_version` differs from the one the Agent last read, it tells the Agent to read the served contract (§2.3) and follow it; it does not tell the Owner to update anything.

The hook adds context and never blocks. `CLUED_VERSION_CHECK=off` disables it; `=offline` skips the service read; `CLUED_ORIGIN` sets the service origin.

## 6. Git tags

Unchanged from v0.1 §5. `scripts/ci/clued_release_tags.py` and the `clued-release-tags` workflow keep two kinds of annotated tag, both created once and never moved:

- **Product version tag.** Its name is exactly the root `VERSION` text, for example `Clued-v1.6`, on the `main` commit that set `VERSION` to that value.
- **Release tag.** `release/<YYYY-MM-DD>-r<run number>` on the commit a successful production deploy put live; its message names the run, the deploy time, `VERSION` and every component version.

`clued_release_tags.py check` runs in the `clued-components` workflow. Tags are pushed with the repository secret `CLUED_RELEASE_TAG_TOKEN`.

## 7. Hosts without hooks

Hosts other than Claude Code run no hook. On them the Agent compares versions itself from the resume fields of §4 and gets the contract as §2.3 says. Automatic repair of an older Skill belongs to Task `456e9348`.

## 8. Implementation steps

1. (Task `af536fcc`) Service: `clued_agent_bootstrap` returns `agent_contract`; resume returns `agent_contract_sha256`; MCP server instructions name `clued_agent_bootstrap` as the way to read the contract. Released to production before step 3 ships (§2.2 item 5).
2. (Task `af536fcc`) Contract text: §1.6 and the Skill describe §2.3 item 4; contract version bump.
3. (Task `af536fcc`) Move the source to `protocol/agent/agent-contract.md`; remove it from `skills/clued` and the plugin copy; point the generator, `AGENTS.md`, `apps/clued-cloud/AGENTS.md` and Decision `f1dbabc4`'s execution note at the new path; manifest roots and digests; Skill version bump (the last one a contract change causes).
4. (Task `af536fcc`) Checks of §2.4 with tests; version-check hook per §5.
5. (Task `af536fcc`) After merge, an archive copy of this contract goes to the Resource Center; the repository copy stays authoritative (Decision `56c3fc66`).
