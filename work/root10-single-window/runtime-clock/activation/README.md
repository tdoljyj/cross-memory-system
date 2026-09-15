# Root10 runtime clock amendment — activation kit (DRAFT, not executed)

Successor of the temporal continuation amendment (event 118). Activates
`Root10RuntimeClockAmendment.json` as execution event **119**
(`RUNTIME_CLOCK_AMENDMENT_ACTIVATED`, idempotency_key
`root10_runtime_clock_amendment_20260915`, expected_sequence 118) for root
`ctr_414bd3c724264a83894b0c55cf2ab878`, GA `ga_32daa5daf52c4deb8e893c25b08eff38`,
budget sequence 117. Event 118 stays in history, immutable, but supplies **no
deadline** once event 119 exists. Authority effect: NONE — no new GA, no new
budget, no refund, no counter change.

## Files

| File | What it is |
| --- | --- |
| `execution_transition.runtime-clock.sql` | `clued_control.execution_transition(jsonb)` successor. Recognizes event 119, supersedes the temporal deadline logic, adds the `PREDISPATCH_RESET` operation and the runtime-clock rules below. Contains placeholder tokens. |
| `effective_execution_binding.runtime-clock.sql` | `clued_control.effective_execution_binding()` successor. Adds `RUNTIME_CLOCK_AMENDMENT_ACTIVATED` to the recognized binding-forward operations, validated by the same exhaustive inline predicate style as the temporal event (which keeps its own clause verbatim, so history still validates). Contains placeholder tokens. |
| `commit_gate_result.runtime-clock.sql` | `clued_control.commit_gate_result(text,text,text)` successor. Under event 119 the temporal deadlines are superseded; commits refuse at the runtime-clock finalization instant, and PASS requires exactly one exact non-overrun STOPPED run (see below). Contains placeholder tokens. |
| `build-root10-runtime-clock-activation.mjs` | Fill script. Reads the three SQL drafts + `../Root10RuntimeClockAmendment.json`, computes `__AMEND_SHA256__` (sha256 of the amendment bytes) and `__AMEND_BLOB_SHA1__` (git blob sha1), takes the three new binding digests from a config JSON (first argument), substitutes every placeholder token, and emits the three executable artifacts below. It throws if any placeholder would remain unsubstituted. |
| `root10-runtime-clock-activation.apply-once.sql` (generated) | One transaction: lock/timeout preamble, function preimage digest guard, `$pre$` state preimage guard, the three `CREATE OR REPLACE FUNCTION`s, event 119 insert (body built with `jsonb_build_object`; `activated_at` = `clock_timestamp()`, binding sha256s computed in SQL), `execution_current.sequence` CAS 118→119, `$post$` postimage guard, commit. |
| `root10-runtime-clock-activation.full-rollback.sql` (generated) | One transaction that restores the three temporal function definitions verbatim (captured from the `*.temporal.sql` files) and deletes event 119 + resets sequence to 118 — guarded: only if no event > 119 exists and the gate_attempts row is unchanged (PENDING, sequence 0, no container, no decision, no receipt, not revoked). |
| `root10-runtime-clock-activation.readback.sql` (generated) | One line: event 119 row + current sequence + effective binding. |

Placeholder tokens in the three SQL drafts: `__AMEND_SHA256__`,
`__AMEND_BLOB_SHA1__`, `__NEW_CONTROLLER_SHA256__`,
`__NEW_QUALIFICATION_SHA256__`, `__NEW_ACCEPTANCE_SHA256__`. The three old
binding digests (`aca4db23…`, `e3ded3a8…`, `17a5d20b…`) are known and written
literally.

## Apply order

1. Publish the amendment file; obtain its git blob sha and the three new
   controller/qualification/acceptance digests.
2. `node build-root10-runtime-clock-activation.mjs config.json [outdir]` with
   `config.json` = `{"new_controller_sha256":"…","new_qualification_sha256":"…","new_runtime_acceptance_sha256":"…"}`
   (all three must differ from the old pins).
3. Review the generated `apply-once` artifact, then execute it — once — against
   the control store. The `$pre$` guard aborts unless: head sequence 10,
   generation `ctrgen_48100437d24e448ba01c542ebe1290da`, not revoked;
   `execution_current` sequence 118, active GA set, `charged_seconds` 11706,
   `charged_evidence_bytes` 2604247987, no pending budget; attempt PENDING,
   sequence 0, container null, no decision/receipt, not revoked, exact
   `ga_sha256`; budget event 117 intact (exact raw bytes hash); effective
   binding exactly equal to the old binding; the embedded amendment bytes hash
   to `__AMEND_SHA256__`; the live function definitions hash to the temporal
   catalog digests; and `clock_timestamp()` is at least 10 minutes before
   `2026-09-16T03:00:00Z`.
4. Run the `readback` artifact to verify.
5. Only if the activation must be undone and nothing was built on it, run the
   `full-rollback` artifact.

## Amended terms (enforced by the functions when event 119 exists)

1. **Preparation is not runtime.** `INTENT_RECORDED`, `CREATE_SENT`, `CREATED`,
   `START_SENT` and `PREDISPATCH_RESET` consume none of the 600 seconds; they
   are bounded only by `preparation_expires_at` (2026-09-16T03:00:00Z). The
   dispatch clock check compares against `preparation_expires_at`, not the old
   temporal effect deadline and not `expires_at`.
2. **The runtime clock starts at the observed container start.** The 600
   seconds begin at the container's own `started_utc` from the RUNNING
   evidence. The RUNNING body must carry `runtime_deadline` exactly equal to
   `started_utc + 600 seconds` (`exact_runtime_deadline_binding`), recorded
   immutably in the event. At most one RUNNING event may ever exist per GA
   (`one_runtime_interval_only`).
3. **Timeout stops the container; stop is never refused.** `STOP_SENT` and
   `STOPPED` are never refused on account of any clock (they are also exempt
   from the finalization gate). A stop after the deadline is admitted but the
   STOPPED body must disclose `overrun` exactly equal to
   `FinishedAt - StartedAt > 600 seconds` from the observation
   (`exact_overrun_disclosure_required`). Overrun is not forgiven: an attempt
   with an overrun STOPPED event cannot reserve a PASS decision
   (`overrun_run_cannot_pass`), and `commit_gate_result` commits a PASS only
   with exactly one STOPPED event whose bytes are exact (sha256 matches), whose
   `overrun` is `false`, and whose observed `FinishedAt - StartedAt` is at most
   600 seconds — with no comparison of any event time against a wall-clock
   effect deadline.
4. **Acceptance and archival are not runtime.** `DECISION_RESERVED`, `SIGNING`
   and the gate-result receipt consume none of the 600 seconds and are bounded
   only by `finalization_expires_at`; every operation except
   `UNKNOWN`/`REVOKE`/`RECONCILED_CONTAINER`/`STOP_SENT`/`STOPPED` is refused
   at or after that instant (`root10_runtime_clock_finalization_expired`), as
   is any receipt commit.
5. **Predispatch failure is repairable in place** via the new
   `PREDISPATCH_RESET` operation: requires event 119, a clock before
   `preparation_expires_at`, phase in PENDING/CREATE_SENT/CREATED/START_SENT,
   no RUNNING event for the GA, fewer than 3 prior resets, a `reason`
   (1–200 chars) and `automatic_retry: false`. If a container exists, exact
   evidence bytes must show it zero-effect (`State.Running` false,
   `State.StartedAt` at the zero instant `0001-01-01T00:00:00Z`, matching
   container id) and the reset clears `container_id`. The attempt returns to
   PENDING under the same GA and the same budget sequence 117. After a reset,
   committed intents and the one-intent-per-effect uniqueness only count events
   recorded after the latest reset. A reset never touches charged counters,
   decision, receipt or budgets.

## Preserved invariants

- **No double charge.** Seconds and evidence bytes were charged once at
  BUDGET_RESERVED (117). Nothing here changes a charged counter or creates a
  path that charges again; at most one RUNNING event exists per GA, so at most
  one runtime interval is ever chargeable.
- **Single active attempt.** `execution_current.active_ga_id` stays the single
  active slot under the same row locks and sequence CAS; a reset never releases
  it and never admits a concurrent attempt.
- **Runaway execution stopped.** `runtime_deadline` derives from the
  container's own start, the controller must stop by it, and an overrun run
  cannot pass.
- **No fake pass.** Every existing evidence requirement is unchanged: exact
  bytes, sha256 bindings, a real container observation, one complete effect
  chain. A reset can never produce a terminal result on its own.
- **No new authority.** No new GA, budget, trust root or generation; no
  capacity increase, refund, or automatic retry of an effectful attempt.
  Event 118 remains in history and must still validate exactly, but it no
  longer supplies any deadline once event 119 exists; if event 119 is absent
  the functions behave exactly as the temporal versions do today.

## Repair (2026-09-15, after activation)

An adversarial review of the activated functions found four defects. Three are
fixed here, in SQL only; the fourth is recorded below as an accepted limitation.

| # | Defect | Fix |
| --- | --- | --- |
| 1 | The stop report certified its own runtime. `rc_overrun` was computed from `State.StartedAt` and `State.FinishedAt` taken from the bytes the host supplied *at STOPPED*, so a host reporting a later start turned an overrun into a compliant run — and a PASS. | `execution_transition` now reads the single committed `RUNNING` event, requires the stop report's observed start to equal the start that event recorded, and measures against that event's `runtime_deadline` — both fixed before the outcome could be known. `commit_gate_result` stops re-deriving the duration and tests the same recorded deadline. |
| 2 | The STALE closeout for an attempt that never dispatched was unreachable. It required `clock_timestamp()>=rc_prep`, but preparation and finalization expire at the same instant and the finalization guard already refuses `DECISION_RESERVED` from that instant on — so the branch was dead in both directions. | The time precondition is dropped. "Nothing was ever dispatched" (phase PENDING, no container, no `RUNNING`/`CREATED` event) is the judge, still bounded by the finalization window. |
| 3 | `rc_event.sequence=119` is NULL when no runtime-clock event exists, and a NULL inside `if not (...) then raise` does not raise — so the `DECISION_RESERVED` phase guard failed **open**. | Both amendments now bind to explicit booleans (`rc_active`, `temporal_active`) set only after their byte checks pass; every amendment predicate in the function is two-valued. |
| 4 | The 600 authorized seconds are anchored at CREATE preparation, and `bridge.py`/`fixed_host.py` require START to reuse that identical window, so container preparation is charged against the container's own life. | **Not fixed.** The fix is in controller bytes, and event 119 pins `controller_sha256`, so changing them would make the activation event fail its own validation — it would cost a second full amendment cycle. It cannot change a verdict: the container's program prints its result at startup and then sleeps, the accounting clock the PASS rule uses is anchored to the observed `State.StartedAt`, and an early host deadline only shortens that sleep. |

`build-root10-runtime-clock-repair.mjs` emits the repair as a transaction that
replaces the function bodies and proves the whole control state came through
byte-identical; event 119 is never rewritten and no event is appended.
`build-root10-runtime-clock-repair-delta.py` emits the same transaction with the
two changed functions expressed as in-database edits over their own installed
text, digest-asserted against the artifact above — same effect, a third of the
bytes, and a mistyped fragment aborts rather than installing unreviewed text.
