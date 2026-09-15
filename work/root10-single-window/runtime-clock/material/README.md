# Root10 runtime-clock material assembler

Read-only. It verifies Owner merges and published bytes over the GitHub API and emits the
static half of the runner material. It does not sign a GA, write the control store, start a
container, or assert PASS.

```
node build-root10-runtime-clock-material.mjs config.runtime-clock.json --emit-json --out TEMPLATE.json
```

Without `--out` the material goes to stdout and the resolution report to stderr.

## Why this is a rewrite, not an edit

`../../stage2/runner-material/build-root10-runner-material.mjs` is hard-coded to the first
round's topology. It asserts that the reviewer delegation and the executor applicability were
published in the *same* Owner merge (`p1`), and it compares `expected_ga.controller_digest` to
the accepted runtime's own controller digest. Under the runtime-clock amendment neither holds:

| Artifact | Owner merge |
| --- | --- |
| Gate definition, Profile signing payload, 6 prerequisites, gate suite, execution scope | #192 `593bc7d2` |
| Result reviewer delegation | #190 `1443bbe0` |
| Runtime-clock amendment, executor applicability, controller source tree | #197 `c8be72a` |
| Runtime acceptance, controller qualification | #198 `1b6d3043` |
| Status29 signing payload | #193 `67e55ee7` |

and `expected_ga` still describes the **original** signed GA, so its controller digest
(`d01bd55e…`) is neither this round's (`5c72dd89…`) nor the predecessor round's (`aca4db23…`).
The assembler therefore takes a *set* of publications, proves each one is a verified web-flow
merge the Owner merged into main with a complete tree, and resolves every reference against
whichever of them actually carries its bytes — reporting the mapping it found rather than
assuming one. It also re-proves, for every blob in the acceptance's `source_ref`, that the same
blob is present in the acceptance's own Owner merge, which is the pairing the controller's
`verifySourcePublication` re-checks at dispatch.

## What it deliberately does not produce

The controller requires the control-store observation to be at most 15 seconds old, so the live
half cannot be baked into a template. The dispatch driver fills these from
`clued_control.read_execution()` at dispatch time:

| Field | Source |
| --- | --- |
| `operation` | `CREATE` / `START` / `STOP` / `GRR` |
| `ga_raw` | the attempt row's `ga_raw` — the signed GA is a control object, not a repository artifact |
| `observation` | `{project, query_sha256, row}` for the exact fixed query |
| `runtime_clock.event` | execution event 119, the activation the controller re-derives |
| `runtime_clock.host_window` | `{prepared_utc, deadline_utc}`, `deadline = prepared + 600s`, stamped per dispatch |
| `status_manifest.raw` | the stored StatusManifest from `control_objects` — Status29 is a live control object, not another Git payload authority |
| `status_manifest.store_ref` | the GA's `status_manifest_ref` |
| `status_manifest.source_binding_sha256` | the original runtime acceptance digest Status29 was signed against |
