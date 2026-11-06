# Clued component versioning v0.2

Task `af536fcc` · Owner Decisions `07f0edc7` and `56c3fc66` (2026-10-09) · succeeds v0.1 (Task `6dfd7560`, Decision `967df3da`)

Every self-developed Clued component has a version that a person or an Agent can read, and a client can tell whether what it runs is current. This contract defines where versions live, how they change and how staleness is detected.

**Status.** Design accepted by the Owner (Decisions `07f0edc7`, `56c3fc66`). §2.3, §2.4, §2.5 and §5 take effect with the changes of Task `af536fcc` that implement them (§8); until each is on `main`, v0.1 still describes that part of the running system.

v0.2 changes one thing against v0.1: the Agent Contract is no longer shipped inside the Clued Skill. The service delivers it, so a contract change no longer changes the Skill's version and no longer asks the Owner to reinstall anything (§2). Everything else carries over from v0.1. In-place automatic updates of the Skill and connection changes stay outside this contract: Task `892dba1d` (S2b, host plugin packaging) and Task `456e9348` (S6, update and repair flow) carry them.

## 1. The manifest

`config/clued-components.json` (schema `clued.components/1`) is the single list. Each component has:

- `id`, `kind` (`product`, `skill`, `contract`, `service`, `hook`, `script`), `version` (dot-separated numbers, compared numerically) and `description`;
- for a component that ships files: `root`, `files` (globs under `root`) and `content_sha256`, the SHA-256 of the lines `<file sha256>  <path relative to root>` in path order, with CRLF read as LF;
- optionally `version_marker`: a file under `root` and a pattern with `{version}`. The marker repeats the version inside the component, so a copy installed elsewhere still says which version it is (for the Skill, `metadata.version` in `SKILL.md`).

The `mcp.server` component has no files: the deployed build is identified by its `source_commit`; its version is the service's `serverInfo.version` and `kernel_version`.

## 2. The Agent Contract is not part of the Skill

### 2.1 Why

Until v0.2 the contract lived at `skills/clued/references/agent-contract.md`. PR #318 (2026-09-24, BUG-20260924-001) put it there to end six drifting copies of the rules; the goal was one source, not the Skill as its home. Because the Skill's digest covered `references/`, every contract change also raised the Skill's version, and every installed Skill copy then looked out of date: the contract went from v7 (2026-10-01) to v41 (2026-10-09), and the Skill, versioned since 2026-10-05, from 1.0.0 to 1.0.13. Decision `635919f6` kept the contract in the Skill only until the service could deliver its full text to Agents that reach Clued through MCP alone; §2.3 provides that and §2.5 makes it a precondition.

### 2.2 Rules

1. **One source, outside every Skill.** The contract's only source is `protocol/agent/agent-contract.md`. It keeps its `Contract version: N` line. `apps/clued-cloud/scripts/generate-agent-contract.mjs` generates the Worker module from it, and the existing drift checks (`stage6-contract`, `served-agent-contract`, `verify-served-agent-contract.mjs` after each production deploy) bind the served text to it. No other file restates it.
2. **No Skill package carries the contract.** No file under a `skill` component's root, and no file under a packaged Skill copy (`integrations/**/skills/clued/**`, built by `scripts/build_claude_code_plugin.py`), is named `agent-contract.md` or has a line matching `^Contract version: \d+$`.
3. **Separate versions.** The `agent-contract` component's `root` lies outside every `skill` component's `root`. A contract change raises only `agent-contract`. The Skill's version rises only when the Skill's own files change.
4. **The Skill points, it does not pin.** `SKILL.md` and its references say how to obtain the contract (§2.3) and that the served contract wins. They never state a contract version number. They may cite contract sections by number (for example §1.7) as reading hints; a contract change that renumbers a cited section updates those citations in the same pull request, which then also raises the Skill version.
5. **Order of rollout.** A released Skill drops the contract only after production delivers it (§2.3); §2.5 enforces this.

### 2.3 How an Agent gets the contract

1. `clued_agent_bootstrap`, the public tool every Clued connection already lists, returns the contract. Using an existing tool means no Host has to reconnect to see it. The tool's handler, and only it, adds the text: `content[0]` keeps the existing bootstrap JSON text and `content[1]` is one plain-text block with the contract markdown (or one part of it, item 5). `structuredContent` no longer repeats the whole bootstrap object, which `content[0]` already carries; it holds `schema_version`, `kernel_version`, `components`, `lifecycle` and `agent_contract: { version, sha256, part, parts, markdown_in: "content[1]", url }`, so the text travels once and a client reading only `structuredContent` still learns where the text is (`url` is `/clued-agent.md`). Dropping `endpoints`, `authentication` and `capabilities` from the tool's `structuredContent` is a deliberate change of public output, announced by the `mcp.server` raise (item 7); `content[0]` still carries them, and the HTTP bootstrap endpoints keep the full object. `bootstrapContract()` also builds `/.well-known/clued-continuity` and `/v1/continuity/bootstrap`; those carry only `agent_contract: { version, sha256 }`.
2. `sha256` is the SHA-256 of the UTF-8 source file with CRLF read as LF, which is exactly the markdown block of item 1. It is not the hash of `/clued-agent.md`, whose served text adds an origin-dependent footer.
3. Every successful `clued_session_resume` returns `contract_version` and `agent_contract_sha256` from `withComponentVersions`, whether or not the work-claims flag is on. Today `contract_version` is added only when work claims are enabled; step 1 of §8 moves it.
4. `GET /clued-agent.md` keeps serving the contract for Agents that can reach the web.
5. Size budget and parts. Every rendered `clued_agent_bootstrap` response (all `content` blocks and `structuredContent`) stays at or below 76,000 bytes, about 21,700 tokens at 3.5 bytes per token, under the default 25,000-token MCP output limit of Claude Code. Measured on 2026-10-09: the production bootstrap JSON is 8,124 bytes and the tool returns it twice today, so with the v41 contract (63,369 bytes) the unchanged layout would be about 79,600 bytes; the layout of item 1 is about 73,000 (8,124 + 63,369 + about 1,500 of `structuredContent`). The tool takes an optional `part` argument (integer, from 1). When the whole contract fits the budget it comes in one response with `parts: 1`. Otherwise the contract is cut into the fewest parts that each fit: parts are exact byte slices of the source, each after the first starting at a line that begins with `## ` outside a fenced code block; part 1 holds the preamble with the `Contract version:` line; nothing is trimmed or added, so the parts concatenate to the source. The call without `part` returns part 1, and `agent_contract.parts` says how many there are. When `parts` is above 1, a plain-text `content[2]` says, outside the markdown, "Part k of N of the Clued Agent Contract; call clued_agent_bootstrap with part=k+1", so an Agent that knows nothing about parts does not take part 1 for the whole. Every part response reports the same `version` and `sha256`; when either changes partway (a deploy in between), the Agent starts again from part 1. An Agent that can compute SHA-256 may also check the concatenation. A `part` of 0, above `parts` or not an integer returns `isError` with the `parts` count. The `part` argument ships in step 1 of §8, long before a contract needs it, so Hosts that cache tool schemas have it by then. A Host that cannot pass `part` reads `/clued-agent.md` instead. A CI test renders the response for every part of the current contract and of an oversized synthetic contract, so the multi-part path is tested from step 1 (the current contract leaves about 3,000 bytes of headroom), and fails when any response exceeds the budget, which can happen only when a single `## ` section does.
6. An Agent that does not hold the text of the returned `contract_version` in its conversation reads it through item 1 (or item 4) and follows it before any work. This is routine and silent: a contract version that differs from what an Agent saw before is not a stale install, is not reported to the Owner as one, and needs no reinstall. Only when the Agent can read the contract through neither path does it tell the Owner and stop (agent-contract §1.6).
7. `mcp.server` is raised in the change that adds item 1, so a client can tell from the reported version whether the service delivers the contract.

### 2.4 Enforcement

The rules of §2.2 are checked by `scripts/ci/check_contract_placement.py`, with its test `scripts/ci/test_check_contract_placement.py`, run as a job named `contract-placement` on every pull request and every push to `main`. It is one job on a GitHub-hosted runner (`ubuntu-latest`) with no skipping `if:` and no dependency that can skip it, so it always reports a real conclusion under that one name, whoever opened the pull request; a skipped job would count as passing a required check. It uses Python, git history and one HTTPS read for §2.5; rule 4 additionally uses Node and a pinned standalone esbuild to render the actual candidate Worker's public bootstrap, with outbound I/O disabled, plus oversized synthetic parts. It installs no application dependency tree and runs no pull request code on self-hosted runners. It is an exception to the self-hosted-first runner policy (Decision `f86179b3`): a run takes seconds of GitHub-hosted time per pull request. Enforcement has three parts, all needed:

- **Required check.** `contract-placement` is a required status check of the `main` ruleset and is in `CI_REQUIRED_CHECKS` of `scripts/ci/clued-merge-slot-ci.mjs`, so a red result blocks the merge, auto-merge included. Adding it to the ruleset is an Owner action.
- **Protected files.** The checker, its test, the workflow that runs it and `clued-merge-slot-ci.mjs` are in the protected layer (`scripts/ci/**`, `.github/**`, agent-contract §1.7): a pull request that changes them is admitted only with an Owner Grant of `repo.protected_change` for its exact head.
- **No trust in editable inputs.** The checker hardcodes the Skill locations `skills/**` and `integrations/**/skills/**` and does not take them from `config/clued-components.json`. It also fails when the manifest has no `skill.clued` component, when that component's kind is not `skill`, or when its root is not `skills/clued`.

The check fails when:

1. a file under `skills/**` or `integrations/**/skills/**` is named `agent-contract.md` or has a line matching `^Contract version: \d+$` (§2.2 item 2);
2. the `agent-contract` component's root lies inside `skills/**` or `integrations/**/skills/**` (§2.2 item 3);
3. `SKILL.md` or a Skill reference states a contract version number (§2.2 item 4), that is, matches any of `(?i)\bcontract(?:'s)?\s+(?:version\s*[:#]?\s*)?v?\d+(?!\.?\d)`, `(?i)(?<![\w.])contract_version\W{0,4}\d+`, `(?i)\bcontract\s*\(v\d+\)`, `(?i)\bv\d+\s+of\s+the\s+contract` or `合同\s*v?\d+(?!\.?\d)`. Section citations carry the § sign (for example agent-contract §1.6, 合同 §3.6) and do not match; a section number without § is written with it. Field and component names such as `contract_version` and `agent-contract` without a number, a qualified field such as `project_lifecycle.contract_version: 2`, and `metadata.version` do not match;
4. the rendered `clued_agent_bootstrap` response exceeds the size budget of §2.3 item 5.

**Pre-split transition (Task `af536fcc`, Decision `d5fb7433`).** Step 4 must land before step 3, while the accepted legacy source and its generated Claude Code plugin copy are still in the Skill packages. The checker reports `pending-split`, rather than failures under items 1 and 2, only when all of these conditions hold:

- The trusted base branch and the head both contain the regular source file at the exact path `skills/clued/references/agent-contract.md`, and both manifests identify `agent-contract` with kind `contract`, root exactly `skills/clued/references` and files exactly `["agent-contract.md"]`. The base is the target branch's verified Git commit, never a path or ref selected by the pull request.
- Item 1's exception covers only that source and the one existing generated copy at `integrations/claude-code/clued/skills/clued/references/agent-contract.md`. The copy must exist as a regular file in both base and head and must byte-match its respective source; any missing, moved, additional or drifting copy fails. A contract edit before the split may change the source and copy together; it still passes component version and generation checks.
- Item 2's exception covers only the `agent-contract` component at that exact legacy root. Every other contract file, contract marker or contract component root in a Skill location still fails. Editable manifest inputs cannot add exception paths.

Items 3 and 4 remain enforced during this transition. Item 3 scans `SKILL.md` and the other Skill references; the two admitted legacy contract artifacts are the source and its exact generated copy, not Skill instructions that may pin a version. The manifest identity checks above and all other component checks remain enforced. The test includes the actual pre-split repository layout, a synchronized contract-version change, a drifting or missing plugin copy, an additional contract file, an extra version pin in a Skill reference and malformed or moved legacy manifest entries.

The transition ends when the head removes the legacy source: that head must pass §2.5 and all four rules without exception, including removal of the plugin copy. Once the base no longer has the legacy source or its exact legacy manifest entry, no later head can re-enter the transition; reintroducing either contract artifact into a Skill fails.

Each failure message cites this section and Decisions `07f0edc7` and `56c3fc66`. The test has a failing fixture for each case, including `Contract version: 42` inside a sentence and at its end (`Contract version: 42.`), `see contract v42.`, `合同v35.`, `contract_version` 42, `contract (v42)` and `v42 of the contract`, and a passing fixture for each exempt form of item 3, including `OAuth (v2) flow`, `contract 1.7` written as §1.7 and `project_lifecycle.contract_version: 2`. The pre-split transition changes rollout timing only, not the final rules of §2.2. The rule changes only through an Owner Decision that supersedes those two Decisions and a successor of this contract.

### 2.5 Rollout gate

The pull request whose head removes the legacy source from a base that still contains it (step 3 of §8) exits §2.4's transition and activates this gate. It moves the contract and does not change its bytes: the checker fails when, in that pull request, `protocol/agent/agent-contract.md` differs from the base branch's `skills/clued/references/agent-contract.md`. The old source and plugin copy are both absent from the head, and the manifest points outside every Skill. A deletion without the new source or correct manifest fails. A contract text change goes in a pull request of its own, before or after.

In that pull request the checker also reads production's `/v1/continuity/bootstrap` and fails unless it reports `agent_contract` with the `sha256` of the base branch's contract and an `mcp.server` version at or above the one step 1 introduced. The HTTP bootstrap stands in for the MCP tool because both come from the same Worker build. Merging to `main` already releases the Skill (the Claude Code plugin updates by commit, Codex installs from the checkout), so this gate, not a deploy schedule, keeps a Skill without the contract from reaching Agents while the service cannot deliver it. When a contract change has merged after the last production deploy, the gate stays red until the next deploy; that is intended. A pre-split head does not activate this production-read gate; it still passes §2.4's transition checks. After the removal is on `main` this one-time gate has nothing to compare and stays inactive, but all four placement rules remain mandatory and the transition cannot be restored.

### 2.6 Skills installed before v0.2

Installed copies of Skill 1.0.x carry contract text and tell the Agent to report a contract difference to the Owner (their `SKILL.md`, and §1.6 of the copy they hold). Until each copy is replaced:

1. The MCP `initialize` instructions and the served contract §1.6 state: an installed Clued Skill that carries its own agent contract or tells you to report a contract difference predates this rule; read the contract through `clued_agent_bootstrap`, follow it, and do not report the difference.
2. The first Skill version without the contract needs one reinstall by the Owner on claude.ai and Codex; the Claude Code plugin picks it up on update. After that, contract changes need no reinstall.

## 3. Changing a component

A component's files and its version change together. `scripts/clued_components.py check --base <ref>` fails when:

1. the files no longer match `content_sha256`;
2. a marker differs from the manifest version;
3. `apps/clued-cloud/worker/generated/components.ts` differs from the manifest;
4. against the base manifest, a component's digest changed while its version did not, its version went down, or it was removed.
5. the `--base` ref cannot be used: it is empty, option-like, does not resolve to a commit, or its manifest is not a component manifest. A commit that holds no manifest is reported on stderr as not compared.

The `clued-components` workflow runs this on every pull request and every push to `main`; the placement check of §2.4 runs beside it as `contract-placement`. `bump <id> <version>` raises a version and rewrites its marker; `update` re-records digests; `node apps/clued-cloud/scripts/generate-agent-contract.mjs` regenerates the Worker modules.

## 4. What the service reports

The Worker is built with the manifest's versions and reports them:

- `/.well-known/clued-continuity` and `/v1/continuity/bootstrap`: `components: { schema, versions, source_commit }`, beside `kernel_version`, `lifecycle.contract.version` and `agent_contract: { version, sha256 }`;
- `clued_agent_bootstrap`: the same, plus the contract markdown (§2.3 item 1);
- `/healthz`: `components` (the version map) beside `version` and `source_commit`;
- every successful `clued_session_resume`: `clued_components`, `contract_version` and `agent_contract_sha256`, independent of the work-claims flag.

These describe the released build. A checkout ahead of production is unreleased work, not a mismatch to repair.

## 5. Detecting staleness

`scripts/hooks/clued_version_check.py` runs in Claude Code at two moments only, never on a schedule. It keeps no state between calls.

- **SessionStart**: reads the service's component versions and compares them with this checkout's manifest, and with every installed copy of the Clued Skill it finds (`~/.claude/skills/clued`, synced claude.ai Skills under `~/.claude/skills/synced/*/clued`, `$CODEX_HOME/skills/clued`). It reports a checkout older than the service, a checkout contract newer than the served one (unreleased work), and a Skill copy that has no version, whose `skill.clued` version is older than the latest, or whose files differ from its version. A contract version is never a reason to report a Skill copy; a copy that still holds `references/agent-contract.md` is reported as an older Skill.
- **PostToolUse on `clued_session_resume`**: compares the resume's `clued_components` with the checkout. When the served `contract_version` differs from this checkout's `agent-contract`, it tells the Agent to read the contract through `clued_agent_bootstrap` (§2.3) and follow it; it does not tell the Owner to update anything.

The hook adds context and never blocks. `CLUED_VERSION_CHECK=off` disables it; `=offline` skips the service read; `CLUED_ORIGIN` sets the service origin.

## 6. Git tags

v0.1 §5 is carried over unchanged:

`scripts/ci/clued_release_tags.py` and the `clued-release-tags` workflow keep two kinds of annotated tag. Both are created once and never moved; a tag that already exists on another commit is an error.

- **Product version tag.** Its name is exactly the root `VERSION` text, for example `Clued-v1.6`, and it points at the commit on `main` that set `VERSION` to that value. This is the convention of the older `vNext-1.3` and `vNext-2.0` tags. A push to `main` that changes `VERSION` creates it.
- **Release tag.** `release/<YYYY-MM-DD>-r<run number>` points at the commit a successful production deploy put live: a `workflow_dispatch` run of `clued-cloud-production-release.yml` on `main` whose "Deploy Clued production Worker" step succeeded. Its message names the run, the deploy time, `VERSION` and every component version of `config/clued-components.json` at that commit. Runs that only preflight, back up, migrate or capture a source get no tag.

`clued_release_tags.py check` runs in the `clued-components` workflow: `VERSION` must be a valid tag name, and if its tag exists it must be on the commit that set `VERSION`, so a new product version always needs a new `VERSION` value. A missing tag is backfilled with `workflow_dispatch` (`product`, or `release_run_id`).

Tags are pushed with the repository secret `CLUED_RELEASE_TAG_TOKEN`, a fine-grained token for this repository with Contents and Workflows read/write: GitHub treats a new tag on a commit whose workflow files differ from `main` as a workflow change, and `GITHUB_TOKEN` cannot hold the `workflows` permission. The workflow fails with that explanation when the secret is missing.

## 7. Hosts without hooks

Hosts other than Claude Code run no hook. On them the Agent compares versions itself from the resume fields of §4 and gets the contract as §2.3 says; §2.6 covers Skills installed before v0.2. Automatic repair of an older Skill belongs to Task `456e9348`.

## 8. Implementation steps

1. (Task `af536fcc`) Service: `clued_agent_bootstrap` delivers the contract as §2.3 items 1, 2 and 5 say, including the optional `part` argument; `/.well-known/clued-continuity` and `/v1/continuity/bootstrap` report `agent_contract: { version, sha256 }`; `withComponentVersions` adds `contract_version` and `agent_contract_sha256` to every resume (§2.3 item 3); the MCP `initialize` instructions name `clued_agent_bootstrap` as the way to read the contract and carry §2.6 item 1; `verify-served-agent-contract.mjs` also checks `agent_contract` after deploy; raise `mcp.server`. Update the consumers of the tool's old output and input: `apps/clued-cloud/tests/integration-runtime-worker.test.mjs` (reads `structuredContent.capabilities`), `apps/clued-cloud/scripts/test-phase2-change-applicability.mjs` (reads `structuredContent.authentication`), and the pinned tool list `apps/clued-cloud/evals/public-mcp/tools-list.baseline.json`, re-frozen with `freeze-tools.mjs` for the new `part` input; `npm run mcp:tools:verify` (a live check against production) fails between the merge and the production deploy and passes again after it. Acceptance: the contract text reaches the model through `clued_agent_bootstrap`, recorded per Host. For this rollout, Owner Decision `0f907ae6-ea65-43fa-bf72-3eb2fe82f412` requires actual full-text delivery on claude.ai and ChatGPT web and preserves the existing Codex evidence; it waives the additional Claude Code command-line login and model test. The former four-Host requirement remains historical; an untested command-line Host is never recorded as passing. The changes under `apps/clued-cloud/scripts/**` are in the protected layer and need an Owner Grant for the pull request's head. Deployed to production before step 3 can pass §2.5.
2. (Task `af536fcc`) Contract text: §1.6 describes §2.3 item 6 and §2.6 item 1; raise the contract version.
3. (Task `af536fcc`) Move the source to `protocol/agent/agent-contract.md` and update every reader of the old path:
   - generator and verifier: `apps/clued-cloud/scripts/generate-agent-contract.mjs`, `apps/clued-cloud/scripts/verify-served-agent-contract.mjs`;
   - tests: `apps/clued-cloud/tests/k-cont-contract.test.mjs`, `work-claims-transport.test.mjs`, `served-agent-contract.test.mjs`, `stage6-contract.test.mjs` (including its assertion that `SKILL.md` names `agent-contract.md`);
   - workflow path filters: `.github/workflows/public-mcp-protocol.yml`, `.github/workflows/clued-connection-authorization.yml` (to `protocol/agent/**`);
   - `config/merge-admission-policy.json`: the `!skills/clued/references/agent-contract.md` exception and its fixtures in `scripts/ci/merge-admission-policy.fixtures.mjs` and `merge-admission-policy.test.mjs`;
   - hooks and their plugin copies: `scripts/hooks/clued_capture_guard.py` (docstring, `OWN_MESSAGE` together with the message it matches, and `tests/test_clued_capture_guard.py`), `scripts/hooks/clued_work_claim_guard.py`, `scripts/hooks/clued_version_check.py` (§5), each with its version raised;
   - docs and Skill: `AGENTS.md`, `apps/clued-cloud/AGENTS.md`, `CONTRIBUTING.md`, `skills/README.md` (cites v0.1 and describes the contract comparison this contract removes), `skills/clued/SKILL.md` and its references (links to `agent-contract.md`), and the execution note of Decision `f1dbabc4`;
   - remove the contract from `skills/clued` and the plugin copy; update manifest roots and digests; raise the Skill version (the last one a contract change causes). The contract's bytes do not change in this pull request (§2.5).
   The workflow, policy and `apps/clued-cloud/scripts/**` files are in the protected layer and need an Owner Grant for the pull request's head.
4. (Task `af536fcc`) `scripts/ci/check_contract_placement.py` and its test (§2.4, §2.5), including the exact pre-split transition and irreversible exit, run as the `contract-placement` job; `contract-placement` added to `CI_REQUIRED_CHECKS` in `scripts/ci/clued-merge-slot-ci.mjs` (coordinate with Task `38e0c90d`, which is changing that file); protected layer, Owner Grant needed. The Owner adds `contract-placement` to the required checks of the `main` ruleset. It lands, and is required, before step 3; the real pre-split source and synchronized plugin copy report `pending-split` while the remaining checks pass. Step 3 then exits the transition and must pass the production gate and all placement rules.
5. (Task `af536fcc`) After the steps are on `main`, an archive copy of this contract goes to the Resource Center; the repository copy stays authoritative (Decision `56c3fc66`). The Owner reinstalls the Skill once (§2.6 item 2).
