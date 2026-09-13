## What this carrier is for

Merging this document is the Owner authorization that opens window12. Its
`committed_at` becomes T; the window is T + 86400 seconds, non-rolling.

The next window is **not a patch on window11** — it is a full cycle. Five
source-level pins were measured, each of which alone forces the controller
bytes to change and therefore moves the freeze point away from `68133f2d`:

| # | Pin | Why it forces a change |
| --- | --- | --- |
| 1 | `context.mjs:18` `forwards:16`, asserted at `:214` | the 21st forward makes it 17 |
| 2 | `context.mjs:191` `root6Expiry` | consumed by `:226`; wrong window aborts |
| 3 | root6 registration body `expires_at`, checked at `:62` | generation reuse is forbidden → **root7 must be registered** |
| 4 | `context.mjs:15` `generation` constant | changes with root7 |
| 5 | `:317` two issuer-qualification digests | the pinned documents bind root5 and expired 2026-09-11 |

Pin 5 is worth stating plainly: **the 600-second run in the previous window
would have aborted at `:319` regardless of R29**, because `context.mjs:319`
asserts both generation equality and window currency over those two documents.
The R29 stop preserved the single remaining allocation.

## What is in the package

- **F12 pre-image** — the five controller files carrying window-bound bytes are
  edited to root7; the four values that cannot be known before T are non-hex
  sentinels. They are non-hex deliberately: an unrealized tree cannot pass
  `check-digest-pins` (literal shortfalls context.mjs 20/22, check-digest-pins
  6/8), so skipping realization is mechanically loud rather than a promise.
  `work/f12/realize-f12.mjs` is the single post-merge entry.
- **Two root7 issuer qualification candidates** — each differs from its
  root5-era predecessor at exactly seven declared paths, cross-doc drift zero.
- **The M3 carrier itself** — window_rule, NW-02 clause (reusing the reviewed
  NW-01 mechanism), the root7 `generation_registration` clause, and the CP-02
  permitted edit classes.
- **root7 registration builder** — a byte-exact port of the root6 one (base
  sha256 `e220bfce`, nine changed points itemized), since `append_event` does
  not validate the body and a wrong one burns the generation permanently.
- **Adjudication and review records** — `M3AdjudicationsRound1.md`,
  `Round32Review.md`, `R31ReviewStatus24DecisionsAndRepin.md`, and the
  self-audit `F12SentinelDiagnosticsFinding.md`.

## What the independent review found

Round 32 reviewed the whole package adversarially. Two findings were
load-bearing, and both were re-verified in the parent session before being
accepted:

**R32-F2 — the 15th instance of the recurring defect, caught before the freeze.**
`commitment-signing-root6-window/signing.mjs` is the load set's only live
cross-directory module, reached from three live verification paths. Its
generation admission list did not include root7, so every window12 GA and GRR
would have died at `purpose_audience_generation_mismatch`. It was invisible to
all fourteen existing defenses because a generation id is 32-hex while every
digest gate matches 64-hex, and the residual scan covered only the controller
directory. Fixed here, following the precedent set when root6 was added.

**R32-F1 — `build-f12.mjs` could not run when it was delivered.** Its
duplicate-rule check keyed on the `from` string alone and so refused the two
schema files that legitimately share one. Its per-rule occurrence assertions had
therefore never executed; the original edits were hand-applied. The key is now
per-file, and a replay on the pre-F12 commit reproduces all six edited files
byte-identically, including the signing.mjs fix — the rule-table-to-bytes
guarantee is now mechanical.

Lower-severity findings (R32-F3 through F6) are recorded in `Round32Review.md`.
R32-F3 is worth carrying forward: the round-9 opinion cited by the **already
merged** NW-01 carrier exists at no path and no digest in this repository, so
that argument is not reviewable today. The 16-to-17 opinion in this package is
anchored by path *and* sha256, and the validator checks that digest against the
file bytes so the same gap cannot recur.

## Self-approval boundary

Round 32 prepared four carrier edits and the matching validator changes but
deliberately did not apply them: for the reviewing session, flipping its own
"awaiting adjudication" flag and wiring in its own opinion as *independent* is
self-certification. The parent session applied them as a distinct party, to a
candidate file, reversibly. **The Owner merge is the approval gate**; nothing in
this PR touches the live control plane.

## Verification

- `validate-m3-candidate.mjs`: A1–A5 pass, 11 discriminators all demonstrated
  able to fail. 26 placeholders, three-way set equality, no materialized T.
- `verify-issuer-candidates.mjs`: passes; `--tamper` refuses.
- F12 residual scan: all 8 old-window tokens at zero occurrences; sentinel
  census exactly 7 sites / 4 distinct values, mirrored by the realize table.
- `root7BudgetSequence = 90` re-measured live: every `BUDGET_RESERVED` sequence
  ≤ 85, post-baseline budgets exactly 8, `max(sequence)` 89.
- `a93bfdda` (the root6 registration body digest root7 will pin as its
  predecessor) closed three independent ways: R31's snapshot computation, the
  builder's historical self-test reproducing `92186d46` for root6, and an
  explicit head-body assertion added in the port.

## Capacity and authority — unchanged

No new capacity, no refund, no reset, no automatic retry. `charged_seconds`
9906 / 10506 measured read-only; the ninth allocation reaches the ceiling
exactly, so **one allocation remains and window replacement does not change
that**. No new trust root, signing identity, paid budget, model budget, or
production authority.

## Still gated on the Owner after this merge

M4 (finalized documents), the root7 `append_event` (a separate explicit
go-ahead, distinct from this merge), the budget reservation, and the
600-second run.

## CI

The five workflows fail at account level (no runner assigned, `runner_id` 0,
~3s, every push since 2026-09-12 07:16 including already-merged ones). This is
not recorded as passing and is not caused by this branch.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012ki2dPxTiJbPmgZu7AD3Nz

---
_Generated by [Claude Code](https://claude.ai/code/session_012ki2dPxTiJbPmgZu7AD3Nz)_