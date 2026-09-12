# Clued Phase 2 — fixed non-production continuation authorization (2026-09-12)

State: **PENDING OWNER VERIFIED MERGE**. This file has no authority effect by itself.

This proposal supersedes nothing. It is the second continuation authorization of this run; the
first is `../next-window-20260911/OwnerApprovalProposal.md`, merged as
`4498102661f626c8e0c489c7d27551acbc8436ea`, whose 24-hour window expires `2026-09-12T13:14:51Z`.

**Read this section first.** This proposal asks for one thing the previous one did not: permission
to change three `SECURITY DEFINER` functions in the control plane. That is a heavier act than a
window continuation, and the reasons it is being asked for include a mistake by the implementing
side. Both are set out in "What is new, and why" below. Nothing here should be merged on the
assumption that it is a routine renewal.

## Approval action

The Owner approval action is the Owner (`tdoljyj`) merging the pull request that contains this
exact file through GitHub's normal web merge path.

The approval is valid only if the resulting merge is independently read back from GitHub and
confirms all of the following:

- `merged_by.login == "tdoljyj"`;
- merge committer is GitHub `web-flow`;
- GitHub commit verification reports `verified == true` and `reason == "valid"`;
- the exact blob bytes of this proposal and the accompanying approval record are present in that
  verified merge tree.

If any of these checks fail or are unknown, this proposal has **no authority effect**.

## Fixed window rule

Unchanged from the previous authorization. To avoid consuming the authorization window before the
Owner actually approves it:

- `not_before` = the verified Owner merge commit's authoritative GitHub `committed_at` timestamp;
- `expires_at` = exactly 24 hours after `not_before`;
- once the Owner merge exists, these two timestamps become exact immutable values for this window;
- the window does not roll, auto-renew, backdate, or extend on later reads or execution attempts.

A later canonical registration subject must materialize these two exact timestamps from the
verified merge readback before any NW-01 database transaction is prepared.

**This 86400-second duration is not negotiable within this proposal and is not being widened.**
The implementing side asked whether a longer window could be authorized; it cannot, and the
consequences of that are recorded below.

## Exact scope

- Repository: `tdoljyj/cross-memory-system`
- Supabase project: `uscrdifznmlvczcekqpw`
- Control schema: `clued_control`
- Existing root set: `ctr_414bd3c724264a83894b0c55cf2ab878`
- Purpose: `SKILL_COEXISTENCE_QUALIFICATION`
- Environment: `ISOLATED_TEST`
- Existing issuer / Owner identity: `tdoljyj`
- Existing audience: `urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw`
- No production authority.
- No paid-model authority.
- No new trust root or second root set.
- No new signing identity.
- No scope expansion.
- No refund, reset, deletion, force-update, or automatic retry.
- No new budget capacity is granted by this approval. Existing charges, existing capacity and
  existing allocation limits remain unchanged.

## What is new, and why

The previous authorization covered `accepted_binding` maintenance only. This one additionally
covers a control-plane function change and a generation registration. Each is stated here with the
reason it became necessary, including where that reason is an error by the implementing side.

### 1. Why the run cannot continue on the existing controller

The registered root5 generation event (`clued_control.events` sequence 5) declares
`expires_at = 2026-09-11T10:21:05Z`. The controller runs `currentWindow(body.not_before,
body.expires_at, now)` over that event body. Since `2026-09-11T10:21:05Z` that check fails, and
the events table is append-only, so the event cannot be amended. **Any controller declaring
generation root5 now fails closed, regardless of its own window constants.** Continuing requires
registering a new generation (root6).

### 2. Why the already-built root6 controller cannot be used as-is

The root6 controller was built with `root6Expiry = '2026-09-19T00:00:00Z'`, and its
`expiryForBudget(sequence >= 89)` requires a new budget to declare exactly that value.
`reserve_execution_budget` additionally requires a new budget's `expires_at` to be no later than
`accepted_binding.expires_at`.

Under the fixed window rule above, `accepted_binding.expires_at` can never be more than 24 hours
after an Owner merge. **`2026-09-19T00:00:00Z` is therefore not a value this mechanism can ever
produce.** That constant was chosen by the implementing side while building root6, and the
qualification and runtime acceptance documents were signed around it. It was not satisfiable from
the moment it was written. This is recorded as an error of the implementing side, not as a
constraint discovered late.

The consequence is that the controller must be rebuilt with `root6Expiry` set to the end of the
window this proposal creates. That rebuild changes the controller digest and the window constant,
and **seven signed documents pin one or both of them**:

| Document | Pins |
| --- | --- |
| `ControllerSourceManifest.candidate.json` | is the controller digest |
| `ScopedRoot5FinalControllerQualification.json` (`f5b18b54…`) | controller digest |
| `ExactRoot5FinalPreentryControllerRuntimeAcceptance.json` (`3f3c9cf3…`) | controller digest |
| `Root6OriginalInput4000000CapacityProposal20260912.json` | window, controller digest, generation |
| `Root6OriginalInput4000000CapacityApproval20260912.v2.json` | window |
| `Root6CurrentController4000000CapacityApplicability20260912.json` | window, controller digest ×3 |
| `Root6Current043CapacityRepairAcceptance20260912.json` | controller digest ×2, generation |

All seven must be re-issued and re-signed, and carried by the second Owner merge in "Execution
sequencing". The status manifest schema is **not** affected: it pins the root6 generation only, and
the generation does not change, so its digest
`510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef` stands.

The implementing side initially told the Owner this rebuild would touch three documents, on the
reasoning that the four capacity documents pin `capacity_delta` rather than the window. That was
wrong — all four pin the window or the controller digest — and it is corrected here before merge
rather than discovered afterwards. It is the seventh time in this run that an estimate by the
implementing side came in smaller than the verified scope.

### 3. Why three control-plane functions must change

`reserve_gate`, `reserve_execution_budget` and `append_status_manifest` each hard-code the root5
generation id, and the first two hard-code the current window literal and a forward cap. They are
`SECURITY DEFINER` functions and are not in this repository.

A related fact belongs in this proposal because it bears on how much care the change deserves.
`ActualNineteenthForwardReceipt.json` records that `reserve_gate` and `reserve_execution_budget`
were rewritten outside this repository on 2026-09-11, as part of the previous window migration,
with — in the receipt's own words — no corresponding pull request and no published evidence in
this repository. **That migration also missed `append_status_manifest`, which still pins the
superseded window, and that omission is why Status24 has been unappendable since
`2026-09-11T10:21:05Z`.** The change requested here must not be performed that way. Its boundary
is set out under "Control plane maintenance boundary" below.

## accepted_binding maintenance boundary

Reuse the already established and independently reviewed `NW-01` same-root maintenance mechanism,
unchanged from the previous authorization. It may operate only after a new canonical continuation
subject, its registration/store acceptances, and verified Owner signature evidence have been
produced and independently checked.

For the single existing row in `clued_control.accepted_binding`, only these seven fields may
change:

1. `not_before`
2. `expires_at`
3. `owner_approval_commit`
4. `subject_sha256`
5. `registration_acceptance_sha256`
6. `store_acceptance_sha256`
7. `signature_evidence_sha256`

Only the three exact binding CHECK constraints that pin window expiry, Owner approval commit, and
subject SHA may be replaced with the new exact values.

`accepted_binding_immutable` may be temporarily disabled only for this table / this row / this
exact guarded transaction and must be restored to its original enabled definition in the same
transaction. Any mismatch or unknown state aborts and rolls back the whole transaction.

All prior Root, Status, GateAuthorization, GateResult, execution events, receipts, charges,
sequence history, constraints, ACLs and unrelated rows must remain unchanged.

## Control plane maintenance boundary (`CP-01`, new in this authorization)

Exactly three functions may be replaced, by `CREATE OR REPLACE` only:

- `clued_control.reserve_gate(text,text)`
- `clued_control.reserve_execution_budget(text,text)`
- `clued_control.append_status_manifest(text,text)`

`clued_control.effective_execution_binding()` is **excluded** from direct replacement. It may
change only through the established append-only binding forward transaction, which records an
`EXECUTION_BINDING_FORWARD_ACCEPTED` event and produces a receipt. Rewriting it directly is
prohibited by this approval.

The permitted edits are limited to these classes, and to no others:

1. Replacing the root5 generation id with the root6 generation id where it denotes the **live**
   root generation.
2. Bounding the existing open-ended `sequence >= 64` historical segments to `>= 64 and < 89`, and
   adding a `>= 89` segment naming the root6 generation and this window's expiry. Existing
   `>= 59 and < 64` and `< 59` segments must remain byte-identical.
3. Replacing the superseded window literals with this window's exact materialized timestamps.
4. Replacing the status manifest schema digest with the digest of the schema this run's controller
   actually carries, and adding it to the existing allow-list.
5. Raising the binding-forward cap from `series_f > 15` to `series_f > 16`. See the separate
   statement below.

Required form of the change, following the convention already used by
`ActualNineteenthForward.sql` and `binding-evidence-successor/alter.candidate.sql`:

- one transaction, `lock table ... in access exclusive mode`;
- opening with a `prosrc` sha256 assertion for **each** of the four control-plane functions,
  including `effective_execution_binding()` which is asserted but not changed, so that any drift
  aborts;
- an immediate read-only read-back after apply, archived with the exact input and raw response;
- independent review before the Owner merge that carries the candidate SQL;
- **no blind retry after an interruption.**

Explicitly not permitted under `CP-01`:

- loosening `series_n > 9`, `charged_seconds <= 10506`, `charged_evidence_bytes <= 2335812531`, or
  any table CHECK bounding charges or allocations;
- weakening the requirement that a new budget's `expires_at` be no later than
  `accepted_binding.expires_at`;
- removing or bypassing the first-pass-stops rule, the terminal-receipt checks, or the
  original-bytes checks;
- adding a refund, reset, or automatic-retry path;
- `DROP FUNCTION`, or any change to the other eleven control-plane functions.

### Statement on the forward cap (`series_f`)

Raising `series_f > 15` to `series_f > 16` is a **cap extension**, and this proposal says so rather
than describing it as maintenance. It is needed because moving the execution binding onto the
rebuilt controller requires a twentieth binding forward, and the fifteenth was consumed on
2026-09-11.

Three things should be weighed before merging:

- The earlier record `OwnerForwardCapExtensionOverride.json` was never independently reviewed, and
  the reasoning offered for it at the time rested on a premise later shown to be false: the
  implementing side told the Owner the cap merely lacked a backing document, when in fact the
  database enforced it and the raise was not executable at all.
- Raising this cap grants **no additional execution capacity.** It does not change `series_n > 9`,
  `charged_seconds <= 10506`, or `charged_evidence_bytes <= 2335812531`. Exactly one 600-second
  allocation remains available before and after this change, and the two table CHECK ceilings are
  reached exactly when it is spent.
- The alternative — rewriting `effective_execution_binding()` directly so that no forward is needed
  and the cap stays at 15 — was considered by the implementing side and rejected as worse, because
  it would move the binding silently, outside the event log. This approval adopts that judgement by
  excluding direct replacement above.

## Generation registration boundary

One `GENERATION_REGISTERED` event may be appended for generation
`ctrgen_5e0440a95ac8ee257b9e4236cabd275b` (root6), against the existing root set
`ctr_414bd3c724264a83894b0c55cf2ab878`, with `predecessor_generation_id` equal to the current head
generation.

This is a new **generation**, not a new trust root, not a second root set, and not a new signing
identity. The root set id, issuer, audience, purpose and environment are unchanged.

Its `not_before` and `expires_at` must be the exact materialized window timestamps from this
approval's verified merge. Registration must not be performed before the `CP-01` transaction has
been applied and read back, because until then the control plane requires the live generation to be
root5 and registration would break the existing path without opening the new one.

## Execution sequencing

This approval does **not** itself authorize immediate execution.

After the verified Owner merge:

1. independently read back the merge and exact proposal blobs;
2. derive the exact 24-hour window timestamps;
3. rebuild the root6 controller with `root6Expiry` set to the derived `expires_at`, and re-issue
   all seven documents listed under "What is new, and why" item 2;
4. build a new canonical continuation registration subject and acceptance records;
5. obtain a second verified Owner merge over that exact subject, the rebuilt controller, and the
   seven re-issued documents;
6. generate and independently verify signature evidence;
7. prepare the exact fresh `NW-01` transaction and the exact `CP-01` transaction against the
   then-current database preimage;
8. independently review the new-window / new-preimage / new-candidate objects and the `CP-01`
   candidate SQL;
9. apply `NW-01`, then `CP-01`, each with an immediate read-only read-back;
10. register root6; then the twentieth binding forward; then Status24;
11. only after PASS and all execution prerequisites are READY may `reserve_execution_budget` be
    called at the last responsible moment.

No preimage or candidate from the expired 2026-09-10/11 or 2026-09-11/12 windows may be reused as
execution authority.

## Recorded governance question

The implementing side raised this twice during preparation and records it here because it bears on
what the eventual qualification result means.

The controller under qualification is built by the implementing side. Under this approval, the
enforcement layer that the controller must satisfy — three `SECURITY DEFINER` functions — would
also be modified by the implementing side, and modified specifically so that this controller
passes. Seven rounds of independent review have examined the repository side only; the database
side was not reviewed by anyone until immediately before the single irreversible write, and a prior
unreviewed change to these same functions is what left `append_status_manifest` inconsistent.

This is not a reason to refuse the merge, and the Owner has already chosen this path. It is
recorded so that the final qualification result states plainly that **the enforcement layer of this
qualification run was modified by the party being qualified, before the run.**
