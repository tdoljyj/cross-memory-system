# Automatic component integration

Task 342c local implementation, narrowed by ComponentVersioning v0.4 (defect C):
the builder regenerates the mechanical outputs of a pull request's own change
and sets no version. Taking main into a queued pull request is a plain merge
with nothing to regenerate. This command is a candidate builder, not a
deployment or a replacement for Source acceptance.

From a clean disposable candidate, before generating the final tested commit:

```text
python scripts/ci/component-version-integration.py --root <candidate> --base <main-SHA> --expect-head <candidate-SHA> --write
```

Without `--write` it only prints the plan. Failure leaves the candidate dirty and
unqualified for inspection; use another disposable candidate rather than reset
or overwrite shared work. The command never commits or pushes. The existing
builder commits its outputs, authorizes the new exact head and runs the normal
required checks. Do not test one head and then edit its metadata after merging.

Initial integration must declare service coverage; the current `mcp.server` has
none and the tool now refuses that omission. Its explicit source is
`root: apps/clued-cloud`, `files: [worker/**/*, supabase/migrations/*.sql]`.
Include the new integration helper/policy scripts and their tests in appropriate
component coverage, and the static policy/helper in the accepted Source closure.
A version changes only when someone bumps it on purpose; nothing is computed per PR.

The existing held config/generated/version files were not edited in this patch.
Native migration and matching accepted CI source must be qualified through the
ordinary process. Old callers lacking mechanical proof retain original coverage
requirements; the feature does not silently waive checks while consumers lag.

Local evidence remains under `C:/w/generated-342c-native-evidence/` and
`C:/w/generated-342c-root-evidence/`; final handoff adds a precise validation
report and immutable patch hashes in the authorized Drive transfer directory.
