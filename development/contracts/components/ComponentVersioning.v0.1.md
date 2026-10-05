# Clued component versioning v0.1

Task `6dfd7560` · Owner Decision `967df3da` (2026-10-05)

Every self-developed Clued component has a version that a person or an Agent can read, and a client can tell whether what it runs is current. This contract defines where versions live, how they change and how staleness is detected. In-place automatic updates are outside this contract: Task `892dba1d` (S2b, host plugin packaging) and Task `456e9348` (S6, update and repair flow) carry them.

## 1. The manifest

`config/clued-components.json` (schema `clued.components/1`) is the single list. Each component has:

- `id`, `kind` (`product`, `skill`, `contract`, `service`, `hook`, `script`), `version` (dot-separated numbers, compared numerically) and `description`;
- for a component that ships files: `root`, `files` (globs under `root`) and `content_sha256`, the SHA-256 of the lines `<file sha256>  <path relative to root>` in path order, with CRLF read as LF;
- optionally `version_marker`: a file under `root` and a pattern with `{version}`. The marker repeats the version inside the component, so a copy installed elsewhere still says which version it is (for the Skill, `metadata.version` in `SKILL.md`).

The `mcp.server` component has no files: the deployed build is identified by its `source_commit`; its version is the service's `serverInfo.version` and `kernel_version`.

## 2. Changing a component

A component's files and its version change together. `scripts/clued_components.py check --base <ref>` fails when:

1. the files no longer match `content_sha256`;
2. a marker differs from the manifest version;
3. `apps/clued-cloud/worker/generated/components.ts` differs from the manifest;
4. against the base manifest, a component's digest changed while its version did not, its version went down, or it was removed.

The `clued-components` workflow runs this on every pull request and every push to `main`. `bump <id> <version>` raises a version and rewrites its marker; `update` re-records digests; `node apps/clued-cloud/scripts/generate-agent-contract.mjs` regenerates the Worker module.

## 3. What the service reports

The Worker is built with the manifest's versions and reports them:

- `/.well-known/clued-continuity` and `/v1/continuity/bootstrap`: `components: { schema, versions, source_commit }`, beside `kernel_version` and `lifecycle.contract.version`;
- `/healthz`: `components` (the version map) beside `version` and `source_commit`;
- every successful `clued_session_resume`: `clued_components`, independent of the work-claims flag.

These describe the released build. A checkout ahead of production is unreleased work, not a mismatch to repair.

## 4. Detecting staleness

`scripts/hooks/clued_version_check.py` runs in Claude Code at two moments only, never on a schedule:

- **SessionStart**: reads the service's component versions and compares them with this checkout's manifest, and with every installed copy of the Clued Skill it finds (`~/.claude/skills/clued`, synced claude.ai Skills under `~/.claude/skills/synced/*/clued`, `$CODEX_HOME/skills/clued`). It reports a checkout older than the service, a contract newer than the served one, and a Skill copy that has no version, is older than the latest, or whose files differ from its version (for example a missing `references/`).
- **PostToolUse on `clued_session_resume`**: compares the resume's `contract_version` and `clued_components` with the checkout. A newer served contract tells the Agent to read and follow the served contract, as agent-contract §1.6 requires.

The hook adds context and never blocks. `CLUED_VERSION_CHECK=off` disables it; `=offline` skips the service read; `CLUED_ORIGIN` sets the service origin.

## 5. Git tags

`scripts/ci/clued_release_tags.py` and the `clued-release-tags` workflow keep two kinds of annotated tag. Both are created once and never moved; a tag that already exists on another commit is an error.

- **Product version tag.** Its name is exactly the root `VERSION` text, for example `Clued-v1.6`, and it points at the commit on `main` that set `VERSION` to that value. This is the convention of the older `vNext-1.3` and `vNext-2.0` tags. A push to `main` that changes `VERSION` creates it.
- **Release tag.** `release/<YYYY-MM-DD>-r<run number>` points at the commit a successful production deploy put live: a `workflow_dispatch` run of `clued-cloud-production-release.yml` on `main` whose "Deploy Clued production Worker" step succeeded. Its message names the run, the deploy time, `VERSION` and every component version of `config/clued-components.json` at that commit. Runs that only preflight, back up, migrate or capture a source get no tag.

`clued_release_tags.py check` runs in the `clued-components` workflow: `VERSION` must be a valid tag name, and if its tag exists it must be on the commit that set `VERSION`, so a new product version always needs a new `VERSION` value. A missing tag is backfilled with `workflow_dispatch` (`product`, or `release_run_id`).

## 6. Hosts without hooks

Hosts other than Claude Code run no hook. On them the Agent compares versions itself from the resume fields of §3; automatic repair belongs to Task `456e9348`.
