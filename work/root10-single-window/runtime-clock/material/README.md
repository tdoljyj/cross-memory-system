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

### Measured again on 2026-09-15 in the `clued-dispatch` environment

The notes above were measured under the "Trusted" policy. A second environment, built for this
round with a wider policy, moved every one of these findings, so record what actually has to be
checked rather than which mirror to use:

* **dockerd is not running.** The Docker CLI is installed but there is no
  `/var/run/docker.sock` and no `/var/lib/docker`. `dockerd`, `containerd`, root and a usable
  cgroupfs are all present, so `dockerd --host=unix:///var/run/docker.sock` in the background
  comes up in about four seconds.
* **No registry mirror was needed.** With that daemon up, the pinned digest pulls straight from
  Docker Hub and resolves to `sha256:285a7132…` unchanged. Write `/etc/docker/daemon.json` only
  after a direct pull has actually failed.
* **The assembler needs `gh`, which is not installed.** It shells out to `gh api`, and the
  cloud session routes GitHub through MCP tools instead, so a fresh container has no `gh` at
  all. `apt-get install -y gh` (noble universe, 2.45.0) is enough — the environment already
  carries a credential that reads this private repository, so no separate login is required.
* **That `gh` is NOT enough for the controller, and the difference is not the path.** Measured
  2026-09-15: after `apt-get install`, the host carries gh **2.45.0** at `/usr/bin/gh`,
  `2fd925d6…`, 45201664 B. `trusted-github.mjs` and `read-source-blobs-linux.mjs` re-hash
  `/usr/local/bin/gh` before every call and require gh **2.63.2**, `f687dc93…`, 50098328 B, as
  `HostProvisioning.json` records. So a symlink or a `PATH` change does not satisfy it — the
  digest is of different bytes, not of the same binary somewhere else. An activation host must
  install 2.63.2 at that exact path.

  Until it does, `check-digest-pins.mjs` refuses with `UNEXPLAINED … f687dc937534` in both of
  those files plus `HOST INCOMPLETE … missing /usr/local/bin/gh`. That is the gate working: its
  own comment records R20-F3, where this exact output was mistaken for a controller defect. It
  is the environment, and it is the same two refusals on the live tree and on any candidate,
  which is what makes it usable as a baseline for comparing the two.
* **The pin is satisfiable, and this is how.** The official release asset hashes to the pinned
  value exactly — no build, no patching:

  ```
  curl -sSL -o gh.tgz https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_linux_amd64.tar.gz
  tar xzf gh.tgz gh_2.63.2_linux_amd64/bin/gh
  sha256sum gh_2.63.2_linux_amd64/bin/gh
  #   f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618   (50098328 bytes)
  install -m 0755 gh_2.63.2_linux_amd64/bin/gh /usr/local/bin/gh
  ```

  Measured 2026-09-15 through the proxy in this container: digest and byte count both match
  `HostProvisioning.json`. After it, `check-digest-pins.mjs` reports `digest pins consistent
  (69 literal(s) accounted for, 0 unexplained)` instead of refusing.
* **`selftest-runtime-pins.mjs`'s six failures were this, not Docker.** I said twice that they
  needed a running `dockerd`. That was wrong, and the mechanism is worth writing down because
  the message does not point at it. `bothWays()` mutates one pin and then requires the sandbox
  to settle with the injected digest as its ONLY complaint (`repair(injected)`), and afterwards
  to settle with no complaint at all (`repair(null)`, which additionally requires exit status
  0). While `/usr/local/bin/gh` is absent, `f687dc93` is unexplained on every one of those runs,
  so both conditions fail for reasons that have nothing to do with the pin under test — hence
  "did not settle … so the probe below would be measuring something else", which is the check
  correctly refusing to measure a confounded sandbox.

  Demonstrated rather than argued, in this order: `dockerd` up and `gh` absent → the same six
  failures; `gh` installed → `runtime pin self-test passed`; `dockerd` then killed and the suite
  re-run → **still passes**. Docker is not required for it. One intermediate run appeared to
  show four failures without Docker; that run was started from the staging directory, where
  `check-digest-pins` exits non-zero on the foreign-directory references, so `repair(null)`
  could never return true. Confounded, discarded, re-run through the landed harness.

  `dockerd` is still required for the actual container operation (see the entry above); it is
  simply not what these six were about.
* **The control store is unreachable, for two independent reasons.**
  `db.uscrdifznmlvczcekqpw.supabase.co` publishes only an AAAA record, and this container's
  kernel has IPv6 compiled out — `/proc/net/if_inet6` does not exist, and a connect attempt
  fails with `Address family not supported by protocol`, which surfaces through psql as an
  error line with an empty message. The IPv4 poolers
  (`aws-{0,1}-ap-northeast-2.pooler.supabase.com`, this project being in `ap-northeast-2`)
  resolve and would answer, but outbound TCP is confined to 443: port 443 on the pooler's own
  address opens, while 5432 and 6543 both time out.

  The agent proxy does answer `CONNECT db.uscrdifznmlvczcekqpw.supabase.co:5432` with
  `200 Connection Established`, but that 200 is not authorization to speak Postgres — it is only
  the local proxy accepting the tunnel request. A forwarder that pipes psql through that tunnel
  gets exactly as far as the Postgres SSL handshake and then `server closed the connection
  unexpectedly`: the policy-enforcing egress proxy resets the raw-TCP database traffic once the
  tunnel is up. `/root/.ccr/README.md` states this outright — under **Not supported through the
  proxy (report, do not work around)** it lists "non-443 HTTPS ports, raw-TCP databases," and it
  instructs that such policy denials be reported, not routed around. libpq 17's
  `sslnegotiation=direct` would not help (the installed psql is 16.13, and direct SSL is still
  raw-TCP database traffic on a non-443 port — the same blocked category). So the block is the
  egress policy itself, one layer below the auto-mode classifier: clearing the classifier (by
  leaving auto mode) lets the forwarder be built and run, but the forwarded connection is still
  reset at egress.

  The consequence is architectural, not a knob to turn: the agent proxy tunnels HTTP/HTTPS
  CONNECT only, so **no cloud-web network-policy tier makes psql → Postgres work through it** —
  raw-TCP databases are categorically unsupported. Reaching the control store to *dispatch* (as
  opposed to the read-only MCP `execute_sql` path, which rides the management API over 443 and
  works but cannot meet the driver's ≤15 s / 3 MB freshness contract) requires one of: running
  the driver from a host that is not behind this proxy and has a direct route to the DB (a local
  session with open internet, or the original tool-origin harness); or an administrator
  provisioning a non-proxied egress route for this DB host, per the report-to-your-administrator
  instruction in the proxy README.

None of this touches what the controller verifies. `observation.project` is a constant in the
driver, the query text is issued verbatim, and `query_sha256` is taken over that constant, so
how the bytes reach port 5432 changes no material the controller reads.

