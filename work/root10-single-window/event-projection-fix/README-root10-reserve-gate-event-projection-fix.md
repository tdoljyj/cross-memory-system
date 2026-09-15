# Root10 reserve_gate stored-event projection correction

This local builder corrects three `reserve_gate` contract projections. Events 114 and
115 store `{operation,body:{binding_id,evidence}}`; the original function compared
those rows to the larger function-call envelope. The correction projects each fixed
call envelope to the exact stored operation/body object while retaining the exact
sequence, idempotency key, binding ID, and evidence bytes.

The same accepted Gate contract is kept without inventing a 52nd GA field: the GA
schema contains `gate_id` and `artifact_refs`, while `gate_definition_ref` belongs to
the result receipt. The corrected SQL therefore closes the unchanged binding Gate
version/digest against the exact, unique accepted Gate blob in `artifact_refs`.

The generated apply transaction is an expected-current CAS at Root sequence 10 and
execution sequence 117. It requires pending budget 117, no active or prior Root10 GA,
the exact old `reserve_gate` catalog digest, the actual normalized events 114/115,
and unchanged charged totals. It replaces only `reserve_gate` and verifies that its
owner, ACL, configuration, security-definer flag, volatility, kind, parallel flag,
and leakproof flag are unchanged.

The generated full rollback file repeats the correction inside each of the already
accepted fifteen negative-probe transactions. Every transaction runs its synthetic
valid control plus rejection cases and ends in `ROLLBACK`; it does not create a
formal GA.

```powershell
node work/new-window/activation/build-root10-reserve-gate-event-projection-fix.mjs LIVE_RESERVE_GATE_SOURCE NEGATIVE_OUTPUT_DIR C:\temporary\output
node work/new-window/activation/selftest-root10-reserve-gate-event-projection-fix.mjs LIVE_RESERVE_GATE_SOURCE NEGATIVE_OUTPUT_DIR
```

The builder and self-test are local-only. Database execution remains a separate,
explicitly reviewed step.
