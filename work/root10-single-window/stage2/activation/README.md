# Root10 single-window activation builder

This directory archives the source of the local activation builder. The builder emits an exact `files[]` JSON envelope to stdout by default, or writes to an explicitly supplied temporary output directory. It never connects to GitHub, Docker, or the database. The accompanying self-test was executed from its original `work/new-window/activation` layout with the retained verification inputs; publication here does not claim a new test run or supply synthetic data as actual activation evidence.

The generated transaction expects Root9/GA6 to have been terminalized exactly at execution sequence 112. It then performs exactly five execution events: register 113, prepare 114, qualify 115, runtime repoint 116, and the only Root10 budget at 117. Charges move monotonically from `11106/2470030259` to `11706/2604247987`; no refund, reset, reassignment, capacity release, GA issuance, or retry is present.

`reserve_gate.actual-negative-fixtures.json` lists the fifteen mandatory live-equivalent rollback probes. In addition to byte/idempotency, one-GA, repair, fixed admission field, Status29, budget117/LF, 600-second, receipt, active/container and replay checks, it now covers immutable Root/execution prefixes, historical budget generation/expiry, exact GA6 closure bytes, the exact original 51-field admission shape (38 accepted fixed plus 13 late-bound fields), and the unchanged container phase machine. SQL enforces the exact field set and accepted values; the trusted host still performs full Schema and signature verification. Container transitions remain routed through the pinned original `execution_transition`.

Inputs are deliberately strict. Signed Root10, signed Status generation 29, the final Root10 controller contract, reviewed qualification/runtime acceptance with **zero** Root10 repair refs, GA6 BLOCKED receipt hash, and exact live cap constraint definitions are mandatory. The 11 Root9 repairs remain historical evidence only and are not inherited by Root10. The builder itself generates the Root10 `reserve_gate`: it accepts only committed budget 117, exact 600-second GA scope, exact unchanged Gate/Profile/Scope and runtime generations, and zero prior Root10 GA. A missing material is a build failure, not a guessed placeholder.

```powershell
node work/new-window/activation/build-root10-activation.mjs MATERIALS.json --stdout
node work/new-window/activation/build-root10-activation.mjs MATERIALS.json C:\path\to\temporary\output
```

`root10-activation.preimage-only.sql` is only a fast stale-input check; it does not compile or execute the candidate functions. The mandatory database preflight is `root10-activation.full-rollback.sql`: it is byte-for-byte the complete apply transaction except for its one terminal `ROLLBACK`, so it compiles all three functions, performs the activation, checks the full postimage, emits actual root/counter/function-SHA readback, and rolls everything back. Only a successful full rollback authorizes running `root10-activation.apply-once.sql`. Do not replay an uncertain response; use `root10-activation.readback.sql` and compare the complete postimage.

The `read_root` rewrite uses callback replacements (`replace(anchor, () => replacement)`), so PostgreSQL `$...$` tokens cannot be interpreted as JavaScript replacement syntax. Each supplied/generated function is rejected unless it contains exactly one definition and one closed `$function$` pair.
