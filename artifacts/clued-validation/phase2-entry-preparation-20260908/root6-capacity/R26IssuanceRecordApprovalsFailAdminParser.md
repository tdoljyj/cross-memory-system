# R26 — issuance record: the two capacity documents were NOT issued; both 160 approvals fail the controller's administrative parser at 4d73b18

**State: `NO_DOCUMENT_ISSUED_NO_WRITE_PERFORMED`.**

Reviewer identity requested: `/root/project_list_auth_fix`.
Reviewed at `4d73b1822c422e19a22aca3ef68959dd71302b48`, the head of `claude/nice-fermat-njqlmm`, fetched fresh.
Host stamp measured: `node=81925c0995b5 docker=18c2a16d6aa0 gh=f687dc937534 python3.11=f56a588548dd`.
Clock at assessment: `2026-09-13T02:06:16Z`. Window closes `2026-09-13T07:05:16Z`.
Issuing session: `session_015Tt97v7JR1XcGCwvZG7Npk`.

I was asked to issue `Root6CurrentController4000000CapacityApplicability20260912.json` and
`Root6Current043CapacityRepairAcceptance20260912.json` at `68133f2d`/160, on the briefing's
correct observation that publication references come from the future Owner merge, not from any
field of the documents themselves, so the R25 refusal grounds no longer forbid issuance. I
verified that observation against source and it holds (section 2). I still did not issue,
because of a defect the briefing could not have known about: **the corrected approvals that
`4d73b18` produced cannot be parsed by the controller at all** (section 3). An applicability
pinning those bytes by content hash would bind a blob that fails at load, before any predicate
of mine is reached — a document chain built on a file the controller can never read, which is
exactly the defect this engineering names.

Everything else is ready, and I proved it: with the approvals' byte form corrected (content
identical, one deterministic re-serialization), the full lifted `checkCapacityAdministration`
clears every document predicate and stops only at the live-store check no host can run
(section 5).

---

## 1. What I verified on this host

Every digest below was measured from bytes on this host. Every predicate was **lifted out of
`context.mjs` source text at run time and executed** — the whole `capacityAdministration` IIFE
(`context.mjs:103-143`), plus its module-scope closures `check`, `time`,
`checkCapacityApprovalTime`, `generation` and `root6Expiry` (`:29`, `:42-46`, `:48`, `:191`),
evaluated from source slices, not transcribed.

### Host prerequisites

| item | required | measured | verdict |
| --- | --- | --- | --- |
| `/opt/node22/bin/node` | `81925c0995b5…` | `81925c0995b5…` | match |
| `/usr/bin/python3.11` | `f56a588548dd…` | `f56a588548dd…` | match |
| `/usr/bin/docker` | `18c2a16d6aa0…` | `18c2a16d6aa0…` | match |
| `/usr/local/bin/gh` 2.63.2 | `f687dc937534…` | `f687dc937534…` | match, installed this session, 50098328 bytes |
| `ajv` in `apps/clued-cloud/node_modules` | 6.15.0 | 6.15.0 | installed with `--no-save --no-package-lock` |

### The four gates, re-run on this host

| gate | result |
| --- | --- |
| `check-digest-pins.mjs` | **48 literals / 0 unexplained** |
| `selftest-runtime-pins.mjs` | **passed, 0 UNPROVEN, 9 not covered, census 73 literals over 56 modules** (its own negative controls all fired: altering context.mjs raises `EXACT_CONTROLLER_SOURCE_BYTES_DRIFT`, etc.) |
| `verify-manifest-against-host.mjs <manifest> --map /=/` | **314/314 verified, 0 mismatched, 0 missing, cross_pins declared 6 failures 0** |
| `selftest-cross-pins.mjs` | **4/4 declared failure modes produced + restore case** |

**Negative control for gate 3** (gates 2 and 4 carry their own): a copy of the manifest with
one sha256 flipped to zeros → `mismatched: 1`, exit 1. The gate can fail; it just doesn't here.

### The freeze point

| claim | measured | verdict |
| --- | --- | --- |
| manifest self-digest | `68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a` | confirmed |
| entries | 314 (153 `REPOSITORY_SOURCE` / 161 `RUNTIME_DEPENDENCY`) | confirmed |
| 22 `REPOSITORY_SOURCE` entries under `control-context-verifier-root6-linux-successor` | all 22 match working-tree bytes and byte counts | confirmed |
| distinct source blobs | 142 ≤ 160 | confirmed (per gate 3 and R25) |

### R25-F3 / R25-F2 — the 4d73b18 fix, re-measured

| file | sha256 at 4d73b18 | git blob |
| --- | --- | --- |
| `…Approval20260913.json` (v1) | `f6bc3c615b824699782e2c616fe564e0b1cc18f09635386b2b47c839c4753552` | `922ae62a` |
| `…Approval20260913.v2.json` | `83a5924be017c6d3886a566b18986812d5fcefebcd82616afb6d350427a8ac8e` | `bf5376c5` |

Both now declare 160 in `limitations[0]`, `what_changed_from_predecessor` and `source`; v1's
window is corrected to `2026-09-13T07:05:16Z`. As **values**, both deep-equal checks pass:
`same(a.capacity_delta, capacityDelta)` and `same(a.baseline, capacityBaseline)` are true, a
mutated delta (159) fails the same comparison. The contradiction findings are fixed **as
content**. The bytes are another matter — section 3.

### Referenced blobs, all present locally and matching their pins

`33feb26a…` (previous evidence sink, blob `a1a5f39b`), `f8c2e3c0…` (evidence sink, blob
`30a8fd5a`, and it appears in `expected_ga.artifact_refs`), `28120e79…` (identified error, blob
`9c04ed1d`), `fe114f08…` (bounded-series approval, blob `86636aa7`, and it deep-equals both the
runtime acceptance's `bounded_series_materials.approval.ref` and v2's `base_approval_ref`),
`e224c379…` (capacity proposal, blob `38db69db`). The v19 acceptance's `capacity_delta`
deep-equals the frozen constant at `context.mjs:113`.

---

## 2. The briefing's issuance argument is correct — I verified it against source

- `publication.commitSha`/`artifactPath` live only in the **descriptors inside the runtime
  acceptance** (`context.mjs:245` for capacity materials, `:268` for bounded series), where
  `verifyOwnerMergeArtifact` checks them at load. Neither document I was asked to issue carries
  any publication field, and no predicate in `:122-:135` or `:140` reads one. So "no merge
  commit exists yet" does not block issuing the documents; it blocks *consuming* them, which is
  the flip's problem, after the Owner merge. R25's addendum conflated the two; the briefing is
  right about this.
- R25-F1 (the `repairs[7]` content-hash pin, `:287` → `:271` → `:221`) determines when a
  re-issued 043 becomes reachable, not whether it can be written. Its own remedy — repoint
  `repairs[7].ref` — requires the new 043 bytes to exist first. Issuing first is the
  prerequisite of the repoint.
- `capacity_materials_intent` is read by nothing in the controller (0 references in any
  controller `.mjs`; measured by grep over all 22 sources). It still pins v2 at the pre-4d73b18
  bytes `2834015707…`/blob `69111a4e` — stale, but declared non-live and harmless *as long as
  the flip re-measures instead of copying it*. A flip that copies it forward fails loudly at
  `CAPACITY_EXACT_APPROVAL` (`:117`), demonstrated in section 5.

Had the approvals' bytes been loadable, I would have issued both documents in this session.

---

## 3. R26-F1 — both 160 approvals fail `parseAuthenticatedAdministrativeJSON` at 4d73b18

**This is the blocking finding.**

### The gate

`context.mjs:104-110` (`parseAuthenticatedAdministrativeJSON`) strips whitespace outside
strings and requires the result to equal `JSON.stringify(value)` —
`ADMIN_JSON_UNIQUE_CANONICAL_VALUES` otherwise. It is invoked on the approval's bytes at
`:117` (`material`, from `checkCapacityAdministration` at `:123`) and at `:253`
(`loadAuthenticatedCapacityMaterials.actual`). There is no path to the capacity administration
that does not run it over the approval bytes.

### Measured

```
Root6LinuxController160SourceRefApproval20260913.json     (f6bc3c61…)  -> ADMIN_JSON_UNIQUE_CANONICAL_VALUES
Root6LinuxController160SourceRefApproval20260913.v2.json  (83a5924b…)  -> ADMIN_JSON_UNIQUE_CANONICAL_VALUES
same two files at 3fe90ce (17908c86…, 28340157…)          -> both parse clean
Root6LinuxController160SourceRefCapacityProposal20260913.json          -> parses clean
```

The regression is introduced by `4d73b18` itself.

### Root cause

The rewritten `source.what_each_approved` object now contains the key `"160"` after the key
`"确认走C"`. `"160"` is an array-index-like key, and JavaScript enumerates such keys **first,
in numeric order, regardless of insertion order** — so `JSON.stringify(JSON.parse(raw))`
reorders it to the front:

```
file bytes:  …"what_each_approved":{"确认走C":"在 SourceRefCeilingExceededDecision.md …
stringify :  …"what_each_approved":{"160":"新的 capacity_delta.source_refs_maximum 数值…
             first divergence at compact-offset 2449, identical in v1 and v2
```

No whitespace choice fixes this: any byte layout that keeps `"确认走C"` before `"160"` fails
the gate. The 4d73b18 commit message says the result was "re-verified with the predicates
lifted from context.mjs: capacity_delta deep-equals … baseline deep-equals … ref(…) true" —
all value-level predicates. `material`/`parseAuthenticatedAdministrativeJSON`, the byte-level
gate, was not among them. That is this project's named defect once again: the verification that
was run could not fail on the axis that broke.

### Why this forbids issuance, rather than accompanying it

The applicability must pin `approval_ref` by `{uri, sha256}` (`:129` requires
`same(d.approval_ref, s.capacity_materials.approval.ref)`, and the loader resolves that ref by
content). Pinning `83a5924b…` pins bytes that throw at `:253`/`:117` before `:124` is ever
evaluated. And once the approvals are re-issued with loadable bytes — which changes their
sha256 — an applicability naming today's sha becomes a stale co-equal candidate on the branch,
the exact hazard R25-F2 was about. Issuing now would produce two documents that are wrong the
moment the prerequisite fix lands.

### Deterministic remedy (for the implementing side; not applied by this reviewer)

Re-serialize each approval's **unchanged JSON value** canonically. One line per file, from the
repository root, byte-reproducible:

```
node -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p,JSON.stringify(JSON.parse(fs.readFileSync(p,"utf8")),null,2)+"\n")' <file>
```

Measured results of exactly that command on the 4d73b18 bytes:

| file | corrected sha256 | corrected git blob | value change |
| --- | --- | --- | --- |
| v1 | `d3a90e311d4a51785deccacca257514128cb0d3977a246d642a6ad505ae4942d` | `21c6bf0d…` | none — `isDeepStrictEqual(old, new)` true |
| v2 | `bc541370c238309730485e33f05b03ba44566fb4f6b83da9d657f7298b5a88e6` | `6d02472a…` | none — `isDeepStrictEqual(old, new)` true |

Both corrected byte forms parse clean under the lifted gate. No Owner-approved content moves;
only key order and whitespace. Per role separation I did not write these bytes into the
approval files: the 160 approvals are the implementing side's documents, and the reviewer who
will pin them must not also be their author. If the implementing side's command reproduces
these digests, this record is the independent verification of that fix in advance.

---

## 4. What I would have issued, and will issue against corrected approval bytes

Prepared and validated in full, held back only by R26-F1:

- **Applicability**: binds `approval_ref` to v2 (post-fix bytes), `base_approval_ref`
  `fe114f08…`, `base_proposal_sha256` `ea96914e…`, `capacity_proposal_ref` `e224c379…`,
  `bounded_series_constraints`/`capacity_delta`/`baseline` byte-lifted from the frozen
  constants, `controller_digest` `68133f2d…`, `scope_digest` `115408c6…`, sinks `33feb26a…` →
  `f8c2e3c0…`, and `changed_source_refs` = **23 refs**: the manifest blob itself plus the 22
  `REPOSITORY_SOURCE` entries under `control-context-verifier-root6-linux-successor` — the set
  R24-F2 measured as absent from `origin/main`, i.e. what this migration introduced. All 23
  uris and sha256s distinct; every sha256 re-measured from working-tree bytes. This settles the
  set-membership question R25 left open, with the semantics stated in the document.
- **043 repair acceptance**: `:140`-complete against that applicability;
  `changed_source_refs` deep-equal to the applicability's; supersedes `3b7b288c…`.

Field-for-field these are fixed by `:122-:135`/`:140` plus re-measured refs; the only values
that change with the approval fix are `approval_ref`/`capacity_approval_ref` (and everything
downstream of the applicability's own bytes). Issuance is a re-run of a validated procedure.

## 5. The demonstration — every predicate executed, every check shown able to fail

Harness: the `capacityAdministration` IIFE and its closures evaluated from `context.mjs`
source slices; in-memory drafts only, nothing written to the repository. Baseline uses the
**corrected** v2 bytes and a synthetic `GENERATION_REGISTERED` body encoding exactly the
declared preconditions (`not_before 2026-09-12T07:05:16Z`, `expires_at 2026-09-13T07:05:16Z`).

```
full checkCapacityAdministration (corrected v2 + draft applicability) -> ACTUAL_043_BLOCKED_TERMINAL_REQUIRED
   (i.e. :122, :124, :125, checkCapacityApprovalTime, :129, :130, :131, :132, :133, :134, :135 all passed;
    the stop is the live-store 043 receipt, whose bytes exist only in the control plane)
same harness with the CURRENT 4d73b18 v2 bytes -> ADMIN_JSON_UNIQUE_CANONICAL_VALUES   (R26-F1)

negative controls, each moving the failure to the named gate:
  approval delta 159 (subject re-pinned)          -> REAL_EXACT_CAPACITY_APPROVAL_REQUIRED  (:124)
  approval delta 159 (subject NOT re-pinned)      -> CAPACITY_EXACT_APPROVAL                (:117)
  subject capacity_delta 159                      -> EXACT_CAPACITY_SUBJECT_AND_LOADED_SET  (:122)
  approval bytes altered, ref unchanged           -> CAPACITY_EXACT_APPROVAL                (:117)
  subject pins approval sha the applicability
    does not name (the stale-intent-copy case)    -> EXACT_INDEPENDENT_CAPACITY_APPLICABILITY (:129)
  applicability reviewer -> /root                 -> EXACT_INDEPENDENT_CAPACITY_APPLICABILITY (:129)
  applicability delta 159                         -> CAPACITY_ONLY_EXPLICIT_DELTA           (:130)
  forbidden scope_unchanged key                   -> CAPACITY_ONLY_EXPLICIT_DELTA           (:130)
  accepted_at before approved_at                  -> CAPACITY_ACCEPTANCE_TIME               (:131)
  controller_digest -> old 3a58eb87               -> CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE (:132)
  duplicated changed_source_refs uri              -> CAPACITY_EXACT_CHANGED_SOURCE_REFS     (:135)
  registered not_before after approved_at         -> CAPACITY_APPROVAL_CURRENT_ROOT5_TIME   (:44-46)

isApprovedCapacityRepair(draft 043, 043 attempt, c) = true                                  (:140)
  old controller_digest / stale applicability ref / short changed_source_refs /
  scope_unchanged present / wrong reviewer        -> all false
```

## 6. What I could not verify — unchanged from R25

Owner merge (nothing here is merged), live control plane (no database access: the registered
body, the 043 receipt bytes `b27286d6…`, the charged budget are asserted, not read),
`verifySourcePublication` end to end.

## 7. Order of repair

1. Implementing side: re-serialize both approvals with the command in section 3 (expected
   digests: v1 `d3a90e31…`, v2 `bc541370…`); commit.
2. This reviewer identity: issue the two capacity documents against the corrected v2 bytes
   (section 4 — the procedure is validated and mechanical).
3. Owner: merge `claude/nice-fermat-njqlmm` into `main` (R24-F2's critical path, unchanged).
4. Flip session, in one acceptance edit, values re-measured from merged bytes and never copied
   from `capacity_materials_intent`: fill `capacity_materials` (approval = corrected v2,
   applicability = the issued document) with their Owner-merge publications, and repoint
   `bounded_series_materials.repairs[7].ref` to the issued 043 (R25-F1).

## 8. Left open

R26-F1 (blocking, new). R25-F1 (structural, remedy unchanged, folded into step 4). R24-F2
(Owner merge, unchanged). R25-N1 (stale erratum, unchanged). Closed here: the R25 addendum's
issuance-ordering objection (section 2), and the changed_source_refs set-membership question
(section 4).

## 9. Boundaries

No database write, no `append_event`, no generation registration, no budget reservation, no
600-second run, no merge to `main`, no new trust root, signing identity, paid or model budget,
production authority, refund, or capacity beyond `source_refs_maximum` 160. The two approval
files, the two capacity documents and every other repository byte are unchanged on this branch;
this record is its only addition. This file issues no acceptance, grants no authority, approves
nothing and merges nothing.
