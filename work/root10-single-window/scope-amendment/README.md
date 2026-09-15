# Root10 scope amendment — activation kit (DRAFT, not executed)

**Nothing in this kit has been run.** No SQL here has touched the control store,
no material here has been published or signed, and the generated artifacts carry
a `-- DRAFT -- NOT EXECUTABLE` banner because one of their inputs is not final
yet (see [Apply order](#apply-order)). The live control store is still at
execution sequence **119**.

Successor of the runtime clock amendment (event 119). Activates
`Root10ScopeAmendment.json` as execution event **120**
(`SCOPE_AMENDMENT_ACTIVATED`, idempotency_key `root10_scope_amendment_20260915`,
expected_sequence 119) for root `ctr_414bd3c724264a83894b0c55cf2ab878`, GA
`ga_32daa5daf52c4deb8e893c25b08eff38`, budget sequence 117. Authority effect:
NONE — no new GA, no new budget, no refund, no counter change, no new trust root
or generation.

## What this amendment is

The gate suite pins 19 formal tests. Exactly 5 of them — PQUAL-11, 13, 15, 16,
17 — have real recorded component observations; the other 14 have no observation
of any kind. `checkRoot10ResultEvidenceStructure` requires a PASS to cover all 19
with an actual observation and an independent oracle assessment per test, so
today no terminal result other than BLOCKED-with-an-empty-set is reachable. The
gap cannot be closed by writing documents: each test's oracle says matching
fixture strings or source text is not behavioral evidence.

Event 120 therefore **narrows what is claimed** and **does not relax what
evidence means**. For generation `ctrgen_48100437d24e448ba01c542ebe1290da` the
applicable formal test set becomes those 5; the other 14 are
`NOT_COVERED_BY_THIS_GENERATION` — neither passed nor failed, and no receipt
under this amendment may assert any result for them. Every event-119
runtime-clock term carries forward verbatim (preparation is not runtime, the 600
seconds start at the container's observed start, stop is never refused, overrun
cannot pass, predispatch failure is repairable in place); the event body pins
`carries_forward_sequence: 119` and the functions refuse a scope event whose
window, budget, GA and binding do not match event 119 exactly.

The narrowed set is not chosen to fit a desired outcome: the accepted runtime
already carries `historical_component_evidence` for exactly those five test ids,
and both builders assert that correspondence
(`APPLICABLE_SET_MUST_MATCH_HISTORICAL_EVIDENCE`) rather than assuming it.

## Files

| File | What it is |
| --- | --- |
| `Root10ScopeAmendment.json` | The Owner amendment. sha256 `1793ec8f59b657b16c5003df2abb03960efc5d3fcfafce9968a880196a2045d8`, git blob `ce941d4cad45d3a7e2b91b46117d109c35934db4`. Its bytes are embedded in the apply-once artifact and re-hashed by the `$pre$` guard. |
| `execution_transition.scope.sql` | `clued_control.execution_transition(jsonb)` successor. Recognizes event 120 and, when it is active, restricts `DECISION_RESERVED` to the applicable set: every `test_results` and `evidence_index.tests` entry must be an in-scope id, ids must be unique, the two sets must agree exactly, and a PASS reservation must be exactly the 5 ids all PASS. Contains placeholder tokens. |
| `effective_execution_binding.scope.sql` | `clued_control.effective_execution_binding()` successor. Adds `SCOPE_AMENDMENT_ACTIVATED` to the recognized binding-forward operations behind the same exhaustive inline predicate, including an `exists` clause that binds event 120 to event 119 by the event-119 amendment sha256 and by carried-forward window/budget/GA/binding equality. Earlier operations keep their clauses verbatim, so history still validates. Contains placeholder tokens. |
| `commit_gate_result.scope.sql` | `clued_control.commit_gate_result(text,text,text)` successor. Under event 120 the receipt's `test_results` must equal the reserved set exactly, may name only in-scope ids, and a committed PASS must be exactly the 5 ids all PASS. The event-119 runtime-clock commit rules (one exact non-overrun STOPPED run, finalization refusal) are unchanged. Contains placeholder tokens. |
| `build-scope-amendment-materials.mjs` | Builds the two stage-2 documents from the prior (event-119) documents plus the candidate controller manifest and the new suite. Publishes nothing, signs nothing, issues nothing. Leaves the two publication-dependent fields as tokens. |
| `ControllerQualification.root10.scope.json` | Stage-2 qualification for the new controller. `controller_digest` `edf397c6b46221c27ed45e64eeb04c1107c8e092ec7abf84c1f1bcdeb0e3bf99`, `qualification_issued: false`, `signature_verified: false`. **Still carries `__OWNER_MERGE_COMMIT__` and `__SOURCE_TREE__`.** |
| `RuntimeAcceptance.root10.scope.json` | Stage-2 runtime acceptance repointed at the new 5-test suite (`gate_suite_ref` sha256 `118cde8774c91adbdff439a8d6b6216d2a353ec983b24c49d3ce16d6c487433a`). `acceptance_issued: false`. No unresolved tokens. |
| `build-root10-scope-amendment-activation.mjs` | Fill script. Reads the three SQL drafts, `Root10ScopeAmendment.json` and the two `.scope.json` materials; computes every digest from the bytes on disk; substitutes every placeholder token; emits the three artifacts below. Throws if any placeholder would survive, and refuses if any new pin equals the pin it replaces. |
| `root10-scope-amendment-activation-output/root10-scope-amendment-activation.apply-once.sql` (generated) | One transaction: lock/timeout preamble, function-preimage digest guard, `$pre$` state-preimage guard, the three `CREATE OR REPLACE FUNCTION`s, the event 120 insert (body built with `jsonb_build_object`; `activated_at` = `clock_timestamp()`, binding sha256s computed in SQL), `execution_current.sequence` CAS 119→120, `$post$` postimage guard, commit. |
| `root10-scope-amendment-activation-output/root10-scope-amendment-activation.full-rollback.sql` (generated) | One transaction that restores the three event-119 function bodies verbatim and deletes event 120 + resets the sequence to 119 — guarded. |
| `root10-scope-amendment-activation-output/root10-scope-amendment-activation.readback.sql` (generated) | One statement: event 120 row, event 119 row, current sequence, effective binding, the three installed function digests. |

Placeholder tokens in the three SQL drafts: `__SCOPE_AMEND_SHA256__`,
`__SCOPE_AMEND_BLOB_SHA1__`, `__NEW_CONTROLLER_SHA256__`,
`__NEW_QUALIFICATION_SHA256__`, `__NEW_ACCEPTANCE_SHA256__`. The three live
event-119 pins (`5c72dd89…`, `6a7145fa…`, `32122181…`) are known and written
literally, as is the event-119 amendment sha256 `e92a252a…`.

## Apply order

Steps 1–4 are Owner-merge work that must land **before** the activation artifact
can be built for real. Until step 3 completes, the qualification's sha256 is a
draft value and the whole event-120 body depends on it.

1. **Publish the candidate controller tree.**
   `scripts/phase2-qualification/control-context-verifier-root10-scope-amendment/`
   — 34 manifest entries; `ControllerSourceManifest.candidate.json` sha256
   `edf397c6b46221c27ed45e64eeb04c1107c8e092ec7abf84c1f1bcdeb0e3bf99` becomes the
   new `controller_sha256`. Do not touch
   `scripts/phase2-qualification/control-context-verifier-root10-single-window/`;
   that tree is the live, pinned event-119 controller.
2. **Publish the new 5-test suite.**
   `scripts/phase2-qualification/RuntimeMaterialPreparation/scope-amendment-successor/preentry-skill-qualification.scope.json`
   — sha256 `118cde8774c91adbdff439a8d6b6216d2a353ec983b24c49d3ce16d6c487433a`,
   exactly PQUAL-11, 13, 15, 16, 17. It becomes the acceptance's `gate_suite_ref`.
3. **Fill the two publication-dependent fields and re-emit the stage-2
   documents.** The Owner merge that lands steps 1, 2 and the amendment produces
   a commit sha and a tree sha. `build-scope-amendment-materials.mjs` currently
   writes `__OWNER_MERGE_COMMIT__` and `__SOURCE_TREE__` literally and reports
   them in `unresolved_placeholders`; it must be given the real values and re-run
   with `--write`. **This changes `ControllerQualification.root10.scope.json`'s
   bytes, so its sha256 — the new `qualification_sha256` pin — changes too.** Any
   activation artifact built before this step is stale by construction, which is
   why the current one is stamped DRAFT.
4. **Publish the two stage-2 documents** so that the digests event 120 pins are
   resolvable blobs, exactly as the event-119 documents are.
5. **Build the activation artifacts.**
   `node build-root10-scope-amendment-activation.mjs [outdir]`. There is no config
   file: every digest is recomputed from the bytes on disk. The builder refuses
   outright while the qualification still carries unresolved tokens; `--draft`
   overrides that and stamps the emitted SQL as non-executable. It also refuses
   if the amendment's test-id lists differ from the set the kit writes, if a new
   pin equals the pin it replaces, if a token is missing from a draft, if any
   token survives into an artifact, if the three functions are not all replaced,
   or if the event-119 bodies on disk are not the ones the committed runtime-clock
   repair proved installed.
6. **Review the generated `apply-once` artifact, then execute it — once.**
7. **Run the `readback` artifact** to verify.
8. Only if the activation must be undone and nothing was built on it, run the
   `full-rollback` artifact.

## What the guards assert

### Function preimage (temp table `_root10_scope_fn`)

The three installed catalog definitions must hash to the live post-repair
event-119 digests — `effective_execution_binding`
`635c067dadb5c59f3d6de79c65bf537909fc31fe9f0c04ca680f7a606af4fb54`,
`execution_transition`
`b75f7aae6a15b27299d6f73e8ec2406daf0f2d94387aec302b7ac777fbe465e4`,
`commit_gate_result`
`22701cb22ce1c520e0761b0a1f04de0f7c9833636b291c1dd44d13f467858a40` — or
`ROOT10_SCOPE_FUNCTION_PREIMAGE_DRIFT`. The same temp table also captures owner,
ACL, config, security/volatility/kind/parallel/leakproof flags for the postimage
comparison. The builder derives these three digests from the runtime-clock
sources in this tree and then cross-checks them against the digests the committed
runtime-clock repair transaction proves installed; if this working tree is not
the live text, the build fails rather than the apply.

### `$pre$` state preimage

Aborts unless **all** of the following hold, under `for share` on the head and
`for update` on `execution_current` and `gate_attempts`:

- head sequence 10, generation `ctrgen_48100437d24e448ba01c542ebe1290da`, not revoked;
- `execution_current`: sequence **119**, `active_ga_id` `ga_32daa5daf52c4deb8e893c25b08eff38`, `pending_budget_sequence` null, `charged_seconds` **11706**, `charged_evidence_bytes` **2604247987**;
- `gate_attempts`: phase **PENDING**, sequence 0, `container_id` null, no decision, no receipt, not revoked, `ga_sha256` `68afb1e6…`, `budget_sequence` 117, GA generation `ctrgen_48100437…`;
- **no execution event above 119 exists**;
- event 119 is the runtime clock activation: idempotency_key `root10_runtime_clock_amendment_20260915`, operation `RUNTIME_CLOCK_AMENDMENT_ACTIVATED`, same GA, amendment sha256 `e92a252a…`, and its `new_binding`, window, runtime seconds, reset cap, budget raw sha256, budget sequence and prior GA sha256 are exactly what event 120 will carry forward (`ROOT10_SCOPE_RUNTIME_CLOCK_PREDECESSOR_DRIFT`);
- budget event 117 is intact: operation `BUDGET_RESERVED` and its raw bytes hash to `669d9605…`;
- the effective binding is exactly the event-119 binding — all eleven keys, value for value, including `controller_sha256` `5c72dd89…`, `qualification_sha256` `6a7145fa…`, `runtime_acceptance_sha256` `32122181…`;
- the amendment bytes embedded in the artifact hash to `1793ec8f…` **and** declare `object_type` `Root10ScopeAmendment`, this root, this generation, `carries_forward.object_type` `Root10RuntimeClockAmendment`, `carries_forward.activation_sequence` 119, `authority_effect` `NONE`, and the two test-id lists the event is about to write (`ROOT10_SCOPE_OWNER_AMENDMENT_BYTES_REQUIRED`);
- `clock_timestamp()` is at least 10 minutes before `2026-09-16T03:00:00Z`.

The insert block re-reads the binding under the same lock, rejects it unless it
is still the event-119 binding, derives the new binding by overlay, and requires
that **exactly three** keys differ — so a scope activation can never move a gate,
scope, profile or counter field.

### `$post$` postimage

Aborts (`ROOT10_SCOPE_POSTIMAGE_DRIFT`) unless, inside the same transaction:
sequence is 120; the GA, pending budget and both charged counters are unchanged;
the attempt is still PENDING at sequence 0 with no container, decision or
receipt, not revoked, same `ga_sha256` and budget sequence; event 119 is
untouched; event 120 satisfies the **same** exhaustive predicate the three
functions enforce (the builder asserts the predicate string it writes into the
guard is byte-identical to the one in all three function bodies); event 120's
`old_binding` equals event 119's `new_binding`; the effective binding is exactly
the new binding; no event above 120 exists; the three functions' owner, ACL,
config and flags are unchanged; and the three installed definitions hash to
`1606fa5d…`, `0968ff8b…`, `57b3e335…`.

## Rollback

`root10-scope-amendment-activation.full-rollback.sql` is one transaction. Its
`$guard$` refuses (`ROOT10_SCOPE_ROLLBACK_GUARD_FAILED`) unless sequence is 120
with the same GA, no pending budget and both charged counters unchanged; the
attempt is still untouched (PENDING, sequence 0, no container, no decision, no
receipt, not revoked, same `ga_sha256` and budget sequence); event 120 is this
activation; event 119 is still the runtime clock activation with amendment sha256
`e92a252a…`; and **no event above 120 exists**. It then restores the three
event-119 function bodies verbatim, deletes event 120, CASes the sequence 120→119,
and finally re-asserts that the effective binding is the event-119 binding again
and that the three installed definitions hash back to `635c067d…`, `b75f7aae…`,
`22701cb2…` (`ROOT10_SCOPE_ROLLBACK_POSTIMAGE_DRIFT`).

Rollback is only available while nothing has been built on event 120. Once an
attempt has dispatched under the narrowed scope, the event is history and must be
superseded rather than deleted.

## Preserved invariants

- **No fake pass.** Evidence requirements for every test still in scope are
  unchanged: exact bytes, sha256 bindings, at least one real
  `ACTUAL_TEST_OBSERVATION` and one `INDEPENDENT_TEST_ORACLE_ASSESSMENT` per test,
  a real container observation, one complete effect chain. The amendment narrows
  scope; it does not lower the bar inside that scope.
- **Independent assessment still required.** The assessor remains
  `/root/root9_recovery_review`, and `DISTINCT_REVIEWER_REFERENCE` still requires
  that the assessor is not the executor.
- **No double charge.** Seconds and evidence bytes were charged once at
  `BUDGET_RESERVED` (117). Nothing here changes a charged counter.
- **Single active attempt.** `execution_current.active_ga_id` stays the single
  active slot under the same row locks and sequence CAS.
- **Runaway execution stopped.** `runtime_deadline` still derives from the
  container's own observed start, the controller must still stop by it, and an
  overrun run still cannot pass.
- **No new authority.** No new GA, budget, trust root or generation; no capacity
  increase, refund, or automatic retry. A PASS under this amendment attests only
  that the container isolation primitive ran to a real non-overrun stop and that
  the 5 applicable tests were assessed PASS on real observations by the
  independent reviewer. It attests nothing about the 14 out-of-scope tests and
  confers no ACTIVE/Entry/SliceA implementation authority.
- **Event 119 is not rewritten.** If event 120 is absent the functions behave
  exactly as the event-119 versions do today.
