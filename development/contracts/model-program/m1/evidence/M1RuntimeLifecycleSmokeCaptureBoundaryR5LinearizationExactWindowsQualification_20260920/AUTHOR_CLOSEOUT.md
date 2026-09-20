# M1-08 Capture Boundary R5 — Author Closeout

Source Freeze: `96312735a2341c145e360f19a6f3a08ec222d64a`

Repair base / previous blocked review head: `0433d9e89080433d66f9c9a19b7f93669b6c0cd0`

Source manifest SHA-256: `149ce89eed53e279220ae8bb7577c3b93c3cd491bee674fcae4984a67772e666`

Scope: targeted MAJOR-08 capture persistence linearization remediation only. MAJOR-07 remains closed. Contract/Profile bytes were not changed.

Implementation: stdout/stderr share one process-level capture authority mutex. Capture writes hold that gate through the final expiry/deadline authority check and lower-level File.Write. Finalization revoke takes the same gate, making revoke a barrier before cleanup. After revoke returns, later pipe bytes are drained/discarded and cannot persist through the reviewed capture writer.

Exact Windows qualification on DESK-W-591 with Go 1.27.1 windows/amd64: A and B each passed 70 top-level + 24 subtests, 0 FAIL / 0 SKIP; Python qualification and go vet passed. Focused R5 passed 2 top-level + 2 subtests. Counts overlap and must not be summed across runs.

Owner binary: 7499264 bytes / SHA-256 `ec51918394d70a23c43e7350bd65991948dcc8cfd1c967ec32952bd6e0d4b160`.

Windows test binary: 12503040 bytes / SHA-256 `5c54ab63c82dc66a09744985de54fb6443f99f492bc5b395edca84fd5ba3eb9d`.

PRE/POST time-point observations show the real M1-08 Guard, Current, evidence directory and runtime root absent, no llama-server process, and loopback port 18088 not accepting connections. This is not continuous monitoring.

No Owner binary/model/lifecycle execution, private-key access, Owner-root selection, Guard Parent provisioning, Final Issuance, merge, M1-09 entry, training, distillation, promotion, activation, release or production deployment occurred.

Fresh-Context independent re-review remains required.
