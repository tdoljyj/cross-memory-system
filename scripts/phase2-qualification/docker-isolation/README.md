# Fixed Docker isolation probe — code preparation only

**NOT EXECUTED / NOT QUALIFIED.** No actual local image is fixed yet; `example.json` intentionally has null image/run key. This directory changes no previous frozen controller, Skill or probe. It does not start Docker/WSL, install anything, pull an image, load a Skill or issue a GA.

`probe.py` is a fixed Linux Python program intended for a later independently verified local Python image. It requires uid 10001, zero effective/permitted capabilities, no-new-privileges and only a loopback network interface before its synthetic operations. It writes one allowed fixture, observes denied rootfs write and denied read of its own mode-zero synthetic canary, uses a successful loopback TCP control, and checks a TEST-NET connection for an actual OS denial. Timeout/refused connection do not count as network isolation. It starts only its own fixed Python descendant, which resists SIGTERM so that later whole-container STOP can be observed. The host credential canary must be set explicitly by that future test coordinator; its absence in a child alone is not non-inheritance proof.

`prepare.py` produces a reviewable fixed argument vector and persists/read-backs a local preparation Intent. The plan uses an exact `docker.io/library/python@sha256:...` input, pull=never, linux/amd64, non-root, read-only rootfs, network none, cap-drop ALL, no-new-privileges, 0.5 CPU, 128 MiB RAM with equal swap limit, 16 PIDs, 16 MiB restricted tmpfs, bounded Docker logs, no restart, one fixed driver read-only bind mount and one dedicated synthetic writable directory. It forwards no host environment or credentials and accepts no command/mount/resource override. No Docker API socket is mounted. Image-provided environment must also be independently inspected before later execution; a digest-shaped string is not proof of an available trusted image.

Both `run` and `formal` entries always return BLOCKED. The preparer contains no subprocess/network execution API. A pre-existing run directory, even with a truncated Intent, returns UNKNOWN without overwrite or redispatch. That is a local preparation safeguard, not formal UNKNOWN recovery or an accepted idempotency protocol.

The plan specifies the later operational order: real local image/host/budget verification → durable Intent → create with pull disabled → persist exact container ID → inspect actual security/mount configuration → start fixed driver → observe live descendant and assertions → persist STOP Intent → stop exact container → wait and inspect its exact ID, exited state and PID zero → preserve evidence. The `stopped` predicate encodes required future observation fields; no container has been stopped by this code preparation.

Independent review found and corrected two potential false positives. The descendant now installs its ignored SIGTERM handler before publishing its readiness record. The parent waits for complete valid JSON whose exact integer PID/PPID/uid and actual handler marker match; a missing, half-written or mismatched file cannot set `tree_active`. The STOP predicate now checks typed object/state fields, exact integer zero PID (not `False`), and a valid nonzero timezone-bearing RFC3339 finish time; empty/garbage/invalid/zero timestamps are rejected.

Run the limited preparation/denial tests from this directory:

```text
python -I -S test_preparation.py
```

These tests use clearly synthetic digest syntax only in memory and do not execute Docker or the Linux probe. They are not OS-isolation tests. Real network denial, filesystem enforcement, image runtime compatibility, environment non-inheritance and full-tree termination remain **UNOBSERVED**. No prepared argument vector is an accepted allowlist, actual resource reservation, remote durable sink, current revocation proof or GA. The existing Owner/Profile/accepted-subject requirements remain applicable before any later qualification execution.

The original nine successful preparation tests remain historical results bound to the original source hashes. After the two review fixes, only the five targeted pure-function/AST checks in `test_review_fixes.py` were run, and all five passed; the old nine-test suite and all Docker/WSL actions were not rerun. `PreparationEvidence.json` preserves both the old source/result bindings and the new exact source digests. Run `python -I -S test_review_fixes.py` only when those changed predicates need review.

Platform flag semantics are from Docker's [container create](https://docs.docker.com/reference/cli/docker/container/create/), [container run](https://docs.docker.com/reference/cli/docker/container/run/) and [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/) documentation. They describe expected configuration, not results on this host.
