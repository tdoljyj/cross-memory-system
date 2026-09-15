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
CLUED_CONTROL_DB_PASSWORD='<database password, verbatim>' \
  node drive-root10-runtime-clock-dispatch.mjs --check-connection

CLUED_CONTROL_DB_PASSWORD='<...>' \
  node drive-root10-runtime-clock-dispatch.mjs --template TEMPLATE.json --operation CREATE [--dry-run]
```

`--check-connection` is a read-only reachability probe: it appends nothing and changes nothing,
so the credential and the network route can be confirmed before anything touches the attempt.

Pass the password **verbatim** in `CLUED_CONTROL_DB_PASSWORD` — no quoting or escaping. A
generated Postgres password routinely contains characters a URL must percent-encode, and an
unencoded one truncates the connection string silently, producing a failure indistinguishable
from a wrong password. It also keeps the password out of the process argument list, where a
connection string is readable by anything that can run `ps`. Host, port, user and database
default to this project and are overridable with `CLUED_CONTROL_DB_HOST`, `CLUED_CONTROL_DB_PORT`,
`CLUED_CONTROL_DB_USER`, `CLUED_CONTROL_DB_DATABASE`, `CLUED_CONTROL_DB_SSLMODE`.
`CLUED_CONTROL_DATABASE_URL` is still honoured for a URL someone has already built.

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
| 3 | stop (out of band) | `RUNNING` → `STOP_SENT` → `STOPPED` |
| 4 | `GRR` | `STOPPED` → `DECISION_RESERVED` → `SIGNING` → committed receipt |

**One host window covers CREATE and START.** `bridge.py` compares the START material against the
dict persisted at CREATE and refuses any difference, so CREATE writes `.host-window.json`
(exclusive create) and START replays it byte for byte. This is the accepted limitation recorded
in the activation README: the 600 authorized seconds are anchored host-side at CREATE, while the
accounting clock the PASS rule uses is anchored at the container's observed `State.StartedAt`.
START must therefore run more than 36 seconds before `deadline_utc` — the host's 30-second stop
reserve plus its 6-second start budget — and the driver refuses earlier, naming that reason,
rather than letting it surface as an opaque host refusal.

**`STOP` is not an operation of this driver.** The entry has no dispatch handshake for it:
`prepareTrustedToolMaterial` returns a stop-authority object with no intent, no dispatch key and
no `finishDispatch`, and `invokeFixedHost` refuses `STOP` outright. The container is stopped by
the host's own watchdog at its deadline, and `STOP_SENT`/`STOPPED` are recorded out of band.

**Freshness is not the bottleneck here.** The controller requires the observation to be at most
15 seconds old. Measured on this host, the entry's whole preflight — manifest digest, python
bytes, all 34 declared files, the five dependency package trees, node's bytes — runs in about
450 ms, so the observation is consumed with seconds to spare.

## Cloud environment setup

A fresh clone cannot run the trusted entry: `apps/clued-cloud/node_modules` is gitignored, and
the entry verifies five package trees file by file against `RuntimeDependencyManifest.json`.
Without them it refuses with `RUNTIME_DEPENDENCY_PACKAGE_TREE_DRIFT:ajv` before anything runs —
confirmed by moving the directory aside and watching the entry refuse.

`environment-setup.sh` recreates them. Paste it into the environment's **Setup script** field.
`npm ci` is not an option here: `package.json` and `package-lock.json` are out of sync
(`gcp-metadata` and `google-logging-utils` are missing from the lock) and it refuses. Installing
`ajv@6.15.0` in an isolated directory works instead, because its dependencies are exactly the
other four pinned packages. Verified on 2026-09-15: the five resulting trees are byte-identical
to the originals and to what the manifest pins, and the entry passes on them.

Two more things the environment needs, neither of which belongs in a setup script:

* **Network access to the control store.** `db.uscrdifznmlvczcekqpw.supabase.co` must be
  reachable. Under the "Trusted" policy every Supabase host is refused at CONNECT, so the
  driver cannot read the observation at all.
* **`CLUED_CONTROL_DB_PASSWORD`.** The environment-variable field warns that its contents are
  visible to anyone using the environment, and a database password is a credential — so treat
  this as a deliberate, time-boxed exposure and reset the password in Supabase once the round is
  finished. Setting it to an alphanumeric-only value first also avoids `.env` parsing surprises:
  a `#` in a value starts a comment.

The pinned container image is a third prerequisite. Docker Hub's blob CDN
(`production.cloudfront.docker.com`) is refused under "Trusted", but `mirror.gcr.io` serves the
identical content-addressed digest and redirects blobs to itself, so
`{"registry-mirrors":["https://mirror.gcr.io"]}` in `/etc/docker/daemon.json` plus a `SIGHUP` to
dockerd is enough. That is left out of the setup script deliberately: it depends on dockerd
already running, and a setup script that fails blocks the session from starting at all.
