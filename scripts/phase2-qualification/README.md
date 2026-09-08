# Local controller candidate

This is a small **unqualified engineering candidate**, not an accepted Profile,
GateAuthorization, qualified controller, Skill loader, or R11 executor. Existing
publication and trusted-reader entry points do not grant this runner qualification.
No new trust root, accepted control type, production binding or Canonical write is
introduced. The qualification source plan remains required evidence, not authority.

The controller reuses Python standard-library process and file operations. Its only
operations are `noop`, bounded `wait`, and `fixture_write` for one fixed synthetic
fixture. It cannot run arbitrary commands, modules, user payloads, models or network
requests. Unknown operations, parameters and formal execution modes fail closed.

## Interface

Run `python scripts/phase2-qualification/controller.py run --config CONFIG.json
--evidence-dir EXISTING_DIRECTORY`. The JSON configuration has exactly these fields:

`example.local.json` is a runnable synthetic configuration bound to the current
controller bytes. A source change requires a new digest and applicable checks;
the runner refuses the old configuration after drift.

```json
{
  "schema": "clued.controller-candidate.v1",
  "mode": "LOCAL_ENGINEERING_ONLY",
  "idempotency_key": "synthetic-probe-1",
  "operation": "fixture_write",
  "parameters": {"fixture_id": "synthetic-v1"},
  "timeout_seconds": 5,
  "expected_runner_sha256": "REPLACE_WITH_SHA256_OF_CONTROLLER_PY_BYTES",
  "expected_control_generation": 1
}
```

For `noop`, parameters must be `{}`. For `wait`, they must be `{"seconds": 1}`
(0–60 seconds). The controller deadline must be greater than 0 and at most 30
seconds. The caller supplies an existing disposable local evidence directory.
Paths containing symbolic links or Windows junctions are rejected. Run IDs cannot
contain separators, dots, absolute paths or alternate data stream syntax.

The runner creates `control.json` with exactly `generation` (positive integer) and
`revoked` (boolean), initially `1` and `false`. Creating `STOP`, setting `revoked`
true, or changing generation blocks a subsequent action and stops an active fixed
worker. These are local engineering controls; they do not verify remote revocation,
issuer authority, distributed fencing, resource leases or budget reservations.

Output is one JSON object. `COMPLETED` means only the fixed local probe completed;
`STOPPED` includes observed worker termination and exit code. `BLOCKED` denies a
precondition. `UNKNOWN` preserves an unresolved intent and prevents automatic retry.
Exit code is 0 for `COMPLETED`, otherwise 2. Every outcome has `qualified=false`,
`authorization_effect=NONE` and `formal_regressions_executed=false`.

## Evidence and recovery

Before launching a worker, an exclusive immutable `runs/KEY/intent.json` is flushed
and fsynced. It binds configuration, runner and Python executable hashes, runtime
version and the exact expected fixture hash. The fixed child uses Python `-I -S`,
no shell, closed stdin, and an explicit empty environment except the Windows
runtime locator `SYSTEMROOT`. Evidence records child environment **names**, never
credential values. The parent never transfers host tokens, proxies, HOME, PATH or
user payloads to the child. This is process-environment filtering, **not proof of
OS filesystem or network isolation**; the child still runs as the current OS user.

`result.json` is written once, after observing execution or termination. Repeating
the same key and exact parameters reads existing evidence; changed parameters are
denied. An intent without a result never triggers another action. Use the read-only
command `python scripts/phase2-qualification/controller.py reconcile --evidence-dir
DIRECTORY --idempotency-key KEY` to compare an existing fixed target with its intent.
Even a matching target leaves execution `UNKNOWN`; it issues no terminal receipt,
does not retry, and releases no capacity. Capture its stdout as an observation if
needed; the command does not overwrite the original history.

One exclusive `.controller.lock` serializes the evidence directory. A crash may
leave that lock. No expiry, PID guess or automatic cleanup removes it. An operator
must independently establish that the old controller and its child are stopped
before separately authorized lock recovery. File fsync is local persistence, not a
remote durability attestation. The local host is not a hostile-writer sandbox;
checks do not prevent privileged concurrent filesystem mutation or coordinated
evidence forgery. This evidence is not cryptographically issued qualification.

## Checks and remaining qualification inputs

`python tests/test_phase2_qualification_controller.py` checks real child environment
filtering, bounded stop/termination, fixed target persistence, denied operations,
idempotency, sink failure and unknown-result recovery. These checks are local
engineering evidence only, not the formal PQUAL-01–20 suite.

Still required before any actual Skill qualification: an existing authorized
issuer/actor and authority chain, accepted Profile and per-action authorization,
independently qualified controller assessment, proven OS isolation, real scoped
budget/stop/revocation/evidence-sink bindings, and exact subject/configuration
bindings. Caller-supplied booleans, this README or passing tests cannot supply them.
