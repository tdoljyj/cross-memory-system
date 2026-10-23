# BeamingFace engineering

Use this workflow for the BeamingFace (formerly KooYomi / Clued) implementation, architecture, CI and governance. When the task also maintains project memory, load the memory workflow for that operation. Engineering qualification and personal-data permissions remain separate.

Engineering outcomes are material outcomes under the served BeamingFace Agent Contract §3: a merged PR, an applied migration, a release, a closed or newly agreed bug. Obtain the full contract through `clued_agent_bootstrap` (all parts), or `/clued-agent.md` when the Host cannot pass `part`; it wins over this workflow. Record each outcome in BeamingFace in the same turn it happens, before reporting it to the user.

## Locate and align the real endpoint

Resolve the authorized checkout and its current endpoint configuration; preserve the user's selected feature branch and unrelated working changes. Machine-specific checkout, runtime and trusted-launcher paths must come from that endpoint, not a portable Skill's hardcoded path.

Read applicable AGENTS.md. The unified repository entry is `sync-memory.ps1 -AlignAndVerify -Access <required-scope>` on Windows/Codex endpoints (`-Pull` routes through the same verification) and `python3 sync-memory.py align-and-verify <required-scope>` on Linux and macOS. Invoke it once per request before reading repository `memory/` snapshot files. Requests that read only the online BeamingFace service, or change code and contracts without reading `memory/`, do not run it; they still follow the Git discipline below (fetch `origin/main`, dirty-worktree gates, no overwrite on divergence). It resolves `origin/main` with one real `git ls-remote`, validates an isolated source and local mirror, and completes doctor in the same Python process and RequestVerificationContext. Do not add a separate `python memory.py doctor` or duplicate the remote probe after a successful unified invocation. Independent requests, retries, processes and Agents require their own invocation; never reuse another Agent's PASS.

The isolated read path does not move the development HEAD, Index or files and never merges, rebases or overwrites them. Repository implementation and write paths still require their dirty-worktree and branch-alignment gates; resolve a Remote Ahead checkout under the applicable Git discipline before editing. True divergence produces a Git Conflict Packet and stops the affected path for semantic resolution. Never reset, force, rebase or silently choose a side.

`-Access NONE` is the zero-Git, zero-memory-read/no-op path. Failed Manifest/hash/current-view checks block reliance on that snapshot and affected work, not unrelated tasks. Do not execute stale exported scripts as a substitute for a verified checkout.

Recover current engineering priorities and handoff through authorized current sources. Prior completion reports are evidence for their accepted subject, not proof that today's checkout or production is qualified. Do not restart already accepted phases without a demonstrated affected requirement.

## Preserve governed qualification

Use the installed trusted reader/launcher with the endpoint's existing pins when formal TM19-qualified reads or publication are required. A repository wrapper, local PASS, bare Activation, skipped workflow or candidate receipt cannot replace its live qualification. Do not rewrite pins or policy from a candidate to make validation succeed.

Relevant repository-relative acceptance sources include:
- `docs/execution-plans/phase2-structure-governance/NamingIntegrityCloseoutDecision_20260907.json` and its referenced evidence.
- `development/authority-index/phase2/SourceIndex.json`.
- `development/contracts/phase2/SourceIndex.json` and the typed Consumer/Authorization/Receipt bindings.
- `docs/execution-plans/phase2-structure-governance/Phase2StructureFreezeDecision_20260907.json`.
- `docs/execution-plans/phase2-structure-governance/AcceptanceAndInvalidation.md`.

Locate current accepted successors through the trusted source; do not copy private evidence into this Skill or assume an old filename proves current acceptance. Frozen Registry, Manifest, namespace, alias, version-source, consumer or payload changes require an accepted successor subject and the affected checks. Version truth remains the remote commit plus VERSION, tags, manifest and M2 pointer as required; check when relevant, never on a periodic schedule merely to reassert version status.

## Change and validate efficiently

Use existing explicit authorization for scoped reversible changes, normal commits and ordinary reviewed pushes. The endpoint edits only its own consumer configuration. Commit authorship follows the endpoint: local endpoints use `AI@machine`; hosted agents and connectors are identified by their authenticated host identity and attribution trailers. Fetch+merge before push, and verify the required post-push ancestry. Do not alter another endpoint's configuration.

When the service offers work claims, claim the Task before the first edit, install, build, test or CI run (contract §1.7). Keep the claim's `write_set` covering every path the change touches, renew before the lease ends, put `Clued-Work-Claim: <claim_id>` in the pull request body and the head commit, and release the claim when the pull request merges or the work stops.

Map each change to its affected acceptance requirements. Reuse reliable evidence for unchanged scope, run meaningful checks once, and broaden checks only for an actual gap or new failure. With parallel agents, assign disjoint files/resources and serialize shared state, credentials, integration and publication.

## Production and publication

Only the configured publisher may publish an accepted subject with actual authorization for that publication. Where the installed contract uses `publish --attestation-commit ... --publication-pr ... --expected-current ...`, pass real selectors through the trusted entry. Preserve Naming and the four Phase2 gates, BASE_CORE and applicable conditional checks, signed artifact binding, semantic comparison, typed scope, transaction and receipt requirements.

BeamingFace MCP developer permissions do not supply GitHub, deployment or database administrator credentials. Keep production `kooyumi.pixelgrav.com` / Worker `clued-cloud` distinct from a ChatGPT Sites deployment. A read, preview or local test never grants production publication, paid activation or access to other users' data.

Changed publishers, machine, code, policy, runtime or expired evidence may invalidate prior qualification under the actual acceptance contract. Preserve failures and continue independent authorized work. Roll back only with real prior state, current-state checks and appropriate authority; never restore revoked access.

Canonical business memory still writes only through the BeamingFace service. Repository `memory/` is read-only; formal snapshot readers use the current pointer and immutable published bundles. Do not publish snapshots or change their canonical IDs as a side effect of merging Skills.
