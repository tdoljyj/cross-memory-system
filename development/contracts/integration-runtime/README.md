# Integration Runtime (plugin line S2c)

`IntegrationRuntime.v0.1.8.md` is the frozen S2c implementation contract for the
Integration runtime under Cross-Host v0.2.6 (frozen baseline, Clued Decision
`b4a7f879`).

- Frozen by Owner Decision `558c0a0b-2aab-407e-ad81-653da675b164` (2026-09-24).
  The freeze is recorded outside the file, as for the baseline: the file's own
  status line still reads "Owner 冻结候选 (freeze candidate)" and its bytes are
  not edited to say otherwise.
- SHA-256 of the frozen bytes:
  `ec96275cafa2bf0b09ba5abc18e4728b1d385fb63fc6dd9d5bf76d6f570c234d` (319,146 bytes).
- Semantics rest on Owner Decisions `d11f19ea` (OQ-1/2/3/14/20/21), `c5574918`
  (explicit Binding ownership, OQ-13) and `1b034f44` (revocation sweep and restore).
- Review history: eight Fresh-Context reviews; v0.1.5 full review and v0.1.7 delta
  review both 0 BLOCKER / 0 MAJOR. v0.1.8 applies only the v0.1.7 review's
  2 MINOR and 6 NIT items (see §18).

The file is immutable. A change is a new version file with its own review and
Owner freeze. A defect found in the frozen text is recorded in `ERRATA.md`
instead, with an Owner Decision as its authority; the frozen bytes are never
edited. Implementations follow the frozen file as amended by every erratum.

The contract grants no production migration, Worker release, flag enablement,
public RPC EXECUTE grant, public visibility, budget or procurement.
