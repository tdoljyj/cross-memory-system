# Contributing

This file adds repository practice on top of [AGENTS.md](./AGENTS.md) and the [Clued Agent Contract](./protocol/agent/agent-contract.md). Where they differ, the contract wins.

## Who contributes

The Owner, and Agents acting with the Owner's GitHub identity. CI cannot tell them apart, so every rule below applies to both. Local endpoints author commits as `AI@machine`; connector-authored commits carry the authenticated GitHub actor.

## What belongs here

Code, protocols and contracts, ADRs, schemas and migrations, tests and fixtures, runbooks, Skills, build and deployment configuration, current execution control and machine-verifiable evidence live in this repository. Product research, strategy, business, brand and visual material, reports, meeting notes, historical reviews and office documents go to Google Drive: see the README section [Documentation & Release Boundary](./README.md#documentation--release-boundary--文档与发布边界) and [docs/EXTERNAL_DOCUMENT_ARCHIVE.md](./docs/EXTERNAL_DOCUMENT_ARCHIVE.md).

## Every change is a pull request

Every change reaches `main` through a merged pull request, whatever its size or type (tdoljyj/cross-memory-system#292). Nobody pushes `main` directly, and nobody merges locally and pushes the merge commit: merge the pull request on GitHub after its CI passes. Branches take normal commits, fetch and merge before push, and never a force push, reset or rebase. The `main` ruleset and the connector write flow are in [GitConnectorWriteContract v0.1](./development/contracts/repository/GitConnectorWriteContract.v0.1.md).

## Work claims

Claim the active Task with `clued_work_claim` before editing files, running an install, build or test, starting CI or opening a pull request ([agent contract](./protocol/agent/agent-contract.md) §1.7). Put `Clued-Work-Claim: <claim_id>` in the pull request body and as a trailer of the head commit, and add `Clued-Work-Scope: project:<id>` when the Task is not Global. Start from [.github/pull_request_template.md](./.github/pull_request_template.md). Keep the claim live until the pull request merges.

The `kooyumi-work-admission` check judges each pull request by its layer and the Owner's state ([MergeAdmission v0.1](./development/contracts/execution-admission/MergeAdmission.v0.1.md) §3–§5; the table is [config/merge-admission-policy.json](./config/merge-admission-policy.json)). The `kooyumi-admission-verified` title shows both: `<VERDICT> [<state> · <layer> · reruns <n>]`.

- **Layer**, the strictest of the pull request's paths: `protected` (next section); `docs`: `docs/**`, `development/contracts/**/*.md`, `development/authority-index/**/*.md`, root `*.md`, and `skills/**/*.md`; `code`: everything else.
- **State**, the repository variable `CLUED_MERGE_ADMISSION_STATE`, which only the Owner changes: `normal` (also when unset) requires a claim and the merge slot in every layer and allows one re-run per head, two for `docs`; `efficiency` only advises the claim and the merge slot for `code` and `docs` and allows them two re-runs; `frozen` (also for an unknown value or a bad policy file) judges every layer as `protected`, and only the Owner merges.

Take the merge slot before the final round where it is required. The slot is a first-in, first-out queue per branch (MergeAdmission §13 step 4): bring the default branch in and push, then renew the claim with the `merge:<owner>/<name>:<branch>` ref; it never conflicts, `merge_queue` shows the claim's place, and only the head of the queue holds the slot. While waiting, renew about once an hour to keep the lease and do nothing for the merge. Where the clued-admission App has Contents: write and Pull requests: write, the `clued-merge-executor` workflow brings the default branch into the queue head, and turns on auto-merge for it when its body has the line `Clued-Auto-Merge: <head sha>` naming that head (add it only once the merge of that head is approved; a later change other than bringing the default branch in needs a new line) and it is up to date and admitted and every CI workflow that ran on that head passed with its gated jobs run (MergeAdmission §13 step 5; Task 114d43cf). When GitHub can already merge such a head and every CI workflow ran and passed on it, with no job skipped, the executor merges it itself, bound to that head (Task ff476b06); the holder records that merge in BeamingFace on its next resume. Where the `clued-merge-slot-ci` workflow runs, CI keeps the head's slot while it runs on the pull request's head (90 minutes past each report, 30 once the four CI required checks pass), a CI required check that fails after the claim became head gives it back at once, takes the claim out of the queue and fails `kooyumi-merge-slot`, and the policy's `merge_slot_hard_cap_minutes` (120, counted from becoming head) ends it whatever CI does; the holder no longer renews only to keep it. Once the Owner turns on "Allow auto-merge", auto-merge may be enabled in `normal` and `efficiency`, only while the pull request's claim holds the merge slot; never in `frozen` (`kooyumi-merge-slot` fails while it is on). Re-run only with "Re-run all jobs" on the pull request's current head, as often per workflow run as the title's `reruns <n>` allows and only once that check is green; skipped gated jobs have not passed, and a refused re-run turns its run red ([agent contract](./protocol/agent/agent-contract.md) §1.7). If a re-run is refused at "Set up runner" or with "re-runs are not admitted" (a run from before this rule), close and reopen the pull request once instead. Admission is always enforced: until step 6 of MergeAdmission §13 (2026-10-09) the repository variables `CLUED_WORK_ADMISSION_ENFORCE` and `CLUED_OWNER_REVIEW_ENFORCE` could make the claim and merge slot, and the Owner grant, advisory outside `frozen`; they are no longer read. Only the policy itself advises (the `efficiency` state for the code and docs layers), and the rollback is the `frozen` state and the main ruleset's Owner emergency steps.

## Protected paths and Owner grants

The protected layer is `CORE_PROTECTED_PATHS` in [scripts/ci/merge-admission-policy.mjs](./scripts/ci/merge-admission-policy.mjs) (`.github/**`, `scripts/ci/**`, `scripts/runner/**`, `apps/clued-cloud/scripts/**`, `apps/clued-cloud/package.json`, `apps/clued-cloud/package-lock.json`, `apps/clued-cloud/wrangler*.jsonc`, `apps/clued-cloud/app/supabase-public-config.ts`, `.gitattributes`, `**/.gitattributes`, `.gitmodules`, `.npmrc`, `**/.npmrc`), plus [config/merge-admission-policy.json](./config/merge-admission-policy.json) and the paths its `layers.protected.paths` adds. Its rules are a code constant that no state relaxes. A pull request into `main` that changes one of them, or changes one against the current tip of `main`, must contain that tip and is admitted only with an Owner Grant of `repo.protected_change` that names its exact head commit; in `frozen` every pull request is treated this way. Push first: the check opens the request itself and answers `owner_review_required` with its link; give the Owner that link as returned. After the grant, edit the pull request body, which runs admission again, and wait until `kooyumi-admission-verified` is green on the head. Then use "Re-run all jobs" once on each gated workflow run of that head, and on `gitleaks` or `trivy` if they were refused. Until every self-hosted runner has the updated start hook ([scripts/runner/README.md](./scripts/runner/README.md)), a re-run refused at "Set up runner" means: close and reopen the pull request once instead. Every new head commit needs its own grant, except a head that only merges `main` into an approved one, and only when neither that merge nor `main` changed a protected file the pull request also changes (and never in `frozen`); otherwise the merged head needs a new grant.

## Local checks

From `apps/clued-cloud` (Node 22.22 or newer, see `engines` in [package.json](./apps/clued-cloud/package.json)): `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:unit` (`tests/rendered-html.test.mjs` reads the built server bundle, so build first). The database suites (`npm run test:db`, or a named suite such as `npm run test:work:claims`) start an embedded PostgreSQL, which needs a non-root OS user and libicu. Python checks run from the repository root as the workflows do:

```sh
python3 -m unittest tests.test_clued_components tests.test_clued_version_check -v
python3 -m unittest tests.test_clued_capture_guard tests.test_clued_work_claim_guard -v
python3 -m unittest scripts/ci/test_clued_release_tags.py -v
python3 scripts/ci/check_design_refs.py
python3 scripts/ci/check_active_doc_links.py
```

Finish with `git diff --check`.

## CI overview

- `clued-cloud-quality` ([clued-cloud-quality-gate.yml](./.github/workflows/clued-cloud-quality-gate.yml)) runs lint, typecheck and the unit tests on every pull request and every push to `main`, with no path filter.
- Path-filtered heavy gates run only when their paths change, for example `Clued connection authorization candidate` ([clued-connection-authorization.yml](./.github/workflows/clued-connection-authorization.yml)) and `Clued G4 Database Gate` ([clued-g4-database.yml](./.github/workflows/clued-g4-database.yml)); `design-refs` and `active-doc-links` guard the contracts and the entry documents.
- After the previous display-name cutover, the `main` ruleset (`main write policy (#292)`) requires six checks: `gitleaks`, `trivy`, `contract-placement` and `kooyumi-work-admission` from GitHub Actions, and `kooyumi-admission-verified` and `kooyumi-merge-slot` from the same clued-admission App; the recovery steps are in [docs/maintenance/main-admission-self-test-deadlock.md](./docs/maintenance/main-admission-self-test-deadlock.md) (written when the fifth check was not yet required). A path-filtered check is never required, because a pull request that does not touch its paths would wait for it forever.
- A gated workflow runs its heavy jobs only after its `admission-gate` job has read the `kooyumi-work-admission` result. Jobs run on self-hosted runners when the actor is the repository owner and the head is in this repository, otherwise on GitHub-hosted runners, under one check name.

## Commit messages

As in `git log`: an imperative summary line; a body that says what changed and why and names the Task or Owner Decision it serves (`Task 5077b641`); then the trailers at the end, `Clued-Work-Claim`, `Clued-Work-Scope` for a non-Global Task, and the `Co-Authored-By` and session trailers of the Agent.

## Dependabot pull requests

[.github/dependabot.yml](./.github/dependabot.yml) opens weekly npm and GitHub Actions updates. They carry no BeamingFace work claim and change protected paths (the protected layer, whatever the state), so `kooyumi-work-admission` rejects them with `claim_trailer_missing` until the Owner admits them; there is no bot exemption (the Owner's own web-UI pull requests are treated the same). To admit one: an Agent claims the active Task with a `write_set` that covers the changed files, the Owner pastes `Clued-Work-Claim: <claim_id>` into the pull request body (editing the body reruns the check), the pull request must contain the tip of `main`, and the Owner approves the `repo.protected_change` grant that the check requests for the exact head. After the grant, edit the body and re-run as above. The work-claim exemption of migration `20261002190000` lifts a Task's claim cap; it is not an admission exemption. Dependabot is not the repository owner, so its pull requests run on the GitHub-hosted runner path.
