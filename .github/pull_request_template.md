<!-- Keep the four headings. Remove the guidance comments as you fill them in. -->
## Why

<!-- The Task, Owner Decision or issue this change serves, and the problem it fixes. Name IDs as `Task 5077b641`. -->

## What

<!-- What changed, in behaviour terms. Name migrations, Worker changes and contract edits explicitly. -->

## Checks run locally

<!-- Run from apps/clued-cloud; name the database suites you ran (npm run test:db or a named test:* suite). -->
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run test:unit`
- [ ] the relevant `test:db` or named suites:
- [ ] `git diff --check`

## Rollout

<!-- A migration, a Worker release and a flag change each need separate Owner approval. Write "none" when there is none. -->
- migration: none
- Worker release: none
- flag changes: none

<!-- Required: the claim this pull request runs under (agent contract §1.7). Keep the Scope line only
     for a non-Global Task and delete it otherwise. A change to a protected path (CORE_PROTECTED_PATHS
     in scripts/ci/merge-admission-policy.mjs, plus config/merge-admission-policy.json and the paths it
     adds; see CONTRIBUTING.md, "Protected paths and Owner grants") needs an Owner grant for the exact
     head commit. -->
Clued-Work-Claim: <claim_id>
Clued-Work-Scope: project:<canonical_project_id>
