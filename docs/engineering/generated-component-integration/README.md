# Automatic component integration

Task 342c local implementation. This command is a candidate builder, not a
deployment or a replacement for Source acceptance. DESK owns the existing
`integrate.sh` integration point; activation is pending until it calls this tool.

After trial merge, from a clean disposable candidate, before generating the
final tested commit:

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
Do not hand-bump versions; let the integration command calculate them.

The existing held config/generated/version files were not edited in this patch.
Native migration and matching accepted CI source must be qualified through the
ordinary process. Old callers lacking mechanical proof retain original coverage
requirements; the feature does not silently waive checks while consumers lag.

Local evidence remains under `C:/w/generated-342c-native-evidence/` and
`C:/w/generated-342c-root-evidence/`; final handoff adds a precise validation
report and immutable patch hashes in the authorized Drive transfer directory.
