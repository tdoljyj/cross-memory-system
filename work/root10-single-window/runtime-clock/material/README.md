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

## Dispatch driver

`drive-root10-runtime-clock-dispatch.mjs` is the trusted caller the controller expects. It
supplies a fresh observation, drives the entry's handshake, and commits — as separate
transactions — the intent, dispatch and result rows the controller asks for. It decides
nothing: every admission, window and byte check lives behind the trusted entry.

```
CLUED_CONTROL_DATABASE_URL=postgresql://... \
  node drive-root10-runtime-clock-dispatch.mjs --template TEMPLATE.json --operation CREATE [--dry-run]
```

`entry-root10-runtime-clock.sh` is the Linux trusted entry, byte-for-byte the command the
tool-origin entry runs inside its relay container: it checks the source manifest against the
digest the driver read from SQL (never against supplied material), then python3.11's bytes,
then the manifest shape, no `__pycache__` under the tree, every listed file's length and
sha256, the three host shell tools, the runtime dependency package trees, and node's bytes —
and only then execs `cli.mjs`.

SQL goes through `psql` rather than an MCP tool because the controller requires the observation
to be at most 15 seconds old, and `read_execution()` returns roughly 3 MB: no human-mediated
round trip fits in that window. The driver needs network reach to the control store and a
credential; nothing else in this directory does.

The steps, in order, each a separate invocation:

| # | Operation | Attempt phase in → out |
| --- | --- | --- |
| 1 | `CREATE` | `PENDING` → `INTENT_RECORDED` → `CREATE_SENT` → `CREATED` |
| 2 | `START` | `CREATED` → `INTENT_RECORDED` → `START_SENT` → `RUNNING` |
| 3 | stop | `RUNNING` → `STOP_SENT` → `STOPPED` |
| 4 | `GRR` | `STOPPED` → `DECISION_RESERVED` → `SIGNING` → committed receipt |
