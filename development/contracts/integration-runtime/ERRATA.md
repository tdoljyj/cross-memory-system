# Integration Runtime contract — errata

`IntegrationRuntime.v0.1.8.md` is immutable: its bytes are never edited, and its
SHA-256 stays `ec96275cafa2bf0b09ba5abc18e4728b1d385fb63fc6dd9d5bf76d6f570c234d`.
A defect found in the frozen text is recorded here as a numbered erratum, with an
Owner Decision as its authority. An erratum amends the contract's semantics; it
never rewrites the frozen file, and no implementation may "explain away" a gap in
place instead of raising one.

Each erratum states what the frozen text says, why it is wrong or incomplete, and
what replaces it. Implementations follow the frozen file as amended by every
erratum below.

---

## ERRATA-001 — `§7.1` facts document: `connection_store`; C4/C5 by `§7.2`

- **Authority:** Owner Decision `9d6fa6c2-65fd-405a-89c4-e81a435374ef` (2026-09-24).
- **Raised by:** the Fresh-Context review of PR #338 (S2c PR-1), findings MAJOR-1 and MINOR-1.
- **Status:** in force. Implemented by PR-1 (migration `20260926000000`).

### 1. `clued.integration-facts.v1` gains a required key `connection_store`

**What the frozen text says.** `§7.3` defines `C7_CONNECTION_STORE_INCONSISTENT`
with four conditions: more than one CURRENT connection row, a connection pointing
at another owner's Binding, a missing ownership row, and an ownership row naming a
different Integration. The `§7.1` facts document carries no field from which any
of those four can be read, and `§7.1` rule 2 makes an unknown key `C1`.

**Why that is a defect.** `§8.6` makes the derivation a pure function that reads
no table, so it cannot inspect the connection store itself. With no carrier in the
facts, `C7` is unreachable: an inconsistent connection store would derive a normal
state instead of `DERIVATION_INPUT_INVALID`. That is fail-open, against `§7.3`.

**What replaces it.** `clued.integration-facts.v1` has one more required top-level
key:

- Key: `connection_store`
- Domain: `CONSISTENT`, `MULTIPLE_CURRENT`, `FOREIGN_BINDING`,
  `OWNER_ROW_MISSING`, `OWNER_MISMATCH`

Any value other than `CONSISTENT` yields `C7`, mapping one-to-one onto the four
conditions `§7.3` already lists. The key is required, so a document that omits it
is `C1`, and it takes part in `facts_sha256` like every other key.

**Consequence for later PRs.** The PR-2 normalizer must emit `connection_store`,
derived from the connection rows and the Binding ownership rows it reads.

### 2. C4 and C5 follow `§7.2`, not the literal `§7.3` formulas

**What the frozen text says.** `§7.2` states that any `identity_claim_facts` value
other than `CONSISTENT` is `C4` or `C5`. The `§7.3` formulas for `C4` and `C5`
additionally condition on `identity_claim_state`, which makes some non-`CONSISTENT`
values valid: `CURRENT_CLAIM_HOLDER` with `UNEXPECTED_CURRENT_ROW`, and
`CLAIM_CONFLICT` with `MISSING_CURRENT_ROW`.

**Why that is a defect.** The two sections contradict each other for those cases.

**What replaces it.** `§7.2` governs. The mapping does not depend on
`identity_claim_state`:

| Claim-store value | Code |
|---|---|
| `MISSING_CURRENT_ROW` | `C4` |
| `KEY_MISMATCH` | `C4` |
| `UNEXPECTED_CURRENT_ROW` | `C5` |

This resolves the conflict on the fail-closed side.

### 3. Two schema tightenings, both `C1`

Both are fail-closed refinements of `§7.1` rule 2 and `§5.6`:

- A `revocation_state` that disagrees with its `revocation_source` is `C1`. The two
  are one truth class in `§7.2`, so an inconsistent pair is a malformed document.
- A non-null `mask` on a value that `§5.6` does not mask is `C1`. `mask` is present
  on every truth class; it is an array only for `RESTRICTED`, `CONDITIONAL` and
  `DEGRADED` values, and JSON null otherwise.

### Boundary

This erratum changes contract semantics only. It grants no production migration,
Worker release, flag enablement, public RPC EXECUTE, public visibility, budget or
procurement.

---

## ERRATA-002 — canonical spellings: integer fields, ceiling `actions`, instants

- **Authority:** items 1 and 2, Owner Decision
  `793ea908-3281-430d-8bfd-8e0b83bfd226`; item 3, Owner Decision
  `25edd152-0d95-4cf7-b3eb-0ff32aed74d0` (both 2026-09-24).
- **Raised by:** the Fresh-Context delta reviews of PR #338 — items 1 and 2 by
  the first review's MAJOR-1, item 3 by the second review's MINOR-1.
- **Status:** in force. Items 1 and 2 implemented by PR-1
  (migration `20260926000000`); item 3 by its follow-up.

All three items exist for the same reason: the frozen contract requires a canonical
byte representation in places where it specifies only a value, and JSON admits
several spellings of one value. Rather than rewrite a document before hashing or
comparing it, the validator refuses the ambiguous spellings.

### 1. Integer-valued fields accept only the integer spelling

**What the frozen text says.** `§7.2` gives `reauth_marks_open` the domain
"整数 ≥ 0", and `§5.12` gives `policy.policy_version` an integer version. JSON
does not distinguish `0` from `0.0`, so both documents satisfy those domains.

**Why that is a defect.** `§7.1` rule 1 requires that the same truth always
yields the same `facts_sha256`. `jsonb` preserves the submitted spelling, so
`{"reauth_marks_open": 0}` and `{"reauth_marks_open": 0.0}` are the same truth
with two different hashes. Canonicalising the document before hashing would make
`facts_sha256` a hash of something the caller did not submit.

**What replaces it.** `reauth_marks_open` and `policy.policy_version` are `C1`
unless their `jsonb` text form matches `^[0-9]+$`. `0.0` and `1.0` are therefore
`C1_SCHEMA_INVALID`. (`1e2` needs no rule: `jsonb` already stores it as `100`.)

### 2. Ceiling entry `actions` is de-duplicated and sorted

**What the frozen text says.** `§5.2` states the rule asymmetrically: `scopes`
must be a subset of the three v12 scopes, de-duplicated and sorted, while an
entry's `actions` must only take v12 values and be non-empty.

**Why that is a defect.** `§10.12` has restore record `ceiling_before` and
`ceiling_after` in its Receipt, which requires one ceiling to have one `jsonb`
representation. Without a canonical order, `["read","write"]` and
`["write","read"]` are the same ceiling with different bytes, and a Receipt
cannot show whether authority changed.

**What replaces it.** An entry's `actions` must be de-duplicated and sorted in
`C` collation, exactly as `scopes` already is. This does not change containment:
`§10.11` compares `actions ⊆ C.actions` as sets, which is order-insensitive.

### 3. An instant is written the one way `timestamptz` round-trips to

**What the frozen text says.** `§7.1` gives no lexical grammar for an instant at
all — only the example `"2026-09-24T12:00:00Z"` — and `§7.2` sources `as_of` and
`canonical_runtime_verification_facts.valid_until` from `timestamptz` columns.

**Why that is a defect.** Two spellings PostgreSQL accepts do not denote the
instant they appear to: it rolls `24:00:00` to the next day and `12:00:60` to
`12:01:00`. `valid_until` is inside `facts_sha256`, so one instant written two
ways hashes two ways, against `§7.1` rule 1. A normalizer formatting a
`timestamptz` cannot produce either spelling, so nothing legitimate is lost.

**What replaces it.** An instant is `C1` unless it is the single spelling
`timestamptz` round-trips to: hour `24` and second `60` are `C1`. Everything else
the previous rule accepted is still accepted — a differential sweep of 400,000
spellings on a live database found exactly 25 classes newly rejected (`h=0…23`
with `s=60`, and `h=24` with `s=0`) and nothing newly accepted.

### Boundary

As ERRATA-001: semantics only, no production, release, flag, grant, visibility,
budget or procurement authority.

---

## Note — `§13.2` P2 (c) sample counts are two obligations

Not an erratum: the frozen text is correct and is restated here because PR-1
briefly under-ran it. `§13.2` P2 (c) requires **250,000** fixed-seed random facts
in CI **and** 2,000,000 nightly. They are separate obligations. Neither may be
reduced to meet a self-imposed runtime budget; the contract sets no CI runtime
budget. Owner Decision `793ea908-3281-430d-8bfd-8e0b83bfd226` restores the CI
count to 250,000 and has PR-1 wire the nightly run rather than defer it.
